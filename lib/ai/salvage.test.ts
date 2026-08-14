import test from "node:test";
import assert from "node:assert/strict";
import { salvageObject } from "./prose";

test("an object wrapped in commentary is recovered", () => {
  const said = `Here are three options for you:

\`\`\`json
{"options":[{"label":"Fit","rationale":"Shorter","ops":[]}]}
\`\`\`

Let me know which you prefer.`;
  const out = salvageObject(said);
  assert.ok(out, "recovered the object from around the prose");
  assert.equal(out.options.length, 1);
});

test("prose with invented notation is not salvaged", () => {
  // The real failure: the model wrote its own op syntax for a human reader.
  const said = `**Option 1 — Fit/scale angle**
\`\`\`
setText body/div:2/section:1/p:1 "From 100,000 to 1M+ square feet"
\`\`\``;
  assert.equal(salvageObject(said), null, "nothing here is the object; ask again");
});

test("nothing at all is not salvaged", () => {
  assert.equal(salvageObject(undefined), null);
  assert.equal(salvageObject(""), null);
  assert.equal(salvageObject("I cannot help with that."), null);
  // Braces that are not the answer.
  assert.equal(salvageObject('Try {"foo": 1} perhaps'), null);
});
