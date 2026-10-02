import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { create, act } from "react-test-renderer";
import type { User as FirebaseUser } from "firebase/auth";
import { ProfileModal } from "../src/components/ProfileModal";
import {
  canImportGoogleCalendarEvents,
  getImportableGoogleCalendars,
  getWritableGoogleCalendars,
  listGoogleCalendars,
  IMPORTABLE_ACCESS_ROLES,
  type GoogleCalendarListEntry,
} from "../src/services/googleCalendarService";
import {
  cachedGoogleCalendarsToEntries,
  googleCalendarSelectableIds,
  isValidCachedGoogleCalendar,
  normalizeCachedGoogleCalendars,
  sameCachedGoogleCalendarList,
  toCachedGoogleCalendarList,
  CACHED_GOOGLE_CALENDAR_FIELDS,
} from "../src/utils/googleCalendarCache";
import {
  importSelectedGoogleCalendars,
  resolveImportCalendarIds,
} from "../src/services/googleCalendarImportService";
import { removeImportedGoogleEventsForCalendars, googleEventToCalendarEvent } from "../src/utils/googleCalendarImport";
import { isValidProfilePayload, isValidGoogleCalendarListCache } from "../src/services/sync/remoteSchema";
import { validateBackup } from "../src/services/backup";
import type { CachedGoogleCalendar, CalendarEvent, TeacherProfile } from "../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const root = resolve(import.meta.dirname, "..");
const readSource = (relative: string) => readFileSync(resolve(root, relative), "utf8");
const appSource = readSource("src/App.tsx");
const modalSource = readSource("src/components/ProfileModal.tsx");

const LIVE_LIST: GoogleCalendarListEntry[] = [
  { id: "me@scuola.it", summary: "Calendario principale", primary: true, accessRole: "owner", selected: true, hidden: false },
  { id: "1d@scuola.it", summary: "1D Sostegno + Geografia", accessRole: "writer" },
  { id: "francese@scuola.it", summary: "FRANCESE 1E", accessRole: "reader" },
  { id: "holidays@group.v.calendar.google.com", summary: "Festività in Italia", accessRole: "reader" },
];

const baseProfile = (overrides: Partial<TeacherProfile> = {}): TeacherProfile => ({
  id: "p1",
  fullName: "Prof. Andrea Conti",
  schoolName: "IC Leonardo Da Vinci",
  schoolLevel: "ssig",
  schoolYear: "2026/2027",
  primarySubjects: ["Sostegno"],
  classes: ["1A"],
  campuses: ["Sede Centrale"],
  roles: [],
  ...overrides,
});

const googleUser = {
  uid: "uid-1", email: "docente@scuola.edu.it", displayName: "Andrea Conti", photoURL: null,
} as unknown as FirebaseUser;

// ---------------------------------------------------------------------------
// ProfileModal harness
// ---------------------------------------------------------------------------

type ModalProps = Partial<React.ComponentProps<typeof ProfileModal>>;

async function mountGoogleTab(props: ModalProps = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(ProfileModal, {
      isOpen: true,
      onClose: () => {},
      profile: baseProfile(),
      onSaveProfile: () => {},
      onDataImported: () => {},
      googleUser,
      events: [],
      initialTab: "google" as const,
      ...props,
    } as React.ComponentProps<typeof ProfileModal>));
  });
  return renderer;
}

const click = async (node: any) => { await act(async () => { await node.props.onClick(); }); };

function allText(renderer: any): string {
  return renderer.root.findAll(() => true)
    .flatMap((node: any) => (Array.isArray(node.children) ? node.children : []))
    .filter((child: any) => typeof child === "string")
    .join(" ");
}

function buttonByText(renderer: any, label: string) {
  const match = renderer.root.findAll((node: any) =>
    node.type === "button"
    && (Array.isArray(node.children) ? node.children : []).some((c: any) => typeof c === "string" && c.includes(label)));
  assert.ok(match.length >= 1, `pulsante "${label}" presente`);
  return match[0];
}

