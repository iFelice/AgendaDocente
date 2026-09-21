/**
 * Scrittura nel modello orario ESISTENTE (TimetableSlot): nessun secondo
 * sistema orario.
 *
 * Per i docenti di sostegno la materia principale resta "Sostegno" e la
 * materia curricolare trovata nell'incrocio va nel campo già esistente
 * `coTeachingSubjects`. Il nome del docente curricolare non viene mai salvato.
 *
 * Gestione dell'orario esistente (mai sovrascrivere automaticamente):
 * - "missing-only":  aggiunge solo gli slot assenti (stesso giorno+periodo+istituto);
 * - "replace-scope": SOSTITUZIONE REALE nell'ambito della ricostruzione: gli slot
 *                    esistenti dello STESSO istituto e della STESSA natura (sostegno
 *                    con sostegno, materia con materia) vengono rimossi e sostituiti
 *                    da quelli confermati. Uno slot vecchio non più presente nel nuovo
 *                    orario non sopravvive (era il bug «giovedì e venerdì restano
 *                    pieni» segnalato su iPhone);
 *                    gli slot di altri istituti o di altra natura non vengono toccati.
 * Non esiste alcuna opzione per azzerare l'intero orario (tutti gli istituti, tutte
 * le nature) da qui.
 */

import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from "../types";
import { normalizeTeacherProfile } from "./multiSchool";
import { getEffectivePeriodSlots, generateDefaultPeriodSlots } from "./timeSlots";
import type { ReconstructedSlot } from "./timetableCrossref";
import { normalizeSubjectName } from "./subjects";
import { isSupportTeacherOf } from "./teacherType";

/** Materia canonica usata in archivio per il sostegno (coerente con i seed). */
export const SUPPORT_TEACHER_SUBJECT = "Sostegno";

/**
 * DELEGA all'helper canonico (src/utils/teacherType.ts): non è una seconda
 * fonte di verità. La semantica è quella canonica — un `isSupportTeacher`
 * esplicito (anche `false`) vince sull'euristica "sostegno" su primarySubjects,
 * che resta fallback SOLO per i profili legacy senza flag.
 */
