"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { NexusNav } from "@/app/components/NexusNav";
import { StatusBar } from "@/app/components/StatusBar";

type TranslateLanguage =
  | "english"
  | "spanish"
  | "french"
  | "portuguese"
  | "german"
  | "swahili"
  | "twi"
  | "kikuyu"
  | "italian"
  | "dutch"
  | "arabic"
  | "hindi"
  | "russian"
  | "ukrainian"
  | "turkish"
  | "chinese"
  | "japanese"
  | "korean"
  | "amharic"
  | "yoruba"
  | "hausa";

type SpeechLanguage = "auto" | "english" | "spanish" | "french" | "portuguese" | "german" | "swahili" | "twi" | "kikuyu";
type WorkMode = "text" | "document" | "live";
type ControlMode = "tap" | "hold";
type SpeakerId = "A" | "B";

type LiveTurn = {
  id: string;
  speaker: SpeakerId;
  source: string;
  translation: string;
  confidence: number;
  latencyMs: number;
  createdAt: string;
};

type TranslateSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: WorkMode;
  targetLanguage: TranslateLanguage;
  sourceText: string;
  translatedText: string;
  liveTurns: LiveTurn[];
};

const LANGUAGE_OPTIONS: Array<{ value: TranslateLanguage; label: string }> = [
  { value: "english", label: "English" },
  { value: "spanish", label: "Spanish" },
  { value: "french", label: "French" },
  { value: "portuguese", label: "Portuguese" },
  { value: "german", label: "German" },
  { value: "swahili", label: "Swahili" },
  { value: "twi", label: "Twi" },
  { value: "kikuyu", label: "Kikuyu" },
  { value: "italian", label: "Italian" },
  { value: "dutch", label: "Dutch" },
  { value: "arabic", label: "Arabic" },
  { value: "hindi", label: "Hindi" },
  { value: "russian", label: "Russian" },
  { value: "ukrainian", label: "Ukrainian" },
  { value: "turkish", label: "Turkish" },
  { value: "chinese", label: "Chinese" },
  { value: "japanese", label: "Japanese" },
  { value: "korean", label: "Korean" },
  { value: "amharic", label: "Amharic" },
  { value: "yoruba", label: "Yoruba" },
  { value: "hausa", label: "Hausa" },
];

const SESSION_KEY = "nexus_translate_sessions_v1";
const DOCUMENT_CHUNK_SIZE = 4200;
const DOCUMENT_CONCURRENCY = 3;

function splitChunks(text: string, maxChars = 1800): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars * 0.55)) cut = remaining.lastIndexOf(" ", maxChars);
    if (cut < Math.floor(maxChars * 0.4)) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function chooseRecorderMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

function slugify(input: string): string {
  const out = input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "nexus-translate";
}

function parseGlossary(input: string): Array<{ source: string; target: string }> {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [source, ...rest] = line.split("=>");
      return {
        source: source?.trim() ?? "",
        target: rest.join("=>").trim(),
      };
    })
    .filter((item) => item.source && item.target);
}

