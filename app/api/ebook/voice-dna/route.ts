import { NextRequest, NextResponse } from "next/server";
import { generateObject, generateText } from "ai";
import { deepSeekModel } from "@/lib/ai-providers";
import { VoiceDNARequestSchema, VoiceDNASchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 120;

function parseVoiceDnaJson(text: string): Record<string, unknown> {
  // Remove markdown code fences if present
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Voice DNA response contained no JSON object");
  }
  
  let rawBlock = match[0];
  
  try {
    return JSON.parse(rawBlock) as Record<string, unknown>;
  } catch (parseErr) {
    // Attempt repair for truncated JSON
    try {
      const openArrays = (rawBlock.match(/\[/g) ?? []).length - (rawBlock.match(/\]/g) ?? []).length;
      const openObjects = (rawBlock.match(/\{/g) ?? []).length - (rawBlock.match(/\}/g) ?? []).length;
      
      // Remove trailing incomplete tokens
      rawBlock = rawBlock.replace(/,\s*$/, "").replace(/,\s*"[^"]*$/, "").replace(/:\s*"[^"]*$/, ": \"\"");
      
      // Close unclosed structures
      rawBlock += "]".repeat(Math.max(0, openArrays)) + "}".repeat(Math.max(0, openObjects));
      
      return JSON.parse(rawBlock) as Record<string, unknown>;
    } catch {
      // If repair fails, throw original error
      throw parseErr;
    }
  }
}

function normalizeVoiceDna(raw: Record<string, unknown>) {
  const normalized: Record<string, unknown> = { ...raw };

  if (typeof normalized.sentencePattern === "string") {
    const sp = normalized.sentencePattern.toLowerCase();
    if (sp.includes("short") || sp.includes("punchy")) normalized.sentencePattern = "short-punchy";
    else if (sp.includes("long") || sp.includes("explanatory")) normalized.sentencePattern = "long-explanatory";
    else normalized.sentencePattern = "mixed";
  }

  if (typeof normalized.vocabularyLevel === "string") {
    const vl = normalized.vocabularyLevel.toLowerCase();
    if (vl.includes("academic")) normalized.vocabularyLevel = "academic";
    else if (vl.includes("technical")) normalized.vocabularyLevel = "technical";
    else if (vl.includes("pastoral")) normalized.vocabularyLevel = "pastoral";
    else normalized.vocabularyLevel = "conversational";
  }

  if (Array.isArray(normalized.signaturePhrases)) normalized.signaturePhrases = normalized.signaturePhrases.slice(0, 8);
  if (Array.isArray(normalized.preferredTerminology)) normalized.preferredTerminology = normalized.preferredTerminology.slice(0, 10);
  if (Array.isArray(normalized.rhetoricalPatterns)) normalized.rhetoricalPatterns = normalized.rhetoricalPatterns.slice(0, 6);
  if (Array.isArray(normalized.avoidWords)) normalized.avoidWords = normalized.avoidWords.slice(0, 30);
  if (Array.isArray(normalized.vernacularMarkers)) normalized.vernacularMarkers = normalized.vernacularMarkers.slice(0, 10);
  if (Array.isArray(normalized.avoidStructures)) normalized.avoidStructures = normalized.avoidStructures.slice(0, 10);

  return VoiceDNASchema.parse(normalized);
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 70000): Promise<T> {
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

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      const backoffMs = Math.min(7000, 1000 * Math.pow(2, attempt));
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`${label} failed after retries: ${detail}`);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = VoiceDNARequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  // A7: Distributed 1800-word sample (600 × start/middle/end) — tripled from 900 words
  // to improve voice coverage across 6-slot projects where the old "middle" landed near
  // a structural break rather than a peak teaching section.
  const words = input.masterTranscript.split(/\s+/);
  const total = words.length;
  const startSample = words.slice(0, 600).join(" ");
  const midStart = Math.max(600, Math.floor(total / 2) - 300);
  const midSample = words.slice(midStart, midStart + 600).join(" ");
  const endSample = words.slice(Math.max(0, total - 600)).join(" ");
  const sampleTranscript = [
    "[START]\n" + startSample,
    "[MIDDLE]\n" + midSample,
    "[END]\n" + endSample,
  ].join("\n\n---\n\n");

  const compactPrompt = `Extract Voice DNA from transcript evidence only.
Return JSON with keys:
signaturePhrases, preferredTerminology, toneProfile, sentencePattern, rhetoricalPatterns,
teachingStyle, avoidWords, vocabularyLevel, pacingFingerprint, narrativeDevice,
emotionalArc, vernacularMarkers, avoidStructures, openingPattern, closingPattern.
Rules:
- sentencePattern must be one of: short-punchy, long-explanatory, mixed
- vocabularyLevel must be one of: conversational, pastoral, academic, technical
- Max items: signaturePhrases 8, preferredTerminology 10, rhetoricalPatterns 6, avoidWords 30, vernacularMarkers 10, avoidStructures 10
- JSON only.`;

  try {
    const { object } = await withRetry(
      () => withTimeout(
        generateObject({
          model: deepSeekModel,
          schema: VoiceDNASchema,
          mode: "json",
          temperature: 0.15,
          maxTokens: 1400,
          prompt: `${compactPrompt}\n\nTranscript sample:\n${sampleTranscript}`,
        }),
        "voice-dna generateObject"
      ),
      "voice-dna generateObject",
      1
    );
    return NextResponse.json(VoiceDNASchema.parse(object), { status: 200 });
  } catch (err) {
    try {
      const { text } = await withRetry(
        () => withTimeout(
          generateText({
            model: deepSeekModel,
            temperature: 0.15,
            maxTokens: 1600,
            prompt: `${compactPrompt}\n\nTranscript sample:\n${sampleTranscript}`,
          }),
          "voice-dna generateText"
        ),
        "voice-dna generateText",
        1
      );
      const parsed = parseVoiceDnaJson(text);
      return NextResponse.json(normalizeVoiceDna(parsed), { status: 200 });
    } catch (fallbackErr) {
      const primary = err instanceof Error ? err.message : String(err);
      const secondary = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      return NextResponse.json(
        {
          route: "ebook/voice-dna",
          error: "Voice DNA extraction failed",
          details: `Primary path: ${primary} | Fallback path: ${secondary}`,
        },
        { status: 502 }
      );
    }
  }
}
