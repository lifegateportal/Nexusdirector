import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  if (!env.DEEPGRAM_API_KEY) {
    return NextResponse.json({ error: "DEEPGRAM_API_KEY not configured" }, { status: 503 });
  }
  return NextResponse.json({ apiKey: env.DEEPGRAM_API_KEY });
}
