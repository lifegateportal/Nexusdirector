"use client";

/**
 * ProseEditor — shared-toolbar rich text editor
 *
 * Architecture:
 *  - ProseToolbarProvider  wraps the editing zone and holds shared state
 *  - SharedProseToolbar    rendered ONCE; operates on whichever editor has focus
 *  - ProseEditor           individual editable field; no own toolbar
 *
 * Features:
 *  Bold · Italic · Underline · H1/H2/H3 · Block-quote · Lists · Indent
 *  Find & Replace · Floating selection mini-toolbar · Live word/char count
 *  Keyboard shortcuts: ⌘B/I/U · ⌘Z/Y · ⌘H · Tab/Shift-Tab
 *  Markdown triggers: "# ", "## ", "### ", "> ", "- ", "1. " + Space
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProseEditorProps = {
  /** Current markdown / plain-text value (pipeline format) */
  value: string;
  /** Called on every change with the new plain-text / markdown value */
  onChange: (value: string) => void;
  /** Label shown above the toolbar */
  label?: string;
  /** Placeholder text shown when the editor is empty */
  placeholder?: string;
  /** Approximate content rows to size the editor initially */
  rows?: number;
  /** Class names appended to the outer wrapper */
  className?: string;
};

// ─── Helpers: convert pipeline prose ↔ HTML ──────────────────────────────────

/**
 * Convert the pipeline's plain-text / markdown-lite format to HTML for editing.
 * Pipeline prose uses:
 *   - Double newline: paragraph break
 *   - > ... lines: blockquote
 *   - *"..."* (reference) : italic scripture inline (kept as-is in <em>)
 *   - **text**: bold
 *   - *text*: italic (when not a scripture pattern)
 */
function textToHtml(text: string): string {
  if (!text) return "<p><br></p>";

  // Split into paragraph-level chunks on double newlines
  const chunks = text.split(/\n{2,}/);

  return chunks
    .map((chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return "";

      // Blockquote lines (> prefix)
      if (trimmed.startsWith("> ") || trimmed.startsWith(">")) {
        const inner = trimmed.replace(/^>\s?/, "").trim();
        return `<blockquote>${inlineToHtml(inner)}</blockquote>`;
      }

      // Headings
      if (trimmed.startsWith("### ")) return `<h3>${inlineToHtml(trimmed.slice(4))}</h3>`;
      if (trimmed.startsWith("## ")) return `<h2>${inlineToHtml(trimmed.slice(3))}</h2>`;
      if (trimmed.startsWith("# ")) return `<h1>${inlineToHtml(trimmed.slice(2))}</h1>`;

      // Unordered list items (- item or • item)
      if (/^[-•]\s/.test(trimmed)) {
        return `<ul>${trimmed
          .split(/\n/)
          .map((l) => l.replace(/^[-•]\s/, "").trim())
          .filter(Boolean)
          .map((l) => `<li>${inlineToHtml(l)}</li>`)
          .join("")}</ul>`;
      }

      // Ordered list items (1. item)
      if (/^\d+\.\s/.test(trimmed)) {
        return `<ol>${trimmed
          .split(/\n/)
          .map((l) => l.replace(/^\d+\.\s/, "").trim())
          .filter(Boolean)
          .map((l) => `<li>${inlineToHtml(l)}</li>`)
          .join("")}</ol>`;
      }

      return `<p>${inlineToHtml(trimmed)}</p>`;
    })
    .filter(Boolean)
    .join("") || "<p><br></p>";
}

/** Handle inline markdown within a block (bold, italic, scripture em) */
function inlineToHtml(text: string): string {
  return text
    // Bold: **text**
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Scripture inline italic: *"text"* (reference)
    .replace(/\*(".*?")\*/g, "<em>$1</em>")
    // Plain italic: *text*
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // Underline: __text__ (non-standard but useful editorially)
    .replace(/__(.+?)__/g, "<u>$1</u>");
}

/**
 * Convert the editor HTML back to the pipeline's plain-text / markdown-lite format.
 * This is the value stored in ChapterDraft.sections[].body.
 */
