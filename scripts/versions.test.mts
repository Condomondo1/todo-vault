import assert from "node:assert/strict";
import test from "node:test";

import { readVersions, versionProblems } from "./versions.mjs";

test("matching versions are fine", () => {
  assert.deepEqual(versionProblems({ a: "0.9.0", b: "0.9.0", c: "0.9.0" }), []);
});

test("a package left behind by a bump is named with its version", () => {
  const problems = versionProblems({ "package.json": "0.9.1", "packages/core/package.json": "0.9.0" });

  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /package\.json is 0\.9\.1/);
  assert.match(problems[0]!, /packages\/core\/package\.json is 0\.9\.0/);
});

test("a missing version is reported rather than read as a difference", () => {
  const problems = versionProblems({ a: "0.9.0", b: null });

  assert.deepEqual(problems, ["b declares no version"]);
});

test("the repo's own package.json files agree", () => {
  // The check this file exists for: CI runs the suite on every push, so a bump
  // that touched two of the three fails here.
  assert.deepEqual(versionProblems(readVersions()), []);
});
