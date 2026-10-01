/**
 * Pasting several lines into a scratch box is ambiguous: one note, or one per
 * line? So the box asks once, and this decides whether there is anything to ask
 * about. Nothing is guessed from punctuation: a line that looks like code is not
 * treated as code, and prose with parentheses is not treated as a snippet.
 */

/**
 * Past this many lines no split is offered. Each note is its own file and its own
 * commit, so splitting a pasted log into two hundred of them would hang the
 * window for as long as that takes, and nobody pasting a log wants that.
 */
export const SPLIT_MAX_LINES = 50;

/**
 * The lines still to add after a split stopped part-way.
 *
 * Notes are added last line first, so a failure after `saved` of them leaves the
 * *first* `lines.length - saved` lines unsaved. Offering the whole list again
 * would save the ones that already exist a second time.
 */
export function remainingAfter(lines: string[], saved: number): string[] {
  return lines.slice(0, Math.max(0, lines.length - saved));
}

/** Line breaks as a textarea holds them, whatever the clipboard used. */
export function normalizePaste(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * The notes a paste would become if the person says to split it, or null when it
 * should simply be one note and nothing needs asking.
 *
 * It is one note when it has fewer than two lines with something on them (blank
 * lines are never notes), when any line opens a code fence, or when every line is
 * indented, which is how a pasted snippet or a block of config arrives. The lines
 * come back trimmed.
 */
export function splitPaste(text: string): string[] | null {
  const raw = normalizePaste(text).split("\n");
  const lines = raw.filter((line) => line.trim() !== "");

  if (lines.length < 2 || lines.length > SPLIT_MAX_LINES) return null;
  if (raw.some((line) => line.trimStart().startsWith("```"))) return null;
  if (lines.every((line) => /^[ \t]/.test(line))) return null;

  return lines.map((line) => line.trim());
}