function htmlToText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;

  function nodeToText(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";

    const el = node as Element;
    const tag = el.tagName?.toLowerCase();

    const children = Array.from(node.childNodes).map(nodeToText).join("");

    if (tag === "br") return "\n";
    if (tag === "strong" || tag === "b") return `**${children}**`;
    if (tag === "em" || tag === "i") return `*${children}*`;
    if (tag === "u") return `__${children}__`;
    if (tag === "blockquote") {
      return children
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => `> ${l}`)
        .join("\n");
    }
    if (tag === "h1") return `# ${children}`;
    if (tag === "h2") return `## ${children}`;
    if (tag === "h3") return `### ${children}`;
    if (tag === "li") return children;
    if (tag === "ul") {
      return Array.from(el.children)
        .map((li) => `- ${nodeToText(li)}`)
        .join("\n");
    }
    if (tag === "ol") {
      return Array.from(el.children)
        .map((li, i) => `${i + 1}. ${nodeToText(li)}`)
        .join("\n");
    }
    if (tag === "p") return children || "";
    return children;
  }

  // Process top-level block nodes separated by double newlines
  const blocks = Array.from(div.childNodes)
    .map(nodeToText)
    .filter((b) => b.trim().length > 0);

  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Word + char count ────────────────────────────────────────────────────────

function countWordsInHtml(html: string): { words: number; chars: number } {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const words = text ? text.split(/\s+/).length : 0;
  return { words, chars: text.length };
}

// ─── Toolbar button ───────────────────────────────────────────────────────────

function ToolbarBtn({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault(); // keep focus in editor
        onClick(e);
      }}
      className={[
        "flex items-center justify-center rounded-lg min-w-[36px] min-h-[36px] px-2 text-sm transition-colors select-none",
        active
          ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
          : "text-slate-300 hover:bg-slate-700/60 hover:text-slate-100 border border-transparent",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

// ─── Shared Toolbar Context ───────────────────────────────────────────────────

type ProseToolbarCtx = {
  /** Ref to the currently focused editor div — used by Find & Replace */
  activeEditorRef: React.MutableRefObject<HTMLDivElement | null>;
  activeFormats: Set<string>;
  setActiveFormats: (f: Set<string>) => void;
  showFindReplace: boolean;
  setShowFindReplace: React.Dispatch<React.SetStateAction<boolean>>;
  /** Whether any ProseEditor is currently focused */
  hasActiveEditor: boolean;
  setHasActiveEditor: (v: boolean) => void;
};

const ProseToolbarContext = createContext<ProseToolbarCtx | null>(null);

/** Wrap the editing zone with this to share one toolbar across all ProseEditors inside */
export function ProseToolbarProvider({ children }: { children: React.ReactNode }) {
  const activeEditorRef = useRef<HTMLDivElement | null>(null);
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [hasActiveEditor, setHasActiveEditor] = useState(false);

  const value = useMemo(
    () => ({ activeEditorRef, activeFormats, setActiveFormats, showFindReplace, setShowFindReplace, hasActiveEditor, setHasActiveEditor }),
    [activeFormats, showFindReplace, hasActiveEditor],
  );

  return <ProseToolbarContext.Provider value={value}>{children}</ProseToolbarContext.Provider>;
}

function useProseToolbar() {
  return useContext(ProseToolbarContext);
}

// ─── Shared exec helper (works on currently focused contenteditable) ──────────

function sharedExec(cmd: string, val?: string) {
  if (cmd === "formatBlock") {
    document.execCommand("formatBlock", false, val ?? "p");
  } else if (cmd === "indent") {
    document.execCommand("indent");
  } else if (cmd === "outdent") {
    document.execCommand("outdent");
  } else {
    document.execCommand(cmd, false, val);
  }
}

function readFormats(editorEl?: HTMLDivElement | null): Set<string> {
  const fmts = new Set<string>();
  try {
    if (document.queryCommandState("bold")) fmts.add("bold");
    if (document.queryCommandState("italic")) fmts.add("italic");
    if (document.queryCommandState("underline")) fmts.add("underline");
  } catch { /* execCommand may throw in some envs */ }
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    let node: Node | null = sel.getRangeAt(0).commonAncestorContainer;
    while (node && node !== editorEl) {
      const tag = (node as Element).tagName;
      if (tag === "BLOCKQUOTE") { fmts.add("blockquote"); break; }
      if (tag === "H1") { fmts.add("h1"); break; }
      if (tag === "H2") { fmts.add("h2"); break; }
      if (tag === "H3") { fmts.add("h3"); break; }
      node = node.parentNode;
    }
  }
  return fmts;
}

// ─── Find & Replace panel ─────────────────────────────────────────────────────

function FindReplacePanel({ onClose }: { onClose: () => void }) {
  const ctx = useProseToolbar();
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [count, setCount] = useState<number | null>(null);

  const highlight = useCallback(() => {
    const el = ctx?.activeEditorRef.current;
    if (!el || !find) return;
    const text = el.innerText;
    const matches = text.match(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
    setCount(matches?.length ?? 0);
  }, [find, ctx]);

  useEffect(() => { highlight(); }, [highlight]);

  const doReplace = useCallback((all: boolean) => {
    const el = ctx?.activeEditorRef.current;
    if (!el || !find) return;
    el.focus();
    const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    el.innerHTML = el.innerHTML.replace(new RegExp(escaped, all ? "gi" : "i"), replace);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    highlight();
  }, [find, replace, ctx, highlight]);

  return (
    <div className="absolute top-full right-0 z-50 mt-1 w-72 rounded-2xl border border-slate-600/60 bg-slate-900 shadow-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Find &amp; Replace</span>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onClose}
          className="text-slate-500 hover:text-slate-200 min-h-[36px] min-w-[36px] flex items-center justify-center">✕</button>
      </div>
      <div className="space-y-2">
        <input className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/60"
          placeholder="Find…" value={find} onChange={(e) => setFind(e.target.value)} />
        <input className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/60"
          placeholder="Replace with…" value={replace} onChange={(e) => setReplace(e.target.value)} />
      </div>
      {count !== null && find && (
        <p className="text-[11px] text-slate-500">{count === 0 ? "No matches" : `${count} match${count !== 1 ? "es" : ""}`}</p>
      )}
      <div className="flex gap-2">
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => doReplace(false)}
          className="flex-1 min-h-[40px] rounded-lg border border-slate-600 bg-slate-800 text-xs text-slate-200 hover:bg-slate-700 transition-colors">Replace next</button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => doReplace(true)}
          className="flex-1 min-h-[40px] rounded-lg bg-cyan-600/80 text-xs text-white hover:bg-cyan-600 transition-colors">Replace all</button>
      </div>
    </div>
  );
}