function parseProtectedTerms(input: string): string[] {
  return input
    .split(/,|\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanupLiveText(text: string): string {
  return text
    .replace(/\b(uh|um|er|ah)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatSrtTime(totalMs: number): string {
  const ms = Math.max(0, Math.floor(totalMs));
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  const pad = (value: number, size: number) => value.toString().padStart(size, "0");
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(mmm, 3)}`;
}

export default function TranslatePage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const liveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const [mode, setMode] = useState<WorkMode>("text");
  const [targetLanguage, setTargetLanguage] = useState<TranslateLanguage>("english");
  const [speechLanguage, setSpeechLanguage] = useState<SpeechLanguage>("auto");
  const [controlMode, setControlMode] = useState<ControlMode>("tap");
  const [activeSpeaker, setActiveSpeaker] = useState<SpeakerId>("A");
  const [cleanupEnabled, setCleanupEnabled] = useState(true);

  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [docExtractedText, setDocExtractedText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [documentWasTruncated, setDocumentWasTruncated] = useState(false);
  const [documentOriginalLength, setDocumentOriginalLength] = useState<number | null>(null);

  const [liveTurns, setLiveTurns] = useState<LiveTurn[]>([]);
  const [interimSpeech, setInterimSpeech] = useState("");

  const [glossaryText, setGlossaryText] = useState("");
  const [protectedTermsText, setProtectedTermsText] = useState("");

  const [progress, setProgress] = useState(0);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState<string>("Ready");

  const [sessions, setSessions] = useState<TranslateSession[]>([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const [mobileTerminologyOpen, setMobileTerminologyOpen] = useState(false);
  const [textViewTab, setTextViewTab] = useState<"source" | "translated">("source");
  const [documentViewTab, setDocumentViewTab] = useState<"source" | "translated">("source");

  const targetLabel = useMemo(
    () => LANGUAGE_OPTIONS.find((item) => item.value === targetLanguage)?.label ?? "English",
    [targetLanguage],
  );
  const glossary = useMemo(() => parseGlossary(glossaryText), [glossaryText]);
  const protectedTerms = useMemo(() => parseProtectedTerms(protectedTermsText), [protectedTermsText]);

  const liveSourceText = useMemo(() => liveTurns.map((turn) => `Speaker ${turn.speaker}: ${turn.source}`).join("\n"), [liveTurns]);
  const liveTranslatedText = useMemo(() => liveTurns.map((turn) => `Speaker ${turn.speaker}: ${turn.translation}`).join("\n"), [liveTurns]);

  const filteredSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((session) =>
      session.name.toLowerCase().includes(q)
      || session.sourceText.toLowerCase().includes(q)
      || session.translatedText.toLowerCase().includes(q),
    );
  }, [sessionSearch, sessions]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as TranslateSession[];
      if (Array.isArray(parsed)) setSessions(parsed);
    } catch {
      // ignore
    }
  }, []);

  const persistSessions = useCallback((next: TranslateSession[]) => {
    setSessions(next);
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  }, []);

  const handleNavSelect = useCallback((id: string) => {
    if (id === "ebook") {
      router.push("/ebook?tab=pipeline");
      return;
    }
    if (id === "translate") {
      router.push("/translate");
      return;
    }
    router.push("/");
  }, [router]);

  const requestTranslate = useCallback(async (text: string, lang: TranslateLanguage): Promise<string> => {
    const res = await fetch("/api/sermon-assistant/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang, glossary, protectedTerms }),
    });
    const json = await res.json() as { translation?: string; error?: string };
    if (!res.ok || !json.translation) {
      throw new Error(json.error ?? "Translation failed");
    }
    return json.translation.trim();
  }, [glossary, protectedTerms]);

  const runTranslation = useCallback(async (text: string, lang: TranslateLanguage) => {
    const chunks = splitChunks(text, DOCUMENT_CHUNK_SIZE);
    if (chunks.length === 0) {
      setStatus("No text to translate");
      return;
    }
    if (chunks.length > 80) {
      setStatus("Content too large. Reduce input size.");
      return;
    }
    setIsTranslating(true);
    setProgress(0);
    setStatus("Translating...");

    try {
      const out = new Array<string>(chunks.length);
      let completed = 0;

      for (let start = 0; start < chunks.length; start += DOCUMENT_CONCURRENCY) {
        const batch = chunks.slice(start, start + DOCUMENT_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (chunk, offset) => {
            const translated = await requestTranslate(chunk, lang);
            completed += 1;
            setProgress(Math.round((completed / chunks.length) * 100));
            return { index: start + offset, translated };
          }),
        );

        for (const result of results) {
          out[result.index] = result.translated;
        }
      }

      setTranslatedText(out.join("\n\n").trim());
      setStatus(`Translated to ${targetLabel}.`);
    } catch {
      setStatus("Translation failed.");
    } finally {
      setIsTranslating(false);
    }
  }, [requestTranslate, targetLabel]);

  const stopLiveSpeech = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (socketRef.current) {
      try {
        socketRef.current.close();
      } catch {
        // ignore
      }
      socketRef.current = null;
    }
    setInterimSpeech("");
    setIsListening(false);
    setStatus("Ready");
  }, []);

  const processLiveFinal = useCallback(async (transcriptRaw: string, confidence: number) => {
    const source = cleanupEnabled ? cleanupLiveText(transcriptRaw) : transcriptRaw.trim();
    if (!source) return;
    const started = performance.now();
    try {
      const translation = await requestTranslate(source, targetLanguage);
      const latencyMs = Math.round(performance.now() - started);
      setLiveTurns((prev) => [
        ...prev,
        {
          id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          speaker: activeSpeaker,
          source,
          translation,
          confidence,
          latencyMs,
          createdAt: new Date().toISOString(),
        },
      ]);
      setStatus(`Live translated (${latencyMs}ms)`);
    } catch {
      setStatus("Live translation chunk failed.");
    }
  }, [activeSpeaker, cleanupEnabled, requestTranslate, targetLanguage]);

  const startLiveSpeech = useCallback(async () => {
    const tokenRes = await fetch("/api/transcribe-token", { method: "GET" });
    if (!tokenRes.ok) {
      setStatus("Deepgram key unavailable.");
      return;
    }
    const tokenData = await tokenRes.json() as { apiKey?: string };
    const apiKey = tokenData.apiKey?.trim();
    if (!apiKey) {
      setStatus("Deepgram key unavailable.");
      return;
    }

    const manualLanguageCode: Record<Exclude<SpeechLanguage, "auto" | "twi" | "kikuyu">, string> = {
      english: "en",
      spanish: "es",
      french: "fr",
      portuguese: "pt",
      german: "de",
      swahili: "sw",
    };

    const params = new URLSearchParams({
      model: "nova-2",
      endpointing: "500",
      punctuate: "true",
      interim_results: "true",
      smart_format: "true",
    });

    const isLimitedLanguage = speechLanguage === "twi" || speechLanguage === "kikuyu";
    if (speechLanguage === "auto" || isLimitedLanguage) {
      params.set("detect_language", "true");
    } else {
      params.set("language", manualLanguageCode[speechLanguage]);
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    setStatus("Connecting interpreter...");

    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ["token", apiKey]);
    socketRef.current = ws;

    ws.onopen = () => {
      const mimeType = chooseRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(event.data);
        }
      };
      recorder.start(250);
      setIsListening(true);
      setStatus("Listening live...");
    };

    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as {
        type?: string;
        is_final?: boolean;
        channel?: {
          alternatives?: Array<{ transcript?: string; confidence?: number }>;
        };
      };
      if (payload.type === "Error") {
        setStatus("Live speech connection failed.");
        stopLiveSpeech();
        return;
      }
      const alt = payload.channel?.alternatives?.[0];
      const transcript = alt?.transcript?.trim() ?? "";
      if (!transcript) return;

      if (payload.is_final) {
        setInterimSpeech("");
        const conf = Number.isFinite(alt?.confidence) ? Number(alt?.confidence) : 0;
        liveQueueRef.current = liveQueueRef.current.then(() => processLiveFinal(transcript, conf));
      } else {
        setInterimSpeech(transcript);
      }
    };

    ws.onerror = () => {
      setStatus("Live speech socket error.");
      stopLiveSpeech();
    };

    ws.onclose = () => {
      stopLiveSpeech();
    };
  }, [processLiveFinal, speechLanguage, stopLiveSpeech]);

  const toggleLiveSpeech = useCallback(async () => {
    if (isListening) {
      stopLiveSpeech();
      return;
    }
    try {
      await startLiveSpeech();
    } catch {
      setStatus("Microphone access denied.");
      stopLiveSpeech();
    }
  }, [isListening, startLiveSpeech, stopLiveSpeech]);

  useEffect(() => () => stopLiveSpeech(), [stopLiveSpeech]);

  const handleTranslateText = useCallback(async () => {
    const text = sourceText.trim();
    if (!text) {
      setStatus("Paste text or upload a document first.");
      return;
    }
    await runTranslation(text, targetLanguage);
    setTextViewTab("translated");
  }, [runTranslation, sourceText, targetLanguage]);

  const handleUploadDocument = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSourceName(file.name);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/sermon-assistant/document-extract", {
        method: "POST",
        body: formData,
      });
      const json = await res.json() as { text?: string; error?: string; truncated?: boolean; originalLength?: number };
      if (!res.ok || !json.text) throw new Error(json.error ?? "Could not extract document text");
      const extracted = json.text.trim();
      setDocumentWasTruncated(Boolean(json.truncated));
      setDocumentOriginalLength(typeof json.originalLength === "number" ? json.originalLength : extracted.length);
      setDocExtractedText(extracted);
      setSourceText(extracted);
      await runTranslation(extracted, targetLanguage);
      setDocumentViewTab("translated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Document upload/translation failed.");
    } finally {
      event.target.value = "";
    }
  }, [runTranslation, targetLanguage]);

  const downloadText = useCallback((name: string, content: string, extension: string) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(name)}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const exportTxt = useCallback(() => {
    const content = mode === "live" ? liveTranslatedText : translatedText;
    if (!content.trim()) return;
    downloadText(`${sourceName || "nexus-translate"}-${targetLanguage}`, content, "txt");
  }, [downloadText, liveTranslatedText, mode, sourceName, targetLanguage, translatedText]);

  const exportJson = useCallback(() => {
    const payload = {
      mode,
      targetLanguage,
      sourceText,
      translatedText,
      liveTurns,
      glossary,
      protectedTerms,
      exportedAt: new Date().toISOString(),
    };
    downloadText(`nexus-translate-${Date.now()}`, JSON.stringify(payload, null, 2), "json");
  }, [downloadText, glossary, liveTurns, mode, protectedTerms, sourceText, targetLanguage, translatedText]);

  const exportSrt = useCallback(() => {
    if (liveTurns.length === 0) return;
    const lines: string[] = [];
    for (let i = 0; i < liveTurns.length; i += 1) {
      const start = i * 3200;
      const end = start + 3000;
      lines.push(String(i + 1));
      lines.push(`${formatSrtTime(start)} --> ${formatSrtTime(end)}`);
      lines.push(`Speaker ${liveTurns[i].speaker}: ${liveTurns[i].translation}`);
      lines.push("");
    }
    downloadText(`nexus-live-${Date.now()}`, lines.join("\n"), "srt");
  }, [downloadText, liveTurns]);

  const exportDocx = useCallback(async () => {
    const { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
    const text = mode === "live" ? liveTranslatedText : translatedText;
    if (!text.trim()) return;
    const title = `Nexus Translate - ${targetLabel}`;
    const doc = new Document({
      creator: "Nexus Director",
      title,
      sections: [{
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
          new Paragraph({
            children: [new TextRun({ text: `Generated ${new Date().toLocaleString()}`, italics: true })],
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({ text: "" }),
          ...text.split(/\r?\n/).map((line) => new Paragraph({ text: line })),
        ],
      }],
    });
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(sourceName || "nexus-translate")}-${targetLanguage}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [liveTranslatedText, mode, sourceName, targetLabel, targetLanguage, translatedText]);

  const saveSession = useCallback(() => {
    const nameBase = sourceName || sourceText.split(/\r?\n/)[0] || `Session ${new Date().toLocaleTimeString()}`;
    const now = new Date().toISOString();
    const session: TranslateSession = {
      id: `session-${Date.now()}`,
      name: nameBase.slice(0, 64),
      createdAt: now,
      updatedAt: now,
      mode,
      targetLanguage,
      sourceText,
      translatedText,
      liveTurns,
    };
    persistSessions([session, ...sessions].slice(0, 100));
    setStatus("Session saved.");
  }, [liveTurns, mode, persistSessions, sessions, sourceName, sourceText, targetLanguage, translatedText]);

  const loadSession = useCallback((session: TranslateSession) => {
    setMode(session.mode);
    setTargetLanguage(session.targetLanguage);
    setSourceText(session.sourceText);
    setTranslatedText(session.translatedText);
    setLiveTurns(session.liveTurns);
    setStatus(`Loaded session: ${session.name}`);
  }, []);

  const confidenceBadge = (confidence: number): string => {
    if (confidence >= 0.86) return "High";
    if (confidence >= 0.68) return "Medium";
    return "Low";
  };

  return (
    <div className="flex min-h-dvh max-h-dvh overflow-hidden bg-shell-950 bg-grid bg-radial-glow safe-area-frame">
      <NexusNav active="translate" onSelect={handleNavSelect} />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),_3.75rem)] lg:pb-0">
        <StatusBar stage="idle" models={[]} />

        <main className="flex min-h-0 w-full flex-1 flex-col gap-3 overflow-y-auto p-2 pb-3 lg:overflow-hidden lg:p-3 lg:pb-3">
          <section className="flex min-h-0 w-full flex-1 flex-col overflow-visible border-b border-cyan-500/20 bg-transparent lg:overflow-hidden lg:rounded-2xl lg:border lg:border-cyan-500/20 lg:bg-slate-950/60">
            <header className="sticky top-0 z-10 flex shrink-0 flex-col gap-2 border-b border-cyan-500/20 bg-slate-950/90 px-3 py-2 backdrop-blur sm:px-4">
              {/* Row 1: title + status */}
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-bold text-slate-100 sm:text-base">Nexus Translate</h1>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Editorial Studio</p>
                </div>
                <p className="shrink-0 text-[10px] text-slate-400">{status}</p>
              </div>

              {/* Row 2: mode switcher + language */}
              <div className="flex items-center gap-2">
                <div className="inline-flex shrink-0 items-center rounded-xl border border-slate-700/70 bg-slate-900/70 p-0.5">
                  {(["text", "document", "live"] as WorkMode[]).map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setMode(item)}
                      className={`focus-ring min-h-9 rounded-lg px-2.5 text-[10px] font-bold uppercase tracking-wide transition-colors duration-150 ${
                        mode === item ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400"
                      }`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <select
                  value={targetLanguage}
                  onChange={(event) => setTargetLanguage(event.target.value as TranslateLanguage)}
                  className="focus-ring h-9 min-w-0 flex-1 rounded-xl border border-cyan-500/35 bg-slate-900 px-2 text-base font-semibold text-cyan-200"
                  aria-label="Translation target language"
                >
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              {/* Row 3: action strip — horizontally scrollable on mobile */}
              <div className={`-mx-1 items-center gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${mode === "live" ? "hidden sm:flex" : "flex"}`}>
                <button
                  type="button"
                  onClick={saveSession}
                  className="focus-ring shrink-0 min-h-9 rounded-lg border border-slate-600/80 px-3 text-xs font-semibold text-slate-200"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={exportTxt}
                  className="focus-ring shrink-0 min-h-9 rounded-lg border border-emerald-500/45 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-300"
                >
                  TXT
                </button>
                <button
                  type="button"
                  onClick={() => void exportDocx()}
                  className="focus-ring shrink-0 min-h-9 rounded-lg border border-slate-600/80 px-3 text-xs font-semibold text-slate-200"
                >
                  DOCX
                </button>
                <button
                  type="button"
                  onClick={exportSrt}
                  className="focus-ring shrink-0 min-h-9 rounded-lg border border-slate-600/80 px-3 text-xs font-semibold text-slate-200"
                >
                  SRT
                </button>
                <button
                  type="button"
                  onClick={exportJson}
                  className="focus-ring shrink-0 min-h-9 rounded-lg border border-slate-600/80 px-3 text-xs font-semibold text-slate-200"
                >
                  JSON
                </button>
                {mode === "document" && (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={isTranslating}
                    className="focus-ring shrink-0 min-h-9 rounded-lg border border-emerald-500/45 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-300 disabled:opacity-60"
                  >
                    {isTranslating ? `Processing ${progress}%` : "Upload"}
                  </button>
                )}
              </div>
            </header>

            <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="grid min-h-0 gap-3 overflow-hidden">
                {mode === "text" && (
                  <div className="flex min-h-0 flex-1 flex-col gap-3">
                    <div className="flex items-center gap-2 overflow-x-auto rounded-xl border border-cyan-500/20 bg-slate-950/70 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      <button
                        type="button"
                        onClick={() => setTextViewTab("source")}
                        className={`focus-ring min-h-10 shrink-0 rounded-lg px-3 text-xs font-bold uppercase tracking-wide ${textViewTab === "source" ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400"}`}
                      >
                        Source
                      </button>
                      <button
                        type="button"
                        onClick={() => setTextViewTab("translated")}
                        className={`focus-ring min-h-10 shrink-0 rounded-lg px-3 text-xs font-bold uppercase tracking-wide ${textViewTab === "translated" ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400"}`}
                      >
                        Translated
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleTranslateText()}
                        disabled={isTranslating}
                        className="focus-ring ml-auto min-h-10 shrink-0 rounded-lg border border-cyan-500/50 bg-cyan-500/15 px-3 text-xs font-semibold text-cyan-200 disabled:opacity-60"
                      >
                        {isTranslating ? `Translating ${progress}%` : "Translate"}
                      </button>
                    </div>

                    <div className="min-h-[35dvh] min-w-0 flex-1 overflow-hidden rounded-xl border border-cyan-500/15 bg-slate-950/70 lg:min-h-0">
                      <div className="border-b border-cyan-500/10 px-4 py-3">
                        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{textViewTab === "source" ? "Source Text" : `Translation (${targetLabel})`}</p>
                      </div>
                      {textViewTab === "source" ? (
                        <textarea
                          value={sourceText}
                          onChange={(event) => setSourceText(event.target.value)}
                          placeholder="Paste source content here..."
                          className="focus-ring h-[calc(100%-49px)] min-h-[calc(35dvh-49px)] w-full resize-none border-0 bg-transparent p-4 text-base leading-relaxed text-slate-100 placeholder:text-slate-500"
                        />
                      ) : (
                        <div className="h-[calc(100%-49px)] min-h-[calc(35dvh-49px)] overflow-y-auto p-4 text-base leading-relaxed text-slate-100">
                          {translatedText ? <p className="whitespace-pre-wrap break-words">{translatedText}</p> : <p className="text-slate-500">Translation output appears here.</p>}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {mode === "document" && (
                  <div className="flex min-h-0 flex-1 flex-col gap-3">
                    <div className="flex items-center gap-2 overflow-x-auto rounded-xl border border-cyan-500/20 bg-slate-950/70 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      <button
                        type="button"
                        onClick={() => setDocumentViewTab("source")}
                        className={`focus-ring min-h-10 shrink-0 rounded-lg px-3 text-xs font-bold uppercase tracking-wide ${documentViewTab === "source" ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400"}`}
                      >
                        Source Document
                      </button>
                      <button
                        type="button"
                        onClick={() => setDocumentViewTab("translated")}
                        className={`focus-ring min-h-10 shrink-0 rounded-lg px-3 text-xs font-bold uppercase tracking-wide ${documentViewTab === "translated" ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400"}`}
                      >
                        Translated
                      </button>
                      <span className="ml-auto shrink-0 text-xs text-slate-500">{sourceName ? `Loaded: ${sourceName}` : "No file selected"}</span>
                    </div>

                    <input
                      ref={fileRef}
                      type="file"
                      accept=".txt,.md,.markdown,.srt,.csv,.tsv,.json,.pdf"
                      className="hidden"
                      onChange={handleUploadDocument}
                    />

                    {isTranslating && (
                      <div className="shrink-0 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                        <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${progress}%` }} />
                      </div>
                    )}
                    {documentWasTruncated && (
                      <p className="shrink-0 text-xs text-amber-300">
                        Document was truncated for processing. Showing {docExtractedText.length.toLocaleString()} of {documentOriginalLength?.toLocaleString() ?? docExtractedText.length.toLocaleString()} characters.
                      </p>
                    )}

                    <div className="min-h-[35dvh] min-w-0 flex-1 overflow-hidden rounded-xl border border-cyan-500/15 bg-slate-950/70 lg:min-h-0">
                      <div className="border-b border-cyan-500/10 px-4 py-3">
                        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                          {documentViewTab === "source" ? "Source Document" : `Translated Document (${targetLabel})`}
                        </p>
                      </div>
                      <div className="h-[calc(100%-49px)] min-h-[calc(35dvh-49px)] overflow-y-auto p-4 text-base leading-relaxed text-slate-100">
                        {documentViewTab === "source"
                          ? (docExtractedText ? <p className="whitespace-pre-wrap break-words text-slate-300">{docExtractedText}</p> : <p className="text-slate-500">Extracted document appears here.</p>)
                          : (translatedText ? <p className="whitespace-pre-wrap break-words">{translatedText}</p> : <p className="text-slate-500">Document translation output appears here.</p>)}
                      </div>
                    </div>
                  </div>
                )}

                {mode === "live" && (
                  <div className="grid min-h-0 gap-3">
                    <div className="grid grid-cols-2 items-center gap-2 rounded-xl border border-cyan-500/20 bg-slate-950/70 p-2 sm:grid-cols-[190px_160px_140px_auto_auto]">
                      <select
                        value={speechLanguage}
                        onChange={(event) => setSpeechLanguage(event.target.value as SpeechLanguage)}
                        className="focus-ring h-9 rounded-xl border border-slate-600/50 bg-slate-900 px-3 text-base font-semibold text-slate-200"
                      >
                        <option value="auto">Auto</option>
                        <option value="english">English</option>
                        <option value="spanish">Spanish</option>
                        <option value="french">French</option>
                        <option value="portuguese">Portuguese</option>
                        <option value="german">German</option>
                        <option value="swahili">Swahili</option>
                        <option value="twi">Twi</option>
                        <option value="kikuyu">Kikuyu</option>
                      </select>

                      <select
                        value={controlMode}
                        onChange={(event) => setControlMode(event.target.value as ControlMode)}
                        className="focus-ring h-9 rounded-xl border border-slate-600/50 bg-slate-900 px-3 text-base font-semibold text-slate-200"
                      >
                        <option value="tap">Tap Mode</option>
                        <option value="hold">Hold Mode</option>
                      </select>

                      <button
                        type="button"
                        onClick={() => setActiveSpeaker((prev) => (prev === "A" ? "B" : "A"))}
                        className="focus-ring min-h-10 rounded-xl border border-slate-700/80 px-4 text-sm font-semibold text-slate-200"
                      >
                        Speaker {activeSpeaker}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          if (controlMode === "tap") {
                            void toggleLiveSpeech();
                          }
                        }}
                        onPointerDown={() => {
                          if (controlMode === "hold" && !isListening) {
                            void startLiveSpeech();
                          }
                        }}
                        onPointerUp={() => {
                          if (controlMode === "hold" && isListening) {
                            stopLiveSpeech();
                          }
                        }}
                        className={`focus-ring min-h-10 rounded-xl px-4 text-sm font-bold ${
                          isListening ? "border border-cyan-400/60 bg-cyan-500/20 text-cyan-300" : "border border-cyan-500/50 bg-cyan-500/15 text-cyan-300"
                        }`}
                      >
                        {controlMode === "hold" ? (isListening ? "Release to Stop" : "Hold to Talk") : (isListening ? "Stop Live" : "Start Live")}
                      </button>

                      <label className="col-span-2 flex min-h-10 items-center gap-2 rounded-xl border border-slate-700/80 px-3 text-sm text-slate-300 sm:col-span-1">
                        <input
                          type="checkbox"
                          checked={cleanupEnabled}
                          onChange={(event) => setCleanupEnabled(event.target.checked)}
                          className="h-4 w-4"
                        />
                        Cleanup transcript
                      </label>
                    </div>

                    <div className="grid min-h-0 gap-3 lg:grid-cols-2">
                      <div className="min-h-[52dvh] overflow-hidden rounded-xl border border-cyan-500/15 bg-slate-950/70 lg:min-h-0">
                        <div className="border-b border-cyan-500/10 px-4 py-3">
                          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Interpreter Feed</p>
                        </div>
                        <div className="h-[calc(100%-49px)] min-h-[calc(52dvh-49px)] space-y-2 overflow-y-auto p-4">
                          {liveTurns.length === 0 && !interimSpeech ? (
                            <p className="text-slate-500">No live turns yet. Start live mode to capture speech and translation.</p>
                          ) : (
                            <>
                              {liveTurns.map((turn) => (
                                <article key={turn.id} className="rounded-lg border border-slate-700/70 bg-slate-900/70 p-3">
                                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                                    <span>Speaker {turn.speaker}</span>
                                    <span>Confidence {confidenceBadge(turn.confidence)}</span>
                                    <span>{turn.latencyMs}ms</span>
                                  </div>
                                  <p className="mt-2 text-sm text-slate-200">{turn.source}</p>
                                  <p className="mt-2 text-sm text-cyan-200">{turn.translation}</p>
                                </article>
                              ))}
                              {interimSpeech && (
                                <p className="rounded-lg border border-cyan-500/35 bg-cyan-500/10 p-3 text-sm italic text-cyan-200">Interim: {interimSpeech}</p>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      <div className="hidden min-h-[42dvh] overflow-hidden rounded-xl border border-cyan-500/15 bg-slate-950/70 lg:block lg:min-h-0">
                        <div className="border-b border-cyan-500/10 px-4 py-3">
                          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Live Transcript + Translation</p>
                        </div>
                        <div className="h-[calc(100%-49px)] min-h-[calc(42dvh-49px)] space-y-3 overflow-y-auto p-4 text-sm">
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Source</p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-slate-200">{liveSourceText || "No source transcript yet."}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Translation ({targetLabel})</p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-cyan-200">{liveTranslatedText || "No translated lines yet."}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <aside className="hidden min-h-0 overflow-hidden rounded-xl border border-cyan-500/20 bg-slate-950/70 lg:block lg:h-full">
                <div className="border-b border-cyan-500/10 px-4 py-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Terminology Guard</p>
                </div>
                <div className="space-y-3 overflow-y-auto p-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Glossary (source =&gt; target)</p>
                    <textarea
                      value={glossaryText}
                      onChange={(event) => setGlossaryText(event.target.value)}
                      placeholder="Grace => Grâce"
                      className="focus-ring mt-2 h-28 w-full resize-none rounded-lg border border-slate-700/70 bg-slate-900/70 p-3 text-base text-slate-200 placeholder:text-slate-500"
                    />
                  </div>

                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Protected Terms (comma/new line)</p>
                    <textarea
                      value={protectedTermsText}
                      onChange={(event) => setProtectedTermsText(event.target.value)}
                      placeholder="Yahweh, Jerusalem"
                      className="focus-ring mt-2 h-24 w-full resize-none rounded-lg border border-slate-700/70 bg-slate-900/70 p-3 text-base text-slate-200 placeholder:text-slate-500"
                    />
                  </div>

                  <div className="rounded-lg border border-slate-700/70 bg-slate-900/70 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Session Library</p>
                    <input
                      type="text"
                      value={sessionSearch}
                      onChange={(event) => setSessionSearch(event.target.value)}
                      placeholder="Search sessions..."
                      className="focus-ring mt-2 h-10 w-full rounded-lg border border-slate-700/70 bg-slate-950/80 px-3 text-base text-slate-100 placeholder:text-slate-500"
                    />
                    <div className="mt-2 max-h-60 space-y-2 overflow-y-auto">
                      {filteredSessions.length === 0 ? (
                        <p className="text-xs text-slate-500">No sessions found.</p>
                      ) : (
                        filteredSessions.map((session) => (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() => loadSession(session)}
                            className="focus-ring min-h-12 w-full rounded-lg border border-slate-700/70 bg-slate-950/70 px-3 py-2 text-left"
                          >
                            <p className="text-xs font-semibold text-slate-200">{session.name}</p>
                            <p className="text-[10px] text-slate-500">{new Date(session.updatedAt).toLocaleString()} - {session.mode}</p>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </aside>
            </div>
          </section>

          <button
            type="button"
            onClick={() => setMobileTerminologyOpen(true)}
            className="focus-ring fixed bottom-[calc(max(env(safe-area-inset-bottom),4.25rem)+0.5rem)] right-3 z-40 min-h-12 rounded-xl border border-cyan-400/40 bg-slate-900/90 px-4 text-sm font-semibold text-cyan-200 shadow-glow lg:hidden"
          >
            Terminology
          </button>

          {mobileTerminologyOpen && (
            <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Terminology guard panel">
              <button
                type="button"
                onClick={() => setMobileTerminologyOpen(false)}
                className="absolute inset-0 bg-slate-950/70"
                aria-label="Close terminology panel"
              />
              <section className="absolute inset-x-0 bottom-0 max-h-[70dvh] overflow-hidden rounded-t-2xl border border-cyan-500/25 bg-slate-950/95">
                <header className="flex items-center justify-between border-b border-cyan-500/15 px-4 py-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-300">Terminology Guard</p>
                  <button type="button" onClick={() => setMobileTerminologyOpen(false)} className="focus-ring min-h-10 rounded-lg border border-slate-700 px-3 text-xs text-slate-300">Close</button>
                </header>
                <div className="space-y-3 overflow-y-auto p-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Glossary (source =&gt; target)</p>
                    <textarea
                      value={glossaryText}
                      onChange={(event) => setGlossaryText(event.target.value)}
                      placeholder="Grace => Grâce"
                      className="focus-ring mt-2 h-28 w-full resize-none rounded-lg border border-slate-700/70 bg-slate-900/70 p-3 text-base text-slate-200 placeholder:text-slate-500"
                    />
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Protected Terms (comma/new line)</p>
                    <textarea
                      value={protectedTermsText}
                      onChange={(event) => setProtectedTermsText(event.target.value)}
                      placeholder="Yahweh, Jerusalem"
                      className="focus-ring mt-2 h-24 w-full resize-none rounded-lg border border-slate-700/70 bg-slate-900/70 p-3 text-base text-slate-200 placeholder:text-slate-500"
                    />
                  </div>
                </div>
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
