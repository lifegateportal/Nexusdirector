import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { deepSeekModel } from "@/lib/ai-providers";
import { VoiceDNARequestSchema, VoiceDNASchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 120;

function parseVoiceDnaJson(text: string): Record<string, unknown> {
  // Remove markdown code fences if present
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Voice DNA response contained no JSON object");
  }
  
  let rawBlock = match[0];
  
  try {
    return JSON.parse(rawBlock) as Record<string, unknown>;
  } catch (parseErr) {
    // Attempt repair for truncated JSON
    try {
      const openArrays = (rawBlock.match(/\[/g) ?? []).length - (rawBlock.match(/\]/g) ?? []).length;
      const openObjects = (rawBlock.match(/\{/g) ?? []).length - (rawBlock.match(/\}/g) ?? []).length;
      
      // Remove trailing incomplete tokens
      rawBlock = rawBlock.replace(/,\s*$/, "").replace(/,\s*"[^"]*$/, "").replace(/:\s*"[^"]*$/, ": \"\"");
      
      // Close unclosed structures
      rawBlock += "]".repeat(Math.max(0, openArrays)) + "}".repeat(Math.max(0, openObjects));
      
      return JSON.parse(rawBlock) as Record<string, unknown>;
    } catch {
      // If repair fails, throw original error
      throw parseErr;
    }
  }
}

function normalizeVoiceDna(raw: Record<string, unknown>) {
  const normalized: Record<string, unknown> = {
    signaturePhrases: [],
    preferredTerminology: [],
    toneProfile: "conversational, direct",
    sentencePattern: "mixed",
    rhetoricalPatterns: [],
    teachingStyle: "Builds teaching points from scripture and practical application.",
    avoidWords: [
      "In conclusion", "delve into", "tapestry", "navigating", "Furthermore",
      "Moreover", "It is crucial", "At the end of the day", "Game-changer",
      "Paradigm shift", "Deep dive", "Unpack", "Moving forward", "Robust",
      "Leverage", "Synergy", "profoundly", "transformative"
    ],
    vocabularyLevel: "conversational",
    pacingFingerprint: "Alternates between explanation and direct application.",
    narrativeDevice: "Uses examples to illustrate principles.",
    emotionalArc: "Builds from challenge to encouragement.",
    vernacularMarkers: [],
    avoidStructures: [],
    openingPattern: "Opens with direct claim or question.",
    closingPattern: "Closes with practical application.",
    ...raw,
  };

  if (typeof normalized.sentencePattern === "string") {
    const sp = normalized.sentencePattern.toLowerCase();
    if (sp.includes("short") || sp.includes("punchy")) normalized.sentencePattern = "short-punchy";
    else if (sp.includes("long") || sp.includes("explanatory")) normalized.sentencePattern = "long-explanatory";
    else normalized.sentencePattern = "mixed";
  }

  if (typeof normalized.vocabularyLevel === "string") {
    const vl = normalized.vocabularyLevel.toLowerCase();
    if (vl.includes("academic")) normalized.vocabularyLevel = "academic";
    else if (vl.includes("technical")) normalized.vocabularyLevel = "technical";
    else if (vl.includes("pastoral")) normalized.vocabularyLevel = "pastoral";
    else normalized.vocabularyLevel = "conversational";
  }

  if (Array.isArray(normalized.signaturePhrases)) normalized.signaturePhrases = normalized.signaturePhrases.slice(0, 8);
  if (Array.isArray(normalized.preferredTerminology)) normalized.preferredTerminology = normalized.preferredTerminology.slice(0, 10);
  if (Array.isArray(normalized.rhetoricalPatterns)) normalized.rhetoricalPatterns = normalized.rhetoricalPatterns.slice(0, 6);
  if (Array.isArray(normalized.avoidWords)) {
    normalized.avoidWords = normalized.avoidWords.slice(0, 30);
  }
  if (Array.isArray(normalized.vernacularMarkers)) normalized.vernacularMarkers = normalized.vernacularMarkers.slice(0, 10);
  if (Array.isArray(normalized.avoidStructures)) normalized.avoidStructures = normalized.avoidStructures.slice(0, 10);

  return VoiceDNASchema.parse(normalized);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = VoiceDNARequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  // A7: Distributed 1800-word sample (600 × start/middle/end) — tripled from 900 words
  // to improve voice coverage across 6-slot projects where the old "middle" landed near
  // a structural break rather than a peak teaching section.
  const words = input.masterTranscript.split(/\s+/);
  const total = words.length;
  const startSample = words.slice(0, 600).join(" ");
  const midStart = Math.max(600, Math.floor(total / 2) - 300);
  const midSample = words.slice(midStart, midStart + 600).join(" ");
  const endSample = words.slice(Math.max(0, total - 600)).join(" ");
  const sampleTranscript = [
    "[START]\n" + startSample,
    "[MIDDLE]\n" + midSample,
    "[END]\n" + endSample,
  ].join("\n\n---\n\n");

  try {
    const { text } = await generateText({
      model: deepSeekModel,
      temperature: 0.2,
      maxTokens: 2000,
      system: `Extract voice profile from transcript. Return JSON only.
Required fields: signaturePhrases (array, max 8), preferredTerminology (array, max 10), toneProfile (string), sentencePattern (must be: "short-punchy" or "long-explanatory" or "mixed"), rhetoricalPatterns (array, max 6), teachingStyle (string), avoidWords (array, max 30), vocabularyLevel (must be: "conversational" or "pastoral" or "academic" or "technical"), pacingFingerprint (string), narrativeDevice (string), emotionalArc (string), vernacularMarkers (array, max 10), avoidStructures (array, max 10), openingPattern (string), closingPattern (string).
Extract only from evidence in transcript. No markdown, no explanation.`,
      prompt: `Transcript sample:\n\n${sampleTranscript}`,
    });

    const parsed = parseVoiceDnaJson(text);
    const validated = normalizeVoiceDna(parsed);
    return NextResponse.json(validated, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice DNA extraction failed";
    console.error("[voice-dna] Error:", message);
    return NextResponse.json(
      {
        route: "ebook/voice-dna",
        error: "Voice DNA extraction failed",
        details: message,
      },
      { status: 502 }
    );
  }
}
