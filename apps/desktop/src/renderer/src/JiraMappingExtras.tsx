import { useMemo, useState } from "react";
import { distinctFields, issueTypeNamed, valueKindFor, type JiraFieldMeta, type ProjectMeta } from "todo-vault/jira-meta";
import type { JiraExtraField, JiraPerson, JiraPersonLink } from "@shared/api";
import { choicesFor } from "@shared/jira-choices";

import { JiraValueField } from "./JiraValueField";

/**
 * Fields the push fills from each item itself, so they are never offered as an
 * extra field. This is the item-dependent half of the core's
 * `fieldsTheMapCanFill`, which the renderer cannot import. `reporter` is here
 * too, although the push never sends it: people are free text, and reporter is
 * the field most likely to name someone with no account.
 */
const PUSH_FILLS: ReadonlySet<string> = new Set([
  "project",
  "issuetype",
  "summary",
  "description",
  "labels",
  "components",
  "assignee",
  "duedate",
  "parent",
  "priority",
  "reporter",
]);

/** The chosen issue types whose create screen has this field. */
function typesWith(meta: ProjectMeta, chosenTypes: string[], fieldId: string): string[] {
  return chosenTypes.filter((name) => issueTypeNamed(meta, name)?.fields.some((f) => f.fieldId === fieldId));
}

/**
 * A new extra field, sent always, limited to the chosen types that have it.
 * Unlimited only when every chosen type has it. Sending a field to a type
 * whose screen lacks it is a 400 from Jira, so the limit is what makes adding
 * a field safe by default.
 */
export function newExtraField(meta: ProjectMeta, chosenTypes: string[], fieldId: string): JiraExtraField {
  const field = distinctFields(meta).find((f) => f.fieldId === fieldId);
  const on = typesWith(meta, chosenTypes, fieldId);
  return {
    ...(field ? { name: field.name } : {}),
    mode: "always",
    ...(on.length < chosenTypes.length ? { issueTypes: on } : {}),
  };
}

/**
 * The Jira fields the vault has no equivalent for: Team, Fix versions, a
 * sprint. Each has a value typed as a person means it, drawn by the same
 * editor the push pane uses for `ask` fields and checked the way the push
 * will check it, and is either sent on every issue or asked for, prefilled, on
 * each push.
 *
 * Fields Jira keeps for itself, such as Rank, are never offered. One already
 * in the map says it is not sent, and can be removed.
 */
