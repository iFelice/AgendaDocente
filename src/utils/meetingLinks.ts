import type { CalendarEvent } from "../types";

/**
 * Link di videochiamata di un impegno (Meet, Zoom, Teams).
 *
 * Due contratti distinti, tenuti separati di proposito:
 *
 * 1. `meetingUrl` SALVATO sull'evento: accetta qualunque URL https ben formato.
 *    La scuola può usare qualsiasi piattaforma (anche una non nota qui), quindi il
 *    campo non è legato alla lista dei fornitori: è legato al protocollo, perché un
 *    link http aprirebbe la videoconferenza su una connessione non cifrata e verrebbe
 *    bloccato dai browser in una pagina https. Da qui `isHttpsMeetingUrl`, usato da
 *    validazione (backup/sync), editor e import Google: un valore non https non entra
 *    mai nei dati.
 *
 * 2. Link RICAVATO dal testo libero (luogo o note) per la sola visualizzazione:
 *    servono sia l'https sia un host fra quelli noti (`isKnownMeetingHost`), perché il
 *    testo di un impegno contiene link di ogni tipo (circolari, moduli, siti) che non
 *    sono invito a una videochiamata.
 *
 * La (2) non scrive mai nulla: `getEventMeetingUrl` è la funzione unica usata dalle
 * viste per decidere se mostrare "Partecipa" e con quale href. I dati salvati restano
 * intatti.
 */

/** Host (e sottodomini) riconosciuti come piattaforme di videoconferenza. */
export const MEETING_HOSTS = ["meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com"] as const;

/** Un URL lungo il double del real world (i link Teams con contesto sono i più lunghi). */
export const MEETING_URL_MAX_LENGTH = 2048;

/** meet.google.com, *.zoom.us, teams.microsoft.com, *.teams.live.com … */
export function isKnownMeetingHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return MEETING_HOSTS.some(meetingHost => host === meetingHost || host.endsWith(`.${meetingHost}`));
}

/**
 * Il contratto del campo `CalendarEvent.meetingUrl`: stringa https priva di spazi,
 * con host, senza credenziali incorporate e di lunghezza ragionevole.
 * Qualunque altra forma (http, javascript:, vuoto, numero, stringa non URL) è invalida.
 */
export function isHttpsMeetingUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate || candidate.length > MEETING_URL_MAX_LENGTH || /\s/.test(candidate)) return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
}

/** Normalizzazione per la scrittura: https valido o niente (mai un link monco salvato). */
export function normalizeMeetingUrl(value: unknown): string | undefined {
  return isHttpsMeetingUrl(value) ? (value as string).trim() : undefined;
}

/**
 * URL https in testo libero. Le parentesi finali e la punteggiatura di chiusura non
 * fanno parte del link: "Riunione (https://meet.google.com/abc-def-ghi)." deve
 * produrre l'URL senza il punto finale.
 */
const HTTPS_URL_IN_TEXT = /https:\/\/[^\s<>"'{}[\]]+/g;

const trimUrlTail = (candidate: string): string =>
  candidate.replace(/[.,;:!?)\]'"’]+$/u, "");

/** Primo link di videoconferenza (host noto + https) contenuto in un testo libero. */
export function extractMeetingUrlFromText(text: unknown): string | undefined {
  if (typeof text !== "string" || !text) return undefined;
  for (const match of text.matchAll(HTTPS_URL_IN_TEXT)) {
    const candidate = trimUrlTail(match[0]);
    if (!isHttpsMeetingUrl(candidate)) continue;
    if (isKnownMeetingHost(new URL(candidate).hostname)) return candidate;
  }
  return undefined;
}

/** Solo i campi che possono veicolare il link: nessuna dipendenza dall'evento intero. */
export type MeetingUrlCarrier = Pick<CalendarEvent, "meetingUrl" | "location" | "notes">;

/**
 * UNICA fonte del link da mostrare. Il campo dedicato vince sempre; in sua assenza si
 * cerca un link di videoconferenza nel luogo e poi nelle note. Pura lettura: nessun
 * dato viene riscritto o persistito.
 */
export function getEventMeetingUrl(event: MeetingUrlCarrier | null | undefined): string | undefined {
  if (!event) return undefined;
  const stored = normalizeMeetingUrl(event.meetingUrl);
  if (stored) return stored;
  return extractMeetingUrlFromText(event.location) ?? extractMeetingUrlFromText(event.notes);
}