// ─── Floating mini-toolbar (appears over selected text) ───────────────────────

function FloatingToolbar({ rect, activeFormats }: { rect: DOMRect; activeFormats: Set<string> }) {
  const style: React.CSSProperties = {
    position: "fixed",
    top: Math.max(4, rect.top - 52),
    left: rect.left + rect.width / 2,
    transform: "translateX(-50%)",
    zIndex: 9999,
  };
  return (
    <div style={style} className="flex items-center gap-0.5 rounded-xl border border-slate-600/80 bg-slate-900 shadow-2xl px-1.5 py-1">
      <ToolbarBtn title="Bold (⌘B)" active={activeFormats.has("bold")} onClick={() => sharedExec("bold")}>
        <strong className="text-xs">B</strong>
      </ToolbarBtn>
      <ToolbarBtn title="Italic (⌘I)" active={activeFormats.has("italic")} onClick={() => sharedExec("italic")}>
        <em className="text-xs italic">I</em>
      </ToolbarBtn>
      <ToolbarBtn title="Underline (⌘U)" active={activeFormats.has("underline")} onClick={() => sharedExec("underline")}>
        <span className="text-xs underline">U</span>
      </ToolbarBtn>
      <span className="w-px h-5 bg-slate-700 mx-0.5" />
      <ToolbarBtn title="Block quote" active={activeFormats.has("blockquote")} onClick={() => sharedExec("formatBlock", "blockquote")}>
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor"><path d="M3 3.5A.5.5 0 0 1 3.5 3h1a.5.5 0 0 1 .5.5v1.5a3 3 0 0 1-3 3V7a2 2 0 0 0 2-2V3.5ZM9 3.5A.5.5 0 0 1 9.5 3h1a.5.5 0 0 1 .5.5v1.5a3 3 0 0 1-3 3V7a2 2 0 0 0 2-2V3.5Z"/></svg>
      </ToolbarBtn>
    </div>
  );
}

