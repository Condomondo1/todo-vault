import type {
  AgendaSection,
  BulkUpdateInput,
  CreateItemInput,
  DeleteResult,
  GitStatus,
  HistoryPage,
  HistoryQuery,
  Item,
  ItemFilter,
  Project,
  RemoveScratchResult,
  ScratchNote,
  ScratchTrashEntry,
  Status,
  TrashEntry,
  TurnOnHistoryOptions,
  TurnOnHistoryResult,
  UpdateItemInput,
  UpdateProjectInput,
} from "todo-vault";
import type { FieldValueKind, ProjectMeta } from "todo-vault/jira-meta";

/**
 * The contract between the main process and the renderer.
 *
 * The renderer never touches the vault: `Vault` imports node:fs and
 * node:child_process, so it lives in main and everything crosses this boundary.
 * Keeping the shape in one file shared by both sides means a channel cannot
 * drift out of sync with its handler without the typecheck noticing.
 */

/**
 * Every call returns one of these rather than throwing.
 *
 * Structured clone strips the VaultError class and its `name` on the way across
 * IPC, so an Error would arrive as a shapeless object. The core's messages are
 * already written for a human — "Cannot move an item from todo to in_review.
 * From todo you can go to: ..." — so they are worth carrying deliberately.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

export interface ProjectSummary extends Project {
  openItems: number;
  totalItems: number;
  /**
   * Whether this project is hidden from the sidebar.
   *
   * Derived in main from `status === "archived"`, so the renderer never learns
   * the encoding and never has to remember which of the four status values is
   * load-bearing. The raw `status` still comes across on the Project fields —
   * this is the interpretation of it, not a replacement for it.
   */
  hidden: boolean;
}

/**
 * The whole vault, sent after every read and every mutation.
 *
 * Reconciling per-item deltas would be a bug farm for no gain at this size —
 * `load()` already rebuilds the entire index on any change.
 */
export interface VaultSnapshot {
  root: string;
  projects: ProjectSummary[];
  items: Item[];
  /**
   * Files that failed to parse, items and scratch notes alike. Surfaced in the
   * UI; otherwise they vanish silently.
   */
  errors: string[];
  /**
   * Every scratch note, newest first. On the snapshot rather than behind its own
   * call because the sidebar shows the newest few and a count on every view.
   */
  scratch: ScratchNote[];
  git: GitStatus;
  trashCount: number;
  loadedAt: string;
}

/** Agenda sections carry keys, not items, so the payload does not duplicate the snapshot. */
export interface AgendaView {
  kind: AgendaSection["kind"];
  scope: AgendaSection["scope"];
  from?: string;
  to?: string;
  /**
   * Display subdivisions of a long `due` window, straight from the core.
   *
   * Passed through untouched rather than derived here for the reason stated in
   * `Agenda.tsx` about the window itself: which dates count as "this week"
   * depends on today's date, so the core owns it and the renderer draws it.
   */
  bands?: AgendaSection["bands"];
  keys: string[];
}

/**
 * Re-exported rather than restated. This used to be its own hand-written union
 * and drifting from the core's was a matter of time — adding a scope there and
 * forgetting here would have typechecked cleanly right up to the `<select>`.
 */
export type AgendaScope = AgendaSection["scope"];

/** Null when no vault has been chosen yet — the renderer shows the picker. */
export type MaybeSnapshot = VaultSnapshot | null;

/**
 * Whether the optional Claude layer can be used, and why not when it cannot.
 *
 * Deliberately says nothing about the key itself beyond whether one exists. The
 * key lives in main, encrypted by safeStorage, and never crosses this boundary
 * in either direction except on the way in — there is no getter.
 */
export interface ClaudeStatus {
  /** safeStorage can actually encrypt on this machine. False means no key can be stored. */
  storageAvailable: boolean;
  hasKey: boolean;
  /** Written for a human, shown in the UI when the layer is unavailable. */
  reason?: string;
  /** Surfaced so the UI can name what it is about to call. */
  model: string;
}

/**
 * Jira's credential crosses this boundary the same one way the Anthropic key
 * does: in, once, when saved. What comes back is everything *but* the token.
 */
export type JiraAuthKind = "site" | "scoped";

export interface JiraCredentialInput {
  /** As typed. Main reduces it to an https origin, or refuses it. */
  site: string;
  auth: JiraAuthKind;
  email: string;
  token: string;
}

