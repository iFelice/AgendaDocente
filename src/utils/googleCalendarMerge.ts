import type { CalendarEvent, EventCategory } from "../types";
import { effectiveDeadlineDate } from "./dates";
import {
  extractTimesFromTitle,
  findAffinityMatch,
  findEventMatch,
  titleTimeAgreesWithEvent,
  type EventMatchCandidate,
} from "./eventMatching";

/**
 * Unione di un impegno importato da Google Calendar con il suo doppione creato nell'app.
 *
 * Tutto qui è puro (nessun I/O, nessuna chiamata a Google): l'App persiste il risultato
 * con una sola scrittura locale e non cancella mai nulla su Google Calendar.
 */

/** Impegno scaricato da Google e non ancora unito a un impegno dell'app. */
export function isGoogleImportedEvent(event: Pick<CalendarEvent, "sourceType">): boolean {
  return event.sourceType === "google_calendar";
}

/**
 * Etichetta "Google Calendar": l'impegno importato, oppure un impegno dell'app che ha
 * un collegamento Google (unito o inviato). Un impegno unito mostra anche la sua origine.
 */
export function showsGoogleCalendarLabel(event: Pick<CalendarEvent, "sourceType" | "googleEventId">): boolean {
  return isGoogleImportedEvent(event) || !!event.googleEventId;
}

/** Lezioni dell'orario: non entrano mai in un'unione né nei doppioni. */
export function isLessonEvent(event: Pick<CalendarEvent, "sourceType" | "category">): boolean {
  return event.sourceType === "orario" || event.category === "lezione";
}

/** Eleggibile al rilevamento dei doppioni: esclusi lezioni, scadenze e tutto il giorno. */
function isDuplicateCandidate(event: CalendarEvent): boolean {
  if (isLessonEvent(event)) return false;
  if (event.category === "scadenza" || effectiveDeadlineDate(event)) return false;
  if (event.isAllDay) return false;
  return true;
}

function toMatchCandidate(event: CalendarEvent): EventMatchCandidate {
  return {
    title: event.title,
    date: event.date,
    category: event.category,
    className: event.className,
    startTime: event.startTime,
    endTime: event.endTime,
    isAllDay: event.isAllDay,
  };
}

/**
 * Possibili doppioni, per giorno: una coppia formata da un impegno da Google e uno
 * nato nell'app è tale se ha orari sovrapposti o titoli equivalenti. La decisione è
 * quella di `findEventMatch` (la stessa dell'import da circolare), non una copia.
 *
 * Quando quei criteri non bastano si aggiunge l'affinità (`findAffinityMatch`): un
 * consiglio scritto male da una parte può avere l'orario nel titolo e un orario
 * contiguo dall'altra. È un avviso in più, non una fusione: qui nulla viene
 * modificato e l'unione resta una scelta esplicita del docente.
 *
 * Ogni impegno compare in al più una coppia. Un impegno dell'app già collegato a Google
 * (`googleEventId`) non è candidato: è già un collegamento, non un doppione da unire.
 * Restituisce una mappa in entrambi i versi: id → impegno accoppiato.
 */
export function findPossibleDuplicates(events: CalendarEvent[]): Map<string, CalendarEvent> {
  const pairs = new Map<string, CalendarEvent>();
  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    if (!isDuplicateCandidate(event)) continue;
    const day = byDay.get(event.date);
    if (day) day.push(event);
    else byDay.set(event.date, [event]);
  }

  for (const dayEvents of byDay.values()) {
    let available = dayEvents.filter(event => !isGoogleImportedEvent(event) && !event.googleEventId);
    for (const google of dayEvents.filter(isGoogleImportedEvent)) {
      const candidate = toMatchCandidate(google);
      const direct = findEventMatch(candidate, available);
      // Una sola sovrapposizione non è un doppione: si valuta comunque l'affinità.
      const match = direct && direct.kind !== "sovrapposizione" ? direct : findAffinityMatch(candidate, available) ?? direct;
      if (!match) continue;
      pairs.set(google.id, match.event);
      pairs.set(match.event.id, google);
      available = available.filter(event => event !== match.event);
    }
  }
  return pairs;
}

