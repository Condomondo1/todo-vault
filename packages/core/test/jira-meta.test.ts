import assert from "node:assert/strict";
import test from "node:test";

import { createJiraClient } from "../src/jira-client.js";
import { discoverJiraMap } from "../src/jira-discover.js";
import {
  distinctFields,
  fetchProjectMeta,
  fieldOn,
  issueTypeNamed,
  requiredGaps,
  searchAssignable,
  valueKindFor,
  type IssueTypeMeta,
  type JiraFieldMeta,
} from "../src/jira-meta.js";
import { fakeFetch, type Reply } from "./jira-fake-fetch.js";

const SITE = "https://acme.atlassian.net";

function field(over: Partial<JiraFieldMeta> & Pick<JiraFieldMeta, "fieldId" | "name">): JiraFieldMeta {
  return { required: false, hasDefaultValue: false, schema: { type: "string" }, operations: ["set"], ...over };
}

/** Shaped like a team-managed project's createmeta, trimmed to what matters. */
const STORY_FIELDS = [
  { fieldId: "summary", name: "Summary", required: true, hasDefaultValue: false, schema: { type: "string", system: "summary" }, operations: ["set"] },
  { fieldId: "issuetype", name: "Issue Type", required: true, hasDefaultValue: false, schema: { type: "issuetype", system: "issuetype" }, operations: [] },
  { fieldId: "reporter", name: "Reporter", required: true, hasDefaultValue: true, schema: { type: "user", system: "reporter" }, operations: ["set"] },
  { fieldId: "customfield_10015", name: "Start date", required: false, hasDefaultValue: false, schema: { type: "date", custom: "com.atlassian.jira.plugin.system.customfieldtypes:datepicker" }, operations: ["set"] },
  { fieldId: "customfield_10001", name: "Team", required: true, hasDefaultValue: false, schema: { type: "team", custom: "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team" }, operations: ["set"] },
];
const EPIC_FIELDS = [
  { fieldId: "summary", name: "Summary", required: true, hasDefaultValue: false, schema: { type: "string" }, operations: ["set"] },
  { fieldId: "customfield_10016", name: "Story point estimate", required: false, hasDefaultValue: false, schema: { type: "number", custom: "com.pyxis.greenhopper.jira:jsw-story-points" }, operations: ["set"] },
];

function projectRoutes(listKey: "issueTypes" | "values"): Record<string, Reply | Reply[]> {
  return {
    "GET /rest/api/3/project/ENG": { status: 200, json: { id: "10000", key: "ENG", name: "Engineering", style: "next-gen" } },
    "GET /rest/api/3/issue/createmeta/ENG/issuetypes": {
      status: 200,
      json: {
        startAt: 0,
        maxResults: 50,
        total: 3,
        [listKey]: [
          { id: "10001", name: "Epic", subtask: false },
          { id: "10002", name: "Story", subtask: false },
          { id: "10003", name: "Subtask", subtask: true },
        ],
      },
    },
    // Two pages, to prove pagination reads past the first.
    "GET /rest/api/3/issue/createmeta/ENG/issuetypes/10002": (req) => {
      const startAt = Number(req.url.searchParams.get("startAt"));
      const page = startAt === 0 ? STORY_FIELDS.slice(0, 3) : STORY_FIELDS.slice(3);
      return { status: 200, json: { startAt, maxResults: 3, total: STORY_FIELDS.length, [listKey === "issueTypes" ? "fields" : "values"]: page } };
    },
    "GET /rest/api/3/issue/createmeta/ENG/issuetypes/10001": {
      status: 200,
      json: { startAt: 0, maxResults: 50, total: 2, fields: EPIC_FIELDS },
    },
    "GET /rest/api/3/issue/createmeta/ENG/issuetypes/10003": {
      status: 200,
      json: { startAt: 0, maxResults: 50, total: 1, fields: EPIC_FIELDS.slice(0, 1) },
    },
  };
}

function metaClient(routes: Record<string, Reply | Reply[]>) {
  const fake = fakeFetch(routes);
  return {
    client: createJiraClient({ site: SITE, email: "dan@acme.test", token: "t", fetch: fake.fetch }),
    requests: fake.requests,
  };
}

// ------------------------------------------------------- classification

