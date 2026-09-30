import assert from "node:assert/strict";
import test from "node:test";

import { createJiraClient } from "../src/jira-client.js";
import type { JiraPushPlan } from "../src/jira.js";
import {
  issueUrl,
  pushTargetProblem,
  sendPushPlan,
  uncertainAttemptSearchUrl,
  type PushAttempt,
  type PushJournal,
  type PushProgress,
} from "../src/jira-push.js";
import { fakeFetch, type Reply } from "./jira-fake-fetch.js";

const SITE = "https://acme.atlassian.net";

function plan(drafts: JiraPushPlan["drafts"], over: Partial<JiraPushPlan> = {}): JiraPushPlan {
  return { jiraProjectKey: "ENG", drafts, attachments: [], skipped: [], warnings: [], blockers: [], ...over };
}

function draft(localKey: string, parentLocalKey?: string) {
  return { localKey, issueType: "Story", ...(parentLocalKey ? { parentLocalKey } : {}), fields: { summary: `Summary of ${localKey}` } };
}

/** A Jira that numbers what it creates, and fails the summaries it is told to. */
function jira(fail: Record<string, Reply | "network"> = {}) {
  let next = 100;
  const doFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { fields: { summary: string } };
    const failure = fail[body.fields.summary];
    if (failure === "network") throw new TypeError("fetch failed: socket hang up");
    return fakeFetch({
      "POST /rest/api/3/issue": failure ?? (() => ({ status: 201, json: { id: String(next), key: `ENG-${next++}`, self: "x" } })),
    }).fetch(input, init);
  };
  const recorded: Array<{ summary: string; parent?: unknown }> = [];
  const recording: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { fields: { summary: string; parent?: unknown } };
    recorded.push({ summary: body.fields.summary, parent: body.fields.parent });
    return doFetch(input, init);
  };
  return {
    client: createJiraClient({ site: SITE, email: "dan@acme.test", token: "t", fetch: recording, maxRetries: 0 }),
    recorded,
  };
}

function memoryJournal() {
  const open = new Map<string, PushAttempt>();
  const journal: PushJournal = {
    begin: async (a) => void open.set(a.localKey, a),
    settle: async (key) => void open.delete(key),
  };
  return { journal, open };
}

// ------------------------------------------------------------------ send

test("drafts are created in order, each stamped before the next, and a child gets its new parent's key", async () => {
  const { client, recorded } = jira();
  const stamped: string[] = [];
  const progress: PushProgress[] = [];
  const outcome = await sendPushPlan(client, plan([draft("ACME-1"), draft("ACME-2", "ACME-1")]), {
    markPushed: async (local, key) => void stamped.push(`${local}->${key}`),
    onProgress: (p) => void progress.push(p),
  });

  assert.deepEqual(stamped, ["ACME-1->ENG-100", "ACME-2->ENG-101"]);
  assert.deepEqual(recorded[1].parent, { key: "ENG-100" });
  assert.deepEqual(
    outcome.created.map((c) => c.url),
    [`${SITE}/browse/ENG-100`, `${SITE}/browse/ENG-101`],
  );
  assert.deepEqual(
    progress.map((p) => p.state),
    ["creating", "created", "creating", "created"],
  );
});

test("a plan with blockers is refused before anything is sent", async () => {
  const { client, recorded } = jira();
  await assert.rejects(
    sendPushPlan(client, plan([draft("ACME-1")], { blockers: [{ localKey: "ACME-1", message: "needs Team" }] }), {
      markPushed: async () => {},
    }),
    /blocker.*needs Team/,
  );
  assert.equal(recorded.length, 0);
});

