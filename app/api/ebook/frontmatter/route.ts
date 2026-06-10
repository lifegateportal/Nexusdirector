import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { deepSeekReasonerModel } from "@/lib/ai-providers";
import { FrontMatterRequestSchema, FrontBackMatterSchema } from "@/lib/schemas/ebook";
import { PREMIUM_BOOK_STYLE_RULES, READER_NORMALIZATION_RULES, SOURCE_LOCK_RULES, stripAudienceLanguage } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 180;

// LLM generates introduction + conclusion only — no preface
const IntroConclSchema = FrontBackMatterSchema.omit({ preface: true, scriptureIndex: true });

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = FrontMatterRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  const transcript = typeof input.masterTranscript === "string" ? input.masterTranscript : "";
  const authorConfig = input.authorConfig;
  const authorConfigBlock = (authorConfig?.instructions || authorConfig?.targetAudience)
    ? `\n\n════════════════════════════════════════════\nAUTHOR BOOK CONFIGURATION (highest priority)\n════════════════════════════════════════════${authorConfig.targetAudience ? `\nTARGET AUDIENCE: ${authorConfig.targetAudience}` : ""}${authorConfig.instructions ? `\nAUTHOR WRITING INSTRUCTIONS: ${authorConfig.instructions}` : ""}`
    : "";

  try {
    const { object } = await generateObject({
      model: deepSeekReasonerModel,
      schema: IntroConclSchema,
      mode: "json",
      temperature: 1,  // reasoner requires temperature=1
      system: `You are an editorial assistant writing the introduction and conclusion of a published teaching book.

ABSOLUTE CONTENT RULE — ZERO FABRICATION:
Every sentence must come verbatim-idea from the provided transcript. You may not add content, context, or ideas not present in the audio/transcript — not even plausible extensions, inferred background, theological context the author "probably" knows, or biographical details you can reasonably assume. If you cannot point to the exact idea in the transcript text below, delete the sentence. Write shorter output rather than pad with invented content.

════════════════════════════════════════════
INTRODUCTION
════════════════════════════════════════════
- Speak in first person as the author introducing the book directly to the reader.
- Focus on the book's purpose, core themes, and invitation to the reader.
- Do not describe the author from a third-person perspective.
- 3–5 paragraphs. Apply all preface guardrails above.

════════════════════════════════════════════
BACK MATTER
════════════════════════════════════════════
- conclusion: Drawn from the closing moments of the teaching, rewritten as a book closing — not an altar call or dismissal. 2–4 paragraphs.
- aboutAuthor: ONLY write if the author spoke about themselves, their background, or their story. Return null if not.
- resourcesList: Books, tools, websites, or resources the author explicitly recommended. Return [] if none mentioned.

SCRIPTURE & QUOTE FORMATTING: Apply Chicago Manual of Style rules as established in the chapter content.
VOICE ENFORCEMENT: Match the author's tone profile and signature phrases.

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PREMIUM_BOOK_STYLE_RULES}${authorConfigBlock}`,
      prompt: `Write the front and back matter for this ebook.

BOOK TITLE: ${input.architecture.bookTitle}
AUTHOR: ${input.architecture.authorName}

ARCHITECTURE CONTEXT:
- Chapters: ${input.architecture.chapters.map((c) => c.title).join(", ")}
- Front matter notes (opening): ${input.architecture.frontMatterNotes}
- Back matter notes (closing): ${input.architecture.backMatterNotes}

VOICE DNA:
${JSON.stringify(input.voiceDNA, null, 2)}

FULL TRANSCRIPT (source of truth — opening & closing only):
${transcript.slice(0, 5000)}

[… middle omitted …]

${transcript.slice(-3000)}`,
    });

    return NextResponse.json({
      ...object,
      preface: "",
      introduction: stripAudienceLanguage(object.introduction ?? ""),
      conclusion: stripAudienceLanguage(object.conclusion ?? ""),
      aboutAuthor: object.aboutAuthor ? stripAudienceLanguage(object.aboutAuthor) : null,
      resourcesList: (object.resourcesList ?? []).map((r) => stripAudienceLanguage(r)),
      scriptureIndex: (() => {
        const seenRefs = new Set<string>();
        return (input.architecture?.chapters ?? [])
          .flatMap((c) => c.quotesInChapter ?? [])
          .filter((q) => q.type === "scripture" && q.reference?.trim())
          .sort((a, b) => a.reference.localeCompare(b.reference))
          .reduce<string[]>((acc, q) => {
            const entry = `${q.reference}${q.translation ? ` (${q.translation})` : ""}`;
            if (!seenRefs.has(entry)) { seenRefs.add(entry); acc.push(entry); }
            return acc;
          }, []);
      })(),
    }, { status: 200 });
  } catch (err) {
    const middle = transcript.slice(Math.floor(transcript.length * 0.05), 5200).trim();
    const closing = transcript.slice(-2200).trim();
    return NextResponse.json({
      preface: "",
      introduction: stripAudienceLanguage(middle || "Introduction unavailable."),
      conclusion: stripAudienceLanguage(closing || "Conclusion unavailable."),
      aboutAuthor: null,
      resourcesList: [],
      scriptureIndex: [],
    }, { status: 200 });
  }
}
