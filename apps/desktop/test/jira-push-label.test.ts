import assert from "node:assert/strict";
import test from "node:test";

import type { JiraUpdateView } from "../src/shared/api.js";
import { pushButtonLabel, updateFieldChoices } from "../src/shared/jira-push-label.js";

test("the button says what a press does, leaving out a half with nothing in it", () => {
  assert.equal(pushButtonLabel(3, 0, "ENG"), "Create 3 issues in ENG");
  assert.equal(pushButtonLabel(1, 0, "ENG"), "Create 1 issue in ENG");
  assert.equal(pushButtonLabel(0, 1, "ENG"), "Update 1 issue in ENG");
  assert.equal(pushButtonLabel(0, 2, "ENG"), "Update 2 issues in ENG");
  assert.equal(pushButtonLabel(2, 1, "ENG"), "Create 2 and update 1 in ENG");
  assert.equal(pushButtonLabel(0, 0, "ENG"), "Create 0 issues in ENG");
});

const change = (fieldId: string, editable = true) => ({
  fieldId,
  name: fieldId,
  jiraText: "a",
  vaultText: "b",
  editable,
  ...(editable ? {} : { reason: "locked" }),
});

const view = (localKey: string, changes: JiraUpdateView["changes"]): JiraUpdateView => ({
  localKey,
  summary: localKey,
  jiraKey: `ENG-${localKey.split("-")[1]}`,
  url: "https://acme.atlassian.net/browse/ENG-1",
  changes,
});

test("every editable change goes unless unticked, and a locked one never does", () => {
  const updates = [
    view("ACME-1", [change("summary"), change("duedate"), change("parent", false)]),
    view("ACME-2", [change("summary")]),
    view("ACME-3", []),
  ];
  assert.deepEqual(updateFieldChoices(updates, { "ACME-1": ["duedate"], "ACME-2": ["summary"] }), {
    "ACME-1": ["summary"],
    // Listed with nothing ticked: Jira's values are kept, and the item restamped.
    "ACME-2": [],
    // ACME-3 already matches Jira, which takes "Mark as in sync", not the button.
  });
  assert.deepEqual(updateFieldChoices(updates, {}), { "ACME-1": ["summary", "duedate"], "ACME-2": ["summary"] });
});
