/**
 * Anno scolastico del profilo (1 settembre → 31 agosto) come UNICO confine di:
 *  - importazione da Google Calendar (finestra + pulizia degli eventi già salvati);
 *  - elenco "Note e impegni" (impegni oltre il 31 agosto nascosti e solo contati).
 *
 * Nessuna di queste regole tocca circolari, server o formato dei dati salvati.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { create, act } from "react-test-renderer";
import { getCurrentSchoolYear, getSchoolYearBoundaries } from "../src/utils/schoolYear";
import { googleEventToCalendarEvent } from "../src/utils/googleCalendarImport";
import {
  googleCalendarImportWindow,
  importGoogleCalendarEvents,
  importSelectedGoogleCalendars,
} from "../src/services/googleCalendarImportService";
import { FutureCommitmentsView } from "../src/components/FutureCommitmentsView";
import type { CalendarEvent, Student } from "../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const root = resolve(import.meta.dirname, "..");
const readSource = (relative: string) => readFileSync(resolve(root, relative), "utf8");

/** 7 ottobre 2026: dentro l'anno scolastico 2026/2027 (1/9/2026 → 31/8/2027). */
const NOW = new Date(2026, 9, 7, 12);
/** 10 settembre 2026: a inizio anno il minimo è il 1 settembre, non oggi − 30 giorni. */
const EARLY_SEPTEMBER = new Date(2026, 8, 10, 12);

const STUDENTS: Student[] = [];

function event(partial: Partial<CalendarEvent> & { id: string; date: string }): CalendarEvent {
  return { title: "Impegno", category: "riunione", isAllDay: true, sourceType: "manuale", ...partial } as CalendarEvent;
}

const manualEvent = (id: string, date: string) => event({ id, date, sourceType: "manuale" });
const circularEvent = (id: string, date: string) => event({ id, date, sourceType: "circolare", title: "Circolare" });
/** Evento già importato da Google (all-day) e salvato localmente. */
const googleEvent = (id: string, date: string) => googleEventToCalendarEvent({ id, start: { date }, end: { date } });

function renderedText(node: any): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join("");
  return renderedText(node?.children ?? []);
}

// --- 1. confini dell'anno scolastico ---------------------------------------

test("confini: \"2026/2027\" → 1 settembre 2026 e 31 agosto 2027", () => {
  assert.deepEqual(getSchoolYearBoundaries("2026/2027"), { start: "2026-09-01", end: "2027-08-31" });
  assert.deepEqual(getSchoolYearBoundaries("2025/2026"), { start: "2025-09-01", end: "2026-08-31" });
});

test("confini: valore mancante o non valido → anno scolastico corrente (regola già esistente)", () => {
  assert.equal(getCurrentSchoolYear(NOW), "2026/2027");
  const expected = { start: "2026-09-01", end: "2027-08-31" };
  for (const invalid of [undefined, null, "", "   ", "non-valido", "2026-2027", "26/27", "2025/26", "2026/2028", "2026/2029"]) {
    assert.deepEqual(getSchoolYearBoundaries(invalid as any, NOW), expected, `valore non valido: ${String(invalid)}`);
  }
  // Prima di agosto l'anno scolastico corrente è quello iniziato nell'anno solare precedente.
  assert.equal(getCurrentSchoolYear(new Date(2026, 2, 15, 12)), "2025/2026");
  assert.deepEqual(getSchoolYearBoundaries("boh", new Date(2026, 2, 15, 12)), { start: "2025-09-01", end: "2026-08-31" });
});

test("una sola fonte per i confini: nessun altro modulo ricalcola settembre/agosto", () => {
  assert.match(readSource("src/utils/schoolYear.ts"), /export function getSchoolYearBoundaries/);
  // I consumatori usano la funzione condivisa e non contengono confini duplicati.
  for (const file of ["src/services/googleCalendarImportService.ts", "src/components/FutureCommitmentsView.tsx"]) {
    const source = readSource(file);
    assert.match(source, /getSchoolYearBoundaries/, `${file} deve usare la funzione condivisa`);
    assert.doesNotMatch(source, /-09-01|-08-31/, `${file} non deve contenere confini duplicati`);
  }
});

// --- 2. finestra di importazione -------------------------------------------

test("finestra Google del 7/10/2026 con anno 2026/2027: 7 settembre → 31 agosto 2027", () => {
  assert.deepEqual(googleCalendarImportWindow(NOW, "2026/2027"), {
    timeMin: "2026-09-07T00:00:00Z",
    timeMax: "2027-08-31T23:59:59Z",
  });
});

test("finestra Google del 10/09/2026: il minimo è il 1 settembre dell'anno scolastico", () => {
  assert.deepEqual(googleCalendarImportWindow(EARLY_SEPTEMBER, "2026/2027"), {
    timeMin: "2026-09-01T00:00:00Z",
    timeMax: "2027-08-31T23:59:59Z",
  });
});

