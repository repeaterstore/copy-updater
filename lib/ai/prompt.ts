/**
 * Prompt construction for copy suggestions.
 */
import type { Block, PageMeta } from "@/lib/ops/types";
import type { AiMode } from "@/db/schema";

export type PromptShape = "optimize" | "directives";

export interface SuggestContext {
  pageUrl: string;
  pageName: string;
  brief: string | null;
  /** House style, chosen per request from the saved voices or typed by hand. */
  brandVoice?: string | null;
  mode: AiMode;
  shape: PromptShape;
  instructions: string | null;
  optionCount: number;
  meta: PageMeta;
  /** Blocks the model may change. */
  scope: Block[];
  /** Read-only surrounding copy, for tone and continuity. */
  context: Block[];
  /** Block id -> class names already on the page. */
  cssIndex: Record<string, string[]>;
  /** Section markup, layout mode only. */
  sectionHtml?: string | null;
  /** When set, this call produces one option from this specific angle. */
  angle?: string | null;
  /** Whether the model may search the web on this request. */
  webSearch?: boolean;
  /** What the scope represents, which changes what a good answer looks like. */
  scopeKind?: "block" | "section" | "page" | "meta";
  /** Heading the section sits under, when scopeKind is "section". */
  sectionLabel?: string | null;
}

const COPY_MODE_RULES = `
You may only emit these operations:
  setText  — replace a block's inner HTML (keep existing inline tags like <a>, <strong>, <em> where they still make sense)
  setMeta  — set the meta title / description / og:title / og:description
Do not add, remove, move or restyle anything.`;

const LAYOUT_MODE_RULES = `
You may emit any of these operations:
  setText         — replace a block's inner HTML
  setMeta         — set the meta title / description / og:title / og:description
  insert          — add new markup before/after a block, or as its first/last child
  remove          — delete a block
  move            — relocate a block
  replaceElement  — swap a whole element for new markup
  setAttr         — change an attribute (e.g. a CTA's href); pass null to remove it
  addStyle        — append CSS to the page

When you add markup, reuse the class names already present on the page (listed
under "existing classes") so new elements inherit the site's design. Only use
addStyle when no existing class does the job.`;

export function buildSystemPrompt(mode: AiMode): string {
  return `You are an expert conversion copywriter working on a live commercial web page.

You are given the page's current copy as a list of blocks. Each block has a stable id.
You return operations that transform the page, referencing blocks by their id.

${mode === "layout" ? LAYOUT_MODE_RULES : COPY_MODE_RULES}

Rules that always apply:
- Only reference ids that appear in the "editable blocks" list. Ids from the
  surrounding context are for understanding tone, not for editing.
- Preserve meaning and factual claims. Never invent product specs, prices,
  guarantees, statistics or compatibility claims that are not already present.
- Match the page's existing voice unless told otherwise.
- The character counts given for each block are guidance, not limits. Staying
  near the original length keeps the layout intact, but write longer when the
  content genuinely needs it and say so in your rationale.
- Each option must be a genuinely different approach, not a reworded version of
  the same idea. Give each a short label describing its angle.`;
}

function describeBlock(block: Block, classes: string[] | undefined): string {
  const parts = [
    `- id: ${block.id}`,
    `  role: ${block.role} (<${block.tag}>)`,
    block.sectionLabel ? `  section: ${block.sectionLabel}` : null,
    `  current (${block.text.length} chars): ${JSON.stringify(block.text)}`,
    block.html !== block.text ? `  html: ${JSON.stringify(block.html)}` : null,
    classes?.length ? `  existing classes: ${classes.join(" ")}` : null,
  ];
  return parts.filter(Boolean).join("\n");
}

