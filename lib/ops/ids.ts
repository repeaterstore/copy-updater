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
 * Stamp ids onto every element in a fragment that lacks one.
 *
 * Must run when an insert/replaceElement op is *created*, never when it is
 * applied: the ids are baked into the op's html string so they stay identical
 * every time the op list is replayed. Minting at apply time would hand the same
 * element a different id on each replay, detaching child versions and comments
 * from the thing they point at.
 */
export function assignNewIds(doc: Document, html: string): string {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  for (const el of Array.from(tpl.content.querySelectorAll("*"))) {
    if (!el.hasAttribute(ID_ATTR)) el.setAttribute(ID_ATTR, mintId());
  }
  return tpl.innerHTML;
}
