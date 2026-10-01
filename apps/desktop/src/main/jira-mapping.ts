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

import type {
  JiraExtraField,
  JiraMapState,
  JiraMappingChoice,
  JiraMappingGap,
  JiraPersonLink,
  VaultIssueType,
} from "../shared/api.js";
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
 * `fields.epicLink`, `priorities` and `statusTransitions` are not touched:
 * the panel does not show them, so it has no business changing them.
 * `defaults` is touched only to remove what `convertDefaults` names, which
 * the same Save writes into `extraFields`.
 * `extraFields` and `people` are the panel's when the choice carries them, and
 * then an entry missing from the choice is removed. That's why `current`, the
 * map as it is on disk, is needed: a removal is an edit to a key the choice no
 * longer names.
 */
export function mappingEdits(
  choice: JiraMappingChoice,
  credential: Pick<StoredJiraCredential, "site" | "auth" | "cloudId">,
  current: Pick<JiraMap, "extraFields" | "people" | "defaults"> | null = null,
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

  if (choice.extraFields) {
    const chosen = Object.entries(choice.extraFields).map(([id, spec]) => extraFieldEntry(id, spec));
    edits.push(...blockEdits("extraFields", chosen, Object.keys(current?.extraFields ?? {})));
  }
  if (choice.people) {
    const chosen = peopleEntries(choice.people);
    edits.push(...blockEdits("people", chosen, Object.keys(current?.people ?? {})));
  }
  if (choice.convertDefaults?.length) {
    edits.push(...convertedDefaultEdits(choice, Object.keys(current?.defaults ?? {})));
  }

  return edits;
}

/**
 * Edits that make one keyed block hold exactly `chosen`.
 *
 * Entry by entry when the block already has entries, so the comments between
 * them survive. When it has none, the whole block is set at once. The template
 * writes an empty block as `{}`, and entries added into a flow map stay flow,
 * so the file would read `extraFields: { customfield_10001: { name: Team, … } }`
 * on one line. Set whole, the block is written in block style like the rest of
 * the file.
 */
function blockEdits(block: string, chosen: Array<[string, unknown]>, existing: string[]): JiraMapEdit[] {
  if (existing.length === 0) {
    return chosen.length ? [{ path: [block], value: Object.fromEntries(chosen) }] : [];
  }
  const keep = new Set(chosen.map(([key]) => key));
  return [
    ...existing.filter((key) => !keep.has(key)).map((key) => ({ path: [block, key], value: undefined })),
    ...chosen.map(([key, value]) => ({ path: [block, key], value })),
  ];
}

/**
 * Removing converted entries from `defaults`.
 *
 * Refused unless every converted id is in `extraFields` on the same Save, so a
 * conversion can never just delete a value. An emptied block is written as
 * `{}`, the way the example file writes an empty block, not deleted.
 */
function convertedDefaultEdits(choice: JiraMappingChoice, existing: string[]): JiraMapEdit[] {
  const converting = new Set((choice.convertDefaults ?? []).filter((id) => existing.includes(id)));
  for (const id of converting) {
    if (!choice.extraFields || !(id in choice.extraFields)) {
      throw new Error(`${id} is being moved out of defaults, but is not among the extra fields to save.`);
    }
  }
  if (converting.size === 0) return [];
  if (existing.every((id) => converting.has(id))) return [{ path: ["defaults"], value: {} }];
  return [...converting].map((id) => ({ path: ["defaults", id], value: undefined }));
}

/**
 * One extra field as the map stores it, with nothing empty written. An
 * `always` field with no value sends nothing, which is allowed: it is how a
 * field is added before its value is known. The gaps still say it is unfilled.
 */
function extraFieldEntry(id: string, spec: JiraExtraField): [string, Record<string, unknown>] {
  const fieldId = id.trim();
  if (!FIELD_ID.test(fieldId)) throw new Error(`${fieldId || "An empty id"} is not a Jira field id.`);
  if (spec.mode !== "always" && spec.mode !== "ask") {
    throw new Error(`${spec.name ?? fieldId} needs to be sent always or asked for on each push.`);
  }
  const issueTypes = (spec.issueTypes ?? []).map((t) => t.trim()).filter(Boolean);
  const name = spec.name?.trim();
  return [
    fieldId,
    {
      ...(name ? { name } : {}),
      mode: spec.mode,
      ...(spec.value !== undefined && spec.value !== null ? { value: spec.value } : {}),
      ...(issueTypes.length ? { issueTypes } : {}),
    },
  ];
}

/**
 * People by the vault's spelling. The push matches them case-insensitively, so
 * two spellings of one person are refused here rather than left for the push
 * to pick between.
 */
function peopleEntries(people: Record<string, JiraPersonLink>): Array<[string, Record<string, string>]> {
  const seen = new Map<string, string>();
  return Object.entries(people).map(([raw, link]) => {
    const person = raw.trim();
    if (!person) throw new Error("A person needs a name.");
    const folded = person.toLowerCase();
    const clash = seen.get(folded);
    if (clash !== undefined) throw new Error(`${clash} and ${person} are the same person to the push. Keep one.`);
    seen.set(folded, person);
    const accountId = link.accountId?.trim();
    if (!accountId) throw new Error(`Choose a Jira account for ${person}.`);
    const displayName = link.displayName?.trim();
    return [person, { accountId, ...(displayName ? { displayName } : {}) }];
  });
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
    extraFields: Object.fromEntries(
      Object.entries(map.extraFields).map(([id, spec]) => [
        id,
        {
          ...(spec.name ? { name: spec.name } : {}),
          mode: spec.mode,
          ...(spec.value !== undefined && spec.value !== null ? { value: spec.value } : {}),
          ...(spec.issueTypes?.length ? { issueTypes: [...spec.issueTypes] } : {}),
        },
      ]),
    ),
    people: Object.fromEntries(Object.entries(map.people).map(([person, link]) => [person, { ...link }])),
    defaults: { ...map.defaults },
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
