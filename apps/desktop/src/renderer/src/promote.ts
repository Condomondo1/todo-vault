/**
 * What a scratch note becomes when it is promoted: a first guess at the item's
 * type, summary and description, from the note's text alone. Pure, so the rules
 * can be tested without a window.
 *
 * Everything here is a proposal. The panel shows it in the form and the person
 * edits it before Create; nothing is sent anywhere, and no network call is made.
 */

/** The vault's summary limit (schema.ts). A longer one is refused, so it is cut. */
export const SUMMARY_MAX = 255;

/**
 * Cut here only if the last space is this close to the limit; a first line with
 * no space near 255 (a URL, say) is cut at the limit itself.
 */
const WORD_BOUNDARY_FLOOR = 200;

/**
 * `bug` only on strong words, otherwise `task`, and never `story` or `epic`.
 * Calling a note a story on a guess would file work under the wrong shape and
 * look deliberate; a task is the safe thing to be wrong about.
 */
const BUG_WORDS = /\b(bug|bugs|crash(?:es|ed|ing)?|broken|exception|regression|fail(?:s|ed|ing)?|error)\b/i;

export function guessType(text: string): "bug" | "task" {
  return BUG_WORDS.test(text) ? "bug" : "task";
}

export interface Prefill {
  type: "bug" | "task";
  summary: string;
  description: string;
  /** True when the first line was longer than the limit and had to be cut. */
  cut: boolean;
}

/**
 * The summary is the first line with something on it, skipping a code fence's
 * opening line; the description is whatever the summary leaves behind.
 *
 * Two cases keep text from being lost or mangled:
 * - A first line over 255 characters is cut near a word boundary and the rest
 *   goes to the top of the description, after an ellipsis, never dropped.
 * - A note that opens with a fence keeps its whole text as the description. The
 *   summary is then the first line of code, and splitting that line out would
 *   leave an unbalanced fence behind. That text already holds the whole line,
 *   so a cut summary needs no overflow ahead of it: adding one would print the
 *   tail twice.
 */
export function prefill(text: string): Prefill {
  const lines = text.split("\n");
  const firstReal = lines.findIndex((line) => line.trim() !== "");
  if (firstReal < 0) return { type: "task", summary: "", description: "", cut: false };

  const fenced = lines[firstReal].trim().startsWith("```");
  const at = fenced
    ? lines.findIndex((line, i) => i > firstReal && line.trim() !== "" && !line.trim().startsWith("```"))
    : firstReal;
  const summaryLine = (at >= 0 ? lines[at] : lines[firstReal]).trim();

  let summary = summaryLine;
  let overflow = "";
  if (summaryLine.length > SUMMARY_MAX) {
    const space = summaryLine.lastIndexOf(" ", SUMMARY_MAX);
    const cutAt = space > WORD_BOUNDARY_FLOOR ? space : SUMMARY_MAX;
    summary = summaryLine.slice(0, cutAt).trim();
    overflow = `…${summaryLine.slice(cutAt).trim()}`;
  }

  const remaining = fenced
    ? text.trim()
    : lines
        .filter((_, i) => i !== firstReal)
        .join("\n")
        .trim();

  return {
    type: guessType(text),
    summary,
    description: fenced ? remaining : [overflow, remaining].filter(Boolean).join("\n\n"),
    cut: overflow !== "",
  };
}
