import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  googleEventLocalId,
  googleEventToCalendarEvent,
  mergeGoogleCalendarGroups,
} from "../src/utils/googleCalendarImport";
import {
  listCalendarEvents,
  listGoogleCalendars,
  isGoogleSyncEnabled,
  PRIMARY_CALENDAR_ID,
  type GoogleCalendarApiEvent,
} from "../src/services/googleCalendarService";
import {
  importSelectedGoogleCalendars,
  resolveImportCalendarIds,
} from "../src/services/googleCalendarImportService";
import { SCOPES } from "../src/services/googleAuth";
import { isValidProfilePayload } from "../src/services/sync/remoteSchema";
import type { CalendarEvent, TeacherProfile } from "../src/types";

const root = resolve(import.meta.dirname, "..");
const readSource = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const timed = (id: string, overrides: Partial<GoogleCalendarApiEvent> = {}): GoogleCalendarApiEvent => ({
  id,
  summary: "Consiglio di classe",
  start: { dateTime: "2026-01-15T12:30:00Z" },
  end: { dateTime: "2026-01-15T13:45:00Z" },
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: (calls: { url: string; method: string }[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return handler(String(input), init);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// 1 + 2
test("CalendarList restituisce primary e condivisi e segue la pagination", async () => {
  await withFetch(url => jsonResponse(
    url.includes("pageToken=p2")
      ? { items: [{ id: "holidays@group.v.calendar.google.com", summary: "Festività in Italia", accessRole: "reader" }] }
      : {
          items: [
            { id: "me@scuola.it", summary: "Il mio calendario", primary: true, accessRole: "owner" },
            { id: "3d@scuola.it", summary: "Consiglio di classe 3D", accessRole: "writer" },
          ],
          nextPageToken: "p2",
        },
  ), async calls => {
    const calendars = await listGoogleCalendars("token");
    assert.deepEqual(calendars.map(c => c.summary), ["Il mio calendario", "Consiglio di classe 3D", "Festività in Italia"]);
    assert.equal(calendars[0].primary, true);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList"));
    assert.deepEqual(calls.map(c => c.method), ["GET", "GET"]);
  });
});

// 3 + 4 + 39
test("profilo legacy importa solo primary; la selezione condivisa è persistita nel profilo e valida per Firestore", () => {
  assert.deepEqual(resolveImportCalendarIds(undefined), ["primary"]);
  assert.deepEqual(resolveImportCalendarIds({}), ["primary"]);
  assert.deepEqual(resolveImportCalendarIds({ googleCalendarImportIds: [] }), ["primary"]);
  assert.deepEqual(resolveImportCalendarIds({ googleCalendarImportIds: ["primary", "3d@scuola.it", "primary"] }),
    ["primary", "3d@scuola.it"]);

  const profile: TeacherProfile = {
    id: "p1", fullName: "Docente", schoolName: "IC", schoolYear: "2025/26",
    primarySubjects: [], classes: [], campuses: [], roles: [],
    googleCalendarImportIds: ["primary", "3d@scuola.it"],
  };
  assert.equal(isValidProfilePayload(JSON.parse(JSON.stringify(profile))), true);
  // Nessun token/credenziale viene mai persistito: solo gli ID.
  assert.deepEqual(Object.keys(profile).filter(k => /token|credential/i.test(k)), []);
});

// 5 + 6 + 7 + 8 + 9 + 16 + 34 + 35 + 36
test("import multi-calendar: solo i calendari selezionati, un'unica scrittura atomica, identity calendarId+eventId", async () => {
  let state: CalendarEvent[] = [];
  let writes = 0;
  let atomics = 0;
  const requested: string[] = [];
  const result = await importSelectedGoogleCalendars("token", ["primary", "3d@scuola.it"], {
    list: async (_t, calendarId) => {
      requested.push(calendarId);
      return Object.assign([timed("shared-1")], { partial: false, pagesRead: 2 });
    },
    read: async () => state,
    write: async events => { writes++; state = events; },
    atomic: async <T,>(operation: () => Promise<T>) => { atomics++; return operation(); },
    now: new Date(2026, 9, 1, 12),
  });

  assert.deepEqual(requested, ["primary", "3d@scuola.it"]);
  assert.ok(!requested.includes("holidays@group.v.calendar.google.com"));
  assert.equal(writes, 1);
  assert.equal(atomics, 1);
  assert.equal(result.added, 2);
  assert.equal(result.pagesRead, 4);
  assert.equal(result.calendarsImported, 2);
  // stessi eventId su calendari diversi ⇒ due eventi distinti
  assert.equal(state.length, 2);
  assert.deepEqual(state.map(e => e.googleCalendarId), ["primary", "3d@scuola.it"]);
  assert.equal(state[1].id, googleEventLocalId("3d@scuola.it", "shared-1"));
  assert.ok(state[1].id.includes(encodeURIComponent("3d@scuola.it")));
});

// 10
test("stesso calendarId + eventId non duplica al re-import", () => {
  const first = mergeGoogleCalendarGroups([], [{ calendarId: "3d@scuola.it", events: [timed("e1")] }]);
  const second = mergeGoogleCalendarGroups(first.events, [{ calendarId: "3d@scuola.it", events: [timed("e1", { summary: "Aggiornato" })] }]);
  assert.equal(second.events.length, 1);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.events[0].title, "Aggiornato");
});

// 11 + 12 + 13
test("evento primary G1 legacy senza googleCalendarId è riconosciuto, conserva id e completed e acquisisce il calendarId", () => {
  const legacy: CalendarEvent = { ...googleEventToCalendarEvent(timed("legacy")), id: "gcal-legacy", completed: true };
  assert.equal(legacy.googleCalendarId, undefined);
  const merged = mergeGoogleCalendarGroups([legacy], [
    { calendarId: "primary", isPrimary: true, events: [timed("legacy", { summary: "Nuovo titolo" })] },
  ]);
  assert.equal(merged.events.length, 1);
  assert.equal(merged.added, 0);
  assert.equal(merged.updated, 1);
  assert.equal(merged.events[0].id, "gcal-legacy");
  assert.equal(merged.events[0].completed, true);
  assert.equal(merged.events[0].googleCalendarId, "primary");
  assert.equal(merged.events[0].title, "Nuovo titolo");
});

// 14 + 15
test("evento Agenda già sincronizzato su primary non è duplicato; un condiviso non collide per solo googleEventId", () => {
  const agenda: CalendarEvent = {
    id: "local-1", title: "Agenda", category: "riunione", date: "2026-01-15", isAllDay: true,
    sourceType: "manuale", googleEventId: "shared-id", syncedWithGoogle: true, completed: true,
  };
  const primary = mergeGoogleCalendarGroups([agenda], [
    { calendarId: "primary", isPrimary: true, events: [timed("shared-id")] },
  ]);
  assert.equal(primary.linked, 1);
  assert.equal(primary.added, 0);
  assert.deepEqual(primary.events[0], agenda);

  const shared = mergeGoogleCalendarGroups([agenda], [
    { calendarId: "3d@scuola.it", events: [timed("shared-id")] },
  ]);
  assert.equal(shared.added, 1);
  assert.equal(shared.events.length, 2);
  assert.deepEqual(shared.events[0], agenda);
  assert.equal(shared.events[1].googleCalendarId, "3d@scuola.it");
});

// 17 + 18 + 19 + 20 + 21 + 34 + 35
test("primary e shared usano solo GET su /calendars/{id}/events, con pagination e limiti per calendario", async () => {
  await withFetch(() => jsonResponse({ items: [timed("a")], nextPageToken: "again" }), async calls => {
    const primary = await listCalendarEvents("token", PRIMARY_CALENDAR_ID, "min", "max", { maxPages: 2 });
    assert.equal(primary.partial, true);
    assert.equal(primary.pagesRead, 2);
    const shared = await listCalendarEvents("token", "3d@scuola.it", "min", "max", { maxEvents: 3 });
    assert.equal(shared.partial, true);
    assert.ok(calls.every(c => c.method === "GET"));
    assert.ok(calls[0].url.includes("/calendars/primary/events"));
    assert.ok(calls.at(-1)!.url.includes(`/calendars/${encodeURIComponent("3d@scuola.it")}/events`));
  });

  const imported = googleEventToCalendarEvent(timed("shared-ro"), "3d@scuola.it");
  assert.equal(imported.sourceType, "google_calendar");
  assert.equal(imported.syncedWithGoogle, false);
  assert.equal(isGoogleSyncEnabled(imported), false);
});

// 20 + 22 + 23
test("outbound resta primary-only e non tocca i calendari condivisi", () => {
  const service = readSource("src/services/googleCalendarService.ts");
  assert.match(service, /const CALENDAR_API_BASE = `\$\{CALENDAR_V3_BASE\}\/calendars\/primary\/events`/);
  for (const fn of ["createGoogleCalendarEvent", "updateGoogleCalendarEvent", "deleteGoogleCalendarEvent"]) {
    const body = service.slice(service.indexOf(`export const ${fn}`), service.indexOf(`export const ${fn}`) + 900);
    assert.ok(body.includes("CALENDAR_API_BASE"), `${fn} deve restare su primary`);
    assert.ok(!/calendarId/.test(body), `${fn} non deve accettare un calendarId`);
  }
  const workflows = readSource("src/services/eventWorkflows.ts");
  assert.match(workflows, /isGoogleSyncEnabled/);
  const modal = readSource("src/components/EventModal.tsx");
  assert.match(modal, /isGoogleSourcedEvent = eventToEdit\?\.sourceType === "google_calendar"/);
  assert.match(modal, /syncedWithGoogle: isGoogleSourcedEvent \? false : syncWithGoogle/);
  assert.match(modal, /\{!isGoogleSourcedEvent && \(isGoogleConnected/);
});

// 25 + 26 + 32 + 33
test("403 su un calendario condiviso non corrompe il DB e non cancella eventi locali", async () => {
  const existing: CalendarEvent = { ...googleEventToCalendarEvent(timed("old"), "3d@scuola.it") };
  let state: CalendarEvent[] = [existing];
  let writes = 0;
  const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });
  const result = await importSelectedGoogleCalendars("token", ["primary", "3d@scuola.it"], {
    list: async (_t, calendarId) => {
      if (calendarId === "3d@scuola.it") throw forbidden;
      return Object.assign([timed("primary-1")], { partial: false, pagesRead: 1 });
    },
    read: async () => state,
    write: async events => { writes++; state = events; },
    atomic: async <T,>(operation: () => Promise<T>) => operation(),
    now: new Date(2026, 9, 1, 12),
  });
  assert.equal(result.partial, true);
  assert.deepEqual(result.inaccessibleCalendarIds, ["3d@scuola.it"]);
  assert.equal(result.calendarsImported, 1);
  assert.equal(writes, 1);
  // l'evento storico del calendario non accessibile resta
  assert.ok(state.some(e => e.googleEventId === "old"));
  assert.ok(state.some(e => e.googleEventId === "primary-1"));

  // deselezione: il calendario non viene più letto, ma gli eventi restano
  const afterDeselect = await importSelectedGoogleCalendars("token", ["primary"], {
    list: async () => Object.assign([timed("primary-1")], { partial: false, pagesRead: 1 }),
    read: async () => state,
    write: async events => { state = events; },
    atomic: async <T,>(operation: () => Promise<T>) => operation(),
    now: new Date(2026, 9, 1, 12),
  });
  assert.equal(afterDeselect.added, 0);
  assert.ok(state.some(e => e.googleCalendarId === "3d@scuola.it"));
});

test("se nessun calendario è leggibile l'import fallisce senza scrivere", async () => {
  let writes = 0;
  await assert.rejects(importSelectedGoogleCalendars("token", ["3d@scuola.it"], {
    list: async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); },
    read: async () => [],
    write: async () => { writes++; },
    atomic: async <T,>(operation: () => Promise<T>) => operation(),
  }), /Nessun calendario Google selezionato risulta accessibile/);
  assert.equal(writes, 0);
  await assert.rejects(importSelectedGoogleCalendars(""), /Riconnetti/);
});

// 24 + 25 + 29 + 30 + 31 + nuovi scope
test("App: single-flight multi-calendar, apertura sessione immediata, cooldown, needs-auth e nuovi scope", () => {
  assert.deepEqual(SCOPES, [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ]);

  const app = readSource("src/App.tsx");
  // single flight: un solo import in volo copre tutti i calendari selezionati
  assert.match(app, /if \(autoImportInFlight\.current\) return autoImportInFlight\.current;/);
  assert.match(app, /importSelectedGoogleCalendars\(token, calendarIds\)/);
  assert.match(app, /resolveImportCalendarIds\(profile\)/);
  // §22 primo import di sessione immediato, poi cooldown di 5 minuti
  assert.match(app, /const immediate = force \|\| !sessionImportDone\.current;/);
  assert.match(app, /if \(!immediate && last !== null && Date\.now\(\) - last < GOOGLE_CALENDAR_AUTO_IMPORT_COOLDOWN_MS\) return null;/);
  assert.match(app, /GOOGLE_CALENDAR_AUTO_IMPORT_COOLDOWN_MS = 5 \* 60 \* 1000/);
  assert.match(app, /sessionImportDone\.current = true;/);
  // token assente ⇒ needs-auth senza popup
  assert.match(app, /if \(!token\) \{\s*setGoogleAutoImportStatus\("needs-auth"\);/);
  // reconnect esplicito ⇒ import immediato
  assert.match(app, /void runAutomaticGoogleImport\(true, result\.accessToken, result\.user\)/);
  // cambio selezione ⇒ salvataggio + import immediato (bypass cooldown)
  assert.match(app, /googleCalendarImportIds: unique/);
  assert.match(app, /await runAutomaticGoogleImport\(true, undefined, undefined, unique\)/);
});

// 15 + 16 UI + 37 + 38 + 40
test("UI: elenco calendari, badge Google nelle viste e outbound manuale invariato", () => {
  const profile = readSource("src/components/ProfileModal.tsx");
  assert.match(profile, /data-google-calendar-selection/);
  assert.match(profile, /Calendari importati/);
  assert.match(profile, /Aggiorna elenco calendari/);
  assert.match(profile, /Principale/);
  assert.match(profile, /Condiviso/);
  assert.match(profile, /calendari selezionati/);
  assert.match(profile, /calendario non accessibile/);
  // la CalendarList si carica solo con tab Google attivo e utente autenticato, con cache
  assert.match(profile, /if \(!isOpen \|\| activeTab !== "google"\) return;/);
  assert.match(profile, /if \(googleCalendars\) return;/);
  // outbound manuale/selettivo invariato
  assert.match(profile, /syncedWithGoogle === true && e\.sourceType !== "google_calendar"/);

  const commitments = readSource("src/utils/futureCommitments.ts");
  assert.match(commitments, /case ["']google_calendar["']:[\s\S]*?return ["']google["']/);
  const app = readSource("src/App.tsx");
  assert.match(app, /<FutureCommitmentsView\s+events=\{events\}/);
  assert.match(app, /<MonthView[\s\S]*?events=\{events\}/);
});
