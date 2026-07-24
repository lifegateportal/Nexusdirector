import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { deepSeekFlashModel } from "@/lib/ai-providers";
import { VoiceDNASchema, VoiceDNARequestSchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = VoiceDNARequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  // A7: Distributed 1800-word sample (600 × start/middle/end)
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
    const { object } = await generateObject({
      model: deepSeekFlashModel,
      schema: VoiceDNASchema,
      mode: "json",
      temperature: 0.2,
      maxTokens: 5120,
      system: `You are a master linguist and voice analyst who profiles published authors for professional ghostwriting engagements.
Your task: extract a precise, multi-dimensional Voice DNA from the provided transcript sample.

CARDINAL RULE: Extract ONLY patterns directly evidenced in this transcript.
Do not invent, infer, or generalize. Every entry must be traceable to actual words present.

═══════════════════════════════════
ARRAY SIZE LIMITS — strictly enforced
═══════════════════════════════════
- signaturePhrases: max 8 (verbatim repeated phrases, min 2 occurrences)
- preferredTerminology: max 10 (domain-specific vocabulary used consistently)
- rhetoricalPatterns: max 6 (teaching devices actually observed)
- avoidWords: max 30 (baseline 22 + up to 8 author-specific)
- vernacularMarkers: max 10 (community idioms that must appear verbatim)
- avoidStructures: max 10 (sentence-level structural patterns the author never uses)

═══════════════════════════════════
FIELD DEFINITIONS
═══════════════════════════════════
signaturePhrases
  Exact phrases repeated at least twice. Quote verbatim.

preferredTerminology
  Domain-specific words or concepts this author consistently chooses.

toneProfile
  One concise string capturing the emotional and relational tone.
  Example: "pastoral, direct, warm" or "authoritative, scholarly, measured"

sentencePattern
  Must be exactly one of: "short-punchy", "long-explanatory", or "mixed"

rhetoricalPatterns
  Observed teaching devices. Examples: "repeats key point three times", "uses rhetorical questions", "call-and-response structure"

teachingStyle
  How the author opens new topics, builds the argument, and lands the point.
  One to three sentences of observed behavior.

avoidWords
  Start with the mandatory AI-cliché baseline below, then append up to 8 words the author demonstrably never uses:
  BASELINE (always include ALL 30): ["In conclusion", "delve into", "tapestry", "navigating", "It's important to note", "Furthermore", "Moreover", "In today's fast-paced world", "It is crucial", "It is worth noting", "At the end of the day", "Game-changer", "Paradigm shift", "Deep dive", "Unpack", "Moving forward", "Robust", "Leverage", "Synergy", "It goes without saying", "The truth is,", "The fact of the matter is", "Indeed,", "Certainly,", "Ultimately,", "At its core,", "In essence,", "Simply put,", "profoundly", "transformative", "vibrant", "fostering", "journey (metaphorical)", "not just...but", "not merely...but", "This is not merely"]

vocabularyLevel
  Must be exactly one of: "conversational", "pastoral", "academic", "technical"
  Choose the single best match for this author's dominant register.

pacingFingerprint
  One sentence describing their rhythm and momentum pattern.

narrativeDevice
  How the author structures stories and illustrations.

emotionalArc
  The emotional modulation across a typical teaching unit.

vernacularMarkers
  Community-specific phrases or idioms that are a signature of this author's culture and must appear verbatim to authenticate voice.
  If none are present, return an empty array.

avoidStructures
  Sentence-level construction patterns the author never uses.

openingPattern
  How the author launches a new point or section.

closingPattern
  How the author lands and seals a point.`,
      prompt: `Extract the author's Voice DNA from this transcript sample:\n\n${sampleTranscript}`,
    });

    return NextResponse.json(object, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice DNA extraction failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
