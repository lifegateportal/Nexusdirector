import { z } from "zod";

export const CoverAccentSchema = z.enum(["amber", "cyan", "emerald", "rose", "violet", "slate"]);

export const PublishedBookEntrySchema = z.object({
  slug:           z.string(),
  title:          z.string(),
  subtitle:       z.string(),
  authorName:     z.string(),
  publishedAt:    z.string(),
  updatedAt:      z.string(),
  wordCount:      z.number(),
  chapterCount:   z.number(),
  synopsis:       z.string(),
  coverAccent:    CoverAccentSchema.default("amber"),
  template:       z.string(),
  coverImageUrl:  z.string().url().optional().nullable(),
  authorImageUrl: z.string().url().optional().nullable(),
});

export const PublishedCatalogSchema = z.object({
  updatedAt: z.string(),
  books:     z.array(PublishedBookEntrySchema),
});

export type CoverAccent       = z.infer<typeof CoverAccentSchema>;
export type PublishedBookEntry = z.infer<typeof PublishedBookEntrySchema>;
export type PublishedCatalog   = z.infer<typeof PublishedCatalogSchema>;
