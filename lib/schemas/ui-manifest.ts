import { z } from "zod";

export const UiManifestInputSchema = z.object({
  objective: z.string().min(5),
  domain: z.string().min(2),
  constraints: z.array(z.string()).default([])
});

export const UiManifestResultSchema = z.object({
  visualDirection: z.string().min(1),
  components: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      purpose: z.string().min(1)
    })
  ),
  interactions: z.array(z.string().min(1)),
  accessibilityNotes: z.array(z.string().min(1))
});

export type UiManifestInput = z.infer<typeof UiManifestInputSchema>;
export type UiManifestResult = z.infer<typeof UiManifestResultSchema>;
