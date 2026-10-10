import { database } from "./db";
import { storage } from "./storage";
import {
  listCalendarEvents,
  listGoogleCalendarEvents,
  PRIMARY_CALENDAR_ID,
  isPrimaryCalendarId,
  type GoogleCalendarApiEvent,
  type GoogleCalendarEventList,
} from "./googleCalendarService";
import { addDaysISO, localDateISO } from "../utils/dates";
import {
  mergeGoogleCalendarEvents,
  mergeGoogleCalendarGroups,
  removeImportedGoogleEventsBeyondDate,
  type GoogleCalendarEventGroup,
} from "../utils/googleCalendarImport";
import { getSchoolYearBoundaries } from "../utils/schoolYear";
import type { CalendarEvent, TeacherProfile } from "../types";

export interface GoogleCalendarImportResult {
  added: number;
  updated: number;
  linked: number;
  ignoredCancelled: number;
  partial: boolean;
  pagesRead: number;
  /** G1.2 aggregate info; absent/neutral for the single-calendar G1 path. */
  calendarsRequested?: number;
  calendarsImported?: number;
  inaccessibleCalendarIds?: string[];
  failedCalendarIds?: string[];
}

/**
 * Legacy profiles (no `googleCalendarImportIds`) import only the primary calendar,
 * exactly like G1. The primary calendar is also always implicitly readable.
 */
export function resolveImportCalendarIds(
  profile?: Pick<TeacherProfile, "googleCalendarImportIds"> | null,
): string[] {
  const configured = profile?.googleCalendarImportIds;
  if (!Array.isArray(configured)) return [PRIMARY_CALENDAR_ID];
  return Array.from(new Set(configured.filter(id => typeof id === "string" && id.trim() !== "")));
}

/** Google signals a calendar the user can no longer read with 403/404/410. */
function isInaccessibleCalendarError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === 403 || status === 404 || status === 410) return true;
  const message = error instanceof Error ? error.message : "";
  return /\b(403|404|410)\b/.test(message) || /not found|forbidden/i.test(message);
}

/**
 * Finestra di importazione, SEMPRE limitata all'anno scolastico del profilo:
 * - `timeMax` = 31 agosto dell'anno scolastico (ultimo giorno utile);
 * - `timeMin` = il più recente fra (oggi − 30 giorni) e il 1 settembre dell'anno scolastico,
 *   così a inizio anno non si importa il residuo dell'anno precedente.
 *
 * Un anno scolastico mancante o non valido ricade sull'anno corrente (regola esistente),
 * quindi la finestra non è mai "un anno avanti" rispetto all'anno del profilo. Cambiando
 * l'anno nel profilo, la sincronizzazione successiva usa subito i nuovi confini.
 */
export function googleCalendarImportWindow(
  now: Date = new Date(),
  schoolYear?: string | null,
): { timeMin: string; timeMax: string } {
  const today = localDateISO(now);
  const { start, end } = getSchoolYearBoundaries(schoolYear, now);
  const lastMonth = addDaysISO(today, -30);
  const minDate = lastMonth > start ? lastMonth : start;
  // Bounded civil-date window. UTC midnight may include at most a boundary hour,
  // while event mapping itself always uses Europe/Rome.
  return { timeMin: `${minDate}T00:00:00Z`, timeMax: `${end}T23:59:59Z` };
}

/**
 * Un anno scolastico già concluso (profilo non aggiornato) produce una finestra vuota:
 * chiederla a Google sarebbe una richiesta non valida (minimo dopo il massimo), quindi
 * la sincronizzazione non legge e non scrive nulla. Nessun evento viene toccato finché
 * l'anno scolastico del profilo non torna a contenere la data odierna.
 */
function isEmptyImportWindow(range: { timeMin: string; timeMax: string }): boolean {
  return range.timeMin > range.timeMax;
}

const EMPTY_IMPORT_RESULT: GoogleCalendarImportResult = {
  added: 0,
  updated: 0,
  linked: 0,
  ignoredCancelled: 0,
  partial: false,
  pagesRead: 0,
};

