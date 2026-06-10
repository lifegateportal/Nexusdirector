import { NextRequest } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel, deepSeekReasonerModel } from "@/lib/ai-providers";
import { ProduceInputSchema, AcademyPackageSchema, AcademyShellSchema } from "@/lib/schemas/academy";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = ProduceInputSchema.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return new Response(JSON.stringify({ error: message }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const encoder = new TextEncoder();

  // SSE stream — keeps the connection alive with ping comments so reverse
  // proxies don't close the socket while DeepSeek generates the large object.
  const stream = new ReadableStream({
    async start(controller) {
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ }
      }, 15_000);

      try {
        // Phase 1 source: sample beginning + middle + end of the FULL raw input
        // so the curriculum reflects the entire book, not just the opening pages.
        // Uses input.rawTranscript (pre-truncation) to capture the full range.
        const buildPhase1Source = (text: string | undefined): string => {
          if (!text) return "";
          const SAMPLE = 4_500; // chars per sample point (~1,200 tokens)
          const len = text.length;
          const beginning = text.slice(0, SAMPLE);
          const midStart  = Math.max(SAMPLE, Math.floor(len / 2) - Math.floor(SAMPLE / 2));
          const middle    = len > SAMPLE * 2 ? text.slice(midStart, midStart + SAMPLE) : "";
          const ending    = len > SAMPLE     ? text.slice(Math.max(0, len - SAMPLE))   : "";
          return [beginning, middle, ending].filter(Boolean).join("\n\n[…]\n\n");
        };
        const phase1Source = buildPhase1Source(input.rawTranscript);
        const phase1SourceSection = phase1Source
          ? `\n\nSOURCE MATERIAL (sampled: beginning · middle · end of the full document):\n${phase1Source}`
          : "";

        const deliverySection = input.deliveryInstructions
          ? `\n\nDELIVERY INSTRUCTIONS:\n${input.deliveryInstructions}`
          : "";

        const basePrompt = JSON.stringify({
          title: input.title,
          summary: input.summary,
          assets: input.assets,
          workflow: input.workflow,
          executionPlan: input.executionPlan,
          entities: input.entities,
          visualDirection: input.visualDirection,
        });

        // ── Scale: calibrate module/theme count to source length ─────────────
        // Spoken-word transcripts run ~800 chars/min with Deepgram formatting.
        // Text files scale similarly by content density.
        const transcriptChars = (input.rawTranscript ?? "").length;
        const estMinutes      = Math.max(1, Math.round(transcriptChars / 800));
        const scale = estMinutes < 5
          ? { minThemes: 1, maxThemes: 2, minMods: 1, maxMods: 1, maxIdx: 1 }
          : estMinutes < 15
          ? { minThemes: 2, maxThemes: 2, minMods: 2, maxMods: 2, maxIdx: 1 }
          : estMinutes < 40
          ? { minThemes: 3, maxThemes: 3, minMods: 3, maxMods: 3, maxIdx: 2 }
          : { minThemes: 3, maxThemes: 4, minMods: 3, maxMods: 4, maxIdx: 3 };

        const themeCountLabel = scale.minThemes === scale.maxThemes
          ? `exactly ${scale.minThemes}`
          : `${scale.minThemes}\u2013${scale.maxThemes}`;
        const modCountLabel = scale.minMods === scale.maxMods
          ? `exactly ${scale.minMods}`
          : `${scale.minMods}\u2013${scale.maxMods}`;

        // ── Phase 0: Content map ────────────────────────────────────────
        // Force DeepSeek to READ and MAP the source's distinct themes BEFORE
        // designing the curriculum. Each theme gets direct source passages so
        // every module is anchored to real, non-overlapping content.
        const ThemeEntrySchema = z.object({
          index:        z.number().int().min(0).max(scale.maxIdx),
          title:        z.string(),
          summary:      z.string(),
          keyPassages:  z.array(z.string()).min(1).max(3),
          sourceRegion: z.enum(["beginning", "early-middle", "late-middle", "end"]),
        });
        const ContentMapSchema = z.object({
          themes: z.array(ThemeEntrySchema).min(scale.minThemes).max(scale.maxThemes),
        });
        type ContentMap = z.infer<typeof ContentMapSchema>;

        const phase0Source = phase1Source || input.rawTranscript?.slice(0, 12_000) || "";
        let contentMap: ContentMap = { themes: [] };
        if (phase0Source) {
          const { object: map } = await generateObject({
            model: deepSeekReasonerModel,
            schema: ContentMapSchema,
            schemaName: "ContentMap",
            schemaDescription: "Distinct major themes found in the source material",
            mode: "json",
            maxTokens: 1_200,
            temperature: 0.1,
            system: `You are a source analyst. Read the material and identify ${themeCountLabel} completely DISTINCT major theme${scale.maxThemes === 1 ? "" : "s"} or sections. Cover the FULL arc of the document.

For each theme:
- index: 0-based (0 = first theme in the source)
- title: 4–7 words, the theme name using the source's own language
- summary: exactly 2 sentences — what the source specifically says about this theme
- keyPassages: 2–3 short verbatim or near-verbatim quotes (10–30 words each) taken directly from the source for this theme
- sourceRegion: where this theme appears in the document: "beginning" | "early-middle" | "late-middle" | "end"

RULES — non-negotiable:
- Every theme must be DISTINCT — zero conceptual overlap between themes
- keyPassages must be actual text from the source, not paraphrases
- Assign themes across the full document — themes must span beginning to end, not cluster in one region
- Do NOT invent content absent from the source`,
            prompt: `SOURCE MATERIAL:\n${phase0Source}`,
          });
          contentMap = map;
        }

        // Build a content map string for Phase 1 injection
        const contentMapSection = contentMap.themes.length > 0
          ? `\n\nCONTENT MAP — your curriculum MUST map exactly to these themes (one theme per module):\n${contentMap.themes.map((t) =>
              `MODULE ${t.index + 1}: "${t.title}"\n  What the source says: ${t.summary}\n  Source passages: ${t.keyPassages.map(p => `"${p}"`).join(" | ")}`
            ).join("\n\n")}`
          : "";

        // ── Phase 1: Academy shell ─────────────────────────────────────────────
        // Generates all metadata, landing page, pricing, SEO, and module outlines
        // with lightweight lesson stubs only. Stays well under the 8K output limit.
        const { object: shell } = await generateObject({
          model: deepSeekModel,
          schema: AcademyShellSchema,
          schemaName: "AcademyShell",
          schemaDescription: "Academy structure with landing page, pricing, SEO, and lesson outlines — no lesson content",
          mode: "json",
          maxTokens: 6_000,
          temperature: 0.3,
          system: `You are the Curator — a world-class educational content architect. Transform source material into an online academy structure.

OUTPUT ALL ACADEMY FIELDS. TOKEN BUDGET IS TIGHT — be concise in every field.

FOR THE CURRICULUM: produce ${modCountLabel} module${scale.maxMods === 1 ? "" : "s"} (HARD MAX ${scale.maxMods}). Each module gets exactly 2–3 lesson outlines (HARD MAX 3). Lesson outline = title + type + durationMinutes only.
DO NOT write notes, quiz, keyTakeaways, or actionItems in this phase.

CURRICULUM RULE — the content map below defines exactly what each module covers:
- Module 1 covers ONLY the content of Theme 1. Module 2 covers ONLY Theme 2. Etc.
- Module title = the theme title (you may rephrase for marketing but must stay on that theme)
- Lesson titles must name SPECIFIC sub-concepts from that theme's source passages ONLY
- Zero topic overlap between any two modules — each module owns its theme exclusively

FIELD GUIDE:
- academyName: Market-ready title from the core subject matter
- tagline: One punchy line — the student transformation
- targetAudience: One precise sentence
- difficultyLevel: "beginner" | "intermediate" | "advanced"
- totalEstimatedHours: Sum of lesson durations ÷ 60, rounded to 1dp
- certificateTitle: e.g. "Certificate in [Topic]"
- themeVariant: midnight (tech) | amber (business/faith) | emerald (health/nature) | rose (personal dev) | violet (design/code) | solar (beginner/broad)
- layoutVariant: "centered" | "split" | "minimal"

LANDING PAGE: headline (max 10 words), subheadline (1 sentence), problemStatement (2 sentences), features (4 bullets — specific outcomes only), cta (button text)

PRICING — exactly 3 tiers:
1. Free — priceUsd: 0, period: "once", 2 bullets
2. Pro — priceUsd: 47–97, period: "monthly", 4 bullets
3. Lifetime — priceUsd: 197–497, period: "once", 5 bullets

CURRICULUM: moduleTitle, moduleDescription (1–2 sentences), lessonOutlines (max 3 stubs)

SEO: title (50–60 chars), description (140–155 chars), keywords (6–8)
onboardingSteps: 3–4 steps

GROUNDING — absolute hard rules:
- Every module title, lesson title, tagline, headline, and feature bullet must be drawn DIRECTLY from the source material or content map below
- Do NOT introduce ANY concept, example, framework, statistic, or claim that does not appear in the source
- If the source does not contain enough material for a field, use a shorter or vaguer value — never pad with invented content
- Paraphrase only to improve readability; never expand beyond what the speaker/author actually said`,
          prompt: basePrompt + contentMapSection + phase1SourceSection + deliverySection,
        });

        // ── Phase 2: one generateObject call per module ───────────────────────
        // Splitting by module keeps each call well under DeepSeek's 8K output
        // limit. A single all-modules call would exceed it for any course with
        // rich notes, causing truncated JSON and a parse failure.
        const SingleModuleContentSchema = z.object({
          moduleIndex:        z.number().int().min(0),
          learningObjectives: z.array(z.string()).min(1).max(5),
          keyTerms: z.array(z.object({
            term:       z.string(),
            definition: z.string(),
          })).min(1).max(6),
          lessons: z.array(z.object({
            lessonIndex:  z.number().int().min(0),
            description:  z.string(),
            notes:        z.string(),
            keyTakeaways: z.array(z.string()).min(1).max(7),
            actionItems:  z.array(z.string()).min(1).max(4),
            quiz: z.array(z.object({
              q:       z.string(),
              options: z.array(z.string()).length(4),
              correct: z.number().int().min(0).max(3),
            })).min(3).max(3),
          })),
        });

        // Scale notes length to available source material. Short videos don't
        // have enough unique content to fill 500-word lessons without repetition.
        const notesWordCount = estMinutes < 5
          ? "150–200 words"
          : estMinutes < 15
          ? "200–300 words"
          : "350–500 words";

        const phase2System = `You are the Curator — a world-class educational content writer focused on a SINGLE module.

PER MODULE output:
- learningObjectives: exactly 3 (Understand/Apply/Identify pattern), drawn from the theme's source passages
- keyTerms: exactly 4 terms that appear in the source, exclusive to this module

PER LESSON output:
- description: 1 sentence stating the specific learning outcome for THIS lesson
- notes: ${notesWordCount}. Core teaching content — use ONLY what the source says about this specific lesson topic. If the source covers this topic briefly, write briefly — do NOT pad to hit a word count.
  Format (adapt section count to actual source depth — omit sections if the source doesn't support them):
  1. Opening paragraph (2–3 sentences): frame the lesson topic grounded in the source.
  2. "## [Section Title]" — core concept block: explain the main idea using specific language from the source. **bold** key terms where introduced.
  3. "## Key Insight" — closing 1–2 sentences: the single most important takeaway from THIS lesson.
  Rules: prose only — no bullet lists. **bold** 1–3 terms. Do NOT repeat content from other lessons.
- keyTakeaways: exactly 3 — specific, distinct insights from THIS lesson only
- actionItems: exactly 2 practical steps grounded in the source
- quiz: exactly 3 questions, each with exactly 4 options, correct index 0–3

GROUNDING — non-negotiable hard rules:
- Every sentence must be directly traceable to the source material or theme passages provided
- Do NOT introduce concepts, examples, statistics, frameworks, or advice the speaker/author did not state
- Do NOT extrapolate or fill gaps with common knowledge — if the source is silent on a point, omit it
- Paraphrase for clarity only; never add meaning beyond what was said
- Quiz wrong-answer options must be plausible distractors from the source context, not invented facts`;

        const allModuleContents: z.infer<typeof SingleModuleContentSchema>[] = [];
        // Track key terms defined in earlier modules so subsequent modules don't redefine them.
        const definedTerms: Array<{ term: string; definedInModule: number }> = [];

        for (const [mi, mod] of shell.curriculum.entries()) {
          const theme = contentMap.themes[mi] ?? contentMap.themes[contentMap.themes.length - 1];
          const modOutline = [
            `MODULE ${mi} "${mod.moduleTitle}": ${mod.moduleDescription}`,
            ...mod.lessonOutlines.map((l, li) => `  LESSON ${li}: "${l.title}" (${l.type}, ${l.durationMinutes}min)`),
          ].join("\n");
          const themePassage = theme
            ? `THEME PASSAGES:\nTheme \u201c${theme.title}\u201d (${theme.sourceRegion}): ${theme.summary}\n  Passages: ${theme.keyPassages.map(p => `\u201c${p}\u201d`).join(" | ")}`
            : "";

          // Cross-module dedup: tell each module what terms are already owned by prior modules.
          const priorTermsBlock = definedTerms.length > 0
            ? `\nALREADY-DEFINED TERMS \u2014 DO NOT REDEFINE IN THIS MODULE:\nThe following terms were defined and explained in earlier modules. Do NOT add them to keyTerms and do NOT re-explain them in notes \u2014 at most reference them by name:\n${definedTerms.map((t) => `  \u2022 "${t.term}" (Module ${t.definedInModule + 1})`).join("\n")}`
            : "";

          const { object: modContent } = await generateObject({
            model: deepSeekModel,
            schema: SingleModuleContentSchema,
            schemaName: "ModuleContent",
            schemaDescription: "Full lesson content for one academy module",
            mode: "json",
            maxTokens: 6_000,
            temperature: 0.2,
            system: phase2System,
            prompt: [
              `Write all content for this module (moduleIndex: ${mi}):`,
              modOutline,
              "",
              themePassage,
              priorTermsBlock,
              "",
              phase1Source ? `SOURCE MATERIAL (sampled):\n${phase1Source}` : "",
              deliverySection,
            ].filter(Boolean).join("\n"),
          });
          allModuleContents.push(modContent);
          // Register this module's key terms so subsequent modules can avoid redefining them.
          for (const kt of modContent.keyTerms ?? []) {
            definedTerms.push({ term: kt.term, definedInModule: mi });
          }
        }

        // Merge Phase 2 content back onto the Phase 1 shell
        const fullCurriculum = shell.curriculum.map((mod, mi) => {
          const modContent = allModuleContents[mi]
            ?? allModuleContents[allModuleContents.length - 1];
          return {
            moduleTitle:        mod.moduleTitle,
            moduleDescription:  mod.moduleDescription,
            learningObjectives: modContent.learningObjectives,
            keyTerms:           modContent.keyTerms,
            lessons: mod.lessonOutlines.map((outline, li) => {
              const lc = modContent.lessons.find(l => l.lessonIndex === li)
                ?? modContent.lessons[li]
                ?? modContent.lessons[modContent.lessons.length - 1];
              return {
                title:           outline.title,
                type:            outline.type,
                durationMinutes: outline.durationMinutes,
                description:     lc.description,
                notes:           lc.notes.trim(),
                keyTakeaways:    lc.keyTakeaways,
                actionItems:     lc.actionItems,
                quiz:            lc.quiz,
              };
            }),
          };
        });

        // ── Phase 3: Merge and validate ────────────────────────────────────────
        const academy = AcademyPackageSchema.parse({
          ...shell,
          curriculum: fullCurriculum,
        });

        clearInterval(ping);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(academy)}\n\n`));
      } catch (error) {
        clearInterval(ping);
        const message = error instanceof Error ? error.message : "Produce stage failed";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering
    },
  });
}

