import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractBlocks, stampIds } from "@/lib/ops/extract";
import { boundingBoxFor } from "@/lib/ai/crop";
import {
  MAX_SCOPE_BLOCKS,
  deriveBlocks,
  groupIntoSections,
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