export type MergeRolesResult =
  | { ok: true; base: CalendarEvent; secondary: CalendarEvent }
  | { ok: false; reason: string };

/**
 * Ruoli dell'unione. Base = l'impegno nato nell'app (circolare o manuale); se entrambi
 * sono dell'app, quello indicato per primo (`first`, cioè quello da cui parte l'azione).
 * Il secondario è quello che viene rimosso dall'app.
 *
 * Rifiuta le combinazioni che perderebbero un collegamento Google o sarebbero senza senso:
 * due impegni importati da Google, due collegamenti Google diversi, una lezione.
 */
export function mergeRolesFor(first: CalendarEvent, second: CalendarEvent): MergeRolesResult {
  if (first.id === second.id) return { ok: false, reason: "Scegli un altro impegno da unire." };
  if (isLessonEvent(first) || isLessonEvent(second)) {
    return { ok: false, reason: "Le lezioni dell’orario non si uniscono." };
  }
  const firstGoogle = isGoogleImportedEvent(first);
  const secondGoogle = isGoogleImportedEvent(second);
  if (firstGoogle && secondGoogle) {
    return { ok: false, reason: "Due impegni importati da Google Calendar non si uniscono." };
  }
  if (first.googleEventId && second.googleEventId
    && (first.googleEventId !== second.googleEventId || first.googleCalendarId !== second.googleCalendarId)) {
    return {
      ok: false,
      reason: "Entrambi gli impegni sono collegati a Google Calendar: unirli farebbe perdere un collegamento.",
    };
  }
  if (firstGoogle) return { ok: true, base: second, secondary: first };
  return { ok: true, base: first, secondary: second };
}

export type MergeField = "title" | "timing" | "location" | "className" | "subject" | "category" | "notes" | "meetingUrl";

export type MergeChoice = "base" | "other" | "both";

/** Ordine e etichette con cui l'anteprima mostra i campi. */
export const MERGE_FIELD_LABELS: Record<MergeField, string> = {
  title: "Titolo",
  timing: "Orario",
  location: "Luogo",
  className: "Classe",
  subject: "Materia",
  category: "Categoria",
  notes: "Note",
  meetingUrl: "Link videochiamata",
};

export const MERGE_FIELD_ORDER: MergeField[] = [
  "title", "timing", "location", "className", "subject", "category", "notes", "meetingUrl",
];

const clean = (value?: string | null): string => (value ?? "").trim();
const fold = (value: string): string => value.toLowerCase().replace(/\s+/g, " ");

function timeRangeText(start?: string, end?: string): string | undefined {
  const from = clean(start);
  const to = clean(end);
  if (from && to) return `${from} – ${to}`;
  return from || to || undefined;
}

/** Valore leggibile di un campo dell'impegno, o undefined se vuoto. */
export function mergeFieldValue(
  event: CalendarEvent,
  field: MergeField,
  categoryLabel: (category: EventCategory) => string = category => category,
): string | undefined {
  switch (field) {
    case "title": return clean(event.title) || undefined;
    case "timing": return event.isAllDay ? "Tutto il giorno" : timeRangeText(event.startTime, event.endTime);
    case "location": return clean(event.location) || undefined;
    case "className": return clean(event.className) || undefined;
    case "subject": return clean(event.subject) || undefined;
    case "category": return mergeCategoryValue(event, categoryLabel);
    case "notes": return clean(event.notes) || undefined;
    case "meetingUrl": return clean(event.meetingUrl) || undefined;
  }
}

/**
 * Valore di categoria ai fini dell'unione. La categoria "personale" è il default
 * assegnato in importazione a ogni evento Google: non è un dato reale, quindi su un
 * impegno con `sourceType "google_calendar"` vale come vuota (non genera una scelta e
 * il risultato prende la categoria dell'altro impegno). Una categoria diversa da
 * "personale" su un evento Google resta reale; su un impegno nato nell'app
 * "personale" è una scelta legittima e non viene mai azzerata.
 */
export function mergeCategoryValue(
  event: Pick<CalendarEvent, "sourceType" | "category">,
  categoryLabel: (category: EventCategory) => string = category => category,
): string | undefined {
  if (event.sourceType === "google_calendar" && event.category === "personale") return undefined;
  return event.category ? categoryLabel(event.category) : undefined;
}

