/**
 * What one Jira project lets you create, read from the project itself.
 *
 * Everything here is scoped to the one project being pushed to. Discovery used
 * to match names against `GET /rest/api/3/field`, which lists every field on
 * the *site* — so it could pick a field that exists somewhere on the instance
 * and is not on this project's create screen, which Jira then refuses at
 * create time. The project's own create metadata is the only list that means
 * "you may send this here".
 *
 * Fields are per issue type. A field can be required on Story and absent from
 * Epic, so nothing below works on a union of fields: validation, required-field
 * checks and editor choices all take one issue type at a time.
 *
 * The top half is pure — types, classification, validation — so the desktop
 * renderer can import it through the `todo-vault/jira-meta` subpath. That is
 * safe because `jira-client.ts` touches nothing Node-only at import time:
 * `Buffer` is used inside a request, which the renderer never makes. The
 * fetches at the bottom take a client as an argument, so the credential stays
 * wherever the client was built — the main process.
 */
import { z } from "zod";

import type { JiraClient } from "./jira-client.js";
import { parseOrThrow } from "./jira-client.js";

// ------------------------------------------------------------------ types

/** A field's type as Jira describes it on the create screen. */
export interface JiraFieldSchema {
  type: string;
  /** For `array`: the element type. */
  items?: string;
  /** For custom fields: the plugin key, e.g. `com.atlassian.jira.plugin.system.customfieldtypes:select`. */
  custom?: string;
  /** For system fields: its name, e.g. `priority`. */
  system?: string;
}

/** One field on one issue type's create screen. */
export interface JiraFieldMeta {
  fieldId: string;
  name: string;
  required: boolean;
  /** Jira fills it in when nothing is sent — a required field with a default is not a gap. */
  hasDefaultValue: boolean;
  schema: JiraFieldSchema;
  /** The values Jira will accept, for option, version, component and priority fields. */
  allowedValues?: unknown[];
  operations: string[];
}

export interface IssueTypeMeta {
  id: string;
  name: string;
  subtask: boolean;
  /** Empty until fetched: fields are read only for the issue types the map uses. */
  fields: JiraFieldMeta[];
}

export interface ProjectMeta {
  /** The site, for knowing which cache this is. */
  site: string;
  projectKey: string;
  projectId: string;
  projectName: string;
  /** `classic` (company-managed) or `next-gen` (team-managed), when Jira says. */
  style?: string;
  issueTypes: IssueTypeMeta[];
  /** ISO timestamp. A push refuses metadata older than the map it validates. */
  fetchedAt: string;
}

/** A person who can be assigned in the project. */
export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
}

// ------------------------------------------------------ pure: classification

/**
 * Which editor a field needs, and therefore what shape its value is stored in.
 *
 * The mapping editor draws one control per kind, and the value it produces is
 * already in the shape Jira's create API takes, so the push never translates.
 * `raw` is the escape hatch: Sprint, Atlassian Team and app-provided fields
 * have schemas that differ between sites and change without notice, and
 * refusing them would make the most-requested extra fields unmappable. A raw
 * value is sent exactly as written.
 */
export type FieldValueKind =
  | "text"
  | "richText"
  | "number"
  | "date"
  | "datetime"
  | "option"
  | "options"
  | "cascading"
  | "user"
  | "users"
  | "version"
  | "versions"
  | "component"
  | "components"
  | "priority"
  | "labels"
  | "raw";

const TEXTAREA = "com.atlassian.jira.plugin.system.customfieldtypes:textarea";
const CASCADING = "com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect";

export function valueKindFor(schema: JiraFieldSchema): FieldValueKind {
  if (schema.custom === CASCADING || schema.type === "option-with-child") return "cascading";
  switch (schema.type) {
    case "string":
      // Textarea custom fields and the two system rich-text fields take ADF on
      // the v3 API; a plain string there is a 400.
      return schema.custom === TEXTAREA || schema.system === "description" || schema.system === "environment"
        ? "richText"
        : "text";
    case "number":
      return "number";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "option":
      return "option";
    case "user":
      return "user";
    case "version":
      return "version";
    case "component":
      return "component";
    case "priority":
      return "priority";
    case "array":
      switch (schema.items) {
        case "option":
          return "options";
        case "user":
          return "users";
        case "version":
          return "versions";
        case "component":
          return "components";
        case "string":
          return schema.system === "labels" ? "labels" : "raw";
        default:
          return "raw";
      }
    default:
      return "raw";
  }
}

