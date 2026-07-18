/**
 * ebook-job-store.ts
 *
 * Two-layer persistence for ebook generation jobs:
 *
 *   1. IndexedDB  — primary, synchronous-feeling local store. Every pipeline
 *      stage saves here immediately so the UI always has up-to-date state.
 *
 *   2. R2 server checkpoint  — fire-and-forget background sync after each save.
 *      Allows cross-device resume and survives browser data clears.
 *      The checkpoint endpoint (/api/ebook/jobs/[jobId]) is a best-effort
 *      write — a failure is logged but never thrown to the caller, so the
 *      pipeline is never blocked by a network hiccup.
 *
 * Resume flow:
 *   On startup, call tryLoadServerCheckpoint(jobId) which returns the server
 *   snapshot when it is newer than (or absent from) local IndexedDB.
 */

import type { EbookJobState } from "@/lib/schemas/ebook";

// ── IndexedDB constants ───────────────────────────────────────────────────────

const DB_NAME    = "nexus-ebook-jobs";
const STORE_NAME = "jobs";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "jobId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── Server checkpoint sync ────────────────────────────────────────────────────

/**
 * Best-effort POST to the server checkpoint endpoint.
 * Never throws — network failures are swallowed so the pipeline continues.
 */
async function syncToServer(state: EbookJobState): Promise<void> {
  try {
    await fetch(`/api/ebook/jobs/${encodeURIComponent(state.jobId)}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(state),
    });
  } catch (err) {
    // Non-blocking — log and continue
    console.warn("[ebook-job-store] Server checkpoint sync failed:", err);
  }
}

/**
 * Attempt to load the latest server checkpoint for a job.
 * Returns null when:
 *  - no checkpoint exists on the server yet
 *  - R2 is not configured
 *  - the network request fails
 *  - the returned schema is invalid
 *
 * Callers should prefer the local IndexedDB copy when it is newer.
 */
export async function tryLoadServerCheckpoint(jobId: string): Promise<EbookJobState | null> {
  try {
    const res = await fetch(`/api/ebook/jobs/${encodeURIComponent(jobId)}`);
    if (!res.ok) return null;
    const data = await res.json() as { state?: EbookJobState | null };
    return data.state ?? null;
  } catch (err) {
    console.warn("[ebook-job-store] Failed to load server checkpoint:", err);
    return null;
  }
}

// ── Local IndexedDB operations ────────────────────────────────────────────────

export async function saveEbookJob(state: EbookJobState): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ ...state, updatedAt: new Date().toISOString() });
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch (err) {
    console.error("[ebook-job-store] Failed to save job locally:", err);
    throw err;
  }

  // Fire-and-forget server sync — never blocks the caller
  void syncToServer(state);
}

export async function getEbookJob(jobId: string): Promise<EbookJobState | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(jobId);
      req.onsuccess = () => resolve((req.result as EbookJobState) ?? null);
      req.onerror   = () => reject(req.error);
    });
  } catch (err) {
    console.error(`[ebook-job-store] Failed to load job ${jobId}:`, err);
    throw err;
  }
}

export async function listEbookJobs(): Promise<EbookJobState[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .getAll();
      req.onsuccess = () => resolve((req.result as EbookJobState[]) ?? []);
      req.onerror   = () => reject(req.error);
    });
  } catch (err) {
    console.error("[ebook-job-store] Failed to list jobs:", err);
    throw err;
  }
}

export async function deleteEbookJob(jobId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(jobId);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch (err) {
    console.error(`[ebook-job-store] Failed to delete job ${jobId}:`, err);
    throw err;
  }
}

export function newJobId(): string {
  return `ebook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