test("each field schema maps to the editor that produces Jira's value shape", () => {
  const cases: [JiraFieldMeta["schema"], string][] = [
    [{ type: "string", system: "summary" }, "text"],
    [{ type: "string", system: "description" }, "richText"],
    [{ type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" }, "richText"],
    [{ type: "number" }, "number"],
    [{ type: "date" }, "date"],
    [{ type: "datetime" }, "datetime"],
    [{ type: "option" }, "option"],
    [{ type: "array", items: "option" }, "options"],
    [{ type: "option-with-child", custom: "com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect" }, "cascading"],
    [{ type: "user" }, "user"],
    [{ type: "array", items: "user" }, "users"],
    [{ type: "array", items: "version", system: "fixVersions" }, "versions"],
    [{ type: "array", items: "component", system: "components" }, "components"],
    [{ type: "priority", system: "priority" }, "priority"],
    [{ type: "array", items: "string", system: "labels" }, "labels"],
    // Each used to fall to a JSON box; shapeFieldValue now builds their value.
    [{ type: "team", custom: "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team" }, "team"],
    [{ type: "array", items: "json", custom: "com.pyxis.greenhopper.jira:gh-sprint" }, "sprint"],
    [{ type: "any", custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" }, "managed"],
    // Nothing in the schema says what an app field wants.
    [{ type: "any", custom: "com.example.app:widget" }, "raw"],
  ];
  for (const [schema, kind] of cases) assert.equal(valueKindFor(schema), kind, JSON.stringify(schema));
});

// ---------------------------------------------------------- validation

test("a required field with no default that nothing fills is a gap", () => {
  const story: IssueTypeMeta = {
    id: "10002",
    name: "Story",
    subtask: false,
    fields: [
      field({ fieldId: "summary", name: "Summary", required: true }),
      field({ fieldId: "project", name: "Project", required: true }),
      field({ fieldId: "reporter", name: "Reporter", required: true, hasDefaultValue: true }),
      field({ fieldId: "customfield_10001", name: "Team", required: true }),
      field({ fieldId: "customfield_10002", name: "Squad", required: true }),
      field({ fieldId: "customfield_10015", name: "Start date" }),
    ],
  };
  const gaps = requiredGaps(story, new Set(["customfield_10002"]));
  assert.deepEqual(
    gaps.map((g) => g.name),
    ["Team"],
    "summary and project are always sent, reporter has a default, Squad is covered, Start date is optional",
  );
});

// ------------------------------------------------------------- network

for (const listKey of ["issueTypes", "values"] as const) {
  test(`project metadata reads every page, under the '${listKey}' list key`, async () => {
    const { client } = metaClient(projectRoutes(listKey));
    const meta = await fetchProjectMeta(client, "ENG", { now: () => new Date("2026-09-29T12:00:00Z") });

    assert.equal(meta.projectId, "10000");
    assert.equal(meta.site, SITE);
    assert.equal(meta.fetchedAt, "2026-09-29T12:00:00.000Z");
    assert.deepEqual(meta.issueTypes.map((t) => t.name), ["Epic", "Story", "Subtask"]);

    const story = issueTypeNamed(meta, "story");
    assert.ok(story);
    assert.equal(story.fields.length, STORY_FIELDS.length, "both pages of fields are read");
    assert.equal(fieldOn(story, "customfield_10001")?.required, true);
    assert.equal(fieldOn(story, "customfield_10016"), undefined, "an Epic field is not a Story field");
  });
}

test("fields are read only for the issue types asked about", async () => {
  const { client, requests } = metaClient(projectRoutes("issueTypes"));
  const meta = await fetchProjectMeta(client, "ENG", { issueTypeNames: ["Epic"] });
  assert.equal(issueTypeNamed(meta, "Epic")?.fields.length, 2);
  assert.equal(issueTypeNamed(meta, "Story")?.fields.length, 0);
  assert.ok(!requests.some((r) => r.url.pathname.endsWith("/issuetypes/10002")));
});

test("distinct fields merge across issue types, once each", async () => {
  const { client } = metaClient(projectRoutes("issueTypes"));
  const meta = await fetchProjectMeta(client, "ENG");
  const ids = distinctFields(meta).map((f) => f.fieldId);
  assert.equal(ids.filter((id) => id === "summary").length, 1);
  assert.ok(ids.includes("customfield_10016"));
  assert.ok(ids.includes("customfield_10001"));
});

test("a project key that is not one is refused before a request", async () => {
  const { client, requests } = metaClient({});
  await assert.rejects(fetchProjectMeta(client, "ENG/../../admin"), /not a Jira project key/);
  assert.equal(requests.length, 0);
});

test("the people search asks for assignable users in this project and drops inactive and app accounts", async () => {
  const { client, requests } = metaClient({
    "GET /rest/api/3/user/assignable/search": {
      status: 200,
      json: [
        { accountId: "a1", displayName: "Dan Okafor", active: true, accountType: "atlassian" },
        { accountId: "a2", displayName: "Dan Old", active: false, accountType: "atlassian" },
        { accountId: "a3", displayName: "Automation for Jira", active: true, accountType: "app" },
      ],
    },
  });
  const users = await searchAssignable(client, "ENG", "  dan ");
  assert.deepEqual(users.map((u) => u.accountId), ["a1"]);
  assert.equal(requests[0].url.searchParams.get("project"), "ENG");
  assert.equal(requests[0].url.searchParams.get("query"), "dan");
});

// ------------------------------------------------------------ discover

test("discover proposes only fields this project has, and never reads the site-wide list", async () => {
  const fake = fakeFetch(projectRoutes("issueTypes"));
  const yaml = await discoverJiraMap(`${SITE}/`, { email: "dan@acme.test", token: "t" }, "ENG", fake.fetch);

  assert.match(yaml, /startDate: customfield_10015/);
  assert.match(yaml, /estimate: customfield_10016/);
  assert.match(yaml, /baseUrl: https:\/\/acme\.atlassian\.net\n/);
  assert.ok(!fake.requests.some((r) => r.url.pathname === "/rest/api/3/field"), "no site-wide field read");
  assert.ok(
    !fake.requests.some((r) => r.url.searchParams.has("expand")),
    "not the deprecated createmeta?expand= form",
  );
});