// ─── SharedProseToolbar — render once above all editors ──────────────────────

export function SharedProseToolbar({ className = "" }: { className?: string }) {
  const ctx = useProseToolbar();
  const af = ctx?.activeFormats ?? new Set<string>();
  const inactive = !ctx?.hasActiveEditor;

  const exec = useCallback((cmd: string, val?: string) => {
    sharedExec(cmd, val);
    if (ctx) {
      // Re-read format state after command
      setTimeout(() => ctx.setActiveFormats(readFormats(ctx.activeEditorRef.current)), 0);
    }
  }, [ctx]);

  return (
    <div className={`relative ${className}`}>
      <div className={[
        "flex flex-wrap items-center gap-0.5 rounded-xl border border-slate-700/60 bg-slate-900/90 px-2 py-1.5 transition-opacity",
        inactive ? "opacity-40 pointer-events-none" : "opacity-100",
      ].join(" ")}>

        {/* History */}
        <ToolbarBtn title="Undo (⌘Z)" onClick={() => exec("undo")}>
          <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M3.5 6H9a4 4 0 0 1 0 8H4m-.5-8L1 8.5l2.5 2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </ToolbarBtn>
        <ToolbarBtn title="Redo (⌘Y)" onClick={() => exec("redo")}>
          <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M12.5 6H7a4 4 0 0 0 0 8h5m.5-8L15 8.5l-2.5 2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </ToolbarBtn>

        <span className="w-px h-5 bg-slate-700 mx-0.5" />

        {/* Inline */}
        <ToolbarBtn title="Bold (⌘B)" active={af.has("bold")} onClick={() => exec("bold")}>
          <span className="text-sm font-bold leading-none">B</span>
        </ToolbarBtn>
        <ToolbarBtn title="Italic (⌘I)" active={af.has("italic")} onClick={() => exec("italic")}>
          <span className="text-sm italic leading-none">I</span>
        </ToolbarBtn>
        <ToolbarBtn title="Underline (⌘U)" active={af.has("underline")} onClick={() => exec("underline")}>
          <span className="text-sm underline leading-none">U</span>
        </ToolbarBtn>

        <span className="w-px h-5 bg-slate-700 mx-0.5" />

        {/* Headings */}
        <ToolbarBtn title="Heading 1" active={af.has("h1")} onClick={() => exec("formatBlock", af.has("h1") ? "p" : "h1")}>
          <span className="text-[11px] font-bold leading-none">H1</span>
        </ToolbarBtn>
        <ToolbarBtn title="Heading 2" active={af.has("h2")} onClick={() => exec("formatBlock", af.has("h2") ? "p" : "h2")}>
          <span className="text-[11px] font-bold leading-none">H2</span>
        </ToolbarBtn>
        <ToolbarBtn title="Heading 3" active={af.has("h3")} onClick={() => exec("formatBlock", af.has("h3") ? "p" : "h3")}>
          <span className="text-[11px] font-bold leading-none">H3</span>
        </ToolbarBtn>

        <span className="w-px h-5 bg-slate-700 mx-0.5" />

        {/* Block quote */}
        <ToolbarBtn title="Block quote / Scripture" active={af.has("blockquote")} onClick={() => exec("formatBlock", af.has("blockquote") ? "p" : "blockquote")}>
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor">
            <path d="M3 3.5A.5.5 0 0 1 3.5 3h1a.5.5 0 0 1 .5.5v1.5a3 3 0 0 1-3 3V7a2 2 0 0 0 2-2V3.5ZM9 3.5A.5.5 0 0 1 9.5 3h1a.5.5 0 0 1 .5.5v1.5a3 3 0 0 1-3 3V7a2 2 0 0 0 2-2V3.5Z"/>
          </svg>
        </ToolbarBtn>

        <span className="w-px h-5 bg-slate-700 mx-0.5" />

        {/* Lists */}
        <ToolbarBtn title="Bullet list" onClick={() => exec("insertUnorderedList")}>
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="2.5" cy="4.5" r="1" fill="currentColor" stroke="none"/>
            <circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none"/>
            <circle cx="2.5" cy="11.5" r="1" fill="currentColor" stroke="none"/>
            <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8" strokeLinecap="round"/>
          </svg>
        </ToolbarBtn>
        <ToolbarBtn title="Numbered list" onClick={() => exec("insertOrderedList")}>
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M1.5 3h1.5M2.25 3v3M5.5 4.5h8M5.5 8h8M5.5 11.5h8" strokeLinecap="round"/>
            <path d="M1.5 9h1.5l-1.5 2h1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </ToolbarBtn>

        <span className="w-px h-5 bg-slate-700 mx-0.5" />

        {/* Indent */}
        <ToolbarBtn title="Indent (Tab)" onClick={() => exec("indent")}>
          <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M2 4h12M6 8h8M6 12h8M2 8l2 2-2 2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </ToolbarBtn>
        <ToolbarBtn title="Outdent (Shift+Tab)" onClick={() => exec("outdent")}>
          <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M2 4h12M6 8h8M6 12h8M6 8l-2 2 2 2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </ToolbarBtn>

        <span className="flex-1" />

        {/* Active field label */}
        {ctx?.hasActiveEditor && (
          <span className="text-[10px] text-cyan-400/70 font-medium mr-1 hidden sm:block">Editing</span>
        )}

        {/* Find & Replace */}
        <ToolbarBtn title="Find &amp; Replace (⌘H)" active={ctx?.showFindReplace} onClick={() => ctx?.setShowFindReplace((p) => !p)}>
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="6.5" cy="6.5" r="4"/>
            <path d="m9.5 9.5 4 4" strokeLinecap="round"/>
            <path d="M12 2.5h2M13 1.5v2" strokeLinecap="round"/>
          </svg>
        </ToolbarBtn>
      </div>

      {ctx?.showFindReplace && <FindReplacePanel onClose={() => ctx.setShowFindReplace(false)} />}

      {/* Prose surface styles (injected once) */}
      <style>{`
        .prose-editor h1 { font-size: 1.5rem; font-weight: 700; color: #e2e8f0; margin: 0.75rem 0 0.25rem; }
        .prose-editor h2 { font-size: 1.2rem; font-weight: 700; color: #e2e8f0; margin: 0.6rem 0 0.2rem; }
        .prose-editor h3 { font-size: 1rem; font-weight: 700; color: #cbd5e1; margin: 0.5rem 0 0.15rem; }
        .prose-editor p  { margin: 0 0 0.5rem; }
        .prose-editor blockquote { border-left: 3px solid #22d3ee55; padding-left: 1rem; margin: 0.6rem 0; color: #94a3b8; font-style: italic; }
        .prose-editor ul { list-style: disc inside; padding-left: 0.5rem; margin: 0.4rem 0; }
        .prose-editor ol { list-style: decimal inside; padding-left: 0.5rem; margin: 0.4rem 0; }
        .prose-editor li { margin: 0.15rem 0; }
        .prose-editor strong { color: #f1f5f9; }
        .prose-editor em { color: #94a3b8; }
        .prose-editor u  { text-decoration-color: #22d3ee88; }
      `}</style>
    </div>
  );
}