test("finestra Google: anno del profilo assente/non valido ricade sull'anno corrente", () => {
  assert.deepEqual(googleCalendarImportWindow(NOW), {
    timeMin: "2026-09-07T00:00:00Z",
    timeMax: "2027-08-31T23:59:59Z",
  });
  assert.deepEqual(googleCalendarImportWindow(NOW, "2026/2028"), {
    timeMin: "2026-09-07T00:00:00Z",
    timeMax: "2027-08-31T23:59:59Z",
  });
});

test("cambiare anno scolastico nel profilo cambia la finestra alla sincronizzazione successiva", () => {
  // Stesso istante, due anni scolastici diversi: la finestra segue il valore del profilo.
  assert.deepEqual(googleCalendarImportWindow(NOW, "2026/2027"), {
    timeMin: "2026-09-07T00:00:00Z",
    timeMax: "2027-08-31T23:59:59Z",
  });
  assert.deepEqual(googleCalendarImportWindow(NOW, "2027/2028"), {
    timeMin: "2027-09-01T00:00:00Z",
    timeMax: "2028-08-31T23:59:59Z",
  });
});

test("anno scolastico già concluso: finestra vuota, nessuna chiamata a Google e nessuna scrittura", async () => {
  const stale = googleCalendarImportWindow(NOW, "2025/2026");
  assert.equal(stale.timeMin > stale.timeMax, true, "minimo dopo il massimo: richiesta non valida");
  let calls = 0;
  let writes = 0;
  const result = await importSelectedGoogleCalendars("token", ["primary", "3d@scuola.it"], {
    list: async () => { calls++; return []; },
    read: async () => [],
    write: async () => { writes++; },
    atomic: async <T,>(operation: () => Promise<T>) => operation(),
    now: NOW,
    schoolYear: "2025/2026",
  });
  assert.equal(calls, 0);
  assert.equal(writes, 0);
  assert.equal(result.added, 0);
  assert.equal(result.calendarsRequested, 2);
});

// --- 3. pulizia degli eventi Google fuori finestra -------------------------

test("evento Google oltre il 31 agosto: rimosso alla sincronizzazione; manuale e circolare alla stessa data intatti", async () => {
  const sanFrancesco = googleEvent("san-francesco", "2027-10-04");
  const manuale = manualEvent("manuale-2027", "2027-10-04");
  const circolare = circularEvent("circolare-2027", "2027-10-04");
  const dentro = googleEvent("collegio", "2027-05-10");
  const ultimoGiorno = googleEvent("ultimo", "2027-08-31");
  let state: CalendarEvent[] = [sanFrancesco, manuale, circolare, dentro, ultimoGiorno];
  let writes = 0;

  const result = await importSelectedGoogleCalendars("token", ["primary"], {
    list: async () => Object.assign([], { partial: false, pagesRead: 1 }),
    read: async () => state,
    write: async events => { writes++; state = events; },
    atomic: async <T,>(operation: () => Promise<T>) => operation(),
    now: NOW,
    schoolYear: "2026/2027",
  });

  assert.equal(result.added, 0);
  assert.equal(writes, 1, "una sola scrittura atomica");
  assert.deepEqual(state.map(e => e.id).sort(), ["circolare-2027", "gcal-collegio", "gcal-ultimo", "manuale-2027"]);
  assert.ok(!state.some(e => e.googleEventId === "san-francesco"));
  assert.ok(state.some(e => e.id === "manuale-2027"), "l'impegno creato dall'utente non viene mai rimosso");
  assert.ok(state.some(e => e.id === "circolare-2027"), "l'impegno da circolare non viene mai rimosso");
  assert.ok(state.some(e => e.id === "gcal-ultimo"), "il 31 agosto è ancora dentro l'anno scolastico");
});

test("storico Google passato e impegni collegati a Google restano: si rimuove solo oltre il 31 agosto", async () => {
  const storicoGoogle = googleEvent("storico", "2026-02-10"); // anno scolastico precedente
  const agendaCollegata: CalendarEvent = {
    ...manualEvent("agenda-collegata", "2027-11-20"),
    googleEventId: "linked-manuale",
    syncedWithGoogle: true,
  };
  let state: CalendarEvent[] = [storicoGoogle, agendaCollegata];
  await importGoogleCalendarEvents("token", {
    list: async () => Object.assign([], { partial: false, pagesRead: 1 }),
    read: async () => state,
    write: async events => { state = events; },
    atomic: async <T,>(operation: () => Promise<T>) => operation(),
    now: NOW,
    schoolYear: "2026/2027",
  });
  assert.deepEqual(state.map(e => e.id).sort(), ["agenda-collegata", "gcal-storico"]);
});

