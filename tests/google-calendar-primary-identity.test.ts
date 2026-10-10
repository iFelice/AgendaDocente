import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PRIMARY_CALENDAR_ID,
  isPrimaryCalendarId,
  primaryCalendarIdFromList,
  savedGoogleCalendarId,
  type GoogleCalendarApiEvent,
  type GoogleCalendarListEntry,
} from "../src/services/googleCalendarService";
import { mergeGoogleCalendarGroups } from "../src/utils/googleCalendarImport";
import { importSelectedGoogleCalendars } from "../src/services/googleCalendarImportService";
import type { CalendarEvent } from "../src/types";

/**
 * Calendario principale: un'unica regola di riconoscimento (alias "primary" o id
 * reale con primary=true nella CalendarList), invio che salva "primary", import
 * che riconosce l'impegno dell'app, migrazione una tantum email → "primary" e
 * risoluzione del doppione del difetto PR #76 senza chiamate verso Google.
 */

const root = resolve(import.meta.dirname, "..");
const readSource = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const PRIMARY_EMAIL = "docente@scuola.it";
const SHARED_ID = "3d@scuola.it";

/** La CalendarList già letta dall'app (live o cache): stessa forma in entrambi i casi. */
const calendarList: GoogleCalendarListEntry[] = [
  { id: PRIMARY_EMAIL, summary: "Il mio calendario", primary: true, accessRole: "owner" },
  { id: SHARED_ID, summary: "Consiglio di classe 3D", accessRole: "writer" },
];

const remotePrimaryEvent: GoogleCalendarApiEvent = {
  id: "g1",
  summary: "Consiglio di classe 3D",
  start: { dateTime: "2026-10-12T13:00:00Z" },
  end: { dateTime: "2026-10-12T14:00:00Z" },
};

/** Impegno nato nell'app e inviato a Google (collegamento). */
const sentAppEvent = (googleCalendarId: string, googleEventId = "g1"): CalendarEvent => ({
  id: "ev-app",
  title: "Consiglio di classe 3D",
  category: "consiglio_classe",
  date: "2026-10-12",
  startTime: "15:00",
  endTime: "16:00",
  isAllDay: false,
  sourceType: "circolare",
  sourceCircularId: "circ-1",
  sourceCircularTitle: "Circolare 42",
  googleEventId,
  googleCalendarId,
  syncedWithGoogle: false,
  completed: false,
});

/** Copia importata dallo stesso evento remoto (riga google_calendar del principale). */
const importedCopy = (): CalendarEvent => ({
  id: `gcal-${encodeURIComponent(PRIMARY_CALENDAR_ID)}-g1`,
  title: "Consiglio di classe 3D",
  category: "personale",
  date: "2026-10-12",
  startTime: "15:00",
  endTime: "16:00",
  isAllDay: false,
  sourceType: "google_calendar",
  googleEventId: "g1",
  googleCalendarId: PRIMARY_CALENDAR_ID,
  syncedWithGoogle: false,
  completed: false,
});

// ── 1. La funzione unica di riconoscimento ────────────────────────────────────

test("riconoscimento del principale: alias 'primary' o id reale con primary=true", () => {
  assert.equal(isPrimaryCalendarId(PRIMARY_CALENDAR_ID), true, "l'alias vale sempre");
  assert.equal(isPrimaryCalendarId(PRIMARY_CALENDAR_ID, calendarList), true);
  assert.equal(isPrimaryCalendarId(PRIMARY_EMAIL, calendarList), true, "l'id reale (email) con primary=true");
  assert.equal(isPrimaryCalendarId(PRIMARY_EMAIL), false, "senza elenco l'email non è riconosciuta");
  assert.equal(isPrimaryCalendarId(SHARED_ID, calendarList), false, "un condiviso non è mai il principale");
  assert.equal(isPrimaryCalendarId(undefined, calendarList), false);
  assert.equal(isPrimaryCalendarId("", calendarList), false);
});

test("id reale del principale preso dalla CalendarList (live o cache)", () => {
  assert.equal(primaryCalendarIdFromList(calendarList), PRIMARY_EMAIL);
  assert.equal(primaryCalendarIdFromList([{ id: "x@y.it", primary: false }]), undefined);
  assert.equal(primaryCalendarIdFromList(undefined), undefined);
});

// ── 2. Invio al principale salva "primary" ───────────────────────────────────

