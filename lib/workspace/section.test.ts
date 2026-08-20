import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractBlocks, stampIds } from "@/lib/ops/extract";
import { boundingBoxFor } from "@/lib/ai/crop";
import {
  MAX_SCOPE_BLOCKS,
  deriveBlocks,
  type DerivedBlock,
  groupIntoSections,
  isVisible,
  sectionBlocks,
  sectionScopeFor,
  structuralHighlights,
} from "./derive";
import type { Block, Op } from "@/lib/ops/types";

const PAGE = `<!doctype html><html><body>
  <nav><div><a href="/a">Menu one</a></div><div><a href="/b">Menu two</a></div></nav>
  <section>
    <h2>Why choose us</h2>
    <p>Boost your signal anywhere.</p>
    <ul><li>Free shipping</li><li>Two year warranty</li></ul>
  </section>
  <section>
    <h2>What you get</h2>
    <p>Everything in the box.</p>
  </section>
</body></html>`;

function blocksOf(html = PAGE): Block[] {
  const doc = new JSDOM(html).window.document;
  stampIds(doc);
  return extractBlocks(doc);
}

/** jsdom has no layout, so boxes are attached explicitly where they matter. */
function withBoxes(blocks: Block[], visible: (b: Block) => boolean): Block[] {
  return blocks.map((b, i) => ({
    ...b,
    box: visible(b) ? { x: 0, y: i * 40, w: 600, h: 30 } : { x: 0, y: 0, w: 0, h: 0 },
  }));
}

test("section scope covers the whole section containing the block", () => {
  const derived = deriveBlocks(withBoxes(blocksOf(), () => true), []);
  const warranty = derived.find((d) => d.text === "Two year warranty")!;

  const scope = sectionScopeFor(derived, warranty.block.id)!;
  assert.equal(scope.label, "Why choose us");
  assert.equal(scope.trimmed, 0);

  const texts = derived
    .filter((d) => scope.blockIds.includes(d.block.id))
    .map((d) => d.text);
  assert.deepEqual(texts, [
    "Why choose us",
    "Boost your signal anywhere.",
    "Free shipping",
    "Two year warranty",
  ]);
  // The neighbouring section must not bleed in.
  assert.equal(texts.includes("What you get"), false);
});

test("a heading selects its own section, not the previous one", () => {
  const derived = deriveBlocks(withBoxes(blocksOf(), () => true), []);
  const heading = derived.find((d) => d.text === "What you get")!;
  const scope = sectionScopeFor(derived, heading.block.id)!;
  assert.equal(scope.label, "What you get");
  assert.ok(scope.blockIds.length >= 2);
});

test("hidden blocks are excluded — nav chrome must not become the section", () => {
  const blocks = blocksOf();
  // Mimic a collapsed menu: the pre-heading run measures 0x0.
  const derived = deriveBlocks(
    withBoxes(blocks, (b) => !b.text.startsWith("Menu")),
    [],
  );
  const menu = derived.find((d) => d.text === "Menu one")!;
  const scope = sectionScopeFor(derived, menu.block.id)!;

  // Every block in that run is hidden, so the fallback keeps them rather than
  // returning an empty scope.
  assert.ok(scope.blockIds.length > 0);

  const visibleSection = sectionScopeFor(
    derived,
    derived.find((d) => d.text === "Free shipping")!.block.id,
  )!;
  const included = derived.filter((d) => visibleSection.blockIds.includes(d.block.id));
  assert.equal(
    included.some((d) => d.text.startsWith("Menu")),
    false,
    "nav never leaks into a content section",
  );
});

test("oversized sections are trimmed and report how much was dropped", () => {
  const items = Array.from({ length: 90 }, (_, i) => `<li>Item ${i}</li>`).join("");
  const derived = deriveBlocks(
    withBoxes(blocksOf(`<!doctype html><html><body><h2>Big grid</h2><ul>${items}</ul></body></html>`), () => true),
    [],
  );
  const scope = sectionScopeFor(derived, derived[1].block.id)!;

  assert.equal(scope.blockIds.length, MAX_SCOPE_BLOCKS);
  assert.equal(scope.trimmed, 91 - MAX_SCOPE_BLOCKS);
});

