import type { CalendarEvent } from "../types";
import { PRIMARY_CALENDAR_ID, type GoogleCalendarApiEvent } from "../services/googleCalendarService";
import { isValidDate } from "./dates";
import { normalizeMeetingUrl } from "./meetingLinks";

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

/**
 * Link della videoconferenza pubblicata da Google per un evento.
 *
 * `hangoutLink` vince sempre: è il campo che Google usa per il proprio pulsante
 * "Partecipa". In sua assenza si prende il PRIMO `conferenceData.entryPoints` di tipo
 * "video" (phone/sip/more non fanno partecipare a una videochiamata). Un `uri` non https
 * viene scartato con lo stesso contratto del campo salvato (`normalizeMeetingUrl`):
 * dall'import Google non entra mai un link che l'editor o il backup rifiuterebbero.
 */
export function googleEventMeetingUrl(remote: GoogleCalendarApiEvent): string | undefined {
  const hangoutLink = normalizeMeetingUrl(remote.hangoutLink);
  if (hangoutLink) return hangoutLink;
  const entryPoints = remote.conferenceData?.entryPoints;
  if (!Array.isArray(entryPoints)) return undefined;
  for (const entryPoint of entryPoints) {
    if (!entryPoint || entryPoint.entryPointType !== "video") continue;
    const uri = normalizeMeetingUrl(entryPoint.uri);
    if (uri) return uri;
  }
  return undefined;
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

  const meetingUrl = googleEventMeetingUrl(remote);

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
    // Chiave assente quando Google non pubblica alcun link: un evento importato senza
    // videoconferenza resta identico a prima (nessun campo vuoto, nessuna chiave undefined).
    ...(meetingUrl ? { meetingUrl } : {}),
    googleEventId: remote.id,
    ...(calendarId ? { googleCalendarId: calendarId } : {}),
    sourceType: "google_calendar",
    syncedWithGoogle: false,
    completed: false,
  };
}

/**
 * Removes only inbound Google events belonging to calendars explicitly removed
 * from the user's selection. The primary legacy fallback is intentionally
 * limited to the primary calendar.
 */
export function removeImportedGoogleEventsForCalendars(
  events: CalendarEvent[],
  removedCalendarIds: string[],
): CalendarEvent[] {
  const removed = new Set(removedCalendarIds);
  return events.filter(event => {
    if (event.sourceType !== "google_calendar") return true;
    if (event.googleCalendarId && removed.has(event.googleCalendarId)) return false;
    // Older imports had no calendar id and can only belong to primary.
    if (!event.googleCalendarId && removed.has("primary") && event.googleEventId != null) return false;
    return true;
  });
}

/**
 * Confine superiore dell'importazione: un evento Google già salvato con data civile
 * OLTRE l'ultimo giorno dell'anno scolastico (31 agosto) non appartiene più alla
 * finestra gestita e viene rimosso alla sincronizzazione successiva.
 *
 * Regole rigorose:
 * - solo `sourceType === "google_calendar"`: un impegno creato dall'utente o importato
 *   da circolare non viene MAI rimosso, nemmeno se collegato a Google (`googleEventId`);
 * - solo il lato futuro: gli eventi Google passati restano lo storico locale già
 *   scaricato (l'Archivio li mostra) e la finestra inferiore è solo un limite di lettura;
 * - una data non valida non è motivo di rimozione.
 */
export function removeImportedGoogleEventsBeyondDate(
  events: CalendarEvent[],
  lastDayIso: string,
): CalendarEvent[] {
  return events.filter(event => {
    if (event.sourceType !== "google_calendar") return true;
    if (!isValidDate(event.date)) return true;
    return event.date <= lastDayIso;
  });
}

export interface GoogleCalendarMergeResult {
  events: CalendarEvent[];
  added: number;
  updated: number;
  linked: number;
  ignoredCancelled: number;
}

/**
 * Unica modifica consentita a un impegno dell'app collegato a Google: se il suo link della
 * videochiamata è vuoto e Google ne pubblica uno, il link viene aggiunto. Un link già
 * presente non viene mai sostituito; tutti gli altri campi restano quelli dell'app.
 */
