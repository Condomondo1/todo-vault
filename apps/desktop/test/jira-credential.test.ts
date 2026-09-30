import assert from "node:assert/strict";
import test from "node:test";

import {
  forFirstConnect,
  parseJiraSite,
  parseStoredCredential,
  summarise,
  toStoredCredential,
  verifyCredential,
} from "../src/main/jira-credential.js";

const TOKEN = "ATATT3xFfGF0-not-a-real-token-8Zq";

test("a site is reduced to an https origin", () => {
  assert.equal(parseJiraSite("https://acme.atlassian.net"), "https://acme.atlassian.net");
  assert.equal(parseJiraSite("  https://acme.atlassian.net/  "), "https://acme.atlassian.net");
  // People paste whatever board they are looking at.
  assert.equal(
    parseJiraSite("https://acme.atlassian.net/jira/software/projects/ENG/boards/3?x=1"),
    "https://acme.atlassian.net",
  );
  // A bare host means https.
  assert.equal(parseJiraSite("acme.atlassian.net"), "https://acme.atlassian.net");
  assert.equal(parseJiraSite("HTTPS://Acme.Atlassian.net"), "https://acme.atlassian.net");
});

test("http is refused rather than upgraded, and so is anything else that is not https", () => {
  assert.throws(() => parseJiraSite("http://acme.atlassian.net"), /over https.*is http/);
  assert.throws(() => parseJiraSite("ftp://acme.atlassian.net"), /over https.*is ftp/);
  assert.throws(() => parseJiraSite(""), /Enter your Jira site/);
  assert.throws(() => parseJiraSite("https://"), /is not a URL/);
});

test("a site with credentials in it is refused, so they cannot end up stored as the site", () => {
  assert.throws(
    () => parseJiraSite(`https://me%40acme.com:${TOKEN}@acme.atlassian.net`),
    /entered separately/,
  );
});

test("input is validated and trimmed into the stored shape", () => {
  const stored = toStoredCredential({
    site: "acme.atlassian.net/browse/ENG-1",
    auth: "scoped",
    email: "  me@acme.com ",
    token: `  ${TOKEN}\n`,
  });
  assert.deepEqual(stored, {
    v: 1,
    site: "https://acme.atlassian.net",
    auth: "scoped",
    email: "me@acme.com",
    token: TOKEN,
  });

  const base = { site: "acme.atlassian.net", auth: "site" as const, email: "me@acme.com", token: TOKEN };
  assert.throws(() => toStoredCredential({ ...base, email: "me" }), /not an email address/);
  assert.throws(() => toStoredCredential({ ...base, token: "   " }), /Paste the API token/);
  assert.throws(
    () => toStoredCredential({ ...base, auth: "oauth" as never }),
    /which kind of API token/,
  );
});

test("a stored blob reads back, and anything unreadable reads as no credential", () => {
  const stored = toStoredCredential({
    site: "acme.atlassian.net",
    auth: "site",
    email: "me@acme.com",
    token: TOKEN,
  });
  assert.deepEqual(parseStoredCredential(JSON.stringify(stored)), stored);
  assert.deepEqual(
    parseStoredCredential(JSON.stringify({ ...stored, verifiedAt: "2026-09-30T10:00:00Z" })),
    { ...stored, verifiedAt: "2026-09-30T10:00:00Z" },
  );

  assert.equal(parseStoredCredential(null), null);
  assert.equal(parseStoredCredential("not json"), null);
  assert.equal(parseStoredCredential(JSON.stringify({ ...stored, v: 2 })), null, "a future shape");
  assert.equal(parseStoredCredential(JSON.stringify({ ...stored, token: "" })), null);
  assert.equal(parseStoredCredential(JSON.stringify({ ...stored, auth: "basic" })), null);
});

test("the summary the renderer gets never carries the token", () => {
  const stored = {
    ...toStoredCredential({ site: "acme.atlassian.net", auth: "site", email: "me@acme.com", token: TOKEN }),
    verifiedAt: "2026-09-30T10:00:00Z",
  };
  const summary = summarise(stored);
  assert.deepEqual(summary, {
    site: "https://acme.atlassian.net",
    auth: "site",
    email: "me@acme.com",
    verifiedAt: "2026-09-30T10:00:00Z",
  });
  assert.equal(JSON.stringify(summary).includes(TOKEN), false);
});

// ------------------------------------------------------------ verification

