/**
 * Whether the three package.json files declare the same version.
 *
 * The root, the core and the desktop app are built and shipped together, so one
 * number describes all of them. Nothing makes that so except this: `npm version`
 * bumps whatever it is pointed at, and the MCP handshake reads the core's
 * package.json while the app's sidebar reads the desktop's. A bump that missed
 * one would leave the two reporting different versions of the same build.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./shared.mjs";

export const VERSIONED_FILES = ["package.json", "packages/core/package.json", "apps/desktop/package.json"];

/** The versions the files declare, keyed by path. A file with none maps to null. */
export function readVersions(root: string = REPO_ROOT): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const file of VERSIONED_FILES) {
    const parsed = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { version?: unknown };
    out[file] = typeof parsed.version === "string" ? parsed.version : null;
  }
  return out;
}

/** What is wrong with these versions, one sentence each; empty when they agree. */
export function versionProblems(versions: Record<string, string | null>): string[] {
  const problems = Object.entries(versions)
    .filter(([, v]) => v === null)
    .map(([file]) => `${file} declares no version`);
  const distinct = new Set(Object.values(versions).filter((v) => v !== null));
  if (distinct.size > 1) {
    const listing = Object.entries(versions)
      .map(([file, v]) => `${file} is ${v}`)
      .join(", ");
    problems.push(`the versions differ: ${listing}`);
  }
  return problems;
}
