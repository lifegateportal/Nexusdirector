import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";

export const runtime = "nodejs";

const RequestSchema = z.object({
  text: z.string().min(1).max(6000),
  lang: z.enum([
    "english",
    "spanish",
    "french",
    "portuguese",
    "german",
    "swahili",
    "twi",
    "kikuyu",
    "italian",
    "dutch",
    "arabic",
    "hindi",
    "russian",
    "ukrainian",
    "turkish",
    "chinese",
    "japanese",
    "korean",
    "amharic",
    "yoruba",
    "hausa",
  ]),
  glossary: z.array(z.object({ source: z.string().min(1).max(120), target: z.string().min(1).max(160) })).max(150).optional(),
  protectedTerms: z.array(z.string().min(1).max(120)).max(150).optional(),
});

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

const LANGUAGE_STYLE_GUIDE: Record<z.infer<typeof RequestSchema>["lang"], string> = {
  english: "natural modern English",
  spanish: "natural modern Spanish",
  french: "natural modern French",
  portuguese: "natural modern Portuguese",
  german: "natural modern German",
  swahili: "natural contemporary Swahili",
  twi: "natural Akan Twi",
  kikuyu: "natural Kikuyu (Gikuyu)",
  italian: "natural modern Italian",
  dutch: "natural modern Dutch",
  arabic: "natural modern Arabic",
  hindi: "natural modern Hindi",
  russian: "natural modern Russian",
  ukrainian: "natural modern Ukrainian",
  turkish: "natural modern Turkish",
  chinese: "natural modern Chinese (Mandarin)",
  japanese: "natural modern Japanese",
  korean: "natural modern Korean",
  amharic: "natural modern Amharic",
  yoruba: "natural modern Yoruba",
  hausa: "natural modern Hausa",
};

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function overlapRatio(source: string, output: string): number {
  const src = new Set(tokenize(source));
  const out = tokenize(output);
  if (src.size === 0 || out.length === 0) return 0;
  const matches = out.filter((token) => src.has(token)).length;
  return matches / out.length;
}

function looksLikeTransliteration(source: string, output: string): boolean {
  if (!source.trim() || !output.trim()) return false;
  if (output.length < 24) return false;

  const normalizedSource = source.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedOutput = output.toLowerCase().replace(/\s+/g, " ").trim();

  if (normalizedSource === normalizedOutput) return true;
  return overlapRatio(source, output) >= 0.78;
}

function buildSystemPrompt(
  targetLanguageLabel: string,
  styleGuide: string,
  strictAntiTransliteration: boolean,
  glossary: Array<{ source: string; target: string }>,
  protectedTerms: string[],
): string {
  const base = [
    `You are a highly accurate live translator to ${targetLanguageLabel}.`,
    `Return the translation in ${styleGuide}.`,
    "Preserve meaning, tone, and intent.",
    "Do not summarize.",
    "Do not add notes, labels, or quotes.",
    "Return ONLY the final translated text.",
  ];

  if (glossary.length > 0) {
    const glossaryRules = glossary
      .slice(0, 80)
      .map((item) => `${item.source} => ${item.target}`)
      .join("; ");
    base.push(`Terminology glossary (must be enforced when relevant): ${glossaryRules}`);
  }

  if (protectedTerms.length > 0) {
    const protectedRules = protectedTerms.slice(0, 80).join(", ");
    base.push(`Protected terms (never translate or alter): ${protectedRules}`);
  }

  if (strictAntiTransliteration) {
    base.push("Never transliterate or mimic source pronunciation.");
    base.push("Use true semantic translation in the target language.");
    base.push("If a term is unclear, translate by context instead of copying source words.");
  }

  return base.join(" ");
}

async function requestTranslation(text: string, systemPrompt: string): Promise<{ translation?: string; status?: number; error?: string }> {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: text,
        },
      ],
    }),
  });

  const data = await response.json() as DeepSeekResponse;
  if (!response.ok) {
    return {
      status: response.status,
      error: data.error?.message ?? `DeepSeek request failed (${response.status})`,
    };
  }

  return { translation: data.choices?.[0]?.message?.content?.trim() };
}

export async function POST(request: NextRequest) {
  let body: z.infer<typeof RequestSchema>;
  try {
    body = RequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request payload" },
      { status: 400 },
    );
  }

  if (!env.DEEPSEEK_API_KEY) {
    return NextResponse.json({ error: "DEEPSEEK_API_KEY is not configured" }, { status: 503 });
  }

  const targetLanguageLabel = body.lang[0].toUpperCase() + body.lang.slice(1);
  const styleGuide = LANGUAGE_STYLE_GUIDE[body.lang];
  const glossary = body.glossary ?? [];
  const protectedTerms = body.protectedTerms ?? [];

  try {
    const firstPass = await requestTranslation(
      body.text,
      buildSystemPrompt(targetLanguageLabel, styleGuide, false, glossary, protectedTerms),
    );
    if (!firstPass.translation) {
      return NextResponse.json(
        { error: firstPass.error ?? "Translation request failed" },
        { status: firstPass.status ?? 502 },
      );
    }

    let translation = firstPass.translation;
    if (looksLikeTransliteration(body.text, translation)) {
      const secondPass = await requestTranslation(
        body.text,
        buildSystemPrompt(targetLanguageLabel, styleGuide, true, glossary, protectedTerms),
      );

      if (secondPass.translation) {
        translation = secondPass.translation;
      }
    }

    return NextResponse.json({ translation });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Translation failed" },
      { status: 500 },
    );
  }
}