export interface MergeFieldPreview {
  field: MergeField;
  label: string;
  baseValue?: string;
  otherValue?: string;
  /** Pieni e diversi: l'utente sceglie. Uguali e vuoti non compaiono qui (vedi `summary`). */
  status: "choice";
  /** Preselezione: valore della base (per il link, quello presente; per l'orario, quello coerente col titolo). */
  defaultChoice: MergeChoice;
  /** Solo per le note. */
  allowBoth: boolean;
}

/**
 * Riga breve dell'anteprima che spiega una preselezione: quale titolo dichiara
 * quell'orario e che cosa si propone.
 */
export interface MergeFieldHint {
  field: MergeField;
  /** Lato proposto: è l'orario (o il campo) che il titolo rende coerente. */
  choice: MergeChoice;
  text: string;
}

/** Etichetta del lato dell'unione, per la riga di spiegazione. */
function mergeSideLabel(event: CalendarEvent): string {
  if (isGoogleImportedEvent(event) || event.googleEventId) return "evento Google";
  return event.sourceType === "circolare" ? "impegno della circolare" : "impegno in agenda";
}

/** Orario "HH:MM–HH:MM" o "HH:MM" scritto nel titolo di un impegno, se c'è. */
function titleTimeRangeText(event: CalendarEvent): string | undefined {
  const declared = extractTimesFromTitle(event.title);
  if (!declared.start) return undefined;
  return declared.end ? `${declared.start}–${declared.end}` : declared.start;
}

/**
 * Orario dell'unione già deciso dal titolo: se il titolo di un impegno dichiara un
 * orario che coincide con l'orario effettivo dell'altro, nell'anteprima si
 * preseleziona quell'orario (che è quello coerente col titolo) e lo si dice con una
 * riga breve. Nessun campo viene cambiato da solo: resta una scelta dell'utente.
 */
export function mergeTimingHint(base: CalendarEvent, other: CalendarEvent): MergeFieldHint | undefined {
  if (base.isAllDay || other.isAllDay) return undefined;
  const sides: { titled: CalendarEvent; other: CalendarEvent; choice: MergeChoice }[] = [
    { titled: other, other: base, choice: "base" },
    { titled: base, other, choice: "other" },
  ];
  for (const side of sides) {
    if (!titleTimeAgreesWithEvent(side.titled, side.other)) continue;
    const range = titleTimeRangeText(side.titled);
    if (!range) continue;
    return {
      field: "timing",
      choice: side.choice,
      text: `Il titolo dell'${mergeSideLabel(side.titled)} indica ${range}: proposto questo orario.`,
    };
  }
  return undefined;
}

export interface MergePlan {
  /** Solo i campi che richiedono una decisione o che hanno un valore da un solo lato. */
  fields: MergeFieldPreview[];
  /** Campi con un valore unico (uguali) o vuoti: non si mostrano come scelta. */
  summary: { field: MergeField; label: string; value: string }[];
  /** Impegno risultante: ha id, sourceType e collegamenti alla circolare della base. */
  merged: CalendarEvent;
  /** Spiegazione della preselezione dell'orario, quando il titolo di un lato lo dichiara. */
  hint?: MergeFieldHint;
}

export type MergeChoices = Partial<Record<MergeField, MergeChoice>>;

/** Lato da cui prende il valore un campo, dato l'esito delle scelte. */
function sideFor(
  field: MergeField,
  base: CalendarEvent,
  other: CalendarEvent,
  categoryLabel: (category: EventCategory) => string,
  choices: MergeChoices,
  defaultChoice: MergeChoice,
): MergeChoice | null {
  const baseValue = mergeFieldValue(base, field, categoryLabel);
  const otherValue = mergeFieldValue(other, field, categoryLabel);
  if (!baseValue && !otherValue) return null;
  if (!otherValue) return "base";
  if (!baseValue) return "other";
  if (fold(baseValue) === fold(otherValue)) return "base";
  return choices[field] ?? defaultChoice;
}

