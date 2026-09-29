import type { PeriodSlot, SchoolProfile, TimetableSlot, TimeSlotConfig } from "../types";
import { effectiveSchoolForSlot } from "./multiSchool";

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

/**
 * FASCE ORARIE DA USARE PER UN ISTITUTO.
 *
 * Un istituto può avere le proprie campane (`school.timeSlotConfig`); finché
 * non le ha, valgono quelle globali del docente — che restano il default e
 * NON vengono copiate dentro la scuola. Nessuna migrazione, nessuna scrittura:
 * la regola si applica in lettura.
 *
 * La config della scuola vince INTERAMENTE: è un `TimeSlotConfig` completo,
 * non un insieme di override da fondere campo per campo con la globale. Una
 * fusione produrrebbe orari che non appartengono a nessuna delle due.
 *
 * Confine deliberato: qui NON si risolve l'identità della scuola (lo fanno
 * `schoolByIdOrPrimary`, `effectiveSchoolForSlot`, `getPrimarySchool`) e NON si
 * inventa un default — se entrambe mancano il risultato è `undefined`, che
 * `getEffectivePeriodSlots` traduce già nel comportamento storico dell'app.
 * Restituire qui un default farebbe sparire silenziosamente la configurazione
 * dell'utente al primo `undefined` di troppo.
 */
export function timeSlotConfigForSchool(
  school: Pick<SchoolProfile, "timeSlotConfig"> | undefined,
  globalConfig: TimeSlotConfig | undefined
): TimeSlotConfig | undefined {
  return school?.timeSlotConfig ?? globalConfig;
}

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

/**
 * Lezioni che userebbero orari diversi dalle NUOVE campane di un istituto.
 *
 * Gli orari vivono copiati dentro ogni `TimetableSlot`: cambiare le fasce di
 * una scuola non li aggiorna da solo. Questa funzione dice quali lezioni
 * resterebbero indietro — non le aggiorna di nascosto: produce il piano, e la
 * decisione resta dell'utente.
 *
 * Una lezione entra nel piano solo se TUTTE queste cose sono vere:
 *
 *  1. appartiene a quell'istituto secondo l'identità canonica runtime
 *     (`effectiveSchoolForSlot`): gli slot legacy senza `schoolId` e quelli con
 *     un id orfano contano come della primaria, non spariscono;
 *  2. la NUOVA configurazione ha davvero una fascia per il suo `periodNumber`;
 *  3. i suoi orari sono diversi da quelli di quella fascia.
 *
 * Sul punto 2: un'ora che nella nuova configurazione non ha più una fascia NON
 * viene toccata, né spostata, né cancellata — resta con i suoi orari storici e
 * la segnalano C1/C2/D1, che è il loro mestiere. Qui non si inventano orari.
 *
 * Sul punto 3: NON si confronta con la vecchia fascia. Un orario modificato a
 * mano è indistinguibile da uno derivato, quindi l'unico criterio onesto è
 * "diverso da dove lo metterebbe la nuova campanella"; avvertire l'utente che
 * le modifiche manuali verranno sostituite spetta alla UI.
 *
 * Funzione pura: non muta gli slot in ingresso e restituisce copie.
 */
export interface TimeSlotRealignmentPlan {
  /** Le lezioni che cambierebbero orario (riferimenti agli slot originali). */
  affected: TimetableSlot[];
  /** L'array completo, con le sole lezioni interessate sostituite da copie aggiornate. */
  updated: TimetableSlot[];
}

export function planTimeSlotRealignment(
  slots: readonly TimetableSlot[],
  school: Pick<SchoolProfile, "id"> | undefined,
  schools: readonly SchoolProfile[] | undefined,
  newConfig: TimeSlotConfig | undefined
): TimeSlotRealignmentPlan {
  const schoolId = school?.id;
  if (!schoolId) return { affected: [], updated: [...slots] };

  const periods = getEffectivePeriodSlots(newConfig);
  const affected: TimetableSlot[] = [];
  const updated = slots.map(slot => {
    if (effectiveSchoolForSlot(slot, schools)?.id !== schoolId) return slot;
    const period = periods.find(p => p.periodNumber === slot.periodNumber);
    if (!period) return slot;
    if (slot.startTime === period.startTime && slot.endTime === period.endTime) return slot;
    affected.push(slot);
    return { ...slot, startTime: period.startTime, endTime: period.endTime };
  });

  return { affected, updated };
}
