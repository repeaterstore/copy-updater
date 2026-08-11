/**
 * Runs inside the snapshot iframe.
 *
 * Holds a pristine clone of the captured body taken before anything is applied,
 * so switching versions replays ops from the original rather than compounding
 * edits on top of edits.
 */
import { cssEscape, isBlockCandidate } from "../ops/extract";
import { sanitizeHtml } from "../ops/sanitize";
import { applyWithUndo, runUndo, type UndoEntry } from "../ops/undo";
import { ID_ATTR } from "../ops/types";
import {
  PREVIEW_CHANNEL,
  type DiffHighlights,
  type FrameMessage,
  type HostMessage,
} from "../preview/protocol";

const DIFF_ATTR = "data-cu-diff";
const COMMENT_ATTR = "data-cu-comment";
const SELECTED_ATTR = "data-cu-selected";

const DIFF_STYLES = `
[${DIFF_ATTR}] { position: relative; }
[${DIFF_ATTR}]::after {
  content: attr(${DIFF_ATTR});
  position: absolute; top: -0.5em; right: 0;
  font: 600 10px/1.4 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .04em; text-transform: uppercase;
  padding: 1px 5px; border-radius: 999px; color: #fff;
  pointer-events: none; z-index: 2147483000;
}
[${DIFF_ATTR}="changed"] { outline: 2px solid #d08700; outline-offset: 2px; background: rgba(255,196,0,.10); }
[${DIFF_ATTR}="changed"]::after { background: #d08700; }
[${DIFF_ATTR}="added"]   { outline: 2px solid #10893e; outline-offset: 2px; background: rgba(16,137,62,.10); }
[${DIFF_ATTR}="added"]::after { background: #10893e; }
[${DIFF_ATTR}="moved"]   { outline: 2px dashed #7b52d3; outline-offset: 2px; }
[${DIFF_ATTR}="moved"]::after { background: #7b52d3; }
[${DIFF_ATTR}="risk"]    { outline: 2px dotted #d08700; outline-offset: 2px; }
[${DIFF_ATTR}="risk"]::after { content: "check layout"; background: #a16207; }

/* Comments are an independent layer: a block can be edited and commented on.
   The marker sits on the opposite corner from the change badge so both are
   readable at once. */
[${COMMENT_ATTR}] { position: relative; }
[${COMMENT_ATTR}]::before {
  content: "\\1F4AC " attr(${COMMENT_ATTR});
  position: absolute; top: -0.5em; left: 0;
  font: 600 10px/1.4 ui-sans-serif, system-ui, sans-serif;
  padding: 1px 5px; border-radius: 999px;
  background: #0f8b8d; color: #fff;
  pointer-events: none; z-index: 2147483000;
}
/* A comment on otherwise-unchanged copy gets its own outline, since there is
   no diff highlight to carry it. */
[${COMMENT_ATTR}]:not([${DIFF_ATTR}]) {
  outline: 2px solid #0f8b8d; outline-offset: 2px;
  background: rgba(15,139,141,.09);
}

[${SELECTED_ATTR}] { outline: 2px solid #2f6fed !important; outline-offset: 2px; }

[contenteditable="true"]:hover { background: rgba(47,111,237,.07); cursor: text; }
[contenteditable="true"]:focus { outline: 2px solid #2f6fed; outline-offset: 2px; }
`;

/**
 * How to reverse the currently-applied op list.
 *
 * Replaces an earlier design that kept a clone of the body and restored it
 * before each replay. cloneNode() does not carry shadow roots, and a
 * declarative shadow root is consumed by the parser, so restoring from a clone
 * deleted every web component on the page — waveform.com's star rating rendered
 * on load and then vanished on the first edit.
 */
let undoJournal: UndoEntry[] = [];
let editable = false;
let highlights: DiffHighlights | null = null;
let diffOn = false;

function post(message: FrameMessage): void {
  parent.postMessage(message, "*");
}

function injectStyles(): void {
  const style = document.createElement("style");
  style.setAttribute("data-cu-preview-style", "");
  style.textContent = DIFF_STYLES;
  document.head.appendChild(style);
}

