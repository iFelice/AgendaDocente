import test from "node:test";
import assert from "node:assert/strict";
import type { CalendarEvent } from "../src/types";
import type { GoogleCalendarApiEvent } from "../src/services/googleCalendarService";
import {
  findPossibleDuplicates,
  isGoogleImportedEvent,
  mergeRolesFor,
  planMerge,
  showsGoogleCalendarLabel,
} from "../src/utils/googleCalendarMerge";
import {
  mergeGoogleCalendarEvents,
  mergeGoogleCalendarGroups,
} from "../src/utils/googleCalendarImport";

const base = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
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
  sourceItemId: "item-1",
  className: "3D",
  completed: false,
  ...overrides,
});

const imported = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "gcal-primary-g1",
  title: "Consiglio classe 3D",
  category: "personale",
  date: "2026-10-12",
  startTime: "15:00",
  endTime: "16:00",
  isAllDay: false,
  sourceType: "google_calendar",
  googleEventId: "g1",
  googleCalendarId: "primary",
  syncedWithGoogle: false,
  completed: false,
  ...overrides,
});

const remote = (overrides: Partial<GoogleCalendarApiEvent> = {}): GoogleCalendarApiEvent => ({
  id: "g1",
  summary: "Consiglio di classe 3D",
  status: "confirmed",
  start: { dateTime: "2026-10-12T13:00:00Z" },
  end: { dateTime: "2026-10-12T14:00:00Z" },
  ...overrides,
} as GoogleCalendarApiEvent);

test("etichetta Google Calendar: importati e impegni dell'app collegati, non gli altri", () => {
  assert.equal(showsGoogleCalendarLabel(imported()), true);
  assert.equal(showsGoogleCalendarLabel(base({ googleEventId: "g1", googleCalendarId: "primary" })), true);
  assert.equal(showsGoogleCalendarLabel(base()), false);
  assert.equal(isGoogleImportedEvent(imported()), true);
  assert.equal(isGoogleImportedEvent(base({ googleEventId: "g1" })), false);
});

test("doppione riconosciuto per orario sovrapposto anche con titolo diverso", () => {
  const app = base({ title: "Riunione staff", category: "personale", className: undefined, sourceType: "manuale" });
  const google = imported({ title: "Zoom con preside" });
  const pairs = findPossibleDuplicates([app, google]);
  assert.equal(pairs.get(google.id)?.id, app.id);
  assert.equal(pairs.get(app.id)?.id, google.id);
});

test("doppione riconosciuto per titolo equivalente anche senza sovrapposizione oraria", () => {
  const app = base({ startTime: "09:00", endTime: "10:00" });
  const google = imported({ title: "Consiglio classe 3D", startTime: "17:00", endTime: "18:00" });
  const pairs = findPossibleDuplicates([app, google]);
  assert.equal(pairs.get(google.id)?.id, app.id);
});

test("lezioni, scadenze e impegni tutto il giorno non producono doppioni", () => {
  const google = imported();
  const lesson = base({ sourceType: "orario", category: "lezione", title: "Matematica" });
  const deadline = base({ category: "scadenza", deadlineDate: "2026-10-12", title: "Consiglio classe 3D" });
  const allDay = base({ isAllDay: true, startTime: undefined, endTime: undefined, title: "Consiglio classe 3D" });
  for (const app of [lesson, deadline, allDay]) {
    assert.equal(findPossibleDuplicates([app, google]).size, 0, `escluso: ${app.title} ${app.category}`);
  }
  const googleAllDay = imported({ isAllDay: true, startTime: undefined, endTime: undefined });
  assert.equal(findPossibleDuplicates([base(), googleAllDay]).size, 0);
});

test("impegni dell'app già collegati a Google non sono candidati, né giorni diversi", () => {
  const linked = base({ googleEventId: "g9", googleCalendarId: "primary" });
  assert.equal(findPossibleDuplicates([linked, imported()]).size, 0);
  assert.equal(findPossibleDuplicates([base({ date: "2026-10-13" }), imported()]).size, 0);
});

test("ruoli: la base è l'impegno dell'app, il secondario è quello Google", () => {
  const roles = mergeRolesFor(imported(), base());
  assert.equal(roles.ok, true);
  if (roles.ok) {
    assert.equal(roles.base.id, "ev-app");
    assert.equal(roles.secondary.id, "gcal-primary-g1");
  }
});

test("ruoli: fra due impegni dell'app vince quello scelto per primo", () => {
  const first = base({ id: "ev-a", sourceType: "manuale", category: "personale" });
  const second = base({ id: "ev-b", sourceType: "manuale", category: "personale" });
  const roles = mergeRolesFor(second, first);
  assert.equal(roles.ok && roles.base.id, "ev-b");
});

