import { z } from "zod";

export const TestimonialSchema = z.object({
  name: z.string(),
  role: z.string().default(""),
  quote: z.string(),
  rating: z.number().min(1).max(5).default(5),
});

export const FaqItemSchema = z.object({
  question: z.string(),
  answer: z.string(),
});

export const SiteConfigSchema = z.object({
  announcementBar:  z.string().default(""),
  ctaOverride:      z.string().default(""),
  testimonials:     z.array(TestimonialSchema).default([]),
  faqItems:         z.array(FaqItemSchema).default([]),
  instructorBio: z.object({
    name:           z.string().default(""),
    title:          z.string().default(""),
    bio:            z.string().default(""),
    avatarInitials: z.string().default(""),
  }).default({}),
  socialLinks: z.object({
    website:   z.string().default(""),
    twitter:   z.string().default(""),
    youtube:   z.string().default(""),
    instagram: z.string().default(""),
    linkedin:  z.string().default(""),
  }).default({}),
  footerText: z.string().default(""),
});

export type SiteConfig = z.infer<typeof SiteConfigSchema>;
