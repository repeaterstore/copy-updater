import test from "node:test";
import assert from "node:assert/strict";
import { canModifyComment } from "./authorship";

test("the author may change their own comment", () => {
  assert.equal(canModifyComment({ authorId: "u1" }, "u1"), true);
});

test("nobody else may", () => {
  assert.equal(canModifyComment({ authorId: "u1" }, "u2"), false);
});

test("a comment with no author belongs to nobody", () => {
  // Its author has left the team. Treating that as "anyone may edit it" would
  // make removing a colleague a way to open up everything they ever wrote.
  assert.equal(canModifyComment({ authorId: null }, "u1"), false);
  // And an empty user id must never match a null author.
  assert.equal(canModifyComment({ authorId: null }, ""), false);
});
