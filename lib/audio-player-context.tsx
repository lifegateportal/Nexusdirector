"use client";

/**
 * Global Audio Player Context — production audio engine
 *
 * Bug fixes in this revision:
 * A. Generation counter (genRef) — every speakSegment call captures the current
 *    generation.  cancel() increments it, which immediately invalidates every
 *    pending setTimeout / onend / onerror callback.  This is the root cause of
 *    sentence repeats: the stall watchdog and the inter-sentence timer could both
 *    call speakSegment(idx) for the same idx.
 * B. pendingRef — true while we are inside a pauseBeforeMs timeout or the tiny
 *    inter-sentence gap.  The stall watchdog skips its restart check while
 *    pendingRef is true, eliminating the 600 ms chapter-title double-start.
 * C. Silent HTMLAudioElement for iOS lock screen — iOS Safari ignores
 *    AudioContext nodes for MediaSession; only a real looping <audio> element
 *    activates the lock screen / notification-shade transport controls.
 *    We build a 1-second 4 kHz WAV in a Blob URL at runtime (no inline base64
 *    blobs, no network request).  It plays at near-zero volume alongside TTS.
 * D. AudioContext keep-alive still present for Chrome background-tab suppression.
 * E. Chrome 15 s stall watchdog with pendingRef guard.
 * F. Page-visibility recovery.
 * G. Voice polling retry for Firefox / slow Android.
 * H. Network-error back-off (1.2 s) before advancing past a failed segment.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SegmentType = "chapter-title" | "heading" | "quote" | "body" | "emphasis";
export type AudioState  = "idle" | "playing" | "paused";

export interface Segment {
  type:    SegmentType;
  text:    string;
  paraKey: string;
}

export interface AudioChapterMeta {
  /** Unique key — change triggers a full reset.  e.g. "ch-3" or slug+chNum. */
  chapterKey: string;
  title:      string;
  number:     number;
  bookTitle:  string;
  /** Absolute pathname back to the reader page, e.g. /library/my-book/read */
  readerHref: string;
}

// ── Voice treatment ───────────────────────────────────────────────────────────

export const RATES = [0.75, 1.0, 1.25, 1.5, 2.0] as const;

// ── Narrator personas ─────────────────────────────────────────────────────────
// Each persona applies a global rate multiplier, pitch offset, and pause scale
// on top of per-segment VOICE_TREATMENT values.  Stored in localStorage by
// AudioReader so the choice persists across sessions.

export const NARRATOR_PERSONAS = [
  { name: "Balanced",    short: "BAL",  rateMultiplier: 1.00, pitchOffset:  0.00, pauseMultiplier: 1.00 },
  { name: "Storyteller", short: "STRY", rateMultiplier: 0.88, pitchOffset: -0.04, pauseMultiplier: 1.35 },
  { name: "Preacher",    short: "PRE",  rateMultiplier: 0.82, pitchOffset:  0.00, pauseMultiplier: 1.60 },
  { name: "Podcast",     short: "POD",  rateMultiplier: 1.12, pitchOffset:  0.06, pauseMultiplier: 0.80 },
] as const;

const VOICE_TREATMENT: Record<
  SegmentType,
  { pitch: number; rate: number; volume: number; pauseBeforeMs: number; pauseAfterMs: number }
> = {
  "chapter-title": { pitch: 1.10, rate: 0.78, volume: 1.00, pauseBeforeMs: 500, pauseAfterMs: 580 },
  "heading":       { pitch: 1.06, rate: 0.82, volume: 1.00, pauseBeforeMs:   0, pauseAfterMs: 420 },
  "quote":         { pitch: 0.91, rate: 0.76, volume: 0.92, pauseBeforeMs:   0, pauseAfterMs: 280 },
  "body":          { pitch: 1.00, rate: 1.00, volume: 1.00, pauseBeforeMs:   0, pauseAfterMs: 220 },
  // Emphasis — bold/italic markers detected by parseChapter
  "emphasis":      { pitch: 1.15, rate: 0.90, volume: 1.00, pauseBeforeMs:   0, pauseAfterMs: 220 },
};

// ── Adaptive speed ───────────────────────────────────────────────────────────────
// Returns a rate multiplier 0.72–1.0 for a segment based on linguistic density.
// Applied on top of the user’s chosen speed and the segment voice treatment.
// • Short titles and headings are already slow in VOICE_TREATMENT — no extra factor.
// • Long average word length, many polysyllabic words, expanded scripture verse
//   references, and long sentence word count all add moderate slowdown.

