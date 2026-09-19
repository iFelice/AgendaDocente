import assert from "node:assert/strict";
import test from "node:test";
import { deriveScheduledAssessmentCalendarItems } from "../src/utils/scheduledAssessmentCalendar";
import type { Student, StudentScheduledAssessment } from "../src/types";

const student = (id: string, fullName: string, status?: Student["status"]): Student => ({ id, fullName, className: "2E", notes: [], status });
const item = (id: string, studentId: string, status: StudentScheduledAssessment["status"] = "scheduled", date = "2026-09-25"): StudentScheduledAssessment => ({ id, studentId, className: "2E", date, assessmentType: "written", topic: "Equazioni", subject: "Matematica", status, createdAt: date, updatedAt: date });

test("calendar view-model shows only scheduled assessments on their date", () => {
  const rows = deriveScheduledAssessmentCalendarItems([item("a", "s1"), item("done", "s1", "completed"), item("cancel", "s1", "cancelled")], [student("s1", "Mario Rossi")]);
  assert.deepEqual(rows.map(row => row.id), ["a"]);
  assert.equal(rows[0].date, "2026-09-25");
});

test("student name is resolved locally by id and duplicate names remain distinct", () => {
  const rows = deriveScheduledAssessmentCalendarItems([item("a", "s1"), item("b", "s2")], [student("s1", "Rossi Mario"), student("s2", "Rossi Mario")]);
  assert.deepEqual(rows.map(row => row.studentId), ["s1", "s2"]);
  assert.deepEqual(rows.map(row => row.studentName), ["Rossi Mario", "Rossi Mario"]);
});

test("missing and archived students are safe and no CalendarEvent is created", () => {
  const rows = deriveScheduledAssessmentCalendarItems([item("missing", "unknown"), item("archived", "old")], [student("old", "Studente archiviato", "archived")]);
  assert.equal(rows[0].studentName, "Studente non disponibile");
  assert.equal(rows[1].studentName, "Studente archiviato");
  assert.equal((rows[0] as { title?: string }).title, undefined);
  assert.equal(rows[0].kind, "scheduled-assessment");
});
