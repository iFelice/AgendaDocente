import { nextDateISO, eventDateError } from "../utils/dates";
import { CalendarEvent } from "../types";

export interface GoogleCalendarApiEvent {
  id?: string;
  summary: string;
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

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

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

/**
 * Fetches upcoming Google Calendar events
 */
export const listGoogleCalendarEvents = async (
  accessToken: string,
  timeMin?: string,
  timeMax?: string
): Promise<GoogleCalendarApiEvent[]> => {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
  });
  if (timeMin) params.append("timeMin", timeMin);
  if (timeMax) params.append("timeMax", timeMax);

  const response = await fetch(`${CALENDAR_API_BASE}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(
      errData?.error?.message || `Errore recupero eventi Google Calendar (${response.status})`
    );
  }

  const data = await response.json();
  return (data.items || []) as GoogleCalendarApiEvent[];
};

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
