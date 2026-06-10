export type ThemeVariant = "midnight" | "amber" | "emerald" | "rose" | "violet" | "solar";

export type ThemeConfig = {
  pageBg: string;
  sectionAlt: string;
  card: string;
  nav: string;
  border: string;
  cardBorder: string;
  accentBg: string;
  accentBgHover: string;
  accentBgMuted: string;
  accentText: string;
  accentBorder: string;
  accentRing: string;
  heading: string;
  body: string;
  muted: string;
  label: string;
  popularBorder: string;
  popularBg: string;
  starActive: string;
  completeBg: string;
  completeText: string;
  inputBorder: string;
  inputFocus: string;
  sidebarActive: string;
  sidebarActiveBadge: string;
  lessonActive: string;
  certGradient: string;
};

export const THEMES: Record<ThemeVariant, ThemeConfig> = {
  midnight: {
    pageBg:           "bg-slate-950",
    sectionAlt:       "bg-slate-900/40",
    card:             "bg-slate-900",
    nav:              "bg-slate-950/80",
    border:           "border-slate-800/60",
    cardBorder:       "border-slate-700/50",
    accentBg:         "bg-cyan-500",
    accentBgHover:    "hover:bg-cyan-400",
    accentBgMuted:    "bg-cyan-500/10",
    accentText:       "text-cyan-400",
    accentBorder:     "border-cyan-500/30",
    accentRing:       "ring-cyan-500/30",
    heading:          "text-slate-100",
    body:             "text-slate-300",
    muted:            "text-slate-400",
    label:            "text-slate-500",
    popularBorder:    "border-cyan-500/50",
    popularBg:        "bg-cyan-500/5",
    starActive:       "text-amber-400",
    completeBg:       "bg-emerald-500/20",
    completeText:     "text-emerald-400",
    inputBorder:      "border-slate-700",
    inputFocus:       "focus:border-cyan-500/60",
    sidebarActive:    "bg-cyan-500/15 text-cyan-300",
    sidebarActiveBadge: "bg-cyan-500/30 text-cyan-300",
    lessonActive:     "bg-slate-800 ring-1 ring-slate-600",
    certGradient:     "from-cyan-500/10 via-emerald-500/10 to-cyan-500/10",
  },
  amber: {
    pageBg:           "bg-[#120d04]",
    sectionAlt:       "bg-amber-950/50",
    card:             "bg-[#1c1506]",
    nav:              "bg-[#120d04]/90",
    border:           "border-amber-900/40",
    cardBorder:       "border-amber-800/30",
    accentBg:         "bg-amber-500",
    accentBgHover:    "hover:bg-amber-400",
    accentBgMuted:    "bg-amber-500/10",
    accentText:       "text-amber-400",
    accentBorder:     "border-amber-500/30",
    accentRing:       "ring-amber-500/30",
    heading:          "text-amber-50",
    body:             "text-amber-100/80",
    muted:            "text-amber-200/60",
    label:            "text-amber-300/50",
    popularBorder:    "border-amber-500/50",
    popularBg:        "bg-amber-500/8",
    starActive:       "text-amber-400",
    completeBg:       "bg-amber-500/15",
    completeText:     "text-amber-400",
    inputBorder:      "border-amber-800/50",
    inputFocus:       "focus:border-amber-500/60",
    sidebarActive:    "bg-amber-500/15 text-amber-300",
    sidebarActiveBadge: "bg-amber-500/25 text-amber-300",
    lessonActive:     "bg-amber-950/70 ring-1 ring-amber-800/50",
    certGradient:     "from-amber-500/10 via-orange-500/10 to-amber-500/10",
  },
  emerald: {
    pageBg:           "bg-[#050f0c]",
    sectionAlt:       "bg-emerald-950/50",
    card:             "bg-[#081a14]",
    nav:              "bg-[#050f0c]/90",
    border:           "border-emerald-900/40",
    cardBorder:       "border-emerald-800/30",
    accentBg:         "bg-emerald-500",
    accentBgHover:    "hover:bg-emerald-400",
    accentBgMuted:    "bg-emerald-500/10",
    accentText:       "text-emerald-400",
    accentBorder:     "border-emerald-500/30",
    accentRing:       "ring-emerald-500/30",
    heading:          "text-emerald-50",
    body:             "text-emerald-100/80",
    muted:            "text-emerald-200/60",
    label:            "text-emerald-300/50",
    popularBorder:    "border-emerald-500/50",
    popularBg:        "bg-emerald-500/8",
    starActive:       "text-amber-400",
    completeBg:       "bg-emerald-500/20",
    completeText:     "text-emerald-400",
    inputBorder:      "border-emerald-800/50",
    inputFocus:       "focus:border-emerald-500/60",
    sidebarActive:    "bg-emerald-500/15 text-emerald-300",
    sidebarActiveBadge: "bg-emerald-500/25 text-emerald-300",
    lessonActive:     "bg-emerald-950/70 ring-1 ring-emerald-800/50",
    certGradient:     "from-emerald-500/10 via-teal-500/10 to-emerald-500/10",
  },
  rose: {
    pageBg:           "bg-[#0f0508]",
    sectionAlt:       "bg-rose-950/50",
    card:             "bg-[#1a0910]",
    nav:              "bg-[#0f0508]/90",
    border:           "border-rose-900/40",
    cardBorder:       "border-rose-800/30",
    accentBg:         "bg-rose-500",
    accentBgHover:    "hover:bg-rose-400",
    accentBgMuted:    "bg-rose-500/10",
    accentText:       "text-rose-400",
    accentBorder:     "border-rose-500/30",
    accentRing:       "ring-rose-500/30",
    heading:          "text-rose-50",
    body:             "text-rose-100/80",
    muted:            "text-rose-200/60",
    label:            "text-rose-300/50",
    popularBorder:    "border-rose-500/50",
    popularBg:        "bg-rose-500/8",
    starActive:       "text-rose-400",
    completeBg:       "bg-rose-500/15",
    completeText:     "text-rose-400",
    inputBorder:      "border-rose-800/50",
    inputFocus:       "focus:border-rose-500/60",
    sidebarActive:    "bg-rose-500/15 text-rose-300",
    sidebarActiveBadge: "bg-rose-500/25 text-rose-300",
    lessonActive:     "bg-rose-950/70 ring-1 ring-rose-800/50",
    certGradient:     "from-rose-500/10 via-pink-500/10 to-rose-500/10",
  },
  violet: {
    pageBg:           "bg-[#08050f]",
    sectionAlt:       "bg-violet-950/50",
    card:             "bg-[#100a1c]",
    nav:              "bg-[#08050f]/90",
    border:           "border-violet-900/40",
    cardBorder:       "border-violet-800/30",
    accentBg:         "bg-violet-500",
    accentBgHover:    "hover:bg-violet-400",
    accentBgMuted:    "bg-violet-500/10",
    accentText:       "text-violet-400",
    accentBorder:     "border-violet-500/30",
    accentRing:       "ring-violet-500/30",
    heading:          "text-violet-50",
    body:             "text-violet-100/80",
    muted:            "text-violet-200/60",
    label:            "text-violet-300/50",
    popularBorder:    "border-violet-500/50",
    popularBg:        "bg-violet-500/8",
    starActive:       "text-amber-400",
    completeBg:       "bg-violet-500/20",
    completeText:     "text-violet-400",
    inputBorder:      "border-violet-800/50",
    inputFocus:       "focus:border-violet-500/60",
    sidebarActive:    "bg-violet-500/15 text-violet-300",
    sidebarActiveBadge: "bg-violet-500/25 text-violet-300",
    lessonActive:     "bg-violet-950/70 ring-1 ring-violet-800/50",
    certGradient:     "from-violet-500/10 via-purple-500/10 to-violet-500/10",
  },
  solar: {
    pageBg:           "bg-amber-50",
    sectionAlt:       "bg-amber-100/70",
    card:             "bg-white",
    nav:              "bg-amber-50/95",
    border:           "border-amber-200/70",
    cardBorder:       "border-amber-200",
    accentBg:         "bg-amber-600",
    accentBgHover:    "hover:bg-amber-700",
    accentBgMuted:    "bg-amber-100",
    accentText:       "text-amber-700",
    accentBorder:     "border-amber-400",
    accentRing:       "ring-amber-400",
    heading:          "text-slate-900",
    body:             "text-slate-700",
    muted:            "text-slate-500",
    label:            "text-slate-400",
    popularBorder:    "border-amber-500",
    popularBg:        "bg-amber-50",
    starActive:       "text-amber-500",
    completeBg:       "bg-emerald-100",
    completeText:     "text-emerald-700",
    inputBorder:      "border-amber-300",
    inputFocus:       "focus:border-amber-500",
    sidebarActive:    "bg-amber-100 text-amber-800",
    sidebarActiveBadge: "bg-amber-200 text-amber-800",
    lessonActive:     "bg-amber-100 ring-1 ring-amber-300",
    certGradient:     "from-amber-200/40 via-orange-100/40 to-amber-200/40",
  },
};

export function getTheme(variant?: string | null): ThemeConfig {
  return THEMES[(variant as ThemeVariant) ?? "midnight"] ?? THEMES.midnight;
}
