import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { BookArchitectureSchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 120;

// ── Input / Output schemas ────────────────────────────────────────────────────

const HeadingReviewRequestSchema = z.object({
  architecture: BookArchitectureSchema,
});

export type HeadingDiagnostic = {
  chapterNumber: number;
  chapterTitle: string;
  sectionNumber: number;
  sectionHeading: string;
  issues: Array<"non-parallel" | "generic" | "spoiler" | "reader-unfriendly" | "ok">;
  suggestedHeading: string | null; // null when "ok"
  explanation: string;
};

export type HeadingReviewReport = {
  diagnostics: HeadingDiagnostic[];
  overallParallelism: "strong" | "partial" | "weak";
  arcRevealScore: number; // 1–10: do headings collectively reveal the book's journey?
  summary: string;
  totalIssues: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractHeadingIndex(architecture: z.infer<typeof BookArchitectureSchema>): string {
  const lines: string[] = [];
  for (const chapter of architecture.chapters ?? []) {
    lines.push(`Chapter ${chapter.number}: "${chapter.title}"`);
    for (const section of chapter.sections ?? []) {
      lines.push(`  §${section.number} "${section.heading}"`);
    }
  }
  return lines.join("\n");
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = (await req.json()) as unknown;
  let input: z.infer<typeof HeadingReviewRequestSchema>;
  try {
    input = HeadingReviewRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 }
    );
  }

  const headingIndex = extractHeadingIndex(input.architecture);

  try {
    const { text } = await generateText({
      model: deepSeekModel,
      maxTokens: 8000,
      prompt: `You are a senior developmental editor specializing in nonfiction book architecture and reader experience.

Review the section headings in this book's table of contents and diagnose quality issues.

HEADING QUALITY CRITERIA:
1. PARALLEL FORM — All section headings within a chapter (and ideally across the whole book) should follow the same grammatical form: all noun phrases, all gerund phrases, all imperative phrases, or all questions. Mixed forms signal inconsistency.
2. READER APPEAL — Headings should intrigue or orient the reader. Generic headings like "Overview," "Background," "Application," "The Solution" are weak. Headings must be specific to the book's content.
3. ARC REVELATION — When read in sequence, the headings should collectively reveal a journey or progression. A reader scanning the TOC should sense the book's argument developing.
4. NO SPOILERS — Headings should not give away the punchline of the section before the reader has read the opening.
5. LENGTH — Headings should be 2–7 words. More than 10 words is unwieldy.

ISSUE TYPES:
- "non-parallel": Grammatical form breaks consistency within the chapter or book.
- "generic": Heading could apply to any book on the topic — lacks specific content.
- "spoiler": Heading reveals the conclusion before the reader gets there.
- "reader-unfriendly": Too long, jargon-heavy, or confusing without context.
- "ok": No significant issues.

BOOK HEADING INDEX:
${headingIndex}

Return ONLY valid JSON — no markdown fences, no commentary:
{
  "diagnostics": [
    {
      "chapterNumber": 1,
      "chapterTitle": "...",
      "sectionNumber": 1,
      "sectionHeading": "...",
      "issues": ["non-parallel"|"generic"|"spoiler"|"reader-unfriendly"|"ok"],
      "suggestedHeading": "...",
      "explanation": "one sentence explaining the issue and why the suggestion improves it"
    }
  ],
  "overallParallelism": "strong"|"partial"|"weak",
  "arcRevealScore": 7,
  "summary": "2–3 sentence editorial summary of the heading architecture's strengths and weaknesses",
  "totalIssues": 4
}`,
    });

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return NextResponse.json({ error: "Malformed LLM response" }, { status: 502 });
    }
    const parsed = JSON.parse(match[0]) as HeadingReviewReport;
    return NextResponse.json(parsed, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Heading review failed" },
      { status: 500 }
    );
  }
}
