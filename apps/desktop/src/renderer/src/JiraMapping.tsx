import { useEffect, useMemo, useState } from "react";
import {
  distinctFields,
  issueTypeNamed,
  valueKindFor,
  type FieldValueKind,
  type JiraFieldMeta,
  type ProjectMeta,
} from "todo-vault/jira-meta";
import type { JiraMapState, JiraMappingChoice, VaultIssueType } from "@shared/api";

const VAULT_TYPES: Array<[VaultIssueType, string]> = [
  ["epic", "Epic"],
  ["story", "Story"],
  ["task", "Task"],
  ["bug", "Bug"],
  ["subtask", "Subtask"],
];

/**
 * What each vault type is called in a fresh Jira project, tried in order when
 * the map says nothing yet. Team-managed projects say "Subtask", company-managed
 * ones "Sub-task", and both are common enough to guess at.
 */
const USUAL_NAMES: Record<VaultIssueType, string[]> = {
  epic: ["Epic"],
  story: ["Story"],
  task: ["Task"],
  bug: ["Bug"],
  subtask: ["Subtask", "Sub-task"],
};

/**
 * Settings → Jira, the mapping half: which project, and where the vault's own
 * fields go in it. Extra fields and people are the next section's job.
 *
 * Every choice here is offered from what the project actually has. The issue
 * types are the project's, and each field list holds only fields of the right
 * kind on the chosen types, so a typo'd `customfield_` id cannot happen. The
 * panel never writes the site: Save sends what was picked, and main fills in
 * `baseUrl`, `auth` and `cloudId` from the verified credential.
 */
