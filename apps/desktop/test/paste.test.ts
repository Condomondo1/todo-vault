import assert from "node:assert/strict";
import test from "node:test";

import { SPLIT_MAX_LINES, normalizePaste, splitPaste } from "../src/renderer/src/paste.js";

test("plain lines are offered as one note each, trimmed", () => {
  assert.deepEqual(splitPaste("Call the plumber\nOrder printer toner \n  Book dentist"), [
    "Call the plumber",
    "Order printer toner",
    "Book dentist",
  ]);
});

test("blank lines are not notes", () => {
  assert.deepEqual(splitPaste("one\n\n   \ntwo\n\n"), ["one", "two"]);
});

test("a single line, however it is padded, needs no question", () => {
  assert.equal(splitPaste("just one thing"), null);
  assert.equal(splitPaste("\n\njust one thing\n\n"), null);
  assert.equal(splitPaste(""), null);
});

test("a fenced block is one note, wherever the fence is", () => {
  assert.equal(splitPaste("```sql\nSELECT 1;\n```"), null);
  assert.equal(splitPaste("Slow tickets:\n```sql\nSELECT 1;\n```"), null);
  assert.equal(splitPaste("one\n  ```\ntwo"), null, "an indented fence still counts");
});

test("text where every line is indented is one note", () => {
  assert.equal(splitPaste("  retry: 3\n  backoff: exponential\n  max_wait: 30s"), null);
  assert.equal(splitPaste("\tone\n\ttwo"), null);
});

test("one unindented line is enough to be a list", () => {
  assert.deepEqual(splitPaste("retry: 3\n  backoff: exponential"), ["retry: 3", "backoff: exponential"]);
});

test("nothing is guessed from punctuation", () => {
  // Code-looking lines are still lines; prose with parentheses is still prose.
  assert.deepEqual(splitPaste("x = foo(1);\ny = bar(2);"), ["x = foo(1);", "y = bar(2);"]);
  assert.deepEqual(splitPaste("Call Dana (re: the audit)\nBook the room {large}"), [
    "Call Dana (re: the audit)",
    "Book the room {large}",
  ]);
});

test("windows line endings split like any other", () => {
  assert.deepEqual(splitPaste("one\r\ntwo\r\nthree"), ["one", "two", "three"]);
  assert.equal(normalizePaste("a\r\nb\rc"), "a\nb\nc");
});

test("a paste too long to split sensibly is left as one note", () => {
  const many = Array.from({ length: SPLIT_MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
  const limit = Array.from({ length: SPLIT_MAX_LINES }, (_, i) => `line ${i}`).join("\n");

  assert.equal(splitPaste(many), null);
  assert.equal(splitPaste(limit)?.length, SPLIT_MAX_LINES);
});
