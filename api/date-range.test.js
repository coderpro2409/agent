import test from "node:test";
import assert from "node:assert/strict";
import { getUtcDayRange } from "./date-range.js";

test("builds an inclusive/exclusive UTC range for one calendar day", () => {
  const range = getUtcDayRange("2026-07-18");
  assert.equal(range.date, "2026-07-18");
  assert.equal(range.start.toISOString(), "2026-07-18T00:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-07-19T00:00:00.000Z");
});

test("handles leap days and rejects impossible dates", () => {
  assert.equal(getUtcDayRange("2024-02-29").end.toISOString(), "2024-03-01T00:00:00.000Z");
  assert.equal(getUtcDayRange("2026-02-29"), null);
  assert.equal(getUtcDayRange("18-07-2026"), null);
});

test("uses the supplied current day when no date is provided", () => {
  const now = new Date("2026-07-18T21:15:00.000Z");
  assert.equal(getUtcDayRange("", now).date, "2026-07-18");
});
