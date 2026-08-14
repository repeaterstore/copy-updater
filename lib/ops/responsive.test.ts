import test from "node:test";
import assert from "node:assert/strict";
import { applyVisibility, detectRecipe, inlineClassesFor, visibilityOf } from "./responsive";

/** What each real site's stylesheet defines, from capturing them. */
const WAVEFORM = new Set(["hidden", "md:block", "md:hidden", "sm:hidden", "sm:block", "hidden-xs"]);
// A Tailwind build ships every breakpoint, so `md:` is defined here too — the
// site simply does not use it.
const RSRF = new Set(["hidden", "desktop:block", "desktop:hidden", "md:block", "md:hidden"]);
const RSRF_USED = new Set(["hidden", "desktop:block", "desktop:hidden"]);
const BOOTSTRAP = new Set(["d-none", "d-md-block", "d-md-none"]);
const PLAIN = new Set(["container", "btn", "header"]);

test("waveform resolves to Tailwind at the conventional breakpoint", () => {
  const recipe = detectRecipe(WAVEFORM);
  assert.equal(recipe?.id, "tailwind-md");
  assert.deepEqual(recipe?.desktopOnly, ["hidden", "md:block"]);
  assert.deepEqual(recipe?.mobileOnly, ["md:hidden"]);
});

test("a site with its own breakpoint name is written in that breakpoint", () => {
  // Defined-only would say `md:` here, which is valid CSS and the wrong
  // dialect: this team writes `desktop:` and the change has to read like the
  // code around it.
  assert.equal(detectRecipe(RSRF)?.id, "tailwind-md", "what the bundle defines");
  const recipe = detectRecipe(RSRF, RSRF_USED);
  assert.equal(recipe?.id, "tailwind-desktop", "what the site actually writes");
  assert.deepEqual(recipe?.mobileOnly, ["desktop:hidden"]);
});

test("other frameworks are recognised", () => {
  assert.equal(detectRecipe(BOOTSTRAP)?.id, "bootstrap5");
});

test("a page with no convention gets no recipe, and so no control", () => {
  assert.equal(detectRecipe(PLAIN), null);
  assert.equal(detectRecipe(new Set()), null);
});

test("the control reads the page's real state, including what the site shipped", () => {
  const recipe = detectRecipe(WAVEFORM)!;
  // A block the site already ships as desktop-only reads as desktop-only.
  assert.equal(visibilityOf(["hidden", "md:block", "px-4"], recipe), "desktop");
  assert.equal(visibilityOf(["md:hidden"], recipe), "mobile");
  assert.equal(visibilityOf(["px-4"], recipe), "both");
  // Versions written before this carried the tool's own classes.
  assert.equal(visibilityOf(["cu-only-mobile"], recipe), "mobile");
  assert.equal(visibilityOf(["cu-only-desktop"], null), "desktop");
});

test("switching states never leaves two contradictory rules on one element", () => {
  const recipe = detectRecipe(WAVEFORM)!;
  const desktop = applyVisibility(["px-4", "text-lg"], recipe, "desktop");
  assert.deepEqual(desktop, ["px-4", "text-lg", "hidden", "md:block"]);

  const mobile = applyVisibility(desktop, recipe, "mobile");
  assert.deepEqual(mobile, ["px-4", "text-lg", "md:hidden"]);

  const both = applyVisibility(mobile, recipe, "both");
  assert.deepEqual(both, ["px-4", "text-lg"], "back to the page's own classes");
});

test("classes this tool did not add are left alone", () => {
  const recipe = detectRecipe(BOOTSTRAP)!;
  // `hidden` means something on plenty of sites; a screen-size control has no
  // business stripping a utility from another framework it never wrote.
  const out = applyVisibility(["hidden", "custom-thing"], recipe, "mobile");
  assert.ok(out.includes("hidden"));
  assert.ok(out.includes("custom-thing"));
  assert.ok(out.includes("d-md-none"));
});

test("the recipe survives a round trip through a site that ships every breakpoint", () => {
  // A Tailwind build defines md:, lg: and sm: whether or not the site writes
  // them. Usage is what decides, and it is judged on the classes that tell the
  // candidates apart — not the bare `hidden` they all share.
  const defined = new Set(["hidden", "md:block", "md:hidden", "lg:block", "lg:hidden"]);
  assert.equal(detectRecipe(defined, new Set(["hidden", "lg:hidden"]))?.id, "tailwind-lg");
  assert.equal(detectRecipe(defined, new Set(["hidden", "md:hidden"]))?.id, "tailwind-md");
  // `hidden` alone says nothing about which breakpoint the site favours.
  assert.equal(detectRecipe(defined, new Set(["hidden"]))?.id, "tailwind-md");
});

test("hiding part of a sentence uses the inline form, not the block one", () => {
  const defined = new Set(["hidden", "md:block", "md:hidden", "md:inline"]);
  const recipe = detectRecipe(defined)!;

  // `md:block` on a span mid-paragraph puts those words on their own line.
  // The inline form says the same thing without breaking the sentence.
  assert.deepEqual(inlineClassesFor(recipe, "desktop", defined), ["hidden", "md:inline"]);
  // Hiding on desktop needs nothing special: display:none is display:none.
  assert.deepEqual(inlineClassesFor(recipe, "mobile", defined), ["md:hidden"]);
});

test("a page that defines md:block but not md:inline gets no inline control", () => {
  const defined = new Set(["hidden", "md:block", "md:hidden"]);
  const recipe = detectRecipe(defined)!;
  assert.equal(recipe.id, "tailwind-md", "the block-level control still works");
  assert.equal(inlineClassesFor(recipe, "desktop", defined), null);
  // The other direction needs no extra class, so it survives.
  assert.deepEqual(inlineClassesFor(recipe, "mobile", defined), ["md:hidden"]);
});

test("frameworks that hide without forcing a display work inline as they are", () => {
  const bulma = new Set(["is-hidden-mobile", "is-hidden-tablet"]);
  const recipe = detectRecipe(bulma)!;
  assert.equal(recipe.id, "bulma");
  assert.deepEqual(inlineClassesFor(recipe, "desktop", bulma), ["is-hidden-mobile"]);
});

test("no recipe means no inline control either", () => {
  assert.equal(inlineClassesFor(null, "desktop", new Set(["md:inline"])), null);
});
