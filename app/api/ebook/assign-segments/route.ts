import { NextRequest, NextResponse } from "next/server";
import {
  AssignSegmentsRequestSchema,
} from "@/lib/schemas/ebook";
import type { SectionAssignment } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = AssignSegmentsRequestSchema.parse(body);
  } catch (err) {
    console.error("[assign-segments] Schema validation failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  try {
    const chapters = Array.isArray(input.architecture?.chapters) ? input.architecture.chapters : [];
    const segments = Array.isArray(input.contentMap?.segments) ? input.contentMap.segments : [];

    console.log(`[assign-segments] Processing ${chapters.length} chapters, ${segments.length} segments`);

    if (chapters.length === 0) {
      console.error("[assign-segments] Architecture is missing chapters");
      return NextResponse.json({ error: "Architecture is missing chapters" }, { status: 400 });
    }
    if (segments.length === 0) {
      console.error("[assign-segments] Content map is missing segments");
      return NextResponse.json({ error: "Content map is missing segments" }, { status: 400 });
    }

    // Build a segment lookup for fast retrieval
    const segmentMap = Object.fromEntries(
      segments.map((s) => [s.id, s])
    );

    // ── Scripture Amendment 4: Compute dominant Bible translation ──────────
    // Count non-empty translation strings across all quotes in the content map.
    // The most-frequent one becomes the book's primaryTranslation, used as the
    // default when a verse is quoted without an explicit translation label.
    const translationCounts: Record<string, number> = {};
    for (const q of input.contentMap.allQuotes ?? []) {
      const t = (q.translation ?? "").trim().toUpperCase();
      if (t) translationCounts[t] = (translationCounts[t] ?? 0) + 1;
    }
    const primaryTranslation = Object.keys(translationCounts).length > 0
      ? Object.entries(translationCounts).sort((a, b) => b[1] - a[1])[0][0]
      : undefined;

    // Build all assignments by resolving segment text for each section
    const assignments = chapters.flatMap((chapter, chIdx) => {
      if (!Array.isArray(chapter.sections)) {
        console.error(`[assign-segments] Chapter ${chapter.number} has no sections array`);
        return [];
      }
      
      return chapter.sections.map((section, idx) => {
        try {
          const sourceSegmentIds = Array.isArray(section.sourceSegmentIds) ? section.sourceSegmentIds : [];
          const excerpts = sourceSegmentIds
            .map((id) => segmentMap[id]?.rawText ?? "")
            .filter(Boolean);

          // We don't have the previous section's ending yet (that gets filled at write time)
          return {
            chapterNumber: chapter.number,
            chapterTitle: chapter.title,
            sectionNumber: section.sectionNumber,
            heading: section.heading,
            transcriptExcerpts: excerpts,
            quotes: Array.isArray(section.quotesInSection) ? section.quotesInSection : [],
            keyPoints: Array.isArray(section.keyPoints) ? section.keyPoints : [],
            voiceDNA: input.voiceDNA,
            previousSectionEnding: "", // filled in at write time by the pipeline client
            targetWordCount: section.targetWordCount ?? 500,
            // Upgrade 1: carry stable segment IDs so the pipeline can track consumption
            sourceSegmentIds,
            // A2: carry chapter premise so standalone callers get the north-star anchor
            chapterPremise: chapter.chapterPremise || undefined,
            // Upgrade 3: book thesis threaded from content map
            coreThesis: input.contentMap.coreThesis || undefined,
            // Scripture Amendment 4: primary translation for consistency
            primaryTranslation,
          };
        } catch (sectionErr) {
          console.error(`[assign-segments] Error processing chapter ${chapter.number} section ${section.sectionNumber}:`, sectionErr);
          throw sectionErr;
        }
      });
    });

    console.log(`[assign-segments] Successfully created ${assignments.length} assignments`);
    return NextResponse.json({ assignments }, { status: 200 });
  } catch (err) {
    console.error("[assign-segments] Fatal error:", err);
    const message = err instanceof Error ? err.message : "Segment assignment failed";
    const stack = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: message, stack }, { status: 500 });
  }
}
