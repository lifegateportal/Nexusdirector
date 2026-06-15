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
import type { EbookManifest, EbookJobState } from "@/lib/schemas/ebook";
import type { SiteConfig } from "@/lib/schemas/site-config";
import type { EbookPipelineSnapshot } from "@/app/components/EbookPipeline";
import {
  listEbookProjects,
  saveEbookProject,
  deleteEbookProject,
  generateEbookProjectId,
} from "@/lib/ebook-project-store";
import { getEbookJob } from "@/lib/ebook-job-store";
import type { EbookProject } from "@/lib/ebook-project-store";

const JOB_STATE_KEY = "nexus_ebook_job_state";
const JOB_STORAGE_KEY = "nexus_ebook_current_job";
const PENDING_MOUNT_KEY = "nexus_ebook_pending_mount";
const VOICE_STUDIO_STORAGE_PREFIX = "nexus_voice_studio_";
const VALID_JOB_STATUSES = new Set([
  "idle", "transcribing", "filtering", "analyzing", "mapping",
  "architecting", "assigning", "writing", "polishing",
  "frontmatter", "exporting", "complete", "failed",
]);

type Tab = "pipeline" | "projects";

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
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [siteConfig] = useState<SiteConfig>(() => SiteConfigSchema.parse({}));

  // Project persistence
  const [projects, setProjects] = useState<EbookProject[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string>("");
  // Incrementing this key remounts <EbookPipeline> so it re-reads localStorage on load
  const [pipelineKey, setPipelineKey] = useState(0);
  // Direct prop to pass initial job state to pipeline on load (more reliable than localStorage-only)
  const [pipelineInitialJobState, setPipelineInitialJobState] = useState<EbookJobState | null>(null);
  const hydratedLoadRef = useRef<string | null>(null);

  useEffect(() => {
    void (async () => {
      const localProjects = await listEbookProjects().catch(() => []);
      setProjects(localProjects);

      try {
        const res = await fetch("/api/projects");
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
          const normalized: EbookProject = {
            id: item.id,
            name: item.name,
            createdAt: item.createdAt ?? new Date().toISOString(),
            updatedAt: item.updatedAt ?? new Date().toISOString(),
            bookTitle: job.architecture?.bookTitle ?? item.name,
            chapterCount: job.chapters?.length ?? 0,
            totalWordCount: (job.chapters ?? []).reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0),
            status: job.status,
            jobState: job,
            publishedSlug: item.publishedSlug ?? existing?.publishedSlug,
            coverImageUrl: item.coverImageUrl ?? existing?.coverImageUrl,
            authorImageUrl: item.authorImageUrl ?? existing?.authorImageUrl,
          };

          await saveEbookProject(normalized).catch(() => {});
          changed = true;
        }

        if (changed) {
          setProjects(await listEbookProjects());
        }
      } catch {
        // Cloud sync is best-effort; local projects remain usable offline.
      }
    })();
  }, []);

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
      const raw = localStorage.getItem(PENDING_MOUNT_KEY);
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
        localStorage.removeItem(PENDING_MOUNT_KEY);
        return;
      }
      const jobParsed = EbookJobStateSchema.safeParse(parsed.jobState);
      if (!jobParsed.success) {
        localStorage.removeItem(PENDING_MOUNT_KEY);
        return;
      }

      localStorage.setItem(JOB_STATE_KEY, JSON.stringify(jobParsed.data));
      if (typeof parsed.projectId === "string") setCurrentProjectId(parsed.projectId);

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
      setStatusMsg({ type: "success", text: `"${parsed.projectName ?? "Project"}" mounted in standalone pipeline.` });
      localStorage.removeItem(PENDING_MOUNT_KEY);
    } catch {
      localStorage.removeItem(PENDING_MOUNT_KEY);
    }
  }, []);

  useEffect(() => {
    if (!requestedLoad || projects.length === 0) return;
    if (hydratedLoadRef.current === requestedLoad) return;
    const project = projects.find((p) => p.id === requestedLoad);
    if (!project) return;

    try {
      localStorage.setItem(JOB_STATE_KEY, JSON.stringify(project.jobState));
      setCurrentProjectId(project.id);
      const job = project.jobState;
      if (job.architecture && job.frontMatter && job.contentMap) {
        setEbookManifest({
          jobId: job.jobId,
          bookTitle: job.architecture.bookTitle,
          subtitle: job.architecture.subtitle,
          authorName: job.architecture.authorName,
          frontMatter: job.frontMatter,
          chapters: job.chapters ?? [],
          totalWordCount: (job.chapters ?? []).reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0),
          allQuotes: job.contentMap.allQuotes ?? [],
          generatedAt: new Date().toISOString(),
          selectedTemplate: "devotional",
          printSpec: { trimSize: "6x9", runningHeaders: true, bleed: false, cropMarks: false },
          coverImageUrl: project.coverImageUrl ?? null,
          authorImageUrl: project.authorImageUrl ?? null,
        });
      }
      setPipelineKey((k) => k + 1);
      setActiveTab("pipeline");
      hydratedLoadRef.current = requestedLoad;
      setStatusMsg({ type: "success", text: `"${project.name}" mounted in standalone pipeline.` });
      router.replace("/ebook?tab=pipeline");
    } catch (err) {
      setStatusMsg({ type: "error", text: err instanceof Error ? err.message : "Project mount failed." });
    }
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
      createdAt: toIso(record.createdAt),
      updatedAt: toIso(record.updatedAt),
    } as EbookJobState;

    return normalized;
  }, []);

  // ── Project handlers ──────────────────────────────────────────────────────

  const handleSaveProject = useCallback(async (name: string) => {
    try {
      const raw = localStorage.getItem(JOB_STATE_KEY);
      const fallbackProject = currentProjectId
        ? projects.find((p) => p.id === currentProjectId)
        : null;
      let parsedRaw: unknown = liveJobState ?? fallbackProject?.jobState;
      if (raw) {
        try {
          parsedRaw = JSON.parse(raw) as unknown;
        } catch {
          parsedRaw = liveJobState ?? fallbackProject?.jobState;
        }
      }
      let jobState = normalizeJobStateForSave(parsedRaw);
      if (!parsedRaw) {
        const savedJobId = localStorage.getItem(JOB_STORAGE_KEY);
        if (savedJobId) {
          parsedRaw = await getEbookJob(savedJobId).catch(() => null);
          jobState = normalizeJobStateForSave(parsedRaw);
        }
      }
      if (!jobState) {
        setStatusMsg({ type: "error", text: "Nothing to save yet — start the pipeline first." });
        return;
      }
      const id = currentProjectId || generateEbookProjectId();
      const existing = projects.find((p) => p.id === id);
      const project: EbookProject = {
        id,
        name,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        bookTitle: jobState.architecture?.bookTitle ?? name,
        chapterCount: jobState.chapters?.length ?? 0,
        totalWordCount: (jobState.chapters ?? []).reduce((s, c) => s + (c.totalWordCount ?? 0), 0),
        status: jobState.status,
        jobState,
        publishedSlug: existing?.publishedSlug,
        coverImageUrl: existing?.coverImageUrl,
        authorImageUrl: existing?.authorImageUrl,
      };
      let localSaved = false;
      try {
        await saveEbookProject(project);
        localSaved = true;
        // Verify chapters were actually saved
        const chapterCount = project.jobState.chapters?.length ?? 0;
        if (chapterCount === 0 && project.jobState.status === "complete") {
          console.warn("[handleSaveProject] WARNING: Saving complete project with 0 chapters");
        }
      } catch (err) {
        localSaved = false;
        console.error("[handleSaveProject] IndexedDB save failed:", err);
      }
      try {
        localStorage.setItem(JOB_STATE_KEY, JSON.stringify(project.jobState));
      } catch (err) {
        // localStorage may be unavailable in some browser modes
        console.warn("[handleSaveProject] localStorage unavailable:", err);
      }
      setCurrentProjectId(id);
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

      let cloudSaved = false;
      const cloudRes = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: {
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
          },
        }),
      }).catch(() => null);
      cloudSaved = Boolean(cloudRes?.ok);

      if (!localSaved && !cloudSaved) {
        setStatusMsg({ type: "error", text: "Save failed: browser storage unavailable and cloud sync did not complete." });
        return;
      }

      setStatusMsg({
        type: "success",
        text: localSaved
          ? `"${name}" saved.`
          : `"${name}" saved to cloud backup (local browser storage is unavailable).`,
      });
    } catch (err) {
      setStatusMsg({ type: "error", text: err instanceof Error ? err.message : "Save failed." });
    }
  }, [currentProjectId, liveJobState, normalizeJobStateForSave, projects]);

  const handleLoadProject = useCallback((id: string) => {
    const p = projects.find((proj) => proj.id === id);
    if (!p) return;
    try {
      const normalized = normalizeJobStateForSave(p.jobState);
      if (!normalized) {
        setStatusMsg({ type: "error", text: "Cannot load this project: saved data is corrupted or incomplete." });
        return;
      }
      
      // Verify we have recoverable data before writing to storage
      const hasData = Boolean(
        normalized.chapters?.length ||
        normalized.architecture ||
        normalized.contentMap ||
        normalized.masterTranscript ||
        normalized.voiceDNA ||
        normalized.status === "complete"
      );
      
      if (!hasData) {
        setStatusMsg({ type: "error", text: "Project saved but has no content to restore. Try running the pipeline again." });
        return;
      }
      
      // Debug: log what we're about to load
      const chapterCount = normalized.chapters?.length ?? 0;
      console.log("[handleLoadProject] Loading project with chapters:", chapterCount, "status:", normalized.status);
      
      try {
        localStorage.setItem(JOB_STATE_KEY, JSON.stringify(normalized));
        localStorage.setItem(JOB_STORAGE_KEY, normalized.jobId);
        // Verify it was written
        const verify = localStorage.getItem(JOB_STATE_KEY);
        if (verify) {
          const parsed = JSON.parse(verify);
          console.log("[handleLoadProject] Verified localStorage write. Chapters in storage:", parsed.chapters?.length ?? 0);
        } else {
          console.warn("[handleLoadProject] localStorage write verification failed");
        }
      } catch (storageErr) {
        setStatusMsg({ type: "error", text: "Cannot load: browser storage unavailable. Try clearing cache." });
        return;
      }
      
      // Set as initial state for pipeline to use directly (more reliable than localStorage-only)
      setPipelineInitialJobState(normalized);
      setCurrentProjectId(p.id);
      const job = normalized;
      if (job.architecture && job.frontMatter && job.contentMap) {
        setEbookManifest({
          jobId: job.jobId,
          bookTitle: job.architecture.bookTitle,
          subtitle: job.architecture.subtitle,
          authorName: job.architecture.authorName,
          frontMatter: job.frontMatter,
          chapters: job.chapters ?? [],
          totalWordCount: (job.chapters ?? []).reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0),
          allQuotes: job.contentMap.allQuotes ?? [],
          generatedAt: new Date().toISOString(),
          selectedTemplate: "devotional",
          printSpec: { trimSize: "6x9", runningHeaders: true, bleed: false, cropMarks: false },
          coverImageUrl: p.coverImageUrl ?? null,
          authorImageUrl: p.authorImageUrl ?? null,
        });
      } else {
        setEbookManifest(null);
      }
      setActiveTab("pipeline");
      setStatusMsg({ type: "success", text: `"${p.name}" loaded — resuming pipeline.` });
      setPipelineKey((k) => k + 1);
    } catch (err) {
      setStatusMsg({ type: "error", text: err instanceof Error ? err.message : "Load failed." });
    }
  }, [normalizeJobStateForSave, projects]);

  const handleDeleteProject = useCallback(async (id: string) => {
    await deleteEbookProject(id);
    setProjects(await listEbookProjects());
    if (currentProjectId === id) setCurrentProjectId("");
    // Remove from R2 (fire-and-forget)
    fetch("/api/projects", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }, [currentProjectId]);

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
      const updated: EbookProject = { ...project, publishedSlug: undefined };
      await saveEbookProject(updated);
      setProjects(await listEbookProjects());
      setStatusMsg({ type: "success", text: `"${project.name}" removed from the library.` });
      // Sync cleared slug to R2
      fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: {
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
    await saveEbookProject(project);
    setProjects(await listEbookProjects());
    setCurrentProjectId(project.id);
    localStorage.setItem(JOB_STATE_KEY, JSON.stringify(project.jobState));
    setPipelineKey((k) => k + 1);
    // Mirror imported project to cloud snapshot store (best-effort)
    fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: {
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
        },
      }),
    }).catch(() => {});
    setStatusMsg({ type: "success", text: `"${project.name}" imported and loaded.` });
  }, []);

  // ── Publish handler ───────────────────────────────────────────────────────

  const handlePublish = useCallback(async (project: EbookProject): Promise<string | null> => {
    const toManifest = (job: EbookJobState | null | undefined): EbookManifest | null => {
      if (!job) return null;
      const chapters = job.chapters ?? [];
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
        totalWordCount: chapters.reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0),
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
    for (const candidate of candidates) {
      manifest = toManifest(candidate);
      if (manifest) break;
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
      const updated: EbookProject = { ...project, publishedSlug: slug };
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

  const buildManifestFromJob = useCallback((job: EbookJobState): EbookManifest | null => {
    if (!job.architecture || !job.frontMatter || !job.contentMap) return null;
    return {
      jobId: job.jobId,
      bookTitle: job.architecture.bookTitle,
      subtitle: job.architecture.subtitle,
      authorName: job.architecture.authorName,
      frontMatter: job.frontMatter,
      chapters: job.chapters ?? [],
      totalWordCount: (job.chapters ?? []).reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0),
      allQuotes: job.contentMap.allQuotes ?? [],
      generatedAt: new Date().toISOString(),
      selectedTemplate: "devotional",
      printSpec: { trimSize: "6x9", runningHeaders: true, bleed: false, cropMarks: false },
    };
  }, []);

  const handleManifestReady = useCallback((manifest: EbookManifest) => {
    setEbookManifest(manifest);
  }, []);

  const handleEbookUpdate = useCallback((manifest: EbookManifest) => {
    setEbookManifest(manifest);
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
  }, []);

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
      localStorage.removeItem(PENDING_MOUNT_KEY);
    } catch {
      // localStorage unavailable; in-memory reset still applies
    }

    hydratedLoadRef.current = null;
    setCurrentProjectId("");
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
                  onJobStateChange={setLiveJobState}
                  onSaveProject={(name) => void handleSaveProject(name)}
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
                  onImportManifestJson={buildManifestFromJob}
                  onPublish={handlePublish}
                  onUnpublish={handleUnpublish}
                  onUpdateImages={handleUpdateImages}
                  onManifestLoaded={(manifest) => {
                    setEbookManifest(manifest);
                    setActiveTab("pipeline");
                    setStatusMsg({ type: "success", text: `"${manifest.bookTitle}" loaded into pipeline.` });
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
