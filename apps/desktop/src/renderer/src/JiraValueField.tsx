import { useState } from "react";

import type { JiraAskField } from "@shared/api";

/**
 * One Jira field's value, with the control its schema implies (see
 * `valueKindFor` in `todo-vault/jira-meta`).
 *
 * Drawn in two places: the push pane, for an `ask` field on this push only,
 * and Settings → Jira → Mapping, for an extra field's stored value. One editor
 * keeps them agreeing about the shape a value is stored in, which is Jira's
 * create shape (`{ id }`, `[{ id }]`, a date string), so nothing translates it
 * on the way out.
 *
 * Kinds with no control of their own, such as sprint, Atlassian Team, people
 * and app fields, fall back to raw JSON, sent exactly as written.
 */
export function JiraValueField({
  field,
  onChange,
}: {
  field: JiraAskField;
  onChange: (value: unknown) => void;
}): React.JSX.Element {
  const [raw, setRaw] = useState(() => (field.value === undefined ? "" : JSON.stringify(field.value, null, 2)));
  const [rawError, setRawError] = useState<string | null>(null);
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  let control: React.JSX.Element;
  switch (field.kind) {
    case "option":
    case "priority":
    case "version":
    case "component": {
      const index = field.choices.findIndex((c) => same(c.value, field.value));
      control = (
        <select value={index} onChange={(e) => onChange(Number(e.target.value) < 0 ? null : field.choices[Number(e.target.value)].value)}>
          <option value={-1}>— none —</option>
          {field.choices.map((c, i) => (
            <option key={i} value={i}>
              {c.label}
            </option>
          ))}
        </select>
      );
      break;
    }
    case "options":
    case "versions":
    case "components": {
      const current = Array.isArray(field.value) ? field.value : [];
      control = (
        <div className="jira-multi">
          {field.choices.map((c, i) => {
            const checked = current.some((v) => same(v, c.value));
            return (
              <label key={i} className="status-line">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(checked ? current.filter((v) => !same(v, c.value)) : [...current, c.value])}
                />
                {c.label}
              </label>
            );
          })}
        </div>
      );
      break;
    }
    case "text":
    case "date":
    case "datetime":
    case "number":
      control = (
        <input
          type={field.kind === "text" ? "text" : field.kind === "datetime" ? "datetime-local" : field.kind}
          defaultValue={field.value === undefined || field.value === null ? "" : String(field.value)}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === "" ? null : field.kind === "number" ? Number(v) : v);
          }}
        />
      );
      break;
    case "labels":
      control = (
        <input
          type="text"
          placeholder="comma, separated"
          defaultValue={Array.isArray(field.value) ? field.value.join(", ") : ""}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(",")
                .map((s) => s.trim().replace(/\s+/g, "-"))
                .filter(Boolean),
            )
          }
        />
      );
      break;
    default:
      control = (
        <>
          <textarea
            rows={3}
            value={raw}
            spellCheck={false}
            onChange={(e) => setRaw(e.target.value)}
            onBlur={() => {
              if (!raw.trim()) {
                setRawError(null);
                onChange(null);
                return;
              }
              try {
                onChange(JSON.parse(raw));
                setRawError(null);
              } catch {
                setRawError("Not valid JSON — the previous value is still what would be sent.");
              }
            }}
          />
          <span className="field-note">Sent exactly as written, as JSON.</span>
          {rawError && <span className="field-note due-overdue">{rawError}</span>}
        </>
      );
  }

  return (
    <div className="modal-field">
      <span title={field.fieldId}>{field.name}</span>
      {control}
    </div>
  );
}
