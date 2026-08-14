import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { applyOps } from "./apply";
import { extractBlocks, stampIds } from "./extract";
import { assignNewIds } from "./ids";
import { sanitizeHtml } from "./sanitize";
import { cleanMarkup } from "./section-scope";
import type { Op } from "./types";

/**
 * The split the preview performs against the live DOM, reproduced here: take
 * everything after the caret out of the block and put it in a clone.
 */
function splitAt(doc: Document, el: Element, offsetInText: number) {
  const textNode = el.firstChild!;
  const range = doc.createRange();
  range.setStart(textNode, offsetInText);
  const tail = range.cloneRange();
  tail.selectNodeContents(el);
  tail.setStart(textNode, offsetInText);
  const moved = tail.extractContents();
  const sibling = el.cloneNode(false) as Element;
  sibling.appendChild(moved);
  return { before: el.innerHTML, after: cleanMarkup(sibling) };
}

test("Enter mid-paragraph makes two paragraphs, not a paragraph inside one", () => {
  const dom = new JSDOM(
    `<!doctype html><html><body><section><p class="lede">First sentence. Second sentence.</p></section></body></html>`,
  );
  const doc = dom.window.document;
  stampIds(doc);
  const para = doc.querySelector("p")!;
  const id = para.getAttribute("data-cu-id")!;

  const { before, after } = splitAt(doc, para, "First sentence. ".length);
  const ops: Op[] = [
    { t: "setText", id, html: sanitizeHtml(doc, before) },
    { t: "insert", refId: id, pos: "after", html: assignNewIds(doc, sanitizeHtml(doc, after)) },
  ];
  assert.equal(applyOps(doc, ops).failures.length, 0);

  const blocks = extractBlocks(doc);
  assert.deepEqual(blocks.map((b) => b.text), ["First sentence.", "Second sentence."]);
  // Two siblings, both paragraphs, both carrying the original's class — not a
  // <div> wedged inside the first one, which is what the browser does unaided.
  assert.equal(doc.querySelectorAll("section > p.lede").length, 2);
  assert.equal(doc.querySelectorAll("p p, p div").length, 0);
  // And the new one is its own block, not a second element answering to the first's id.
  assert.equal(new Set(blocks.map((b) => b.id)).size, 2);
});

test("Enter at the end of a paragraph gives an empty one to type into", () => {
  const dom = new JSDOM(
    `<!doctype html><html><body><section><p>All of it.</p></section></body></html>`,
  );
  const doc = dom.window.document;
  stampIds(doc);
  const para = doc.querySelector("p")!;
  const id = para.getAttribute("data-cu-id")!;

  const { before, after } = splitAt(doc, para, "All of it.".length);
  const ops: Op[] = [
    { t: "setText", id, html: sanitizeHtml(doc, before) },
    { t: "insert", refId: id, pos: "after", html: assignNewIds(doc, sanitizeHtml(doc, after)) },
  ];
  assert.equal(applyOps(doc, ops).failures.length, 0);
  assert.equal(doc.querySelectorAll("section > p").length, 2);
  assert.equal(doc.querySelectorAll("section > p")[1].textContent, "");
});

test("splitting keeps inline markup on the side of the caret it belongs to", () => {
  const dom = new JSDOM(
    `<!doctype html><html><body><section><p>Read the <a href="/g">guide</a> now.</p></section></body></html>`,
  );
  const doc = dom.window.document;
  stampIds(doc);
  const para = doc.querySelector("p")!;
  const id = para.getAttribute("data-cu-id")!;

  const { before, after } = splitAt(doc, para, "Read the ".length);
  const ops: Op[] = [
    { t: "setText", id, html: sanitizeHtml(doc, before) },
    { t: "insert", refId: id, pos: "after", html: assignNewIds(doc, sanitizeHtml(doc, after)) },
  ];
  assert.equal(applyOps(doc, ops).failures.length, 0);
  // The link moved with the words around it rather than being torn in half.
  const paras = [...doc.querySelectorAll("section > p")];
  assert.equal(paras[0].textContent, "Read the ");
  assert.match(paras[1].innerHTML, /<a href="\/g"/);
  assert.equal(paras[1].textContent, "guide now.");
});
