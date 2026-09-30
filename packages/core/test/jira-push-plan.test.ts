import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPushPlan, fieldsTheMapCanFill, JiraMapSchema, type JiraMap } from "../src/jira.js";
import { requiredGaps } from "../src/jira-meta.js";
import type { IssueTypeMeta, JiraFieldMeta, ProjectMeta } from "../src/jira-meta.js";
import { Vault } from "../src/vault.js";

async function tmpVault(): Promise<Vault> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "push-plan-test-"));
  const vault = await Vault.init(dir);
  await vault.createProject({ key: "ACME", name: "Acme rollout" });
  return vault;
}

function map(over: Record<string, unknown> = {}): JiraMap {
  return JiraMapSchema.parse({ jiraProjectKey: "ENG", issueTypes: {}, ...over });
}

function field(fieldId: string, over: Partial<JiraFieldMeta> = {}): JiraFieldMeta {
  return { fieldId, name: fieldId, required: false, hasDefaultValue: false, schema: { type: "string" }, operations: ["set"], ...over };
}

/** Story has a Team field Jira requires; Epic has no start date or labels field. */
function meta(): ProjectMeta {
  const common = ["summary", "description", "priority", "duedate", "assignee"].map((id) => field(id));
  const story: IssueTypeMeta = {
    id: "10002",
    name: "Story",
    subtask: false,
    fields: [
      ...common,
      field("labels"),
      field("customfield_10015", { name: "Start date" }),
      field("customfield_10001", { name: "Team", required: true }),
      field("reporter", { name: "Reporter", required: true, hasDefaultValue: true }),
    ],
  };
  const epic: IssueTypeMeta = { id: "10001", name: "Epic", subtask: false, fields: [...common, field("customfield_10001", { name: "Team" })] };
  const task: IssueTypeMeta = { id: "10003", name: "Task", subtask: false, fields: [] };
  return {
    site: "https://acme.atlassian.net",
    projectKey: "ENG",
    projectId: "10000",
    projectName: "Engineering",
    issueTypes: [epic, story, task],
    fetchedAt: "2026-09-29T00:00:00.000Z",
  };
}

async function items(vault: Vault) {
  return vault.listItems({ limit: 500 }).items;
}

// ---------------------------------------------------------------- people

test("an assignee goes as a Jira account id, matched case-insensitively", async () => {
  const vault = await tmpVault();
  const a = await vault.createItem({ project: "ACME", summary: "Mapped", assignee: "dan okafor" });
  const plan = buildPushPlan(await items(vault), map({ people: { "Dan Okafor": { accountId: "acc-1" } } }), vault);
  assert.deepEqual(plan.drafts.find((d) => d.localKey === a.key)?.fields.assignee, { accountId: "acc-1" });
});

test("an assignee with no account is left unassigned, said once for all their items", async () => {
  const vault = await tmpVault();
  const a = await vault.createItem({ project: "ACME", summary: "One", assignee: "Renee" });
  const b = await vault.createItem({ project: "ACME", summary: "Two", assignee: "renee" });
  const plan = buildPushPlan(await items(vault), map(), vault);

  for (const draft of plan.drafts) assert.equal(draft.fields.assignee, undefined, "never { name }, which Jira Cloud refuses");
  const about = plan.warnings.filter((w) => /no Jira account/.test(w));
  assert.equal(about.length, 2, "one per distinct spelling as typed");
  assert.ok(plan.warnings.some((w) => w.includes(a.key)) && plan.warnings.some((w) => w.includes(b.key)));
});

// ---------------------------------------------------------- extra fields

test("extra fields are sent, ask values override for this push, and the item's own fields win", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "S", type: "story", priority: "high" });
  const m = map({
    extraFields: {
      customfield_10001: { name: "Team", mode: "always", value: "team-1" },
      fixVersions: { mode: "ask", value: [{ id: "1" }] },
      priority: { mode: "always", value: { name: "Lowest" } },
      customfield_20000: { mode: "always", value: "epics only", issueTypes: ["Epic"] },
    },
  });

  const plain = buildPushPlan(await items(vault), m, vault).drafts[0].fields;
  assert.equal(plain.customfield_10001, "team-1");
  assert.deepEqual(plain.fixVersions, [{ id: "1" }], "an ask field sends its prefilled value when not changed");
  assert.deepEqual(plain.priority, { name: "High" }, "the item's priority beats an extra field of the same id");
  assert.equal(plain.customfield_20000, undefined, "limited to Epic");

  const asked = buildPushPlan(await items(vault), m, vault, { askValues: { fixVersions: [{ id: "2" }] } }).drafts[0].fields;
  assert.deepEqual(asked.fixVersions, [{ id: "2" }]);
});

// ------------------------------------------------------ screen checks

test("without project metadata the plan is built as before, with no blockers", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "S", type: "story" });
  const plan = buildPushPlan(await items(vault), map(), vault);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.drafts[0].fields.issuetype, { name: "Story" });
  assert.equal(plan.drafts[0].issueType, "Story");
});

test("with metadata, the issue type goes by id and a required field nothing fills blocks", async () => {
  const vault = await tmpVault();
  const s = await vault.createItem({ project: "ACME", summary: "S", type: "story" });
  const plan = buildPushPlan(await items(vault), map(), vault, { meta: meta() });

  assert.deepEqual(plan.drafts[0].fields.issuetype, { id: "10002" });
  assert.equal(plan.blockers.length, 1, "Team is required on Story; Reporter has a default and is not a gap");
  assert.equal(plan.blockers[0].localKey, s.key);
  assert.match(plan.blockers[0].message, /Team \(customfield_10001\)/);
});