test("invio al principale salva googleCalendarId 'primary'; i condivisi restano col proprio id", () => {
  assert.equal(savedGoogleCalendarId(PRIMARY_CALENDAR_ID, calendarList), PRIMARY_CALENDAR_ID);
  assert.equal(savedGoogleCalendarId(PRIMARY_EMAIL, calendarList), PRIMARY_CALENDAR_ID, "l'email del principale diventa l'alias");
  assert.equal(savedGoogleCalendarId(SHARED_ID, calendarList), SHARED_ID, "condiviso invariato");
  assert.equal(savedGoogleCalendarId(SHARED_ID), SHARED_ID, "senza elenco nessun id cambia");

  // L'invio dall'app normalizza l'id con la stessa regola, usando la CalendarList già letta.
  const app = readSource("src/App.tsx");
  assert.match(app, /const googleCalendarList = googleCalendars \?\? cachedGoogleCalendarsToEntries\(profile\.googleCalendarListCache\);/);
  assert.match(app, /const calendarId = savedGoogleCalendarId\(rawCalendarId, googleCalendarList\);/);
  assert.match(app, /googleCalendarId: calendarId, syncedWithGoogle: false/);
});

// ── 3. Reimport dopo invio: nessun doppione, con "primary" e con l'email ─────

test("reimport dopo invio al principale: nessun doppione e 'linked', sia con 'primary' sia con l'email", () => {
  for (const savedId of [PRIMARY_CALENDAR_ID, PRIMARY_EMAIL]) {
    const merged = mergeGoogleCalendarGroups(
      [sentAppEvent(savedId)],
      [{ calendarId: PRIMARY_CALENDAR_ID, isPrimary: true, primaryCalendarId: PRIMARY_EMAIL, events: [remotePrimaryEvent] }],
    );
    assert.equal(merged.added, 0, `nessun doppione con googleCalendarId ${savedId}`);
    assert.equal(merged.linked, 1, `l'impegno nato nell'app conta come linked con ${savedId}`);
    assert.equal(merged.events.length, 1);
    assert.equal(merged.events[0].sourceType, "circolare", "la riga dell'app resta, non viene sovrascritta");
    assert.equal(merged.events[0].googleCalendarId, PRIMARY_CALENDAR_ID);
  }
});

// ── 4. Migrazione email → "primary": una tantum e idempotente ─────────────────

test("migrazione email → 'primary': una volta sola, non tocca nessun altro evento", () => {
  const appEvent = sentAppEvent(PRIMARY_EMAIL);
  const sharedAppEvent: CalendarEvent = { ...sentAppEvent(SHARED_ID, "s1"), id: "ev-shared", sourceType: "manuale" };
  const sharedImported: CalendarEvent = {
    id: `gcal-${encodeURIComponent(SHARED_ID)}-s2`,
    title: "Altro", category: "personale", date: "2026-10-13", startTime: "09:00", endTime: "10:00",
    isAllDay: false, sourceType: "google_calendar", googleEventId: "s2", googleCalendarId: SHARED_ID,
    syncedWithGoogle: false, completed: false,
  };

  const first = mergeGoogleCalendarGroups(
    [sharedImported, appEvent, sharedAppEvent],
    [{ calendarId: PRIMARY_CALENDAR_ID, isPrimary: true, primaryCalendarId: PRIMARY_EMAIL, events: [remotePrimaryEvent] }],
  );
  assert.equal(first.events.find(e => e.id === "ev-app")!.googleCalendarId, PRIMARY_CALENDAR_ID, "migrato al primo giro");
  assert.equal(first.events.find(e => e.id === "ev-shared")!.googleCalendarId, SHARED_ID, "condiviso invariato");
  assert.equal(first.events.find(e => e.id === `gcal-${encodeURIComponent(SHARED_ID)}-s2`)!.googleCalendarId, SHARED_ID);
  assert.equal(first.linked, 1);
  assert.equal(first.added, 0);

  const second = mergeGoogleCalendarGroups(first.events, [
    { calendarId: PRIMARY_CALENDAR_ID, isPrimary: true, primaryCalendarId: PRIMARY_EMAIL, events: [remotePrimaryEvent] },
  ]);
  // Nessun secondo giro di migrazione: nessun nuovo id, nessun nuovo oggetto, stessa riga.
  assert.equal(second.added, 0);
  assert.equal(second.linked, 1);
  assert.equal(second.events.length, first.events.length);
  assert.equal(second.events.find(e => e.id === "ev-app"), first.events.find(e => e.id === "ev-app"), "al secondo giro la riga non viene nemmeno ricopiata");
});

test("senza elenco CalendarList l'email non viene riconosciuta: comportamento pregresso", () => {
  const merged = mergeGoogleCalendarGroups(
    [sentAppEvent(PRIMARY_EMAIL)],
    [{ calendarId: PRIMARY_CALENDAR_ID, isPrimary: true, events: [remotePrimaryEvent] }],
  );
  assert.equal(merged.added, 1, "senza primaryCalendarId il merge non può migrare né riconoscere");
});

// ── 5. Doppione già esistente del difetto: risolto senza chiamate a Google ────

