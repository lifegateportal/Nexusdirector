import type { IngestResult } from "@/lib/schemas/blueprint";

const ASSET_CHIP: Record<string, string> = {
  video: "text-violet-300 bg-violet-400/10 border-violet-400/30",
  audio: "text-blue-300 bg-blue-400/10 border-blue-400/30",
  image: "text-pink-300 bg-pink-400/10 border-pink-400/30",
  document: "text-amber-300 bg-amber-400/10 border-amber-400/30",
  log: "text-cyan-300 bg-cyan-400/10 border-cyan-400/30"
};

type BlueprintViewerProps = { blueprint: IngestResult };

export function BlueprintViewer({ blueprint }: BlueprintViewerProps) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-700/60 glass shadow-panel">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-slate-700/50 px-4 py-3">
        <span
          className="h-2 w-2 rounded-full bg-emerald-400"
          style={{ boxShadow: "0 0 8px rgba(52,211,153,0.65)" }}
        />
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-300">Blueprint</h2>
        <span className="ml-auto rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
          Extracted
        </span>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
        {/* Title + summary */}
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Title</p>
          <p className="font-semibold text-slate-100">{blueprint.title}</p>
        </div>
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Summary</p>
          <p className="text-sm leading-relaxed text-slate-300">{blueprint.summary}</p>
        </div>

        {/* Assets */}
        {blueprint.assets.length > 0 && (
          <div>
            <p className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">
              Assets ({blueprint.assets.length})
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {blueprint.assets.map((asset) => (
                <li
                  key={asset.id}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${ASSET_CHIP[asset.type] ?? "border-slate-600/40 bg-slate-700/40 text-slate-300"}`}
                >
                  {asset.title}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Workflow steps */}
        {blueprint.workflow.length > 0 && (
          <div>
            <p className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">
              Workflow ({blueprint.workflow.length} steps)
            </p>
            <ol className="space-y-1.5">
              {blueprint.workflow.map((step, i) => (
                <li
                  key={step.id}
                  className="flex items-start gap-2.5 rounded-xl border border-slate-700/40 bg-shell-800/50 px-3 py-2"
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-accent-500/20 text-[10px] font-bold text-accent-400">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-200">{step.label}</p>
                    <p className="text-xs text-slate-500">{step.intent}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Risk flags */}
        {blueprint.riskFlags.length > 0 && (
          <div>
            <p className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Risk Flags</p>
            <ul className="space-y-1">
              {blueprint.riskFlags.map((flag, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400">
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeLinejoin="round" />
                    <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
                  </svg>
                  {flag}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
