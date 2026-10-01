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

import { isAdfDoc, markdownToAdf } from "./jira-adf.js";

// Re-exported so the renderer, which imports this module and never jira.ts,
// can show a stored paragraph value as text and check what a person typed.
export { adfToMarkdown, isAdfDoc, markdownToAdf } from "./jira-adf.js";
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
 * Which editor a field needs, and how `shapeFieldValue` reads what is typed into it.
 *
 * The editors take what a person would naturally write: an option's name, a
 * paragraph of markdown, a person's name, a comma list. `shapeFieldValue` turns
 * that into Jira's create shape when the push is planned. `managed` fields are
 * Jira's own (Rank) and are never sent. `raw` covers app-provided fields whose
 * shape no schema describes. A string there is sent as a string, and JSON stays
 * possible for the rare field that needs an object.
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
  | "strings"
  | "sprint"
  | "team"
  | "group"
  | "groups"
  | "project"
  | "managed"
  | "raw";

const TEXTAREA = "com.atlassian.jira.plugin.system.customfieldtypes:textarea";
const CASCADING = "com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect";
const LABELS = "com.atlassian.jira.plugin.system.customfieldtypes:labels";
const SPRINT = "com.pyxis.greenhopper.jira:gh-sprint";
const TEAM = "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team";
/** Fields Jira keeps for itself. Rank is the board's ordering, and a create that sends one is refused. */
const MANAGED: ReadonlySet<string> = new Set(["com.pyxis.greenhopper.jira:gh-lexo-rank"]);

export function valueKindFor(schema: JiraFieldSchema): FieldValueKind {
  if (schema.custom && MANAGED.has(schema.custom)) return "managed";
  if (schema.custom === CASCADING || schema.type === "option-with-child") return "cascading";
  if (schema.custom === SPRINT) return "sprint";
  if (schema.custom === TEAM || schema.type === "team") return "team";
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
    case "group":
      return "group";
    case "project":
      return "project";
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
          return schema.system === "labels" || schema.custom === LABELS ? "labels" : "strings";
        case "group":
          return "groups";
        default:
          return "raw";
      }
    default:
      return "raw";
  }
}

// -------------------------------------------------------- pure: shaping

/** What `shapeFieldValue` needs beyond the field: the map's people, to turn a name into an account. */
export interface ShapeContext {
  /** The map's `people`: a vault spelling, case-folded on lookup, to a Jira account. */
  people?: Readonly<Record<string, { accountId: string }>>;
}

/**
 * The value Jira's create API takes for this field, from what a person wrote.
 *
 * `value: undefined` means "send nothing": an empty value, or a field Jira
 * manages itself. A failure carries a message that names what was wrong and,
 * for a list of options, what Jira would accept, because the person has to fix
 * it before the push can go.
 */
export type ShapedValue = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Turn a typed value into Jira's shape for one field on one create screen.
 *
 * The person types what they mean: `Payments` for an option, a paragraph for a
 * paragraph field, `Dan Okafor` for a user, `a, b` for a list. This builds the
 * JSON. A value already in Jira's shape (`{ id }`, an ADF document, an
 * `{ accountId }`) is returned as it is, so a map written before this still
 * pushes unchanged.
 *
 * Pure, and free of Node imports, so the settings panel can call it as a person
 * types and show a mistake under the field rather than only at push time.
 */
