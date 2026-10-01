import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

import { parseDescription, type Block, type Inline } from "./description.js";
import { markdownToAdf } from "./jira-adf.js";
import { JIRA_MAP_TEMPLATE } from "./jira-map-template.js";
import {
  fieldOn,
  issueTypeNamed,
  requiredGaps,
  shapeFieldValue,
  valueKindFor,
  type ProjectMeta,
  type ShapeContext,
} from "./jira-meta.js";
import type { Item } from "./schema.js";
import type { Vault } from "./vault.js";
import { pushableFields } from "./vault.js";
import { contentHash, formatZodError, writeFileAtomic } from "./util.js";

/**
 * One-way push to Jira.
 *
 * The vault is never a mirror of Jira — it is upstream of it. We generate a
 * payload, you review it, and only then does anything leave the machine.
 */

export const JiraMapSchema = z
  .object({
    jiraProjectKey: z.string().min(1).describe("Target project key in Jira, e.g. ENG"),
    baseUrl: z.string().url().optional(),
    issueTypes: z.object({
      epic: z.string().default("Epic"),
      story: z.string().default("Story"),
      task: z.string().default("Task"),
      bug: z.string().default("Bug"),
      subtask: z.string().default("Subtask"),
    }),
    priorities: z
      .record(z.string())
      .default({
        highest: "Highest",
        high: "High",
        medium: "Medium",
        low: "Low",
        lowest: "Lowest",
      }),
    /**
     * Custom field IDs, discovered from your instance rather than guessed.
     * Run `vault jira discover` against a live instance to fill these in —
     * start date in particular is a different customfield_NNNNN on every site.
     */
    fields: z
      .object({
        startDate: z.string().optional(),
        estimate: z.string().optional(),
        epicLink: z.string().optional().describe("Only needed on older company-managed projects"),
        category: z
          .string()
          .default("labels")
          .describe("'labels' to fold category into labels, or a customfield_NNNNN id"),
      })
      .default({ category: "labels" }),
    /**
     * `site` sends a classic API token to `baseUrl`; `scoped` sends a scoped
     * token through Atlassian's gateway, which needs `cloudId`. See
     * `jira-client.ts`. The credential itself is never in this file.
     */
    auth: z.enum(["site", "scoped"]).default("site"),
    cloudId: z.string().optional(),
    /**
     * Vault people, as the vault spells them, to Jira accounts. Jira Cloud
     * takes `{ accountId }` for every user field and has not accepted a name
     * since 2019, so an assignee with no entry here is pushed unassigned.
     * Keys are matched case-insensitively, as `listItems` matches people.
     */
    people: z
      .record(z.object({ accountId: z.string().min(1), displayName: z.string().optional() }).strict())
      .default({}),
    /**
     * Jira fields with no vault equivalent, keyed by field id. `value` is stored
     * already in the shape Jira's create API takes. `always` sends it on every
     * issue; `ask` offers it, prefilled, in the push pane for that push only.
     * `issueTypes` limits the field to the types whose create screen has it.
     */
    extraFields: z
      .record(
        z
          .object({
            name: z.string().optional(),
            mode: z.enum(["always", "ask"]).default("always"),
            value: z.unknown(),
            issueTypes: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .default({}),
    /** The older form of `extraFields`: always sent, no names. Still read. */
    defaults: z.record(z.unknown()).default({}),
    /** Local statuses to Jira transition names, applied after creation. */
    statusTransitions: z.record(z.string()).default({}),
  })
  .strict()
  .superRefine((map, ctx) => {
    if (map.auth === "scoped" && !map.cloudId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cloudId"],
        message: "auth: scoped needs the site's cloudId (Settings → Jira looks it up)",
      });
    }
  });

export type JiraMap = z.infer<typeof JiraMapSchema>;

export async function loadJiraMap(filePath: string): Promise<JiraMap> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    throw new Error(
      `No Jira mapping found at ${filePath}. Copy jira-map.example.yaml and fill in your instance's field IDs.`,
    );
  }
  try {
    return JiraMapSchema.parse(YAML.parse(raw));
  } catch (err) {
    throw new Error(`Jira mapping is invalid: ${formatZodError(err)}`);
  }
}

/** Where a vault keeps its map. */
export function jiraMapPath(vaultRoot: string): string {
  return path.join(vaultRoot, "jira-map.yaml");
}

