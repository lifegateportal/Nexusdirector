import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { deepSeekModel, deepSeekReasonerModel } from "@/lib/ai-providers";
import { AcademyPackageSchema } from "@/lib/schemas/academy";
import type { AcademyPackage } from "@/lib/schemas/academy";
import { SiteConfigSchema } from "@/lib/schemas/site-config";
import type { SiteConfig } from "@/lib/schemas/site-config";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 120;

const RequestSchema = z.object({
  academy:     AcademyPackageSchema,
  instruction: z.string().min(1).max(4000),
  siteConfig:  SiteConfigSchema.optional(),
  dryRun:       z.boolean().optional(),
  academyVersion: z.string().optional(),
  history: z.array(z.object({
    role:    z.enum(["user", "assistant"]),
    content: z.string().max(8000),
  })).max(20).optional(),
});

// ── Patch schemas — AI returns ONLY changed fields, never the full academy. ──
// This keeps output well under DeepSeek's 8K token limit regardless of academy size.

const LessonPatchSchema = z.object({
  lessonIndex:    z.number().int().min(0),
  operation:      z.enum(["update", "delete"]).default("update").optional(), // Explicit delete op
  title:          z.string().optional(),
  type:           z.enum(["video", "reading", "quiz", "exercise"]).optional(),
  durationMinutes:z.number().optional(),
  description:    z.string().optional(),
  notes:          z.string().optional(),
  keyTakeaways:   z.array(z.string()).optional(),
  actionItems:    z.array(z.string()).optional(),
  quiz: z.array(z.object({
    q:       z.string(),
    options: z.array(z.string()),
    correct: z.number().int().min(0).max(3),
  })).optional(),
});

const ModulePatchSchema = z.object({
  moduleIndex:       z.number().int().min(0),
  operation:         z.enum(["update", "delete", "insert"]).default("update").optional(), // Explicit ops
  insertAfterIndex:  z.number().int().min(-1).optional(), // For insert: -1 = beginning
  moduleTitle:       z.string().optional(),
  moduleDescription: z.string().optional(),
  learningObjectives:z.array(z.string()).optional(),
  keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })).optional(),
  lessons: z.array(z.any()).optional(), // Full lessons array for new modules
  lessonPatches: z.array(LessonPatchSchema).optional(),
});

const AcademyPatchSchema = z.object({
  academyName:         z.string().optional(),
  tagline:             z.string().optional(),
  targetAudience:      z.string().optional(),
  difficultyLevel:     z.enum(["beginner", "intermediate", "advanced"]).optional(),
  totalEstimatedHours: z.number().optional(),
  certificateTitle:    z.string().optional(),
  themeVariant:  z.enum(["midnight", "amber", "emerald", "rose", "violet", "solar"]).optional(),
  layoutVariant: z.enum(["centered", "split", "minimal"]).optional(),
  landingPage: z.object({
    headline:         z.string().optional(),
    subheadline:      z.string().optional(),
    problemStatement: z.string().optional(),
    features: z.array(z.object({ title: z.string(), description: z.string() })).optional(),
    cta: z.string().optional(),
  }).optional(),
  pricing: z.array(z.object({
    name:     z.string(),
    priceUsd: z.number(),
    period:   z.enum(["once", "monthly", "yearly"]),
    features: z.array(z.string()),
  })).optional(),
  seoMeta: z.object({
    title:       z.string().optional(),
    description: z.string().optional(),
    keywords:    z.array(z.string()).optional(),
  }).optional(),
  onboardingSteps:  z.array(z.string()).optional(),
  curriculumPatches:z.array(ModulePatchSchema).optional(),
});

const PatchResponseSchema = z.object({
  academyPatch:        AcademyPatchSchema.optional(),
  siteConfigPatch:     SiteConfigSchema.partial().optional(),
  confidence:          z.enum(["high", "medium", "low"]).default("high"),
  clarificationNeeded: z.string().optional(),
  summary:             z.string(),
});

// ── Server-side merge helpers ────────────────────────────────────────────────

