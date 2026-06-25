import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import glossaryRaw from "@/lib/glossary.json";

export const runtime = "nodejs";
export const maxDuration = 30;

const GlossaryEntrySchema = z.object({
  wrong: z.string(),
  correct: z.string(),
});

const RequestSchema = z.object({
  masterTranscript: z.string().min(10),
});

const glossary = z.array(GlossaryEntrySchema).parse(glossaryRaw);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type SanitizeResult = {
  sanitizedTranscript: string;
  replacements: { wrong: string; correct: string; count: number }[];
};

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return NextResponse.json(
      {
        route: "ebook/sanitize",
        error: err instanceof Error ? err.message : "Invalid JSON payload",
      },
      { status: 400 }
    );
  }

  let input;
  try {
    input = RequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 }
    );
  }

  let text = input.masterTranscript;
  const replacements: SanitizeResult["replacements"] = [];

  for (const entry of glossary) {
    const pattern = new RegExp(escapeRegex(entry.wrong), "gi");
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      text = text.replace(pattern, entry.correct);
      replacements.push({ wrong: entry.wrong, correct: entry.correct, count: matches.length });
    }
  }

  return NextResponse.json(
    { sanitizedTranscript: text, replacements } satisfies SanitizeResult,
    { status: 200 }
  );
}
