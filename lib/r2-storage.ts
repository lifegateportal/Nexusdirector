import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

const SIGNED_URL_TTL_SECONDS = 60 * 60;

export function makeR2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function maybeExtractR2KeyFromPublicUrl(url: string): string | null {
  if (!env.R2_PUBLIC_URL) return null;
  try {
    const base = new URL(env.R2_PUBLIC_URL.replace(/\/$/, ""));
    const candidate = new URL(url);
    if (base.origin !== candidate.origin) return null;
    if (!candidate.pathname.startsWith(base.pathname)) return null;
    const keyPath = candidate.pathname.slice(base.pathname.length).replace(/^\/+/, "");
    return keyPath || null;
  } catch {
    return null;
  }
}

export async function resolveR2ObjectUrl(keyOrUrl: string): Promise<string> {
  const normalized = keyOrUrl.trim();

  if (isHttpUrl(keyOrUrl)) {
    // Some R2 public/CDN URLs are not truly public (WAF/ACL rules), which causes
    // worker-side 403 errors in RunPod. If the URL points to our configured R2
    // public origin, derive the key and issue a signed object URL instead.
    const keyFromPublicUrl = maybeExtractR2KeyFromPublicUrl(normalized);
    if (!keyFromPublicUrl) return normalized;
    keyOrUrl = keyFromPublicUrl;
  }

  if (!env.R2_BUCKET_NAME) {
    throw new Error("R2 bucket is not configured");
  }

  const client = makeR2Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: keyOrUrl,
    }),
    { expiresIn: SIGNED_URL_TTL_SECONDS }
  );
}

export function toR2PublicUrlOrKey(key: string): string {
  return env.R2_PUBLIC_URL
    ? `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`
    : key;
}