/**
 * /api/ebook/jobs/[jobId]
 *
 * Server-side checkpoint store for ebook pipeline jobs.
 * Snapshots are written to R2 at `jobs/{jobId}/state.json` after each pipeline
 * stage so that a browser crash, tab close, or device switch does not destroy
 * in-progress work.
 *
 * GET  — load the latest checkpoint for a job (returns null when not found)
 * POST — save a new checkpoint for a job
 */

import { NextRequest, NextResponse } from "next/server";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import { EbookJobStateSchema } from "@/lib/schemas/ebook";

export const runtime     = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ jobId: string }> };

function makeS3() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

function r2Available(): boolean {
  return !!(
    env.R2_ACCOUNT_ID &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY &&
    env.R2_BUCKET_NAME
  );
}

function jobKey(jobId: string): string {
  // Sanitise jobId to prevent path traversal
  const safe = jobId.replace(/[^a-z0-9_\-]/gi, "").slice(0, 80);
  return `jobs/${safe}/state.json`;
}

// ── GET — load checkpoint ─────────────────────────────────────────────────────

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { jobId } = await ctx.params;

  if (!r2Available()) {
    return NextResponse.json({ state: null, source: "r2-unavailable" }, { status: 200 });
  }

  try {
    const s3  = makeS3();
    const res = await s3.send(
      new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME!, Key: jobKey(jobId) }),
    );
    const raw = await res.Body?.transformToString();
    if (!raw) return NextResponse.json({ state: null }, { status: 200 });

    const parsed = EbookJobStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return NextResponse.json(
        { state: null, error: "Checkpoint schema invalid", issues: parsed.error.issues },
        { status: 200 },
      );
    }

    return NextResponse.json({ state: parsed.data }, { status: 200 });
  } catch (err: unknown) {
    // NoSuchKey — checkpoint does not exist yet (normal on first load)
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
    if (code === "NoSuchKey" || code === "NotFound") {
      return NextResponse.json({ state: null }, { status: 200 });
    }
    const message = err instanceof Error ? err.message : "Checkpoint load failed";
    return NextResponse.json({ state: null, error: message }, { status: 500 });
  }
}

// ── POST — save checkpoint ────────────────────────────────────────────────────

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { jobId } = await ctx.params;

  if (!r2Available()) {
    // R2 not configured — silently succeed so the pipeline is not blocked
    return NextResponse.json({ saved: false, reason: "r2-unavailable" }, { status: 200 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = EbookJobStateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid job state schema", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  // Guard: the jobId in the URL must match the one in the payload
  if (parsed.data.jobId !== jobId) {
    return NextResponse.json(
      { error: `jobId mismatch: URL has "${jobId}", payload has "${parsed.data.jobId}"` },
      { status: 400 },
    );
  }

  try {
    const s3 = makeS3();
    await s3.send(
      new PutObjectCommand({
        Bucket:       env.R2_BUCKET_NAME!,
        Key:          jobKey(jobId),
        Body:         JSON.stringify(parsed.data),
        ContentType:  "application/json",
        CacheControl: "no-store",
      }),
    );
    return NextResponse.json({ saved: true }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Checkpoint save failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