/** A stored credential, told to the renderer with the token left out. */
export interface JiraCredentialSummary {
  site: string;
  auth: JiraAuthKind;
  email: string;
  /** When Test connection last succeeded with this credential. */
  verifiedAt?: string;
  /** Whose account Jira said the token belongs to, at that check. */
  accountName?: string;
}

export interface JiraStatus {
  /** safeStorage can actually encrypt on this machine. False means nothing can be stored. */
  storageAvailable: boolean;
  /** Absent when none is stored, or when the stored one cannot be decrypted or read. */
  credential?: JiraCredentialSummary;
  /** Written for a human, shown when storage is unavailable. */
  reason?: string;
}

// --------------------------------------------------------- Jira mapping
// Settings -> Jira -> Mapping: which Jira project, which of its issue types
// and fields the vault's own go to, the Jira fields the vault has no
// equivalent for, and which Jira account each vault person is.

/** The vault's item types, each of which goes to one Jira issue type. */
export type VaultIssueType = "epic" | "story" | "task" | "bug" | "subtask";

/**
 * What the mapping panel chooses. Deliberately not a set of map edits: the
 * renderer says what it picked, and main decides what is written. In
 * particular, `baseUrl`, `auth` and `cloudId` are never in here. Main writes
 * them from the verified credential, so nothing the renderer sends can point
 * the map, and with it the token, at another site.
 */
export interface JiraMappingChoice {
  projectKey: string;
  issueTypes: Record<VaultIssueType, string>;
  fields: {
    /** A date field's id, or absent to send no start date. */
    startDate?: string;
    /** A number field's id, or absent to send no estimate. */
    estimate?: string;
    /** "labels" to fold the category into labels, or a text field's id. */
    category: string;
  };
  /**
   * The whole set of extra fields, by field id. Present means the panel owns
   * the set: an id missing from it is removed from the map. Absent leaves the
   * map's extra fields exactly as they were.
   */
  extraFields?: Record<string, JiraExtraField>;
  /** The whole set of people, by the vault's spelling. Same rule as `extraFields`. */
  people?: Record<string, JiraPersonLink>;
  /**
   * `defaults` entries converted into `extraFields` on this Save, by field id,
   * to be removed from `defaults`. The converted entries themselves travel in
   * `extraFields` like any other.
   */
  convertDefaults?: string[];
}

/** A Jira field the vault has no equivalent for, and what to send in it. */
export interface JiraExtraField {
  /** Jira's name for it, kept for whoever reads the file. */
  name?: string;
  /** `always` sends `value` on every issue; `ask` offers it, prefilled, on each push. */
  mode: "always" | "ask";
  /**
   * What a person chose or typed: an option as `{ id }`, a paragraph as
   * markdown, a person as `{ accountId }`, a list as an array. The core's
   * `shapeFieldValue` builds Jira's create shape from it at push time, and
   * passes a value already in that shape through unchanged.
   */
  value?: unknown;
  /** Only these issue types, by name. Absent means every type. */
  issueTypes?: string[];
}

/** A vault person's Jira account. */
export interface JiraPersonLink {
  accountId: string;
  displayName?: string;
}

