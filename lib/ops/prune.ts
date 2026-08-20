/**
 * Dropping ops that can never apply.
 *
 * A `new:` id exists only because some insert op's markup carries it. Remove
 * that insert — by reverting the section it was anchored in, by deleting the
 * fragment, by applying a different AI option over it — and every op written
 * against the blocks it created is left pointing at nothing. They cannot
 * resolve, so every save reports "could not resolve target for setText" and
 * goes on doing so forever, because nothing ever takes them out.
 *
 * That is what happened to the RSRF home page: an FAQ section was added from a
 * template, two of its blocks were edited, and the insert was later dropped
 * while the two setText ops stayed behind.
 */
import { ID_ATTR, type Op } from "./types";
import { isNewId } from "./ids";

/**
 * Every id introduced by markup in this list.
 *
 * Any op carrying html, not just `insert`. `replaceElement` stamps fresh ids
 * onto the markup it swaps in exactly as an insert does, so reading only
 * inserts made every edit to replaced content look like it pointed at nothing —
 * and this function decides what gets deleted, so a gap here is lost work, not
 * a warning.
 *
 * Both quote styles, because the schema accepts whatever markup a model writes
 * even though everything that reaches storage has been through a serialiser
 * that prefers double.
 */
const ID_IN_MARKUP = new RegExp(`${ID_ATTR}=(?:"([^"]+)"|'([^']+)')`, "g");

function introduced(ops: Op[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) {
    const html = (op as { html?: unknown }).html;
    if (typeof html !== "string") continue;
    for (const match of html.matchAll(ID_IN_MARKUP)) ids.add(match[1] ?? match[2]);
  }
  return ids;
}

/**
 * The op list with anything unresolvable taken out.
 *
 * Only `new:` targets are judged. A structural path can be missing for reasons
 * that are none of this function's business — a re-capture that moved it, a
 * page that changed under the version — and dropping a reviewer's work over
 * that would be far worse than a warning. An id that no insert introduces is
 * different: it is not missing, it never existed.
 *
 * Repeated to a fixed point, because an insert can be anchored to a block
 * another insert created: dropping the outer one strands the inner one, and
 * the inner one's blocks in turn.
 */
export function withoutOrphans(ops: Op[]): Op[] {
  let current = ops;

  /*
   * Bounded by the list itself rather than an arbitrary count.
   *
   * Each pass that changes anything removes at least one op, so the list length
   * is a real ceiling — a fixed ten stopped short on a longer chain and left
   * exactly the orphans this exists to remove.
   */
  for (let pass = 0; pass <= ops.length; pass += 1) {
    const known = introduced(current);
    const orphaned = (id: string | undefined) =>
      typeof id === "string" && isNewId(id) && !known.has(id);

    const next = current.filter((op) => {
      if ("id" in op && orphaned(op.id as string)) return false;
      if ("refId" in op && orphaned(op.refId as string)) return false;
      return true;
    });

    if (next.length === current.length) return next;
    current = next;
  }
  return current;
}