test("an extra field closes the gap it covers", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "S", type: "story" });
  const m = map({ extraFields: { customfield_10001: { mode: "always", value: "team-1" } } });
  assert.deepEqual(buildPushPlan(await items(vault), m, vault, { meta: meta() }).blockers, []);
});

test("a field the issue type's screen lacks is dropped, and said once for every item it hits", async () => {
  const vault = await tmpVault();
  const e1 = await vault.createItem({ project: "ACME", summary: "E1", type: "epic", labels: ["x"], startDate: "2026-10-01" });
  const e2 = await vault.createItem({ project: "ACME", summary: "E2", type: "epic", labels: ["y"] });
  const m = map({ fields: { startDate: "customfield_10015" } });
  const plan = buildPushPlan(await items(vault), m, vault, { meta: meta() });

  for (const draft of plan.drafts) {
    assert.equal(draft.fields.labels, undefined);
    assert.equal(draft.fields.customfield_10015, undefined);
  }
  const labels = plan.warnings.filter((w) => w.includes("has no labels field"));
  assert.equal(labels.length, 1, "grouped, not one line per item");
  assert.ok(labels[0].includes(e1.key) && labels[0].includes(e2.key));
  assert.deepEqual(plan.blockers, [], "Team is optional on Epic");
});

test("an issue type the project cannot create, or whose fields were not loaded, blocks", async () => {
  const vault = await tmpVault();
  const bug = await vault.createItem({ project: "ACME", summary: "B", type: "bug" });
  const task = await vault.createItem({ project: "ACME", summary: "T", type: "task" });
  const plan = buildPushPlan(await items(vault), map(), vault, { meta: meta() });

  const byKey = new Map(plan.blockers.map((b) => [b.localKey, b.message]));
  assert.match(byKey.get(bug.key) ?? "", /cannot create\. It can create: Epic, Story, Task/);
  assert.match(byKey.get(task.key) ?? "", /were not loaded/);
});

test("a child created in the same batch counts its parent as covered", async () => {
  const vault = await tmpVault();
  const epic = await vault.createItem({ project: "ACME", summary: "E", type: "epic" });
  await vault.createItem({ project: "ACME", summary: "S", type: "story", parent: epic.key });
  const m2 = meta();
  const story = m2.issueTypes.find((t) => t.name === "Story")!;
  story.fields.push(field("parent", { name: "Parent", required: true }));
  const m = map({ extraFields: { customfield_10001: { mode: "always", value: "team-1" } } });

  const plan = buildPushPlan(await items(vault), m, vault, { meta: m2 });
  assert.deepEqual(plan.blockers, [], "the parent is filled in once the epic exists");
  assert.equal(plan.drafts.find((d) => d.issueType === "Story")?.parentLocalKey, epic.key);
});

// ------------------------------------------------- map-level coverage

test("every field a fully populated draft carries is one the map says it can fill", async () => {
  const vault = await tmpVault();
  const epic = await vault.createItem({ project: "ACME", summary: "E", type: "epic" });
  await vault.createItem({
    project: "ACME",
    summary: "Everything set",
    type: "story",
    parent: epic.key,
    priority: "high",
    labels: ["billing"],
    components: ["Web"],
    assignee: "Dan",
    dueDate: "2026-11-01",
    startDate: "2026-10-01",
    estimate: 3,
    category: "Vendor management",
  });
  const m = map({
    people: { dan: { accountId: "acc-1" } },
    fields: { startDate: "customfield_10015", estimate: "customfield_10016", category: "customfield_10050" },
    defaults: { customfield_1: "x" },
    extraFields: {
      customfield_10001: { mode: "always", value: "team-1" },
      fixVersions: { mode: "ask", value: [{ id: "1" }] },
      customfield_20000: { mode: "always", value: "epic only", issueTypes: ["Epic"] },
    },
  });

  for (const draft of buildPushPlan(await items(vault), m, vault).drafts) {
    const canFill = fieldsTheMapCanFill(m, draft.issueType);
    const sent = [...Object.keys(draft.fields), ...(draft.parentLocalKey ? ["parent"] : [])];
    const missing = sent.filter((id) => !canFill.has(id));
    assert.deepEqual(missing, [], `${draft.localKey} (${draft.issueType}) sends fields the map-level answer does not know about`);
  }
});

test("the map-level gap is Team until an extra field for Story fills it", () => {
  const story = meta().issueTypes.find((t) => t.name === "Story")!;
  const gaps = (m: JiraMap) => requiredGaps(story, fieldsTheMapCanFill(m, "Story")).map((g) => g.name);

  assert.deepEqual(gaps(map()), ["Team"]);
  assert.deepEqual(gaps(map({ extraFields: { customfield_10001: { mode: "ask" } } })), [], "ask can be filled at push time");
  assert.deepEqual(gaps(map({ extraFields: { customfield_10001: { mode: "always", value: "t" } } })), []);
  assert.deepEqual(
    gaps(map({ extraFields: { customfield_10001: { mode: "always", value: null } } })),
    ["Team"],
    "an always field with no value sends nothing",
  );
  assert.deepEqual(
    gaps(map({ extraFields: { customfield_10001: { mode: "always", value: "t", issueTypes: ["Epic"] } } })),
    ["Team"],
    "restricted to Epic, so it does nothing for Story",
  );
  assert.deepEqual(
    gaps(map({ extraFields: { customfield_10001: { mode: "always", value: "t", issueTypes: [" story "] } } })),
    [],
    "issue type names match the way buildPushPlan matches them",
  );
});
