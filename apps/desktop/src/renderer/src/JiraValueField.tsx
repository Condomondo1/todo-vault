import { useMemo, useState } from "react";
import { adfToMarkdown, isAdfDoc, shapeFieldValue, type JiraFieldMeta } from "todo-vault/jira-meta";

import type { JiraAskField, JiraChoice, JiraPerson, JiraPersonLink } from "@shared/api";
import {
  accountIdOf,
  cascadingIndexes,
  chosenPeople,
  storedPeople,
  type ChosenPerson,
  cascadingValue,
  listText,
  localDatetime,
  parseList,
  peopleChoices,
} from "@shared/jira-choices";

/**
 * One Jira field's value, with the control its schema implies (see
 * `valueKindFor` in `todo-vault/jira-meta`).
 *
 * Drawn in two places: the push pane, for an `ask` field on this push only,
 * and Settings → Jira → Mapping, for an extra field's stored value. One editor
 * keeps them agreeing about how a value is stored.
 *
 * Every control stores what a person means — an option's `{ id }`, a paragraph
 * as markdown, a person's `{ accountId }`, a list — and the core's
 * `shapeFieldValue` builds Jira's JSON from it at push time. Nobody types JSON
 * unless they ask to: the only JSON box is behind "Edit as JSON" on a field
 * whose schema says nothing usable, and only that box is sent as written.
 */
