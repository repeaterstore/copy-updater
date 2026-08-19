import test from "node:test";
import assert from "node:assert/strict";
import { salvageObject } from "./prose";

test("an object wrapped in commentary is recovered", () => {
  const said = `Here are three options for you:

\`\`\`json
{"options":[{"label":"Fit","rationale":"Shorter","ops":[{"t":"setText","id":"a","html":"x"}]}]}
\`\`\`

Let me know which you prefer.`;
  const out = salvageObject(said);
  assert.ok(out);
  assert.equal(out.options.length, 1);
});

test("`op` and `text` are renamed to the keys the schema declares", () => {
  const said =
    '{"options":[{"label":"L","rationale":"R","ops":[{"op":"setText","id":"a","text":"New copy"}]}]}';
  const option = salvageObject(said)!.options[0] as { ops: Record<string, unknown>[] };
  assert.equal(option.ops[0].t, "setText");
  assert.equal(option.ops[0].html, "New copy");
  assert.ok(!("op" in option.ops[0]));
});

test("ops carrying options are pivoted back into options carrying ops", () => {
  // The real payload from an Opus run on the RSRF home page: one entry per
  // block, and inside it the alternative wordings for that block. Three good
  // rewrites were thrown away as prose.
  const said = JSON.stringify({
    ops: [
      {
        op: "setText",
        id: "body/div:2/section:3/div:1/div:1/h2:1",
        options: [
          { label: "Focus", text: "In-building wireless is our entire business.", rationale: "Flat before." },
          { label: "Proof", text: "Twenty years of in-building wireless.", rationale: "Concrete." },
        ],
      },
      {
        op: "setText",
        id: "body/div:2/section:3/div:1/div:1/p:1",
        options: [
          { label: "Focus", text: "We do one thing.", rationale: "Matches the headline." },
          { label: "Proof", text: "Five thousand builds.", rationale: "Backs the claim." },
        ],
      },
    ],
  });

  const out = salvageObject(said);
  assert.ok(out, "the inverted shape is recognised");
  assert.equal(out.options.length, 2, "one option per alternative, not per block");

  const first = out.options[0] as { label: string; rationale: string; ops: Record<string, unknown>[] };
  assert.equal(first.label, "Focus");
  assert.equal(first.ops.length, 2, "both blocks change together in one option");
  assert.equal(first.ops[0].t, "setText");
  assert.equal(first.ops[0].id, "body/div:2/section:3/div:1/div:1/h2:1");
  assert.equal(first.ops[0].html, "In-building wireless is our entire business.");
  assert.equal(first.ops[1].html, "We do one thing.");
  // The alternative's own wording is dropped from the op; only schema fields
  // survive, or validation rejects the lot.
  assert.ok(!("options" in first.ops[0]));
  assert.ok(!("text" in first.ops[0]));

  const second = out.options[1] as { label: string; ops: Record<string, unknown>[] };
  assert.equal(second.label, "Proof");
  assert.equal(second.ops[0].html, "Twenty years of in-building wireless.");
});

test("a block with fewer alternatives simply does not change in the later option", () => {
  const said = JSON.stringify({
    ops: [
      { op: "setText", id: "a", options: [{ text: "one" }, { text: "two" }] },
      { op: "setText", id: "b", options: [{ text: "only" }] },
    ],
  });
  const out = salvageObject(said)!;
  assert.equal((out.options[0] as { ops: unknown[] }).ops.length, 2);
  assert.equal((out.options[1] as { ops: unknown[] }).ops.length, 1);
});

test("prose with invented notation is not salvaged", () => {
  const said = `**Option 1 — Fit/scale angle**
\`\`\`
setText body/div:2/section:1/p:1 "From 100,000 to 1M+ square feet"
\`\`\``;
  assert.equal(salvageObject(said), null);
});

test("nothing recognisable is not salvaged", () => {
  assert.equal(salvageObject(undefined), null);
  assert.equal(salvageObject(""), null);
  assert.equal(salvageObject("I cannot help with that."), null);
  assert.equal(salvageObject('Try {"foo": 1} perhaps'), null);
});
