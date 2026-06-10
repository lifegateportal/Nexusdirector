import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { z } from "zod";

export const runtime = "nodejs";

const RequestSchema = z.object({
  filename:    z.string().min(1).max(255),
  contentType: z.string().min(1),
  prefix:      z.enum(["videos", "images", "voice-samples"]).default("videos"),
});

export async function POST(req: NextRequest) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL } = env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json(
      { error: "R2 storage not configured — add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME to your environment variables." },
      { status: 503 }
    );
  }

  try {
    const body = await req.json() as unknown;
    const { filename, contentType, prefix } = RequestSchema.parse(body);

    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });

    // Sanitise filename and namespace under the requested prefix
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${prefix}/${Date.now()}-${safe}`;

    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const publicUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL.replace(/\/$/, "")}/${key}` : null;

    return NextResponse.json({ presignedUrl, key, publicUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Presign failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