/** Someone Jira says can be assigned in the project. */
export interface JiraPerson {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

/** The mapping as `jira-map.yaml` has it now, or `exists: false` before the first save. */
export type JiraMapState =
  | { exists: false }
  | {
      exists: true;
      projectKey: string;
      baseUrl?: string;
      issueTypes: Record<VaultIssueType, string>;
      fields: { startDate?: string; estimate?: string; category: string };
      extraFields: Record<string, JiraExtraField>;
      people: Record<string, JiraPersonLink>;
      /** The older form of `extraFields`: always sent, in Jira's shape. Offered for conversion. */
      defaults: Record<string, unknown>;
      /**
       * Required fields on a mapped issue type that nothing under this map can
       * fill in. Absent until this project's metadata has been loaded in this
       * session, because only Jira knows what its create screens require.
       */
      gaps?: JiraMappingGap[];
    };

/** One required field no mapping fills: "Story requires Team, which nothing fills in". */
export interface JiraMappingGap {
  issueType: string;
  fieldId: string;
  fieldName: string;
}

// ------------------------------------------------------------- Jira push
// Built in main from the vault, the map, the project's metadata and the stored
// credential. The renderer only ever sees the result: never the token, and
// never a plan it could edit and send back — the push rebuilds the plan in main
// from the same keys rather than trusting one that crossed IPC.

/** One field of a draft, as the push pane lists it. */
export interface JiraDraftFieldView {
  fieldId: string;
  /** Jira's own name for it when the project told us, else the id. */
  name: string;
  /** A one-line reading of the value: names over ids, ADF as its text. */
  text: string;
}

export interface JiraDraftView {
  localKey: string;
  summary: string;
  issueType: string;
  parentLocalKey?: string;
  fields: JiraDraftFieldView[];
  /** The payload exactly as it will be sent, for the pane's Show JSON. */
  json: string;
}

/** A selectable value from Jira's own list for a field. */
export interface JiraChoice {
  /** Already in the shape Jira's create API takes, e.g. `{ id: "10021" }`. */
  value: unknown;
  label: string;
  /** A cascading select's second level, under this parent. */
  children?: JiraChoice[];
}

/** An `ask` extra field, offered once per push, prefilled from the map. */
export interface JiraAskField {
  fieldId: string;
  name: string;
  /** Which control to draw. See `valueKindFor` in `todo-vault/jira-meta`. */
  kind: FieldValueKind;
  choices: JiraChoice[];
  /** The value that will be sent if nothing is changed. */
  value: unknown;
}

/**
 * One field where an issue already in Jira and its vault item now differ.
 * Only the texts cross IPC: the value to send stays in main, which reads Jira
 * again and takes it from a fresh diff at push time.
 */
export interface JiraFieldChangeView {
  fieldId: string;
  name: string;
  /** "" when Jira has nothing there. */
  jiraText: string;
  /** "" when the vault cleared it. */
  vaultText: string;
  /** False when the issue's edit screen will not take it; `reason` says why. */
  editable: boolean;
  reason?: string;
}

/** What the pane decided for one changed item: the fields to send, and every field it showed. */
export interface JiraUpdateChoice {
  ticked: string[];
  /** Ticked or not. A difference outside this set appeared after the person looked. */
  seen: string[];
}

/** An item changed since its push, set beside its Jira issue as it is now. */
export interface JiraUpdateView {
  localKey: string;
  summary: string;
  jiraKey: string;
  url: string;
  /** Empty when Jira already matches: nothing to send, only "Mark as in sync". */
  changes: JiraFieldChangeView[];
}

/** A push attempt that may or may not have reached Jira. */
export interface JiraUncertainAttempt {
  localKey: string;
  summary: string;
  at: string;
  /** A Jira search to check, opened in the browser. */
  searchUrl: string;
}

export interface JiraPushPreview {
  site: string;
  projectKey: string;
  projectName: string;
  drafts: JiraDraftView[];
  warnings: string[];
  blockers: Array<{ localKey: string; message: string }>;
  skipped: Array<{ localKey: string; reason: string }>;
  askFields: JiraAskField[];
  /** Items changed since their push, each with what differs from Jira now. */
  updates: JiraUpdateView[];
  /** Changed items that cannot be compared, such as an issue deleted in Jira. Not sent. */
  updateProblems: Array<{ localKey: string; message: string }>;
  /** The map's linked people, for a user field's picker. */
  people: Record<string, JiraPersonLink>;
  /** Must be resolved before these items can be pushed again. */
  uncertain: JiraUncertainAttempt[];
}

export type JiraPushProgress =
  | { localKey: string; state: "creating" }
  | { localKey: string; state: "created"; jiraKey: string; url: string }
  | { localKey: string; state: "failed"; message: string; uncertain: boolean }
  | { localKey: string; state: "skipped"; reason: string }
  | { localKey: string; state: "updating" }
  | { localKey: string; state: "updated"; jiraKey: string; url: string }
  /** Jira answered 429; the push is waiting, not hung. Not about one item. */
  | { state: "slowedDown"; waitMs: number };

export interface JiraPushOutcome {
  created: Array<{ localKey: string; jiraKey: string; jiraId: string; url: string }>;
  /**
   * `fields` names what was sent; empty when the item was only marked as
   * matching Jira. `restamped` is false when a difference the person never
   * saw or could not send remains, and `note` then says which, so the item
   * still reads as changed and is offered again.
   */
  updated: Array<{
    localKey: string;
    jiraKey: string;
    url: string;
    fields: string[];
    restamped: boolean;
    note?: string;
  }>;
  /** `fieldErrors` is keyed by Jira's name for the field where the project told us, else its id. */
  failed: Array<{ localKey: string; message: string; fieldErrors: Record<string, string>; uncertain: boolean }>;
  skipped: Array<{ localKey: string; reason: string }>;
}

/**
 * A proposed item, rendered for confirmation and never written directly.
 *
 * `input` has already been validated against the core's CreateItemInput in main,
 * so anything that reaches the renderer is something the vault would accept. The
 * confirmation step is about intent, not validity.
 */
export interface ItemDraft {
  input: CreateItemInput;
  /** What Claude assumed or could not determine. Shown above the form. */
  notes: string;
}

/**
 * Which palette the app renders in.
 *
 * Electron's own `nativeTheme.themeSource` vocabulary, adopted rather than
 * reinvented, because that property is what this drives. Three states rather
 * than a boolean: nothing in a two-position switch can express "I have no
 * opinion", so a toggle would strand the user the first time they pressed it,
 * with "follow the OS" unreachable forever.
 *
 * `system` is the default, and an absent key in settings.json means `system` —
 * which is today's behaviour spelled out rather than changed.
 */
export type ThemePreference = "system" | "light" | "dark";

export interface VaultApi {
  /** Current snapshot, or null if no vault is configured yet. */
  getSnapshot(): Promise<Result<MaybeSnapshot>>;
  /** Native folder picker. Null when the dialog was cancelled. */
  chooseVault(): Promise<Result<MaybeSnapshot>>;
  /** Open a specific path, for the "use the example vault" shortcut. */
  openVault(root: string): Promise<Result<MaybeSnapshot>>;
  /** Create a vault in an empty folder, so a first run is not a dead end. */
  initVault(root: string): Promise<Result<MaybeSnapshot>>;
  /** Re-read from disk. The watcher does this automatically; this is the manual nudge. */
  reload(): Promise<Result<MaybeSnapshot>>;

