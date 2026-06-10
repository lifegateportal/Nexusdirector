"use client";

/**
 * VoiceStudio — XTTS v2 audiobook narration panel.
 *
 * Shown inside EbookPipeline when stage === "complete".
 * Lets the author:
 *   1. Upload a 30s–3min voice sample
 *   2. Upload the sample to R2, clone it via RunPod
 *   3. Narrate any or all chapters — each chapter queues independently
 *   4. Play back finished chapters inline with a native <audio> element
 *
 * Narration state persists to localStorage under the key STORAGE_KEY so the
 * user can close the tab and come back to their audiobook.
 */

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { EbookManifest, ChapterDraft } from "@/lib/schemas/ebook";

// ── Types ─────────────────────────────────────────────────────────────────────

type NarrateStatus = "idle" | "queued" | "synthesizing" | "done" | "error";
type ProgressPhase = "queued" | "synthesizing" | "finalizing";

interface ChapterNarration {
  chapterId: string;
  title: string;
  status: NarrateStatus;
  phase: ProgressPhase | null;
  progressPct: number;
  audioUrl: string | null;
  durationSec: number | null;
  error: string | null;
}

interface VoiceStudioState {
  voiceId: string | null;   // R2 URL of the cleaned WAV sample
  voiceDurationSec: number | null;
  chapters: ChapterNarration[];
}

interface NarrationTarget {
  chapterId: string;
  title: string;
  text: string;
}

// ── Storage key ───────────────────────────────────────────────────────────────

const STORAGE_KEY_PREFIX = "nexus_voice_studio_";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChapterId(ch: ChapterDraft): string {
  return `ch-${ch.number}`;
}

function makeIntroductionId(): string {
  return "fm-introduction";
}

function makeConclusionId(): string {
  return "fm-conclusion";
}

function makePrefaceId(): string {
  return "fm-preface";
}

function makeAboutAuthorId(): string {
  return "fm-about-author";
}

