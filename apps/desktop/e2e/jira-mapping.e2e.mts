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

import { jiraMapPath, loadJiraMap } from "todo-vault";

import { canStartFakeJira, startFakeJira, type FakeJira } from "./fake-jira.mjs";
import { START_DATE_FIELD, serveProject } from "./fake-jira-project.mjs";
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
  },
);
