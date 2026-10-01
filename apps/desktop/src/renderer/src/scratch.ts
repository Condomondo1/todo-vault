import type { ScratchNote } from "todo-vault";

/** How many of the newest notes the sidebar section lists before "More…". */
export const SIDEBAR_NOTES = 5;

/**
 * The line a one-line row shows for a note: the first one with something on it,
 * skipping a code fence's own opening line so a pasted snippet reads as its
 * first line of code rather than as "```sql".
 */
export function firstLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim());
  return lines.find((line) => line && !line.startsWith("```")) ?? lines.find(Boolean) ?? "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * How long ago a note was jotted down, as short as the sidebar's count column
 * needs: "now", "12m", "3h", "2d", then a date once it is a week old. Local
 * time for the date, since that is the day the person remembers writing it.
 */
export function shortAge(created: string, now: Date = new Date()): string {
  const then = new Date(created);
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return `${MONTHS[then.getMonth()]} ${then.getDate()}`;
}

/** "1 note" or "12 notes". */
export function noteCount(count: number): string {
  return `${count} ${count === 1 ? "note" : "notes"}`;
}

/**
 * Notes whose text contains every term, case-insensitively — the same rule the
 * command palette uses for items, so a second word always narrows.
 */
export function matchNotes(notes: ScratchNote[], terms: string[]): ScratchNote[] {
  if (terms.length === 0) return [];
  return notes.filter((note) => {
    const haystack = note.text.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * The note `j` or `k` lands on. With nothing selected either key starts at the
 * top, and the ends hold rather than wrap — the same cursor the item views have.
 */
export function stepNote(notes: ScratchNote[], selectedId: string | null, delta: number): string | null {
  if (notes.length === 0) return null;
  const at = notes.findIndex((note) => note.id === selectedId);
  if (at < 0) return notes[0].id;
  return notes[Math.max(0, Math.min(notes.length - 1, at + delta))].id;
}

/**
 * Where the selection goes when a note is removed: the one that slides into its
 * place, else the one above it, else nothing. `x` does the same in the backlog.
 */
export function selectionAfterRemove(notes: ScratchNote[], removedId: string): string | null {
  const at = notes.findIndex((note) => note.id === removedId);
  if (at < 0) return null;
  return (notes[at + 1] ?? notes[at - 1])?.id ?? null;
}
