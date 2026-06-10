"use client";

import { useState, useEffect, useCallback } from "react";

export type AnnotationColor = "amber" | "rose" | "sky" | "emerald";

export interface Annotation {
  id:           string;
  slug:         string;
  chapterIndex: number;
  chapterTitle: string;
  selectedText: string;
  note:         string;
  color:        AnnotationColor;
  createdAt:    number;
}

export const ANNO_COLOR_MAP: Record<AnnotationColor, { bg: string; border: string; dot: string }> = {
  amber:   { bg: "rgba(251,191,36,0.22)",  border: "#f59e0b", dot: "#f59e0b" },
  rose:    { bg: "rgba(251,113,133,0.22)", border: "#f43f5e", dot: "#f43f5e" },
  sky:     { bg: "rgba(56,189,248,0.22)",  border: "#0ea5e9", dot: "#0ea5e9" },
  emerald: { bg: "rgba(52,211,153,0.22)",  border: "#10b981", dot: "#10b981" },
};

const STORAGE_KEY = (slug: string) => `nx-ann-${slug}`;

export function loadAnnotations(slug: string): Annotation[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY(slug)) ?? "[]"); }
  catch { return []; }
}

export function saveAnnotation(ann: Annotation): void {
  const all = loadAnnotations(ann.slug).filter(a => a.id !== ann.id);
  localStorage.setItem(STORAGE_KEY(ann.slug), JSON.stringify([...all, ann]));
}

export function deleteAnnotation(slug: string, id: string): void {
  const all = loadAnnotations(slug);
  localStorage.setItem(STORAGE_KEY(slug), JSON.stringify(all.filter(a => a.id !== id)));
}

export function updateAnnotationNote(slug: string, id: string, note: string): void {
  const all = loadAnnotations(slug).map(a => a.id === id ? { ...a, note } : a);
  localStorage.setItem(STORAGE_KEY(slug), JSON.stringify(all));
}

// ── Theme ─────────────────────────────────────────────────────────────────────
interface Theme {
  bg: string; text: string; muted: string; border: string;
  chrome: string; chromeBorder: string; accent: string;
}

interface PanelProps {
  slug:      string;
  open:      boolean;
  onClose:   () => void;
  t:         Theme;
  fontFamily:string;
}