function segComplexity(text: string, type: SegmentType): number {
  if (type === "chapter-title" || type === "heading") return 1.0;
  const words   = text.trim().split(/\s+/);
  const wc      = Math.max(words.length, 1);
  const avgLen  = words.reduce((s, w) => s + w.replace(/[^a-z]/gi, "").length, 0) / wc;
  const polyPct = words.filter((w) => w.replace(/[^a-z]/gi, "").length >= 9).length / wc;
  const hasVerse = /chapter \d+ verse/i.test(text);  // expanded scripture ref

  let factor = 1.0;
  if (avgLen  > 6.5) factor -= 0.06;
  if (avgLen  > 7.5) factor -= 0.07;
  if (polyPct > 0.25) factor -= 0.07;
  if (polyPct > 0.40) factor -= 0.06;
  if (hasVerse)       factor -= 0.06;
  if (wc      > 25)   factor -= 0.05;
  if (wc      > 40)   factor -= 0.05;
  return Math.max(0.72, Math.min(1.0, factor));
}

// ── Voice selection ───────────────────────────────────────────────────────────

export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const preferred = [
    "Samantha (Enhanced)", "Samantha",
    "Karen (Enhanced)",    "Karen",
    "Alex", "Victoria", "Fiona", "Moira", "Daniel",
    "Microsoft Aria Online (Natural)", "Microsoft Aria Online",
    "Microsoft Jenny Online (Natural)", "Microsoft Jenny Online",
    "Microsoft Aria", "Microsoft Jenny",
    "Google US English",
  ];
  for (const name of preferred) {
    const v = voices.find((v) => v.name === name && v.lang.startsWith("en"));
    if (v) return v;
  }
  const online = voices.find((v) => v.name.includes("Online") && v.lang.startsWith("en"));
  if (online) return online;
  return voices.find((v) => v.lang === "en-US" || v.lang === "en_US") ?? voices[0] ?? null;
}

// ── Context shape ─────────────────────────────────────────────────────────────

interface AudioPlayerContextValue {
  state:               AudioState;
  currentSeg:          Segment | null;
  currentWord:         number;
  segIdx:              number;
  segTotal:            number;
  rateIdx:             number;
  personaIdx:          number;
  chapterMeta:         AudioChapterMeta | null;
  setChapter:          (segs: Segment[], meta: AudioChapterMeta, onProgress?: (idx: number, key: string) => void) => void;
  play:                (fromIdx?: number) => void;
  pause:               () => void;
  resume:              () => void;
  stop:                () => void;
  cycleRate:           () => void;
  seekTo:              (idx: number) => void;
  seekToWord:          (idx: number, wordIdx: number) => void;
  setVolumeMultiplier: (v: number) => void;
  setPersona:          (idx: number) => void;
}

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

