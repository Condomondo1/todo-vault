/**
 * Settings → Jira, the connection, in a real window against a fake Jira.
 *
 * `jira-credential.test.ts` covers validation and `verifyCredential` over a
 * fake `fetch`. What only the app can show is the whole path: the panel sends
 * the pair once, main asks a real HTTPS server `GET /myself` with it, and only
 * an answer Jira accepted gets stored. The spec also checks the storage itself:
 * that `safeStorage` really encrypted the file on this machine, that a refused
 * pair left nothing behind, and that Remove deletes the file rather than hiding
 * it. Every path is the harness's throwaway `userData`, never the real one.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { canStartFakeJira, startFakeJira, type FakeJira } from "./fake-jira.mjs";
import { launchHarness, type Harness } from "./harness.mjs";

const EMAIL = "me@acme.com";
const TOKEN = "ATATT3xFfGF0-e2e-fixture-token-not-real-7Qp";

describe(
  "the Jira connection is verified before it is stored, and stored encrypted",
  // A fake Jira needs openssl for its certificate. Said, not silently passed.
  { concurrency: 1, skip: (await canStartFakeJira()) ? false : "openssl is not on PATH, so no fake Jira" },
  () => {
    let jira: FakeJira;
    let harness: Harness;
    const credentialFile = () => path.join(harness.userDataDir, "jira-credentials.bin");
    const exists = (p: string) => fs.stat(p).then(() => true, () => false);
    const panel = () =>
      harness.page.locator(".modal", { has: harness.page.locator("h2", { hasText: "Jira" }) });
    const fill = async (site: string, token: string): Promise<void> => {
      await panel().getByLabel("Jira site").fill(site);
      await panel().getByLabel("Atlassian account email").fill(EMAIL);
      await panel().getByLabel("API token", { exact: true }).fill(token);
    };

    before(async () => {
      jira = await startFakeJira({
        email: EMAIL,
        token: TOKEN,
        account: { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Dan Okafor", emailAddress: EMAIL },
      });
      harness = await launchHarness({ env: { NODE_EXTRA_CA_CERTS: jira.caCertPath } });
    });

    after(async () => {
      await harness.close();
      await jira.close();
    });

    test("the panel opens not connected", async () => {
      await harness.page.getByRole("button", { name: "Jira", exact: true }).click();
      await panel().getByText("Not connected").waitFor();
      assert.equal(await exists(credentialFile()), false);
    });

    test("an http site is refused before anything is sent", async () => {
      await fill(jira.site.replace("https:", "http:"), TOKEN);
      await panel().getByRole("button", { name: "Connect" }).click();
      await panel().locator(".modal-error", { hasText: "must be reached over https" }).waitFor();
      assert.equal(jira.requests.length, 0, "not even a refused request left the app");
      assert.equal(await exists(credentialFile()), false);
    });

    test("a token Jira refuses is not stored", async () => {
      await fill(jira.site, "not-the-token");
      await panel().getByRole("button", { name: "Connect" }).click();
      await panel().locator(".modal-error", { hasText: "did not accept this email and token" }).waitFor();
      assert.equal((await panel().locator(".modal-error").innerText()).includes("not-the-token"), false);
      assert.deepEqual(
        jira.requests.map((r) => [r.method, r.path, r.authorized]),
        [["GET", "/rest/api/3/myself", false]],
      );
      assert.equal(await exists(credentialFile()), false);
    });

    test("the right pair is verified, then stored encrypted, and names the account", async () => {
      await panel().getByLabel("API token", { exact: true }).fill(TOKEN);
      await panel().getByRole("button", { name: "Connect" }).click();

      await panel().getByText(`Dan Okafor · ${EMAIL} on ${new URL(jira.site).host}`).waitFor();
      await panel().getByText(/^verified /).waitFor();
      assert.deepEqual(jira.requests.at(-1), {
        method: "GET",
        path: "/rest/api/3/myself",
        authorized: true,
        body: "",
      });

      const onDisk = await fs.readFile(credentialFile());
      assert.equal(onDisk.includes(TOKEN), false, "the token must not be on disk in plain text");
      assert.equal(onDisk.includes(EMAIL), false, "nor the rest of the blob");

      const status = await harness.page.evaluate(() =>
        (window as unknown as { vault: { jiraStatus(): Promise<unknown> } }).vault.jiraStatus(),
      );
      assert.equal(JSON.stringify(status).includes(TOKEN), false);
      const credential = (status as { value: { credential: Record<string, unknown> } }).value.credential;
      assert.deepEqual(
        { ...credential, verifiedAt: typeof credential.verifiedAt },
        { site: jira.site, auth: "site", email: EMAIL, accountName: "Dan Okafor", verifiedAt: "string" },
      );
    });

    test("Test connection asks again with the stored pair", async () => {
      const already = jira.requests.length;
      await panel().getByRole("button", { name: "Test connection" }).click();
      await panel().getByText("Jira accepted the stored token.").waitFor();
      assert.deepEqual(
        jira.requests.slice(already).map((r) => [r.path, r.authorized]),
        [["/rest/api/3/myself", true]],
      );
    });

    test("Replace re-asks for the token, with site and email kept", async () => {
      await panel().getByRole("button", { name: "Replace" }).click();
      assert.equal(await panel().getByLabel("Jira site").inputValue(), jira.site);
      assert.equal(await panel().getByLabel("Atlassian account email").inputValue(), EMAIL);
      assert.equal(await panel().getByLabel("API token", { exact: true }).inputValue(), "");
      assert.equal(await panel().getByRole("button", { name: "Connect" }).isDisabled(), true);
      await panel().getByRole("button", { name: "Cancel" }).click();
    });

    test("Remove deletes the file", async () => {
      await panel().getByRole("button", { name: "Remove" }).click();
      await panel().getByText("Not connected").waitFor();
      assert.equal(await exists(credentialFile()), false);
    });
  },
);
