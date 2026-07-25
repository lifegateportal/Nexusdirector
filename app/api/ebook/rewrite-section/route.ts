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

function paragraphGroundingScore(paragraph: string, excerpts: string[]): { score: number; shared: number } {
  const paraTokens = new Set(
    paragraph
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
  if (paraTokens.size === 0 || excerpts.length === 0) {
    return { score: 0, shared: 0 };
  }

  let bestScore = 0;
  let bestShared = 0;
  for (const excerpt of excerpts) {
    const excerptTokens = new Set(
      excerpt
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );
    let shared = 0;
    for (const token of paraTokens) {
      if (excerptTokens.has(token)) shared += 1;
    }
    const score = shared / Math.max(paraTokens.size, 1);
    if (score > bestScore || (score === bestScore && shared > bestShared)) {
      bestScore = score;
      bestShared = shared;
    }
  }
  return { score: bestScore, shared: bestShared };
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

  const rewriteSystem = `You are an elite developmental editor and ghostwriter rewriting one section of a published teaching book.

THE STANDARD: The rewritten section must read like a professionally published book — not a cleaned-up transcript. Every sentence should be the best possible expression of the idea it carries.

PROSE ELEVATION RULES (apply on every paragraph):
1. WORD PRECISION — Replace vague words with exact ones. "He struggled" → name what he struggled with. "It was difficult" → show what made it difficult. Concrete nouns and active verbs only.
2. ARGUMENT MOMENTUM — Each paragraph must advance the argument. No paragraph may restate what the previous one already established. Ask: "What does the reader know now that they didn't before?" If nothing new, cut or merge.
3. SHOW BEFORE TELL — If the transcript contains a story, illustration, or example that proves a point, lead with the illustration. State the principle after the reader has felt it.
4. RHYTHM — Vary sentence length deliberately. Short punches follow long explanations. Uniform medium-length sentences signal machine generation. Break the pattern.
5. PARAGRAPH CLOSE — Never end a paragraph by restating its opening sentence. Close with either a definitive statement that advances the reader or a question that creates pull toward what follows.
6. FIRST PERSON AUTHORSHIP — Write entirely as the author speaking to the reader. Never "the speaker says," "the preacher argues," or any third-person reference. Every sentence is the author's direct voice.

CONTENT FIDELITY RULES (non-negotiable):
- Use ONLY ideas present in the provided transcript excerpts. Zero fabrication.
- If an excerpt is marked [MUST INCLUDE], its core idea must appear clearly in the rewrite.
- If the source material is thin, write shorter and write it brilliantly. Never pad.
- Preserve the theological and argument order from the transcript sequence.
- No em dashes (—) anywhere in the output. Use commas, colons, or subordinate clauses instead.

Return JSON only matching the schema.`;


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
        system: `You are a senior developmental editor critiquing one section of a published teaching book. Be precise and actionable — not generic.

Evaluate on these five dimensions:
1. SOURCE FIDELITY — Does every sentence trace to the provided transcript excerpts? Flag any sentence that appears invented, extended, or inferred beyond what the transcript says.
2. PROSE QUALITY — Are sentences the best possible expression of their idea? Flag weak verbs, vague nouns, padding, clichés, AI-signature phrases ("ultimately," "in essence," "it's important to note," "transformative"), and passive constructions.
3. ARGUMENT MOMENTUM — Does each paragraph advance the argument? Flag any paragraph that restates a previous one, treads water, or fails to move the reader forward.
4. VOICE & PERSON — Is every sentence written in first person as the author? Flag any "the speaker," "the preacher," or third-person reference to the author.
5. RHYTHM & STRUCTURE — Are sentence lengths varied? Flag runs of uniform-length sentences, back-to-back rhetorical questions, and paragraphs that close with a restatement of their opening.

For each issue identified, give a specific action: not "improve the flow" but "rewrite the third sentence of paragraph 2 — it restates paragraph 1's conclusion."
Do not invent new source facts or suggest content not in the transcript.`,
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
        system: `You are refining exactly one paragraph of a published teaching book. Return only that one paragraph — never the surrounding context, never extra paragraphs.

THE STANDARD: The refined paragraph must be the best possible expression of the idea it carries, using only content present in the provided transcript excerpts.

ELEVATION RULES (apply before returning):
- WORD PRECISION: Replace every vague or weak word with the most exact one available. Cut adverbs — they are confessions of weak verbs. "He decided not to continue" → "He quit."
- SENTENCE RHYTHM: Vary sentence length. If the paragraph has three similarly-sized sentences, make one short and punchy. If it opens long, close short. Deliberate contrast is craft; uniformity is machine output.
- OPENING SENTENCE: Must not begin with the same word as the previous paragraph (provided for context). Must not restate the section heading. Drop the reader into the idea immediately.
- CLOSING SENTENCE: Must either land a definitive statement with force OR create forward pull via an unresolved implication. Never close by summarizing what the paragraph just said.
- FIRST PERSON: Write entirely as the author. No "the speaker," "the preacher," or any third-person reference to the author.
- NO EM DASHES: Never use — in any form. Use commas, colons, or subordinate clauses instead.
- SOURCE FIDELITY: Every sentence must trace to the transcript excerpts. Zero fabrication, zero extension.`,
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

    const groundedParagraphs = paragraphs.filter((paragraph) => {
      const words = paragraph.split(/\s+/).filter(Boolean).length;
      const grounding = paragraphGroundingScore(paragraph, assignment.transcriptExcerpts);
      return grounding.score >= 0.06 || grounding.shared >= 6 || words <= 14;
    });
    if (groundedParagraphs.length === 0) {
      return NextResponse.json({ error: "Rewrite produced content not grounded in assigned transcript excerpts" }, { status: 422 });
    }

    const computedUsage = groundedParagraphs.map((paragraph) => paragraphExcerptUsage(paragraph, assignment.transcriptExcerpts));

    return NextResponse.json(
      {
        body: groundedParagraphs.join("\n\n"),
        excerptUsage: (object.excerptUsage ?? computedUsage).filter((n) => n > 0),
      },
      { status: 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Section rewrite failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
