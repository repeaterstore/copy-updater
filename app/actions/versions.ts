"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { OpListSchema } from "@/lib/ops/schema";
import type { Op } from "@/lib/ops/types";
import type { VersionStatus } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { latestReadySnapshot, setVersionOps } from "@/lib/versions";

export async function createVersionAction(input: {
  pageId: string;
  parentVersionId: string | null;
  label: string;
  /** Seed the fork with in-progress edits instead of the parent's saved ops. */
  ops?: unknown;
}): Promise<{ id: string }> {
  const user = await requireUser();

  const snapshot = await latestReadySnapshot(input.pageId);
  if (!snapshot) throw new Error("This page has no completed capture yet.");

  // A fork starts from its parent's ops so the reviewer begins from what they
  // were looking at, not from the untouched page.
  let ops: Op[] = [];
  if (input.ops !== undefined) {
    // Forking mid-edit: the work in progress moves to the new version so the
    // original is left exactly as its author had it.
    const parsed = OpListSchema.safeParse(input.ops);
    if (!parsed.success) throw new Error("Those edits could not be carried over.");
    ops = parsed.data;
  } else if (input.parentVersionId) {
    const parent = await db.query.versions.findFirst({
      where: eq(schema.versions.id, input.parentVersionId),
    });
    if (!parent) throw new Error("Parent version not found.");
    ops = parent.ops;
  }

  const [version] = await db
    .insert(schema.versions)
    .values({
      pageId: input.pageId,
      snapshotId: snapshot.id,
      parentVersionId: input.parentVersionId,
      authorId: user.id,
      label: input.label.trim() || "Untitled version",
      status: "draft",
      ops,
    })
    .returning();

  await setVersionOps(version.id, ops);
  revalidatePath(`/pages/${input.pageId}`);
  return { id: version.id };
}

export async function saveOpsAction(
  versionId: string,
  ops: unknown,
): Promise<{ failures: { reason: string }[] }> {
  await requireUser();

  const parsed = OpListSchema.safeParse(ops);
  if (!parsed.success) {
    throw new Error(`Invalid operations: ${parsed.error.issues[0]?.message}`);
  }

  const version = await db.query.versions.findFirst({
    where: eq(schema.versions.id, versionId),
  });
  if (!version) throw new Error("Version not found.");
  if (version.status === "approved") {
    throw new Error("This version is approved and can no longer be edited. Fork it instead.");
  }

  const { failures } = await setVersionOps(versionId, parsed.data);
  revalidatePath(`/pages/${version.pageId}`);
  return { failures: failures.map((f) => ({ reason: f.reason })) };
}

export async function setVersionStatusAction(
  versionId: string,
  status: VersionStatus,
): Promise<void> {
  await requireUser();

  const version = await db.query.versions.findFirst({
    where: eq(schema.versions.id, versionId),
  });
  if (!version) throw new Error("Version not found.");

  await db
    .update(schema.versions)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.versions.id, versionId));
  revalidatePath(`/pages/${version.pageId}`);
}

export async function renameVersionAction(
  versionId: string,
  label: string,
): Promise<void> {
  await requireUser();
  const [version] = await db
    .update(schema.versions)
    .set({ label: label.trim() || "Untitled version", updatedAt: new Date() })
    .where(eq(schema.versions.id, versionId))
    .returning({ pageId: schema.versions.pageId });

  if (version) revalidatePath(`/pages/${version.pageId}`);
}

export async function deleteVersionAction(versionId: string): Promise<void> {
  await requireUser();

  const version = await db.query.versions.findFirst({
    where: eq(schema.versions.id, versionId),
  });
  if (!version) throw new Error("Version not found.");

  // Comments and AI runs cascade. Children keep their own full op list (a
  // fork copies its parent's ops at creation), so losing the parent only
  // re-bases their diff onto the live page — their content is untouched.
  await db.delete(schema.versions).where(eq(schema.versions.id, versionId));
  revalidatePath(`/pages/${version.pageId}`);
}

export async function addCommentAction(input: {
  versionId: string;
  blockId: string | null;
  body: string;
}): Promise<void> {
  const user = await requireUser();
  const body = input.body.trim();
  if (body === "") return;

  await db.insert(schema.comments).values({
    versionId: input.versionId,
    blockId: input.blockId,
    authorId: user.id,
    body,
  });

  const version = await db.query.versions.findFirst({
    where: eq(schema.versions.id, input.versionId),
  });
  if (version) revalidatePath(`/pages/${version.pageId}`);
}

export async function resolveCommentAction(
  commentId: string,
  resolved: boolean,
): Promise<void> {
  await requireUser();
  await db
    .update(schema.comments)
    .set({ resolved })
    .where(eq(schema.comments.id, commentId));
}