function initChapterNarrations(targets: NarrationTarget[]): ChapterNarration[] {
  return targets.map((target) => ({
    chapterId: target.chapterId,
    title: target.title,
    status: "idle",
    phase: null,
    progressPct: 0,
    audioUrl: null,
    durationSec: null,
    error: null,
  }));
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function buildChapterText(ch: ChapterDraft): string {
  const parts: string[] = [];

  // Lead with chapter heading so generated narration always opens with chapter context.
  if (ch.number || ch.title) {
    const chapterHeading = [
      ch.number ? `Chapter ${ch.number}` : "",
      ch.title?.trim() ? `: ${ch.title.trim()}` : "",
    ].join("");
    if (chapterHeading.trim()) parts.push(chapterHeading.trim());
  }

  // Read the key scripture/epigraph before the intro so the opening matches reader flow.
  if (ch.epigraph?.trim()) {
    parts.push("Key Scripture");
    parts.push(ch.epigraph.trim());
  }

  if (ch.intro?.trim()) {
    parts.push(ch.intro.trim());
  }

  for (const section of ch.sections) {
    if (section.heading?.trim()) parts.push(section.heading.trim());
    if (section.body?.trim()) parts.push(section.body.trim());
  }

  if (ch.forwardQuestion?.trim()) {
    parts.push("Forward Question");
    parts.push(ch.forwardQuestion.trim());
  }

  if (ch.keyTakeaways.length > 0) {
    parts.push("Key Takeaways");
    parts.push(ch.keyTakeaways.join(". "));
  }

  if (ch.reflectionQuestions.length > 0) {
    parts.push("Reflection Questions");
    parts.push(
      ch.reflectionQuestions
        .map((question, idx) => `${idx + 1}. ${question}`)
        .join(" "),
    );
  }

  return parts.join("\n\n");
}

function buildNarrationTargets(manifest: EbookManifest): NarrationTarget[] {
  const targets: NarrationTarget[] = [];
  const preface = manifest.frontMatter.preface?.trim();
  const intro = manifest.frontMatter.introduction?.trim();
  const conclusion = manifest.frontMatter.conclusion?.trim();
  const aboutAuthor = manifest.frontMatter.aboutAuthor?.trim();

  if (preface) {
    targets.push({
      chapterId: makePrefaceId(),
      title: "Book Preface",
      text: ["Preface", preface].join("\n\n"),
    });
  }

  if (intro) {
    targets.push({
      chapterId: makeIntroductionId(),
      title: "Book Introduction",
      text: ["Introduction", intro].join("\n\n"),
    });
  }

  for (const ch of manifest.chapters) {
    targets.push({
      chapterId: makeChapterId(ch),
      title: ch.title || `Chapter ${ch.number}`,
      text: buildChapterText(ch),
    });
  }

  if (conclusion) {
    targets.push({
      chapterId: makeConclusionId(),
      title: "Book Conclusion",
      text: ["Conclusion", conclusion].join("\n\n"),
    });
  }

  if (aboutAuthor) {
    targets.push({
      chapterId: makeAboutAuthorId(),
      title: "About the Author",
      text: ["About the Author", aboutAuthor].join("\n\n"),
    });
  }

  return targets;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function inferExtFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const fileName = pathname.split("/").pop() ?? "";
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "wav";
    return ext.replace(/[^a-z0-9]/g, "") || "wav";
  } catch {
    return "wav";
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isNetworkFetchError(message: string): boolean {
  return /fetch failed|failed to fetch|networkerror|network connection|load failed/i.test(message);
}

function normalizeClientError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : fallback;
  if (isNetworkFetchError(message)) {
    return "Network connection interrupted while contacting the voice API. Please retry.";
  }
  return message || fallback;
}

async function postJsonWithRetry<T>(
  url: string,
  body: Record<string, unknown>,
  retries = 2,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const raw = await res.text();
      let parsed: Record<string, unknown> = {};
      if (raw) {
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = { error: raw.slice(0, 300) };
        }
      }

      if (!res.ok) {
        const message = typeof parsed.error === "string"
          ? parsed.error
          : `${url} failed (${res.status})`;
        const retryable = res.status >= 500 || res.status === 429;
        if (retryable && attempt < retries) {
          await delay(400 * (attempt + 1));
          continue;
        }
        throw new Error(message);
      }

      return parsed as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      const retryable = isNetworkFetchError(message);
      if (retryable && attempt < retries) {
        await delay(400 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  throw new Error("Request failed after retries");
}

// ── Component ─────────────────────────────────────────────────────────────────

interface VoiceStudioProps {
  manifest: EbookManifest;
  slug?: string; // used as a folder name in R2 — defaults to jobId
}

export function VoiceStudio({ manifest, slug }: VoiceStudioProps) {
  const bookSlug = slug ?? manifest.jobId;
  const storageKey = `${STORAGE_KEY_PREFIX}${bookSlug}`;
  const narrationTargets = useMemo(() => buildNarrationTargets(manifest), [manifest]);

  // ── State ──────────────────────────────────────────────────────────────────

  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [voiceDurationSec, setVoiceDurationSec] = useState<number | null>(null);
  const [sampleFile, setSampleFile] = useState<File | null>(null);
  const [sampleUrl, setSampleUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  const [chapters, setChapters] = useState<ChapterNarration[]>(() =>
    initChapterNarrations(narrationTargets)
  );

  const [uploadingR2, setUploadingR2] = useState(false);
  const [language, setLanguage] = useState("en");
  const [speed, setSpeed] = useState(1.0);
  const [narrating, setNarrating] = useState(false);

  const abortRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Persist state to localStorage ─────────────────────────────────────────

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) return;
      const state = JSON.parse(saved) as VoiceStudioState;
      if (state.voiceId)         setVoiceId(state.voiceId);
      if (state.voiceDurationSec) setVoiceDurationSec(state.voiceDurationSec);
      if (state.chapters?.length) {
        // Merge saved narration URLs into current chapter list so new chapters are still shown
        setChapters((prev) =>
          prev.map((ch) => {
            const saved_ch = state.chapters.find((c) => c.chapterId === ch.chapterId);
            if (!saved_ch) return ch;
            const merged = { ...ch, ...saved_ch };
            return {
              ...merged,
              phase: merged.status === "done" || merged.status === "error" ? null : merged.phase ?? null,
              progressPct: merged.status === "done" ? 100 : clampProgress(merged.progressPct ?? 0),
            };
          })
        );
      }
    } catch {
      // Corrupted localStorage — ignore
    }
  }, [storageKey]);

  const persist = useCallback((nextVoiceId: string | null, nextDur: number | null, nextChapters: ChapterNarration[]) => {
    const state: VoiceStudioState = { voiceId: nextVoiceId, voiceDurationSec: nextDur, chapters: nextChapters };
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* storage full */ }
  }, [storageKey]);

  // ── Upload voice sample to R2 via server-side route ──────────────────────
  // Using server-side upload (not presigned PUT) to avoid browser CORS issues.

  async function uploadSampleToR2(file: File): Promise<string> {
    const MAX_MB = 25;
    if (file.size > MAX_MB * 1024 * 1024) {
      throw new Error(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Please trim your recording to under ${MAX_MB} MB.`);
    }
    setUploadingR2(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "wav";
      const formData = new FormData();
      formData.append("file", file);
      formData.append("prefix", "voice-samples");
      formData.append("ext", ext);

      const res = await fetch("/api/r2-upload", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? `Upload failed (${res.status})`);
      }
      const { publicUrl, key } = await res.json() as { publicUrl: string | null; key: string };
      return publicUrl ?? key;
    } finally {
      setUploadingR2(false);
    }
  }

  // ── Clone voice ────────────────────────────────────────────────────────────

  async function handleClone() {
    const trimmedSampleUrl = sampleUrl.trim();
    if (!sampleFile && !trimmedSampleUrl) return;
    setCloning(true);
    setCloneError(null);
    try {
      if (!sampleFile) {
        try {
          const parsed = new URL(trimmedSampleUrl);
          if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
            throw new Error("Voice sample URL must start with http:// or https://");
          }
        } catch (error) {
          throw error instanceof Error ? error : new Error("Enter a valid voice sample URL");
        }
      }

      const cloneSampleUrl = sampleFile ? await uploadSampleToR2(sampleFile) : trimmedSampleUrl;
      const ext = sampleFile
        ? sampleFile.name.split(".").pop()?.toLowerCase() ?? "wav"
        : inferExtFromUrl(trimmedSampleUrl);

      // Submit job — returns immediately
      const submitJson = await postJsonWithRetry<{ runpodJobId?: string; error?: string }>(
        "/api/voice/clone",
        { sampleUrl: cloneSampleUrl, ext },
      );
      if (submitJson.error || !submitJson.runpodJobId) {
        throw new Error(submitJson.error ?? "Clone submit failed");
      }

      // Poll finalize until done
      const runpodJobId = submitJson.runpodJobId!;
      for (let attempt = 0; attempt < 150; attempt++) {
        await new Promise<void>((r) => setTimeout(r, 4000));
        const poll = await postJsonWithRetry<{ status: string; voiceId?: string; durationSec?: number; error?: string }>(
          "/api/voice/clone/finalize",
          { runpodJobId },
        );
        if (poll.status === "COMPLETED") {
          setVoiceId(poll.voiceId!);
          setVoiceDurationSec(poll.durationSec ?? null);
          persist(poll.voiceId!, poll.durationSec ?? null, chapters);
          return;
        }
        if (poll.status === "FAILED") throw new Error(poll.error ?? "Clone failed");
        // IN_QUEUE / IN_PROGRESS — keep polling
      }
      throw new Error("Voice clone timed out after 10 minutes. The GPU worker may still be cold-starting — try again.");
    } catch (err) {
      setCloneError(normalizeClientError(err, "Clone failed"));
    } finally {
      setCloning(false);
    }
  }

  // ── Narrate a single chapter ───────────────────────────────────────────────

  const narrateChapter = useCallback(async (
    target: NarrationTarget,
    currentVoiceId: string,
    currentChapters: ChapterNarration[],
    setChaptersFn: React.Dispatch<React.SetStateAction<ChapterNarration[]>>,
  ): Promise<ChapterNarration[]> => {
    const id = target.chapterId;
    const updateStatus = (partial: Partial<ChapterNarration>, list: ChapterNarration[]): ChapterNarration[] =>
      list.map((c) => (c.chapterId === id ? { ...c, ...partial } : c));

    let updated = updateStatus({ status: "synthesizing", phase: "synthesizing", progressPct: 8, error: null }, currentChapters);
    setChaptersFn(updated);

    try {
      const text = target.text;

      // Submit job — returns immediately
      const submitJson = await postJsonWithRetry<{ runpodJobId?: string; error?: string }>(
        "/api/voice/narrate",
        { text, voiceId: currentVoiceId, chapterId: id, slug: bookSlug, language, speed },
      );
      if (submitJson.error || !submitJson.runpodJobId) {
        throw new Error(submitJson.error ?? "Narrate submit failed");
      }

      // Poll finalize until done
      const runpodJobId = submitJson.runpodJobId!;
      for (let attempt = 0; attempt < 150; attempt++) {
        await new Promise<void>((r) => setTimeout(r, 4000));
        const poll = await postJsonWithRetry<{ status: string; audioUrl?: string; durationSec?: number; error?: string; note?: string }>(
          "/api/voice/narrate/finalize",
          { runpodJobId, chapterId: id, slug: bookSlug },
        );
        if (poll.status === "COMPLETED") {
          updated = updateStatus({ status: "done", phase: null, progressPct: 100, audioUrl: poll.audioUrl!, durationSec: poll.durationSec ?? null }, updated);
          break;
        }
        if (poll.status === "FAILED") throw new Error(poll.error ?? "Narration failed");

        // Estimated progress while waiting for terminal status from RunPod.
        if (poll.status === "IN_QUEUE") {
          const pct = clampProgress(5 + attempt * 2);
          updated = updateStatus({ status: "queued", phase: "queued", progressPct: Math.min(pct, 25) }, updated);
          setChaptersFn(updated);
          continue;
        }

        if (poll.status === "IN_PROGRESS") {
          const finalizing = attempt >= 35 || /output|finaliz/i.test(poll.note ?? "");
          const pct = finalizing
            ? Math.min(94, clampProgress(86 + (attempt - 35) * 1.5))
            : Math.min(88, clampProgress(25 + attempt * 2.25));
          updated = updateStatus({
            status: "synthesizing",
            phase: finalizing ? "finalizing" : "synthesizing",
            progressPct: pct,
          }, updated);
          setChaptersFn(updated);
          continue;
        }

        // Unknown intermediary status — keep user feedback moving.
        const pct = clampProgress(20 + attempt * 2.5);
        const finalizing = attempt >= 35;
        updated = updateStatus({
          status: "synthesizing",
          phase: finalizing ? "finalizing" : "synthesizing",
          progressPct: finalizing ? Math.min(94, Math.max(pct, 88)) : Math.min(pct, 88),
        }, updated);
        setChaptersFn(updated);

        // IN_QUEUE / IN_PROGRESS — keep polling
        if (attempt === 149) throw new Error("Narration timed out after 10 minutes");
      }
    } catch (err) {
      updated = updateStatus({ status: "error", phase: null, progressPct: 0, error: normalizeClientError(err, "Narration failed") }, updated);
    }

    setChaptersFn(updated);
    return updated;
  }, [bookSlug, language, speed]);

  // ── Narrate all pending chapters sequentially ─────────────────────────────

  async function handleNarrateAll() {
    if (!voiceId) return;
    abortRef.current = false;
    setNarrating(true);

    // Queue all non-done chapters
    let currentChapters = chapters.map((c) =>
      c.status === "done" ? c : { ...c, status: "queued" as NarrateStatus, phase: "queued" as ProgressPhase, progressPct: 5 }
    );
    setChapters(currentChapters);

    try {
      for (const target of narrationTargets) {
        if (abortRef.current) break;
        const chNarration = currentChapters.find((c) => c.chapterId === target.chapterId);
        if (chNarration?.status === "done") continue;

        currentChapters = await narrateChapter(target, voiceId, currentChapters, setChapters);
        persist(voiceId, voiceDurationSec, currentChapters);
      }
    } finally {
      setNarrating(false);
      abortRef.current = false;
    }
  }

  // ── Narrate single chapter ────────────────────────────────────────────────

  async function handleNarrateOne(target: NarrationTarget) {
    if (!voiceId) return;
    const updated = await narrateChapter(target, voiceId, chapters, setChapters);
    persist(voiceId, voiceDurationSec, updated);
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  const doneCount = chapters.filter((c) => c.status === "done").length;
  const hasAnyDone = doneCount > 0;
  const hasVoice = Boolean(voiceId);

  return (
    <div className="rounded-2xl border border-purple-500/15 bg-slate-900/60 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-purple-500/10">
        <div>
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 text-purple-400">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h3 className="text-sm font-semibold text-purple-300 uppercase tracking-widest">Voice Studio</h3>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">Clone your voice and narrate the full audiobook.</p>
        </div>
        {hasVoice && (
          <div className="flex items-center gap-1.5 rounded-lg border border-emerald-400/20 bg-emerald-400/8 px-2.5 py-1">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] font-semibold text-emerald-300">
              Voice cloned{voiceDurationSec ? ` · ${formatDuration(voiceDurationSec)} sample` : ""}
            </span>
          </div>
        )}
      </div>

      <div className="p-4 space-y-5">
        {/* ── Step 1: Upload voice sample ── */}
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Step 1 — Add Your Voice Sample
          </p>
          <p className="text-xs text-slate-400">
            Record yourself reading 30 seconds to 3 minutes of clean, unedited speech in your natural voice.
            No music, minimal background noise. WAV, MP3, M4A, FLAC, or MOV/MP4 (audio track is extracted). Max 25 MB.
          </p>
          <div className="space-y-2 rounded-xl border border-slate-700/60 bg-slate-950/40 p-3">
            <label htmlFor="voice-sample-url" className="block text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Already have a hosted sample?
            </label>
            <input
              id="voice-sample-url"
              type="url"
              inputMode="url"
              placeholder="Paste a public or R2 sample URL"
              value={sampleUrl}
              onChange={(e) => {
                setSampleUrl(e.target.value);
                if (e.target.value) setSampleFile(null);
                setCloneError(null);
              }}
              disabled={cloning || narrating || uploadingR2}
              className="min-h-[48px] w-full rounded-xl border border-slate-600 bg-slate-900 px-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-purple-500 focus:outline-none disabled:opacity-50"
            />
            <p className="text-xs text-slate-500">
              Paste an existing WAV, MP3, M4A, FLAC, MOV, or MP4 URL to skip the upload step.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/*,.mp3,.wav,.m4a,.flac,.aac,.ogg,.mov,.mp4"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setSampleFile(f);
                if (f) setSampleUrl("");
                setCloneError(null);
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={cloning || narrating}
              className="min-h-[48px] flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-800 px-4 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50 transition"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {sampleFile ? sampleFile.name : "Choose audio file"}
            </button>

            <button
              type="button"
              onClick={() => void handleClone()}
              disabled={(!sampleFile && !sampleUrl.trim()) || cloning || uploadingR2 || narrating}
              className={[
                "min-h-[48px] rounded-xl px-5 text-sm font-semibold transition-all active:scale-[0.98]",
                (sampleFile || sampleUrl.trim()) && !cloning
                  ? "bg-gradient-to-r from-purple-500 to-violet-500 text-white hover:opacity-90"
                  : "bg-slate-700/50 text-slate-500 cursor-not-allowed",
              ].join(" ")}
            >
              {uploadingR2 ? "Uploading…" : cloning ? "Cloning voice…" : hasVoice ? "Re-clone voice" : "Clone Voice"}
            </button>
          </div>
          {cloneError && (
            <p className="text-xs text-red-400 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2">{cloneError}</p>
          )}
        </div>

        {/* ── Step 2: Narration settings ── */}
        {hasVoice && (
          <div className="space-y-3 border-t border-slate-700/40 pt-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Step 2 — Narration Settings</p>

            <div className="flex flex-wrap gap-4">
              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">Language</label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  disabled={narrating}
                  className="min-h-[48px] rounded-xl border border-slate-600 bg-slate-800 px-3 text-sm text-slate-200 focus:border-purple-500 focus:outline-none disabled:opacity-50"
                >
                  <option value="en">English</option>
                  <option value="es">Spanish</option>
                  <option value="fr">French</option>
                  <option value="de">German</option>
                  <option value="pt">Portuguese</option>
                  <option value="it">Italian</option>
                  <option value="nl">Dutch</option>
                  <option value="pl">Polish</option>
                  <option value="tr">Turkish</option>
                  <option value="ru">Russian</option>
                  <option value="zh-cn">Chinese (Simplified)</option>
                  <option value="ja">Japanese</option>
                  <option value="ko">Korean</option>
                  <option value="ar">Arabic</option>
                  <option value="cs">Czech</option>
                  <option value="hu">Hungarian</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  Speed — {speed.toFixed(1)}x
                </label>
                <input
                  type="range"
                  min={0.5}
                  max={1.5}
                  step={0.05}
                  value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  disabled={narrating}
                  className="mt-3 w-36 accent-purple-500 disabled:opacity-50"
                />
              </div>
            </div>

            {/* Narrate all button */}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleNarrateAll()}
                disabled={narrating}
                className={[
                  "min-h-[48px] rounded-xl px-5 text-sm font-semibold transition-all active:scale-[0.98]",
                  !narrating
                    ? "bg-gradient-to-r from-purple-500 to-violet-500 text-white hover:opacity-90"
                    : "bg-slate-700/50 text-slate-500 cursor-not-allowed",
                ].join(" ")}
              >
                {narrating
                  ? `Narrating… (${doneCount}/${chapters.length})`
                  : hasAnyDone
                  ? `Re-narrate Missing (${chapters.length - doneCount} remaining)`
                  : `Narrate All ${chapters.length} Chapters`}
              </button>
              {narrating && (
                <button
                  type="button"
                  onClick={() => { abortRef.current = true; }}
                  className="min-h-[48px] rounded-xl border border-red-400/30 bg-red-400/8 px-4 text-sm font-semibold text-red-300 hover:bg-red-400/15 transition"
                >
                  Stop
                </button>
              )}
              {hasAnyDone && (
                <span className="text-xs text-slate-500">{doneCount} of {chapters.length} chapters narrated</span>
              )}
            </div>
          </div>
        )}

        {/* ── Chapter list ── */}
        {hasVoice && chapters.length > 0 && (
          <div className="border-t border-slate-700/40 pt-4 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Chapters</p>
            {chapters.map((narr, i) => {
              const target = narrationTargets.find((t) => t.chapterId === narr.chapterId);
              return (
                <div
                  key={narr.chapterId}
                  className="rounded-xl border border-slate-700/40 bg-slate-950/50 p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusDot status={narr.status} />
                      <span className="text-sm font-medium text-slate-200 truncate">{narr.title}</span>
                      {narr.durationSec && (
                        <span className="text-[10px] text-slate-500 tabular-nums shrink-0">{formatDuration(narr.durationSec)}</span>
                      )}
                    </div>
                    {narr.status !== "synthesizing" && narr.status !== "queued" && (
                      <button
                        type="button"
                        onClick={() => target && void handleNarrateOne(target)}
                        disabled={narrating || !target}
                        className="min-h-[44px] min-w-[44px] flex shrink-0 items-center justify-center rounded-xl border border-purple-500/20 bg-purple-500/8 text-xs text-purple-300 hover:bg-purple-500/15 disabled:opacity-40 transition"
                        title={narr.status === "done" ? "Re-narrate" : "Narrate"}
                      >
                        {narr.status === "done" ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                            <path d="M1 4v6h6M23 20v-6h-6" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Error message */}
                  {narr.error && (
                    <p className="text-[11px] text-red-400 px-1">{narr.error}</p>
                  )}

                  {/* Audio player */}
                  {narr.audioUrl && narr.status === "done" && (
                    <audio
                      src={narr.audioUrl}
                      controls
                      controlsList="nodownload"
                      className="w-full h-10 rounded-lg"
                      style={{ colorScheme: "dark" }}
                    />
                  )}

                  {/* Progress indicator */}
                  {(narr.status === "synthesizing" || narr.status === "queued") && (
                    <div className="flex items-center gap-2 px-1">
                      <div className="h-1.5 flex-1 rounded-full bg-slate-700 overflow-hidden">
                        {narr.phase === "finalizing" ? (
                          <div className="relative h-full w-full overflow-hidden rounded-full bg-slate-800">
                            <div className="absolute inset-0 bg-gradient-to-r from-purple-500/20 via-purple-400/65 to-fuchsia-400/20 animate-pulse" />
                            <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-purple-400/85 animate-[pulse_1.4s_ease-in-out_infinite]" />
                          </div>
                        ) : (
                          <div
                            className={[
                              "h-full rounded-full transition-all duration-500",
                              narr.status === "synthesizing" ? "bg-purple-500" : "bg-slate-600",
                            ].join(" ")}
                            style={{ width: `${clampProgress(narr.progressPct)}%` }}
                          />
                        )}
                      </div>
                      <span className="text-[10px] text-slate-500 shrink-0 tabular-nums">
                        {narr.phase === "finalizing"
                          ? "Finalizing output…"
                          : narr.status === "synthesizing"
                            ? "Synthesizing"
                            : "Queued"}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Download all ── */}
        {hasAnyDone && (
          <div className="border-t border-slate-700/40 pt-3">
            <p className="text-[10px] text-slate-500">
              Audio files are stored in your Cloudflare R2 bucket under{" "}
              <code className="text-purple-300/80">audio/books/{bookSlug}/</code>.
              You can link to them directly or download via the R2 dashboard.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Status dot ─────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: NarrateStatus }) {
  const cls = {
    idle:        "bg-slate-600",
    queued:      "bg-yellow-500",
    synthesizing:"bg-purple-400 animate-pulse",
    done:        "bg-emerald-400",
    error:       "bg-red-400",
  }[status];
  return <span className={`shrink-0 h-2 w-2 rounded-full ${cls}`} />;
}
