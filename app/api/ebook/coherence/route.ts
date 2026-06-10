import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { ChapterDraftSchema } from "@/lib/schemas/ebook";
import { SOURCE_LOCK_RULES } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 120;

// ─── Request / Response ───────────────────────────────────────────────────────

const CoherenceRequestSchema = z.object({
  chapter: ChapterDraftSchema,
  coreThesis: z.string().optional(),
});

const WeakTransitionSchema = z.object({
  between: z.string().describe('e.g. "§2 → §3"'),
  diagnosis: z.string().describe("Why the transition fails: abrupt, summarizing, repeated opener, etc."),
  suggestion: z.string().describe("A concrete rewrite direction. Not a full replacement — a direction."),
});

const CoherenceReportSchema = z.object({
  // Whether the chapter's opening hook is resolved or echoed in the conclusion
  hookPayoff: z.boolean().default(true),
  hookPayoffNote: z.string().default(""),
  // Whether the section sequence builds a logical arc
  arcIntegrity: z.enum(["strong", "partial", "weak"]).default("partial"),
  arcNote: z.string().default(""),
  // Tonal inconsistencies found (e.g. one section is academic, another is casual)
  tonalInconsistencies: z.array(z.string()).default([]),
  // Sections that feel like fillers — content that doesn't advance the chapter thesis
  fillerSections: z.array(z.object({
    sectionNumber: z.number(),
    reason: z.string(),
  })).default([]),
  // Weak transitions between adjacent sections
  weakTransitions: z.array(WeakTransitionSchema).default([]),
  // A revised intro if the opening paragraph doesn't earn the chapter's premise
  revisedIntro: z.string().default(""),
  // A revised conclusion if the close doesn't resolve the chapter's opening tension
  revisedConclusion: z.string().default(""),
  // Overall coherence score 1–10
  coherenceScore: z.number().min(1).max(10).default(7),
  // Summary note for display in the pipeline UI
  summary: z.string().default(""),
});

export type CoherenceReport = z.infer<typeof CoherenceReportSchema>;

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = CoherenceRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  const { chapter, coreThesis } = input;

  const sectionSummaries = (chapter.sections ?? [])
    .map((s) => {
      const opening = (s.body ?? "").split(/(?<=[.!?])\s+/).filter(Boolean)[0] ?? "";
      const closing = (s.body ?? "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(-1)[0] ?? "";
      return `§${s.sectionNumber} — ${s.heading}\n  OPENS: "${opening.slice(0, 180)}"\n  CLOSES: "${closing.slice(0, 180)}"`;
    })
    .join("\n\n");

  const chapterOpening = (chapter.intro ?? "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3).join(" ");
  const chapterClosing = (chapter.conclusion ?? "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(-3).join(" ");

  const thesisBlock = coreThesis
    ? `\nBOOK CORE THESIS: "${coreThesis}"\nEvery chapter must advance this thesis. Flag any section that has no traceable connection to it as a filler section.`
    : "";

  try {
    const { object } = await generateObject({
      model: deepSeekModel,
      schema: CoherenceReportSchema,
      mode: "json",
      temperature: 0.2,
      system: `You are a senior developmental editor reviewing a chapter for narrative coherence and logical flow.

Your job is NOT to rewrite the chapter. It is to diagnose structural problems a writer needs to fix:
1. Does the chapter's opening hook pay off in the conclusion?
2. Do sections build logically — each one advancing the argument of the previous?
3. Are there tonal inconsistencies (one section academic, another casual, another evangelical)?
4. Are there sections that feel like filler — content that doesn't advance the chapter's central argument?
5. Are there weak transitions between adjacent sections (abrupt stops, repeated openers, mechanical summaries)?
6. Does the chapter's intro earn its premise? Does the conclusion resolve the opening tension?

SCORING GUIDE for coherenceScore (1–10):
10 = Every section flows into the next; hook pays off in conclusion; no filler; tone is consistent.
7–9 = Minor weak transitions; hook largely pays off; one possible filler section.
4–6 = Multiple weak transitions; arc feels episodic rather than cumulative; hook not clearly resolved.
1–3 = Sections feel like separate sermons pasted together; no through-line; tone varies widely.

For revisedIntro / revisedConclusion: only provide a replacement if the existing one is clearly weak (fails to frame the thesis, repeats section content verbatim, or doesn't resolve the hook). Return empty string if the existing text is adequate.

${SOURCE_LOCK_RULES}`,
      prompt: `Review Chapter ${chapter.number}: "${chapter.title}" for coherence.${thesisBlock}

CHAPTER INTRO (first 3 sentences):
"${chapterOpening}"

CHAPTER CONCLUSION (last 3 sentences):
"${chapterClosing}"

SECTION OPENINGS AND CLOSINGS:
${sectionSummaries}

Provide your coherence diagnosis.`,
    });

    return NextResponse.json(object, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Coherence check failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