// ─── ProseEditor — individual editable field (no own toolbar) ─────────────────

export function ProseEditor({
  value,
  onChange,
  label,
  placeholder,
  rows = 10,
  className = "",
}: ProseEditorProps) {
  const ctx = useProseToolbar();
  const editorRef = useRef<HTMLDivElement>(null);
  const [floatRect, setFloatRect] = useState<DOMRect | null>(null);
  const [localFormats, setLocalFormats] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState({ words: 0, chars: 0 });
  const lastValueRef = useRef<string>("");

  // Init HTML from value prop
  useEffect(() => {
    if (!editorRef.current) return;
    if (value === lastValueRef.current) return;
    const html = textToHtml(value);
    editorRef.current.innerHTML = html;
    setStats(countWordsInHtml(html));
    lastValueRef.current = value;
  }, [value]);

  const refreshFormats = useCallback(() => {
    const fmts = readFormats(editorRef.current);
    setLocalFormats(fmts);
    if (ctx) ctx.setActiveFormats(fmts);
  }, [ctx]);

  const emitChange = useCallback(() => {
    if (!editorRef.current) return;
    const html = editorRef.current.innerHTML;
    setStats(countWordsInHtml(html));
    const text = htmlToText(html);
    lastValueRef.current = text;
    onChange(text);
  }, [onChange]);

  // Floating mini-toolbar on selection
  useEffect(() => {
    const handler = () => {
      refreshFormats();
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { setFloatRect(null); return; }
      const range = sel.getRangeAt(0);
      if (!editorRef.current?.contains(range.commonAncestorContainer)) { setFloatRect(null); return; }
      setFloatRect(range.getBoundingClientRect());
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [refreshFormats]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && e.key === "b") { e.preventDefault(); sharedExec("bold"); refreshFormats(); emitChange(); return; }
    if (isMod && e.key === "i") { e.preventDefault(); sharedExec("italic"); refreshFormats(); emitChange(); return; }
    if (isMod && e.key === "u") { e.preventDefault(); sharedExec("underline"); refreshFormats(); emitChange(); return; }
    if (isMod && e.key === "z" && !e.shiftKey) { e.preventDefault(); sharedExec("undo"); emitChange(); return; }
    if ((isMod && e.key === "y") || (isMod && e.shiftKey && e.key === "z")) { e.preventDefault(); sharedExec("redo"); emitChange(); return; }
    if (isMod && e.key === "h") { e.preventDefault(); ctx?.setShowFindReplace((p) => !p); return; }

    if (e.key === " " && editorRef.current) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;
      const text = node.textContent ?? "";
      const offset = range.startOffset;
      const lineText = text.slice(0, offset);
      const triggers: [string, string][] = [["#", "h1"], ["##", "h2"], ["###", "h3"], [">", "blockquote"]];
      for (const [trigger, block] of triggers) {
        if (lineText === trigger) {
          e.preventDefault();
          node.textContent = text.slice(offset);
          document.execCommand("formatBlock", false, block);
          emitChange();
          return;
        }
      }
      if (lineText === "-" || lineText === "*") {
        e.preventDefault(); node.textContent = text.slice(offset);
        document.execCommand("insertUnorderedList"); emitChange(); return;
      }
      if (/^\d+\.$/.test(lineText)) {
        e.preventDefault(); node.textContent = text.slice(offset);
        document.execCommand("insertOrderedList"); emitChange(); return;
      }
    }
    if (e.key === "Tab") {
      e.preventDefault();
      sharedExec(e.shiftKey ? "outdent" : "indent");
      emitChange();
    }
  }, [refreshFormats, emitChange, ctx]);

  const minHeight = `${rows * 1.7}rem`;

  return (
    <div className={`flex flex-col gap-0 ${className}`}>
      {label && (
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</label>
          <span className="text-[10px] text-slate-600 tabular-nums">
            {stats.words.toLocaleString()} words · {stats.chars.toLocaleString()} chars
          </span>
        </div>
      )}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        data-placeholder={placeholder ?? "Start writing…"}
        onFocus={() => {
          if (ctx) { ctx.activeEditorRef.current = editorRef.current; ctx.setHasActiveEditor(true); }
          refreshFormats();
        }}
        onBlur={() => {
          // Keep hasActiveEditor true briefly so toolbar clicks don't deactivate
          setTimeout(() => {
            if (ctx && ctx.activeEditorRef.current === editorRef.current) {
              const focused = document.activeElement;
              const inEditor = editorRef.current?.contains(focused);
              if (!inEditor) ctx.setHasActiveEditor(false);
            }
          }, 200);
        }}
        onKeyDown={handleKeyDown}
        onInput={emitChange}
        onMouseUp={refreshFormats}
        onKeyUp={refreshFormats}
        style={{ minHeight }}
        className={[
          "w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-4 py-3",
          "text-base text-slate-100 leading-relaxed outline-none overflow-y-auto",
          "focus:border-cyan-500/40",
          "empty:before:content-[attr(data-placeholder)] empty:before:text-slate-600 empty:before:pointer-events-none",
          "prose-editor",
        ].join(" ")}
      />
      {floatRect && <FloatingToolbar rect={floatRect} activeFormats={localFormats} />}
    </div>
  );
}
