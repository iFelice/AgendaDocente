import { database } from "./db";
import { storage } from "./storage";
import {
  listGoogleCalendarEvents,
  type GoogleCalendarApiEvent,
  type GoogleCalendarEventList,
} from "./googleCalendarService";
import { addDaysISO, localDateISO, parseCivilDate } from "../utils/dates";
import { mergeGoogleCalendarEvents } from "../utils/googleCalendarImport";
import type { CalendarEvent } from "../types";

export interface GoogleCalendarImportResult {
  added: number;
  updated: number;
  linked: number;
  ignoredCancelled: number;
  partial: boolean;
  pagesRead: number;
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
