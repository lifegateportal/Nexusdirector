"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type VerseQueueItem = { ref: string; text: string };

type MonitorBackgroundId = "black" | "midnight" | "sunrise" | "ocean" | "charcoal" | "transparent";
type MonitorFontStyle = "serif" | "sans" | "display";
type LowerThirdSize = "compact" | "standard" | "large";
type BibleTranslationCode = "web" | "kjv" | "asv" | "ylt" | "niv" | "nlt" | "nkjv" | "amp" | "msg";

type MonitorDisplayPrefs = {
  layout: "center" | "lower-third";
  background: MonitorBackgroundId;
  fontStyle: MonitorFontStyle;
  lowerThirdBackground: "solid" | "glass" | "transparent";
  centerRefSize: number;
  centerVerseSize: number;
  lowerRefSize: number;
  lowerVerseSize: number;
  lowerThirdSize: LowerThirdSize;
};

const DEFAULT_DISPLAY_PREFS: MonitorDisplayPrefs = {
  layout: "center",
  background: "black",
  fontStyle: "serif",
  lowerThirdBackground: "solid",
  centerRefSize: 34,
  centerVerseSize: 72,
  lowerRefSize: 18,
  lowerVerseSize: 40,
  lowerThirdSize: "standard",
};

const BACKGROUND_STYLES: Record<MonitorBackgroundId, string> = {
  black: "radial-gradient(circle at 50% 35%, #161616 0%, #070707 58%, #000000 100%)",
  midnight: "linear-gradient(120deg, #020617 0%, #111827 48%, #0f172a 100%)",
  sunrise: "linear-gradient(135deg, #1f1200 0%, #5a2b00 42%, #9a4a00 100%)",
  ocean: "linear-gradient(135deg, #031f39 0%, #124d7d 55%, #2c7aa8 100%)",
  charcoal: "linear-gradient(160deg, #0a0a0a 0%, #1b1b1b 50%, #050505 100%)",
  transparent: "transparent",
};

const FONT_FAMILY: Record<MonitorFontStyle, string> = {
  serif: '"Georgia", "Times New Roman", serif',
  sans: '"Helvetica Neue", "Arial", sans-serif',
  display: '"Palatino Linotype", "Book Antiqua", Palatino, serif',
};

type MonitorState = {
  ref: string;
  text: string;
  updatedAt: number;
  cleared: boolean;
  stream: {
    ref: string;
    text: string;
    updatedAt: number;
    cleared: boolean;
  };
  operatorQueue: VerseQueueItem[];
  queueMode: boolean;
  displayPrefs: MonitorDisplayPrefs;
  streamDisplayPrefs: MonitorDisplayPrefs;
};

type MonitorChannel = "primary" | "stream";

const STREAM_DISPLAY_PREFS: MonitorDisplayPrefs = {
  layout: "lower-third",
  background: "black",
  fontStyle: "serif",
  lowerThirdBackground: "solid",
  centerRefSize: DEFAULT_DISPLAY_PREFS.centerRefSize,
  centerVerseSize: DEFAULT_DISPLAY_PREFS.centerVerseSize,
  lowerRefSize: DEFAULT_DISPLAY_PREFS.lowerRefSize,
  lowerVerseSize: DEFAULT_DISPLAY_PREFS.lowerVerseSize,
  lowerThirdSize: "standard",
};

function stepSequentialRef(ref: string, delta: number): string | null {
  const m = ref.match(/^((?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)?)\s+(\d+):(\d+)$/);
  if (!m) return null;
  const nextVerse = parseInt(m[3], 10) + delta;
  if (nextVerse < 1) return null;
  return `${m[1]} ${m[2]}:${nextVerse}`;
}

const BIBLE_BOOK_SUGGESTIONS = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth",
  "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra", "Nehemiah", "Esther",
  "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon", "Isaiah", "Jeremiah", "Lamentations",
  "Ezekiel", "Daniel", "Hosea", "Joel", "Amos", "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk",
  "Zephaniah", "Haggai", "Zechariah", "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans",
  "1 Corinthians", "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians",
  "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James", "1 Peter", "2 Peter",
  "1 John", "2 John", "3 John", "Jude", "Revelation",
] as const;

