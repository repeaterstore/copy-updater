import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractBlocks, stampIds } from "@/lib/ops/extract";
import { buildUserPrompt, neighboursFor, pageSummaryFor } from "./prompt";
import type { Block } from "@/lib/ops/types";

const PAGE = `<!doctype html><html><body>
  <nav><div><a href="/a">Menu one</a></div></nav>
  <section>
    <h1>Cell signal boosters that actually work</h1>
    <p>Rated 4.93 by twelve thousand customers.</p>
  </section>
  <section>
    <h2>Built for large homes</h2>
    <p>Coverage up to seven thousand square feet.</p>
  </section>
</body></html>`;

function blocksOf(html = PAGE): Block[] {
  const doc = new JSDOM(html).window.document;
  stampIds(doc);
  return extractBlocks(doc);
}

const META = {
  title: "Waveform",
  description: "Signal boosters.",
  ogTitle: null,
  ogDescription: null,
  canonical: null,
};

function metaPrompt(blocks: Block[]): string {
  // Exactly what generateSuggestions assembles for a meta-scoped request:
  // nothing in scope, the page carried as read-only context.
  return buildUserPrompt({
    pageUrl: "https://www.waveform.com/",
    pageName: "Waveform home",
    brief: "Audience: IT directors.",
    mode: "copy",
    shape: "optimize",
    instructions: null,
    optionCount: 3,
    meta: META,
    scope: [],
    context: pageSummaryFor(blocks),
    cssIndex: {},
    angle: null,
    webSearch: false,
    scopeKind: "meta",
    sectionLabel: null,
  });
}

test("a meta request is shown the page it has to describe", () => {
  const blocks = blocksOf();
  const prompt = metaPrompt(blocks);

  // The failure this guards against is silent: the model still returns setMeta
  // ops, written from the brief and the URL, having never seen the page.
  assert.match(prompt, /Cell signal boosters that actually work/);
  assert.match(prompt, /Built for large homes/);
  assert.match(prompt, /WHAT THE PAGE SAYS/);

  // Still meta-only: no editable blocks, and no invitation to rewrite copy.
  assert.doesNotMatch(prompt, /EDITABLE BLOCKS/);
  assert.match(prompt, /Emit only setMeta/);
});

test("neighbours are empty without a scope, which is why meta needs its own context", () => {
  assert.deepEqual(neighboursFor(blocksOf(), []), []);
});

test("the page summary keeps the top of the page and the headings", () => {
  // Long enough to be trimmed: a lead run, then headings far past the cap.
  const filler: Block[] = Array.from({ length: 60 }, (_, i) => ({
    id: `body/p:${i}`,
    tag: "p",
    role: "paragraph",
    html: `Body ${i}`,
    text: `Body ${i}`,
    order: i,
    sectionLabel: null,
    classes: [],
    box: null,
  }));
  const heading: Block = {
    ...filler[0],
    id: "body/h2:1",
    tag: "h2",
    role: "heading",
    html: "Late heading",
    text: "Late heading",
    order: 25,
  };
  const all = [...filler.slice(0, 25), heading, ...filler.slice(25)];

  const summary = pageSummaryFor(all, 40);
  // The lead run plus the headings — a cap, not a quota, so a page with few
  // headings sends less rather than padding with mid-page body copy.
  assert.ok(summary.length <= 40);
  assert.ok(summary.length < all.length, "a long page is sampled, not sent whole");
  assert.equal(summary[0].id, all[0].id, "starts at the top of the page");
  assert.ok(
    summary.some((b) => b.id === "body/h2:1"),
    "a heading past the lead run is still included",
  );
  // Document order is preserved, so the sample reads as the page reads.
  const orders = summary.map((b) => all.indexOf(b));
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test("a short page is passed through whole", () => {
  const blocks = blocksOf();
  assert.deepEqual(pageSummaryFor(blocks, 40), blocks);
});