function byId(id: string): Element | null {
  return document.querySelector(`[${ID_ATTR}="${cssEscape(id)}"]`);
}

/** Reverse the currently-applied ops, leaving untouched DOM alone. */
function revertApplied(): void {
  runUndo(undoJournal);
  undoJournal = [];
  // The journal only reverses ops. Anything typed directly into the page since
  // the last apply has to come off too, or the next replay starts from a
  // document that is not the snapshot.
  restorePristine();
}

function clearDecorations(): void {
  for (const el of Array.from(document.querySelectorAll(`[${DIFF_ATTR}]`))) {
    el.removeAttribute(DIFF_ATTR);
  }
  for (const el of Array.from(document.querySelectorAll(`[${COMMENT_ATTR}]`))) {
    el.removeAttribute(COMMENT_ATTR);
  }
}

function paintDiff(): void {
  clearDecorations();
  if (!diffOn || !highlights) return;
  // Order matters: a block that both changed and moved should read as changed,
  // and a growth warning should not mask an actual edit.
  const layers: [string, string[]][] = [
    ["risk", highlights.layoutRisk],
    ["moved", highlights.moved],
    ["added", highlights.added],
    ["changed", highlights.changed],
  ];
  for (const [kind, ids] of layers) {
    for (const id of ids) byId(id)?.setAttribute(DIFF_ATTR, kind);
  }

  for (const [id, count] of Object.entries(highlights.comments ?? {})) {
    if (count > 0) byId(id)?.setAttribute(COMMENT_ATTR, String(count));
  }
}

/**
 * Bring a block into view and keep it there.
 *
 * Instant rather than smooth: a snapshot is ~10,000px tall, so a smooth scroll
 * takes seconds and gets throttled in a background iframe. The repeats handle
 * the other half of the problem — images above the target finish decoding after
 * the scroll and push the content down, so a single call lands in the wrong
 * place and the block appears not to have been found.
 */
function scrollToBlock(id: string): void {
  const settle = () => byId(id)?.scrollIntoView({ behavior: "auto", block: "center" });
  settle();
  requestAnimationFrame(settle);
  setTimeout(settle, 250);
  setTimeout(settle, 1000);
}

/** Only leaf text blocks are editable; containers would let a stray keypress
 *  destroy nested structure. */
function isLeafTextBlock(el: Element): boolean {
  const hasElementChildren = Array.from(el.children).some(
    (c) => !/^(A|ABBR|B|BR|CITE|CODE|EM|I|IMG|MARK|Q|S|SMALL|SPAN|STRONG|SUB|SUP|TIME|U)$/.test(c.tagName),
  );
  return !hasElementChildren && (el.textContent ?? "").trim() !== "";
}

/**
 * What each editable block said in the untouched snapshot.
 *
 * The replay model assumes the document equals snapshot + ops, and the undo
 * journal keeps that true by recording each element's content from just before
 * its op ran. Inline editing breaks the assumption: the typist changes the DOM
 * directly, so by the time the op arrives the "previous" content already
 * contains the edit. The journal then treats a half-typed sentence as the
 * original, and reverting a block leaves whatever had been typed by the time
 * the first op landed.
 *
 * Recorded once at load, when the document is known to be the bare snapshot,
 * and only for blocks that can be typed into — their content is a heading or a
 * paragraph, so this stays small.
 */
const pristineHtml = new Map<string, string>();

function capturePristine(): void {
  for (const el of Array.from(document.querySelectorAll(`[${ID_ATTR}]`))) {
    const id = el.getAttribute(ID_ATTR);
    if (id && isLeafTextBlock(el)) pristineHtml.set(id, el.innerHTML);
  }
}

/** Undo anything typed straight into the page, which no op list accounts for. */
function restorePristine(): void {
  for (const [id, html] of pristineHtml) {
    const el = byId(id);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }
}