function applyAcademyPatch(
  academy: AcademyPackage,
  patch: z.infer<typeof AcademyPatchSchema>,
): AcademyPackage {
  const { curriculumPatches, landingPage, seoMeta, pricing, onboardingSteps, ...topLevel } = patch;
  const updated: AcademyPackage = { ...academy, ...topLevel };

  if (landingPage)     updated.landingPage    = { ...academy.landingPage,    ...landingPage };
  // SAFEGUARD: Only replace arrays if they're non-empty or explicitly null
  if (pricing !== undefined) {
    if (pricing === null) updated.pricing = []; // explicit clear
    else if (pricing.length > 0) updated.pricing = pricing;
    // else: empty array in patch = ignored (prevents accidental wipes)
  }
  if (onboardingSteps !== undefined) {
    if (onboardingSteps === null) updated.onboardingSteps = [];
    else if (onboardingSteps.length > 0) updated.onboardingSteps = onboardingSteps;
  }
  if (seoMeta)         updated.seoMeta        = { ...academy.seoMeta, ...seoMeta };

  if (curriculumPatches?.length) {
    let curriculum = academy.curriculum.map((m) => ({ ...m, lessons: m.lessons.map((l) => ({ ...l })) }));
    
    // Sort patches: deletes last, inserts first, updates middle
    const deletes = curriculumPatches.filter((p) => p.operation === "delete");
    const inserts = curriculumPatches.filter((p) => p.operation === "insert");
    const updates = curriculumPatches.filter((p) => !p.operation || p.operation === "update");

    // 1. Apply inserts
    for (const mp of inserts) {
      const { insertAfterIndex = -1, lessons: newLessons, ...modFields } = mp;
      if (!newLessons || newLessons.length === 0) continue;
      const newModule = { ...modFields, lessons: newLessons } as typeof curriculum[0];
      if (insertAfterIndex === -1) curriculum.unshift(newModule);
      else curriculum.splice(insertAfterIndex + 1, 0, newModule);
    }

    // 2. Apply updates
    for (const mp of updates) {
      const { moduleIndex, lessonPatches, operation, insertAfterIndex, lessons: _, ...modFields } = mp;
      if (moduleIndex < 0 || moduleIndex >= curriculum.length) continue;
      Object.assign(curriculum[moduleIndex], modFields);
      
      if (lessonPatches) {
        let lessons = curriculum[moduleIndex].lessons;
        const lessonDeletes = lessonPatches.filter((lp) => lp.operation === "delete");
        const lessonUpdates = lessonPatches.filter((lp) => !lp.operation || lp.operation === "update");
        
        // Apply lesson updates
        for (const lp of lessonUpdates) {
          const { lessonIndex, operation: _, ...lessonFields } = lp;
          if (lessonIndex < 0 || lessonIndex >= lessons.length) continue;
          Object.assign(lessons[lessonIndex], lessonFields);
        }
        
        // Apply lesson deletes (reverse order to maintain indices)
        for (const lp of lessonDeletes.sort((a, b) => b.lessonIndex - a.lessonIndex)) {
          if (lp.lessonIndex >= 0 && lp.lessonIndex < lessons.length) {
            lessons.splice(lp.lessonIndex, 1);
          }
        }
        
        curriculum[moduleIndex].lessons = lessons;
      }
    }

    // 3. Apply module deletes (reverse order to maintain indices)
    for (const mp of deletes.sort((a, b) => b.moduleIndex - a.moduleIndex)) {
      if (mp.moduleIndex >= 0 && mp.moduleIndex < curriculum.length) {
        curriculum.splice(mp.moduleIndex, 1);
      }
    }

    updated.curriculum = curriculum;
  }

  return AcademyPackageSchema.parse(updated);
}

