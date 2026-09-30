import assert from "node:assert/strict";
import test from "node:test";

import {
  apiRoot,
  createJiraClient,
  normaliseBaseUrl,
  resolveCloudId,
  retryAfterMs,
  JiraError,
  type JiraClientOptions,
} from "../src/jira-client.js";
import { fakeFetch, type Reply } from "./jira-fake-fetch.js";

const SITE = "https://acme.atlassian.net";
const EMAIL = "dan@acme.test";
const TOKEN = "ATATT3xFfGF0-this-is-the-secret-token";
const BASIC = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
const CLOUD_ID = "11111111-2222-3333-4444-555555555555";

function client(routes: Record<string, Reply | Reply[]>, extra: Partial<JiraClientOptions> = {}) {
  const fake = fakeFetch(routes);
  const c = createJiraClient({
    site: SITE,
    email: EMAIL,
    token: TOKEN,
    fetch: fake.fetch,
    sleep: async () => {},
    ...extra,
  });
  return { c, requests: fake.requests };
}

/** Everything an error could leak through: message, stack, and every own property. */
function everythingIn(err: unknown): string {
  const e = err as Error & Record<string, unknown>;
  return [e.message, e.stack, JSON.stringify({ ...e })].join("\n");
}

// ------------------------------------------------------------- base URL

test("a pasted site URL is reduced to its https origin", () => {
  assert.equal(normaliseBaseUrl("https://acme.atlassian.net/"), SITE);
  assert.equal(normaliseBaseUrl("  https://acme.atlassian.net//  "), SITE);
  assert.equal(normaliseBaseUrl("https://acme.atlassian.net/jira/software/projects/ENG/boards/1"), SITE);
});

test("http is refused, not upgraded — Basic auth over it is the token in the clear", () => {
  assert.throws(() => normaliseBaseUrl("http://acme.atlassian.net"), /https/);
});

test("credentials in the URL and non-URLs are refused", () => {
  assert.throws(() => normaliseBaseUrl("https://dan:pw@acme.atlassian.net"), /username and password/);
  assert.throws(() => normaliseBaseUrl("acme.atlassian.net"), /not a URL/);
});

test("a scoped token goes through the gateway, and needs a cloud id to", () => {
  assert.equal(apiRoot({ site: SITE }), SITE);
  assert.equal(
    apiRoot({ site: SITE, auth: "scoped", cloudId: CLOUD_ID }),
    `https://api.atlassian.com/ex/jira/${CLOUD_ID}`,
  );
  assert.throws(() => apiRoot({ site: SITE, auth: "scoped" }), /cloud id/);
  assert.throws(() => apiRoot({ site: SITE, auth: "scoped", cloudId: "../../evil" }), /cloud id/);
});

// ------------------------------------------------------------- requests

test("myself sends Basic auth to the site, refuses redirects, and returns the account", async () => {
  const { c, requests } = client({
    "GET /rest/api/3/myself": { status: 200, json: { accountId: "abc", displayName: "Dan Okafor", emailAddress: EMAIL, extra: 1 } },
  });
  const me = await c.myself();
  assert.deepEqual(me, { accountId: "abc", displayName: "Dan Okafor", emailAddress: EMAIL });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.origin, SITE);
  assert.equal(requests[0].headers.authorization, `Basic ${BASIC}`);
  assert.equal(requests[0].redirect, "manual");
});

test("a scoped client sends every request under the gateway root", async () => {
  const { c, requests } = client(
    { [`GET /ex/jira/${CLOUD_ID}/rest/api/3/myself`]: { status: 200, json: { accountId: "abc", displayName: "Dan" } } },
    { auth: "scoped", cloudId: CLOUD_ID },
  );
  await c.myself();
  assert.equal(requests[0].url.origin, "https://api.atlassian.com");
  assert.equal(c.site, SITE, "links still point at the site a person opens");
});

test("a path that would leave the site is refused before any request is made", async () => {
  const { c, requests } = client({});
  for (const path of ["https://evil.test/steal", "//evil.test/steal", "/rest/../../x", "rest/api/3/myself"]) {
    await assert.rejects(c.get(path), /Refusing/, path);
  }
  assert.equal(requests.length, 0);
});

test("query values are encoded rather than spliced into the path", async () => {
  const { c, requests } = client({ "GET /rest/api/3/user/assignable/search": { status: 200, json: [] } });
  await c.get("/rest/api/3/user/assignable/search", { project: "ENG", query: "dan & co", skip: undefined });
  assert.equal(requests[0].url.searchParams.get("query"), "dan & co");
  assert.equal(requests[0].url.searchParams.has("skip"), false);
});