export function ExtraFields({
  meta,
  chosenTypes,
  mappedFieldIds,
  value,
  onChange,
  people,
}: {
  meta: ProjectMeta;
  chosenTypes: string[];
  /** The vault's own fields' targets: already filled, so not offered again. */
  mappedFieldIds: string[];
  value: Record<string, JiraExtraField>;
  onChange: (next: Record<string, JiraExtraField>) => void;
  /** The map's linked people, for a user field's picker and for checking a typed name. */
  people: Record<string, JiraPersonLink>;
}): React.JSX.Element {
  const known = useMemo(() => distinctFields(meta), [meta]);

  /** Fields on at least one chosen type, required first, not already covered. */
  const addable = useMemo(() => {
    const out: Array<{ field: JiraFieldMeta; on: string[] }> = [];
    for (const field of known) {
      if (PUSH_FILLS.has(field.fieldId) || mappedFieldIds.includes(field.fieldId) || field.fieldId in value) continue;
      if (valueKindFor(field.schema) === "managed") continue;
      const on = typesWith(meta, chosenTypes, field.fieldId);
      if (on.length) out.push({ field, on });
    }
    return out.sort(
      (a, b) => Number(b.field.required) - Number(a.field.required) || a.field.name.localeCompare(b.field.name),
    );
  }, [known, meta, chosenTypes, mappedFieldIds, value]);

  const set = (id: string, patch: Partial<JiraExtraField>): void =>
    onChange({ ...value, [id]: { ...value[id], ...patch } });

  return (
    <fieldset className="jira-extras">
      <legend>Extra fields</legend>
      {Object.keys(value).length === 0 && (
        <p className="field-note">None. Add one for a Jira field the vault has nothing for, such as a team.</p>
      )}

      {Object.entries(value).map(([id, spec]) => {
        const field = known.find((f) => f.fieldId === id);
        const kind = field ? valueKindFor(field.schema) : "raw";
        return (
          <div key={id} className="jira-extra" data-field-id={id}>
            <JiraValueField
              field={{
                fieldId: id,
                name: spec.name ?? field?.name ?? id,
                kind,
                choices: choicesFor(field?.allowedValues),
                value: spec.value,
              }}
              people={people}
              meta={field}
              onChange={(next) => set(id, { value: next === null ? undefined : next })}
            />
            <div className="jira-extra-meta">
              {kind !== "managed" && (
                <select
                  aria-label={`When to send ${spec.name ?? id}`}
                  value={spec.mode}
                  onChange={(e) => set(id, { mode: e.target.value as JiraExtraField["mode"] })}
                >
                  <option value="always">Send on every issue</option>
                  <option value="ask">Ask on each push</option>
                </select>
              )}
              <span className="field-note">
                {spec.issueTypes?.length ? `On ${spec.issueTypes.join(", ")}` : "On every type"}
                {!field && " · not on this project's screens"}
              </span>
              <span className="spacer" />
              <button
                className="btn"
                onClick={() => {
                  const next = { ...value };
                  delete next[id];
                  onChange(next);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        );
      })}

      {addable.length > 0 && (
        <label>
          <span>Add a field</span>
          <select
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) onChange({ ...value, [id]: newExtraField(meta, chosenTypes, id) });
            }}
          >
            <option value="">Choose…</option>
            {addable.map(({ field, on }) => (
              <option key={field.fieldId} value={field.fieldId}>
                {field.name}
                {field.required ? " (required)" : ""} — on {on.join(", ")}
              </option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
  );
}

type Search = { state: "searching" } | { state: "done"; results: JiraPerson[] } | { state: "failed"; message: string };

/**
 * The vault's assignees, each linked to a Jira account. Jira Cloud takes an
 * `accountId` for every user field and has not accepted a name since 2019, so
 * an assignee with no link here is pushed unassigned.
 *
 * Found through the assignable search for this project, and linked on its
 * own only when the search returns exactly one person. That's the same
 * evidence floor `vault-capture` keeps. Anything else waits for a choice.
 */
export function PeopleLinks({
  projectKey,
  vaultPeople,
  value,
  setValue,
}: {
  projectKey: string;
  vaultPeople: string[];
  value: Record<string, JiraPersonLink>;
  /**
   * The state setter itself, not a plain callback. A search finishes after
   * renders it did not see, and "Find everyone" runs several in turn, so each
   * link is merged into the value as it is by then, not as it was at the start.
   */
  setValue: React.Dispatch<React.SetStateAction<Record<string, JiraPersonLink>>>;
}): React.JSX.Element {
  const [searches, setSearches] = useState<Record<string, Search>>({});

  /** Everyone assigned in the vault, plus anyone already linked, once each. */
  const people = useMemo(() => {
    const byFolded = new Map<string, string>();
    for (const name of Object.keys(value)) byFolded.set(name.toLowerCase(), name);
    for (const name of vaultPeople) if (!byFolded.has(name.toLowerCase())) byFolded.set(name.toLowerCase(), name);
    return [...byFolded.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [value, vaultPeople]);

  const unlinked = people.filter((p) => !value[p]);

  const link = (person: string, who: JiraPerson): void =>
    setValue((cur) => ({ ...cur, [person]: { accountId: who.accountId, displayName: who.displayName } }));

  const search = async (person: string): Promise<void> => {
    setSearches((s) => ({ ...s, [person]: { state: "searching" } }));
    const result = await window.vault.jiraSearchPeople(projectKey, person);
    if (!result.ok) {
      setSearches((s) => ({ ...s, [person]: { state: "failed", message: result.message } }));
      return;
    }
    setSearches((s) => ({ ...s, [person]: { state: "done", results: result.value } }));
    if (result.value.length === 1) link(person, result.value[0]);
  };

  return (
    <fieldset className="jira-people">
      <legend>People</legend>
      {people.length === 0 && <p className="field-note">No one is assigned anything in this vault yet.</p>}
      {people.length > 0 && (
        <p className="field-note">
          An assignee with no account here is created unassigned, and the push says so.
        </p>
      )}

      {people.map((person) => {
        const linked = value[person];
        const found = searches[person];
        return (
          <div key={person} className="jira-person" data-person={person}>
            <span className="jira-person-name">{person}</span>
            {linked ? (
              <>
                <span className="jira-confirmed">→ {linked.displayName ?? linked.accountId}</span>
                <span className="spacer" />
                <button
                  className="btn"
                  onClick={() => {
                    const without = <T,>(record: Record<string, T>): Record<string, T> => {
                      const next = { ...record };
                      delete next[person];
                      return next;
                    };
                    setValue(without);
                    setSearches(without);
                  }}
                >
                  Unlink
                </button>
              </>
            ) : found?.state === "searching" ? (
              <span className="field-note">Asking Jira…</span>
            ) : found?.state === "failed" ? (
              <span className="field-note due-overdue">{found.message}</span>
            ) : found?.state === "done" && found.results.length === 0 ? (
              <span className="field-note">No one assignable in {projectKey} matches.</span>
            ) : found?.state === "done" ? (
              <select
                aria-label={`Jira account for ${person}`}
                value=""
                onChange={(e) => {
                  const who = found.results.find((r) => r.accountId === e.target.value);
                  if (who) link(person, who);
                }}
              >
                <option value="">{found.results.length} match — choose…</option>
                {found.results.map((r) => (
                  <option key={r.accountId} value={r.accountId}>
                    {r.displayName}
                    {r.emailAddress ? ` <${r.emailAddress}>` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span className="field-note">Not linked</span>
            )}
            {!linked && found?.state !== "searching" && (
              <>
                <span className="spacer" />
                <button className="btn" onClick={() => void search(person)}>
                  Find in Jira
                </button>
              </>
            )}
          </div>
        );
      })}

      {unlinked.length > 1 && (
        <div className="jira-mapping-actions">
          <span className="spacer" />
          <button
            className="btn"
            onClick={() => {
              void (async () => {
                for (const person of unlinked) await search(person);
              })();
            }}
          >
            Find everyone in Jira
          </button>
        </div>
      )}
    </fieldset>
  );
}

