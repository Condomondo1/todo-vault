/**
 * Settings → Jira, the connection half, in a real window.
 *
 * `jira-credential.test.ts` covers the validation as pure functions. What only
 * the app can show is the storage: that `safeStorage` actually encrypts on this
 * machine, so the token is not sitting in `jira-credentials.bin` in plain text;
 * that a refused site stores nothing at all; and that Remove really deletes the
 * file rather than hiding it. Each check reads the harness's throwaway
 * `userData`, never the real one. The harness asserts that before any spec runs.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { launchHarness, type Harness } from "./harness.mjs";

const TOKEN = "ATATT3xFfGF0-e2e-fixture-token-not-real-7Qp";

describe("the Jira connection is stored once, encrypted, and removable", { concurrency: 1 }, () => {
  let harness: Harness;
  const credentialFile = () => path.join(harness.userDataDir, "jira-credentials.bin");
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);
  const panel = () => harness.page.locator(".modal", { has: harness.page.locator("h2", { hasText: "Jira" }) });

  before(async () => {
    harness = await launchHarness();
  });

  after(async () => {
    await harness.close();
  });

  test("the panel opens not connected", async () => {
    await harness.page.getByRole("button", { name: "Jira", exact: true }).click();
    await panel().getByText("Not connected").waitFor();
    assert.equal(await exists(credentialFile()), false);
  });

  test("an http site is refused, and nothing is written", async () => {
    await panel().getByLabel("Jira site").fill("http://acme.atlassian.net");
    await panel().getByLabel("Atlassian account email").fill("me@acme.com");
    await panel().getByLabel("API token", { exact: true }).fill(TOKEN);
    await panel().getByRole("button", { name: "Save" }).click();

    await panel().locator(".modal-error", { hasText: "must be reached over https" }).waitFor();
    assert.equal(await exists(credentialFile()), false);
  });

  test("an https site is stored, encrypted, and reported without the token", async () => {
    // A board URL, as people paste it. Main keeps only the origin.
    await panel().getByLabel("Jira site").fill("https://acme.atlassian.net/jira/software/projects/ENG/boards/3");
    await panel().getByLabel(/^Scoped token/).check();
    await panel().getByRole("button", { name: "Save" }).click();

    await panel().getByText("me@acme.com on acme.atlassian.net").waitFor();
    await panel().getByText("not verified yet").waitFor();

    const onDisk = await fs.readFile(credentialFile());
    assert.ok(onDisk.length > 0);
    assert.equal(onDisk.includes(TOKEN), false, "the token must not be on disk in plain text");
    assert.equal(onDisk.includes("me@acme.com"), false, "nor the rest of the blob");

    // And nothing the renderer can ask for contains it.
    const status = await harness.page.evaluate(() =>
      (window as unknown as { vault: { jiraStatus(): Promise<unknown> } }).vault.jiraStatus(),
    );
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
    assert.deepEqual(status, {
      ok: true,
      value: {
        storageAvailable: true,
        credential: { site: "https://acme.atlassian.net", auth: "scoped", email: "me@acme.com" },
      },
    });
  });

  test("Replace re-asks for the token, with site and email kept", async () => {
    await panel().getByRole("button", { name: "Replace" }).click();
    assert.equal(await panel().getByLabel("Jira site").inputValue(), "https://acme.atlassian.net");
    assert.equal(await panel().getByLabel("Atlassian account email").inputValue(), "me@acme.com");
    assert.equal(await panel().getByLabel("API token", { exact: true }).inputValue(), "");
    assert.equal(await panel().getByRole("button", { name: "Save" }).isDisabled(), true);
    await panel().getByRole("button", { name: "Cancel" }).click();
  });

  test("Remove deletes the file", async () => {
    await panel().getByRole("button", { name: "Remove" }).click();
    await panel().getByText("Not connected").waitFor();
    assert.equal(await exists(credentialFile()), false);
  });
});
