"use client";

import { useState, useEffect } from "react";
import {
  isInReadingList,
  toggleReadingList,
  type ReadingListEntry,
} from "@/lib/reading-list-store";

export default function ReadingListButton({
  entry,
  accentBg,
}: {
  entry:    ReadingListEntry;
  accentBg: string; // Tailwind classes e.g. "bg-amber-500 hover:bg-amber-400"
}) {
  const [saved, setSaved] = useState(false);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    setSaved(isInReadingList(entry.slug));
  }, [entry.slug]);

  function handleToggle() {
    const nowSaved = toggleReadingList(entry);
    setSaved(nowSaved);
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
  }

  return (
    <button
      onClick={handleToggle}
      aria-label={saved ? "Remove from reading list" : "Add to reading list"}
      className={`inline-flex min-h-14 min-w-[48px] items-center gap-2.5 rounded-2xl border px-6 text-base font-semibold transition active:scale-[0.97]
        ${saved
          ? "border-slate-600 bg-slate-800 text-slate-300 hover:border-slate-500 hover:bg-slate-700"
          : "border-slate-700/60 bg-slate-900/60 text-slate-300 hover:border-slate-600 hover:bg-slate-800"
        }`}
    >
      {/* Bookmark icon */}
      <svg viewBox="0 0 24 24" className="h-5 w-5 flex-shrink-0" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.75}>
        <path d="M5 3h14a1 1 0 011 1v17l-8-4-8 4V4a1 1 0 011-1z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="hidden sm:inline">
        {flash ? (saved ? "Saved!" : "Removed") : saved ? "In My List" : "Save to List"}
      </span>
    </button>
  );
}
