import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JiraMapSchema, writeJiraMap, type JiraMap } from "todo-vault";
import type { IssueTypeMeta, JiraFieldMeta, ProjectMeta } from "todo-vault/jira-meta";

import type { JiraMappingChoice } from "../src/shared/api.js";
import { mapState, mappingEdits, mappingGaps, normaliseProjectKey } from "../src/main/jira-mapping.js";

const CLASSIC = { site: "https://acme.atlassian.net", auth: "site" as const };
const SCOPED = { site: "https://acme.atlassian.net", auth: "scoped" as const, cloudId: "c10ud-1d" };

const choice = (patch: Partial<JiraMappingChoice> = {}): JiraMappingChoice => ({
  projectKey: "ENG",
  issueTypes: { epic: "Epic", story: "Story", task: "Task", bug: "Task", subtask: "Subtask" },
  fields: { category: "labels" },
  ...patch,
});

test("a project key is trimmed and upper-cased, and anything that is not one is refused", () => {
  assert.equal(normaliseProjectKey("  eng "), "ENG");
  assert.equal(normaliseProjectKey("PAY_2"), "PAY_2");
  assert.throws(() => normaliseProjectKey(""), /An empty key is not a Jira project key/);
  assert.throws(() => normaliseProjectKey("ENG-12"), /ENG-12 is not a Jira project key/);
  assert.throws(() => normaliseProjectKey("2ENG"), /not a Jira project key/);
  assert.throws(() => normaliseProjectKey("E NG"), /not a Jira project key/);
});

test("the edits are paths into blocks, never a whole block, so the block's comments survive", () => {
  const edits = mappingEdits(choice({ fields: { startDate: "customfield_10015", category: "labels" } }), CLASSIC);
  for (const edit of edits) {
    assert.ok(
      !["fields", "issueTypes", "extraFields", "people"].includes(edit.path.join(".")),
      `${edit.path.join(".")} replaces a whole block`,
    );
  }
  assert.deepEqual(
    edits.map((e) => e.path.join(".")),
    [
      "jiraProjectKey",
      "baseUrl",
      "auth",
      "cloudId",
      "issueTypes.epic",
      "issueTypes.story",
      "issueTypes.task",
      "issueTypes.bug",
      "issueTypes.subtask",
      "fields.startDate",
      "fields.estimate",
      "fields.category",
    ],
  );
});

test("the site, auth and cloudId come from the credential, whatever the choice carries", () => {
  // A renderer that tried to smuggle a site in would be ignored, not obeyed.
  const smuggled = { ...choice(), baseUrl: "https://evil.example", auth: "scoped" } as JiraMappingChoice;
  const byPath = new Map(mappingEdits(smuggled, CLASSIC).map((e) => [e.path.join("."), e.value]));
  assert.equal(byPath.get("baseUrl"), "https://acme.atlassian.net");
  assert.equal(byPath.get("auth"), "site");
});

test("cloudId is written for a scoped token and removed for a classic one", () => {
  const cloudId = (credential: typeof CLASSIC | typeof SCOPED) =>
    mappingEdits(choice(), credential).find((e) => e.path.join(".") === "cloudId");
  assert.deepEqual(cloudId(SCOPED), { path: ["cloudId"], value: "c10ud-1d" });
  // Present with no value: writeJiraMap deletes the key, so a stale one goes.
  assert.deepEqual(cloudId(CLASSIC), { path: ["cloudId"], value: undefined });
});

test("an unchosen optional field is removed, not left pointing at the old one", () => {
  const byPath = new Map(mappingEdits(choice(), CLASSIC).map((e) => [e.path.join("."), e]));
  assert.ok(byPath.has("fields.startDate"));
  assert.equal(byPath.get("fields.startDate")?.value, undefined);
});

test("a bad key, field id, category or missing issue type is refused before anything is written", () => {
  assert.throws(() => mappingEdits(choice({ projectKey: "eng-1" }), CLASSIC), /not a Jira project key/);
  assert.throws(
    () => mappingEdits(choice({ fields: { startDate: "customfield_abc", category: "labels" } }), CLASSIC),
    /customfield_abc is not a Jira field id/,
  );
  assert.throws(
    () => mappingEdits(choice({ fields: { estimate: "../../token", category: "labels" } }), CLASSIC),
    /is not a Jira field id/,
  );
  assert.throws(
    () => mappingEdits(choice({ fields: { category: "Label s" } }), CLASSIC),
    /is not "labels" or a Jira field id/,
  );
  assert.throws(
    () => mappingEdits(choice({ issueTypes: { ...choice().issueTypes, subtask: " " } }), CLASSIC),
    /Choose a Jira issue type for subtask/,
  );
});

