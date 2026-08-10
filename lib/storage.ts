/**
 * Snapshot file storage on the Railway volume mounted at DATA_DIR.
 *
 * Paths stored in Postgres are always relative to DATA_DIR so the volume can be
 * remounted or swapped for object storage without a migration.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

function root(): string {
  return path.resolve(env.dataDir);
}

/** Resolve a stored relative path, refusing anything that escapes DATA_DIR. */
export function resolveDataPath(relativePath: string): string {
  const base = root();
  const full = path.resolve(base, relativePath);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`Refusing to access path outside DATA_DIR: ${relativePath}`);
  }
  return full;
}

export async function writeDataFile(
  relativePath: string,
  contents: string | Buffer,
): Promise<string> {
  const full = resolveDataPath(relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
  return relativePath;
}

export async function readDataFile(relativePath: string): Promise<Buffer> {
  return readFile(resolveDataPath(relativePath));
}

export async function readDataText(relativePath: string): Promise<string> {
  return readFile(resolveDataPath(relativePath), "utf8");
}

export function streamDataFile(relativePath: string) {
  return createReadStream(resolveDataPath(relativePath));
}

export async function dataFileSize(relativePath: string): Promise<number> {
  const info = await stat(resolveDataPath(relativePath));
  return info.size;
}

export async function deleteDataFile(relativePath: string): Promise<void> {
  try {
    await unlink(resolveDataPath(relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export const snapshotPaths = {
  html: (snapshotId: string) => `snapshots/${snapshotId}/page.html`,
  skeleton: (snapshotId: string) => `snapshots/${snapshotId}/skeleton.html`,
  screenshot: (snapshotId: string) => `snapshots/${snapshotId}/page.png`,
};
