export {
  Vault,
  VaultError,
  pushableFields,
  compareByRank,
  compareProjectsByRank,
  TURN_ON_HISTORY_SUBJECT,
} from "./vault.js";
export type {
  VaultOptions,
  AgendaBand,
  AgendaSection,
  DeleteResult,
  DeleteProjectResult,
  MoveProjectResult,
  BulkUpdateResult,
  TrashEntry,
  GitStatus,
  TurnOnHistoryOptions,
  TurnOnHistoryResult,
  HistoryQuery,
} from "./vault.js";
export { parseGitLog, diffFrontmatter, diffArray, keyFromPath } from "./history.js";
export type {
  EntryChange,
  FieldChange,
  FileChange,
  FileChangeKind,
  HistoryEntry,
  HistoryPage,
} from "./history.js";
export { diffLines } from "./text-diff.js";
export type { DiffLine, TextDiff } from "./text-diff.js";
export * from "./schema.js";
export { parseFrontmatter, serializeFrontmatter } from "./markdown.js";
export {
  RANK_GAP,
  rankBetween,
  toPosixPath,
  fromPosixPath,
  todayIso,
  // Exported for consumers that surface errors to people: the write paths
  // validate with zod's .parse(), whose default message is the raw issue array.
  formatZodError,
} from "./util.js";
export {
  parseDescription,
  serializeDescription,
  isLosslessDescription,
} from "./description.js";
export type { Block, Inline } from "./description.js";
export { isSyncedPath, syncedRootFor } from "./links.js";
export { classifyLinkTarget } from "./link-target.js";
export type { LinkTargetKind } from "./link-target.js";
export { cadencePeriod, isTickedFor, isSettledForWindow } from "./recurrence.js";
export type { Tickable } from "./recurrence.js";
export {
  blocksToWiki,
  buildPushPlan,
  jiraMapPath,
  loadJiraMap,
  writeJiraMap,
  markdownToAdf,
  selectPushable,
  toJiraCsv,
  JiraMapSchema,
} from "./jira.js";
export {
  apiRoot,
  createJiraClient,
  normaliseBaseUrl,
  resolveCloudId,
  retryAfterMs,
  JiraError,
} from "./jira-client.js";
export type {
  JiraAuthKind,
  JiraClient,
  JiraClientOptions,
  JiraErrorKind,
  JiraMyself,
} from "./jira-client.js";
export {
  ALWAYS_SENT,
  distinctFields,
  fetchFieldsFor,
  fetchIssueTypes,
  fetchProject,
  fetchProjectMeta,
  fieldOn,
  issueTypeNamed,
  requiredGaps,
  searchAssignable,
  valueKindFor,
} from "./jira-meta.js";
export type {
  FieldValueKind,
  IssueTypeMeta,
  JiraFieldMeta,
  JiraFieldSchema,
  JiraUser,
  ProjectMeta,
} from "./jira-meta.js";
export type {
  JiraMap,
  JiraMapEdit,
  JiraPushBlocker,
  JiraPushPlan,
  JiraIssueDraft,
  PushPlanOptions,
  JiraCsvColumn,
  JiraCsvOptions,
  JiraCsvResult,
  PushSelection,
} from "./jira.js";
