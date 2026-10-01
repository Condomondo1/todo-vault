import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { markdownToAdf } from "../src/jira-adf.js";
import { createJiraClient } from "../src/jira-client.js";
import { buildPushPlan, buildUpdatePlan, JiraMapSchema, type JiraIssueUpdate, type JiraMap } from "../src/jira.js";
import type { JiraFieldMeta } from "../src/jira-meta.js";
import { diffIssue, readIssueState, sendUpdates, type IssueState } from "../src/jira-update.js";
import { Vault } from "../src/vault.js";
import { fakeFetch, type Reply } from "./jira-fake-fetch.js";

const SITE = "https://acme.atlassian.net";

async function tmpVault(): Promise<Vault> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jira-update-test-"));
  const vault = await Vault.init(dir);
  await vault.createProject({ key: "ACME", name: "Acme rollout" });
  return vault;
}

function map(over: Record<string, unknown> = {}): JiraMap {
  return JiraMapSchema.parse({ jiraProjectKey: "ENG", issueTypes: {}, ...over });
}

function editField(fieldId: string, over: Partial<JiraFieldMeta> = {}): JiraFieldMeta {
  return { fieldId, name: fieldId, required: false, hasDefaultValue: false, schema: { type: "string" }, operations: ["set"], ...over };
}

/** Every field the vault fills, editable, as a plain edit screen would have them. */
function editScreen(...extra: JiraFieldMeta[]): Record<string, JiraFieldMeta> {
  const names: Record<string, string> = {
    summary: "Summary",
    description: "Description",
    priority: "Priority",
    labels: "Labels",
    components: "Components",
    assignee: "Assignee",
    duedate: "Due date",
    parent: "Parent",
  };
  const fields = Object.entries(names).map(([id, name]) => editField(id, { name }));
  return Object.fromEntries([...fields, ...extra].map((f) => [f.fieldId, f]));
}

async function items(vault: Vault) {
  return vault.listItems({ limit: 500 }).items;
}

/** An item pushed as ENG-7 with the vault's fields as Jira now holds them, then edited. */
async function pushedThenEdited(vault: Vault, m: JiraMap) {
  const item = await vault.createItem({
    project: "ACME",
    summary: "Email the invoice",
    priority: "high",
    labels: ["billing", "q4"],
    dueDate: "2026-10-01",
  });
  const jiraFields = { ...buildPushPlan([item], m, vault).drafts[0].fields };
  await vault.markPushed(item.key, "ENG-7", "10070");
  return { item, jiraFields };
}

// -------------------------------------------------------------- the plan

test("only items changed since their push are planned, with the item's own fields and no extras", async () => {
  const vault = await tmpVault();
  const m = map({ extraFields: { customfield_1: { mode: "always", value: "team" } } });
  const settled = await vault.createItem({ project: "ACME", summary: "Settled" });
  const never = await vault.createItem({ project: "ACME", summary: "Never pushed" });
  const { item } = await pushedThenEdited(vault, m);
  await vault.markPushed(settled.key, "ENG-1");
  await vault.updateItem(item.key, { summary: "Email the final invoice" });

  const plan = buildUpdatePlan(await items(vault), m, vault);
  assert.deepEqual(plan.updates.map((u) => u.localKey), [item.key], `${settled.key} is unchanged and ${never.key} is a create`);
  const update = plan.updates[0];
  assert.equal(update.jiraKey, "ENG-7");
  assert.equal(update.jiraId, "10070", "carried so the restamp keeps it");
  assert.equal(update.fields.summary, "Email the final invoice");
  assert.equal("customfield_1" in update.fields, false, "extra fields are set at create, not updated");
  assert.equal("project" in update.fields || "issuetype" in update.fields, false);
});

test("what the item no longer has is cleared, but priority and an unmapped assignee are left alone", async () => {
  const vault = await tmpVault();
  const m = map({ priorities: { high: "High" } });
  const { item } = await pushedThenEdited(vault, m);
  await vault.updateItem(item.key, { dueDate: null, labels: [], assignee: "Nobody Mapped" } as never);

  const fields = buildUpdatePlan(await items(vault), m, vault).updates[0].fields;
  assert.equal(fields.duedate, null);
  assert.deepEqual(fields.labels, []);
  assert.equal("assignee" in fields, false, "a name with no account is not an instruction to unassign");
  assert.equal(fields.parent, null);
});

// -------------------------------------------------------------- the diff

function update(fields: Record<string, unknown>, over: Partial<JiraIssueUpdate> = {}): JiraIssueUpdate {
  return { localKey: "ACME-1", jiraKey: "ENG-7", issueType: "Story", fields, typed: [], ...over };
}

