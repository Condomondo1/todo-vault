/**
 * The push, from the main process: everything between the push pane and the
 * core's `sendPushPlan`.
 *
 * The credential is read here and goes no further than the client built here.
 * The renderer sends item keys and its choices for `ask` fields, and gets back
 * a preview, progress and an outcome — never the token, and never a plan it
 * could alter and send back. `runPush` rebuilds the plan from the same keys
 * rather than trusting the one it previewed, so what is sent is always what the
 * vault, the map and the project say now.
 *
 * Refusals before any request: no stored credential, no map, and a map whose
 * `baseUrl` is not the site the credential was saved for (`pushTargetProblem`).
 * The map is a file in a synced, committed folder; if it could point a push at
 * another site, the token would go with it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  adfToMarkdown,
  buildPushPlan,
  buildUpdatePlan,
  createJiraClient,
  diffIssue,
  distinctFields,
  fetchProjectMeta,
  issueUrl,
  JiraError,
  jiraMapPath,
  loadJiraMap,
  pushTargetProblem,
  readIssueState,
  resolveCloudId,
  sendPushPlan,
  sendUpdates,
  uncertainAttemptSearchUrl,
  valueKindFor,
  type IssueDiff,
  type IssueState,
  type Item,
  type JiraClient,
  type JiraIssueUpdate,
  type JiraMap,
  type JiraPushPlan,
  type ProjectMeta,
  type PushAttempt,
  type PushJournal,
} from "todo-vault";

import type {
  JiraAskField,
  JiraDraftView,
  JiraPushOutcome,
  JiraPushPreview,
  JiraPushProgress,
  JiraUpdateView,
} from "../shared/api.js";
import { choicesFor } from "../shared/jira-choices.js";
import { fieldName, namedFieldErrors } from "./jira-names.js";
import { parseStoredCredential } from "./jira-credential.js";
import { getSecret } from "./secrets.js";
import type { VaultService } from "./vault-service.js";

// ---------------------------------------------------------------- journal

/**
 * Attempts that may have reached Jira, per vault root. In `userData`, not the
 * vault: it is about this machine's requests, and a journal that synced would
 * have a second machine asking about pushes it never made.
 */
type JournalFile = Record<string, PushAttempt[]>;

function journalPath(): string {
  return path.join(app.getPath("userData"), "jira-push-journal.json");
}

async function readJournal(): Promise<JournalFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(journalPath(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as JournalFile) : {};
  } catch {
    return {};
  }
}

async function writeJournal(journal: JournalFile): Promise<void> {
  const target = journalPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await fs.rename(temp, target);
}

function fileJournal(vaultRoot: string): PushJournal {
  return {
    async begin(attempt) {
      const journal = await readJournal();
      journal[vaultRoot] = [...(journal[vaultRoot] ?? []).filter((a) => a.localKey !== attempt.localKey), attempt];
      await writeJournal(journal);
    },
    async settle(localKey) {
      const journal = await readJournal();
      const remaining = (journal[vaultRoot] ?? []).filter((a) => a.localKey !== localKey);
      if (remaining.length) journal[vaultRoot] = remaining;
      else delete journal[vaultRoot];
      await writeJournal(journal);
    },
  };
}

async function uncertainAttempts(vaultRoot: string): Promise<PushAttempt[]> {
  return (await readJournal())[vaultRoot] ?? [];
}

// ---------------------------------------------------------------- context

interface PushContext {
  root: string;
  client: JiraClient;
  map: JiraMap;
  meta: ProjectMeta;
}

/**
 * Project metadata, briefly remembered. A preview is rebuilt whenever an `ask`
 * value changes, and refetching every create screen on each keystroke would be
 * a dozen requests for nothing. Ten minutes, and never across a change of site,
 * project or mapped issue types, which are all in the key.
 */
const META_TTL_MS = 10 * 60_000;
const metaCache = new Map<string, ProjectMeta>();