  listItems(filter: Partial<ItemFilter>): Promise<Result<{ total: number; items: Item[] }>>;
  getAgenda(scope: AgendaScope): Promise<Result<AgendaView[]>>;
  /**
   * Children, backlinks, and the statuses behind this item's `item` links, for
   * the detail panel.
   *
   * `links` records a key, not an item, so a status has to be resolved from
   * somewhere and the renderer is the wrong place: it holds `visibleItems`,
   * which drops hidden projects, so a link pointing into one would resolve to
   * nothing and the absent pill would read as "no status" rather than "not
   * shown here". Main holds the whole vault, so it resolves them here — which
   * is what `backlinks` already does, unfiltered, for the same panel.
   *
   * `null` means the target is gone. `addLink` validates that it exists and
   * `doctor` checks for dangling item links anyway, because deleting the other
   * end still happens.
   */
  getRelated(key: string): Promise<
    Result<{
      children: Item[];
      backlinks: Item[];
      linked: Record<string, Status | null>;
    }>
  >;

  /**
   * A page of vault commits with their changes read back into vault terms.
   *
   * Pass `key` for one item's history, `project` to scope the global view, or
   * neither for the whole vault. `hasMore` on the result drives "Load more".
   */
  getHistory(query: HistoryQuery): Promise<Result<HistoryPage>>;

  /** Reveal an item's markdown, or an attachment, in the OS file manager. */
  revealPath(target: { kind: "item" | "attachment" | "vault"; value?: string }): Promise<Result<null>>;

  /**
   * Open a `file`/`folder` link, an attachment, or an external URL with the OS
   * default handler. Distinct from revealPath: this opens the target itself
   * rather than showing its containing folder, so it refuses executable
   * extensions and checks the external scheme allowlist rather than reusing
   * revealPath's vault-containment guard, which a `file` link is by definition
   * outside of.
   */
  openTarget(target: {
    kind: "attachment" | "file" | "folder" | "external";
    value: string;
  }): Promise<Result<null>>;

  // ------------------------------------------------------------- mutations
  // Each returns a fresh snapshot, so the renderer never reconciles a delta.

