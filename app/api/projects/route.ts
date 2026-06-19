import { NextRequest, NextResponse } from "next/server";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { z } from "zod";

export const runtime    = "nodejs";
export const maxDuration = 30;
export const maxRequestBodySize = "50mb";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const WORKSPACE_PROJECTS_DIR = path.join(process.cwd(), ".nexusdirector", "projects");

const ProjectRecordSchema = z.object({
  id: z.string().min(1),
  updatedAt: z.string().optional(),
  createdAt: z.string().optional(),
}).passthrough();

type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

function countChapters(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((item) => Boolean(item && typeof item === "object")).length;
}

function pickValueByRecency<T>(
  incoming: T | undefined,
  existing: T | undefined,
  chapterAccessor: (value: T) => unknown,
  preferIncoming: boolean,
): T | undefined {
  if (incoming === undefined) return existing;
  if (existing === undefined) return incoming;

  const incomingChapters = countChapters(chapterAccessor(incoming));
  const existingChapters = countChapters(chapterAccessor(existing));

  if (preferIncoming) {
    if (incomingChapters === 0 && existingChapters > 0) return existing;
    return incoming;
  }

  if (existingChapters === 0 && incomingChapters > 0) return incoming;
  return existing;
}

function makeS3(accountId: string, accessKey: string, secretKey: string) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
}

function r2Ready() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) return null;
  return {
    s3:     makeS3(R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY),
    bucket: R2_BUCKET_NAME,
  };
}

function normalizeProject(project: unknown): ProjectRecord | null {
  const parsed = ProjectRecordSchema.safeParse(project);
  if (!parsed.success) return null;

  const nowIso = new Date().toISOString();
  const updatedAt = parsed.data.updatedAt && Number.isFinite(Date.parse(parsed.data.updatedAt))
    ? new Date(parsed.data.updatedAt).toISOString()
    : nowIso;
  const createdAt = parsed.data.createdAt && Number.isFinite(Date.parse(parsed.data.createdAt))
    ? new Date(parsed.data.createdAt).toISOString()
    : updatedAt;

  return {
    ...parsed.data,
    createdAt,
    updatedAt,
  };
}

function workspaceProjectPath(id: string) {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(WORKSPACE_PROJECTS_DIR, `${safeId}.json`);
}

async function ensureWorkspaceProjectsDir() {
  await mkdir(WORKSPACE_PROJECTS_DIR, { recursive: true });
}

async function listWorkspaceProjects(): Promise<ProjectRecord[]> {
  try {
    await ensureWorkspaceProjectsDir();
    const entries = await readdir(WORKSPACE_PROJECTS_DIR, { withFileTypes: true });
    const settled = await Promise.allSettled(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const raw = await readFile(path.join(WORKSPACE_PROJECTS_DIR, entry.name), "utf8");
          return normalizeProject(JSON.parse(raw) as unknown);
        }),
    );

    return settled
      .filter((result): result is PromiseFulfilledResult<ProjectRecord | null> => result.status === "fulfilled")
      .map((result) => result.value)
      .filter((project): project is ProjectRecord => Boolean(project));
  } catch (err) {
    console.error("[api/projects] Failed to read workspace projects:", err);
    return [];
  }
}

async function saveWorkspaceProject(project: ProjectRecord) {
  await ensureWorkspaceProjectsDir();
  await writeFile(workspaceProjectPath(project.id), `${JSON.stringify(project, null, 2)}\n`, "utf8");
}

async function deleteWorkspaceProject(id: string) {
  try {
    await rm(workspaceProjectPath(id), { force: true });
  } catch (err) {
    console.error("[api/projects] Failed to delete workspace project:", err);
    throw err;
  }
}

