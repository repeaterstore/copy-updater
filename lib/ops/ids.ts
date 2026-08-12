import { nanoid } from "nanoid";
import { ID_ATTR } from "./types";

/** Prefix distinguishing ids minted for inserted markup from captured paths. */
export const NEW_ID_PREFIX = "new:";

export function mintId(): string {
  return `${NEW_ID_PREFIX}${nanoid(10)}`;
}

export function isNewId(id: string): boolean {
  return id.startsWith(NEW_ID_PREFIX);
}

/**
 * Stamp a fresh id onto every element in a fragment.
 *
 * Must run when an insert/replaceElement op is *created*, never when it is
 * applied: the ids are baked into the op's html string so they stay identical
 * every time the op list is replayed. Minting at apply time would hand the same
 * element a different id on each replay, detaching child versions and comments
 * from the thing they point at.
 *
 * Ids the caller supplied are overwritten rather than kept. A model writes this
 * markup after being shown the page's own stamped html, and it copies what it
 * is shown — so a "new" paragraph would arrive carrying the id of the paragraph
 * it was modelled on. Two elements then answer to one id: the outline shows the
 * original as the addition, the real one not at all, and every click, edit and
 * highlight lands on whichever the selector finds first.
 *
 * `keep` is the one exception, for a replaceElement that means to stay the
 * block it replaces.
 */
export function assignNewIds(doc: Document, html: string, keep?: string): string {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  for (const el of Array.from(tpl.content.querySelectorAll("*"))) {
    if (keep && el.getAttribute(ID_ATTR) === keep) continue;
    el.setAttribute(ID_ATTR, mintId());
  }
  return tpl.innerHTML;
}
