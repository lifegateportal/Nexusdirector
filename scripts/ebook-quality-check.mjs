#!/usr/bin/env node
import fs from "node:fs";

function tokenize(input) {
  return new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function evaluate({ manifest, contentMap }) {
  const issues = [];
  let score = 100;
  const source = contentMap.segments.map((s) => s.rawText || "").join("\n\n");
  const sourceTokens = tokenize(source);
  const cueRe = /\b(say amen|look at your neighbor|clap your hands|lift your hands|as you sit here today|in this room today)\b/gi;

  for (const chapter of manifest.chapters || []) {
    for (const section of chapter.sections || []) {
      const body = section.body || "";
      const cues = body.match(cueRe)?.length || 0;
      if (cues > 0) {
        issues.push({ severity: "warn", message: `Audience cues in Ch ${chapter.number} § ${section.sectionNumber}` });
        score -= Math.min(8, cues * 2);
      }
      const overlap = jaccard(tokenize(body), sourceTokens);
      if (overlap < 0.035) {
        issues.push({ severity: "error", message: `Low source overlap in Ch ${chapter.number} § ${section.sectionNumber}` });
        score -= 12;
      }
    }
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), issues };
}

const [manifestPath, contentMapPath] = process.argv.slice(2);
if (!manifestPath || !contentMapPath) {
  console.error("Usage: node scripts/ebook-quality-check.mjs <manifest.json> <content-map.json>");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const contentMap = JSON.parse(fs.readFileSync(contentMapPath, "utf8"));
const report = evaluate({ manifest, contentMap });
console.log(JSON.stringify(report, null, 2));
if (report.issues.some((i) => i.severity === "error")) process.exit(2);