function state(fields: Record<string, unknown>, editable = editScreen()): IssueState {
  return { fields: { issuetype: { name: "Story" }, ...fields }, editable };
}

test("fields Jira already holds, in its own fuller shape, are not offered", () => {
  const ours = {
    summary: "Email the invoice",
    description: markdownToAdf("Send it **today**."),
    priority: { name: "High" },
    labels: ["billing", "q4"],
    components: [{ name: "Web" }],
    assignee: { accountId: "acc-1" },
    duedate: "2026-10-01",
  };
  // Jira hands values back with ids and attributes it added: a localId on a
  // paragraph, an icon on a priority, labels in its own order.
  const theirs = {
    summary: "Email the invoice",
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          attrs: { localId: "abc" },
          content: [{ type: "text", text: "Send it " }, { type: "text", text: "today", marks: [{ type: "strong" }] }, { type: "text", text: "." }],
        },
      ],
    },
    priority: { id: "2", name: "high", iconUrl: "x" },
    labels: ["q4", "billing"],
    components: [{ id: "100", name: "Web" }],
    assignee: { accountId: "acc-1", displayName: "Dan Okafor" },
    duedate: "2026-10-01",
  };
  assert.deepEqual(diffIssue(update(ours), state(theirs)).changes, []);
});

test("a differing field is offered as Jira now against the vault, by name", () => {
  const diff = diffIssue(
    update({ summary: "Email the final invoice", assignee: { accountId: "acc-2" }, duedate: null }),
    state({ summary: "Email the invoice", assignee: { accountId: "acc-1", displayName: "Dan Okafor" }, duedate: "2026-10-01" }),
    { people: { "Renee Liu": { accountId: "acc-2" } } },
  );
  assert.deepEqual(
    diff.changes.map((c) => [c.name, c.jiraText, c.vaultText, c.editable]),
    [
      ["Summary", "Email the invoice", "Email the final invoice", true],
      ["Assignee", "Dan Okafor", "Renee Liu", true],
      ["Due date", "2026-10-01", "", true],
    ],
  );
  assert.equal(diff.changes[2].value, null, "a cleared field is sent as null");
});

