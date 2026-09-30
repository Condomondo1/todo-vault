/**
 * A push, end to end: the real app, a real HTTPS server playing Jira, and the
 * vault's files read back afterwards.
 *
 * The core's `sendPushPlan` is unit-tested over a fake `fetch`, and
 * `jira-push-pane.e2e.mts` proves the pane refuses with no credential. What
 * only this can show is the whole path working at once: a credential stored
 * through Settings → Jira, a map in the vault, main fetching the project's
 * create screens, a blocker shown and then cleared, an `ask` value chosen in
 * the pane, two issues created parent-first over TLS, and the vault stamped.
 *
 * The fake validates creates like Jira does (see `fake-jira-project.mts`), so a
 * payload the planner should have caught fails here rather than passing
 * because the server accepted anything.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { Vault, jiraMapPath, writeJiraMap } from "todo-vault";

import { canStartFakeJira, startFakeJira, type FakeJira } from "./fake-jira.mjs";
import { DAN, ISSUE_TYPES, TEAM_FIELD, serveProject, type ServedProject } from "./fake-jira-project.mjs";
import { launchHarness, type Harness } from "./harness.mjs";
import { eventually, itemRow } from "./drive.mjs";

const EMAIL = "me@acme.com";
const TOKEN = "ATATT3xFfGF0-e2e-push-token-not-real-9Zk";

describe(
  "a push reaches Jira, parent first, and is stamped in the vault",
  { concurrency: 1, skip: (await canStartFakeJira()) ? false : "openssl is not on PATH, so no fake Jira" },
  () => {
    let jira: FakeJira;
    let project: ServedProject;
    let harness: Harness;
    let epicKey: string;
    let storyKey: string;

    const pane = () => harness.page.getByRole("dialog", { name: "Push to Jira" });
    const settings = () => harness.page.locator(".modal", { has: harness.page.locator("h2", { hasText: /^Jira$/ }) });
    const posts = () => jira.requests.filter((r) => r.method === "POST");

    before(async () => {
      jira = await startFakeJira({ email: EMAIL, token: TOKEN });
      project = serveProject(jira);
      harness = await launchHarness({ env: { NODE_EXTRA_CA_CERTS: jira.caCertPath } });
      await harness.page.locator("table.table tbody tr").first().waitFor({ state: "visible" });

      // The credential goes in the way a person puts it in: through the panel,
      // verified against the fake before it is stored.
      await harness.page.getByRole("button", { name: "Jira", exact: true }).click();
      await settings().getByLabel("Jira site").fill(jira.site);
      await settings().getByLabel("Atlassian account email").fill(EMAIL);
      await settings().getByLabel("API token", { exact: true }).fill(TOKEN);
      await settings().getByRole("button", { name: "Connect" }).click();
      await settings().getByText(/^verified /).waitFor();
      await harness.page.keyboard.press("Escape");
      await settings().waitFor({ state: "hidden" }).catch(async () => {
        await settings().getByRole("button", { name: "Close" }).click();
        await settings().waitFor({ state: "hidden" });
      });

      // The map, written the way Settings → Jira will write it. No Team yet.
      await writeJiraMap(jiraMapPath(harness.vaultRoot), [
        { path: ["jiraProjectKey"], value: "ENG" },
        { path: ["baseUrl"], value: jira.site },
        { path: ["people", "Dan Okafor"], value: { accountId: DAN.accountId, displayName: DAN.displayName } },
      ]);

      const vault = await Vault.open(harness.vaultRoot);
      const epic = await vault.createItem({ project: "ACME", type: "epic", summary: "Launch the billing page" });
      const story = await vault.createItem({
        project: "ACME",
        type: "story",
        parent: epic.key,
        summary: "Show the invoice history",
        assignee: "dan okafor",
      });
      epicKey = epic.key;
      storyKey = story.key;
      for (const key of [epicKey, storyKey]) {
        await itemRow(harness.page, key).waitFor({ state: "visible" });
        await itemRow(harness.page, key).locator('input[type="checkbox"]').check();
      }
    });

    after(async () => {
      await harness?.close();
      await jira?.close();
    });

    test("a Team the map does not fill blocks the push, and nothing is sent", async () => {
      await harness.page.locator(".bulk-bar").getByRole("button", { name: "Push to Jira…" }).click();
      await pane().getByText(/needs Team \(customfield_10001\)/).waitFor();
      assert.equal(await pane().getByRole("button", { name: /^Create 2 issues in ENG$/ }).isDisabled(), true);
      assert.equal(posts().length, 0);
      await pane().getByRole("button", { name: "Cancel" }).click();
      await pane().waitFor({ state: "hidden" });
    });

    test("with Team asked for, the chosen value goes out and both issues are created parent first", async () => {
      await writeJiraMap(jiraMapPath(harness.vaultRoot), [
        {
          path: ["extraFields", TEAM_FIELD],
          value: { name: "Team", mode: "ask", value: { id: "t1" }, issueTypes: ["Story"] },
        },
      ]);

      await harness.page.locator(".bulk-bar").getByRole("button", { name: "Push to Jira…" }).click();
      const team = pane().locator(".modal-field", { hasText: "Team" }).locator("select");
      await team.waitFor();
      await team.selectOption({ label: "Payments" });

      const create = pane().getByRole("button", { name: "Create 2 issues in ENG" });
      await eventually("the re-plan clears and the button enables", () => create.isEnabled(), (on) => on);
      await create.click();
      await pane().getByText("Created 2").waitFor();

      assert.equal(project.created.length, 2);
      const [epic, story] = project.created;
      assert.deepEqual(epic.fields.issuetype, { id: ISSUE_TYPES.epic.id });
      assert.deepEqual(story.fields.issuetype, { id: ISSUE_TYPES.story.id });
      assert.deepEqual(story.fields.parent, { key: epic.key }, "the child waits for its parent's new key");
      assert.deepEqual(story.fields[TEAM_FIELD], { id: "t2" }, "the value chosen in the pane, not the map's default");
      assert.equal(epic.fields[TEAM_FIELD], undefined, "limited to Story by the map");
      assert.deepEqual(story.fields.assignee, { accountId: DAN.accountId }, "by account id, never by name");

      assert.ok(jira.requests.length > 0);
      assert.ok(
        jira.requests.every((r) => r.authorized),
        "every request carried the stored pair, and none was refused",
      );
    });

    test("the vault records both as pushed, so the pane stamps what it created", async () => {
      await eventually(
        "both items stamped on disk",
        async () => {
          const vault = await Vault.open(harness.vaultRoot);
          return [epicKey, storyKey].map((k) => {
            const s = vault.getItem(k).sync;
            return `${s.state}:${s.jiraKey}:${s.jiraId}`;
          });
        },
        (stamps) => stamps.every((s) => s.startsWith("pushed:ENG-") && !s.endsWith(":undefined")),
      );
      await pane().getByRole("button", { name: "Done" }).click();
      await pane().waitFor({ state: "hidden" });
    });

    test("pushing the same items again sends nothing", async () => {
      const before = posts().length;
      await harness.page.locator(".bulk-bar").getByRole("button", { name: "Push to Jira…" }).click();
      await pane().getByText("0 issues to create").waitFor();
      assert.equal(await pane().getByRole("button", { name: /^Create 0 issues/ }).isDisabled(), true);
      await pane().getByText("2 not sent").click();
      await pane().getByText(/Already pushed as ENG-1/).waitFor();
      assert.equal(posts().length, before);
      await pane().getByRole("button", { name: "Cancel" }).click();
    });
  },
);
