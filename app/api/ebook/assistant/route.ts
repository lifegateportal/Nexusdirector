import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { createHash } from "crypto";
import { deepSeekReasonerModel } from "@/lib/ai-providers";
import {
  EbookManifestSchema,
  SectionDraftSchema,
  ChapterDraftSchema,
  FrontBackMatterSchema,
  BackMatterSchema,
} from "@/lib/schemas/ebook";
import { CoverAccentSchema } from "@/lib/schemas/published-book";
import { harmonizeBookManifest } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 120;

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(8000),
});

const RequestSchema = z.object({
  manifest: EbookManifestSchema,
  instruction: z.string().min(1).max(4000),
  history: z.array(ChatMessageSchema).max(20).optional(),
  dryRun: z.boolean().optional(),
  mode: z.enum(["edit", "critique", "applyPatch"]).optional(),
  approvedPatch: z.lazy(() => EbookChangeSchema).optional(),
  manifestVersion: z.string().optional(),
  pipeline: z.object({
    stage: z.string(),
    progress: z.object({ total: z.number().int().nonnegative(), completed: z.number().int().nonnegative() }),
    totalWords: z.number().int().nonnegative(),
    reviewReady: z.boolean(),
    qualityReport: z.object({
      score: z.number(),
      pass: z.boolean(),
      issues: z.array(z.object({ severity: z.enum(["warn", "error"]), message: z.string() })),
    }).nullable(),
    error: z.string().nullable(),
    bookTitle: z.string().nullable(),
    chapterCount: z.number().int().nonnegative(),
    frontMatterSections: z.number().int().nonnegative(),
  }).optional(),
});

// Lightweight patch for chapter-level metadata — use this instead of the full chapters array
// for any operation that doesn't restructure sections (e.g. edit conclusion, rename, takeaways).
const ChapterPatchSchema = z.object({
  chapterNumber: z.number().int().min(1),
  title: z.string().optional(),
  intro: z.string().optional(),
  epigraph: z.string().optional(),
  premiseLine: z.string().optional(),
  conclusion: z.string().optional(),
  keyTakeaways: z.array(z.string()).optional(),
  reflectionQuestions: z.array(z.string()).optional(),
});

// Patch for the published library catalog entry — only the fields that can be edited without re-publishing
const LibraryPatchSchema = z.object({
  slug:         z.string().min(1),
  title:        z.string().optional(),
  subtitle:     z.string().optional(),
  authorName:   z.string().optional(),
  synopsis:     z.string().optional(),
  coverAccent:  CoverAccentSchema.optional(),
});

// Back matter patch must be partial and must not default missing keys to []
// (otherwise glossary-only edits can wipe reading guide/resources/scripture index).
const BackMatterPatchSchema = z.object({
  scriptureIndex: z.array(z.object({
    reference: z.string(),
    translation: z.string(),
    chapters: z.array(z.number()),
  })).optional(),
  glossary: z.array(z.object({
    term: z.string(),
    definition: z.string(),
    firstAppearance: z.string(),
  })).optional(),
  readingGroupGuide: z.array(z.object({
    chapterNumber: z.number(),
    chapterTitle: z.string(),
    questions: z.array(z.string()),
  })).optional(),
  recommendedResources: z.array(z.string()).optional(),
});

// The agent returns only what changed — undefined fields = no change
const EbookChangeSchema = z.object({
  bookTitle:     z.string().optional(),
  subtitle:      z.string().optional(),
  authorName:    z.string().optional(),
  frontMatter:   FrontBackMatterSchema.optional(),
  backMatter:    BackMatterPatchSchema.optional(),            // partial back matter patch only
  chapters:      z.array(ChapterDraftSchema).optional(),     // ONLY for section reorders / full restructures
  chapterPatches: z.array(ChapterPatchSchema).optional(),    // preferred for chapter-level field edits
  updatedSections: z.array(SectionDraftSchema).optional(),   // targeted section edits
  libraryPatch:  LibraryPatchSchema.optional(),              // update the published catalog entry metadata
  confidence: z.enum(["high", "medium", "low"]).default("high"), // AI's self-assessed certainty
  clarificationNeeded: z.string().optional(), // question to surface when confidence is low
  summary: z.string(), // one-sentence description of what changed
});

