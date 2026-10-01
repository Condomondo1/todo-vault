/**
 * A Jira project called ENG, served by the fake Jira in `fake-jira.mts`.
 *
 * Shared by every spec that needs a project rather than just a connection —
 * the push (`jira-push.e2e.mts`) and the mapping panel — so the canned create
 * screens live in one place and cannot drift into two slightly different
 * Jiras. `fake-jira.mts` stays the server; this only calls its `route()`.
 *
 * The shapes follow Atlassian's current reference for the paginated
 * per-project createmeta endpoints (`issueTypes`, `fields`), and the project
 * is built to exercise what the push has to get right:
 *
 * - **Story requires Team**, an option field with no default, so a map that
 *   does not fill it is blocked before anything is sent.
 * - **Epic has no Start date**, so a start date on an epic is dropped with a
 *   warning rather than refused by Jira.
 * - **Story has a paragraph, a cascading select and Rank**, the three fields
 *   a person used to meet as a JSON box. Jira wants ADF in a paragraph and
 *   refuses Rank on create, and so does this fake.
 * - **POST /issue validates like Jira does** — project, issue type, the
 *   required Team on a Story, ADF in a paragraph, ids in a cascading select,
 *   no Rank — and answers a miss with Jira's own error shape,
 *   so a push that got past the checks it should have failed is caught here
 *   rather than passing because the fake accepted anything.
 */
import type { FakeJira, FakeJiraRequest } from "./fake-jira.mjs";

export const PROJECT = { id: "10000", key: "ENG", name: "Engineering", style: "next-gen" };

export const ISSUE_TYPES = {
  epic: { id: "10001", name: "Epic", subtask: false },
  story: { id: "10002", name: "Story", subtask: false },
  task: { id: "10003", name: "Task", subtask: false },
  subtask: { id: "10004", name: "Subtask", subtask: true },
} as const;

export const TEAM_FIELD = "customfield_10001";
export const TEAMS = [
  { id: "t1", value: "Platform" },
  { id: "t2", value: "Payments" },
];
export const START_DATE_FIELD = "customfield_10015";
/** A textarea custom field: plain text in the app, ADF on the wire. */
export const PROPOSAL_FIELD = "customfield_10050";
/** A cascading select, region then city. */
export const REGION_FIELD = "customfield_10060";
export const REGIONS = [
  { id: "r1", value: "Europe", children: [{ id: "r11", value: "Berlin" }, { id: "r12", value: "Lisbon" }] },
  { id: "r2", value: "Americas", children: [{ id: "r21", value: "Denver" }] },
];
/** A user field that is not the assignee, so its picker searches the whole site. */
export const REVIEWER_FIELD = "customfield_10070";
/** Someone the site search finds and the assignable search does not. */
export const PRIYA = { accountId: "acc-priya", displayName: "Priya Raman", active: true, accountType: "atlassian" };
/** Jira's board ordering. On the create screen, and refused if sent. */
export const RANK_FIELD = "customfield_10019";

/** The one person the assignable search knows. */
export const DAN = { accountId: "acc-dan", displayName: "Dan Okafor", active: true, accountType: "atlassian" };

type Field = {
  fieldId: string;
  name: string;
  required: boolean;
  hasDefaultValue: boolean;
  schema: Record<string, string>;
  operations: string[];
  allowedValues?: unknown[];
};

const f = (fieldId: string, name: string, schema: Record<string, string>, extra: Partial<Field> = {}): Field => ({
  fieldId,
  name,
  required: false,
  hasDefaultValue: false,
  schema,
  operations: ["set"],
  ...extra,
});

const COMMON: Field[] = [
  f("summary", "Summary", { type: "string", system: "summary" }, { required: true }),
  f("issuetype", "Issue Type", { type: "issuetype", system: "issuetype" }, { required: true }),
  f("project", "Project", { type: "project", system: "project" }, { required: true }),
  f("description", "Description", { type: "string", system: "description" }),
  f("priority", "Priority", { type: "priority", system: "priority" }, {
    allowedValues: ["Highest", "High", "Medium", "Low", "Lowest"].map((name, i) => ({ id: String(i + 1), name })),
  }),
  f("labels", "Labels", { type: "array", items: "string", system: "labels" }),
  f("duedate", "Due date", { type: "date", system: "duedate" }),
  f("assignee", "Assignee", { type: "user", system: "assignee" }),
  f("reporter", "Reporter", { type: "user", system: "reporter" }, { required: true, hasDefaultValue: true }),
];

const team = (required: boolean): Field =>
  f(TEAM_FIELD, "Team", { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" }, {
    required,
    allowedValues: TEAMS,
  });