test("sections keep unique keys when headings repeat", () => {
  const repeated = `<!doctype html><html><body>
    <h3>QuadPro</h3><p>First mention.</p>
    <h3>Other</h3><p>Middle.</p>
    <h3>QuadPro</h3><p>Second mention.</p>
  </body></html>`;
  const sections = groupIntoSections(deriveBlocks(blocksOf(repeated), []));
  const labels = sections.map((s) => s.label);
  const ids = sections.map((s) => s.id);

  assert.equal(labels.filter((l) => l === "QuadPro").length, 2);
  assert.equal(new Set(ids).size, ids.length, "ids stay unique despite repeated labels");
});

test("crop box spans the scope and ignores unmeasured blocks", () => {
  const blocks: Block[] = [
    { ...blocksOf()[0], box: { x: 100, y: 500, w: 200, h: 40 } },
    { ...blocksOf()[1], box: { x: 150, y: 560, w: 400, h: 60 } },
    { ...blocksOf()[2], box: null },
    { ...blocksOf()[3], box: { x: 0, y: 0, w: 0, h: 0 } },
  ];

  const box = boundingBoxFor(blocks)!;
  assert.deepEqual(box, { left: 100, top: 500, width: 450, height: 120 });
  assert.equal(boundingBoxFor([{ ...blocks[2] }]), null);
});


test("no measured region means no screenshot at all", async () => {
  const { cropToBlocks } = await import("@/lib/ai/crop");
  const hidden: Block[] = blocksOf()
    .slice(0, 2)
    .map((b) => ({ ...b, box: { x: 0, y: 0, w: 0, h: 0 } }));

  // A 1x1 PNG stands in for the page image; the point is the null, not the pixels.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  assert.equal(
    await cropToBlocks(png, hidden),
    null,
    "collapsed-menu blocks send no picture rather than the whole page",
  );
});

/**
 * The shape that broke the old grouping: a mega-menu holding headings of its
 * own, and page bands that carry no heading element at all.
 */
const MEGA_MENU_PAGE = `<!doctype html><html><body>
  <div id="menu">
    <a href="/a">Products</a>
    <h3>Medium-Sized Buildings</h3><a href="/m">Medium plans</a>
    <h3>Large Buildings &amp; Campuses</h3><a href="/l">Large plans</a>
  </div>
  <section id="hero"><div>Turn-Key DAS Solutions</div><p>Designed and installed.</p></section>
  <div id="proof"><div>Real buildings. Real results.</div><p>Ten thousand sites.</p></div>
</body></html>`;

/** Only the menu is collapsed; the page bands are on screen. */
function megaMenuBlocks(): DerivedBlock[] {
  const blocks = blocksOf(MEGA_MENU_PAGE);
  return deriveBlocks(
    withBoxes(blocks, (b) => !b.id.includes("div:1/")),
    [],
  );
}

test("a hidden mega-menu stays in one group, headings and all", () => {
  const sections = groupIntoSections(megaMenuBlocks());

  const nav = sections.find((s) => s.chrome === "nav")!;
  assert.ok(nav, "the collapsed menu is recognised as furniture");
  const navText = nav.blocks.map((d) => d.text);
  assert.ok(navText.includes("Medium-Sized Buildings"));
  assert.ok(navText.includes("Large Buildings & Campuses"));

  // The regression: a heading inside the menu used to end the nav group, so the
  // rest of the menu was listed as page sections below it.
  const labels = sections.map((s) => s.label);
  assert.equal(labels.includes("Medium-Sized Buildings"), false);
  assert.equal(labels.includes("Large Buildings & Campuses"), false);
});

