import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { curatorModel } from "@/lib/ai-providers";
import { EbookManifestSchema, ChapterDraftSchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 120;

const RequestSchema = z.object({
  manifest: EbookManifestSchema,
  instruction: z.string().min(1).max(4000),
  chapterNumber: z.union([z.number().int().min(1), z.literal("frontmatter")]),
});

// ── Output schemas ────────────────────────────────────────────────────────────

const FormatSectionSchema = z.object({
  sectionNumber: z.number(),
  body: z.string(),
});

const FormatChapterOutputSchema = z.object({
  intro: z.string(),
  conclusion: z.string(),
  sections: z.array(FormatSectionSchema),
  summary: z.string(),
});

const FormatFrontMatterOutputSchema = z.object({
  preface: z.string(),
  introduction: z.string(),
  conclusion: z.string(),
  aboutAuthor: z.string().nullable(),
  summary: z.string(),
});

// ── System prompt ─────────────────────────────────────────────────────────────

const FORMATTER_SYSTEM = `You are a professional typographic editor for published teaching books. Your sole task is to apply rich markdown formatting to the provided prose.

ABSOLUTE RULES:
- DO NOT change, add, or remove any words, sentences, or ideas
- PRESERVE the author's voice, vocabulary, and content exactly
- ONLY apply markdown formatting markers
- Return EVERY section that was given to you — do not skip any

FORMATTING STANDARDS TO APPLY:
1. **Bold** — wrap key terms, core concepts, and must-remember phrases in **double asterisks**
2. *Italics* — wrap book/scripture titles mentioned inline, technical terms on first use, and words used for special emphasis in *single asterisks*
3. > Block quotes — prefix any direct scripture quotation or extended quote (40+ words) with >
4. Lists — if a sentence enumerates 3 or more items separated by commas or semicolons, convert to a markdown bullet list (- item) or numbered list (1. item) as appropriate
5. Paragraphs — ensure each new idea or paragraph is separated by a blank line
6. ### Sub-headings — within section body prose, if a clearly distinct sub-concept is introduced, add a ### Sub-heading before it

Return the FULL formatted text for every section with all original words intact.`;

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = RequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  const { manifest, instruction, chapterNumber } = input;

  try {
    // ── Front matter formatting ───────────────────────────────────────────────
    if (chapterNumber === "frontmatter") {
      const fm = manifest.frontMatter;
      const parts: string[] = [];
      if (fm.preface?.trim())       parts.push(`PREFACE:\n${fm.preface}`);
      if (fm.introduction?.trim())  parts.push(`INTRODUCTION:\n${fm.introduction}`);
      if (fm.conclusion?.trim())    parts.push(`CONCLUSION:\n${fm.conclusion}`);
      if (fm.aboutAuthor?.trim())   parts.push(`ABOUT THE AUTHOR:\n${fm.aboutAuthor}`);

      if (parts.length === 0) {
        return NextResponse.json({ frontMatter: fm, summary: "No front matter content to format." });
      }

      const { object } = await generateObject({
        model: curatorModel,
        schema: FormatFrontMatterOutputSchema,
        mode: "tool",
        temperature: 0.05,
        maxTokens: 10000,
        system: FORMATTER_SYSTEM,
        prompt: [
          `FORMATTING INSTRUCTION: ${instruction}`,
          "",
          "FRONT MATTER TO FORMAT:",
          ...parts,
        ].join("\n\n"),
      });

      const formatted = {
        preface:      object.preface      || fm.preface,
        introduction: object.introduction || fm.introduction,
        conclusion:   object.conclusion   || fm.conclusion,
        aboutAuthor:  object.aboutAuthor  ?? fm.aboutAuthor,
        resourcesList: fm.resourcesList,
      };
      return NextResponse.json({ frontMatter: formatted, summary: object.summary });
    }

    // ── Chapter formatting ────────────────────────────────────────────────────
    const chapter = manifest.chapters.find((c) => c.number === chapterNumber);
    if (!chapter) {
      return NextResponse.json({ error: `Chapter ${chapterNumber} not found` }, { status: 404 });
    }

    const sectionBlocks = chapter.sections.map(
      (s) => `SECTION ${s.sectionNumber}: ${s.heading}\n${s.body ?? ""}`,
    );

    const { object } = await generateObject({
      model: curatorModel,
      schema: FormatChapterOutputSchema,
      mode: "tool",
      temperature: 0.05,
      maxTokens: 16000,
      system: FORMATTER_SYSTEM,
      prompt: [
        `FORMATTING INSTRUCTION: ${instruction}`,
        "",
        `CHAPTER ${chapter.number}: "${chapter.title}"`,
        "",
        chapter.intro?.trim() ? `CHAPTER INTRO:\n${chapter.intro}` : null,
        ...sectionBlocks,
        chapter.conclusion?.trim() ? `CHAPTER CONCLUSION:\n${chapter.conclusion}` : null,
      ].filter(Boolean).join("\n\n---\n\n"),
    });

    // Merge formatted content back — preserve all non-body fields (title, wordCount, etc.)
    const mergedChapter = ChapterDraftSchema.parse({
      ...chapter,
      intro:      object.intro       || chapter.intro,
      conclusion: object.conclusion  || chapter.conclusion,
      sections: chapter.sections.map((s) => {
        const formatted = object.sections.find((fs) => fs.sectionNumber === s.sectionNumber);
        // Safety: only apply if the returned body is non-empty and not dramatically shorter
        const originalWords = (s.body ?? "").split(/\s+/).filter(Boolean).length;
        const returnedWords = (formatted?.body ?? "").split(/\s+/).filter(Boolean).length;
        const bodyToUse =
          formatted?.body && returnedWords >= originalWords * 0.85
            ? formatted.body
            : s.body;
        return { ...s, body: bodyToUse };
      }),
    });

    return NextResponse.json({ chapter: mergedChapter, summary: object.summary });

  } catch (err) {
    const message = err instanceof Error ? err.message : "Format operation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