// --------------------------------------------------------- pure: validation

/**
 * Fields Jira always receives from the push itself, whatever the map says:
 * `project` and `issuetype` identify the create, and `summary` is every
 * item's own. `parent` is filled when the item has one and is deliberately not
 * listed — a required parent is a real gap for an item without one.
 */
export const ALWAYS_SENT: ReadonlySet<string> = new Set(["project", "issuetype", "summary"]);

/**
 * Required fields on one issue type that nothing will fill in.
 *
 * `covered` is every field id the push will send for this issue type — the
 * mapped vault fields plus the extra fields that apply to it. A field is a gap
 * when Jira requires it, has no default of its own, and is not covered. Each
 * gap is a setup error: the settings panel shows it, and the push refuses to
 * send an issue of this type until it is closed.
 */
export function requiredGaps(issueType: IssueTypeMeta, covered: ReadonlySet<string>): JiraFieldMeta[] {
  return issueType.fields.filter(
    (field) =>
      field.required && !field.hasDefaultValue && !ALWAYS_SENT.has(field.fieldId) && !covered.has(field.fieldId),
  );
}

/** A field on a given issue type, by id. Undefined means that type's create screen does not have it. */
export function fieldOn(issueType: IssueTypeMeta, fieldId: string): JiraFieldMeta | undefined {
  return issueType.fields.find((f) => f.fieldId === fieldId);
}

/** An issue type by its name, case-insensitively, since the map stores names a person typed. */
export function issueTypeNamed(meta: ProjectMeta, name: string): IssueTypeMeta | undefined {
  const wanted = name.trim().toLowerCase();
  return meta.issueTypes.find((t) => t.name.toLowerCase() === wanted);
}

/**
 * Every distinct field across the fetched issue types, once each — for
 * name-matching during discovery, where the question is "does this project
 * have a Start date field at all", not "on which type".
 */
export function distinctFields(meta: ProjectMeta): JiraFieldMeta[] {
  const seen = new Map<string, JiraFieldMeta>();
  for (const type of meta.issueTypes) {
    for (const field of type.fields) if (!seen.has(field.fieldId)) seen.set(field.fieldId, field);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- network

/*
 * Response shapes are read tolerantly on one point, deliberately. Atlassian's
 * reference documents the paginated createmeta endpoints with `issueTypes` and
 * `fields` as the list keys; older documentation and some deployments return
 * `values`. Both are accepted rather than betting on one, and the one-time
 * check against a real project (see plans/PLAN-jira-push.md) settles which a
 * given site sends. Everything else is read strictly, so a genuine change fails
 * here and names the path.
 */

const Page = z
  .object({
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    total: z.number().optional(),
    isLast: z.boolean().optional(),
  })
  .passthrough();

const IssueTypeEntry = z.object({
  id: z.string(),
  name: z.string(),
  subtask: z.boolean().default(false),
});

const FieldEntry = z.object({
  fieldId: z.string(),
  name: z.string(),
  required: z.boolean().default(false),
  hasDefaultValue: z.boolean().default(false),
  schema: z
    .object({
      type: z.string(),
      items: z.string().optional(),
      custom: z.string().optional(),
      system: z.string().optional(),
    })
    .passthrough(),
  allowedValues: z.array(z.unknown()).optional(),
  operations: z.array(z.string()).default([]),
});

const ProjectResponse = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  style: z.string().optional(),
});

const UsersResponse = z.array(
  z.object({
    accountId: z.string(),
    displayName: z.string(),
    emailAddress: z.string().optional(),
    active: z.boolean().default(true),
    accountType: z.string().optional(),
  }),
);