test("bands without a heading are named from their opening line", () => {
  const labels = groupIntoSections(megaMenuBlocks()).map((s) => s.label);
  // Neither band has a heading element — the old code had nothing to call them
  // but the nearest preceding heading, which was a dropdown link.
  assert.ok(labels.includes("Turn-Key DAS Solutions"));
  assert.ok(labels.includes("Real buildings. Real results."));
});

test("page copy is never filed under a hidden menu item", () => {
  const derived = megaMenuBlocks();
  const body = derived.find((d) => d.text === "Designed and installed.")!;
  const scope = sectionScopeFor(derived, body.block.id)!;

  assert.equal(scope.label, "Turn-Key DAS Solutions");
  const texts = derived
    .filter((d) => scope.blockIds.includes(d.block.id))
    .map((d) => d.text);
  assert.equal(texts.some((t) => t.includes("Buildings")), false);
});

test("subheadings nest under their band instead of ending it", () => {
  const page = `<!doctype html><html><body>
    <section><h2>Coverage</h2><p>Intro line.</p>
      <h3>Small sites</h3><p>Up to 5,000 sq ft.</p>
      <h3>Campuses</h3><p>Multi-building.</p>
    </section>
  </body></html>`;
  const derived = deriveBlocks(withBoxes(blocksOf(page), () => true), []);
  const sections = groupIntoSections(derived);

  assert.equal(sections.length, 1, "one band, not three siblings");
  const band = sections[0];
  assert.equal(band.label, "Coverage");
  assert.deepEqual(band.children.map((c) => c.label), ["Small sites", "Campuses"]);
  // The parent keeps its own copy rather than being truncated at the first h3.
  assert.deepEqual(band.blocks.map((d) => d.text), ["Coverage", "Intro line."]);

  // A subsection scopes to itself, and says where it sits.
  const small = derived.find((d) => d.text === "Up to 5,000 sq ft.")!;
  const scope = sectionScopeFor(derived, small.block.id)!;
  assert.equal(scope.label, "Coverage › Small sites");
  assert.equal(scope.blockIds.length, 2);

  // Selecting the band itself takes its subsections with it. Scoping to the
  // parent's own two lines and dropping the subsections rewrote a fraction of
  // what the outline says the section contains.
  const parent = sectionScopeFor(derived, band.blocks[0].block.id)!;
  assert.equal(parent.label, "Coverage");
  const texts = derived
    .filter((d) => parent.blockIds.includes(d.block.id))
    .map((d) => d.text);
  assert.deepEqual(texts, [
    "Coverage",
    "Intro line.",
    "Small sites",
    "Up to 5,000 sq ft.",
    "Campuses",
    "Multi-building.",
  ]);
});

test("a long list is not carved into one group per row", () => {
  const items = Array.from({ length: 90 }, (_, i) => `<li>Item ${i}</li>`).join("");
  const derived = deriveBlocks(
    withBoxes(blocksOf(`<!doctype html><html><body><h2>Big grid</h2><ul>${items}</ul></body></html>`), () => true),
    [],
  );
  const sections = groupIntoSections(derived);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].label, "Big grid");
});

test("grouping survives degenerate input", () => {
  assert.deepEqual(groupIntoSections([]), []);

  const one = deriveBlocks(
    withBoxes(blocksOf(`<!doctype html><html><body><p>Alone.</p></body></html>`), () => true),
    [],
  );
  const sections = groupIntoSections(one);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].label, "Alone.");
  assert.equal(sections[0].blocks.length, 1);
});

test("blocks inserted by an op join the band they sit in", () => {
  const page = `<!doctype html><html><body>
    <section><h2>Warranty</h2><ul><li>Two years</li></ul></section>
  </body></html>`;
  const blocks = withBoxes(blocksOf(page), () => true);
  // What an insert op produces: no structural path, so no container to group by.
  const inserted: Block[] = [
    { ...blocks[blocks.length - 1], id: "new:aaaaaa", html: "Free returns", text: "Free returns" },
    { ...blocks[blocks.length - 1], id: "new:bbbbbb", html: "Free shipping", text: "Free shipping" },
  ];
  const derived = deriveBlocks([...blocks, ...inserted], []);
  const sections = groupIntoSections(derived);

  // One band, not one per inserted bullet.
  assert.equal(sections.length, 1);
  const texts = sectionBlocks(sections[0]).map((d) => d.text);
  assert.ok(texts.includes("Free returns"));
  assert.ok(texts.includes("Free shipping"));
});

