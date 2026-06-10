/**
 * instruction-normalizer.ts
 *
 * Pre-processes a raw user instruction before it reaches the LLM.
 * Canonicalizes notation, expands synonyms, and disambiguates common
 * phrasings so DeepSeek receives a clear, unambiguous directive.
 *
 * No external dependencies — pure rule-based transforms.
 */

// ─────────────────────────────────────────────────────────────────────────────
// NOTATION NORMALIZERS
// Convert ambiguous shorthand into explicit prose the LLM can act on reliably.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Chapter 1.4" / "Ch1.4" / "chapter 1, section 4" → "section 4 of chapter 1"
 * "Section 2.3"                                      → "section 3 of chapter 2"
 */
function normalizeChapterSectionNotation(text: string): string {
  // "chapter 1.4", "ch 1.4", "Ch1.4"
  text = text.replace(
    /\bch(?:apter)?\s*(\d+)[.\-§,\s]+(\d+)\b/gi,
    (_m, ch, sec) => `section ${sec} of chapter ${ch}`,
  );
  // "section 1.4"
  text = text.replace(
    /\bsection\s+(\d+)[.\-§]+(\d+)\b/gi,
    (_m, ch, sec) => `section ${sec} of chapter ${ch}`,
  );
  // bare "1.4" when surrounded by non-numerics (avoid mangling decimals/dates)
  text = text.replace(
    /(?<![.\d])(\d+)\.(\d+)(?![.\d])/g,
    (_m, ch, sec) => `section ${sec} of chapter ${ch}`,
  );
  return text;
}

/**
 * Passive-voice move instructions → active canonical form understood by the LLM.
 * "section 4 of chapter 1 should be moved to chapter 3"
 *   → "move section 4 of chapter 1 to chapter 3"
 */
