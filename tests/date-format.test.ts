import assert from "node:assert/strict";
import test from "node:test";
import { formatCivilDateIt } from "../src/utils/dates";

test("formatCivilDateIt formats civil ISO dates in Italian order with padding", () => {
  assert.equal(formatCivilDateIt("2026-12-03"), "03/12/2026");
  assert.equal(formatCivilDateIt("2026-09-05"), "05/09/2026");
  assert.equal(formatCivilDateIt("2027-01-01"), "01/01/2027");
});

test("formatCivilDateIt does not use UTC or change the stored civil date", () => {
  const iso = "2026-03-29";
  assert.equal(formatCivilDateIt(iso), "29/03/2026");
  assert.equal(iso, "2026-03-29");
  assert.equal(formatCivilDateIt("not-a-date"), "not-a-date");
});
