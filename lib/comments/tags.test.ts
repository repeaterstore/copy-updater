import test from "node:test";
import assert from "node:assert/strict";
import { isForDesigner, withoutDesignTag } from "./tags";

test("a design tag is recognised wherever it sits in the comment", () => {
  assert.ok(isForDesigner("@design this photo is the wrong building"));
  assert.ok(isForDesigner("The hero image is stretched @design"));
  assert.ok(isForDesigner("Two headings, same size — @designer can you look?"));
  assert.ok(isForDesigner("@DESIGN case does not matter"));
});

test("copy comments are left alone", () => {
  assert.ok(!isForDesigner("Tighten this headline."));
  // The guard that matters: a signature or an address is not a design request.
  assert.ok(!isForDesigner("Ask sam@design.com about the brand kit"));
  assert.ok(!isForDesigner("Our redesign lands in March"));
  assert.ok(!isForDesigner("See the design system doc"));
});

test("the tag is stripped for a list that is already all design notes", () => {
  assert.equal(withoutDesignTag("@design wrong building"), "wrong building");
  assert.equal(withoutDesignTag("The hero is stretched @design"), "The hero is stretched");
  assert.equal(
    withoutDesignTag("Two headings, @designer same size"),
    "Two headings, same size",
  );
});

test("design notes group with the busiest pages first", async () => {
  const { groupByPage } = await import("./notes");
  const note = (pageId: string, pageName: string, resolved: boolean, id: string) => ({
    id, body: "b", resolved, createdAt: "2026-08-01T00:00:00.000Z", author: "A",
    pageId, pageName, pageUrl: `https://x/${pageId}`,
    versionId: "v", versionLabel: "V", blockId: null, blockText: null, blockRole: null,
  });

  const grouped = groupByPage([
    note("p1", "Alpha", true, "1"),
    note("p2", "Beta", false, "2"),
    note("p2", "Beta", false, "3"),
    note("p3", "Gamma", false, "4"),
  ]);

  // Two open beats one open beats none — a list that opens on finished work
  // stops being read.
  assert.deepEqual(grouped.map((g) => g.pageName), ["Beta", "Gamma", "Alpha"]);
  assert.equal(grouped[0].notes.length, 2);
});
