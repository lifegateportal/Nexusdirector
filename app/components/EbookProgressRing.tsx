"use client";

type EbookProgressRingProps = {
  total: number;
  completed: number;
  label?: string;
  size?: number;
};

export function EbookProgressRing({
  total,
  completed,
  label,
  size = 96,
}: EbookProgressRingProps) {
  const radius = (size - 12) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = total > 0 ? completed / total : 0;
  const strokeDashoffset = circumference * (1 - pct);
  const displayPct = Math.round(pct * 100);

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(6,182,212,0.12)"
          strokeWidth={8}
        />
        {/* Progress */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={pct === 1 ? "#34d399" : "#06b6d4"}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{ transition: "stroke-dashoffset 0.4s ease, stroke 0.3s ease" }}
        />
        {/* Center text — counter-rotate so it reads normally */}
        <text
          x={size / 2}
          y={size / 2 + 1}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={size * 0.22}
          fontFamily="ui-monospace, monospace"
          fill={pct === 1 ? "#34d399" : "#06b6d4"}
          style={{ transform: `rotate(90deg) translate(0px, -${size}px)` }}
        >
          {displayPct}%
        </text>
      </svg>
      {label && (
        <span className="text-xs text-slate-400 text-center leading-tight max-w-[96px]">
          {label}
        </span>
      )}
      {total > 0 && (
        <span className="text-[10px] text-slate-500 tabular-nums">
          {completed}/{total}
        </span>
      )}
    </div>
  );
}