/**
 * One change to the map: set the value at `path`, or remove it when `value` is
 * `undefined`. Paths rather than a whole object, because a whole-object write
 * replaces a block and the comments inside it go with it.
 */
export interface JiraMapEdit {
  path: readonly (string | number)[];
  value: unknown;
}

/**
 * Apply edits to `jira-map.yaml` without losing a comment.
 *
 * `discover` refuses to write this file, and the reason was right for the
 * writer it had in mind: parse, change, reserialise, and every comment that
 * makes the example readable is gone. `YAML.parseDocument` keeps the comments
 * attached to the nodes they describe and edits values in place, so this
 * writer changes only what it is told to. A missing file starts from
 * `JIRA_MAP_TEMPLATE`, the example's own text, so a first-time user gets the
 * explanations too.
 *
 * The result is validated against `JiraMapSchema` *before* anything touches
 * disk, and a refusal names the field. The schema is `.strict()`, so an edit
 * that invents a key — `token`, say — is refused outright: the credential is
 * never in this file, and this is where that stays true.
 *
 * Returns the parsed map as written. Committing is the caller's business;
 * `Vault.commitChange` is how the app does it.
 */
export async function writeJiraMap(filePath: string, edits: readonly JiraMapEdit[]): Promise<JiraMap> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    text = JIRA_MAP_TEMPLATE;
  }

  const doc = YAML.parseDocument(text);
  if (doc.errors.length) {
    throw new Error(`jira-map.yaml is not valid YAML, so it was left alone: ${doc.errors[0].message}`);
  }
  for (const edit of edits) {
    if (edit.path.length === 0) throw new Error("A map edit needs a path.");
    if (edit.value === undefined) doc.deleteIn(edit.path);
    else doc.setIn(edit.path, edit.value);
  }

  const next = String(doc);
  let map: JiraMap;
  try {
    map = JiraMapSchema.parse(YAML.parse(next));
  } catch (err) {
    throw new Error(`That change would make jira-map.yaml invalid, so it was not saved: ${formatZodError(err)}`);
  }
  await writeFileAtomic(filePath, next);
  return map;
}

// ------------------------------------------------------- markdown to ADF

export { adfToMarkdown, isAdfDoc, markdownToAdf, type AdfNode } from "./jira-adf.js";

// ------------------------------------------------------ markdown to wiki

function wikiInline(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "strong":
          return `*${node.text}*`;
        case "em":
          return `_${node.text}_`;
        case "code":
          return `{{${node.text}}}`;
        case "link":
          return `[${node.text}|${node.href}]`;
        case "break":
          return "\n";
        default:
          return node.text;
      }
    })
    .join("");
}

/**
 * Blocks to Jira wiki markup — the third serializer over description.ts's
 * grammar, beside markdown (serializeDescription, for the app) and ADF
 * (markdownToAdf, for the REST API).
 *
 * This is what the CSV path needs. Jira Cloud stores descriptions as ADF, but
 * ADF is JSON and a CSV cell holding JSON imports as a cell holding JSON; the
 * importer's own conversion is from wiki markup. Without this step a
 * description arrives in Jira as the literal characters `## Heading` and
 * `- bullet`, which is what the export did before.
 *
 * Same closed subset as the other two, and the same failure mode: anything the
 * grammar does not recognise reaches here as a paragraph, so this can flatten
 * but not fail.
 */
export function blocksToWiki(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "heading":
          // Wiki markup defines h1..h6 and nothing beyond it.
          return `h${Math.min(block.level, 6)}. ${wikiInline(block.content)}`;
        case "list":
          return block.items
            .map((item) => `${block.ordered ? "#" : "*"} ${wikiInline(item)}`)
            .join("\n");
        case "quote":
          return `{quote}\n${wikiInline(block.content)}\n{quote}`;
        case "code":
          return `{code${block.language ? `:${block.language}` : ""}}\n${block.text}\n{code}`;
        default:
          return wikiInline(block.content);
      }
    })
    .join("\n\n");
}

// --------------------------------------------------------- shared decisions

/*
 * Everything in this section was once inlined in buildPushPlan, which is how
 * the two export paths came to disagree: the CSV export had no notion of sync
 * state (so running it twice created every issue twice), routed `category`
 * nowhere, and dropped start dates without the warning that explains how to fix
 * the map. A decision that both paths have to make identically belongs in one
 * named function, or it gets made twice and drifts.
 */

