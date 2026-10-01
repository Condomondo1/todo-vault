import assert from "node:assert/strict";
import test from "node:test";

import { SUMMARY_MAX, guessType, prefill } from "../src/renderer/src/promote.js";

/** A first line made of numbered words, so a cut is easy to read back. */
function longLine(words: number): string {
  return Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
}

test("the first line is the summary and the rest is the description", () => {
  const p = prefill("Ask Dana about the questionnaire\nrepro: curl -i localhost\nmore detail");

  assert.equal(p.summary, "Ask Dana about the questionnaire");
  assert.equal(p.description, "repro: curl -i localhost\nmore detail");
  assert.equal(p.cut, false);
});

test("leading blank lines are skipped and a single line leaves no description", () => {
  const p = prefill("\n\n  Renew the parking permit  \n");

  assert.equal(p.summary, "Renew the parking permit");
  assert.equal(p.description, "");
});

test("a note that opens with a fence keeps its whole text as the description", () => {
  const text = "```sql\nSELECT owner FROM tickets;\n```";
  const p = prefill(text);

  assert.equal(p.summary, "SELECT owner FROM tickets;");
  assert.equal(p.description, text, "splitting the line out would leave an unbalanced fence");
});

test("a fenced first code line over the limit is cut without printing its tail twice", () => {
  const text = `\`\`\`sql\n${longLine(60)}\n\`\`\``;

  const p = prefill(text);

  assert.ok(p.summary.length <= SUMMARY_MAX);
  assert.equal(p.cut, true);
  assert.equal(p.description, text, "the whole note, once: the long line is already in it");
});

test("an empty note has nothing to propose", () => {
  assert.deepEqual(prefill("  \n\n"), { type: "task", summary: "", description: "", cut: false });
});

test("a summary at the limit is left alone", () => {
  const exact = "x".repeat(SUMMARY_MAX);

  assert.equal(prefill(exact).summary, exact);
  assert.equal(prefill(exact).cut, false);
});

test("a long first line is cut at a word boundary and the overflow leads the description", () => {
  const line = longLine(60);
  assert.ok(line.length > SUMMARY_MAX);

  const p = prefill(line);

  assert.ok(p.summary.length <= SUMMARY_MAX);
  assert.ok(!p.summary.endsWith(" "));
  assert.match(p.summary, /word\d+$/, "ends on a whole word");
  assert.equal(p.cut, true);
  assert.ok(p.description.startsWith("…word"));
  assert.equal(`${p.summary} ${p.description.slice(1)}`, line, "nothing is dropped");
});

test("overflow goes ahead of the remaining lines", () => {
  const p = prefill(`${longLine(60)}\nsecond line`);

  assert.ok(p.description.startsWith("…"));
  assert.ok(p.description.endsWith("\n\nsecond line"));
});

test("a long line with no space near the limit is cut at the limit", () => {
  const url = `https://example.com/${"a".repeat(400)}`;

  const p = prefill(url);

  assert.equal(p.summary.length, SUMMARY_MAX);
  assert.equal(`${p.summary}${p.description.slice(1)}`, url);
});

test("strong bug words make a bug, whatever the case", () => {
  for (const text of [
    "Login crashes on an empty password",
    "Rate limiter is BROKEN on 429s",
    "Unhandled exception in the importer",
    "Regression in the export",
    "The nightly job failed again",
    "Error 500 from the API",
    "Found a bug in the calendar",
  ]) {
    assert.equal(guessType(text), "bug", text);
  }
});

test("anything else is a task, and a bug word inside another word is not a bug", () => {
  for (const text of [
    "Renew the parking permit",
    "idea: show scratch notes in the agenda",
    "Call the debugger vendor",
    "Terror of the deep",
    "Email about the failure-free rollout plan",
  ]) {
    assert.equal(guessType(text), "task", text);
  }
});

test("a guess is never a story or an epic", () => {
  for (const text of ["epic: rebuild everything", "As a user I want a story", "Plan the roadmap"]) {
    assert.ok(["bug", "task"].includes(prefill(text).type));
  }
});
