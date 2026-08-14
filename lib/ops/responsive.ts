/**
 * Hiding copy on one screen size, using the classes the site already has.
 *
 * This used to invent two classes of its own and carry a stylesheet to define
 * them. That worked in the preview and exported as markup referencing classes
 * nothing on the real site defines — a change a developer had to translate
 * before they could implement it.
 *
 * Sites do not agree on how to say it, and three of ours disagree with each
 * other. The RSRF site is Tailwind with a bespoke `desktop:` breakpoint;
 * waveform.com is Tailwind with `md:` *and* a layer of older utilities; the
 * bufferbloat page carries `hidden-sm` and `hide-if-small` from a previous
 * theme. So the convention is read out of each snapshot's own stylesheet
 * rather than assumed, and where a page has no such convention the control is
 * not offered at all — better no button than one that silently does nothing.
 */

export interface ResponsiveRecipe {
  id: string;
  /** Named for the person who has to implement it. */
  label: string;
  /** Classes that leave a block visible only on wide screens. */
  desktopOnly: string[];
  /** Classes that leave a block visible only on narrow screens. */
  mobileOnly: string[];
}

/**
 * Every class a recipe depends on. All of them must be defined in the page's
 * own CSS, because a site can easily define `md:hidden` and not `md:block`.
 */
function required(recipe: ResponsiveRecipe): string[] {
  return [...new Set([...recipe.desktopOnly, ...recipe.mobileOnly])];
}

/**
 * Tailwind, at whichever breakpoint the site actually uses.
 *
 * Ordered by how well the breakpoint matches "phone versus everything else":
 * `md` is the conventional split and comes first, then a project's own named
 * breakpoint, then the neighbours. The first that is fully defined wins.
 */
const TAILWIND_PREFIXES = ["md", "desktop", "lg", "sm", "tablet"];

const TAILWIND: ResponsiveRecipe[] = TAILWIND_PREFIXES.map((prefix) => ({
  id: `tailwind-${prefix}`,
  label: `Tailwind (${prefix})`,
  // Hidden by default, shown from the breakpoint up — which is also the
  // mobile-first order Tailwind expects them written in.
  desktopOnly: ["hidden", `${prefix}:block`],
  mobileOnly: [`${prefix}:hidden`],
}));

const OTHERS: ResponsiveRecipe[] = [
  {
    id: "bootstrap5",
    label: "Bootstrap 5",
    desktopOnly: ["d-none", "d-md-block"],
    mobileOnly: ["d-md-none"],
  },
  {
    id: "bootstrap3",
    label: "Bootstrap 3/4",
    desktopOnly: ["hidden-xs"],
    mobileOnly: ["visible-xs-block"],
  },
  {
    id: "foundation",
    label: "Foundation",
    desktopOnly: ["show-for-medium"],
    mobileOnly: ["hide-for-medium"],
  },
  {
    id: "bulma",
    label: "Bulma",
    desktopOnly: ["is-hidden-mobile"],
    mobileOnly: ["is-hidden-tablet"],
  },
  {
    id: "shopify-slate",
    label: "Shopify (slate)",
    desktopOnly: ["small--hide"],
    mobileOnly: ["medium-up--hide"],
  },
];

export const RECIPES: ResponsiveRecipe[] = [...TAILWIND, ...OTHERS];

/**
 * The convention this page uses, or null if it has none.
 *
 * `defined` is every class the page's stylesheets define a rule for, with
 * Tailwind's escaping already undone — `.md\:block` in the CSS is `md:block`
 * here. `used` is what the markup actually puts on elements.
 *
 * Both matter, and usage decides. A Tailwind build ships every breakpoint
 * whether the site touches it or not, so "defined" alone picks `md:` for
 * everyone: correct CSS, and on the RSRF site the wrong answer, because that
 * team writes `desktop:hidden` throughout and a change written in `md:` would
 * arrive in a different dialect from the code around it. A convention already
 * on the page is evidence of intent; one merely compiled into the bundle is
 * not.
 */
export function detectRecipe(
  defined: Set<string>,
  used: Set<string> = new Set(),
): ResponsiveRecipe | null {
  const complete = RECIPES.filter((recipe) => required(recipe).every((c) => defined.has(c)));

  /*
   * Judged on the classes that tell the candidates apart.
   *
   * Every Tailwind recipe shares the bare `hidden`, so asking whether *any* of
   * a recipe's classes are in use matches all of them and the first wins —
   * which is the bug this replaces. What distinguishes them is the
   * breakpoint-prefixed half.
   */
  const counts = new Map<string, number>();
  for (const recipe of complete) {
    for (const c of required(recipe)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const distinguishing = (recipe: ResponsiveRecipe) =>
    required(recipe).filter((c) => (counts.get(c) ?? 0) === 1);

  return (
    complete.find((recipe) => distinguishing(recipe).some((c) => used.has(c))) ??
    complete[0] ??
    null
  );
}

export type Visibility = "both" | "desktop" | "mobile";

/** Which of a recipe's states a set of classes currently expresses. */
export function visibilityOf(classes: string[], recipe: ResponsiveRecipe | null): Visibility {
  const has = (needed: string[]) => needed.length > 0 && needed.every((c) => classes.includes(c));
  if (recipe) {
    // Mobile first: a block carrying both — which nothing here writes, but a
    // hand-edit could — is hidden everywhere, and saying "mobile" at least
    // names one of the reasons.
    if (has(recipe.mobileOnly)) return "mobile";
    if (has(recipe.desktopOnly)) return "desktop";
  }
  // Versions written before the site's own classes were used carry these.
  if (classes.includes("cu-only-mobile")) return "mobile";
  if (classes.includes("cu-only-desktop")) return "desktop";
  return "both";
}

/**
 * The class list for a block set to one device.
 *
 * Only this page's own recipe is added or removed, plus the two classes older
 * versions carry. Clearing every convention's classes was tempting for
 * tidiness and wrong: `hidden`, `d-none` and the rest are ordinary utilities
 * that mean something on the sites that define them, and a control for
 * screen size has no business stripping a class it did not put there.
 *
 * Note that this reads and writes the page's *real* responsive state. A block
 * the site already ships as `hidden md:block` reads as desktop-only, and
 * setting it back to "both" removes those classes — which is exactly the
 * change "show this on mobile too" means.
 */
export function applyVisibility(
  classes: string[],
  recipe: ResponsiveRecipe,
  mode: Visibility,
): string[] {
  const ours = new Set([
    "cu-only-desktop",
    "cu-only-mobile",
    ...recipe.desktopOnly,
    ...recipe.mobileOnly,
  ]);
  const kept = classes.filter((c) => !ours.has(c));
  if (mode === "both") return kept;
  return [...kept, ...(mode === "desktop" ? recipe.desktopOnly : recipe.mobileOnly)];
}