test("ruoli: rifiuta due importati, due collegamenti Google diversi e le lezioni", () => {
  assert.equal(mergeRolesFor(imported(), imported({ id: "gcal-x", googleEventId: "g2" })).ok, false);
  const linkedOther = base({ googleEventId: "g7", googleCalendarId: "primary" });
  assert.equal(mergeRolesFor(linkedOther, imported()).ok, false);
  assert.equal(mergeRolesFor(base({ googleEventId: "g1", googleCalendarId: "primary" }), imported()).ok, true);
  assert.equal(mergeRolesFor(base({ sourceType: "orario", category: "lezione" }), imported()).ok, false);
});

test("unione: link di Meet da Google, classe e categoria dalla circolare", () => {
  const google = imported({ meetingUrl: "https://meet.google.com/abc-defg-hij" });
  const plan = planMerge(base(), google);
  assert.equal(plan.merged.id, "ev-app");
  assert.equal(plan.merged.sourceType, "circolare");
  assert.equal(plan.merged.sourceCircularId, "circ-1");
  assert.equal(plan.merged.sourceItemId, "item-1");
  assert.equal(plan.merged.meetingUrl, "https://meet.google.com/abc-defg-hij");
  assert.equal(plan.merged.className, "3D");
  assert.equal(plan.merged.category, "consiglio_classe");
  assert.equal(plan.merged.googleEventId, "g1");
  assert.equal(plan.merged.googleCalendarId, "primary");
  assert.equal(plan.merged.syncedWithGoogle, false);
  // Campi uguali o vuoti non sono scelte: il link è un riepilogo, la classe pure.
  assert.equal(plan.fields.some(field => field.field === "meetingUrl"), false);
  assert.equal(plan.fields.some(field => field.field === "className"), false);
  assert.ok(plan.summary.some(line => line.field === "meetingUrl" && line.value.includes("meet.google.com")));
});

test("unione: campi pieni e diversi richiedono una scelta, preselezionata sulla base", () => {
  // "glo" è una categoria reale: il default "personale" dell'import Google non lo è.
  const google = imported({ title: "Consiglio straordinario", location: "Aula 4", category: "glo" });
  const plan = planMerge(base({ location: "Aula Magna" }), google, {}, category => category);
  const titles = plan.fields.filter(field => field.status === "choice").map(field => field.field);
  assert.deepEqual(titles.sort(), ["category", "location", "title"]);
  for (const field of plan.fields) assert.equal(field.defaultChoice, "base");
  assert.equal(plan.merged.title, "Consiglio di classe 3D");
  assert.equal(plan.merged.location, "Aula Magna");

  const chosen = planMerge(base({ location: "Aula Magna" }), google, { title: "other", location: "other" });
  assert.equal(chosen.merged.title, "Consiglio straordinario");
  assert.equal(chosen.merged.location, "Aula 4");
});

test("unione: categoria Google 'personale' vale come vuota: nessuna scelta, prende la categoria della circolare", () => {
  const google = imported(); // categoria "personale": il default dell'import Google
  const plan = planMerge(base(), google);
  assert.equal(plan.fields.some(field => field.field === "category"), false, "nessuna scelta di categoria");
  assert.equal(plan.merged.category, "consiglio_classe", "il risultato prende la categoria della circolare");
  assert.equal(plan.merged.sourceType, "circolare");
  assert.ok(plan.summary.some(line => line.field === "category" && line.value === "consiglio_classe"));
  // "personale" su un impegno nato nell'app è reale: resta una scelta normale.
  const realPersonal = planMerge(base({ category: "personale" }), imported({ category: "glo" }));
  assert.ok(realPersonal.fields.some(field => field.field === "category"));
});

test("unione: categoria Google diversa da 'personale' resta una scelta normale", () => {
  const google = imported({ category: "glo" });
  const plan = planMerge(base(), google);
  const category = plan.fields.find(field => field.field === "category");
  assert.ok(category, "scelta categoria presente");
  assert.equal(category!.baseValue, "consiglio_classe");
  assert.equal(category!.otherValue, "glo");
  assert.equal(category!.defaultChoice, "base");
  assert.equal(plan.merged.category, "consiglio_classe", "preselezione sulla base");
  const chosen = planMerge(base(), google, { category: "other" });
  assert.equal(chosen.merged.category, "glo", "la scelta sull'evento Google resta valida");
});

test("unione: note 'tieni entrambe' e note vuote da una parte", () => {
  const google = imported({ notes: "Portare il registro" });
  const both = planMerge(base({ notes: "Verbale da firmare" }), google, { notes: "both" });
  assert.equal(both.merged.notes, "Verbale da firmare\nPortare il registro");
  const onlyBase = planMerge(base({ notes: "Verbale da firmare" }), google, { notes: "base" });
  assert.equal(onlyBase.merged.notes, "Verbale da firmare");
  const emptyBase = planMerge(base(), google);
  assert.equal(emptyBase.merged.notes, "Portare il registro");
  assert.equal(planMerge(base({ notes: "Uguale" }), imported({ notes: "uguale" })).fields.some(f => f.field === "notes"), false);
});