export function isSupportTeacherProfile(profile: Pick<TeacherProfile, "isSupportTeacher" | "primarySubjects"> | null | undefined): boolean {
  return isSupportTeacherOf(profile);
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

export type TimetableMergeMode = "missing-only" | "replace-scope";

/**
 * Istituto effettivo di uno slot. Gli slot legacy non hanno `schoolId`: appartengono
 * all'istituto principale del profilo (stessa regola di `normalizeTeacherProfile`),
 * così un orario esistente salvato prima del modello multi-istituto non resta
 * "invisibile" né alla sostituzione né al controllo dei duplicati.
 */
export function slotSchoolKey(slot: Pick<TimetableSlot, "schoolId">, profile?: TeacherProfile): string {
  const clean = (slot.schoolId ?? "").trim();
  if (clean) return clean;
  if (!profile) return "";
  return normalizeTeacherProfile(profile).schools?.find(s => s.isPrimary)?.id ?? "";
}

/**
 * Chiave di occupazione di uno slot: stesso istituto, stesso giorno, stesso periodo.
 * Con il profilo la sede è normalizzata, quindi un archivio legacy (senza `schoolId`)
 * e una ricostruzione che la portano NON vengono scambiati per due ore diverse.
 */
export function slotOccupancyKey(
  slot: Pick<TimetableSlot, "dayOfWeek" | "periodNumber" | "schoolId">,
  profile?: TeacherProfile
): string {
  return `${slotSchoolKey(slot, profile)}|${slot.dayOfWeek}|${slot.periodNumber}`;
}

/** Natura di uno slot: ore di sostegno oppure ore di materia curricolare. */
export type TimetableSlotNature = "support" | "subject";
export function slotNature(slot: Pick<TimetableSlot, "subject">): TimetableSlotNature {
  return /sostegno/i.test(String(slot.subject ?? "")) ? "support" : "subject";
}

export interface ReconstructionScopeOptions {
  /** Profilo del docente: serve a mappare gli slot legacy senza `schoolId` sull'istituto principale. */
  profile?: TeacherProfile;
}

/**
 * Natura dell'orario personale settimanale del docente: sostegno per un docente di
 * sostegno, materia altrimenti. È la STESSA regola con cui
 * `reconstructedToTimetableSlots` assegna la materia agli slot importati, quindi
 * ambito della cancellazione e slot scritti non possono divergere.
 */
export function personalTimetableNature(profile?: TeacherProfile): TimetableSlotNature {
  return profile && isSupportTeacherProfile(profile) ? "support" : "subject";
}

/**
 * Gli slot esistenti che una sovrascrittura ("replace-scope") elimina: stesso
 * istituto E stessa natura dell'ORARIO PERSONALE importato.
 *
 * L'ambito NON dipende dagli slot in arrivo — non dalle loro coordinate, non dalle
 * loro classi, non dalle loro materie, non dall'intersezione vecchio/nuovo: il
 * documento importato rappresenta l'intera settimana del docente, quindi TUTTE le
 * vecchie ore di quell'ambito spariscono. Restano fuori ambito (e quindi intatte)
 * le ore di altra natura e quelle sicuramente di un altro istituto; gli slot legacy
 * senza `schoolId` valgono l'istituto principale del profilo.
 *
 * Senza profilo la natura resta prudenzialmente quella degli slot in arrivo: non si
 * cancellano dati di un docente di cui non conosciamo l'orario personale.
 */
export function slotsInReplacementScope(
  existing: TimetableSlot[],
  incoming: TimetableSlot[],
  options: ReconstructionScopeOptions = {}
): TimetableSlot[] {
  if (incoming.length === 0) return [];
  const schools = new Set(incoming.map(s => slotSchoolKey(s, options.profile)));
  const natures: Set<TimetableSlotNature> = options.profile
    ? new Set([personalTimetableNature(options.profile)])
    : new Set(incoming.map(s => slotNature(s)));
  return existing.filter(s => schools.has(slotSchoolKey(s, options.profile)) && natures.has(slotNature(s)));
}

export interface ReconstructedTimetableResult {
  slots: TimetableSlot[];
  addedCount: number;
  replacedCount: number;
  /** Slot esistenti rimossi dalla sostituzione perché assenti nel nuovo orario. */
  removedCount: number;
  untouchedCount: number;
}

/**
 * Progetto della fusione: unica fonte dei conteggi, così l'anteprima mostrata prima
 * di salvare e il salvataggio reale non possono divergere.
 */
function planReconstruction(
  existing: TimetableSlot[],
  incoming: TimetableSlot[],
  mode: TimetableMergeMode,
  options: ReconstructionScopeOptions
): { slots: TimetableSlot[]; addedCount: number; replacedCount: number; removedCount: number; untouchedCount: number } {
  if (mode === "replace-scope") {
    const inScope = slotsInReplacementScope(existing, incoming, options);
    const inScopeIds = new Set(inScope.map(s => s.id));
    const incomingKeys = new Set(incoming.map(s => slotOccupancyKey(s, options.profile)));
    const replacedCount = inScope.filter(s => incomingKeys.has(slotOccupancyKey(s, options.profile))).length;
    // Gli slot fuori ambito restano intatti, anche se occupano la stessa coordinata
    // (un'ora di materia non viene mai cancellata da una ricostruzione di sostegno).
    return {
      slots: [...existing.filter(s => !inScopeIds.has(s.id)), ...incoming],
      addedCount: incoming.length - replacedCount,
      replacedCount,
      removedCount: inScope.length - replacedCount,
      untouchedCount: existing.length - inScope.length,
    };
  }

  const result = [...existing];
  let addedCount = 0;
  let replacedCount = 0;
  for (const slot of incoming) {
    const index = result.findIndex(s => slotOccupancyKey(s, options.profile) === slotOccupancyKey(slot, options.profile));
    if (index >= 0) {
      // "missing-only": lo slot esiste già -> non toccato (nessun duplicato).
      continue;
    }
    result.push(slot);
    addedCount++;
  }
  return { slots: result, addedCount, replacedCount, removedCount: 0, untouchedCount: existing.length - replacedCount };
}

/** Solo i conteggi, per l'anteprima nel modale (nessuna scrittura). */
export function previewReconstruction(
  existing: TimetableSlot[],
  incoming: TimetableSlot[],
  mode: TimetableMergeMode,
  options: ReconstructionScopeOptions = {}
): Omit<ReconstructedTimetableResult, "slots"> {
  const { slots: _slots, ...counts } = planReconstruction(existing, incoming, mode, options);
  return counts;
}

/**
 * Unisce la proposta (confermata) con l'orario esistente.
 * NIENTE sovrascrittura automatica in "missing-only": uno slot esistente viene
 * toccato solo se coincide per istituto+giorno+periodo. In "replace-scope" la
 * sovrascrittura è INTEGRALE dentro l'ambito dell'orario personale (istituto +
 * natura): tutte le vecchie ore di quell'ambito escono, anche quelle in coordinate
 * o classi assenti nel nuovo orario. Vedi `slotsInReplacementScope`.
 */
export function applyReconstruction(
  existing: TimetableSlot[],
  incoming: TimetableSlot[],
  mode: TimetableMergeMode,
  options: ReconstructionScopeOptions = {}
): ReconstructedTimetableResult {
  return planReconstruction(existing, incoming, mode, options);
}