export interface PushSelection {
  eligible: Item[];
  skipped: Array<{ localKey: string; reason: string }>;
  warnings: string[];
}

/**
 * Which items still need creating in Jira, and why the rest do not.
 *
 * `holdDrifted` is the app's push. There, an item changed since it was pushed
 * is held back rather than created a second time, because a duplicate in a
 * tracker a whole team reads is worse than a change that waits for updating to
 * exist. The CSV export and the MCP planner keep the old behaviour, a warning,
 * since a person reads their output before anything reaches Jira.
 */
export function selectPushable(items: Item[], options: { holdDrifted?: boolean } = {}): PushSelection {
  const warnings: string[] = [];
  const skipped: Array<{ localKey: string; reason: string }> = [];

  const eligible = items.filter((item) => {
    // `drifted` carries a push baseline exactly as `pushed` does, so both belong
    // here. Checking only `pushed` let a drifted item fall through with no skip
    // and no warning, drafted as a brand-new issue for work Jira already had.
    if (item.sync.state === "pushed" || item.sync.state === "drifted") {
      // The hash decides, not the label. updateItem only ever moves
      // pushed -> drifted and never back, so an item that was edited and then
      // reverted still reads `drifted` while matching what Jira holds.
      const changed =
        item.sync.contentHash && contentHash(pushableFields(item)) !== item.sync.contentHash;
      if (!changed) {
        skipped.push({
          localKey: item.key,
          reason: `Already pushed as ${item.sync.jiraKey} and unchanged since`,
        });
        return false;
      }
      if (options.holdDrifted) {
        skipped.push({
          localKey: item.key,
          reason: `Changed since it was pushed as ${item.sync.jiraKey}. Updating an existing issue is not supported yet, so it is not sent again. Update ${item.sync.jiraKey} in Jira by hand.`,
        });
        return false;
      }
      warnings.push(
        `${item.key} has changed since it was pushed as ${item.sync.jiraKey}. This creates a NEW issue; update the existing one by hand if that is not what you want.`,
      );
    }
    return true;
  });

  return { eligible, skipped, warnings };
}

/** Epics before their children, subtasks last, stable within a rank by key. */
function orderForCreation(items: Item[]): Item[] {
  const typeOrder: Record<string, number> = { epic: 0, story: 1, task: 1, bug: 1, subtask: 2 };
  return [...items].sort(
    (a, b) => typeOrder[a.type] - typeOrder[b.type] || a.key.localeCompare(b.key),
  );
}

/**
 * Where an item's `category` goes: folded in with the labels, or into whatever
 * custom field the map names. A category that lands in labels on one path and a
 * custom field on the other is two different issues, so both paths ask here.
 */
function resolveCategory(
  item: Item,
  map: JiraMap,
): { labels: string[]; customField?: [string, string] } {
  const labels = [...item.labels];
  if (!item.category) return { labels };
  if (map.fields.category === "labels") {
    // Jira splits a label on whitespace, so "Vendor management" would arrive as
    // two labels that mean nothing apart.
    labels.push(item.category.replace(/\s+/g, "-"));
    return { labels };
  }
  return { labels, customField: [map.fields.category, item.category] };
}

/**
 * Start date is a custom field with a different id on every site, so the map
 * has to name it. Saying so is the point: silently dropping the date leaves you
 * with a plausible-looking import missing a field you set deliberately.
 */
function resolveStartDate(
  item: Item,
  map: JiraMap,
): { fieldId?: string; value?: string; warning?: string } {
  if (!item.startDate) return {};
  if (!map.fields.startDate) {
    return {
      warning: `${item.key} has a start date but jira-map.yaml has no fields.startDate. Run \`vault jira discover --url <your site> --project <KEY>\` with JIRA_EMAIL and JIRA_TOKEN set to find the custom field id for your instance.`,
    };
  }
  return { fieldId: map.fields.startDate, value: item.startDate };
}

// ------------------------------------------------------------- payload

export interface JiraIssueDraft {
  localKey: string;
  /** The Jira issue type name this draft creates, for showing in the push pane. */
  issueType: string;
  /** Set when this issue's parent is also in this batch and must be created first. */
  parentLocalKey?: string;
  fields: Record<string, unknown>;
}

/** Something that stops an issue being created at all, as opposed to a warning about how. */
export interface JiraPushBlocker {
  localKey: string;
  message: string;
}