function setEditable(on: boolean): void {
  editable = on;
  for (const el of Array.from(document.querySelectorAll(`[${ID_ATTR}]`))) {
    if (!on) {
      el.removeAttribute("contenteditable");
      continue;
    }
    if (!isLeafTextBlock(el)) continue;

    // Mark only the outermost editable block. A heading made of styled spans
    // qualifies, and so does every span inside it — nesting contenteditable
    // makes the caret behave erratically and means an edit to the heading is
    // captured as an edit to whichever span happened to have focus.
    // querySelectorAll is in document order, so ancestors are already marked.
    if (el.parentElement?.closest('[contenteditable="true"]')) continue;

    el.setAttribute("contenteditable", "true");
  }
}

/**
 * Keep the caret where the typist left it across an apply.
 *
 * Applying an op list rewrites the innerHTML of every block it touches,
 * including the one being typed into, and replacing a node's children destroys
 * the selection inside it. The caret went back to the start of the field every
 * time the host pushed the list — roughly every time the typist paused — which
 * made inline editing unusable past a few characters.
 *
 * The position is recorded as a character offset into the block's text rather
 * than a node and offset, because the nodes themselves do not survive.
 */
function captureCaret(): { id: string; offset: number } | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;

  const anchor = selection.anchorNode;
  const start = anchor?.nodeType === 1 ? (anchor as Element) : anchor?.parentElement;
  const block = start?.closest?.('[contenteditable="true"]');
  if (!block) return null;

  // Only when the caret is genuinely in this block. A stale selection left
  // behind after clicking away must not pull focus back.
  const active = document.activeElement;
  if (active !== block && !block.contains(active)) return null;

  const id = block.getAttribute(ID_ATTR);
  if (!id) return null;

  const range = document.createRange();
  range.selectNodeContents(block);
  range.setEnd(anchor!, selection.anchorOffset);
  return { id, offset: range.toString().length };
}

function restoreCaret(saved: { id: string; offset: number }): void {
  const block = byId(saved.id);
  if (!block) return;

  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = saved.offset;
  let last: Text | null = null;
  let node = walker.nextNode() as Text | null;

  while (node) {
    const length = node.data.length;
    if (remaining <= length) {
      place(node, remaining);
      return;
    }
    remaining -= length;
    last = node;
    node = walker.nextNode() as Text | null;
  }

  // The text got shorter than the offset — sit at the end rather than nowhere.
  if (last) place(last, last.data.length);

  function place(target: Text, offset: number): void {
    const range = document.createRange();
    range.setStart(target, offset);
    range.collapse(true);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (block as HTMLElement).focus?.({ preventScroll: true });
  }
}

const pendingEdits = new Map<string, ReturnType<typeof setTimeout>>();

function watchEdits(): void {
  document.addEventListener("input", (event) => {
    if (!editable) return;
    const target = (event.target as Element | null)?.closest?.(`[${ID_ATTR}]`);
    if (!target) return;
    const id = target.getAttribute(ID_ATTR);
    if (!id) return;

    clearTimeout(pendingEdits.get(id));
    pendingEdits.set(
      id,
      setTimeout(() => {
        pendingEdits.delete(id);
        post({
          channel: PREVIEW_CHANNEL,
          type: "blockEdited",
          id,
          html: sanitizeHtml(document, target.innerHTML),
        });
      }, 400),
    );
  });
}

/**
 * Which block the reviewer meant by clicking at this point.
 *
 * `closest()` alone is wrong on card layouts. The "stretched link" pattern puts
 * a full-card <a> on top of the card's text, so the topmost element at the
 * pointer is the anchor and the copy underneath can never be selected — on
 * waveform.com that made text like "Best Performance, Requires Aiming"
 * unclickable even though the outline listed it.
 *
 * Comparing element sizes does not work — a stretched link is often smaller
 * than the paragraph it covers. What distinguishes them is whose *text* is
 * painted at that pixel, so measure the text nodes directly.
 */
function hasTextAt(el: Element, x: number, y: number): boolean {
  const walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */);
  let node = walker.nextNode();
  while (node) {
    if ((node.nodeValue ?? "").trim() !== "") {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return true;
        }
      }
    }
    node = walker.nextNode();
  }
  return false;
}

