"use client";

import { useEffect, useRef, useState } from "react";

type MonitorState = {
  ref: string;
  text: string;
  updatedAt: number;
  cleared: boolean;
};

export default function MonitorPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [logging, setLogging] = useState(false);
  const [display, setDisplay] = useState<MonitorState | null>(null);
  const lastUpdatedAt = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollState = async () => {
    try {
      const res = await fetch("/api/monitor/state");
      if (res.status === 401) {
        setAuthed(false);
        if (intervalRef.current) clearInterval(intervalRef.current);
        return;
      }
      if (!res.ok) return;
      const data = await res.json() as MonitorState;
      if (data.updatedAt !== lastUpdatedAt.current) {
        lastUpdatedAt.current = data.updatedAt;
        setDisplay(data);
      }
    } catch {
      // network blip — continue
    }
  };

  useEffect(() => {
    void pollState().then(() => {
      setAuthed((a) => a === null ? false : a);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPolling = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => void pollState(), 2000);
  };

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/monitor/state");
      if (res.ok) {
        const data = await res.json() as MonitorState;
        lastUpdatedAt.current = data.updatedAt;
        setDisplay(data);
        setAuthed(true);
        startPolling();
      } else {
        setAuthed(false);
      }
    })();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");
    setLogging(true);
    try {
      const res = await fetch("/api/monitor/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setLoginError("Incorrect password. Try again.");
        return;
      }
      setAuthed(true);
      startPolling();
      void pollState();
    } catch {
      setLoginError("Connection error. Please retry.");
    } finally {
      setLogging(false);
    }
  };

  if (authed === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-black">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-yellow-400 border-t-transparent" />
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-[#0a0a0a]">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-black/70 p-8 shadow-2xl">
          <div className="mb-8 text-center">
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-yellow-400">Nexus Director</p>
            <h1 className="mt-2 text-2xl font-bold text-white">Scripture Monitor</h1>
            <p className="mt-1 text-sm text-white/40">Enter the access password to connect</p>
          </div>
          <form onSubmit={(e) => void handleLogin(e)} className="space-y-4">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/30 outline-none focus:border-yellow-400/60 focus:ring-1 focus:ring-yellow-400/30"
            />
            {loginError && <p className="text-xs text-red-400">{loginError}</p>}
            <button
              type="submit"
              disabled={logging || !password}
              className="w-full rounded-xl bg-yellow-400 py-3 text-sm font-bold text-black transition hover:bg-yellow-300 disabled:opacity-50"
            >
              {logging ? "Connecting…" : "Connect"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const isLive = display && !display.cleared && display.ref;

  return (
    <div className="flex h-screen flex-col items-center justify-center overflow-hidden bg-black text-white">
      {isLive ? (
        <div
          key={display.updatedAt}
          className="animate-fadein w-full max-w-5xl px-12 text-center"
        >
          <p
            className="mb-8 text-2xl font-bold uppercase tracking-[0.3em] text-yellow-400"
            style={{ textShadow: "0 0 40px rgba(250,204,21,0.5)" }}
          >
            {display.ref}
          </p>
          <p
            className="font-serif text-5xl leading-snug text-white md:text-6xl"
            style={{ textShadow: "0 2px 20px rgba(255,255,255,0.15)" }}
          >
            &ldquo;{display.text}&rdquo;
          </p>
        </div>
      ) : (
        <div className="text-center">
          <p className="text-xs font-bold uppercase tracking-[0.4em] text-white/20">Nexus Director</p>
          <p className="mt-3 text-sm text-white/10">Waiting for scripture…</p>
        </div>
      )}

      <style>{`
        @keyframes fadein {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .animate-fadein { animation: fadein 0.5s ease both; }
      `}</style>
    </div>
  );
}
