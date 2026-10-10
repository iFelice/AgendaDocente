import type { CalendarEvent, Student, StudentScheduledAssessment } from "../types";
import { addDaysISO, civilDayOfWeek, isValidDate, localDateISO } from "./dates";
import { deriveScheduledAssessmentCalendarItems, scheduledAssessmentTypeLabel } from "./scheduledAssessmentCalendar";

/**
 * "Note e impegni" — proiezioni read-only operative e d'archivio.
 *
 * Questa utility NON crea, copia o persiste nulla: deriva a runtime le liste
 * a partire dagli archivi già esistenti (`events`, `scheduledAssessments`,
 * `students`). Un consiglio di classe resta un solo `CalendarEvent`: qui viene
 * soltanto mostrato.
 */

export type FutureCommitmentSource = "agenda" | "circolare" | "verifica" | "google" | "registro" | "nota";

export interface FutureCommitmentItem {
  id: string;
  kind: "calendar-event" | "scheduled-assessment";
  date: string;
  startTime?: string;
  title: string;
  details?: string;
  className?: string;
  subject?: string;
  location?: string;
  schoolId?: string;
  source: FutureCommitmentSource;
  /** Solo per i CalendarEvent: stato di completamento già persistito su `events`. */
  completed?: boolean;
  originalEvent?: CalendarEvent;
  assessmentId?: string;
}

export type FutureCommitmentGroupId = "oggi" | "domani" | "questa-settimana" | "prossima-settimana" | "piu-avanti";

export interface FutureCommitmentGroup {
  id: FutureCommitmentGroupId;
  label: string;
  items: FutureCommitmentItem[];
}

export const FUTURE_COMMITMENT_GROUP_LABELS: Record<FutureCommitmentGroupId, string> = {
  oggi: "Oggi",
  domani: "Domani",
  "questa-settimana": "Questa settimana",
  "prossima-settimana": "Prossima settimana",
  "piu-avanti": "Più avanti",
};

export const FUTURE_COMMITMENT_SOURCE_LABELS: Record<FutureCommitmentSource, string> = {
  agenda: "Agenda",
  circolare: "Circolare",
  verifica: "Verifica",
  google: "Google Calendar",
  registro: "Registro",
  nota: "Nota",
};

/** Le normali lezioni dell'orario non sono "impegni": inquinerebbero la lista. */
function isRoutineLesson(event: CalendarEvent): boolean {
  // La provenienza è la discriminante semantica: una circolare può contenere
  // un'attività didattica straordinaria classificata dall'AI come "lezione".
  return event.sourceType === "orario";
}

/**
 * Nota personale rapida: resta un normale `CalendarEvent` manuale, ma con
 * `category === "promemoria"` viene riconosciuta come "Nota" nella lista. I
 * normali impegni manuali (Consiglio, Collegio, …) restano "Agenda".
 */
export function isQuickNoteEvent(event: CalendarEvent): boolean {
  return event.sourceType === "manuale" && event.category === "promemoria";
}

function sourceOf(event: CalendarEvent): FutureCommitmentSource {
  switch (event.sourceType) {
    case "circolare":
      return "circolare";
    case "google_calendar":
      return "google";
    case "registro":
      return "registro";
    default:
      return isQuickNoteEvent(event) ? "nota" : "agenda";
  }
}

/** Lunedì (civile) della settimana che contiene `iso`; settimana italiana lunedì → domenica. */
export function civilWeekMonday(iso: string): string {
  const day = civilDayOfWeek(iso); // 0 = domenica
  const delta = day === 0 ? -6 : 1 - day;
  return addDaysISO(iso, delta);
}

/** Ordine: data, poi ora (gli eventi senza ora precedono), poi titolo, poi id. */
export function compareFutureCommitments(a: FutureCommitmentItem, b: FutureCommitmentItem): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const at = a.startTime ?? "";
  const bt = b.startTime ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Storico: data e ora decrescenti, poi titolo e id come tie-breaker stabili. */
