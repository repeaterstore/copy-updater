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
  /**
   * This request adds a section rather than rewriting one.
   *
   * The block it goes after, and the label of the section it follows. Scope,
   * neighbours and section markup all still describe the *existing* copy — the
   * point of showing it is that the new section has to look like it belongs
   * beside it.
   */
  addAfterBlockId?: string | null;
  /** Whether the model may search the web on this request. */
  webSearch?: boolean;
  /** A crop of the page as captured, sent as the first image. */
  hasPageImage?: boolean;
  /** A picture of the section someone wants, sent as the last image. */
  hasReferenceImage?: boolean;
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
addStyle when no existing class does the job.

Structure is part of the answer here, not a last resort. Listing the operations
is not the same as asking for them, and a request that comes back as nothing but
setText has ignored what this mode is for. Before rewriting a line, ask whether
the section would work better with the order changed, a paragraph split into
points a reader can scan, a missing step added, or a line that repeats its
neighbour removed.

Do not invent structural churn to look busy. If the copy genuinely is all that
should change, say so in the rationale — that is a real answer. But "I only
rewrote the words" should be a conclusion you reached, not the default.`;

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
      context.addAfterBlockId
        ? `SECTION MARKUP — the section your new one will sit next to. Copy its ` +
          `nesting and its class names so what you add looks like part of the ` +
          `same page:\n\`\`\`html\n${context.sectionHtml.slice(0, 12_000)}\n\`\`\``
        : `SECTION MARKUP (so you can see the structure you are changing):\n\`\`\`html\n${context.sectionHtml.slice(0, 12_000)}\n\`\`\``,
    );
  }

  /*
   * Adding is a different job from rewriting, and the difference has to be
   * stated or the model does the job it has always been asked to do.
   *
   * Everything else in this prompt describes copy that already exists, and
   * left to itself a model reads that as an invitation to improve it. The one
   * op asked for here is an insert; touching the surrounding copy is not a
   * bonus, it is a change nobody asked for arriving inside one they did.
   */
  if (context.addAfterBlockId) {
    sections.push(
      `THE TASK: add one new section to this page, immediately after the block ` +
        `with id "${context.addAfterBlockId}".\n` +
        `Return exactly one op per option. Every field of the op schema must be ` +
        `present, with "" where it does not apply — note the key is "t", not ` +
        `"op":\n` +
        `{"t":"insert","id":"","html":"<the new section>","title":"",` +
        `"description":"","refId":"${context.addAfterBlockId}","pos":"after",` +
        `"name":"","value":"","css":""}\n` +
        `No setText, no changes of any kind to copy that is already there.\n` +
        `The html must be a complete section — a real container with real ` +
        `content inside it, written the way the markup above is written. Use ` +
        `that section's own class names. Do not invent a design system, and do ` +
        `not emit a bare tag with no classes on a page that plainly uses them.\n` +
        `Every line of copy goes in its own element, so each one can be edited, ` +
        `diffed and commented on afterwards.\n` +
        `Write real copy for this page and this business. Placeholder wording — ` +
        `"Section heading", "Lorem ipsum", "Your text here" — is not an answer.`,
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

  /*
   * Only described when a reference image is attached.
   *
   * The page crop has always been sent without comment and models handle it
   * fine, so saying nothing is the established behaviour for an ordinary
   * request and this must not change it. Two unlabelled images is a different
   * matter: nothing in the payload says which is which, so the order has to be
   * stated, and it has to match the order buildMessages actually sends.
   */
  if (context.hasReferenceImage) {
    sections.push(
      (context.hasPageImage
        ? `TWO IMAGES ARE ATTACHED. The first is the page as it stands today. ` +
          `The second is a reference: a picture of a section someone wants added.`
        : `ONE IMAGE IS ATTACHED. It is a reference: a picture of a section ` +
          `someone wants added.`) +
        `\n\nThis request is a transcription, not an optimisation. Everything ` +
        `else in this prompt asks you to improve copy; for the reference ` +
        `section, do not. Reproduce its wording exactly as it appears, ` +
        `punctuation and capitalisation included. Keep every product name, ` +
        `technology name and figure you can read — "Peplink", "SpeedFusion", ` +
        `"$100/mo" — verbatim. The brand voice above does not override this: ` +
        `these are someone's approved words, already signed off, and rewriting ` +
        `them is the one thing this request is not asking for.\n` +
        `The exception is text that is obviously a stand-in: lorem ipsum, ` +
        `"Your headline here", another company's name where this page's belongs.\n\n` +
        `The reference is a brief, not an asset. Do not describe it, do not ` +
        `reproduce it as an image, and do not position text over it. Write the ` +
        `section as real markup using an insert op, with every line of text as ` +
        `its own element so it can be edited on its own afterwards. Reproduce ` +
        `the structure you can see, including buttons, links and small print.\n\n` +
        `STYLING. Prefer the page's own class names, listed under "existing ` +
        `classes", so the section looks native. Where the reference shows ` +
        `something the page has no class for — a dark card, a coloured button, ` +
        `an icon row — write the CSS with an addStyle op and reference it with ` +
        `your own class names. The general advice above to avoid addStyle does ` +
        `not apply here: reproducing a design the page does not already have is ` +
        `precisely the case it exists for, and a section that arrives as ` +
        `unstyled text has not reproduced anything.\n\n` +
        `PICTURES. You cannot recreate a photograph, and dropping it silently ` +
        `loses the fact that the section needs one. Leave a gap instead: an ` +
        `empty div, styled with a dashed border and roughly the proportions the ` +
        `image occupies in the reference, containing one line naming what ` +
        `belongs there — for example "Product photo: two routers, landscape". ` +
        `Someone pastes the real image into that gap afterwards, so it must be ` +
        `visible, obviously a placeholder, and hold the space the picture will ` +
        `take.`,
    );
  }

  if (context.optionCount === 1) {
    sections.push(`Return exactly one option.`);
  } else {
    /*
     * Asking for N options and leaving it there returns N phrasings of one
     * idea: the model settles on an approach in its first sentence and spends
     * the rest of the call rewording it. Naming the levers it can pull — and
     * saying plainly that interchangeable options do not count — is what makes
     * the difference between three options and one option written three times.
     *
     * The levers are named, the choices are not. Prescribing the actual angles
     * is what the old hard-coded list did, and it produced copy that read like
     * it was answering a brief rather than selling the page.
     */
    sections.push(
      `Return exactly ${context.optionCount} options, and make them genuinely ` +
        `different attempts rather than one idea reworded.\n` +
        `Change the approach between them, not just the wording. Things worth ` +
        `varying: what the opening leads with; whether it leads with the ` +
        `benefit, the problem, the proof or the offer; how specific versus how ` +
        `broad; which objection it answers; how long it is; how much it assumes ` +
        `the reader already knows.\n` +
        `Two options a reader could swap without noticing are one option. If ` +
        `you find yourself writing a third that is close to the first, take a ` +
        `real risk with it instead — a version worth rejecting is more useful ` +
        `than a safe near-duplicate.`,
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