const TRANSLATION_ALIASES: Array<{ pattern: RegExp; code: BibleTranslationCode }> = [
  { pattern: /\bnew\s+international\s+version\b|\bniv\b/i, code: "niv" },
  { pattern: /\bnew\s+living\s+translation\b|\bnlt\b/i, code: "nlt" },
  { pattern: /\bnew\s+king\s+james(?:\s+version)?\b|\bnkjv\b/i, code: "nkjv" },
  { pattern: /\bking\s+james(?:\s+version)?\b|\bkjv\b/i, code: "kjv" },
  { pattern: /\bamerican\s+standard\s+version\b|\basv\b/i, code: "asv" },
  { pattern: /\byoung'?s\s+literal\s+translation\b|\bylt\b/i, code: "ylt" },
  { pattern: /\bworld\s+english\s+bible\b|\bweb\b/i, code: "web" },
  { pattern: /\bamplified(?:\s+bible)?\b|\bamp\b/i, code: "amp" },
  { pattern: /\bthe\s+message\b|\bmsg\b/i, code: "msg" },
];

function splitReferenceAndTranslation(raw: string, fallback: BibleTranslationCode): { reference: string; translation: BibleTranslationCode } {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  for (const alias of TRANSLATION_ALIASES) {
    const match = trimmed.match(alias.pattern);
    if (!match) continue;
    const start = match.index ?? -1;
    const token = match[0];
    if (start < 0) continue;
    const cleaned = `${trimmed.slice(0, start)} ${trimmed.slice(start + token.length)}`.replace(/\s+/g, " ").trim();
    if (cleaned) return { reference: cleaned, translation: alias.code };
  }
  return { reference: trimmed, translation: fallback };
}

function normalizeBookToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function extractBookPrefixForSuggest(input: string): string {
  const trimmed = input.trimStart();
  if (!trimmed) return "";
  if (/[:]/.test(trimmed)) return "";
  const match = trimmed.match(/^([1-3]?\s*[A-Za-z\s]+)/);
  return match ? match[1].trim() : "";
}

function MonitorPageInner() {
  const searchParams = useSearchParams();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [logging, setLogging] = useState(false);
  const [bridging, setBridging] = useState(false);

  const [state, setState] = useState<MonitorState | null>(null);
  const [showControls, setShowControls] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [fullscreenPromptVisible, setFullscreenPromptVisible] = useState(true);
  const [manualRefInput, setManualRefInput] = useState("");
  const [manualTextInput, setManualTextInput] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualStepBusy, setManualStepBusy] = useState(false);
  const [manualError, setManualError] = useState("");
  const [manualRefFocused, setManualRefFocused] = useState(false);
  const [autoCenterRefSize, setAutoCenterRefSize] = useState(DEFAULT_DISPLAY_PREFS.centerRefSize);
  const [autoCenterVerseSize, setAutoCenterVerseSize] = useState(DEFAULT_DISPLAY_PREFS.centerVerseSize);
  const [autoLowerRefSize, setAutoLowerRefSize] = useState(DEFAULT_DISPLAY_PREFS.lowerRefSize);
  const [autoLowerVerseSize, setAutoLowerVerseSize] = useState(DEFAULT_DISPLAY_PREFS.lowerVerseSize);

  const lastUpdatedAt = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const centerWrapperRef = useRef<HTMLDivElement | null>(null);
  const centerRefRef = useRef<HTMLParagraphElement | null>(null);
  const centerVerseRef = useRef<HTMLParagraphElement | null>(null);
  const lowerThirdBarRef = useRef<HTMLDivElement | null>(null);
  const lowerThirdRefRef = useRef<HTMLParagraphElement | null>(null);
  const lowerThirdVerseRef = useRef<HTMLParagraphElement | null>(null);

  const displayOnly = searchParams.get("displayOnly") === "1";
  const monitorChannel: MonitorChannel = searchParams.get("channel") === "stream" ? "stream" : "primary";
  const activeDisplay = useMemo(() => {
    if (!state) return null;
    if (monitorChannel === "stream") {
      return {
        ref: state.stream?.ref ?? "",
        text: state.stream?.text ?? "",
        updatedAt: state.stream?.updatedAt ?? 0,
        cleared: state.stream?.cleared ?? true,
      };
    }
    return {
      ref: state.ref,
      text: state.text,
      updatedAt: state.updatedAt,
      cleared: state.cleared,
    };
  }, [monitorChannel, state]);
  const displayPrefs = useMemo(
    () => {
      if (monitorChannel === "stream") {
        const streamPrefs = { ...DEFAULT_DISPLAY_PREFS, ...(state?.streamDisplayPrefs ?? {}) };
        return { ...STREAM_DISPLAY_PREFS, ...streamPrefs, layout: "lower-third" };
      }
      return { ...DEFAULT_DISPLAY_PREFS, ...(state?.displayPrefs ?? {}) };
    },
    [monitorChannel, state?.displayPrefs, state?.streamDisplayPrefs],
  );
  const fontFamily = FONT_FAMILY[displayPrefs.fontStyle];
  const backgroundStyle = useMemo(() => {
    // Keep regular shareable monitor safe/visible even if transparent was selected for overlay use.
    if (displayPrefs.background === "transparent" && !displayOnly) {
      return BACKGROUND_STYLES.black;
    }
    return BACKGROUND_STYLES[displayPrefs.background];
  }, [displayOnly, displayPrefs.background]);
  const isLive = Boolean(activeDisplay && !activeDisplay.cleared && activeDisplay.ref);
  const isLowerThirdLayout = displayPrefs.layout === "lower-third";
  const manualBookSuggestions = useMemo(() => {
    const prefix = extractBookPrefixForSuggest(manualRefInput);
    const normalizedPrefix = normalizeBookToken(prefix);
    if (!normalizedPrefix) return [] as string[];
    return BIBLE_BOOK_SUGGESTIONS
      .filter((book) => normalizeBookToken(book).startsWith(normalizedPrefix))
      .slice(0, 8);
  }, [manualRefInput]);

  // ─── Auth ────────────────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");
    setLogging(true);
    try {
      const res = await fetch("/api/monitor/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) { setLoginError("Incorrect password."); return; }
      setAuthed(true);
      startPolling();
    } catch { setLoginError("Connection error. Retry."); }
    finally { setLogging(false); }
  };

  const handleSessionBridgeLogin = async () => {
    setLoginError("");
    setBridging(true);
    try {
      const res = await fetch("/api/monitor/auth/bridge", { method: "POST" });
      if (!res.ok) {
        setLoginError("Could not verify app session. Use monitor password instead.");
        return;
      }
      setAuthed(true);
      startPolling();
    } catch {
      setLoginError("Connection error. Retry.");
    } finally {
      setBridging(false);
    }
  };

  // ─── Polling ─────────────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/monitor/state");
      if (res.status === 401) { setAuthed(false); stopPolling(); return; }
      if (!res.ok) return;
      const data = await res.json() as MonitorState;
      const incomingUpdatedAt = monitorChannel === "stream"
        ? (data.stream?.updatedAt ?? 0)
        : data.updatedAt;
      if (incomingUpdatedAt !== lastUpdatedAt.current) {
        lastUpdatedAt.current = incomingUpdatedAt;
        setState(data);
        if (data.queueMode && data.operatorQueue.length > 0) setShowQueue(true);
      }
    } catch { /* network blip */ }
  }, [monitorChannel]);

  const stopPolling = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };

  const startPolling = useCallback(() => {
    stopPolling();
    intervalRef.current = setInterval(() => void poll(), 2000);
  }, [poll]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/monitor/state");
        if (res.ok) {
          const data = await res.json() as MonitorState;
          lastUpdatedAt.current = monitorChannel === "stream"
            ? (data.stream?.updatedAt ?? 0)
            : data.updatedAt;
          setState(data);
          setAuthed(true);
          startPolling();
          return;
        }

        // If monitor cookie is missing, try bridging from existing app session.
        const bridge = await fetch("/api/monitor/auth/bridge", { method: "POST" });
        if (bridge.ok) {
          const retry = await fetch("/api/monitor/state");
          if (retry.ok) {
            const data = await retry.json() as MonitorState;
            lastUpdatedAt.current = monitorChannel === "stream"
              ? (data.stream?.updatedAt ?? 0)
              : data.updatedAt;
            setState(data);
            setAuthed(true);
            startPolling();
            return;
          }
        }
      } catch {
        // fall through to login screen on transient auth bootstrap failures
      }

        setAuthed(false);
    })();
    return stopPolling;
  }, [monitorChannel, startPolling]);

  // ─── Operator actions ─────────────────────────────────────────────────────
  const operatorGo = async () => {
    await fetch("/api/monitor/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operatorGo: true }),
    });
    void poll();
  };

  const operatorSkip = async () => {
    await fetch("/api/monitor/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operatorSkip: true }),
    });
    void poll();
  };

  const toggleQueueMode = async (enabled: boolean) => {
    await fetch("/api/monitor/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setQueueMode: enabled }),
    });
    void poll();
  };

  const updateDisplayPrefs = async (patch: Partial<MonitorDisplayPrefs>) => {
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        displayPrefs: { ...DEFAULT_DISPLAY_PREFS, ...prev.displayPrefs, ...patch },
      };
    });
    await fetch("/api/monitor/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setDisplayPrefs: patch, source: "media" }),
    });
    void poll();
  };

  const handleManualMonitorPush = async () => {
    const parsed = splitReferenceAndTranslation(manualRefInput, "web");
    const ref = parsed.reference;
    const translation = parsed.translation;
    let text = manualTextInput.trim();
    if (!ref) {
      setManualError("Enter a scripture reference.");
      return;
    }

    setManualBusy(true);
    setManualError("");
    try {
      if (!text) {
        const verseRes = await fetch("/api/bible-verse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference: ref, translation }),
        });
        if (!verseRes.ok) {
          setManualError("Could not fetch verse text. Add it manually.");
          return;
        }
        const verseData = await verseRes.json() as { text?: string; error?: string };
        if (verseData.error || !verseData.text) {
          setManualError("Could not fetch verse text. Add it manually.");
          return;
        }
        text = verseData.text.trim();
      }

      const res = await fetch("/api/monitor/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref, text }),
      });
      if (!res.ok) {
        setManualError("Manual cast failed. Try again.");
        return;
      }
      setManualRefInput("");
      setManualTextInput("");
      void poll();
    } catch {
      setManualError("Manual cast failed. Try again.");
    } finally {
      setManualBusy(false);
    }
  };

  const handleStepVerse = async (delta: -1 | 1) => {
    const currentRef = activeDisplay?.ref?.trim() ?? "";
    if (!currentRef) return;
    const targetRef = stepSequentialRef(currentRef, delta);
    if (!targetRef) return;

    setManualStepBusy(true);
    setManualError("");
    try {
      const verseRes = await fetch("/api/bible-verse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: targetRef, translation: "web" }),
      });
      if (!verseRes.ok) {
        setManualError("Could not fetch that verse.");
        return;
      }
      const verseData = await verseRes.json() as { reference?: string; text?: string; error?: string };
      if (verseData.error || !verseData.text) {
        setManualError("Could not fetch that verse.");
        return;
      }

      const ref = (verseData.reference ?? targetRef).trim();
      const text = verseData.text.trim();
      const res = await fetch("/api/monitor/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref, text }),
      });
      if (!res.ok) {
        setManualError("Could not update monitor verse.");
        return;
      }

      setManualRefInput(ref);
      setManualTextInput(text);
      void poll();
    } catch {
      setManualError("Could not update monitor verse.");
    } finally {
      setManualStepBusy(false);
    }
  };

  const requestFullscreen = useCallback(async () => {
    try {
      setFullscreenError("");
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      }
      setFullscreenPromptVisible(!!document.fullscreenElement ? false : true);
    } catch {
      setFullscreenError("Fullscreen request was blocked by the browser. Tap again to allow.");
      setFullscreenPromptVisible(true);
    }
  }, []);

  const openFullscreenOutput = () => {
    const channelQuery = monitorChannel === "stream" ? "&channel=stream" : "";
    const href = `${window.location.origin}/monitor?displayOnly=1${channelQuery}`;
    const win = window.open(href, "NexusMonitorFullscreen", "noopener,noreferrer");
    if (!win) return;
    win.focus();
  };

  useEffect(() => {
    const syncFullscreen = () => {
      if (!displayOnly) return;
      setFullscreenPromptVisible(!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    syncFullscreen();
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, [displayOnly]);

  useLayoutEffect(() => {
    if (isLowerThirdLayout || !isLive) {
      setAutoCenterRefSize(displayPrefs.centerRefSize);
      setAutoCenterVerseSize(displayPrefs.centerVerseSize);
      return;
    }

    const fitCenter = () => {
      const wrapper = centerWrapperRef.current;
      const refEl = centerRefRef.current;
      const verseEl = centerVerseRef.current;
      if (!wrapper || !refEl || !verseEl) return;

      const hardCap = Math.floor(window.innerHeight * 0.92);
      const minVerse = 10;
      const minRef = 9;
      let nextRef = displayPrefs.centerRefSize;
      let nextVerse = displayPrefs.centerVerseSize;

      wrapper.style.maxHeight = `${hardCap}px`;
      refEl.style.fontSize = `${nextRef / 16}rem`;
      verseEl.style.fontSize = `${nextVerse / 16}rem`;

      let guard = 0;
      while (wrapper.scrollHeight > hardCap && (nextVerse > minVerse || nextRef > minRef) && guard < 300) {
        guard += 1;
        if (nextVerse > minVerse) nextVerse -= 1;
        if (guard % 2 === 0 && nextRef > minRef) nextRef -= 1;
        refEl.style.fontSize = `${nextRef / 16}rem`;
        verseEl.style.fontSize = `${nextVerse / 16}rem`;
      }

      setAutoCenterRefSize(nextRef);
      setAutoCenterVerseSize(nextVerse);
    };

    fitCenter();
    window.addEventListener("resize", fitCenter);
    return () => window.removeEventListener("resize", fitCenter);
  }, [activeDisplay?.ref, activeDisplay?.text, displayPrefs.centerRefSize, displayPrefs.centerVerseSize, isLive, isLowerThirdLayout]);

  useLayoutEffect(() => {
    if (!isLowerThirdLayout || !isLive) {
      setAutoLowerRefSize(displayPrefs.lowerRefSize);
      setAutoLowerVerseSize(displayPrefs.lowerVerseSize);
      return;
    }

    const fitLowerThird = () => {
      const bar = lowerThirdBarRef.current;
      const verse = lowerThirdVerseRef.current;
      if (!bar || !verse) return;

      const hardCap = Math.floor(window.innerHeight / 3);
      const fadePixels = displayPrefs.lowerThirdBackground === "transparent"
        ? 0
        : displayPrefs.lowerThirdSize === "compact"
          ? 40
          : displayPrefs.lowerThirdSize === "large"
            ? 80
            : 64;
      const barCap = Math.max(120, hardCap - fadePixels);
      const minVerse = 8;
      const minRef = 8;
      let nextRef = displayPrefs.lowerRefSize;
      let nextSize = displayPrefs.lowerVerseSize;

      bar.style.maxHeight = `${barCap}px`;
      if (lowerThirdRefRef.current) {
        lowerThirdRefRef.current.style.fontSize = `${nextRef / 16}rem`;
      }
      verse.style.fontSize = `${nextSize / 16}rem`;

      let guard = 0;
      while (bar.scrollHeight > barCap && (nextSize > minVerse || nextRef > minRef) && guard < 300) {
        guard += 1;
        if (nextSize > minVerse) nextSize -= 1;
        if (guard % 2 === 0 && nextRef > minRef) nextRef -= 1;
        if (lowerThirdRefRef.current) {
          lowerThirdRefRef.current.style.fontSize = `${nextRef / 16}rem`;
        }
        verse.style.fontSize = `${nextSize / 16}rem`;
      }

      setAutoLowerRefSize(nextRef);
      setAutoLowerVerseSize(nextSize);
    };

    fitLowerThird();
    window.addEventListener("resize", fitLowerThird);
    return () => window.removeEventListener("resize", fitLowerThird);
  }, [activeDisplay?.ref, activeDisplay?.text, displayPrefs.lowerRefSize, displayPrefs.lowerThirdBackground, displayPrefs.lowerThirdSize, displayPrefs.lowerVerseSize, isLive, isLowerThirdLayout]);

  // ─── Controls auto-hide ───────────────────────────────────────────────────
  const revealControls = () => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), 4000);
  };

  // ─── Login screen ─────────────────────────────────────────────────────────
  if (authed === null) {
    return (
      <div className="flex h-dvh items-center justify-center bg-black">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-yellow-400 border-t-transparent" />
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center bg-[#080808]">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-black/80 p-8 shadow-2xl">
          <div className="mb-8 text-center">
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-yellow-400">Nexus Director</p>
            <h1 className="mt-2 text-2xl font-bold text-white">Scripture Monitor</h1>
            <p className="mt-1 text-sm text-white/40">Enter the access password to connect</p>
          </div>
          <form onSubmit={(e) => void handleLogin(e)} className="space-y-4">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/25 outline-none focus:border-yellow-400/60 focus:ring-1 focus:ring-yellow-400/20"
            />
            {loginError && <p className="text-xs text-red-400">{loginError}</p>}
            <button
              type="submit"
              disabled={logging || !password}
              className="w-full rounded-xl bg-yellow-400 py-3 text-sm font-bold text-black transition hover:bg-yellow-300 disabled:opacity-40"
            >
              {logging ? "Connecting…" : "Connect"}
            </button>
            <button
              type="button"
              onClick={() => void handleSessionBridgeLogin()}
              disabled={bridging}
              className="w-full rounded-xl border border-cyan-500/60 bg-cyan-500/15 py-3 text-sm font-bold text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-40"
            >
              {bridging ? "Checking app session..." : "Use Current App Session"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ─── Display screen ────────────────────────────────────────────────────────

  const lowerBarSizing = {
    compact: { fade: "h-10", body: "px-8 py-3", refMb: "mb-1", verseLeading: "leading-snug" },
    standard: { fade: "h-16", body: "px-10 py-5", refMb: "mb-2", verseLeading: "leading-snug" },
    large: { fade: "h-20", body: "px-12 py-6", refMb: "mb-3", verseLeading: "leading-normal" },
  }[displayPrefs.lowerThirdSize];

  return (
    <div
      className="relative h-dvh w-screen overflow-hidden bg-black text-white select-none"
      style={{ background: backgroundStyle }}
      onMouseMove={revealControls}
      onTouchStart={revealControls}
    >
      {displayOnly && fullscreenPromptVisible && (
        <div className="pointer-events-none absolute left-0 right-0 top-4 z-30 flex justify-center">
          <div className="pointer-events-auto flex flex-col items-center gap-2 rounded-2xl border border-white/15 bg-black/70 px-4 py-2 backdrop-blur">
            <button
              onClick={() => void requestFullscreen()}
              className="rounded-lg border border-yellow-400/50 bg-yellow-400/20 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-yellow-300 hover:bg-yellow-400/30"
            >
              Enter Fullscreen
            </button>
            {fullscreenError && <p className="text-[11px] text-red-300">{fullscreenError}</p>}
          </div>
        </div>
      )}

      {/* ── Center layout ─────────────────────────────────────────────── */}
      {!isLowerThirdLayout && (
        <div className="flex h-full items-center justify-center">
          {isLive ? (
            <div
              ref={centerWrapperRef}
              key={`${activeDisplay?.ref ?? ""}-${activeDisplay?.updatedAt ?? 0}`}
              className="mx-auto flex h-[92dvh] w-full max-w-5xl flex-col items-center justify-center overflow-hidden px-12 text-center"
              style={{ animation: "fadeUp 0.5s ease both" }}
            >
              <p
                ref={centerRefRef}
                className="mb-8 font-bold uppercase tracking-[0.3em] text-yellow-400"
                style={{
                  textShadow: "0 0 40px rgba(250,204,21,0.4)",
                  fontFamily,
                  fontSize: `${autoCenterRefSize / 16}rem`,
                }}
              >
                {activeDisplay?.ref ?? ""}
              </p>
              <p
                ref={centerVerseRef}
                className="leading-snug text-white [overflow-wrap:anywhere]"
                style={{
                  textShadow: "0 2px 30px rgba(255,255,255,0.1)",
                  fontFamily,
                  fontSize: `${autoCenterVerseSize / 16}rem`,
                }}
              >
                &ldquo;{activeDisplay?.text ?? ""}&rdquo;
              </p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-white/15">Nexus Director</p>
              {state?.queueMode && (
                <p className="mt-2 text-xs text-white/20">Queue mode — operator hold active</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Lower-thirds layout ───────────────────────────────────────── */}
      {isLowerThirdLayout && (
        <>
          {/* idle watermark */}
          {!isLive && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-white/10">Nexus Director</p>
            </div>
          )}

          {/* lower-thirds bar */}
          {isLive && (
            <div
              key={`${activeDisplay?.ref ?? ""}-${activeDisplay?.updatedAt ?? 0}`}
              className="absolute bottom-0 left-0 right-0 overflow-hidden"
              style={{ animation: "slideUp 0.45s ease both", maxHeight: "33.333dvh" }}
            >
              {/* gradient fade */}
              <div
                className={`${displayPrefs.lowerThirdBackground === "transparent" ? "h-0" : lowerBarSizing.fade} ${displayPrefs.lowerThirdBackground === "glass" ? "bg-gradient-to-t from-black/35 to-transparent" : "bg-gradient-to-t from-black/80 to-transparent"}`}
              />
              <div
                ref={lowerThirdBarRef}
                className={`overflow-hidden border-t border-yellow-400/30 ${lowerBarSizing.body} ${displayPrefs.lowerThirdBackground === "solid" ? "bg-black/85" : ""} ${displayPrefs.lowerThirdBackground === "glass" ? "bg-black/30 backdrop-blur-sm" : ""} ${displayPrefs.lowerThirdBackground === "transparent" ? "bg-transparent" : ""}`}
              >
                <p
                  ref={lowerThirdRefRef}
                  className={`${lowerBarSizing.refMb} font-bold uppercase tracking-[0.28em] text-yellow-400`}
                  style={{
                    fontFamily,
                    fontSize: `${autoLowerRefSize / 16}rem`,
                  }}
                >
                  {activeDisplay?.ref ?? ""}
                </p>
                <p
                  ref={lowerThirdVerseRef}
                  className={`${lowerBarSizing.verseLeading} text-white`}
                  style={{
                    fontFamily,
                    fontSize: `${autoLowerVerseSize / 16}rem`,
                  }}
                >
                  &ldquo;{activeDisplay?.text ?? ""}&rdquo;
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Operator queue panel ──────────────────────────────────────── */}
      {!displayOnly && state?.queueMode && showQueue && (
        <div className="absolute right-4 top-4 w-80 rounded-2xl border border-white/10 bg-black/90 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-wider text-yellow-400">
              Operator Queue ({state.operatorQueue?.length ?? 0})
            </p>
            <button onClick={() => setShowQueue(false)} className="text-white/40 hover:text-white text-sm">✕</button>
          </div>
          {(state.operatorQueue?.length ?? 0) === 0 ? (
            <p className="px-4 py-3 text-xs text-white/30">No items queued</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {(state.operatorQueue ?? []).map((item, i) => (
                <div key={i} className={`border-b border-white/5 px-4 py-3 ${i === 0 ? "bg-yellow-400/5" : ""}`}>
                  <p className="text-xs font-bold text-yellow-300">{item.ref}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-white/50">{item.text}</p>
                  {i === 0 && (
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => void operatorGo()}
                        className="rounded-lg bg-green-500/80 px-4 py-1.5 text-xs font-bold text-white hover:bg-green-500"
                      >
                        GO
                      </button>
                      <button
                        onClick={() => void operatorSkip()}
                        className="rounded-lg bg-white/10 px-4 py-1.5 text-xs font-bold text-white/70 hover:bg-white/20"
                      >
                        Skip
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!displayOnly && (
        <div className="absolute left-4 top-4 z-20 w-[min(420px,calc(100vw-2rem))] rounded-2xl border border-violet-500/25 bg-black/85 p-3 shadow-2xl backdrop-blur">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-300">Manual Scripture</p>
          <p className="mt-1 text-[11px] text-white/55">Use this when auto live detection misses a verse.</p>
          <div className="mt-2 grid gap-2">
            <div className="relative">
              <input
                type="text"
                value={manualRefInput}
                onChange={(e) => setManualRefInput(e.target.value)}
                onFocus={() => setManualRefFocused(true)}
                onBlur={() => window.setTimeout(() => setManualRefFocused(false), 100)}
                placeholder="Reference (e.g. Romans 8:28)"
                className="min-h-[48px] w-full rounded-lg border border-white/15 bg-black/50 px-3 text-base text-white placeholder:text-white/30 outline-none focus:border-violet-400/70"
              />
              {manualRefFocused && manualBookSuggestions.length > 0 && (
                <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-20 overflow-hidden rounded-lg border border-white/20 bg-black shadow-2xl">
                  {manualBookSuggestions.map((book) => (
                    <button
                      key={book}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const suffix = manualRefInput.match(/\s+\d.*$/)?.[0] ?? "";
                        setManualRefInput(`${book}${suffix}`.trim());
                        setManualRefFocused(false);
                      }}
                      className="flex min-h-[42px] w-full items-center px-3 text-left text-sm text-white/85 hover:bg-white/10"
                    >
                      {book}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <textarea
              value={manualTextInput}
              onChange={(e) => setManualTextInput(e.target.value)}
              rows={2}
              placeholder="Verse text (optional if reference is valid)"
              className="rounded-lg border border-white/15 bg-black/50 px-3 py-2 text-base text-white placeholder:text-white/30 outline-none focus:border-violet-400/70"
            />
            <button
              type="button"
              onClick={() => void handleManualMonitorPush()}
              disabled={manualBusy || !manualRefInput.trim()}
              className="min-h-[48px] rounded-lg border border-violet-400/60 bg-violet-500/20 px-4 text-xs font-bold uppercase tracking-[0.18em] text-violet-100 transition hover:bg-violet-500/30 disabled:opacity-40"
            >
              {manualBusy ? "Sending..." : (state?.queueMode ? "Add To Queue" : "Cast Now")}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void handleStepVerse(-1)}
                disabled={manualStepBusy || !stepSequentialRef(state?.ref ?? "", -1)}
                className="min-h-[44px] rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-3 text-[11px] font-bold uppercase tracking-[0.16em] text-cyan-200 transition hover:bg-cyan-500/20 disabled:opacity-40"
              >
                Previous Verse
              </button>
              <button
                type="button"
                onClick={() => void handleStepVerse(1)}
                disabled={manualStepBusy || !stepSequentialRef(state?.ref ?? "", 1)}
                className="min-h-[44px] rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-3 text-[11px] font-bold uppercase tracking-[0.16em] text-cyan-200 transition hover:bg-cyan-500/20 disabled:opacity-40"
              >
                Next Verse
              </button>
            </div>
            {manualError && <p className="text-xs text-red-300">{manualError}</p>}
          </div>
        </div>
      )}

      {/* ── Control bar (auto-hide) ───────────────────────────────────── */}
      {!displayOnly && <div
        className={`absolute bottom-0 left-0 right-0 grid grid-cols-1 gap-3 border-t border-white/5 bg-black/70 px-6 py-3 backdrop-blur transition-all duration-300 lg:grid-cols-[auto_1fr_auto] ${showControls ? "opacity-100 translate-y-0" : "opacity-0 translate-y-full pointer-events-none"}`}
        style={{ bottom: isLowerThirdLayout && isLive ? "auto" : 0, top: isLowerThirdLayout && isLive ? 0 : "auto" }}
      >
        <div className="flex items-center gap-4">
          {/* Layout toggle */}
          <button
            onClick={() => void updateDisplayPrefs({ layout: isLowerThirdLayout ? "center" : "lower-third" })}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-white/70 hover:bg-white/15 transition"
          >
            {isLowerThirdLayout ? (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>
                Center
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="3" y="15" width="18" height="6" rx="1" fill="currentColor"/></svg>
                Lower-Thirds
              </>
            )}
          </button>

          {/* Queue mode toggle */}
          <button
            onClick={() => void toggleQueueMode(!(state?.queueMode ?? false))}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-bold transition ${state?.queueMode ? "border-yellow-500/60 bg-yellow-500/15 text-yellow-300" : "border-white/10 bg-white/5 text-white/70 hover:bg-white/15"}`}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${state?.queueMode ? "bg-yellow-400 animate-pulse" : "bg-white/30"}`} />
            {state?.queueMode ? "Queue Mode ON" : "Queue Mode OFF"}
          </button>

          <button
            onClick={openFullscreenOutput}
            className="rounded-lg border border-cyan-500/60 bg-cyan-500/20 px-3 py-1.5 text-xs font-bold text-cyan-200 hover:bg-cyan-500/30"
          >
            Deploy Fullscreen
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 lg:grid-cols-7">
          <select
            value={displayPrefs.background}
            onChange={(e) => void updateDisplayPrefs({ background: e.target.value as MonitorBackgroundId })}
            className="rounded-lg border border-white/15 bg-black/50 px-2 py-1.5 text-xs text-white"
          >
            <option value="black">Black</option>
            <option value="midnight">Midnight</option>
            <option value="sunrise">Sunrise</option>
            <option value="ocean">Ocean</option>
            <option value="charcoal">Charcoal</option>
            <option value="transparent">Transparent</option>
          </select>
          <select
            value={displayPrefs.fontStyle}
            onChange={(e) => void updateDisplayPrefs({ fontStyle: e.target.value as MonitorFontStyle })}
            className="rounded-lg border border-white/15 bg-black/50 px-2 py-1.5 text-xs text-white"
          >
            <option value="serif">Serif</option>
            <option value="sans">Sans</option>
            <option value="display">Display</option>
          </select>
          <select
            value={displayPrefs.lowerThirdBackground}
            onChange={(e) => void updateDisplayPrefs({ lowerThirdBackground: e.target.value as MonitorDisplayPrefs["lowerThirdBackground"] })}
            className="rounded-lg border border-white/15 bg-black/50 px-2 py-1.5 text-xs text-white"
          >
            <option value="solid">LT Solid</option>
            <option value="glass">LT Glass</option>
            <option value="transparent">LT Transparent</option>
          </select>
          <input
            type="range"
            min={16}
            max={90}
            value={displayPrefs.centerRefSize}
            onChange={(e) => void updateDisplayPrefs({ centerRefSize: Number(e.target.value) })}
            className="w-full"
            title="Center reference size"
          />
          <input
            type="range"
            min={28}
            max={140}
            value={displayPrefs.centerVerseSize}
            onChange={(e) => void updateDisplayPrefs({ centerVerseSize: Number(e.target.value) })}
            className="w-full"
            title="Center verse size"
          />
          <input
            type="range"
            min={12}
            max={56}
            value={displayPrefs.lowerRefSize}
            onChange={(e) => void updateDisplayPrefs({ lowerRefSize: Number(e.target.value) })}
            className="w-full"
            title="Lower-third reference size"
          />
          <input
            type="range"
            min={20}
            max={96}
            value={displayPrefs.lowerVerseSize}
            onChange={(e) => void updateDisplayPrefs({ lowerVerseSize: Number(e.target.value) })}
            className="w-full"
            title="Lower-third verse size"
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-white/15 bg-black/40 p-1">
            {(["compact", "standard", "large"] as const).map((size) => (
              <button
                key={size}
                onClick={() => void updateDisplayPrefs({ lowerThirdSize: size })}
                className={`rounded-md px-2 py-1 text-[11px] font-bold uppercase ${displayPrefs.lowerThirdSize === size ? "bg-yellow-400/25 text-yellow-200" : "text-white/60 hover:bg-white/10"}`}
              >
                {size}
              </button>
            ))}
          </div>

          {/* Queue indicator */}
          {state?.queueMode && (state.operatorQueue?.length ?? 0) > 0 && (
            <button
              onClick={() => setShowQueue(true)}
              className="rounded-lg bg-yellow-400/20 px-3 py-1.5 text-xs font-bold text-yellow-300 hover:bg-yellow-400/30"
            >
              Queue: {state.operatorQueue.length} waiting
            </button>
          )}

          {/* Quick Go button (when queue has items) */}
          {state?.queueMode && (state.operatorQueue?.length ?? 0) > 0 && (
            <button
              onClick={() => void operatorGo()}
              className="rounded-lg bg-green-500/80 px-4 py-1.5 text-xs font-bold text-white hover:bg-green-500"
            >
              GO ▶
            </button>
          )}
        </div>
      </div>}

      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(100%); }
          to   { opacity: 1; transform: translateY(0); }
        }
        * { -webkit-font-smoothing: antialiased; }
      `}</style>
    </div>
  );
}

export default function MonitorPage() {
  return (
    <Suspense>
      <MonitorPageInner />
    </Suspense>
  );
}