// ── AnnotationsPanel ─────────────────────────────────────────────────────────
export function AnnotationsPanel({ slug, open, onClose, t, fontFamily }: PanelProps) {
  const [anns,      setAnns]      = useState<Annotation[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNote,  setEditNote]  = useState("");

  const reload = useCallback(() => {
    setAnns(loadAnnotations(slug).sort((a, b) => a.createdAt - b.createdAt));
  }, [slug]);

  useEffect(() => { if (open) { reload(); setEditingId(null); } }, [open, reload]);

  const handleDelete = (id: string) => { deleteAnnotation(slug, id); reload(); };

  const startEdit = (ann: Annotation) => { setEditingId(ann.id); setEditNote(ann.note); };

  const commitEdit = (id: string) => {
    updateAnnotationNote(slug, id, editNote.trim());
    setEditingId(null);
    reload();
  };

  // Group by chapter index
  const grouped = anns.reduce<Record<string, Annotation[]>>((acc, ann) => {
    const k = String(ann.chapterIndex);
    (acc[k] ??= []).push(ann);
    return acc;
  }, {});
  const groupKeys = Object.keys(grouped).sort((a, b) => Number(a) - Number(b));

  const iconBtn = (label: string, onClick: () => void, d: string) => (
    <button
      onClick={onClick}
      aria-label={label}
      style={{
        background: "none", border: "none", cursor: "pointer",
        color: t.muted, opacity: 0.6,
        minHeight: "2rem", minWidth: "2rem",
        display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: "0.3rem", flexShrink: 0,
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        style={{ width: "0.75rem", height: "0.75rem" }}>
        <path d={d} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 44,
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(3px)",
          WebkitBackdropFilter: "blur(3px)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.3s ease",
        }}
      />

      {/* Slide-in panel */}
      <div
        style={{
          position: "fixed",
          top: 0, right: 0, bottom: 0,
          width: "min(400px, 94vw)",
          zIndex: 45,
          background: t.chrome,
          borderLeft: `1px solid ${t.chromeBorder}`,
          display: "flex", flexDirection: "column",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.32s cubic-bezier(0.4,0,0.2,1)",
          boxShadow: "-16px 0 56px rgba(0,0,0,0.4)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 1.25rem", height: "3.5rem", flexShrink: 0,
          borderBottom: `1px solid ${t.border}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
              style={{ width: "1rem", height: "1rem", color: t.accent, flexShrink: 0 }}>
              <path d="M12 20h9" strokeLinecap="round" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" strokeLinecap="round" />
            </svg>
            <span style={{
              fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.14em",
              textTransform: "uppercase", color: t.muted, fontFamily,
            }}>
              Annotations
            </span>
            {anns.length > 0 && (
              <span style={{
                fontSize: "0.65rem", fontWeight: 700,
                background: `${t.accent}25`, color: t.accent,
                padding: "0.1rem 0.5rem", borderRadius: "999px", fontFamily,
              }}>
                {anns.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close annotations"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: t.muted, display: "flex",
              minHeight: "3rem", minWidth: "3rem",
              alignItems: "center", justifyContent: "center",
              borderRadius: "0.5rem",
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              style={{ width: "1.1rem", height: "1.1rem" }}>
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Scrollable list */}
        <div style={{
          flex: 1, overflowY: "auto",
          WebkitOverflowScrolling: "touch",
        } as React.CSSProperties}>
          {anns.length === 0 ? (
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", padding: "5rem 2rem", gap: "0.85rem",
              color: t.muted, textAlign: "center",
            }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2}
                style={{ width: "3rem", height: "3rem", opacity: 0.3 }}>
                <path d="M12 20h9" strokeLinecap="round" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" strokeLinecap="round" />
              </svg>
              <p style={{ fontSize: "0.92rem", fontWeight: 600, color: t.text, fontFamily }}>
                No annotations yet
              </p>
              <p style={{ fontSize: "0.8rem", lineHeight: 1.65, fontFamily, maxWidth: "22ch", opacity: 0.7 }}>
                Tap the pencil icon, then select any text to highlight it.
              </p>
            </div>
          ) : (
            <div style={{ padding: "0.85rem 1rem 3rem" }}>
              {groupKeys.map(gk => {
                const group = grouped[gk];
                const first = group[0];
                return (
                  <div key={gk} style={{ marginBottom: "1.75rem" }}>
                    {/* Chapter label */}
                    <p style={{
                      fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.15em",
                      textTransform: "uppercase", color: t.accent, fontFamily,
                      padding: "0.35rem 0", marginBottom: "0.6rem",
                      borderBottom: `1px solid ${t.border}`,
                    }}>
                      Ch {first.chapterIndex + 1} · {first.chapterTitle}
                    </p>

                    <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
                      {group.map(ann => {
                        const c = ANNO_COLOR_MAP[ann.color];
                        const isEditing = editingId === ann.id;
                        return (
                          <div
                            key={ann.id}
                            style={{
                              borderRadius: "0.7rem",
                              background: c.bg,
                              borderLeft: `3px solid ${c.dot}`,
                              border: `1px solid ${c.border}40`,
                              borderLeftWidth: "3px",
                              borderLeftColor: c.dot,
                              padding: "0.8rem 0.9rem",
                            }}
                          >
                            {/* Top row: action buttons */}
                            <div style={{
                              display: "flex", justifyContent: "flex-end",
                              gap: "0.15rem", marginBottom: "0.35rem",
                            }}>
                              {iconBtn("Edit note", () => startEdit(ann),
                                "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
                              )}
                              {iconBtn("Delete annotation", () => handleDelete(ann.id),
                                "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"
                              )}
                            </div>

                            {/* Quoted text */}
                            <p style={{
                              fontSize: "0.88rem",
                              fontFamily: "Georgia, serif",
                              fontStyle: "italic",
                              color: t.text,
                              lineHeight: 1.65,
                              marginBottom: "0.55rem",
                            }}>
                              "{ann.selectedText}"
                            </p>

                            {/* Note area */}
                            {isEditing ? (
                              <div style={{ marginTop: "0.4rem" }}>
                                <textarea
                                  autoFocus
                                  value={editNote}
                                  onChange={e => setEditNote(e.target.value)}
                                  onKeyDown={e => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") commitEdit(ann.id);
                                    if (e.key === "Escape") setEditingId(null);
                                  }}
                                  placeholder="Add a note…"
                                  rows={2}
                                  style={{
                                    width: "100%", fontSize: "1rem", fontFamily,
                                    background: "transparent",
                                    border: `1px solid ${t.border}`,
                                    borderRadius: "0.4rem",
                                    padding: "0.45rem 0.55rem",
                                    color: t.text, resize: "none",
                                    outline: "none", lineHeight: 1.5,
                                    boxSizing: "border-box",
                                  } as React.CSSProperties}
                                />
                                <div style={{
                                  display: "flex", gap: "0.45rem",
                                  justifyContent: "flex-end", marginTop: "0.4rem",
                                }}>
                                  <button
                                    onClick={() => setEditingId(null)}
                                    style={{
                                      fontSize: "0.75rem", fontFamily, color: t.muted,
                                      background: "none",
                                      border: `1px solid ${t.border}`,
                                      borderRadius: "0.35rem", cursor: "pointer",
                                      minHeight: "2rem", padding: "0 0.65rem",
                                    }}
                                  >Cancel</button>
                                  <button
                                    onClick={() => commitEdit(ann.id)}
                                    style={{
                                      fontSize: "0.75rem", fontFamily, color: "#fff",
                                      background: t.accent, border: "none",
                                      borderRadius: "0.35rem", cursor: "pointer",
                                      minHeight: "2rem", padding: "0 0.75rem",
                                      fontWeight: 600,
                                    }}
                                  >Save</button>
                                </div>
                              </div>
                            ) : ann.note ? (
                              <p
                                onClick={() => startEdit(ann)}
                                style={{
                                  fontSize: "0.8rem", fontFamily, color: t.muted,
                                  lineHeight: 1.55, cursor: "text",
                                  borderTop: `1px solid ${c.border}35`,
                                  paddingTop: "0.4rem",
                                }}
                              >
                                {ann.note}
                              </p>
                            ) : (
                              <button
                                onClick={() => startEdit(ann)}
                                style={{
                                  fontSize: "0.72rem", fontFamily, color: t.muted,
                                  background: "none", border: "none", cursor: "pointer",
                                  padding: 0, opacity: 0.55,
                                  display: "flex", alignItems: "center", gap: "0.3rem",
                                  minHeight: "1.75rem",
                                }}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                                  style={{ width: "0.7rem", height: "0.7rem" }}>
                                  <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                                </svg>
                                Add note
                              </button>
                            )}

                            {/* Timestamp */}
                            <p style={{
                              fontSize: "0.6rem", color: t.muted, fontFamily,
                              opacity: 0.45, marginTop: "0.5rem",
                            }}>
                              {new Date(ann.createdAt).toLocaleDateString(undefined, {
                                month: "short", day: "numeric",
                              })}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