export function shapeFieldValue(field: JiraFieldMeta, value: unknown, ctx: ShapeContext = {}): ShapedValue {
  if (isEmpty(value)) return ok(undefined);
  const kind = valueKindFor(field.schema);
  const allowed = field.allowedValues;
  switch (kind) {
    case "managed":
      return ok(undefined);
    case "text":
      return typeof value === "object" ? fail(`${field.name} takes plain text.`) : ok(String(value));
    case "richText":
      if (isAdfDoc(value)) return ok(value);
      return typeof value === "object" ? fail(`${field.name} takes text.`) : ok(markdownToAdf(String(value)));
    case "number":
    case "sprint": {
      const n = asNumber(Array.isArray(value) && value.length === 1 ? value[0] : value);
      if (n === undefined) {
        return fail(
          kind === "sprint"
            ? `${field.name} takes a sprint's number, the one in the board's URL when that sprint is selected.`
            : `${field.name} takes a number, not "${String(value)}".`,
        );
      }
      return ok(n);
    }
    case "date": {
      const s = String(value).trim();
      const m = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(s);
      return m ? ok(m[1]) : fail(`${field.name} takes a date written as YYYY-MM-DD, not "${s}".`);
    }
    case "datetime":
      return shapeDatetime(field, value);
    case "option":
    case "priority":
    case "version":
    case "component":
      return pickOne(field, value, kind === "option" ? "value" : "name");
    case "options":
    case "versions":
    case "components":
      return eachOf(listOf(value), (v) => pickOne(field, v, kind === "options" ? "value" : "name"));
    case "cascading":
      return shapeCascading(field, value);
    case "user":
      return shapeUser(field, value, ctx);
    case "users":
      return eachOf(listOf(value), (v) => shapeUser(field, v, ctx));
    case "group":
      return shapeGroup(value);
    case "groups":
      return eachOf(listOf(value), shapeGroup);
    case "project": {
      if (typeof value === "object") return ok(value);
      const typed = String(value).trim();
      return ok(/^\d+$/.test(typed) ? { id: typed } : { key: typed.toUpperCase() });
    }
    case "labels":
      // Jira refuses a label with a space in it, so the space becomes a hyphen,
      // the same as the category does when it is folded into labels.
      return ok(listOf(value).map((v) => String(v).trim().replace(/\s+/g, "-")).filter(Boolean));
    case "strings":
      return ok(listOf(value).map((v) => String(v).trim()).filter(Boolean));
    case "team":
      // The team's id, as a string. Whether every site takes the bare id or an
      // `{ id }` is unverified, so an object is left exactly as written.
      return ok(typeof value === "string" ? value.trim() : value);
    case "raw":
      return shapeRaw(field, value);
  }
}

function ok(value: unknown): ShapedValue {
  return { ok: true, value };
}

function fail(message: string): ShapedValue {
  return { ok: false, message };
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** An array as it is, or a comma-separated string split into one. */
function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [value];
}

/** Shape each element; the first failure is the answer. */
function eachOf(values: unknown[], shape: (v: unknown) => ShapedValue): ShapedValue {
  const out: unknown[] = [];
  for (const v of values) {
    const r = shape(v);
    if (!r.ok) return r;
    if (r.value !== undefined) out.push(r.value);
  }
  return ok(out);
}

interface AllowedEntry {
  id: string;
  label: string;
  /** Every spelling a person might type for it, lower-cased: id, name, value, key. */
  spellings: string[];
  children: AllowedEntry[];
}

function allowedEntries(allowed: unknown[] | undefined): AllowedEntry[] {
  return (allowed ?? []).flatMap((entry): AllowedEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" && typeof e.id !== "number") return [];
    const id = String(e.id);
    const words = ["name", "value", "key"].map((k) => e[k]).filter((v): v is string => typeof v === "string");
    return [
      {
        id,
        label: words[0] ?? id,
        spellings: [id, ...words].map((w) => w.trim().toLowerCase()),
        children: allowedEntries(Array.isArray(e.children) ? e.children : undefined),
      },
    ];
  });
}

function findEntry(entries: AllowedEntry[], typed: string): AllowedEntry | undefined {
  const wanted = typed.trim().toLowerCase();
  return entries.find((e) => e.spellings.includes(wanted));
}

function notOneOf(field: JiraFieldMeta, typed: string, entries: AllowedEntry[]): ShapedValue {
  const names = entries.map((e) => e.label);
  const shown =
    names.length > 12 ? `${names.slice(0, 12).join(", ")}, and ${names.length - 12} more` : names.join(", ");
  return fail(`${field.name} has no option "${typed}". Jira offers: ${shown}.`);
}

/**
 * One option, version, component or priority, as `{ id }`.
 *
 * Ids are what is sent wherever Jira lists the values, because names get
 * renamed. A field whose create screen lists no values is sent by name or
 * value instead, which Jira also accepts and checks itself.
 */
function pickOne(field: JiraFieldMeta, value: unknown, byWord: "name" | "value"): ShapedValue {
  const entries = allowedEntries(field.allowedValues);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (entries.length === 0) return ok(value);
    if (typeof v.id === "string" || typeof v.id === "number") {
      return entries.some((e) => e.id === String(v.id))
        ? ok({ id: String(v.id) })
        : fail(
            `The saved choice for ${field.name} (id ${String(v.id)}) is no longer one of Jira's options. Choose it again in Settings → Jira.`,
          );
    }
    const word = [v.name, v.value].find((w): w is string => typeof w === "string");
    if (word === undefined) return ok(value);
    value = word;
  }
  const typed = String(value);
  if (entries.length === 0) return ok({ [byWord]: typed.trim() });
  const entry = findEntry(entries, typed);
  return entry ? ok({ id: entry.id }) : notOneOf(field, typed, entries);
}

