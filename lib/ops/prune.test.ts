import test from "node:test";
import assert from "node:assert/strict";
import { withoutOrphans } from "./prune";
import type { Op } from "./types";

const insert = (html: string, refId = "body/main:1/p:1"): Op => ({
  t: "insert", refId, pos: "after", html,
});

test("edits to an inserted block go when the insert does", () => {
  // Exactly the shape found on the RSRF home page: two setTexts against blocks
  // of an FAQ template whose insert had been reverted away.
  const ops: Op[] = [
    { t: "setText", id: "body/main:1/h1:1", html: "Kept — a real block on the page" },
    { t: "setText", id: "new:nIo-FBjW7B", html: "Frequently asked questions" },
    { t: "setText", id: "new:5KZQ-fvHLG", html: "First question?" },
  ];
  assert.deepEqual(withoutOrphans(ops), [ops[0]]);
});

test("edits to an inserted block stay while the insert is there", () => {
  const ops: Op[] = [
    insert('<section data-cu-id="new:sec"><h2 data-cu-id="new:head">Q</h2></section>'),
    { t: "setText", id: "new:head", html: "Frequently asked questions" },
  ];
  assert.deepEqual(withoutOrphans(ops), ops);
});

test("a chain of inserts is unwound to a fixed point", () => {
  const ops: Op[] = [
    // The outer insert is missing, so the one anchored inside it is orphaned,
    // and so is the edit to what that one created.
    insert('<li data-cu-id="new:inner">Another</li>', "new:outer"),
    { t: "setText", id: "new:inner", html: "Another question?" },
    { t: "setText", id: "body/main:1/p:2", html: "Untouched" },
  ];
  assert.deepEqual(withoutOrphans(ops), [ops[2]]);
});

test("a structural path that is missing is left well alone", () => {
  // A captured block can be absent for reasons this must not judge — a
  // re-capture that moved it, a page that changed underneath. Dropping a
  // reviewer's work over that would be far worse than a warning.
  const ops: Op[] = [{ t: "setText", id: "body/main:1/section:9/p:4", html: "Still here" }];
  assert.deepEqual(withoutOrphans(ops), ops);
});

test("pruning is stable: a clean list is returned unchanged", () => {
  const ops: Op[] = [
    insert('<p data-cu-id="new:a">A</p>'),
    { t: "setText", id: "new:a", html: "A revised" },
    { t: "setAttr", id: "new:a", name: "class", value: "hidden md:block" },
    { t: "setMeta", title: "T" },
  ];
  assert.deepEqual(withoutOrphans(withoutOrphans(ops)), ops);
});
