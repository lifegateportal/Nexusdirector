// ── Reading List Store ────────────────────────────────────────────────────────
// localStorage-backed personal reading list. No auth required.

export type ReadingListEntry = {
  slug:          string;
  title:         string;
  authorName:    string;
  subtitle?:     string;
  coverAccent:   string;
  coverImageUrl: string | null;
  addedAt:       string;
};

const KEY = "nd_reading_list";

function load(): ReadingListEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ReadingListEntry[]) : [];
  } catch { return []; }
}

function save(list: ReadingListEntry[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

export function getReadingList(): ReadingListEntry[] {
  return load();
}

export function isInReadingList(slug: string): boolean {
  return load().some((e) => e.slug === slug);
}

export function addToReadingList(entry: ReadingListEntry): void {
  const list = load().filter((e) => e.slug !== entry.slug);
  list.unshift({ ...entry, addedAt: new Date().toISOString() });
  save(list);
}

export function removeFromReadingList(slug: string): void {
  save(load().filter((e) => e.slug !== slug));
}

export function toggleReadingList(entry: ReadingListEntry): boolean {
  if (isInReadingList(entry.slug)) {
    removeFromReadingList(entry.slug);
    return false;
  }
  addToReadingList(entry);
  return true;
}
