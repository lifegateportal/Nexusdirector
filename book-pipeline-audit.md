# Nexus-Director — Book Pipeline Audit
**Date:** July 18, 2026  
**Scope:** Full pipeline — ingestion → signal filter → voice DNA → content map → architect → chapter plan → write-section → audit → polish → export → publish

---

## Executive Summary

The pipeline is architecturally sophisticated and clearly purpose-built for high-fidelity pastoral/theological book production. The schema layer (Zod), the Voice DNA system, and the anti-duplication controls are genuinely industry-leading for an independent AI publishing tool. However, seven categories of issues need amendment before the pipeline is production-safe, and a further set of industry-standard upgrades would close the gap with commercial AI publishing platforms (Jasper, Lex, Shimmr).

---

## Part 1 — What Needs Amendment

### 🔴 Critical (Data-Loss / Correctness Risk)

---

#### C-1 · R2 Catalog Race Condition in `/api/ebook/publish`

**What it does:** On every publish, the route fetches `index.json` from R2, appends or updates the entry, then writes it back.

**The problem:** There is no locking, ETags, or versioning on the read-modify-write cycle. Two concurrent publishes (or a user double-clicking "Publish") will race: both read the same stale `index.json`, both write their version back, and one silently overwrites the other's entry. The catalog becomes inconsistent.

**Amendment:**
```typescript
// Before overwrite, compare ETags from the GetObject response.
// Retry with back-off if the ETag changed before PutObject completes.
const { ETag, Body } = await s3.send(new GetObjectCommand({ Bucket, Key: "index.json" }));
// ... mutate catalog ...
await s3.send(new PutObjectCommand({
  Bucket, Key: "index.json", Body: newJson,
  // Abort if another writer changed the file between our read and write
  IfMatch: ETag,
}));
```
Alternatively, move the catalog to a server-side KV store (Replit DB, Redis, or a Postgres table) where atomic upserts are trivial.

---

#### C-2 · Slug Collision Not Handled

**What it does:** Published book slugs are derived from a 6-character hash of the title + timestamp.

**The problem:** No uniqueness check is done before writing. A collision silently overwrites an existing published book's record. At scale (100+ books) the birthday problem makes this a near-certainty.

**Amendment:** After generating a candidate slug, query the catalog to confirm it is not already taken before committing. Append an incrementing suffix (`-2`, `-3`) on collision.

---

#### C-3 · `EbookJobState` Stored Only in IndexedDB (Client-Only)

**What it does:** All pipeline progress — transcripts, voice DNA, architecture, section drafts — is persisted exclusively in the browser's IndexedDB.

**The problem:** Clearing browser data, opening a second device, incognito mode, or a browser crash permanently destroys an in-progress job. A job that takes 45–90 minutes of LLM compute is unrecoverable.

**Amendment:** After each stage completes, POST a serialised snapshot to a server-side endpoint (e.g. `/api/ebook/jobs/[jobId]/checkpoint`) that writes to R2 or a database. The `saveEbookJob` function is the right interception point — add a server-sync call there.

---

### 🟠 High (Reliability / Correctness)

---

#### H-1 · No Request Body Size Limits on Transcript Endpoints

**What it does:** `/api/ebook/filter-signal`, `/api/ebook/voice-dna`, and `/api/ebook/content-map` all accept raw transcript strings with no byte-length cap beyond Zod's `min(100)`.

**The problem:** A user can upload 6 × 3-hour audio files. The combined master transcript can exceed 500 KB. Passing this entire string to a single LLM call will hit the model's context window, produce a truncated/hallucinated response with no error surfaced to the user, and burn significant API budget.

**Amendment:**
```typescript
// In each route, add an explicit byte-length guard before calling the LLM
if (Buffer.byteLength(body.masterTranscript, "utf8") > 400_000) {
  return NextResponse.json(
    { error: "Transcript exceeds 400 KB — split into smaller sessions." },
    { status: 422 }
  );
}
```
For `content-map`, the existing slot-splitting logic is correct — ensure it applies to `voice-dna` and `filter-signal` too.

---

#### H-2 · `withRetry` Retries Non-Retryable Errors

**What it does:** The `withRetry` wrapper in `EbookPipeline.tsx` retries all errors up to 2 times with exponential back-off.

**The problem:** HTTP 400 (bad request / schema mismatch), 401 (invalid API key), and 422 (validation error) are deterministic — retrying them wastes time and burns LLM quota. Only 429 (rate limit) and 5xx (server error) should be retried.

