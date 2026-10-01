import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APP_NAME } from "../src/shared/app-name.js";

test("the page title is the app name", () => {
  // The page <title> replaces the window's title on load, so a drift between
  // the two shows the old name for as long as the window is open.
  const html = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];

  assert.equal(title, APP_NAME);
});