interface ImportDependencies {
  list?: (token: string, min: string, max: string) => Promise<GoogleCalendarEventList | GoogleCalendarApiEvent[]>;
  read?: () => Promise<CalendarEvent[]>;
  write?: (events: CalendarEvent[]) => Promise<void>;
  atomic?: <T>(operation: () => Promise<T>) => Promise<T>;
  now?: Date;
  /** Anno scolastico del profilo: governa la finestra e la pulizia oltre il 31 agosto. */
  schoolYear?: string | null;
}

/**
 * Read-only Google workflow: all remote I/O completes before one local atomic merge.
 * It intentionally invokes only Calendar API GET/list and never outbound sync helpers.
 */
export async function importGoogleCalendarEvents(
  accessToken: string,
  dependencies: ImportDependencies = {},
): Promise<GoogleCalendarImportResult> {
  if (!accessToken) throw new Error("Riconnetti l’account Google per autorizzare il download degli eventi.");
  const range = googleCalendarImportWindow(dependencies.now, dependencies.schoolYear);
  if (isEmptyImportWindow(range)) return { ...EMPTY_IMPORT_RESULT };
  const schoolYearEnd = getSchoolYearBoundaries(dependencies.schoolYear, dependencies.now).end;
  const list = dependencies.list ?? listGoogleCalendarEvents;
  const remote = await list(accessToken, range.timeMin, range.timeMax);
  const partial = "partial" in remote ? !!remote.partial : false;
  const pagesRead = "pagesRead" in remote && typeof remote.pagesRead === "number" ? remote.pagesRead : 1;
  const read = dependencies.read ?? (() => storage.getEvents());
  const write = dependencies.write ?? (events => storage.saveEvents(events));
  const atomic = dependencies.atomic ?? (operation => database.atomic(operation));

  return atomic(async () => {
    const merged = mergeGoogleCalendarEvents(await read(), remote);
    // La riconciliazione per identità non rimuove mai nulla: gli eventi Google già
    // salvati oltre il 31 agosto dell'anno scolastico vengono ripuliti qui, nella
    // stessa unica scrittura atomica. Impegni manuali e da circolare restano intatti.
    const events = removeImportedGoogleEventsBeyondDate(merged.events, schoolYearEnd);
    await write(events);
    return {
      added: merged.added,
      updated: merged.updated,
      linked: merged.linked,
      ignoredCancelled: merged.ignoredCancelled,
      partial,
      pagesRead,
    };
  });
}


interface MultiImportDependencies {
  list?: (
    token: string,
    calendarId: string,
    min: string,
    max: string,
  ) => Promise<GoogleCalendarEventList | GoogleCalendarApiEvent[]>;
  read?: () => Promise<CalendarEvent[]>;
  write?: (events: CalendarEvent[]) => Promise<void>;
  atomic?: <T>(operation: () => Promise<T>) => Promise<T>;
  now?: Date;
  /** Anno scolastico del profilo: governa la finestra e la pulizia oltre il 31 agosto. */
  schoolYear?: string | null;
  /**
   * Id reale del calendario principale (dalla CalendarList già letta dall'app,
   * live o cache). Abilita la migrazione email → "primary" degli eventi locali
   * e il riconoscimento degli impegni inviati al principale (difetto PR #76).
   */
  primaryCalendarId?: string;
}

/**
 * G1.2 read-only multi-calendar workflow.
 *
 * Strategy (documented on purpose):
 * 1. every selected calendar is downloaded FIRST, sequentially (bounded concurrency = 1,
 *    so a single auto-import never fans out dozens of simultaneous requests);
 * 2. a calendar that fails is skipped, never aborting the run: the local DB is simply not
 *    told anything about it, so nothing can be corrupted and no historical event is removed;
 * 3. all downloaded calendars are merged together and written in ONE final atomic write.
 *
 * It uses Calendar API GET/list only: no POST, PATCH or DELETE ever happens inbound.
 */