export interface JiraPushPlan {
  jiraProjectKey: string;
  /** Ordered so that every parent is created before its children. */
  drafts: JiraIssueDraft[];
  attachments: Array<{ localKey: string; paths: string[] }>;
  skipped: Array<{ localKey: string; reason: string }>;
  /** "This will send, and here is what you might not expect." */
  warnings: string[];
  /**
   * "This will not send." An issue type the project cannot create, or a field
   * Jira requires that nothing fills. Only found when `meta` is given; the push
   * refuses a batch with any blocker in it and names each one.
   */
  blockers: JiraPushBlocker[];
}

export interface PushPlanOptions {
  /**
   * The target project's create metadata. When given, each draft is checked
   * against its own issue type's create screen: fields that type does not have
   * are dropped with a warning, required fields nothing fills become blockers,
   * and the issue type is sent by id rather than by name. Without it the plan is
   * built the way it always was, which is what the MCP planner and the CLI get.
   */
  meta?: ProjectMeta;
  /** Values chosen in the push pane for `ask` extra fields, by field id. This push only. */
  askValues?: Readonly<Record<string, unknown>>;
  /** Hold back items changed since their push instead of creating them again. See `selectPushable`. */
  holdDrifted?: boolean;
}

/**
 * Checked against the create screen by nothing: `project` and `issuetype`
 * identify the create itself, and `parent` is how a subtask or a child is
 * placed, which Jira does not reliably list as a screen field.
 */
const NOT_SCREEN_FIELDS: ReadonlySet<string> = new Set(["project", "issuetype", "parent"]);

/** A person's Jira account, by the vault's spelling of their name, case-folded. */
function accountFor(map: JiraMap, person: string): { accountId: string } | undefined {
  const wanted = person.trim().toLowerCase();
  for (const [name, entry] of Object.entries(map.people)) {
    if (name.trim().toLowerCase() === wanted) return { accountId: entry.accountId };
  }
  return undefined;
}

/**
 * The same warning for many items, said once with the keys listed. A batch of
 * forty items with no Start date field on Epic would otherwise print forty
 * lines that differ only in a key, and bury the one warning that matters.
 */
class GroupedWarnings {
  private readonly groups = new Map<string, string[]>();
  add(message: string, key: string): void {
    const keys = this.groups.get(message) ?? [];
    keys.push(key);
    this.groups.set(message, keys);
  }
  into(out: string[]): void {
    for (const [message, keys] of this.groups) out.push(`${message} (${keys.join(", ")})`);
  }
}

/** Whether an extra field is meant for this issue type: unrestricted, or named in `issueTypes`. */
function extraFieldAppliesTo(spec: JiraMap["extraFields"][string], issueTypeName: string): boolean {
  const wanted = issueTypeName.trim().toLowerCase();
  return !spec.issueTypes || spec.issueTypes.some((t) => t.trim().toLowerCase() === wanted);
}

/**
 * Every field id some item of this issue type could carry under this map —
 * the map-level answer to "what does the push fill in?", for Settings → Jira
 * to hold against `requiredGaps` before any item has been chosen.
 *
 * Deliberately generous on the item-dependent fields: `duedate`, `assignee`,
 * `labels`, `components` and `parent` are counted because *an* item can
 * carry them, even though a given one may not. So a gap shown here is certain
 * — nothing under this map can ever fill it — while a gap that depends on the
 * item, a required due date on an item without one, is still caught per draft
 * by `buildPushPlan`'s blockers at push time.
 *
 * Kept beside `buildPushPlan` and sharing its helpers, with a test that every
 * field a fully-populated item's draft carries is in this set, so the two
 * answers cannot drift apart.
 */
export function fieldsTheMapCanFill(map: JiraMap, issueTypeName: string): Set<string> {
  const ids = new Set<string>([
    "project",
    "issuetype",
    "summary",
    "description",
    "labels",
    "components",
    "assignee",
    "duedate",
    "parent",
  ]);
  if (Object.values(map.priorities).some(Boolean)) ids.add("priority");
  if (map.fields.startDate) ids.add(map.fields.startDate);
  if (map.fields.estimate) ids.add(map.fields.estimate);
  if (map.fields.category !== "labels") ids.add(map.fields.category);
  for (const id of Object.keys(map.defaults)) ids.add(id);
  for (const [id, spec] of Object.entries(map.extraFields)) {
    // An "always" field with no value sends nothing. An "ask" field can be
    // given one in the push pane, so it counts.
    if (!extraFieldAppliesTo(spec, issueTypeName)) continue;
    if (spec.mode === "ask" || !isBlank(spec.value)) ids.add(id);
  }
  return ids;
}

