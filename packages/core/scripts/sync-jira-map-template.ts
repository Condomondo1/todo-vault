/**
 * Regenerates `src/jira-map-template.ts` from the repo's `jira-map.example.yaml`.
 *
 * The example is the documentation a person reads; the template is the same
 * text, embedded, because the app writes a first `jira-map.yaml` from it and a
 * packaged app has no repo to read the example from. `test/jira-map.test.ts`
 * fails when the two differ, and names this script as the fix:
 *
 *   npm run sync-jira-template -w todo-vault
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.resolve(here, "..", "..", "..", "jira-map.example.yaml");
const target = path.resolve(here, "..", "src", "jira-map-template.ts");

const text = (await fs.readFile(example, "utf8")).replace(/\r\n/g, "\n");
const lines = text.replace(/\n$/, "").split("\n");

const out = [
  "// Generated from jira-map.example.yaml by scripts/sync-jira-map-template.ts.",
  "// Do not edit by hand: edit the example and rerun `npm run sync-jira-template -w todo-vault`.",
  "// test/jira-map.test.ts fails when the two disagree.",
  "",
  "/** The text a first `jira-map.yaml` is written from, comments and all. */",
  "export const JIRA_MAP_TEMPLATE = [",
  ...lines.map((line) => `  ${JSON.stringify(line)},`),
  '].join("\\n") + "\\n";',
  "",
].join("\n");

await fs.writeFile(target, out, "utf8");
console.log(`Wrote ${path.relative(process.cwd(), target)} (${lines.length} lines)`);
