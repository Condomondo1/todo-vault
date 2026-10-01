import assert from "node:assert/strict";
import test from "node:test";

import { adfToMarkdown, isAdfDoc, markdownToAdf } from "../src/jira-adf.js";
import { shapeFieldValue, valueKindFor, type JiraFieldMeta, type JiraFieldSchema } from "../src/jira-meta.js";

const CT = "com.atlassian.jira.plugin.system.customfieldtypes:";

function field(schema: JiraFieldSchema, over: Partial<JiraFieldMeta> = {}): JiraFieldMeta {
  return { fieldId: "customfield_1", name: "Field", required: false, hasDefaultValue: false, schema, operations: ["set"], ...over };
}

function shaped(f: JiraFieldMeta, value: unknown, people?: Record<string, { accountId: string }>): unknown {
  const r = shapeFieldValue(f, value, { people });
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.value;
}

function refused(f: JiraFieldMeta, value: unknown): string {
  const r = shapeFieldValue(f, value);
  assert.equal(r.ok, false, `expected ${JSON.stringify(value)} to be refused`);
  return r.ok ? "" : r.message;
}

const teams = field(
  { type: "option", custom: `${CT}select` },
  { name: "Team", allowedValues: [{ id: "t1", value: "Payments" }, { id: "t2", value: "Platform" }] },
);

// ------------------------------------------------------------- kinds

