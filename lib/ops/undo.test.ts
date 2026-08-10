import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractBlocks, stampIds } from "./extract";
import { assignNewIds } from "./ids";
import { applyWithUndo, runUndo } from "./undo";
import { ID_ATTR, type Op } from "./types";

const PAGE = `<!doctype html>
<html><head><title>Old</title><meta name="description" content="Old desc"></head><body>
  <section class="hero">
    <h1>Fast boosters</h1>
    <p>Boost your signal today.</p>
    <div class="rating"><span>4.93</span><star-rating rating="4.93"></star-rating></div>
  </section>
  <ul><li>Free shipping</li><li>Two year warranty</li></ul>
</body></html>`;

function fresh() {
  const dom = new JSDOM(PAGE);
  stampIds(dom.window.document);
  return dom.window.document;
}

function byId(doc: Document, id: string) {
  return doc.querySelector(`[${ID_ATTR}="${id}"]`);
}

test("replaying ops never touches untouched nodes", () => {
  const doc = fresh();
  const blocks = extractBlocks(doc);
  const h1 = blocks.find((b) => b.tag === "h1")!;

  // The widget the runtime must not disturb. In a real snapshot this carries a
  // shadow root, which cloneNode() would silently drop.
  const widget = doc.querySelector("star-rating")!;
  const ratingSpan = doc.querySelector(".rating span")!;

  let result = applyWithUndo(doc, [{ t: "setText", id: h1.id, html: "Faster boosters" }]);
  assert.equal(result.failures.length, 0);
  assert.equal(byId(doc, h1.id)!.textContent, "Faster boosters");

  // Same node objects, not replacements — proof nothing was rebuilt wholesale.
  assert.equal(doc.querySelector("star-rating"), widget, "widget node is identical");
  assert.equal(doc.querySelector(".rating span"), ratingSpan, "sibling node is identical");

  runUndo(result.undo);
  assert.equal(byId(doc, h1.id)!.textContent, "Fast boosters", "reverted to original");

  // Replay a different list, as the workspace does on every keystroke.
  result = applyWithUndo(doc, [{ t: "setText", id: h1.id, html: "Fastest boosters" }]);
  assert.equal(byId(doc, h1.id)!.textContent, "Fastest boosters");
  assert.equal(doc.querySelector("star-rating"), widget, "widget survives replay");
});

test("undo reverses every op type", () => {
  const doc = fresh();
  const blocks = extractBlocks(doc);
  const h1 = blocks.find((b) => b.tag === "h1")!;
  const para = blocks.find((b) => b.tag === "p")!;
  const shipping = blocks.find((b) => b.text === "Free shipping")!;
  const warranty = blocks.find((b) => b.text === "Two year warranty")!;

  const beforeHtml = doc.body.innerHTML;
  const beforeTitle = doc.querySelector("title")!.textContent;

  const ops: Op[] = [
    { t: "setText", id: h1.id, html: "Rewritten" },
    { t: "setMeta", title: "New title", description: "New desc" },
    { t: "insert", refId: warranty.id, pos: "after", html: assignNewIds(doc, "<li>Free returns</li>") },
    { t: "remove", id: shipping.id },
    { t: "move", id: para.id, refId: h1.id, pos: "before" },
    { t: "setAttr", id: h1.id, name: "data-test", value: "x" },
    { t: "addStyle", css: "h1{color:red}" },
  ];

  const result = applyWithUndo(doc, ops);
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
  assert.equal(result.applied, ops.length);

  // Everything landed.
  assert.equal(byId(doc, h1.id)!.textContent, "Rewritten");
  assert.equal(doc.querySelector("title")!.textContent, "New title");
  assert.ok([...doc.querySelectorAll("li")].some((li) => li.textContent === "Free returns"));
  assert.equal(byId(doc, shipping.id), null);
  assert.equal(byId(doc, h1.id)!.getAttribute("data-test"), "x");
  assert.equal(doc.querySelectorAll("style[data-cu-style]").length, 1);

  runUndo(result.undo);

  // And everything came back.
  assert.equal(doc.querySelector("title")!.textContent, beforeTitle);
  assert.equal(
    doc.querySelector('meta[name="description"]')!.getAttribute("content"),
    "Old desc",
  );
  assert.ok(!doc.body.innerHTML.includes("Free returns"), "inserted node removed");
  assert.ok(byId(doc, shipping.id), "removed node restored");
  assert.equal(byId(doc, h1.id)!.hasAttribute("data-test"), false);
  assert.equal(doc.querySelectorAll("style[data-cu-style]").length, 0);
  assert.equal(doc.body.innerHTML, beforeHtml, "document byte-identical to the start");
});

test("a failing op does not leave a half-applied journal", () => {
  const doc = fresh();
  const before = doc.body.innerHTML;
  const result = applyWithUndo(doc, [
    { t: "setText", id: "body/nope:1", html: "x" },
    { t: "remove", id: "body/also-nope:1" },
  ]);

  assert.equal(result.applied, 0);
  assert.equal(result.failures.length, 2);
  runUndo(result.undo);
  assert.equal(doc.body.innerHTML, before);
});
