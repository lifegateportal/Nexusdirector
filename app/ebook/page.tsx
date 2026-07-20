"use client";

import { Suspense, useState, useCallback, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { EbookPipeline } from "@/app/components/EbookPipeline";
import { EbookProjectsPanel } from "@/app/components/EbookProjectsPanel";
import { AssistantPanel } from "@/app/components/AssistantPanel";
import { NexusNav } from "@/app/components/NexusNav";
import { StatusBar } from "@/app/components/StatusBar";
import { SiteConfigSchema } from "@/lib/schemas/site-config";
import { EbookManifestSchema, EbookJobStateSchema } from "@/lib/schemas/ebook";
import type { ChapterDraft, EbookManifest, EbookJobState, SectionAssignment } from "@/lib/schemas/ebook";
import type { SiteConfig } from "@/lib/schemas/site-config";
import type { EbookPipelineSnapshot } from "@/app/components/EbookPipeline";
import {
  listEbookProjects,
  saveEbookProject,
  deleteEbookProject,
  generateEbookProjectId,
  EBOOK_PROJECT_SCHEMA_VERSION,
} from "@/lib/ebook-project-store";
import { saveProject } from "@/lib/project-store";
import { getEbookJob, saveEbookJob, tryLoadServerCheckpoint } from "@/lib/ebook-job-store";
import type { EbookProject } from "@/lib/ebook-project-store";

const JOB_STATE_KEY = "nexus_ebook_job_state";
const JOB_STORAGE_KEY = "nexus_ebook_current_job";
const CURRENT_PROJECT_ID_KEY = "nexus_ebook_current_project_id";
const PENDING_MOUNT_KEY = "nexus_ebook_pending_mount";
const VOICE_STUDIO_STORAGE_PREFIX = "nexus_voice_studio_";
const VALID_JOB_STATUSES = new Set([
  "idle", "transcribing", "filtering", "analyzing", "mapping",
  "architecting", "assigning", "writing", "polishing",
  "frontmatter", "exporting", "complete", "failed",
]);

type Tab = "pipeline" | "projects";

function isChapterDraft(value: unknown): value is ChapterDraft {
  return Boolean(value && typeof value === "object");
}

function sanitizeChapterDrafts(chapters: unknown): ChapterDraft[] {
  return Array.isArray(chapters) ? chapters.filter(isChapterDraft) : [];
}

// Fields computed fresh at write time — they are passed to write-section as runtime
// inputs but have zero value in the saved state. Persisting them bloats each
// SectionAssignment by 10-100 KB and caused the browser to crash during save.
const EPHEMERAL_ASSIGNMENT_FIELDS = new Set([
  "priorSectionsSample",  // all sentences from written sections — can be thousands of items
  "bannedRecaps",         // opening sentences of all prior paragraphs
  "coverageLedger",       // per-section claim summaries
  "overusedPhrases",      // 3-gram frequency list
  "sequenceTurns",        // rhetorical pivot points
  "storyPayoffPairs",     // story setup/payoff ordering data
  "scripturePositions",   // scripture sequence enforcement data
  "priorExcerptTail",     // last excerpt from the previous section
]);

function sanitizeSectionAssignments(assignments: unknown): SectionAssignment[] {
  if (!Array.isArray(assignments)) return [];

  return assignments
    .filter((assignment): assignment is Record<string, unknown> => Boolean(assignment && typeof assignment === "object"))
    .map((assignment) => {
      const chapterNumber = Number(assignment.chapterNumber);
      const sectionNumber = Number(assignment.sectionNumber);
      if (!Number.isFinite(chapterNumber) || !Number.isFinite(sectionNumber)) return null;

      // Strip ephemeral runtime fields before saving. These are recomputed fresh
      // before each write-section call — storing them wastes memory and causes crashes.
      const stripped: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(assignment)) {
        if (!EPHEMERAL_ASSIGNMENT_FIELDS.has(key)) stripped[key] = val;
      }

      return {
        ...stripped,
        chapterNumber,
        sectionNumber,
        transcriptExcerpts: Array.isArray(assignment.transcriptExcerpts)
          ? assignment.transcriptExcerpts.filter((excerpt): excerpt is string => typeof excerpt === "string")
          : [],
      } as SectionAssignment;
    })
    .filter((assignment): assignment is SectionAssignment => Boolean(assignment));
}

function sumChapterWordCount(chapters: ChapterDraft[]): number {
  return chapters.reduce((sum, chapter) => {
    const words = typeof chapter.totalWordCount === "number" ? chapter.totalWordCount : 0;
    return sum + words;
  }, 0);
}

function jobStrength(job: EbookJobState | null): number {
  if (!job) return -1;
  const safeChapters = sanitizeChapterDrafts(job.chapters);
  const safeAssignments = sanitizeSectionAssignments(job.sectionAssignments);
  const chapters = safeChapters.length;
  const assignments = safeAssignments.length;
  const assignmentExcerpts = safeAssignments.reduce((sum, assignment) => sum + assignment.transcriptExcerpts.length, 0);
  const sections = job.sections?.length ?? 0;
  const words = sumChapterWordCount(safeChapters);
  const progress = job.progress?.completed ?? 0;
  const bonus = job.status === "complete" ? 100000 : 0;
  return bonus + chapters * 2000 + assignments * 700 + assignmentExcerpts * 5 + sections * 200 + words + progress * 10;
}

function pickBestJobState(candidates: Array<EbookJobState | null>): EbookJobState | null {
  const valid = candidates.filter((candidate): candidate is EbookJobState => Boolean(candidate));
  if (valid.length === 0) return null;
  const scored = valid.map((candidate) => {
    const ts = Date.parse(candidate.updatedAt ?? "");
    return {
      candidate,
      ts: Number.isFinite(ts) ? ts : 0,
      strength: jobStrength(candidate),
    };
  });

  scored.sort((a, b) => {
    if (a.strength !== b.strength) return b.strength - a.strength;
    return b.ts - a.ts;
  });

  return scored[0].candidate;
}

export default function EbookPage() {
  return (
    <Suspense fallback={(
      <div className="flex h-dvh items-center justify-center bg-shell-950 text-sm text-slate-400">
        Loading book workspace...
      </div>
    )}>
      <EbookPageClient />
    </Suspense>
  );
}

function EbookPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>("pipeline");
  const [ebookManifest, setEbookManifest] = useState<EbookManifest | null>(null);
  const [ebookPipelineSnapshot, setEbookPipelineSnapshot] = useState<EbookPipelineSnapshot | null>(null);
  const [liveJobState, setLiveJobState] = useState<EbookJobState | null>(null);
  const liveJobStateRef = useRef<EbookJobState | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [siteConfig] = useState<SiteConfig>(() => SiteConfigSchema.parse({}));
  const isLikelyIOS = (() => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const touchPoints = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
    return /iPad|iPhone|iPod/i.test(ua)
      || (/Mac/i.test(platform) && touchPoints > 1)
      || /iPad|iPhone|iPod/i.test(platform);
  })();

  // Project persistence
  const [projects, setProjects] = useState<EbookProject[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string>("");
  const currentProjectIdRef = useRef<string>("");
  // Incrementing this key remounts <EbookPipeline> so it re-reads localStorage on load
  const [pipelineKey, setPipelineKey] = useState(0);
  // Direct prop to pass initial job state to pipeline on load (more reliable than localStorage-only)
  const [pipelineInitialJobState, setPipelineInitialJobState] = useState<EbookJobState | null>(null);
  const hydratedLoadRef = useRef<string | null>(null);
  // Prevent overlapping save operations from allocating multiple project IDs.
  const saveInFlightRef = useRef(false);
  const pendingProjectIdRef = useRef<string | null>(null);
  const autoSaveInFlightRef = useRef(false);
  const queuedAutoSaveRef = useRef<{ name: string; manifest: EbookManifest } | null>(null);
  const lastCloudSyncAtRef = useRef(0);

  const emitSaveTelemetry = useCallback((event: string, data?: Record<string, unknown>) => {
    try {
      const ts = new Date().toISOString();
      console.info("[ebook-save-telemetry]", JSON.stringify({ ts, event, ...data }));
    } catch {
      // telemetry is best-effort
    }
  }, []);

  useEffect(() => {
    liveJobStateRef.current = liveJobState;
  }, [liveJobState]);

  useEffect(() => {
    currentProjectIdRef.current = currentProjectId;
  }, [currentProjectId]);

  const setCurrentProjectIdStable = useCallback((id: string) => {
    currentProjectIdRef.current = id;
    setCurrentProjectId(id);
    try {
      localStorage.setItem(CURRENT_PROJECT_ID_KEY, id);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const clearCurrentProjectIdStable = useCallback(() => {
    currentProjectIdRef.current = "";
    setCurrentProjectId("");
    try {
      localStorage.removeItem(CURRENT_PROJECT_ID_KEY);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const findProjectIdByJobId = useCallback((jobId: string | null | undefined) => {
    if (!jobId) return "";
    const matches = projects.filter((project) => project.jobState?.jobId === jobId);
    if (matches.length === 0) return "";
    const best = [...matches].sort((a, b) => (
      Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || "")
    ))[0];
    return best?.id ?? "";
  }, [projects]);

  const ensureActiveProjectId = useCallback((jobId?: string | null) => {
    const existing = currentProjectIdRef.current || pendingProjectIdRef.current;
    if (existing) return existing;

    const matchedByJobId = findProjectIdByJobId(jobId);
    if (matchedByJobId) {
      pendingProjectIdRef.current = matchedByJobId;
      setCurrentProjectIdStable(matchedByJobId);
      return matchedByJobId;
    }

    const id = generateEbookProjectId();
    pendingProjectIdRef.current = id;
    setCurrentProjectIdStable(id);
    return id;
  }, [findProjectIdByJobId, setCurrentProjectIdStable]);

  useEffect(() => {
    void (async () => {
      const localProjects = await listEbookProjects().catch(() => []);
      setProjects(localProjects);

      try {
        const storedProjectId = (localStorage.getItem(CURRENT_PROJECT_ID_KEY) ?? "").trim();
        if (storedProjectId && localProjects.some((project) => project.id === storedProjectId)) {
          setCurrentProjectIdStable(storedProjectId);
          return;
        }

        if (storedProjectId) {
          localStorage.removeItem(CURRENT_PROJECT_ID_KEY);
        }

        const rawJobState = localStorage.getItem(JOB_STATE_KEY);
        if (!rawJobState) return;
        const parsed = JSON.parse(rawJobState) as { jobId?: unknown };
        const jobId = typeof parsed.jobId === "string" ? parsed.jobId : "";
        if (!jobId) return;

        const match = localProjects
          .filter((project) => project.jobState?.jobId === jobId)
          .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""))[0];

        if (match?.id) {
          setCurrentProjectIdStable(match.id);
        }
      } catch {
        // localStorage unavailable or corrupt
      }
    })();
  }, [setCurrentProjectIdStable]);

  useEffect(() => {
    let cancelled = false;

    const syncFromCloud = async () => {
      try {
        const localProjects = await listEbookProjects().catch(() => []);
        const res = await fetch(`/api/projects?kind=ebook&t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;

        const payload = await res.json() as {
          projects?: Array<{
            id?: string;
            name?: string;
            createdAt?: string;
            updatedAt?: string;
            ebookJobState?: unknown;
            jobState?: unknown;
            publishedSlug?: string;
            coverImageUrl?: string;
            authorImageUrl?: string;
          }>;
        };

        const remote = Array.isArray(payload.projects) ? payload.projects : [];
        const localById = new Map(localProjects.map((p) => [p.id, p]));
        let changed = false;

        for (const item of remote) {
          if (!item.id || !item.name) continue;
          const sourceJobState = item.ebookJobState ?? item.jobState;
          if (!sourceJobState) continue;

          const rawState = typeof sourceJobState === "string"
            ? (() => {
                try {
                  return JSON.parse(sourceJobState) as unknown;
                } catch {
                  return null;
                }
              })()
            : sourceJobState;
          if (!rawState || typeof rawState !== "object") continue;

          const record = rawState as Record<string, unknown>;
          const rawStatus = typeof record.status === "string" ? record.status : "idle";
          const normalizedState = {
            ...record,
            jobId: typeof record.jobId === "string" && record.jobId ? record.jobId : item.id,
            status: VALID_JOB_STATUSES.has(rawStatus) ? rawStatus : "idle",
            createdAt: (() => {
              const source = typeof record.createdAt === "string" ? record.createdAt : item.createdAt;
              const ts = source ? Date.parse(source) : NaN;
              return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date().toISOString();
            })(),
            updatedAt: (() => {
              const source = typeof record.updatedAt === "string" ? record.updatedAt : item.updatedAt;
              const ts = source ? Date.parse(source) : NaN;
              return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date().toISOString();
            })(),
          };

          const parsed = EbookJobStateSchema.safeParse(normalizedState);
          if (!parsed.success) continue;

          const existing = localById.get(item.id);
          const localTs = existing ? new Date(existing.updatedAt).getTime() : 0;
          const remoteTs = new Date(item.updatedAt ?? item.createdAt ?? 0).getTime();
          const hasRemoteImageUpdates = Boolean(
            (item.coverImageUrl && !existing?.coverImageUrl) ||
            (item.authorImageUrl && !existing?.authorImageUrl) ||
            (item.publishedSlug && !existing?.publishedSlug)
          );
          if (existing && localTs >= remoteTs && !hasRemoteImageUpdates) continue;

          const job = parsed.data;
          const safeChapters = sanitizeChapterDrafts(job.chapters);
          const normalized: EbookProject = {
            _version: EBOOK_PROJECT_SCHEMA_VERSION,
            id: item.id,
            name: item.name,
            createdAt: item.createdAt ?? new Date().toISOString(),
            updatedAt: item.updatedAt ?? new Date().toISOString(),
            bookTitle: job.architecture?.bookTitle ?? item.name,
            chapterCount: safeChapters.length,
            totalWordCount: sumChapterWordCount(safeChapters),
            status: job.status,
            jobState: { ...job, chapters: safeChapters },
            publishedSlug: item.publishedSlug ?? existing?.publishedSlug,
            coverImageUrl: item.coverImageUrl ?? existing?.coverImageUrl,
            authorImageUrl: item.authorImageUrl ?? existing?.authorImageUrl,
          };

          await saveEbookProject(normalized).catch(() => {});
          changed = true;
        }

        if (changed) {
          const next = await listEbookProjects().catch(() => []);
          if (!cancelled) setProjects(next);
        }
      } catch {
        // Polling is best-effort.
      }
    };

    void syncFromCloud();

    const intervalMs = isLikelyIOS ? 30000 : 12000;
    const timer = setInterval(() => {
      void syncFromCloud();
    }, intervalMs);

    const onVisibleOrFocus = () => {
      if (document.visibilityState === "hidden") return;
      void syncFromCloud();
    };

    window.addEventListener("focus", onVisibleOrFocus);
    document.addEventListener("visibilitychange", onVisibleOrFocus);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onVisibleOrFocus);
      document.removeEventListener("visibilitychange", onVisibleOrFocus);
    };
  }, [isLikelyIOS]);

  const requestedTab = searchParams.get("tab");
  const requestedLoad = searchParams.get("load");
  useEffect(() => {
    if (requestedTab === "projects" || requestedTab === "pipeline") {
      setActiveTab(requestedTab);
      return;
    }
    setActiveTab("pipeline");
  }, [requestedTab]);

  useEffect(() => {
    try {
      let storageUnavailable = false;
      const raw = (() => {
        try {
          return localStorage.getItem(PENDING_MOUNT_KEY);
        } catch {
          storageUnavailable = true;
          return null;
        }
      })();
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        projectId?: string;
        projectName?: string;
        jobState?: unknown;
        ebookManifest?: unknown;
        coverImageUrl?: string | null;
        authorImageUrl?: string | null;
        ts?: number;
      };
      if (typeof parsed.ts !== "number" || Date.now() - parsed.ts > 120000) {
        try { localStorage.removeItem(PENDING_MOUNT_KEY); } catch {}
        return;
      }
      const jobParsed = EbookJobStateSchema.safeParse(parsed.jobState);
      if (!jobParsed.success) {
        try { localStorage.removeItem(PENDING_MOUNT_KEY); } catch {}
        return;
      }

      try {
        localStorage.setItem(JOB_STATE_KEY, JSON.stringify(jobParsed.data));
        localStorage.setItem(JOB_STORAGE_KEY, jobParsed.data.jobId);
      } catch {
        storageUnavailable = true;
      }
      setPipelineInitialJobState(jobParsed.data);
        if (typeof parsed.projectId === "string") setCurrentProjectIdStable(parsed.projectId);

      const manifestParsed = EbookManifestSchema.safeParse(parsed.ebookManifest);
      if (manifestParsed.success) {
        setEbookManifest({
          ...manifestParsed.data,
          coverImageUrl: manifestParsed.data.coverImageUrl ?? parsed.coverImageUrl ?? null,
          authorImageUrl: manifestParsed.data.authorImageUrl ?? parsed.authorImageUrl ?? null,
        });
      }

      setPipelineKey((k) => k + 1);
      setActiveTab("pipeline");
      setStatusMsg({
        type: "success",
        text: storageUnavailable
          ? `"${parsed.projectName ?? "Project"}" mounted in durable fallback mode.`
          : `"${parsed.projectName ?? "Project"}" mounted in standalone pipeline.`,
      });
      try { localStorage.removeItem(PENDING_MOUNT_KEY); } catch {}
    } catch {
      try { localStorage.removeItem(PENDING_MOUNT_KEY); } catch {}
    }
  }, []);

  useEffect(() => {
    if (!requestedLoad || projects.length === 0) return;
    if (hydratedLoadRef.current === requestedLoad) return;
    const project = projects.find((p) => p.id === requestedLoad);
    if (!project) return;

    try {
      const normalized = normalizeJobStateForSave(project.jobState);
      if (!normalized) return;
      let storageUnavailable = false;
      try {
        localStorage.setItem(JOB_STATE_KEY, JSON.stringify(normalized));
        localStorage.setItem(JOB_STORAGE_KEY, normalized.jobId);
      } catch {
        storageUnavailable = true;
      }
      setPipelineInitialJobState(normalized);
      liveJobStateRef.current = normalized;
      setLiveJobState(normalized);
      setCurrentProjectIdStable(project.id);
      const manifest = toManifestFromJob(normalized);
      setEbookManifest(
        manifest
          ? {
              ...manifest,
              coverImageUrl: project.coverImageUrl ?? null,
              authorImageUrl: project.authorImageUrl ?? null,
            }
          : null
      );
      setPipelineKey((k) => k + 1);
      setActiveTab("pipeline");
      hydratedLoadRef.current = requestedLoad;
      setStatusMsg({
        type: "success",
        text: storageUnavailable
          ? `"${project.name}" mounted in durable fallback mode.`
          : `"${project.name}" mounted in standalone pipeline.`,
      });
      router.replace("/ebook?tab=pipeline");
    } catch (err) {
      setStatusMsg({ type: "error", text: err instanceof Error ? err.message : "Project mount failed." });
    }
  // Intentionally avoid callback deps here because this effect is defined
  // before those callbacks are initialized in this component body.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedLoad, projects, router]);

  const suggestedName = ebookPipelineSnapshot?.bookTitle ?? ebookManifest?.bookTitle ?? "";

  const readNarrationUrls = useCallback((jobId: string): Record<string, string> | undefined => {
    try {
      const raw = localStorage.getItem(`${VOICE_STUDIO_STORAGE_PREFIX}${jobId}`);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as {
        chapters?: Array<{ chapterId?: string; status?: string; audioUrl?: string | null }>;
      };
      const entries = (parsed.chapters ?? [])
        .filter((chapter): chapter is { chapterId: string; status: string; audioUrl: string } => (
          typeof chapter.chapterId === "string" &&
          chapter.chapterId.length > 0 &&
          chapter.status === "done" &&
          typeof chapter.audioUrl === "string" &&
          chapter.audioUrl.length > 0
        ))
        .map((chapter) => [chapter.chapterId, chapter.audioUrl] as const);

      if (entries.length === 0) return undefined;
      return Object.fromEntries(entries);
    } catch {
      return undefined;
    }
  }, []);

  const normalizeJobStateForSave = useCallback((value: unknown): EbookJobState | null => {
    if (!value || typeof value !== "object") return null;

    const nowIso = new Date().toISOString();
    const record = value as Record<string, unknown>;

    let storedJobId: string | null = null;
    try {
      const rawStoredJobId = localStorage.getItem(JOB_STORAGE_KEY);
      if (rawStoredJobId && rawStoredJobId.trim().length > 0) {
        storedJobId = rawStoredJobId.trim();
      }
    } catch {
      storedJobId = null;
    }

    const toIso = (input: unknown): string => {
      if (typeof input !== "string") return nowIso;
      const ts = Date.parse(input);
      return Number.isFinite(ts) ? new Date(ts).toISOString() : nowIso;
    };

    const rawStatus = typeof record.status === "string" ? record.status : "idle";
    const isValidStatus = VALID_JOB_STATUSES.has(rawStatus);

    // Preserve entire record structure, only fixing required fields
    const normalized: EbookJobState = {
      ...record,
      jobId: typeof record.jobId === "string" && record.jobId.trim().length > 0
        ? record.jobId
        : (storedJobId ?? `job-${Date.now()}`),
      status: (isValidStatus ? rawStatus : "idle") as any,
      chapters: sanitizeChapterDrafts(record.chapters),
      sectionAssignments: sanitizeSectionAssignments(record.sectionAssignments),
      createdAt: toIso(record.createdAt),
      updatedAt: toIso(record.updatedAt),
    } as EbookJobState;

    return normalized;
  }, []);

  const toJsonSafeValue = useCallback((value: unknown): unknown => {
    // Use the browser's native C++ JSON serializer instead of a recursive JS walk.
    // The previous implementation (hand-rolled DFS) visited every node in the tree
    // creating a full in-memory copy via JS object allocation — on a large job state
    // (transcript text + all section data) this was 10-100x slower than native JSON
    // and could exhaust the tab's memory, crashing the browser on Save.
    try {
      const json = JSON.stringify(value, (_key, val) => {
        if (val instanceof Date) return val.toISOString();
        if (typeof val === "bigint") return val.toString();
        if (typeof val === "function" || typeof val === "symbol") return undefined;
        return val;
      });
      return JSON.parse(json) as unknown;
    } catch {
      return null;
    }
  }, []);

  const mergeManifestIntoJobState = useCallback((
    job: EbookJobState | null,
    manifest: EbookManifest | null,
  ): EbookJobState | null => {
    if (!job) return null;
    if (!manifest || manifest.chapters.length === 0) return job;

    return {
      ...job,
      status: job.status === "failed" ? "failed" : "complete",
      chapters: manifest.chapters,
      frontMatter: manifest.frontMatter ?? job.frontMatter,
      architecture: job.architecture
        ? {
            ...job.architecture,
            bookTitle: manifest.bookTitle,
            subtitle: manifest.subtitle,
            authorName: manifest.authorName,
          }
        : {
            bookTitle: manifest.bookTitle,
            subtitle: manifest.subtitle,
            authorName: manifest.authorName,
            estimatedTotalWords: manifest.totalWordCount,
            chapters: [],
            frontMatterNotes: "",
            backMatterNotes: "",
            seriesArc: [],
            droppedSegments: [],
          },
      contentMap: job.contentMap
        ? {
            ...job.contentMap,
            allQuotes: manifest.allQuotes ?? job.contentMap.allQuotes ?? [],
          }
        : {
            totalEstimatedWords: manifest.totalWordCount,
            overarchingThemes: [],
            teachingArc: "",
            coreThesis: "",
            targetAudience: "",
            uniqueVocabulary: [],
            toneMap: "",
            segments: [],
            allQuotes: manifest.allQuotes ?? [],
          },
      updatedAt: new Date().toISOString(),
    };
  }, []);

  const toManifestFromJob = useCallback((job: EbookJobState): EbookManifest | null => {
    const chapters = sanitizeChapterDrafts(job.chapters);
    if (chapters.length === 0) return null;
    return {
      jobId: job.jobId,
      bookTitle: job.architecture?.bookTitle ?? "Untitled Book",
      subtitle: job.architecture?.subtitle ?? "",
      authorName: job.architecture?.authorName ?? "the author",
      frontMatter: job.frontMatter ?? {
        preface: "",
        introduction: "",
        conclusion: "",
        aboutAuthor: null,
        resourcesList: [],
        scriptureIndex: [],
      },
      chapters,
      totalWordCount: sumChapterWordCount(chapters),
      allQuotes: job.contentMap?.allQuotes ?? [],
      generatedAt: new Date().toISOString(),
      selectedTemplate: "devotional",
      printSpec: { trimSize: "6x9", runningHeaders: true, bleed: false, cropMarks: false },
    };
  }, []);

  const buildCompleteJobFromManifest = useCallback((
    manifest: EbookManifest,
    base: EbookJobState | null,
    projectId?: string,
  ): EbookJobState => {
    const nowIso = new Date().toISOString();
    // When no base is provided, rescue sectionAssignments from liveJobState
    // so they are never overwritten with [] by the no-base fallback path.
    const rescuedAssignments = base
      ? undefined // base path uses ...base spread, no rescue needed
      : (liveJobState?.sectionAssignments?.length ?? 0) > 0
        ? liveJobState!.sectionAssignments
        : [];
    if (base) {
      return {
        ...base,
        status: base.status === "failed" ? "failed" : "complete",
        jobId: base.jobId,
        chapters: manifest.chapters,
        frontMatter: manifest.frontMatter,
        backMatter: manifest.backMatter ?? base.backMatter ?? null,
        architecture: base.architecture
          ? {
              ...base.architecture,
              bookTitle: manifest.bookTitle,
              subtitle: manifest.subtitle,
              authorName: manifest.authorName,
              estimatedTotalWords: manifest.totalWordCount,
            }
          : {
              bookTitle: manifest.bookTitle,
              subtitle: manifest.subtitle,
              authorName: manifest.authorName,
              estimatedTotalWords: manifest.totalWordCount,
              chapters: [],
              frontMatterNotes: "",
              backMatterNotes: "",
              seriesArc: [],
              droppedSegments: [],
            },
        contentMap: base.contentMap
          ? {
              ...base.contentMap,
              totalEstimatedWords: manifest.totalWordCount,
              allQuotes: manifest.allQuotes ?? base.contentMap.allQuotes ?? [],
            }
          : {
              totalEstimatedWords: manifest.totalWordCount,
              overarchingThemes: [],
              teachingArc: "",
              coreThesis: "",
              targetAudience: "",
              uniqueVocabulary: [],
              toneMap: "",
              segments: [],
              allQuotes: manifest.allQuotes ?? [],
            },
        progress: {
          total: manifest.chapters.length,
          completed: manifest.chapters.length,
        },
        currentStage: "complete",
        updatedAt: nowIso,
      };
    }

    return {
      jobId: projectId || `ebook-${Date.now()}`,
      status: "complete",
      audioFileNames: [],
      transcripts: [],
      masterTranscript: "",
      filteredTranscript: "",
      filterRemovedCount: 0,
      voiceDNA: manifest.voiceDNA ?? null,
      contentMap: {
        totalEstimatedWords: manifest.totalWordCount,
        overarchingThemes: [],
        teachingArc: "",
        coreThesis: "",
        targetAudience: "",
        uniqueVocabulary: [],
        toneMap: "",
        segments: [],
        allQuotes: manifest.allQuotes ?? [],
      },
      architecture: {
        bookTitle: manifest.bookTitle,
        subtitle: manifest.subtitle,
        authorName: manifest.authorName,
        estimatedTotalWords: manifest.totalWordCount,
        chapters: [],
        frontMatterNotes: "",
        backMatterNotes: "",
        seriesArc: [],
        droppedSegments: [],
      },
      sectionAssignments: rescuedAssignments ?? [],
      chapterPlans: {},
      sections: [],
      chapters: manifest.chapters,
      frontMatter: manifest.frontMatter,
      backMatter: manifest.backMatter ?? null,
      exportUrls: null,
      currentStage: "complete",
      progress: {
        total: manifest.chapters.length,
        completed: manifest.chapters.length,
      },
      errorLog: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }, [liveJobState]);

  const syncProjectToWorkspaceAndCloud = useCallback(async (project: EbookProject) => {
    const startedAt = Date.now();
    emitSaveTelemetry("cloud-sync-start", { projectId: project.id, name: project.name });

    let workspaceSaved = false;
    try {
      await saveProject({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        academy: null,
        siteConfig: {},
        deliveryInstructions: "",
        chatHistory: [],
        blueprint: null,
        logicResult: null,
        uiResult: null,
        ebookManifest: null,
        ebookJobState: project.jobState,
        publishedSlug: project.publishedSlug,
        coverImageUrl: project.coverImageUrl,
        authorImageUrl: project.authorImageUrl,
      });
      workspaceSaved = true;
    } catch {
      emitSaveTelemetry("workspace-sync-failed", { projectId: project.id });
    }

    const cloudJobState = {
      ...project.jobState,
      masterTranscript: "",
      filteredTranscript: "",
      transcripts: (project.jobState.transcripts ?? [])
        .filter((t: unknown): t is { label?: unknown } => Boolean(t && typeof t === "object"))
        .map((t) => ({
          label: typeof t.label === "string" ? t.label : "",
          text: "",
        })),
    };

    const cloudProject = {
      _version: EBOOK_PROJECT_SCHEMA_VERSION,
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      academy: null,
      siteConfig: {},
      deliveryInstructions: "",
      chatHistory: [],
      blueprint: null,
      logicResult: null,
      uiResult: null,
      ebookManifest: toManifestFromJob(project.jobState),
      ebookJobState: cloudJobState,
      publishedSlug: project.publishedSlug,
      coverImageUrl: project.coverImageUrl,
      authorImageUrl: project.authorImageUrl,
    };

    let cloudSaved = false;
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: cloudProject }),
      });
      if (!res.ok) {
        emitSaveTelemetry("cloud-sync-failed", {
          projectId: project.id,
          status: res.status,
          durationMs: Date.now() - startedAt,
        });
      } else {
        const payload = await res.json().catch(() => null) as { cloudSaved?: boolean; workspaceSaved?: boolean } | null;
        cloudSaved = Boolean(payload?.cloudSaved);
        emitSaveTelemetry("cloud-sync-finish", {
          projectId: project.id,
          cloudSaved,
          workspaceSaved,
          durationMs: Date.now() - startedAt,
        });
      }
    } catch {
      emitSaveTelemetry("cloud-sync-failed", {
        projectId: project.id,
        durationMs: Date.now() - startedAt,
      });
    }

    return { workspaceSaved, cloudSaved };
  }, [emitSaveTelemetry, toManifestFromJob]);

  // ── Project handlers ──────────────────────────────────────────────────────

  const handleSaveProject = useCallback(async (name: string, options?: { silent?: boolean; localOnly?: boolean }) => {
    if (saveInFlightRef.current) {
      if (!options?.silent) {
        setStatusMsg({ type: "success", text: "Save already in progress..." });
      }
      return;
    }
    saveInFlightRef.current = true;
    try {
      const fallbackProject = currentProjectId
        ? projects.find((p) => p.id === currentProjectId)
        : null;

      let parsedRaw: unknown = liveJobState ?? fallbackProject?.jobState;
      if (!parsedRaw) {
        try {
          const raw = localStorage.getItem(JOB_STATE_KEY);
          if (raw) {
            parsedRaw = JSON.parse(raw) as unknown;
          }
        } catch {
          parsedRaw = null;
        }
      }

      let jobState = mergeManifestIntoJobState(
        normalizeJobStateForSave(parsedRaw),
        ebookManifest,
      );

      if (!parsedRaw) {
        const savedJobId = localStorage.getItem(JOB_STORAGE_KEY);
        if (savedJobId) {
          parsedRaw = await getEbookJob(savedJobId).catch(() => null);
          // C-3: if IndexedDB is empty (cleared, different device, incognito),
          // fall back to the server checkpoint written after every pipeline stage.
          if (!parsedRaw) {
            parsedRaw = await tryLoadServerCheckpoint(savedJobId);
          }
          jobState = mergeManifestIntoJobState(
            normalizeJobStateForSave(parsedRaw),
            ebookManifest,
          );
        }
      }

      if (!jobState) {
        // Allow saving imported manifest-only sessions by synthesizing a complete job snapshot.
        if (ebookManifest && ebookManifest.chapters.length > 0) {
          const nowIso = new Date().toISOString();
          const fallbackJob: EbookJobState = {
            jobId: currentProjectId || `ebook-${Date.now()}`,
            status: "complete",
            audioFileNames: [],
            transcripts: [],
            masterTranscript: "",
            filteredTranscript: "",
            filterRemovedCount: 0,
            voiceDNA: ebookManifest.voiceDNA ?? null,
            contentMap: {
              totalEstimatedWords: ebookManifest.totalWordCount,
              overarchingThemes: [],
              teachingArc: "",
              coreThesis: "",
              targetAudience: "",
              uniqueVocabulary: [],
              toneMap: "",
              segments: [],
              allQuotes: ebookManifest.allQuotes ?? [],
            },
            architecture: {
              bookTitle: ebookManifest.bookTitle,
              subtitle: ebookManifest.subtitle,
              authorName: ebookManifest.authorName,
              estimatedTotalWords: ebookManifest.totalWordCount,
              chapters: [],
              frontMatterNotes: "",
              backMatterNotes: "",
              seriesArc: [],
              droppedSegments: [],
            },
            sectionAssignments: [],
            chapterPlans: {},
            sections: [],
            chapters: ebookManifest.chapters,
            frontMatter: ebookManifest.frontMatter,
            backMatter: ebookManifest.backMatter ?? null,
            exportUrls: null,
            currentStage: "complete",
            progress: {
              total: ebookManifest.chapters.length,
              completed: ebookManifest.chapters.length,
            },
            errorLog: [],
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          jobState = fallbackJob;
        } else {
          if (!options?.silent) {
            setStatusMsg({ type: "error", text: "Nothing to save yet — start the pipeline first." });
          }
          return;
        }
      }

      const safeJobState = normalizeJobStateForSave(toJsonSafeValue(jobState));
      if (!safeJobState) {
        setStatusMsg({ type: "error", text: "Save failed: project data contains unsupported values." });
        return;
      }

      const safeChapters = (safeJobState.chapters ?? []).filter((chapter): chapter is ChapterDraft => Boolean(chapter && typeof chapter === "object"));
      const chapterCount = safeChapters.length;
      const totalWordCount = sumChapterWordCount(safeChapters);

      const id = ensureActiveProjectId(safeJobState.jobId);
      const existing = projects.find((p) => p.id === id);
      const existingChapters = sanitizeChapterDrafts(existing?.jobState.chapters);
      const shouldPreserveExisting = Boolean(existing && existingChapters.length > 0 && chapterCount === 0);
      const persistedJobState = shouldPreserveExisting
        ? existing!.jobState
        : safeJobState;
      const persistedChapters = shouldPreserveExisting ? existingChapters : safeChapters;
      const persistedChapterCount = persistedChapters.length;
      const persistedTotalWordCount = sumChapterWordCount(persistedChapters);

      const project: EbookProject = {
        _version: EBOOK_PROJECT_SCHEMA_VERSION,
        id,
        name,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        bookTitle: ebookManifest?.bookTitle ?? persistedJobState.architecture?.bookTitle ?? name,
        chapterCount: persistedChapterCount,
        totalWordCount: persistedTotalWordCount,
        status: persistedJobState.status,
        jobState: persistedJobState,
        publishedSlug: existing?.publishedSlug,
        coverImageUrl: existing?.coverImageUrl,
        authorImageUrl: existing?.authorImageUrl,
      };
      let localSaved = false;
      try {
        await saveEbookProject(project);
        localSaved = true;
        if (persistedChapterCount === 0 && project.jobState.status === "complete") {
          console.warn("[handleSaveProject] WARNING: Saving complete project with 0 valid chapters");
        }
      } catch (err) {
        localSaved = false;
        console.error("[handleSaveProject] IndexedDB save failed:", err);
      }

      let workspaceProjectSaved = false;
      try {
        await saveProject({
          id: project.id,
          name: project.name,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          academy: null,
          siteConfig: {},
          deliveryInstructions: "",
          chatHistory: [],
          blueprint: null,
          logicResult: null,
          uiResult: null,
          ebookManifest: null,
          ebookJobState: project.jobState,
          publishedSlug: project.publishedSlug,
          coverImageUrl: project.coverImageUrl,
          authorImageUrl: project.authorImageUrl,
        });
        workspaceProjectSaved = true;
      } catch (err) {
        workspaceProjectSaved = false;
        console.error("[handleSaveProject] Workspace save failed:", err);
      }

      try {
        localStorage.setItem(JOB_STATE_KEY, JSON.stringify(project.jobState));
        localStorage.setItem(JOB_STORAGE_KEY, project.jobState.jobId);
      } catch (err) {
        // localStorage may be unavailable in some browser modes
        console.warn("[handleSaveProject] localStorage unavailable:", err);
      }
      setCurrentProjectIdStable(id);
      pendingProjectIdRef.current = null;
      if (localSaved) {
        setProjects(await listEbookProjects());
      } else {
        setProjects((prev) => {
          const idx = prev.findIndex((p) => p.id === id);
          if (idx === -1) return [project, ...prev];
          const next = [...prev];
          next[idx] = project;
          return next;
        });
      }

      // Strip raw transcript text from cloud payload — it's the largest part and
      // not needed for chapter restore. Chapters, architecture, frontMatter and
      // contentMap are preserved in full so reload works from R2.
      const cloudJobState = {
        ...persistedJobState,
        masterTranscript: "",
        filteredTranscript: "",
        transcripts: (persistedJobState.transcripts ?? [])
          .filter((t: unknown): t is { label?: unknown } => Boolean(t && typeof t === "object"))
          .map((t) => ({
            label: typeof t.label === "string" ? t.label : "",
            text: "",
          })),
      };

      let workspaceFileSaved = false;
      let cloudSaved = false;
      if (!options?.localOnly) {
        const cloudRes = await fetch("/api/projects", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: {
              _version: EBOOK_PROJECT_SCHEMA_VERSION,
              id: project.id,
              name: project.name,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              academy: null,
              siteConfig: {},
              deliveryInstructions: "",
              chatHistory: [],
              blueprint: null,
              logicResult: null,
              uiResult: null,
              ebookManifest: toManifestFromJob(persistedJobState),
              ebookJobState: cloudJobState,
              publishedSlug: project.publishedSlug,
              coverImageUrl: project.coverImageUrl,
              authorImageUrl: project.authorImageUrl,
            },
          }),
        }).catch(() => null);
        const cloudPayload = cloudRes?.ok
          ? await cloudRes.json().catch(() => null) as { workspaceSaved?: boolean; cloudSaved?: boolean } | null
          : null;
        workspaceFileSaved = Boolean(cloudPayload?.workspaceSaved);
        cloudSaved = Boolean(cloudPayload?.cloudSaved);
      }

      if (!localSaved && !workspaceProjectSaved && !workspaceFileSaved && !cloudSaved) {
        setStatusMsg({ type: "error", text: "Save failed: no local or workspace persistence target completed." });
        return;
      }

      const savedTargets = [
        localSaved ? "projects" : null,
        workspaceProjectSaved ? "workspace panel" : null,
        !options?.localOnly && workspaceFileSaved ? "workspace file" : null,
        !options?.localOnly && cloudSaved ? "cloud backup" : null,
      ].filter((target): target is string => Boolean(target));

      if (!options?.silent) {
        setStatusMsg({
          type: "success",
          text: `"${name}" saved to ${savedTargets.join(", ")}.`,
        });
      }
    } catch (err) {
      if (!options?.silent) {
        setStatusMsg({ type: "error", text: err instanceof Error ? err.message : "Save failed." });
      }
    } finally {
      saveInFlightRef.current = false;
    }
  }, [
    currentProjectId,
    ensureActiveProjectId,
    ebookManifest,
    liveJobState,
    mergeManifestIntoJobState,
    normalizeJobStateForSave,
    projects,
    toJsonSafeValue,
  ]);

  const runAutoSaveProjectOnce = useCallback(async ({
    name,
    manifest,
  }: {
    name: string;
    manifest: EbookManifest;
  }) => {
    const startedAt = Date.now();
    emitSaveTelemetry("autosave-start", {
      name,
      manifestJobId: manifest.jobId,
      chapterCount: manifest.chapters.length,
    });
    try {
      const id = ensureActiveProjectId(safeJobState.jobId);
      const existing = projects.find((p) => p.id === id) ?? null;

      const latestLiveJobState = liveJobStateRef.current;
      const candidateBase = normalizeJobStateForSave(toJsonSafeValue(latestLiveJobState ?? existing?.jobState));
      const jobState = buildCompleteJobFromManifest(manifest, candidateBase, id);
      const safeJobState = normalizeJobStateForSave(toJsonSafeValue(jobState));
      if (!safeJobState) throw new Error("Autosave failed: could not normalize job state.");

      const safeChapters = sanitizeChapterDrafts(safeJobState.chapters);
      const project: EbookProject = {
        _version: EBOOK_PROJECT_SCHEMA_VERSION,
        id,
        name,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        bookTitle: manifest.bookTitle,
        chapterCount: safeChapters.length,
        totalWordCount: sumChapterWordCount(safeChapters),
        status: safeJobState.status,
        jobState: safeJobState,
        publishedSlug: existing?.publishedSlug,
        coverImageUrl: existing?.coverImageUrl,
        authorImageUrl: existing?.authorImageUrl,
      };

      let projectSaved = false;
      try {
        await saveEbookProject(project);
        projectSaved = true;
      } catch {
        emitSaveTelemetry("autosave-indexeddb-project-failed", { projectId: project.id });
      }

      let jobSaved = false;
      try {
        await saveEbookJob(safeJobState);
        jobSaved = true;
      } catch {
        emitSaveTelemetry("autosave-indexeddb-job-failed", { jobId: safeJobState.jobId });
      }

      let localStorageSaved = false;
      try {
        localStorage.setItem(JOB_STATE_KEY, JSON.stringify(project.jobState));
        localStorage.setItem(JOB_STORAGE_KEY, project.jobState.jobId);
        localStorageSaved = true;
      } catch {
        // localStorage unavailable
      }

      setProjects((prev) => {
        const idx = prev.findIndex((p) => p.id === project.id);
        if (idx === -1) return [project, ...prev];
        const next = [...prev];
        next[idx] = project;
        return next;
      });

      const now = Date.now();
      const shouldSyncCloudNow =
        safeJobState.status === "complete" ||
        safeJobState.status === "failed" ||
        now - lastCloudSyncAtRef.current >= 60000;

      if (projectSaved || jobSaved || localStorageSaved) {
        if (shouldSyncCloudNow) {
          lastCloudSyncAtRef.current = now;
          void syncProjectToWorkspaceAndCloud(project);
        }
      } else {
        lastCloudSyncAtRef.current = now;
        const syncResult = await syncProjectToWorkspaceAndCloud(project);
        if (!syncResult.workspaceSaved && !syncResult.cloudSaved) {
          throw new Error("Autosave failed: no persistence targets succeeded.");
        }
      }
      setLiveJobState(safeJobState);
      pendingProjectIdRef.current = null;
      emitSaveTelemetry("autosave-finish", {
        projectId: project.id,
        jobId: safeJobState.jobId,
        projectSaved,
        jobSaved,
        localStorageSaved,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      emitSaveTelemetry("autosave-failed", {
        name,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : "unknown",
      });
      throw err;
    } finally {
      // outer queue runner controls in-flight lock
    }
  }, [
    buildCompleteJobFromManifest,
    ensureActiveProjectId,
    emitSaveTelemetry,
    liveJobState,
    normalizeJobStateForSave,
    projects,
    saveEbookJob,
    syncProjectToWorkspaceAndCloud,
    toJsonSafeValue,
  ]);

  const handleAutoSaveProject = useCallback(async ({
    name,
    manifest,
  }: {
    name: string;
    manifest: EbookManifest;
  }) => {
    queuedAutoSaveRef.current = { name, manifest };
    if (autoSaveInFlightRef.current) {
      emitSaveTelemetry("autosave-queued", { name, manifestJobId: manifest.jobId });
      return;
    }

    autoSaveInFlightRef.current = true;
    try {
      while (queuedAutoSaveRef.current) {
        const next = queuedAutoSaveRef.current;
        queuedAutoSaveRef.current = null;
        await runAutoSaveProjectOnce(next);
      }
    } finally {
      autoSaveInFlightRef.current = false;
    }
  }, [emitSaveTelemetry, runAutoSaveProjectOnce]);

  const handleLoadProject = useCallback(async (id: string) => {
    const p = projects.find((proj) => proj.id === id);
    if (!p) return;

    try {
      const projectJob = normalizeJobStateForSave(p.jobState);
      const candidates: Array<EbookJobState | null> = [projectJob];
      const expectedJobId = projectJob?.jobId ?? null;

      try {
        const raw = localStorage.getItem(JOB_STATE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          const parsedCandidate = normalizeJobStateForSave(parsed);
          if (!expectedJobId || parsedCandidate?.jobId === expectedJobId) {
            candidates.push(parsedCandidate);
          }
        }
      } catch {
        // localStorage may be unavailable
      }

      const preferredIdbJobId = expectedJobId ?? (() => {
        try {
          return localStorage.getItem(JOB_STORAGE_KEY);
        } catch {
          return null;
        }
      })();
      if (preferredIdbJobId) {
        let idbJob = await getEbookJob(preferredIdbJobId).catch(() => null);
        // C-3: fall back to server checkpoint when IndexedDB is empty
        // (cleared browser data, incognito, different device).
        if (!idbJob) {
          idbJob = await tryLoadServerCheckpoint(preferredIdbJobId);
        }
        const idbCandidate = normalizeJobStateForSave(idbJob);
        if (!expectedJobId || idbCandidate?.jobId === expectedJobId) {
          candidates.push(idbCandidate);
        }
      }

      let normalized = pickBestJobState(candidates);
      if (!normalized) {
        setStatusMsg({ type: "error", text: "Cannot load this project: saved data is corrupted or incomplete." });
        return;
      }

      let manifest = toManifestFromJob(normalized);
      if (!manifest && p.publishedSlug) {
        try {
          const res = await fetch(`/api/ebook/publish?slug=${encodeURIComponent(p.publishedSlug)}`);
          if (res.ok) {
            const payload = await res.json() as { manifest?: EbookManifest };
            if (payload.manifest) {
              manifest = payload.manifest;
              const merged = mergeManifestIntoJobState(normalized, payload.manifest);
              if (merged) normalized = merged;
            }
          }
        } catch {
          // Published fallback is best-effort.
        }
      }

      try {
        localStorage.setItem(JOB_STATE_KEY, JSON.stringify(normalized));
        localStorage.setItem(JOB_STORAGE_KEY, normalized.jobId);
      } catch {}
      
      // Set as initial state for pipeline to use directly (more reliable than localStorage-only)
      setPipelineInitialJobState(normalized);
      // Populate liveJobState immediately so the first autosave after remount
      // has the full job state (including sectionAssignments) as its base.
      // Without this, buildCompleteJobFromManifest receives null and creates
      // sectionAssignments: [] which overwrites IndexedDB on the first autosave.
      liveJobStateRef.current = normalized;
      setLiveJobState(normalized);
      setCurrentProjectIdStable(p.id);
      setEbookManifest(
        manifest
          ? {
              ...manifest,
              coverImageUrl: p.coverImageUrl ?? null,
              authorImageUrl: p.authorImageUrl ?? null,
            }
          : null
      );
      setActiveTab("pipeline");
      setStatusMsg({
        type: "success",
        text: `"${p.name}" loaded — resuming pipeline.`,
      });
      setPipelineKey((k) => k + 1);
    } catch (err) {
      setStatusMsg({ type: "error", text: err instanceof Error ? err.message : "Load failed." });
    }
  }, [mergeManifestIntoJobState, normalizeJobStateForSave, projects, setCurrentProjectIdStable, toManifestFromJob]);

  const handleDeleteProject = useCallback(async (id: string) => {
    await deleteEbookProject(id);
    setProjects(await listEbookProjects());
    if (currentProjectIdRef.current === id) clearCurrentProjectIdStable();
    await fetch("/api/projects", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }, [clearCurrentProjectIdStable]);

  // ── Unpublish handler ─────────────────────────────────────────────────────

  const handleUnpublish = useCallback(async (project: EbookProject): Promise<boolean> => {
    if (!project.publishedSlug) return false;
    try {
      const res = await fetch("/api/ebook/publish", {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ slug: project.publishedSlug }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        setStatusMsg({ type: "error", text: err.error ?? "Remove from library failed." });
        return false;
      }
      // Clear publishedSlug from local project record
      const updated: EbookProject = {
        ...project,
        _version: EBOOK_PROJECT_SCHEMA_VERSION,
        publishedSlug: undefined,
      };
      await saveEbookProject(updated);
      setProjects(await listEbookProjects());
      setStatusMsg({ type: "success", text: `"${project.name}" removed from the library.` });
      // Sync cleared slug to R2
      fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: {
            _version: EBOOK_PROJECT_SCHEMA_VERSION,
            id: updated.id, name: updated.name,
            createdAt: updated.createdAt, updatedAt: updated.updatedAt,
            academy: null, siteConfig: {}, deliveryInstructions: "",
            chatHistory: [], blueprint: null, logicResult: null, uiResult: null,
            ebookManifest: null, ebookJobState: updated.jobState, publishedSlug: undefined,
          },
        }),
      }).catch(() => {});
      return true;
    } catch (err) {
      setStatusMsg({ type: "error", text: err instanceof Error ? err.message : "Remove failed." });
      return false;
    }
  }, []);

  const handleImportProject = useCallback(async (project: EbookProject) => {
    const normalizedProject: EbookProject = {
      ...project,
      _version: typeof project._version === "number" ? project._version : EBOOK_PROJECT_SCHEMA_VERSION,
    };

    await saveEbookProject(normalizedProject);
    setProjects(await listEbookProjects());
    setCurrentProjectIdStable(normalizedProject.id);

    let storageUnavailable = false;
    try {
      localStorage.setItem(JOB_STATE_KEY, JSON.stringify(normalizedProject.jobState));
      localStorage.setItem(JOB_STORAGE_KEY, normalizedProject.jobState.jobId);
    } catch {
      storageUnavailable = true;
    }
    setPipelineInitialJobState(normalizedProject.jobState);
    liveJobStateRef.current = normalizedProject.jobState;
    setLiveJobState(normalizedProject.jobState);
    setPipelineKey((k) => k + 1);
    const importRes = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: {
          _version: EBOOK_PROJECT_SCHEMA_VERSION,
          id: normalizedProject.id,
          name: normalizedProject.name,
          createdAt: normalizedProject.createdAt,
          updatedAt: normalizedProject.updatedAt,
          academy: null,
          siteConfig: {},
          deliveryInstructions: "",
          chatHistory: [],
          blueprint: null,
          logicResult: null,
          uiResult: null,
          ebookManifest: null,
          ebookJobState: normalizedProject.jobState,
          publishedSlug: normalizedProject.publishedSlug,
          coverImageUrl: normalizedProject.coverImageUrl,
          authorImageUrl: normalizedProject.authorImageUrl,
        },
      }),
    }).catch(() => null);
    const importPayload = importRes?.ok
      ? await importRes.json().catch(() => null) as { workspaceSaved?: boolean; cloudSaved?: boolean } | null
      : null;
    const importedTargets = [
      "projects",
      importPayload?.workspaceSaved ? "workspace file" : null,
      importPayload?.cloudSaved ? "cloud backup" : null,
    ].filter((target): target is string => Boolean(target));
    setStatusMsg({
      type: "success",
      text: storageUnavailable
        ? `"${normalizedProject.name}" imported to ${importedTargets.join(", ")} and loaded from durable fallback mode.`
        : `"${normalizedProject.name}" imported to ${importedTargets.join(", ")} and loaded.`,
    });
  }, [setCurrentProjectIdStable]);

  // ── Publish handler ───────────────────────────────────────────────────────

  const handlePublish = useCallback(async (project: EbookProject): Promise<string | null> => {
    const toManifest = (job: EbookJobState | null | undefined): EbookManifest | null => {
      if (!job) return null;
      const chapters = sanitizeChapterDrafts(job.chapters);
      if (chapters.length === 0) return null;

      const nowIso = new Date().toISOString();
      const parsedUpdated = Date.parse(job.updatedAt ?? "");
      const generatedAt = Number.isFinite(parsedUpdated) ? new Date(parsedUpdated).toISOString() : nowIso;

      return {
        jobId: job.jobId,
        bookTitle: job.architecture?.bookTitle ?? project.name,
        subtitle: job.architecture?.subtitle ?? "",
        authorName: job.architecture?.authorName ?? "the author",
        frontMatter: job.frontMatter ?? {
          preface: "",
          introduction: "",
          conclusion: "",
          aboutAuthor: null,
          resourcesList: [],
          scriptureIndex: [],
        },
        chapters,
        totalWordCount: sumChapterWordCount(chapters),
        allQuotes: job.contentMap?.allQuotes ?? [],
        generatedAt,
        selectedTemplate: "devotional",
        printSpec: { trimSize: "6x9", runningHeaders: true, bleed: false, cropMarks: false },
        coverImageUrl: project.coverImageUrl ?? null,
        authorImageUrl: project.authorImageUrl ?? null,
        narrationUrls: readNarrationUrls(job.jobId),
      };
    };

    const candidates: Array<EbookJobState | null> = [
      normalizeJobStateForSave(project.jobState),
      project.id === currentProjectId ? normalizeJobStateForSave(liveJobState) : null,
    ];

    if (project.id === currentProjectId) {
      try {
        const raw = localStorage.getItem(JOB_STATE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          candidates.push(normalizeJobStateForSave(parsed));
        }
      } catch {
        // localStorage may be unavailable
      }

      try {
        const savedJobId = localStorage.getItem(JOB_STORAGE_KEY);
        if (savedJobId) {
          const idbJob = await getEbookJob(savedJobId).catch(() => null);
          candidates.push(normalizeJobStateForSave(idbJob));
        }
      } catch {
        // IndexedDB may be unavailable
      }
    }

    let manifest: EbookManifest | null = null;
    const bestCandidate = pickBestJobState(candidates);
    if (bestCandidate) {
      manifest = toManifest(bestCandidate);
    }
    if (!manifest) {
      for (const candidate of candidates) {
        manifest = toManifest(candidate);
        if (manifest) break;
      }
    }

    if (!manifest && project.id === currentProjectId && ebookManifest && ebookManifest.chapters.length > 0) {
      manifest = {
        ...ebookManifest,
        coverImageUrl: project.coverImageUrl ?? ebookManifest.coverImageUrl ?? null,
        authorImageUrl: project.authorImageUrl ?? ebookManifest.authorImageUrl ?? null,
      };
    }

    if (!manifest) {
      setStatusMsg({ type: "error", text: "Cannot publish yet: load this project and ensure it has chapters, then try Publish again." });
      return null;
    }

    try {
      const res = await fetch("/api/ebook/publish", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ manifest, coverAccent: "amber" }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        setStatusMsg({ type: "error", text: err.error ?? "Publish failed." });
        return null;
      }
      const { slug } = await res.json() as { slug: string };
      const updated: EbookProject = {
        ...project,
        _version: EBOOK_PROJECT_SCHEMA_VERSION,
        publishedSlug: slug,
      };
      await saveEbookProject(updated);
      setProjects(await listEbookProjects());
      setStatusMsg({ type: "success", text: `"${project.name}" published to /library/${slug}` });
      return slug;
    } catch (err) {
      setStatusMsg({ type: "error", text: err instanceof Error ? err.message : "Publish failed." });
      return null;
    }
  }, [currentProjectId, ebookManifest, liveJobState, normalizeJobStateForSave, readNarrationUrls]);

  const handleUpdateImages = useCallback(async (
    id: string,
    coverImageUrl?: string,
    authorImageUrl?: string,
  ) => {
    const p = projects.find((proj) => proj.id === id);
    if (!p) return;
    const updated: EbookProject = {
      ...p,
      _version: EBOOK_PROJECT_SCHEMA_VERSION,
      ...(coverImageUrl  !== undefined ? { coverImageUrl  } : {}),
      ...(authorImageUrl !== undefined ? { authorImageUrl } : {}),
    };
    await saveEbookProject(updated);
    setProjects(await listEbookProjects());
    // Sync to R2
    fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: {
          _version: EBOOK_PROJECT_SCHEMA_VERSION,
          id: updated.id, name: updated.name,
          createdAt: updated.createdAt, updatedAt: updated.updatedAt,
          academy: null, siteConfig: {}, deliveryInstructions: "",
          chatHistory: [], blueprint: null, logicResult: null, uiResult: null,
          ebookManifest: null, ebookJobState: updated.jobState,
          publishedSlug: updated.publishedSlug,
          coverImageUrl: updated.coverImageUrl,
          authorImageUrl: updated.authorImageUrl,
        },
      }),
    }).catch(() => {});
    // If already published, push the new images to the library immediately
    if (updated.publishedSlug) {
      handlePublish(updated).catch(() => {});
    }
  }, [projects, handlePublish]);

  // ── Manifest handlers ─────────────────────────────────────────────────────

  const handleManifestReady = useCallback((manifest: EbookManifest) => {
    setEbookManifest(manifest);
  }, []);

  const handleEbookUpdate = useCallback((manifest: EbookManifest) => {
    setEbookManifest(manifest);
    setLiveJobState((current) => mergeManifestIntoJobState(current, manifest));
    // Write the AI-edited manifest back to localStorage so the pipeline display,
    // saves, and reloads all reflect the changes immediately.
    try {
      const raw = localStorage.getItem(JOB_STATE_KEY);
      if (raw) {
        const existing = JSON.parse(raw) as Record<string, unknown>;
        const updatedJobState = {
          ...existing,
          chapters: manifest.chapters,
          frontMatter: manifest.frontMatter,
          ...(existing.architecture
            ? {
                architecture: {
                  ...(existing.architecture as Record<string, unknown>),
                  bookTitle: manifest.bookTitle,
                  subtitle: manifest.subtitle,
                  authorName: manifest.authorName,
                },
              }
            : {}),
        };
        localStorage.setItem(JOB_STATE_KEY, JSON.stringify(updatedJobState));
      }
    } catch {
      // localStorage unavailable — in-memory state still updated correctly
    }
  }, [mergeManifestIntoJobState]);

  const handlePipelineSnapshotChange = useCallback((snapshot: EbookPipelineSnapshot | null) => {
    setEbookPipelineSnapshot(snapshot);
  }, []);

  const handleExportJson = useCallback(() => {
    if (!ebookManifest) return;
    const blob = new Blob([JSON.stringify({ ebookManifest }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${ebookManifest.bookTitle.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_ebook_manifest.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [ebookManifest]);

  const handleStartFreshProject = useCallback(() => {
    const confirmed = window.confirm(
      "Start a fresh book project? This will clear the current in-progress pipeline from this screen, but your saved projects will remain available."
    );
    if (!confirmed) return;

    try {
      localStorage.removeItem(JOB_STATE_KEY);
      localStorage.removeItem(JOB_STORAGE_KEY);
      localStorage.removeItem(PENDING_MOUNT_KEY);
    } catch {
      // localStorage unavailable; in-memory reset still applies
    }

    hydratedLoadRef.current = null;
    clearCurrentProjectIdStable();
    setPipelineInitialJobState(null);
    setEbookManifest(null);
    setEbookPipelineSnapshot(null);
    setAssistantOpen(false);
    setActiveTab("pipeline");
    setPipelineKey((k) => k + 1);
    setStatusMsg({ type: "success", text: "Started a fresh book project." });
    router.replace("/ebook?tab=pipeline");
  }, [router]);

  const handleNavSelect = useCallback((id: string) => {
    if (id === "ebook") {
      router.push("/ebook?tab=pipeline");
      return;
    }
    if (id === "translate") {
      router.push("/translate");
      return;
    }
    router.push("/");
  }, [router]);

  return (
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-shell-950 bg-grid bg-radial-glow safe-area-frame text-slate-100">
      <NexusNav active="ebook" onSelect={handleNavSelect} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),_3.75rem)] lg:pb-0">
        <StatusBar stage="idle" models={[]} />

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-md">
            <div className="w-full px-4 lg:px-8">
              <div className="flex items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-cyan-500/15 ring-1 ring-cyan-400/30"
                    style={{ boxShadow: "0 0 14px rgba(6,182,212,0.20)" }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5 text-cyan-400">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M9 7h7M9 11h5" strokeLinecap="round" />
                    </svg>
                  </div>
                  <div>
                    <h1 className="text-sm font-bold leading-none text-slate-100">Ebook Production Studio</h1>
                    <p className="mt-0.5 text-[11px] text-slate-400">Audio → Voice DNA → Chapters → PDF + EPUB</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleStartFreshProject}
                    className="flex min-h-12 items-center gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2 text-xs font-semibold text-amber-300 transition hover:border-amber-400/60 hover:bg-amber-500/15 active:scale-[0.97]"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                      <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M20 20v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="hidden sm:inline">New Project</span>
                    <span className="sm:hidden">New</span>
                  </button>
                  {ebookManifest && (
                    <>
                      <button
                        type="button"
                        onClick={() => setAssistantOpen(true)}
                        className="flex min-h-[44px] items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3.5 py-2 text-xs font-semibold text-cyan-300 transition hover:border-cyan-400/60 hover:bg-cyan-500/15 active:scale-[0.97]"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M9 12h6M12 9v6" strokeLinecap="round" />
                        </svg>
                        <span className="hidden sm:inline">Director AI</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleExportJson}
                        className="flex min-h-[44px] items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs font-semibold text-emerald-300 transition hover:border-emerald-400/60 hover:bg-emerald-500/15 active:scale-[0.97]"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                          <path d="M12 3v12" strokeLinecap="round" />
                          <polyline points="17 12 12 17 7 12" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
                        </svg>
                        <span className="hidden sm:inline">Export</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="flex gap-1 pb-0">
                <button
                  type="button"
                  onClick={() => setActiveTab("pipeline")}
                  className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${activeTab === "pipeline" ? "border-cyan-400 text-cyan-300" : "border-transparent text-slate-400 hover:text-slate-200"}`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                    <path d="M5 3h14M5 8h14M5 13l4 4 4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Pipeline
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("projects")}
                  className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${activeTab === "projects" ? "border-cyan-400 text-cyan-300" : "border-transparent text-slate-400 hover:text-slate-200"}`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                    <rect x="2" y="7" width="20" height="14" rx="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Projects
                  {projects.length > 0 && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500/25 px-1 text-[10px] font-bold text-cyan-300">
                      {projects.length}
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>

          {statusMsg && (
            <div className="shrink-0 px-4 pt-3 lg:px-8">
              <p className={`rounded-xl border px-3 py-2 text-xs ${statusMsg.type === "error" ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}`}>
                {statusMsg.text}
              </p>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className={activeTab === "pipeline" ? "flex min-h-0 flex-1 overflow-hidden" : "hidden"}>
              <div className="h-full w-full overflow-y-auto overscroll-contain px-4 pt-5 pb-[max(env(safe-area-inset-bottom),1.5rem)] lg:px-8 lg:pt-6 lg:pb-6" style={{ WebkitOverflowScrolling: "touch" }}>
                <EbookPipeline
                  key={pipelineKey}
                  initialJobState={pipelineInitialJobState}
                  ebookManifest={ebookManifest}
                  onManifestReady={handleManifestReady}
                  onPipelineSnapshotChange={handlePipelineSnapshotChange}
                  onJobStateChange={(job) => {
                    liveJobStateRef.current = job;
                    setLiveJobState(job);
                  }}
                  onSaveProject={(name) => void handleSaveProject(name)}
                  onAutoSaveProject={handleAutoSaveProject}
                />
              </div>
            </div>

            <div className={activeTab === "projects" ? "flex min-h-0 flex-1 overflow-hidden" : "hidden"}>
              <div className="h-full w-full overflow-y-auto overscroll-contain px-4 pt-5 pb-[max(env(safe-area-inset-bottom),1.5rem)] lg:px-8 lg:pt-6 lg:pb-6" style={{ WebkitOverflowScrolling: "touch" }}>
                <EbookProjectsPanel
                  projects={projects}
                  suggestedName={suggestedName}
                  canSave
                  onSave={handleSaveProject}
                  onLoad={handleLoadProject}
                  onDelete={handleDeleteProject}
                  onImport={handleImportProject}
                  onImportManifestJson={toManifestFromJob}
                  onPublish={handlePublish}
                  onUnpublish={handleUnpublish}
                  onUpdateImages={handleUpdateImages}
                  onManifestLoaded={(manifest) => {
                    // Assign a stable project ID so subsequent saves
                    // update the same record instead of creating a new one.
                    if (!currentProjectIdRef.current) {
                      setCurrentProjectIdStable(generateEbookProjectId());
                    }
                    setEbookManifest(manifest);
                    setActiveTab("pipeline");
                    setStatusMsg({ type: "success", text: `"${manifest.bookTitle}" loaded — tap Save to keep it.` });
                  }}
                />
              </div>
            </div>

          </div>

          <AssistantPanel
            isOpen={assistantOpen}
            onClose={() => setAssistantOpen(false)}
            academy={null}
            onUpdate={() => {}}
            siteConfig={siteConfig}
            onSiteUpdate={() => {}}
            ebookManifest={ebookManifest}
            onEbookUpdate={handleEbookUpdate}
            ebookPipelineSnapshot={ebookPipelineSnapshot}
          />
        </main>
      </div>
    </div>
  );
}
