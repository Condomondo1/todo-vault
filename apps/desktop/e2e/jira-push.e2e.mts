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
import {
  DAN,
  ISSUE_TYPES,
  PROPOSAL_FIELD,
  RANK_FIELD,
  REGION_FIELD,
  TEAM_FIELD,
  serveProject,
  type ServedProject,
} from "./fake-jira-project.mjs";
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
      await pane().waitFor({ state: "hidden" });
    });

    test("values typed as a person means them arrive in Jira's shape, and Rank is never sent", async () => {
      // What someone would write by hand in jira-map.yaml: a name, a
      // paragraph, a path. No ids and no JSON.
      await writeJiraMap(jiraMapPath(harness.vaultRoot), [
        { path: ["extraFields", TEAM_FIELD], value: { name: "Team", mode: "always", value: "payments", issueTypes: ["Story"] } },
        { path: ["extraFields", PROPOSAL_FIELD], value: { mode: "always", value: "Ship it **today**", issueTypes: ["Story"] } },
        { path: ["extraFields", REGION_FIELD], value: { mode: "always", value: "Europe / Berlin", issueTypes: ["Story"] } },
        { path: ["extraFields", RANK_FIELD], value: { name: "Rank", mode: "always", value: "0|hzzzzz:", issueTypes: ["Story"] } },
      ]);
      const vault = await Vault.open(harness.vaultRoot);
      const story = await vault.createItem({ project: "ACME", type: "story", summary: "Email the invoice" });
      await itemRow(harness.page, story.key).waitFor({ state: "visible" });
      await itemRow(harness.page, story.key).locator('input[type="checkbox"]').check();

      await harness.page.locator(".bulk-bar").getByRole("button", { name: "Push to Jira…" }).click();
      await pane().getByText(/Rank is set by Jira itself/).waitFor();
      const create = pane().getByRole("button", { name: "Create 1 issue in ENG" });
      await eventually("the plan has no blockers", () => create.isEnabled(), (on) => on);
      await create.click();
      await pane().getByText("Created 1").waitFor();

      const sent = project.created.at(-1)?.fields ?? {};
      assert.deepEqual(sent[TEAM_FIELD], { id: "t2" }, "an option typed as its name goes as its id");
      const doc = sent[PROPOSAL_FIELD] as { type: string; version: number; content: unknown[] };
      assert.equal(doc.type, "doc", "a paragraph typed as text goes as ADF");
      assert.equal(doc.version, 1);
      assert.deepEqual(doc.content, [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ship it " },
            { type: "text", text: "today", marks: [{ type: "strong" }] },
          ],
        },
      ]);
      assert.deepEqual(sent[REGION_FIELD], { id: "r1", child: { id: "r11" } });
      assert.equal(RANK_FIELD in sent, false);
      await pane().getByRole("button", { name: "Done" }).click();
      await pane().waitFor({ state: "hidden" });
    });

    test("an item changed since its push is updated field by field, sending only what was ticked", async () => {
      const vault = await Vault.open(harness.vaultRoot);
      const item = await vault.createItem({ project: "ACME", type: "story", summary: "Send the reminder", dueDate: "2026-11-02" });
      await itemRow(harness.page, item.key).waitFor({ state: "visible" });
      await itemRow(harness.page, item.key).locator('input[type="checkbox"]').check();

      await harness.page.locator(".bulk-bar").getByRole("button", { name: "Push to Jira…" }).click();
      const create = pane().getByRole("button", { name: "Create 1 issue in ENG" });
      await eventually("the plan has no blockers", () => create.isEnabled(), (on) => on);
      await create.click();
      await pane().getByText("Created 1").waitFor();
      await pane().getByRole("button", { name: "Done" }).click();
      await pane().waitFor({ state: "hidden" });
      const jiraKey = project.created.at(-1)!.key;

      // Changed in the vault after the push, behind the app's back.
      await (await Vault.open(harness.vaultRoot)).updateItem(item.key, { summary: "Send the second reminder", dueDate: null });
      await eventually(
        "the change is on screen",
        () => itemRow(harness.page, item.key).innerText(),
        (text) => text.includes("Send the second reminder"),
      );

      const putsBefore = project.updated.length;
      await harness.page.locator(".bulk-bar").getByRole("button", { name: "Push to Jira…" }).click();
      const changed = pane().getByRole("region", { name: "Changed since pushed" }).locator(`[data-local-key="${item.key}"]`);
      await changed.waitFor();
      const row = (id: string) => changed.locator(`tr[data-field-id="${id}"]`);
      assert.match(await row("summary").innerText(), /Send the reminder\s*→\s*Send the second reminder/);
      assert.match(await row("duedate").innerText(), /2026-11-02\s*→\s*empty/);
      assert.equal(await row("summary").getByRole("checkbox").isChecked(), true, "ticked by default");
      // Not listed again under "not sent", now that it is an update.
      assert.equal(await pane().getByText(/so it is updated there rather than created again/).count(), 0);

      // Keep Jira's due date; send only the summary.
      await row("duedate").getByRole("checkbox").uncheck();
      const otherRows = await changed.locator("tr[data-field-id]").evaluateAll((rows) =>
        rows.map((r) => r.getAttribute("data-field-id")),
      );
      for (const id of otherRows) if (id !== "summary" && id !== "duedate") await row(id!).getByRole("checkbox").uncheck();

      const update = pane().getByRole("button", { name: "Update 1 issue in ENG" });
      await eventually("the button enables", () => update.isEnabled(), (on) => on);
      await update.click();
      await pane().getByText("Updated 1").waitFor();

      assert.equal(project.updated.length, putsBefore + 1, "one PUT");
      const put = project.updated.at(-1)!;
      assert.equal(put.key, jiraKey);
      assert.deepEqual(put.fields, { summary: "Send the second reminder" }, "only the ticked field, never the unticked due date");
      const issue = project.created.find((c) => c.key === jiraKey)!;
      assert.equal(issue.fields.duedate, "2026-11-02", "Jira keeps its due date");
      await eventually(
        "the item restamped on disk",
        async () => (await Vault.open(harness.vaultRoot)).getItem(item.key).sync,
        (sync) => sync.state === "pushed" && sync.jiraKey === jiraKey,
      );
      await pane().getByRole("button", { name: "Done" }).click();
      await pane().waitFor({ state: "hidden" });

      // A third look: the unticked due date was a decision, so nothing is offered again.
      await harness.page.locator(".bulk-bar").getByRole("button", { name: "Push to Jira…" }).click();
      await pane().getByText("0 issues to create").waitFor();
      assert.equal(await pane().getByRole("region", { name: "Changed since pushed" }).count(), 0);
      assert.equal(await pane().getByRole("button", { name: /^Create 0 issues/ }).isDisabled(), true);
      await pane().getByRole("button", { name: "Cancel" }).click();
      await pane().waitFor({ state: "hidden" });
    });

    test("an item Jira already matches is only marked as in sync, and a deleted issue is said, not sent", async () => {
      const vault = await Vault.open(harness.vaultRoot);
      const same = await vault.createItem({ project: "ACME", type: "story", summary: "Chase the refund" });
      const gone = await vault.createItem({ project: "ACME", type: "story", summary: "Archive the receipts" });
      for (const key of [same.key, gone.key]) {
        await itemRow(harness.page, key).waitFor({ state: "visible" });
        await itemRow(harness.page, key).locator('input[type="checkbox"]').check();
      }
      await harness.page.locator(".bulk-bar").getByRole("button", { name: "Push to Jira…" }).click();
      const create = pane().getByRole("button", { name: "Create 2 issues in ENG" });
      await eventually("the plan has no blockers", () => create.isEnabled(), (on) => on);
      await create.click();
      await pane().getByText("Created 2").waitFor();
      await pane().getByRole("button", { name: "Done" }).click();
      await pane().waitFor({ state: "hidden" });
      const [sameIssue, goneIssue] = project.created.slice(-2);

      // The same edit made on both sides, and the other issue deleted in Jira.
      const after = await Vault.open(harness.vaultRoot);
      await after.updateItem(same.key, { summary: "Chase the refund today" });
      await after.updateItem(gone.key, { summary: "Archive every receipt" });
      sameIssue.fields.summary = "Chase the refund today";
      jira.route("GET", `/rest/api/3/issue/${goneIssue.key}`, () => ({
        status: 404,
        body: { errorMessages: ["Issue does not exist or you do not have permission to see it."], errors: {} },
      }));
      await eventually(
        "both changes on screen",
        () => harness.page.locator("table.table").innerText(),
        (text) => text.includes("Chase the refund today") && text.includes("Archive every receipt"),
      );

      const puts = project.updated.length;
      await harness.page.locator(".bulk-bar").getByRole("button", { name: "Push to Jira…" }).click();
      const section = pane().getByRole("region", { name: "Changed since pushed" });
      await section.getByText(`${goneIssue.key} no longer exists in Jira, so ${gone.key} is not updated.`).waitFor();
      const matching = section.locator(`[data-local-key="${same.key}"]`);
      await matching.getByText("Jira already matches. Nothing to send.").waitFor();
      assert.equal(await pane().getByRole("button", { name: /^Update/ }).count(), 0, "nothing to update by the button");

      await matching.getByRole("button", { name: "Mark as in sync" }).click();
      await matching.waitFor({ state: "detached" });
      assert.equal(project.updated.length, puts, "marking sends nothing to Jira");
      const stamped = (await Vault.open(harness.vaultRoot)).getItem(same.key).sync;
      assert.equal(stamped.state, "pushed");
      assert.equal(stamped.jiraKey, sameIssue.key);
      await pane().getByRole("button", { name: "Cancel" }).click();
      await pane().waitFor({ state: "hidden" });
    });
  },
);
