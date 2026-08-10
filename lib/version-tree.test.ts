import test from "node:test";
import assert from "node:assert/strict";
import { orderByLineage } from "./version-tree";

interface V {
  id: string;
  parentVersionId: string | null;
  createdAt: string;
  label: string;
}

const v = (id: string, parent: string | null, day: number, label = id): V => ({
  id,
  parentVersionId: parent,
  createdAt: `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`,
  label,
});

test("children follow their parent, and roots keep creation order", () => {
  // The real shape on a page: two independent roots, one with a fork.
  const rows = orderByLineage([
    v("revision", "test2", 4),
    v("graeme", null, 1),
    v("test2", null, 2),
  ]);

  assert.deepEqual(
    rows.map((r) => [r.version.id, r.depth]),
    [
      ["graeme", 0],
      ["test2", 0],
      ["revision", 1],
    ],
  );
  assert.equal(rows[2].parent?.id, "test2");
  assert.equal(rows[0].parent, null);
});

test("depth increases down a chain", () => {
  const rows = orderByLineage([
    v("c", "b", 3),
    v("a", null, 1),
    v("b", "a", 2),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.version.id, r.depth]),
    [["a", 0], ["b", 1], ["c", 2]],
  );
});

test("a version whose parent is missing is listed as a root", () => {
  // Happens when the parent lives on another page or was deleted; the version
  // must still appear rather than vanishing from the list.
  const rows = orderByLineage([v("orphan", "gone", 1), v("root", null, 2)]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.version.id === "orphan")?.depth, 0);
  assert.equal(rows.find((r) => r.version.id === "orphan")?.parent, null);
});

test("a cycle is listed rather than hanging the render", () => {
  const rows = orderByLineage([v("x", "y", 1), v("y", "x", 2)]);
  assert.equal(rows.length, 2, "both versions still appear");
  assert.deepEqual(new Set(rows.map((r) => r.version.id)), new Set(["x", "y"]));
});

test("every version appears exactly once", () => {
  const input = [
    v("a", null, 1), v("b", "a", 2), v("c", "a", 3),
    v("d", "b", 4), v("e", null, 5),
  ];
  const rows = orderByLineage(input);
  assert.equal(rows.length, input.length);
  assert.equal(new Set(rows.map((r) => r.version.id)).size, input.length);
  // Siblings sort by creation, so 'b' precedes 'c' under 'a'.
  const ids = rows.map((r) => r.version.id);
  assert.ok(ids.indexOf("b") < ids.indexOf("c"));
  assert.ok(ids.indexOf("d") > ids.indexOf("b"));
});
