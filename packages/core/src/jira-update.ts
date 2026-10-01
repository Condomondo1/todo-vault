/**
 * Updating issues already in Jira whose vault items have changed since.
 *
 * The create path writes a new issue and never looks at Jira first. An update
 * cannot work that way: someone may have edited the issue in Jira since the
 * push, and the vault keeps only a hash of what it sent, not the values. So an
 * update reads what Jira holds now, sets it beside what the vault would send,
 * and offers only the fields that differ, one by one, for a person to choose.
 * Nothing is sent that was not shown.
 *
 * Three steps, each separate so the pane can stand between them:
 * - `readIssueState`: the issue's current values and its edit screen.
 * - `diffIssue`: pure. Which fields differ, as a person reads them, and which
 *   of those Jira will let this issue's edit screen change.
 * - `sendUpdates`: one `PUT` per issue with the chosen fields, then a restamp.
 *
 * No journal, unlike the create. A `PUT` of the same fields twice leaves the
 * issue as one `PUT` would, so a dropped connection is safe to retry.
 */
import { z } from "zod";

import { adfToMarkdown, isAdfDoc } from "./jira-adf.js";
import { JiraError, parseOrThrow, type JiraClient } from "./jira-client.js";
import { shapeFieldValue, type JiraFieldMeta, type ShapeContext } from "./jira-meta.js";
import { issueUrl } from "./jira-push.js";
import type { JiraIssueUpdate } from "./jira.js";

// ------------------------------------------------------------------ read

/** What Jira holds for one issue now, and what its edit screen lets change. */
export interface IssueState {
  /** Jira's current values, by field id, for the fields the update touches. */
  fields: Record<string, unknown>;
  /** The edit screen, by field id. A field missing here cannot be changed on this issue. */
  editable: Record<string, JiraFieldMeta>;
}

const IssueResponse = z.object({ id: z.string(), key: z.string(), fields: z.record(z.unknown()) });

const EditMetaResponse = z.object({
  fields: z.record(
    z
      .object({
        name: z.string(),
        required: z.boolean().default(false),
        schema: z
          .object({
            type: z.string(),
            items: z.string().optional(),
            custom: z.string().optional(),
            system: z.string().optional(),
          })
          .passthrough()
          .default({ type: "any" }),
        allowedValues: z.array(z.unknown()).optional(),
        operations: z.array(z.string()).default([]),
      })
      .passthrough(),
  ),
});

function issuePath(jiraKey: string): string {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(jiraKey)) throw new Error(`"${jiraKey}" is not a Jira issue key.`);
  return `/rest/api/3/issue/${jiraKey}`;
}

/**
 * `GET /issue/{key}` for the fields this update touches, and `/editmeta` for
 * what may be changed. The edit screen is its own list, not the create
 * screen: a field can be set at create and locked afterwards, or the reverse.
 */
export async function readIssueState(client: JiraClient, update: JiraIssueUpdate): Promise<IssueState> {
  const path = issuePath(update.jiraKey);
  const wanted = [...new Set([...Object.keys(update.fields), "issuetype"])].join(",");
  const issue = parseOrThrow(IssueResponse, await client.get(path, { fields: wanted }), path);
  const metaPath = `${path}/editmeta`;
  const meta = parseOrThrow(EditMetaResponse, await client.get(metaPath), metaPath);
  const editable: Record<string, JiraFieldMeta> = {};
  for (const [fieldId, f] of Object.entries(meta.fields)) {
    editable[fieldId] = {
      fieldId,
      name: f.name,
      required: f.required,
      hasDefaultValue: false,
      schema: f.schema,
      ...(f.allowedValues ? { allowedValues: f.allowedValues } : {}),
      operations: f.operations,
    };
  }
  return { fields: issue.fields, editable };
}

// ------------------------------------------------------------------ diff

/** One field that differs between Jira and the vault. */
export interface JiraFieldChange {
  fieldId: string;
  /** Jira's name for it where the edit screen says, else a plain name for the system fields. */
  name: string;
  /** Jira's value now, as a person reads it. Empty when it has none. */
  jiraText: string;
  /** The vault's value, as a person reads it. Empty when the vault cleared it. */
  vaultText: string;
  /** What the update sends for this field, in Jira's shape. `null` clears it. */
  value: unknown;
  /** Whether Jira will take a change to this field on this issue. */
  editable: boolean;
  /** Why not, when it will not. */
  reason?: string;
}

