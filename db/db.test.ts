/**
 * Integration test for the schema, run against PGlite — a real Postgres engine
 * compiled to WASM, so migrations, jsonb round-trips, cascades and self-
 * references behave exactly as they will on Railway Postgres.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import type { Op, Resolved } from "@/lib/ops/types";

async function freshDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return { db, client };
}

test("migrations apply and every table exists", async () => {
  const { db, client } = await freshDb();
  const result = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  const names = result.rows.map((r) => r.table_name).sort();
  for (const expected of [
    "ai_runs", "brand_voices", "comments", "pages", "settings", "snapshots",
    "users", "versions",
  ]) {
    assert.ok(names.includes(expected), `table ${expected} exists`);
  }
  await client.close();
  void db;
});

test("a version tree round-trips with typed jsonb intact", async () => {
  const { db, client } = await freshDb();

  const [user] = await db
    .insert(schema.users)
    .values({ email: "copy@waveform.com", name: "Copywriter" })
    .returning();

  const [page] = await db
    .insert(schema.pages)
    .values({
      url: "https://example.com/product",
      name: "Product page",
      brief: "Confident, plain language. Target: signal booster buyers.",
      createdBy: user.id,
    })
    .returning();

  const [snapshot] = await db
    .insert(schema.snapshots)
    .values({
      pageId: page.id,
      status: "ready",
      htmlPath: "snapshots/a.html",
      skeletonPath: "snapshots/a.skeleton.html",
      screenshotPath: "snapshots/a.png",
      blocks: [
        {
          id: "body/main:1/h1:1", tag: "h1", role: "heading",
          html: "Old", text: "Old", order: 0, sectionLabel: null,
          classes: ["hero__title"], box: { x: 0, y: 0, w: 800, h: 60 },
        },
      ],
      meta: {
        title: "Old Title", description: "Old desc",
        ogTitle: null, ogDescription: null, canonical: null,
      },
      cssIndex: { "body/main:1/h1:1": ["hero__title", "hero"] },
    })
    .returning();

  const ops: Op[] = [
    { t: "setText", id: "body/main:1/h1:1", html: "New headline" },
    { t: "addStyle", css: ".hero__title{font-size:3rem}" },
  ];
  const resolved: Resolved = {
    blocks: [
      {
        id: "body/main:1/h1:1", tag: "h1", role: "heading",
        html: "New headline", text: "New headline", order: 0,
        sectionLabel: null, classes: ["hero__title"], box: null,
      },
    ],
    meta: {
      title: "Old Title", description: "Old desc",
      ogTitle: null, ogDescription: null, canonical: null,
    },
    styles: [".hero__title{font-size:3rem}"],
  };

  const [v1] = await db
    .insert(schema.versions)
    .values({
      pageId: page.id, snapshotId: snapshot.id, authorId: user.id,
      label: "Copy pass", status: "proposed", ops, resolved,
    })
    .returning();

  // Fork: a child pointing at v1, which is what "compare any two" relies on.
  const [v2] = await db
    .insert(schema.versions)
    .values({
      pageId: page.id, snapshotId: snapshot.id, parentVersionId: v1.id,
      authorId: user.id, label: "Sina review", status: "draft",
      ops: [...ops, { t: "setMeta", title: "Newer Title" }],
    })
    .returning();

  const reloaded = await db.query.versions.findFirst({ where: eq(schema.versions.id, v1.id) });
  assert.equal(reloaded?.ops.length, 2);
  assert.equal(reloaded?.ops[0].t, "setText");
  assert.equal(reloaded?.resolved?.blocks[0].text, "New headline");
  assert.deepEqual(reloaded?.resolved?.styles, [".hero__title{font-size:3rem}"]);

  const child = await db.query.versions.findFirst({ where: eq(schema.versions.id, v2.id) });
  assert.equal(child?.parentVersionId, v1.id);
  assert.equal(child?.ops.length, 3);

  // Snapshot blocks keep their nested shape.
  const snap = await db.query.snapshots.findFirst({ where: eq(schema.snapshots.id, snapshot.id) });
  assert.equal(snap?.blocks[0].box?.w, 800);
  assert.deepEqual(snap?.cssIndex["body/main:1/h1:1"], ["hero__title", "hero"]);

  await client.close();
});

test("deleting a page cascades to snapshots, versions and comments", async () => {
  const { db, client } = await freshDb();

  const [user] = await db.insert(schema.users)
    .values({ email: "sina@rsrf.com" }).returning();
  const [page] = await db.insert(schema.pages)
    .values({ url: "https://example.com", name: "Home", createdBy: user.id }).returning();
  const [snapshot] = await db.insert(schema.snapshots)
    .values({ pageId: page.id, status: "ready" }).returning();
  const [version] = await db.insert(schema.versions)
    .values({ pageId: page.id, snapshotId: snapshot.id, label: "v1" }).returning();
  await db.insert(schema.comments)
    .values({ versionId: version.id, authorId: user.id, body: "Tighten this", blockId: "body/h1:1" });

  await db.delete(schema.pages).where(eq(schema.pages.id, page.id));

  assert.equal((await db.select().from(schema.snapshots)).length, 0);
  assert.equal((await db.select().from(schema.versions)).length, 0);
  assert.equal((await db.select().from(schema.comments)).length, 0);
  // The user survives; only their authorship link is severed.
  assert.equal((await db.select().from(schema.users)).length, 1);

  await client.close();
});

test("email uniqueness is enforced", async () => {
  const { db, client } = await freshDb();
  await db.insert(schema.users).values({ email: "dup@waveform.com" });
  // Drizzle wraps driver errors, so assert on the cause rather than the message.
  await assert.rejects(
    () => db.insert(schema.users).values({ email: "dup@waveform.com" }),
    (error: unknown) => {
      const cause = (error as { cause?: { message?: string } }).cause;
      assert.match(String(cause?.message ?? error), /duplicate key|unique/i);
      return true;
    },
  );
  assert.equal((await db.select().from(schema.users)).length, 1);
  await client.close();
});

test("home listing counts versions and reports the latest snapshot status", async () => {
  const { db, client } = await freshDb();
  const { listPagesWithStats } = await import("../lib/pages");

  const [user] = await db.insert(schema.users)
    .values({ email: "sina@rsrf.com" }).returning();
  const [withVersions] = await db.insert(schema.pages)
    .values({ url: "https://example.com/a", name: "A", createdBy: user.id }).returning();
  const [empty] = await db.insert(schema.pages)
    .values({ url: "https://example.com/b", name: "B", createdBy: user.id }).returning();

  const [snapshot] = await db.insert(schema.snapshots)
    .values({ pageId: withVersions.id, status: "ready" }).returning();
  for (const label of ["v1", "v2", "v3"]) {
    await db.insert(schema.versions)
      .values({ pageId: withVersions.id, snapshotId: snapshot.id, label });
  }
  // An older failed capture followed by a ready one: the latest wins.
  await db.insert(schema.snapshots)
    .values({ pageId: empty.id, status: "failed", capturedAt: new Date("2026-01-01") });
  await db.insert(schema.snapshots)
    .values({ pageId: empty.id, status: "pending", capturedAt: new Date("2026-02-01") });

  const rows = await listPagesWithStats(db);
  const a = rows.find((r) => r.id === withVersions.id);
  const b = rows.find((r) => r.id === empty.id);

  assert.equal(a?.versionCount, 3);
  assert.equal(a?.snapshotStatus, "ready");
  assert.equal(b?.versionCount, 0);
  assert.equal(b?.snapshotStatus, "pending");

  await client.close();
});

test("only one brand voice can be the default", async () => {
  const { db, client } = await freshDb();

  await db.insert(schema.brandVoices).values({
    name: "House", body: "Plain and specific.", isDefault: true,
  });
  await db.insert(schema.brandVoices).values({
    name: "Support", body: "Warmer, more patient.", isDefault: false,
  });

  // The guard is the partial unique index, not the action that sets it — a
  // second default has to be impossible even if some code path forgets to
  // clear the first.
  await assert.rejects(
    () => db.insert(schema.brandVoices).values({
      name: "Campaign", body: "Punchy.", isDefault: true,
    }),
    (error: unknown) => {
      const cause = (error as { cause?: { message?: string } }).cause;
      assert.match(String(cause?.message ?? error), /duplicate key|unique/i);
      return true;
    },
  );

  // Any number of non-defaults is fine, which the index must not prevent.
  await db.insert(schema.brandVoices).values({
    name: "Technical", body: "Specs first.", isDefault: false,
  });
  const rows = await db.select().from(schema.brandVoices);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.isDefault).length, 1);

  await client.close();
});
