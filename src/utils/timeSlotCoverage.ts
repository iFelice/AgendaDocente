import type { SchoolProfile, SchoolWeekday, TeacherProfile, TimeSlotConfig } from "../types";
import { normalizeTeacherProfile } from "./multiSchool";
import { maxPeriodsInWeek } from "./schoolDayPeriods";
import { getEffectivePeriodSlots, timeSlotConfigForSchool } from "./timeSlots";

/** A school whose longest day has no corresponding real bell slot yet. */
export interface MissingTimeSlotCoverage {
  schoolId: string;
  schoolName: string;
  requiredPeriods: number;
  effectivePeriods: number;
}

/** One-shot navigation request from the coverage warning to the existing drawer. */
export interface TimeSlotConfigOpenRequest {
  schoolId: string;
  requestId: number;
}

/**
 * Finds schools whose day structure extends beyond their configured bells.
 *
 * Pure detection only: this deliberately does not generate, resize, or persist
 * slots. The existing timetable drawer owns that workflow and keeps its
 * explicit confirmation step.
 */
export function findMissingTimeSlotCoverage(
  profile: TeacherProfile,
  globalConfig: TimeSlotConfig | undefined,
  weekdays: readonly SchoolWeekday[]
): MissingTimeSlotCoverage[] {
  const schools = normalizeTeacherProfile(profile).schools ?? [];

  return schools.flatMap((school: SchoolProfile) => {
    if (!school.isPrimary && school.active === false) return [];
    const config = timeSlotConfigForSchool(school, globalConfig);
    const requiredPeriods = maxPeriodsInWeek(weekdays, school, config);
    const effectivePeriods = getEffectivePeriodSlots(config).length;
    return requiredPeriods > effectivePeriods
      ? [{ schoolId: school.id, schoolName: school.name, requiredPeriods, effectivePeriods }]
      : [];
  });
}