function checkboxFor(renderer: any, calendarId: string) {
  return renderer.root.find((node: any) => node.type === "input" && node.props.id === `gcal-select-${calendarId}`);
}

// ---------------------------------------------------------------------------
// 1 + 16 + 17 — la CalendarList live finisce in cache, senza token
// ---------------------------------------------------------------------------

test("1/16 — la CalendarList live diventa una cache minimale e non contiene token né credenziali", () => {
  const polluted = LIVE_LIST.map(entry => ({
    ...entry,
    accessToken: "ya29.SEGRETO",
    refresh_token: "1//rt",
    conferenceProperties: { allowedConferenceSolutionTypes: ["hangoutsMeet"] },
  })) as unknown as GoogleCalendarListEntry[];

  const cache = toCachedGoogleCalendarList(polluted);
  assert.equal(cache.length, 4);
  for (const entry of cache) {
    assert.deepEqual(Object.keys(entry).sort(), Object.keys(entry).sort());
    for (const key of Object.keys(entry)) {
      assert.ok((CACHED_GOOGLE_CALENDAR_FIELDS as readonly string[]).includes(key), `campo non ammesso in cache: ${key}`);
    }
  }
  const serialized = JSON.stringify(cache);
  assert.doesNotMatch(serialized, /token|credential|cookie|ya29|refresh/i);
  // selected/hidden della CalendarList non vengono persistiti
  assert.equal((cache[0] as any).selected, undefined);
  assert.deepEqual(cache[0], { id: "me@scuola.it", summary: "Calendario principale", primary: true, accessRole: "owner" });
});

test("1 — App salva la cache dopo ogni CalendarList riuscita, senza toccare la selezione", () => {
  assert.match(appSource, /const applyLiveGoogleCalendarList = useCallback/);
  assert.match(appSource, /setGoogleCalendarListSource\("live"\);/);
  assert.match(appSource, /const cache = toCachedGoogleCalendarList\(calendars\);/);
  assert.match(appSource, /googleCalendarListCache: cache/);
  // la lista live è l'unico percorso che scrive la cache: reconnect + load on-demand
  assert.match(appSource, /await applyLiveGoogleCalendarList\(await listGoogleCalendars\(result\.accessToken\)\)/);
  assert.match(appSource, /const calendars = await listGoogleCalendars\(token\);\s*await applyLiveGoogleCalendarList\(calendars\);/);
});

// ---------------------------------------------------------------------------
// 2 + 17 — bootstrap della cache al riavvio e dopo un reload del profilo
// ---------------------------------------------------------------------------