export function JiraValueField({
  field,
  onChange,
  people = {},
  meta,
}: {
  field: JiraAskField;
  onChange: (value: unknown) => void;
  /** The map's linked people, offered first by a user field's picker. */
  people?: Readonly<Record<string, JiraPersonLink>>;
  /**
   * The field as the project describes it. When given, the value is checked
   * the way the push will check it, and a mistake shows under the field.
   */
  meta?: JiraFieldMeta;
}): React.JSX.Element {
  const [checked, setChecked] = useState<string | null>(() => problemWith(meta, field.value, people));
  const change = (value: unknown): void => {
    onChange(value);
    setChecked(problemWith(meta, value, people));
  };

  let control: React.JSX.Element;
  switch (field.kind) {
    case "option":
    case "priority":
    case "version":
    case "component":
      control = <SingleSelect choices={field.choices} value={field.value} onChange={change} />;
      break;
    case "options":
    case "versions":
    case "components":
      control = <MultiSelect choices={field.choices} value={field.value} onChange={change} />;
      break;
    case "cascading":
      control = <Cascading field={field} onChange={change} />;
      break;
    case "user":
    case "users":
      control = <PeoplePicker field={field} people={people} multiple={field.kind === "users"} onChange={change} />;
      break;
    case "richText":
      control = (
        <>
          <textarea
            rows={4}
            defaultValue={isAdfDoc(field.value) ? adfToMarkdown(field.value) : typeof field.value === "string" ? field.value : ""}
            onChange={(e) => change(e.target.value === "" ? null : e.target.value)}
          />
          <span className="field-note">Formatted like a description: **bold**, - lists, [links](https://…).</span>
        </>
      );
      break;
    case "datetime":
      control = (
        <input
          type="datetime-local"
          defaultValue={localDatetime(field.value)}
          onChange={(e) => change(e.target.value === "" ? null : e.target.value)}
        />
      );
      break;
    case "date":
      control = (
        <input
          type="date"
          defaultValue={typeof field.value === "string" ? field.value.slice(0, 10) : ""}
          onChange={(e) => change(e.target.value === "" ? null : e.target.value)}
        />
      );
      break;
    case "number":
    case "sprint":
      control = (
        <>
          <input
            type="number"
            defaultValue={typeof field.value === "number" || typeof field.value === "string" ? String(field.value) : ""}
            onChange={(e) => change(e.target.value === "" ? null : Number(e.target.value))}
          />
          {field.kind === "sprint" && (
            <span className="field-note">Sprint id: the number in the board&rsquo;s URL with that sprint selected.</span>
          )}
        </>
      );
      break;
    case "labels":
    case "strings":
    case "groups":
      control = (
        <input
          type="text"
          placeholder="comma, separated"
          defaultValue={listText(field.value)}
          onChange={(e) => change(parseList(e.target.value))}
        />
      );
      break;
    case "managed":
      control = <span className="field-note">Jira sets this itself; it is not sent.</span>;
      break;
    case "raw":
      control = <RawValue field={field} onChange={change} />;
      break;
    default:
      // text, team, group, project: one line, sent as typed. A team or group
      // stored as an object by an older map is shown as its id or name.
      control = (
        <>
          <input
            type="text"
            defaultValue={plainText(field.value)}
            onChange={(e) => change(e.target.value === "" ? null : e.target.value)}
          />
          {field.kind === "team" && <span className="field-note">Team id, from the team&rsquo;s page in Atlassian.</span>}
        </>
      );
  }

  return (
    <div className="modal-field" data-kind={field.kind}>
      <span title={field.fieldId}>{field.name}</span>
      {control}
      {checked && <span className="field-note due-overdue">{checked}</span>}
    </div>
  );
}

/** What the push would refuse about this value, or null. */
function problemWith(
  meta: JiraFieldMeta | undefined,
  value: unknown,
  people: Readonly<Record<string, JiraPersonLink>>,
): string | null {
  if (!meta) return null;
  const shaped = shapeFieldValue(meta, value, { people });
  return shaped.ok ? null : shaped.message;
}

function plainText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return String(value);
  const v = value as { id?: unknown; name?: unknown; key?: unknown };
  for (const word of [v.name, v.key, v.id]) if (typeof word === "string") return word;
  return JSON.stringify(value);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function SingleSelect({
  choices,
  value,
  onChange,
}: {
  choices: JiraChoice[];
  value: unknown;
  onChange: (value: unknown) => void;
}): React.JSX.Element {
  const index = choices.findIndex((c) => same(c.value, value));
  return (
    <select value={index} onChange={(e) => onChange(Number(e.target.value) < 0 ? null : choices[Number(e.target.value)].value)}>
      <option value={-1}>— none —</option>
      {choices.map((c, i) => (
        <option key={i} value={i}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

function MultiSelect({
  choices,
  value,
  onChange,
}: {
  choices: JiraChoice[];
  value: unknown;
  onChange: (value: unknown) => void;
}): React.JSX.Element {
  const current = Array.isArray(value) ? value : [];
  return (
    <div className="jira-multi">
      {choices.map((c, i) => {
        const on = current.some((v) => same(v, c.value));
        return (
          <label key={i} className="status-line">
            <input
              type="checkbox"
              checked={on}
              onChange={() => onChange(on ? current.filter((v) => !same(v, c.value)) : [...current, c.value])}
            />
            {c.label}
          </label>
        );
      })}
    </div>
  );
}

/** Two selects: the parent, then the children Jira lists under it. */
function Cascading({ field, onChange }: { field: JiraAskField; onChange: (value: unknown) => void }): React.JSX.Element {
  const [at, setAt] = useState(() => cascadingIndexes(field.choices, field.value));
  const kids = field.choices[at.parent]?.children ?? [];
  const pick = (parent: number, child: number): void => {
    setAt({ parent, child });
    onChange(cascadingValue(field.choices, parent, child));
  };
  return (
    <div className="jira-cascading">
      <select aria-label={`${field.name}, first level`} value={at.parent} onChange={(e) => pick(Number(e.target.value), -1)}>
        <option value={-1}>— none —</option>
        {field.choices.map((c, i) => (
          <option key={i} value={i}>
            {c.label}
          </option>
        ))}
      </select>
      {kids.length > 0 && (
        <select
          aria-label={`${field.name}, second level`}
          value={at.child}
          onChange={(e) => pick(at.parent, Number(e.target.value))}
        >
          <option value={-1}>— none —</option>
          {kids.map((c, i) => (
            <option key={i} value={i}>
              {c.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

type Search = { state: "idle" } | { state: "searching" } | { state: "done"; results: JiraPerson[] } | { state: "failed"; message: string };

/**
 * A person, or several, by Jira account. The map's linked people come first,
 * since they are who the vault already knows; anyone else is a search of the
 * site away. Stored as `{ accountId }`, the shape Jira takes.
 */
function PeoplePicker({
  field,
  people,
  multiple,
  onChange,
}: {
  field: JiraAskField;
  people: Readonly<Record<string, JiraPersonLink>>;
  multiple: boolean;
  onChange: (value: unknown) => void;
}): React.JSX.Element {
  const linked = useMemo(() => peopleChoices(people), [people]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<Search>({ state: "idle" });

  // Names written by hand into the map are resolved the way the push will
  // resolve them; one that names nobody linked stays text, never a fake account.
  const chosen = chosenPeople(field.value, people);
  const keyOf = (c: ChosenPerson): string => ("accountId" in c ? `a:${c.accountId}` : `t:${c.typed}`);
  const labelOf = (c: ChosenPerson): string =>
    "accountId" in c
      ? (names[c.accountId] ?? linked.find((l) => accountIdOf(l.value) === c.accountId)?.label ?? c.accountId)
      : c.typed;
  const ids = chosen.flatMap((c) => ("accountId" in c ? [c.accountId] : []));

  const set = (next: ChosenPerson[]): void => {
    const values = storedPeople(next);
    onChange(multiple ? values : (values[0] ?? null));
  };
  const add = (who: { accountId: string; displayName?: string }): void => {
    if (who.displayName) setNames((n) => ({ ...n, [who.accountId]: who.displayName as string }));
    const person = { accountId: who.accountId };
    set(multiple ? [...chosen.filter((c) => keyOf(c) !== keyOf(person)), person] : [person]);
    setSearch({ state: "idle" });
    setQuery("");
  };

  const find = async (): Promise<void> => {
    if (!query.trim()) return;
    setSearch({ state: "searching" });
    const result = await window.vault.jiraSearchUsers(query);
    setSearch(result.ok ? { state: "done", results: result.value } : { state: "failed", message: result.message });
  };

  const offered = linked.filter((c) => !ids.includes(accountIdOf(c.value) ?? ""));

  return (
    <div className="jira-people-picker">
      {chosen.length > 0 && (
        <div className="jira-chosen">
          {chosen.map((c) => (
            <span
              key={keyOf(c)}
              className={`pill${"typed" in c ? " jira-chip-unlinked" : ""}`}
              title={"accountId" in c ? c.accountId : "No linked Jira account: the push looks this name up in People"}
            >
              {labelOf(c)}{" "}
              <button
                type="button"
                className="jira-chip-remove"
                aria-label={`Remove ${labelOf(c)}`}
                onClick={() => set(chosen.filter((other) => keyOf(other) !== keyOf(c)))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {(multiple || chosen.length === 0) && (
        <div className="jira-people-add">
          {offered.length > 0 && (
            <select
              aria-label={`${field.name}: a linked person`}
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (id) add({ accountId: id });
              }}
            >
              <option value="">Linked people…</option>
              {offered.map((c) => (
                <option key={accountIdOf(c.value)} value={accountIdOf(c.value)}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            placeholder="Search Jira by name or email"
            aria-label={`${field.name}: search Jira`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void find();
              }
            }}
          />
          <button type="button" className="btn" disabled={!query.trim() || search.state === "searching"} onClick={() => void find()}>
            Find
          </button>
        </div>
      )}
      {search.state === "searching" && <span className="field-note">Asking Jira…</span>}
      {search.state === "failed" && <span className="field-note due-overdue">{search.message}</span>}
      {search.state === "done" && search.results.length === 0 && (
        <span className="field-note">No one on the site matches &ldquo;{query}&rdquo;.</span>
      )}
      {search.state === "done" && search.results.length > 0 && (
        <select
          aria-label={`${field.name}: search results`}
          value=""
          onChange={(e) => {
            const who = search.results.find((r) => r.accountId === e.target.value);
            if (who) add(who);
          }}
        >
          <option value="">
            {search.results.length} match{search.results.length === 1 ? "" : "es"} — choose…
          </option>
          {search.results.map((r) => (
            <option key={r.accountId} value={r.accountId}>
              {r.displayName}
              {r.emailAddress ? ` <${r.emailAddress}>` : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/**
 * A field whose schema says nothing usable, usually an app's. Plain text by
 * default, which the core sends as a string, or matches to Jira's options when
 * the project lists them. "Edit as JSON" is the one way to send an object, and
 * the one value that goes exactly as written.
 */
function RawValue({ field, onChange }: { field: JiraAskField; onChange: (value: unknown) => void }): React.JSX.Element {
  const isObject = field.value !== null && typeof field.value === "object";
  const [json, setJson] = useState(isObject);
  const [text, setText] = useState(() =>
    isObject ? JSON.stringify(field.value, null, 2) : field.value === undefined || field.value === null ? "" : String(field.value),
  );
  const [error, setError] = useState<string | null>(null);

  const toggle = (
    <label className="status-line">
      <input
        type="checkbox"
        checked={json}
        onChange={() => {
          setJson(!json);
          setError(null);
        }}
      />
      Edit as JSON
    </label>
  );

  if (!json) {
    return (
      <>
        <input
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange(e.target.value === "" ? null : e.target.value);
          }}
        />
        {toggle}
      </>
    );
  }

  return (
    <>
      <textarea
        rows={3}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!text.trim()) {
            setError(null);
            onChange(null);
            return;
          }
          try {
            onChange(JSON.parse(text));
            setError(null);
          } catch {
            setError("Not valid JSON — the previous value is still what would be sent.");
          }
        }}
      />
      {toggle}
      <span className="field-note">Sent exactly as written, as JSON.</span>
      {error && <span className="field-note due-overdue">{error}</span>}
    </>
  );
}