/** A value that sends nothing: absent, blank text, or an empty list. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  return Array.isArray(value) && value.length === 0;
}

export function buildPushPlan(
  items: Item[],
  map: JiraMap,
  vault: Vault,
  options: PushPlanOptions = {},
): JiraPushPlan {
  const { meta, askValues = {}, holdDrifted } = options;
  const { eligible, skipped, warnings } = selectPushable(items, { holdDrifted });
  const selected = new Map(items.map((i) => [i.key, i]));
  const ordered = orderForCreation(eligible);

  const drafts: JiraIssueDraft[] = [];
  const attachments: Array<{ localKey: string; paths: string[] }> = [];
  const blockers: JiraPushBlocker[] = [];
  const grouped = new GroupedWarnings();

  for (const item of ordered) {
    const issueType = map.issueTypes[item.type];

    // Extra fields first, so everything the vault itself knows about the item
    // is written over them: an extra field named `priority` must not beat the
    // item's own priority. `defaults` first of all, being the older form.
    const fields: Record<string, unknown> = { ...map.defaults };
    // Fields whose value a person typed, to be shaped into Jira's form once the
    // issue type's screen is known. `defaults` is left out: it has always been
    // written in Jira's shape by hand, and is sent exactly as it stands.
    const typed = new Set<string>();
    for (const [fieldId, spec] of Object.entries(map.extraFields)) {
      if (!extraFieldAppliesTo(spec, issueType)) continue;
      const value = spec.mode === "ask" && fieldId in askValues ? askValues[fieldId] : spec.value;
      if (!isBlank(value)) {
        fields[fieldId] = value;
        typed.add(fieldId);
      }
    }

    Object.assign(fields, {
      project: { key: map.jiraProjectKey },
      issuetype: { name: issueType },
      summary: item.summary,
      description: markdownToAdf(buildDescription(item, vault)),
    });

    const priority = map.priorities[item.priority];
    if (priority) fields.priority = { name: priority };

    const category = resolveCategory(item, map);
    if (category.labels.length) fields.labels = category.labels;
    if (category.customField) {
      fields[category.customField[0]] = category.customField[1];
      typed.add(category.customField[0]);
    }
    if (item.components.length) {
      fields.components = item.components.map((name) => ({ name }));
    }
    if (item.assignee) {
      // Jira Cloud identifies people by account id and has refused `{ name }`
      // since 2019, so a name with no account is left unassigned and said so,
      // rather than sent and refused.
      const account = accountFor(map, item.assignee);
      if (account) fields.assignee = account;
      else {
        grouped.add(
          `"${item.assignee}" has no Jira account in jira-map.yaml's people, so these are created unassigned`,
          item.key,
        );
      }
    }
    if (item.dueDate) fields.duedate = item.dueDate;

    const startDate = resolveStartDate(item, map);
    if (startDate.warning) warnings.push(startDate.warning);
    if (startDate.fieldId) fields[startDate.fieldId] = startDate.value;
    if (item.estimate !== undefined && map.fields.estimate) {
      fields[map.fields.estimate] = item.estimate;
    }

    const draft: JiraIssueDraft = { localKey: item.key, issueType, fields };

    if (item.parent) {
      const parentItem = selected.get(item.parent) ?? safeGet(vault, item.parent);
      const parentJiraKey = parentItem?.sync.jiraKey;
      if (parentJiraKey) {
        fields.parent = { key: parentJiraKey };
      } else if (selected.has(item.parent)) {
        draft.parentLocalKey = item.parent;
      } else {
        warnings.push(
          `${item.key} has parent ${item.parent}, which is neither in this batch nor already in Jira. It will be created without a parent link.`,
        );
      }
    }

    if (meta) checkAgainstScreen(item, draft, meta, blockers, grouped, { typed, people: map.people });

    drafts.push(draft);

    if (item.attachments.length) {
      attachments.push({
        localKey: item.key,
        paths: item.attachments.map((a) => a.path),
      });
    }
  }

  grouped.into(warnings);
  return { jiraProjectKey: map.jiraProjectKey, drafts, attachments, skipped, warnings, blockers };
}

/**
 * Hold one draft up against its issue type's create screen in the target project.
 *
 * Per issue type, never a union: a field can be required on Story and absent
 * from Epic. Three outcomes. A field the screen does not have is removed — Jira
 * would refuse the whole create over it — and the removal is a warning, since
 * the rest of the issue is still worth creating. A required field with no
 * default that nothing fills is a blocker. And the issue type goes by id, which
 * survives the type being renamed between setup and push.
 */
