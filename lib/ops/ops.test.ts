import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { applyOps, collectStyles } from "./apply";
import { buildCssIndex, extractBlocks, extractMeta, stampIds, structuralPath } from "./extract";
import { assignNewIds } from "./ids";
import { diffResolved } from "./diff";
import { sanitizeHtml, sanitizeCss } from "./sanitize";
import { resolveVersion, buildSkeleton } from "./resolve.server";
import { EXTRACTOR_VERSION, ID_ATTR, type Op, type Resolved } from "./types";

const PAGE = `<!doctype html>
<html><head>
  <title>Old Title</title>
  <meta name="description" content="Old description">
  <style>.btn { color: red }</style>
</head><body>
  <header class="site-head"><a class="logo" href="/">Acme</a></header>
  <main>
    <section class="hero">
      <h1 class="hero__title">Fast <em>signal</em> boosters</h1>
      <p class="hero__sub">Boost your signal with a <a href="/shop">booster</a>.</p>
      <a class="btn btn--primary" href="/buy">Buy now</a>
    </section>
    <section class="features">
      <h2>Why us</h2>
      <ul>
        <li>Free shipping</li>
        <li>2 year warranty</li>
      </ul>
      Loose text <span>with inline</span><div>and a nested block</div>
    </section>
  </main>
</body></html>`;

function domOf(html: string) {
  const dom = new JSDOM(html);
  return { dom, doc: dom.window.document };
}

function stamped() {
  const { dom, doc } = domOf(PAGE);
  stampIds(doc);
  return { dom, doc };
}

function resolvedOf(doc: Document): Resolved {
  return { blocks: extractBlocks(doc), meta: extractMeta(doc), styles: [] };
}

test("structural paths are deterministic and stable across parses", () => {
  const a = stamped();
  const b = stamped();
  const idsA = Array.from(a.doc.querySelectorAll("*")).map((e) => e.getAttribute(ID_ATTR));
  const idsB = Array.from(b.doc.querySelectorAll("*")).map((e) => e.getAttribute(ID_ATTR));
  assert.deepEqual(idsA, idsB);
  const h1 = a.doc.querySelector("h1")!;
  assert.equal(structuralPath(h1), "body/main:1/section:1/h1:1");
});

test("a paragraph containing a link stays one block", () => {
  const { doc } = stamped();
  const blocks = extractBlocks(doc);
  const sub = blocks.find((b) => b.text.startsWith("Boost your signal"));
  assert.ok(sub, "hero subtitle should be extracted");
  assert.equal(sub!.tag, "p");
  assert.match(sub!.html, /<a[^>]*>booster<\/a>/);
  // The inner <a> must not also surface as its own block.
  assert.equal(blocks.filter((b) => b.text === "booster").length, 0);
});

test("loose text in a mixed container becomes its own block", () => {
  const { doc } = stamped();
  const blocks = extractBlocks(doc);
  assert.ok(blocks.find((b) => b.text === "Loose text"), "loose text wrapped and extracted");
  assert.ok(blocks.find((b) => b.text === "with inline"));
  assert.ok(blocks.find((b) => b.text === "and a nested block"));
});

test("roles and section labels are assigned", () => {
  const { doc } = stamped();
  const blocks = extractBlocks(doc);
  const h1 = blocks.find((b) => b.tag === "h1")!;
  assert.equal(h1.role, "heading");
  const cta = blocks.find((b) => b.text === "Buy now")!;
  assert.equal(cta.role, "link");
  assert.equal(cta.sectionLabel, "Fast signal boosters");
  const warranty = blocks.find((b) => b.text === "2 year warranty")!;
  assert.equal(warranty.role, "listitem");
  assert.equal(warranty.sectionLabel, "Why us");

  // A heading names its own section rather than inheriting the previous one,
  // otherwise every section title is filed under the section before it.
  assert.equal(h1.sectionLabel, "Fast signal boosters");
  const h2 = blocks.find((b) => b.tag === "h2")!;
  assert.equal(h2.sectionLabel, "Why us");
});

test("setText and setMeta apply", () => {
  const { doc } = stamped();
  const h1 = doc.querySelector("h1")!.getAttribute(ID_ATTR)!;
  const result = applyOps(doc, [
    { t: "setText", id: h1, html: "Faster <em>signal</em> boosters" },
    { t: "setMeta", title: "New Title", description: "New description" },
  ]);
  assert.equal(result.failures.length, 0);
  assert.equal(doc.querySelector("h1")!.textContent, "Faster signal boosters");
  assert.equal(extractMeta(doc).title, "New Title");
  assert.equal(extractMeta(doc).description, "New description");
});

