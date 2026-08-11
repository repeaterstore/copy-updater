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
  sectionBlocks,
  sectionScopeFor,
} from "./derive";
import type { Block } from "@/lib/ops/types";

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
