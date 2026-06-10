import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const FileMetaSchema = z.object({
  name: z.string().min(1),
  size: z.number().positive().max(40_000_000),
  type: z.string().optional(),
});

const SUPPORTED_EXTENSIONS = new Set(["txt", "md", "markdown", "srt", "csv", "tsv", "json", "pdf"]);

function fileExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const rawFile = formData.get("file");
    if (!(rawFile instanceof File)) {
      return NextResponse.json({ error: "Missing upload file" }, { status: 400 });
    }

    const meta = FileMetaSchema.safeParse({
      name: rawFile.name,
      size: rawFile.size,
      type: rawFile.type,
    });
    if (!meta.success) {
      return NextResponse.json({ error: "Invalid file metadata" }, { status: 400 });
    }

    const ext = fileExtension(meta.data.name);
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return NextResponse.json({ error: "Unsupported file format" }, { status: 400 });
    }

    let text = "";
    if (ext === "pdf") {
      try {
        const pdfParse = (await import("pdf-parse")).default;
        const buffer = Buffer.from(await rawFile.arrayBuffer());
        const parsed = await pdfParse(buffer);
        text = parsed.text ?? "";
      } catch (error) {
        return NextResponse.json(
          {
            error: error instanceof Error
              ? `PDF extraction failed: ${error.message}`
              : "PDF extraction failed. The file may be image-only, encrypted, or malformed.",
          },
          { status: 422 },
        );
      }
    } else {
      text = await rawFile.text();
    }

    const normalized = text.replace(/\u0000/g, "").trim();
    if (!normalized) {
      return NextResponse.json(
        { error: ext === "pdf" ? "No readable text extracted from PDF. This PDF may be scanned/image-only and needs OCR support." : "No readable text extracted" },
        { status: 422 },
      );
    }

    const maxChars = 240_000;
    const truncated = normalized.length > maxChars;
    const capped = truncated ? normalized.slice(0, maxChars) : normalized;
    return NextResponse.json({ text: capped, truncated, originalLength: normalized.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Document extraction failed" },
      { status: 500 },
    );
  }
}
