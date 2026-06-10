import { z } from "zod";

export const MediaAssetSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["video", "audio", "image", "document", "log"]),
  title: z.string().min(1),
  source: z.string().default(""),
  durationMs: z.number().nonnegative().optional(),
  tags: z.array(z.string()).default([])
});

export const WorkflowStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  intent: z.string().min(1),
  dependsOn: z.array(z.string()).default([])
});

export const BlueprintSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  assets: z.array(MediaAssetSchema).default([]),
  workflow: z.array(WorkflowStepSchema).default([]),
  riskFlags: z.array(z.string()).default([]),
  createdAtIso: z.string().datetime()
});

export const LogicTransformRequestSchema = z.object({
  objective: z.string().min(10),
  blueprint: BlueprintSchema,
  constraints: z.array(z.string().min(1)).default([])
});

export const LogicTransformResultSchema = z.object({
  reasoningSummary: z.string().min(1),
  entities: z.array(
    z.object({
      id: z.string().min(1),
      category: z.enum(["asset", "workflow", "risk", "action"]),
      label: z.string().min(1),
      rationale: z.string().default("")
    })
  ),
  transitions: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      condition: z.string().default("")
    })
  ),
  executionPlan: z.array(
    z.object({
      step: z.number(),
      title: z.string().min(1),
      action: z.string().min(1),
      expectedOutcome: z.string().default("")
    })
  ),
  warnings: z.array(z.string()).default([])
});

export const IngestInputSchema = z.object({
  sourceText: z.string().min(1),
  locale: z.string().default("en-US")
});

export const IngestResultSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  assets: z.array(MediaAssetSchema),
  workflow: z.array(WorkflowStepSchema),
  riskFlags: z.array(z.string())
});

export type Blueprint = z.infer<typeof BlueprintSchema>;
export type LogicTransformRequest = z.infer<typeof LogicTransformRequestSchema>;
export type LogicTransformResult = z.infer<typeof LogicTransformResultSchema>;
export type IngestResult = z.infer<typeof IngestResultSchema>;
