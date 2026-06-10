"use client";

/**
 * GlobalMiniPlayer
 *
 * A sticky bottom bar that appears on any page when the audio reader is
 * active but the user has navigated away from the reader.  Lets them
 * play / pause / stop without going back to the book, and provides a
 * direct link back to the reader.
 *
 * Visibility logic:
 *   – Hidden when audio state is "idle" (nothing playing)
 *   – Hidden when already ON the reader page (AudioReader handles controls there)
 *   – Shown on every other route inside the app
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAudioPlayer, RATES } from "@/lib/audio-player-context";

export function GlobalMiniPlayer() {
  const {
    state, currentSeg, segIdx, segTotal, rateIdx,
    chapterMeta, play, pause, resume, stop, cycleRate,
  } = useAudioPlayer();

  const pathname = usePathname();

  // Don't render when idle or no chapter loaded
  if (state === "idle" || !chapterMeta) return null;

  // Don't render when the user is already on the reader page
  if (pathname.startsWith(chapterMeta.readerHref)) return null;

  const isPlaying  = state === "playing";
  const progressPct = segTotal > 0 ? Math.round((segIdx / segTotal) * 100) : 0;

  const togglePlay = () => {
    if      (state === "playing") pause();
    else if (state === "paused")  resume();
    else                          play();
  };

  return (
    <>
      {/* EQ bar keyframes (shared with AudioReader) */}
      <style>{`
        @keyframes nxGEqA { 0%,100%{height:3px} 50%{height:9px} }
        @keyframes nxGEqB { 0%,100%{height:6px} 40%{height:2px} 80%{height:11px} }
        @keyframes nxGEqC { 0%,100%{height:4px} 60%{height:10px} }
      `}</style>

      {/*
        Positioned above the mobile bottom nav (pb-20 lg:pb-0) per copilot-instructions.
        Safe-area-inset-bottom accounts for iPhone home bar.
      */}
      <div
        style={{
          position:        "fixed",
          bottom:          0,
          left:            0,
          right:           0,
            // z-52 sits above NexusNav (z-50) and overlays on all pages
            zIndex:        52,
            // Push the card above: nav height (≈3.5rem) + safe-area on notched phones
            bottom:        "max(calc(3.75rem + env(safe-area-inset-bottom)), 4.25rem)",
            pointerEvents: "none",
        }}
      >
        <div
          style={{
            margin:           "0 0.75rem",
            background:       "rgba(10,8,6,0.92)",
            backdropFilter:   "blur(28px)",
            WebkitBackdropFilter: "blur(28px)",
            border:           "1px solid rgba(255,255,255,0.1)",
            borderRadius:     "1rem",
            overflow:         "hidden",
            boxShadow:        "0 8px 32px rgba(0,0,0,0.6)",
            pointerEvents:    "auto",
          }}
        >
          {/* Progress line */}
          <div style={{ height: "2px", background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${progressPct}%`,
              background: "linear-gradient(to right, #c4933a99, #c4933a)",
              transition: "width 0.5s ease",
            }} />
          </div>

          {/* Controls row */}
          <div style={{
            display: "flex", alignItems: "center", gap: "0.5rem",
            padding: "0.6rem 0.9rem",
            minHeight: "3.25rem",
          }}>
            {/* Animated EQ / static dot */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: "11px", flexShrink: 0 }}>
              {[
                { a: "nxGEqA", d: "0.75s", dl: "0ms",   h: 4 },
                { a: "nxGEqB", d: "0.9s",  dl: "130ms", h: 7 },
                { a: "nxGEqC", d: "0.65s", dl: "260ms", h: 5 },
              ].map((bar, i) => (
                <div key={i} style={{
                  width: "3px", height: `${bar.h}px`, borderRadius: "2px",
                  background: "#c4933a",
                  opacity: isPlaying ? 1 : 0.35,
                  animation: isPlaying
                    ? `${bar.a} ${bar.d} ease-in-out infinite`
                    : "none",
                  animationDelay: bar.dl,
                }} />
              ))}
            </div>

            {/* Title + chapter info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{
                margin: 0, lineHeight: 1.25,
                fontSize: "0.72rem", fontWeight: 600,
                color: "#f0e8d8",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {chapterMeta.bookTitle}
              </p>
              <p style={{
                margin: "0.1rem 0 0", lineHeight: 1.2,
                fontSize: "0.6rem", color: "rgba(240,232,216,0.55)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {isPlaying ? "Now reading · " : "Paused · "}
                Ch {chapterMeta.number} — {chapterMeta.title}
                {currentSeg ? ` · ${currentSeg.type === "chapter-title" ? "intro" : currentSeg.type}` : ""}
              </p>
            </div>

            {/* Speed pill */}
            <button
              onClick={cycleRate}
              aria-label="Change speed"
              style={{
                fontSize: "0.65rem", fontWeight: 700,
                color: "#c4933a",
                background: "rgba(196,147,58,0.12)",
                border: "1px solid rgba(196,147,58,0.25)",
                borderRadius: "999px", padding: "0.2rem 0.6rem",
                cursor: "pointer", minHeight: "2rem", flexShrink: 0,
              }}
            >
              {RATES[rateIdx]}×
            </button>

            {/* Play / Pause */}
            <button
              onClick={togglePlay}
              aria-label={isPlaying ? "Pause" : "Play"}
              style={{
                width: "2.35rem", height: "2.35rem", borderRadius: "50%",
                background: "#c4933a",
                boxShadow: isPlaying
                  ? "0 0 0 3px rgba(196,147,58,0.25), 0 2px 10px rgba(196,147,58,0.4)"
                  : "0 2px 8px rgba(196,147,58,0.25)",
                border: "none", cursor: "pointer", color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
                transition: "box-shadow 0.2s ease",
              }}
            >
              {isPlaying ? (
                <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.8rem", height: "0.8rem" }}>
                  <rect x="6" y="5" width="4" height="14" rx="1.5" />
                  <rect x="14" y="5" width="4" height="14" rx="1.5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.8rem", height: "0.8rem" }}>
                  <path d="M8 5.14v14l11-7-11-7z" />
                </svg>
              )}
            </button>

            {/* Stop */}
            <button
              onClick={stop}
              aria-label="Stop audio"
              style={{
                width: "2.1rem", height: "2.1rem",
                background: "none",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: "50%", cursor: "pointer",
                color: "rgba(240,232,216,0.5)",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.7rem", height: "0.7rem" }}>
                <rect x="5" y="5" width="14" height="14" rx="3" />
              </svg>
            </button>

            {/* Back-to-reader link */}
            <Link
              href={chapterMeta.readerHref}
              aria-label="Back to reader"
              style={{
                width: "2.1rem", height: "2.1rem",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "none",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: "50%", cursor: "pointer",
                color: "rgba(240,232,216,0.5)",
                flexShrink: 0,
                textDecoration: "none",
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                style={{ width: "0.75rem", height: "0.75rem" }}>
                <path d="M12 6l-6 6 6 6M6 12h12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
