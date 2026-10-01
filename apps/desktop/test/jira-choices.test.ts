import assert from "node:assert/strict";
import test from "node:test";

import {
  accountIdOf,
  cascadingIndexes,
  cascadingValue,
  choicesFor,
  chosenPeople,
  storedPeople,
  listText,
  localDatetime,
  parseList,
  peopleChoices,
} from "../src/shared/jira-choices.js";

const REGIONS = [
  {
    id: "100",
    value: "Europe",
    children: [
      { id: "101", value: "Berlin" },
      { id: "102", value: "Lisbon" },
    ],
  },
  { id: "200", value: "Americas", children: [{ id: "201", value: "Denver" }] },
  { id: "300", value: "Nowhere" },
];

test("choices are { id } labelled by name or value, and a cascading field keeps its children", () => {
  const choices = choicesFor(REGIONS);
  assert.deepEqual(choices[0], {
    value: { id: "100" },
    label: "Europe",
    children: [
      { value: { id: "101" }, label: "Berlin" },
      { value: { id: "102" }, label: "Lisbon" },
    ],
  });
  assert.equal("children" in choices[2], false);
  assert.deepEqual(choicesFor([{ id: 7, name: "numeric id" }, null, { name: "no id" }]), []);
});

test("a cascading value is found by id, and a hand-typed 'Parent / Child' by label", () => {
  const choices = choicesFor(REGIONS);
  assert.deepEqual(cascadingIndexes(choices, { id: "100", child: { id: "102" } }), { parent: 0, child: 1 });
  assert.deepEqual(cascadingIndexes(choices, { id: "200" }), { parent: 1, child: -1 });
  assert.deepEqual(cascadingIndexes(choices, "europe / berlin"), { parent: 0, child: 0 });
  assert.deepEqual(cascadingIndexes(choices, "Americas > Denver"), { parent: 1, child: 0 });
  assert.deepEqual(cascadingIndexes(choices, undefined), { parent: -1, child: -1 });
  assert.deepEqual(cascadingIndexes(choices, { id: "999" }), { parent: -1, child: -1 });
});

test("two cascading selects store { id, child: { id } }, a parent alone, or nothing", () => {
  const choices = choicesFor(REGIONS);
  assert.deepEqual(cascadingValue(choices, 0, 1), { id: "100", child: { id: "102" } });
  assert.deepEqual(cascadingValue(choices, 2, -1), { id: "300" });
  assert.equal(cascadingValue(choices, -1, -1), null);
});

test("linked people are offered once per account, by their Jira name, sorted", () => {
  const choices = peopleChoices({
    dan: { accountId: "acc-dan", displayName: "Dan Okafor" },
    "Dan O": { accountId: "acc-dan", displayName: "Dan Okafor" },
    ana: { accountId: "acc-ana" },
  });
  assert.deepEqual(choices, [
    { value: { accountId: "acc-ana" }, label: "ana" },
    { value: { accountId: "acc-dan" }, label: "Dan Okafor" },
  ]);
  assert.equal(accountIdOf({ accountId: "acc-dan" }), "acc-dan");
  assert.equal(accountIdOf("Dan Okafor"), undefined, "a typed string is not an account");
  assert.equal(accountIdOf(null), undefined);
});

test("a comma input shows a list and stores its trimmed parts", () => {
  assert.equal(listText(["a", "b c"]), "a, b c");
  assert.equal(listText("typed, as is"), "typed, as is");
  assert.equal(listText(undefined), "");
  assert.deepEqual(parseList(" a, ,b c ,"), ["a", "b c"]);
});

test("a full ISO date-time from an older map shows in a datetime-local input as local time", () => {
  assert.equal(localDatetime("2026-10-01T09:30"), "2026-10-01T09:30");
  const iso = new Date(2026, 9, 1, 9, 30).toISOString();
  assert.equal(localDatetime(iso), "2026-10-01T09:30");
  // Jira's own form: an offset without a colon, which Date does not read on its own.
  const offset = -new Date(2026, 9, 1, 9, 30).getTimezoneOffset();
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, "0");
  const zone = `${offset >= 0 ? "+" : "-"}${pad(Math.trunc(offset / 60))}${pad(offset % 60)}`;
  assert.equal(localDatetime(`2026-10-01T09:30:00.000${zone}`), "2026-10-01T09:30");
  assert.equal(localDatetime("not a date"), "");
  assert.equal(localDatetime(42), "");
});

test("Jira's field errors are named as Jira shows the field, in the message too", async () => {
  const { namedFieldErrors } = await import("../src/main/jira-names.js");
  const meta = {
    site: "https://acme.atlassian.net",
    projectKey: "ENG",
    projectId: "1",
    projectName: "Engineering",
    issueTypes: [
      {
        id: "10002",
        name: "Story",
        subtask: false,
        fields: [
          {
            fieldId: "customfield_10001",
            name: "Team",
            required: true,
            hasDefaultValue: false,
            schema: { type: "option" },
            operations: [],
          },
        ],
      },
    ],
    fetchedAt: "2026-09-30T00:00:00.000Z",
  };
  const failure = {
    localKey: "ACME-2",
    message: "Jira refused it. customfield_10001: Team is required. customfield_99: Unknown.",
    fieldErrors: { customfield_10001: "Team is required.", customfield_99: "Unknown." },
    uncertain: false,
  };
  const named = namedFieldErrors(failure, meta, "story");
  assert.deepEqual(named.fieldErrors, { Team: "Team is required.", customfield_99: "Unknown." });
  assert.equal(named.message, "Jira refused it. Team: Team is required. customfield_99: Unknown.");
  assert.equal(named.localKey, "ACME-2");
  assert.equal(namedFieldErrors(failure, meta, undefined), failure, "no issue type, nothing to name it by");
});

test("a hand-written name resolves through People, and an unknown one stays text rather than a fake account", () => {
  const people = { "Dan Okafor": { accountId: "acc-dan", displayName: "Dan Okafor" } };
  const real = "5b10a2844c20165700ede21f";
  assert.deepEqual(chosenPeople(["dan okafor"], people), [{ accountId: "acc-dan" }]);
  assert.deepEqual(chosenPeople("Dan Okafor, Renee", people), [{ accountId: "acc-dan" }, { typed: "Renee" }]);
  assert.deepEqual(chosenPeople([{ accountId: "acc-x" }, real, "557058:00000000-0000-0000-0000-000000000000"], people), [
    { accountId: "acc-x" },
    { accountId: real },
    { accountId: "557058:00000000-0000-0000-0000-000000000000" },
  ]);
  assert.deepEqual(chosenPeople(null, people), []);

  // Adding a second person keeps the unresolved name as text, so the push can
  // still look it up or block on it, instead of sending { accountId: "Renee" }.
  const next = [...chosenPeople("Renee", people), { accountId: "acc-priya" }];
  assert.deepEqual(storedPeople(next), ["Renee", { accountId: "acc-priya" }]);
});