  createItem(input: CreateItemInput): Promise<Result<{ snapshot: VaultSnapshot; key: string }>>;
  updateItem(key: string, patch: UpdateItemInput): Promise<Result<VaultSnapshot>>;
  /**
   * Apply one patch to many items as a single commit — the backlog table's
   * multi-select. `updated`/`skipped` mirror BulkUpdateResult so the bar can
   * report "10 updated, 2 skipped" without reconciling item-by-item; the
   * snapshot is still the whole vault, same as every other mutation here.
   */
  updateItems(
    keys: string[],
    patch: BulkUpdateInput,
  ): Promise<
    Result<{
      snapshot: VaultSnapshot;
      updated: number;
      skipped: Array<{ key: string; reason: string }>;
    }>
  >;
  transitionItem(key: string, status: Status): Promise<Result<VaultSnapshot>>;
  /**
   * Log a recurring item as done for one period, leaving its status alone.
   * `on` defaults to today; `undo` removes that date instead of adding it.
   */
  tickItem(key: string, on?: string, undo?: boolean): Promise<Result<VaultSnapshot>>;
  /** Manual reorder. Positions are list positions — see Vault.moveItem. */
  moveItem(
    key: string,
    position: { after?: string; before?: string },
  ): Promise<Result<VaultSnapshot>>;

  addComment(key: string, body: string): Promise<Result<VaultSnapshot>>;
  addLink(
    key: string,
    link: { type: string; target: string; label?: string },
  ): Promise<Result<VaultSnapshot>>;
  removeLink(key: string, target: string): Promise<Result<VaultSnapshot>>;

  /**
   * The one git *write* across this boundary: set history up for the open vault
   * and prove a commit lands. Every outcome but `done` is a situation to explain
   * (no git, an ignoring outer repo, no identity yet) rather than an error, so
   * those come back as values and only a genuine git failure is `ok: false`.
   */
  turnOnHistory(
    options: TurnOnHistoryOptions,
  ): Promise<Result<{ result: TurnOnHistoryResult; snapshot: VaultSnapshot }>>;

  /**
   * Opens a native file picker in main, then attaches what was chosen.
   *
   * "Copy in" here is an explicit choice, so a file inside a OneDrive folder
   * is refused rather than downgraded — the core's message reaches the error
   * toast and names the "Link" button as the way through.
   */
  attachViaDialog(key: string, copy: boolean): Promise<Result<MaybeSnapshot>>;
  /**
   * For paths dropped onto the window, whose real values the renderer resolved.
   *
   * Unlike the picker, a drop has no dialog behind it, so main routes each path
   * by what it is: directories become `folder` links, and files inside a synced
   * folder are linked in place rather than copied. `linkedInstead` names those,
   * so the panel can say what happened instead of silently doing something
   * other than what the gesture implied.
   */
  attachPaths(
    key: string,
    paths: string[],
    copy: boolean,
  ): Promise<Result<{ snapshot: VaultSnapshot; linkedInstead: string[] }>>;

  /**
   * Trash an item. Without `cascade` this fails when the item has children, and
   * the message lists them — the renderer turns that into a confirmation rather
   * than deciding on the user's behalf.
   */
  deleteItem(
    key: string,
    cascade: boolean,
  ): Promise<Result<{ snapshot: VaultSnapshot; trashed: DeleteResult[] }>>;
  restoreItem(file: string): Promise<Result<VaultSnapshot>>;
  listTrash(): Promise<Result<TrashEntry[]>>;

  /** Notes read fresh from disk. The snapshot carries the same list; this is for a caller that wants it alone. */
  listScratch(): Promise<Result<{ notes: ScratchNote[]; errors: string[] }>>;
  /** Add a note. Resolves with it, so a caller can select it. */
  addScratch(text: string): Promise<Result<{ snapshot: VaultSnapshot; note: ScratchNote }>>;
  /** Trash a note. `file` in the result is what restoreScratch takes. */
  removeScratch(id: string): Promise<Result<{ snapshot: VaultSnapshot; removed: RemoveScratchResult }>>;
  listTrashedScratch(): Promise<Result<ScratchTrashEntry[]>>;
  restoreScratch(file: string): Promise<Result<{ snapshot: VaultSnapshot; note: ScratchNote }>>;