test("a refused create is reported with Jira's field errors, and its children are skipped rather than orphaned", async () => {
  const { client, recorded } = jira({
    "Summary of ACME-1": { status: 400, json: { errorMessages: [], errors: { customfield_10001: "Team is required." } } },
  });
  const { journal, open } = memoryJournal();
  const outcome = await sendPushPlan(client, plan([draft("ACME-1"), draft("ACME-2", "ACME-1"), draft("ACME-3")]), {
    markPushed: async () => {},
    journal,
  });

  assert.deepEqual(outcome.failed.map((f) => [f.localKey, f.uncertain]), [["ACME-1", false]]);
  assert.deepEqual(outcome.failed[0].fieldErrors, { customfield_10001: "Team is required." });
  assert.deepEqual(outcome.skipped.map((s) => s.localKey), ["ACME-2"]);
  assert.deepEqual(outcome.created.map((c) => c.localKey), ["ACME-3"], "unrelated items carry on");
  assert.equal(recorded.length, 2, "the orphan was never sent");
  assert.equal(open.size, 0, "a refusal is certain, so nothing is left in the journal");
});

test("a request that got no answer is uncertain: it stays in the journal and says so", async () => {
  const { client } = jira({ "Summary of ACME-1": "network" });
  const { journal, open } = memoryJournal();
  const outcome = await sendPushPlan(client, plan([draft("ACME-1"), draft("ACME-2")]), {
    markPushed: async () => {},
    journal,
    now: () => new Date("2026-09-29T15:00:00Z"),
  });

  assert.equal(outcome.failed[0].uncertain, true);
  assert.match(outcome.failed[0].message, /may have reached Jira/);
  assert.deepEqual([...open.keys()], ["ACME-1"]);
  assert.equal(open.get("ACME-1")?.summary, "Summary of ACME-1");
  assert.deepEqual(outcome.created.map((c) => c.localKey), ["ACME-2"]);
});

test("an issue created but not stamped is kept in the journal, so it is never created twice", async () => {
  const { client } = jira();
  const { journal, open } = memoryJournal();
  const outcome = await sendPushPlan(client, plan([draft("ACME-1")]), {
    markPushed: async () => {
      throw new Error("disk full");
    },
    journal,
  });
  assert.equal(outcome.failed[0].uncertain, true);
  assert.match(outcome.failed[0].message, /ENG-100 was created in Jira/);
  assert.ok(open.has("ACME-1"));
});

test("skipped items from the plan are carried into the outcome", async () => {
  const { client } = jira();
  const outcome = await sendPushPlan(
    client,
    plan([], { skipped: [{ localKey: "ACME-9", reason: "Already pushed as ENG-9 and unchanged since" }] }),
    { markPushed: async () => {} },
  );
  assert.deepEqual(outcome.skipped.map((s) => s.localKey), ["ACME-9"]);
});

// ------------------------------------------------------------ the target

test("the push goes only to the site the credential was saved for", () => {
  assert.equal(pushTargetProblem({ baseUrl: "https://acme.atlassian.net/" }, SITE), null);
  assert.match(pushTargetProblem({ baseUrl: "https://evil.atlassian.net" }, SITE) ?? "", /only ever sent to the site it was saved for/);
  assert.match(pushTargetProblem({}, SITE) ?? "", /no baseUrl/);
  assert.match(pushTargetProblem({ baseUrl: "http://acme.atlassian.net" }, SITE) ?? "", /not usable/);
});

test("issue links and the uncertain-attempt search point at the site a person opens", () => {
  assert.equal(issueUrl(`${SITE}/`, "ENG-7"), `${SITE}/browse/ENG-7`);
  const url = new URL(
    uncertainAttemptSearchUrl(SITE, "ENG", { localKey: "ACME-1", summary: 'Chase "legal" re: DPA', at: "2026-09-29T00:30:00Z" }),
  );
  assert.equal(url.origin, SITE);
  const jql = url.searchParams.get("jql") ?? "";
  assert.match(jql, /project = "ENG"/);
  assert.match(jql, /summary ~ "\\"Chase  legal  re: DPA\\""/, "quotes cannot break out of the phrase");
  assert.match(jql, /created >= "2026-09-28"/, "a day early, whatever the user's Jira timezone");
});
