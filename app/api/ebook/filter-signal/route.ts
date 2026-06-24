import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { cleanTranscriptForBook } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 120;

const RequestSchema = z.object({
  masterTranscript: z.string().min(50),
});

// Tiny schema — only extract start/end markers, NEVER the full transcript.
// Server reconstructs the cleaned transcript via string matching.
const MarkersSchema = z.object({
  teachingStartPhrase: z.string().default("").describe("First 80-120 chars of the sentence where core teaching begins (verbatim)"),
  teachingEndPhrase: z.string().default("").describe("Last 80-120 chars of the final teaching sentence before closing prayer/altar call (verbatim)"),
  // Accept any strings — the LLM returns human-readable labels, not enum slugs,
  // and these are only used as display text in the summary. No switch logic depends on them.
  removedCategories: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

export type FilterSignalResult = {
  cleanedTranscript: string;
  removedSegments: { reason: string; excerpt: string }[];
  summary: string;
};

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      const backoffMs = Math.min(7000, 1000 * Math.pow(2, attempt));
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("signal filter request failed");
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 90000): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = RequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      {
        route: "ebook/filter-signal",
        error: err instanceof Error ? err.message : "Invalid input",
      },
      { status: 400 }
    );
  }

  const transcript = input.masterTranscript;

  // Only sample the head + tail (non-teaching content is almost always at the edges).
  // Keep the LLM output tiny — just two phrase markers.
  const words = transcript.split(/\s+/);
  const headSample = words.slice(0, 1200).join(" ");
  const tailSample = words.length > 1200 ? words.slice(-600).join(" ") : "";
  const sample = tailSample
    ? `${headSample}\n\n[…middle of transcript omitted…]\n\n${tailSample}`
    : headSample;

  try {
    const { text } = await withRetry(
      () => withTimeout(generateText({
        model: deepSeekModel,
        temperature: 0.1,
        system: `You are a content signal filter for a book production pipeline.

Find where the CORE TEACHING begins and ends in the transcript excerpt.

NON-TEACHING content (identify and skip):
- Opening/closing prayers and benedictions
- Church announcements and event notices
- Greetings: "Good morning", "how is everyone", banter before teaching
- Greetings and acknowledgements to the room/church family
- Thank-you lines directed to attendees, leaders, choir, workers, or guests
- Repeated monthly-theme/series recap lines that do not add new teaching substance
- Housekeeping: "turn to your neighbor", stand/sit cues, phone reminders
- Altar calls and salvation appeals
- Offering/tithing appeals
- Technical breaks

TEACHING content (preserve everything else):
- Scripture exposition, Bible references
- Theological and doctrinal points
- Stories and analogies that illustrate a teaching point
- Application, arguments, conclusions

Return VERBATIM phrases (exact words from the transcript) so the server can locate them.
If teaching starts at the very beginning, set teachingStartPhrase to the first sentence.
If no closing non-teaching is found, set teachingEndPhrase to the last teaching sentence.

Respond with ONLY a valid JSON object — no markdown, no code blocks, no explanation:
{"teachingStartPhrase":"...","teachingEndPhrase":"...","removedCategories":[],"summary":"..."}`,
        prompt: `Identify the teaching start and end markers:\n\n${sample}`,
      }), "ebook/filter-signal"),
      2
    );
    let _parsed: unknown;
    try {
      const _jsonMatch = text.match(/\{[\s\S]*\}/);
      _parsed = _jsonMatch ? JSON.parse(_jsonMatch[0]) : {};
    } catch {
      _parsed = {};
    }
    const _result = MarkersSchema.safeParse(_parsed);
    const object = _result.success ? _result.data : MarkersSchema.parse({});

    // Reconstruct cleaned transcript using the markers (string-match, no LLM output of full text)
    let cleaned = transcript;

    const start = (object.teachingStartPhrase ?? "").trim();
    if (start.length > 20) {
      const idx = transcript.indexOf(start.slice(0, 60));
      if (idx > 10) {
        // Re-inject the nearest preceding [Slot-N] header so the content-map
        // parser doesn't lose the first slot when greetings/prayers are trimmed.
        const before = transcript.slice(0, idx);
        const allHeaders = before.match(/\[Slot-\d+\]/g);
        const lastHeader = allHeaders ? allHeaders[allHeaders.length - 1] : null;
        cleaned = lastHeader
          ? `${lastHeader}\n${transcript.slice(idx)}`
          : transcript.slice(idx);
      }
    }

    const end = (object.teachingEndPhrase ?? "").trim();
    if (end.length > 20) {
      const searchKey = end.slice(0, 60);
      const idx = cleaned.lastIndexOf(searchKey);
      if (idx > 0) {
        const lineEnd = cleaned.indexOf("\n", idx + searchKey.length);
        cleaned = lineEnd > 0 ? cleaned.slice(0, lineEnd).trim() : cleaned;
      }
    }

    const cleanedTranscript = cleanTranscriptForBook(cleaned || transcript);
    const removedSegments = object.removedCategories.map((reason) => ({ reason, excerpt: "" }));

    return NextResponse.json({
      cleanedTranscript,
      removedSegments,
      summary: object.summary ||
        (removedSegments.length > 0 ? `Removed: ${object.removedCategories.join(", ")}` : "No non-teaching content detected"),
    }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signal filter failed";
    return NextResponse.json({
      route: "ebook/filter-signal",
      error: message,
    }, { status: 500 });
  }
}