export function useAudioPlayer(): AudioPlayerContextValue {
  const ctx = useContext(AudioPlayerContext);
  if (!ctx) throw new Error("useAudioPlayer must be used inside AudioPlayerProvider");
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function AudioPlayerProvider({ children }: { children: React.ReactNode }) {
  const [state,       setState]      = useState<AudioState>("idle");
  const [currentSeg,  setCurrentSeg] = useState<Segment | null>(null);
  const [currentWord, setCurrentWord]= useState(-1);
  const [segIdx,      setSegIdx]     = useState(0);
  const [segTotal,    setSegTotal]   = useState(0);
  const [rateIdx,     setRateIdx]    = useState(1);
  const [personaIdx,  setPersonaIdx] = useState(0);
  const [chapterMeta, setChapterMeta]= useState<AudioChapterMeta | null>(null);

  // ── Stable refs ──────────────────────────────────────────────────────────
  const segsRef        = useRef<Segment[]>([]);
  const segIdxRef      = useRef(0);
  const rateIdxRef     = useRef(1);
  const voicesRef      = useRef<SpeechSynthesisVoice[]>([]);
  const stoppedRef     = useRef(true);
  const stateRef       = useRef<AudioState>("idle");
  const onProgressRef  = useRef<((idx: number, key: string) => void) | undefined>(undefined);
  const chapterMetaRef = useRef<AudioChapterMeta | null>(null);

  // ── FIX A: generation counter — invalidates all stale callbacks on cancel ──
  // Increment genRef whenever speechSynthesis.cancel() is called. Every
  // speakSegment(idx, gen) call captures the generation at scheduling time.
  // onend / onerror / pauseBeforeMs timeouts bail out if gen !== genRef.current.
  const genRef         = useRef(0);

  // ── FIX B: pendingRef — true while in a pre-speech delay or inter-sentence gap
  // The stall watchdog skips its restart while this is true.
  const pendingRef     = useRef(false);

  // Indirection pointer so closures always call the latest speakSegment.
  const speakRef       = useRef<(idx: number, gen: number) => void>(() => {});
  const wordOffsetRef  = useRef(0);

  // AudioContext keep-alive (Chrome)
  const audioCtxRef    = useRef<AudioContext | null>(null);
  // Stall watchdog interval
  const watchdogRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── FIX C: silent <audio> element for iOS MediaSession lock screen ────────
  // iOS Safari requires a playing HTMLAudioElement to activate the lock-screen
  // / notification-shade transport controls via the MediaSession API.
  // We create a 1-second 4 kHz mono WAV blob at runtime (no network round-trip,
  // no large inline base64).
  const silentAudioRef    = useRef<HTMLAudioElement | null>(null);
  const silentBlobUrlRef  = useRef<string | null>(null);

  // ── Volume multiplier — used by sleep timer fade-out ──────────────────────
  // Values from 1.0 (full) down to ~0.0 (silent). Applied per utterance.
  const volumeMultiplierRef = useRef(1.0);

  // ── Narrator persona ref — mirrors personaIdx state for closure access ────
  const personaIdxRef    = useRef(0);

  // ── Breath rhythm counter ─────────────────────────────────────────────────
  // Counts consecutive body/emphasis segments. Every 5, adds a 700 ms breath
  // pause so the narration breathes like a real reader.  Resets at headings.
  const breathCounterRef = useRef(0);

  // ── Chapter arrival announcement ─────────────────────────────────────────
  // Set on every chapter change; consumed (cleared) on the first play(0) call.
  const pendingAnnouncementRef = useRef<string | null>(null);

  const ensureSilentAudio = useCallback((): HTMLAudioElement | null => {
    if (typeof window === "undefined") return null;
    if (silentAudioRef.current) return silentAudioRef.current;
    try {
      // 1 second of silence at 4000 Hz, 16-bit PCM, mono
      const rate       = 4000;
      const numSamples = rate; // 1 second
      const buf        = new ArrayBuffer(44 + numSamples * 2);
      const v          = new DataView(buf);
      const w = (o: number, s: string) => {
        for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
      };
      w(0,  "RIFF"); v.setUint32(4, 36 + numSamples * 2, true);
      w(8,  "WAVE"); w(12, "fmt ");
      v.setUint32(16, 16, true);       // chunk size
      v.setUint16(20, 1,  true);       // PCM
      v.setUint16(22, 1,  true);       // mono
      v.setUint32(24, rate, true);     // sample rate
      v.setUint32(28, rate * 2, true); // byte rate
      v.setUint16(32, 2,  true);       // block align
      v.setUint16(34, 16, true);       // bits/sample
      w(36, "data"); v.setUint32(40, numSamples * 2, true);
      // bytes 44…end are all 0 = silence

      const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      silentBlobUrlRef.current = url;
      const audio = new Audio(url);
      audio.loop   = true;
      audio.volume = 0.001; // near-silent, audibly transparent
      silentAudioRef.current = audio;
      return audio;
    } catch { return null; }
  }, []);

  // ── Sync state refs ──────────────────────────────────────────────────────
  useEffect(() => { stateRef.current      = state;        }, [state]);
  useEffect(() => { rateIdxRef.current    = rateIdx;      }, [rateIdx]);
  useEffect(() => { chapterMetaRef.current = chapterMeta; }, [chapterMeta]);

  // ── Voice loading — polling retry ────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const load = () => {
      const v = window.speechSynthesis.getVoices();
      if (v.length > 0) { voicesRef.current = v; return true; }
      return false;
    };
    if (load()) {
      window.speechSynthesis.onvoiceschanged = load;
      return () => { window.speechSynthesis.onvoiceschanged = null; };
    }
    const ids = [100, 500, 1500, 3000, 5000].map((d) =>
      setTimeout(() => { const v = window.speechSynthesis.getVoices(); if (v.length) voicesRef.current = v; }, d),
    );
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      ids.forEach(clearTimeout);
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // ── AudioContext keep-alive (Chrome background-tab suppression) ──────────
  const startAudioCtx = useCallback(() => {
    if (typeof window === "undefined") return;
    // Start silent <audio> for iOS MediaSession
    const silent = ensureSilentAudio();
    if (silent && silent.paused) {
      silent.play().catch(() => { /* blocked before user gesture — ignore */ });
    }
    // AudioContext oscillator for Chrome
    if (audioCtxRef.current) return;
    try {
      type ACtxCtor = typeof AudioContext;
      const Ctor = (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: ACtxCtor }).webkitAudioContext);
      if (!Ctor) return;
      const ctx  = new Ctor();
      const src  = ctx.createConstantSource();
      const gain = ctx.createGain();
      gain.gain.value = 0.001;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start();
      audioCtxRef.current = ctx;
    } catch { /* ignore */ }
  }, [ensureSilentAudio]);

  const stopAudioCtx = useCallback(() => {
    if (silentAudioRef.current && !silentAudioRef.current.paused) {
      silentAudioRef.current.pause();
      silentAudioRef.current.currentTime = 0;
    }
    if (!audioCtxRef.current) return;
    try { audioCtxRef.current.close(); } catch { /* ignore */ }
    audioCtxRef.current = null;
  }, []);

  // ── Stall watchdog — FIX B: skips restart while pendingRef is true ───────
  const stopWatchdog = useCallback(() => {
    if (watchdogRef.current) { clearInterval(watchdogRef.current); watchdogRef.current = null; }
  }, []);

  const startWatchdog = useCallback(() => {
    stopWatchdog();
    watchdogRef.current = setInterval(() => {
      if (stoppedRef.current || pendingRef.current) return;
      const ss = typeof window !== "undefined" ? window.speechSynthesis : null;
      if (!ss) return;
      if (ss.paused) {
        ss.resume();
      } else if (!ss.speaking && stateRef.current === "playing") {
        // Synthesis queue is genuinely empty — restart from last known segment
        const gen = genRef.current;
        speakRef.current(segIdxRef.current, gen);
      }
    }, 14_000);
  }, [stopWatchdog]);

  // ── Media Session helpers ────────────────────────────────────────────────
  const updateMediaSession = useCallback((s: AudioState) => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;
    const meta = chapterMetaRef.current;
    if (meta && s !== "idle") {
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  meta.title,
        artist: "Nexus Reader",
        album:  meta.bookTitle,
      });
    }
    navigator.mediaSession.playbackState =
      s === "playing" ? "playing" : s === "paused" ? "paused" : "none";
  }, []);

  // ── Core synthesis engine — FIX A: gen parameter on every call ──────────
  const speakSegment = useCallback((idx: number, gen: number) => {
    // Bail immediately if this call is from a stale generation
    if (gen !== genRef.current) return;

    const segs = segsRef.current;
    if (stoppedRef.current || idx >= segs.length) {
      stoppedRef.current = true;
      pendingRef.current = false;
      setState("idle"); stateRef.current = "idle";
      setCurrentSeg(null); setCurrentWord(-1);
      stopWatchdog(); stopAudioCtx();
      updateMediaSession("idle");
      return;
    }
    const seg       = segs[idx];
    const treatment = VOICE_TREATMENT[seg.type];

    const doSpeak = () => {
      // Re-check gen after any async delay
      if (gen !== genRef.current) return;
      if (stoppedRef.current) return;

      pendingRef.current = false; // we are now actually speaking
      const voice    = pickVoice(voicesRef.current);
      const userRate = RATES[rateIdxRef.current];
      const persona  = NARRATOR_PERSONAS[personaIdxRef.current];
      segIdxRef.current = idx;
      setCurrentSeg(seg);
      setCurrentWord(-1);
      setSegIdx(idx);
      onProgressRef.current?.(idx, seg.paraKey);

      const words = seg.text.split(/(\s+)/).filter((token) => !/^\s+$/.test(token));
      const startWordIdx = Math.max(0, Math.min(wordOffsetRef.current, Math.max(0, words.length - 1)));
      const spokenText = startWordIdx > 0 ? words.slice(startWordIdx).join(" ") : seg.text;
      const utt    = new SpeechSynthesisUtterance(spokenText);
      utt.rate     = treatment.rate * userRate * segComplexity(spokenText, seg.type) * persona.rateMultiplier;
      utt.pitch    = Math.max(0.1, Math.min(2, treatment.pitch + persona.pitchOffset));
      utt.volume   = treatment.volume * volumeMultiplierRef.current;
      utt.lang     = "en-US";
      if (voice) utt.voice = voice;

      utt.onboundary = (e) => {
        if (e.name !== "word" || gen !== genRef.current) return;
        setCurrentWord(startWordIdx + (spokenText.slice(0, e.charIndex).match(/\S+/g) ?? []).length);
      };

      utt.onend = () => {
        // FIX A: only advance if our generation is still current
        if (gen !== genRef.current || stoppedRef.current) return;
        pendingRef.current = true; // briefly pending between sentences

        // ── Breath rhythm pacing ─────────────────────────────────────────
        // Every 4–6 consecutive body/emphasis segments add a small breath gap
        // (random 320–560 ms) so the rhythm isn't a detectable metronome.
        let breathMs = 0;
        if (seg.type === "body" || seg.type === "emphasis") {
          breathCounterRef.current += 1;
          if (breathCounterRef.current >= 5) {
            breathCounterRef.current = 0;
            // Randomise the breath pause so it never sounds like a timer firing
            breathMs = 320 + Math.floor(Math.random() * 240);
          }
        } else if (seg.type === "heading" || seg.type === "chapter-title") {
          breathCounterRef.current = 0;
        }

        // ── Jitter — ±18% variation on every inter-sentence pause ────────
        // Human narrators never pause for exactly the same duration twice.
        const jitter = 0.82 + Math.random() * 0.36; // 0.82 – 1.18
        const totalPauseMs = Math.round(
          (treatment.pauseAfterMs + breathMs) * persona.pauseMultiplier * jitter
        );
        setTimeout(() => {
          pendingRef.current = false;
          wordOffsetRef.current = 0;
          speakRef.current(idx + 1, gen);
        }, totalPauseMs);
      };

      utt.onerror = (e) => {
        if (e.error === "interrupted" || e.error === "canceled") return;
        if (gen !== genRef.current || stoppedRef.current) return;
        const delay = e.error === "network" ? 1200 : 80;
        pendingRef.current = true;
        setTimeout(() => {
          pendingRef.current = false;
          if (gen === genRef.current && !stoppedRef.current) {
            speakRef.current(idx + 1, gen);
          }
        }, delay);
      };

      window.speechSynthesis.speak(utt);
    };

    if (treatment.pauseBeforeMs > 0) {
      pendingRef.current = true; // FIX B: block watchdog during lead-in silence
      const jitteredBefore = Math.round(treatment.pauseBeforeMs * (0.85 + Math.random() * 0.30));
      setTimeout(() => {
        if (gen !== genRef.current) { pendingRef.current = false; return; }
        doSpeak();
      }, jitteredBefore);
    } else {
      doSpeak();
    }
  }, [stopWatchdog, stopAudioCtx, updateMediaSession]);

  useEffect(() => { speakRef.current = speakSegment; }, [speakSegment]);

  // ── Page-visibility recovery ─────────────────────────────────────────────
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden || !window.speechSynthesis) return;
      if (stateRef.current !== "playing") return;
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      } else if (!window.speechSynthesis.speaking && !stoppedRef.current && !pendingRef.current) {
        speakRef.current(segIdxRef.current, genRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ── Media Session action handlers ────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;

    navigator.mediaSession.setActionHandler("play", () => {
      if (stateRef.current === "playing") return;
      stoppedRef.current = false;
      window.speechSynthesis?.resume();
      setState("playing"); stateRef.current = "playing";
      startWatchdog(); startAudioCtx();
      updateMediaSession("playing");
    });

    navigator.mediaSession.setActionHandler("pause", () => {
      if (stateRef.current !== "playing") return;
      window.speechSynthesis?.pause();
      setState("paused"); stateRef.current = "paused";
      stopWatchdog();
      updateMediaSession("paused");
    });

    const seekRelative = (delta: number) => {
      const newIdx = Math.max(0, Math.min(segsRef.current.length - 1, segIdxRef.current + delta));
      genRef.current += 1;
      stoppedRef.current = false;
      pendingRef.current = false;
      window.speechSynthesis?.cancel();
      const gen = genRef.current;
      setTimeout(() => {
        setState("playing"); stateRef.current = "playing";
        startAudioCtx(); startWatchdog();
        updateMediaSession("playing");
        speakRef.current(newIdx, gen);
      }, 80);
    };

    navigator.mediaSession.setActionHandler("seekbackward", () => seekRelative(-10));
    navigator.mediaSession.setActionHandler("seekforward",  () => seekRelative(+10));

    return () => {
      (["play", "pause", "seekbackward", "seekforward"] as MediaSessionAction[]).forEach((a) => {
        try { navigator.mediaSession.setActionHandler(a, null); } catch { /* ignore */ }
      });
    };
  }, [startWatchdog, startAudioCtx, stopWatchdog, updateMediaSession]);

  // ── Provider unmount ─────────────────────────────────────────────────────
  useEffect(() => () => {
    stoppedRef.current = true;
    genRef.current += 1;
    window.speechSynthesis?.cancel();
    stopWatchdog();
    stopAudioCtx();
    if (silentBlobUrlRef.current) URL.revokeObjectURL(silentBlobUrlRef.current);
  }, [stopWatchdog, stopAudioCtx]);

  // ── Public API ───────────────────────────────────────────────────────────

  const setChapter = useCallback((
    segs:        Segment[],
    meta:        AudioChapterMeta,
    onProgress?: (idx: number, key: string) => void,
  ) => {
    const prevKey = chapterMetaRef.current?.chapterKey;
    segsRef.current       = segs;
    onProgressRef.current = onProgress;

    if (prevKey !== meta.chapterKey) {
      genRef.current += 1; // invalidate all in-flight callbacks
      stoppedRef.current = true;
      pendingRef.current = false;
      window.speechSynthesis?.cancel();
      stopWatchdog(); stopAudioCtx();
      segIdxRef.current = 0;
      setState("idle"); stateRef.current = "idle";
      setCurrentSeg(null); setCurrentWord(-1); setSegIdx(0);
      updateMediaSession("idle");
      // Feature: chapter arrival announcement — queued for next play(0) call
      pendingAnnouncementRef.current = `Chapter ${meta.number}. ${meta.title}.`;
      // Feature: breath rhythm — reset counter on chapter boundary
      breathCounterRef.current = 0;
    }

    setSegTotal(segs.length);
    setChapterMeta(meta);
    chapterMetaRef.current = meta;

    if (typeof window !== "undefined" && "mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  meta.title,
        artist: "Nexus Reader",
        album:  meta.bookTitle,
      });
    }
  }, [stopWatchdog, stopAudioCtx, updateMediaSession]);

  const play = useCallback((fromIdx = segIdxRef.current) => {
    stoppedRef.current = false;
    pendingRef.current = false;
    setState("playing"); stateRef.current = "playing";
    startAudioCtx(); startWatchdog();
    updateMediaSession("playing");

    // ── Chapter arrival announcement ────────────────────────────────────
    // Plays "Chapter N. Title." once before the first segment whenever a fresh
    // chapter starts from position 0, replicating the Audible handoff feel.
    const firstSeg = segsRef.current[fromIdx] ?? null;
    const shouldAnnounce = fromIdx === 0 && firstSeg?.type !== "chapter-title";
    const announcement = shouldAnnounce ? pendingAnnouncementRef.current : null;
    if (fromIdx === 0) pendingAnnouncementRef.current = null;

    if (announcement) {
      pendingRef.current = true;
      const gen   = genRef.current;
      const voice = pickVoice(voicesRef.current);
      const persona = NARRATOR_PERSONAS[personaIdxRef.current];
      const utt = new SpeechSynthesisUtterance(announcement);
      utt.pitch  = Math.max(0.1, Math.min(2, 1.12 + persona.pitchOffset));
      utt.rate   = 0.78 * persona.rateMultiplier;
      utt.volume = volumeMultiplierRef.current;
      utt.lang   = "en-US";
      if (voice) utt.voice = voice;
      utt.onend = () => {
        if (gen !== genRef.current) return;
        pendingRef.current = false;
        // 600 ms dramatic pause after chapter announcement, then start segments
        setTimeout(() => speakRef.current(fromIdx, gen), 600);
      };
      utt.onerror = () => {
        if (gen !== genRef.current) return;
        pendingRef.current = false;
        speakRef.current(fromIdx, gen);
      };
      window.speechSynthesis.speak(utt);
    } else {
      speakRef.current(fromIdx, genRef.current);
    }
  }, [startAudioCtx, startWatchdog, updateMediaSession]);

  const pause = useCallback(() => {
    window.speechSynthesis?.pause();
    setState("paused"); stateRef.current = "paused";
    stopWatchdog();
    if (silentAudioRef.current && !silentAudioRef.current.paused) {
      silentAudioRef.current.pause();
    }
    updateMediaSession("paused");
  }, [stopWatchdog, updateMediaSession]);

  const resume = useCallback(() => {
    stoppedRef.current = false;
    window.speechSynthesis?.resume();
    setState("playing"); stateRef.current = "playing";
    startWatchdog();
    const silent = silentAudioRef.current;
    if (silent && silent.paused) silent.play().catch(() => {});
    updateMediaSession("playing");
  }, [startWatchdog, updateMediaSession]);

  const stop = useCallback(() => {
    genRef.current += 1; // invalidate all in-flight callbacks
    stoppedRef.current = true;
    pendingRef.current = false;
    window.speechSynthesis?.cancel();
    stopWatchdog(); stopAudioCtx();
    segIdxRef.current = 0;
    setState("idle"); stateRef.current = "idle";
    setCurrentSeg(null); setCurrentWord(-1); setSegIdx(0);
    updateMediaSession("idle");
  }, [stopWatchdog, stopAudioCtx, updateMediaSession]);

  const cycleRate = useCallback(() => {
    const next = (rateIdxRef.current + 1) % RATES.length;
    setRateIdx(next); rateIdxRef.current = next;
    if (stateRef.current === "playing") {
      genRef.current += 1;
      stoppedRef.current = false;
      pendingRef.current = false;
      window.speechSynthesis?.cancel();
      const gen = genRef.current;
      setTimeout(() => speakRef.current(segIdxRef.current, gen), 60);
    }
  }, []);

  const seekTo = useCallback((idx: number) => {
    wordOffsetRef.current = 0;
    genRef.current += 1;
    stoppedRef.current = false;
    pendingRef.current = false;
    window.speechSynthesis?.cancel();
    const gen = genRef.current;
    setTimeout(() => {
      setState("playing"); stateRef.current = "playing";
      startAudioCtx(); startWatchdog();
      updateMediaSession("playing");
      speakRef.current(idx, gen);
    }, 80);
  }, [startAudioCtx, startWatchdog, updateMediaSession]);

  const seekToWord = useCallback((idx: number, wordIdx: number) => {
    wordOffsetRef.current = Math.max(0, wordIdx);
    genRef.current += 1;
    stoppedRef.current = false;
    pendingRef.current = false;
    window.speechSynthesis?.cancel();
    const gen = genRef.current;
    setTimeout(() => {
      setState("playing"); stateRef.current = "playing";
      startAudioCtx(); startWatchdog();
      updateMediaSession("playing");
      speakRef.current(idx, gen);
    }, 80);
  }, [startAudioCtx, startWatchdog, updateMediaSession]);

  const setVolumeMultiplier = useCallback((v: number) => {
    volumeMultiplierRef.current = Math.max(0, Math.min(1, v));
  }, []);

  // ── Narrator persona ─────────────────────────────────────────────────────
  // AudioReader calls setPersona on mount (from localStorage) and on cycle.
  // Restarts the current segment so the new pitch/rate/pause applies immediately.
  const setPersona = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(NARRATOR_PERSONAS.length - 1, idx));
    setPersonaIdx(clamped);
    personaIdxRef.current = clamped;
    if (stateRef.current === "playing") {
      genRef.current += 1;
      stoppedRef.current = false;
      pendingRef.current = false;
      wordOffsetRef.current = 0;
      window.speechSynthesis?.cancel();
      const gen = genRef.current;
      setTimeout(() => speakRef.current(segIdxRef.current, gen), 60);
    }
  }, []);

  return (
    <AudioPlayerContext.Provider
      value={{
        state, currentSeg, currentWord, segIdx, segTotal,
        rateIdx, personaIdx, chapterMeta,
        setChapter, play, pause, resume, stop, cycleRate, seekTo, seekToWord,
        setVolumeMultiplier, setPersona,
      }}
    >
      {children}
    </AudioPlayerContext.Provider>
  );
}
