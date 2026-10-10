import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import type { CalendarEvent, ExtractedItem } from "../src/types";
import type { GoogleCalendarApiEvent } from "../src/services/googleCalendarService";
import {
  areClassesCompatible,
  areEventsAffine,
  assignDocumentMatches,
  extractClassToken,
  extractClassTokensFromText,
  extractTimesFromTitle,
  findAffinityMatch,
  findEventMatch,
  getEventClassTokens,
  sharesMeetingKeyword,
  titleTimeAgreesWithEvent,
  type EventMatchCandidate,
} from "../src/utils/eventMatching";
import {
  findPossibleDuplicates,
  mergeRolesFor,
  mergeTimingHint,
  planMerge,
} from "../src/utils/googleCalendarMerge";
import { mergeGoogleCalendarEvents } from "../src/utils/googleCalendarImport";
import { EventMergeModal } from "../src/components/EventMergeModal";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Accetta sia un renderer (radice) sia un'istanza già trovata. */
function findAll(renderer: any, predicate: (node: any) => boolean): any[] {
  return (renderer.root ?? renderer).findAll(predicate);
}

/** Riga breve richiesta nell'anteprima per il caso reale A/B. */
const HINT_TEXT = "Il titolo dell'evento Google indica 16:30–17:15: proposto questo orario.";

/**
 * Affinità fra impegni: il criterio in più usato SOLO per suggerire "Possibile
 * doppione · Unisci". Il caso reale è il 13/10: Google dice 15:30–16:30 ma scrive
 * nel titolo "ore 16:30/17:15", la circolare dice "Consiglio di Classe 1C, 1N"
 * 16:30–17:15. Orari contigui e titolo che dichiara l'orario dell'altro.
 */

const DAY = "2026-10-13";

/** A: impegno importato da Google Calendar, con link Meet e orario scritto nel titolo. */
const googleA = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "gcal-a",
  title: "Consiglio 1 C del 13 Ottobre ore 16:30/17:15",
  category: "personale",
  date: DAY,
  startTime: "15:30",
  endTime: "16:30",
  isAllDay: false,
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  sourceType: "google_calendar",
  googleEventId: "evt-a",
  googleCalendarId: "primary",
  syncedWithGoogle: false,
  completed: false,
  ...overrides,
});

/** B: impegno nato in agenda dalla circolare, con la classe anche nel titolo. */
const appB = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "ev-b",
  title: "Consiglio di Classe 1C, 1N",
  category: "consiglio_classe",
  date: DAY,
  startTime: "16:30",
  endTime: "17:15",
  isAllDay: false,
  location: "Telematica",
  className: "1C, 1N",
  sourceType: "circolare",
  sourceCircularId: "circ-7",
  sourceCircularTitle: "Circolare n. 7",
  completed: false,
  ...overrides,
});

const asCandidate = (event: CalendarEvent): EventMatchCandidate => ({
  title: event.title,
  date: event.date,
  category: event.category,
  className: event.className,
  startTime: event.startTime,
  endTime: event.endTime,
  isAllDay: event.isAllDay,
});

const extractedFromCircular = (overrides: Partial<ExtractedItem> = {}): ExtractedItem => ({
  tempId: "temp-b",
  title: "Consiglio di Classe 1C, 1N",
  category: "consiglio_classe",
  date: DAY,
  startTime: "16:30",
  endTime: "17:15",
  className: "1C, 1N",
  location: "Telematica",
  relevance: "VERDE",
  relevanceReason: "Consiglio di classe con la classe in organico.",
  selectedForImport: true,
  ...overrides,
});

// ---------- 1. extractTimesFromTitle ----------

test("extractTimesFromTitle: formati con ora e minuti", () => {
  assert.deepEqual(extractTimesFromTitle("Consiglio 1 C del 13 Ottobre ore 16:30/17:15"), { start: "16:30", end: "17:15" });
  assert.deepEqual(extractTimesFromTitle("Collegio docenti 16:30"), { start: "16:30" });
  assert.deepEqual(extractTimesFromTitle("Collegio docenti 16.30-17.15"), { start: "16:30", end: "17:15" });
  assert.deepEqual(extractTimesFromTitle("Scrutinio 1C ore 16:30 alle 17:15"), { start: "16:30", end: "17:15" });
});