async function loadContext(
  service: VaultService,
  options: { freshMeta?: boolean; onRateLimit?: (waitMs: number) => void } = {},
): Promise<PushContext> {
  const root = service.root;
  if (!root) throw new Error("No vault is open.");

  const stored = parseStoredCredential(await getSecret("jira"));
  if (!stored) throw new Error("No Jira credential is saved. Connect in Settings → Jira first.");

  const map = await loadJiraMap(jiraMapPath(root));
  const problem = pushTargetProblem(map, stored.site);
  if (problem) throw new Error(problem);

  // Settings → Jira caches the cloud id in the credential for a scoped token.
  // The map's copy and a fresh lookup are fallbacks for a credential saved
  // before that cache existed.
  const cloudId =
    stored.auth === "scoped"
      ? (stored.cloudId ?? map.cloudId ?? (await resolveCloudId(stored.site)))
      : undefined;

  const client = createJiraClient({
    site: stored.site,
    auth: stored.auth,
    cloudId,
    email: stored.email,
    token: stored.token,
    ...(options.onRateLimit ? { onRateLimit: options.onRateLimit } : {}),
  });

  const typeNames = [...new Set(Object.values(map.issueTypes))].sort();
  const cacheKey = `${stored.site}|${stored.auth}|${map.jiraProjectKey}|${typeNames.join(",")}`;
  const cached = metaCache.get(cacheKey);
  let meta: ProjectMeta;
  if (!options.freshMeta && cached && Date.now() - Date.parse(cached.fetchedAt) < META_TTL_MS) {
    meta = cached;
  } else {
    meta = await fetchProjectMeta(client, map.jiraProjectKey, { issueTypeNames: typeNames });
    metaCache.set(cacheKey, meta);
  }

  return { root, client, map, meta };
}

/**
 * The plan for these keys, with anything awaiting an answer about an uncertain
 * attempt held back. That item may already exist in Jira; pushing it again
 * before someone checks is how a duplicate gets made.
 *
 * `holdDrifted` for the same reason: an item changed since it was pushed is
 * never drafted as a new issue, which the CSV export would do. It is skipped
 * here, and `readUpdates` offers it as an update to the issue it already has.
 */
async function planFor(
  service: VaultService,
  ctx: PushContext,
  keys: string[],
  askValues: Record<string, unknown>,
): Promise<{ plan: JiraPushPlan; items: Map<string, Item> }> {
  const pending = new Set((await uncertainAttempts(ctx.root)).map((a) => a.localKey));
  return service.read((vault) => {
    const items = new Map(keys.map((key) => [key, vault.getItem(key)]));
    const sendable = [...items.values()].filter((item) => !pending.has(item.key));
    const plan = buildPushPlan(sendable, ctx.map, vault, { meta: ctx.meta, askValues, holdDrifted: true });
    for (const key of keys) {
      if (pending.has(key)) {
        plan.skipped.push({
          localKey: key,
          reason: "A previous push of this item may have reached Jira. Say whether it did before pushing it again.",
        });
      }
    }
    return { plan, items };
  });
}

// ---------------------------------------------------------------- updates

/** A changed item, its Jira issue as it is now, and where the two differ. */
interface ReadUpdate {
  update: JiraIssueUpdate;
  state: IssueState;
  diff: IssueDiff;
  summary: string;
}

/**
 * The items among `keys` changed since their push, each read from Jira now and
 * diffed. Read fresh every time, never cached: the point is to compare with
 * what Jira holds at this moment, and someone may have edited it a minute ago.
 *
 * An issue that cannot be read is a problem for that item only. A 404 means it
 * was deleted or moved in Jira, and the item is not updated.
 */
async function readUpdates(
  service: VaultService,
  ctx: PushContext,
  keys: string[],
): Promise<{ read: ReadUpdate[]; problems: Array<{ localKey: string; message: string }>; warnings: string[] }> {
  const { updates, warnings, summaries } = await service.read((vault) => {
    const items = keys.map((key) => vault.getItem(key));
    return { ...buildUpdatePlan(items, ctx.map, vault), summaries: new Map(items.map((i) => [i.key, i.summary])) };
  });
  const read: ReadUpdate[] = [];
  const problems: Array<{ localKey: string; message: string }> = [];
  for (const update of updates) {
    let state: IssueState;
    try {
      state = await readIssueState(ctx.client, update);
    } catch (err) {
      const message =
        err instanceof JiraError && err.kind === "notFound"
          ? `${update.jiraKey} no longer exists in Jira, so ${update.localKey} is not updated.`
          : `${update.jiraKey} could not be read, so ${update.localKey} is not updated. ${err instanceof Error ? err.message : String(err)}`;
      problems.push({ localKey: update.localKey, message });
      continue;
    }
    const diff = diffIssue(update, state, { people: ctx.map.people });
    warnings.push(...diff.warnings);
    read.push({ update, state, diff, summary: summaries.get(update.localKey) ?? update.localKey });
  }
  return { read, problems, warnings };
}

function updateView(site: string, { update, diff, summary }: ReadUpdate): JiraUpdateView {
  return {
    localKey: update.localKey,
    summary,
    jiraKey: update.jiraKey,
    url: issueUrl(site, update.jiraKey),
    changes: diff.changes.map(({ fieldId, name, jiraText, vaultText, editable, reason }) => ({
      fieldId,
      name,
      jiraText,
      vaultText,
      editable,
      ...(reason ? { reason } : {}),
    })),
  };
}