export function comparePastCommitments(a: FutureCommitmentItem, b: FutureCommitmentItem): number {
  if (a.date !== b.date) return a.date > b.date ? -1 : 1;
  const at = a.startTime ?? "";
  const bt = b.startTime ?? "";
  if (at !== bt) return at > bt ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * L'Archivio mette in evidenza le note appena completate (oggi o con una data
 * futura), poi conserva il normale ordinamento storico. Non esiste un
 * `completedAt`: per quelle note la data civile è l'ordinamento leggibile e
 * deterministico più vicino.
 */
export function compareArchiveCommitments(a: FutureCommitmentItem, b: FutureCommitmentItem, todayIso: string): number {
  const isRecentCompletedNote = (item: FutureCommitmentItem) =>
    item.kind === "calendar-event" && item.source === "nota" && item.completed === true && item.date >= todayIso;
  const aRecent = isRecentCompletedNote(a);
  const bRecent = isRecentCompletedNote(b);
  if (aRecent !== bRecent) return aRecent ? -1 : 1;
  return aRecent ? compareFutureCommitments(a, b) : comparePastCommitments(a, b);
}

function calendarEventCommitment(event: CalendarEvent): FutureCommitmentItem {
  return {
    id: `event:${event.id}`,
    kind: "calendar-event",
    date: event.date,
    ...(event.isAllDay ? {} : event.startTime ? { startTime: event.startTime } : {}),
    title: event.title,
    ...(event.notes ? { details: event.notes } : {}),
    ...(event.className ? { className: event.className } : {}),
    ...(event.subject ? { subject: event.subject } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.schoolId ? { schoolId: event.schoolId } : {}),
    source: sourceOf(event),
    completed: !!event.completed,
    originalEvent: event,
  };
}

export function futureCommitmentGroupFor(dateIso: string, todayIso: string): FutureCommitmentGroupId {
  if (dateIso === todayIso) return "oggi";
  if (dateIso === addDaysISO(todayIso, 1)) return "domani";
  const thisMonday = civilWeekMonday(todayIso);
  const nextMonday = addDaysISO(thisMonday, 7);
  const weekAfterMonday = addDaysISO(nextMonday, 7);
  if (dateIso < nextMonday) return "questa-settimana";
  if (dateIso < weekAfterMonday) return "prossima-settimana";
  return "piu-avanti";
}

export interface DeriveFutureCommitmentsInput {
  events: CalendarEvent[];
  scheduledAssessments: StudentScheduledAssessment[];
  students: Student[];
  todayIso?: string;
}

/** Derivazione pura: nessuna scrittura, nessuna conversione persistente. */
export function deriveFutureCommitments({
  events,
  scheduledAssessments,
  students,
  todayIso = localDateISO(),
}: DeriveFutureCommitmentsInput): FutureCommitmentItem[] {
  const items: FutureCommitmentItem[] = [];
  const seenEventIds = new Set<string>();

  for (const event of events) {
    if (!event || !isValidDate(event.date)) continue;
    if (event.date < todayIso) continue;
    if (event.completed) continue;
    if (isRoutineLesson(event)) continue;
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    items.push(calendarEventCommitment(event));
  }

  const seenAssessmentIds = new Set<string>();
  for (const assessment of deriveScheduledAssessmentCalendarItems(scheduledAssessments, students)) {
    if (!isValidDate(assessment.date)) continue;
    if (assessment.date < todayIso) continue;
    if (seenAssessmentIds.has(assessment.id)) continue;
    seenAssessmentIds.add(assessment.id);
    const typeLabel = scheduledAssessmentTypeLabel[assessment.assessmentType];
    items.push({
      id: `assessment:${assessment.id}`,
      kind: "scheduled-assessment",
      date: assessment.date,
      title: `${typeLabel} — ${assessment.studentName}`,
      ...(assessment.topic ? { details: assessment.topic } : {}),
      ...(assessment.className ? { className: assessment.className } : {}),
      ...(assessment.subject ? { subject: assessment.subject } : {}),
      source: "verifica",
      assessmentId: assessment.id,
    });
  }

  return items.sort(compareFutureCommitments);
}

