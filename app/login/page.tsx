"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        router.push("/");
        router.refresh();
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Login failed");
        setPassword("");
        inputRef.current?.focus();
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-[#02040d] px-4">
      {/* Logo */}
      <div className="mb-8 flex flex-col items-center gap-3">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-500/20 ring-1 ring-cyan-400/50"
          style={{ boxShadow: "0 0 28px rgba(6,182,212,0.35)" }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-7 w-7 text-cyan-400">
            <path d="M12 2 21 6.5V17L12 21.5 3 17V6.5L12 2z" strokeLinejoin="round" />
            <path d="M12 2v19.5M3 6.5l9 5 9-5" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="text-center">
          <h1 className="text-lg font-semibold text-slate-100 tracking-tight">Nexus Director</h1>
          <p className="text-xs text-slate-500 mt-0.5">Enter your password to continue</p>
        </div>
      </div>

      {/* Card */}
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-slate-700/60 bg-slate-900/80 p-6 shadow-2xl backdrop-blur"
      >
        <label className="block mb-1.5 text-xs font-medium text-slate-400" htmlFor="password">
          Password
        </label>
        <input
          ref={inputRef}
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          disabled={loading}
          className={[
            "w-full rounded-xl border px-4 py-3 text-base bg-slate-800/70 text-slate-100",
            "placeholder:text-slate-600 outline-none transition-all",
            "focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/60",
            error ? "border-rose-500/60" : "border-slate-600/60",
            "disabled:opacity-50",
          ].join(" ")}
        />

        {error && (
          <p className="mt-2 text-xs text-rose-400 flex items-center gap-1.5">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 flex-shrink-0">
              <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" clipRule="evenodd" />
            </svg>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !password}
          className={[
            "mt-4 w-full min-h-[52px] rounded-xl font-semibold text-base transition-all",
            "bg-gradient-to-r from-cyan-500 to-violet-500 text-white",
            "hover:opacity-90 active:scale-[0.98]",
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100",
          ].join(" ")}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
              </svg>
              Unlocking…
            </span>
          ) : (
            "Unlock"
          )}
        </button>
      </form>
    </div>
  );
}
