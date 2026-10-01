import assert from "node:assert/strict";
import test from "node:test";

import type { ScratchNote } from "todo-vault";
import {
  firstLine,
  matchNotes,
  noteCount,
  selectionAfterRemove,
  shortAge,
  stepNote,
} from "../src/renderer/src/scratch.js";

function note(id: string, text = id): ScratchNote {
  return { id, created: "2026-10-01T12:00:00.000Z", text };
}

const NOW = new Date(2026, 9, 10, 12, 0, 0);
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("a row shows the first line with something on it", () => {
  assert.equal(firstLine("\n  \n  Ask Dana\nsecond line"), "Ask Dana");
});

test("a code fence's opening line is skipped, so a snippet reads as its code", () => {
  assert.equal(firstLine("```sql\nSELECT 1;\n```"), "SELECT 1;");
});

test("a note that is only fences still has something to show", () => {
  assert.equal(firstLine("```\n```"), "```");
});

test("ages are as short as the count column needs", () => {
  assert.equal(shortAge(ago(10_000), NOW), "now");
  assert.equal(shortAge(ago(12 * MINUTE), NOW), "12m");
  assert.equal(shortAge(ago(3 * HOUR), NOW), "3h");
  assert.equal(shortAge(ago(2 * DAY), NOW), "2d");
});

test("a week-old note shows the day it was written", () => {
  assert.equal(shortAge(new Date(2026, 8, 25, 9, 0, 0).toISOString(), NOW), "Sep 25");
});

test("a note from the future is not negative", () => {
  assert.equal(shortAge(new Date(NOW.getTime() + HOUR).toISOString(), NOW), "now");
});

test("the count is singular for one", () => {
  assert.equal(noteCount(1), "1 note");
  assert.equal(noteCount(0), "0 notes");
  assert.equal(noteCount(12), "12 notes");
});

test("every search term has to appear, in any case", () => {
  const notes = [note("a", "Renew the Parking permit"), note("b", "Parking: call the plumber")];

  assert.deepEqual(matchNotes(notes, ["parking"]).map((n) => n.id), ["a", "b"]);
  assert.deepEqual(matchNotes(notes, ["parking", "plumber"]).map((n) => n.id), ["b"]);
  assert.deepEqual(matchNotes(notes, []), [], "no terms is no search, not every note");
});

test("j and k start at the top, step, and hold at the ends", () => {
  const notes = [note("a"), note("b"), note("c")];

  assert.equal(stepNote(notes, null, 1), "a");
  assert.equal(stepNote(notes, null, -1), "a");
  assert.equal(stepNote(notes, "a", 1), "b");
  assert.equal(stepNote(notes, "c", 1), "c");
  assert.equal(stepNote(notes, "a", -1), "a");
  assert.equal(stepNote(notes, "gone", 1), "a", "a stale selection starts over");
  assert.equal(stepNote([], null, 1), null);
});

test("removing a note selects the one that slides up, else the one above, else none", () => {
  const notes = [note("a"), note("b"), note("c")];

  assert.equal(selectionAfterRemove(notes, "a"), "b");
  assert.equal(selectionAfterRemove(notes, "b"), "c");
  assert.equal(selectionAfterRemove(notes, "c"), "b");
  assert.equal(selectionAfterRemove([note("only")], "only"), null);
  assert.equal(selectionAfterRemove(notes, "missing"), null);
});