function checkAgainstScreen(
  item: Item,
  draft: JiraIssueDraft,
  meta: ProjectMeta,
  blockers: JiraPushBlocker[],
  grouped: GroupedWarnings,
  shaping: { typed: ReadonlySet<string>; people: ShapeContext["people"] },
): void {
  const type = issueTypeNamed(meta, draft.issueType);
  if (!type) {
    blockers.push({
      localKey: item.key,
      message: `${item.key} is a ${item.type}, mapped to "${draft.issueType}", which ${meta.projectKey} cannot create. It can create: ${meta.issueTypes.map((t) => t.name).join(", ")}.`,
    });
    return;
  }
  if (type.fields.length === 0) {
    blockers.push({
      localKey: item.key,
      message: `The fields of ${meta.projectKey}'s ${type.name} issue type were not loaded, so ${item.key} cannot be checked. Refresh the project's fields in Settings → Jira.`,
    });
    return;
  }

  draft.fields.issuetype = { id: type.id };

  for (const fieldId of Object.keys(draft.fields)) {
    if (NOT_SCREEN_FIELDS.has(fieldId) || fieldOn(type, fieldId)) continue;
    delete draft.fields[fieldId];
    grouped.add(`${meta.projectKey}'s ${type.name} has no ${fieldId} field, so it is not sent`, item.key);
  }

  // What a person typed becomes Jira's shape here, against this issue type's
  // own field: its options, its kind. A value that cannot be shaped is a
  // blocker, because Jira would refuse the create over it anyway, and the
  // person can fix it before anything is sent.
  for (const fieldId of shaping.typed) {
    const field = fieldOn(type, fieldId);
    if (!field || !(fieldId in draft.fields)) continue;
    if (valueKindFor(field.schema) === "managed") {
      delete draft.fields[fieldId];
      grouped.add(`${field.name} is set by Jira itself, so it is not sent`, item.key);
      continue;
    }
    const shaped = shapeFieldValue(field, draft.fields[fieldId], { people: shaping.people });
    if (!shaped.ok) {
      blockers.push({ localKey: item.key, message: `${item.key} (${type.name}): ${shaped.message}` });
    } else if (shaped.value === undefined) {
      delete draft.fields[fieldId];
    } else {
      draft.fields[fieldId] = shaped.value;
    }
  }

  const covered = new Set(Object.keys(draft.fields));
  if (draft.parentLocalKey) covered.add("parent");
  for (const gap of requiredGaps(type, covered)) {
    blockers.push({
      localKey: item.key,
      message: `${item.key} (${type.name}) needs ${gap.name} (${gap.fieldId}), which Jira requires and nothing fills in. Set it in Settings → Jira, or give the item a value for it.`,
    });
  }
}

/**
 * Appends a provenance footer so the Jira issue points back at the vault item.
 * Links that Jira cannot resolve (local file paths, Outlook deep links) go here
 * as text rather than being silently dropped.
 */
function buildDescription(item: Item, vault: Vault): string {
  const parts = [item.description.trim()];
  const notes: string[] = [];

  for (const link of item.links) {
    if (link.type === "url") {
      notes.push(`- [${link.label ?? link.target}](${link.target})`);
    } else if (link.type === "item") {
      notes.push(`- Related vault item: ${link.target}`);
    } else {
      notes.push(`- ${link.label ?? link.type}: \`${link.target}\``);
    }
  }
  if (notes.length) {
    parts.push("", "## Links", ...notes);
  }
  parts.push("", `_Tracked locally as ${item.key} in ${vault.root}_`);
  return parts.join("\n").trim();
}

