"use client";

import { useMemo, useState } from "react";
import { z } from "zod";
import { ProseEditor } from "@/app/components/ProseEditor";
import type { ChapterDraft, SectionAssignment } from "@/lib/schemas/ebook";

type Props = {
  chapters: ChapterDraft[];
  sectionAssignments: SectionAssignment[];
  transcriptEntries: Array<{ label: string; text: string }>;
  onSectionBodyChange: (chapterNumber: number, sectionNumber: number, body: string) => void;
  authorConfig?: { instructions: string; targetAudience: string };
};

const RewriteResponseSchema = z.object({
  body: z.string().default(""),
  excerptUsage: z.array(z.number().int().positive()).default([]),
});

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function overlapScore(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const bSet = new Set(tb);
  let hits = 0;
  for (const token of ta) {
    if (bSet.has(token)) hits += 1;
  }
  return hits / Math.max(ta.length, 1);
}

function splitParagraphs(body: string): string[] {
  return body
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function TranscriptSourceMapPanel({
  chapters,
  sectionAssignments,
  transcriptEntries,
  onSectionBodyChange,
  authorConfig,
}: Props) {
  const flatSections = useMemo(
    () => chapters.flatMap((chapter) => chapter.sections.map((section) => ({ chapter, section }))),
    [chapters]
  );

  const [activeKey, setActiveKey] = useState<string | null>(() => {
    const first = flatSections[0];
    return first ? `${first.chapter.number}-${first.section.sectionNumber}` : null;
  });
  const [selectedExcerptNumbers, setSelectedExcerptNumbers] = useState<Set<number>>(new Set());
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [rewriteBusy, setRewriteBusy] = useState(false);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [activeExcerptNumber, setActiveExcerptNumber] = useState<number | null>(null);

  const active = useMemo(() => {
    if (!activeKey) return null;
    const [chStr, secStr] = activeKey.split("-");
    const chapterNumber = Number(chStr);
    const sectionNumber = Number(secStr);
    const chapter = chapters.find((c) => c.number === chapterNumber);
    const section = chapter?.sections.find((s) => s.sectionNumber === sectionNumber);
    const assignment = sectionAssignments.find(
      (a) => a.chapterNumber === chapterNumber && a.sectionNumber === sectionNumber
    );
    if (!chapter || !section || !assignment) return null;
    return { chapter, section, assignment };
  }, [activeKey, chapters, sectionAssignments]);

  const paragraphToExcerpt = useMemo(() => {
    if (!active) return [] as number[];
    const paragraphs = splitParagraphs(active.section.body ?? "");
    return paragraphs.map((paragraph) => {
      let best = -1;
      let score = 0;
      active.assignment.transcriptExcerpts.forEach((excerpt, index) => {
        const next = overlapScore(paragraph, excerpt);
        if (next > score) {
          score = next;
          best = index;
        }
      });
      return score >= 0.08 ? best : -1;
    });
  }, [active]);

  const usedExcerptNumbers = useMemo(() => {
    const used = new Set<number>();
    for (const idx of paragraphToExcerpt) {
      if (idx >= 0) used.add(idx + 1);
    }
    return used;
  }, [paragraphToExcerpt]);

  const skippedExcerptNumbers = useMemo(() => {
    if (!active) return [] as number[];
    const skipped: number[] = [];
    for (let i = 1; i <= active.assignment.transcriptExcerpts.length; i++) {
      if (!usedExcerptNumbers.has(i)) skipped.push(i);
    }
    return skipped;
  }, [active, usedExcerptNumbers]);

  const activeSlotLabel = useMemo(() => {
    if (!active) return "";
    const ids = active.assignment.sourceSegmentIds ?? [];
    const inferred = ids.find((id) => id.includes("audio-"));
    if (!inferred) return "";
    const match = inferred.match(/audio-\d/);
    return match ? match[0].replace("audio-", "Slot-") : "";
  }, [active]);

  const transcriptPreview = useMemo(() => {
    if (!activeSlotLabel) return null;
    return transcriptEntries.find((entry) => entry.label === activeSlotLabel) ?? null;
  }, [activeSlotLabel, transcriptEntries]);

  const applyRewrite = async () => {
    if (!active) return;
    setRewriteBusy(true);
    setRewriteError(null);
    try {
      const response = await fetch("/api/ebook/rewrite-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignment: active.assignment,
          currentBody: active.section.body ?? "",
          instruction: rewriteInstruction,
          includeExcerptNumbers: Array.from(selectedExcerptNumbers),
          authorConfig,
        }),
      });
      const raw = await response.json();
      if (!response.ok) {
        throw new Error(typeof raw?.error === "string" ? raw.error : "Rewrite failed");
      }
      const parsed = RewriteResponseSchema.parse(raw);
      if (!parsed.body.trim()) {
        throw new Error("Rewrite returned empty text");
      }
      onSectionBodyChange(active.chapter.number, active.section.sectionNumber, parsed.body.trim());
      setSelectedExcerptNumbers(new Set());
      setActiveExcerptNumber(parsed.excerptUsage[0] ?? null);
    } catch (err) {
      setRewriteError(err instanceof Error ? err.message : "Rewrite failed");
    } finally {
      setRewriteBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3">
        <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">Section</label>
        <select
          value={activeKey ?? ""}
          onChange={(e) => {
            setActiveKey(e.target.value || null);
            setSelectedExcerptNumbers(new Set());
            setActiveExcerptNumber(null);
            setRewriteError(null);
          }}
          className="w-full min-h-[48px] rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
        >
          {flatSections.map(({ chapter, section }) => {
            const key = `${chapter.number}-${section.sectionNumber}`;
            return (
              <option key={key} value={key}>
                {`Ch ${chapter.number} § ${section.sectionNumber} - ${section.heading}`}
              </option>
            );
          })}
        </select>
        {active && (
          <p className="mt-2 text-xs text-slate-400">
            {usedExcerptNumbers.size} used • {skippedExcerptNumbers.length} skipped • {active.assignment.transcriptExcerpts.length} total excerpts
          </p>
        )}
      </div>

      {!active && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          No section assignment found for this section yet.
        </div>
      )}

      {active && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
          <section className="rounded-xl border border-violet-500/20 bg-slate-900/50 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-violet-300">Transcript Source</p>
              {transcriptPreview && (
                <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-1 text-[10px] font-semibold text-violet-200">
                  {transcriptPreview.label}
                </span>
              )}
            </div>

            <div className="max-h-[48dvh] space-y-2 overflow-y-auto pr-1 lg:max-h-[70dvh]">
              {active.assignment.transcriptExcerpts.map((excerpt, index) => {
                const number = index + 1;
                const isUsed = usedExcerptNumbers.has(number);
                const isSkipped = !isUsed;
                const isSelected = selectedExcerptNumbers.has(number);
                const isActive = activeExcerptNumber === number;
                return (
                  <div
                    key={number}
                    className={[
                      "rounded-xl border px-3 py-3",
                      isActive ? "border-cyan-400/50 bg-cyan-500/10" : "border-slate-700/60 bg-slate-950/70",
                    ].join(" ")}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveExcerptNumber(number)}
                        className="min-h-[48px] rounded-lg border border-slate-600/60 px-2.5 text-xs font-semibold text-slate-200"
                      >
                        Excerpt {number}
                      </button>
                      <span
                        className={[
                          "rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                          isUsed
                            ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-amber-500/20 text-amber-200",
                        ].join(" ")}
                      >
                        {isUsed ? "Used" : "Skipped"}
                      </span>
                      {isSkipped && (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedExcerptNumbers((prev) => {
                              const next = new Set(prev);
                              if (next.has(number)) next.delete(number);
                              else next.add(number);
                              return next;
                            });
                          }}
                          className={[
                            "min-h-[48px] rounded-lg border px-2.5 text-xs font-semibold",
                            isSelected
                              ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-200"
                              : "border-slate-600/60 text-slate-200",
                          ].join(" ")}
                        >
                          {isSelected ? "Will include" : "Include in rewrite"}
                        </button>
                      )}
                    </div>
                    <p className="text-sm leading-relaxed text-slate-300">{excerpt}</p>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-xl border border-cyan-500/20 bg-slate-900/50 p-3">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-cyan-300">LLM Written Section</p>

            <div className="mb-3 max-h-[30dvh] space-y-2 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-950/70 p-3 lg:max-h-[24dvh]">
              {splitParagraphs(active.section.body ?? "").map((paragraph, index) => {
                const mappedIdx = paragraphToExcerpt[index];
                const mappedNumber = mappedIdx >= 0 ? mappedIdx + 1 : null;
                return (
                  <button
                    type="button"
                    key={`${index}-${mappedNumber ?? "none"}`}
                    onClick={() => setActiveExcerptNumber(mappedNumber)}
                    className={[
                      "w-full rounded-lg border p-2 text-left",
                      "min-h-[48px]",
                      mappedNumber === null
                        ? "border-amber-500/30 bg-amber-500/10"
                        : activeExcerptNumber === mappedNumber
                        ? "border-cyan-400/50 bg-cyan-500/10"
                        : "border-slate-700/60 bg-slate-900/60",
                    ].join(" ")}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Paragraph {index + 1}</span>
                      <span className="text-[10px] font-semibold text-cyan-200">
                        {mappedNumber ? `Uses excerpt ${mappedNumber}` : "No clear source match"}
                      </span>
                    </div>
                    <p className="line-clamp-3 text-sm leading-relaxed text-slate-300">{paragraph}</p>
                  </button>
                );
              })}
            </div>

            <ProseEditor
              label="Edit section text"
              value={active.section.body ?? ""}
              onChange={(next) => onSectionBodyChange(active.chapter.number, active.section.sectionNumber, next)}
              rows={14}
              placeholder="Edit this section..."
            />

            <div className="mt-3 space-y-2 rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500">Rewrite instruction</label>
              <textarea
                value={rewriteInstruction}
                onChange={(e) => setRewriteInstruction(e.target.value)}
                rows={4}
                placeholder="Tell the model how to rewrite this section, e.g. tighten flow and include selected skipped excerpts."
                className="w-full rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
              />
              <button
                type="button"
                disabled={rewriteBusy}
                onClick={() => void applyRewrite()}
                className="w-full min-h-[48px] rounded-xl bg-gradient-to-r from-cyan-500 to-violet-500 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {rewriteBusy
                  ? "Rewriting section..."
                  : `Rewrite Section${selectedExcerptNumbers.size > 0 ? ` (include ${selectedExcerptNumbers.size} skipped)` : ""}`}
              </button>
              {rewriteError && <p className="text-xs text-red-300">{rewriteError}</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