export interface IssueDiff {
  changes: JiraFieldChange[];
  /** Differences an update cannot carry, said rather than silently left: a changed issue type. */
  warnings: string[];
}

const SYSTEM_NAMES: Record<string, string> = {
  summary: "Summary",
  description: "Description",
  priority: "Priority",
  labels: "Labels",
  components: "Components",
  assignee: "Assignee",
  duedate: "Due date",
  parent: "Parent",
};

/**
 * The fields where the vault and Jira disagree, in the order the vault builds
 * them. Equal fields are left out, so a change made in Jira that the vault
 * also has does not show, and an item whose every field already matches has
 * no changes. That one only needs restamping, with nothing sent.
 */
export function diffIssue(update: JiraIssueUpdate, state: IssueState, ctx: ShapeContext = {}): IssueDiff {
  const changes: JiraFieldChange[] = [];
  const warnings: string[] = [];

  const jiraType = (state.fields.issuetype as { name?: unknown } | undefined)?.name;
  if (typeof jiraType === "string" && jiraType.toLowerCase() !== update.issueType.toLowerCase()) {
    warnings.push(
      `${update.localKey} is a ${update.issueType} here and a ${jiraType} in Jira (${update.jiraKey}). An update cannot change an issue's type; use Move in Jira.`,
    );
  }

  for (const [fieldId, vaultValue] of Object.entries(update.fields)) {
    const meta = state.editable[fieldId];
    const jiraValue = state.fields[fieldId];
    const name = meta?.name ?? SYSTEM_NAMES[fieldId] ?? fieldId;

    let value = vaultValue;
    let refused: string | undefined;
    if (meta && update.typed.includes(fieldId) && !isBlank(vaultValue)) {
      const shaped = shapeFieldValue(meta, vaultValue, ctx);
      if (shaped.ok) value = shaped.value ?? null;
      else refused = shaped.message;
    }

    if (!refused && same(value, jiraValue)) continue;

    let reason = refused;
    if (!reason && !meta) reason = `${update.jiraKey}'s edit screen has no ${name} field, so Jira will not take a change to it.`;
    if (!reason && meta && meta.operations.length > 0 && !meta.operations.includes("set")) {
      reason = `Jira does not allow ${name} to be set on ${update.jiraKey}.`;
    }
    if (!reason && fieldId === "parent" && value === null) {
      reason = "Removing an issue's parent is done in Jira.";
    }

    changes.push({
      fieldId,
      name,
      jiraText: textOf(jiraValue, ctx),
      vaultText: textOf(vaultValue, ctx),
      value,
      editable: !reason,
      ...(reason ? { reason } : {}),
    });
  }

  return { changes, warnings };
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  return Array.isArray(value) && value.length === 0;
}

/**
 * Whether Jira's value already is what the vault would send. Driven by the
 * vault's side: only the keys it sends are compared, so `{ name: "High" }`
 * matches Jira's `{ id: "2", name: "High", iconUrl: … }`, and a list matches in
 * any order. Rich text is compared as the markdown it reads as, because Jira
 * hands ADF back with ids and attributes it added itself.
 */
function same(ours: unknown, theirs: unknown): boolean {
  if (isBlank(ours)) return isBlank(theirs);
  if (isAdfDoc(ours)) return isAdfDoc(theirs) && adfToMarkdown(ours).trim() === adfToMarkdown(theirs).trim();
  if (Array.isArray(ours)) {
    if (!Array.isArray(theirs) || theirs.length !== ours.length) return false;
    const left = [...theirs];
    return ours.every((o) => {
      const at = left.findIndex((t) => same(o, t));
      if (at < 0) return false;
      left.splice(at, 1);
      return true;
    });
  }
  if (ours && typeof ours === "object") {
    if (!theirs || typeof theirs !== "object") return false;
    const t = theirs as Record<string, unknown>;
    return Object.entries(ours).every(([key, value]) =>
      (key === "name" || key === "value") && typeof value === "string" && typeof t[key] === "string"
        ? value.toLowerCase() === (t[key] as string).toLowerCase()
        : same(value, t[key]),
    );
  }
  if (typeof ours === "number") return Number(theirs) === ours;
  return ours === theirs;
}

