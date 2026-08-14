/**
 * Recovering from a model that answers in prose.
 *
 * Kept apart from the pipeline so it can be tested without a database, and
 * because it is the one piece of this that is pure string handling.
 */
/**
 * What to add when a model has already answered in prose once.
 *
 * Deliberately blunt and placed last, where a system prompt carries most
 * weight. It names the specific failure rather than restating the schema: the
 * model that wrote `setText body/div:2/…` in a code fence knew the ops, it
 * simply addressed the answer to a human reader.
 */
export const INSIST_ON_OBJECT =
  "CRITICAL: Your last answer was prose and was discarded. Reply with the JSON " +
  "object alone — no preamble, no explanation, no markdown, no code fences, and " +
  "no invented notation. Every word you want to say about an option goes in that " +
  "option's `rationale` field.";

/**
 * Pull an object out of an answer that also contains commentary.
 *
 * Some models return the right thing wrapped in the wrong packaging: a
 * sentence, then a fenced block, then a sign-off. The braces are unambiguous
 * enough to find, and anything recovered is still parsed against the strict
 * schema afterwards, so a wrong guess fails the same way an empty answer does.
 *
 * Returns null rather than guessing wildly: no braces, unbalanced braces, or
 * something that parses to the wrong shape all mean "ask again".
 */
export function salvageObject(text: string | undefined): { options: unknown[] } | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { options?: unknown };
    return Array.isArray(parsed.options) ? { options: parsed.options } : null;
  } catch {
    return null;
  }
}
