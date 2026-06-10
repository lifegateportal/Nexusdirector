type ProjectCardProps = {
  title: string;
  status: string;
  detail: string;
  metrics?: { label: string; value: string }[];
};

const STATUS_CFG: Record<string, { dotCls: string; glow: string; badgeCls: string }> = {
  Healthy: {
    dotCls: "bg-emerald-400",
    glow: "0 0 8px rgba(52,211,153,0.6)",
    badgeCls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
  },
  Warning: {
    dotCls: "bg-amber-400",
    glow: "0 0 8px rgba(251,191,36,0.55)",
    badgeCls: "border-amber-400/30 bg-amber-400/10 text-amber-300"
  },
  Error: {
    dotCls: "bg-red-400",
    glow: "0 0 8px rgba(248,113,113,0.55)",
    badgeCls: "border-red-400/30 bg-red-400/10 text-red-300"
  }
};

const DEFAULT_CFG = {
  dotCls: "bg-slate-500",
  glow: "none",
  badgeCls: "border-slate-500/30 bg-slate-500/10 text-slate-300"
};

export function ProjectCard({ title, status, detail, metrics }: ProjectCardProps) {
  const cfg = STATUS_CFG[status] ?? DEFAULT_CFG;

  return (
    <article className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-cyan-500/15 glass shadow-panel">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-cyan-500/10 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-100">{title}</h2>
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${cfg.dotCls}`}
            style={{ boxShadow: cfg.glow }}
          />
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${cfg.badgeCls}`}>
            {status}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
        <p className="text-sm text-slate-400">{detail}</p>

        {metrics && metrics.length > 0 && (
          <dl className="grid grid-cols-2 gap-2">
            {metrics.map(({ label, value }) => (
              <div key={label} className="rounded-xl border border-slate-700/50 bg-slate-900/70 px-3 py-2.5">
                <dt className="text-[10px] uppercase tracking-wider text-slate-400">{label}</dt>
                <dd className="mt-0.5 text-sm font-semibold text-white">{value}</dd>
              </div>
            ))}
          </dl>
        )}

        <button
          type="button"
          className="focus-ring mt-auto inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-medium text-cyan-300 transition hover:bg-cyan-500/20 hover:border-cyan-400/50 active:scale-[0.99]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 text-accent-400">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          Open Control Surface
        </button>
      </div>
    </article>
  );
}