function applySiteConfigPatch(
  base: SiteConfig,
  patch: Partial<SiteConfig>,
): SiteConfig {
  const merged = { ...base, ...patch };
  return SiteConfigSchema.parse(merged);
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  let parsedInput: { academy: AcademyPackage; instruction: string; siteConfig?: SiteConfig } | undefined;
  try {
    const body = await req.json() as unknown;
    parsedInput = RequestSchema.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return new Response(JSON.stringify({ error: message }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const { academy, instruction, siteConfig } = parsedInput;
  const dryRun = parsedInput.dryRun ?? false;

  // ── Optimistic locking ───────────────────────────────────────────────
  function computeAcademyVersion(a: typeof academy): string {
    return createHash("sha256")
      .update(JSON.stringify({ academyName: a.academyName, curriculum: a.curriculum }))
      .digest("hex")
      .slice(0, 12);
  }
  const currentVersion = computeAcademyVersion(academy);
  if (parsedInput.academyVersion && parsedInput.academyVersion !== currentVersion) {
    return new Response(
      JSON.stringify({ error: "Conflict: the academy has been modified since you last loaded it. Please reload before editing.", code: "VERSION_CONFLICT" }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );
  } 
  // Build a module-level concept map before sending anything to the LLM.
  // Each module OWNS its terms and lesson concepts — the AI must not redefine
  // or re-explain a concept that already belongs to another module.
  type ModuleEntry = { moduleIndex: number; moduleTitle: string; keyTerms: string[]; lessonTitles: string[]; objectives: string[] };
  const moduleLedger: ModuleEntry[] = academy.curriculum.map((mod, mi) => ({
    moduleIndex:  mi,
    moduleTitle:  mod.moduleTitle,
    keyTerms:     (mod.keyTerms ?? []).map((kt) => kt.term),
    lessonTitles: mod.lessons.map((l) => l.title),
    objectives:   (mod.learningObjectives ?? []).slice(0, 3),
  }));

  // Detect explicitly referenced modules/lessons in the instruction so we can
  // send their full notes (not the 120-char stub) to the LLM.
  function parseExplicitModuleRefs(text: string): Set<string> {
    const refs = new Set<string>();
    const patterns = [
      /\bmodule\s+(\d+)\s+lesson\s+(\d+)/gi,
      /\bm(\d+)\s*l(\d+)\b/gi,
      /\blesson\s+(\d+)\b/gi,
      /\bmodule\s+(\d+)\b/gi,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[2]) refs.add(`${Number(m[1]) - 1}:${Number(m[2]) - 1}`);
        else if (m[1]) refs.add(`mod:${Number(m[1]) - 1}`);
      }
    }
    return refs;
  }
  const history = parsedInput.history ?? [];
  const historyText = history.map((m) => m.content).join(" ");
  const explicitRefs = parseExplicitModuleRefs(instruction + " " + historyText);

  // Detect structural / high-reasoning operations that benefit from R1:
  // Structural: add/remove/merge/split/reorder modules
  // Academy-wide: objectives for all modules, notes for all lessons
  // Curriculum audit: overlap/duplication analysis across modules
  const isStructuralOp = /\b(add\s+a?\s*module|remove\s+module|delete\s+module|reorder\s+module|merge\s+module|split\s+(?:lesson|module)|restructure|reorganize|rearrange|full\s+rewrite|rewrite\s+all|complete\s+overhaul|add\s+(?:learning\s+)?objectives\s+to\s+all|add\s+(?:key\s+)?terms?\s+to\s+all|rewrite\s+(?:notes|lessons?)\s+for\s+all|expand\s+all\s+(?:notes|lessons?)|(?:check|identify|find|audit)\s+(?:overlap|duplicat|repeated\s+content|coverage)|across\s+all\s+modules|every\s+module)\b/i.test(instruction);

  // closing the connection while DeepSeek is generating the response.
  const stream = new ReadableStream({
    async start(controller) {
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ }
      }, 15_000);

      try {

    // Trim lesson notes to a short stub before serialising — the model doesn't
    // need to read 500-word prose to write a patch, and sending it bloats the
    // prompt beyond DeepSeek's reliable JSON-generation threshold in production.
    // EXCEPTION: explicitly referenced lessons are sent at full length.
    const academyContext = {
      ...academy,
      curriculum: academy.curriculum.map((mod, mi) => ({
        ...mod,
        lessons: mod.lessons.map((l, li) => {
          const isExplicit = explicitRefs.has(`${mi}:${li}`) || explicitRefs.has(`mod:${mi}`);
          return {
            ...l,
            notes: isExplicit
              ? l.notes  // full notes for explicitly named lessons
              : l.notes ? l.notes.slice(0, 120) + (l.notes.length > 120 ? "…" : "") : "",
          };
        }),
      })),
    };

    // ── Concept Ownership Block ───────────────────────────────────────────
    // Built from the live academy — injected into the system prompt so the LLM
    // knows what each module owns and cannot duplicate across modules.
    const conceptOwnershipBlock = moduleLedger.length > 1
      ? `\n\n════════════════════════════════════════════
CONCEPT OWNERSHIP MAP — NON-NEGOTIABLE
════════════════════════════════════════════
Each module OWNS its key terms and lesson concepts. Do NOT redefine, re-explain, or introduce in another module any concept that already belongs to a different module.
${moduleLedger.map((e) =>
  `Module ${e.moduleIndex + 1} "${e.moduleTitle}" OWNS:\n  Terms: ${e.keyTerms.length ? e.keyTerms.join(", ") : "(none)"}\n  Lessons: ${e.lessonTitles.join(" | ")}`
).join("\n")}`
      : "";

    // ── Conversation history block ────────────────────────────────────────
    const historyBlock = history.length > 0
      ? `\n\nCONVERSATION HISTORY (oldest first — use this for follow-up instructions):\n${history.map((m) => `${m.role === "user" ? "USER" : "DIRECTOR"}: ${m.content}`).join("\n")}`
      : "";

    // Route structural operations to R1 (reasoning model) — they require
    // multi-step thinking about concept ownership and curriculum coherence.
    const selectedModel = isStructuralOp ? deepSeekReasonerModel : deepSeekModel;

    const { object } = await generateObject({
      model: selectedModel,
      schema: PatchResponseSchema,
      schemaName: "AcademyPatch",
      schemaDescription: "Patch object describing only the fields that need to change in the academy and/or site config.",
      mode: "json",
      maxTokens: 6000,
      temperature: 0.1,
      system: `IMPORTANT: Output ONLY a raw JSON object. No code fences, no markdown, no commentary before or after the JSON.

You are the Nexus Director AI — a precise, powerful academy editor with full control over every aspect of the academy content, visual presentation, and website configuration.

Analyse the user's instruction carefully, determine what needs to change, then return only the updated objects.

════════════════════════════════════════════
CRITICAL: SURGICAL EDITS ONLY
════════════════════════════════════════════
⚠️  NEVER delete, remove, or modify content unless the user EXPLICITLY requests it with clear language like:
    - "delete module 2"
    - "remove the lesson about X"
    - "clear the pricing tiers"
    
⚠️  When the user says "add", "update", "improve", "rewrite", "expand", or "fix" content:
    - ONLY modify the SPECIFIC item they mention
    - PRESERVE all other modules, lessons, and fields untouched
    - Do NOT reorder, restructure, or reorganize unless explicitly told to

⚠️  If the instruction is vague or could affect multiple items:
    - Choose the MOST CONSERVATIVE interpretation
    - Modify the LEAST amount of content possible
    - When in doubt, ask for clarification using the "clarificationNeeded" field

════════════════════════════════════════════
ACADEMY CONTENT CHANGES
════════════════════════════════════════════
Triggers: anything about curriculum, modules, lessons, notes, quizzes, takeaways, difficulty, theme, layout, hours, certificate

CURRICULUM OPERATIONS:
- "add a module" → Use operation="insert" with full module data (moduleTitle, lessons, learningObjectives, keyTerms)
- "remove/delete module X" → Use operation="delete" on that specific moduleIndex ONLY (requires explicit "delete" or "remove" in instruction)
- "reorder modules" → Return full curriculumPatches array with all modules in new order (requires explicit "reorder" in instruction)
- "add a lesson to module X" → Update that module's lessons array by appending new lesson
- "merge modules X and Y" → Delete one module, update the other with combined lessons (requires explicit "merge" in instruction)
- "split lesson X" → Replace one lesson with two new lessons (requires explicit "split" in instruction)

LESSON OPERATIONS:
- "rewrite notes for lesson X" → Update ONLY that specific lesson's notes field with full, dense markdown
- "add key takeaways to lesson X" → Update ONLY that lesson's keyTakeaways field (5–7 items from existing notes)
- "add action items to all lessons" → Update keyTakeaways for ALL lessons (but preserve all other lesson fields)
- "add quiz questions to lesson X" → Update ONLY that lesson's quiz field
- "add learning objectives to module X" → Update ONLY that module's learningObjectives field
- "expand the glossary for module X" → Update ONLY that module's keyTerms field (add 4–8 new entries, preserve existing)
- "format all notes" → Update ONLY the notes field for each lesson with proper markdown structure (preserve all other fields)
- "improve the notes for lesson X" → Update ONLY that specific lesson's notes field
- "delete lesson X from module Y" → Use operation="delete" on that specific lessonIndex (requires explicit "delete" or "remove" in instruction)

⚠️  LESSON EDIT RULE: When updating a lesson, include ONLY the lessonIndex and the specific fields you're changing. 
    Do NOT include unchanged fields like title, type, durationMinutes unless explicitly modifying them.

NOTES FORMAT STANDARD (when writing or reformatting notes):
  # [Lesson Title]
  ## [Major Concept 1]
  Full teaching prose (2–4 paragraphs). Ground in source material. Use:
  - **bold** for key terms
  - *italics* for titles/names
  - > blockquotes for key statements
  - Numbered lists for sequences/frameworks
  - Bullet lists for supporting points
  - --- for major thematic breaks
  ## [Major Concept 2]
  ## Key Principles (synthesise the lesson's core insights)

VISUAL / PRESENTATION CHANGES:
- themeVariant: Set to "midnight" | "amber" | "emerald" | "rose" | "violet" | "solar"
  Respond to: "change the theme", "use amber colours", "make it feel more [adjective]", "switch to [colour] theme"
  Guidance: midnight=tech/dark, amber=business/faith/warm, emerald=health/wellness, rose=personal dev, violet=programming/design, solar=beginner/broad
- layoutVariant: "centered" | "split" | "minimal"
  Respond to: "split the hero", "minimal layout", "centered design"
- difficultyLevel: "beginner" | "intermediate" | "advanced"
- totalEstimatedHours: Update when adding/removing content
- certificateTitle: Rename the completion certificate

METADATA CHANGES:
- academyName / tagline: Rebrand or rename the academy
- targetAudience: Refine the ideal student description
- seoMeta: Update title, description, keywords
- onboardingSteps: Modify the getting-started flow
- pricing: Adjust tier names, prices, periods, feature lists

════════════════════════════════════════════
SITE CONFIG CHANGES
════════════════════════════════════════════
Triggers: anything about the landing page, website, social, footer, banner, instructor, testimonials, FAQ, CTA button

- testimonials: Add/edit student testimonials — each needs name, role, quote, rating (1–5)
  Respond to: "add testimonials", "add 3 student reviews", "add social proof"
- faqItems: Add/edit FAQ questions and answers
  Respond to: "add FAQ", "add common questions"
- instructorBio: Set instructor name, professional title, bio paragraph, avatarInitials (2 uppercase letters)
  Respond to: "add instructor bio", "set the instructor details"
- announcementBar: Short bold top-of-page banner (max 80 chars)
  Respond to: "add a banner", "add announcement", "add urgency"
- ctaOverride: Override all CTA button text sitewide
  Respond to: "change the button text", "update the CTA"
- socialLinks: Set website, twitter, youtube, instagram, linkedin (full https:// URLs only)
  Respond to: "add social links", "set social media"
- footerText: Custom copyright/tagline in the footer

════════════════════════════════════════════
OUTPUT RULES — PRESERVATION IS MANDATORY
════════════════════════════════════════════
⚠️  CRITICAL PRESERVATION RULES:
1. Return "academyPatch" ONLY if academy content needs to change
2. Return "siteConfigPatch" ONLY if site config needs to change  
3. Return BOTH if both need to change
4. NEVER include a field in your patch unless you are CHANGING that specific field
5. NEVER return empty arrays for pricing/onboardingSteps unless the user explicitly said "clear" or "remove"
6. NEVER set operation="delete" unless the user explicitly said "delete", "remove", or "clear"
7. For curriculum patches: include ONLY the moduleIndex and the fields you're modifying for that module
8. For lesson patches: include ONLY the lessonIndex and the fields you're modifying for that lesson
9. If you're unsure whether the user wants to delete something, set clarificationNeeded and confidence="low"

⚠️  WHAT TO INCLUDE IN YOUR PATCH:
- Scalar fields (academyName, themeVariant, etc.) → include ONLY if the user wants to change them
- curriculumPatches → include ONLY modules you're adding, updating, or deleting (with explicit operation field)
- lessonPatches → include ONLY lessons you're adding, updating, or deleting within a module
- pricing / onboardingSteps → include ONLY if the user explicitly asks to change/add/replace them (never empty arrays)
- seoMeta → include ONLY the specific seo fields being changed (title, description, keywords)

⚠️  DELETION OPERATIONS:
- To DELETE a module: { moduleIndex: X, operation: "delete" } — ONLY if user explicitly said "delete/remove module X"
- To DELETE a lesson: { lessonIndex: Y, operation: "delete" } — ONLY if user explicitly said "delete/remove lesson Y"
- NEVER delete content based on implied intent, vague instructions, or assumptions

Always write a concise "summary" of exactly what you changed (not what you preserved).
Never invent facts not in the existing academy or user instruction.
If ambiguous, choose the most conservative interpretation that modifies the LEAST content.

════════════════════════════════════════════
OUTPUT FORMAT — patch only what changes
════════════════════════════════════════════
Return "academyPatch" with ONLY the fields that need to change:
- Scalar fields (academyName, themeVariant, difficultyLevel, etc.) — include ONLY if changing
- curriculumPatches: array of module operations:
  * To UPDATE a module: { moduleIndex, [changed fields], lessonPatches: [...] }
  * To DELETE a module: { moduleIndex, operation: "delete" } (explicit user request only!)
  * To INSERT a module: { operation: "insert", insertAfterIndex, moduleTitle, lessons: [...full lessons...], ... }
  * lessonPatches within a module:
    - To UPDATE: { lessonIndex, [changed fields] }
    - To DELETE: { lessonIndex, operation: "delete" } (explicit user request only!)
- pricing: include full replacement array ONLY if user explicitly asks to change pricing (never empty unless user said "clear pricing")
- onboardingSteps: include full replacement array ONLY if user explicitly asks to change onboarding (never empty unless user said "clear onboarding")
- seoMeta: include ONLY the seo fields being changed (e.g., just {title: "New Title"} if only title changes)
- landingPage: include ONLY the landing page fields being changed

Return "siteConfigPatch" with ONLY the site config keys that need to change (never include unchanged keys).

Always include:
- "summary": one concise sentence describing what you changed
- "confidence": "high" | "medium" | "low"
- "clarificationNeeded": (optional) if the instruction is ambiguous or you need confirmation for a destructive operation

CONCEPT OWNERSHIP: The CONCEPT OWNERSHIP MAP is a hard constraint — do not duplicate terms/concepts across modules.`,
      prompt: [
        "CURRENT ACADEMY (notes trimmed for brevity — explicitly named lessons sent at full length):",
        JSON.stringify(academyContext),
        "",
        "CURRENT SITE CONFIG:",
        JSON.stringify(siteConfig ?? {}),
        conceptOwnershipBlock,
        historyBlock,
        "",
        "USER INSTRUCTION:",
        instruction,
      ].join("\n"),
    });

        clearInterval(ping);

        // ── Validation: detect destructive operations ────────────────────────
        const warnings: string[] = [];
        if (object.academyPatch?.curriculumPatches) {
          const moduleDeletes = object.academyPatch.curriculumPatches.filter(p => p.operation === "delete");
          if (moduleDeletes.length > 0) {
            warnings.push(`⚠️ Deleting ${moduleDeletes.length} module(s): ${moduleDeletes.map(p => `Module ${p.moduleIndex + 1}`).join(", ")}`);
          }
          for (const mp of object.academyPatch.curriculumPatches) {
            if (mp.lessonPatches) {
              const lessonDeletes = mp.lessonPatches.filter(lp => lp.operation === "delete");
              if (lessonDeletes.length > 0) {
                warnings.push(`⚠️ Deleting ${lessonDeletes.length} lesson(s) from Module ${mp.moduleIndex + 1}`);
              }
            }
          }
        }
        if (object.academyPatch?.pricing !== undefined && (!object.academyPatch.pricing || object.academyPatch.pricing.length === 0)) {
          warnings.push("⚠️ Clearing pricing information");
        }
        if (object.academyPatch?.onboardingSteps !== undefined && (!object.academyPatch.onboardingSteps || object.academyPatch.onboardingSteps.length === 0)) {
          warnings.push("⚠️ Clearing onboarding steps");
        }

        // ── Dry-run: return patch without applying ───────────────────────────
        if (dryRun) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            dryRun: true,
            patch:   object.academyPatch,
            siteConfigPatch: object.siteConfigPatch,
            summary: object.summary,
            confidence: object.confidence,
            ...(warnings.length > 0 && { warnings }),
            ...(object.clarificationNeeded && { clarificationNeeded: object.clarificationNeeded }),
            academyVersion: currentVersion,
          })}\n\n`));
          controller.close();
          return;
        }

        // ── Confidence gate ─────────────────────────────────────────────
        if (object.confidence === "low" && object.clarificationNeeded) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            needsClarification: true,
            clarificationNeeded: object.clarificationNeeded,
            summary: object.summary,
            confidence: object.confidence,
            ...(warnings.length > 0 && { warnings }),
            academyVersion: currentVersion,
          })}\n\n`));
          controller.close();
          return;
        }

        // Merge patches server-side and return full objects to the client
        let updatedAcademy: AcademyPackage | undefined;
        let updatedSiteConfig: SiteConfig | undefined;

        if (object.academyPatch) {
          updatedAcademy = applyAcademyPatch(academy, object.academyPatch);
        }

        if (object.siteConfigPatch) {
          updatedSiteConfig = applySiteConfigPatch(
            siteConfig ?? SiteConfigSchema.parse({}),
            object.siteConfigPatch,
          );
        }

        // ── Append audit trail entry ───────────────────────────────────────────
        if (updatedAcademy) {
          const entry = {
            timestamp:   new Date().toISOString(),
            instruction: instruction.slice(0, 200),
            summary:     object.summary,
            model:       (isStructuralOp ? "r1" : "v3") as "r1" | "v3",
          };
          const existing = (academy.changeLog ?? []) as typeof entry[];
          updatedAcademy = { ...updatedAcademy, changeLog: [...existing, entry].slice(-50) };
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          academy:        updatedAcademy,
          siteConfig:     updatedSiteConfig,
          summary:        object.summary,
          confidence:     object.confidence,
          academyVersion: updatedAcademy ? computeAcademyVersion(updatedAcademy) : currentVersion,
          ...(warnings.length > 0 && { warnings }),
          ...(object.clarificationNeeded && { clarificationNeeded: object.clarificationNeeded }),
        })}\n\n`));
      } catch (error) {
        clearInterval(ping);
        const message = error instanceof Error ? error.message : "Assistant failed";
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
      "X-Accel-Buffering": "no",
    },
  });
}