// ---------------------------------------------------------------- preview

/** A value as one line of text: names over ids, ADF as its markdown. */
function describe(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(describe).join(", ");
  const obj = value as Record<string, unknown>;
  if (obj.type === "doc") return adfToMarkdown(obj).slice(0, 280);
  for (const key of ["name", "value", "displayName", "key", "accountId", "id"]) {
    if (typeof obj[key] === "string" || typeof obj[key] === "number") return String(obj[key]);
  }
  return JSON.stringify(value);
}

function askFieldsFor(ctx: PushContext, askValues: Record<string, unknown>): JiraAskField[] {
  const known = distinctFields(ctx.meta);
  return Object.entries(ctx.map.extraFields)
    .filter(([, spec]) => spec.mode === "ask")
    .map(([fieldId, spec]) => {
      const field = known.find((f) => f.fieldId === fieldId);
      const kind = field ? valueKindFor(field.schema) : "raw";
      return {
        fieldId,
        name: spec.name ?? field?.name ?? fieldId,
        kind,
        choices: choicesFor(field?.allowedValues),
        value: fieldId in askValues ? askValues[fieldId] : spec.value,
      };
    });
}

export async function previewPush(
  service: VaultService,
  keys: string[],
  askValues: Record<string, unknown>,
): Promise<JiraPushPreview> {
  const ctx = await loadContext(service);
  const { plan, items } = await planFor(service, ctx, keys, askValues);
  const changed = await readUpdates(service, ctx, keys);
  // A changed item is skipped as a create and listed as an update instead, or
  // as a problem when its issue cannot be read. Once is enough.
  const elsewhere = new Set([...changed.read.map((r) => r.update.localKey), ...changed.problems.map((p) => p.localKey)]);

  const drafts: JiraDraftView[] = plan.drafts.map((draft) => ({
    localKey: draft.localKey,
    summary: items.get(draft.localKey)?.summary ?? draft.localKey,
    issueType: draft.issueType,
    ...(draft.parentLocalKey ? { parentLocalKey: draft.parentLocalKey } : {}),
    fields: Object.entries(draft.fields)
      .filter(([id]) => id !== "project" && id !== "issuetype")
      .map(([fieldId, value]) => ({
        fieldId,
        name: fieldName(ctx.meta, draft.issueType, fieldId),
        text: describe(value),
      })),
    json: JSON.stringify({ fields: draft.fields }, null, 2),
  }));

  return {
    site: ctx.client.site,
    projectKey: ctx.meta.projectKey,
    projectName: ctx.meta.projectName,
    drafts,
    warnings: [...plan.warnings, ...changed.warnings],
    blockers: plan.blockers,
    skipped: plan.skipped.filter((s) => !elsewhere.has(s.localKey)),
    askFields: askFieldsFor(ctx, askValues),
    updates: changed.read.map((r) => updateView(ctx.client.site, r)),
    updateProblems: changed.problems,
    people: ctx.map.people,
    uncertain: (await uncertainAttempts(ctx.root)).map((attempt) => ({
      ...attempt,
      searchUrl: uncertainAttemptSearchUrl(ctx.client.site, ctx.meta.projectKey, attempt),
    })),
  };
}

// ------------------------------------------------------------------- push

let running = false;

export async function runPush(
  service: VaultService,
  keys: string[],
  askValues: Record<string, unknown>,
  updateFields: Record<string, string[]>,
  onProgress: (progress: JiraPushProgress) => void,
): Promise<JiraPushOutcome> {
  // A double click must not become two pushes of the same items.
  if (running) throw new Error("A push is already running.");
  running = true;
  try {
    // Fresh metadata for the real thing: a field made required since the
    // preview should block here, not be discovered by Jira mid-batch.
    const ctx = await loadContext(service, {
      freshMeta: true,
      onRateLimit: (waitMs) => onProgress({ state: "slowedDown", waitMs }),
    });
    const { plan } = await planFor(service, ctx, keys, askValues);
    const outcome = await sendPushPlan(ctx.client, plan, {
      markPushed: async (localKey, jiraKey, jiraId) => {
        await service.markPushed(localKey, jiraKey, jiraId);
      },
      journal: fileJournal(ctx.root),
      onProgress,
    });
    const typeOf = new Map(plan.drafts.map((d) => [d.localKey, d.issueType]));
    const result: JiraPushOutcome = {
      ...outcome,
      updated: [],
      failed: outcome.failed.map((f) => {
        const type = typeOf.get(f.localKey);
        return namedFieldErrors(f, type ? (id) => fieldName(ctx.meta, type, id) : undefined);
      }),
      // The create path skips a changed item. The update below reports it.
      skipped: outcome.skipped.filter((s) => !(s.localKey in updateFields)),
    };
    if (Object.keys(updateFields).length > 0) {
      await pushUpdates(service, ctx, updateFields, onProgress, result);
    }
    return result;
  } finally {
    running = false;
  }
}

