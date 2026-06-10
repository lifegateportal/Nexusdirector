import type { EbookJobState } from "@/lib/schemas/ebook";

export type EbookProject = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  bookTitle: string;
  chapterCount: number;
  totalWordCount: number;
  status: string;
  jobState: EbookJobState;
  /** Slug of the published library entry, set after a successful publish */
  publishedSlug?: string;
  /** R2 public URL for the book cover image */
  coverImageUrl?: string;
  /** R2 public URL for the author's photo */
  authorImageUrl?: string;
};

const DB_NAME = "nexus-ebook-projects";
const STORE   = "projects";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}

export async function listEbookProjects(): Promise<EbookProject[]> {
  if (typeof window === "undefined") return [];
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const items = (req.result as EbookProject[]).sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function saveEbookProject(project: EbookProject): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...project, updatedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function deleteEbookProject(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export function generateEbookProjectId(): string {
  return `ebook-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
