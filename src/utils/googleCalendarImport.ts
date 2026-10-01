import type { CalendarEvent } from "../types";
import type { GoogleCalendarApiEvent } from "../services/googleCalendarService";

const ROME_TIME_ZONE = "Europe/Rome";

/** Format an RFC3339 instant as AgendaDocente civil date/time in Europe/Rome. */
export function googleDateTimeInRome(dateTime: string): { date: string; time: string } {
  const instant = new Date(dateTime);
  if (Number.isNaN(instant.getTime())) throw new Error("Data Google Calendar non valida");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ROME_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

/**
 * Maps one Google occurrence to one local event. Multi-day all-day events are
 * deliberately represented by their first day only in G1 (Google's end.date is exclusive).
 */
export function googleEventLocalId(calendarId: string | undefined, eventId: string): string {
  // G1 kept `gcal-<eventId>`; with several calendars the local id must carry both identities.
  return calendarId
    ? `gcal-${encodeURIComponent(calendarId)}-${encodeURIComponent(eventId)}`
    : `gcal-${encodeURIComponent(eventId)}`;
}

export function googleEventToCalendarEvent(remote: GoogleCalendarApiEvent, calendarId?: string): CalendarEvent {
  if (!remote.id) throw new Error("Evento Google Calendar senza identificativo");

  const allDay = !!remote.start?.date;
  let date: string;
  let startTime: string | undefined;
  let endTime: string | undefined;

  if (allDay) {
    date = remote.start.date!;
  } else {
    if (!remote.start?.dateTime || !remote.end?.dateTime) {
      throw new Error("Evento Google Calendar senza data completa");
    }
    const start = googleDateTimeInRome(remote.start.dateTime);
    const end = googleDateTimeInRome(remote.end.dateTime);
    date = start.date;
    startTime = start.time;
    endTime = end.time;
  }

  return {
    id: googleEventLocalId(calendarId, remote.id),
    title: remote.summary?.trim() || "Evento Google",
    category: "personale",
    date,
    startTime,
    endTime,
    isAllDay: allDay,
    location: remote.location,
    notes: remote.description,
    googleEventId: remote.id,
    ...(calendarId ? { googleCalendarId: calendarId } : {}),
    sourceType: "google_calendar",
    syncedWithGoogle: false,
    completed: false,
  };
}

export interface GoogleCalendarMergeResult {
  events: CalendarEvent[];
  added: number;
  updated: number;
  linked: number;
  ignoredCancelled: number;
}

/** Pure googleEventId-only merge. Agenda-origin records are never changed. */
export function mergeGoogleCalendarEvents(
  localEvents: CalendarEvent[],
  remoteEvents: GoogleCalendarApiEvent[],
): GoogleCalendarMergeResult {
  const events = [...localEvents];
  let added = 0;
  let updated = 0;
  let linked = 0;
  let ignoredCancelled = 0;

  for (const remote of remoteEvents) {
    if (remote.status === "cancelled") {
      ignoredCancelled++;
      continue;
    }
    const mapped = googleEventToCalendarEvent(remote);
    const index = events.findIndex(event => event.googleEventId === remote.id);
    if (index < 0) {
      events.push(mapped);
      added++;
      continue;
    }
    const existing = events[index];
    if (existing.sourceType !== "google_calendar") {
      linked++;
      continue;
    }
    events[index] = {
      ...existing,
      ...mapped,
      id: existing.id,
      googleEventId: existing.googleEventId,
      sourceType: "google_calendar",
      completed: existing.completed,
      updatedAt: existing.updatedAt,
    };
    updated++;
  }

  return { events, added, updated, linked, ignoredCancelled };
}


/** One selected Google calendar and the events already downloaded from it. */
export interface GoogleCalendarEventGroup {
  calendarId: string;
  /** The primary calendar enables legacy (G1) matching on googleEventId alone. */
  isPrimary?: boolean;
  events: GoogleCalendarApiEvent[];
}

/**
 * Multi-calendar merge. Remote identity is `googleCalendarId + googleEventId`.
 *
 * Backward compatibility rules:
 * - primary: a legacy local record (`sourceType === "google_calendar"` and no
 *   `googleCalendarId`) matching on `googleEventId` is the SAME event. It keeps its local id
 *   and `completed`, and simply acquires `googleCalendarId` on first refresh.
 * - primary: an Agenda-born event already linked to Google (`sourceType !== "google_calendar"`)
 *   counts as linked and is never duplicated nor overwritten.
 * - shared calendars: never match on `googleEventId` alone, so a shared event can never
 *   collide with an Agenda event or with the same event id coming from another calendar.
 */
export function mergeGoogleCalendarGroups(
  localEvents: CalendarEvent[],
  groups: GoogleCalendarEventGroup[],
): GoogleCalendarMergeResult {
  const events = [...localEvents];
  let added = 0;
  let updated = 0;
  let linked = 0;
  let ignoredCancelled = 0;

  for (const group of groups) {
    const { calendarId } = group;
    for (const remote of group.events) {
      if (remote.status === "cancelled") {
        ignoredCancelled++;
        continue;
      }
      const mapped = googleEventToCalendarEvent(remote, calendarId);
      let index = events.findIndex(
        event => event.googleCalendarId === calendarId && event.googleEventId === remote.id,
      );
      if (index < 0 && group.isPrimary) {
        index = events.findIndex(
          event => event.googleCalendarId == null && event.googleEventId === remote.id,
        );
      }
      if (index < 0) {
        events.push(mapped);
        added++;
        continue;
      }
      const existing = events[index];
      if (existing.sourceType !== "google_calendar") {
        // Agenda → Google record already linked to this remote event: never touched here.
        linked++;
        continue;
      }
      events[index] = {
        ...existing,
        ...mapped,
        id: existing.id,
        googleEventId: existing.googleEventId,
        googleCalendarId: calendarId,
        sourceType: "google_calendar",
        syncedWithGoogle: false,
        completed: existing.completed,
        updatedAt: existing.updatedAt,
      };
      updated++;
    }
  }

  return { events, added, updated, linked, ignoredCancelled };
}