test("written through writeJiraMap, a Save keeps comments and leaves what it did not show alone", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jira-mapping-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "jira-map.yaml");
  await fs.writeFile(
    file,
    [
      "jiraProjectKey: OLD",
      "cloudId: stale-from-a-scoped-token",
      "fields:",
      "  # Start date is a different customfield on every site.",
      "  startDate: customfield_99999",
      "  epicLink: customfield_10014",
      "extraFields:",
      "  customfield_10001:",
      "    name: Team",
      "    value: { id: t1 }",
      "",
    ].join("\n"),
  );

  const edits = mappingEdits(choice({ fields: { estimate: "timeoriginalestimate", category: "labels" } }), CLASSIC);
  const map = await writeJiraMap(file, edits);
  const text = await fs.readFile(file, "utf8");

  assert.match(text, /# Start date is a different customfield on every site\./);
  assert.equal(map.jiraProjectKey, "ENG");
  assert.equal(map.baseUrl, "https://acme.atlassian.net");
  assert.equal(map.cloudId, undefined);
  assert.equal(map.fields.startDate, undefined);
  assert.equal(map.fields.estimate, "timeoriginalestimate");
  assert.equal(map.fields.epicLink, "customfield_10014", "not shown by the panel, so not touched");
  assert.deepEqual(map.extraFields.customfield_10001?.value, { id: "t1" });
});

// ------------------------------------------------- extra fields and people

const TEAM_SPEC = { name: "Team", mode: "always" as const, value: { id: "t2" }, issueTypes: ["Epic", "Story", "Task"] };
const DAN_LINK = { accountId: "acc-dan", displayName: "Dan Okafor" };
const edited = (edits: ReturnType<typeof mappingEdits>) => new Map(edits.map((e) => [e.path.join("."), e.value]));

test("a choice without extra fields or people leaves the map's alone", () => {
  const paths = mappingEdits(choice(), CLASSIC, mapOf({ extraFields: { customfield_1: { value: 1 } } })).map((e) =>
    e.path.join("."),
  );
  assert.ok(!paths.some((p) => p.startsWith("extraFields") || p.startsWith("people")));
});

test("the panel's set of extra fields and people replaces the map's, entry by entry", () => {
  const current = mapOf({
    extraFields: { customfield_10001: { name: "Team", value: { id: "t1" } }, customfield_30000: { value: "gone" } },
    people: { "Dan Okafor": { accountId: "old" }, "Ann Lee": { accountId: "acc-ann" } },
  });
  const edits = edited(
    mappingEdits(choice({ extraFields: { customfield_10001: TEAM_SPEC }, people: { "Dan Okafor": DAN_LINK } }), CLASSIC, current),
  );
  assert.deepEqual(edits.get("extraFields.customfield_10001"), TEAM_SPEC);
  assert.ok(edits.has("extraFields.customfield_30000"), "a field the panel dropped is removed");
  assert.equal(edits.get("extraFields.customfield_30000"), undefined);
  assert.deepEqual(edits.get("people.Dan Okafor"), DAN_LINK);
  assert.ok(edits.has("people.Ann Lee"));
  assert.equal(edits.get("people.Ann Lee"), undefined);
  assert.ok(!edits.has("extraFields") && !edits.has("people"), "never the whole block over existing entries");
});

test("nothing empty is written: no null value, no empty issueTypes, no blank name", () => {
  const edits = edited(
    mappingEdits(
      choice({ extraFields: { customfield_1: { name: "  ", mode: "ask", value: null, issueTypes: [" "] } } }),
      CLASSIC,
    ),
  );
  assert.deepEqual(edits.get("extraFields"), { customfield_1: { mode: "ask" } });
});

test("a bad extra field or person is refused", () => {
  const withExtra = (id: string, mode = "always") =>
    choice({ extraFields: { [id]: { mode: mode as "always" } } });
  assert.throws(() => mappingEdits(withExtra("../token"), CLASSIC), /is not a Jira field id/);
  assert.throws(() => mappingEdits(withExtra("customfield_1", "sometimes"), CLASSIC), /always or asked for/);
  assert.throws(
    () => mappingEdits(choice({ people: { "Dan Okafor": DAN_LINK, "dan okafor": DAN_LINK } }), CLASSIC),
    /Dan Okafor and dan okafor are the same person to the push/,
  );
  assert.throws(
    () => mappingEdits(choice({ people: { Dan: { accountId: " " } } }), CLASSIC),
    /Choose a Jira account for Dan/,
  );
});

