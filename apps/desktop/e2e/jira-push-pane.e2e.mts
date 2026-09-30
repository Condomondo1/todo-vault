/**
 * The push pane opens from both of its entry points and, with no credential
 * saved, shows main's refusal instead of a button that could send anything.
 *
 * This is the part of the push that needs no Jira: the wiring from the bulk
 * bar and the detail panel, through IPC, to `loadContext` in main, which
 * refuses before building a client. A push against a Jira — the fake HTTPS
 * server in `fake-jira.mts` — is its own spec. Each harness run has a fresh
 * `userData`, so there is never a credential here to begin with.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { launchHarness, type Harness } from "./harness.mjs";
import { findItemKey, itemRow, openItem } from "./drive.mjs";

describe("the Jira push pane", { concurrency: 1 }, () => {
  let harness: Harness;
  let key: string;

  before(async () => {
    harness = await launchHarness();
    await harness.page.locator("table.table tbody tr").first().waitFor({ state: "visible" });
    // Any item the fixture has not already pushed.
    const { Vault } = await import("todo-vault");
    const vault = await Vault.open(harness.vaultRoot);
    const unpushed = vault.listItems({ open: true, limit: 500 }).items.find((i) => !i.sync.jiraKey);
    assert.ok(unpushed, "the fixture should hold an unpushed open item");
    key = await findItemKey(harness.vaultRoot, unpushed.summary);
  });

  after(async () => {
    await harness.close();
  });

  const pane = () => harness.page.getByRole("dialog", { name: "Push to Jira" });

  test("from the detail panel, with no credential saved, it explains instead of offering to send", async () => {
    await openItem(harness.page, key);
    await harness.page.locator("aside.detail").getByRole("button", { name: "Push to Jira…" }).click();
    await pane().waitFor({ state: "visible" });
    await pane().locator(".modal-error").waitFor({ state: "visible" });

    assert.match(await pane().locator(".modal-error").innerText(), /No Jira credential is saved/);
    const create = pane().getByRole("button", { name: /^Create / });
    assert.equal(await create.isDisabled(), true, "nothing to send, so nothing to press");

    await pane().getByRole("button", { name: "Cancel" }).click();
    await pane().waitFor({ state: "hidden" });
  });

  test("from the bulk bar, for the checked rows", async () => {
    await itemRow(harness.page, key).locator('input[type="checkbox"]').check();
    await harness.page.locator(".bulk-bar").getByRole("button", { name: "Push to Jira…" }).click();
    await pane().locator(".modal-error").waitFor({ state: "visible" });
    assert.match(await pane().locator(".modal-error").innerText(), /Settings → Jira/);
    await pane().getByRole("button", { name: "Close" }).click();
    await pane().waitFor({ state: "hidden" });
  });
});