function normalizePassiveMove(text: string): string {
  // "(section/chapter X) should be moved / needs to be moved / must be moved to (Y)"
  text = text.replace(
    /(section\s+\d+\s+of\s+chapter\s+\d+|section\s+[\d.]+|chapter\s+[\d.]+)\s+(?:should\s+be|needs?\s+to\s+be|must\s+be|can\s+be|has\s+to\s+be)\s+moved\s+to\b/gi,
    (_m, ref) => `move ${ref} to`,
  );
  // "(ref) goes to / belongs to / belongs in (Y)"
  text = text.replace(
    /(section\s+\d+\s+of\s+chapter\s+\d+|section\s+[\d.]+|chapter\s+[\d.]+)\s+(?:goes?|belongs?)\s+(?:to|in)\b/gi,
    (_m, ref) => `move ${ref} to`,
  );
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNONYM EXPANDERS
// Map colloquial / ambiguous terms to canonical book-editing vocabulary.
// ─────────────────────────────────────────────────────────────────────────────

const SYNONYM_MAP: [RegExp, string][] = [
  // Restructure synonyms
  [/\breorganise\b/gi, "restructure"],
  [/\breorganize\b/gi, "restructure"],
  [/\brearrange\b/gi, "restructure"],
  [/\breshuffl/gi, "restructure"],

  // Live-audience language
  [/\bchurch\s+talk\b/gi, "live-audience language"],
  [/\bpulpit\s+language\b/gi, "live-audience language"],
  [/\bcongregation\s+chatter\b/gi, "live-audience language"],
  [/\baudience\s+talk\b/gi, "live-audience language"],
  [/\blive\s+service\s+language\b/gi, "live-audience language"],
  [/\btalking\s+to\s+(?:the\s+)?audience\b/gi, "live-audience language"],
  [/\bspeaker\s+talking\s+to\b/gi, "live-audience language"],
  [/\bcrowd\s+(?:talk|chatter|language)\b/gi, "live-audience language"],

  // Prose quality
  [/\btighten\s+up\b/gi, "improve and tighten"],
  [/\bclean\s+it\s+up\b/gi, "improve the prose of"],
  [/\bflows?\s+badly\b/gi, "has poor flow — rewrite"],
  [/\bread\s+better\b/gi, "flow better — rewrite"],

  // Endings / conclusions
  [/\bending\s+is\s+weak\b/gi, "conclusion needs rewriting"],
  [/\bfix\s+the\s+ending\b/gi, "rewrite the conclusion"],
  [/\bconclusion\s+drags\b/gi, "conclusion needs tightening — rewrite"],
  [/\bwrap\s+up\b/gi, "rewrite the conclusion of"],
  [/\bbetter\s+clos(?:e|ing)\b/gi, "stronger conclusion"],

  // Intros / openings
  [/\bbetter\s+hook\b/gi, "stronger intro"],
  [/\bstart\s+is\s+slow\b/gi, "intro is weak — rewrite"],
  [/\bfix\s+the\s+opening\b/gi, "rewrite the intro"],
  [/\bstrengthen\s+the\s+beginning\b/gi, "rewrite the intro"],
  [/\bopening\s+is\s+weak\b/gi, "intro needs rewriting"],

  // Front matter
  [/\babout\s+(?:the\s+)?author\s+section\b/gi, "author bio (frontMatter.aboutAuthor)"],
  [/\bauthor\s+bio\b/gi, "author bio (frontMatter.aboutAuthor)"],
  [/\breading\s+list\b/gi, "resources list (frontMatter.resourcesList)"],

  // Size adjustments
  [/\btoo\s+long\b/gi, "too long — condense"],
  [/\btoo\s+short\b/gi, "too short — expand"],
  [/\bcondense\b/gi, "shorten and condense"],
  [/\btrim\b/gi, "shorten"],

  // Takeaways
  [/\bkey\s+points?\b/gi, "key takeaways"],
  [/\bsummarise\s+chapter\b/gi, "add key takeaways to chapter"],
  [/\bsummarize\s+chapter\b/gi, "add key takeaways to chapter"],

  // Duplicate content
  [/\bsame\s+verse\s+appears\s+twice\b/gi, "duplicate scripture — remove the duplicate"],
  [/\bduplicate\s+bible\s+verses?\b/gi, "duplicate scripture — remove the duplicate"],
  [/\bscripture\s+is\s+repeated\b/gi, "scripture is duplicated — remove the duplicate reference"],

  // Book-wide scope signals
  [/\ball\s+chapters?\b/gi, "all chapters (book-wide operation)"],
  [/\bevery\s+chapter\b/gi, "every chapter (book-wide operation)"],
  [/\bthroughout\s+the\s+(?:whole\s+)?book\b/gi, "across all chapters (book-wide operation)"],
];

function expandSynonyms(text: string): string {
  for (const [pattern, replacement] of SYNONYM_MAP) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCOPE DISAMBIGUATOR
// Inject explicit scope hints so the LLM doesn't confuse chapter-level and
// section-level operations.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects "fix/update/improve/rewrite [the] introduction" without a chapter
 * number, which is ambiguous: it could mean the front-matter introduction or
 * a chapter intro.  When no chapter number follows, assume front matter.
 */
function disambiguateScope(text: string): string {
  // "rewrite the introduction" (no chapter number) → clarify front matter
  text = text.replace(
    /\b(rewrite|update|fix|improve|revise)\s+the\s+introduction(?!\s+of\s+chapter|\s+for\s+chapter|\s+in\s+chapter|\s+to\s+chapter|\s+\d)/gi,
    "$1 the book introduction (frontMatter.introduction)",
  );
  // "rewrite the preface" → clarify front matter
  text = text.replace(
    /\b(rewrite|update|fix|improve|revise)\s+the\s+preface\b/gi,
    "$1 the preface (frontMatter.preface)",
  );
  // "update the conclusion" (no chapter number) → front-matter conclusion
  text = text.replace(
    /\b(rewrite|update|fix|improve|revise)\s+the\s+conclusion(?!\s+of\s+chapter|\s+for\s+chapter|\s+in\s+chapter|\s+\d)/gi,
    "$1 the book conclusion (frontMatter.conclusion)",
  );
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalizedInstruction {
  /** The canonicalized instruction sent to the LLM. */
  normalized: string;
  /** True if the original differed from the normalized form (useful for debug logging). */
  wasChanged: boolean;
}

/**
 * Normalize a raw user instruction so DeepSeek can parse it reliably.
 * Applies transforms in order: notation → passive-voice → synonyms → scope.
 */
export function normalizeInstruction(raw: string): NormalizedInstruction {
  let text = raw.trim();

  text = normalizeChapterSectionNotation(text);
  text = normalizePassiveMove(text);
  text = expandSynonyms(text);
  text = disambiguateScope(text);

  // Collapse multiple spaces created by substitutions
  text = text.replace(/\s{2,}/g, " ").trim();

  return { normalized: text, wasChanged: text !== raw.trim() };
}
