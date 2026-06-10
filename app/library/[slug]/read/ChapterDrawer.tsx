"use client";

export type ReaderTheme = {
  bg: string; text: string; heading: string; muted: string; accent: string;
  border: string; chrome: string; chromeBorder: string;
};

export type TocItem = {
  label: string;  // e.g. "Ch 1", "Preface", "Conclusion"
  title: string;
};

type Props = {
  items:        TocItem[];
  currentIndex: number;
  open:         boolean;
  onClose:      () => void;
  onSelect:     (index: number) => void;
  t:            ReaderTheme;
  fontFamily:   string;
};

export function ChapterDrawer({
  items, currentIndex, open, onClose, onSelect, t, fontFamily,
}: Props) {
  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          onClick={onClose}
          style={{
            position: "fixed", inset: 0, zIndex: 48,
            background: "rgba(0,0,0,0.55)",
            backdropFilter: "blur(2px)",
          }}
        />
      )}

      {/* Drawer panel — slides in from the right */}
      <nav
        style={{
          position:  "fixed",
          top:       0,
          right:     0,
          bottom:    0,
          zIndex:    49,
          width:     "min(320px, 100%)",
          background: t.chrome,
          borderLeft: `1px solid ${t.chromeBorder}`,
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)",
          display:   "flex",
          flexDirection: "column",
          overflowY: "hidden",
        }}
        aria-hidden={!open}
      >
        {/* Header */}
        <div
          style={{
            display:        "flex",
            alignItems:     "center",
            justifyContent: "space-between",
            padding:        "1.25rem 1.25rem 1rem",
            borderBottom:   `1px solid ${t.border}`,
            flexShrink:     0,
          }}
        >
          <p style={{ fontFamily, fontSize: "0.65rem", fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: t.muted }}>
            Contents
          </p>
          <button
            onClick={onClose}
            aria-label="Close contents"
            style={{ minHeight: "2.75rem", minWidth: "2.75rem", display: "flex", alignItems: "center", justifyContent: "center", color: t.muted, background: "none", border: "none", cursor: "pointer" }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: "1.1rem", height: "1.1rem" }}>
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Chapter list */}
        <ol
          style={{
            flex:      1,
            overflowY: "auto",
            padding:   "0.75rem 0.75rem",
            listStyle: "none",
            margin:    0,
          }}
        >
          {items.map((item, i) => {
            const active = i === currentIndex;
            return (
              <li key={i}>
                <button
                  onClick={() => onSelect(i)}
                  style={{
                    display:     "flex",
                    alignItems:  "center",
                    gap:         "0.875rem",
                    width:       "100%",
                    padding:     "0.75rem 0.75rem",
                    marginBottom: "0.125rem",
                    borderRadius: "0.75rem",
                    background:  active ? `${t.accent}22` : "transparent",
                    border:      "none",
                    cursor:      "pointer",
                    textAlign:   "left",
                    transition:  "background 0.15s",
                  }}
                >
                  <span
                    style={{
                      flexShrink:  0,
                      minWidth:    "2.5rem",
                      textAlign:   "right",
                      fontSize:    "0.62rem",
                      fontWeight:  700,
                      color:       active ? t.accent : t.muted,
                      fontFamily,
                      letterSpacing: "0.04em",
                    }}
                  >
                    {item.label}
                  </span>
                  <span
                    style={{
                      flex:       1,
                      fontSize:   "0.85rem",
                      fontFamily: "Georgia, serif",
                      color:      active ? t.heading : t.text,
                      lineHeight: 1.4,
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {item.title}
                  </span>
                  {active && (
                    <span
                      style={{
                        flexShrink:  0,
                        width:       "0.4rem",
                        height:      "0.4rem",
                        borderRadius: "50%",
                        background:  t.accent,
                      }}
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
