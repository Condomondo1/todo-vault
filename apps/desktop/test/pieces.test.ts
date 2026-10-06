import assert from "node:assert/strict";
import test from "node:test";

import type { Item } from "todo-vault";
import { UNASSIGNED, knownPeople, matchesAssignee } from "../src/renderer/src/pieces.js";

/** Enough of an Item for `knownPeople`, which reads only `reporter`/`assignee`. */
function item(reporter?: string, assignee?: string): Item {
  return {
    key: "ACME-1",
    project: "ACME",
    type: "task",
    summary: "x",
    description: "",
    status: "todo",
    priority: "medium",
    labels: [],
    links: [],
    attachments: [],
    comments: [],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    reporter,
    assignee,
  } as unknown as Item;
}

test("offers the most-used spelling of each person", () => {
  const items = [
    item("John Doe"),
    item("john doe"),
    item("john doe"),
    item("Priya Raman"),
  ];
  assert.deepEqual(knownPeople(items, "reporter"), ["john doe", "Priya Raman"]);
});

test("ties break alphabetically", () => {
  const items = [item("Dan Okafor"), item("dan okafor")];
  assert.deepEqual(knownPeople(items, "reporter"), ["dan okafor"]);
});

test("whitespace-only values are ignored, same as missing", () => {
  const items = [item("   "), item("Priya Raman")];
  assert.deepEqual(knownPeople(items, "reporter"), ["Priya Raman"]);
});

test("reads the field it is asked for, and only that one", () => {
  const items = [item("Priya Raman", "Dan Okafor")];
  assert.deepEqual(knownPeople(items, "reporter"), ["Priya Raman"]);
  assert.deepEqual(knownPeople(items, "assignee"), ["Dan Okafor"]);
});

test("returns the same answer for both fields over the same data", () => {
  const forReporter = [item("John Doe"), item("john doe"), item("Priya Raman")];
  const forAssignee = forReporter.map((i) => item(undefined, i.reporter));
  assert.deepEqual(knownPeople(forAssignee, "assignee"), knownPeople(forReporter, "reporter"));
});

test("the assignee filter passes everything on all and matches a folded name", () => {
  const dan = item(undefined, "Dan Okafor");
  assert.equal(matchesAssignee(dan, "all"), true);
  assert.equal(matchesAssignee(dan, "dan okafor"), true);
  assert.equal(matchesAssignee(item(undefined, " DAN OKAFOR "), "dan okafor"), true);
  assert.equal(matchesAssignee(dan, "priya raman"), false);
});

test("the unassigned filter keeps items with no assignee, blank or missing, and nothing else", () => {
  assert.equal(matchesAssignee(item(), UNASSIGNED), true);
  assert.equal(matchesAssignee(item(undefined, "   "), UNASSIGNED), true);
  assert.equal(matchesAssignee(item(undefined, "Dan Okafor"), UNASSIGNED), false);
});

test("a named assignee filter drops unassigned items", () => {
  assert.equal(matchesAssignee(item(), "dan okafor"), false);
});
