import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { deepSeekModel } from "@/lib/ai-providers";
import { VoiceDNARequestSchema, VoiceDNASchema } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 120;

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 70000): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      const backoffMs = Math.min(7000, 1000 * Math.pow(2, attempt));
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`${label} failed after retries: ${detail}`);
}

function buildFallbackVoiceDNA(sampleTranscript: string) {
  const firstWords = sampleTranscript.split(/\s+/).filter(Boolean).slice(0, 1200).join(" ").toLowerCase();
  const rhetoricalPatterns: string[] = [];
  if (firstWords.includes("?")) rhetoricalPatterns.push("uses rhetorical questions");
  if (/(amen|hallelujah|praise)/i.test(firstWords)) rhetoricalPatterns.push("uses call-and-response cues");
  if (/(story|when i was|i remember|one day)/i.test(firstWords)) rhetoricalPatterns.push("uses personal story illustration");

  return VoiceDNASchema.parse({
    signaturePhrases: [],
    preferredTerminology: [],
    toneProfile: "pastoral, direct, conversational",
    sentencePattern: "mixed",
    rhetoricalPatterns,
    teachingStyle: "Builds practical teaching points from scripture and direct exhortation.",
    avoidWords: [
      "In conclusion",
      "delve into",
      "tapestry",
      "navigating",
      "It's important to note",
      "Furthermore",
      "Moreover",
      "In today's fast-paced world",
      "It is crucial",
      "It is worth noting",
      "At the end of the day",
      "Game-changer",
      "Paradigm shift",
      "Deep dive",
      "Unpack",
      "Moving forward",
      "Robust",
      "Leverage",
      "Synergy",
      "It goes without saying",
      "The truth is,",
      "The fact of the matter is",
      "Indeed,",
      "Certainly,",
      "Ultimately,",
      "At its core,",
      "In essence,",
      "Simply put,",
      "profoundly",
      "transformative",
    ],
    vocabularyLevel: "pastoral",
    pacingFingerprint: "Alternates explanatory teaching with direct, shorter exhortation.",
    narrativeDevice: "Uses examples and scripture to move from principle to application.",
    emotionalArc: "Begins with challenge, builds conviction, and ends in encouragement.",
    vernacularMarkers: [],
    avoidStructures: [],
    openingPattern: "Opens with a direct claim or question.",
    closingPattern: "Closes with a practical call to action.",
  });
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
    const { object } = await withRetry(
      () => withTimeout(generateObject({
        model: deepSeekModel,
        schema: VoiceDNASchema,
        mode: "tool",
        temperature: 0.2,
        maxTokens: 1800,
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
  BASELINE (always include ALL 30): ["In conclusion", "delve into", "tapestry", "navigating", "It's important to note", "Furthermore", "Moreover", "In today's fast-paced world", "It is crucial", "It is worth noting", "At the end of the day", "Game-changer", "Paradigm shift", "Deep dive", "Unpack", "Moving forward", "Robust", "Leverage", "Synergy", "It goes without saying", "The truth is,", "The fact of the matter is", "Indeed,", "Certainly,", "Ultimately,", "At its core,", "In essence,", "Simply put,", "profoundly", "transformative"]

vocabularyLevel
  Must be exactly one of: "conversational", "pastoral", "academic", "technical"
  Choose the single best match for this author's dominant register.

pacingFingerprint
  One sentence describing their rhythm and momentum pattern.
  Example: "slow narrative build followed by rapid-fire doctrinal landing" or "staccato declarative bursts punctuated by extended personal illustration"

narrativeDevice
  How the author structures stories and illustrations.
  Example: "opens mid-scene with dramatic detail, then extracts the spiritual principle at the end"

emotionalArc
  The emotional modulation across a typical teaching unit.
  Example: "opens with communal challenge, builds doctrinal conviction, releases into personal hope and encouragement"

vernacularMarkers
  Community-specific phrases or idioms that are a signature of this author's culture and must appear verbatim to authenticate voice.
  Example: ["Somebody ought to praise Him right there", "Watch this now", "Can I tell you something?"]
  If none are present, return an empty array.

avoidStructures
  Sentence-level construction patterns the author never uses.
  Example: ["never stacks three consecutive rhetorical questions", "never opens a paragraph with 'The truth is'", "never uses 'not only...but also' framing"]

openingPattern
  How the author launches a new point or section.
  Example: "poses a direct question to the audience, then answers it with a scripture anchor"

closingPattern
  How the author lands and seals a point.
  Example: "restates the core thesis with a subtle twist, then ends on a concrete imperative or blessing"

═══════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════
Respond with ONLY a valid JSON object — no markdown fences, no commentary — matching this exact shape:
{
  "signaturePhrases": ["..."],
  "preferredTerminology": ["..."],
  "toneProfile": "...",
  "sentencePattern": "short-punchy" | "long-explanatory" | "mixed",
  "rhetoricalPatterns": ["..."],
  "teachingStyle": "...",
  "avoidWords": ["..."],
  "vocabularyLevel": "conversational" | "pastoral" | "academic" | "technical",
  "pacingFingerprint": "...",
  "narrativeDevice": "...",
  "emotionalArc": "...",
  "vernacularMarkers": ["..."],
  "avoidStructures": ["..."],
  "openingPattern": "...",
  "closingPattern": "..."
}`,
        prompt: `Extract the author's Voice DNA from this transcript sample:\n\n${sampleTranscript}`,
      }), "voice-dna generation"),
      "voice-dna extraction",
      2
    );
    return NextResponse.json(VoiceDNASchema.parse(object), { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice DNA extraction failed";
    console.warn("[voice-dna] Falling back to deterministic profile:", message);
    const fallback = buildFallbackVoiceDNA(sampleTranscript);
    return NextResponse.json(fallback, { status: 200 });
  }
}
