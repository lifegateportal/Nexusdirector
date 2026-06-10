import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { deepSeekReasonerModel } from "@/lib/ai-providers";

export const runtime = "nodejs";
export const maxDuration = 120;

const RequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("outline"),
    rawTranscript: z.string().min(1).max(120000),
  }),
  z.object({
    action: z.literal("command"),
    rawTranscript: z.string().min(1).max(120000),
    organizedMarkdown: z.string().max(120000).optional().default(""),
    command: z.string().min(1).max(2000),
  }),
]);

function outlineSystemPrompt(): string {
  return [
    "You are Nexus Sermon Assistant.",
    "Transform spoken transcript into a clear, well-organized sermon manuscript outline in Markdown.",
    "The user wants organized notes they can preach from and manually edit later.",
    "Use this structure whenever source supports it:",
    "# Sermon Title",
    "## Central Theme",
    "## Key Scriptures",
    "### Scripture Reference",
    "> Full scripture text",
    "- Why it matters in the sermon",
    "## Opening",
    "## Main Movement 1",
    "## Main Movement 2",
    "## Main Movement 3",
    "## Supporting Notes",
    "## Invitation / Response",
    "## Closing Prayer",
    "Keep it faithful to the transcript.",
    "If the speaker directly quoted scripture or clearly alluded to a scripture, identify it and include the full verse text when you can do so with high confidence.",
    "If a hinted scripture is plausible but not certain, place it under Key Scriptures with a note saying it is a likely reference.",
    "Do not invent stories, sermon points, or references not grounded in the transcript.",
    "Use bullet points for subpoints, transitions, applications, and supporting notes.",
    "Use blockquotes for scripture quotations.",
    "Preserve the speaker's language where it is strong, but rewrite into a clean, readable structure.",
    "Output only final Markdown.",
  ].join("\n");
}

function commandSystemPrompt(): string {
  return [
    "You are Nexus Sermon Assistant.",
    "You receive: transcript, current outline, and a user command.",
    "Apply the command precisely and return the complete updated sermon outline in Markdown.",
    "Edit only the scope requested by the user.",
    "If the user asks for changes to one section, only change that section and keep all other sections intact.",
    "Do not delete, condense, or rewrite unrelated sections.",
    "Preserve existing headings and order unless the user explicitly asks to move/remove/restructure them.",
    "When unsure, prefer minimal diffs over broad rewrites.",
    "Keep the outline well organized and preachable.",
    "Retain or improve the Key Scriptures section with full verse text for clearly identified scriptures and likely-reference notes for hints/allusions.",
    "Preserve unaffected sections.",
    "Do not add fabricated details not inferable from source material.",
    "Output only final Markdown.",
  ].join("\n");
}

function countWords(text: string): number {
  const tokens = text.trim().match(/\S+/g);
  return tokens ? tokens.length : 0;
}

function countHeadings(text: string): number {
  const matches = text.match(/^#{1,6}\s+/gm);
  return matches ? matches.length : 0;
}

function isGlobalRewriteCommand(command: string): boolean {
  return /(rewrite\s+(the\s+)?(entire|whole|full)|rewrite\s+all|overhaul|replace\s+everything|summari[sz]e\s+(the\s+)?(entire|whole|full)|condense\s+(the\s+)?(entire|whole|full)|shorten\s+(the\s+)?(entire|whole|full)|trim\s+everything)/i.test(command);
}

function looksAggressivelyTrimmed(previous: string, next: string, command: string): boolean {
  if (isGlobalRewriteCommand(command)) return false;

  const prevWords = countWords(previous);
  const nextWords = countWords(next);
  if (prevWords < 120) return false;

  const wordRatio = nextWords / Math.max(1, prevWords);
  const prevHeadings = countHeadings(previous);
  const nextHeadings = countHeadings(next);
  const headingRatio = prevHeadings > 0 ? nextHeadings / prevHeadings : 1;

  return wordRatio < 0.7 || headingRatio < 0.6;
}

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof RequestSchema>;
  try {
    parsed = RequestSchema.parse(await req.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 },
    );
  }

  try {
    if (parsed.action === "outline") {
      const { text } = await generateText({
        model: deepSeekReasonerModel,
        temperature: 0.3,
        maxTokens: 2800,
        system: outlineSystemPrompt(),
        prompt: `RAW TRANSCRIPT:\n${parsed.rawTranscript}`,
      });

      return NextResponse.json({ markdown: text.trim() });
    }

    const prompt = [
      `RAW TRANSCRIPT:\n${parsed.rawTranscript}`,
      `CURRENT OUTLINE:\n${parsed.organizedMarkdown}`,
      `COMMAND:\n${parsed.command}`,
    ].join("\n\n");

    const first = await generateText({
      model: deepSeekReasonerModel,
      temperature: 0.25,
      maxTokens: 3600,
      system: commandSystemPrompt(),
      prompt,
    });

    let markdown = first.text.trim();

    if (looksAggressivelyTrimmed(parsed.organizedMarkdown, markdown, parsed.command)) {
      const retry = await generateText({
        model: deepSeekReasonerModel,
        temperature: 0.2,
        maxTokens: 3800,
        system: [
          commandSystemPrompt(),
          "CRITICAL: Your previous draft removed too much content.",
          "Return the full outline while editing only the requested section(s).",
          "Keep all untouched headings and paragraphs from CURRENT OUTLINE.",
        ].join("\n"),
        prompt,
      });

      const retryMarkdown = retry.text.trim();
      markdown = looksAggressivelyTrimmed(parsed.organizedMarkdown, retryMarkdown, parsed.command)
        ? parsed.organizedMarkdown
        : retryMarkdown;
    }

    return NextResponse.json({ markdown });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Generation failed" },
      { status: 500 },
    );
  }
}