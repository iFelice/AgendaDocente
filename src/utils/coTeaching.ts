import type { TimetableSlot } from "../types";

/**
 * Co-teaching ("compresenza") helpers shared by the timetable editor, Today, Week and sync.
 *
 * The model is role-agnostic and fully optional (old TimetableSlot documents without these
 * fields stay valid everywhere):
 *  - support teacher: coTeachingSubjects (curricular subjects followed during the hour) and
 *    coSupportTeachers (other support teachers present);
 *  - curricular teacher: supportTeachers (support teachers joining the hour).
 *
 * Teacher names are free-form "Nome Cognome" strings (normalized via formatPersonDisplayName)
 * with suggestions collected from names already used in the timetable. The shape is designed
 * so a future school directory can replace/augment the suggestion source without migrations.
 */

const cleanList = (value: string[] | undefined): string[] =>
  Array.isArray(value) ? value.map(v => String(v).trim()).filter(Boolean) : [];

export function coTeachingSubjectsOf(slot: TimetableSlot): string[] {
  return cleanList(slot.coTeachingSubjects);
}

export function coSupportTeachersOf(slot: TimetableSlot): string[] {
  return cleanList(slot.coSupportTeachers);
}

export function supportTeachersOf(slot: TimetableSlot): string[] {
  return cleanList(slot.supportTeachers);
}

/**
 * Compact one-line summary for timetable cards, e.g.:
 *  - support:    "Compresenza: Matematica · Con: Prof.ssa Rossi"
 *  - curricular: "Sostegno: Prof. Bianchi, Prof.ssa Verdi"
 * Returns null when the slot has no co-teaching information (old slots included).
 */
export function coTeachingSummary(slot: TimetableSlot): string | null {
  const subjects = coTeachingSubjectsOf(slot);
  const coTeachers = coSupportTeachersOf(slot);
  const supportTeachers = supportTeachersOf(slot);
  if (!subjects.length && !coTeachers.length && !supportTeachers.length) return null;
  const parts: string[] = [];
  if (subjects.length) parts.push(`Compresenza: ${subjects.join(", ")}`);
  if (coTeachers.length) parts.push(`Con: ${coTeachers.join(", ")}`);
  if (supportTeachers.length) parts.push(`Sostegno: ${supportTeachers.join(", ")}`);
  return parts.join(" · ");
}

/** True when the slot carries any co-teaching information. */
export function hasCoTeaching(slot: TimetableSlot): boolean {
  return coTeachingSummary(slot) !== null;
}

/**
 * All teacher names already used in the given timetables (support and curricular side),
 * de-duplicated and alphabetically sorted. Used for datalist suggestions; a future school
 * directory can extend or replace this source.
 */
export function collectKnownTeacherNames(...timetables: TimetableSlot[][]): string[] {
  const names = new Set<string>();
  for (const timetable of timetables) {
    for (const slot of timetable) {
      for (const name of coSupportTeachersOf(slot)) names.add(name);
      for (const name of supportTeachersOf(slot)) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, "it"));
}

/** Removes empty co-teaching fields so saved slots stay clean when nothing was entered. */
export function pruneCoTeachingFields(slot: TimetableSlot): TimetableSlot {
  const pruned: TimetableSlot = { ...slot };
  if (!coTeachingSubjectsOf(pruned).length) delete pruned.coTeachingSubjects;
  if (!coSupportTeachersOf(pruned).length) delete pruned.coSupportTeachers;
  if (!supportTeachersOf(pruned).length) delete pruned.supportTeachers;
  return pruned;
}
