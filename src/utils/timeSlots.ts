import type { PeriodSlot, TimeSlotConfig } from "../types";

/**
 * Normalizes a class name by trimming whitespace and converting to uppercase.
 * Example: " 2e " -> "2E"
 */
export function normalizeClassName(name: string): string {
  return name.trim().toUpperCase();
}

/**
 * Adds a given number of minutes to a "HH:MM" time string and returns "HH:MM".
 * Example: addMinutesToTime("07:50", 60) -> "08:50"
 */
export function addMinutesToTime(timeStr: string, minutes: number): string {
  const parts = timeStr.split(":");
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  const total = h * 60 + m + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const endH = Math.floor(wrapped / 60);
  const endM = wrapped % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

/**
 * Generates standard continuous period slots based on:
 * - firstHourStartTime (default "07:50")
 * - periodsPerDay (default 6)
 * - durationMinutes (default 60)
 */
export function generateDefaultPeriodSlots(
  firstHourStartTime: string = "07:50",
  periodsPerDay: number = 6,
  durationMinutes: number = 60
): PeriodSlot[] {
  const count = Math.max(1, Math.min(12, Math.floor(periodsPerDay) || 6));
  const duration = Math.max(1, Math.floor(durationMinutes) || 60);
  let currentStart = firstHourStartTime || "07:50";
  const slots: PeriodSlot[] = [];

  for (let i = 1; i <= count; i++) {
    const end = addMinutesToTime(currentStart, duration);
    slots.push({
      periodNumber: i,
      label: `${i}ª Ora`,
      startTime: currentStart,
      endTime: end,
    });
    currentStart = end;
  }

  return slots;
}

export const DEFAULT_PERIOD_SLOTS: PeriodSlot[] = generateDefaultPeriodSlots("07:50", 6, 60);

export const DEFAULT_TIME_SLOT_CONFIG: TimeSlotConfig = {
  firstHourStartTime: "07:50",
  periodsPerDay: 6,
  standardDurationMinutes: 60,
  customSlots: DEFAULT_PERIOD_SLOTS,
};

/**
 * Checks if a given array of slots exactly matches the auto-generated slots
 * for the specified parameters.
 */
export function areSlotsMatchingAuto(
  slots: PeriodSlot[],
  firstHourStartTime: string = "07:50",
  periodsPerDay: number = 6,
  durationMinutes: number = 60
): boolean {
  const auto = generateDefaultPeriodSlots(firstHourStartTime, periodsPerDay, durationMinutes);
  if (!slots || slots.length !== auto.length) return false;
  return slots.every(
    (s, i) =>
      s.periodNumber === auto[i].periodNumber &&
      s.startTime === auto[i].startTime &&
      s.endTime === auto[i].endTime
  );
}

/**
 * Returns the effective list of period slots from a TimeSlotConfig.
 * If customSlots are explicitly set, they take precedence (sorted by periodNumber).
 * Otherwise, slots are generated automatically from firstHourStartTime, periodsPerDay, and standardDurationMinutes.
 */
export function getEffectivePeriodSlots(config?: TimeSlotConfig): PeriodSlot[] {
  if (!config) return DEFAULT_PERIOD_SLOTS;

  if (config.customSlots && Array.isArray(config.customSlots) && config.customSlots.length > 0) {
    return [...config.customSlots]
      .sort((a, b) => a.periodNumber - b.periodNumber)
      .map(s => ({
        periodNumber: s.periodNumber,
        label: s.label || `${s.periodNumber}ª Ora`,
        startTime: s.startTime,
        endTime: s.endTime,
      }));
  }

  return generateDefaultPeriodSlots(
    config.firstHourStartTime || "07:50",
    config.periodsPerDay || 6,
    config.standardDurationMinutes || 60
  );
}
