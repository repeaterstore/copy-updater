import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { stampIds } from "./extract";
import { cleanMarkup, enclosingSection } from "./section-scope";

function docOf(html: string): Document {
  const doc = new JSDOM(html).window.document;
  stampIds(doc);
  return doc;
}

test("an explicit section wins over its wrappers", () => {
  const doc = docOf(`<!doctype html><html><body><main><div class="outer">
    <section class="faq"><h2>Questions</h2><div class="item"><p id="a">Yes.</p></div></section>
  </div></main></body></html>`);
  const found = enclosingSection(doc.getElementById("a")!);
  assert.equal(found.className, "faq");
});

test("without a section tag it stops before the element spanning several headings", () => {
  // Utility-class markup with no semantic tags — the RSRF shape.
  const doc = docOf(`<!doctype html><html><body><div id="app">
    <div class="band"><h2>One</h2><p id="a">First body.</p></div>
    <div class="band"><h2>Two</h2><p>Second body.</p></div>
  </div></body></html>`);
  const found = enclosingSection(doc.getElementById("a")!);
  assert.equal(found.className, "band", "took the band, not the whole app wrapper");
  assert.ok(!found.textContent?.includes("Second body"), "did not swallow the next section");
});

test("the whole document is never the answer", () => {
  const doc = docOf(`<!doctype html><html><body><p id="a">Alone on the page.</p></body></html>`);
  const found = enclosingSection(doc.getElementById("a")!);
  assert.notEqual(found.tagName.toUpperCase(), "BODY");
  assert.equal(found.getAttribute("id"), "a");
});

test("copied markup keeps the page's classes and drops the tool's attributes", () => {
  const doc = docOf(`<!doctype html><html><body><section class="faq">
    <div class="item"><h3 class="q">Does it work?</h3><p class="a">Yes.</p></div>
  </section></body></html>`);
  const item = doc.querySelector(".item")!;
  item.setAttribute("data-cu-diff", "changed");
  item.setAttribute("contenteditable", "true");

  const html = cleanMarkup(item);
  // The classes are the entire reason for copying off the page rather than
  // generating a template.
  assert.match(html, /class="item"/);
  assert.match(html, /class="q"/);
  // And nothing the tool wrote comes along — a copied id would be a second
  // element answering to an id that already exists.
  assert.ok(!html.includes("data-cu-id"), `ids leaked: ${html}`);
  assert.ok(!html.includes("data-cu-diff"));
  assert.ok(!html.includes("contenteditable"));
  // The original is untouched: this copies, it does not strip the live page.
  assert.equal(item.getAttribute("data-cu-diff"), "changed");
  assert.ok(item.hasAttribute("data-cu-id"));
});

test("body is returned as itself rather than walking up to the document", () => {
  const doc = docOf(`<!doctype html><html><body><p>Copy.</p></body></html>`);
  assert.equal(enclosingSection(doc.body).tagName.toUpperCase(), "BODY");
});