**Amendment:**
```typescript
async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (err) {
      const status = (err as { status?: number }).status;
      // Do not retry client errors
      if (status && status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt === retries) throw err;
      await delay(Math.pow(2, attempt) * 1000);
    }
  }
  throw new Error("unreachable");
}
```

---

#### H-3 · Missing Zod Validation on LLM Output in Several Routes

**What it does:** Routes like `/api/ebook/sanitize` and `/api/ebook/voice-dna` parse the LLM's text response but do not run the output through their own Zod schema before returning it to the client.

**The problem:** If the model returns a partial or malformed JSON object (common on timeout or context overflow), the invalid data silently propagates into downstream stages, corrupting the Voice DNA or Content Map used by every subsequent step.

**Amendment:** Every route that calls `generateObject` should add a Zod `.safeParse()` on the result before returning:
```typescript
const parsed = VoiceDNASchema.safeParse(result.object);
if (!parsed.success) {
  return NextResponse.json(
    { error: "LLM returned invalid schema", issues: parsed.error.issues },
    { status: 502 }
  );
}
return NextResponse.json(parsed.data);
```

---

#### H-4 · `chapter-plan` Heartbeat Uses Raw `\n` Spacer Bytes

**What it does:** The chapter-plan route sends periodic newline characters over the stream to prevent proxy timeouts during long DeepSeek-R1 reasoning.

**The problem:** These spacer bytes are injected directly into the streaming response. If the client attempts to parse the full response as JSON, the leading whitespace causes a parse error. This works by accident today (client reads the final JSON only), but is fragile and undocumented.

**Amendment:** Use a proper SSE (Server-Sent Events) stream with explicit `event: heartbeat\ndata: {}\n\n` frames, and change the client to an EventSource reader. This is standard practice for long-running AI streams and is natively supported in Next.js via `ReadableStream`.

---

### 🟡 Medium (Quality / Maintainability)

---

#### M-1 · `EbookPipeline.tsx` Is a ~3,000-Line God Component

**What it does:** A single React component manages all UI rendering, the entire pipeline state machine, retry logic, concurrency controls, progress calculation, and error formatting.

**The problem:** This violates the Single Responsibility Principle. Adding a new pipeline stage, changing retry behaviour, or fixing a display bug all require navigating the same enormous file. Testing any logic in isolation is impossible.

**Amendment (phased):**
1. Extract the state machine into a `useEbookPipeline` custom hook (pure logic, no JSX).
2. Extract concurrency helpers (`withRetry`, `withTimeout`, `mapWithConcurrency`) into `lib/pipeline-utils.ts`.
3. Split the UI into stage-specific sub-components: `<TranscriptionStage>`, `<ArchitectStage>`, `<WritingStage>`, etc.

---

#### M-2 · Two Duplicate IndexedDB Stores Holding the Same Data

**What it does:** `lib/ebook-job-store.ts` and `lib/ebook-project-store.ts` are separate IndexedDB databases (`nexus-ebook-jobs` and `nexus-ebook-projects`) that both embed the full `EbookJobState`.

**The problem:** Every save operation must be coordinated between two stores. They can drift out of sync (project shows "complete", job store shows "writing"). The full job state is duplicated on disk. Both stores open their own `IDBDatabase` connection on every operation — there is no connection pooling.

**Amendment:** Consolidate into a single `nexus-projects` database with one `projects` object store. Keep a lightweight `ProjectMeta` index (title, word count, status, updatedAt) in a separate small table for fast listing without deserialising full job state.

---

#### M-3 · No API Authentication

**What it does:** Every route in `/api/ebook/` is publicly accessible — there is no session check, API key, or middleware guard.

**The problem:** Anyone who discovers the endpoint can trigger expensive LLM calls (DeepSeek-R1, Claude) and file uploads to R2, running up your bill with zero attribution. A single malicious `write-section` call with a large transcript can consume $5–10 of DeepSeek-R1 budget.

**Amendment:** Add a Next.js middleware (`middleware.ts`) that validates the `SESSION_SECRET`-signed session cookie before any `/api/ebook/` request reaches a handler:
```typescript
// middleware.ts
import { NextResponse } from "next/server";
export function middleware(req) {
  const session = req.cookies.get("nexus_session");
  if (!session || !validateSession(session.value)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
export const config = { matcher: ["/api/ebook/:path*"] };
```

