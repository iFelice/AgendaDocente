/**
 * Scrittura nel modello orario ESISTENTE (TimetableSlot): nessun secondo
 * sistema orario.
 *
 * Per i docenti di sostegno la materia principale resta "Sostegno" e la
 * materia curricolare trovata nell'incrocio va nel campo già esistente
 * `coTeachingSubjects`. Il nome del docente curricolare non viene mai salvato.
 *
 * Gestione dell'orario esistente (mai sovrascrivere automaticamente):
 * - "missing-only":       aggiunge solo gli slot assenti (stesso giorno+periodo+sede);
 * - "replace-selected":   sostituisce SOLO gli slot corrispondenti a quelli
 *                         selezionati, aggiunge i nuovi, non toglie gli altri.
 * Non esiste alcuna opzione per azzerare l'intero orario da qui.
 */

import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from "../types";
import { normalizeTeacherProfile } from "./multiSchool";
import { getEffectivePeriodSlots, generateDefaultPeriodSlots } from "./timeSlots";
import type { ReconstructedSlot } from "./timetableCrossref";
import { normalizeSubjectName } from "./subjects";

/** Materia canonica usata in archivio per il sostegno (coerente con i seed). */
export const SUPPORT_TEACHER_SUBJECT = "Sostegno";

export function isSupportTeacherProfile(profile: Pick<TeacherProfile, "isSupportTeacher" | "primarySubjects">): boolean {
  return !!profile.isSupportTeacher || (profile.primarySubjects ?? []).some(s => /sostegno/i.test(s));
}

/**
 * Tempo della fascia dal periodIndex, usando la configurazione fasce orarie del
 * docente (la stessa regola che usa l'editor orario). Se il periodo è oltre la
 * configurazione, le fasce vengono prolungate con la stessa durata standard:
 * il periodo arriva dal documento, gli orari dalla configurazione dell'utente.
 */
export function periodTimesForIndex(config: TimeSlotConfig | undefined, periodIndex: number): { startTime: string; endTime: string } {
  const effective = getEffectivePeriodSlots(config);
  const found = effective.find(p => p.periodNumber === periodIndex);
  if (found) return { startTime: found.startTime, endTime: found.endTime };
  const generated = generateDefaultPeriodSlots(
    config?.firstHourStartTime || effective[0]?.startTime || "07:50",
    Math.max(periodIndex, config?.periodsPerDay || effective.length),
    config?.standardDurationMinutes || 60
  );
  const extended = generated[periodIndex - 1];
  if (extended) return { startTime: extended.startTime, endTime: extended.endTime };
  return { startTime: effective[0]?.startTime ?? "08:00", endTime: effective[0]?.endTime ?? "09:00" };
}

export interface ReconstructedTimetableOptions {
  profile: TeacherProfile;
  timeSlotConfig?: TimeSlotConfig;
  /** Sede associata (multi-istituto); default: istituto principale. */
  schoolId?: string;
}

/**
 * Converte gli slot ricostruiti (confermati dall'utente) nel modello orario
 * esistente:
 *  - docente di sostegno: subject = "Sostegno", materia in compresenza in
 *    `coTeachingSubjects` (campo già esistente, mai duplicato);
 *  - nessun nome di docente curricolare viene salvato;
 *  - classe e scuola sono quelle (corrette) dall'utente nella conferma;
 *  - gli slot senza classe non vengono salvati (l'utente deve correggerli o
 *    deselezionarli: il modello richiede una classe).
 */
export function reconstructedToTimetableSlots(
  slots: Array<ReconstructedSlot & { correctedClass?: string; correctedSubject?: string; selected?: boolean }>,
  options: ReconstructedTimetableOptions
): TimetableSlot[] {
  const support = isSupportTeacherProfile(options.profile);
  const schoolId = options.schoolId ?? normalizeTeacherProfile(options.profile).schools?.find(s => s.isPrimary)?.id;

  const result: TimetableSlot[] = [];
  for (const slot of slots) {
    if (slot.selected === false) continue; // slot deselezionato: non salvato
    const className = (slot.correctedClass ?? slot.classLabel ?? "").trim().toUpperCase();
    if (!className) continue; // nessuna classe determinabile: mai inventata

    const times = periodTimesForIndex(options.timeSlotConfig, slot.periodIndex);
    // La correzione manuale dell'utente sostituisce la proposta (non si accumulano materie).
    const correctedSubject = slot.correctedSubject?.trim();
    let coTeaching: string[] = [];
    if (correctedSubject) {
      coTeaching = [correctedSubject];
    } else if (slot.coTeachingSubjects.length === 1) {
      coTeaching = [slot.coTeachingSubjects[0]];
    }
    const subject = support ? SUPPORT_TEACHER_SUBJECT : (correctedSubject || coTeaching[0] || SUPPORT_TEACHER_SUBJECT);

    const timetale: TimetableSlot = {
      id: `tt-recon-${crypto.randomUUID()}`,
      dayOfWeek: slot.dayOfWeek as TimetableSlot["dayOfWeek"],
      periodNumber: slot.periodIndex,
      startTime: times.startTime,
      endTime: times.endTime,
      subject,
      className,
      isProvisional: false,
    };
    if (coTeaching.length) timetale.coTeachingSubjects = coTeaching.map(s => normalizeSubjectName(s));
    if (schoolId) timetale.schoolId = schoolId;
    result.push(timetale);
  }
  return result;
}

function dedupePreservingOrder(values: string[]): string[] {
  const result: string[] = [];
  for (const v of values) {
    const clean = v.trim();
    if (clean && !result.includes(clean)) result.push(clean);
  }
  return result;
}

export type TimetableMergeMode = "missing-only" | "replace-selected";

/** Chiave di occupazione di uno slot: stessa sede, stesso giorno, stesso periodo. */
export function slotOccupancyKey(slot: Pick<TimetableSlot, "dayOfWeek" | "periodNumber" | "schoolId">): string {
  return `${slot.schoolId ?? ""}|${slot.dayOfWeek}|${slot.periodNumber}`;
}

export interface ReconstructedTimetableResult {
  slots: TimetableSlot[];
  addedCount: number;
  replacedCount: number;
  untouchedCount: number;
}

/**
 * Unisce la proposta (confermata) con l'orario esistente.
 * NIENTE sovrascrittura automatica: ogni slot esistente viene toccato solo
 * se la modalità lo prevede E lo slot proposto coincide per
 * giorno+periodo(+sede). Gli slot non corrispondenti restano intatti.
 */
export function applyReconstruction(
  existing: TimetableSlot[],
  incoming: TimetableSlot[],
  mode: TimetableMergeMode
): ReconstructedTimetableResult {
  const result = [...existing];
  let addedCount = 0;
  let replacedCount = 0;

  for (const slot of incoming) {
    const index = result.findIndex(s => slotOccupancyKey(s) === slotOccupancyKey(slot));
    if (index >= 0) {
      if (mode === "replace-selected") {
        result[index] = slot;
        replacedCount++;
      }
      // "missing-only": lo slot esiste già -> non toccato.
      continue;
    }
    result.push(slot);
    addedCount++;
  }

  return { slots: result, addedCount, replacedCount, untouchedCount: existing.length - replacedCount };
}
