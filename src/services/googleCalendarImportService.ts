import { database } from "./db";
import { storage } from "./storage";
import {
  listCalendarEvents,
  listGoogleCalendarEvents,
  PRIMARY_CALENDAR_ID,
  type GoogleCalendarApiEvent,
  type GoogleCalendarEventList,
} from "./googleCalendarService";
import { addDaysISO, localDateISO, parseCivilDate } from "../utils/dates";
import { mergeGoogleCalendarEvents, mergeGoogleCalendarGroups, type GoogleCalendarEventGroup } from "../utils/googleCalendarImport";
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

export function googleCalendarImportWindow(now: Date = new Date()): { timeMin: string; timeMax: string } {
  const today = localDateISO(now);
  const minDate = addDaysISO(today, -30);
  const max = parseCivilDate(today);
  max.setFullYear(max.getFullYear() + 1);
  const maxDate = localDateISO(max);
  // Bounded civil-date window. UTC midnight may include at most a boundary hour,
  // while event mapping itself always uses Europe/Rome.
  return { timeMin: `${minDate}T00:00:00Z`, timeMax: `${maxDate}T23:59:59Z` };
}

interface ImportDependencies {
  list?: (token: string, min: string, max: string) => Promise<GoogleCalendarEventList | GoogleCalendarApiEvent[]>;
  read?: () => Promise<CalendarEvent[]>;
  write?: (events: CalendarEvent[]) => Promise<void>;
  atomic?: <T>(operation: () => Promise<T>) => Promise<T>;
  now?: Date;
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
  const range = googleCalendarImportWindow(dependencies.now);
  const list = dependencies.list ?? listGoogleCalendarEvents;
  const remote = await list(accessToken, range.timeMin, range.timeMax);
  const partial = "partial" in remote ? !!remote.partial : false;
  const pagesRead = "pagesRead" in remote && typeof remote.pagesRead === "number" ? remote.pagesRead : 1;
  const read = dependencies.read ?? (() => storage.getEvents());
  const write = dependencies.write ?? (events => storage.saveEvents(events));
  const atomic = dependencies.atomic ?? (operation => database.atomic(operation));

  return atomic(async () => {
    const merged = mergeGoogleCalendarEvents(await read(), remote);
    await write(merged.events);
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
  const range = googleCalendarImportWindow(dependencies.now);
  const list = dependencies.list ?? ((token, calendarId, min, max) => listCalendarEvents(token, calendarId, min, max));

  const groups: GoogleCalendarEventGroup[] = [];
  const inaccessibleCalendarIds: string[] = [];
  const failedCalendarIds: string[] = [];
  let partial = false;
  let pagesRead = 0;

  for (const calendarId of ids) {
    try {
      const remote = await list(accessToken, calendarId, range.timeMin, range.timeMax);
      if ("partial" in remote && remote.partial) partial = true;
      pagesRead += "pagesRead" in remote && typeof remote.pagesRead === "number" ? remote.pagesRead : 1;
      groups.push({ calendarId, isPrimary: calendarId === PRIMARY_CALENDAR_ID, events: [...remote] });
    } catch (error) {
      partial = true;
      if (isInaccessibleCalendarError(error)) inaccessibleCalendarIds.push(calendarId);
      else failedCalendarIds.push(calendarId);
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
    await write(merged.events);
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