/**
 * The updates, after the creates, so a parent created a moment ago is in Jira
 * by the time its child's parent field is compared.
 *
 * Jira is read again and every value comes from that fresh diff. The renderer
 * only says which fields were ticked. A ticked field that no longer differs is
 * dropped without a word, since the issue already says what the person chose.
 * One that has become uneditable is not sent, and the outcome says so.
 */
async function pushUpdates(
  service: VaultService,
  ctx: PushContext,
  updateFields: Record<string, string[]>,
  onProgress: (progress: JiraPushProgress) => void,
  result: JiraPushOutcome,
): Promise<void> {
  const changed = await readUpdates(service, ctx, Object.keys(updateFields));
  for (const problem of changed.problems) result.skipped.push({ localKey: problem.localKey, reason: problem.message });

  const names = new Map<string, Map<string, string>>();
  const editScreens = new Map<string, IssueState["editable"]>();
  const choices = changed.read.map(({ update, state, diff }) => {
    const ticked = new Set(updateFields[update.localKey] ?? []);
    const fields: Record<string, unknown> = {};
    for (const change of diff.changes) {
      if (!ticked.has(change.fieldId)) continue;
      if (change.editable) fields[change.fieldId] = change.value;
      else {
        result.skipped.push({
          localKey: update.localKey,
          reason: `${change.name} was not changed. ${change.reason ?? ""}`.trim(),
        });
      }
    }
    names.set(update.localKey, new Map(diff.changes.map((c) => [c.fieldId, c.name])));
    editScreens.set(update.localKey, state.editable);
    return {
      localKey: update.localKey,
      jiraKey: update.jiraKey,
      ...(update.jiraId ? { jiraId: update.jiraId } : {}),
      fields,
    };
  });

  const outcome = await sendUpdates(ctx.client, choices, {
    markPushed: async (localKey, jiraKey, jiraId) => {
      await service.markPushed(localKey, jiraKey, jiraId);
    },
    onProgress: (p) => onProgress(p.state === "failed" ? { ...p, uncertain: false } : p),
  });

  for (const u of outcome.updated) {
    const named = names.get(u.localKey);
    result.updated.push({ ...u, fields: u.fields.map((id) => named?.get(id) ?? id) });
  }
  for (const f of outcome.failed) {
    // Named from the edit screen the PUT went to, not the create screen.
    const screen = editScreens.get(f.localKey);
    const named = names.get(f.localKey);
    result.failed.push({
      ...namedFieldErrors(f, (id) => screen?.[id]?.name ?? named?.get(id) ?? id),
      uncertain: false,
    });
  }
}

/**
 * Restamp a changed item whose issue already matches it, as "Mark as in sync"
 * asks. Jira is read again first. If it no longer matches, nothing is stamped,
 * because stamping then would hide a real difference until the next edit.
 */
export async function markInSync(service: VaultService, localKey: string): Promise<void> {
  if (running) throw new Error("A push is running. Mark it once that finishes.");
  const ctx = await loadContext(service);
  const changed = await readUpdates(service, ctx, [localKey]);
  if (changed.problems[0]) throw new Error(changed.problems[0].message);
  const found = changed.read[0];
  if (!found) throw new Error(`${localKey} has not changed since its push, so there is nothing to mark.`);
  if (found.diff.changes.length > 0) {
    const fields = found.diff.changes.map((c) => c.name).join(", ");
    throw new Error(`${found.update.jiraKey} no longer matches ${localKey}: ${fields} differ. Push again to update it.`);
  }
  await service.markPushed(localKey, found.update.jiraKey, found.update.jiraId);
}

/**
 * Settle an uncertain attempt once a person has checked Jira. A key stamps the
 * item as pushed to it; null means it was not created and may be pushed again.
 */
export async function resolveUncertain(
  service: VaultService,
  localKey: string,
  jiraKey: string | null,
): Promise<void> {
  const root = service.root;
  if (!root) throw new Error("No vault is open.");
  if (jiraKey !== null) {
    const key = jiraKey.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Error(`"${jiraKey}" is not a Jira issue key, such as ENG-42.`);
    await service.markPushed(localKey, key);
  }
  await fileJournal(root).settle(localKey);
}
