import assert from "node:assert/strict";
import test from "node:test";

import type { Item } from "todo-vault";
import {
  canCreate,
  initialValues,
  reseed,
  toInput,
  validParent,
  type ItemFormValues,
} from "../src/renderer/src/item-form.js";

const PROJECTS = [{ key: "ACME" }, { key: "OPS" }];

function item(key: string, project: string, type: Item["type"]): Item {
  return { key, project, type, summary: key } as Item;
}

const ITEMS = [
  item("ACME-1", "ACME", "epic"),
  item("ACME-2", "ACME", "task"),
  item("OPS-1", "OPS", "epic"),
];

function filled(over: Partial<ItemFormValues> = {}): ItemFormValues {
  return { ...initialValues(PROJECTS), summary: "Do it", assignee: "Grace", ...over };
}

test("the form opens on the first project as a task, with everything else empty", () => {
  const v = initialValues(PROJECTS);

  assert.equal(v.project, "ACME");
  assert.equal(v.type, "task");
  assert.equal(v.priority, "medium");
  assert.equal(v.cadence, "none");
  assert.deepEqual(
    [v.summary, v.parent, v.dueDate, v.category, v.labels, v.reporter, v.assignee],
    ["", "", "", "", "", "", ""],
  );
});

test("a seed overrides the project, type and parent it names", () => {
  const v = initialValues(PROJECTS, { project: "OPS", type: "subtask", parent: "OPS-2" });

  assert.deepEqual([v.project, v.type, v.parent], ["OPS", "subtask", "OPS-2"]);
});

test("with no projects the project is empty, which keeps toInput from producing a payload", () => {
  assert.equal(toInput({ ...initialValues([]), summary: "Orphan" }), null);
});

test("toInput trims, drops empties and splits labels on commas", () => {
  const input = toInput(
    filled({
      summary: "  Trim me  ",
      description: "  body\n",
      category: "  ops ",
      labels: "alpha, , beta ,",
      reporter: "  Ada ",
      assignee: "  Grace ",
      dueDate: "",
      parent: "",
    }),
  );

  assert.deepEqual(input, {
    project: "ACME",
    type: "task",
    summary: "Trim me",
    description: "body",
    priority: "medium",
    parent: undefined,
    dueDate: undefined,
    category: "ops",
    labels: ["alpha", "beta"],
    cadence: "none",
    reporter: "Ada",
    assignee: "Grace",
  });
});

test("a blank assignee yields no payload and keeps Create off, so Enter cannot send it either", () => {
  assert.equal(toInput(filled({ assignee: "" })), null);
  assert.equal(toInput(filled({ assignee: "   " })), null);
  assert.equal(canCreate(filled({ assignee: "   " }), false), false);
});

test("a blank summary yields no payload", () => {
  assert.equal(toInput(filled({ summary: "   " })), null);
});

test("Create stays off for a parentless subtask, though toInput still builds its payload", () => {
  // The button is greyed to save a round trip, but Enter in the summary has
  // always sent the form and shown the vault's own refusal — so the two rules
  // are not the same rule.
  const v = filled({ type: "subtask", parent: "" });

  assert.equal(canCreate(v, false), false);
  assert.notEqual(toInput(v), null);
});

test("Create is off while saving, and on for a summarised task", () => {
  assert.equal(canCreate(filled(), false), true);
  assert.equal(canCreate(filled(), true), false);
});

test("a parent the hierarchy does not allow is dropped", () => {
  assert.equal(validParent(ITEMS, "ACME", "task", "ACME-1"), "ACME-1");
  assert.equal(validParent(ITEMS, "ACME", "subtask", "ACME-1"), "", "an epic cannot parent a subtask");
  assert.equal(validParent(ITEMS, "ACME", "task", "OPS-1"), "", "another project's epic is not a choice");
  assert.equal(validParent(ITEMS, "ACME", "epic", "ACME-1"), "", "epics sit at the top");
});

test("reseeding keeps project, parent and category and replaces type, summary and description", () => {
  const before = filled({
    project: "ACME",
    parent: "ACME-1",
    category: "reporting",
    type: "task",
    summary: "Old",
    description: "old body",
    priority: "high",
    dueDate: "2031-01-01",
    labels: "x",
    cadence: "weekly",
    reporter: "Ada",
  });

  const after = reseed(before, { type: "bug", summary: "New", description: "new body" }, PROJECTS, ITEMS);

  assert.deepEqual([after.project, after.parent, after.category], ["ACME", "ACME-1", "reporting"]);
  assert.deepEqual([after.type, after.summary, after.description], ["bug", "New", "new body"]);
});

test("reseeding sends the fields that are not sticky back to their defaults", () => {
  const before = filled({
    priority: "high",
    dueDate: "2031-01-01",
    labels: "x",
    cadence: "weekly",
    reporter: "Ada",
    assignee: "Grace",
  });

  const after = reseed(before, { summary: "Next" }, PROJECTS, ITEMS);

  assert.equal(after.priority, "medium");
  assert.equal(after.dueDate, "");
  assert.equal(after.labels, "");
  assert.equal(after.cadence, "none");
  assert.equal(after.reporter, "");
  assert.equal(after.assignee, "");
});

test("a sticky parent is checked again against the next note's type", () => {
  const before = filled({ parent: "ACME-1" });

  const asSubtask = reseed(before, { type: "subtask", summary: "Next" }, PROJECTS, ITEMS);
  const asEpic = reseed(before, { type: "epic", summary: "Next" }, PROJECTS, ITEMS);

  assert.equal(asSubtask.parent, "", "an epic is no parent for a subtask");
  assert.equal(asEpic.parent, "", "an epic takes no parent");
  assert.equal(asSubtask.project, "ACME", "the project still sticks when the parent does not");
});

test("a project that has gone falls back to the first one, and its parent with it", () => {
  const before = filled({ project: "OPS", parent: "OPS-1" });

  const after = reseed(before, { summary: "Next" }, [{ key: "ACME" }], ITEMS);

  assert.equal(after.project, "ACME");
  assert.equal(after.parent, "");
});

test("the type of a reseeded note defaults to task when the note names none", () => {
  const after = reseed(filled({ type: "bug" }), { summary: "Next" }, PROJECTS, ITEMS);

  assert.equal(after.type, "task");
});