const startDate = f(START_DATE_FIELD, "Start date", {
  type: "date",
  custom: "com.atlassian.jira.plugin.system.customfieldtypes:datepicker",
});
const parent = f("parent", "Parent", { type: "issuelink", system: "parent" });
const proposal = f(PROPOSAL_FIELD, "Proposed Solution at Onset", {
  type: "string",
  custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
});
const region = f(
  REGION_FIELD,
  "Region",
  { type: "option-with-child", custom: "com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect" },
  { allowedValues: REGIONS },
);
const reviewer = f(REVIEWER_FIELD, "Reviewer", {
  type: "user",
  custom: "com.atlassian.jira.plugin.system.customfieldtypes:userpicker",
});
const rank = f(RANK_FIELD, "Rank", { type: "any", custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" });

/** Each issue type's create screen. */
export const FIELDS: Record<string, Field[]> = {
  [ISSUE_TYPES.epic.id]: [...COMMON, team(false)],
  [ISSUE_TYPES.story.id]: [...COMMON, team(true), startDate, parent, proposal, region, reviewer, rank],
  [ISSUE_TYPES.task.id]: [...COMMON, team(false), startDate, parent],
  [ISSUE_TYPES.subtask.id]: [...COMMON, { ...parent, required: true }],
};

export interface ServedProject {
  /** Every issue Jira created, in order, with the fields it was sent. */
  created: Array<{ key: string; id: string; fields: Record<string, unknown> }>;
}

/** Add ENG's routes to a running fake Jira. */
export function serveProject(jira: FakeJira): ServedProject {
  const created: ServedProject["created"] = [];
  const base = `/rest/api/3/issue/createmeta/${PROJECT.key}/issuetypes`;

  jira.route("GET", `/rest/api/3/project/${PROJECT.key}`, () => ({ body: PROJECT }));
  jira.route("GET", base, () => ({
    body: { startAt: 0, maxResults: 50, total: 4, issueTypes: Object.values(ISSUE_TYPES) },
  }));
  for (const [id, fields] of Object.entries(FIELDS)) {
    jira.route("GET", `${base}/${id}`, () => ({ body: { startAt: 0, maxResults: 50, total: fields.length, fields } }));
  }
  jira.route("GET", "/rest/api/3/user/assignable/search", () => ({ body: [DAN] }));
  // The site-wide search: everyone, plus an app account Jira returns too and the app must not offer.
  jira.route("GET", "/rest/api/3/user/search", () => ({
    body: [DAN, PRIYA, { accountId: "acc-bot", displayName: "Automation", active: true, accountType: "app" }],
  }));

  jira.route("POST", "/rest/api/3/issue", (req: FakeJiraRequest) => {
    const { fields } = JSON.parse(req.body) as { fields: Record<string, unknown> };
    const errors: Record<string, string> = {};
    const project = fields.project as { key?: string } | undefined;
    const type = fields.issuetype as { id?: string } | undefined;
    if (project?.key !== PROJECT.key) errors.project = "valid project is required";
    if (!type?.id || !FIELDS[type.id]) errors.issuetype = "valid issue type is required";
    if (type?.id === ISSUE_TYPES.story.id && !fields[TEAM_FIELD]) errors[TEAM_FIELD] = "Team is required.";
    const doc = fields[PROPOSAL_FIELD] as { type?: string; version?: number } | undefined;
    if (doc !== undefined && (doc?.type !== "doc" || doc.version !== 1)) {
      errors[PROPOSAL_FIELD] = "Operation value must be an Atlassian Document (see the Atlassian Document Format).";
    }
    const where = fields[REGION_FIELD] as { id?: string; child?: { id?: string } } | undefined;
    if (where !== undefined && !REGIONS.some((r) => r.id === where?.id && (!where.child || r.children.some((c) => c.id === where.child?.id)))) {
      errors[REGION_FIELD] = "Specify a valid value for Region";
    }
    if (RANK_FIELD in fields) errors[RANK_FIELD] = "Field 'Rank' cannot be set. It is not on the appropriate screen, or unknown.";
    for (const key of Object.keys(fields)) {
      if (type?.id && FIELDS[type.id] && key !== "parent" && !FIELDS[type.id].some((x) => x.fieldId === key)) {
        errors[key] = `Field '${key}' cannot be set. It is not on the appropriate screen, or unknown.`;
      }
    }
    if (Object.keys(errors).length) return { status: 400, body: { errorMessages: [], errors } };

    const n = created.length + 1;
    const issue = { key: `${PROJECT.key}-${n}`, id: String(20000 + n), fields };
    created.push(issue);
    return { status: 201, body: { id: issue.id, key: issue.key, self: `https://localhost/rest/api/3/issue/${issue.id}` } };
  });

  return { created };
}
