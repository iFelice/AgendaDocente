import assert from "node:assert/strict";
import test from "node:test";
import { readDailyCollapse, writeDailyCollapse, readWeeklyCollapse, writeWeeklyCollapse, defaultCollapseState } from "../src/utils/collapsePreferences";

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) };

test("collapse defaults are open and daily preferences are date scoped", () => {
  store.clear();
  assert.deepEqual(readDailyCollapse("2099-09-19"), defaultCollapseState());
  const state = { timetable: true, scheduledAssessments: false, commitments: true };
  writeDailyCollapse("2099-09-19", state);
  assert.deepEqual(readDailyCollapse("2099-09-19"), state);
  assert.deepEqual(readDailyCollapse("2099-09-20"), defaultCollapseState());
});

test("weekly preferences persist independently and corrupt storage falls back safely", () => {
  store.clear();
  writeWeeklyCollapse({ timetable: true, scheduledAssessments: false, commitments: false });
  assert.equal(readWeeklyCollapse().timetable, true);
  store.set("agenda-docente:weekly-collapse:v1", "not-json");
  assert.deepEqual(readWeeklyCollapse(), defaultCollapseState());
});
