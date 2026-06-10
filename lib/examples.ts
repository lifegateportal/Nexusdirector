/**
 * Typed example payloads for manual testing of the remaining pipeline routes.
 *
 * Usage — curl:
 *   curl -X POST http://localhost:3000/api/generate-logic \
 *     -H "Content-Type: application/json" \
 *     -d "$(node -e "const e=require('./lib/examples'); console.log(JSON.stringify(e.generateLogicExample))")"
 *
 * Usage — fetch (browser console / PromptBar dev):
 *   import { generateLogicExample, generateUiExample } from "@/lib/examples";
 *   await fetch("/api/generate-logic", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(generateLogicExample) });
 *   await fetch("/api/generate-ui",    { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(generateUiExample) });
 */

import type { LogicTransformRequest } from "@/lib/schemas/blueprint";
import type { z } from "zod";
import type { UiManifestInputSchema } from "@/lib/schemas/ui-manifest";

type UiManifestInput = z.infer<typeof UiManifestInputSchema>;

// ---------------------------------------------------------------------------
// POST /api/generate-logic
// DeepSeek Engineer: transforms a workspace blueprint into an execution graph
// ---------------------------------------------------------------------------
export const generateLogicExample: LogicTransformRequest = {
  objective:
    "Transform a cooking tutorial video series into a paid online academy with structured modules, knowledge-check quizzes, and a 30-second promotional reel ready for paid acquisition campaigns.",
  constraints: [
    "Export must be Teachable-compatible JSON",
    "Total video runtime must stay under 6 hours",
    "Quizzes must use multiple-choice only",
    "Promo reel maximum 30 seconds"
  ],
  blueprint: {
    workspaceId: "ws-cooking-academy-001",
    title: "The Art of Modern Cooking — Academy Build",
    summary:
      "12-episode YouTube tutorial series covering knife skills, sauce fundamentals, and plating technique. Supplemented by a 6-episode podcast series on chef mindset. Source: YouTube archive export + Spotify RSS transcript.",
    createdAtIso: "2026-05-19T10:00:00.000Z",
    assets: [
      {
        id: "vid-001",
        type: "video",
        title: "Episode 01 — Knife Skills & Mise en Place",
        source: "youtube://archive/ep001.mp4",
        durationMs: 2340000,
        tags: ["fundamentals", "safety", "module-1"]
      },
      {
        id: "vid-002",
        type: "video",
        title: "Episode 02 — The Five Mother Sauces",
        source: "youtube://archive/ep002.mp4",
        durationMs: 1980000,
        tags: ["sauces", "french-cuisine", "module-2"]
      },
      {
        id: "vid-003",
        type: "video",
        title: "Episode 03 — Plating as Communication",
        source: "youtube://archive/ep003.mp4",
        durationMs: 2100000,
        tags: ["plating", "aesthetics", "module-3"]
      },
      {
        id: "aud-001",
        type: "audio",
        title: "Podcast S1E01 — The Chef Mindset",
        source: "podcast://rss/chef-mindset-s1e01.mp3",
        durationMs: 3600000,
        tags: ["mindset", "bonus-content"]
      },
      {
        id: "doc-001",
        type: "document",
        title: "Course Outline Draft v2",
        source: "gdrive://docs/course-outline-v2.docx",
        tags: ["structure", "curriculum", "reference"]
      }
    ],
    workflow: [
      {
        id: "step-001",
        label: "Content Audit",
        intent: "Review all source videos, extract chapter timestamps and key topics per episode",
        dependsOn: []
      },
      {
        id: "step-002",
        label: "Module Mapping",
        intent: "Map episodes to academy modules with learning objectives and prerequisite chains",
        dependsOn: ["step-001"]
      },
      {
        id: "step-003",
        label: "Quiz Authoring",
        intent: "Generate 5 MCQ knowledge-check questions per module derived from episode transcripts",
        dependsOn: ["step-002"]
      },
      {
        id: "step-004",
        label: "Promo Reel Script",
        intent: "Write a 30-second highlight reel script pulling best 3-second moments from each episode",
        dependsOn: ["step-001"]
      },
      {
        id: "step-005",
        label: "Teachable Export",
        intent: "Package modules, quizzes, and assets into a Teachable-compatible course JSON bundle",
        dependsOn: ["step-002", "step-003"]
      }
    ],
    riskFlags: [
      "Episode 04 missing from YouTube archive — manual re-upload required",
      "Podcast audio quality drops below -16 LUFS in episodes 3–5",
      "Course outline draft conflicts with episode order in episodes 7–9"
    ]
  }
};

// ---------------------------------------------------------------------------
// POST /api/generate-ui
// Claude Designer: generates a UI manifest for a premium tablet interface
// ---------------------------------------------------------------------------
export const generateUiExample: UiManifestInput = {
  objective:
    "Design a premium iPad-first dashboard for an AI-powered media-to-academy pipeline — showing real-time agent status, course module tree, asset ingestion progress, and a one-tap deploy action.",
  domain: "EdTech SaaS",
  constraints: [
    "iPad Safari safe — dvh units only, never vh or screen-height",
    "Dark mode only — no light-mode variants needed",
    "All interactive targets minimum 48x48px",
    "No hover-only states — all actions must be tap-accessible",
    "Maximum font size 16px on inputs to prevent iOS auto-zoom",
    "Glass morphism aesthetic consistent with existing shell-950 palette"
  ]
};
