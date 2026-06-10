import { NextRequest, NextResponse } from "next/server";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import { env } from "@/lib/env";
import { toR2PublicUrlOrKey } from "@/lib/r2-storage";

export const runtime = "nodejs";
export const maxDuration = 15;

const QuerySchema = z.object({
  chapterId: z.string().min(1).max(120),
  slug: z.string().min(1).max(160).optional(),
  jobId: z.string().min(1).max(160).optional(),
});

function makeS3(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

function sanitizePart(value: string): string {
  return value.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

export async function GET(req: NextRequest) {
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
  } = env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json({ audioUrl: null }, { status: 200 });
  }

  let input: z.infer<typeof QuerySchema>;
  try {
    input = QuerySchema.parse({
      chapterId: req.nextUrl.searchParams.get("chapterId") ?? "",
      slug: req.nextUrl.searchParams.get("slug") ?? undefined,
      jobId: req.nextUrl.searchParams.get("jobId") ?? undefined,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid query" }, { status: 400 });
  }

  const chapterId = sanitizePart(input.chapterId);
  const candidates = [input.slug, input.jobId]
    .filter((value): value is string => Boolean(value))
    .map((value) => sanitizePart(value));

  if (candidates.length === 0) {
    return NextResponse.json({ audioUrl: null }, { status: 200 });
  }

  const s3 = makeS3();

  for (const safeSlug of candidates) {
    const key = `audio/books/${safeSlug}/${chapterId}.wav`;
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      }));
      return NextResponse.json({ audioUrl: toR2PublicUrlOrKey(key) }, { status: 200 });
    } catch {
      // Try next candidate.
    }
  }

  return NextResponse.json({ audioUrl: null }, { status: 200 });
}
