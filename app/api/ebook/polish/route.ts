import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { deepSeekModel } from "@/lib/ai-providers";
import { z } from "zod";
import { PolishChapterRequestSchema } from "@/lib/schemas/ebook";
import { PREMIUM_BOOK_STYLE_RULES, READER_NORMALIZATION_RULES, SOURCE_LOCK_RULES } from "@/lib/editorial-style-bible";
import { stripAudienceLanguage } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 300;

// Slim output — section bodies are already written; LLM only adds framing + takeaways
const PolishOutputSchema = z.object({
  intro: z.string().default(""),
  forwardQuestion: z.string().default(""),
  keyTakeaways: z.array(z.string()).default([]),
  reflectionQuestions: z.array(z.string()).default([]),
  epigraph: z.string().default(""),
  // Upgrade 5: section boundary transitions
  sectionTransitions: z.array(z.object({
    sectionNumber: z.number(),
    revisedLastSentence: z.string(),
  })).default([]),
});

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 80000): Promise<T> {
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

async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      const backoffMs = Math.min(9000, 1200 * Math.pow(2, attempt));
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`${label} failed after retries: ${detail}`);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return NextResponse.json(
      {
        route: "ebook/polish",
        error: err instanceof Error ? err.message : "Invalid JSON payload",
      },
      { status: 400 }
    );
  }

  let input;
  try {
    input = PolishChapterRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  const { input: chapter } = input;
  const authorConfig = input.authorConfig;
  const authorConfigBlock = (authorConfig?.instructions || authorConfig?.targetAudience)
    ? `\n\nAUTHOR BOOK CONFIGURATION (highest priority):\n${authorConfig.targetAudience ? `TARGET AUDIENCE: ${authorConfig.targetAudience}` : ""}${authorConfig.instructions ? `\nAUTHOR WRITING INSTRUCTIONS: ${authorConfig.instructions}` : ""}`
    : "";

  try {
    // ── Amendment 3: Section summary now includes first 2 sentences of actual prose.
    // Previously: only section headings were sent, so the intro LLM was generating
    // openers that were disconnected from the chapter's actual arguments.
    // Now: the first 2 sentences of each section's opening paragraph ground the LLM
    // in real content — not just metadata — without risking the verbatim-mirroring
    // problem (which was caused by sending the FULL first paragraph, not a 2-sentence sample).
    const sectionsSummary = (chapter.sections ?? [])
      .map((s) => {
        const bodySentences = (s.body ?? "")
          .split(/(?<=[.!?])\s+/)
          .map((sent) => sent.trim())
          .filter(Boolean)
          .slice(0, 2)
          .join(" ");
        const proseHint = bodySentences ? `\n   Opens: "${bodySentences.slice(0, 180)}${bodySentences.length > 180 ? "…" : ""}"` : "";
        return `Section ${s.sectionNumber} — ${s.heading}${proseHint}`;
      })
      .join("\n\n");

    const totalWordCount = (chapter.sections ?? []).reduce((acc, s) => acc + (s.wordCount ?? 0), 0);

    // Trim VoiceDNA to key fields only to keep the prompt small and response fast
    const voiceDNASlim = {
      signaturePhrases: (chapter.voiceDNA?.signaturePhrases ?? []).slice(0, 6),
      toneProfile: chapter.voiceDNA?.toneProfile ?? "",
      preferredTerminology: (chapter.voiceDNA?.preferredTerminology ?? []).slice(0, 6),
      avoidWords: (chapter.voiceDNA?.avoidWords ?? []).slice(0, 8),
    };

    const epigraphCandidates = (chapter.quotesInChapter ?? [])
      .filter((q) => q.type === "scripture")
      .slice(0, 5)
      .map((q) => `"${q.text.slice(0, 120)}" \u2014 ${q.reference}${q.translation ? ` (${q.translation})` : ""}`)
      .join("\n");

    const prevChapterBlock = chapter.previousChapterForwardQuestion
      ? `\n\nPREVIOUS CHAPTER FORWARD QUESTION (the open question that closed the last chapter — your intro should feel like the answer beginning to form):\n${chapter.previousChapterForwardQuestion.slice(0, 200)}`
      : "";

    // ── Amendment 6: Forward question is grounded in the NEXT chapter's content.
    // Previously the forward question was generated with no knowledge of what the
    // next chapter actually covers — producing generic "open door" questions that
    // may not match what comes next. Now the next chapter title is supplied so the
    // LLM can write a question the reader will feel was answered by what follows.
    const nextChapterBlock = chapter.nextChapterTitle
      ? `\n\nNEXT CHAPTER (for FORWARD QUESTION only — do not reference in intro or conclusion):\n"${chapter.nextChapterTitle}"\nYour forward question must create a tension the reader will feel resolved by that chapter. Write it so that, looking back after reading the next chapter, the reader thinks: "That question was exactly what I needed answered." Do not name the next chapter. Do not preview its content. Plant the question that opens the door it walks through.`
      : "";

    // U5: Chapter premise from architect — constrains the intro and premise line
    const chapterPremiseBlock = chapter.chapterPremise
      ? `\n\nCHAPTER PREMISE (from blueprint — your intro and premise line must serve this north star):\n${chapter.chapterPremise}`
      : "";

    // U7: Series arc bridge — tells the intro what conceptual thread to pick up from the previous chapter
    const seriesArcBlock = chapter.seriesArcBridge
      ? `\n\nSERIES ARC BRIDGE: The previous chapter's closing thread was: "${chapter.seriesArcBridge}". The intro of this chapter should feel like a natural continuation of that thread — not a restatement, but a forward step.`
      : "";

    // ── Upgrade 5: Section boundary data for transition review ───────────
    // Extract last 2 sentences from each section and first 2 sentences of the next,
    // so the LLM can identify and improve weak handoffs between sections.
    const sections = chapter.sections ?? [];
    const sectionBoundariesBlock = sections.length > 1
      ? `\n\nSECTION BOUNDARY REVIEW:\n${sections.slice(0, -1).map((sec, idx) => {
          const nextSec = sections[idx + 1];
          const lastSents = (sec.body ?? "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(-2).join(" ");
          const firstSents = (nextSec.body ?? "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 2).join(" ");
          return `• Boundary after §${sec.sectionNumber} → §${nextSec.sectionNumber}:\n  ENDS: "${lastSents.slice(0, 200)}"\n  OPENS: "${firstSents.slice(0, 200)}"`;
        }).join("\n")}`
      : "";

    const { object } = await withRetry(
      () => withTimeout(generateObject({
        model: deepSeekModel,
        schema: PolishOutputSchema,
        mode: "tool",
        temperature: 0.2,
        system: `You are an editorial assistant finalizing a chapter of a published teaching book.

ABSOLUTE CONTENT RULE: Every sentence must come from the provided transcript content.
Do NOT add new ideas, examples, or explanations not present in the transcript.

EM DASH ABSOLUTE BAN: Never use an em dash (—) in any output. No spaced em dashes ( — ), no unspaced em dashes (—), no double hyphens (--) used as em dashes. Use a comma, colon, or split into two sentences instead.

HUMANIZATION: Use contractions naturally. Avoid "not just...but", "not merely...but", "indeed,", "certainly,", "ultimately,", "at its core", "in essence", "profoundly", "transformative". Break any run of three parallel-structured sentences.

Your tasks:
1. EPIGRAPH: From the provided scripture candidates, pick the ONE most resonant opening quote for this chapter. Return it formatted as: "Quote text." — Reference (Translation). If no candidate strongly fits or none are provided, return an empty string. Never invent a quote.
2. INTRO (CONSOLIDATED CHAPTER OPENER): Two sentences — no more, no less.
   Sentence 1: ONE bold declarative statement — the north star thesis of this chapter. States what is at stake, what will be proven, or what the reader will discover. Present tense. Direct. Max 20 words.
   Sentence 2: ONE provocative question that makes the reader feel the personal stakes and need to read on. Sharp, specific to this chapter's content — not generic.
   The two sentences must work as a unit: the first declares, the second destabilizes. Together they are the door into the chapter.
   WRONG: "In this chapter, we'll explore what it means to walk in faith. This is an important topic."
   RIGHT: "Faith is not the absence of doubt — it is action taken despite it. So why do so many of us pray for more faith instead of just moving?"
   CRITICAL: Do NOT copy the opening sentences of Section 1. Do NOT summarize the chapter contents.
   CONNECTIVE TISSUE: If a "PREVIOUS CHAPTER FORWARD QUESTION" is provided, sentence 1 should feel like the answer beginning to form.
3. FORWARD QUESTION: ONE sentence — a preemptive question that plants anticipation for where the book goes next.
   This is the last thing the reader sees before turning the page. It should feel like an open door, not a closed summary.
   It must point forward, not backward. Never restate what the chapter covered.
   WRONG: "We've seen how faith requires action." RIGHT: "But what happens when you've done everything right and nothing moves?"
   If a NEXT CHAPTER is provided in the prompt: write a question the reader will feel was answered by that chapter. It should feel, looking back after reading it, like it was pointing there all along. Do not name or preview the next chapter.
    If this is the final chapter (no NEXT CHAPTER provided): write a question that sends the reader back into life with something unresolved and worth carrying.
4. KEY TAKEAWAYS: 3–6 bullet statements taken VERBATIM or near-verbatim from the chapter content.
5. REFLECTION QUESTIONS: 3–4 questions that are SPECIFIC, PERSONAL, and ACTIONABLE.
   REQUIRED: Each question must reference a concrete claim, story, or scripture from this chapter.
   FORBIDDEN generic forms: "How does X shape the message?", "What is the main message?", "What should the reader carry forward?", "How can you apply this?".
   REQUIRED: Name the specific idea, then ask about its implication in the reader's real life. Example: "Peter says diligence is required, not passive waiting — where in your life are you waiting for God to act when He has already told you to move?"
6. SECTION TRANSITIONS: Review the SECTION BOUNDARY data provided. For each boundary, evaluate whether the current ending sentence of section N creates genuine forward momentum into section N+1. If the handoff feels abrupt, mechanical, or summarizing, write a replacement last sentence for that section. Rules:
   • The revised sentence must be drawn from section N's OWN content — never preview section N+1's ideas.
   • It must create forward tension via an unresolved question, an open implication, or a logical pull — not a summary.
   • If the existing ending is already strong (creates pull, avoids summarizing), return an empty string for that section — do NOT change it.
   • Return as sectionTransitions array: [{"sectionNumber": N, "revisedLastSentence": "...or empty string"}].

VOICE: Use the author's signature phrases and preferred terminology consistently. Never swap a synonym for variety when the author has a preferred term. Do not use words in the avoidWords list.

READER NORMALIZATION:
- Remove live-audience language and stage commands.
- Rewrite spoken-room references into reader-facing prose.

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PREMIUM_BOOK_STYLE_RULES}${authorConfigBlock}

Respond with ONLY a valid JSON object — no markdown, no code blocks, no explanation:
{"intro":"...","forwardQuestion":"...","keyTakeaways":["..."],"reflectionQuestions":["..."],"epigraph":"...","sectionTransitions":[{"sectionNumber":1,"revisedLastSentence":"..."}]}`,
        prompt: `Finalize this chapter.\n\nCHAPTER ${chapter.number}: ${chapter.title}\n\nVOICE DNA:\n${JSON.stringify(voiceDNASlim)}\n\nSECTION SUMMARIES:\n${sectionsSummary}${epigraphCandidates ? `\n\nSCRIPTURE CANDIDATES FOR EPIGRAPH (pick the most resonant ONE, or return empty string if none fits):\n${epigraphCandidates}` : ""}${prevChapterBlock}${nextChapterBlock}${chapterPremiseBlock}${seriesArcBlock}${sectionBoundariesBlock}`,
      }), "chapter polish generation"),
      "chapter polish",
      2
    );

    // Merge: preserve section bodies that were already written
    // ── Upgrade 14: Epigraph source credibility flag ─────────────────────
    // Flag any epigraph attribution that doesn't match a recognized Bible book pattern.
    // This catches hallucinated scripture references or misattributed quotes.
    const BIBLE_BOOK_PATTERN = /\b(genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalms?|proverbs?|ecclesiastes|song of solomon|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation|gen|ex|lev|num|deut|josh|judg|prov|ps|psa|eccl|isa|jer|lam|ezek|dan|hos|mal|matt|mk|lk|jn|rom|cor|gal|eph|phil|col|thess|tim|tit|heb|jas|rev)\b/i;
    const VERSE_REFERENCE_PATTERN = /\d+:\d+/;
    let epigraphCredibilityWarning: string | null = null;
    if (object.epigraph && object.epigraph.trim().length > 0) {
      const epigraphText = object.epigraph;
      // Attempt to extract the attribution (after the last — or - or in parens at end)
      const attrMatch = epigraphText.match(/[—\-–]\s*(.+?)(\s*\(.*?\))?$/);
      const attribution = attrMatch?.[1]?.trim() ?? "";
      if (attribution && !BIBLE_BOOK_PATTERN.test(attribution) && !VERSE_REFERENCE_PATTERN.test(attribution)) {
        epigraphCredibilityWarning = `Epigraph attribution "${attribution}" does not match a recognized scripture reference. Verify this source before publishing.`;
        console.warn(`[polish] ${epigraphCredibilityWarning}`);
      }
    }

    // ── Upgrade 5: Apply section transition revisions to section bodies ──
    const patchedSections = (chapter.sections ?? []).map((sec) => {
      const transition = (object.sectionTransitions ?? []).find(
        (t) => t.sectionNumber === sec.sectionNumber && t.revisedLastSentence?.trim()
      );
      if (!transition) return sec;
      // Replace the last sentence of the section body with the revised one
      const sentences = (sec.body ?? "").split(/(?<=[.!?])\s+/).filter(Boolean);
      if (sentences.length === 0) return sec;
      sentences[sentences.length - 1] = transition.revisedLastSentence.trim();
      return { ...sec, body: sentences.join(" ") };
    });
    const merged = {
      ...object,
      intro: stripAudienceLanguage(object.intro ?? ""),
      forwardQuestion: stripAudienceLanguage(object.forwardQuestion ?? ""),
      keyTakeaways: (object.keyTakeaways ?? []).map((t) => stripAudienceLanguage(t)),
      reflectionQuestions: (object.reflectionQuestions ?? []).map((q) => stripAudienceLanguage(q)),
      epigraph: object.epigraph ?? "",
      number: chapter.number,
      title: chapter.title,
      sections: patchedSections,
      totalWordCount,
      status: "complete" as const,
      ...(epigraphCredibilityWarning ? { epigraphCredibilityWarning } : {}),
    };

    return NextResponse.json(merged, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chapter polish failed";
    return NextResponse.json({
      route: "ebook/polish",
      error: "Chapter polish failed",
      details: message,
    }, { status: 502 });
  }
}