test("unione: orario scelto dal lato Google e nessuna chiave undefined nel risultato", () => {
  const plan = planMerge(base({ startTime: undefined, endTime: undefined, className: undefined, location: undefined }), imported({ location: "Sala" }));
  assert.equal(plan.merged.startTime, "15:00");
  assert.equal(plan.merged.endTime, "16:00");
  assert.equal(plan.merged.location, "Sala");
  assert.equal("className" in plan.merged, false);
  assert.equal("meetingUrl" in plan.merged, false);
});

test("import primario: un impegno unito non viene duplicato né sovrascritto", () => {
  const merged = base({ googleEventId: "g1", googleCalendarId: "primary", syncedWithGoogle: false, title: "Titolo locale" });
  const result = mergeGoogleCalendarGroups([merged], [{ calendarId: "primary", isPrimary: true, events: [remote()] }]);
  assert.equal(result.added, 0);
  assert.equal(result.linked, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].title, "Titolo locale");
  assert.equal(result.events[0].sourceType, "circolare");
});

test("import G1 (solo primario): un impegno unito non viene duplicato", () => {
  const merged = base({ googleEventId: "g1", syncedWithGoogle: false });
  const result = mergeGoogleCalendarEvents([merged], [remote()]);
  assert.equal(result.added, 0);
  assert.equal(result.linked, 1);
  assert.equal(result.events[0].id, "ev-app");
});

test("import su calendario condiviso: un impegno unito con googleCalendarId condiviso non viene duplicato", () => {
  const sharedId = "team@group.calendar.google.com";
  const merged = base({ googleEventId: "g5", googleCalendarId: sharedId });
  const result = mergeGoogleCalendarGroups(
    [merged],
    [{ calendarId: sharedId, isPrimary: false, events: [remote({ id: "g5" })] }],
  );
  assert.equal(result.added, 0);
  assert.equal(result.linked, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].sourceType, "circolare");
});

test("import: un impegno unito riceve il link Meet se è vuoto, ma non lo sostituisce se presente", () => {
  const withoutLink = base({ googleEventId: "g1", googleCalendarId: "primary" });
  const addLink = mergeGoogleCalendarGroups(
    [withoutLink],
    [{ calendarId: "primary", isPrimary: true, events: [remote({ hangoutLink: "https://meet.google.com/new-link-abc" } as Partial<GoogleCalendarApiEvent>)] }],
  );
  assert.equal(addLink.events[0].meetingUrl, "https://meet.google.com/new-link-abc");
  assert.equal(addLink.linked, 1);

  const withLink = base({ googleEventId: "g1", googleCalendarId: "primary", meetingUrl: "https://zoom.us/j/111" });
  const keepLink = mergeGoogleCalendarGroups(
    [withLink],
    [{ calendarId: "primary", isPrimary: true, events: [remote({ hangoutLink: "https://meet.google.com/new-link-abc" } as Partial<GoogleCalendarApiEvent>)] }],
  );
  assert.equal(keepLink.events[0].meetingUrl, "https://zoom.us/j/111");

  const legacyAddLink = mergeGoogleCalendarEvents(
    [withoutLink],
    [remote({ hangoutLink: "https://meet.google.com/new-link-abc" } as Partial<GoogleCalendarApiEvent>)],
  );
  assert.equal(legacyAddLink.events[0].meetingUrl, "https://meet.google.com/new-link-abc");
  assert.equal(legacyAddLink.events[0].sourceType, "circolare");
});

test("ciclo completo: dopo l'unione la sincronizzazione successiva non duplica (principale e condiviso)", () => {
  // Principale: l'impegno Google si unisce alla circolare; il risultato porta googleCalendarId "primary".
  const primaryImport = imported({ googleCalendarId: "primary", meetingUrl: "https://meet.google.com/aaa-bbbb-ccc" });
  const primaryMerged = planMerge(base(), primaryImport).merged;
  const afterPrimary = mergeGoogleCalendarGroups(
    [primaryMerged],
    [{ calendarId: "primary", isPrimary: true, events: [remote()] }],
  );
  assert.equal(afterPrimary.added, 0);
  assert.equal(afterPrimary.linked, 1);
  assert.equal(afterPrimary.events.length, 1);
  assert.equal(afterPrimary.events[0].sourceType, "circolare");

  // Condiviso: stesso ciclo, con googleCalendarId del calendario condiviso.
  const sharedId = "team@group.calendar.google.com";
  const sharedImport = imported({ id: "gcal-shared-g5", googleEventId: "g5", googleCalendarId: sharedId });
  const sharedMerged = planMerge(base(), sharedImport).merged;
  assert.equal(sharedMerged.googleCalendarId, sharedId);
  const afterShared = mergeGoogleCalendarGroups(
    [sharedMerged],
    [{ calendarId: sharedId, isPrimary: false, events: [remote({ id: "g5" })] }],
  );
  assert.equal(afterShared.added, 0, "nessun doppione dal calendario condiviso");
  assert.equal(afterShared.events.length, 1);
});
