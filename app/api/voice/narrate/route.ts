/**
 * POST /api/voice/narrate
 *
 * Submits a chapter synthesis job to RunPod and returns immediately with the jobId.
 * The client polls /api/voice/narrate/finalize to check status and get the audioUrl.
 *
 * Body: { text, voiceId, chapterId, slug, language?, speed? }
 * Response: { runpodJobId: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { resolveR2ObjectUrl } from "@/lib/r2-storage";

export const runtime = "nodejs";
export const maxDuration = 15;

const RequestSchema = z.object({
  text:       z.string().min(1).max(50_000),
  voiceId:    z.string().min(1, "voiceId is required"),
  chapterId:  z.string().min(1).max(100),
  slug:       z.string().min(1).max(100),
  language:   z.string().default("en"),
  speed:      z.number().min(0.5).max(2.0).default(1.0),
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

  // Strip markdown so the TTS model reads clean prose, not formatting symbols
  const cleanText = input.text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  try {
    const speakerWavUrl = await resolveR2ObjectUrl(input.voiceId);

    const submitRes = await fetch(`https://api.runpod.ai/v2/${endpointId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RUNPOD_API_KEY}` },
      body: JSON.stringify({
        input: {
          action: "synthesize",
          text: cleanText,
          speaker_wav_url: speakerWavUrl,
          language: input.language,
          speed: input.speed,
          // Pass chapter metadata so finalize can build the R2 key
          chapter_id: input.chapterId,
          slug: input.slug,
        },
      }),
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