test("a band whose heading follows an eyebrow is not named twice", () => {
  const page = `<!doctype html><html><body>
    <section><p>WHY WAVEFORM</p><h2>Coverage that holds</h2><p>Body copy.</p></section>
  </body></html>`;
  const derived = deriveBlocks(withBoxes(blocksOf(page), () => true), []);
  const sections = groupIntoSections(derived);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].label, "Coverage that holds");
  // The heading names the band; it must not then open a child repeating it.
  assert.deepEqual(sections[0].children, []);
});

test("furniture detection needs the hidden blocks, so grouping comes before filtering", () => {
  const derived = megaMenuBlocks();

  const grouped = groupIntoSections(derived);
  assert.ok(grouped.some((s) => s.chrome === "nav"), "the menu is furniture");

  // The outline hides collapsed-menu rows by default. Doing that before
  // grouping is the trap: the menu arrives as only its always-visible items,
  // scores as fully visible, and comes through as a page section. On
  // waveform.com that turned a 224-block menu into a band called "Antennas &
  // Routers" and left "Navigation & header" with the four blocks that happen
  // to sit in a literal <header>.
  const visibleFirst = groupIntoSections(derived.filter((d) => isVisible(d.block)));
  assert.equal(
    visibleFirst.some((s) => s.chrome === "nav"),
    false,
    "filtering first loses the evidence — OutlinePane must group the full list",
  );
});

test("an inserted block is listed next to what it was inserted against", () => {
  const page = `<!doctype html><html><body>
    <section><h2>Warranty</h2><ul><li>Two years</li></ul></section>
  </body></html>`;
  const blocks = withBoxes(blocksOf(page), () => true);
  const anchor = blocks.find((b) => b.text === "Two years")!;
  // What an insert op looks like once created: ids minted into the markup.
  const ops: Op[] = [
    { t: "insert", refId: anchor.id, pos: "after", html: '<li data-cu-id="new:aaaaaa">Free returns</li>' },
  ];

  const derived = deriveBlocks(blocks, ops);
  const texts = derived.map((d) => d.text);
  // On the page but missing from the outline was the bug: the preview applies
  // insert ops, the derived list was built from the baseline alone.
  assert.deepEqual(texts, ["Warranty", "Two years", "Free returns"]);

  const inserted = derived.find((d) => d.text === "Free returns")!;
  assert.equal(inserted.block.id, "new:aaaaaa");
  assert.equal(inserted.changed, false, "added, not edited — nothing to word-diff against");
});

test("structural highlights come from the ops, without resolving anything", () => {
  const ops: Op[] = [
    { t: "insert", refId: "body/ul:1/li:1", pos: "after", html: '<li data-cu-id="new:bbbbbb">Added</li>' },
    { t: "move", id: "body/p:2", refId: "body/p:1", pos: "before" },
    { t: "remove", id: "body/p:3" },
    { t: "setText", id: "body/h1:1", html: "Edited" },
  ];

  const { added, moved } = structuralHighlights(ops);
  assert.deepEqual(added, ["new:bbbbbb"]);
  assert.deepEqual(moved, ["body/p:2"]);
  // Removals are not in there on purpose: the element is gone from the page,
  // so the preview has nothing left to paint.
});