export async function importSelectedGoogleCalendars(
  accessToken: string,
  calendarIds: string[] = [PRIMARY_CALENDAR_ID],
  dependencies: MultiImportDependencies = {},
): Promise<GoogleCalendarImportResult> {
  if (!accessToken) throw new Error("Riconnetti l’account Google per autorizzare il download degli eventi.");
  const ids = Array.from(new Set(calendarIds));
  if (ids.length === 0) {
    return {
      added: 0,
      updated: 0,
      linked: 0,
      ignoredCancelled: 0,
      partial: false,
      pagesRead: 0,
      calendarsRequested: 0,
      calendarsImported: 0,
      inaccessibleCalendarIds: [],
      failedCalendarIds: [],
    };
  }
  const range = googleCalendarImportWindow(dependencies.now, dependencies.schoolYear);
  if (isEmptyImportWindow(range)) {
    return { ...EMPTY_IMPORT_RESULT, calendarsRequested: ids.length, calendarsImported: 0, inaccessibleCalendarIds: [], failedCalendarIds: [] };
  }
  const schoolYearEnd = getSchoolYearBoundaries(dependencies.schoolYear, dependencies.now).end;
  const list = dependencies.list ?? ((token, calendarId, min, max) => listCalendarEvents(token, calendarId, min, max));

  const groups: GoogleCalendarEventGroup[] = [];
  const inaccessibleCalendarIds: string[] = [];
  const failedCalendarIds: string[] = [];
  let partial = false;
  let pagesRead = 0;

  for (const rawCalendarId of ids) {
    // La selezione può esporre il principale col suo id reale (l'email): lo si
    // riconosce con la stessa regola unica e si normalizza a "primary".
    const primaryEntry = dependencies.primaryCalendarId
      ? [{ id: dependencies.primaryCalendarId, primary: true }]
      : undefined;
    const isPrimary = isPrimaryCalendarId(rawCalendarId, primaryEntry);
    const calendarId = isPrimary ? PRIMARY_CALENDAR_ID : rawCalendarId;
    try {
      const remote = await list(accessToken, calendarId, range.timeMin, range.timeMax);
      if ("partial" in remote && remote.partial) partial = true;
      pagesRead += "pagesRead" in remote && typeof remote.pagesRead === "number" ? remote.pagesRead : 1;
      groups.push({
        calendarId,
        isPrimary,
        primaryCalendarId: isPrimary ? dependencies.primaryCalendarId : undefined,
        events: [...remote],
      });
    } catch (error) {
      partial = true;
      if (isInaccessibleCalendarError(error)) inaccessibleCalendarIds.push(rawCalendarId);
      else failedCalendarIds.push(rawCalendarId);
    }
  }

  if (groups.length === 0) {
    const reason = inaccessibleCalendarIds.length > 0
      ? "Nessun calendario Google selezionato risulta accessibile."
      : "Aggiornamento Google Calendar non riuscito.";
    throw new Error(reason);
  }

  const read = dependencies.read ?? (() => storage.getEvents());
  const write = dependencies.write ?? (events => storage.saveEvents(events));
  const atomic = dependencies.atomic ?? (operation => database.atomic(operation));

  return atomic(async () => {
    const merged = mergeGoogleCalendarGroups(await read(), groups);
    // Un evento di un calendario non più leggibile resta salvato (nessuna rimozione
    // basata sulla risposta remota), ma la pulizia oltre il 31 agosto è una proprietà
    // della data locale e vale per tutti gli eventi di origine Google.
    const events = removeImportedGoogleEventsBeyondDate(merged.events, schoolYearEnd);
    await write(events);
    return {
      added: merged.added,
      updated: merged.updated,
      linked: merged.linked,
      ignoredCancelled: merged.ignoredCancelled,
      partial,
      pagesRead,
      calendarsRequested: ids.length,
      calendarsImported: groups.length,
      inaccessibleCalendarIds,
      failedCalendarIds,
    };
  });
}