test("extractTimesFromTitle: ore sole solo dopo ore/dalle/alle", () => {
  assert.deepEqual(extractTimesFromTitle("Riunione dalle 16 alle 17"), { start: "16:00", end: "17:00" });
  assert.deepEqual(extractTimesFromTitle("Riunione ore 9"), { start: "09:00" });
  // "16 17" senza una parola che lo annunci non è un orario.
  assert.deepEqual(extractTimesFromTitle("Riunione 16 17"), {});
});

test("extractTimesFromTitle: date e sigle di classe non sono orari", () => {
  assert.deepEqual(extractTimesFromTitle("Consiglio del 13/10"), {});
  assert.deepEqual(extractTimesFromTitle("Consiglio 1C"), {});
  assert.deepEqual(extractTimesFromTitle("Consiglio di Classe 1C, 1N"), {});
  assert.deepEqual(extractTimesFromTitle("Circolare n. 123.456 del 13/10"), {});
  assert.deepEqual(extractTimesFromTitle(""), {});
  assert.deepEqual(extractTimesFromTitle(undefined), {});
  // Un'ora oltre le 23 o minuti oltre 59 non sono orari.
  assert.deepEqual(extractTimesFromTitle("Chiusura 25:00"), {});
  assert.deepEqual(extractTimesFromTitle("Chiusura 16:75"), {});
});

// ---------- 2. extractClassTokensFromText / getEventClassTokens ----------

test("extractClassTokensFromText: scritture diverse della stessa classe", () => {
  assert.deepEqual(extractClassTokensFromText("1 C"), ["1C"]);
  assert.deepEqual(extractClassTokensFromText("1^C"), ["1C"]);
  assert.deepEqual(extractClassTokensFromText("1ªC"), ["1C"]);
  assert.deepEqual(extractClassTokensFromText("1°C"), ["1C"]);
  assert.deepEqual(extractClassTokensFromText("classe 1 C"), ["1C"]);
  assert.deepEqual(extractClassTokensFromText("1C, 1N"), ["1C", "1N"]);
  assert.deepEqual(extractClassTokensFromText("classe 2 A"), ["2A"]);
  assert.deepEqual(extractClassTokensFromText("Consiglio 1 C del 13 Ottobre"), ["1C"]);
  assert.deepEqual(extractClassTokensFromText("Circolare 15/10"), []);
  assert.deepEqual(extractClassTokensFromText("Corso di 40 ore"), []);
  // La normalizzazione è quella già usata da areClassesCompatible.
  assert.equal(extractClassToken("1C, 1N"), "1C");
  assert.equal(extractClassToken("1^C"), "1C");
});

test("getEventClassTokens: campi classe e titolo uniti", () => {
  assert.deepEqual(getEventClassTokens(googleA()), ["1C"]);
  assert.deepEqual(getEventClassTokens(appB()), ["1C", "1N"]);
  assert.deepEqual(
    getEventClassTokens({ title: "Consiglio di Classe", className: "2A", classi: "1C, 1N" }),
    ["2A", "1C", "1N"]
  );
  assert.deepEqual(getEventClassTokens({ title: "Collegio docenti" }), []);
});

test("areClassesCompatible: comportamento invariato", () => {
  assert.equal(areClassesCompatible("1C", "1C, 1N"), false);
  assert.equal(areClassesCompatible("1C", "1C"), true);
  assert.equal(areClassesCompatible(undefined, undefined, "Consiglio 1 C", "Consiglio 1^C"), true);
});