test("a block inserted before a section's first block joins that section", () => {
  const page = `<!doctype html><html><body>
    <section><h2>Warranty</h2><p>Two years, parts and labour.</p></section>
    <section><h2>Shipping</h2><p>Free over fifty pounds.</p></section>
  </body></html>`;
  const blocks = withBoxes(blocksOf(page), () => true);
  // The heading that opens the second section — the anchor a "before" insert
  // would name to put a kicker above it.
  const secondHeading = blocks.find((b) => b.text === "Shipping");
  assert.ok(secondHeading, "the fixture has a second section");

  const ops: Op[] = [
    {
      t: "insert",
      refId: secondHeading.id,
      pos: "before",
      html: '<p data-cu-id="new:kicker">Delivery, in short</p>',
    },
  ];
  const sections = groupIntoSections(deriveBlocks(blocks, ops));

  const owner = sections.find((s) =>
    sectionBlocks(s).some((d) => d.text === "Delivery, in short"),
  );
  assert.ok(owner, "the inserted block is in some section");
  // It reads above "Shipping", so that is where a reviewer will look for it —
  // not filed under the warranty section that happens to precede it.
  const texts = sectionBlocks(owner).map((d) => d.text);
  assert.ok(texts.includes("Shipping"), `grouped with its anchor, got ${texts.join(" | ")}`);
  assert.ok(!texts.includes("Two years, parts and labour."), "not the previous section");
});

test("a page wrapped in one div still splits into bands", () => {
  // How a React site renders: header, every section and the footer are
  // siblings under a single application wrapper, so at the top level there is
  // one container holding the entire page.
  const sections = Array.from({ length: 24 }, (_, i) =>
    `<section><h2>Section ${i + 1}</h2><p>Body copy for section ${i + 1}.</p>` +
    `<p>A second paragraph for section ${i + 1}.</p></section>`,
  ).join("");
  const page = `<!doctype html><html><body><div id="app">
    <header><nav><a href="/a">About</a><a href="/b">Process</a></nav></header>
    ${sections}
    <footer><p>Company details in the footer.</p></footer>
  </div></body></html>`;

  const grouped = groupIntoSections(deriveBlocks(withBoxes(blocksOf(page), () => true), []));

  // The whole page as one band named after the navigation is the failure this
  // guards: its first block is a nav link, but 2 blocks of 45 are not chrome.
  assert.ok(grouped.length > 3, `expected real bands, got ${grouped.length}`);
  assert.ok(
    !grouped.some((s) => s.chrome === "nav" && sectionBlocks(s).length > 20),
    "the navigation band swallowed the page",
  );
  const labels = grouped.map((s) => s.label);
  assert.ok(labels.includes("Section 7"), `expected middle sections as bands, got ${labels.join(" | ")}`);
});

test("an added section is one row per element, and typing edits only that element", () => {
  // derive.ts parses an inserted fragment with DOMParser, which the browser has
  // and node does not. jsdom supplies the same implementation the server uses.
  const parserWindow = new JSDOM("").window;
  const had = "DOMParser" in globalThis;
  if (!had) (globalThis as { DOMParser?: unknown }).DOMParser = parserWindow.DOMParser;

  try {
    const page = `<!doctype html><html><body><main>
      <section><h2>What you get</h2><p>Everything in the box.</p></section>
    </main></body></html>`;
    const blocks = withBoxes(blocksOf(page), () => true);
    const anchor = blocks[blocks.length - 1];

    // What addSection builds: a template, stamped with ids at op-creation time.
    const html =
      '<section data-cu-id="new:sec"><h2 data-cu-id="new:head">Section heading</h2>' +
      '<p data-cu-id="new:body">The opening paragraph of this section.</p></section>';
    const insert: Op = { t: "insert", refId: anchor.id, pos: "after", html };

    const rows = deriveBlocks(blocks, [insert]);
    const added = rows.filter((d) => d.block.id.startsWith("new:"));
    assert.deepEqual(
      added.map((d) => d.block.id),
      ["new:head", "new:body"],
      "the heading and the paragraph are separate rows, and the wrapper is not one",
    );
    assert.equal(added[0].block.tag, "h2");
    assert.equal(added[0].html, "Section heading");

    // Typing into the heading edits the heading, and the paragraph is untouched.
    const typed: Op[] = [insert, { t: "setText", id: "new:head", html: "Our guarantee" }];
    const after = deriveBlocks(blocks, typed).filter((d) => d.block.id.startsWith("new:"));
    assert.equal(after.find((d) => d.block.id === "new:head")?.text, "Our guarantee");
    assert.equal(
      after.find((d) => d.block.id === "new:body")?.text,
      "The opening paragraph of this section.",
    );
  } finally {
    if (!had) delete (globalThis as { DOMParser?: unknown }).DOMParser;
    parserWindow.close();
  }
});

