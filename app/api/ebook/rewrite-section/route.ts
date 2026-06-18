import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { SectionAssignmentSchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 180;

const RequestSchema = z.object({
  assignment: SectionAssignmentSchema,
  currentBody: z.string().default(""),
  instruction: z.string().default(""),
  includeExcerptNumbers: z.array(z.number().int().positive()).default([]),
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

  const { assignment, currentBody, instruction, includeExcerptNumbers, authorConfig } = parsed.data;
  const includeSet = new Set(includeExcerptNumbers);

  const excerptBlock = assignment.transcriptExcerpts
    .map((excerpt, index) => {
      const number = index + 1;
      const forced = includeSet.has(number) ? " [MUST INCLUDE]" : "";
      return `Excerpt ${number}${forced}:\n${excerpt}`;
    })
    .join("\n\n");

  const system = [
    "You are a developmental editor rewriting one ebook section from transcript excerpts.",
    "RULES:",
    "1) Use only provided excerpt content; no fabrication.",
    "2) Keep prose polished and readable in book form.",
    "3) Preserve theological/argument order from transcript sequence.",
    "4) If an excerpt is marked [MUST INCLUDE], include its core idea clearly.",
    "5) Return JSON only matching the schema.",
  ].join("\n");

  const prompt = [
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
    const { object } = await generateObject({
      model: deepSeekModel,
      schema: ResponseSchema,
      mode: "json",
      temperature: 0.5,
      system,
      prompt,
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
