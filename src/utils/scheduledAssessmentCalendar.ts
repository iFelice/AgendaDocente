import type { Student, StudentScheduledAssessment } from "../types";

export const scheduledAssessmentTypeLabel: Record<StudentScheduledAssessment["assessmentType"], string> = { oral: "Interrogazione", written: "Verifica scritta", practical: "Prova pratica", other: "Altro" };

export interface ScheduledAssessmentCalendarItem {
  kind: "scheduled-assessment";
  id: string;
  date: string;
  studentId: string;
  studentName: string;
  subject?: string;
  assessmentType: StudentScheduledAssessment["assessmentType"];
  topic?: string;
  status: "scheduled";
}

/** View-model only: no persistence or CalendarEvent conversion. */
export function deriveScheduledAssessmentCalendarItems(
  assessments: StudentScheduledAssessment[],
  students: Student[],
): ScheduledAssessmentCalendarItem[] {
  const names = new Map(students.map(student => [student.id, student.fullName]));
  return assessments
    .filter(item => item.status === "scheduled")
    .map(item => ({
      kind: "scheduled-assessment" as const,
      id: item.id,
      date: item.date,
      studentId: item.studentId,
      studentName: names.get(item.studentId) || "Studente non disponibile",
      ...(item.subject ? { subject: item.subject } : {}),
      assessmentType: item.assessmentType,
      ...(item.topic ? { topic: item.topic } : {}),
      status: "scheduled" as const,
    }));
}