test("a restyled block counts as a change even though its wording is untouched", () => {
  const page = `<!doctype html><html><body><main>
    <section><h2>Offer</h2><a class="btn" href="/buy">Get My DAS Plan</a></section>
  </main></body></html>`;
  const blocks = withBoxes(blocksOf(page), () => true);
  const button = blocks.find((b) => b.text === "Get My DAS Plan")!;

  // Recolouring a button, or restricting it to one device, is a setAttr: the
  // copy is identical, so a text diff sees nothing at all.
  const ops: Op[] = [{ t: "setAttr", id: button.id, name: "class", value: "btn btn--red" }];
  const derived = deriveBlocks(blocks, ops);
  const row = derived.find((d) => d.block.id === button.id)!;

  assert.equal(row.changed, false, "the wording really is unchanged");
  assert.equal(row.restyled, true, "but the block is not untouched");

  const highlights = structuralHighlights(ops);
  assert.deepEqual(highlights.restyled, [button.id], "and the page says so too");
});

test("a removed block stays listed so it can be seen and put back", () => {
  const page = `<!doctype html><html><body><main>
    <section><h2>Offer</h2><p>Old promise we no longer make.</p></section>
  </main></body></html>`;
  const blocks = withBoxes(blocksOf(page), () => true);
  const doomed = blocks.find((b) => b.text === "Old promise we no longer make.")!;

  const derived = deriveBlocks(blocks, [{ t: "remove", id: doomed.id }]);
  const row = derived.find((d) => d.block.id === doomed.id);
  assert.ok(row, "still in the outline rather than silently gone");
  assert.equal(row.removed, true);

  // And it is not offered to the model as copy to rewrite.
  const scope = sectionScopeFor(derived, blocks[0].id);
  assert.ok(!scope?.blockIds.includes(doomed.id), "kept out of AI scope");
});

test("a card grid becomes one group per card, and a bullet list does not", () => {
  // Cards titled with <p>, not <h3> — the shape that used to arrive as one
  // flat run, because heading-based subsections have nothing to work with.
  const cards = Array.from({ length: 5 }, (_, i) =>
    `<div class="card"><p class="t">Card ${i + 1}</p><p>Body copy for card ${i + 1}.</p></div>`,
  ).join("");
  const bullets = Array.from({ length: 12 }, (_, i) => `<li>Point ${i + 1}.</li>`).join("");
  // Enough of a page that it splits into bands at all; below the threshold the
  // whole document is one band and the sections never separate.
  const filler = Array.from({ length: 70 }, (_, i) => `<p>Filler paragraph ${i + 1}.</p>`).join("");

  const page = `<!doctype html><html><body><main>
    <section><h2>Our solutions</h2><div class="grid">${cards}</div></section>
    <section><h2>What you get</h2><ul>${bullets}</ul></section>
    <section>${filler}</section>
  </main></body></html>`;

  const grouped = groupIntoSections(deriveBlocks(withBoxes(blocksOf(page), () => true), []));

  const solutions = grouped.find((s) => s.label === "Our solutions");
  assert.ok(solutions, `no solutions band; got ${grouped.map((s) => s.label).join(" | ")}`);
  // Five cards, each its own group named by its title — not ten rows in a row
  // with nothing saying which body belongs to which title.
  assert.equal(solutions.children.length, 5, "one group per card");
  assert.deepEqual(
    solutions.children.map((c) => c.label),
    ["Card 1", "Card 2", "Card 3", "Card 4", "Card 5"],
  );
  assert.ok(solutions.children.every((c) => c.blocks.length === 2));

  // The list is left alone: one group per bullet is the block list with extra
  // headers, which is worse than the flat run it would replace.
  const list = grouped.find((s) => s.label === "What you get");
  assert.ok(list, "found the list section");
  assert.equal(list.children.length, 0, "a bullet list is not a grid");
});

