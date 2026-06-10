import { NextRequest, NextResponse } from "next/server";
import { setMonitorDisplay, clearMonitorDisplay } from "@/lib/monitor-state";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { ref?: string; text?: string; clear?: boolean };
  try {
    body = await req.json() as { ref?: string; text?: string; clear?: boolean };
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  if (body.clear) {
    clearMonitorDisplay();
  } else if (body.ref && body.text) {
    setMonitorDisplay(body.ref, body.text);
  } else {
    return NextResponse.json({ error: "Missing ref or text" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