test("the fields that used to need JSON each have a kind of their own", () => {
  assert.equal(valueKindFor({ type: "string", custom: `${CT}textarea` }), "richText");
  assert.equal(valueKindFor({ type: "any", custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" }), "managed");
  assert.equal(valueKindFor({ type: "array", items: "json", custom: "com.pyxis.greenhopper.jira:gh-sprint" }), "sprint");
  assert.equal(valueKindFor({ type: "team", custom: `${CT}atlassian-team` }), "team");
  assert.equal(valueKindFor({ type: "array", items: "string", custom: `${CT}labels` }), "labels");
  assert.equal(valueKindFor({ type: "array", items: "string", custom: "app:tags" }), "strings");
  assert.equal(valueKindFor({ type: "array", items: "group", custom: `${CT}multigrouppicker` }), "groups");
  assert.equal(valueKindFor({ type: "project", custom: `${CT}project` }), "project");
});

// ----------------------------------------------------------- shaping

test("a paragraph field takes plain text and sends ADF; an ADF value is left alone", () => {
  const paragraph = field({ type: "string", custom: `${CT}textarea` }, { name: "Project objective" });
  const out = shaped(paragraph, "Cut checkout time.\n\n- **fast**\n- cheap");
  assert.deepEqual(out, markdownToAdf("Cut checkout time.\n\n- **fast**\n- cheap"));
  assert.ok(isAdfDoc(out));
  assert.equal(shaped(paragraph, out), out, "idempotent on what it produces");
});

test("an option is chosen by its name, case and spaces aside, and sent by id", () => {
  assert.deepEqual(shaped(teams, " payments "), { id: "t1" });
  assert.deepEqual(shaped(teams, { id: "t2" }), { id: "t2" }, "a stored id passes");
  assert.deepEqual(shaped(teams, { value: "Platform" }), { id: "t2" }, "a hand-written { value } becomes an id");
});

test("an option Jira does not offer is refused, naming what it does offer", () => {
  assert.match(refused(teams, "Paymnts"), /Team has no option "Paymnts"\. Jira offers: Payments, Platform\./);
  assert.match(refused(teams, { id: "gone" }), /no longer one of Jira's options/);
});

test("without a list of values, an option goes by value and a version by name", () => {
  assert.deepEqual(shaped(field({ type: "option" }), "Gold"), { value: "Gold" });
  assert.deepEqual(shaped(field({ type: "array", items: "version", system: "fixVersions" }), "1.0, 1.1"), [{ name: "1.0" }, { name: "1.1" }]);
});

test("a multi-select takes a comma list or an array", () => {
  const multi = field({ type: "array", items: "option" }, { allowedValues: [{ id: "1", value: "Web" }, { id: "2", value: "iOS" }] });
  assert.deepEqual(shaped(multi, "web, IOS"), [{ id: "1" }, { id: "2" }]);
  assert.deepEqual(shaped(multi, ["iOS"]), [{ id: "2" }]);
  assert.match(refused(multi, "Web, Android"), /no option "Android"/);
});

test("a cascading select takes Parent / Child", () => {
  const region = field(
    { type: "option-with-child", custom: `${CT}cascadingselect` },
    { name: "Region", allowedValues: [{ id: "10", value: "EMEA", children: [{ id: "11", value: "UK" }, { id: "12", value: "DE" }] }] },
  );
  assert.deepEqual(shaped(region, "emea / uk"), { id: "10", child: { id: "11" } });
  assert.deepEqual(shaped(region, "EMEA > DE"), { id: "10", child: { id: "12" } });
  assert.deepEqual(shaped(region, "EMEA"), { id: "10" });
  assert.match(refused(region, "EMEA / FR"), /no "FR" under "EMEA"\. Jira offers: UK, DE/);
});

test("a person is found by the vault's spelling in people, or taken as an account id", () => {
  const reviewer = field({ type: "user", custom: `${CT}userpicker` }, { name: "Reviewer" });
  const people = { "Dan Okafor": { accountId: "acc-1" } };
  assert.deepEqual(shaped(reviewer, "dan okafor", people), { accountId: "acc-1" });
  assert.deepEqual(shaped(reviewer, "5b10ac8d82e05b22cc7d4ef5"), { accountId: "5b10ac8d82e05b22cc7d4ef5" });
  assert.deepEqual(shaped(reviewer, { accountId: "x" }), { accountId: "x" });
  assert.match(refused(reviewer, "Renee"), /Reviewer: "Renee" has no Jira account\. Link them in Settings → Jira → People\./);

  const approvers = field({ type: "array", items: "user" }, { name: "Approvers" });
  assert.deepEqual(shaped(approvers, "Dan Okafor, 5b10ac8d82e05b22cc7d4ef5", people), [
    { accountId: "acc-1" },
    { accountId: "5b10ac8d82e05b22cc7d4ef5" },
  ]);
});

test("numbers, dates, sprints and lists are read from text", () => {
  assert.equal(shaped(field({ type: "number" }), " 3.5 "), 3.5);
  assert.match(refused(field({ type: "number" }, { name: "Points" }), "three"), /Points takes a number/);
  assert.equal(shaped(field({ type: "date" }), "2026-10-01"), "2026-10-01");
  assert.equal(shaped(field({ type: "date" }), "2026-10-01T09:00"), "2026-10-01");
  assert.match(refused(field({ type: "date" }), "1 Oct"), /YYYY-MM-DD/);
  assert.equal(shaped(field({ type: "array", items: "json", custom: "com.pyxis.greenhopper.jira:gh-sprint" }), "42"), 42);
  assert.deepEqual(shaped(field({ type: "array", items: "string", system: "labels" }), "front end, q4"), ["front-end", "q4"]);
  assert.deepEqual(shaped(field({ type: "array", items: "string" }), "front end, q4"), ["front end", "q4"]);
});

test("a datetime picked in a browser gains seconds and the local zone", () => {
  const out = shaped(field({ type: "datetime" }), "2026-10-01T09:30") as string;
  assert.match(out, /^2026-10-01T09:30:00\.000[+-]\d{4}$/);
});

test("Rank is Jira's own and sends nothing; blanks send nothing", () => {
  assert.equal(shaped(field({ type: "any", custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" }), "0|i0000:"), undefined);
  assert.equal(shaped(teams, "  "), undefined);
  assert.equal(shaped(teams, null), undefined);
  assert.equal(shaped(field({ type: "array", items: "option" }), []), undefined);
});

test("an app field with no schema: listed values act as a select, text stays text, JSON is still possible", () => {
  const app = field({ type: "any", custom: "app:thing" }, { name: "Thing", allowedValues: [{ id: "9", name: "Nine" }] });
  assert.deepEqual(shaped(app, "nine"), { id: "9" });
  const free = field({ type: "any", custom: "app:free" });
  assert.equal(shaped(free, "just words"), "just words");
  assert.deepEqual(shaped(free, '{"id": "x"}'), { id: "x" });
  assert.equal(shaped(free, "{not json"), "{not json");
});

// ------------------------------------------------------------- ADF back

test("ADF written from the vault's markdown reads back exactly", () => {
  const md = "# Goal\n\nCut **checkout** time, see [the doc](https://x.test).\n\n1. one\n2. two\n\n> quoted\n> twice\n\n```ts\nconst a = 1;\n```";
  assert.equal(adfToMarkdown(markdownToAdf(md)), md);
});

test("ADF from Jira with more than the grammar holds arrives as its words", () => {
  const doc = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Ask " }, { type: "mention", attrs: { id: "a", text: "@Dan" } }] },
      { type: "panel", content: [{ type: "paragraph", content: [{ type: "text", text: "Heads up" }] }] },
    ],
  };
  assert.equal(adfToMarkdown(doc), "Ask @Dan\n\nHeads up");
  assert.equal(adfToMarkdown("not adf"), "");
});
