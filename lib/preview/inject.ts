/**
 * Injects the preview runtime into snapshot HTML when it is served.
 *
 * Deliberately not done at capture time. Baking the runtime into the stored
 * file freezes it with the snapshot, so any fix to the preview — a bug in how
 * ops are applied, a change to diff rendering — would only reach pages captured
 * afterwards, and every existing snapshot would have to be re-captured to pick
 * it up. Injecting on the way out keeps one live copy of the runtime for every
 * snapshot ever taken.
 *
 * Snapshots captured by older builds still contain an embedded runtime, so any
 * previous copy is stripped before the current one is added.
 */

const RUNTIME_MARKER = "data-cu-runtime";
const RUNTIME_TAG = new RegExp(
  `<script[^>]*${RUNTIME_MARKER}[^>]*>[\\s\\S]*?<\\/script>`,
  "gi",
);
const ANY_SCRIPT = /<script\b[\s\S]*?<\/script\s*>/gi;

export function stripRuntime(html: string): string {
  return html.replace(RUNTIME_TAG, "");
}

/**
 * Remove every script from the serialised snapshot.
 *
 * Capture strips scripts from the live DOM, but that cannot be the only
 * defence. `querySelectorAll` does not reach into template content or shadow
 * roots, and some scripts re-insert themselves while the page is being
 * serialised — Cloudflare's challenge script does exactly that. Anything that
 * survives runs inside the preview iframe, where it phones home on every view
 * and can rewrite the DOM out from under the stamped ids.
 *
 * Operating on the serialised string catches all of those, and applies to
 * snapshots captured by older builds without re-capturing them.
 */
export function stripAllScripts(html: string): string {
  return html.replace(ANY_SCRIPT, "");
}

export function injectRuntime(html: string, runtime: string): string {
  // Our own bundled code, but a string literal containing "</script" would
  // still terminate the element early.
  const safe = runtime.replace(/<\/script/gi, "<\\/script");
  const tag = `<script ${RUNTIME_MARKER}>${safe}</script>`;

  // Strip every script, not just a previous runtime: the stored file may still
  // contain third-party scripts that survived capture.
  const clean = stripAllScripts(html);

  const closingBody = clean.lastIndexOf("</body>");
  if (closingBody !== -1) {
    return clean.slice(0, closingBody) + tag + clean.slice(closingBody);
  }
  const closingHtml = clean.lastIndexOf("</html>");
  if (closingHtml !== -1) {
    return clean.slice(0, closingHtml) + tag + clean.slice(closingHtml);
  }
  return clean + tag;
}