/**
 * Anteprima e risultato dell'unione. Campo per campo:
 * - uguali → un solo valore; vuoto da una parte → quello pieno (così il link Meet di
 *   Google non si perde mai, nemmeno quando l'altro lato non ce l'ha);
 * - pieni e diversi → scelta (preselezione: base, per il link quello presente, per
 *   l'orario quello coerente col titolo di un impegno, vedi `mergeTimingHint`);
 * - per le note è disponibile anche "tieni entrambe".
 */
export function planMerge(
  base: CalendarEvent,
  other: CalendarEvent,
  choices: MergeChoices = {},
  categoryLabel: (category: EventCategory) => string = category => category,
): MergePlan {
  const fields: MergeFieldPreview[] = [];
  const picked: Partial<Record<MergeField, MergeChoice>> = {};
  const hint = mergeTimingHint(base, other);

  for (const field of MERGE_FIELD_ORDER) {
    const defaultChoice: MergeChoice = field === "timing" ? hint?.choice ?? "base" : "base";
    const baseValue = mergeFieldValue(base, field, categoryLabel);
    const otherValue = mergeFieldValue(other, field, categoryLabel);
    if (baseValue && otherValue && fold(baseValue) !== fold(otherValue)) {
      fields.push({
        field,
        label: MERGE_FIELD_LABELS[field],
        baseValue,
        otherValue,
        status: "choice",
        defaultChoice,
        allowBoth: field === "notes",
      });
    }
    picked[field] = sideFor(field, base, other, categoryLabel, choices, defaultChoice) ?? undefined;
  }

  const notesChoice = choices.notes;
  const notesBoth = notesChoice === "both" && !!mergeFieldValue(base, "notes") && !!mergeFieldValue(other, "notes")
    && fold(mergeFieldValue(base, "notes")!) !== fold(mergeFieldValue(other, "notes")!);

  const pickFrom = (event: CalendarEvent, side: MergeChoice | undefined) => (side === "other" ? other : base);
  const titleSide = pickFrom(base, picked.title);
  const timingSide = pickFrom(base, picked.timing);
  const categorySide = pickFrom(base, picked.category);

  const notesText = notesBoth
    ? [clean(base.notes), clean(other.notes)].join("\n")
    : clean(pickFrom(base, picked.notes).notes) || undefined;

  const location = clean(pickFrom(base, picked.location).location) || undefined;
  const className = clean(pickFrom(base, picked.className).className) || undefined;
  const subject = clean(pickFrom(base, picked.subject).subject) || undefined;
  const meetingUrl = clean(pickFrom(base, picked.meetingUrl).meetingUrl) || undefined;
  const title = clean(titleSide.title) || base.title;
  const isAllDay = !!timingSide.isAllDay;

  // Collegamento Google: quello dell'impegno che lo porta (la base ha la precedenza).
  const linkSource = base.googleEventId ? base : other;
  const googleEventId = linkSource.googleEventId;
  const googleCalendarId = linkSource.googleCalendarId;

  const merged: CalendarEvent = {
    ...base,
    title,
    category: categorySide.category,
    date: base.date,
    isAllDay,
    startTime: isAllDay ? undefined : timingSide.startTime,
    endTime: isAllDay ? undefined : timingSide.endTime,
    location,
    className,
    subject,
    notes: notesText || undefined,
    meetingUrl,
    googleEventId,
    googleCalendarId,
    syncedWithGoogle: false,
  };
  // Nessuna chiave undefined nei campi assenti: l'impegno resta come quelli salvati.
  for (const key of Object.keys(merged) as (keyof CalendarEvent)[]) {
    if (merged[key] === undefined) delete merged[key];
  }

  const summary: MergePlan["summary"] = [];
  for (const field of MERGE_FIELD_ORDER) {
    const value = mergeFieldValue(merged, field, categoryLabel);
    if (value) summary.push({ field, label: MERGE_FIELD_LABELS[field], value });
  }

  // La riga di spiegazione ha senso solo se l'orario è davvero una scelta da fare.
  const timingIsChoice = fields.some(field => field.field === "timing");
  return { fields, summary, merged, ...(hint && timingIsChoice ? { hint } : {}) };
}