test("grouping never lists a block twice or drops one", () => {
  const cards = Array.from({ length: 4 }, (_, i) =>
    `<div><h3>Item ${i + 1}</h3><p>Detail ${i + 1}.</p><a href="/x">More</a></div>`,
  ).join("");
  const page = `<!doctype html><html><body><main>
    <section><h2>Heading</h2><p>Intro line.</p><div class="grid">${cards}</div></section>
  </main></body></html>`;

  const derived = deriveBlocks(withBoxes(blocksOf(page), () => true), []);
  const listed = groupIntoSections(derived).flatMap((s) => sectionBlocks(s).map((d) => d.block.id));

  assert.equal(new Set(listed).size, listed.length, "no block is listed twice");
  assert.equal(new Set(listed).size, derived.length, "no block is dropped");
});

test("hiding part of a sentence counts as a change to the block", () => {
  const page = `<!doctype html><html><body><main>
    <section><h2>Coverage</h2><p>Cover every inch of your warehouse.</p></section>
  </main></body></html>`;
  const blocks = withBoxes(blocksOf(page), () => true);
  const para = blocks.find((b) => b.text.startsWith("Cover every"))!;

  // What the editor writes when words are tagged "desktop only": the wording is
  // untouched, so a text diff sees nothing and the block read as unedited —
  // no dot, nothing in the section count, and no revert control.
  const tagged =
    'Cover every inch of <span class="hidden md:inline">your warehouse</span>.';
  const derived = deriveBlocks(blocks, [{ t: "setText", id: para.id, html: tagged }]);
  const row = derived.find((d) => d.block.id === para.id)!;

  assert.equal(row.text, "Cover every inch of your warehouse.", "the wording is the same");
  assert.equal(row.changed, false, "and so it is not a reword");
  assert.equal(row.restyled, true, "but it is still a change, and says so");
});

test("a parse round trip is still not a change", () => {
  // The reason the text comparison exists: an op's html and the server's
  // re-serialised copy differ in whitespace while describing the same content,
  // and a forked version must not open showing every inherited edit as new.
  const page = `<!doctype html><html><body><main>
    <section><p>Boost your <b>signal</b> today.</p></section>
  </main></body></html>`;
  const blocks = withBoxes(blocksOf(page), () => true);
  const para = blocks.find((b) => b.text.startsWith("Boost"))!;

  // Indentation and spacing around attributes, which is what a parse and
  // re-serialise actually changes — not the content between the tags.
  const respaced = para.html
    .replace(/></g, ">\n      <")
    .replace(/=/g, " = ");
  const row = deriveBlocks(blocks, [{ t: "setText", id: para.id, html: respaced }])
    .find((d) => d.block.id === para.id)!;
  assert.equal(row.changed, false);
  assert.equal(row.restyled, false, "reformatting is not a restyle");
});

test("reordered attributes and quote style are not a restyle", () => {
  // What a parse and re-serialise is free to do. Calling it a restyle puts a
  // badge and a change count on every block of a freshly forked version — the
  // false positive the text comparison exists to avoid, by another door.
  const page = `<!doctype html><html><body><main>
    <section><p class="lede" id="x" data-role="intro">Boost your signal today.</p></section>
  </main></body></html>`;
  const blocks = withBoxes(blocksOf(page), () => true);
  const para = blocks.find((b) => b.text.startsWith("Boost"))!;

  // Same element, attributes in another order and single-quoted.
  const reordered = para.html;
  const rows = deriveBlocks(blocks, [
    { t: "setText", id: para.id, html: reordered.replace(/"/g, "'") },
  ]);
  const row = rows.find((d) => d.block.id === para.id)!;
  assert.equal(row.changed, false);
  assert.equal(row.restyled, false, "quote style alone is not a change");
});