function withGoogleMeetingLinkIfEmpty(existing: CalendarEvent, mapped: CalendarEvent): CalendarEvent {
  if (existing.meetingUrl || !mapped.meetingUrl) return existing;
  return { ...existing, meetingUrl: mapped.meetingUrl };
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
      events[index] = withGoogleMeetingLinkIfEmpty(existing, mapped);
      linked++;
      continue;
    }
    // La riga importata viene SEMPRE ricostruita, non solo quando i campi visibili
    // cambiano: `mapped` porta meetingUrl quando Google pubblica la videoconferenza,
    // quindi il link arriva anche su un impegno già importato in passato. Se il link
    // scompare lato Google il valore locale NON viene cancellato: l'impegno importato
    // resta modificabile nell'app e un link digitato dal docente non può essere perso
    // da una sincronizzazione.
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
  /**
   * Real id of the primary calendar (typically its email), from the CalendarList
   * the app already read. Lets the primary group recognize local events saved
   * with that id and migrate them to the "primary" alias (defect of PR #76).
   */
  primaryCalendarId?: string;
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
 * - primary: a local record saved with the REAL primary id (the email, used by Google as the
 *   primary calendar id — defect of PR #76) is the SAME calendar: it is migrated to the
 *   "primary" alias and recognized as owned by the primary group.
 * - shared calendars: never match on `googleEventId` alone, so a shared event can never
 *   collide with an Agenda event or with the same event id coming from another calendar.
 */
export function mergeGoogleCalendarGroups(
  localEvents: CalendarEvent[],
  groups: GoogleCalendarEventGroup[],
): GoogleCalendarMergeResult {
  let events = [...localEvents];

  // Migrazione una tantum, idempotente: gli eventi locali salvati con l'id reale del
  // principale (l'email) passano all'alias "primary". Non tocca nessun altro campo e
  // nessuna altra identità: al passaggio successivo non trova più nulla da convertire.
  for (const group of groups) {
    if (!group.isPrimary || !group.primaryCalendarId || group.primaryCalendarId === PRIMARY_CALENDAR_ID) continue;
    const primaryId = group.primaryCalendarId;
    if (!events.some(event => event.googleCalendarId === primaryId)) continue;
    events = events.map(event =>
      event.googleCalendarId === primaryId ? { ...event, googleCalendarId: PRIMARY_CALENDAR_ID } : event,
    );
  }

  let added = 0;
  let updated = 0;
  let linked = 0;
  let ignoredCancelled = 0;

  for (const group of groups) {
    const { calendarId } = group;
    // Identità "di casa" per il gruppo: stessa identità remota. Sul principale
    // contano anche l'import legacy senza googleCalendarId e l'id reale del
    // principale, riconosciuto anche al primo ciclo (prima della migrazione).
    const isOwnEvent = (event: CalendarEvent, eventId: string): boolean => {
      if (event.googleEventId !== eventId) return false;
      if (event.googleCalendarId === calendarId) return true;
      if (!group.isPrimary) return false;
      return event.googleCalendarId == null
        || (group.primaryCalendarId != null && event.googleCalendarId === group.primaryCalendarId);
    };
    for (const remote of group.events) {
      if (remote.status === "cancelled") {
        ignoredCancelled++;
        continue;
      }
      const mapped = googleEventToCalendarEvent(remote, calendarId);
      // Un impegno nato nell'app ha sempre la precedenza sull'eventuale copia
      // importata con la stessa identità (caso del difetto PR #76).
      let index = events.findIndex(
        event => event.sourceType !== "google_calendar" && isOwnEvent(event, remote.id),
      );
      if (index < 0) {
        index = events.findIndex(event => isOwnEvent(event, remote.id));
      }
      if (index < 0) {
        events.push(mapped);
        added++;
        continue;
      }
      const existing = events[index];
      if (existing.sourceType !== "google_calendar") {
        // Impegno dell'app collegato (unito o inviato): non viene mai duplicato né sovrascritto.
        events[index] = withGoogleMeetingLinkIfEmpty(existing, mapped);
        linked++;
        // Doppione residuo del difetto PR #76: stesso googleEventId, uno nato
        // nell'app e uno importato dal principale. La copia importata esce SOLO
        // dall'app: nessuna chiamata di cancellazione verso Google.
        if (group.isPrimary) {
          for (let i = events.length - 1; i >= 0; i--) {
            const other = events[i];
            if (other.id === existing.id) continue;
            if (other.sourceType !== "google_calendar" || other.googleEventId !== remote.id) continue;
            if (other.googleCalendarId === PRIMARY_CALENDAR_ID
              || other.googleCalendarId == null
              || (group.primaryCalendarId != null && other.googleCalendarId === group.primaryCalendarId)) {
              events.splice(i, 1);
            }
          }
        }
        continue;
      }
      // Stesso contratto del merge G1: la riga è ricostruita a ogni ciclo, così meetingUrl
      // (presente in `mapped` solo se Google pubblica un link) si aggiunge anche su un
      // impegno già importato e un link rimosso lato Google non cancella quello locale.
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