async function listR2Projects(): Promise<ProjectRecord[]> {
  const r2 = r2Ready();
  if (!r2) return [];

  const list = await r2.s3.send(
    new ListObjectsV2Command({ Bucket: r2.bucket, Prefix: "projects/" }),
  );
  const keys = (list.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => !!k && k.endsWith(".json"));

  if (keys.length === 0) return [];

  const settled = await Promise.allSettled(
    keys.map(async (key) => {
      const res = await r2.s3.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
      const raw = await res.Body?.transformToString();
      if (!raw) return null;
      return normalizeProject(JSON.parse(raw) as unknown);
    }),
  );

  return settled
    .filter((result): result is PromiseFulfilledResult<ProjectRecord | null> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((project): project is ProjectRecord => Boolean(project));
}

function mergeProjects(projects: ProjectRecord[]): ProjectRecord[] {
  const byId = new Map<string, ProjectRecord>();

  for (const project of projects) {
    const existing = byId.get(project.id);
    if (!existing) {
      byId.set(project.id, project);
      continue;
    }

    const existingTs = Date.parse(existing.updatedAt ?? existing.createdAt ?? "");
    const incomingTs = Date.parse(project.updatedAt ?? project.createdAt ?? "");
    if (!Number.isFinite(existingTs) || incomingTs >= existingTs) {
      byId.set(project.id, project);
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? ""),
  );
}

async function saveR2Project(project: ProjectRecord) {
  const r2 = r2Ready();
  if (!r2) return false;

  await r2.s3.send(
    new PutObjectCommand({
      Bucket:       r2.bucket,
      Key:          `projects/${project.id}.json`,
      Body:         JSON.stringify(project),
      ContentType:  "application/json",
      CacheControl: "private, no-cache",
    }),
  );
  return true;
}

async function readWorkspaceProject(id: string): Promise<ProjectRecord | null> {
  try {
    const raw = await readFile(workspaceProjectPath(id), "utf8");
    return normalizeProject(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function readR2Project(id: string): Promise<ProjectRecord | null> {
  const r2 = r2Ready();
  if (!r2) return null;

  try {
    const res = await r2.s3.send(new GetObjectCommand({ Bucket: r2.bucket, Key: `projects/${id}.json` }));
    const raw = await res.Body?.transformToString();
    if (!raw) return null;
    return normalizeProject(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function mergeProjectRecord(existing: ProjectRecord | null, incoming: ProjectRecord): ProjectRecord {
  if (!existing) return incoming;

  const existingTs = Date.parse(existing.updatedAt ?? existing.createdAt ?? "");
  const incomingTs = Date.parse(incoming.updatedAt ?? incoming.createdAt ?? "");
  const preferIncoming = !Number.isFinite(existingTs) || (Number.isFinite(incomingTs) && incomingTs >= existingTs);

  const merged: ProjectRecord = {
    ...(preferIncoming ? existing : incoming),
    ...(preferIncoming ? incoming : existing),
    ebookJobState: pickValueByRecency(
      incoming.ebookJobState as ProjectRecord["ebookJobState"] | undefined,
      existing.ebookJobState as ProjectRecord["ebookJobState"] | undefined,
      (value) => (value && typeof value === "object" ? (value as Record<string, unknown>).chapters : undefined),
      preferIncoming,
    ),
    ebookManifest: pickValueByRecency(
      incoming.ebookManifest as ProjectRecord["ebookManifest"] | undefined,
      existing.ebookManifest as ProjectRecord["ebookManifest"] | undefined,
      (value) => (value && typeof value === "object" ? (value as Record<string, unknown>).chapters : undefined),
      preferIncoming,
    ),
    publishedSlug: incoming.publishedSlug ?? existing.publishedSlug,
    coverImageUrl: incoming.coverImageUrl ?? existing.coverImageUrl,
    authorImageUrl: incoming.authorImageUrl ?? existing.authorImageUrl,
  };

  const existingCreatedAt = existing.createdAt && Number.isFinite(Date.parse(existing.createdAt))
    ? new Date(existing.createdAt).toISOString()
    : incoming.createdAt;
  const incomingCreatedAt = incoming.createdAt && Number.isFinite(Date.parse(incoming.createdAt))
    ? new Date(incoming.createdAt).toISOString()
    : existingCreatedAt;
  merged.createdAt = existingCreatedAt <= incomingCreatedAt ? existingCreatedAt : incomingCreatedAt;

  return merged;
}

async function deleteR2Project(id: string) {
  const r2 = r2Ready();
  if (!r2) return false;

  await r2.s3.send(
    new DeleteObjectCommand({ Bucket: r2.bucket, Key: `projects/${id}.json` }),
  );
  return true;
}

// ── GET /api/projects — return all saved ProjectSnapshots from R2 ─────────────

export async function GET() {
  try {
    const [workspaceProjects, r2Projects] = await Promise.all([
      listWorkspaceProjects(),
      listR2Projects().catch((err) => {
        console.error("[api/projects] Failed to read R2 projects:", err);
        return [];
      }),
    ]);

    return NextResponse.json(
      { projects: mergeProjects([...workspaceProjects, ...r2Projects]) },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load projects";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── POST /api/projects — upsert a single ProjectSnapshot ─────────────────────

const UpsertSchema = z.object({
  project: z.object({ id: z.string().min(1) }).passthrough(),
});

export async function POST(req: NextRequest) {
  let input;
  try {
    input = UpsertSchema.parse(await req.json() as unknown);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  const incomingProject = normalizeProject(input.project);
  if (!incomingProject) {
    return NextResponse.json({ error: "Invalid project payload" }, { status: 400 });
  }

  try {
    const existingProject = mergeProjects((await Promise.all([
      readWorkspaceProject(incomingProject.id),
      readR2Project(incomingProject.id),
    ])).filter((project): project is ProjectRecord => Boolean(project)))[0] ?? null;
    const project = mergeProjectRecord(existingProject, incomingProject);

    await saveWorkspaceProject(project);

    let cloudSaved = false;
    try {
      cloudSaved = await saveR2Project(project);
    } catch (err) {
      console.error("[api/projects] Failed to save R2 project:", err);
    }

    return NextResponse.json({ ok: true, workspaceSaved: true, cloudSaved });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Save failed" },
      { status: 500 },
    );
  }
}

// ── DELETE /api/projects — remove a project from R2 ──────────────────────────

const DeleteSchema = z.object({ id: z.string().min(1) });

export async function DELETE(req: NextRequest) {
  let input;
  try {
    input = DeleteSchema.parse(await req.json() as unknown);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  try {
    await deleteWorkspaceProject(input.id);

    let cloudDeleted = false;
    try {
      cloudDeleted = await deleteR2Project(input.id);
    } catch (err) {
      console.error("[api/projects] Failed to delete R2 project:", err);
    }

    return NextResponse.json({ ok: true, workspaceDeleted: true, cloudDeleted });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete failed" },
      { status: 500 },
    );
  }
}
