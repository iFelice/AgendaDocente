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
 * - firstHourStartTime (e.g. "07:50" or "08:00")
 * - periodsPerDay (e.g. 6)
 * - durationMinutes (e.g. 60)
 */
export function generateDefaultPeriodSlots(
  firstHourStartTime: string = "08:15",
  periodsPerDay: number = 6,
  durationMinutes: number = 60
): PeriodSlot[] {
  const count = Math.max(1, Math.min(12, Math.floor(periodsPerDay) || 6));
  const duration = Math.max(1, Math.floor(durationMinutes) || 60);
  let currentStart = firstHourStartTime || "08:15";
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

export const DEFAULT_PERIOD_SLOTS: PeriodSlot[] = [
  { periodNumber: 1, label: "1ª Ora", startTime: "08:15", endTime: "09:10" },
  { periodNumber: 2, label: "2ª Ora", startTime: "09:10", endTime: "10:05" },
  { periodNumber: 3, label: "3ª Ora", startTime: "10:15", endTime: "11:10" },
  { periodNumber: 4, label: "4ª Ora", startTime: "11:15", endTime: "12:10" },
  { periodNumber: 5, label: "5ª Ora", startTime: "12:15", endTime: "13:10" },
  { periodNumber: 6, label: "6ª Ora", startTime: "13:10", endTime: "14:05" },
];

export const DEFAULT_TIME_SLOT_CONFIG: TimeSlotConfig = {
  firstHourStartTime: "08:15",
  periodsPerDay: 6,
  standardDurationMinutes: 60,
  customSlots: DEFAULT_PERIOD_SLOTS,
};

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
    config.firstHourStartTime || "08:15",
    config.periodsPerDay || 6,
    config.standardDurationMinutes || 60
  );
}