  createProject(input: {
    key: string;
    name: string;
    description?: string;
    category?: string;
    lead?: string;
  }): Promise<Result<VaultSnapshot>>;
  updateProject(key: string, patch: UpdateProjectInput): Promise<Result<VaultSnapshot>>;
  moveProject(
    key: string,
    position: { after?: string; before?: string },
  ): Promise<Result<VaultSnapshot>>;
  /**
   * Drop a project from the sidebar. Nothing is deleted and the CLI and MCP
   * server still list it — see Vault.hideProject.
   *
   * Fails while the project holds items that are not done or disregarded, and
   * the message names them. The sidebar disables the button before it gets that
   * far, so this is the backstop for the case where the last open item was
   * reopened from outside the app between render and click.
   */
  hideProject(key: string): Promise<Result<VaultSnapshot>>;
  unhideProject(key: string): Promise<Result<VaultSnapshot>>;

  // ------------------------------------------------------- optional Claude
  // Absent or unconfigured, every one of these still answers; the UI degrades
  // to the plain form rather than hiding it.

  claudeStatus(): Promise<Result<ClaudeStatus>>;
  /** One-way. There is no matching getter — the key never comes back out. */
  setClaudeKey(key: string): Promise<Result<ClaudeStatus>>;
  clearClaudeKey(): Promise<Result<ClaudeStatus>>;

  // ------------------------------------------------------------- Jira
  // Settings -> Jira. Same one-way rule as the Claude key: set and clear
  // answer with a status, and no call returns the token.

  jiraStatus(): Promise<Result<JiraStatus>>;
  /**
   * Verify against Jira, then store. A pair Jira refuses is never stored, so
   * a saved credential is always one that worked at least once.
   */
  setJiraCredentials(input: JiraCredentialInput): Promise<Result<JiraStatus>>;
  /** Re-check the stored pair: tokens expire, and this is how that shows up. */
  testJiraConnection(): Promise<Result<JiraStatus>>;
  /** The map in the open vault, read fresh. */
  jiraLoadMap(): Promise<Result<JiraMapState>>;
  /**
   * One project's issue types and every type's create-screen fields, read
   * with the stored credential. Setup wants them all, since which types will
   * be mapped is the question being answered.
   */
  jiraLoadMeta(projectKey: string): Promise<Result<ProjectMeta>>;
  /** Write the mapping into `jira-map.yaml`, comments kept, and commit it. */
  jiraSaveMap(choice: JiraMappingChoice): Promise<Result<JiraMapState>>;
  /** People Jira will accept as an assignee in this project, matching `query`. */
  jiraSearchPeople(projectKey: string, query: string): Promise<Result<JiraPerson[]>>;
  /**
   * Anyone on the site matching `query`, for a user field that is not the
   * assignee, such as a reviewer. Active human accounts only.
   */
  jiraSearchUsers(query: string): Promise<Result<JiraPerson[]>>;
  clearJiraCredentials(): Promise<Result<JiraStatus>>;

  /**
   * What pushing these items would send, checked against the project's own
   * create screens. Never sends. `askValues` are this push's choices for the
   * map's `ask` fields, by field id.
   */
  jiraPreviewPush(keys: string[], askValues: Record<string, unknown>): Promise<Result<JiraPushPreview>>;
  /**
   * Create the issues. The plan is rebuilt in main from the same keys and
   * values, not taken from the preview, and a plan with blockers is refused.
   * Progress arrives through `onJiraPushProgress` while this is pending.
   */
  jiraPush(
    keys: string[],
    askValues: Record<string, unknown>,
    /**
     * Per changed item to update, the field ids ticked and the ids shown. An
     * item not listed is left for a later push. Values are never sent from
     * here: main takes them from a fresh diff, and stamps the item only if
     * that diff holds nothing beyond what was shown.
     */
    updateFields: Record<string, JiraUpdateChoice>,
  ): Promise<Result<JiraPushOutcome>>;
  /**
   * Restamp a changed item whose Jira issue already matches it, after reading
   * Jira again to be sure. Nothing is sent to Jira.
   */
  jiraMarkInSync(localKey: string): Promise<Result<void>>;
  /**
   * Settle an uncertain attempt: `jiraKey` when the issue turned out to exist
   * (it is stamped as pushed), null when it did not (it can be pushed again).
   */
  jiraResolveUncertain(localKey: string, jiraKey: string | null): Promise<Result<void>>;
  onJiraPushProgress(listener: (progress: JiraPushProgress) => void): () => void;
  /**
   * Turn a sentence into a proposed item. Returns a draft for confirmation —
   * this never writes. `defaultProject` is the project the UI has in focus,
   * which Claude uses only when the prompt does not name one.
   */
  draftItem(prompt: string, defaultProject: string | null): Promise<Result<ItemDraft>>;

