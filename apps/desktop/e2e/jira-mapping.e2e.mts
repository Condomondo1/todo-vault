/**
 * Settings → Jira → Mapping, in a real window against a fake Jira's ENG.
 *
 * `jira-mapping.test.ts` covers the edits and the gaps as pure functions. What
 * only the app can show is the whole path: the tab opening only once a
 * credential is stored, main reading ENG's create screens over TLS with that
 * credential, the panel offering what ENG actually has, and a Save that lands
 * in the vault as a commented file with the verified site in it, committed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

import { Vault, jiraMapPath, loadJiraMap, writeJiraMap } from "todo-vault";

import { canStartFakeJira, startFakeJira, type FakeJira } from "./fake-jira.mjs";
import {
  DAN,
  PROPOSAL_FIELD,
  PRIYA,
  RANK_FIELD,
  REGION_FIELD,
  REVIEWER_FIELD,
  START_DATE_FIELD,
  TEAM_FIELD,
  serveProject,
} from "./fake-jira-project.mjs";
import { launchHarness, type Harness } from "./harness.mjs";

const EMAIL = "me@acme.com";
const TOKEN = "ATATT3xFfGF0-e2e-mapping-token-not-real-4Hn";
const execFileAsync = promisify(execFile);

describe(
  "the Jira mapping is chosen from the project and saved into the vault",
  { concurrency: 1, skip: (await canStartFakeJira()) ? false : "openssl is not on PATH, so no fake Jira" },
  () => {
    let jira: FakeJira;
    let harness: Harness;

    const settings = () => harness.page.locator(".modal", { has: harness.page.locator("h2", { hasText: /^Jira$/ }) });
    const tab = (name: string) => settings().getByRole("tab", { name });
    const mapping = () => settings().getByRole("tabpanel", { name: "Mapping" });
    // A select inside its label takes the chosen option into its accessible
    // name ("Epic Epic"), so an exact getByLabel never matches. By caption.
    const select = (caption: string) =>
      mapping()
        .locator("label")
        .filter({ has: harness.page.locator("span", { hasText: new RegExp(`^${caption}$`) }) })
        .locator("select");
    const git = async (...args: string[]) =>
      (await execFileAsync("git", args, { cwd: harness.vaultRoot })).stdout.trim();

    before(async () => {
      jira = await startFakeJira({ email: EMAIL, token: TOKEN });
      serveProject(jira);
      harness = await launchHarness({ env: { NODE_EXTRA_CA_CERTS: jira.caCertPath } });
      await harness.page.locator("table.table tbody tr").first().waitFor({ state: "visible" });

      // Someone assigned, for the People section to offer. Written behind the
      // app's back, as a synced edit would be, and waited for on screen.
      const vault = await Vault.open(harness.vaultRoot);
      await vault.createItem({ project: "ACME", type: "task", summary: "Reconcile the ledger", assignee: "Dan Okafor" });
      await harness.page.getByText("Reconcile the ledger").first().waitFor();
    });

    after(async () => {
      await harness?.close();
      await jira?.close();
    });

    test("Mapping is closed until a credential is stored", async () => {
      await harness.page.getByRole("button", { name: "Jira", exact: true }).click();
      await settings().getByText("Not connected").waitFor();
      assert.equal(await tab("Mapping").isDisabled(), true);

      await settings().getByLabel("Jira site").fill(jira.site);
      await settings().getByLabel("Atlassian account email").fill(EMAIL);
      await settings().getByLabel("API token", { exact: true }).fill(TOKEN);
      await settings().getByRole("button", { name: "Connect" }).click();
      await settings().getByText(/^verified /).waitFor();
      assert.equal(await tab("Mapping").isDisabled(), false);
    });

    test("the project's own issue types are offered, and the usual names are guessed", async () => {
      await tab("Mapping").click();
      await mapping().getByText("No jira-map.yaml in this vault yet", { exact: false }).waitFor();
      // Neither the connection's buttons nor its form belong to this tab.
      assert.equal(await settings().getByRole("button", { name: "Test connection" }).count(), 0);

      await mapping().getByLabel("Jira project key").fill("eng");
      await mapping().getByRole("button", { name: "Load project" }).click();
      await mapping().getByText("Engineering", { exact: true }).waitFor();
      assert.equal(await mapping().getByLabel("Jira project key").inputValue(), "ENG");

      assert.equal(await select("Epic").inputValue(), "Epic");
      assert.equal(await select("Story").inputValue(), "Story");
      assert.equal(await select("Subtask").inputValue(), "Subtask");
      // ENG has no Bug, so nothing is guessed and nothing can be saved yet.
      assert.equal(await select("Bug").inputValue(), "");
      assert.equal(await mapping().getByRole("button", { name: "Save mapping" }).isDisabled(), true);
      // Only the subtask type is offered for subtasks, and never for the rest.
      assert.deepEqual(await select("Subtask").locator("option").allInnerTexts(), ["Choose…", "Subtask"]);
      assert.deepEqual(await select("Bug").locator("option").allInnerTexts(), ["Choose…", "Epic", "Story", "Task"]);
    });

    test("a loaded project survives a look at the Connection tab", async () => {
      await tab("Connection").click();
      await settings().getByRole("button", { name: "Test connection" }).waitFor();
      await tab("Mapping").click();
      await mapping().getByText("Engineering", { exact: true }).waitFor();
    });

    test("Save writes the verified site into a commented map, and commits it", async () => {
      await select("Bug").selectOption("Task");
      await select("Start date").selectOption(START_DATE_FIELD);
      await mapping().getByRole("button", { name: "Save mapping" }).click();
      await mapping().getByText("Saved to jira-map.yaml.").waitFor();

      const file = jiraMapPath(harness.vaultRoot);
      const text = await fs.readFile(file, "utf8");
      assert.match(text, /^# Jira field mapping\./, "started from the commented example");
      const map = await loadJiraMap(file);
      assert.equal(map.baseUrl, jira.site, "the site is the credential's, not the example's");
      assert.equal(map.jiraProjectKey, "ENG");
      assert.equal(map.auth, "site");
      assert.deepEqual(map.issueTypes, { epic: "Epic", story: "Story", task: "Task", bug: "Task", subtask: "Subtask" });
      assert.equal(map.fields.startDate, START_DATE_FIELD);
      assert.equal(text.includes(TOKEN), false, "the token is never in the vault");

      assert.equal(await git("log", "-1", "--format=%s"), "Update Jira mapping");
      assert.equal(await git("status", "--porcelain"), "", "nothing left uncommitted");
    });

    test("the Team that Story requires, and nothing fills, is named", async () => {
      await mapping().getByText("Story requires Team, which nothing fills in.").waitFor();
      // Task has Team too, but optional, and Subtask's required parent is sent.
      assert.equal(await mapping().locator(".jira-blockers li").count(), 1);
    });

    test("Replace closes Mapping until the pair is settled", async () => {
      await tab("Connection").click();
      await settings().getByRole("button", { name: "Replace" }).click();
      assert.equal(await tab("Mapping").isDisabled(), true);
      await settings().getByRole("button", { name: "Cancel" }).click();
      assert.equal(await tab("Mapping").isDisabled(), false);
    });

    test("reopened, the panel reads the saved map back, gaps and all", async () => {
      await settings().getByRole("button", { name: "Close" }).last().click();
      await settings().waitFor({ state: "hidden" });
      await harness.page.getByRole("button", { name: "Jira", exact: true }).click();
      await tab("Mapping").click();
      await mapping().getByLabel("Jira project key").waitFor();
      assert.equal(await mapping().getByLabel("Jira project key").inputValue(), "ENG");

      await mapping().getByRole("button", { name: "Load project" }).click();
      assert.equal(await select("Bug").inputValue(), "Task", "the saved choice is kept");
      await mapping().getByText("Story requires Team, which nothing fills in.").waitFor();
    });

    const team = () => mapping().locator(`.jira-extra[data-field-id="${TEAM_FIELD}"]`);
    const dan = () => mapping().locator('.jira-person[data-person="Dan Okafor"]');

    test("Fill it in adds Team as an extra field, only on the types that have it", async () => {
      await mapping().locator(".jira-blockers li", { hasText: "Story requires Team" }).getByRole("button", { name: "Fill it in" }).click();
      await team().waitFor();
      // ENG's Subtask has no Team, so sending it there would be a 400.
      await team().getByText("On Epic, Story, Task").waitFor();
      assert.equal(await team().getByLabel("When to send Team").inputValue(), "always");
      assert.deepEqual(await team().locator("select").first().locator("option").allInnerTexts(), [
        "— none —",
        "Platform",
        "Payments",
      ]);
      await team().locator("select").first().selectOption({ label: "Payments" });
      await mapping().getByText("Added above; save to check it.").waitFor();
    });

    test("an assignee with exactly one match in Jira is linked on its own", async () => {
      await dan().getByText("Not linked").waitFor();
      await dan().getByRole("button", { name: "Find in Jira" }).click();
      await dan().getByText(`→ ${DAN.displayName}`).waitFor();
      assert.ok(
        jira.requests.some((r) => r.method === "GET" && r.path.startsWith("/rest/api/3/user/assignable/search") && r.authorized),
        "found through the assignable search, with the stored credential",
      );
    });

    test("Save writes both, and the gap they closed is gone", async () => {
      await mapping().getByRole("button", { name: "Save mapping" }).click();
      await mapping().getByText("Saved to jira-map.yaml.").waitFor();
      await mapping().locator(".jira-gaps").waitFor({ state: "detached" });

      const map = await loadJiraMap(jiraMapPath(harness.vaultRoot));
      assert.deepEqual(map.extraFields[TEAM_FIELD], {
        name: "Team",
        mode: "always",
        value: { id: "t2" },
        issueTypes: ["Epic", "Story", "Task"],
      });
      assert.deepEqual(map.people["Dan Okafor"], { accountId: DAN.accountId, displayName: DAN.displayName });
      assert.equal(await git("log", "-1", "--format=%s"), "Update Jira mapping");
      assert.equal(await git("status", "--porcelain"), "");
    });

    test("removing the field on the next Save removes it from the file, and the gap returns", async () => {
      await team().getByRole("button", { name: "Remove" }).click();
      await team().waitFor({ state: "detached" });
      await mapping().getByRole("button", { name: "Save mapping" }).click();
      await mapping().getByText("Story requires Team, which nothing fills in.").waitFor();

      const map = await loadJiraMap(jiraMapPath(harness.vaultRoot));
      assert.equal(TEAM_FIELD in map.extraFields, false);
      assert.equal(map.people["Dan Okafor"]?.accountId, DAN.accountId, "the person is untouched");
    });

    const extra = (id: string) => mapping().locator(`.jira-extra[data-field-id="${id}"]`);

    test("Rank is never offered as an extra field: Jira sets it itself", async () => {
      const offered = await select("Add a field").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      assert.ok(offered.includes(PROPOSAL_FIELD), "the paragraph is offered");
      assert.equal(offered.includes(RANK_FIELD), false);
    });

    test("a paragraph is typed as text and a cascading select is two selects, with no JSON box", async () => {
      await select("Add a field").selectOption(PROPOSAL_FIELD);
      await extra(PROPOSAL_FIELD).locator("textarea").fill("Ship it **today**");
      await extra(PROPOSAL_FIELD).getByText("Formatted like a description", { exact: false }).waitFor();

      await select("Add a field").selectOption(REGION_FIELD);
      await extra(REGION_FIELD).getByLabel("Region, first level").selectOption({ label: "Europe" });
      await extra(REGION_FIELD).getByLabel("Region, second level").selectOption({ label: "Lisbon" });

      assert.equal(await mapping().getByText("Sent exactly as written", { exact: false }).count(), 0);

      await mapping().getByRole("button", { name: "Save mapping" }).click();
      await mapping().getByText("Saved to jira-map.yaml.").waitFor();
      const map = await loadJiraMap(jiraMapPath(harness.vaultRoot));
      assert.equal(map.extraFields[PROPOSAL_FIELD]?.value, "Ship it **today**", "stored as the markdown typed");
      assert.deepEqual(map.extraFields[REGION_FIELD]?.value, { id: "r1", child: { id: "r12" } });
    });

    test("a person field offers the linked people, and finds anyone else on the site", async () => {
      await select("Add a field").selectOption(REVIEWER_FIELD);
      const reviewer = extra(REVIEWER_FIELD);
      assert.deepEqual(await reviewer.getByLabel("Reviewer: a linked person").locator("option").allInnerTexts(), [
        "Linked people…",
        DAN.displayName,
      ]);
      await reviewer.getByLabel("Reviewer: search Jira").fill("priya");
      await reviewer.getByRole("button", { name: "Find" }).click();
      const results = reviewer.getByLabel("Reviewer: search results");
      await results.waitFor();
      assert.deepEqual(await results.locator("option").allInnerTexts(), [
        "2 matches — choose…",
        DAN.displayName,
        PRIYA.displayName,
      ], "active humans only: the app account is not offered");
      await results.selectOption(PRIYA.accountId);
      await reviewer.locator(".pill", { hasText: PRIYA.displayName }).waitFor();
      assert.ok(jira.requests.some((r) => r.path.startsWith("/rest/api/3/user/search") && r.authorized));

      await mapping().getByRole("button", { name: "Save mapping" }).click();
      await mapping().getByText("Saved to jira-map.yaml.").waitFor();
      const map = await loadJiraMap(jiraMapPath(harness.vaultRoot));
      assert.deepEqual(map.extraFields[REVIEWER_FIELD]?.value, { accountId: PRIYA.accountId });
    });

    test("a Rank already in the map says it is not sent, and can be removed", async () => {
      await writeJiraMap(jiraMapPath(harness.vaultRoot), [
        { path: ["extraFields", RANK_FIELD], value: { name: "Rank", mode: "always", value: "0|hzzzzz:" } },
      ]);
      await settings().getByRole("button", { name: "Close" }).last().click();
      await settings().waitFor({ state: "hidden" });
      await harness.page.getByRole("button", { name: "Jira", exact: true }).click();
      await tab("Mapping").click();
      await mapping().getByRole("button", { name: "Load project" }).click();

      await extra(RANK_FIELD).getByText("Jira sets this itself; it is not sent.").waitFor();
      assert.equal(await extra(RANK_FIELD).locator("select, input, textarea").count(), 0);
      // The paragraph saved above reads back as the text it was typed as.
      assert.equal(await extra(PROPOSAL_FIELD).locator("textarea").inputValue(), "Ship it **today**");
      await extra(RANK_FIELD).getByRole("button", { name: "Remove" }).click();
      await extra(RANK_FIELD).waitFor({ state: "detached" });
    });
  },
);