/** A fake fetch that answers by URL and records what was asked. */
function fakeJira(routes: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const route = routes[url];
    if (!route) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const NOW = () => new Date("2026-09-30T12:00:00.000Z");
const CLOUD_ID = "0f5c1e0a-2b3c-4d5e-8f90-a1b2c3d4e5f6";
const ME = { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Dan Okafor", emailAddress: "me@acme.com" };

test("a classic token is checked against the site, and the answer is kept", async () => {
  const stored = toStoredCredential({ site: "acme.atlassian.net", auth: "site", email: "me@acme.com", token: TOKEN });
  const jira = fakeJira({ "https://acme.atlassian.net/rest/api/3/myself": { status: 200, body: ME } });

  const { stored: verified, account } = await verifyCredential(stored, { fetch: jira.fetch, now: NOW });

  assert.equal(account.displayName, "Dan Okafor");
  assert.deepEqual(verified, { ...stored, verifiedAt: "2026-09-30T12:00:00.000Z", accountName: "Dan Okafor" });
  assert.equal(jira.calls.length, 1);
  assert.equal(
    jira.calls[0]!.authorization,
    `Basic ${Buffer.from(`me@acme.com:${TOKEN}`).toString("base64")}`,
  );
});

test("a scoped token resolves the cloud id once, keeps it, and goes through the gateway", async () => {
  const stored = toStoredCredential({ site: "acme.atlassian.net", auth: "scoped", email: "me@acme.com", token: TOKEN });
  const gateway = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/myself`;
  const jira = fakeJira({
    "https://acme.atlassian.net/_edge/tenant_info": { status: 200, body: { cloudId: CLOUD_ID } },
    [gateway]: { status: 200, body: ME },
  });

  const first = await verifyCredential(stored, { fetch: jira.fetch, now: NOW });
  assert.equal(first.stored.cloudId, CLOUD_ID);
  assert.deepEqual(jira.calls.map((c) => c.url), ["https://acme.atlassian.net/_edge/tenant_info", gateway]);
  assert.equal(jira.calls[0]!.authorization, null, "the cloud id lookup is sent without credentials");

  // The kept id is used rather than looked up again.
  await verifyCredential(first.stored, { fetch: jira.fetch, now: NOW });
  assert.deepEqual(jira.calls.slice(2).map((c) => c.url), [gateway]);
});

test("a refused token rejects with a message that never contains it", async () => {
  const stored = toStoredCredential({ site: "acme.atlassian.net", auth: "site", email: "me@acme.com", token: TOKEN });
  const jira = fakeJira({
    "https://acme.atlassian.net/rest/api/3/myself": { status: 401, body: { errorMessages: ["Unauthorized"] } },
  });

  const err = await verifyCredential(stored, { fetch: jira.fetch, now: NOW }).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as Error & { kind?: string },
  );
  assert.equal(err.kind, "auth");
  assert.equal(JSON.stringify({ message: err.message, stack: err.stack }).includes(TOKEN), false);
});

test("the cloud id and account name survive a round trip; the summary names the account", () => {
  const stored = {
    ...toStoredCredential({ site: "acme.atlassian.net", auth: "scoped", email: "me@acme.com", token: TOKEN }),
    cloudId: CLOUD_ID,
    verifiedAt: "2026-09-30T12:00:00.000Z",
    accountName: "Dan Okafor",
  };
  assert.deepEqual(parseStoredCredential(JSON.stringify(stored)), stored);
  assert.equal(summarise(stored).accountName, "Dan Okafor");
  assert.equal("cloudId" in summarise(stored), false, "the renderer has no use for it");
});

test("a first Connect that Jira refuses is worded for a first Connect", async () => {
  const stored = toStoredCredential({ site: "acme.atlassian.net", auth: "site", email: "me@acme.com", token: TOKEN });
  const jira = fakeJira({
    "https://acme.atlassian.net/rest/api/3/myself": { status: 401, body: { errorMessages: ["Unauthorized"] } },
  });
  const err = await verifyCredential(stored, { fetch: jira.fetch }).catch((e: unknown) => forFirstConnect(e));
  assert.match((err as Error).message, /did not accept this email and token/);
  assert.equal((err as Error).message.includes("stored"), false);

  // Anything that is not a refusal keeps the client's own message.
  const network = Object.assign(new Error("Could not reach acme.atlassian.net."), { kind: "network" });
  assert.equal(forFirstConnect(network), network);
});