function safeGet(vault: Vault, key: string): Item | undefined {
  try {
    return vault.getItem(key);
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------- csv

export interface JiraCsvOptions {
  /**
   * Emit a Reporter column. Off by default: `reporter` is free text in the
   * vault, filtered case-insensitively because it is typed by hand, and Cloud's
   * importer resolves a person column against real accounts. It is the field
   * most likely to hold a name no account matches, and the one Jira cares about
   * least. Assignee carries the same risk and is emitted anyway, because an
   * unassigned bulk import is not much use.
   */
  reporter?: boolean;
}

export interface JiraCsvColumn {
  header: string;
  /** What to pick on the importer's mapping screen. Printed as a crib. */
  maps: string;
}

export interface JiraCsvResult {
  csv: string;
  columns: JiraCsvColumn[];
  rowCount: number;
  skipped: Array<{ localKey: string; reason: string }>;
  warnings: string[];
  /** Distinct people in the file, to eyeball against the site's users first. */
  assignees: string[];
  reporters: string[];
}

interface CsvRow {
  cells: Map<string, string>;
  labels: string[];
  components: string[];
}

/**
 * CSV for Jira Cloud's external import — the path to use when there is no API
 * token, or the instance is behind a VPN you would rather not automate against.
 *
 * The output is meant to survive the importer's mapping screen, which is where
 * a human pairs each column with a Jira field. Header wording is therefore a
 * convenience rather than a protocol: it has to be recognisable, not exact.
 * Two columns are not guessable and are why `columns` is returned for printing
 * — `Issue Id` and `Parent id`, which are how rows inside a single import link
 * to each other. Without that pair the import succeeds with a flat hierarchy,
 * which is the failure this function exists to avoid.
 */
export function toJiraCsv(
  items: Item[],
  map: JiraMap,
  vault: Vault,
  options: JiraCsvOptions = {},
): JiraCsvResult {
  const { eligible, skipped, warnings } = selectPushable(items);
  const ordered = orderForCreation(eligible);
  const emitted = new Set(ordered.map((item) => item.key));
  const byKey = new Map(items.map((item) => [item.key, item]));

  // Object-valued defaults are the one part of the map a CSV cannot carry:
  // `{ id: "team-uuid" }` has no cell representation, and a create screen that
  // requires the field rejects every row without explaining why.
  const defaults: Array<[string, string]> = [];
  for (const [field, value] of Object.entries(map.defaults)) {
    if (value !== null && typeof value === "object") {
      warnings.push(
        `jira-map.yaml sets defaults.${field} to an object, which no CSV cell can express. If your create screen requires that field, set it on the issues after import or push over the API instead.`,
      );
      continue;
    }
    defaults.push([field, String(value)]);
  }

  const startHeader = map.fields.startDate ? "Start Date" : undefined;
  const categoryHeader = map.fields.category !== "labels" ? "Category" : undefined;

  const rows: CsvRow[] = ordered.map((item) => {
    const cells = new Map<string, string>();
    const category = resolveCategory(item, map);
    const startDate = resolveStartDate(item, map);
    if (startDate.warning) warnings.push(startDate.warning);

    cells.set("Issue Id", item.key);
    cells.set("Issue Type", map.issueTypes[item.type]);
    cells.set("Summary", item.summary);
    // buildDescription, not item.description: the links footer and the "tracked
    // locally as" provenance line are how a created issue points back at the
    // vault, and the API path has always had them.
    cells.set("Description", blocksToWiki(parseDescription(buildDescription(item, vault))));
    cells.set("Priority", map.priorities[item.priority] ?? "");
    cells.set("Assignee", item.assignee ?? "");
    if (options.reporter) cells.set("Reporter", item.reporter ?? "");
    cells.set("Due Date", item.dueDate ?? "");
    if (startHeader && startDate.value) cells.set(startHeader, startDate.value);
    if (map.fields.estimate && item.estimate !== undefined) {
      cells.set("Story Points", String(item.estimate));
    }
    if (categoryHeader && category.customField) {
      cells.set(categoryHeader, category.customField[1]);
    }
    for (const [field, value] of defaults) cells.set(field, value);

    if (item.parent) {
      // Same order of preference as buildPushPlan: a parent Jira already holds
      // wins over an in-batch link, because a real key needs no resolution.
      const parentItem = byKey.get(item.parent) ?? safeGet(vault, item.parent);
      const parentJiraKey = parentItem?.sync.jiraKey;
      if (parentJiraKey) {
        cells.set("Parent", parentJiraKey);
      } else if (emitted.has(item.parent)) {
        cells.set("Parent id", item.parent);
        if (map.fields.epicLink && parentItem?.type === "epic") {
          cells.set("Epic Link", item.parent);
        }
      } else {
        warnings.push(
          `${item.key} has parent ${item.parent}, which is neither in this export nor already in Jira. It will be created without a parent link.`,
        );
      }
    }

    return { cells, labels: category.labels, components: [...item.components] };
  });

  const columns = buildColumns(rows, {
    reporter: options.reporter === true,
    startHeader,
    categoryHeader,
    estimate: Boolean(map.fields.estimate),
    epicLink: Boolean(map.fields.epicLink),
    defaults: defaults.map(([field]) => field),
  });

  const table = [
    columns.map((column) => column.header),
    ...rows.map((row) => csvRowValues(row, columns)),
  ];

  // The BOM and the CRLF endings are for Excel, which is where these files get
  // opened and eyeballed before anyone uploads them. Jira is indifferent to
  // both; Excel on Windows reads a BOM-less UTF-8 file as the ANSI codepage and
  // mangles every non-ASCII character in it.
  const csv = `\uFEFF${table.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;

  return {
    csv,
    columns,
    rowCount: rows.length,
    skipped,
    warnings,
    assignees: distinct(ordered.map((item) => item.assignee)),
    reporters: options.reporter ? distinct(ordered.map((item) => item.reporter)) : [],
  };
}

/**
 * The header row, and with it the shape of every data row.
 *
 * Labels and components get one column *each*, repeated as many times as the
 * widest row needs, because that is how the importer reads a multi-value field.
 * Joining them into one cell — which this export used to do — either splits a
 * label on its spaces or imports one wrong label, depending on the field.
 *
 * Deriving the width is why the rows are built before the header exists: a
 * single pass cannot know how many Labels columns the file will need.
 */
function buildColumns(
  rows: CsvRow[],
  present: {
    reporter: boolean;
    startHeader?: string;
    categoryHeader?: string;
    estimate: boolean;
    epicLink: boolean;
    defaults: string[];
  },
): JiraCsvColumn[] {
  const widest = (pick: (row: CsvRow) => string[]) =>
    rows.reduce((max, row) => Math.max(max, pick(row).length), 0);

  const columns: JiraCsvColumn[] = [
    { header: "Issue Id", maps: "Issue Id — the vault key. Pairs with Parent id." },
    { header: "Issue Type", maps: "Issue Type" },
    { header: "Summary", maps: "Summary" },
    { header: "Description", maps: "Description" },
    { header: "Priority", maps: "Priority" },
  ];

  for (let i = 0; i < widest((row) => row.labels); i += 1) {
    columns.push({ header: "Labels", maps: "Labels (one column per label)" });
  }
  for (let i = 0; i < widest((row) => row.components); i += 1) {
    columns.push({ header: "Components", maps: "Component/s (one column per component)" });
  }

  columns.push({ header: "Assignee", maps: "Assignee — matched against your site's users" });
  if (present.reporter) {
    columns.push({ header: "Reporter", maps: "Reporter — matched against your site's users" });
  }
  columns.push({ header: "Due Date", maps: "Due Date" });
  if (present.startHeader) {
    columns.push({ header: present.startHeader, maps: "the start date custom field on your site" });
  }
  if (present.estimate) {
    columns.push({ header: "Story Points", maps: "the estimate field named in jira-map.yaml" });
  }
  if (present.categoryHeader) {
    columns.push({
      header: present.categoryHeader,
      maps: "the category custom field named in jira-map.yaml",
    });
  }
  for (const field of present.defaults) {
    columns.push({ header: field, maps: `${field}, from defaults in jira-map.yaml` });
  }
  columns.push({ header: "Parent id", maps: "Parent id — links to an Issue Id in this same file" });
  columns.push({ header: "Parent", maps: "Parent — an issue key already in Jira" });
  if (present.epicLink) {
    columns.push({ header: "Epic Link", maps: "Epic Link, for a company-managed project" });
  }
  return columns;
}

/**
 * One row's cells, in column order.
 *
 * Labels and Components appear under repeated headers, so they are read
 * positionally — the nth `Labels` column holds the nth label — and short rows
 * pad with empties. Everything else is a straight lookup by header.
 */
function csvRowValues(row: CsvRow, columns: JiraCsvColumn[]): string[] {
  let label = 0;
  let component = 0;
  return columns.map((column) => {
    if (column.header === "Labels") return row.labels[label++] ?? "";
    if (column.header === "Components") return row.components[component++] ?? "";
    return row.cells.get(column.header) ?? "";
  });
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v && v.trim())))].sort();
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
