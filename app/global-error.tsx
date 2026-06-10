"use client";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ background: "#02040d", color: "#e2e8f0", fontFamily: "monospace", padding: "2rem" }}>
        <h2 style={{ color: "#f87171", marginBottom: "1rem" }}>Application Error</h2>
        <pre style={{ background: "#0f172a", padding: "1rem", borderRadius: "0.5rem", overflowX: "auto", fontSize: "0.75rem", color: "#fca5a5", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {error?.message ?? "Unknown error"}
          {"\n\n"}
          {error?.stack ?? "No stack trace"}
          {"\n\nDigest: "}
          {error?.digest ?? "none"}
        </pre>
      </body>
    </html>
  );
}
