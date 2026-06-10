import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { deepSeekModel } from "@/lib/ai-providers";
import { VoiceDNARequestSchema, VoiceDNASchema } from "@/lib/schemas/ebook";

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
    });

    // Extract the first {...} JSON block — handles leading text, code fences, or truncation artifacts
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Voice DNA response contained no JSON object. Raw: ${text.slice(0, 200)}`);

    // Attempt to parse; if truncated, close any open brackets and retry once
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      // Truncated JSON — close unclosed arrays and objects and retry
      let partial = jsonMatch[0];
      const openArrays = (partial.match(/\[/g) ?? []).length - (partial.match(/\]/g) ?? []).length;
      const openObjects = (partial.match(/\{/g) ?? []).length - (partial.match(/\}/g) ?? []).length;
      // Remove trailing comma or incomplete token before closing
      partial = partial.replace(/,\s*$/, "").replace(/,\s*"[^"]*$/, "");
      partial += "]".repeat(Math.max(0, openArrays)) + "}".repeat(Math.max(0, openObjects));
      raw = JSON.parse(partial) as Record<string, unknown>;
    }

    // Coerce sentencePattern to a valid enum value
    if (typeof raw.sentencePattern === "string") {
      const sp = raw.sentencePattern.toLowerCase();
      if (sp.includes("short") || sp.includes("punchy")) raw.sentencePattern = "short-punchy";
      else if (sp.includes("long") || sp.includes("explanatory")) raw.sentencePattern = "long-explanatory";
      else raw.sentencePattern = "mixed";
    }

    // Coerce vocabularyLevel to a valid enum value
    if (typeof raw.vocabularyLevel === "string") {
      const vl = raw.vocabularyLevel.toLowerCase();
      if (vl.includes("academic")) raw.vocabularyLevel = "academic";
      else if (vl.includes("technical")) raw.vocabularyLevel = "technical";
      else if (vl.includes("pastoral")) raw.vocabularyLevel = "pastoral";
      else raw.vocabularyLevel = "conversational";
    }

    // Hard-cap arrays so an over-generous model can never cause a truncation loop
    if (Array.isArray(raw.signaturePhrases))    raw.signaturePhrases    = (raw.signaturePhrases    as string[]).slice(0, 8);
    if (Array.isArray(raw.preferredTerminology)) raw.preferredTerminology = (raw.preferredTerminology as string[]).slice(0, 10);
    if (Array.isArray(raw.rhetoricalPatterns))  raw.rhetoricalPatterns  = (raw.rhetoricalPatterns  as string[]).slice(0, 6);
    if (Array.isArray(raw.avoidWords))          raw.avoidWords          = (raw.avoidWords          as string[]).slice(0, 30);
    if (Array.isArray(raw.vernacularMarkers))   raw.vernacularMarkers   = (raw.vernacularMarkers   as string[]).slice(0, 10);
    if (Array.isArray(raw.avoidStructures))     raw.avoidStructures     = (raw.avoidStructures     as string[]).slice(0, 10);

    const object = VoiceDNASchema.parse(raw);
    return NextResponse.json(object, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice DNA extraction failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