/**
 * Derivazione read-only dell'Archivio.
 *
 * Include tutti gli elementi già passati e, in aggiunta, tutte le note rapide
 * completate: una nota completata oggi o in futuro non può quindi sparire. La
 * deduplica è sempre per identità dell'evento (`event.id`).
 */
export function deriveArchiveCommitments({
  events,
  scheduledAssessments,
  students,
  todayIso = localDateISO(),
}: DeriveFutureCommitmentsInput): FutureCommitmentItem[] {
  const items: FutureCommitmentItem[] = [];
  const seenEventIds = new Set<string>();

  for (const event of events) {
    if (!event || !isValidDate(event.date)) continue;
    const belongsToArchive = event.date < todayIso || (isQuickNoteEvent(event) && event.completed === true);
    if (!belongsToArchive) continue;
    if (isRoutineLesson(event)) continue;
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    items.push(calendarEventCommitment(event));
  }

  const studentsById = new Map(students.map(student => [student.id, student]));
  const seenAssessmentIds = new Set<string>();
  for (const assessment of scheduledAssessments) {
    if (!assessment || !isValidDate(assessment.date)) continue;
    if (assessment.date >= todayIso) continue;
    if (assessment.status !== "scheduled" && assessment.status !== "completed") continue;
    if (seenAssessmentIds.has(assessment.id)) continue;
    seenAssessmentIds.add(assessment.id);
    const student = studentsById.get(assessment.studentId);
    const typeLabel = scheduledAssessmentTypeLabel[assessment.assessmentType];
    items.push({
      id: `assessment:${assessment.id}`,
      kind: "scheduled-assessment",
      date: assessment.date,
      title: `${typeLabel} — ${student?.fullName || "Studente non disponibile"}`,
      ...(assessment.topic ? { details: assessment.topic } : {}),
      ...(student?.className ? { className: student.className } : {}),
      ...(assessment.subject ? { subject: assessment.subject } : {}),
      source: "verifica",
      assessmentId: assessment.id,
    });
  }

  return items.sort((a, b) => compareArchiveCommitments(a, b, todayIso));
}

/** Nome legacy mantenuto per i consumer N1.1: ora rappresenta l'Archivio. */
export const derivePastCommitments = deriveArchiveCommitments;

/**
 * Limite superiore dell'elenco "prossimi impegni": il 31 agosto dell'anno scolastico
 * del profilo. Gli impegni che lo superano — qualunque sia l'origine (agenda, Google,
 * circolare, verifica, nota) — restano salvati e visibili nelle viste calendario: qui
 * vengono solo esclusi dall'elenco, per essere riassunti in fondo da un solo conteggio.
 *
 * Derivazione pura: nessun elemento viene modificato o eliminato.
 */
export function splitFutureCommitmentsBySchoolYearEnd(
  items: FutureCommitmentItem[],
  schoolYearEnd: string,
): { withinSchoolYear: FutureCommitmentItem[]; beyondSchoolYear: FutureCommitmentItem[] } {
  const withinSchoolYear: FutureCommitmentItem[] = [];
  const beyondSchoolYear: FutureCommitmentItem[] = [];
  for (const item of items) {
    (item.date <= schoolYearEnd ? withinSchoolYear : beyondSchoolYear).push(item);
  }
  return { withinSchoolYear, beyondSchoolYear };
}

/** Gruppi non vuoti, nell'ordine di lettura della schermata. */
export function groupFutureCommitments(
  items: FutureCommitmentItem[],
  todayIso: string = localDateISO(),
): FutureCommitmentGroup[] {
  const order: FutureCommitmentGroupId[] = ["oggi", "domani", "questa-settimana", "prossima-settimana", "piu-avanti"];
  const buckets = new Map<FutureCommitmentGroupId, FutureCommitmentItem[]>(order.map(id => [id, []]));
  for (const item of items) buckets.get(futureCommitmentGroupFor(item.date, todayIso))!.push(item);
  return order
    .map(id => ({ id, label: FUTURE_COMMITMENT_GROUP_LABELS[id], items: buckets.get(id)!.slice().sort(compareFutureCommitments) }))
    .filter(group => group.items.length > 0);
}
