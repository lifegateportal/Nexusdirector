/**
 * ebook-job-store.ts
 * IndexedDB persistence for ebook generation jobs.
 * Each section is saved immediately after completion — pipeline is fully resumable.
 */

import type { EbookJobState } from "@/lib/schemas/ebook";

const DB_NAME = "nexus-ebook-jobs";
const STORE_NAME = "jobs";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "jobId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveEbookJob(state: EbookJobState): Promise<void> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ ...state, updatedAt: new Date().toISOString() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error("[ebook-job-store] Failed to save job:", err);
    throw err;
  }
}

export async function getEbookJob(jobId: string): Promise<EbookJobState | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(jobId);
      req.onsuccess = () => resolve((req.result as EbookJobState) ?? null);
      req.onerror = () => reject(req.error);
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
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error("[ebook-job-store] Failed to list jobs:", err);
    throw err;
  }
}

export async function deleteEbookJob(jobId: string): Promise<void> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(jobId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error(`[ebook-job-store] Failed to delete job ${jobId}:`, err);
    throw err;
  }
}

export function newJobId(): string {
  return `ebook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
