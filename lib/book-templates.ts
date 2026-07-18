/**
 * book-templates.ts
 * Seven industry-standard non-fiction book layout templates for PDF export.
 * Each template drives all typographic decisions in ebook-generator.tsx.
 */

export const BOOK_TEMPLATE_IDS = [
  "classic-academic",
  "modern-business",
  "devotional",
  "popular-nonfiction",
  "premium-literary",
  "pastoral-ministry",
  "memoir-narrative",
] as const;

export type BookTemplateId = (typeof BOOK_TEMPLATE_IDS)[number];

// ─── Print Trim Sizes ─────────────────────────────────────────────────────────
export type PrintTrimSize = "6x9" | "5.5x8.5";

export type TrimSizeSpec = {
  label: string;
  description: string;
  pageSize: [number, number]; // width × height in points (72pt = 1 inch)
  margins: { top: number; bottom: number; left: number; right: number }; // recto (odd page) defaults
  gutterMargin: number;  // inside / binding margin — wider to allow for binding
  outsideMargin: number; // outside / trim margin — narrower
  bodyFontSizeAdjust: number; // delta applied to template's base body font size
};

/** International premium print trim specifications */
export const TRIM_SIZE_SPECS: Record<PrintTrimSize, TrimSizeSpec> = {
  "6x9": {
    label: "6 × 9 in",
    description: "US Trade — Zondervan, Thomas Nelson, Baker Books",
    pageSize: [432, 648],
    // Recto defaults (odd pages): gutter on left, outside on right
    margins: { top: 63, bottom: 72, left: 63, right: 54 },
    gutterMargin: 63,   // 0.875 in — inside / binding
    outsideMargin: 54,  // 0.750 in — outside / trim
    bodyFontSizeAdjust: 0,
  },
  "5.5x8.5": {
    label: "5.5 × 8.5 in",
    description: "US Digest — Charisma House, Hay House, Faith Words",
    pageSize: [396, 612],
    margins: { top: 54, bottom: 63, left: 54, right: 45 },
    gutterMargin: 54,   // 0.750 in — inside / binding
    outsideMargin: 45,  // 0.625 in — outside / trim
    bodyFontSizeAdjust: 0, // same font size as 6×9 — smaller page naturally yields more pages
  },
};

export type BookTemplateConfig = {
  id: BookTemplateId;
  name: string;
  description: string;
  badge: string;
  // Page size and margins are NOT stored here — they come from TRIM_SIZE_SPECS
  // based on the user's PrintSpec (trimSize) selection at export time.
  // Running headers / footers (can be overridden by PrintSpec)
  runningHeaders: boolean;
  // Body text
  bodyFontSize: number;
  bodyLineGap: number;
  paragraphGap: number;    // > 0 = "open" modern gap style (no indent)
  paragraphIndent: number; // > 0 = traditional indent style (no gap)
  bodyAlign: "left" | "justify";
  // Chapter header
  chapterLabel: (n: number) => string;
  chapterLabelSize: number;
  chapterLabelColor: string;
  chapterLabelFont: "serif" | "serifBold" | "sans" | "sansBold" | "serifItalic";
  chapterLabelAlign: "left" | "center" | "right";
  chapterTitleSize: number;
  chapterTitleColor: string;
  chapterTitleFont: "serif" | "serifBold" | "sans" | "sansBold" | "serifItalic";
  chapterTitleAlign: "left" | "center" | "right";
  chapterPreGap: number; // moveDown before the chapter block
  // Section headings
  sectionSize: number;
  sectionColor: string;
  sectionFont: "serif" | "serifBold" | "sans" | "sansBold" | "serifItalic";
  sectionAlign: "left" | "center" | "right";
  sectionRule: boolean;
  // Divider rule between blocks
  showDivider: boolean;
  dividerColor: string;
  // Front / back matter titles
  matterTitleSize: number;
  matterTitleAlign: "left" | "center" | "right";
  // Title page
  titlePageTitleSize: number;
  titlePageSubtitleSize: number;
  titlePageAuthorSize: number;
  titlePageAlign: "left" | "center" | "right";
  titlePageTopGap: number; // moveDown at start of title page
  // Scripture / block quote
  scriptureIndent: number;
  scriptureFontSize: number;
  // Accent / label colours
  accentColor: string;
  labelColor: string;
};