export function buildUserPrompt(context: SuggestContext): string {
  const sections: string[] = [];

  sections.push(`PAGE: ${context.pageName}\nURL: ${context.pageUrl}`);

  // Voice before brief: the house style is the constant, and the brief may
  // sharpen it for this page. Stated in that order, a brief that says
  // "technical" reads as a narrowing of the voice rather than a contradiction.
  if (context.brandVoice) {
    sections.push(
      `BRAND VOICE — how we sound. This overrides the page's existing voice ` +
        `where they disagree:\n${context.brandVoice}`,
    );
  }

  if (context.brief) {
    sections.push(`BRIEF (this page's audience, goal, keywords):\n${context.brief}`);
  }

  sections.push(
    `CURRENT META:\n  title: ${JSON.stringify(context.meta.title)}\n` +
      `  description: ${JSON.stringify(context.meta.description)}`,
  );

  if (context.scopeKind === "meta") {
    // A meta-only request has no editable blocks at all; the fields above are
    // the whole canvas. Without saying so, the model casts about for blocks to
    // rewrite and comes back with out-of-scope setText ops that get discarded.
    sections.push(
      `This request covers ONLY the meta fields shown above. Emit only setMeta ` +
        `ops — title, description, og:title and og:description as appropriate. ` +
        `Do not emit setText or any structural operation.`,
    );
  } else {
    const scopeHeading =
      context.scopeKind === "section"
        ? `EDITABLE BLOCKS — one section${context.sectionLabel ? ` ("${context.sectionLabel}")` : ""}, ${context.scope.length} blocks, in the order they appear:`
        : `EDITABLE BLOCKS (${context.scope.length}) — you may only change these:`;

    sections.push(
      `${scopeHeading}\n` +
        context.scope
          .map((b) => describeBlock(b, context.cssIndex[b.id]))
          .join("\n"),
    );
  }

  if (context.scopeKind === "section" && context.scope.length > 1) {
    // Without this, a multi-block request comes back as N independent rewrites
    // that each sound fine alone and repeat each other when read down the page.
    sections.push(
      `These blocks are one section and a reader meets them in order. Rewrite them ` +
        `as a single connected piece, not as separate lines that happen to share a ` +
        `request:\n` +
        `- Keep the roles doing their jobs: a heading frames what follows, body copy ` +
        `delivers it, a list carries parallel items, a button names the action.\n` +
        `- Do not repeat the same phrase, claim or construction across blocks. If the ` +
        `heading says it, the paragraph beneath should not say it again.\n` +
        `- Vary sentence shape between adjacent blocks so the section does not read as ` +
        `a list of headlines.\n` +
        `- Leave a block unchanged rather than rewriting it for the sake of it. Returning ` +
        `fewer, better changes is a stronger answer than touching everything.\n` +
        `- Each option must be a coherent version of the whole section, not a menu of ` +
        `per-block alternatives.`,
    );
  }

  if (context.context.length) {
    const heading =
      context.scopeKind === "meta"
        ? `WHAT THE PAGE SAYS (read-only) — the copy the meta fields have to describe:`
        : `SURROUNDING COPY (read-only, for tone and continuity):`;
    sections.push(
      `${heading}\n` +
        context.context
          .map((b) => `- ${b.role}: ${JSON.stringify(b.text.slice(0, 180))}`)
          .join("\n"),
    );
  }

  if (context.sectionHtml) {
    sections.push(
      `SECTION MARKUP (so you can see the structure you are changing):\n\`\`\`html\n${context.sectionHtml.slice(0, 12_000)}\n\`\`\``,
    );
  }

  if (context.shape === "directives") {
    sections.push(
      `APPLY THESE SPECIFIC CHANGES:\n${context.instructions ?? "(none given)"}\n\n` +
        `Apply each one faithfully. Where a change makes neighbouring copy read ` +
        `awkwardly or become inconsistent, update that copy too so the page still ` +
        `hangs together — and mention what you adjusted in your rationale.`,
    );
  } else {
    const task =
      context.scopeKind === "meta"
        ? `TASK: Improve the meta title and description — clearer, more compelling ` +
          `in a search result or social share, faithful to what the page actually offers.`
        : `TASK: Improve this copy — clearer, more persuasive, better structured.`;
    sections.push(
      task + (context.instructions ? `\n\nAdditional direction: ${context.instructions}` : ""),
    );
  }

  if (context.webSearch) {
    sections.push(
      `You may search the web. Use it only to learn how this market talks — the ` +
        `words competitors and buyers use, the benefits they lead with, the objections ` +
        `they raise. Anything you find describes someone else's product. Do not carry ` +
        `a specification, price, compatibility claim or guarantee from a search result ` +
        `onto this page.`,
    );
  }

  if (context.angle) {
    sections.push(
      `ANGLE FOR THIS VERSION: ${context.angle}\n\n` +
        `Commit to it. A version that hedges between angles is worse than one that ` +
        `takes this one seriously. Return exactly one option.`,
    );
  } else {
    sections.push(
      `Return exactly ${context.optionCount} distinct option${context.optionCount === 1 ? "" : "s"}.`,
    );
  }

  return sections.join("\n\n");
}

/**
 * A readable sample of the whole page, for requests with no blocks in scope.
 *
 * A meta title and description have to describe what the page offers, and the
 * page is exactly what a meta-scoped request has none of — there is no scope to
 * take neighbours around. Sending all 200-odd blocks of a real marketing page
 * would be mostly navigation and footer, so this keeps the top of the page,
 * where the proposition lives, plus the headings that say what the rest covers.
 */
export function pageSummaryFor(all: Block[], limit = 40): Block[] {
  if (all.length <= limit) return all;

  const picked = new Set<number>();
  const lead = Math.round(limit / 2);
  for (let i = 0; i < lead && i < all.length; i += 1) picked.add(i);
  all.forEach((block, i) => {
    if (block.role === "heading") picked.add(i);
  });

  // Sorted before trimming, so what survives the cap is the top of the page
  // rather than whichever headings happened to be found last.
  return [...picked]
    .sort((a, b) => a - b)
    .slice(0, limit)
    .map((i) => all[i]);
}

/**
 * Blocks near the scope, used as read-only context.
 */
export function neighboursFor(
  all: Block[],
  scope: Block[],
  radius = 4,
): Block[] {
  if (scope.length === 0) return [];
  const scopeIds = new Set(scope.map((b) => b.id));
  const indices = all
    .map((b, i) => (scopeIds.has(b.id) ? i : -1))
    .filter((i) => i >= 0);
  const lo = Math.max(0, Math.min(...indices) - radius);
  const hi = Math.min(all.length, Math.max(...indices) + radius + 1);

  return all.slice(lo, hi).filter((b) => !scopeIds.has(b.id));
}
