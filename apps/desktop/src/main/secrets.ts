import { promises as fs } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";

/**
 * Credentials persisted between launches: the Anthropic API key, and the Jira
 * email and token pair.
 *
 * Encrypted at rest with Electron's safeStorage, which defers to the OS
 * credential store (Keychain, DPAPI, or a Linux keyring) instead of this app
 * rolling its own crypto. Everything here is main-process only — a secret must
 * never cross IPC to the renderer, so there is deliberately no IPC-safe
 * accessor for one. secretStatus() exists so the renderer can ask whether a
 * secret is configured without ever seeing it.
 *
 * Named rather than one module per secret, so the rules below exist once. The
 * second secret arriving is exactly when a copied module would start to drift
 * from the first.
 */

export type SecretName = "claude" | "jira";

/** One file each, beside settings.json. Listed so an uninstall can find them all. */
const SECRET_FILES: Record<SecretName, string> = {
  claude: "claude-key.bin",
  jira: "jira-credentials.bin",
};

/** How each secret is named in a message a person reads. */
const SECRET_LABELS: Record<SecretName, string> = {
  claude: "API key",
  jira: "Jira credentials",
};

/** Whether a secret can be stored at all, and whether one already is. */
export interface SecretStatus {
  /** safeStorage can actually encrypt on this machine. */
  available: boolean;
  hasKey: boolean;
  /** Why storage is unavailable, written for a human. Absent when available. */
  reason?: string;
}

function secretPath(name: SecretName): string {
  // Not a module-level constant: app.getPath is unsafe to call before the
  // app is ready, same reasoning as settingsPath() in settings.ts.
  return path.join(app.getPath("userData"), SECRET_FILES[name]);
}

export async function secretStatus(name: SecretName): Promise<SecretStatus> {
  const available = safeStorage.isEncryptionAvailable();

  let hasKey: boolean;
  try {
    await fs.access(secretPath(name));
    hasKey = true;
  } catch {
    hasKey = false;
  }

  if (!available) {
    return {
      available,
      hasKey,
      reason:
        "No OS credential store is available on this system (Keychain, DPAPI, or a Linux keyring), so a secret cannot be encrypted for storage.",
    };
  }

  return { available, hasKey };
}

/**
 * Rejects when safeStorage is unavailable, rather than writing plaintext.
 * `value` is stored exactly as given; callers trim or serialise first.
 */
export async function setSecret(name: SecretName, value: string): Promise<void> {
  if (!value) throw new Error(`${SECRET_LABELS[name]} cannot be empty.`);

  // No plaintext fallback: a secret that can't be encrypted is a secret that
  // doesn't get stored. Silently writing it in the open here is exactly the
  // failure mode this module exists to prevent.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      `Cannot save the ${SECRET_LABELS[name]}: no OS credential store is available on this machine to encrypt it with.`,
    );
  }

  const target = secretPath(name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, safeStorage.encryptString(value));
}

/** Null when absent or undecryptable. Main process only — never send this over IPC. */
export async function getSecret(name: SecretName): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;

  let encrypted: Buffer;
  try {
    encrypted = await fs.readFile(secretPath(name));
  } catch {
    return null;
  }

  try {
    return safeStorage.decryptString(encrypted);
  } catch {
    // The OS keychain changed, the user migrated machines, or the file is
    // corrupt — all legitimate. An undecryptable secret is not an error state
    // for the caller, it's the same as having none at all.
    return null;
  }
}

export async function clearSecret(name: SecretName): Promise<void> {
  try {
    await fs.unlink(secretPath(name));
  } catch (err) {
    // Already gone is success, not failure.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ------------------------------------------------------------ the Claude key
// Kept as named wrappers so the Claude layer reads as it always did.

export const setApiKey = (key: string): Promise<void> => setSecret("claude", key.trim());
export const getApiKey = (): Promise<string | null> => getSecret("claude");
export const clearApiKey = (): Promise<void> => clearSecret("claude");
