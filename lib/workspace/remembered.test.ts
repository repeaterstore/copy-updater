import test from "node:test";
import assert from "node:assert/strict";
import { readRemembered, writeRemembered, type KeyValueStore } from "./remembered";

function store(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const isDevice = (v: unknown): v is string =>
  v === "desktop" || v === "mobile" || v === "both";

test("a setting survives the round trip", () => {
  const s = store();
  writeRemembered(s, "device", "both");
  assert.equal(readRemembered(s, "device", isDevice), "both");
});

test("a setting older than a week is forgotten and cleared", () => {
  const s = store();
  const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  writeRemembered(s, "device", "mobile", weekAgo);
  assert.equal(readRemembered(s, "device", isDevice), null);
  assert.equal(s.map.size, 0, "the stale entry is removed rather than left to rot");
});

test("a value this build no longer offers falls back", () => {
  // A viewport that was renamed, or a zoom level dropped from the picker.
  const s = store();
  writeRemembered(s, "device", "widescreen");
  assert.equal(readRemembered(s, "device", isDevice), null);
});

test("nothing stored, and unparseable storage, both read as absent", () => {
  const s = store();
  assert.equal(readRemembered(s, "device", isDevice), null);
  s.map.set("copy-updater/device", "{not json");
  assert.equal(readRemembered(s, "device", isDevice), null);
  assert.equal(s.map.size, 0, "the junk is cleared out");
});

test("storage that throws is survivable", () => {
  // Private browsing, or blocked storage. A preview preference is never worth
  // failing a review over.
  const denied: KeyValueStore = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  assert.equal(readRemembered(denied, "device", isDevice), null);
  assert.doesNotThrow(() => writeRemembered(denied, "device", "both"));
});

test("settings are kept apart from anything else in the browser", () => {
  const s = store();
  writeRemembered(s, "device", "both");
  assert.ok([...s.map.keys()].every((k) => k.startsWith("copy-updater/")));
});
