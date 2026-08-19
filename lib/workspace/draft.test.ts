import test from "node:test";
import assert from "node:assert/strict";
import { nextDraft } from "./draft";
import { tidy } from "./tidy";

test("typing a space does not rewrite the field", () => {
  // The exact sequence behind the caret jump: the space is typed, reported
  // upward, and comes back as the block's html. Rewriting the field with it is
  // what put the caret at the start of the line.
  const typed = "Cover every inch of your warehouse ";
  assert.equal(nextDraft(typed, typed, false), null, "the echo is ignored");

  // And it is only a space that exposed it — tidy leaves the rest alone, so
  // every other keystroke echoed back identical and was silently skipped.
  assert.notEqual(tidy(typed), typed, "tidy would have changed it");
});

test("a change from anywhere else replaces what is shown", () => {
  const mine = "What I was typing";
  // An AI option applied, or an edit made in the preview.
  assert.equal(nextDraft("Something else entirely", mine, false), "Something else entirely");
});

test("content arriving before anything is typed is tidied", () => {
  // A freshly selected block still carries the source page's indentation.
  const captured = "\n              Turn-Key DAS Solutions v3\n            ";
  assert.equal(nextDraft(captured, null, false), "Turn-Key DAS Solutions v3");
});

test("the markup view is shown exactly as it is", () => {
  const captured = "\n  <p>Spaced <b>out</b></p>\n";
  assert.equal(nextDraft(captured, null, true), captured);
});

test("a trailing double space survives being typed", () => {
  // Mid-sentence, someone types two spaces before continuing. Collapsing them
  // under the caret moves it, and the second space vanishes as it is typed.
  const typed = "One  ";
  assert.equal(nextDraft(typed, typed, false), null);
});

test("pre blocks keep their whitespace when they arrive", () => {
  const code = "<pre>  indented\n    more</pre>";
  assert.equal(nextDraft(code, null, false), code);
});