const CritiqueResponseSchema = z.object({
  summary: z.string(),
  overview: z.string(),
  confidence: z.enum(["high", "medium", "low"]).default("high"),
  findings: z.array(z.object({
    priority: z.enum(["high", "medium", "low"]),
    location: z.string(),
    diagnosis: z.string(),
    rationale: z.string(),
    recommendation: z.string(),
    needsMoreSourceMaterial: z.boolean().default(false),
  })).default([]),
  proposedPatch: EbookChangeSchema.optional(),
  approvalPrompt: z.string().default("Approve these amendments to apply them."),
});

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = RequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 }
    );
  }

  const { manifest, instruction, history, pipeline } = input;
  const dryRun       = input.dryRun ?? false;

  // ── Optimistic locking ───────────────────────────────────────────────
  // Hash the mutable content fields so concurrent edits from multiple tabs
  // are detected and rejected with 409 instead of silently stomping each other.
  function computeManifestVersion(m: typeof manifest): string {
    return createHash("sha256")
      .update(JSON.stringify({ bookTitle: m.bookTitle, subtitle: m.subtitle, authorName: m.authorName, chapters: m.chapters, frontMatter: m.frontMatter, backMatter: m.backMatter }))
      .digest("hex")
      .slice(0, 12);
  }
  const currentVersion = computeManifestVersion(manifest);
  if (input.manifestVersion && input.manifestVersion !== currentVersion) {
    return NextResponse.json(
      { error: "Conflict: the book has been modified since you last loaded it. Please reload before editing.", code: "VERSION_CONFLICT" },
      { status: 409 }
    );
  }

  const safeExcerpt = (value: string | null | undefined, max = 600) => (value ?? "").slice(0, max);

  // Parse explicit section references from text.
  // Catches: "section 2.1", "section 2§1", "ch2 sec 1", "chapter 2 section 1", "2-1", "2.1"
  // Explicitly named sections are always sent at full length and not subject to the word-count guard.
  function parseExplicitSectionRefs(text: string): Set<string> {
    const refs = new Set<string>();
    const patterns = [
      // "section 2.1" / "section 2 §1" / "section 2-1"
      /\bsection\s+(\d+)[.\s§\-]+(\d+)/gi,
      // "(\d).(\d) section" reverse order
      /(\d+)[.\s§\-]+(\d+)\s+section\b/gi,
      // "chapter 2 section 1" / "ch 2 sec 1" / "ch2 s1"
      /\bch(?:apter)?\s*(\d+)\s+s(?:ec(?:tion)?)?\s*(\d+)/gi,
      // bare "2.1" preceded/followed by non-digits (to avoid matching dates/decimals)
      /(?<![\d.\-])(\d+)\.(\d+)(?![\d.\-])/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const ch = m[1];
        const sc = m[2];
        if (ch && sc) refs.add(`${ch}:${sc}`);
      }
    }
    return refs;
  }
  // Gather refs from the full conversation so contextual follow-ups ("make it longer") work
  const historyText = (history ?? []).map((m) => m.content).join(" ");
  const explicitRefs = parseExplicitSectionRefs(instruction + " " + historyText);

  const selectedModel = deepSeekReasonerModel;

  const cleanInstruction = instruction.replace(/\s+/g, " ").trim();

  function parseDeterministicCommand(): z.infer<typeof EbookChangeSchema> | null {
    const text = cleanInstruction;

    const renameChapter = text.match(/^(?:rename|retitle|change\s+title\s+of)\s+chapter\s+(\d+)\s+(?:to|as)\s+(.+)$/i);
    if (renameChapter) {
      const chapterNumber = Number(renameChapter[1]);
      const title = renameChapter[2].trim();
      if (!title) return null;
      return {
        chapterPatches: [{ chapterNumber, title }],
        summary: `Renamed Chapter ${chapterNumber} to "${title}".`,
        confidence: "high",
      };
    }

    const renameSection = text.match(/^(?:rename|retitle|change\s+title\s+of)\s+section\s+(\d+)[.\-](\d+)\s+(?:to|as)\s+(.+)$/i);
    if (renameSection) {
      const chapterNumber = Number(renameSection[1]);
      const sectionNumber = Number(renameSection[2]);
      const heading = renameSection[3].trim();
      if (!heading) return null;
      const chapter = manifest.chapters.find((ch) => ch.number === chapterNumber);
      const section = chapter?.sections.find((s) => s.sectionNumber === sectionNumber);
      if (!chapter || !section) {
        return {
          summary: `Could not find section ${chapterNumber}.${sectionNumber}.`,
          confidence: "low",
          clarificationNeeded: `I could not find section ${chapterNumber}.${sectionNumber}. Please confirm the chapter and section number.`,
        };
      }
      return {
        updatedSections: [{ ...section, chapterNumber, sectionNumber, heading }],
        summary: `Renamed Section ${chapterNumber}.${sectionNumber} to "${heading}".`,
        confidence: "high",
      };
    }

    const bookTitle = text.match(/^(?:change|set|update)\s+(?:the\s+)?book\s+title\s+(?:to|as)\s+(.+)$/i)
      || text.match(/^(?:change|set|update)\s+title\s+(?:to|as)\s+(.+)$/i);
    if (bookTitle) {
      const title = bookTitle[1].trim();
      if (!title) return null;
      return {
        bookTitle: title,
        summary: `Updated book title to "${title}".`,
        confidence: "high",
      };
    }

    const subtitle = text.match(/^(?:change|set|update)\s+(?:the\s+)?subtitle\s+(?:to|as)\s+(.+)$/i);
    if (subtitle) {
      const value = subtitle[1].trim();
      if (!value) return null;
      return {
        subtitle: value,
        summary: `Updated subtitle to "${value}".`,
        confidence: "high",
      };
    }

    const authorName = text.match(/^(?:change|set|update)\s+(?:the\s+)?author\s+name\s+(?:to|as)\s+(.+)$/i);
    if (authorName) {
      const value = authorName[1].trim();
      if (!value) return null;
      return {
        authorName: value,
        summary: `Updated author name to "${value}".`,
        confidence: "high",
      };
    }

    return null;
  }

  // Track which sections are truncated so we can restore original content if the AI loses words
  const truncatedSections = new Set<string>();

  function buildBookSummary(compact = false) {
    return {
      bookTitle: manifest.bookTitle,
      subtitle: manifest.subtitle,
      authorName: manifest.authorName,
      totalWordCount: manifest.totalWordCount,
      frontMatter: {
        preface: compact ? safeExcerpt(manifest.frontMatter.preface, 800) : manifest.frontMatter.preface,
        introduction: compact ? safeExcerpt(manifest.frontMatter.introduction, 800) : manifest.frontMatter.introduction,
        conclusion: compact ? safeExcerpt(manifest.frontMatter.conclusion, 800) : manifest.frontMatter.conclusion,
        aboutAuthor: compact ? safeExcerpt(manifest.frontMatter.aboutAuthor, 500) : manifest.frontMatter.aboutAuthor,
        resourcesList: manifest.frontMatter.resourcesList,
      },
      backMatter: manifest.backMatter
        ? {
            glossaryTermCount: (manifest.backMatter.glossary ?? []).length,
            glossary: compact ? (manifest.backMatter.glossary ?? []).slice(0, 40) : (manifest.backMatter.glossary ?? []),
            readingGroupGuide: (manifest.backMatter.readingGroupGuide ?? []).map((c) => ({
              chapterNumber: c.chapterNumber,
              chapterTitle: c.chapterTitle,
              questions: compact ? c.questions.slice(0, 3) : c.questions,
            })),
            scriptureIndex: compact ? (manifest.backMatter.scriptureIndex ?? []).slice(0, 60) : (manifest.backMatter.scriptureIndex ?? []),
            recommendedResources: manifest.backMatter.recommendedResources ?? [],
          }
        : null,
      chapters: manifest.chapters.map((ch) => ({
        number: ch.number,
        title: ch.title,
        intro: compact ? safeExcerpt(ch.intro, 500) : ch.intro,
        conclusion: compact ? safeExcerpt(ch.conclusion, 500) : ch.conclusion,
        keyTakeaways: ch.keyTakeaways,
        reflectionQuestions: ch.reflectionQuestions,
        totalWordCount: ch.totalWordCount,
        sections: ch.sections.map((s) => {
          const fullBody = s.body ?? "";
          const isExplicit = explicitRefs.has(`${ch.number}:${s.sectionNumber}`);
          const limit = compact ? 2800 : 4000;
          const excerptSize = compact ? 650 : 1200;
          const isTruncated = !isExplicit && fullBody.length > limit;
          if (isTruncated) {
            truncatedSections.add(`${ch.number}:${s.sectionNumber}`);
          }
          return {
            sectionNumber: s.sectionNumber,
            chapterNumber: ch.number,
            heading: s.heading,
            body: isTruncated
              ? safeExcerpt(fullBody, excerptSize) + "\n…[TRUNCATED — DO NOT MODIFY THIS SECTION. Return its body field as an empty string so the original is preserved]"
              : fullBody,
            wordCount: s.wordCount,
          };
        }),
      })),
    };
  }

  async function generateWithReasoner<T extends z.ZodTypeAny>(options: {
    schema: T;
    system: string;
    historyLimit?: number;
    compact?: boolean;
    temperature?: number;
  }): Promise<z.infer<T>> {
    const selectedHistory = (history ?? []).slice(-(options.historyLimit ?? 14));
    const prompt = [
      "CURRENT BOOK STRUCTURE:",
      JSON.stringify(buildBookSummary(options.compact ?? false), null, 2),
      pipelineSummary ? ["CURRENT PIPELINE STATE:", JSON.stringify(pipelineSummary, null, 2)].join("\n") : "",
      "",
      ...(selectedHistory.length > 0
        ? [
            "CONVERSATION HISTORY (oldest first — use this to understand follow-up instructions):",
            selectedHistory.map((m) => `${m.role === "user" ? "USER" : "DIRECTOR"}: ${m.content}`).join("\n"),
            "",
          ]
        : []),
      "CURRENT USER INSTRUCTION:",
      instruction,
    ].join("\n");

    const { object } = await generateObject({
      model: selectedModel,
      schema: options.schema,
      mode: "json",
      maxTokens: 8000,
      temperature: options.temperature ?? 0.15,
      system: options.system,
      prompt,
    });

    return object;
  }

  const pipelineSummary = pipeline
    ? {
        stage: pipeline.stage,
        progress: pipeline.progress,
        totalWords: pipeline.totalWords,
        reviewReady: pipeline.reviewReady,
        qualityReport: pipeline.qualityReport,
        error: pipeline.error,
        bookTitle: pipeline.bookTitle,
        chapterCount: pipeline.chapterCount,
        frontMatterSections: pipeline.frontMatterSections,
      }
    : null;

  function applyChangeObject(
    object: z.infer<typeof EbookChangeSchema>,
    auditInstruction: string,
    auditModel: "r1" | "v3"
  ) {
    // Merge updatedSections into the full manifest chapters
    let mergedChapters = manifest.chapters;

    if (object.chapterPatches && object.chapterPatches.length > 0) {
      mergedChapters = mergedChapters.map((ch) => {
        const patch = object.chapterPatches!.find((p) => p.chapterNumber === ch.number);
        if (!patch) return ch;
        const { chapterNumber: _ignored, ...fields } = patch;
        return { ...ch, ...fields };
      });
    }

    if (object.updatedSections && object.updatedSections.length > 0) {
      mergedChapters = manifest.chapters.map((ch) => ({
        ...ch,
        sections: ch.sections.map((s) => {
          const updated = object.updatedSections!.find(
            (u) => u.chapterNumber === ch.number && u.sectionNumber === s.sectionNumber
          );
          if (!updated) return s;
          const originalWords = (s.body ?? "").split(/\s+/).filter(Boolean).length;
          const returnedWords = (updated.body ?? "").split(/\s+/).filter(Boolean).length;
          const sectionKey = `${ch.number}:${s.sectionNumber}`;
          const bodyToUse =
            !updated.body ||
            (!explicitRefs.has(sectionKey) && truncatedSections.has(sectionKey) && returnedWords < originalWords * 0.75)
              ? s.body
              : updated.body;
          return { ...updated, body: bodyToUse };
        }),
      }));
    }

    if (object.chapters) {
      mergedChapters = object.chapters.map((returnedCh) => {
        const originalCh = manifest.chapters.find((c) => c.number === returnedCh.number);
        if (!originalCh) return returnedCh;
        return {
          ...returnedCh,
          sections: (returnedCh.sections ?? []).map((returnedSection) => {
            const originalSection = originalCh.sections.find(
              (s) => s.sectionNumber === returnedSection.sectionNumber
            );
            if (!originalSection) return returnedSection;
            const key = `${returnedCh.number}:${returnedSection.sectionNumber}`;
            const wasTruncated = truncatedSections.has(key);
            const originalWords = (originalSection.body ?? "").split(/\s+/).filter(Boolean).length;
            const returnedWords = (returnedSection.body ?? "").split(/\s+/).filter(Boolean).length;
            const bodyToUse =
              !explicitRefs.has(key) && wasTruncated && (!returnedSection.body || returnedWords < originalWords * 0.75)
                ? originalSection.body
                : returnedSection.body;
            return { ...returnedSection, body: bodyToUse };
          }),
        };
      });
    }

    const lowerInstruction = auditInstruction.toLowerCase();
    const clearIntent = /\b(clear|remove|delete|wipe|reset)\b/i;
    const glossaryIntent = /\bglossary\b/i;
    const scriptureIntent = /\bscripture\s*index|index\s+of\s+scripture\b/i;
    const guideIntent = /\breading\s+group\s+guide|discussion\s+questions?|study\s+guide\b/i;
    const resourcesIntent = /\brecommended\s+resources?|resources\b/i;

    let mergedBackMatter = manifest.backMatter ?? null;
    if (object.backMatter !== undefined) {
      const next = {
        scriptureIndex: mergedBackMatter?.scriptureIndex ?? [],
        glossary: mergedBackMatter?.glossary ?? [],
        readingGroupGuide: mergedBackMatter?.readingGroupGuide ?? [],
        recommendedResources: mergedBackMatter?.recommendedResources ?? [],
      };

      const hasOwn = (k: keyof z.infer<typeof BackMatterPatchSchema>) =>
        Object.prototype.hasOwnProperty.call(object.backMatter, k);

      if (hasOwn("scriptureIndex")) {
        const v = object.backMatter.scriptureIndex;
        if (v !== undefined && (v.length > 0 || (v.length === 0 && clearIntent.test(lowerInstruction) && scriptureIntent.test(lowerInstruction)))) {
          next.scriptureIndex = v;
        }
      }
      if (hasOwn("glossary")) {
        const v = object.backMatter.glossary;
        if (v !== undefined && (v.length > 0 || (v.length === 0 && clearIntent.test(lowerInstruction) && glossaryIntent.test(lowerInstruction)))) {
          next.glossary = v;
        }
      }
      if (hasOwn("readingGroupGuide")) {
        const v = object.backMatter.readingGroupGuide;
        if (v !== undefined && (v.length > 0 || (v.length === 0 && clearIntent.test(lowerInstruction) && guideIntent.test(lowerInstruction)))) {
          next.readingGroupGuide = v;
        }
      }
      if (hasOwn("recommendedResources")) {
        const v = object.backMatter.recommendedResources;
        if (v !== undefined && (v.length > 0 || (v.length === 0 && clearIntent.test(lowerInstruction) && resourcesIntent.test(lowerInstruction)))) {
          next.recommendedResources = v;
        }
      }

      mergedBackMatter = next;
    }

    const updatedManifest = {
      ...manifest,
      ...(object.bookTitle !== undefined && { bookTitle: object.bookTitle }),
      ...(object.subtitle !== undefined && { subtitle: object.subtitle }),
      ...(object.authorName !== undefined && { authorName: object.authorName }),
      ...(object.frontMatter !== undefined && { frontMatter: object.frontMatter }),
      ...(mergedBackMatter !== null && { backMatter: mergedBackMatter }),
      chapters: mergedChapters,
    };

    const hasChanges =
      object.chapterPatches?.length ||
      object.updatedSections?.length ||
      object.chapters?.length ||
      object.frontMatter !== undefined ||
      object.backMatter !== undefined ||
      object.libraryPatch !== undefined ||
      object.bookTitle !== undefined ||
      object.subtitle !== undefined ||
      object.authorName !== undefined;

    if (!hasChanges) {
      return { noChanges: true as const, summary: object.summary };
    }

    const harmonized = harmonizeBookManifest(updatedManifest);
    const changeLogEntry = {
      timestamp: new Date().toISOString(),
      instruction: auditInstruction.slice(0, 200),
      summary: object.summary,
      model: auditModel,
    };
    const existingLog = (manifest.changeLog ?? []) as typeof changeLogEntry[];
    harmonized.changeLog = [...existingLog, changeLogEntry].slice(-50);

    const validated = EbookManifestSchema.safeParse(harmonized);
    if (!validated.success) {
      throw new Error(`Manifest validation failed: ${validated.error.issues[0]?.message}`);
    }

    return {
      manifest: validated.data,
      summary: object.summary,
      confidence: object.confidence,
      manifestVersion: computeManifestVersion(validated.data),
      ...(object.clarificationNeeded && { clarificationNeeded: object.clarificationNeeded }),
      ...(object.libraryPatch !== undefined && { libraryPatch: object.libraryPatch }),
    };
  }

  try {
    const deterministic = parseDeterministicCommand();
    if (deterministic && input.mode !== "critique") {
      return NextResponse.json(applyChangeObject(deterministic, instruction, "r1"), { status: 200 });
    }

    if (input.mode === "applyPatch") {
      if (!input.approvedPatch) {
        return NextResponse.json({ error: "No approved patch provided." }, { status: 400 });
      }
      return NextResponse.json(applyChangeObject(input.approvedPatch, `Approved amendment: ${instruction}`, "r1"), { status: 200 });
    }

    if (input.mode === "critique") {
      const critiqueSystem = `You are the Nexus Book Director in critical-reasoning mode.

Your job is to evaluate this book like a rigorous editorial strategist.

NON-NEGOTIABLE RULES:
- Work only from the manuscript and pipeline context provided.
- Do not invent new theology, stories, or examples.
- If the book lacks enough source material for a stronger treatment, say so explicitly.
- Distinguish between:
  1. issues that can be improved by reorganizing or tightening existing material
  2. issues that need more source material from the speaker before they should be revised

OUTPUT REQUIREMENTS:
- overview: a concise top-level assessment of manuscript quality and biggest leverage points.
- findings: specific, high-signal diagnoses with location, rationale, and recommendation.
- proposedPatch: include only if you can safely propose concrete amendments using existing material.
- Do not apply anything. This is a proposal for approval.
- approvalPrompt should tell the user to approve if they want the amendments applied.
- Keep proposedPatch limited to high-confidence changes that preserve speaker fidelity.
- If a chapter/section is thin because the book lacks evidence, set needsMoreSourceMaterial=true for that finding instead of faking an amendment.
`;

      let object: z.infer<typeof CritiqueResponseSchema>;
      try {
        object = await generateWithReasoner({
          schema: CritiqueResponseSchema,
          system: critiqueSystem,
          historyLimit: 14,
          compact: false,
          temperature: 0.2,
        });
      } catch {
        object = await generateWithReasoner({
          schema: CritiqueResponseSchema,
          system: critiqueSystem,
          historyLimit: 8,
          compact: true,
          temperature: 0.15,
        });
      }

      return NextResponse.json({
        mode: "critique",
        summary: object.summary,
        overview: object.overview,
        findings: object.findings,
        confidence: object.confidence,
        proposedPatch: object.proposedPatch,
        approvalPrompt: object.approvalPrompt,
        manifestVersion: currentVersion,
      }, { status: 200 });
    }

    const editSystem = `You are the Nexus Book Director — a precision ebook editor with MAXIMUM AUTHORITY over every part of this published teaching book. You receive the full book structure and can make any change the user requests.

════════════════════════════════════════════
SPEAKER-FIDELITY LAW — NON-NEGOTIABLE
════════════════════════════════════════════
This book was produced strictly from a speaker's transcripts. You MUST:
- NEVER add ideas, examples, stories, or theological content not already present in the book
- When rewriting or editing, work ONLY with content already in the book
- Preserve the speaker's voice, vocabulary, and teaching style exactly
- If asked to "improve" or "expand" content, do so by reorganizing or clarifying existing text — not by adding new content

BOOK-SAFETY RULE — ALWAYS APPLY
- Remove or avoid church-room chatter that does not belong in a book: greetings to congregation, thanking attendees/teams, service-flow remarks, crowd-response prompts, and stage directions.
- Keep only reader-appropriate teaching prose.

════════════════════════════════════════════
NATURAL LANGUAGE MAPPINGS — interpret these colloquial phrases correctly
════════════════════════════════════════════
"take out the church talk" / "remove pulpit language" / "congregation chatter" / "audience talk" / "live service language" / "speaker talking to audience"
  → fix live-audience language (updatedSections for affected sections)

"the ending is weak" / "fix the ending" / "the conclusion drags" / "wrap up chapter X better" / "chapter X needs a better close"
  → rewrite chapterPatches: conclusion for the named chapter

"remove the conclusions" / "take out the chapter endings" / "no need for summaries" / "cut the chapter summaries"
  → chapterPatches: conclusion: "" for named chapters

"the intro is weak" / "fix the opening" / "chapter X needs a better hook" / "the start is slow" / "strengthen the beginning"
  → rewrite chapterPatches: intro (and/or premiseLine) for the named chapter

"tighten up section X" / "clean it up" / "section X flows badly" / "make it read better" / "improve the writing"
  → updatedSections: rewrite body with tighter prose, same content

"make section X shorter" / "trim section X" / "condense section X" / "too long"
  → updatedSections: condensed body

"update the author bio" / "change the about section" / "author section needs updating"
  → frontMatter: update aboutAuthor

"take out the resources" / "remove the reading list" / "delete the resources section"
  → frontMatter: resourcesList: []

"the scripture is repeated" / "same verse appears twice" / "duplicate Bible verses"
  → updatedSections: remove the duplicate scripture reference from the later section

"move section X to chapter Y" / "transfer section X" / "section X belongs in chapter Y"
  → chapters array restructure: remove from source chapter, add to target chapter

"chapter X needs reflection questions" / "add questions at the end of chapter X"
  → chapterPatches: reflectionQuestions for that chapter

"chapter X needs takeaways" / "key points for chapter X" / "summarise chapter X"
  → chapterPatches: keyTakeaways for that chapter

════════════════════════════════════════════
FULL AUTHORITY — WHAT YOU CAN DO
════════════════════════════════════════════
METADATA:
  "change the title to…"              → update bookTitle
  "update the subtitle"               → update subtitle
  "set the author name to…"           → update authorName

FRONT MATTER (return full frontMatter object with ALL fields):
  "rewrite the preface"               → update frontMatter.preface
  "revise the introduction"           → update frontMatter.introduction
  "update the conclusion"             → update frontMatter.conclusion
  "update about the author"           → update frontMatter.aboutAuthor
  "update the resources list"         → update frontMatter.resourcesList
  Any front matter instruction        → return the COMPLETE frontMatter object with all fields preserved

BACK MATTER (return partial backMatter — only the fields that changed):
  "add a glossary term" / "define X in the glossary"   → backMatter: { glossary: [...existing+new] }
  "remove a glossary term" / "clean up the glossary"   → backMatter: { glossary: [...filtered] }
  "update the glossary" / "improve the glossary"       → backMatter: { glossary: [...all terms revised] }
  "update the reading group guide" / "add questions to chapter N" → backMatter: { readingGroupGuide: [...] }
  "update recommended resources" / "add a resource"   → backMatter: { recommendedResources: [...] }
  "fix the scripture index" / "update the scripture index"  → backMatter: { scriptureIndex: [...] }
  Any back matter instruction  → return backMatter with ONLY the changed fields

LIBRARY CATALOG (update the published entry metadata — no re-publish required):
  "update the library title"    → libraryPatch: { slug, title: "new title" }
  "change the book synopsis"    → libraryPatch: { slug, synopsis: "new synopsis" }
  "update the library subtitle" → libraryPatch: { slug, subtitle: "..." }
  "change the cover colour"     → libraryPatch: { slug, coverAccent: "amber|cyan|emerald|rose|violet|slate" }
  The slug is manifest.jobId-derived — use the published slug from manifest if known, or set slug to manifest.bookTitle slugified for reference

CHAPTER OPERATIONS — use chapterPatches for field edits, chapters array ONLY for section reorders:
  "rename chapter N to…"               → chapterPatches: [{chapterNumber:N, title:"..."}]
  "rewrite the intro of chapter N"     → chapterPatches: [{chapterNumber:N, intro:"full prose"}]
  "rewrite the conclusion of chapter N"→ chapterPatches: [{chapterNumber:N, conclusion:"full prose"}]
  "remove the conclusion of chapter N" → chapterPatches: [{chapterNumber:N, conclusion:""}]
  "remove all conclusions"             → chapterPatches: [{chapterNumber:1,conclusion:""},{chapterNumber:2,conclusion:""},…]
  "add/replace takeaways in chapter N" → chapterPatches: [{chapterNumber:N, keyTakeaways:[…5–7 items]}]
  "replace reflection questions in chapter N" → chapterPatches: [{chapterNumber:N, reflectionQuestions:[…4–6]}]
  "reorder sections in chapter N"      → chapters array (only when restructuring section order)

SECTION OPERATIONS — return only changed sections via updatedSections:
  "rename section N.M to…"            → updatedSections: [{chapterNumber:N, sectionNumber:M, heading:…, body:existing}]
  "rewrite section N.M"               → updatedSections: [{chapterNumber:N, sectionNumber:M, heading:existing, body:FULL REWRITE}]
  "expand section N.M"                → updatedSections with longer body using existing content
  "improve section N.M"               → updatedSections with refined prose, same ideas
  "fix the tone in section N.M"       → updatedSections with tone adjusted, same content
  "remove audience language from section N.M" → updatedSections with congregation/live-event language removed

BOOK-WIDE OPERATIONS:
  "fix all live-audience language"    → updatedSections for every section that contains crowd language
  "remove all greeting/crowd phrases" → updatedSections for affected sections only
  "standardise all section headings"  → updatedSections with heading field only (body unchanged)
  "add takeaways to all chapters"     → chapterPatches: one entry per chapter with keyTakeaways filled in
  "remove all conclusions"            → chapterPatches: one entry per chapter with conclusion: ""

════════════════════════════════════════════
CONTENT PRESERVATION — CRITICAL
════════════════════════════════════════════
Some section bodies end with "…[TRUNCATED — DO NOT MODIFY THIS SECTION...]".
This means the full content was too long to include in this prompt.
YOU MUST:
- Return those sections' body field as an EMPTY STRING "" — the client will restore the original automatically
- NEVER attempt to rewrite, summarise, or fill in a truncated section
- ONLY modify a truncated section if the user's instruction EXPLICITLY names it by section number (e.g., "rewrite section 2.3")
- This rule prevents catastrophic word count loss across the book

════════════════════════════════════════════
OUTPUT RULES
════════════════════════════════════════════
- Return ONLY fields that ACTUALLY changed — leave others as undefined
- If chapters array is returned, include ALL chapters (changed and unchanged) with ALL their sections
- If updatedSections is returned, include ONLY the changed sections — the client merges them by chapterNumber + sectionNumber
- The body field in updatedSections MUST be the FULL rewritten prose — never truncate
- frontMatter: if returned, include ALL fields (preface, introduction, conclusion, aboutAuthor, resourcesList)
- backMatter: if returned, include ONLY the changed sub-fields (glossary, readingGroupGuide, scriptureIndex, or recommendedResources); unchanged fields may be omitted
- libraryPatch: if updating the published catalog, include the slug plus only the changed metadata fields
- Always write a concise one-sentence "summary" of exactly what changed
- If the instruction is ambiguous, make the most useful interpretation and describe what you did in summary
- ALWAYS attempt the instruction — never refuse or treat instructions as comments
- If you make ANY change, you MUST include the corresponding change fields (chapterPatches, updatedSections, chapters, frontMatter, etc.). Returning ONLY summary with no change fields = zero manuscript changes. The user will see your summary but the book will be IDENTICAL.
- Only return empty change fields when the user is asking a question ("show me...", "explain...") — not for edit instructions`;

    let object: z.infer<typeof EbookChangeSchema>;
    try {
      object = await generateWithReasoner({
        schema: EbookChangeSchema,
        system: editSystem,
        historyLimit: 14,
        compact: false,
        temperature: 0.15,
      });
    } catch {
      object = await generateWithReasoner({
        schema: EbookChangeSchema,
        system: editSystem,
        historyLimit: 8,
        compact: true,
        temperature: 0.1,
      });
    }

    // ── Dry-run: return the AI patch without applying it ────────────────────────
    // The client can diff this against the current manifest and show a preview
    // before the user confirms the change.
    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        patch:  object,
        summary: object.summary,
        confidence: object.confidence,
        ...(object.clarificationNeeded && { clarificationNeeded: object.clarificationNeeded }),
        manifestVersion: currentVersion,
      }, { status: 200 });
    }

    // ── Confidence gate ───────────────────────────────────────────────────
    // When the AI flags low confidence and provides a clarifying question,
    // surface it to the client without applying any changes. The user can
    // answer the question and resubmit.
    if (object.confidence === "low" && object.clarificationNeeded) {
      return NextResponse.json({
        needsClarification: true,
        clarificationNeeded: object.clarificationNeeded,
        summary: object.summary,
        confidence: object.confidence,
        manifestVersion: currentVersion,
      }, { status: 200 });
    }
    return NextResponse.json(applyChangeObject(object, instruction, "r1"), { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ebook assistant failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