test("insert adds a bullet without disturbing existing ids", () => {
  const { doc } = stamped();
  const before = extractBlocks(doc);
  const lastLi = before.find((b) => b.text === "2 year warranty")!;
  const html = assignNewIds(doc, "<li>Free returns</li>");
  const result = applyOps(doc, [
    { t: "insert", refId: lastLi.id, pos: "after", html },
  ]);
  assert.equal(result.failures.length, 0);

  const after = extractBlocks(doc);
  assert.ok(after.find((b) => b.text === "Free returns"), "new bullet present");
  // Every pre-existing id must survive unchanged.
  for (const b of before) {
    assert.ok(after.find((x) => x.id === b.id), `id ${b.id} survived insert`);
  }
});

test("move reorders and remove deletes", () => {
  const { doc } = stamped();
  const blocks = extractBlocks(doc);
  const cta = blocks.find((b) => b.text === "Buy now")!;
  const h1 = blocks.find((b) => b.tag === "h1")!;
  const sub = blocks.find((b) => b.text.startsWith("Boost your"))!;

  const result = applyOps(doc, [
    { t: "move", id: cta.id, refId: h1.id, pos: "before" },
    { t: "remove", id: sub.id },
  ]);
  assert.equal(result.failures.length, 0);

  const after = extractBlocks(doc);
  assert.equal(after[after.findIndex((b) => b.id === cta.id) + 1].id, h1.id);
  assert.equal(after.find((b) => b.id === sub.id), undefined);
});

test("failures are reported, not swallowed", () => {
  const { doc } = stamped();
  const result = applyOps(doc, [
    { t: "setText", id: "body/nope:9", html: "x" },
    { t: "move", id: "body", refId: "body", pos: "after" },
  ]);
  assert.equal(result.applied, 0);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0].reason, /no element with id/);
});

test("setAttr cannot rewrite identity or attach handlers", () => {
  const { doc } = stamped();
  const cta = extractBlocks(doc).find((b) => b.text === "Buy now")!;
  const result = applyOps(doc, [
    { t: "setAttr", id: cta.id, name: ID_ATTR, value: "hijacked" },
    { t: "setAttr", id: cta.id, name: "onclick", value: "alert(1)" },
    { t: "setAttr", id: cta.id, name: "href", value: "/checkout" },
  ]);
  assert.equal(result.failures.length, 2);
  const el = doc.querySelector(`[${ID_ATTR}="${cta.id}"]`)!;
  assert.equal(el.getAttribute("href"), "/checkout");
  assert.equal(el.hasAttribute("onclick"), false);
});

