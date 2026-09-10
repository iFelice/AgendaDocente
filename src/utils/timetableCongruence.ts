/**
 * Utility functions for calculating timetable congruence with declared weekly hours.
 * 
 * Key design:
 * - Internally uses minutes for precision (50min, 55min, 60min slots, etc.)
 * - Converts to hours only for UI display
 * - Calculates per-school totals for multi-institute scenarios
 * - Handles legacy profiles without weeklyDeclaredHours (defaults to 18)
 */
import type { TimetableSlot, TeacherProfile } from "../types";
import {
  calculatePrimaryExpectedHours,
  calculateTotalDeclaredHours,
  getOtherActiveSchools,
  getPrimarySchool,
} from "../utils/multiSchool";

/** Converts a "HH:MM" time string to minutes after midnight */
export function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(":");
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  return h * 60 + m;
}

/** Converts minutes after midnight to "HH:MM" format */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Calculates the duration in minutes between start and end time strings */
export function slotDurationMinutes(startTime: string, endTime: string): number {
  return timeToMinutes(endTime) - timeToMinutes(startTime);
}

/** Calculates total planned hours (in minutes) for a single timetable slot */
export function calculateSlotMinutes(slot: TimetableSlot): number {
  return slotDurationMinutes(slot.startTime, slot.endTime);
}

/** Calculates total planned hours (in minutes) for all slots on a specific day of week */
export function calculateDayTotalMinutes(timetable: TimetableSlot[], dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6): number {
  const daySlots = timetable.filter(slot => slot.dayOfWeek === dayOfWeek);
  return daySlots.reduce((total, slot) => total + slotDurationMinutes(slot.startTime, slot.endTime), 0);
}

/** Calculates total planned hours (in minutes) across the entire timetable */
export function calculateTotalTimetableMinutes(timetable: TimetableSlot[]): number {
  return timetable.reduce((total, slot) => total + slotDurationMinutes(slot.startTime, slot.endTime), 0);
}

/** Calculates total planned hours grouped by schoolId */
export function calculateTimetableBySchoolMinutes(timetable: TimetableSlot[]): Record<string, number> {
  const bySchool: Record<string, number> = {};
  timetable.forEach(slot => {
    const schoolId = slot.schoolId ?? "primary";
    bySchool[schoolId] = (bySchool[schoolId] || 0) + slotDurationMinutes(slot.startTime, slot.endTime);
  });
  return bySchool;
}

/** Gets the declared weekly hours for a profile, defaulting to 18 for legacy profiles */
export function getDeclaredWeeklyHours(profile: TeacherProfile): number {
  return (profile.weeklyDeclaredHours ?? 18);
}

/** 
 * Calculates congruence between the planned timetable and declared weekly hours.
 * Returns an object with total and per-school breakdowns and warnings.
 */