test("into the example file, a first extra field and person are block style, and its comments stay", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jira-mapping-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "jira-map.yaml");

  const map = await writeJiraMap(
    file,
    mappingEdits(choice({ extraFields: { customfield_10001: TEAM_SPEC }, people: { "Dan Okafor": DAN_LINK } }), CLASSIC),
  );
  const text = await fs.readFile(file, "utf8");

  assert.match(text, /^# Jira field mapping\./);
  assert.match(text, /^extraFields:\n {2}customfield_10001:\n {4}name: Team$/m, "block style, not flow");
  assert.match(text, /^people:\n {2}Dan Okafor:\n {4}accountId: acc-dan$/m);
  assert.match(text, /^# {2}customfield_10001:/m, "the example's commented-out entry survives");
  assert.deepEqual(map.extraFields.customfield_10001, TEAM_SPEC);
  assert.deepEqual(map.people["Dan Okafor"], DAN_LINK);
});

test("mapState hands back extra fields and people as the file has them", () => {
  const state = mapState(mapOf({ extraFields: { customfield_10001: TEAM_SPEC }, people: { "Dan Okafor": DAN_LINK } }));
  assert.ok(state.exists);
  assert.deepEqual(state.extraFields, { customfield_10001: TEAM_SPEC });
  assert.deepEqual(state.people, { "Dan Okafor": DAN_LINK });
});

// ------------------------------------------------------------ gaps

const field = (fieldId: string, name: string, extra: Partial<JiraFieldMeta> = {}): JiraFieldMeta => ({
  fieldId,
  name,
  required: false,
  hasDefaultValue: false,
  schema: { type: "string" },
  operations: ["set"],
  ...extra,
});

const COMMON = [
  field("summary", "Summary", { required: true }),
  field("issuetype", "Issue Type", { required: true }),
  field("project", "Project", { required: true }),
  field("reporter", "Reporter", { required: true, hasDefaultValue: true }),
];
const TEAM = field("customfield_10001", "Team", { required: true, schema: { type: "option" } });

const type = (id: string, name: string, fields: JiraFieldMeta[], subtask = false): IssueTypeMeta => ({
  id,
  name,
  subtask,
  fields: [...COMMON, ...fields],
});

const META: ProjectMeta = {
  site: "https://acme.atlassian.net",
  projectKey: "ENG",
  projectId: "10000",
  projectName: "Engineering",
  issueTypes: [
    type("1", "Epic", []),
    type("2", "Story", [TEAM]),
    type("3", "Task", [field("customfield_20000", "Cost centre", { required: true })]),
    type("4", "Subtask", [field("parent", "Parent", { required: true })], true),
  ],
  fetchedAt: "2026-09-30T00:00:00.000Z",
};

const mapOf = (patch: Record<string, unknown> = {}): JiraMap =>
  JiraMapSchema.parse({
    jiraProjectKey: "ENG",
    issueTypes: { epic: "Epic", story: "Story", task: "Task", bug: "Task", subtask: "Subtask" },
    ...patch,
  });

test("a required field with no default that nothing fills is a gap, named by type and field", () => {
  assert.deepEqual(mappingGaps(mapOf(), META), [
    { issueType: "Story", fieldId: "customfield_10001", fieldName: "Team" },
    { issueType: "Task", fieldId: "customfield_20000", fieldName: "Cost centre" },
  ]);
});

test("two vault types on one Jira type give that type's gaps once", () => {
  const gaps = mappingGaps(mapOf(), META) ?? [];
  assert.equal(gaps.filter((g) => g.issueType === "Task").length, 1);
});

test("a default, the push's own fields, and the parent it sends are never gaps", () => {
  const gaps = mappingGaps(mapOf(), META) ?? [];
  for (const id of ["reporter", "summary", "issuetype", "project", "parent"]) {
    assert.ok(!gaps.some((g) => g.fieldId === id), `${id} should not be a gap`);
  }
});

test("an extra field closes a gap, but only on the types it applies to", () => {
  const map = mapOf({
    extraFields: {
      customfield_10001: { name: "Team", value: { id: "t1" }, issueTypes: ["Story"] },
      customfield_20000: { name: "Cost centre", mode: "ask", issueTypes: ["Epic"] },
    },
  });
  assert.deepEqual(mappingGaps(map, META), [
    { issueType: "Task", fieldId: "customfield_20000", fieldName: "Cost centre" },
  ]);
});

test("another project's metadata answers nothing, rather than the wrong thing", () => {
  assert.equal(mappingGaps(mapOf({ jiraProjectKey: "PAY" }), META), undefined);
});

test("mapState carries gaps only when it was given metadata", () => {
  const without = mapState(mapOf());
  const withMeta = mapState(mapOf(), META);
  assert.ok(without.exists && !("gaps" in without));
  assert.ok(withMeta.exists && withMeta.gaps?.length === 2);
});
