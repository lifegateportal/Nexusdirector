"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { IngestResultSchema } from "@/lib/schemas/blueprint";
import type { IngestResult } from "@/lib/schemas/blueprint";
import type { LogEntry, PipelineStage } from "@/lib/types";

type PromptBarProps = {
  stage: PipelineStage;
  onLog: (entry: Omit<LogEntry, "id" | "timestamp">) => void;
  onBlueprint: (result: IngestResult, sourceText: string) => void;
  onStageChange: (stage: PipelineStage) => void;
  onDeliveryChange?: (text: string) => void;
};

export function PromptBar({ stage, onLog, onBlueprint, onStageChange, onDeliveryChange }: PromptBarProps) {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [showDelivery, setShowDelivery] = useState(false);
  const [deliveryText, setDeliveryText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load persisted delivery instructions client-side only (avoids SSR hydration mismatch)
  useEffect(() => {
    const saved = localStorage.getItem("nexus_delivery_instructions");
    if (saved) { setDeliveryText(saved); onDeliveryChange?.(saved); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isIdle = stage === "idle" || stage === "done" || stage === "error";
  const canSubmit = isIdle && !running && prompt.trim().length > 0;

  const handleRun = useCallback(async () => {
    const text = prompt.trim();
    if (!text || !isIdle || running) return;

    setRunning(true);
    onStageChange("ingesting");
    onLog({ level: "info", message: "Prompt dispatched to Analyst…" });
    onLog({
      level: "stream",
      message: text.length > 100 ? text.slice(0, 100) + "…" : text,
    });

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceText: text, locale: "en" }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const raw: unknown = await res.json();
      const result = IngestResultSchema.parse(raw);
      onBlueprint(result, text);
      // Stage management handed to the pipeline orchestrator in page.tsx
      setPrompt("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Pipeline error";
      onLog({ level: "error", message: msg });
      onStageChange("error");
    } finally {
      setRunning(false);
    }
  }, [prompt, isIdle, running, onLog, onBlueprint, onStageChange]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleRun();
    }
  };

  return (
    <div className="flex-shrink-0 border-t border-slate-700/50 glass-light px-4 pt-3 pb-3">
      <div className="flex items-end gap-3">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!isIdle || running}
          placeholder='Describe what to build…'
          rows={2}
          className="flex-1 resize-none rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-cyan-500/60 focus:outline-none focus:ring-1 focus:ring-cyan-500/30 disabled:opacity-40"
        />
        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={!canSubmit}
          className="flex min-h-12 min-w-[112px] flex-shrink-0 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-5 text-sm font-semibold text-slate-950 shadow-glow transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {running ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              <span>Running…</span>
            </>
          ) : (
            <>
              <span>Run Pipeline</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
                <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </>
          )}
        </button>
      </div>
      <p className="mt-1.5 hidden text-[11px] text-slate-600 sm:block">⌘ Return to run · or drop files in the panel above</p>

      {/* Delivery preferences toggle */}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowDelivery((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] text-slate-500 transition hover:text-slate-300"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-3 w-3">
            <path d="M12 2a4 4 0 0 1 4 4 4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4zm0 10c4.42 0 8 1.79 8 4v2H4v-2c0-2.21 3.58-4 8-4z" />
          </svg>
          Delivery preferences
          <span className="text-slate-700">{showDelivery ? "▲" : "▼"}</span>
        </button>
        {deliveryText && !showDelivery && (
          <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-400">active</span>
        )}
      </div>

      {showDelivery && (
        <textarea
          value={deliveryText}
          onChange={(e) => {
            const v = e.target.value;
            setDeliveryText(v);
            localStorage.setItem("nexus_delivery_instructions", v);
            onDeliveryChange?.(v);
          }}
          placeholder='How should the course be delivered? e.g. “Weekly modules, casual tone, target complete beginners, end each lesson with a hands-on exercise”'
          rows={3}
          className="mt-2 w-full resize-none rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-3 text-base text-slate-100 placeholder:text-slate-600 focus:border-cyan-500/60 focus:outline-none"
        />
      )}
    </div>
  );
}