test("a redirect is reported, never followed", async () => {
  const { c, requests } = client({
    "GET /rest/api/3/myself": { status: 302, headers: { location: "https://evil.test/" } },
  });
  await assert.rejects(c.myself(), (err: JiraError) => err.kind === "redirect" && err.status === 302);
  assert.equal(requests.length, 1);
});

// --------------------------------------------------------------- errors

test("a 401 reads as a possibly expired token, with where to fix it", async () => {
  const { c } = client({ "GET /rest/api/3/myself": { status: 401, text: "Unauthorized" } });
  await assert.rejects(c.myself(), (err: JiraError) => {
    assert.equal(err.kind, "auth");
    assert.match(err.message, /expired or been revoked/);
    assert.match(err.message, /Settings → Jira/);
    return true;
  });
});

test("Jira's field errors are kept, so a refused create can say which field", async () => {
  const { c } = client({
    "POST /rest/api/3/issue": {
      status: 400,
      json: { errorMessages: [], errors: { customfield_10001: "Team is required." } },
    },
  });
  await assert.rejects(c.post("/rest/api/3/issue", { fields: {} }), (err: JiraError) => {
    assert.equal(err.kind, "http");
    assert.deepEqual(err.fieldErrors, { customfield_10001: "Team is required." });
    assert.match(err.message, /Team is required/);
    return true;
  });
});

test("the token appears in no error, whatever went wrong", async () => {
  const cases: Record<string, Reply | "throw"> = {
    auth: { status: 401 },
    forbidden: { status: 403, json: { errorMessages: ["No permission"] } },
    notFound: { status: 404 },
    server: { status: 500, text: "<html>proxy error</html>" },
    redirect: { status: 307 },
    notJson: { status: 200, text: "<html>login page</html>" },
    network: "throw",
  };
  for (const [name, reply] of Object.entries(cases)) {
    const doFetch: typeof fetch =
      reply === "throw"
        ? async () => {
            throw new TypeError("fetch failed: ECONNRESET");
          }
        : fakeFetch({ "GET /rest/api/3/myself": reply }).fetch;
    const c = createJiraClient({ site: SITE, email: EMAIL, token: TOKEN, fetch: doFetch });
    const err = await c.myself().then(
      () => assert.fail(`${name} should have failed`),
      (e: unknown) => e,
    );
    assert.ok(err instanceof JiraError, name);
    const text = everythingIn(err);
    assert.ok(!text.includes(TOKEN), `${name} leaked the token`);
    assert.ok(!text.includes(BASIC), `${name} leaked the Basic header`);
  }
});

// ----------------------------------------------------------- rate limits

test("a 429 waits as long as Jira says, then carries on", async () => {
  const waits: number[] = [];
  const told: number[] = [];
  const { c, requests } = client(
    {
      "GET /rest/api/3/myself": [
        { status: 429, headers: { "retry-after": "2" } },
        { status: 200, json: { accountId: "abc", displayName: "Dan" } },
      ],
    },
    { sleep: async (ms) => void waits.push(ms), onRateLimit: (ms) => void told.push(ms) },
  );
  await c.myself();
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(told, [2000], "a UI can say how long it is waiting");
});

test("a 429 that never lets up is reported after the retries run out", async () => {
  const { c, requests } = client({ "GET /rest/api/3/myself": { status: 429 } }, { maxRetries: 2 });
  await assert.rejects(c.myself(), (err: JiraError) => err.kind === "rateLimited");
  assert.equal(requests.length, 3);
});

test("retry waits back off without a header and are capped at a minute", () => {
  assert.equal(retryAfterMs(null, 0), 1000);
  assert.equal(retryAfterMs(null, 2), 4000);
  assert.equal(retryAfterMs("7", 0), 7000);
  assert.equal(retryAfterMs("86400", 0), 60_000);
  assert.equal(retryAfterMs("soon", 1), 2000);
});

// ------------------------------------------------------------ cloud id

test("the cloud id is read from the site with no credentials sent", async () => {
  const fake = fakeFetch({ "GET /_edge/tenant_info": { status: 200, json: { cloudId: CLOUD_ID } } });
  assert.equal(await resolveCloudId(`${SITE}/`, fake.fetch), CLOUD_ID);
  assert.equal(fake.requests[0].url.origin, SITE);
  assert.equal(fake.requests[0].headers.authorization, undefined);
  assert.equal(fake.requests[0].redirect, "manual");
});

test("a site with no tenant info says so rather than guessing", async () => {
  const fake = fakeFetch({ "GET /_edge/tenant_info": { status: 404 } });
  await assert.rejects(resolveCloudId(SITE, fake.fetch), /did not report a cloud id/);
});
