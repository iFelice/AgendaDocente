import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  googleDateTimeInRome,
  googleEventToCalendarEvent,
  mergeGoogleCalendarEvents,
} from "../src/utils/googleCalendarImport";
import { isGoogleSyncEnabled, listGoogleCalendarEvents, type GoogleCalendarApiEvent } from "../src/services/googleCalendarService";
import { googleCalendarImportWindow, importGoogleCalendarEvents } from "../src/services/googleCalendarImportService";
import type { CalendarEvent } from "../src/types";

const timed = (id: string, overrides: Partial<GoogleCalendarApiEvent> = {}): GoogleCalendarApiEvent => ({
  id,
  summary: "Riunione",
  description: "Descrizione originale",
  location: "Aula magna",
  start: { dateTime: "2026-01-15T12:30:00Z" },
  end: { dateTime: "2026-01-15T13:45:00Z" },
  ...overrides,
});

test("mapping Google: timed Europe/Rome, metadata neutri, descrizione e luogo", () => {
  const event = googleEventToCalendarEvent(timed("abc/123"));
  assert.deepEqual(event, {
    id: "gcal-abc%2F123", title: "Riunione", category: "personale", date: "2026-01-15",
    startTime: "13:30", endTime: "14:45", isAllDay: false, location: "Aula magna",
    notes: "Descrizione originale", googleEventId: "abc/123", sourceType: "google_calendar",
    syncedWithGoogle: false, completed: false,
  });
});

test("mapping Google: all-day usa start.date e fallback del titolo", () => {
  const event = googleEventToCalendarEvent({ id: "all", start: { date: "2026-05-02" }, end: { date: "2026-05-04" } });
  assert.equal(event.date, "2026-05-02");
  assert.equal(event.isAllDay, true);
  assert.equal(event.startTime, undefined);
  assert.equal(event.endTime, undefined);
  assert.equal(event.title, "Evento Google");
});

test("conversione UTC segue Europe/Rome anche ai cambi DST", () => {
  assert.deepEqual(googleDateTimeInRome("2026-03-29T00:30:00Z"), { date: "2026-03-29", time: "01:30" });
  assert.deepEqual(googleDateTimeInRome("2026-03-29T01:30:00Z"), { date: "2026-03-29", time: "03:30" });
  assert.deepEqual(googleDateTimeInRome("2026-10-25T01:30:00Z"), { date: "2026-10-25", time: "02:30" });
  assert.deepEqual(googleDateTimeInRome("2026-01-01T23:30:00Z"), { date: "2026-01-02", time: "00:30" });
});

test("merge usa solo googleEventId: aggiunge, ignora cancellati e non tocca eventi Agenda", () => {
  const agenda: CalendarEvent = { id: "local", title: "Agenda", category: "riunione", date: "2026-01-15", isAllDay: true,
    sourceType: "manuale", googleEventId: "linked", syncedWithGoogle: true, completed: true };
  const result = mergeGoogleCalendarEvents([agenda], [timed("new"), timed("linked"), timed("gone", { status: "cancelled" })]);
  assert.equal(result.added, 1);
  assert.equal(result.linked, 1);
  assert.equal(result.ignoredCancelled, 1);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events[0], agenda);
});

test("evento Google importato non abilita cancellazione/scrittura remota", () => {
  const imported = googleEventToCalendarEvent(timed("read-only"));
  assert.equal(imported.syncedWithGoogle, false);
  assert.equal(isGoogleSyncEnabled(imported), false);
  const workflow = readFileSync(resolve(import.meta.dirname, "../src/services/eventWorkflows.ts"), "utf8");
  assert.match(workflow, /event\?\.googleEventId && isGoogleSyncEnabled\(event\) && token/);
});

