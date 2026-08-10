/**
 * Capture job runner.
 *
 * A capture takes 30–60s, so it runs detached from the request that started it
 * and reports progress through the `snapshots` row, which the UI polls. Railway
 * runs a long-lived container, so an in-process job needs no queue
 * infrastructure — but it also means a deploy mid-capture leaves a row stuck in
 * "pending", which `reapStaleCaptures` cleans up.
 */
import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import { snapshotPaths, writeDataFile } from "@/lib/storage";
import { capturePage, type CaptureStage } from "./capture";

/** A capture exceeding this is assumed dead (process restarted mid-run). */
const STALE_AFTER_MS = 10 * 60 * 1000;

const running = new Set<string>();

export function isCaptureRunning(snapshotId: string): boolean {
  return running.has(snapshotId);
}

/**
 * Kick off a capture. Returns immediately; progress lands in the snapshot row.
 */
export function startCapture(snapshotId: string, url: string): void {
  if (running.has(snapshotId)) return;
  running.add(snapshotId);

  void runCapture(snapshotId, url).finally(() => running.delete(snapshotId));
}

async function runCapture(snapshotId: string, url: string): Promise<void> {
  const stages: CaptureStage[] = [];
  try {
    const result = await capturePage({
      url,
      onProgress: (stage) => stages.push(stage),
    });

    const htmlPath = snapshotPaths.html(snapshotId);
    const skeletonPath = snapshotPaths.skeleton(snapshotId);
    const screenshotPath = snapshotPaths.screenshot(snapshotId);

    await Promise.all([
      writeDataFile(htmlPath, result.html),
      writeDataFile(skeletonPath, result.skeleton),
      writeDataFile(screenshotPath, result.screenshot),
    ]);

    await db
      .update(schema.snapshots)
      .set({
        status: "ready",
        htmlPath,
        skeletonPath,
        screenshotPath,
        blocks: result.extraction.blocks,
        meta: result.extraction.meta,
        cssIndex: result.extraction.cssIndex,
        error: null,
      })
      .where(eq(schema.snapshots.id, snapshotId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(schema.snapshots)
      .set({
        status: "failed",
        error: `${message}${stages.length ? ` (reached: ${stages.at(-1)})` : ""}`,
      })
      .where(eq(schema.snapshots.id, snapshotId));
  }
}

/**
 * Fail any capture that has been pending long enough to be dead. Called when
 * reading snapshot status so a restarted process never shows a permanent
 * spinner.
 */
export async function reapStaleCaptures(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  await db
    .update(schema.snapshots)
    .set({
      status: "failed",
      error: "Capture did not finish. The server may have restarted; try again.",
    })
    .where(
      and(
        eq(schema.snapshots.status, "pending"),
        lt(schema.snapshots.capturedAt, cutoff),
      ),
    );
}
