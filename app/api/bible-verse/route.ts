import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 15;

const TRANSLATIONS = ["web", "kjv", "asv", "ylt", "basicenglish"] as const;
type Translation = typeof TRANSLATIONS[number];

const RequestSchema = z.object({
  reference: z.string().min(2).max(140),
  translation: z.enum(TRANSLATIONS).default("web"),
  returnVerses: z.boolean().default(false),
});

type BibleApiVerse = {
  book_id: string;
  book_name: string;
  chapter: number;
  verse: number;
  text: string;
};

type BibleApiResponse = {
  reference?: string;
  text?: string;
  error?: string;
  verses?: BibleApiVerse[];
  translation_id?: string;
};

function buildUrl(reference: string, translation: Translation): string {
  const encoded = encodeURIComponent(reference.replace(/\s+/g, "+"));
  return `https://bible-api.com/${encoded}?translation=${translation}`;
}

export async function POST(req: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await req.json() as unknown);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const url = buildUrl(input.reference, input.translation);
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(9000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const data = await res.json() as BibleApiResponse;

    if (data.error || !data.text) {
      return NextResponse.json({ error: data.error ?? "No text returned" }, { status: 404 });
    }

    if (input.returnVerses && data.verses && data.verses.length > 0) {
      const verses = data.verses.map((v) => ({
        ref: `${v.book_name} ${v.chapter}:${v.verse}`,
        text: v.text.replace(/\n+/g, " ").trim(),
      }));
      return NextResponse.json({
        reference: data.reference ?? input.reference,
        verses,
      });
    }

    return NextResponse.json({
      reference: data.reference ?? input.reference,
      text: data.text.replace(/\n+/g, " ").trim(),
    });
  } catch {
    return NextResponse.json({ error: "Fetch failed" }, { status: 502 });
  }
}