test("sharesMeetingKeyword: parole di riunione per radice", () => {
  assert.equal(sharesMeetingKeyword("Consiglio 1C", "Consigli di classe integrativi"), true);
  assert.equal(sharesMeetingKeyword("Collegio Docenti", "Collegio"), true);
  assert.equal(sharesMeetingKeyword("Colloqui in corso 1C", "Colloqui con i genitori"), true);
  assert.equal(sharesMeetingKeyword("Riunione 1C", "Riunioni"), true);
  assert.equal(sharesMeetingKeyword("Assemblea di istituto", "Assemblee"), true);
  assert.equal(sharesMeetingKeyword("GLI 1C", "Gruppi di lavoro"), false);
  assert.equal(sharesMeetingKeyword("Uscita didattica 1C", "Consiglio 1C"), false);
});

// ---------- 3. affinità e suggerimento dei doppioni ----------

test("caso reale A/B: possibile doppione suggerito, senza unione automatica", () => {
  const google = googleA();
  const app = appB();

  // I criteri attuali non bastano: orari contigui e titoli non equivalenti.
  assert.equal(findEventMatch(asCandidate(google), [app]), null);
  assert.equal(findEventMatch(asCandidate(app), [google]), null);

  assert.equal(areEventsAffine(asCandidate(google), asCandidate(app)), true);

  const pairs = findPossibleDuplicates([app, google]);
  assert.equal(pairs.get(google.id)?.id, app.id);
  assert.equal(pairs.get(app.id)?.id, google.id);
});

test("affinità per sola coincidenza dell'orario nel titolo (orari distanti)", () => {
  // Stesso schema: qui gli orari effettivi sono lontanissimi, ma il titolo di
  // Google dichiara esattamente l'orario della circolare.
  const google = googleA({ startTime: "08:00", endTime: "08:45" });
  const app = appB();
  const match = findAffinityMatch(asCandidate(google), [app]);
  assert.equal(match?.event.id, app.id);
  assert.equal(match?.kind, "affinita");
});

test("classi diverse e incontri contigui: nessun suggerimento", () => {
  const app = appB({ title: "Consiglio di classe 1C", className: "1C" });
  const google = googleA({ title: "Consiglio di classe 2C", startTime: "17:15", endTime: "18:00" });
  assert.equal(areEventsAffine(asCandidate(google), asCandidate(app)), false);
  assert.equal(findPossibleDuplicates([app, google]).size, 0);
});

test("stessa classe in giorni diversi: nessun suggerimento", () => {
  const app = appB({ date: "2026-10-14" });
  const google = googleA({ date: DAY });
  assert.equal(findPossibleDuplicates([app, google]).size, 0);
  assert.equal(areEventsAffine(asCandidate(google), asCandidate(app)), false);
});

test("stessa classe ma nessuna parola di riunione in comune: nessun suggerimento", () => {
  const app = appB({ title: "Uscita didattica 1C", className: "1C", category: "uscita_didattica" });
  const google = googleA({ title: "Consiglio 1C" });
  assert.equal(areEventsAffine(asCandidate(google), asCandidate(app)), false);
  assert.equal(findPossibleDuplicates([app, google]).size, 0);
});

test("orari distanti oltre 60 minuti e titolo senza orario: nessun suggerimento", () => {
  const app = appB({ title: "Consiglio di classe 1C", className: "1C" });
  const google = googleA({ title: "Consiglio 1 C", startTime: "08:00", endTime: "09:00" });
  assert.equal(areEventsAffine(asCandidate(google), asCandidate(app)), false);
  assert.equal(findAffinityMatch(asCandidate(google), [app]), null);
  assert.equal(findPossibleDuplicates([app, google]).size, 0);
});

test("distanza fra gli orari: entro 60 minuti sì, oltre no", () => {
  const app = appB({ title: "Consiglio di classe 1C", className: "1C" });
  // 16:30 finisce esattamente dove comincia l'impegno in agenda: contigui.
  assert.equal(areEventsAffine(googleA({ title: "Consiglio 1 C", startTime: "15:45", endTime: "16:30" }), asCandidate(app)), true);
  // 35 minuti di vuoto restano un sospetto doppione.
  assert.equal(areEventsAffine(googleA({ title: "Consiglio 1 C", startTime: "15:55", endTime: "16:00" }), asCandidate(app)), true);
  // 76 minuti di vuoto no.
  assert.equal(areEventsAffine(googleA({ title: "Consiglio 1 C", startTime: "15:00", endTime: "15:14" }), asCandidate(app)), false);
});

