/**
 * Sending a push plan: the one place the vault writes to Jira.
 *
 * `buildPushPlan` decides what to send and never sends it. This sends exactly
 * what it decided, one issue at a time, and stamps each success the moment it
 * lands. Everything here takes a client and callbacks rather than reaching for
 * a vault or a file, so the whole send — ordering, parent links, failure
 * handling, the journal — runs under test against a fake `fetch`.
 *
 * **Sequential, parents first.** Jira's bulk create takes fifty at a time, but
 * it cannot create a parent and its child in one call and reports partial
 * failure per element. For the batch sizes one person pushes, one at a time is
 * simpler to reason about and fails one row at a time in a way the pane can
 * show.
 *
 * **Stamped as it goes.** `markPushed` runs after each create, not at the end,
 * so a crash halfway leaves every created issue stamped and the next push skips
 * it rather than creating it twice.
 *
 * **The ambiguous failure is journalled.** When the connection drops after a
 * request has left, nobody knows whether Jira created the issue. Retrying
 * risks a duplicate in a tracker a whole team reads; giving up risks a lost
 * stamp. So each attempt is written to a journal before it is sent and settled
 * once the outcome is known. An entry left unsettled is surfaced next time as
 * "may already exist in Jira", for a person to resolve before that item can be
 * pushed again.
 */
import { z } from "zod";

import { JiraError, normaliseBaseUrl, parseOrThrow, type JiraClient } from "./jira-client.js";
import type { JiraMap, JiraPushPlan } from "./jira.js";

/** One attempt in flight, as the journal records it. */
export interface PushAttempt {
  localKey: string;
  summary: string;
  /** ISO timestamp the request was sent. */
  at: string;
}

/**
 * Where attempts are recorded before they are sent. The app keeps it in a file
 * under `userData`; tests keep it in memory. `settle` is called once the outcome
 * is certain either way — created, or refused by Jira.
 */
export interface PushJournal {
  begin(attempt: PushAttempt): Promise<void>;
  settle(localKey: string): Promise<void>;
}

export type PushProgress =
  | { localKey: string; state: "creating" }
  | { localKey: string; state: "created"; jiraKey: string; url: string }
  | { localKey: string; state: "failed"; message: string; uncertain: boolean }
  | { localKey: string; state: "skipped"; reason: string };

export interface PushOutcome {
  created: Array<{ localKey: string; jiraKey: string; jiraId: string; url: string }>;
  /**
   * `uncertain` means the request may have reached Jira: the journal entry is
   * left in place, and the item cannot be pushed again until someone says
   * whether it exists.
   */
  failed: Array<{ localKey: string; message: string; fieldErrors: Record<string, string>; uncertain: boolean }>;
  skipped: Array<{ localKey: string; reason: string }>;
}

export interface SendOptions {
  /** Stamp the item. Called once per created issue, before the next is sent. */
  markPushed(localKey: string, jiraKey: string, jiraId: string): Promise<void>;
  journal?: PushJournal;
  onProgress?: (progress: PushProgress) => void;
  now?: () => Date;
}

const CreatedIssue = z.object({ id: z.string(), key: z.string() });

/** Where a person opens an issue. Always the site, even when requests go through the gateway. */
export function issueUrl(site: string, jiraKey: string): string {
  return `${normaliseBaseUrl(site)}/browse/${encodeURIComponent(jiraKey)}`;
}

/**
 * The map and the credential must name the same site, or nothing is sent.
 *
 * A token is issued for one site. The map is a file in a synced, committed
 * folder that anyone with access to the vault can edit; if it could redirect a
 * push to another site, the token would go with it. Returns the refusal, or
 * null when the two agree.
 */
export function pushTargetProblem(map: Pick<JiraMap, "baseUrl">, credentialSite: string): string | null {
  if (!map.baseUrl) {
    return "jira-map.yaml has no baseUrl, so there is no site to push to. Set it in Settings → Jira.";
  }
  let mapSite: string;
  try {
    mapSite = normaliseBaseUrl(map.baseUrl);
  } catch (err) {
    return `jira-map.yaml's baseUrl is not usable: ${err instanceof Error ? err.message : String(err)}`;
  }
  const saved = normaliseBaseUrl(credentialSite);
  if (mapSite !== saved) {
    return `jira-map.yaml points at ${mapSite}, but the saved Jira credential is for ${saved}. Nothing was sent: a token is only ever sent to the site it was saved for. Fix the map or replace the credential in Settings → Jira.`;
  }
  return null;
}

/**
 * Send every draft in `plan`, in order, and report what happened to each.
 *
 * Refuses outright when the plan has blockers — the pane should never offer the
 * button then, and this is the check that does not depend on the pane.
 */
