import { NextRequest, NextResponse } from "next/server";
import {
  setMonitorDisplay,
  clearMonitorDisplay,
  enqueueForOperator,
  operatorGo,
  operatorSkip,
  setQueueMode,
  setDisplayPrefs,
  getMonitorState,
} from "@/lib/monitor-state";
import { z } from "zod";

export const runtime = "nodejs";

type PushBody =
  | { ref: string; text: string; clear?: never; operatorGo?: never; operatorSkip?: never; setQueueMode?: never }
  | { clear: true; ref?: never; text?: never }
  | { operatorGo: true; ref?: never; text?: never }
  | { operatorSkip: true; ref?: never; text?: never }
  | { setQueueMode: boolean; ref?: never; text?: never }
  | {
      setDisplayPrefs: {
        layout?: "center" | "lower-third";
        background?: "black" | "midnight" | "sunrise" | "ocean" | "charcoal" | "transparent";
        fontStyle?: "serif" | "sans" | "display";
        lowerThirdBackground?: "solid" | "glass" | "transparent";
        centerRefSize?: number;
        centerVerseSize?: number;
        lowerRefSize?: number;
        lowerVerseSize?: number;
        lowerThirdSize?: "compact" | "standard" | "large";
      };
      ref?: never;
      text?: never;
    };

const prefsSchema = z.object({
  layout: z.enum(["center", "lower-third"]).optional(),
  background: z.enum(["black", "midnight", "sunrise", "ocean", "charcoal", "transparent"]).optional(),
  fontStyle: z.enum(["serif", "sans", "display"]).optional(),
  lowerThirdBackground: z.enum(["solid", "glass", "transparent"]).optional(),
  centerRefSize: z.number().int().min(16).max(90).optional(),
  centerVerseSize: z.number().int().min(28).max(140).optional(),
  lowerRefSize: z.number().int().min(12).max(56).optional(),
  lowerVerseSize: z.number().int().min(20).max(96).optional(),
  lowerThirdSize: z.enum(["compact", "standard", "large"]).optional(),
}).strict();

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

  if (typeof body.setDisplayPrefs === "object" && body.setDisplayPrefs !== null) {
    const parsed = prefsSchema.safeParse(body.setDisplayPrefs);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid display preferences" }, { status: 400 });
    }
    setDisplayPrefs(parsed.data);
    return NextResponse.json({ ok: true, state: getMonitorState() });
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
