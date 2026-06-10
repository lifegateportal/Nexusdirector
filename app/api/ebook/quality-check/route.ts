import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ChapterDraftSchema, ContentMapSchema, FrontBackMatterSchema } from "@/lib/schemas/ebook";
import { evaluateBookQuality } from "@/lib/ebook-quality";

export const runtime = "nodejs";
export const maxDuration = 30;

const QualityCheckRequestSchema = z.object({
  chapters: z.array(ChapterDraftSchema),
  contentMap: ContentMapSchema,
  frontMatter: FrontBackMatterSchema,
});

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = QualityCheckRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  const report = evaluateBookQuality({
    chapters: input.chapters,
    contentMap: input.contentMap,
    frontMatter: input.frontMatter,
  });

  return NextResponse.json(report, { status: 200 });
}
