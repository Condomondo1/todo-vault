/**
 * Settings → Jira's mapping, from the main process: turning what the panel
 * chose into edits to `jira-map.yaml`, and reading the map back for it.
 *
 * Pure, with no Electron import, so it can be tested directly. The write
 * itself is the core's `writeJiraMap`, through `VaultService.saveJiraMap`,
 * which keeps comments, validates before touching disk, and commits.
 */
import { fieldsTheMapCanFill, type JiraMap, type JiraMapEdit } from "todo-vault";
import { issueTypeNamed, requiredGaps, type ProjectMeta } from "todo-vault/jira-meta";

import type { JiraMapState, JiraMappingChoice, JiraMappingGap, VaultIssueType } from "../shared/api.js";
import type { StoredJiraCredential } from "./jira-credential.js";

const VAULT_TYPES: readonly VaultIssueType[] = ["epic", "story", "task", "bug", "subtask"];

/** Jira project keys: a capital letter, then capitals, digits or underscores. */
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,9}$/;

/** A field id the map may name: a system field's name or `customfield_NNNNN`. */
const FIELD_ID = /^(?:[a-z][a-zA-Z]*|customfield_\d+)$/;

/** As the panel types it, normalised; throws a message for a person. */
export function normaliseProjectKey(raw: string): string {
  const key = raw.trim().toUpperCase();
  if (!PROJECT_KEY.test(key)) {
    throw new Error(
      `${raw.trim() || "An empty key"} is not a Jira project key. It is the letters before the number in an issue key, such as ENG in ENG-12.`,
    );
  }
  return key;
}

/**
 * The edits for one Save, and only these.
 *
 * Paths, not blocks, because `writeJiraMap` keeps the comments inside a block
 * only when the block is edited key by key. Replacing `fields` wholesale would
 * take its explanations with it.
 *
 * `baseUrl`, `auth` and `cloudId` come from the credential, never from the
 * choice. That makes the push's own check, that the map's site is the site the
 * token was saved for, true by construction for a map saved here. It also
 * means the renderer cannot aim a push anywhere. `cloudId` is removed for a
 * classic token rather than left stale from a scoped one.
 *
 * `fields.epicLink`, `priorities`, `statusTransitions` and everything B2b-2
 * owns (`extraFields`, `people`) are not touched: this Save did not show them,
 * so it has no business changing them.
 */
export function mappingEdits(
  choice: JiraMappingChoice,
  credential: Pick<StoredJiraCredential, "site" | "auth" | "cloudId">,
): JiraMapEdit[] {
  const edits: JiraMapEdit[] = [
    { path: ["jiraProjectKey"], value: normaliseProjectKey(choice.projectKey) },
    { path: ["baseUrl"], value: credential.site },
    { path: ["auth"], value: credential.auth },
    { path: ["cloudId"], value: credential.auth === "scoped" ? credential.cloudId : undefined },
  ];

  for (const type of VAULT_TYPES) {
    const name = choice.issueTypes[type]?.trim();
    if (!name) throw new Error(`Choose a Jira issue type for ${type}.`);
    edits.push({ path: ["issueTypes", type], value: name });
  }

  const optionalField = (key: "startDate" | "estimate"): void => {
    const id = choice.fields[key]?.trim();
    if (id && !FIELD_ID.test(id)) throw new Error(`${id} is not a Jira field id.`);
    edits.push({ path: ["fields", key], value: id || undefined });
  };
  optionalField("startDate");
  optionalField("estimate");

  const category = choice.fields.category.trim();
  if (category !== "labels" && !FIELD_ID.test(category)) {
    throw new Error(`${category || "An empty choice"} is not "labels" or a Jira field id.`);
  }
  edits.push({ path: ["fields", "category"], value: category });

  return edits;
}

/**
 * The part of a map the mapping panel shows. `meta` is the project's metadata
 * if this session has fetched it, and with it come the gaps.
 */
export function mapState(map: JiraMap, meta?: ProjectMeta): JiraMapState {
  const gaps = meta ? mappingGaps(map, meta) : undefined;
  return {
    exists: true,
    projectKey: map.jiraProjectKey,
    ...(map.baseUrl ? { baseUrl: map.baseUrl } : {}),
    issueTypes: { ...map.issueTypes },
    fields: {
      ...(map.fields.startDate ? { startDate: map.fields.startDate } : {}),
      ...(map.fields.estimate ? { estimate: map.fields.estimate } : {}),
      category: map.fields.category,
    },
    ...(gaps ? { gaps } : {}),
  };
}

/**
 * Required fields that no item of a mapped type could ever carry under this
 * map, each named once per issue type.
 *
 * Undefined for another project's metadata, which would answer for the wrong
 * create screens. Two vault types mapped to one Jira type (bug and task both
 * to Task, in a project without Bug) are one issue type and so one set of
 * gaps. A mapped name the project does not have gives nothing here. The push
 * reports that itself, and the panel only offers names the project has.
 */
export function mappingGaps(map: JiraMap, meta: ProjectMeta): JiraMappingGap[] | undefined {
  if (meta.projectKey !== map.jiraProjectKey) return undefined;
  const gaps: JiraMappingGap[] = [];
  const seen = new Set<string>();
  for (const vaultType of VAULT_TYPES) {
    const type = issueTypeNamed(meta, map.issueTypes[vaultType]);
    if (!type || seen.has(type.id)) continue;
    seen.add(type.id);
    for (const field of requiredGaps(type, fieldsTheMapCanFill(map, type.name))) {
      gaps.push({ issueType: type.name, fieldId: field.fieldId, fieldName: field.name });
    }
  }
  return gaps;
}