test("doppione del difetto già esistente: la copia importata esce dall'app, resta quella dell'app, zero chiamate Google", async () => {
  const networkCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    networkCalls.push(String(input));
    throw new Error("rete disabilitata nel test");
  }) as typeof fetch;

  // Ordine sfavorevole: la copia importata sta PRIMA della riga dell'app.
  let state: CalendarEvent[] = [importedCopy(), sentAppEvent(PRIMARY_EMAIL)];
  let writes = 0;
  try {
    const result = await importSelectedGoogleCalendars("token", [PRIMARY_CALENDAR_ID], {
      list: async () => Object.assign([remotePrimaryEvent], { partial: false, pagesRead: 1 }),
      read: async () => state,
      write: async events => { writes++; state = events; },
      atomic: async <T,>(operation: () => Promise<T>) => operation(),
      now: new Date(2026, 9, 15, 12),
      primaryCalendarId: PRIMARY_EMAIL,
    });

    assert.equal(result.added, 0);
    assert.equal(result.linked, 1, "la riga dell'app è riconosciuta come linked");
    assert.equal(writes, 1, "una sola scrittura locale");
    assert.equal(state.length, 1, "la copia importata esce dall'app");
    assert.equal(state[0].id, "ev-app", "resta la riga nata nell'app");
    assert.equal(state[0].sourceType, "circolare");
    assert.equal(state[0].googleCalendarId, PRIMARY_CALENDAR_ID, "migrata a 'primary'");
    assert.deepEqual(networkCalls, [], "nessuna chiamata verso Google (niente cancellazioni)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── 6. Riproduzione completa del difetto PR #76 a livello di servizio ─────────

test("PR #76: invio che salvava l'email → alla sincronizzazione l'impegno è migrato e collegato, non duplicato", async () => {
  let state: CalendarEvent[] = [sentAppEvent(PRIMARY_EMAIL)];
  const result = await importSelectedGoogleCalendars("token", [PRIMARY_CALENDAR_ID], {
    list: async () => Object.assign([remotePrimaryEvent], { partial: false, pagesRead: 1 }),
    read: async () => state,
    write: async events => { state = events; },
    atomic: async <T,>(operation: () => Promise<T>) => operation(),
    now: new Date(2026, 9, 15, 12),
    primaryCalendarId: PRIMARY_EMAIL,
  });
  assert.equal(result.added, 0, "prima del fix qui arrivava added=1");
  assert.equal(result.linked, 1);
  assert.equal(result.calendarsImported, 1);
  assert.equal(state.length, 1);
  assert.equal(state[0].googleCalendarId, PRIMARY_CALENDAR_ID);
});

// ── 7. Calendari condivisi invariati ─────────────────────────────────────────

test("calendari condivisi invariati: nessun effetto di migrazione e matching per identità", () => {
  const sharedAppEvent: CalendarEvent = { ...sentAppEvent(SHARED_ID, "s1"), id: "ev-shared", sourceType: "manuale" };
  const sharedImported: CalendarEvent = {
    id: `gcal-${encodeURIComponent(SHARED_ID)}-s2`,
    title: "Altro", category: "personale", date: "2026-10-13", startTime: "09:00", endTime: "10:00",
    isAllDay: false, sourceType: "google_calendar", googleEventId: "s2", googleCalendarId: SHARED_ID,
    syncedWithGoogle: false, completed: false,
  };
  const remoteShared: GoogleCalendarApiEvent[] = [
    { id: "s1", summary: "Riunione", start: { dateTime: "2026-10-12T13:00:00Z" }, end: { dateTime: "2026-10-12T14:00:00Z" } },
    { id: "s2", summary: "Altro", start: { dateTime: "2026-10-13T07:00:00Z" }, end: { dateTime: "2026-10-13T08:00:00Z" } },
    { id: "s3", summary: "Nuovo", start: { dateTime: "2026-10-14T07:00:00Z" }, end: { dateTime: "2026-10-14T08:00:00Z" } },
  ];

  const merged = mergeGoogleCalendarGroups(
    [sharedImported, sharedAppEvent],
    [{ calendarId: SHARED_ID, events: remoteShared }],
  );
  assert.equal(merged.linked, 1, "l'impegno dell'app sul condiviso resta collegato");
  assert.equal(merged.updated, 1, "la riga importata viene aggiornata come prima");
  assert.equal(merged.added, 1, "il nuovo evento condiviso entra come prima");
  for (const event of merged.events) {
    assert.equal(event.googleCalendarId, SHARED_ID, "nessun id condiviso migra a 'primary'");
  }
  assert.equal(merged.events.find(e => e.id === "ev-shared")!.googleCalendarId, SHARED_ID);
});
