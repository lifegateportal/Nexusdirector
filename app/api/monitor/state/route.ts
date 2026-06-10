import { NextRequest, NextResponse } from "next/server";
import { getMonitorState } from "@/lib/monitor-state";

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

export async function GET(req: NextRequest) {
  const authPassword = process.env.AUTH_PASSWORD;
  const cookieSecret = process.env.AUTH_COOKIE_SECRET;

  if (!authPassword || !cookieSecret) {
    return NextResponse.json(getMonitorState());
  }

  const monitorToken = req.cookies.get(MONITOR_COOKIE)?.value;
  const nexusToken = req.cookies.get(NEXUS_COOKIE)?.value;

  const [expectedMonitor, expectedNexus] = await Promise.all([
    computeMonitorToken(cookieSecret, authPassword),
    computeNexusToken(cookieSecret, authPassword),
  ]);

  const isValid =
    (monitorToken && monitorToken === expectedMonitor) ||
    (nexusToken && nexusToken === expectedNexus);

  if (!isValid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(getMonitorState());
}
