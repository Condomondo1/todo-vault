import assert from "node:assert/strict";
import test from "node:test";

import {
  parseJiraSite,
  parseStoredCredential,
  summarise,
  toStoredCredential,
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
