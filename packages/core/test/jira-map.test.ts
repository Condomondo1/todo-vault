import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { JiraMapSchema, loadJiraMap, writeJiraMap } from "../src/jira.js";
import { JIRA_MAP_TEMPLATE } from "../src/jira-map-template.js";

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "jira-map.example.yaml");

async function tmpMapPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jira-map-test-"));
  return path.join(dir, "jira-map.yaml");
}

/** Every comment line, trimmed — what a reserialising writer would lose. */
function commentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("#"));
}

test("the embedded template is the example file, word for word", async () => {
  const example = (await fs.readFile(EXAMPLE, "utf8")).replace(/\r\n/g, "\n");
  assert.equal(
    JIRA_MAP_TEMPLATE,
    example,
    "jira-map.example.yaml and src/jira-map-template.ts differ. Run: npm run sync-jira-template -w todo-vault",
  );
});

test("the example is a valid map with no guessed custom field ids switched on", () => {
  const map = JiraMapSchema.parse(YAML.parse(JIRA_MAP_TEMPLATE));
  assert.equal(map.fields.startDate, undefined, "a guessed start date id would be used silently");
  assert.equal(map.fields.estimate, undefined);
  assert.equal(map.auth, "site");
  assert.deepEqual(map.people, {});
  assert.deepEqual(map.extraFields, {});
});

test("a map written before people and extraFields existed still loads", async () => {
  const file = await tmpMapPath();
  await fs.writeFile(
    file,
    "jiraProjectKey: ENG\nissueTypes: {}\nfields: { startDate: customfield_10015 }\ndefaults: { customfield_1: x }\n",
  );
  const map = await loadJiraMap(file);
  assert.equal(map.fields.startDate, "customfield_10015");
  assert.deepEqual(map.defaults, { customfield_1: "x" });
  assert.deepEqual(map.people, {});
});

test("a first write starts from the template, so every explanation survives", async () => {
  const file = await tmpMapPath();
  const map = await writeJiraMap(file, [
    { path: ["jiraProjectKey"], value: "OPS" },
    { path: ["baseUrl"], value: "https://acme.atlassian.net" },
    { path: ["people", "Dan Okafor"], value: { accountId: "5b10ac8d", displayName: "Dan Okafor" } },
  ]);
  const written = await fs.readFile(file, "utf8");

  assert.equal(map.jiraProjectKey, "OPS");
  assert.equal(map.people["Dan Okafor"].accountId, "5b10ac8d");
  const lost = commentLines(JIRA_MAP_TEMPLATE).filter((c) => !written.includes(c));
  assert.deepEqual(lost, [], "no comment line may be lost");
});

test("an edit to an existing map changes only what it names", async () => {
  const file = await tmpMapPath();
  const original = [
    "# My own note about this site.",
    "jiraProjectKey: ENG",
    "issueTypes:",
    "  story: User Story   # renamed here years ago",
    "fields:",
    "  # looked up by hand in 2025",
    "  startDate: customfield_10015",
    "",
  ].join("\n");
  await fs.writeFile(file, original);

  await writeJiraMap(file, [
    { path: ["fields", "estimate"], value: "customfield_10016" },
    { path: ["extraFields", "customfield_10001"], value: { name: "Team", mode: "always", value: "team-1" } },
  ]);
  const written = await fs.readFile(file, "utf8");

  for (const kept of ["# My own note about this site.", "# renamed here years ago", "# looked up by hand in 2025", "startDate: customfield_10015"]) {
    assert.ok(written.includes(kept), `lost: ${kept}`);
  }
  const map = await loadJiraMap(file);
  assert.equal(map.fields.estimate, "customfield_10016");
  assert.equal(map.extraFields.customfield_10001.value, "team-1");
});

test("an undefined value removes the key", async () => {
  const file = await tmpMapPath();
  await writeJiraMap(file, [{ path: ["people", "dan"], value: { accountId: "a1" } }]);
  const map = await writeJiraMap(file, [{ path: ["people", "dan"], value: undefined }]);
  assert.deepEqual(map.people, {});
});

test("an edit that would make the map invalid is refused and the file is left alone", async () => {
  const file = await tmpMapPath();
  await writeJiraMap(file, [{ path: ["jiraProjectKey"], value: "ENG" }]);
  const before = await fs.readFile(file, "utf8");

  await assert.rejects(writeJiraMap(file, [{ path: ["auth"], value: "scoped" }]), /cloudId/);
  await assert.rejects(writeJiraMap(file, [{ path: ["extraFields", "x"], value: { mode: "sometimes" } }]), /invalid/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("the credential has nowhere to go: an unknown key such as token is refused", async () => {
  const file = await tmpMapPath();
  await assert.rejects(writeJiraMap(file, [{ path: ["token"], value: "ATATT-secret" }]), /invalid/);
  await assert.rejects(
    writeJiraMap(file, [{ path: ["people", "dan"], value: { accountId: "a1", token: "ATATT-secret" } }]),
    /invalid/,
  );
  await assert.rejects(fs.access(file), "nothing was written");
});