// ─── Roman Numeral Helper ──────────────────────────────────────────────────────
function toRoman(n: number): string {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ["M","CM","D","CD","C","XC","L","XL","X","IX","V","IV","I"];
  let result = "";
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}

// ─── Number-to-Word Helper (for Pastoral and Memoir labels) ───────────────────
function toWord(n: number): string {
  const ones  = ["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine",
                  "Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen",
                  "Sixteen","Seventeen","Eighteen","Nineteen"];
  const tens  = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
  if (n < 20) return ones[n] ?? String(n);
  const t = Math.floor(n / 10), o = n % 10;
  return o === 0 ? tens[t] : `${tens[t]}-${ones[o]}`;
}

// ─── Template Definitions ──────────────────────────────────────────────────────

export const BOOK_TEMPLATES: Record<BookTemplateId, BookTemplateConfig> = {

  // 1 ── Classic Academic ─────────────────────────────────────────────────────
  "classic-academic": {
    id: "classic-academic",
    name: "Classic Academic",
    description: "University Press style — Chicago, Oxford, Cambridge",
    badge: "Chicago / Oxford",
    runningHeaders: true,
    bodyFontSize: 11,
    bodyLineGap: 4,
    paragraphGap: 0,
    paragraphIndent: 28,
    bodyAlign: "justify",
    chapterLabel: (n) => `CHAPTER ${n}`,
    chapterLabelSize: 9,
    chapterLabelColor: "#595959",   // CMYK 0/0/0/65 — neutral grey, press-safe
    chapterLabelFont: "sans",
    chapterLabelAlign: "center",
    chapterTitleSize: 22,
    chapterTitleColor: "#1a1a1a",   // CMYK 0/0/0/90 — rich black substitute
    chapterTitleFont: "serifBold",
    chapterTitleAlign: "center",
    chapterPreGap: 1.5,
    sectionSize: 12.5,
    sectionColor: "#1a1a1a",        // CMYK 0/0/0/90
    sectionFont: "serifBold",
    sectionAlign: "left",
    sectionRule: false,
    showDivider: true,
    dividerColor: "#c8c8c8",        // CMYK 0/0/0/22 — hairline rule, press-safe
    matterTitleSize: 20,
    matterTitleAlign: "center",
    titlePageTitleSize: 26,
    titlePageSubtitleSize: 13,
    titlePageAuthorSize: 12,
    titlePageAlign: "center",
    titlePageTopGap: 6,
    scriptureIndent: 36,
    scriptureFontSize: 11,
    accentColor: "#404040",         // CMYK 0/0/0/75 — dark neutral, press-safe
    labelColor: "#737373",          // CMYK 0/0/0/55 — muted label, press-safe
  },

  // 2 ── Modern Business ──────────────────────────────────────────────────────
  "modern-business": {
    id: "modern-business",
    name: "Modern Business",
    description: "Portfolio / Penguin Business — Gladwell, Sinek style",
    badge: "Portfolio / Penguin",
    runningHeaders: true,
    bodyFontSize: 11.5,
    bodyLineGap: 6,
    paragraphGap: 10,
    paragraphIndent: 0,
    bodyAlign: "justify",
    chapterLabel: (n) => `CHAPTER ${n}`,
    chapterLabelSize: 9,
    chapterLabelColor: "#1b3d6e",   // CMYK 76/55/0/57 — navy, offset-press safe
    chapterLabelFont: "sansBold",
    chapterLabelAlign: "left",
    chapterTitleSize: 26,
    chapterTitleColor: "#0d0d0d",   // CMYK 0/0/0/95 — near-black
    chapterTitleFont: "serifBold",
    chapterTitleAlign: "left",
    chapterPreGap: 1.2,
    sectionSize: 12,
    sectionColor: "#0d0d0d",        // CMYK 0/0/0/95
    sectionFont: "sansBold",
    sectionAlign: "left",
    sectionRule: true,
    showDivider: true,
    dividerColor: "#1b3d6e",        // same as accent — navy rule
    matterTitleSize: 22,
    matterTitleAlign: "left",
    titlePageTitleSize: 30,
    titlePageSubtitleSize: 14,
    titlePageAuthorSize: 13,
    titlePageAlign: "left",
    titlePageTopGap: 5,
    scriptureIndent: 32,
    scriptureFontSize: 11.5,
    accentColor: "#1b3d6e",         // CMYK 76/55/0/57 — navy
    labelColor: "#1b3d6e",          // navy label
  },

  // 3 ── Devotional ───────────────────────────────────────────────────────────
  "devotional": {
    id: "devotional",
    name: "Devotional",
    description: "Zondervan / Thomas Nelson — Warren, Meyer, Jakes style",
    badge: "Zondervan / Nelson",
    runningHeaders: true,
    bodyFontSize: 12,
    bodyLineGap: 7,
    paragraphGap: 12,
    paragraphIndent: 0,
    bodyAlign: "justify",
    chapterLabel: (n) => `Chapter ${n}`,
    chapterLabelSize: 11,
    chapterLabelColor: "#7a3d00",   // CMYK 0/50/100/52 — burnt sienna, press-safe
    chapterLabelFont: "serifItalic",
    chapterLabelAlign: "center",
    chapterTitleSize: 24,
    chapterTitleColor: "#190f00",   // CMYK 0/40/100/90 — deep warm black
    chapterTitleFont: "serifBold",
    chapterTitleAlign: "center",
    chapterPreGap: 1.5,
    sectionSize: 13,
    sectionColor: "#190f00",        // CMYK 0/40/100/90
    sectionFont: "serifBold",
    sectionAlign: "center",
    sectionRule: false,
    showDivider: true,
    dividerColor: "#c49060",        // CMYK 0/27/52/23 — warm tan rule, press-safe
    matterTitleSize: 22,
    matterTitleAlign: "center",
    titlePageTitleSize: 28,
    titlePageSubtitleSize: 14,
    titlePageAuthorSize: 13,
    titlePageAlign: "center",
    titlePageTopGap: 6,
    scriptureIndent: 40,
    scriptureFontSize: 12,
    accentColor: "#7a3d00",         // CMYK 0/50/100/52 — burnt sienna
    labelColor: "#7a3d00",          // burnt sienna label
  },

  // 4 ── Popular Nonfiction ───────────────────────────────────────────────────
  "popular-nonfiction": {
    id: "popular-nonfiction",
    name: "Popular Nonfiction",
    description: "Hay House / Random House — Robbins, Brown, Coelho style",
    badge: "Hay House / Random House",
    runningHeaders: true,
    bodyFontSize: 11.5,
    bodyLineGap: 5.5,
    paragraphGap: 9,
    paragraphIndent: 0,
    bodyAlign: "justify",
    chapterLabel: (n) => `${String(n).padStart(2, "0")}`,
    chapterLabelSize: 36,
    chapterLabelColor: "#bf3a06",   // CMYK 0/69/97/25 — vermilion, press-safe
    chapterLabelFont: "sansBold",
    chapterLabelAlign: "left",
    chapterTitleSize: 22,
    chapterTitleColor: "#0d0d0d",   // CMYK 0/0/0/95
    chapterTitleFont: "serifBold",
    chapterTitleAlign: "left",
    chapterPreGap: 1.2,
    sectionSize: 13,
    sectionColor: "#0d0d0d",        // CMYK 0/0/0/95
    sectionFont: "serifBold",
    sectionAlign: "left",
    sectionRule: false,
    showDivider: true,
    dividerColor: "#d9d9d9",        // CMYK 0/0/0/15 — light rule, press-safe
    matterTitleSize: 22,
    matterTitleAlign: "left",
    titlePageTitleSize: 32,
    titlePageSubtitleSize: 15,
    titlePageAuthorSize: 13,
    titlePageAlign: "left",
    titlePageTopGap: 4.5,
    scriptureIndent: 30,
    scriptureFontSize: 11.5,
    accentColor: "#bf3a06",         // CMYK 0/69/97/25 — vermilion
    labelColor: "#bf3a06",          // vermilion label
  },

  // 5 ── Premium Literary ─────────────────────────────────────────────────────
  "premium-literary": {
    id: "premium-literary",
    name: "Premium Literary",
    description: "Knopf / Farrar Straus — understated, elegant, timeless",
    badge: "Knopf / Farrar Straus",
    runningHeaders: true,
    bodyFontSize: 11,
    bodyLineGap: 4.5,
    paragraphGap: 0,
    paragraphIndent: 36,
    bodyAlign: "justify",
    chapterLabel: (n) => toRoman(n),
    chapterLabelSize: 11,
    chapterLabelColor: "#4d4d4d",   // CMYK 0/0/0/70 — cool mid-grey, press-safe
    chapterLabelFont: "serifItalic",
    chapterLabelAlign: "center",
    chapterTitleSize: 20,
    chapterTitleColor: "#1a1a1a",   // CMYK 0/0/0/90
    chapterTitleFont: "serif",
    chapterTitleAlign: "center",
    chapterPreGap: 2,
    sectionSize: 11.5,
    sectionColor: "#333333",        // CMYK 0/0/0/80
    sectionFont: "serifItalic",
    sectionAlign: "center",
    sectionRule: false,
    showDivider: false,
    dividerColor: "#bfbfbf",        // CMYK 0/0/0/25 — light rule, press-safe
    matterTitleSize: 18,
    matterTitleAlign: "center",
    titlePageTitleSize: 24,
    titlePageSubtitleSize: 12,
    titlePageAuthorSize: 11,
    titlePageAlign: "center",
    titlePageTopGap: 7,
    scriptureIndent: 44,
    scriptureFontSize: 11,
    accentColor: "#4d4d4d",         // CMYK 0/0/0/70 — cool grey
    labelColor: "#737373",          // CMYK 0/0/0/55 — softer label
  },

  // 6 ── Pastoral Ministry ────────────────────────────────────────────────────
  //
  // Modelled on Baker Books, Whitaker House, and Charisma House — publishers
  // specialising in pastoral, prophetic, and ministry books. Key markers:
  //   • Chapter labels spelled out in ALL-CAPS ("CHAPTER ONE") in a small
  //     spaced sans-serif — a Baker Books house convention.
  //   • Generous body leading (8pt line gap, 12pt paragraph gap) and a
  //     slightly larger body size (12.5pt) for readability at the pulpit
  //     and for congregants who read in lower light.
  //   • Warm burgundy accent (#6b1f2a) — a press-safe deep red used widely
  //     in Baker and Charisma covers.
  //   • Centered chapter titles in a large bold serif — commanding authority
  //     without academic distance.
  //   • Generous scripture indent (48pt) and matching scripture font size —
  //     scripture passages deserve visual breathing room in pastoral prose.
  //
  "pastoral-ministry": {
    id: "pastoral-ministry",
    name: "Pastoral Ministry",
    description: "Baker Books / Whitaker House — Stanley, Hagee, Dollar style",
    badge: "Baker / Whitaker House",
    runningHeaders: true,
    bodyFontSize: 12.5,
    bodyLineGap: 8,
    paragraphGap: 12,
    paragraphIndent: 0,
    bodyAlign: "justify",
    chapterLabel: (n) => `CHAPTER ${toWord(n).toUpperCase()}`,
    chapterLabelSize: 8.5,
    chapterLabelColor: "#6b1f2a",   // CMYK 0/71/60/58 — deep burgundy, press-safe
    chapterLabelFont: "sans",
    chapterLabelAlign: "center",
    chapterTitleSize: 26,
    chapterTitleColor: "#1a0408",   // CMYK 0/80/55/90 — near-black with warm cast
    chapterTitleFont: "serifBold",
    chapterTitleAlign: "center",
    chapterPreGap: 1.6,
    sectionSize: 13.5,
    sectionColor: "#1a0408",        // CMYK 0/80/55/90
    sectionFont: "serifBold",
    sectionAlign: "left",
    sectionRule: false,
    showDivider: true,
    dividerColor: "#b89070",        // CMYK 0/22/39/28 — warm gold rule, press-safe
    matterTitleSize: 22,
    matterTitleAlign: "center",
    titlePageTitleSize: 30,
    titlePageSubtitleSize: 14,
    titlePageAuthorSize: 13,
    titlePageAlign: "center",
    titlePageTopGap: 5.5,
    scriptureIndent: 48,
    scriptureFontSize: 12.5,
    accentColor: "#6b1f2a",         // CMYK 0/71/60/58 — deep burgundy
    labelColor: "#6b1f2a",          // burgundy label
  },

  // 7 ── Memoir & Narrative ───────────────────────────────────────────────────
  //
  // Modelled on Penguin Press, Harper Perennial, and W.W. Norton — publishers
  // whose memoir list (Mary Karr, Rick Bragg, Frank McCourt) sets the standard
  // for intimate, literary personal narrative. Key markers:
  //   • Chapter labels as written-out ordinals in italic serif ("One", "Two") —
  //     the single most recognisable convention of literary memoir typography.
  //   • Traditional indented paragraphs (34pt) with no paragraph gap — the reader
  //     is pulled forward without visual interruption.
  //   • 11pt body on a 4.5pt line gap — tight but not cramped; allows a full
  //     narrative page to feel immersive.
  //   • Warm sepia accent (#5c3d1e — CMYK 0/33/67/64) rather than blue or red —
  //     signals intimacy and memory rather than authority or energy.
  //   • Section headings in italic serif, left-aligned — understated, never
  //     interrupting the narrative voice.
  //   • No divider rule — the prose flows as one continuous experience;
  //     the indent alone signals paragraph transitions.
  //
  "memoir-narrative": {
    id: "memoir-narrative",
    name: "Memoir & Narrative",
    description: "Penguin Press / W.W. Norton — Mary Karr, Rick Bragg style",
    badge: "Penguin Press / Norton",
    runningHeaders: true,
    bodyFontSize: 11,
    bodyLineGap: 4.5,
    paragraphGap: 0,
    paragraphIndent: 34,
    bodyAlign: "justify",
    chapterLabel: (n) => toWord(n),
    chapterLabelSize: 14,
    chapterLabelColor: "#5c3d1e",   // CMYK 0/33/67/64 — warm sepia, press-safe
    chapterLabelFont: "serifItalic",
    chapterLabelAlign: "center",
    chapterTitleSize: 19,
    chapterTitleColor: "#1c120a",   // CMYK 0/33/44/89 — deep warm near-black
    chapterTitleFont: "serifBold",
    chapterTitleAlign: "center",
    chapterPreGap: 2,
    sectionSize: 11.5,
    sectionColor: "#2e1f0f",        // CMYK 0/32/67/82 — dark sepia
    sectionFont: "serifItalic",
    sectionAlign: "left",
    sectionRule: false,
    showDivider: false,
    dividerColor: "#c4aa88",        // CMYK 0/13/30/23 — light sepia hairline
    matterTitleSize: 20,
    matterTitleAlign: "center",
    titlePageTitleSize: 24,
    titlePageSubtitleSize: 12,
    titlePageAuthorSize: 12,
    titlePageAlign: "center",
    titlePageTopGap: 7,
    scriptureIndent: 40,
    scriptureFontSize: 11,
    accentColor: "#5c3d1e",         // CMYK 0/33/67/64 — warm sepia
    labelColor: "#8a6645",          // CMYK 0/25/50/46 — lighter sepia label
  },
};

export function getTemplate(id?: string | null): BookTemplateConfig {
  return BOOK_TEMPLATES[(id as BookTemplateId) ?? "devotional"] ?? BOOK_TEMPLATES["devotional"];
}
