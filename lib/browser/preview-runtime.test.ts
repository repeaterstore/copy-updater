import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { bundleBrowserScript } from "./bundle";
import { stampIds } from "@/lib/ops/extract";

const CHANNEL = "copy-updater/preview";

/**
 * Loads the real preview runtime into a page, the way the iframe does.
 *
 * The bundle is what actually ships to the frame, so testing it directly is
 * the only way to cover the parts that only exist in a browser: where the
 * caret is, which element is editable, and what gets posted back.
 */
async function frame(body: string) {
  const code = await bundleBrowserScript("preview");
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    runScripts: "dangerously",
  });
  stampIds(dom.window.document);

  const posted: Record<string, unknown>[] = [];
  // The runtime talks to its host with parent.postMessage.
  Object.defineProperty(dom.window, "parent", {
    value: { postMessage: (m: Record<string, unknown>) => posted.push(m) },
    configurable: true,
  });

  const script = dom.window.document.createElement("script");
  script.textContent = code;
  dom.window.document.body.appendChild(script);

  const send = (message: Record<string, unknown>) =>
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", { data: { channel: CHANNEL, ...message } }),
    );

  return { dom, doc: dom.window.document, posted, send };
}

test("Enter splits the editable block, not the span the caret sits in", async () => {
  // The shape that broke it: the paragraph is the editable block, but the
  // caret's nearest id-bearing ancestor is the span inside it.
  const { dom, doc, posted, send } = await frame(
    `<section><p class="lede">Our team will review your floorplans. <span>Zero fluff.</span></p></section>`,
  );
  send({ type: "setEditable", on: true });

  const para = doc.querySelector("p")!;
  assert.equal(para.getAttribute("contenteditable"), "true", "the paragraph is the editable block");

  // Caret inside the span, which is where the bug lived: every element in a
  // snapshot is stamped, so the nearest id-bearing ancestor is the span, and
  // splitting that produced two spans on one line.
  const span = doc.querySelector("span")!;
  assert.ok(span.hasAttribute("data-cu-id"), "the span is stamped too — that is the trap");
  const range = doc.createRange();
  range.setStart(span.firstChild!, "Zero ".length);
  range.collapse(true);
  const selection = dom.window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  para.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );

  const split = posted.find((m) => m.type === "blockSplit");
  assert.ok(split, `no split was posted; got ${posted.map((m) => m.type).join(", ")}`);
  // The paragraph's id, not the span's — splitting the span would put two
  // spans side by side on one line, which reads as Enter doing nothing.
  assert.equal(split.id, para.getAttribute("data-cu-id"));
  // Inner markup: the host wraps it in the block's own tag and classes.
  assert.ok(!String(split.after).startsWith("<p"), "not a whole element");
  assert.match(String(split.after), /fluff\./);
  assert.ok(!String(split.after).includes("data-cu-id"), "the copy carries no borrowed ids");
  assert.match(String(split.before), /Our team will review your floorplans\./);
  assert.match(String(split.before), /Zero /, "the words before the caret stayed put");
  assert.ok(!String(split.before).includes("fluff."), "the tail moved out of the original");
});

test("shift+Enter breaks the line instead of splitting the block", async () => {
  const { dom, doc, posted, send } = await frame(`<section><p>One two.</p></section>`);
  send({ type: "setEditable", on: true });

  const para = doc.querySelector("p")!;
  const range = doc.createRange();
  range.setStart(para.firstChild!, "One ".length);
  range.collapse(true);
  const selection = dom.window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  para.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "Enter", shiftKey: true, bubbles: true, cancelable: true,
    }),
  );

  assert.ok(!posted.some((m) => m.type === "blockSplit"), "no split for a line break");
  assert.equal(para.querySelectorAll("br").length, 1, "a <br> went in, which is inline markup");
});

test("Enter over a selection replaces it rather than duplicating it", async () => {
  const { dom, doc, posted, send } = await frame(
    `<section><p>Keep this. Delete this. Keep that.</p></section>`,
  );
  send({ type: "setEditable", on: true });

  const para = doc.querySelector("p")!;
  const text = para.firstChild!;
  const from = "Keep this. ".length;
  const to = from + "Delete this. ".length;

  const range = doc.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  const selection = dom.window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  para.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );

  const split = posted.find((m) => m.type === "blockSplit")!;
  assert.ok(split, "the block split");
  // The selected phrase is gone from both halves — not left in the first and
  // repeated at the top of the second.
  assert.ok(!String(split.before).includes("Delete this"), `before kept it: ${split.before}`);
  assert.ok(!String(split.after).includes("Delete this"), `after kept it: ${split.after}`);
  assert.match(String(split.before), /Keep this\./);
  assert.match(String(split.after), /Keep that\./);
});