export function JiraMapping(): React.JSX.Element {
  const [map, setMap] = useState<JiraMapState | null>(null);
  const [projectKey, setProjectKey] = useState("");
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [types, setTypes] = useState<Record<VaultIssueType, string>>({
    epic: "",
    story: "",
    task: "",
    bug: "",
    subtask: "",
  });
  const [fields, setFields] = useState<JiraMappingChoice["fields"]>({ category: "labels" });
  const [busy, setBusy] = useState<"load" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void window.vault.jiraLoadMap().then((result) => {
      if (!live) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setMap(result.value);
      if (result.value.exists) {
        setProjectKey(result.value.projectKey);
        setTypes(result.value.issueTypes);
        setFields(result.value.fields);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const load = async (): Promise<void> => {
    setBusy("load");
    setError(null);
    setSaved(false);
    const result = await window.vault.jiraLoadMeta(projectKey);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      setMeta(null);
      return;
    }
    const loaded = result.value;
    setMeta(loaded);
    setProjectKey(loaded.projectKey);
    // Main now has this project's create screens, so the saved map can be
    // checked against them before anything is changed.
    void window.vault.jiraLoadMap().then((fresh) => {
      if (fresh.ok) setMap(fresh.value);
    });
    // Keep a mapped type the project still has. Otherwise guess by the usual
    // name, and otherwise leave it blank for a person to choose.
    setTypes((current) => {
      const next = { ...current };
      for (const [vaultType] of VAULT_TYPES) {
        const kept = current[vaultType] && issueTypeNamed(loaded, current[vaultType]);
        const guessed = USUAL_NAMES[vaultType].map((n) => issueTypeNamed(loaded, n)).find(Boolean);
        next[vaultType] = (kept || guessed)?.name ?? "";
      }
      return next;
    });
  };

  /** Fields on at least one chosen type, by kind, with the chosen types they appear on. */
  const fieldsByKind = useMemo(() => {
    const out = new Map<FieldValueKind, Array<{ field: JiraFieldMeta; on: string[] }>>();
    if (!meta) return out;
    const chosen = [...new Set(Object.values(types).filter(Boolean))];
    for (const field of distinctFields(meta)) {
      const on = chosen.filter((name) =>
        issueTypeNamed(meta, name)?.fields.some((f) => f.fieldId === field.fieldId),
      );
      if (on.length === 0) continue;
      const kind = valueKindFor(field.schema);
      out.set(kind, [...(out.get(kind) ?? []), { field, on }]);
    }
    return out;
  }, [meta, types]);

  const optionsOf = (kind: FieldValueKind, exclude: string[] = []) =>
    (fieldsByKind.get(kind) ?? []).filter(({ field }) => !exclude.includes(field.fieldId));

  const complete = meta !== null && VAULT_TYPES.every(([t]) => types[t]);

  const save = async (): Promise<void> => {
    if (!meta || !complete) return;
    setBusy("save");
    setError(null);
    setSaved(false);
    const result = await window.vault.jiraSaveMap({ projectKey: meta.projectKey, issueTypes: types, fields });
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setMap(result.value);
    setSaved(true);
  };

  const fieldSelect = (
    label: string,
    key: "startDate" | "estimate",
    kind: FieldValueKind,
    exclude: string[] = [],
  ) => (
    <label>
      <span>{label}</span>
      <select
        value={fields[key] ?? ""}
        onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value || undefined }))}
      >
        <option value="">Don&rsquo;t send</option>
        {optionsOf(kind, exclude).map(({ field, on }) => (
          <option key={field.fieldId} value={field.fieldId}>
            {field.name} ({field.fieldId}) — on {on.join(", ")}
          </option>
        ))}
        {/* A saved choice this project no longer offers stays visible, marked. */}
        {fields[key] && !optionsOf(kind, exclude).some(({ field }) => field.fieldId === fields[key]) && (
          <option value={fields[key]}>{fields[key]} (not on the chosen types)</option>
        )}
      </select>
    </label>
  );

  return (
    <section className="jira-mapping" aria-label="Jira mapping">
      <h3>Where items go</h3>

      {map && !map.exists && (
        <p className="field-note">
          No <code>jira-map.yaml</code> in this vault yet. Saving creates one from the commented
          example, so it stays readable by hand.
        </p>
      )}

      <div className="modal-row">
        <label>
          <span>Jira project key</span>
          <input
            value={projectKey}
            placeholder="ENG"
            onChange={(e) => setProjectKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && projectKey.trim()) {
                e.preventDefault();
                void load();
              }
            }}
          />
        </label>
        <button
          className="btn jira-load"
          disabled={busy !== null || !projectKey.trim()}
          onClick={() => void load()}
        >
          {busy === "load" ? "Reading…" : meta ? "Reload" : "Load project"}
        </button>
      </div>

      {meta && (
        <>
          <p className="field-note">
            <strong>{meta.projectName}</strong> ({meta.projectKey}
            {meta.style ? `, ${meta.style === "next-gen" ? "team-managed" : "company-managed"}` : ""}):{" "}
            {meta.issueTypes.length} issue types.
          </p>

          <fieldset className="jira-types">
            <legend>Each vault type becomes</legend>
            {VAULT_TYPES.map(([vaultType, label]) => (
              <label key={vaultType}>
                <span>{label}</span>
                <select
                  value={types[vaultType]}
                  onChange={(e) => setTypes((t) => ({ ...t, [vaultType]: e.target.value }))}
                >
                  <option value="">Choose…</option>
                  {meta.issueTypes
                    // A subtask goes to a subtask type and nothing else does:
                    // Jira refuses a parentless subtask and a parented story alike.
                    .filter((t) => t.subtask === (vaultType === "subtask"))
                    .map((t) => (
                      <option key={t.id} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </fieldset>

          <fieldset className="jira-types">
            <legend>Vault fields</legend>
            {fieldSelect("Start date", "startDate", "date", ["duedate"])}
            {fieldSelect("Estimate", "estimate", "number")}
            <label>
              <span>Category</span>
              <select
                value={fields.category}
                onChange={(e) => setFields((f) => ({ ...f, category: e.target.value }))}
              >
                <option value="labels">Fold into labels</option>
                {optionsOf("text", ["summary"]).map(({ field, on }) => (
                  <option key={field.fieldId} value={field.fieldId}>
                    {field.name} ({field.fieldId}) — on {on.join(", ")}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          {/*
            Gaps are the saved map's, checked against this project, so they
            answer for what a push would do now rather than for unsaved picks.
          */}
          {map?.exists && map.projectKey === meta.projectKey && map.gaps && map.gaps.length > 0 && (
            <div className="jira-gaps">
              <p className="field-note">
                A push of these types will be refused until each field is filled in:
              </p>
              <ul className="jira-blockers">
                {map.gaps.map((gap) => (
                  <li key={`${gap.issueType}:${gap.fieldId}`}>
                    {gap.issueType} requires {gap.fieldName}, which nothing fills in.
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="jira-mapping-actions">
            {saved && <span className="field-note jira-confirmed">Saved to jira-map.yaml.</span>}
            <span className="spacer" />
            <button className="btn btn-primary" disabled={busy !== null || !complete} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : "Save mapping"}
            </button>
          </div>
        </>
      )}

      {error && <div className="modal-error">{error}</div>}
    </section>
  );
}
