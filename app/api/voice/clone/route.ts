/**
 * POST /api/voice/clone
 *
 * Submits a voice clone job to RunPod and returns immediately with the jobId.
 * The client polls /api/voice/clone/finalize to check status and get the voiceId.
 *
 * Body: { sampleUrl: string, ext?: string }
 * Response: { runpodJobId: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { resolveR2ObjectUrl } from "@/lib/r2-storage";

export const runtime = "nodejs";
export const maxDuration = 15;

const RequestSchema = z.object({
  sampleUrl: z.string().min(1),
  ext:       z.string().optional().default("wav"),
});

export async function POST(req: NextRequest) {
  const { RUNPOD_API_KEY, RUNPOD_VOICE_ENDPOINT_ID, RUNPOD_ENDPOINT_ID } = env;
  const endpointId = RUNPOD_VOICE_ENDPOINT_ID ?? RUNPOD_ENDPOINT_ID;

  if (!RUNPOD_API_KEY || !endpointId) {
    return NextResponse.json({ error: "RUNPOD_API_KEY and RUNPOD_VOICE_ENDPOINT_ID (or RUNPOD_ENDPOINT_ID) must be set" }, { status: 503 });
  }

  let input: z.infer<typeof RequestSchema>;
  try {
    const body = await req.json() as unknown;
    input = RequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid request" }, { status: 400 });
  }

  try {
    const sampleUrl = await resolveR2ObjectUrl(input.sampleUrl);
    const safeExt = (input.ext ?? "wav").toLowerCase().replace(/[^a-z0-9]/g, "") || "wav";

    const sampleRes = await fetch(sampleUrl);
    if (!sampleRes.ok) {
      const body = await sampleRes.text();
      throw new Error(`Sample fetch failed (${sampleRes.status}): ${body.slice(0, 300)}`);
    }
    const sampleBuffer = Buffer.from(await sampleRes.arrayBuffer());

    // RunPod request bodies are capped at 10 MiB. Base64 adds ~33% overhead,
    // so keep raw payloads <= 7 MiB on the inline path.
    const MAX_INLINE_BYTES = 7 * 1024 * 1024;
    const shouldInlineBase64 = sampleBuffer.byteLength <= MAX_INLINE_BYTES;

    const runpodInput = shouldInlineBase64
      ? {
          action: "clone",
          audio_base64: sampleBuffer.toString("base64"),
          ext: safeExt,
        }
      : {
          action: "clone",
          // Prefer the original uploaded URL when available to avoid very long
          // signed query strings in workers that infer extension from URL text.
          audio_url: /^https?:\/\//i.test(input.sampleUrl) ? input.sampleUrl : sampleUrl,
          ext: safeExt,
        };

    const submitRes = await fetch(`https://api.runpod.ai/v2/${endpointId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RUNPOD_API_KEY}` },
      body: JSON.stringify({ input: runpodInput }),
    });
    if (!submitRes.ok) {
      const body = await submitRes.text();
      throw new Error(`RunPod submit failed (${submitRes.status}): ${body.slice(0, 400)}`);
    }
    const { id: runpodJobId } = await submitRes.json() as { id: string };
    return NextResponse.json({ runpodJobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Submit failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
