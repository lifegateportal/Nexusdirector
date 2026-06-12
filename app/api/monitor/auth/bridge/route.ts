import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const MONITOR_COOKIE = "monitor_session";
const NEXUS_COOKIE = "nexus_session";

async function computeMonitorToken(secret: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`monitor:${password}`),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function computeNexusToken(secret: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(password));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(req: NextRequest) {
  const authPassword = process.env.AUTH_PASSWORD;
  const cookieSecret = process.env.AUTH_COOKIE_SECRET;

  if (!authPassword || !cookieSecret) {
    return NextResponse.json({ error: "Auth not configured" }, { status: 500 });
  }

  const nexusToken = req.cookies.get(NEXUS_COOKIE)?.value;
  if (!nexusToken) {
    return NextResponse.json({ error: "No app session found" }, { status: 401 });
  }

  const expectedNexus = await computeNexusToken(cookieSecret, authPassword);
  if (nexusToken !== expectedNexus) {
    return NextResponse.json({ error: "App session invalid" }, { status: 401 });
  }

  const monitorToken = await computeMonitorToken(cookieSecret, authPassword);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(MONITOR_COOKIE, monitorToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });

  return res;
}
