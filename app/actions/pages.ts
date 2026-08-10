"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { startCapture } from "@/lib/capture/jobs";
import { requireUser } from "@/lib/session";

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("Enter a URL.");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http and https URLs can be captured.");
  }
  return parsed.href;
}

function defaultName(url: string): string {
  const parsed = new URL(url);
  const segment = parsed.pathname.split("/").filter(Boolean).pop();
  if (!segment) return parsed.hostname;
  return segment.replace(/[-_]+/g, " ").replace(/\.[a-z]+$/i, "");
}

export async function createPageAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  const url = normalizeUrl(String(formData.get("url") ?? ""));
  const name = String(formData.get("name") ?? "").trim() || defaultName(url);
  const brief = String(formData.get("brief") ?? "").trim() || null;

  const [page] = await db
    .insert(schema.pages)
    .values({ url, name, brief, createdBy: user.id })
    .returning();

  const [snapshot] = await db
    .insert(schema.snapshots)
    .values({ pageId: page.id, status: "pending" })
    .returning();

  startCapture(snapshot.id, url);

  revalidatePath("/");
  redirect(`/pages/${page.id}`);
}

export async function recaptureAction(pageId: string): Promise<void> {
  await requireUser();

  const page = await db.query.pages.findFirst({
    where: eq(schema.pages.id, pageId),
  });
  if (!page) throw new Error("Page not found.");

  const [snapshot] = await db
    .insert(schema.snapshots)
    .values({ pageId: page.id, status: "pending" })
    .returning();

  startCapture(snapshot.id, page.url);
  revalidatePath(`/pages/${pageId}`);
}

export async function updatePageBriefAction(
  pageId: string,
  brief: string,
): Promise<void> {
  await requireUser();
  await db
    .update(schema.pages)
    .set({ brief: brief.trim() || null })
    .where(eq(schema.pages.id, pageId));
  revalidatePath(`/pages/${pageId}`);
}
