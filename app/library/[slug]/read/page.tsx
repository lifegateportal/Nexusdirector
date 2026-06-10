import { notFound } from "next/navigation";
import { EbookManifestSchema } from "@/lib/schemas/ebook";
import { ReaderClient } from "./ReaderClient";

export const revalidate = 60;

async function fetchManifest(slug: string) {
  const pub = process.env.R2_PUBLIC_URL;
  if (!pub) return null;
  try {
    const res = await fetch(
      `${pub.replace(/\/$/, "")}/published/${slug}/manifest.json`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) return null;
    const parsed = EbookManifestSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export default async function ReadPage({
  params,
  searchParams,
}: {
  params:       Promise<{ slug: string }>;
  searchParams: Promise<{ chapter?: string }>;
}) {
  const { slug } = await params;
  const sp       = await searchParams;
  const initial  = sp.chapter !== undefined
    ? Math.max(0, parseInt(sp.chapter, 10))
    : undefined;

  const manifest = await fetchManifest(slug);
  if (!manifest) notFound();

  return <ReaderClient manifest={manifest} slug={slug} initialChapter={initial} />;
}
