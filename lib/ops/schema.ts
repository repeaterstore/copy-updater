/**
 * Runtime validation for ops.
 *
 * Kept apart from `types.ts` so browser bundles (the capture stamper and the
 * preview runtime, both injected into every snapshot) never pull zod in. Only
 * server code — AI responses, API payloads — needs to validate.
 *
 * The `satisfies` assertion at the bottom fails the build if these schemas ever
 * drift from the canonical types.
 */
import { z } from "zod";
import type { Op, OpType } from "./types";

export const InsertPositionSchema = z.enum([
  "before",
  "after",
  "firstChild",
  "lastChild",
]);

export const SetTextOpSchema = z.object({
  t: z.literal("setText"),
  id: z.string().min(1),
  html: z.string(),
});

export const SetMetaOpSchema = z.object({
  t: z.literal("setMeta"),
  title: z.string().nullish(),
  description: z.string().nullish(),
  ogTitle: z.string().nullish(),
  ogDescription: z.string().nullish(),
});

export const InsertOpSchema = z.object({
  t: z.literal("insert"),
  refId: z.string().min(1),
  pos: InsertPositionSchema,
  html: z.string(),
});

export const RemoveOpSchema = z.object({
  t: z.literal("remove"),
  id: z.string().min(1),
});

export const MoveOpSchema = z.object({
  t: z.literal("move"),
  id: z.string().min(1),
  refId: z.string().min(1),
  pos: InsertPositionSchema,
});

export const ReplaceElementOpSchema = z.object({
  t: z.literal("replaceElement"),
  id: z.string().min(1),
  html: z.string(),
});

export const SetAttrOpSchema = z.object({
  t: z.literal("setAttr"),
  id: z.string().min(1),
  name: z.string().min(1),
  value: z.string().nullable(),
});

export const AddStyleOpSchema = z.object({
  t: z.literal("addStyle"),
  css: z.string(),
});

export const OpSchema = z.discriminatedUnion("t", [
  SetTextOpSchema,
  SetMetaOpSchema,
  InsertOpSchema,
  RemoveOpSchema,
  MoveOpSchema,
  ReplaceElementOpSchema,
  SetAttrOpSchema,
  AddStyleOpSchema,
]);

export const OpListSchema = z.array(OpSchema);

/** Schemas for the subset of ops a given AI mode may emit. */
export const OP_SCHEMA_BY_TYPE = {
  setText: SetTextOpSchema,
  setMeta: SetMetaOpSchema,
  insert: InsertOpSchema,
  remove: RemoveOpSchema,
  move: MoveOpSchema,
  replaceElement: ReplaceElementOpSchema,
  setAttr: SetAttrOpSchema,
  addStyle: AddStyleOpSchema,
} satisfies Record<OpType, z.ZodType>;

// Fails to compile if the schemas and the canonical types diverge.
type SchemaOp = z.infer<typeof OpSchema>;
const _opConformance: SchemaOp extends Op ? true : never = true;
const _opCoverage: Op["t"] extends SchemaOp["t"] ? true : never = true;
void _opConformance;
void _opCoverage;