test("lezioni, scadenze e tutto il giorno restano esclusi dall'affinità", () => {
  const google = googleA();
  const lesson = appB({ sourceType: "orario", category: "lezione" });
  const deadline = appB({ category: "scadenza", deadlineDate: DAY });
  const allDay = appB({ isAllDay: true, startTime: undefined, endTime: undefined });
  for (const app of [lesson, deadline, allDay]) {
    assert.equal(areEventsAffine(asCandidate(google), asCandidate(app)), false, app.category);
  }
});

test("un titolo senza orario non genera mai una coincidenza", () => {
  assert.equal(titleTimeAgreesWithEvent({ title: "Consiglio di Classe 1C, 1N" }, { startTime: "16:30", endTime: "17:15" }), false);
  assert.equal(titleTimeAgreesWithEvent({ title: "Consiglio ore 16:30/17:15" }, { startTime: "16:30", endTime: "17:15" }), true);
  assert.equal(titleTimeAgreesWithEvent({ title: "Consiglio ore 16:30" }, { startTime: "16:30", endTime: "17:15" }), true);
  // Inizio concorde ma fine dichiarata diversa: non è la stessa riunione.
  assert.equal(titleTimeAgreesWithEvent({ title: "Consiglio ore 16:30/18:00" }, { startTime: "16:30", endTime: "17:15" }), false);
});

// ---------- 4. non regressione: import da circolare e import Google invariati ----------

test("assignDocumentMatches: A/B non è un aggiornamento automatico né un doppio uso", () => {
  const google = googleA();
  const item = extractedFromCircular();

  const entries = assignDocumentMatches([item], [google]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].match, null);
  assert.deepEqual(entries[0].overlaps, []);

  // Nessun criterio storico produce un match per A/B, in nessuno dei due versi:
  // l'affinità non arriva mai qui, quindi nulla viene "aggiornato" da solo.
  assert.equal(findEventMatch(item, [google]), null);
  assert.equal(findEventMatch(asCandidate(appB()), [google]), null);
  assert.equal(findEventMatch(asCandidate(google), [appB()]), null);
});

test("assignDocumentMatches: i criteri veri di titolo e orario restano attivi", () => {
  const existing = appB({ title: "Consiglio di classe 1C", className: "1C" });
  const byTitle = assignDocumentMatches(
    [extractedFromCircular({ title: "Consiglio di classe 1C", className: "1C", startTime: "16:30", endTime: "17:15" })],
    [existing]
  );
  assert.equal(byTitle[0].match?.kind, "titolo");
  assert.equal(byTitle[0].match?.event.id, existing.id);

  const byTime = assignDocumentMatches(
    [extractedFromCircular({ title: "Verifica comune 1C", className: "1C", startTime: "16:45", endTime: "17:00" })],
    [existing]
  );
  assert.equal(byTime[0].match?.kind, "orario");
});

test("mergeGoogleCalendarEvents: A/B non fonde e non aggiorna nulla", () => {
  const remote = {
    id: "evt-a",
    summary: "Consiglio 1 C del 13 Ottobre ore 16:30/17:15",
    status: "confirmed",
    start: { dateTime: "2026-10-13T13:30:00Z" },
    end: { dateTime: "2026-10-13T14:30:00Z" },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
  } as GoogleCalendarApiEvent;

  const app = appB();
  const result = mergeGoogleCalendarEvents([app], [remote]);

  assert.equal(result.events.length, 2);
  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.linked, 0);

  const untouched = result.events.find((event) => event.id === app.id)!;
  assert.equal(untouched.title, app.title);
  assert.equal(untouched.startTime, "16:30");
  assert.equal(untouched.endTime, "17:15");
  assert.equal(untouched.meetingUrl, undefined);
  assert.equal(untouched.googleEventId, undefined);

  // L'avviso resta un suggerimento: i ruoli dell'unione non cambiano.
  const roles = mergeRolesFor(app, result.events.find((event) => event.id !== app.id)!);
  assert.equal(roles.ok && roles.base.id, app.id);
});