/** The list in a createmeta page, under whichever key this site uses. */
function pageItems(page: Record<string, unknown>, keys: readonly string[]): unknown[] {
  for (const key of keys) {
    const value = page[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * Read every page of a paginated createmeta list. Stops on `isLast`, on
 * reaching `total`, or on an empty page — whichever the site reports — with a
 * hard ceiling so a site that never says "last" cannot loop forever.
 */
async function readAllPages<S extends z.ZodTypeAny>(
  client: JiraClient,
  path: string,
  listKeys: readonly string[],
  entry: S,
): Promise<z.output<S>[]> {
  const out: z.output<S>[] = [];
  const pageSize = 50;
  for (let startAt = 0, guard = 0; guard < 100; guard += 1) {
    const page = parseOrThrow(Page, await client.get(path, { startAt, maxResults: pageSize }), path);
    const items = pageItems(page, listKeys);
    for (const item of items) out.push(parseOrThrow(entry, item, path));
    startAt += items.length;
    if (page.isLast === true || items.length === 0) break;
    if (page.total !== undefined && startAt >= page.total) break;
  }
  return out;
}

function projectPath(projectKey: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,254}$/i.test(projectKey)) {
    throw new Error(`"${projectKey}" is not a Jira project key.`);
  }
  return encodeURIComponent(projectKey);
}

/** `GET /rest/api/3/project/{key}` — proves the project exists and the account can see it. */
export async function fetchProject(
  client: JiraClient,
  projectKey: string,
): Promise<{ id: string; key: string; name: string; style?: string }> {
  const path = `/rest/api/3/project/${projectPath(projectKey)}`;
  return parseOrThrow(ProjectResponse, await client.get(path), path);
}

/** The issue types this project can create, without their fields. */
export async function fetchIssueTypes(client: JiraClient, projectKey: string): Promise<IssueTypeMeta[]> {
  const path = `/rest/api/3/issue/createmeta/${projectPath(projectKey)}/issuetypes`;
  const types = await readAllPages(client, path, ["issueTypes", "values"], IssueTypeEntry);
  return types.map((t) => ({ ...t, fields: [] }));
}

/** One issue type's create-screen fields in this project. */
export async function fetchFieldsFor(
  client: JiraClient,
  projectKey: string,
  issueTypeId: string,
): Promise<JiraFieldMeta[]> {
  if (!/^\d+$/.test(issueTypeId)) throw new Error(`"${issueTypeId}" is not an issue type id.`);
  const path = `/rest/api/3/issue/createmeta/${projectPath(projectKey)}/issuetypes/${issueTypeId}`;
  return readAllPages(client, path, ["fields", "results", "values"], FieldEntry);
}

/**
 * Everything the mapping editor and the validator need about one project.
 *
 * Fields are fetched only for `issueTypeNames` when given — the types the map
 * actually uses — because each one is its own paginated request and a project
 * can carry a dozen types nobody pushes to. With no names, every type's fields
 * are read, which is what first-time setup wants.
 */
export async function fetchProjectMeta(
  client: JiraClient,
  projectKey: string,
  options: { issueTypeNames?: readonly string[]; now?: () => Date } = {},
): Promise<ProjectMeta> {
  const project = await fetchProject(client, projectKey);
  const issueTypes = await fetchIssueTypes(client, project.key);
  const wanted = options.issueTypeNames?.map((n) => n.trim().toLowerCase());

  for (const type of issueTypes) {
    if (wanted && !wanted.includes(type.name.toLowerCase())) continue;
    type.fields = await fetchFieldsFor(client, project.key, type.id);
  }

  return {
    site: client.site,
    projectKey: project.key,
    projectId: project.id,
    projectName: project.name,
    style: project.style,
    issueTypes,
    fetchedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

/**
 * People who can be assigned in this project, matching `query`.
 *
 * The *assignable* search rather than the general user search, because the
 * only accounts worth mapping a vault name to are ones Jira will accept as an
 * assignee here. Inactive accounts are dropped: an assignee Jira refuses is
 * worse than none.
 */
export async function searchAssignable(
  client: JiraClient,
  projectKey: string,
  query: string,
): Promise<JiraUser[]> {
  const path = "/rest/api/3/user/assignable/search";
  const users = parseOrThrow(
    UsersResponse,
    await client.get(path, { project: projectKey, query: query.trim(), maxResults: 20 }),
    path,
  );
  return users
    .filter((u) => u.active && (u.accountType === undefined || u.accountType === "atlassian"))
    .map(({ accountId, displayName, emailAddress, active }) => ({ accountId, displayName, emailAddress, active }));
}