  /**
   * Real filesystem paths for dropped File objects. Electron removed
   * `File.path`, and `webUtils` is only reachable from the preload.
   */
  pathsForFiles(files: File[]): string[];

  /** The app's version, as package.json declares it. */
  getVersion(): Promise<Result<string>>;

  /** Subscribe to disk changes. Returns an unsubscribe function. */
  onChanged(listener: (snapshot: VaultSnapshot) => void): () => void;

  /** Suggested starting point: the example vault shipped with the repo, if present. */
  getSuggestedVault(): Promise<Result<string | null>>;

  // ---------------------------------------------------------------- theme
  /**
   * The preference in force, for labelling the control — never for rendering.
   *
   * Main applies the saved theme before the window is created, so by the time
   * this resolves the stylesheet has long since picked a palette. A label that
   * arrives one tick late is invisible; a palette that does is a flash of the
   * wrong scheme on every launch, which is why the two are separated.
   */
  getTheme(): Promise<Result<ThemePreference>>;
  /** Apply and persist, returning what was applied. */
  setTheme(preference: ThemePreference): Promise<Result<ThemePreference>>;
}

/** Channel names, kept beside the interface so both sides agree. */
export const CHANNELS = {
  getSnapshot: "vault:get-snapshot",
  chooseVault: "vault:choose",
  openVault: "vault:open",
  initVault: "vault:init",
  reload: "vault:reload",
  listItems: "vault:list-items",
  getAgenda: "vault:get-agenda",
  getRelated: "vault:get-related",
  getHistory: "vault:get-history",
  revealPath: "vault:reveal-path",
  openTarget: "vault:open-target",
  getSuggestedVault: "vault:suggested",

  createItem: "vault:create-item",
  updateItem: "vault:update-item",
  updateItems: "vault:update-items",
  transitionItem: "vault:transition-item",
  tickItem: "vault:tick-item",
  moveItem: "vault:move-item",
  addComment: "vault:add-comment",
  addLink: "vault:add-link",
  removeLink: "vault:remove-link",
  attachViaDialog: "vault:attach-dialog",
  attachPaths: "vault:attach-paths",
  deleteItem: "vault:delete-item",
  restoreItem: "vault:restore-item",
  listTrash: "vault:list-trash",
  listScratch: "scratch:list",
  addScratch: "scratch:add",
  removeScratch: "scratch:remove",
  listTrashedScratch: "scratch:list-trash",
  restoreScratch: "scratch:restore",
  createProject: "vault:create-project",
  updateProject: "vault:update-project",
  moveProject: "vault:move-project",
  hideProject: "vault:hide-project",
  unhideProject: "vault:unhide-project",
  turnOnHistory: "vault:turn-on-history",

  // Neither `vault:` nor `claude:` — the theme is a property of this machine's
  // app window and says nothing about what is open in it.
  getTheme: "app:get-theme",
  setTheme: "app:set-theme",

  claudeStatus: "claude:status",
  setClaudeKey: "claude:set-key",
  clearClaudeKey: "claude:clear-key",

  jiraStatus: "jira:status",
  setJiraCredentials: "jira:set-credentials",
  testJiraConnection: "jira:test-connection",
  jiraLoadMap: "jira:load-map",
  jiraLoadMeta: "jira:load-meta",
  jiraSaveMap: "jira:save-map",
  jiraSearchPeople: "jira:search-people",
  jiraSearchUsers: "jira:search-users",
  clearJiraCredentials: "jira:clear-credentials",
  jiraPreviewPush: "jira:preview-push",
  jiraPush: "jira:push",
  jiraResolveUncertain: "jira:resolve-uncertain",
  jiraMarkInSync: "jira:mark-in-sync",
  draftItem: "claude:draft",
  getVersion: "app:version",

  /** main -> renderer push */
  changed: "vault:changed",
  /** main -> renderer, while a push is running */
  jiraPushProgress: "jira:push-progress",
} as const;