test("a field the edit screen lacks, or will not set, is shown but cannot be chosen", () => {
  const screen = editScreen();
  delete screen.duedate;
  screen.components = editField("components", { name: "Components", operations: ["add", "remove"] });
  const diff = diffIssue(
    update({ duedate: "2026-11-01", components: [{ name: "Web" }], parent: null }),
    state({ duedate: "2026-10-01", components: [], parent: { key: "ENG-1" } }, screen),
  );
  const by = Object.fromEntries(diff.changes.map((c) => [c.fieldId, c]));
  assert.equal(by.duedate.editable, false);
  assert.match(by.duedate.reason ?? "", /ENG-7's edit screen has no Due date field/);
  assert.match(by.components.reason ?? "", /does not allow Components to be set/);
  assert.match(by.parent.reason ?? "", /Removing an issue's parent is done in Jira/);
});

test("a typed category value is shaped against the edit screen's options", () => {
  const screen = editScreen(
    editField("customfield_5", { name: "Area", schema: { type: "option" }, allowedValues: [{ id: "a1", value: "Billing" }] }),
  );
  const same = diffIssue(update({ customfield_5: "billing" }, { typed: ["customfield_5"] }), state({ customfield_5: { id: "a1", value: "Billing" } }, screen));
  assert.deepEqual(same.changes, [], "the name matches Jira's option once shaped");

  const bad = diffIssue(update({ customfield_5: "Payroll" }, { typed: ["customfield_5"] }), state({ customfield_5: { id: "a1" } }, screen));
  assert.equal(bad.changes[0].editable, false);
  assert.match(bad.changes[0].reason ?? "", /Area has no option "Payroll"/);
});

test("a changed issue type is said, since an update cannot carry it", () => {
  const diff = diffIssue(update({ summary: "S" }, { issueType: "Bug" }), state({ summary: "S" }));
  assert.match(diff.warnings[0], /a Bug here and a Story in Jira \(ENG-7\)\. An update cannot change an issue's type/);
});

// -------------------------------------------------------- read and send

test("the issue is read for just the fields the update touches, with its edit screen", async () => {
  const fake = fakeFetch({
    "GET /rest/api/3/issue/ENG-7": { status: 200, json: { id: "10070", key: "ENG-7", fields: { summary: "S", issuetype: { name: "Story" } } } },
    "GET /rest/api/3/issue/ENG-7/editmeta": {
      status: 200,
      json: { fields: { summary: { name: "Summary", required: true, schema: { type: "string", system: "summary" }, operations: ["set"] } } },
    },
  });
  const client = createJiraClient({ site: SITE, email: "dan@acme.test", token: "t", fetch: fake.fetch });
  const read = await readIssueState(client, update({ summary: "S", duedate: null }));

  assert.equal(fake.requests[0].url.searchParams.get("fields"), "summary,duedate,issuetype");
  assert.equal(read.editable.summary.name, "Summary");
  assert.deepEqual(read.fields.summary, "S");
  await assert.rejects(readIssueState(client, update({}, { jiraKey: "../x" })), /not a Jira issue key/);
});

function jira(put: Reply) {
  const fake = fakeFetch({ "PUT /rest/api/3/issue/ENG-7": put, "PUT /rest/api/3/issue/ENG-8": { status: 204 } });
  return { fake, client: createJiraClient({ site: SITE, email: "dan@acme.test", token: "t", fetch: fake.fetch, maxRetries: 0 }) };
}

test("only the chosen fields are sent, and each item is restamped as it lands", async () => {
  const { fake, client } = jira({ status: 204 });
  const stamped: string[] = [];
  const outcome = await sendUpdates(
    client,
    [
      { localKey: "ACME-1", jiraKey: "ENG-7", jiraId: "10070", fields: { summary: "New" } },
      { localKey: "ACME-2", jiraKey: "ENG-8", fields: {} },
    ],
    { markPushed: async (local, key, id) => void stamped.push(`${local}->${key}:${id ?? "-"}`) },
  );

  assert.equal(fake.requests.length, 1, "an item that already matches is restamped without a request");
  assert.equal(fake.requests[0].method, "PUT");
  assert.deepEqual(fake.requests[0].body, { fields: { summary: "New" } });
  assert.deepEqual(stamped, ["ACME-1->ENG-7:10070", "ACME-2->ENG-8:-"]);
  assert.deepEqual(outcome.updated.map((u) => [u.jiraKey, u.fields, u.restamped]), [["ENG-7", ["summary"], true], ["ENG-8", [], true]]);
  assert.equal(outcome.updated[0].url, `${SITE}/browse/ENG-7`);
});

test("a refused update is not restamped, and a dropped one says a retry is safe", async () => {
  const refused = jira({ status: 400, json: { errorMessages: [], errors: { duedate: "Bad date" } } });
  const stamped: string[] = [];
  const out = await sendUpdates(refused.client, [{ localKey: "ACME-1", jiraKey: "ENG-7", fields: { duedate: "x" } }], {
    markPushed: async (local) => void stamped.push(local),
  });
  assert.deepEqual(stamped, []);
  assert.deepEqual(out.failed[0].fieldErrors, { duedate: "Bad date" });

  const dropping = createJiraClient({
    site: SITE,
    email: "dan@acme.test",
    token: "t",
    maxRetries: 0,
    fetch: (async () => {
      throw new TypeError("socket hang up");
    }) as typeof fetch,
  });
  const dropped = await sendUpdates(dropping, [{ localKey: "ACME-1", jiraKey: "ENG-7", fields: { summary: "x" } }], {
    markPushed: async () => {},
  });
  assert.match(dropped.failed[0].message, /Sending it again is safe/);
});

test("after the update lands, the item is no longer offered", async () => {
  const vault = await tmpVault();
  const m = map();
  const { item, jiraFields } = await pushedThenEdited(vault, m);
  await vault.updateItem(item.key, { summary: "Email the final invoice" });

  const planned = buildUpdatePlan(await items(vault), m, vault).updates[0];
  const diff = diffIssue(planned, state(jiraFields));
  assert.deepEqual(diff.changes.map((c) => c.fieldId), ["summary"], "only what was edited differs");
  const { client } = jira({ status: 204 });
  await sendUpdates(
    client,
    [{ localKey: planned.localKey, jiraKey: planned.jiraKey, jiraId: planned.jiraId, fields: { summary: diff.changes[0].value } }],
    { markPushed: async (local, key, id) => void (await vault.markPushed(local, key, id)) },
  );

  assert.deepEqual(buildUpdatePlan(await items(vault), m, vault).updates, []);
  assert.equal(vault.getItem(item.key).sync.jiraId, "10070", "the restamp kept the id");
});

test("restamp: false sends the chosen fields and leaves the item reading as changed", async () => {
  const { fake, client } = jira({ status: 204 });
  const stamped: string[] = [];
  const outcome = await sendUpdates(
    client,
    [{ localKey: "ACME-1", jiraKey: "ENG-7", fields: { summary: "New" }, restamp: false }],
    { markPushed: async (local) => void stamped.push(local) },
  );
  assert.deepEqual(fake.requests[0].body, { fields: { summary: "New" } });
  assert.deepEqual(stamped, [], "a difference nobody decided about is not buried by a stamp");
  assert.equal(outcome.updated[0].restamped, false);
});
