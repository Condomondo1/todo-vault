/**
 * Jira's names for fields, where a request or an error gives only ids.
 *
 * Pure, and apart from `jira-push.ts`, which imports Electron, so the tests
 * can reach it.
 */
import { fieldOn, issueTypeNamed, type ProjectMeta } from "todo-vault/jira-meta";

/** A field's name on one issue type's create screen, or its id when the project does not say. */
export function fieldName(meta: ProjectMeta, issueType: string, fieldId: string): string {
  const type = issueTypeNamed(meta, issueType);
  return (type && fieldOn(type, fieldId)?.name) ?? fieldId;
}

/**
 * A failure's field errors under the names a person sees in Jira, not
 * `customfield_10001`. The message carries the same `id: error` lines, so
 * they are renamed there too.
 *
 * `nameOf` is the screen the request went to: the create screen for a
 * create (`fieldName` on its issue type), the edit screen for an update.
 * Undefined when nothing is known to name them by.
 */
export function namedFieldErrors<F extends { message: string; fieldErrors: Record<string, string> }>(
  failure: F,
  nameOf: ((fieldId: string) => string) | undefined,
): F {
  if (!nameOf || Object.keys(failure.fieldErrors).length === 0) return failure;
  let message = failure.message;
  const fieldErrors: Record<string, string> = {};
  for (const [id, error] of Object.entries(failure.fieldErrors)) {
    const name = nameOf(id);
    fieldErrors[name] = error;
    if (name !== id) message = message.split(`${id}: `).join(`${name}: `);
  }
  return { ...failure, message, fieldErrors };
}