---

#### M-4 · `MinimalChapterSchema` Defaults Mask Malformed Architect Output

**What it does:** The architect route uses a schema with `.default([])` and `.default("")` on almost every field, meaning a nearly empty LLM response will pass validation and produce a chapter with no sections, no title, and no key theme.

**The problem:** The pipeline proceeds with an empty chapter structure, the writing stage produces 0 sections for that chapter, and the failure is only discovered at the export stage — after 40+ minutes of compute.

**Amendment:** Add post-parse validation guards:
```typescript
const arch = parsed.data;
const emptyChapters = arch.chapters.filter(c => c.sections.length === 0);
if (emptyChapters.length > 0) {
  return NextResponse.json(
    { error: `Architect returned ${emptyChapters.length} chapter(s) with no sections`, emptyChapters: emptyChapters.map(c => c.title) },
    { status: 502 }
  );
}
```

---

## Part 2 — Industry-Standard Upgrades

### Upgrade 1 · Server-Side Job Checkpointing with Resume-from-Stage

**Standard:** All commercial AI pipelines (Runway, ElevenLabs, Jasper) checkpoint work server-side and expose a `/jobs/{id}/status` polling endpoint.

**What to build:**
- A server-side job store (R2 JSON blob or Postgres row) written after every stage completes.
- A `GET /api/ebook/jobs/[jobId]` endpoint returning current stage + progress.
- The client polls this endpoint on load, allowing cross-device resume and crash recovery.
- A "Resume" button in the Projects panel that picks up from the last saved stage.

**Impact:** Eliminates C-3 entirely. Makes the pipeline safe to run on mobile or low-memory devices.

---

### Upgrade 2 · Proper SSE Streaming Progress Protocol

**Standard:** Long AI operations stream events so users see real-time progress, not a spinner that may mean "working" or "hung".

**What to build:**
- Replace the current heartbeat hack in `chapter-plan` with proper SSE streams on all heavy routes.
- Each event carries `{ stage, step, totalSteps, preview }` — the UI renders a live progress bar and real-time word-count ticker.
- Use Next.js `ReadableStream` with `TextEncoder`:
```typescript
const stream = new ReadableStream({ start(controller) {
  controller.enqueue(`event: progress\ndata: ${JSON.stringify({ step: 1, label: "Planning paragraphs…" })}\n\n`);
}});
return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
```

**Impact:** Removes the "Is it frozen?" anxiety that kills trust in long AI pipelines.

---

### Upgrade 3 · Semantic Similarity Gate Before Write Stage

**Standard:** Enterprise content pipelines (Writer.com, Narrato) run a pre-flight similarity check before generating to prevent structural duplication.

**What to build:**
- After `chapter-plan` completes, embed each section's `keyPoints` with a lightweight embedding model (Gemini `text-embedding-004` — free tier, fast).
- Compute cosine similarity between all section pairs across the book.
- Flag pairs with similarity > 0.85 as candidates for merge or elimination before writing begins.
- Surface these as a "Structural Review" modal in the UI, giving the user merge / proceed / reassign options.

**Impact:** Catches content overlap *before* spending 30+ minutes writing sections that will fail the audit stage anyway.

---

### Upgrade 4 · LLM Cost Tracking per Job

**Standard:** Every production AI platform (OpenAI Playground, AWS Bedrock) tracks token usage and cost per operation.

**What to build:**
- Capture `usage.promptTokens` and `usage.completionTokens` from every AI SDK call (all providers expose this on the response object — DeepSeek returns OpenAI-format usage).
- Accumulate in a `costLedger` field on `EbookJobState`.
- Display estimated cost (using published per-million-token rates) in the Projects panel.
- Add a pre-flight cost estimate before the user starts a job, based on transcript word count and chapter count.

**Impact:** Prevents bill shock. Lets users make informed trade-offs (fewer chapters = lower cost).

---

### Upgrade 5 · Quality Score Dashboard After Audit

**Standard:** Grammarly, ProWritingAid, and Hemingway produce a quantified quality score so the author can track improvement across edits.

**What to build:**
- After `/api/ebook/audit` runs, compute a structured quality score:
```typescript
type QualityScore = {
  voiceFidelity: number;       // 0–100: how closely sections match Voice DNA
  contentCoverage: number;     // 0–100: % of source transcript points addressed
  structuralCoherence: number; // 0–100: arc completeness (hook/context/mechanism/application)
  duplicationIndex: number;    // 0–100 (100 = no duplication)
  overall: number;
};
```
- Display these as radial gauges in the UI, chapter by chapter.
- Store scores in `EbookJobState.auditScores` so they persist and can be compared across polish rounds.

