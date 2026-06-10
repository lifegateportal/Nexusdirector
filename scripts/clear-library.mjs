#!/usr/bin/env node
// One-shot script: clears all published books from R2 and resets the catalog.
// Run: node scripts/clear-library.mjs

import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.error("Missing R2 env vars (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME)");
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

async function run() {
  // 1. List all objects under published/
  const list = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME, Prefix: "published/" }));
  const keys = (list.Contents ?? []).map((o) => o.Key).filter(Boolean);
  if (keys.length === 0) {
    console.log("No published objects found — already empty.");
  } else {
    console.log(`Deleting ${keys.length} object(s)…`);
    for (const key of keys) {
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
      console.log("  ✓ Deleted:", key);
    }
  }

  // 2. Write a fresh empty catalog
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: "published/index.json",
    Body: JSON.stringify({ updatedAt: new Date().toISOString(), books: [] }),
    ContentType: "application/json",
    CacheControl: "public, max-age=30",
  }));
  console.log("✓ Fresh empty catalog written to published/index.json");
  console.log("Library cleared.");
}

run().catch((err) => { console.error(err); process.exit(1); });
