import { NextRequest, NextResponse } from "next/server";
import {
  setMonitorDisplay,
  clearMonitorDisplay,
  enqueueForOperator,
  operatorGo,
  operatorSkip,
  setQueueMode,
  getMonitorState,
} from "@/lib/monitor-state";

export const runtime = "nodejs";

type PushBody =
  | { ref: string; text: string; clear?: never; operatorGo?: never; operatorSkip?: never; setQueueMode?: never }
  | { clear: true; ref?: never; text?: never }
  | { operatorGo: true; ref?: never; text?: never }
  | { operatorSkip: true; ref?: never; text?: never }
  | { setQueueMode: boolean; ref?: never; text?: never };

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  if (body.clear === true) {
    clearMonitorDisplay();
    return NextResponse.json({ ok: true });
  }

  if (body.operatorGo === true) {
    operatorGo();
    return NextResponse.json({ ok: true, state: getMonitorState() });
  }

  if (body.operatorSkip === true) {
    operatorSkip();
    return NextResponse.json({ ok: true, state: getMonitorState() });
  }

  if (typeof body.setQueueMode === "boolean") {
    setQueueMode(body.setQueueMode);
    return NextResponse.json({ ok: true });
  }

  if (typeof body.ref === "string" && typeof body.text === "string") {
    const state = getMonitorState();
    if (state.queueMode) {
      enqueueForOperator(body.ref, body.text);
    } else {
      setMonitorDisplay(body.ref, body.text);
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Missing ref or text" }, { status: 400 });
}
