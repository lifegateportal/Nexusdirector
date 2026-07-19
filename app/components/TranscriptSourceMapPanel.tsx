"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

const CritiqueResponseSchema = z.object({
  summary: z.string().default(""),
  strengths: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
});

type HistoryEntry = {
  past: string[];
  present: string;
  future: string[];
};

function normalizeForExactMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ── N-gram overlap coverage check ─────────────────────────────────────────
// The LLM paraphrases rather than copying transcript text verbatim, so a
// simple string.includes() check always returns false. Instead we measure
// 4-gram overlap between the excerpt and the full section body. Any excerpt
// whose concepts are ≥15% present in the body is considered covered.
function bodyNgrams(text: string, n = 4): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const grams = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

function excerptCoveredInBody(excerpt: string, bodyGrams: Set<string>): boolean {
  const excGrams = bodyNgrams(excerpt);
  if (excGrams.size === 0) return false;
  let shared = 0;
  for (const g of excGrams) {
    if (bodyGrams.has(g)) shared++;
  }
  // 15% n-gram overlap: the excerpt's core concepts appear in the prose
  return shared / excGrams.size >= 0.15;
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
  const isLikelyIOS = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const touchPoints = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
    return /iPad|iPhone|iPod/i.test(ua)
      || (/Mac/i.test(platform) && touchPoints > 1)
      || /iPad|iPhone|iPod/i.test(platform);
  }, []);

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
  const [selectedParagraphIndex, setSelectedParagraphIndex] = useState<number | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [critique, setCritique] = useState<z.infer<typeof CritiqueResponseSchema> | null>(null);
  const [coverageFilter, setCoverageFilter] = useState<"all" | "covered" | "not-covered">("all");
  const [mobileExcerptLimit, setMobileExcerptLimit] = useState(80);
  const historyRef = useRef<Record<string, HistoryEntry>>({});

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

  const ensureHistoryEntry = (key: string, currentBody: string): HistoryEntry => {
    const existing = historyRef.current[key];
    if (!existing) {
      const created: HistoryEntry = { past: [], present: currentBody, future: [] };
      historyRef.current[key] = created;
      return created;
    }
    return existing;
  };

  useEffect(() => {
    if (!active || !activeKey) return;
    const body = active.section.body ?? "";
    const entry = ensureHistoryEntry(activeKey, body);
    if (entry.present !== body) {
      entry.present = body;
      setHistoryVersion((v) => v + 1);
    }
  }, [active, activeKey]);

  const visibleExcerptIndexes = useMemo(() => {
    if (!active) return [] as number[];
    return active.assignment.transcriptExcerpts.map((_, index) => index);
  }, [active]);

  const excerptUsedByIndex = useMemo(() => {
    if (!active) return [] as boolean[];
    const body = active.section.body ?? "";
    if (!body.trim()) return active.assignment.transcriptExcerpts.map(() => false);
    // Use n-gram overlap rather than exact string match. The LLM always
    // paraphrases so verbatim matching returns 0 covered every time.
    const bgrams = bodyNgrams(body);
    return active.assignment.transcriptExcerpts.map((excerpt) =>
      excerpt.trim() ? excerptCoveredInBody(excerpt, bgrams) : false
    );
  }, [active]);

  // Coverage counts — used for the summary and filter button labels
  const coveredCount = useMemo(
    () => excerptUsedByIndex.filter(Boolean).length,
    [excerptUsedByIndex]
  );
  const notCoveredCount = useMemo(
    () => excerptUsedByIndex.filter((v) => !v).length,
    [excerptUsedByIndex]
  );

  const filteredExcerptIndexes = useMemo(() => {
    if (coverageFilter === "covered") return visibleExcerptIndexes.filter((index) => excerptUsedByIndex[index]);
    if (coverageFilter === "not-covered") return visibleExcerptIndexes.filter((index) => !excerptUsedByIndex[index]);
    return visibleExcerptIndexes; // "all" — always show every excerpt
  }, [excerptUsedByIndex, coverageFilter, visibleExcerptIndexes]);

  const renderedExcerptIndexes = useMemo(() => {
    if (!isLikelyIOS) return filteredExcerptIndexes;
    return filteredExcerptIndexes.slice(0, mobileExcerptLimit);
  }, [filteredExcerptIndexes, isLikelyIOS, mobileExcerptLimit]);

  const transcriptPreviewByExcerpt = useMemo(() => {
    if (!active) return [] as Array<string | null>;
    return active.assignment.transcriptExcerpts.map((excerpt) => {
      const normalizedExcerpt = normalizeForExactMatch(excerpt);
      if (!normalizedExcerpt) return null;
      const hit = transcriptEntries.find((entry) =>
        normalizeForExactMatch(entry.text).includes(normalizedExcerpt)
      );
      return hit?.label ?? null;
    });
  }, [active, transcriptEntries]);

  const transcriptPreview = useMemo(() => {
    if (activeExcerptNumber === null) return null;
    const excerptIndex = activeExcerptNumber - 1;
    const label = transcriptPreviewByExcerpt[excerptIndex];
    if (!label) return null;
    return { label };
  }, [activeExcerptNumber, transcriptPreviewByExcerpt]);

  const activeHistory = useMemo(() => {
    if (!active || !activeKey) return null;
    return ensureHistoryEntry(activeKey, active.section.body ?? "");
  }, [active, activeKey, historyVersion]);

  const canUndo = Boolean(activeHistory && activeHistory.past.length > 0);
  const canRedo = Boolean(activeHistory && activeHistory.future.length > 0);

  const commitBodyChange = (nextBody: string, pushHistory = true) => {
    if (!active || !activeKey) return;
    const entry = ensureHistoryEntry(activeKey, active.section.body ?? "");
    if (entry.present === nextBody) return;
    if (pushHistory) {
      entry.past.push(entry.present);
      if (entry.past.length > 120) entry.past.shift();
      entry.future = [];
    }
    entry.present = nextBody;
    onSectionBodyChange(active.chapter.number, active.section.sectionNumber, nextBody);
    setHistoryVersion((v) => v + 1);
  };

  const handleUndo = () => {
    if (!active || !activeKey) return;
    const entry = ensureHistoryEntry(activeKey, active.section.body ?? "");
    const previous = entry.past.pop();
    if (typeof previous !== "string") return;
    entry.future.push(entry.present);
    entry.present = previous;
    onSectionBodyChange(active.chapter.number, active.section.sectionNumber, previous);
    setHistoryVersion((v) => v + 1);
  };

  const handleRedo = () => {
    if (!active || !activeKey) return;
    const entry = ensureHistoryEntry(activeKey, active.section.body ?? "");
    const next = entry.future.pop();
    if (typeof next !== "string") return;
    entry.past.push(entry.present);
    entry.present = next;
    onSectionBodyChange(active.chapter.number, active.section.sectionNumber, next);
    setHistoryVersion((v) => v + 1);
  };

  const applyAssistant = async (mode: "rewriteSection" | "refineParagraph" | "critiqueSection") => {
    if (!active) return;
    if (mode === "refineParagraph" && selectedParagraphIndex === null) {
      setRewriteError("Select a paragraph first before refining.");
      return;
    }

    setRewriteBusy(true);
    setRewriteError(null);
    if (mode !== "critiqueSection") setCritique(null);

    try {
      const response = await fetch("/api/ebook/rewrite-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          assignment: active.assignment,
          currentBody: active.section.body ?? "",
          instruction: rewriteInstruction,
          includeExcerptNumbers: Array.from(selectedExcerptNumbers),
          paragraphIndex: selectedParagraphIndex,
          authorConfig,
        }),
      });
      const raw = await response.json();
      if (!response.ok) {
        throw new Error(typeof raw?.error === "string" ? raw.error : "Rewrite failed");
      }

      if (mode === "critiqueSection") {
        const parsedCritique = CritiqueResponseSchema.parse(raw);
        setCritique(parsedCritique);
        return;
      }

      const parsed = RewriteResponseSchema.parse(raw);
      if (!parsed.body.trim()) {
        throw new Error("Rewrite returned empty text");
      }
      commitBodyChange(parsed.body.trim(), true);
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
            setSelectedParagraphIndex(null);
            setRewriteError(null);
            setCritique(null);
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
            {selectedExcerptNumbers.size} selected for rewrite •{" "}
            <span className="text-emerald-400">{coveredCount} covered</span>
            {" / "}
            <span className={notCoveredCount > 0 ? "text-amber-400" : "text-slate-400"}>{notCoveredCount} not in prose</span>
            {" / "}
            {active.assignment.transcriptExcerpts.length} total
          </p>
        )}
        {active && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleUndo}
              disabled={!canUndo}
              className="min-h-[48px] rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 text-sm font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={!canRedo}
              className="min-h-[48px] rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 text-sm font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Redo
            </button>
          </div>
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
            <div className="mb-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-widest text-violet-300">Transcript Source</p>
                {transcriptPreview && (
                  <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-1 text-[10px] font-semibold text-violet-200">
                    {transcriptPreview.label}
                  </span>
                )}
              </div>
              {/* 3-way coverage filter — always shows the full excerpt set, just narrows the view */}
              <div className="flex gap-1.5">
                {(["all", "covered", "not-covered"] as const).map((f) => {
                  const label =
                    f === "all"
                      ? `All (${active.assignment.transcriptExcerpts.length})`
                      : f === "covered"
                      ? `Covered (${coveredCount})`
                      : `Not in prose (${notCoveredCount})`;
                  const activeStyle =
                    f === "all"
                      ? "border-violet-400/50 bg-violet-500/15 text-violet-200"
                      : f === "covered"
                      ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-200"
                      : "border-amber-400/50 bg-amber-500/15 text-amber-200";
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setCoverageFilter(f)}
                      className={[
                        "min-h-[36px] flex-1 rounded-lg border px-2 text-[10px] font-semibold uppercase tracking-wide transition-colors",
                        coverageFilter === f
                          ? activeStyle
                          : "border-slate-700/60 bg-slate-900/60 text-slate-400 hover:text-slate-200",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="max-h-[48dvh] space-y-2 overflow-y-auto pr-1 lg:max-h-[70dvh]">
              {renderedExcerptIndexes.map((index) => {
                const excerpt = active.assignment.transcriptExcerpts[index];
                const number = index + 1;
                const isSelected = selectedExcerptNumbers.has(number);
                const isActive = activeExcerptNumber === number;
                const exactSlotLabel = transcriptPreviewByExcerpt[index];
                return (
                  <div
                    key={number}
                    className={[
                      "rounded-xl border px-3 py-3",
                      isActive
                        ? "border-cyan-400/50 bg-cyan-500/10"
                        : excerptUsedByIndex[index]
                        ? "border-emerald-700/40 bg-emerald-950/30"
                        : "border-amber-700/30 bg-amber-950/20",
                    ].join(" ")}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveExcerptNumber(number)}
                        className="min-h-[40px] rounded-lg border border-slate-600/60 px-2.5 text-xs font-semibold text-slate-200"
                      >
                        #{number}
                      </button>

                      {/* Usage status — the primary signal the user asked for */}
                      {excerptUsedByIndex[index] ? (
                        <span className="rounded-md bg-emerald-500/20 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-300">
                          ✓ Covered in prose
                        </span>
                      ) : (
                        <span className="rounded-md bg-amber-500/20 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-300">
                          ○ Not in prose
                        </span>
                      )}

                      {exactSlotLabel ? (
                        <span className="rounded-md bg-slate-700/60 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                          {exactSlotLabel}
                        </span>
                      ) : null}

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
                          "min-h-[40px] rounded-lg border px-2.5 text-xs font-semibold",
                          isSelected
                            ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-200"
                            : "border-slate-600/60 text-slate-400 hover:text-slate-200",
                        ].join(" ")}
                      >
                        {isSelected ? "Will include" : "Include in rewrite"}
                      </button>
                    </div>
                    <p className="text-sm leading-relaxed text-slate-300">{excerpt}</p>
                  </div>
                );
              })}
              {renderedExcerptIndexes.length === 0 && (
                <p className="rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-sm text-slate-400">
                  {coverageFilter === "not-covered" ? "All excerpts are covered in prose for this section." : coverageFilter === "covered" ? "No excerpts found in prose yet — run the write step first." : "No excerpts available for this section."}
                </p>
              )}
              {isLikelyIOS && renderedExcerptIndexes.length < filteredExcerptIndexes.length && (
                <button
                  type="button"
                  onClick={() => setMobileExcerptLimit((v) => v + 80)}
                  className="min-h-[48px] w-full rounded-xl border border-slate-600/60 bg-slate-900/70 px-3 py-2 text-sm font-semibold text-slate-200"
                >
                  Load more excerpts ({renderedExcerptIndexes.length}/{filteredExcerptIndexes.length})
                </button>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-cyan-500/20 bg-slate-900/50 p-3">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-cyan-300">LLM Written Section</p>

            <div className="mb-3 max-h-[30dvh] space-y-2 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-950/70 p-3 lg:max-h-[24dvh]">
              {splitParagraphs(active.section.body ?? "").map((paragraph, index) => {
                const isSelectedParagraph = selectedParagraphIndex === index;
                return (
                  <button
                    type="button"
                    key={`${index}`}
                    onClick={() => {
                      setSelectedParagraphIndex(index);
                    }}
                    className={[
                      "w-full rounded-lg border p-2 text-left",
                      "min-h-[48px]",
                      isSelectedParagraph
                        ? "border-violet-400/50 bg-violet-500/10"
                        : "border-slate-700/60 bg-slate-900/60",
                    ].join(" ")}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Paragraph {index + 1}</span>
                    </div>
                    <p className="line-clamp-3 text-sm leading-relaxed text-slate-300">{paragraph}</p>
                  </button>
                );
              })}
            </div>

            <ProseEditor
              label="Edit section text"
              value={active.section.body ?? ""}
              onChange={(next) => commitBodyChange(next, true)}
              rows={14}
              placeholder="Edit this section..."
            />

            <div className="mt-3 space-y-2 rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500">Editorial assistant instruction</label>
              <textarea
                value={rewriteInstruction}
                onChange={(e) => setRewriteInstruction(e.target.value)}
                rows={4}
                placeholder="Ask for critique, refinement, flow fixes, or scope corrections."
                className="w-full rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
              />
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                <button
                  type="button"
                  disabled={rewriteBusy}
                  onClick={() => void applyAssistant("critiqueSection")}
                  className="min-h-[48px] rounded-xl border border-violet-400/40 bg-violet-500/15 px-3 py-2 text-sm font-semibold text-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {rewriteBusy ? "Working..." : "Critique Section"}
                </button>
                <button
                  type="button"
                  disabled={rewriteBusy || selectedParagraphIndex === null}
                  onClick={() => void applyAssistant("refineParagraph")}
                  className="min-h-[48px] rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-3 py-2 text-sm font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {rewriteBusy
                    ? "Working..."
                    : selectedParagraphIndex === null
                    ? "Select paragraph to refine"
                    : `Refine Paragraph ${selectedParagraphIndex + 1}`}
                </button>
                <button
                  type="button"
                  disabled={rewriteBusy}
                  onClick={() => void applyAssistant("rewriteSection")}
                  className="min-h-[48px] rounded-xl bg-gradient-to-r from-cyan-500 to-violet-500 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {rewriteBusy
                    ? "Working..."
                    : `Rewrite Section${selectedExcerptNumbers.size > 0 ? ` (include ${selectedExcerptNumbers.size} unused)` : ""}`}
                </button>
              </div>

              {critique && (
                <div className="rounded-xl border border-violet-500/25 bg-violet-500/8 p-3">
                  <p className="text-xs font-semibold uppercase tracking-widest text-violet-200">Editorial Critique</p>
                  {critique.summary && <p className="mt-2 text-sm text-slate-200">{critique.summary}</p>}
                  {critique.strengths.length > 0 && (
                    <div className="mt-2">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-300">Strengths</p>
                      <ul className="mt-1 space-y-1 text-xs text-slate-300">
                        {critique.strengths.map((item, index) => <li key={`str-${index}`}>• {item}</li>)}
                      </ul>
                    </div>
                  )}
                  {critique.issues.length > 0 && (
                    <div className="mt-2">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-amber-300">Issues</p>
                      <ul className="mt-1 space-y-1 text-xs text-slate-300">
                        {critique.issues.map((item, index) => <li key={`iss-${index}`}>• {item}</li>)}
                      </ul>
                    </div>
                  )}
                  {critique.actions.length > 0 && (
                    <div className="mt-2">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-cyan-300">Recommended edits</p>
                      <ul className="mt-1 space-y-1 text-xs text-slate-300">
                        {critique.actions.map((item, index) => <li key={`act-${index}`}>• {item}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {rewriteError && <p className="text-xs text-red-300">{rewriteError}</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
