import { nextDateISO, eventDateError } from "../utils/dates";
import { CalendarEvent } from "../types";

export interface GoogleCalendarApiEvent {
  id?: string;
  summary?: string;
  status?: string;
  description?: string;
  location?: string;
  start: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
}

const CALENDAR_V3_BASE = "https://www.googleapis.com/calendar/v3";
/** Outbound (create/update/delete) stays primary-only by design: G1.2 never writes shared calendars. */
const CALENDAR_API_BASE = `${CALENDAR_V3_BASE}/calendars/primary/events`;
export const PRIMARY_CALENDAR_ID = "primary";

/** Minimal CalendarList entry: G1.2 needs identity and read access only, no colors/metadata. */
export interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  selected?: boolean;
  hidden?: boolean;
}

/** Reads every CalendarList page (GET only) and keeps calendars the user can at least read. */
export const listGoogleCalendars = async (
  accessToken: string,
  limits: { maxPages?: number } = {},
): Promise<GoogleCalendarListEntry[]> => {
  if (!accessToken) throw new Error("Riconnetti l’account Google per leggere l’elenco dei calendari.");
  const maxPages = limits.maxPages ?? 10;
  const calendars: GoogleCalendarListEntry[] = [];
  let pageToken: string | undefined;
  let pagesRead = 0;

  do {
    const params = new URLSearchParams({ maxResults: "250", minAccessRole: "reader" });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`${CALENDAR_V3_BASE}/users/me/calendarList?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `Errore elenco calendari Google (${response.status})`);
    }
    const data = await response.json() as { items?: GoogleCalendarListEntry[]; nextPageToken?: string };
    pagesRead++;
    for (const item of data.items ?? []) {
      if (!item?.id) continue;
      calendars.push({
        id: item.id,
        summary: item.summary || item.id,
        primary: item.primary,
        accessRole: item.accessRole,
        selected: item.selected,
        hidden: item.hidden,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken && pagesRead < maxPages);

  return calendars;
};

function validateExportEvent(event: CalendarEvent): void {
  const error = eventDateError(event);
  if (error) throw new Error(`Impossibile esportare "${event.title}": ${error}`);
}

/**
 * Transforms an Agenda Docente CalendarEvent into a Google Calendar API format
 */
export const toGoogleCalendarPayload = (event: CalendarEvent): GoogleCalendarApiEvent => {
  validateExportEvent(event);
  const timeZone = "Europe/Rome";
  const categoryLabel = event.category.toUpperCase().replace(/_/g, " ");

  const descriptionParts = [
    `Agenda Docente - ${categoryLabel}`,
    event.className ? `Classe: ${event.className}` : "",
    event.subject ? `Materia: ${event.subject}` : "",
    event.notes ? `Note: ${event.notes}` : "",
    event.sourceCircularTitle ? `Fonte: Circolare "${event.sourceCircularTitle}"` : "",
  ].filter(Boolean);

  const payload: GoogleCalendarApiEvent = {
    summary: event.title,
    description: descriptionParts.join("\n"),
    location: event.location || undefined,
    start: {},
    end: {},
  };

  if (event.isAllDay) {
    payload.start = { date: event.date };
    payload.end = { date: nextDateISO(event.date) };
  } else {
    const startStr = event.startTime;
    const endStr = event.endTime;

    payload.start = {
      dateTime: `${event.date}T${startStr}:00`,
      timeZone,
    };
    payload.end = {
      dateTime: `${event.date}T${endStr}:00`,
      timeZone,
    };
  }

  return payload;
};

/**
 * Creates an event on user's primary Google Calendar
 */
export const createGoogleCalendarEvent = async (
  accessToken: string,
  event: CalendarEvent
): Promise<string> => {
  const payload = toGoogleCalendarPayload(event);
  const response = await fetch(CALENDAR_API_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(
      errData?.error?.message || `Errore Google Calendar (${response.status})`
    );
  }

  const created = await response.json();
  return created.id as string;
};

/**
 * Updates an event on user's primary Google Calendar
 */
export const updateGoogleCalendarEvent = async (
  accessToken: string,
  googleEventId: string,
  event: CalendarEvent
): Promise<void> => {
  const payload = toGoogleCalendarPayload(event);
  const response = await fetch(`${CALENDAR_API_BASE}/${encodeURIComponent(googleEventId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(
      errData?.error?.message || `Errore aggiornamento Google Calendar (${response.status})`
    );
  }
};

/**
 * Deletes an event from Google Calendar
 */
export const deleteGoogleCalendarEvent = async (
  accessToken: string,
  googleEventId: string
): Promise<void> => {
  const response = await fetch(`${CALENDAR_API_BASE}/${encodeURIComponent(googleEventId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok && response.status !== 404 && response.status !== 410) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(
      errData?.error?.message || `Errore eliminazione da Google Calendar (${response.status})`
    );
  }
};

/** Array result retains the old API while exposing whether the safety cap truncated it. */
export type GoogleCalendarEventList = GoogleCalendarApiEvent[] & {
  partial: boolean;
  pagesRead: number;
};

/** Fetches every page of one calendar in the requested range, up to G1's explicit safety cap. */
export const listCalendarEvents = async (
  accessToken: string,
  calendarId: string = PRIMARY_CALENDAR_ID,
  timeMin?: string,
  timeMax?: string,
  limits: { maxPages?: number; maxEvents?: number } = {},
): Promise<GoogleCalendarEventList> => {
  const maxPages = limits.maxPages ?? 10;
  const maxEvents = limits.maxEvents ?? 1000;
  const events: GoogleCalendarApiEvent[] = [];
  const endpoint = `${CALENDAR_V3_BASE}/calendars/${encodeURIComponent(calendarId || PRIMARY_CALENDAR_ID)}/events`;
  let pageToken: string | undefined;
  let pagesRead = 0;
  let partial = false;

  do {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "100",
    });
    if (timeMin) params.set("timeMin", timeMin);
    if (timeMax) params.set("timeMax", timeMax);
    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetch(`${endpoint}?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const error = new Error(errData?.error?.message || `Errore recupero eventi Google Calendar (${response.status})`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }

    const data = await response.json() as { items?: GoogleCalendarApiEvent[]; nextPageToken?: string };
    pagesRead++;
    const room = Math.max(0, maxEvents - events.length);
    const pageItems = data.items ?? [];
    events.push(...pageItems.slice(0, room));
    pageToken = data.nextPageToken;
    if (pageItems.length > room || (pageToken && (pagesRead >= maxPages || events.length >= maxEvents))) {
      partial = true;
      break;
    }
  } while (pageToken);

  return Object.assign(events, { partial, pagesRead });
};

/** G1 signature kept intact for outbound/primary callers and the existing suite. */
export const listGoogleCalendarEvents = async (
  accessToken: string,
  timeMin?: string,
  timeMax?: string,
  limits: { maxPages?: number; maxEvents?: number } = {},
): Promise<GoogleCalendarEventList> => listCalendarEvents(accessToken, PRIMARY_CALENDAR_ID, timeMin, timeMax, limits);

/**
 * Generates an official Google Calendar 1-click web URL to add an event without requiring any OAuth scopes
 */
export const getGoogleCalendarWebUrl = (event: CalendarEvent): string => {
  validateExportEvent(event);
  const title = encodeURIComponent(event.title);
  const location = event.location ? encodeURIComponent(event.location) : "";
  const details = encodeURIComponent(
    [
      event.notes || "",
      event.className ? `Classe: ${event.className}` : "",
      event.subject ? `Materia: ${event.subject}` : "",
      event.sourceCircularTitle ? `Fonte circolare: ${event.sourceCircularTitle}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );

  const cleanDate = event.date.replace(/-/g, "");
  let datesParam = "";
  if (event.isAllDay) {
    datesParam = `${cleanDate}/${nextDateISO(event.date).replace(/-/g, "")}`;
  } else {
    const startHour = event.startTime!.replace(":", "") + "00";
    const endHour = event.endTime!.replace(":", "") + "00";
    datesParam = `${cleanDate}T${startHour}/${cleanDate}T${endHour}`;
  }

  let url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${datesParam}`;
  if (details) url += `&details=${details}`;
  if (location) url += `&location=${location}`;
  return url;
};

/**
 * Exports events as a standard .ics iCalendar file that can be imported directly
 * into Google Calendar, Apple Calendar, or Outlook without any OAuth verification.
 */
export const downloadIcsCalendar = (events: CalendarEvent[], filename = "agenda_docente.ics") => {
  // Validate the entire collection before creating or downloading a file.
  events.forEach(validateExportEvent);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(
    now.getUTCHours()
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const escapeIcs = (str: string) =>
    str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Agenda Docente Digitale//IT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Agenda Docente",
    "X-WR-TIMEZONE:Europe/Rome",
  ];

  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.id || Math.random().toString(36).substring(2)}@agendadocente`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SUMMARY:${escapeIcs(ev.title)}`);

    const cleanDate = ev.date.replace(/-/g, "");
    if (ev.isAllDay) {
      lines.push(`DTSTART;VALUE=DATE:${cleanDate}`);
      lines.push(`DTEND;VALUE=DATE:${nextDateISO(ev.date).replace(/-/g, "")}`);
    } else {
      const sH = ev.startTime!.replace(":", "");
      const eH = ev.endTime!.replace(":", "");
      lines.push(`DTSTART:${cleanDate}T${sH}00`);
      lines.push(`DTEND:${cleanDate}T${eH}00`);
    }

    if (ev.location) {
      lines.push(`LOCATION:${escapeIcs(ev.location)}`);
    }

    const descParts = [
      `Categoria: ${ev.category}`,
      ev.className ? `Classe: ${ev.className}` : "",
      ev.subject ? `Materia: ${ev.subject}` : "",
      ev.notes ? `Note: ${ev.notes}` : "",
      ev.sourceCircularTitle ? `Circolare: ${ev.sourceCircularTitle}` : "",
    ].filter(Boolean);

    if (descParts.length > 0) {
      lines.push(`DESCRIPTION:${escapeIcs(descParts.join("\n"))}`);
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/** Only an explicit per-event opt-in grants permission to send data to Google. */
export const isGoogleSyncEnabled = (event: Pick<CalendarEvent, 'syncedWithGoogle'>): boolean =>
  event.syncedWithGoogle === true;

async function syncGoogleEventsUnlocked(
  token: string,
  eventIds: string[],
  readEvent: (id: string) => CalendarEvent | undefined | Promise<CalendarEvent | undefined>,
  saveEvent: (event: CalendarEvent) => void | Promise<void>,
): Promise<{ syncedCount: number; errorCount: number }> {
  let syncedCount = 0, errorCount = 0;
  for (const id of new Set(eventIds)) {
    // Re-read before each request: consent may have changed while a previous request was running.
    const event = await readEvent(id);
    if (!event || !isGoogleSyncEnabled(event)) continue;
    try {
      if (event.googleEventId) {
        await updateGoogleCalendarEvent(token, event.googleEventId, event);
      } else {
        const googleEventId = await createGoogleCalendarEvent(token, event);
        const latest = await readEvent(id);
        // Preserve a revoked consent and any edits made during the request; never resurrect a deleted event.
        if (latest && !latest.googleEventId) await saveEvent({ ...latest, googleEventId });
      }
      syncedCount++;
    } catch {
      // Do not log event titles, notes, tokens or API response bodies.
      errorCount++;
    }
  }
  return { syncedCount, errorCount };
}

// Web Locks coordinate concurrent sync buttons across tabs. Older browsers still serialize within a tab.
let pendingSync: Promise<unknown> = Promise.resolve();
export function syncOptedInGoogleEvents(...args: Parameters<typeof syncGoogleEventsUnlocked>): ReturnType<typeof syncGoogleEventsUnlocked> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('agenda-docente-google-sync', () => syncGoogleEventsUnlocked(...args));
  }
  const result = pendingSync.then(() => syncGoogleEventsUnlocked(...args));
  pendingSync = result.catch(() => undefined);
  return result;
}
