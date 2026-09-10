import type { CalendarEvent, CircularDocument, SchoolProfile, TeacherProfile, TimetableSlot } from "../types";

/** Stable identity for the legacy school. It deliberately does not use a random UUID. */
export function legacyPrimarySchoolId(profile: Pick<TeacherProfile, "id" | "schoolName">): string {
  const source = `${profile.id}|${profile.schoolName.trim().toLocaleLowerCase()}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `school-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function createPrimarySchool(profile: TeacherProfile): SchoolProfile {
  return {
    id: legacyPrimarySchoolId(profile),
    name: profile.schoolName,
    institutionalEmail: profile.email,
    campuses: [...(profile.campuses ?? [])],
    schoolLevel: profile.schoolLevel,
    weeklyHours: undefined,
    isPrimary: true,
    active: true,
  };
}

/**
 * Idempotent compatibility boundary. Legacy scalar fields remain the source of truth
 * for the existing UI; schools is an additive projection until school editing is complete.
 */
export function normalizeTeacherProfile(input: TeacherProfile): TeacherProfile {
  const profile = structuredClone(input);
  const schools = Array.isArray(profile.schools) ? profile.schools.filter(s => s && typeof s.id === "string" && typeof s.name === "string") : [];
  if (schools.length === 0) profile.schools = [createPrimarySchool(profile)];
  else {
    const primary = schools.find(s => s.isPrimary) ?? schools[0];
    // Legacy scalar fields are still edited by the current UI. Keep the primary id
    // stable, but refresh its projection on every normalization.
    const primaryProjection: SchoolProfile = {
      ...primary,
      name: profile.schoolName,
      institutionalEmail: profile.email,
      campuses: [...(profile.campuses ?? [])],
      schoolLevel: profile.schoolLevel,
      isPrimary: true,
      active: true,
    };
    profile.schools = [primaryProjection, ...schools.filter(s => s !== primary && s.id !== primary.id)
      .map(s => ({ ...s, active: s.active ?? true, isPrimary: false }))];
  }
  return profile;
}

/** The dormant UI flag is derived only from active secondary institutes. */
export function hasActiveSecondarySchool(profile: TeacherProfile): boolean {
  return (profile.schools ?? []).some(s => !s.isPrimary && s.active !== false);
}

const primaryId = (profile: TeacherProfile) => normalizeTeacherProfile(profile).schools!.find(s => s.isPrimary)?.id;
export function withLegacySchoolId<T extends { schoolId?: string }>(value: T, profile: TeacherProfile): T {
  return value.schoolId ? value : { ...value, schoolId: primaryId(profile) };
}
export function normalizeSchoolLinkedData(data: any): any {
  const profile = normalizeTeacherProfile(data.profile);
  return {
    ...data,
    profile,
    events: data.events.map(event => event.schoolId ? event : event.category === "lezione" || event.sourceType === "circolare" ? withLegacySchoolId(event, profile) : event),
    circulars: data.circulars.map(c => withLegacySchoolId(c, profile)),
    definitiveTimetable: data.definitiveTimetable.map(s => withLegacySchoolId(s, profile)),
    provisionalTimetable: data.provisionalTimetable.map(s => withLegacySchoolId(s, profile)),
  };
}

/** Returns overlapping lessons, including overlaps across different schools. */
export function findTimetableConflicts(slots: TimetableSlot[]): Array<{ first: TimetableSlot; second: TimetableSlot }> {
  const conflicts: Array<{ first: TimetableSlot; second: TimetableSlot }> = [];
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
    const a = slots[i], b = slots[j];
    if (a.dayOfWeek === b.dayOfWeek && a.startTime < b.endTime && b.startTime < a.endTime && a.schoolId !== b.schoolId) conflicts.push({ first: a, second: b });
  }
  return conflicts;
}
