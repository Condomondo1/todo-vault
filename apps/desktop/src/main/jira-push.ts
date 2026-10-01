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
  createJiraClient,
  distinctFields,
  fetchProjectMeta,
  jiraMapPath,
  loadJiraMap,
  pushTargetProblem,
  resolveCloudId,
  sendPushPlan,
  uncertainAttemptSearchUrl,
  valueKindFor,
  type Item,
  type JiraClient,
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
 * listed as "update not supported yet", where the CSV export would create it
 * again. The app has no update yet, and a second issue is worse than none.
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
    warnings: plan.warnings,
    blockers: plan.blockers,
    skipped: plan.skipped,
    askFields: askFieldsFor(ctx, askValues),
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
    return {
      ...outcome,
      failed: outcome.failed.map((f) => namedFieldErrors(f, ctx.meta, typeOf.get(f.localKey))),
    };
  } finally {
    running = false;
  }
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
