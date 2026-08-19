/**
 * What the editor field should show when new content arrives from outside it.
 *
 * The editor reports every keystroke upward, and what it reports comes back
 * again as the block's current html. Rewriting the field with that echo is
 * where the caret goes: the browser puts it at the start of whatever it is
 * handed, so the typist ends up writing backwards.
 *
 * It only stayed hidden because the echo is usually identical to what is
 * already displayed, and an unchanged value is not written. A space is where it
 * stops being identical — `tidy` trims trailing whitespace and collapses runs
 * of it, so the moment the space bar is pressed the value differs from the
 * field, the field is rewritten, and the caret jumps to the front of the line.
 */
import { tidy } from "./tidy";

/**
 * The text to display, or null to leave the field exactly as it is.
 *
 * `emitted` is what this editor last sent upward. Content equal to it is the
 * round trip of the typist's own work and must not be written back. Anything
 * else — an applied AI suggestion, an edit made in the preview, a different
 * block being selected — is genuinely new and replaces what is shown.
 */
export function nextDraft(
  incoming: string,
  emitted: string | null,
  showHtml: boolean,
): string | null {
  if (emitted !== null && incoming === emitted) return null;
  return showHtml ? incoming : tidy(incoming);
}
