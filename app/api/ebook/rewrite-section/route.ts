import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { SectionAssignmentSchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 180;

const RequestSchema = z.object({
  mode: z.enum(["rewriteSection", "refineParagraph", "critiqueSection"]).default("rewriteSection"),
  assignment: SectionAssignmentSchema,
  currentBody: z.string().default(""),
  instruction: z.string().default(""),
  includeExcerptNumbers: z.array(z.number().int().positive()).default([]),
  paragraphIndex: z.number().int().nonnegative().optional(),
  authorConfig: z
    .object({
      instructions: z.string().default(""),
      targetAudience: z.string().default(""),
    })
    .optional(),
});

const ResponseSchema = z.object({
  paragraphs: z.array(z.string()).default([]),
  excerptUsage: z.array(z.number().int().positive()).default([]),
});

const CritiqueSchema = z.object({
  summary: z.string().default(""),
  strengths: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
});

const ParagraphRefineSchema = z.object({
  refinedParagraph: z.string().default(""),
  excerptUsage: z.array(z.number().int().positive()).default([]),
});

function splitParagraphs(body: string): string[] {
  return body
    .split(/\n\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function paragraphExcerptUsage(paragraph: string, excerpts: string[]): number {
  const words = paragraph
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return 0;

  let best = 0;
  let bestScore = 0;
  excerpts.forEach((excerpt, index) => {
    const set = new Set(
      excerpt
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
    let hits = 0;
    for (const w of words) {
      if (set.has(w)) hits += 1;
    }
    const score = hits / Math.max(words.length, 1);
    if (score > bestScore) {
      bestScore = score;
      best = index + 1;
    }
  });
  return bestScore >= 0.08 ? best : 0;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const { mode, assignment, currentBody, instruction, includeExcerptNumbers, paragraphIndex, authorConfig } = parsed.data;
  const includeSet = new Set(includeExcerptNumbers);

  const excerptBlock = assignment.transcriptExcerpts
    .map((excerpt, index) => {
      const number = index + 1;
      const forced = includeSet.has(number) ? " [MUST INCLUDE]" : "";
      return `Excerpt ${number}${forced}:\n${excerpt}`;
    })
    .join("\n\n");

  const rewriteSystem = [
    "You are a developmental editor rewriting one ebook section from transcript excerpts.",
    "RULES:",
    "1) Use only provided excerpt content; no fabrication.",
    "2) Keep prose polished and readable in book form.",
    "3) Preserve theological/argument order from transcript sequence.",
    "4) If an excerpt is marked [MUST INCLUDE], include its core idea clearly.",
    "5) Return JSON only matching the schema.",
  ].join("\n");

  const rewritePrompt = [
    `CHAPTER ${assignment.chapterNumber}: ${assignment.chapterTitle}`,
    `SECTION ${assignment.sectionNumber}: ${assignment.heading}`,
    `TARGET WORD COUNT: ${assignment.targetWordCount}`,
    "",
    "CURRENT SECTION BODY:",
    currentBody || "(empty)",
    "",
    instruction.trim() ? `USER REWRITE INSTRUCTION:\n${instruction.trim()}\n` : "",
    authorConfig?.instructions?.trim()
      ? `AUTHOR WRITING INSTRUCTION:\n${authorConfig.instructions.trim()}\n`
      : "",
    authorConfig?.targetAudience?.trim()
      ? `TARGET AUDIENCE:\n${authorConfig.targetAudience.trim()}\n`
      : "",
    "TRANSCRIPT EXCERPTS:",
    excerptBlock,
    "",
    "Return:",
    "- paragraphs: array of paragraph strings",
    "- excerptUsage: array of excerpt numbers used in the same order as paragraphs",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    if (mode === "critiqueSection") {
      const critiquePrompt = [
        `CHAPTER ${assignment.chapterNumber}: ${assignment.chapterTitle}`,
        `SECTION ${assignment.sectionNumber}: ${assignment.heading}`,
        "",
        "SECTION BODY:",
        currentBody || "(empty)",
        "",
        "SOURCE EXCERPTS:",
        excerptBlock,
        "",
        instruction.trim() ? `USER NOTE:\n${instruction.trim()}\n` : "",
        "Return concise editorial guidance:",
        "- summary: one sentence",
        "- strengths: up to 4",
        "- issues: up to 6",
        "- actions: up to 6 concrete edits",
      ].filter(Boolean).join("\n");

      const { object } = await generateObject({
        model: deepSeekModel,
        schema: CritiqueSchema,
        mode: "json",
        temperature: 0.35,
        system: "You are an editorial assistant. Critique for clarity, flow, source fidelity, and voice consistency. Do not invent new source facts.",
        prompt: critiquePrompt,
      });

      return NextResponse.json(object, { status: 200 });
    }

    if (mode === "refineParagraph") {
      const paragraphs = splitParagraphs(currentBody);
      if (paragraphs.length === 0) {
        return NextResponse.json({ error: "Section has no paragraphs to refine" }, { status: 422 });
      }
      if (typeof paragraphIndex !== "number" || paragraphIndex < 0 || paragraphIndex >= paragraphs.length) {
        return NextResponse.json({ error: "Invalid paragraph index for refineParagraph mode" }, { status: 400 });
      }

      const targetParagraph = paragraphs[paragraphIndex];
      const prevParagraph = paragraphIndex > 0 ? paragraphs[paragraphIndex - 1] : "";
      const nextParagraph = paragraphIndex < paragraphs.length - 1 ? paragraphs[paragraphIndex + 1] : "";

      const refinePrompt = [
        `CHAPTER ${assignment.chapterNumber}: ${assignment.chapterTitle}`,
        `SECTION ${assignment.sectionNumber}: ${assignment.heading}`,
        `PARAGRAPH INDEX TO REFINE: ${paragraphIndex + 1} of ${paragraphs.length}`,
        "",
        "PREVIOUS PARAGRAPH (context):",
        prevParagraph || "(none)",
        "",
        "TARGET PARAGRAPH (rewrite only this):",
        targetParagraph,
        "",
        "NEXT PARAGRAPH (context):",
        nextParagraph || "(none)",
        "",
        instruction.trim() ? `USER INSTRUCTION:\n${instruction.trim()}\n` : "",
        "SOURCE EXCERPTS:",
        excerptBlock,
        "",
        "Return JSON with:",
        "- refinedParagraph: rewritten paragraph only (do not include other paragraphs)",
        "- excerptUsage: excerpt numbers used",
      ].filter(Boolean).join("\n");

      const { object } = await generateObject({
        model: deepSeekModel,
        schema: ParagraphRefineSchema,
        mode: "json",
        temperature: 0.35,
        system: "You are refining exactly one paragraph. Preserve section continuity and speaker fidelity. Never return any extra paragraphs.",
        prompt: refinePrompt,
      });

      const refinedParagraph = (object.refinedParagraph ?? "").trim();
      if (!refinedParagraph) {
        return NextResponse.json({ error: "Refined paragraph was empty" }, { status: 422 });
      }

      const merged = [...paragraphs];
      merged[paragraphIndex] = refinedParagraph;
      const mergedBody = merged.join("\n\n");
      const usage = (object.excerptUsage ?? []).filter((n) => n > 0);

      return NextResponse.json({ body: mergedBody, excerptUsage: usage }, { status: 200 });
    }

    const { object } = await generateObject({
      model: deepSeekModel,
      schema: ResponseSchema,
      mode: "json",
      temperature: 0.5,
      system: rewriteSystem,
      prompt: rewritePrompt,
    });

    const paragraphs = (object.paragraphs ?? []).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) {
      return NextResponse.json({ error: "Rewrite returned empty output" }, { status: 422 });
    }

    const computedUsage = paragraphs.map((paragraph) => paragraphExcerptUsage(paragraph, assignment.transcriptExcerpts));

    return NextResponse.json(
      {
        body: paragraphs.join("\n\n"),
        excerptUsage: (object.excerptUsage ?? computedUsage).filter((n) => n > 0),
      },
      { status: 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Section rewrite failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