**Impact:** Gives authors a target to improve against. Makes the audit a motivating tool, not just a gate.

---

### Upgrade 6 · Narration Track Pre-Generation (TTS Integration)

**Standard:** Findaway, Draft2Digital, and ACX all offer AI narration as a native publish step.

**What to build:**
- After export, offer a "Generate Narration" step that calls ElevenLabs (or Deepgram TTS) chapter by chapter.
- Store narration URLs in the already-present `EbookManifest.narrationUrls` field — **this schema field exists but is never populated**.
- Add a chapter-by-chapter audio player in the Preview panel.

**Impact:** Unlocks audiobook publishing with zero extra manual work. The schema is already built for this.

---

### Upgrade 7 · Automated Scripture Accuracy Verification

**Standard:** Faithlife Proclaim, Logos, and Bible Gateway integrations in Christian publishing tools verify every scripture reference before print.

**What to build:**
- After the audit stage, call the existing `/api/bible-verse` endpoint for every `Quote` with `type: "scripture"` in `EbookManifest.allQuotes`.
- Compare the quote text stored in the manifest against the canonical verse text from the API.
- Flag any quote where the texts differ by more than a 10% edit distance — these are likely paraphrases passed off as direct quotes.
- Surface mismatches in the audit UI with the canonical text alongside the draft text for one-click correction.

**Impact:** Eliminates the most reputation-damaging error in theological publishing: misquoting scripture. The `/api/bible-verse` route already exists — this upgrade is primarily UI wiring.

---

### Upgrade 8 · Architecture Lock Before Writing Begins

**Standard:** Hollywood script coverage tools and book packagers lock structure before prose to prevent mid-flight architecture changes from corrupting written sections.

**What to build:**
- After the architect stage, present a "Lock Architecture" confirmation step.
- Post-lock: record the blueprint as immutable (`architectureLocked: true` on `EbookJobState`).
- Prevent re-runs of `architect` or `assign-segments` once any section has been written.
- Display a visual "locked" badge on each chapter card in the UI.

**Impact:** Prevents the current silent failure mode where re-running an earlier stage invalidates all written sections that depend on the old architecture.

---

## Summary Table

| ID | Severity | Issue | Effort |
|----|----------|-------|--------|
| C-1 | 🔴 Critical | R2 catalog race condition | M |
| C-2 | 🔴 Critical | Slug collision not handled | S |
| C-3 | 🔴 Critical | Client-only job persistence | L |
| H-1 | 🟠 High | Missing transcript size limits | S |
| H-2 | 🟠 High | Retry retries non-retryable errors | S |
| H-3 | 🟠 High | Missing LLM output schema validation | M |
| H-4 | 🟠 High | Heartbeat spacer bytes fragile | M |
| M-1 | 🟡 Medium | ~3,000-line god component | L |
| M-2 | 🟡 Medium | Duplicate IndexedDB stores | M |
| M-3 | 🟡 Medium | No API authentication on ebook routes | S |
| M-4 | 🟡 Medium | Schema defaults mask architect failures | S |
| U-1 | ⬆️ Upgrade | Server-side checkpointing + resume | L |
| U-2 | ⬆️ Upgrade | Proper SSE streaming progress | M |
| U-3 | ⬆️ Upgrade | Pre-write semantic similarity gate | M |
| U-4 | ⬆️ Upgrade | LLM cost tracking per job | M |
| U-5 | ⬆️ Upgrade | Quality score dashboard | M |
| U-6 | ⬆️ Upgrade | TTS narration track generation | L |
| U-7 | ⬆️ Upgrade | Automated scripture verification | M |
| U-8 | ⬆️ Upgrade | Architecture lock before writing | S |

**Effort key:** S = 1–2 hours · M = half day · L = 1–2 days

---

## Recommended Sequencing

**Sprint 1 — Fix before any production use:** C-1, C-2, H-1, H-2, M-3  
**Sprint 2 — Reliability hardening:** C-3 + U-1 together (same server-sync work), H-3, H-4, M-4  
**Sprint 3 — Quality & UX:** U-3, U-5, U-8, M-1 (begin decomposition)  
**Sprint 4 — Publishing features:** U-4, U-6, U-7  
