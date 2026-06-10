"use client";

type Props = { current: number; total: number; accent: string };

export function ProgressBar({ current, total, accent }: Props) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  return (
    <div
      style={{
        position:   "absolute",
        top:        0,
        left:       0,
        right:      0,
        height:     "2px",
        background: "transparent",
        zIndex:     50,
      }}
    >
      <div
        style={{
          height:     "100%",
          width:      `${pct}%`,
          background: accent,
          transition: "width 0.5s ease",
          borderRadius: "0 1px 1px 0",
        }}
      />
    </div>
  );
}
