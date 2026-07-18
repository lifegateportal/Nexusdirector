import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import { EbookManifestSchema } from "@/lib/schemas/ebook";
import {
  PublishedBookEntrySchema,
  PublishedCatalogSchema,
  CoverAccentSchema,
} from "@/lib/schemas/published-book";
import type { PublishedCatalog } from "@/lib/schemas/published-book";
import { z } from "zod";

export const runtime    = "nodejs";
export const maxDuration = 30;

type PublishGetResponse = {
  books: z.infer<typeof PublishedCatalogSchema>["books"];
  manifest: z.infer<typeof EbookManifestSchema> | null;
  error?: string;
};

function jsonResponse(payload: PublishGetResponse, status = 200) {
  return NextResponse.json(payload, { status });
}

function makeS3Client(accountId: string, accessKey: string, secretKey: string) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
}

// ── Catalog helpers — ETag-conditional read / write ───────────────────────────

/**
 * Read the published catalog from R2 and return the raw ETag alongside the
 * parsed catalog so callers can use it for a conditional write.
 * Returns etag = null when the object does not yet exist (first publish).
 */
async function readCatalogWithETag(
  s3: S3Client,
  bucket: string,
): Promise<{ catalog: PublishedCatalog; etag: string | null }> {
  const now = new Date().toISOString();
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: "published/index.json" }),
    );
    const raw = await res.Body?.transformToString();
    const etag = res.ETag ?? null;
    if (!raw) return { catalog: { updatedAt: now, books: [] }, etag };
    const parsed = PublishedCatalogSchema.safeParse(JSON.parse(raw));
    return {
      catalog: parsed.success ? parsed.data : { updatedAt: now, books: [] },
      etag,
    };
  } catch {
    // Object does not exist yet — first publish
    return { catalog: { updatedAt: now, books: [] }, etag: null };
  }
}

/**
 * Write the catalog back to R2 with an ETag conditional check.
 * If etag is non-null, the write is rejected (412) if the object was modified
 * between our read and write, which means another request raced us.
 * Throws with code "PreconditionFailed" on conflict so callers can retry.
 */
async function writeCatalogConditional(
  s3: S3Client,
  bucket: string,
  catalog: PublishedCatalog,
  etag: string | null,
): Promise<void> {
  const cmd = new PutObjectCommand({
    Bucket:       bucket,
    Key:          "published/index.json",
    Body:         JSON.stringify(catalog),
    ContentType:  "application/json",
    CacheControl: "public, max-age=30",
    // Only set IfMatch when we know the current ETag — prevents silent overwrites.
    // When etag is null (first publish), no condition is needed.
    ...(etag ? { IfMatch: etag } : {}),
  });
  await s3.send(cmd);
}

/**
 * Resolve a unique slug: start from the base slug and append -2, -3 … until
 * no existing catalog entry uses it.  O(n) scan is fine for typical book counts.
 */
function resolveUniqueSlug(
  baseSlug: string,
  existingBooks: Array<{ slug: string }>,
): string {
  const taken = new Set(existingBooks.map((b) => b.slug));
  if (!taken.has(baseSlug)) return baseSlug;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${baseSlug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Fallback: append timestamp millis (effectively unique)
  return `${baseSlug}-${Date.now()}`;
}

// ── GET /api/ebook/publish — fetch the live published catalog ─────────────────

export async function GET(req: NextRequest) {
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
  } = env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return jsonResponse({ books: [], manifest: null }, 200);
  }

  try {
    const s3 = makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);

    const slug = req.nextUrl.searchParams.get("slug");
    if (slug) {
      try {
        const manifestRes = await s3.send(
          new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: `published/${slug}/manifest.json` }),
        );
        const rawManifest = await manifestRes.Body?.transformToString();
        if (!rawManifest) return jsonResponse({ books: [], manifest: null, error: "Manifest not found" }, 404);
        const parsedManifest = EbookManifestSchema.safeParse(JSON.parse(rawManifest));
        if (!parsedManifest.success) {
          return jsonResponse({ books: [], manifest: null, error: "Invalid manifest" }, 422);
        }
        return jsonResponse({ books: [], manifest: parsedManifest.data }, 200);
      } catch {
        return jsonResponse({ books: [], manifest: null, error: "Manifest not found" }, 404);
      }
    }

    const { catalog } = await readCatalogWithETag(s3, R2_BUCKET_NAME);
    return jsonResponse({ books: catalog.books, manifest: null }, 200);
  } catch {
    return jsonResponse({ books: [], manifest: null }, 200);
  }
}