/**
 * Climb to the outermost enclosing block candidate.
 *
 * Extraction walks top-down and stops at the first candidate it meets, so a
 * heading built from styled spans is one block — the heading, not the spans.
 * Click resolution has to agree, or it reports an id that is not in the block
 * list and the inspector has nothing to show.
 */
function outermostCandidate(el: Element): Element {
  let best = el;
  let parent = el.parentElement;
  while (parent && parent.hasAttribute(ID_ATTR) && isBlockCandidate(parent)) {
    best = parent;
    parent = parent.parentElement;
  }
  return best;
}

function blockAtPoint(event: MouseEvent): Element | null {
  const { clientX: x, clientY: y } = event;
  const stack =
    typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(x, y)
      : [];

  // Topmost first, so the first candidate actually showing text at this point
  // is the one the reviewer can see.
  for (const el of stack) {
    if (!el.hasAttribute?.(ID_ATTR)) continue;
    if (!isBlockCandidate(el)) continue;
    if (hasTextAt(el, x, y)) return outermostCandidate(el);
  }

  // No text under the pointer (whitespace, an image, a padded container):
  // fall back to whatever was clicked.
  const fallback = (event.target as Element | null)?.closest?.(`[${ID_ATTR}]`) ?? null;
  return fallback ? outermostCandidate(fallback) : null;
}

function watchClicks(): void {
  document.addEventListener(
    "click",
    (event) => {
      const target = blockAtPoint(event as MouseEvent);
      if (!target) return;
      const id = target.getAttribute(ID_ATTR);
      if (!id) return;
      // The snapshot is a frozen copy, so a link must never be followed — in
      // any mode. Navigating would replace the preview with the live site (or a
      // dead end, since assets are inlined) and lose the version being
      // reviewed. Previously this only applied outside edit mode, which is the
      // default, so clicking any CTA navigated away.
      if ((event.target as Element).closest?.("a")) event.preventDefault();
      post({ channel: PREVIEW_CHANNEL, type: "blockClicked", id });
    },
    true,
  );

  // Forms in a frozen snapshot can only ever navigate away.
  document.addEventListener("submit", (event) => event.preventDefault(), true);
}

function handle(message: HostMessage): void {
  switch (message.type) {
    case "applyOps": {
      const caret = captureCaret();
      revertApplied();
      const result = applyWithUndo(document, message.ops);
      undoJournal = result.undo;
      if (editable) setEditable(true);
      paintDiff();
      // After setEditable, so the block is contenteditable again before focus
      // returns to it.
      if (caret) restoreCaret(caret);
      post({
        channel: PREVIEW_CHANNEL,
        type: "applied",
        failures: result.failures.map((f) => ({
          id: "id" in f.op ? String(f.op.id) : "refId" in f.op ? String(f.op.refId) : "",
          reason: f.reason,
        })),
      });
      break;
    }
    case "setDiffMode":
      diffOn = message.on;
      highlights = message.highlights;
      paintDiff();
      break;
    case "setEditable":
      setEditable(message.on);
      break;
    case "selectBlock": {
      for (const el of Array.from(document.querySelectorAll(`[${SELECTED_ATTR}]`))) {
        el.removeAttribute(SELECTED_ATTR);
      }
      if (message.id) byId(message.id)?.setAttribute(SELECTED_ATTR, "");
      break;
    }
    case "scrollToBlock":
      scrollToBlock(message.id);
      break;
    case "measure": {
      const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
      for (const id of message.ids) {
        const el = byId(id) as HTMLElement | null;
        if (!el) continue;
        const r = el.getBoundingClientRect();
        boxes[id] = {
          x: Math.round(r.x + window.scrollX),
          y: Math.round(r.y + window.scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }
      post({ channel: PREVIEW_CHANNEL, type: "measured", boxes });
      break;
    }
  }
}

function start(): void {
  if (!document.body) return;
  // Before anything can change the document, so this really is the snapshot.
  capturePristine();
  injectStyles();
  watchEdits();
  watchClicks();

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as HostMessage | undefined;
    if (!data || data.channel !== PREVIEW_CHANNEL) return;
    handle(data);
  });

  post({ channel: PREVIEW_CHANNEL, type: "ready" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
