/**
 * Utility functions for calculating timetable congruence with declared weekly hours.
 * 
 * Key design:
 * - Internally uses minutes for precision (50min, 55min, 60min slots, etc.)
 * - Converts to hours only for UI display
 * - Calculates per-school totals for multi-institute scenarios
 * - Handles legacy profiles without weeklyDeclaredHours (defaults to 18)
 * - Uses real school IDs from profile, never the special "primary" string
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
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  // Ensure non-negative duration
  return end >= start ? end - start : 0;
}

/** Calculates total planned hours (in minutes) for all timetable slots */
export function calculateTotalTimetableMinutes(timetable: TimetableSlot[]): number {
  return timetable.reduce((total, slot) => total + slotDurationMinutes(slot.startTime, slot.endTime), 0);
}

/** Calculates total planned hours grouped by schoolId */
export function calculateTimetableBySchoolMinutes(timetable: TimetableSlot[]): Record<string, number> {
  const bySchool: Record<string, number> = {};
  timetable.forEach(slot => {
    const schoolId = slot.schoolId;
    if (schoolId) {
      bySchool[schoolId] = (bySchool[schoolId] || 0) + slotDurationMinutes(slot.startTime, slot.endTime);
    }
  });
  return bySchool;
}

/**
 * Gets the real primary school ID from the profile,
 * or undefined if no primary school is configured.
 */
export function getPrimarySchoolId(profile: TeacherProfile): string | undefined {
  const primary = getPrimarySchool(profile);
  return primary?.id;
}

/**
 * Calculates congruence between the planned timetable and declared weekly hours.
 * 
 * @returns Object with total and per-school breakdowns, differences, and warnings.
 * Never blocks saving - only returns messages.
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
  const primarySchoolId = getPrimarySchoolId(profile);
  const otherSchools = getOtherActiveSchools(profile);
  const primaryExpected = calculatePrimaryExpectedHours(declaredHours, otherSchools);

  // Build per-school congruence using real school IDs
  const schoolCongruence: Record<string, { plannedMinutes: number; declaredMinutes: number; differenceMinutes: number }> = {};
  
  // Collect all school IDs that appear in the timetable
  const timetableSchoolIds = new Set<string>();
  timetable.forEach(slot => {
    if (slot.schoolId) timetableSchoolIds.add(slot.schoolId);
  });

  // For each school found in the timetable
  timetableSchoolIds.forEach(schoolId => {
    const planned = bySchool[schoolId] || 0;
    
    // Determine declared hours for this school
    let declaredForSchool: number;
    
    // Check if this is the primary school
    const isPrimary = schoolId === primarySchoolId;
    
    if (isPrimary) {
      // Primary school gets the derived expected hours
      declaredForSchool = primaryExpected * 60;
    } else {
      // Secondary school - use its declared weeklyHours
      const otherSchool = otherSchools.find(s => s.id === schoolId);
      declaredForSchool = (otherSchool?.weeklyHours ?? 0) * 60;
    }
    
    const difference = planned - declaredForSchool;
    schoolCongruence[schoolId] = { plannedMinutes: planned, declaredMinutes: declaredForSchool, differenceMinutes: difference };
  });

  // Also include primary school if it has no slots but we need to show the expected hours
  // This handles the case where the profile has a primary school but no slots are currently scheduled
  if (primarySchoolId && !timetableSchoolIds.has(primarySchoolId)) {
    schoolCongruence[primarySchoolId] = {
      plannedMinutes: 0,
      declaredMinutes: primaryExpected * 60,
      differenceMinutes: -primaryExpected * 60,
    };
  }

  // Overall congruence (with 5-minute tolerance)
  const isTotalCongruent = Math.abs(totalPlanned - declaredMinutes) <= 5;
  
  // Per-school congruence: all schools must be within tolerance
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

  // Per-school warnings: show if difference is significant (> 1 hour or > 30 min)
  Object.entries(schoolCongruence).forEach(([schoolId, school]) => {
    const diffHours = school.differenceMinutes / 60;
    if (Math.abs(diffHours) > 1 || Math.abs(school.differenceMinutes) > 30) {
      const schoolName = schoolId === primarySchoolId ? "Istituto principale" : `Istituto ${schoolId}`;
      const over = school.differenceMinutes > 0;
      warnings.push(
        `${schoolName}: ${over ? "supera" : "è inferiore di"} ${Math.abs(diffHours).toFixed(1)} h ${over ? "" : "(distribuzione)"}`
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
      const schoolLabel = schoolId === (getPrimarySchoolId(profile) || '') ? "Istituto principale" : `Istituto secondario`;
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

/** Gets the declared weekly hours for a profile, defaulting to 18 for legacy profiles */
export function getDeclaredWeeklyHours(profile: TeacherProfile): number {
  return profile.weeklyDeclaredHours ?? 18;
}

/** Validates that a slot's end time is after its start time */
export function validateSlotTimes(startTime: string, endTime: string): boolean {
  return slotDurationMinutes(startTime, endTime) >= 0;
}