// ── POST /api/ebook/publish — publish or re-publish a book ───────────────────

const PublishRequestSchema = z.object({
  manifest:       EbookManifestSchema,
  coverAccent:    CoverAccentSchema.default("amber"),
  coverImageUrl:  z.string().url().optional().nullable(),
  authorImageUrl: z.string().url().optional().nullable(),
});

function slugify(title: string, jobId: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const suffix = jobId.replace(/[^a-z0-9]/gi, "").slice(-6);
  return `${base}-${suffix}`;
}

function buildSynopsis(manifest: z.infer<typeof EbookManifestSchema>): string {
  const candidates = [
    manifest.frontMatter.introduction,
    manifest.frontMatter.preface,
  ];
  for (const text of candidates) {
    if (text && text.length > 60) {
      const clean = text.replace(/#{1,3} /g, "").replace(/\*\*/g, "").trim();
      return clean.slice(0, 340).trimEnd() + (clean.length > 340 ? "…" : "");
    }
  }
  return `${manifest.bookTitle} by ${manifest.authorName}. ${manifest.chapters.length} chapters, ${manifest.totalWordCount.toLocaleString()} words.`;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return NextResponse.json(
      { route: "ebook/publish", error: err instanceof Error ? err.message : "Invalid JSON payload" },
      { status: 400 },
    );
  }

  let input;
  try {
    input = PublishRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_PUBLIC_URL,
  } = env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json(
      { error: "R2 storage must be configured to publish books. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME." },
      { status: 503 },
    );
  }

  const { manifest, coverAccent } = input;
  const coverImageUrl  = input.coverImageUrl  ?? manifest.coverImageUrl  ?? null;
  const authorImageUrl = input.authorImageUrl ?? manifest.authorImageUrl ?? null;

  const s3 = makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);

  // ── Step 1: Write the manifest (slug-independent, no race condition) ──────
  // We derive the slug after reading the catalog so we can check uniqueness.
  // Write manifest first with the base slug; if we end up using a suffixed slug
  // we overwrite the key in step 5 — this is an idempotent operation.
  const baseSlug = slugify(manifest.bookTitle, manifest.jobId);

  const now = new Date().toISOString();

  // ── Steps 2–5: Read catalog → resolve unique slug → upsert → conditional write
  // Retry up to 3 times on ETag conflict (concurrent publish race).
  const MAX_CATALOG_ATTEMPTS = 3;
  let slug = baseSlug;

  for (let attempt = 1; attempt <= MAX_CATALOG_ATTEMPTS; attempt++) {
    const { catalog, etag } = await readCatalogWithETag(s3, R2_BUCKET_NAME);

    // C-2 fix: resolve a unique slug against the current catalog.
    // Re-publishing the same job always reuses its own slug (filter it out first).
    const otherBooks = catalog.books.filter((b) => b.slug !== baseSlug && !b.slug.startsWith(`${baseSlug}-`));
    slug = resolveUniqueSlug(baseSlug, otherBooks);

    // Build the catalog entry
    const entry = PublishedBookEntrySchema.parse({
      slug,
      title:        manifest.bookTitle,
      subtitle:     manifest.subtitle,
      authorName:   manifest.authorName,
      publishedAt:  now,
      updatedAt:    now,
      wordCount:    manifest.totalWordCount,
      chapterCount: manifest.chapters.length,
      synopsis:     buildSynopsis(manifest),
      coverAccent,
      template:     manifest.selectedTemplate,
      coverImageUrl,
      authorImageUrl,
    });

    // Upsert: remove any entry for this job's slug family, prepend fresh entry
    catalog.books = catalog.books.filter(
      (b) => b.slug !== baseSlug && !b.slug.startsWith(`${baseSlug}-`),
    );
    catalog.books.unshift(entry);
    catalog.updatedAt = now;

    try {
      await writeCatalogConditional(s3, R2_BUCKET_NAME, catalog, etag);
      // Catalog write succeeded — break out of retry loop
      break;
    } catch (err) {
      const isConflict =
        err instanceof Error &&
        (err.name === "PreconditionFailed" || err.message.includes("PreconditionFailed") || err.message.includes("412"));

      if (isConflict && attempt < MAX_CATALOG_ATTEMPTS) {
        // Another request modified the catalog between our read and write — retry.
        continue;
      }
      // Non-conflict error or out of retries
      const message = err instanceof Error ? err.message : "Catalog write failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // ── Write the manifest to R2 under the resolved slug ─────────────────────
  try {
    const manifestWithImages = { ...manifest, coverImageUrl, authorImageUrl };
    await s3.send(
      new PutObjectCommand({
        Bucket:       R2_BUCKET_NAME,
        Key:          `published/${slug}/manifest.json`,
        Body:         JSON.stringify(manifestWithImages),
        ContentType:  "application/json",
        CacheControl: "public, max-age=60",
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Manifest upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const publicUrl = R2_PUBLIC_URL
    ? `${R2_PUBLIC_URL.replace(/\/$/, "")}/published/${slug}/manifest.json`
    : null;

  revalidatePath("/library");

  return NextResponse.json({ slug, publicUrl }, { status: 200 });
}

// ── PATCH /api/ebook/publish — update catalog entry metadata ─────────────────

const PatchCatalogRequestSchema = z.object({
  slug:        z.string().min(1),
  title:       z.string().optional(),
  subtitle:    z.string().optional(),
  authorName:  z.string().optional(),
  synopsis:    z.string().optional(),
  coverAccent: CoverAccentSchema.optional(),
});

export async function PATCH(req: NextRequest) {
  let input;
  try {
    input = PatchCatalogRequestSchema.parse(await req.json() as unknown);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json({ error: "R2 storage not configured." }, { status: 503 });
  }

  const { slug, ...fields } = input;
  const s3  = makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);
  const now = new Date().toISOString();

  const MAX_CATALOG_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_CATALOG_ATTEMPTS; attempt++) {
    const { catalog, etag } = await readCatalogWithETag(s3, R2_BUCKET_NAME);

    const idx = catalog.books.findIndex((b) => b.slug === slug);
    if (idx === -1) {
      return NextResponse.json({ error: `Book with slug "${slug}" not found in catalog.` }, { status: 404 });
    }

    catalog.books[idx] = PublishedBookEntrySchema.parse({
      ...catalog.books[idx],
      ...fields,
      updatedAt: now,
    });
    catalog.updatedAt = now;

    try {
      await writeCatalogConditional(s3, R2_BUCKET_NAME, catalog, etag);
      break;
    } catch (err) {
      const isConflict =
        err instanceof Error &&
        (err.name === "PreconditionFailed" || err.message.includes("PreconditionFailed") || err.message.includes("412"));

      if (isConflict && attempt < MAX_CATALOG_ATTEMPTS) continue;

      const message = err instanceof Error ? err.message : "Catalog update failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  revalidatePath("/library");
  return NextResponse.json({ slug, updatedAt: now }, { status: 200 });
}

// ── DELETE /api/ebook/publish — unpublish a book ─────────────────────────────

const DeleteRequestSchema = z.object({
  slug: z.string().min(1),
});

export async function DELETE(req: NextRequest) {
  let input;
  try {
    input = DeleteRequestSchema.parse(await req.json() as unknown);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return NextResponse.json({ error: "R2 storage not configured." }, { status: 503 });
  }

  const { slug } = input;
  const s3  = makeS3Client(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);
  const now = new Date().toISOString();

  // ── Step 1: Remove from catalog with ETag conditional write ──────────────
  const MAX_CATALOG_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_CATALOG_ATTEMPTS; attempt++) {
    const { catalog, etag } = await readCatalogWithETag(s3, R2_BUCKET_NAME);

    catalog.books     = catalog.books.filter((b) => b.slug !== slug);
    catalog.updatedAt = now;

    try {
      await writeCatalogConditional(s3, R2_BUCKET_NAME, catalog, etag);
      break;
    } catch (err) {
      const isConflict =
        err instanceof Error &&
        (err.name === "PreconditionFailed" || err.message.includes("PreconditionFailed") || err.message.includes("412"));

      if (isConflict && attempt < MAX_CATALOG_ATTEMPTS) continue;

      const message = err instanceof Error ? err.message : "Catalog update failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // ── Step 2: Delete manifest from R2 (best-effort) ────────────────────────
  await s3.send(
    new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: `published/${slug}/manifest.json` }),
  ).catch(() => { /* file may not exist */ });

  revalidatePath("/library");

  return NextResponse.json({ slug }, { status: 200 });
}