test("re-import aggiorna record Google preservando id locale e completed, senza duplicare", () => {
  const old: CalendarEvent = { ...googleEventToCalendarEvent(timed("same")), id: "id-locale", completed: true, title: "Vecchio" };
  const once = mergeGoogleCalendarEvents([old], [timed("same", { summary: "Nuovo", description: "Note nuove", location: "Altrove" })]);
  assert.equal(once.updated, 1);
  assert.equal(once.events[0].id, "id-locale");
  assert.equal(once.events[0].completed, true);
  assert.equal(once.events[0].title, "Nuovo");
  assert.equal(once.events[0].notes, "Note nuove");
  assert.equal(once.events[0].location, "Altrove");
  const twice = mergeGoogleCalendarEvents(once.events, [timed("same", { summary: "Nuovo" })]);
  assert.equal(twice.events.length, 1);
  assert.equal(twice.added, 0);
});

test("list legge oltre 100 eventi solo via GET e propaga pageToken", async () => {
  const original = globalThis.fetch;
  const methods: string[] = [];
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? "GET"); urls.push(String(input));
    const page = urls.length;
    return new Response(JSON.stringify({
      items: Array.from({ length: page === 1 ? 100 : 25 }, (_, i) => timed(`${page}-${i}`)),
      nextPageToken: page === 1 ? "next token" : undefined,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await listGoogleCalendarEvents("secret", "min", "max");
    assert.equal(result.length, 125);
    assert.equal(result.pagesRead, 2);
    assert.equal(result.partial, false);
    assert.ok(urls[1].includes("pageToken=next+token"));
    assert.deepEqual(methods, ["GET", "GET"]);
  } finally { globalThis.fetch = original; }
});

test("pagination si ferma e segnala risultato parziale al limite", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ items: [timed(String(calls))], nextPageToken: "again" }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await listGoogleCalendarEvents("token", undefined, undefined, { maxPages: 3 });
    assert.equal(calls, 3);
    assert.equal(result.partial, true);
  } finally { globalThis.fetch = original; }
});

test("workflow scarica prima e poi salva una sola volta dentro atomic; errore GET non corrompe", async () => {
  let state: CalendarEvent[] = [];
  let writes = 0, atomics = 0;
  const dependencies = {
    list: async () => Object.assign([timed("remote")], { partial: false, pagesRead: 1 }),
    read: async () => state,
    write: async (events: CalendarEvent[]) => { writes++; state = events; },
    atomic: async <T>(operation: () => Promise<T>) => { atomics++; return operation(); },
    now: new Date(2026, 9, 1, 12),
  };
  const first = await importGoogleCalendarEvents("token", dependencies);
  const second = await importGoogleCalendarEvents("token", dependencies);
  assert.deepEqual([first.added, second.added, state.length, writes, atomics], [1, 0, 1, 2, 2]);

  const before = structuredClone(state);
  await assert.rejects(importGoogleCalendarEvents("token", { ...dependencies, list: async () => { throw new Error("Google down"); } }));
  assert.deepEqual(state, before);
  assert.equal(writes, 2);
});

test("finestra G1 è limitata all'anno scolastico del profilo; token mancante è esplicito", async () => {
  // 1 ottobre 2026, anno scolastico 2026/2027: 30 giorni indietro … 31 agosto 2027.
  assert.deepEqual(googleCalendarImportWindow(new Date(2026, 9, 1, 12), "2026/2027"), {
    timeMin: "2026-09-01T00:00:00Z", timeMax: "2027-08-31T23:59:59Z",
  });
  await assert.rejects(importGoogleCalendarEvents(""), /Riconnetti/);
});

test("UI espone card download distinta e le viste esistenti ricevono tutti gli eventi", () => {
  const root = resolve(import.meta.dirname, "..");
  const profile = readFileSync(resolve(root, "src/components/ProfileModal.tsx"), "utf8");
  const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
  const commitments = readFileSync(resolve(root, "src/utils/futureCommitments.ts"), "utf8");
  assert.match(profile, /data-google-calendar-import/);
  assert.match(profile, /Scarica eventi/);
  assert.match(profile, /Scaricamento…/);
  assert.match(app, /<FutureCommitmentsView\s+events=\{events\}/);
  assert.match(app, /<MonthView[\s\S]*?events=\{events\}/);
  assert.match(commitments, /case ["']google_calendar["']:[\s\S]*?return ["']google["']/);
});
