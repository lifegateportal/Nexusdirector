import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  context: z.string().min(20).max(4000),
  existingRefs: z.array(z.string().max(64)).max(50).optional().default([]),
});

const SuggestionSchema = z.object({
  suggestions: z.array(z.object({
    ref: z.string().min(3).max(40),
    text: z.string().min(6).max(280),
    reason: z.string().min(6).max(180),
    confidence: z.number().min(0).max(1),
  })).max(3),
});

export async function POST(req: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await req.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 },
    );
  }

  try {
    const result = await generateObject({
      model: deepSeekModel,
      schema: SuggestionSchema,
      temperature: 0.2,
      system: [
        "You are a Bible reference matcher for sermon prep.",
        "Given a paraphrased theology statement, suggest likely scripture references.",
        "Return only highly plausible references, not exhaustive lists.",
        "Do not suggest refs already in existingRefs.",
        "If confidence is low, return an empty suggestions array.",
      ].join("\n"),
      prompt: [
        `CONTEXT:\n${input.context}`,
        `EXISTING_REFS:\n${input.existingRefs.join(", ") || "(none)"}`,
      ].join("\n\n"),
    });

    const filtered = result.object.suggestions.filter(
      (item) => !input.existingRefs.some((ref) => ref.toLowerCase() === item.ref.toLowerCase()),
    );

    return NextResponse.json({ suggestions: filtered });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
