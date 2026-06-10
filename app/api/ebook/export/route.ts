import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";
import { ExportRequestSchema } from "@/lib/schemas/ebook";
import { generatePdfBuffer, generateEpubBuffer, generateDocxBuffer } from "@/lib/ebook-generator.tsx";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = ExportRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  const { manifest, formats, template } = input;
  const safeBookTitle = typeof manifest.bookTitle === "string" ? manifest.bookTitle : "ebook";
  const slug = safeBookTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  const prefix = `ebooks/${Date.now()}-${slug}`;

  try {
    const results: { pdfUrl?: string; epubUrl?: string; docxUrl?: string } = {};

    // ── Generate PDF ──────────────────────────────────────────────────────────
    if (formats.pdf) {
      const pdfBuffer = await generatePdfBuffer(manifest, template, input.printSpec);
      results.pdfUrl = await uploadOrStream(pdfBuffer, `${prefix}.pdf`, "application/pdf");
    }

    // ── Generate EPUB ─────────────────────────────────────────────────────────
    if (formats.epub) {
      const epubBuffer = await generateEpubBuffer(manifest, template);
      results.epubUrl = await uploadOrStream(epubBuffer, `${prefix}.epub`, "application/epub+zip");
    }

    // ── Generate DOCX ───────────────────────────────────────────────────────────
    if (formats.docx) {
      const docxBuffer = await generateDocxBuffer(manifest, template, input.printSpec);
      results.docxUrl = await uploadOrStream(
        docxBuffer,
        `${prefix}.docx`,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
    }

    return NextResponse.json(results, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed";
    return NextResponse.json({
      route: "ebook/export",
      error: message,
      details: err instanceof Error && err.stack
        ? err.stack.split("\n").slice(0, 3).join(" | ")
        : undefined,
    }, { status: 500 });
  }
}

async function uploadOrStream(
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<string> {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL } = env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    // R2 not configured — return a data URL (small files only) or throw
    throw new Error(
      "R2 storage is required for ebook export. Please configure R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME."
    );
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  // Return public URL if configured, otherwise a 1-hour presigned GET URL
  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
  }

  const presignedUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
    { expiresIn: 3600 }
  );
  return presignedUrl;
}