/** A two-level select: `Parent / Child`, `Parent > Child`, or just `Parent`. */
function shapeCascading(field: JiraFieldMeta, value: unknown): ShapedValue {
  if (typeof value === "object") return ok(value);
  const entries = allowedEntries(field.allowedValues);
  const [parentText, childText] = String(value).split(/\s*[/>]\s*/, 2);
  if (entries.length === 0) {
    return ok(childText ? { value: parentText, child: { value: childText } } : { value: parentText });
  }
  const parent = findEntry(entries, parentText);
  if (!parent) return notOneOf(field, parentText, entries);
  if (!childText) return ok({ id: parent.id });
  const child = findEntry(parent.children, childText);
  if (!child) {
    const offered = parent.children.map((c) => c.label).join(", ") || "nothing";
    return fail(`${field.name} has no "${childText}" under "${parent.label}". Jira offers: ${offered}.`);
  }
  return ok({ id: parent.id, child: { id: child.id } });
}

/**
 * A person, as `{ accountId }`. A name is looked up in the map's people, the
 * same table the assignee uses. Something shaped like an account id is taken
 * as one, since that is what a person copies from a Jira profile URL.
 */
function shapeUser(field: JiraFieldMeta, value: unknown, ctx: ShapeContext): ShapedValue {
  if (value && typeof value === "object") return ok(value);
  const typed = String(value).trim();
  const wanted = typed.toLowerCase();
  for (const [name, entry] of Object.entries(ctx.people ?? {})) {
    if (name.trim().toLowerCase() === wanted) return ok({ accountId: entry.accountId });
  }
  if (/^[0-9a-f]{24}$/i.test(typed) || /^\d+:[0-9a-f-]{36}$/i.test(typed)) return ok({ accountId: typed });
  return fail(`${field.name}: "${typed}" has no Jira account. Link them in Settings → Jira → People.`);
}

function shapeGroup(value: unknown): ShapedValue {
  return typeof value === "object" ? ok(value) : ok({ name: String(value).trim() });
}

/**
 * A date and time in the form Jira documents, `2026-10-01T09:00:00.000+0100`.
 * A browser's datetime input gives `2026-10-01T09:00`, with no seconds and no
 * zone. That is read as local time, which is what the person picking it meant.
 */
function shapeDatetime(field: JiraFieldMeta, value: unknown): ShapedValue {
  const s = String(value).trim();
  const when = new Date(s);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(when.getTime())) {
    return fail(`${field.name} takes a date and time, not "${s}".`);
  }
  const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, "0");
  const offset = -when.getTimezoneOffset();
  const zone = `${offset >= 0 ? "+" : "-"}${pad(Math.trunc(offset / 60))}${pad(offset % 60)}`;
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}.${pad(when.getMilliseconds(), 3)}`;
  return ok(`${date}T${time}${zone}`);
}

/**
 * A field whose schema says nothing usable. If Jira lists its values, it is
 * treated as a select over them. Otherwise a string goes as a string, a number
 * field gets a number, and JSON stays possible for an app field that wants an
 * object.
 */
function shapeRaw(field: JiraFieldMeta, value: unknown): ShapedValue {
  if (typeof value !== "string") return ok(value);
  const text = value.trim();
  if (allowedEntries(field.allowedValues).length) {
    return field.schema.type === "array"
      ? eachOf(listOf(text), (v) => pickOne(field, v, "value"))
      : pickOne(field, text, "value");
  }
  if (/^[[{]/.test(text)) {
    try {
      return ok(JSON.parse(text));
    } catch {
      // Not JSON after all, so it goes as the string it is.
    }
  }
  if (field.schema.type === "array") return ok(listOf(text));
  return ok(text);
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

/**
 * People on the site matching `query`, for a user field that is not the
 * assignee, such as a reviewer or an approver.
 *
 * The assignable search answers "who may be assigned here", which is the wrong
 * question for those fields, so this is the general user search. It needs the
 * Browse users and groups permission, which most accounts have. As with the
 * assignee, only active human accounts are offered.
 */
export async function searchUsers(client: JiraClient, query: string): Promise<JiraUser[]> {
  const path = "/rest/api/3/user/search";
  const users = parseOrThrow(UsersResponse, await client.get(path, { query: query.trim(), maxResults: 20 }), path);
  return users
    .filter((u) => u.active && (u.accountType === undefined || u.accountType === "atlassian"))
    .map(({ accountId, displayName, emailAddress, active }) => ({ accountId, displayName, emailAddress, active }));
}
