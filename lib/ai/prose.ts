/**
 * Recovering from a model that answers in the wrong shape.
 *
 * Kept apart from the pipeline so it can be tested without a database, and
 * because it is the one piece of this that is pure string and object handling.
 *
 * Everything recovered here is still parsed against the request's own strict
 * schema afterwards. That is what makes guessing safe: a repair that guessed
 * wrong fails exactly as an empty answer would, so the worst case is the
 * behaviour we already had.
 */

/**
 * What to add when a model has already answered badly once.
 *
 * Deliberately blunt and placed last, where a system prompt carries most
 * weight. It shows the skeleton rather than describing it, because the failures
 * seen in practice are not refusals to produce JSON — they are JSON of a
 * different shape: options nested inside ops, `op` where the key is `t`, `text`
 * where it is `html`.
 */
export const INSIST_ON_OBJECT =
  "CRITICAL: Your last answer was discarded because it was not the required " +
  "shape. Reply with this exact structure and nothing else — no preamble, no " +
  "markdown, no code fences:\n" +
  '{"options":[{"label":"…","rationale":"…","ops":[{"t":"setText","id":"…","html":"…"}]}]}\n' +
  "`options` is the outer array, one entry per alternative. `ops` is inside " +
  'each option. The operation key is "t", not "op". The replacement copy goes ' +
  'in "html", not "text". Every word you want to say about an option goes in ' +
  "that option's `rationale`.";

/** Keys models reach for instead of the ones the schema declares. */
const OP_ALIASES: Record<string, string> = { op: "t", type: "t", text: "html", content: "html" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rename the keys a model commonly gets wrong, leaving everything else alone. */
function renameOpKeys(op: unknown): unknown {
  if (!isRecord(op)) return op;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(op)) {
    const target = OP_ALIASES[key] ?? key;
    // A real `t` always wins over an aliased one, so a well-formed op is never
    // damaged by an unrelated field that happens to be called `type`.
    if (target in out && key !== target) continue;
    out[target] = value;
  }
  return out;
}

/**
 * Turn "ops, each carrying options" back into "options, each carrying ops".
 *
 * Opus returns this inversion regularly: one entry per block, and inside it the
 * alternative wordings for that block. It is a coherent way to describe the
 * same intent, and it is not the shape the pipeline validates, so it was thrown
 * away as prose along with three perfectly good rewrites.
 *
 * The pivot is by position: the first alternative of every op becomes option
 * one, the second becomes option two, and so on. That is what the nesting
 * means — parallel sets of changes — and it is why the label and rationale of
 * the option are taken from the alternative rather than from the op.
 */
function pivotOpsCarryingOptions(parsed: Record<string, unknown>): unknown[] | null {
  const ops = parsed.ops;
  if (!Array.isArray(ops) || ops.length === 0) return null;

  const nested = ops.filter((op) => isRecord(op) && Array.isArray(op.options));
  if (nested.length !== ops.length) return null;

  const width = Math.max(...nested.map((op) => (op as { options: unknown[] }).options.length));
  if (width === 0) return null;

  const options: unknown[] = [];
  for (let index = 0; index < width; index += 1) {
    const opsForOption: unknown[] = [];
    let label = "";
    let rationale = "";

    for (const op of nested as Record<string, unknown>[]) {
      const alternatives = op.options as unknown[];
      // Fewer alternatives than the widest op: that block simply does not
      // change in this option, which is a legitimate thing for it to mean.
      const alternative = alternatives[index];
      if (!isRecord(alternative)) continue;

      const { options: _drop, ...rest } = op;
      const merged = renameOpKeys({
        ...rest,
        ...(typeof alternative.html === "string" ? { html: alternative.html } : {}),
        ...(typeof alternative.text === "string" ? { html: alternative.text } : {}),
      });
      opsForOption.push(merged);

      if (!label && typeof alternative.label === "string") label = alternative.label;
      if (!rationale && typeof alternative.rationale === "string") {
        rationale = alternative.rationale;
      }
    }

    if (opsForOption.length > 0) {
      options.push({ label: label || `Option ${index + 1}`, rationale, ops: opsForOption });
    }
  }
  return options.length > 0 ? options : null;
}

/**
 * Pull the options out of whatever the model actually returned.
 *
 * Handles the object arriving wrapped in commentary, the keys it reaches for
 * instead of the declared ones, and the inversion above. Returns null when
 * there is nothing recognisable, which means "ask again".
 */
export function salvageObject(text: string | undefined): { options: unknown[] } | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (Array.isArray(parsed.options)) {
    const options = parsed.options.map((option) => {
      if (!isRecord(option) || !Array.isArray(option.ops)) return option;
      return { ...option, ops: option.ops.map(renameOpKeys) };
    });
    return { options };
  }

  const pivoted = pivotOpsCarryingOptions(parsed);
  return pivoted ? { options: pivoted } : null;
}