test("2/17 — la cache persistita riaccende googleCalendars al bootstrap e dopo un reload profilo", () => {
  const cache: CachedGoogleCalendar[] = toCachedGoogleCalendarList(LIVE_LIST);
  const entries = cachedGoogleCalendarsToEntries(cache);
  assert.deepEqual(entries.map(e => e.summary), [
    "Calendario principale", "1D Sostegno + Geografia", "FRANCESE 1E", "Festività in Italia",
  ]);
  assert.equal(entries[0].primary, true);
  assert.equal(entries[2].accessRole, "reader");
  // la cache sopravvive a una serializzazione completa (IndexedDB / Firestore / backup)
  assert.deepEqual(cachedGoogleCalendarsToEntries(JSON.parse(JSON.stringify(cache))), entries);

  // bootstrap dello stato runtime dal profilo iniziale
  assert.match(appSource, /useState<GoogleCalendarListEntry\[\] \| null>\(\(\) => \{\s*const bootstrapped = cachedGoogleCalendarsToEntries\(initialData\.profile\.googleCalendarListCache\);/);
  assert.match(appSource, /useState<"cache" \| "live" \| null>/);
  // re-bootstrap su cambio profilo (restore backup / account sync) quando non c'è lista runtime
  assert.match(appSource, /if \(googleCalendars !== null\) return;\s*const cached = cachedGoogleCalendarsToEntries\(profile\.googleCalendarListCache\);/);
  assert.match(appSource, /setGoogleCalendarListSource\("cache"\);/);
});

test("2 — una voce malformata viene scartata senza invalidare il profilo", () => {
  const raw = [
    { id: "ok@scuola.it", summary: "Valido", accessRole: "reader" },
    { id: "", summary: "id vuoto" },
    { summary: "senza id" },
    { id: "x@scuola.it", summary: 42 },
    null,
    "stringa",
    { id: "bool@scuola.it", summary: "Primary non booleano", primary: "si" },
  ];
  const normalized = normalizeCachedGoogleCalendars(raw);
  assert.deepEqual(normalized, [{ id: "ok@scuola.it", summary: "Valido", accessRole: "reader" }]);
  assert.equal(isValidCachedGoogleCalendar({ id: "a", summary: "A" }), true);
  assert.equal(isValidCachedGoogleCalendar({ id: " ", summary: "A" }), false);
  assert.equal(normalizeCachedGoogleCalendars(undefined).length, 0);
  assert.equal(normalizeCachedGoogleCalendars("boom").length, 0);

  // il profilo resta valido per Firestore e per il backup anche con un elemento sporco
  const profile = baseProfile({ googleCalendarListCache: raw as unknown as CachedGoogleCalendar[] });
  assert.equal(isValidGoogleCalendarListCache(raw), true);
  assert.equal(isValidProfilePayload(JSON.parse(JSON.stringify(profile))), true);
});

test("3bis — profilo con cache valida accettato da remote schema e da validateBackup", () => {
  const profile = baseProfile({
    googleCalendarImportIds: ["primary", "1d@scuola.it"],
    googleCalendarListCache: toCachedGoogleCalendarList(LIVE_LIST),
  });
  assert.equal(isValidProfilePayload(JSON.parse(JSON.stringify(profile))), true);
  validateBackup({
    version: 3, profile, events: [], circulars: [], students: [],
    definitiveTimetable: [], provisionalTimetable: [], timetableMode: "auto", onboardingCompleted: true,
  });
});

// ---------------------------------------------------------------------------
// 3 + 4 + 6 — la cache mostra i calendari senza token e le spunte sono modificabili
// ---------------------------------------------------------------------------

test("3/6 — senza token la card mostra la cache con la nota discreta e nessun errore rosso", async () => {
  let loadCalls = 0;
  const renderer = await mountGoogleTab({
    googleAccessToken: null,
    googleCalendars: cachedGoogleCalendarsToEntries(toCachedGoogleCalendarList(LIVE_LIST)),
    googleCalendarListSource: "cache",
    selectedGoogleCalendarIds: ["primary", "1d@scuola.it"],
    onLoadGoogleCalendars: async () => { loadCalls++; return []; },
    onUpdateGoogleCalendarSelection: async () => {},
  });
  const text = allText(renderer);
  assert.match(text, /Elenco salvato dall’ultima connessione Google\./);
  assert.match(text, /Ricollega Google per aggiornare l’elenco\./);
  assert.doesNotMatch(text, /Elenco aggiornato da Google\./);
  // nomi, tipo e spunte correnti sono visibili senza alcuna chiamata a Google
  assert.match(text, /Calendario principale/);
  assert.match(text, /FRANCESE 1E/);
  assert.equal(checkboxFor(renderer, "me@scuola.it").props.checked, true);
  assert.equal(checkboxFor(renderer, "1d@scuola.it").props.checked, true);
  assert.equal(checkboxFor(renderer, "francese@scuola.it").props.checked, false);
  assert.equal(loadCalls, 0, "senza token non parte alcuna fetch della CalendarList");
  await act(async () => { renderer.unmount(); });
});

test("6 — con lista live la nota è 'Elenco aggiornato da Google.'", async () => {
  const renderer = await mountGoogleTab({
    googleAccessToken: "token",
    googleCalendars: LIVE_LIST,
    googleCalendarListSource: "live",
    onLoadGoogleCalendars: async () => LIVE_LIST,
    onUpdateGoogleCalendarSelection: async () => {},
  });
  const text = allText(renderer);
  assert.match(text, /Elenco aggiornato da Google\./);
  assert.doesNotMatch(text, /Elenco salvato dall’ultima connessione Google/);
  await act(async () => { renderer.unmount(); });
});

test("4/8/9 — senza token la spunta è modificabile, persiste la selezione e non mostra errori", async () => {
  const updates: string[][] = [];
  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => { fetchCalls.push(String(input)); return new Response("{}"); }) as typeof fetch;
  try {
    const renderer = await mountGoogleTab({
      googleAccessToken: null,
      googleCalendars: cachedGoogleCalendarsToEntries(toCachedGoogleCalendarList(LIVE_LIST)),
      googleCalendarListSource: "cache",
      selectedGoogleCalendarIds: ["primary"],
      onUpdateGoogleCalendarSelection: async ids => { updates.push(ids); },
    });
    const checkbox = checkboxFor(renderer, "francese@scuola.it");
    await act(async () => { await checkbox.props.onChange({ target: { checked: true } }); });
    assert.equal(updates.length, 1, "una sola chiamata di aggiornamento selezione");
    assert.deepEqual(updates[0].sort(), ["francese@scuola.it", "primary"]);
    const text = allText(renderer);
    assert.match(text, /Calendario selezionato\. Gli eventi verranno importati alla prossima riconnessione Google\./);
    assert.doesNotMatch(text, /Impossibile aggiornare la selezione/);
    assert.deepEqual(fetchCalls, [], "nessuna GET verso Google senza token");
    await act(async () => { renderer.unmount(); });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 5 + 6 + 8 + 10 — handler di selezione: token assente ⇒ save + cleanup + stop
// ---------------------------------------------------------------------------

test("5/6/10 — handleUpdateGoogleCalendarSelection: senza token salva e pulisce, senza chiamare Google", () => {
  const handler = appSource.slice(
    appSource.indexOf("const handleUpdateGoogleCalendarSelection"),
    appSource.indexOf("// Focus and online transitions"),
  );
  // il token è letto prima, ma non blocca né il salvataggio né il cleanup
  assert.match(handler, /const token = googleAccessToken \|\| getAccessToken\(\);/);
  const saveIndex = handler.indexOf("handleSaveProfile({ ...profile, googleCalendarImportIds: normalizedNext })");
  const cleanupIndex = handler.indexOf("removeImportedGoogleEventsForCalendars(current, removedIds)");
  const tokenGuardIndex = handler.indexOf("if (!token) {");
  const importIndex = handler.indexOf("await runAutomaticGoogleImport(true, undefined, undefined, unique)");
  assert.ok(saveIndex > 0 && cleanupIndex > saveIndex, "save profile → cleanup removed");
  assert.ok(tokenGuardIndex > cleanupIndex, "il guard sul token viene DOPO salvataggio e cleanup");
  assert.ok(importIndex > tokenGuardIndex, "l'import resta l'ultimo passo, solo con token");
  // il ramo senza token esce senza errori e senza import
  assert.match(handler, /if \(!token\) \{[\s\S]*?return;\s*\}/);
  assert.match(handler, /Calendario selezionato\. Gli eventi verranno importati alla prossima riconnessione Google\./);
});

test("5/8 — cleanup locale G1.2.3 di un calendario deselezionato: puramente locale", () => {
  const events: CalendarEvent[] = [
    googleEventToCalendarEvent({ id: "h1", summary: "Festa", start: { date: "2026-01-06" }, end: { date: "2026-01-07" } }, "holidays@group.v.calendar.google.com"),
    googleEventToCalendarEvent({ id: "d1", summary: "Consiglio", start: { date: "2026-01-08" }, end: { date: "2026-01-09" } }, "1d@scuola.it"),
    { id: "manuale-1", title: "GLO", category: "glo", date: "2026-01-10", isAllDay: true, sourceType: "manuale", completed: false },
  ];
  const cleaned = removeImportedGoogleEventsForCalendars(events, ["holidays@group.v.calendar.google.com"]);
  assert.deepEqual(cleaned.map(e => e.id), [events[1].id, "manuale-1"]);
  assert.equal(cleaned.every(e => e.sourceType !== "google_calendar" || e.googleCalendarId !== "holidays@group.v.calendar.google.com"), true);
});

test("10 — la selezione salvata senza token viene importata alla riconnessione successiva", async () => {
  // selezione persistita mentre il token mancava
  const profile = baseProfile({ googleCalendarImportIds: ["primary", "francese@scuola.it"] });
  const requested: string[] = [];
  let state: CalendarEvent[] = [];
  const result = await importSelectedGoogleCalendars("token-dopo-reconnect", resolveImportCalendarIds(profile), {
    list: async (_t, calendarId) => {
      requested.push(calendarId);
      return Object.assign([
        { id: `${calendarId}-ev`, summary: "Evento", start: { dateTime: "2026-01-15T12:30:00Z" }, end: { dateTime: "2026-01-15T13:30:00Z" } },
      ], { partial: false, pagesRead: 1 });
    },
    read: async () => state,
    write: async events => { state = events; },
    atomic: async <T,>(operation: () => Promise<T>) => operation(),
    now: new Date(2026, 0, 10, 10),
  });
  assert.deepEqual(requested, ["primary", "francese@scuola.it"]);
  assert.equal(result.added, 2);
  assert.deepEqual(state.map(e => e.googleCalendarId), ["primary", "francese@scuola.it"]);
});

// ---------------------------------------------------------------------------
// 11 + 12 + 13 + 14 + 23 — Seleziona tutti / Deseleziona tutti
// ---------------------------------------------------------------------------

test("11/23 — Seleziona tutti: una sola chiamata con tutti i calendari realmente importabili", async () => {
  const updates: string[][] = [];
  const withFreeBusy: GoogleCalendarListEntry[] = [
    ...LIVE_LIST,
    { id: "busy@scuola.it", summary: "Disponibilità collega", accessRole: "freeBusyReader" },
  ];
  const renderer = await mountGoogleTab({
    googleAccessToken: null,
    googleCalendars: withFreeBusy,
    googleCalendarListSource: "cache",
    selectedGoogleCalendarIds: [],
    onUpdateGoogleCalendarSelection: async ids => { updates.push(ids); },
  });
  await click(buttonByText(renderer, "Seleziona tutti"));
  assert.equal(updates.length, 1, "una sola onUpdateGoogleCalendarSelection, non N click simulati");
  const selected = updates[0];
  // reader incluso (importabile), freeBusyReader escluso
  assert.ok(selected.includes("francese@scuola.it"), "un calendario reader resta selezionabile");
  assert.ok(selected.includes("holidays@group.v.calendar.google.com"));
  assert.ok(selected.includes("1d@scuola.it"));
  assert.ok(!selected.includes("busy@scuola.it"), "freeBusyReader non è importabile");
  // alias primary conservato insieme all'id reale: App canonicalizza su "primary"
  assert.ok(selected.includes("me@scuola.it") && selected.includes("primary"));
  // la checkbox non importabile è disabilitata
  assert.equal(checkboxFor(renderer, "busy@scuola.it").props.disabled, true);
  assert.equal(checkboxFor(renderer, "francese@scuola.it").props.disabled, false);
  await act(async () => { renderer.unmount(); });
});

test("12/13 — Deseleziona tutti: una sola chiamata con lista vuota", async () => {
  const updates: string[][] = [];
  const renderer = await mountGoogleTab({
    googleAccessToken: "token",
    googleCalendars: LIVE_LIST,
    googleCalendarListSource: "live",
    selectedGoogleCalendarIds: ["primary", "1d@scuola.it", "francese@scuola.it"],
    onUpdateGoogleCalendarSelection: async ids => { updates.push(ids); },
  });
  await click(buttonByText(renderer, "Deseleziona tutti"));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], []);
  await act(async () => { renderer.unmount(); });
});

test("14 — Deseleziona tutti pulisce TUTTI gli eventi inbound e non chiama Google", async () => {
  const events: CalendarEvent[] = [
    googleEventToCalendarEvent({ id: "p1", summary: "Primary", start: { date: "2026-01-06" }, end: { date: "2026-01-07" } }, "primary"),
    googleEventToCalendarEvent({ id: "s1", summary: "Shared", start: { date: "2026-01-06" }, end: { date: "2026-01-07" } }, "1d@scuola.it"),
    googleEventToCalendarEvent({ id: "r1", summary: "Reader", start: { date: "2026-01-06" }, end: { date: "2026-01-07" } }, "francese@scuola.it"),
    { id: "manuale-1", title: "GLO", category: "glo", date: "2026-01-10", isAllDay: true, sourceType: "manuale", completed: false },
  ];
  const cleaned = removeImportedGoogleEventsForCalendars(events, ["primary", "1d@scuola.it", "francese@scuola.it"]);
  assert.deepEqual(cleaned.map(e => e.id), ["manuale-1"]);

  // selezione vuota ⇒ importSelectedGoogleCalendars non interroga Google
  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => { fetchCalls.push(String(input)); return new Response("{}"); }) as typeof fetch;
  try {
    const result = await importSelectedGoogleCalendars("token", []);
    assert.equal(result.calendarsRequested, 0);
    assert.equal(result.added, 0);
    assert.deepEqual(fetchCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("11/12 — le azioni bulk sono atomiche: un solo save/cleanup/import per gesto", () => {
  assert.match(modalSource, /data-google-calendar-bulk-actions/);
  assert.match(modalSource, /Seleziona tutti/);
  assert.match(modalSource, /Deseleziona tutti/);
  assert.match(modalSource, /runCalendarSelectionUpdate\("select-all", selectAllCalendarIds\)/);
  assert.match(modalSource, /runCalendarSelectionUpdate\("clear-all", \[\]\)/);
  // un unico punto di ingresso ⇒ una sola await onUpdateGoogleCalendarSelection nel componente
  const calls = modalSource.match(/await onUpdateGoogleCalendarSelection\(/g) ?? [];
  assert.equal(calls.length, 1, "una sola invocazione di onUpdateGoogleCalendarSelection in tutto il componente");
});

// ---------------------------------------------------------------------------
// 15 + 17 — primary non reimpostato, nessun duplicato primary/email
// ---------------------------------------------------------------------------

test("15/17 — alias primary: nessun duplicato in cache e selezione mai reimpostata", () => {
  const withAliasDuplicate: GoogleCalendarListEntry[] = [
    { id: "primary", summary: "Calendario principale", primary: true, accessRole: "owner" },
    { id: "me@scuola.it", summary: "Calendario principale", primary: true, accessRole: "owner" },
    { id: "1d@scuola.it", summary: "1D", accessRole: "writer" },
  ];
  const cache = toCachedGoogleCalendarList(withAliasDuplicate);
  assert.deepEqual(cache.map(c => c.id), ["me@scuola.it", "1d@scuola.it"]);

  const ids = googleCalendarSelectableIds(LIVE_LIST);
  assert.ok(ids.has("primary") && ids.has("me@scuola.it"));

  // una selezione vuota esplicita non torna mai a ["primary"]
  assert.deepEqual(resolveImportCalendarIds({ googleCalendarImportIds: [] }), []);
  assert.deepEqual(resolveImportCalendarIds({ googleCalendarImportIds: ["primary", "primary"] }), ["primary"]);
  // nessuna reimpostazione automatica della selezione nel percorso live
  assert.doesNotMatch(appSource, /googleCalendarImportIds: \[PRIMARY_CALENDAR_ID\]/);
});

// ---------------------------------------------------------------------------
// 18 + 19 + 20 — "Aggiorna elenco calendari"
// ---------------------------------------------------------------------------

test("18 — Aggiorna elenco con token sostituisce lista e cache, senza toccare le spunte", async () => {
  const pages = [
    { items: [{ id: "me@scuola.it", summary: "Calendario principale", primary: true, accessRole: "owner" }] },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(pages[0]), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    const live = await listGoogleCalendars("token");
    const cache = toCachedGoogleCalendarList(live);
    assert.deepEqual(cache.map(c => c.id), ["me@scuola.it"]);
    // la nuova cache SOSTITUISCE la precedente (il calendario rimosso sparisce)
    const previous = toCachedGoogleCalendarList(LIVE_LIST);
    assert.equal(sameCachedGoogleCalendarList(previous, cache), false);
    assert.equal(sameCachedGoogleCalendarList(cache, toCachedGoogleCalendarList(live)), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  // il refresh non scrive mai googleCalendarImportIds se non per calendari spariti
  const apply = appSource.slice(appSource.indexOf("const applyLiveGoogleCalendarList"), appSource.indexOf("/** Loads the CalendarList"));
  assert.match(apply, /if \(staleIds\.length > 0\) nextProfile\.googleCalendarImportIds = selection!\.filter\(id => liveIds\.has\(id\)\);/);
  assert.match(apply, /Array\.isArray\(selection\) \? selection\.filter\(id => !liveIds\.has\(id\)\) : \[\]/);
});

test("19 — Aggiorna elenco senza token chiede il reconnect e non lancia la fetch", async () => {
  let loadCalls = 0;
  const renderer = await mountGoogleTab({
    googleAccessToken: null,
    googleCalendars: cachedGoogleCalendarsToEntries(toCachedGoogleCalendarList(LIVE_LIST)),
    googleCalendarListSource: "cache",
    onLoadGoogleCalendars: async () => { loadCalls++; return []; },
    onUpdateGoogleCalendarSelection: async () => {},
  });
  await click(buttonByText(renderer, "Aggiorna elenco calendari"));
  assert.equal(loadCalls, 0, "nessuna fetch senza token");
  assert.match(allText(renderer), /Ricollega Google per aggiornare l’elenco dei calendari\./);
  await act(async () => { renderer.unmount(); });

  // anche in App: loadGoogleCalendars senza token rifiuta con un messaggio di reconnect
  assert.match(appSource, /throw new Error\("Ricollega Google per aggiornare l’elenco dei calendari\."\);/);
});

test("20 — una lista live non sovrascrive la selezione persistita ancora valida", () => {
  const profile = baseProfile({ googleCalendarImportIds: ["primary", "francese@scuola.it"] });
  const liveIds = googleCalendarSelectableIds(LIVE_LIST);
  const stale = profile.googleCalendarImportIds!.filter(id => !liveIds.has(id));
  assert.deepEqual(stale, [], "nessuna selezione scartata quando i calendari esistono ancora");

  // calendario sparito da Google: viene rimosso dalla selezione e i suoi eventi puliti
  const shrunk = LIVE_LIST.filter(c => c.id !== "francese@scuola.it");
  const shrunkIds = googleCalendarSelectableIds(shrunk);
  const removed = profile.googleCalendarImportIds!.filter(id => !shrunkIds.has(id));
  assert.deepEqual(removed, ["francese@scuola.it"]);
  assert.match(appSource, /Un calendario non è più disponibile ed è stato rimosso dalla selezione\./);
});

// ---------------------------------------------------------------------------
// 21 + 22 — outbound G1.3 invariato
// ---------------------------------------------------------------------------

test("21/22 — outbound G1.3: solo calendari scrivibili e token obbligatorio", () => {
  const writable = getWritableGoogleCalendars(cachedGoogleCalendarsToEntries(toCachedGoogleCalendarList([
    ...LIVE_LIST,
    { id: "busy@scuola.it", summary: "Disponibilità", accessRole: "freeBusyReader" },
  ])));
  // la cache non amplia i permessi: reader/freeBusyReader restano fuori dalle destinazioni
  assert.deepEqual(writable.map(c => c.id), ["me@scuola.it", "1d@scuola.it"]);

  // la destinazione outbound resta filtrata su owner/writer/organizer in App
  assert.match(appSource, /googleWritableCalendars=\{\(googleCalendars \|\| \[\]\)\.filter\(calendar => \["owner", "writer", "organizer"\]\.includes\(calendar\.accessRole \|\| ""\)\)\}/);
  // una lista da cache NON vale come lista caricata per l'EventModal: con token si ricarica live
  assert.match(appSource, /googleCalendarsLoaded=\{googleCalendars !== null && googleCalendarListSource === "live"\}/);

  // senza token l'invio richiede il reconnect (isGoogleConnected richiede user + token)
  assert.match(appSource, /isGoogleConnected=\{!!googleUser && !!googleAccessToken\}/);
  const modal = readSource("src/components/EventModal.tsx");
  assert.match(modal, /if \(!isOpen \|\| isGoogleSourcedEvent \|\| !isGoogleConnected \|\| googleCalendarsLoaded \|\| !onLoadGoogleCalendars\) return;/);
  assert.match(modal, /await onGoogleConnect\(\); await onLoadGoogleCalendars\?\.\(\);/);
});

// ---------------------------------------------------------------------------
// 23 — filtro calendari importabili (scelta documentata)
// ---------------------------------------------------------------------------

test("23 — ruoli importabili: owner/organizer/writer/reader sì, freeBusyReader no", () => {
  assert.deepEqual([...IMPORTABLE_ACCESS_ROLES], ["owner", "organizer", "writer", "reader"]);
  assert.equal(canImportGoogleCalendarEvents({ accessRole: "reader" }), true);
  assert.equal(canImportGoogleCalendarEvents({ accessRole: "owner" }), true);
  assert.equal(canImportGoogleCalendarEvents({ accessRole: "freeBusyReader" }), false);
  assert.equal(canImportGoogleCalendarEvents({ accessRole: "none" }), false);
  // una cache storica priva di accessRole resta importabile: proveniva da minAccessRole=reader
  assert.equal(canImportGoogleCalendarEvents({}), true);
  assert.deepEqual(
    getImportableGoogleCalendars([...LIVE_LIST, { id: "busy", summary: "Busy", accessRole: "freeBusyReader" }]).map(c => c.id),
    LIVE_LIST.map(c => c.id),
  );
  // la CalendarList viene già richiesta con minAccessRole=reader
  assert.match(readSource("src/services/googleCalendarService.ts"), /minAccessRole: "reader"/);
});

// ---------------------------------------------------------------------------
// 19 (sicurezza) — nessun token persistito, nessun nuovo storage
// ---------------------------------------------------------------------------

test("sicurezza — la cache vive nel profilo esistente e non introduce storage o segreti", () => {
  const cacheSource = readSource("src/utils/googleCalendarCache.ts");
  // whitelist esplicita: nessun campo oltre i quattro metadata può finire nel profilo
  assert.match(cacheSource, /CACHED_GOOGLE_CALENDAR_FIELDS = \["id", "summary", "primary", "accessRole"\] as const;/);
  const code = cacheSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /accessToken|refreshToken|refresh_token|credential|cookie/i);
  assert.match(readSource("src/types.ts"), /googleCalendarListCache\?: CachedGoogleCalendar\[\];/);
  // nessun nuovo storage: si usa storage.saveProfile dentro database.atomic
  assert.match(appSource, /await storage\.saveProfile\(nextProfile\);/);
  assert.doesNotMatch(appSource, /localStorage\.setItem\(["']googleCalendar/);
});
