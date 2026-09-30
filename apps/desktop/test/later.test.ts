import assert from "node:assert/strict";
import test from "node:test";

import type { Item } from "todo-vault";
import { isLater } from "../src/renderer/src/later.js";

type Laterable = Parameters<typeof isLater>[0];

/** A plain open one-off, overridden per case. */
function item(over: Partial<Laterable> = {}): Laterable {
  return { status: "todo", cadence: "none", completions: [], ...over };
}

const TODAY = "2026-09-29"; // a Tuesday

test("a todo whose start is still ahead is later; today or earlier is not", () => {
  assert.equal(isLater(item({ startDate: "2026-09-30" }), TODAY), true);
  assert.equal(isLater(item({ startDate: TODAY }), TODAY), false, "starting today is actionable today");
  assert.equal(isLater(item({ startDate: "2026-09-01" }), TODAY), false);
  assert.equal(isLater(item(), TODAY), false, "no start date means no reason to wait");
});

test("a future start only defers work that has not begun", () => {
  for (const status of ["in_progress", "in_review", "blocked"] as const) {
    assert.equal(
      isLater(item({ status, startDate: "2026-12-01" }), TODAY),
      false,
      `${status} has begun whatever the date says`,
    );
  }
});

test("a recurring item ticked for the current period is later until the period turns", () => {
  const daily = item({ cadence: "daily", completions: [TODAY] });
  assert.equal(isLater(daily, TODAY), true);
  assert.equal(isLater(daily, "2026-09-30"), false, "tomorrow is a new day's turn");

  // Ticked Monday; the week runs on through Sunday.
  const weekly = item({ cadence: "weekly", completions: ["2026-09-28"] });
  assert.equal(isLater(weekly, TODAY), true);

  const unticked = item({ cadence: "weekly", completions: ["2026-09-20"] });
  assert.equal(isLater(unticked, TODAY), false, "last week's tick does not settle this week");
});

test("closed items are never later — Hide closed owns those", () => {
  const statuses: Item["status"][] = ["done", "disregard"];
  for (const status of statuses) {
    assert.equal(isLater(item({ status, startDate: "2026-12-01" }), TODAY), false);
    assert.equal(isLater(item({ status, cadence: "daily", completions: [TODAY] }), TODAY), false);
  }
});