export async function sendPushPlan(
  client: JiraClient,
  plan: JiraPushPlan,
  options: SendOptions,
): Promise<PushOutcome> {
  if (plan.blockers.length) {
    throw new Error(
      `This push has ${plan.blockers.length} blocker${plan.blockers.length === 1 ? "" : "s"} and was not sent: ${plan.blockers[0].message}`,
    );
  }

  const now = options.now ?? (() => new Date());
  const outcome: PushOutcome = { created: [], failed: [], skipped: [...plan.skipped] };
  const createdKeys = new Map<string, string>();
  const notCreated = new Set<string>();

  for (const draft of plan.drafts) {
    // A child whose parent is in this batch waits for that parent's key. If
    // the parent did not make it, creating the child anyway would put it in
    // Jira unparented — a quieter failure than skipping it and saying why.
    const fields = { ...draft.fields };
    if (draft.parentLocalKey) {
      const parentKey = createdKeys.get(draft.parentLocalKey);
      if (!parentKey) {
        const reason = `Its parent ${draft.parentLocalKey} was not created, so it was not sent.`;
        outcome.skipped.push({ localKey: draft.localKey, reason });
        notCreated.add(draft.localKey);
        options.onProgress?.({ localKey: draft.localKey, state: "skipped", reason });
        continue;
      }
      fields.parent = { key: parentKey };
    }

    options.onProgress?.({ localKey: draft.localKey, state: "creating" });
    const summary = typeof fields.summary === "string" ? fields.summary : draft.localKey;
    await options.journal?.begin({ localKey: draft.localKey, summary, at: now().toISOString() });

    let created: { id: string; key: string };
    try {
      created = parseOrThrow(CreatedIssue, await client.post("/rest/api/3/issue", { fields }), "/rest/api/3/issue");
    } catch (err) {
      // Only a request that got no answer is ambiguous. A 4xx or 5xx is Jira
      // saying it did not create the issue, so the attempt is settled.
      const uncertain = err instanceof JiraError && err.kind === "network";
      if (!uncertain) await options.journal?.settle(draft.localKey);
      const message =
        err instanceof Error ? err.message : String(err);
      outcome.failed.push({
        localKey: draft.localKey,
        message: uncertain
          ? `${message} The request may have reached Jira, so it will not be sent again until you say whether ${draft.localKey} was created.`
          : message,
        fieldErrors: err instanceof JiraError ? err.fieldErrors : {},
        uncertain,
      });
      notCreated.add(draft.localKey);
      options.onProgress?.({ localKey: draft.localKey, state: "failed", message, uncertain });
      continue;
    }

    // Stamped before anything else is sent. If the stamp itself fails the
    // issue still exists, so the journal entry is kept: next time it asks,
    // rather than creating a second copy.
    try {
      await options.markPushed(draft.localKey, created.key, created.id);
    } catch (err) {
      const message = `${created.key} was created in Jira, but recording that in the vault failed: ${err instanceof Error ? err.message : String(err)}`;
      outcome.failed.push({ localKey: draft.localKey, message, fieldErrors: {}, uncertain: true });
      createdKeys.set(draft.localKey, created.key);
      options.onProgress?.({ localKey: draft.localKey, state: "failed", message, uncertain: true });
      continue;
    }
    await options.journal?.settle(draft.localKey);

    const url = issueUrl(client.site, created.key);
    createdKeys.set(draft.localKey, created.key);
    outcome.created.push({ localKey: draft.localKey, jiraKey: created.key, jiraId: created.id, url });
    options.onProgress?.({ localKey: draft.localKey, state: "created", jiraKey: created.key, url });
  }

  return outcome;
}

/**
 * A Jira search a person can open to check whether an uncertain attempt landed:
 * the project, the exact summary, created since the day before the attempt.
 *
 * Opened in the browser rather than run here. The person deciding is the one
 * who knows whether a near-match is the same issue, and a search page shows
 * them everything a query result would, with the issue one click away.
 */
export function uncertainAttemptSearchUrl(site: string, projectKey: string, attempt: PushAttempt): string {
  // A day early, by date only. JQL reads a time in the *user's* Jira timezone,
  // which this cannot know, so a tight UTC window could start hours after the
  // attempt and miss the very issue being looked for. A day of slack is cheap:
  // the exact-summary clause does the narrowing.
  const since = new Date(new Date(attempt.at).getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10);
  const phrase = attempt.summary.replace(/["\\]/g, " ").trim();
  const jql = `project = "${projectKey.replace(/"/g, "")}" AND summary ~ "\\"${phrase}\\"" AND created >= "${since}" ORDER BY created DESC`;
  return `${normaliseBaseUrl(site)}/issues/?jql=${encodeURIComponent(jql)}`;
}