test("l'import passa sempre la finestra dell'anno scolastico a Google", async () => {
  const requested: { min: string; max: string }[] = [];
  await importSelectedGoogleCalendars("token", ["primary", "3d@scuola.it"], {
    list: async (_token, _calendarId, min, max) => { requested.push({ min, max }); return []; },
    read: async () => [],
    write: async () => {},
    atomic: async <T,>(operation: () => Promise<T>) => operation(),
    now: NOW,
    schoolYear: "2026/2027",
  });
  assert.deepEqual(requested, [
    { min: "2026-09-07T00:00:00Z", max: "2027-08-31T23:59:59Z" },
    { min: "2026-09-07T00:00:00Z", max: "2027-08-31T23:59:59Z" },
  ]);
});

// --- 4. elenco "Note e impegni" --------------------------------------------

async function renderList(props: Record<string, unknown>) {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(FutureCommitmentsView, {
        events: [],
        scheduledAssessments: [],
        students: STUDENTS,
        todayIso: "2026-10-07",
        schoolYear: "2026/2027",
        ...props,
      } as any),
    );
  });
  return renderer;
}

test("elenco: l'impegno del 31/08/2027 è visibile, quello del 01/09/2027 è nascosto e contato", async () => {
  const renderer = await renderList({
    events: [
      event({ id: "dentro", date: "2027-08-31", title: "Collegio ultimo giorno" }),
      event({ id: "fuori", date: "2027-09-01", title: "Primo giorno anno nuovo" }),
      event({ id: "fuori-google", date: "2027-10-04", title: "San Francesco", sourceType: "google_calendar" }),
    ],
  });

  const text = renderedText(renderer.toJSON());
  assert.ok(text.includes("Collegio ultimo giorno"), "il 31 agosto è ancora nell'anno scolastico");
  assert.ok(!text.includes("Primo giorno anno nuovo"), "il 1 settembre è oltre l'anno scolastico");
  assert.ok(!text.includes("San Francesco"), "l'origine non conta: oltre il 31 agosto non si elenca");
  assert.ok(
    text.includes("2 impegni oltre il 31/08/2027"),
    `riga di conteggio mancante o errata: ${text}`,
  );
  const row = renderer.root.findByProps({ "data-commitments-beyond-school-year": "2027-08-31" });
  assert.equal(row.props["data-commitments-beyond-count"], 2);
  assert.equal(row.findAllByProps({ "data-commitment-id": "event:fuori" }).length, 0);
  await act(async () => renderer.unmount());
});

test("elenco: un solo impegno oltre il 31 agosto compare al singolare", async () => {
  const renderer = await renderList({
    events: [event({ id: "fuori", date: "2027-09-01", title: "Fuori anno" })],
  });
  const text = renderedText(renderer.toJSON());
  assert.ok(text.includes("1 impegno oltre il 31/08/2027"), text);
  assert.ok(!text.includes("Fuori anno"));
  await act(async () => renderer.unmount());
});

test("elenco: senza anno scolastico valido si usa quello corrente e restano i confini", async () => {
  const renderer = await renderList({
    schoolYear: "non-valido",
    events: [
      event({ id: "dentro", date: "2027-08-31", title: "Ultimo giorno" }),
      event({ id: "fuori", date: "2027-09-01", title: "Oltre" }),
    ],
  });
  const text = renderedText(renderer.toJSON());
  assert.ok(text.includes("Ultimo giorno"));
  assert.ok(!text.includes("Oltre"));
  assert.ok(text.includes("1 impegno oltre il 31/08/2027"));
  await act(async () => renderer.unmount());
});

test("elenco: nessuna riga di conteggio quando tutti gli impegni sono nell'anno", async () => {
  const renderer = await renderList({ events: [event({ id: "dentro", date: "2027-08-31", title: "Ultimo giorno" })] });
  assert.equal(renderer.root.findAllByProps({ "data-commitments-beyond-school-year": "2027-08-31" }).length, 0);
  assert.ok(!renderedText(renderer.toJSON()).includes("oltre il"));
  await act(async () => renderer.unmount());
});

// --- 5. cablaggio in App ---------------------------------------------------

test("App: anno scolastico del profilo passato sia a Google sia a Note e impegni", () => {
  const app = readSource("src/App.tsx");
  assert.match(app, /importSelectedGoogleCalendars\(token, calendarIds, \{ schoolYear: profile\.schoolYear \}\)/);
  assert.match(app, /<FutureCommitmentsView[\s\S]*?schoolYear=\{profile\.schoolYear\}/);
  // Il cambio di anno nel profilo ricrea la callback dell'import (nessun valore congelato).
  assert.match(app, /\}, \[googleUser, googleAccessToken, isOnline, profile\.googleCalendarImportIds, profile\.schoolYear\]\);/);
});
