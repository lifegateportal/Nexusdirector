"use client";

import type { ReaderSettings } from "@/lib/reader-store";

export type ReaderTheme = {
  bg: string; text: string; heading: string; muted: string; accent: string;
  border: string; chrome: string; chromeBorder: string;
};

const FONT_LABELS: Record<number, string> = { 1: "XS", 2: "S", 3: "M", 4: "L", 5: "XL" };

type Props = {
  settings:   ReaderSettings;
  open:       boolean;
  onClose:    () => void;
  onChange:   (patch: Partial<ReaderSettings>) => void;
  t:          ReaderTheme;
  fontFamily: string;
};

const THEMES: { key: ReaderSettings["theme"]; label: string; bg: string; fg: string }[] = [
  { key: "night",     label: "Night",     bg: "#1c1510", fg: "#e8dcc8" },
  { key: "parchment", label: "Parchment", bg: "#f4e9d0", fg: "#2c1a0e" },
  { key: "paper",     label: "Paper",     bg: "#fafafa", fg: "#1a1a1a" },
];

export function ReaderSettingsPanel({ settings, open, onClose, onChange, t, fontFamily }: Props) {
  function optBtn(active: boolean) {
    return {
      display:      "flex",
      alignItems:   "center",
      justifyContent: "center",
      minHeight:    "2.75rem",
      padding:      "0 0.875rem",
      borderRadius: "0.625rem",
      border:       `1px solid ${active ? t.accent : t.border}`,
      background:   active ? `${t.accent}22` : "transparent",
      color:        active ? t.accent : t.muted,
      fontFamily,
      fontSize:     "0.8rem",
      fontWeight:   active ? 700 : 400,
      cursor:       "pointer",
      transition:   "all 0.15s",
    } as React.CSSProperties;
  }

  return (
    <>
      {open && (
        <div
          onClick={onClose}
          style={{
            position:   "fixed",
            inset:      0,
            zIndex:     48,
            background: "rgba(0,0,0,0.4)",
            backdropFilter: "blur(2px)",
          }}
        />
      )}

      <aside
        style={{
          position:  "fixed",
          top:       "3.25rem",
          right:     0,
          zIndex:    49,
          width:     "min(300px, 100%)",
          background: t.chrome,
          borderLeft: `1px solid ${t.chromeBorder}`,
          borderBottom: `1px solid ${t.chromeBorder}`,
          borderBottomLeftRadius: "1rem",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          transform: open ? "translateY(0)" : "translateY(-110%)",
          opacity:   open ? 1 : 0,
          transition: "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s",
          padding:   "1.25rem",
          display:   "flex",
          flexDirection: "column",
          gap:       "1.5rem",
        }}
        aria-hidden={!open}
      >
        {/* Reading theme */}
        <div>
          <p style={{ fontFamily, fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: t.muted, marginBottom: "0.75rem" }}>
            Theme
          </p>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            {THEMES.map(({ key, label, bg, fg }) => (
              <button
                key={key}
                onClick={() => onChange({ theme: key })}
                title={label}
                style={{
                  flex:         1,
                  height:       "3rem",
                  borderRadius: "0.75rem",
                  background:   bg,
                  border:       `2px solid ${settings.theme === key ? t.accent : "transparent"}`,
                  cursor:       "pointer",
                  display:      "flex",
                  alignItems:   "center",
                  justifyContent: "center",
                  transition:   "border-color 0.15s",
                }}
              >
                <span style={{ fontSize: "0.65rem", fontWeight: 700, color: fg, fontFamily: "Georgia, serif" }}>
                  {label[0]}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Font size */}
        <div>
          <p style={{ fontFamily, fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: t.muted, marginBottom: "0.75rem" }}>
            Font Size
          </p>
          <div style={{ display: "flex", gap: "0.375rem" }}>
            {([1, 2, 3, 4, 5] as const).map((s) => (
              <button key={s} onClick={() => onChange({ fontSize: s })} style={optBtn(settings.fontSize === s)}>
                {FONT_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        {/* Line height */}
        <div>
          <p style={{ fontFamily, fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: t.muted, marginBottom: "0.75rem" }}>
            Spacing
          </p>
          <div style={{ display: "flex", gap: "0.375rem" }}>
            {([1, 2, 3] as const).map((lh) => {
              const label = lh === 1 ? "Tight" : lh === 2 ? "Normal" : "Loose";
              return (
                <button key={lh} onClick={() => onChange({ lineHeight: lh })} style={optBtn(settings.lineHeight === lh)}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Font family */}
        <div>
          <p style={{ fontFamily, fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: t.muted, marginBottom: "0.75rem" }}>
            Typeface
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button onClick={() => onChange({ fontFamily: "serif" })} style={{ ...optBtn(settings.fontFamily === "serif"), fontFamily: "Georgia, serif", flex: 1 }}>
              Serif
            </button>
            <button onClick={() => onChange({ fontFamily: "sans" })} style={{ ...optBtn(settings.fontFamily === "sans"), fontFamily: "system-ui, sans-serif", flex: 1 }}>
              Sans
            </button>
          </div>
        </div>

        {/* Bionic reading mode */}
        <div>
          <p style={{ fontFamily, fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: t.muted, marginBottom: "0.6rem" }}>
            Reading Mode
          </p>
          <button
            onClick={() => onChange({ bionicMode: !settings.bionicMode })}
            style={{
              width: "100%", display: "flex", alignItems: "center",
              justifyContent: "space-between",
              minHeight: "2.75rem", padding: "0 0.875rem",
              borderRadius: "0.625rem",
              border: `1px solid ${settings.bionicMode ? t.accent : t.border}`,
              background: settings.bionicMode ? `${t.accent}22` : "transparent",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            <span style={{
              fontFamily: "Georgia, serif", fontSize: "0.82rem",
              color: settings.bionicMode ? t.accent : t.muted,
            }}>
              <strong style={{ fontWeight: 800 }}>Bio</strong>
              <span style={{ opacity: 0.65 }}>nic</span>{" "}
              <strong style={{ fontWeight: 800 }}>Rea</strong>
              <span style={{ opacity: 0.65 }}>ding</span>
            </span>
            {/* Toggle pill */}
            <span style={{
              display: "inline-flex", alignItems: "center",
              width: "2.25rem", height: "1.25rem",
              borderRadius: "999px",
              background: settings.bionicMode ? t.accent : t.border,
              transition: "background 0.2s",
              padding: "0.15rem",
              flexShrink: 0,
            }}>
              <span style={{
                display: "block", width: "0.9rem", height: "0.9rem",
                borderRadius: "50%", background: "#fff",
                transform: settings.bionicMode ? "translateX(1rem)" : "translateX(0)",
                transition: "transform 0.2s",
              }} />
            </span>
          </button>
          <p style={{ fontSize: "0.58rem", color: t.muted, fontFamily, marginTop: "0.45rem", opacity: 0.7 }}>
            Bold fixation points guide your eye for faster reading.
          </p>
        </div>
      </aside>
    </>
  );
}