export function calculateCongruence(
  timetable: TimetableSlot[],
  profile: TeacherProfile
): {
  totalPlannedMinutes: number;
  totalDeclaredMinutes: number;
  totalDifferenceMinutes: number;
  bySchool: Record<string, { plannedMinutes: number; declaredMinutes: number; differenceMinutes: number }>;
  isTotalCongruent: boolean;
  isBySchoolCongruent: boolean;
  warnings: string[];
} {
  const declaredHours = getDeclaredWeeklyHours(profile);
  const declaredMinutes = declaredHours * 60;
  const totalPlanned = calculateTotalTimetableMinutes(timetable);
  const bySchool = calculateTimetableBySchoolMinutes(timetable);
  const bySchoolDeclared = calculateTimetableBySchoolMinutes(
    timetable.map(slot => ({ ...slot, schoolId: slot.schoolId ?? "primary" }))
  );

  // Build per-school declared hours - use the multi-school distribution
  const otherSchools = getOtherActiveSchools(profile);
  const primarySchool = getPrimarySchool(profile);
  const primaryExpected = calculatePrimaryExpectedHours(declaredHours, otherSchools);

  // Calculate per-school congruence
  const schoolCongruence: Record<string, { plannedMinutes: number; declaredMinutes: number; differenceMinutes: number }> = {};
  const allSchoolIds = new Set([...Object.keys(bySchool), ...Object.keys(bySchoolDeclared)]);

  allSchoolIds.forEach(schoolId => {
    const planned = bySchool[schoolId] || 0;
    // For primary school, use the derived expected hours
    let declaredForSchool: number;
    if (schoolId === "primary") {
      declaredForSchool = primaryExpected * 60;
    } else {
      // For other schools, use their declared weeklyHours
      const otherSchool = otherSchools.find(s => s.id === schoolId);
      declaredForSchool = (otherSchool?.weeklyHours ?? 0) * 60;
    }
    const difference = planned - declaredForSchool;
    schoolCongruence[schoolId] = { plannedMinutes: planned, declaredMinutes: declaredForSchool, differenceMinutes: difference };
  });

  // Overall congruence
  const isTotalCongruent = Math.abs(totalPlanned - declaredMinutes) <= 5; // 5 min tolerance
  const allSchoolsOk = Object.values(schoolCongruence).every(
    s => Math.abs(s.differenceMinutes) <= 5
  );
  const isBySchoolCongruent = allSchoolsOk;

  // Generate warnings
  const warnings: string[] = [];

  if (!isTotalCongruent) {
    const over = totalPlanned > declaredMinutes;
    warnings.push(
      over
        ? `L'orario pianificato supera il monte ore dichiarato di ${Math.round((totalPlanned - declaredMinutes) / 60)} h`
        : `L'orario pianificato è inferiore di ${Math.round((declaredMinutes - totalPlanned) / 60)} h al monte ore dichiarato`
    );
  }

  // Per-school warnings
  Object.entries(schoolCongruence).forEach(([schoolId, school]) => {
    const diffHours = school.differenceMinutes / 60;
    if (Math.abs(diffHours) > 1 || Math.abs(school.differenceMinutes) > 30) {
      const schoolName = schoolId === "primary" ? "Istituto principale" : `Istituto ${schoolId}`;
      const over = school.differenceMinutes > 0;
      warnings.push(
        `${schoolName}: ${over ? "supera" : "è inferiore di"} ${Math.abs(diffHours).toFixed(1)} h ${over ? "(totale)" : ""}`
      );
    }
  });

  // Distribution warning: total is correct but per-school distribution is off
  if (isTotalCongruent && !isBySchoolCongruent) {
    warnings.push("La distribuzione oraria per scuola non è coerente con il monte ore totale dichiarato");
  }

  return {
    totalPlannedMinutes: totalPlanned,
    totalDeclaredMinutes: declaredMinutes,
    totalDifferenceMinutes: totalPlanned - declaredMinutes,
    bySchool: schoolCongruence,
    isTotalCongruent,
    isBySchoolCongruent,
    warnings,
  };
}

/** 
 * Gets UI-ready congruence status with amber warning messages.
 * Does NOT prevent saving, only returns messages.
 */
export function getCongruenceStatus(
  timetable: TimetableSlot[],
  profile: TeacherProfile
): {
  totalPlannedHours: number;
  totalDeclaredHours: number;
  differenceHours: number;
  totalWarning: string | null;
  bySchoolWarnings: Array<{ schoolId: string; label: string; warning: string }>;
  isConsistent: boolean;
} {
  const declaredHours = getDeclaredWeeklyHours(profile);
  const congruence = calculateCongruence(timetable, profile);

  const totalPlannedHours = congruence.totalPlannedMinutes / 60;
  const differenceHours = (congruence.totalPlannedMinutes - congruence.totalDeclaredMinutes) / 60;

  // Total warning
  let totalWarning: string | null = null;
  if (!congruence.isTotalCongruent) {
    totalWarning = differenceHours > 0
      ? `L'orario inserito non corrisponde al monte ore dichiarato (${differenceHours.toFixed(1)} h in più)`
      : `L'orario inserito non corrisponde al monte ore dichiarato (${Math.abs(differenceHours).toFixed(1)} h in meno)`;
  }

  // Per-school warnings
  const bySchoolWarnings: Array<{ schoolId: string; label: string; warning: string }> = [];
  Object.entries(congruence.bySchool).forEach(([schoolId, school]) => {
    const diffHours = school.differenceMinutes / 60;
    if (Math.abs(diffHours) > 0.5) {
      const schoolLabel = schoolId === "primary" ? "Istituto principale" : `Istituto secondario`;
      bySchoolWarnings.push({
        schoolId,
        label: schoolLabel,
        warning: diffHours > 0
          ? `${schoolLabel}: ${diffHours.toFixed(1)} h superiori al dichiarato`
          : `${schoolLabel}: ${Math.abs(diffHours).toFixed(1)} h inferiori al dichiarato`,
      });
    }
  });

  // Distribution warning if total is OK but per-school is not
  let isConsistent = congruence.isTotalCongruent && congruence.isBySchoolCongruent;
  if (congruence.isTotalCongruent && !congruence.isBySchoolCongruent) {
    isConsistent = false;
    // Add a distribution warning
    bySchoolWarnings.push({
      schoolId: "distribution",
      label: "Distribuzione",
      warning: "Totale ore corretto ma distribuzione per scuola non coerente",
    });
  }

  return {
    totalPlannedHours: parseFloat(totalPlannedHours.toFixed(1)),
    totalDeclaredHours: declaredHours,
    differenceHours: parseFloat(differenceHours.toFixed(1)),
    totalWarning,
    bySchoolWarnings,
    isConsistent,
  };
}