test("sanitiser strips scripts and javascript: urls, keeps markup", () => {
  const { doc } = domOf("<html><body></body></html>");
  const dirty = `<p class="keep" style="color:red">Hi<script>alert(1)</script>
    <a href="javascript:alert(1)" onclick="x()">bad</a>
    <a href="/good">good</a><img src="data:image/png;base64,AAA"></p>`;
  const clean = sanitizeHtml(doc, dirty);
  assert.equal(clean.includes("<script"), false);
  assert.equal(clean.includes("onclick"), false);
  assert.equal(clean.includes("javascript:"), false);
  assert.match(clean, /class="keep"/);
  assert.match(clean, /style="color:red"/);
  assert.match(clean, /href="\/good"/);
  assert.match(clean, /src="data:image\/png/);
  assert.equal(sanitizeCss("@import url(x); a{color:red}").includes("@import"), false);
});

test("sanitiser strips editor state so it never reaches a saved version", () => {
  const { doc } = domOf("<html><body></body></html>");
  // What the inline editor actually reads off the live DOM: the preview runtime
  // has already stamped contenteditable and diff markers onto the nodes.
  const fromEditor =
    '<span class="keep" data-cu-id="body/h1:1/span:1" contenteditable="true" spellcheck="false">Fast</span>' +
    '<em data-cu-diff="changed" data-cu-selected="">signal</em>';
  const clean = sanitizeHtml(doc, fromEditor);

  assert.equal(clean.includes("contenteditable"), false);
  assert.equal(clean.includes("spellcheck"), false);
  assert.equal(clean.includes("data-cu-diff"), false);
  assert.equal(clean.includes("data-cu-selected"), false);
  // Real content and identity must survive.
  assert.match(clean, /class="keep"/);
  assert.match(clean, /data-cu-id="body\/h1:1\/span:1"/);
  assert.match(clean, /Fast/);
  assert.match(clean, /<em[^>]*>signal<\/em>/);
});

test("diff distinguishes changed, added, removed and moved", () => {
  const base = stamped();
  const beforeState = resolvedOf(base.doc);

  const work = stamped();
  const blocks = extractBlocks(work.doc);
  const h1 = blocks.find((b) => b.tag === "h1")!;
  const shipping = blocks.find((b) => b.text === "Free shipping")!;
  const cta = blocks.find((b) => b.text === "Buy now")!;
  const warranty = blocks.find((b) => b.text === "2 year warranty")!;

  applyOps(work.doc, [
    { t: "setText", id: h1.id, html: "Fast <em>signal</em> amplifiers" },
    { t: "remove", id: shipping.id },
    { t: "insert", refId: warranty.id, pos: "after", html: assignNewIds(work.doc, "<li>Free returns</li>") },
    { t: "move", id: cta.id, refId: h1.id, pos: "before" },
  ]);
  const afterState = resolvedOf(work.doc);

  const d = diffResolved(beforeState, afterState);
  assert.equal(d.counts.changed, 1);
  assert.equal(d.counts.removed, 1);
  assert.equal(d.counts.added, 1);
  assert.equal(d.counts.moved, 1);

  const changed = d.blocks.find((c) => c.kind === "changed")!;
  assert.equal(changed.id, h1.id);
  const addedWords = changed.words!.filter((w) => w.added).map((w) => w.value).join("");
  assert.match(addedWords, /amplifiers/);

  const moved = d.blocks.find((c) => c.kind === "moved")!;
  assert.equal(moved.id, cta.id);
});

test("diff reports meta changes and layout risk", () => {
  const a = stamped();
  const before = resolvedOf(a.doc);
  const b = stamped();
  const h1 = extractBlocks(b.doc).find((x) => x.tag === "h1")!;
  applyOps(b.doc, [
    { t: "setMeta", title: "A much longer and more descriptive title" },
    { t: "setText", id: h1.id, html: "The fastest signal boosters money can buy anywhere today" },
  ]);
  const after = resolvedOf(b.doc);

  const d = diffResolved(before, after);
  assert.equal(d.meta.length, 1);
  assert.equal(d.meta[0].field, "title");
  assert.ok(d.layoutRisk.includes(h1.id), "long h1 flagged for layout check");
});

test("skeleton preserves structure and ids while dropping weight", () => {
  const heavy = PAGE.replace(
    "<body>",
    `<body><img src="data:image/png;base64,${"A".repeat(50000)}">`,
  ).replace(".btn { color: red }", `.btn{color:red}${"/*pad*/".repeat(20000)}`);
  const { doc } = domOf(heavy);
  stampIds(doc);
  const full = doc.documentElement.outerHTML;

  const skeleton = buildSkeleton(full);
  assert.ok(skeleton.length < full.length / 10, "skeleton is far smaller");

  const fromFull = resolvedOf(domOf(full).doc);
  const fromSkeleton = resolvedOf(domOf(skeleton).doc);
  assert.deepEqual(
    fromSkeleton.blocks.map((b) => [b.id, b.text]),
    fromFull.blocks.map((b) => [b.id, b.text]),
    "skeleton yields identical blocks to the full snapshot",
  );
});

test("resolveVersion replays ops deterministically", () => {
  const { doc } = stamped();
  const skeleton = buildSkeleton(doc.documentElement.outerHTML);
  const h1 = extractBlocks(doc).find((b) => b.tag === "h1")!;
  const ops: Op[] = [
    { t: "setText", id: h1.id, html: "Rewritten" },
    { t: "addStyle", css: ".hero__title{font-size:3rem}" },
  ];

  const first = resolveVersion(skeleton, ops);
  const second = resolveVersion(skeleton, ops);
  assert.equal(first.failures.length, 0);
  assert.deepEqual(first.resolved.blocks, second.resolved.blocks);
  assert.equal(first.resolved.blocks.find((b) => b.id === h1.id)!.text, "Rewritten");
  assert.deepEqual(first.resolved.styles, [".hero__title{font-size:3rem}"]);
  assert.equal(collectStyles(ops).length, 1);
});

test("css index surfaces existing class names per block", () => {
  const { doc } = stamped();
  const blocks = extractBlocks(doc);
  const index = buildCssIndex(doc, blocks);
  const h1 = blocks.find((b) => b.tag === "h1")!;
  assert.ok(index[h1.id].includes("hero__title"));
  assert.ok(index[h1.id].includes("hero"), "ancestor classes included");
});

test("markup copied with an existing id is re-stamped, not left to collide", () => {
  const { doc } = stamped();
  const existing = extractBlocks(doc)[0];

  // What a model does when it writes new markup after being shown the page's
  // own stamped html: it copies an id along with the tag.
  const html = assignNewIds(doc, `<p data-cu-id="${existing.id}">A new promise</p>`);
  assert.ok(!html.includes(existing.id), `the copied id was kept: ${html}`);
  assert.match(html, /data-cu-id="new:/);

  // A replacement may keep the id of the thing it replaces — that one is its own.
  const kept = assignNewIds(doc, `<p data-cu-id="${existing.id}">Reworded</p>`, existing.id);
  assert.ok(kept.includes(existing.id), "the replaced element keeps its identity");
});

test("a picture pasted into a placeholder stays a block", () => {
  const { doc } = domOf(
    `<!doctype html><html><body><section><h2>Gallery</h2><p>PHOTO GOES HERE</p></section></body></html>`,
  );
  stampIds(doc);
  const gap = extractBlocks(doc).find((b) => b.text === "PHOTO GOES HERE")!;

  // Exactly what the inspector's paste writes into the block.
  const html =
    '<img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==" alt="" ' +
    'style="display:block;max-width:100%;height:auto" />';
  const result = applyOps(doc, [{ t: "setText", id: gap.id, html }]);
  assert.equal(result.failures.length, 0);

  const after = extractBlocks(doc);
  const still = after.find((b) => b.id === gap.id);
  // Without this the element has no text, stops being a block, and the picture
  // becomes something on the page that nothing in the outline can reach.
  assert.ok(still, `the image block disappeared; blocks are ${after.map((b) => b.id).join(", ")}`);
  assert.match(still.html, /data:image\/jpeg/);
});

test("a picture is a block, carries its alt text, and can be re-alt-ed", () => {
  const { doc } = domOf(
    `<!doctype html><html><body><section><h2>Gallery</h2>
      <div><img src="/hero.jpg" alt="A rooftop antenna"></div>
    </section></body></html>`,
  );
  stampIds(doc);
  const blocks = extractBlocks(doc);
  const image = blocks.find((b) => b.role === "image");
  assert.ok(image, `no image block; got roles ${blocks.map((b) => b.role).join(", ")}`);
  assert.equal(image.alt, "A rooftop antenna");
  assert.equal(image.tag, "img");

  // Alt text is the one piece of wording a picture carries, so it is editable.
  const result = applyOps(doc, [
    { t: "setAttr", id: image.id, name: "alt", value: "A DAS antenna on a rooftop" },
  ]);
  assert.equal(result.failures.length, 0);
  assert.equal(extractBlocks(doc).find((b) => b.id === image.id)?.alt, "A DAS antenna on a rooftop");
});

test("duplicating a block inserts a real copy that keeps its wording", () => {
  const { doc } = domOf(
    `<!doctype html><html><body><section class="faq">
      <div class="faq__item"><h3>Does it work?</h3><p>Yes, it does.</p></div>
    </section></body></html>`,
  );
  stampIds(doc);
  const before = extractBlocks(doc);
  const item = doc.querySelector(".faq__item")!;
  const anchorId = item.getAttribute("data-cu-id")!;

  // What the preview hands back: the real subtree with the tool's own
  // attributes stripped, then stamped with fresh ids by the caller.
  const source = item.outerHTML.replace(/ data-cu-id="[^"]*"/g, "");
  const html = assignNewIds(doc, sanitizeHtml(doc, source));
  const result = applyOps(doc, [{ t: "insert", refId: anchorId, pos: "after", html }]);
  assert.equal(result.failures.length, 0);

  const after = extractBlocks(doc);
  assert.equal(after.length, before.length * 2, "every block of the item was copied");
  // The wording comes with it — an empty shell is a puzzle, a copy is a start.
  assert.equal(after.filter((b) => b.text === "Does it work?").length, 2);
  // And the copy answers to its own ids, not the original's.
  assert.equal(new Set(after.map((b) => b.id)).size, after.length, "ids are unique");
  // Classes survive, which is the entire reason for copying off the page.
  assert.equal(doc.querySelectorAll(".faq__item").length, 2);
});

test("reordering swaps two blocks and survives a replay", () => {
  const { doc } = domOf(
    `<!doctype html><html><body><ul>
      <li>First</li><li>Second</li><li>Third</li>
    </ul></body></html>`,
  );
  stampIds(doc);
  const [first, second] = extractBlocks(doc);
  const ops: Op[] = [{ t: "move", id: second.id, refId: first.id, pos: "before" }];
  assert.equal(applyOps(doc, ops).failures.length, 0);
  assert.deepEqual(extractBlocks(doc).map((b) => b.text), ["Second", "First", "Third"]);
});

test("resolved output is stamped, so a stale cache can be spotted and rebuilt", () => {
  const { doc } = stamped();
  const skeleton = buildSkeleton(doc.documentElement.outerHTML);
  const { resolved } = resolveVersion(skeleton, []);
  assert.equal(resolved.v, EXTRACTOR_VERSION);

  // What a row saved by an older build looks like, and how it is recognised.
  const legacy = { blocks: [], meta: resolved.meta, styles: [] };
  assert.ok(((legacy as { v?: number }).v ?? 0) < EXTRACTOR_VERSION, "stale rows are detectable");
});
