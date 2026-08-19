/**
 * A block's markup with the source page's own line breaks and indentation
 * taken out.
 *
 * A captured block keeps the whitespace it was written with — a heading is
 * routinely `"\n              Turn-Key DAS Solutions v3\n            "` — and
 * a browser collapses all of that when it renders, which is why the block
 * reads tight on the page. An editor does not: it shows every character, so
 * the copy appeared two blank lines down and fourteen spaces in.
 *
 * Collapsing runs of whitespace is what the renderer does anyway, so nothing
 * about the block changes — except inside `<pre>`, where the whitespace is the
 * content, so that is left exactly as captured.
 *
 * Applied when content *arrives*, never to what someone is typing: it trims,
 * and trimming a trailing space out from under the caret is how the caret ends
 * up somewhere else.
 */
export function tidy(html: string): string {
  if (/<pre[\s>]/i.test(html)) return html;
  return html.replace(/\s+/g, " ").trim();
}