/** A value as a person reads it: names over ids, rich text as its markdown, a list joined. */
function textOf(value: unknown, ctx: ShapeContext): string {
  if (isBlank(value)) return "";
  if (isAdfDoc(value)) return adfToMarkdown(value);
  if (Array.isArray(value)) return value.map((v) => textOf(v, ctx)).join(", ");
  if (typeof value !== "object") return String(value);
  const v = value as Record<string, unknown>;
  let text: string | undefined;
  for (const key of ["displayName", "name", "value", "key"]) {
    if (typeof v[key] === "string") {
      text = v[key] as string;
      break;
    }
  }
  if (text === undefined && typeof v.accountId === "string") text = personName(v.accountId, ctx);
  if (text === undefined && (typeof v.id === "string" || typeof v.id === "number")) text = String(v.id);
  const child = v.child !== undefined ? textOf(v.child, ctx) : "";
  return child ? `${text ?? ""} / ${child}` : (text ?? JSON.stringify(value));
}

/** The vault's name for an account, from the map's people, or the id when nobody is linked to it. */
function personName(accountId: string, ctx: ShapeContext): string {
  for (const [name, entry] of Object.entries(ctx.people ?? {})) {
    if (entry.accountId === accountId) {
      const display = (entry as { displayName?: unknown }).displayName;
      return typeof display === "string" ? display : name;
    }
  }
  return accountId;
}

// ------------------------------------------------------------------ send

/** One issue's update as a person chose it. Empty `fields` means "already matches; just restamp". */
export interface UpdateChoice {
  localKey: string;
  jiraKey: string;
  jiraId?: string;
  /** Field id to the value to send, in Jira's shape: the chosen `JiraFieldChange.value`s. */
  fields: Record<string, unknown>;
}

export type UpdateProgress =
  | { localKey: string; state: "updating" }
  | { localKey: string; state: "updated"; jiraKey: string; url: string }
  | { localKey: string; state: "failed"; message: string };

export interface UpdateOutcome {
  /** `fields` is what was sent; empty when the item was only marked as matching Jira. */
  updated: Array<{ localKey: string; jiraKey: string; url: string; fields: string[] }>;
  failed: Array<{ localKey: string; message: string; fieldErrors: Record<string, string> }>;
}

export interface UpdateSendOptions {
  /** Restamp the item, so it reads as pushed and unchanged. */
  markPushed(localKey: string, jiraKey: string, jiraId?: string): Promise<void>;
  onProgress?: (progress: UpdateProgress) => void;
}

/**
 * Send each chosen update, one `PUT` at a time, and restamp each item as it
 * lands.
 *
 * The restamp happens even when a person left some differing fields unticked.
 * Choosing to keep Jira's value for a field is a decision about it. Without
 * the restamp the item would read as changed forever, and the same field
 * would be offered at every push.
 */
export async function sendUpdates(
  client: JiraClient,
  choices: readonly UpdateChoice[],
  options: UpdateSendOptions,
): Promise<UpdateOutcome> {
  const outcome: UpdateOutcome = { updated: [], failed: [] };

  for (const choice of choices) {
    const ids = Object.keys(choice.fields);
    options.onProgress?.({ localKey: choice.localKey, state: "updating" });
    if (ids.length > 0) {
      try {
        await client.put(issuePath(choice.jiraKey), { fields: choice.fields });
      } catch (err) {
        const base = err instanceof Error ? err.message : String(err);
        const message =
          err instanceof JiraError && err.kind === "network"
            ? `${base} Sending it again is safe: an update repeated leaves the issue as one would.`
            : base;
        outcome.failed.push({
          localKey: choice.localKey,
          message,
          fieldErrors: err instanceof JiraError ? err.fieldErrors : {},
        });
        options.onProgress?.({ localKey: choice.localKey, state: "failed", message });
        continue;
      }
    }

    try {
      await options.markPushed(choice.localKey, choice.jiraKey, choice.jiraId);
    } catch (err) {
      const message = `${choice.jiraKey} ${ids.length ? "was updated in Jira" : "matches Jira"}, but recording that in the vault failed: ${err instanceof Error ? err.message : String(err)}. The next push will find nothing left to change.`;
      outcome.failed.push({ localKey: choice.localKey, message, fieldErrors: {} });
      options.onProgress?.({ localKey: choice.localKey, state: "failed", message });
      continue;
    }

    const url = issueUrl(client.site, choice.jiraKey);
    outcome.updated.push({ localKey: choice.localKey, jiraKey: choice.jiraKey, url, fields: ids });
    options.onProgress?.({ localKey: choice.localKey, state: "updated", jiraKey: choice.jiraKey, url });
  }

  return outcome;
}
