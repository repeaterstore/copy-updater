import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Block, Op, PageMeta, Resolved } from "@/lib/ops/types";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    url: text("url").notNull(),
    name: text("name").notNull(),
    /** Brand voice, target keywords, audience notes. Fed to AI as context. */
    brief: text("brief"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pages_created_at_idx").on(t.createdAt)],
);

export const snapshotStatus = ["pending", "ready", "failed"] as const;
export type SnapshotStatus = (typeof snapshotStatus)[number];

export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    status: text("status").$type<SnapshotStatus>().notNull().default("pending"),
    /** Populated when status is "failed". */
    error: text("error"),
    viewportWidth: integer("viewport_width").notNull().default(1440),
    viewportHeight: integer("viewport_height").notNull().default(900),
    /** Paths under DATA_DIR, not URLs. */
    htmlPath: text("html_path"),
    skeletonPath: text("skeleton_path"),
    screenshotPath: text("screenshot_path"),
    blocks: jsonb("blocks").$type<Block[]>().notNull().default([]),
    meta: jsonb("meta").$type<PageMeta>(),
    /** Block id -> class names in play, so AI reuses the site's own classes. */
    cssIndex: jsonb("css_index").$type<Record<string, string[]>>().notNull().default({}),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("snapshots_page_idx").on(t.pageId, t.capturedAt)],
);

export const versionStatus = ["draft", "proposed", "approved", "rejected"] as const;
export type VersionStatus = (typeof versionStatus)[number];

export const versions = pgTable(
  "versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    /** Null for the baseline version. Versions form a tree, not a line. */
    parentVersionId: uuid("parent_version_id").references(
      (): any => versions.id,
      { onDelete: "set null" },
    ),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    label: text("label").notNull(),
    status: text("status").$type<VersionStatus>().notNull().default("draft"),
    /** Authored source of truth. */
    ops: jsonb("ops").$type<Op[]>().notNull().default([]),
    /** Derived cache, rebuilt from ops on every save. Drives diff and export. */
    resolved: jsonb("resolved").$type<Resolved>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("versions_page_idx").on(t.pageId, t.createdAt),
    index("versions_parent_idx").on(t.parentVersionId),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    /** Null for a comment on the meta fields (inspector with nothing selected). */
    blockId: text("block_id"),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comments_version_idx").on(t.versionId)],
);

export const reasoningLevels = ["low", "medium", "high"] as const;
export type ReasoningLevel = (typeof reasoningLevels)[number];

/**
 * Single row of AI configuration, shared by the team.
 *
 * Everything routes through OpenRouter, so there is one key and one model list
 * rather than a provider per vendor. OpenRouter also normalises reasoning and
 * web search across model families, which is what removed the per-provider
 * capability probing this table used to carry.
 */
export const settings = pgTable("settings", {
  id: text("id").primaryKey().default("singleton"),
  /** AES-256-GCM ciphertext. Never leaves the server. */
  openrouterKeyEncrypted: text("openrouter_key_encrypted"),
  /** Model ids offered in the suggest panel, e.g. "anthropic/claude-opus-4.5". */
  models: jsonb("models").$type<string[]>().notNull().default([]),
  defaultModel: text("default_model"),
  /** Tried in order if the chosen model is unavailable. */
  fallbackModels: jsonb("fallback_models").$type<string[]>().notNull().default([]),
  reasoningLevel: text("reasoning_level").$type<ReasoningLevel>().notNull().default("medium"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiModes = ["copy", "layout"] as const;
export type AiMode = (typeof aiModes)[number];

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    mode: text("mode").$type<AiMode>().notNull().default("copy"),
    /** "optimize" or "directives". */
    shape: text("shape").notNull().default("optimize"),
    reasoningLevel: text("reasoning_level").$type<ReasoningLevel>(),
    /** Whether the request was allowed to search the web. */
    webSearch: boolean("web_search").notNull().default(false),
    /** Whether each option came from its own call with an assigned angle. */
    distinctOptions: boolean("distinct_options").notNull().default(false),
    /** Which blocks were in scope. */
    scope: jsonb("scope").$type<{ kind: string; blockIds: string[] }>(),
    instructions: text("instructions"),
    options: jsonb("options").$type<
      { label: string; rationale: string; ops: Op[] }[]
    >().notNull().default([]),
    chosenOption: integer("chosen_option"),
    error: text("error"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_runs_version_idx").on(t.versionId, t.createdAt)],
);
