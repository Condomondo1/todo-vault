import { useCallback, useEffect, useRef, useState } from "react";

import type {
  JiraDraftView,
  JiraPushOutcome,
  JiraPushPreview,
  JiraPushProgress,
  JiraUpdateView,
} from "@shared/api";
import { pushButtonLabel, updateFieldChoices } from "@shared/jira-push-label";

import { JiraValueField } from "./JiraValueField";

/** Progress about one item; the push's own "slowed down" has no item. */
type ItemProgress = Extract<JiraPushProgress, { localKey: string }>;

/**
 * The push pane: what would be created in Jira and what would be updated
 * there, then the one button that does both.
 *
 * Everything shown is built in main — the plan, the project's create screens,
 * each changed issue as Jira holds it now, the stored credential's site — and
 * nothing here can change what is sent except the `ask` fields and which
 * changed fields are ticked, which go back as choices rather than as a
 * payload. Pressing the button asks main to rebuild the plan and read Jira
 * again, so a field made required since the preview blocks the push, and an
 * update sends what differs at that moment.
 *
 * The button says what it does — "Create 3 and update 1 in ENG" — because
 * this is the one action in the app that writes somewhere other than the
 * vault, into a tracker other people read.
 */
export function JiraPush({
  keys,
  onClose,
}: {
  keys: string[];
  onClose: () => void;
}): React.JSX.Element {
  const [preview, setPreview] = useState<JiraPushPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askValues, setAskValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [progress, setProgress] = useState<Record<string, ItemProgress>>({});
  /** When Jira's 429 wait ends, so the pane can count down rather than look hung. */
  const [resumesAt, setResumesAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [outcome, setOutcome] = useState<JiraPushOutcome | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showJson, setShowJson] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Changed fields someone unticked, per item. Kept as what was turned off,
   * not what is on, so a field that appears on a later re-plan starts ticked
   * like every other.
   */
  const [unticked, setUnticked] = useState<Record<string, string[]>>({});
  const requestId = useRef(0);

  const load = useCallback(
    async (values: Record<string, unknown>) => {
      const id = ++requestId.current;
      setLoading(true);
      const result = await window.vault.jiraPreviewPush(keys, values);
      // A slower, older preview must not overwrite a newer one.
      if (id !== requestId.current) return;
      setLoading(false);
      if (result.ok) {
        setPreview(result.value);
        setError(null);
      } else {
        setError(result.message);
      }
    },
    [keys],
  );

  // Re-plan when an ask value changes, a beat after the last change, so the
  // blockers shown always match the values that would be sent.
  useEffect(() => {
    const timer = setTimeout(() => void load(askValues), Object.keys(askValues).length ? 350 : 0);
    return () => clearTimeout(timer);
  }, [askValues, load]);

  const push = async (): Promise<void> => {
    setPushing(true);
    setProgress({});
    const stop = window.vault.onJiraPushProgress((p) => {
      if (p.state === "slowedDown") {
        setNow(Date.now());
        setResumesAt(Date.now() + p.waitMs);
        return;
      }
      setResumesAt(null);
      setProgress((cur) => ({ ...cur, [p.localKey]: p }));
    });
    try {
      const result = await window.vault.jiraPush(keys, askValues, updateFieldChoices(updates, unticked));
      if (result.ok) setOutcome(result.value);
      else setError(result.message);
    } finally {
      stop();
      setPushing(false);
      setResumesAt(null);
    }
  };

  // A once-a-second tick while Jira has asked us to wait, for the countdown.
  useEffect(() => {
    if (resumesAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resumesAt]);

  const toggle = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const drafts = preview?.drafts ?? [];
  const blockers = preview?.blockers ?? [];
  const updates = preview?.updates ?? [];
  /** Changed items the button acts on. One that already matches Jira waits for "Mark as in sync". */
  const toUpdate = updates.filter((u) => u.changes.length > 0).length;
  const canPush =
    !loading && !pushing && !outcome && drafts.length + toUpdate > 0 && blockers.length === 0;
  const projectLabel = preview ? preview.projectKey : "Jira";

  const setTicked = (localKey: string, fieldId: string, on: boolean): void =>
    setUnticked((cur) => {
      const off = new Set(cur[localKey] ?? []);
      if (on) off.delete(fieldId);
      else off.add(fieldId);
      return { ...cur, [localKey]: [...off] };
    });

  const markInSync = async (localKey: string): Promise<void> => {
    const result = await window.vault.jiraMarkInSync(localKey);
    if (result.ok) {
      setError(null);
      void load(askValues);
    } else {
      setError(result.message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={pushing ? undefined : onClose}>
      <div className="modal jira-push" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Push to Jira">
        <header className="modal-head">
          <h2>Push to Jira</h2>
          {preview && (
            <span className="pill" title={preview.site}>
              {preview.projectKey} — {preview.projectName}
            </span>
          )}
          <div className="spacer" />
          <button className="btn" onClick={onClose} disabled={pushing} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          {!preview && loading && <p className="field-note">Reading the project&rsquo;s create screens…</p>}
          {error && <div className="modal-error">{error}</div>}
          {resumesAt !== null && (
            <div className="field-note jira-slowed" role="status">
              Jira asked us to slow down — resuming in {Math.max(0, Math.ceil((resumesAt - now) / 1000))}s
            </div>
          )}

          {preview && !outcome && (
            <>
              {preview.uncertain.length > 0 && <Uncertain preview={preview} onResolved={() => void load(askValues)} />}

              {blockers.length > 0 && (
                <section className="jira-section">
                  <h3>Cannot be sent yet</h3>
                  <ul className="jira-blockers">
                    {blockers.map((b, i) => (
                      <li key={`${b.localKey}-${i}`}>{b.message}</li>
                    ))}
                  </ul>
                </section>
              )}

              {preview.askFields.length > 0 && (
                <section className="jira-section">
                  <h3>For this push</h3>
                  <p className="field-note">
                    Prefilled from Settings → Jira. A change here applies to this push only.
                  </p>
                  {preview.askFields.map((field) => (
                    <JiraValueField
                      key={field.fieldId}
                      field={field}
                      people={preview.people}
                      onChange={(value) => setAskValues((cur) => ({ ...cur, [field.fieldId]: value }))}
                    />
                  ))}
                </section>
              )}

              {(updates.length > 0 || preview.updateProblems.length > 0) && (
                <section className="jira-section" aria-label="Changed since pushed">
                  <h3>Changed since pushed</h3>
                  <p className="field-note">
                    Jira as it is now, beside the vault. Ticked fields are sent; an unticked one keeps Jira&rsquo;s
                    value.
                  </p>
                  <ul className="jira-drafts">
                    {updates.map((update) => (
                      <UpdateRow
                        key={update.localKey}
                        update={update}
                        unticked={unticked[update.localKey] ?? []}
                        progress={progress[update.localKey]}
                        disabled={pushing}
                        onTick={(fieldId, on) => setTicked(update.localKey, fieldId, on)}
                        onMarkInSync={() => void markInSync(update.localKey)}
                      />
                    ))}
                  </ul>
                  {preview.updateProblems.length > 0 && (
                    <ul className="jira-blockers">
                      {preview.updateProblems.map((p) => (
                        <li key={p.localKey}>{p.message}</li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {/* Left out when the push only updates: "0 issues to create" is noise then. */}
              {(drafts.length > 0 || updates.length === 0) && (
                <section className="jira-section">
                  <h3>
                    {drafts.length} issue{drafts.length === 1 ? "" : "s"} to create
                  </h3>
                  {drafts.length === 0 && <p className="field-note">Nothing here needs creating.</p>}
                  <ul className="jira-drafts">
                    {drafts.map((draft) => (
                      <DraftRow
                        key={draft.localKey}
                        draft={draft}
                        blocked={blockers.some((b) => b.localKey === draft.localKey)}
                        open={expanded.has(draft.localKey)}
                        json={showJson.has(draft.localKey)}
                        progress={progress[draft.localKey]}
                        onToggle={() => setExpanded((s) => toggle(s, draft.localKey))}
                        onToggleJson={() => setShowJson((s) => toggle(s, draft.localKey))}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {preview.warnings.length > 0 && (
                <section className="jira-section">
                  <h3>Worth knowing</h3>
                  <ul className="jira-warnings">
                    {preview.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </section>
              )}

              {preview.skipped.length > 0 && (
                <details className="jira-section">
                  <summary>{preview.skipped.length} not sent</summary>
                  <ul className="jira-warnings">
                    {preview.skipped.map((s) => (
                      <li key={s.localKey}>
                        <strong>{s.localKey}</strong> — {s.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

          {outcome && <Outcome outcome={outcome} />}
        </div>

        <footer className="modal-foot">
          {outcome ? (
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={pushing}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!canPush} onClick={() => void push()}>
                {pushing ? "Sending…" : pushButtonLabel(drafts.length, toUpdate, projectLabel)}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function DraftRow({
  draft,
  blocked,
  open,
  json,
  progress,
  onToggle,
  onToggleJson,
}: {
  draft: JiraDraftView;
  blocked: boolean;
  open: boolean;
  json: boolean;
  progress?: ItemProgress;
  onToggle: () => void;
  onToggleJson: () => void;
}): React.JSX.Element {
  return (
    <li className={`jira-draft${blocked ? " jira-draft-blocked" : ""}`}>
      <button type="button" className="jira-draft-head" onClick={onToggle} aria-expanded={open}>
        <span className="cell-key">{draft.localKey}</span>
        <span className="jira-draft-summary">{draft.summary}</span>
        <span className="pill">{draft.issueType}</span>
        {draft.parentLocalKey && <span className="field-note">under {draft.parentLocalKey}</span>}
        {progress && <span className={`jira-state jira-state-${progress.state}`}>{progressLabel(progress)}</span>}
      </button>
      {open && (
        <div className="jira-draft-body">
          <dl className="jira-fields">
            {draft.fields.map((f) => (
              <div key={f.fieldId}>
                <dt title={f.fieldId}>{f.name}</dt>
                <dd>{f.text || <span className="field-note">empty</span>}</dd>
              </div>
            ))}
          </dl>
          <button type="button" className="btn" onClick={onToggleJson}>
            {json ? "Hide JSON" : "Show JSON"}
          </button>
          {json && <pre className="jira-json">{draft.json}</pre>}
        </div>
      )}
    </li>
  );
}

/**
 * One changed item: each differing field as Jira has it now and as the vault
 * would make it, with a tick for whether to send it. A field the issue's edit
 * screen will not take is shown, unticked and disabled, with Jira's reason,
 * so nothing that differs is hidden. An item that already matches Jira has
 * nothing to send, and only needs marking as in sync.
 */
function UpdateRow({
  update,
  unticked,
  progress,
  disabled,
  onTick,
  onMarkInSync,
}: {
  update: JiraUpdateView;
  unticked: readonly string[];
  progress?: ItemProgress;
  disabled: boolean;
  onTick: (fieldId: string, on: boolean) => void;
  onMarkInSync: () => void;
}): React.JSX.Element {
  return (
    <li className="jira-draft" data-local-key={update.localKey}>
      <div className="jira-draft-head">
        <span className="cell-key">{update.localKey}</span>
        <span className="jira-draft-summary">{update.summary}</span>
        <a
          href={update.url}
          className="pill"
          onClick={(e) => {
            e.preventDefault();
            void window.vault.openTarget({ kind: "external", value: update.url });
          }}
        >
          {update.jiraKey}
        </a>
        {progress && <span className={`jira-state jira-state-${progress.state}`}>{progressLabel(progress)}</span>}
      </div>
      <div className="jira-draft-body">
        {update.changes.length === 0 ? (
          <div className="jira-resolve">
            <span className="field-note">Jira already matches. Nothing to send.</span>
            <button type="button" className="btn" disabled={disabled} onClick={onMarkInSync}>
              Mark as in sync
            </button>
          </div>
        ) : (
          <table className="jira-changes">
            <thead>
              <tr>
                <th aria-label="Send" />
                <th>Field</th>
                <th>Jira now</th>
                <th aria-hidden="true" />
                <th>Vault</th>
              </tr>
            </thead>
            <tbody>
              {update.changes.map((c) => (
                <tr key={c.fieldId} data-field-id={c.fieldId} className={c.editable ? undefined : "jira-change-locked"}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Update ${c.name}`}
                      checked={c.editable && !unticked.includes(c.fieldId)}
                      disabled={!c.editable || disabled}
                      onChange={(e) => onTick(c.fieldId, e.target.checked)}
                    />
                  </td>
                  <td title={c.fieldId}>
                    {c.name}
                    {c.reason && <div className="field-note">{c.reason}</div>}
                  </td>
                  <td>{c.jiraText || <span className="field-note">empty</span>}</td>
                  <td aria-hidden="true">→</td>
                  <td>{c.vaultText || <span className="field-note">empty</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </li>
  );
}

function progressLabel(p: ItemProgress): string {
  switch (p.state) {
    case "creating":
      return "creating…";
    case "updating":
      return "updating…";
    case "created":
    case "updated":
      return p.jiraKey;
    case "failed":
      return p.uncertain ? "unknown" : "failed";
    case "skipped":
      return "skipped";
  }
}

/** Attempts that may or may not have reached Jira, each needing a person to say which. */
function Uncertain({ preview, onResolved }: { preview: JiraPushPreview; onResolved: () => void }): React.JSX.Element {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const resolve = async (localKey: string, jiraKey: string | null): Promise<void> => {
    const result = await window.vault.jiraResolveUncertain(localKey, jiraKey);
    if (result.ok) {
      setMessage(null);
      onResolved();
    } else {
      setMessage(result.message);
    }
  };

  return (
    <section className="jira-section">
      <h3>Did these reach Jira?</h3>
      <p className="field-note">
        A previous push lost its connection before Jira answered, so these may already exist. They will not be
        sent again until you say.
      </p>
      <ul className="jira-drafts">
        {preview.uncertain.map((a) => (
          <li key={a.localKey} className="jira-draft">
            <div className="jira-draft-head">
              <span className="cell-key">{a.localKey}</span>
              <span className="jira-draft-summary">{a.summary}</span>
              <button
                type="button"
                className="btn"
                onClick={() => void window.vault.openTarget({ kind: "external", value: a.searchUrl })}
              >
                Check in Jira
              </button>
            </div>
            <div className="jira-draft-body jira-resolve">
              <input
                type="text"
                placeholder={`${preview.projectKey}-123`}
                value={keys[a.localKey] ?? ""}
                onChange={(e) => setKeys((k) => ({ ...k, [a.localKey]: e.target.value }))}
              />
              <button
                type="button"
                className="btn"
                disabled={!keys[a.localKey]?.trim()}
                onClick={() => void resolve(a.localKey, keys[a.localKey])}
              >
                It exists
              </button>
              <button type="button" className="btn" onClick={() => void resolve(a.localKey, null)}>
                It was not created
              </button>
            </div>
          </li>
        ))}
      </ul>
      {message && <div className="modal-error">{message}</div>}
    </section>
  );
}

function Outcome({ outcome }: { outcome: JiraPushOutcome }): React.JSX.Element {
  return (
    <>
      {outcome.created.length > 0 && (
        <section className="jira-section">
          <h3>Created {outcome.created.length}</h3>
          <ul className="jira-warnings">
            {outcome.created.map((c) => (
              <li key={c.localKey}>
                <strong>{c.localKey}</strong> →{" "}
                <a
                  href={c.url}
                  onClick={(e) => {
                    e.preventDefault();
                    void window.vault.openTarget({ kind: "external", value: c.url });
                  }}
                >
                  {c.jiraKey}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {outcome.updated.length > 0 && (
        <section className="jira-section">
          <h3>Updated {outcome.updated.length}</h3>
          <ul className="jira-warnings">
            {outcome.updated.map((u) => (
              <li key={u.localKey}>
                <strong>{u.localKey}</strong> →{" "}
                <a
                  href={u.url}
                  onClick={(e) => {
                    e.preventDefault();
                    void window.vault.openTarget({ kind: "external", value: u.url });
                  }}
                >
                  {u.jiraKey}
                </a>{" "}
                <span className="field-note">
                  {u.fields.length ? u.fields.join(", ") : "nothing sent; Jira's values kept"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {outcome.failed.length > 0 && (
        <section className="jira-section">
          <h3>Failed {outcome.failed.length}</h3>
          <ul className="jira-blockers">
            {outcome.failed.map((f) => (
              <li key={f.localKey}>
                <strong>{f.localKey}</strong> — {f.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {outcome.skipped.length > 0 && (
        <section className="jira-section">
          <h3>Not sent {outcome.skipped.length}</h3>
          <ul className="jira-warnings">
            {/* An update can add a note per field, so one item may appear twice. */}
            {outcome.skipped.map((s, i) => (
              <li key={`${s.localKey}-${i}`}>
                <strong>{s.localKey}</strong> — {s.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      {outcome.created.length === 0 &&
        outcome.updated.length === 0 &&
        outcome.failed.length === 0 &&
        outcome.skipped.length === 0 && (
        <p className="field-note">Nothing was sent.</p>
      )}
    </>
  );
}