// ---------- 5. anteprima di unione ----------

test("anteprima unione: preselezionato l'orario coerente col titolo di Google", () => {
  const google = googleA();
  const app = appB();
  const plan = planMerge(app, google);

  assert.equal(plan.hint?.text, HINT_TEXT);
  const timing = plan.fields.find((field) => field.field === "timing");
  assert.equal(timing?.defaultChoice, "base");
  assert.equal(plan.merged.startTime, "16:30");
  assert.equal(plan.merged.endTime, "17:15");
  // Il link Meet dell'impegno importato è conservato.
  assert.equal(plan.merged.meetingUrl, "https://meet.google.com/abc-defg-hij");
  assert.ok(plan.summary.some((line) => line.field === "meetingUrl"));
});

test("anteprima unione: ruoli invertiti, proposta la lato Google coerente col titolo", () => {
  const google = googleA();
  const app = appB();
  const plan = planMerge(google, app);
  assert.equal(mergeTimingHint(google, app)?.choice, "other");
  assert.equal(plan.merged.startTime, "16:30");
  assert.equal(plan.merged.endTime, "17:15");
  assert.equal(plan.merged.meetingUrl, "https://meet.google.com/abc-defg-hij");
});

test("anteprima unione: nessun orario nel titolo, nessuna riga di proposta", () => {
  const google = googleA({ title: "Consiglio 1 C" });
  const app = appB();
  assert.equal(mergeTimingHint(app, google), undefined);
  const plan = planMerge(app, google);
  assert.equal(plan.hint, undefined);
  assert.equal(plan.fields.find((field) => field.field === "timing")?.defaultChoice, "base");
});

test("anteprima unione: la scelta manuale dell'utente vince sulla proposta", () => {
  const plan = planMerge(appB(), googleA(), { timing: "other" });
  assert.equal(plan.merged.startTime, "15:30");
  assert.equal(plan.merged.endTime, "16:30");
});

// ---------- categoria dell'esito: solo suggerimento ----------

test("findAffinityMatch restituisce il tipo affinita, solo come suggerimento", () => {
  const match = findAffinityMatch(asCandidate(googleA()), [appB()]);
  assert.equal(match?.kind, "affinita");
  assert.equal(match?.event.id, "ev-b");
  assert.equal(match?.others, 0);
  // Nessun titolo di riunione condiviso: nessun match.
  assert.equal(findAffinityMatch(asCandidate(googleA({ title: "Evento personale" })), [appB()]), null);
  assert.equal(findAffinityMatch(asCandidate(googleA()), []), null);
});

test("anteprima a schermo: riga breve sulla proposta di orario e radio già selezionata", async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(EventMergeModal, {
        base: appB(),
        other: googleA(),
        categoryLabel: (category: string) => category,
        onCancel: () => {},
        onConfirm: () => {},
      })
    );
  });

  const hint = findAll(renderer, (node: any) => node.props?.["data-merge-timing-hint"] !== undefined)[0];
  assert.ok(hint, "l'anteprima spiega perché propone quell'orario");
  const rendered = JSON.stringify(renderer.toJSON());
  assert.ok(rendered.includes(HINT_TEXT), rendered.slice(0, 400));

  const timing = findAll(renderer, (node: any) => node.props?.["data-merge-field"] === "timing")[0];
  assert.ok(timing, "l'orario resta una scelta dell'utente");
  const selected = findAll(timing, (node: any) => node.props?.["aria-checked"] === true);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].props["data-merge-option"], "base");
});
