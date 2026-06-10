/**
 * POST /api/r2-upload
 *
 * Server-side file upload to Cloudflare R2.
 * Accepts multipart/form-data with:
 *   file        — the audio/video file
 *   prefix      — storage prefix (default: "voice-samples")
 *   ext         — file extension override (derived from file name if omitted)
 *
 * Returns: { publicUrl: string | null, key: string }
 *
 * Using server-side upload avoids browser CORS restrictions on presigned PUTs.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;

const ALLOWED_PREFIXES = ["voice-samples", "videos", "images"] as const;
const MAX_BYTES = 30 * 1024 * 1024; // 30 MB

export async function POST(req: NextRequest) {
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_PUBLIC_URL,
  } = env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json({ error: "R2 storage not configured" }, { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const rawPrefix = (formData.get("prefix") as string | null) ?? "voice-samples";
  const prefix = ALLOWED_PREFIXES.includes(rawPrefix as (typeof ALLOWED_PREFIXES)[number])
    ? rawPrefix
    : "voice-samples";

  if (!file || file.size === 0) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` },
      { status: 413 }
    );
  }

  // Derive extension from the File's name, falling back to the form field
  const nameExt = file.name.split(".").pop()?.toLowerCase() ?? "";
  const extField = (formData.get("ext") as string | null)?.toLowerCase() ?? "";
  const ext = nameExt || extField || "bin";
  const safeExt = ext.replace(/[^a-z0-9]/g, "");

  const contentType = file.type || "application/octet-stream";
  const key = `${prefix}/${Date.now()}-sample.${safeExt}`;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

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

    const publicUrl = R2_PUBLIC_URL
      ? `${R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`
      : null;

    return NextResponse.json({ publicUrl, key });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
