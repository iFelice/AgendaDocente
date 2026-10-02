/**
 * G1.3 — invio manuale del singolo impegno AgendaDocente → Google Calendar
 * con scelta esplicita del calendario di destinazione scrivibile.
 *
 * Direzioni:
 *   Google Calendar → AgendaDocente   automatico / read-only (G1.x, invariato)
 *   AgendaDocente  → Google Calendar  manuale / per singolo impegno (questo file)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { act, create } from "react-test-renderer";
import { EventModal } from "../src/components/EventModal";
import {
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  getWritableGoogleCalendars,
  isGoogleSyncEnabled,
  PRIMARY_CALENDAR_ID,
  type GoogleCalendarListEntry,
} from "../src/services/googleCalendarService";
import { SCOPES } from "../src/services/googleAuth";
import type { CalendarEvent, TeacherProfile } from "../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const root = resolve(import.meta.dirname, "..");
const readSource = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const profile: TeacherProfile = {
  id: "p1", fullName: "Prof.ssa Bianchi", schoolName: "IC Da Vinci", schoolYear: "2026/27",
  primarySubjects: ["Italiano"], classes: ["3D"], campuses: ["Sede Centrale"], roles: [],
};

const calendars: GoogleCalendarListEntry[] = [
  { id: "me@scuola.it", summary: "me@scuola.it", primary: true, accessRole: "owner" },
  { id: "3d@scuola.it", summary: "Consiglio di classe 3D", accessRole: "writer" },
  { id: "classe3d@group.calendar.google.com", summary: "Classe 3D", accessRole: "owner" },
  { id: "circolari@scuola.it", summary: "Circolari", accessRole: "reader" },
  { id: "aule@scuola.it", summary: "Aule", accessRole: "freeBusyReader" },
  { id: "misterioso@scuola.it", summary: "Senza ruolo" },
];

const manualEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "ev-1", title: "Consiglio 3D", category: "consiglio_classe", date: "2026-10-20",
  startTime: "15:00", endTime: "16:30", isAllDay: false, sourceType: "manuale",
  completed: false, ...overrides,
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

async function mountModal(props: Partial<React.ComponentProps<typeof EventModal>> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true,
      onClose: () => {},
      eventToEdit: null,
      profile,
      onSave: () => {},
      ...props,
    }));
  });
  return renderer;
}

const textOf = (node: any): string => {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  return (node.children ?? []).map(textOf).join("");
};

const findButton = (renderer: any, label: string) =>
  renderer.root.findAllByType("button").find((node: any) => textOf(node).includes(label));

const outboundSections = (renderer: any) =>
  renderer.root.findAllByProps({ "data-google-outbound": true });

// ———————————————————————————— filtro calendari scrivibili ————————————————————————————

// Test 4+5+6+7+8: owner/writer/organizer (e primary) entrano, reader/freeBusyReader no.
test("getWritableGoogleCalendars tiene solo owner/writer/organizer e scarta i read-only", () => {
  const writable = getWritableGoogleCalendars(calendars);
  assert.deepEqual(writable.map(c => c.id), ["me@scuola.it", "3d@scuola.it", "classe3d@group.calendar.google.com"]);
  assert.ok(writable.some(c => c.primary));
  assert.ok(writable.some(c => c.accessRole === "writer"));
  assert.ok(writable.some(c => c.accessRole === "owner"));
  assert.ok(!writable.some(c => c.accessRole === "reader"));
  assert.ok(!writable.some(c => c.accessRole === "freeBusyReader"));
  // organizer accettato difensivamente se mai restituito dalla CalendarList
  assert.equal(getWritableGoogleCalendars([{ id: "x", summary: "X", accessRole: "organizer" }]).length, 1);
  // senza ruolo riconosciuto ⇒ escluso
  assert.equal(getWritableGoogleCalendars([{ id: "y", summary: "Y" }]).length, 0);
});

// ———————————————————————————— API create/update parametrizzate ————————————————————————————

// Test 10+11+13: create POSTa sul calendario scelto, con calendarId encoded.
test("createGoogleCalendarEvent scrive sul calendario scelto con id encoded", async () => {
  await withFetch(() => jsonResponse({ id: "remote-1" }), async calls => {
    const id = await createGoogleCalendarEvent("token", manualEvent(), "3d@scuola.it");
    assert.equal(id, "remote-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.ok(calls[0].url.includes(`/calendars/${encodeURIComponent("3d@scuola.it")}/events`));
  });
});

// Test 12: senza calendarId i vecchi caller restano su primary.
test("createGoogleCalendarEvent senza calendarId resta su primary (backward compatibility)", async () => {
  await withFetch(() => jsonResponse({ id: "remote-2" }), async calls => {
    await createGoogleCalendarEvent("token", manualEvent());
    assert.ok(calls[0].url.includes("/calendars/primary/events"));
  });
});

// Test 16+18: update PATCHa il calendario passato, entrambi gli ID encoded, stesso googleEventId.
test("updateGoogleCalendarEvent PATCHa il calendario indicato con entrambi gli ID encoded", async () => {
  await withFetch(() => jsonResponse({}), async calls => {
    await updateGoogleCalendarEvent("token", "ev id/strano", manualEvent(), "3d@scuola.it");
    assert.equal(calls[0].method, "PATCH");
    assert.ok(calls[0].url.includes(`/calendars/${encodeURIComponent("3d@scuola.it")}/events/${encodeURIComponent("ev id/strano")}`));
  });
});

// Test 17: update legacy senza calendarId → primary.
test("updateGoogleCalendarEvent senza calendarId resta su primary", async () => {
  await withFetch(() => jsonResponse({}), async calls => {
    await updateGoogleCalendarEvent("token", "legacy-id", manualEvent());
    assert.ok(calls[0].url.includes(`/calendars/primary/events/${encodeURIComponent("legacy-id")}`));
  });
});

// Test 28 (service): lo status HTTP resta sull'errore per riconoscere 403/404.
test("create/update conservano lo status HTTP sugli errori (403 permesso, 404 calendario sparito)", async () => {
  await withFetch(() => jsonResponse({ error: { message: "Forbidden" } }, 403), async () => {
    await assert.rejects(createGoogleCalendarEvent("token", manualEvent(), "3d@scuola.it"),
      (error: Error & { status?: number }) => error.status === 403);
  });
  await withFetch(() => jsonResponse({ error: { message: "Not Found" } }, 404), async () => {
    await assert.rejects(updateGoogleCalendarEvent("token", "gone", manualEvent(), "sparito@scuola.it"),
      (error: Error & { status?: number }) => error.status === 404);
  });
});

// ———————————————————————————— EventModal: UI outbound ————————————————————————————

// Test 1+4+5+6+7+8+9: evento manuale non inviato ⇒ dropdown dei soli scrivibili + Invia, default primary.
test("EventModal: manuale senza googleEventId mostra dropdown scrivibili con default primary e Invia", async () => {
  const renderer = await mountModal({
    eventToEdit: manualEvent(),
    isGoogleConnected: true,
    hasGoogleAccount: true,
    googleWritableCalendars: getWritableGoogleCalendars(calendars),
    onSendToGoogle: async () => {},
  });
  try {
    const select = renderer.root.findByProps({ id: "google-destination-calendar" });
    assert.equal(select.props.value, "me@scuola.it"); // default = primary, nessun matching per classe
    const options = select.findAllByType("option");
    assert.deepEqual(options.map((o: any) => o.props.value),
      ["me@scuola.it", "3d@scuola.it", "classe3d@group.calendar.google.com"]);
    // il primary è etichettato "Il mio calendario"; i condivisi col loro nome
    assert.equal(options[0].props.children, "Il mio calendario");
    assert.equal(options[1].props.children, "Consiglio di classe 3D");
    assert.ok(findButton(renderer, "Invia a Google Calendar"));
    assert.ok(!findButton(renderer, "Aggiorna su Google Calendar"));
  } finally { await act(async () => renderer.unmount()); }
});

// Test 2: evento da circolare ⇒ stesso outbound manuale.
test("EventModal: evento da circolare mostra dropdown + Invia", async () => {
  const renderer = await mountModal({
    eventToEdit: manualEvent({ sourceType: "circolare" }),
    isGoogleConnected: true,
    hasGoogleAccount: true,
    googleWritableCalendars: getWritableGoogleCalendars(calendars),
    onSendToGoogle: async () => {},
  });
  try {
    assert.ok(renderer.root.findByProps({ id: "google-destination-calendar" }));
    assert.ok(findButton(renderer, "Invia a Google Calendar"));
  } finally { await act(async () => renderer.unmount()); }
});

// Test 3: evento importato da Google ⇒ NESSUN controllo outbound.
test("EventModal: evento google_calendar resta read-only, nessun outbound", async () => {
  const renderer = await mountModal({
    eventToEdit: manualEvent({ sourceType: "google_calendar", googleEventId: "g1", googleCalendarId: "primary" }),
    isGoogleConnected: true,
    hasGoogleAccount: true,
    googleWritableCalendars: getWritableGoogleCalendars(calendars),
    onSendToGoogle: async () => {},
  });
  try {
    assert.equal(outboundSections(renderer).length, 0);
    assert.ok(!findButton(renderer, "Invia a Google Calendar"));
    assert.ok(!findButton(renderer, "Aggiorna su Google Calendar"));
    assert.equal(renderer.root.findAllByProps({ id: "google-destination-calendar" }).length, 0);
  } finally { await act(async () => renderer.unmount()); }
});

// Test 10+13+14+15+21+26+30: Invia chiama onSendToGoogle col calendario scelto; doppio tap = una sola chiamata;
// al successo la destinazione si blocca e compare "Presente su Google Calendar".
test("EventModal: Invia usa il calendario scelto, doppio tap non duplica, poi destinazione bloccata", async () => {
  const sent: { event: CalendarEvent; calendarId: string }[] = [];
  const renderer = await mountModal({
    eventToEdit: manualEvent(),
    isGoogleConnected: true,
    hasGoogleAccount: true,
    googleWritableCalendars: getWritableGoogleCalendars(calendars),
    onSendToGoogle: async (event, calendarId) => {
      sent.push({ event, calendarId });
      return { ...event, googleEventId: "remote-99", googleCalendarId: calendarId, syncedWithGoogle: false };
    },
  });
  try {
    const select = renderer.root.findByProps({ id: "google-destination-calendar" });
    await act(async () => select.props.onChange({ target: { value: "3d@scuola.it" } }));
    const sendButton = findButton(renderer, "Invia a Google Calendar");
    // doppio tap: la seconda pressione trova il guard sincrono già attivo
    await act(async () => { void sendButton.props.onClick(); void sendButton.props.onClick(); });
    assert.equal(sent.length, 1, "un doppio tap non deve creare due copie Google");
    assert.equal(sent[0].calendarId, "3d@scuola.it");
    assert.equal(sent[0].event.id, "ev-1");
    assert.equal(sent[0].event.googleEventId, undefined);
    // UI post-invio: stato collegato, nome calendario dalla CalendarList in memoria, niente dropdown
    const sectionText = textOf(outboundSections(renderer)[0]);
    assert.match(sectionText, /Presente su Google Calendar/);
    assert.match(sectionText, /Calendario: Consiglio di classe 3D/);
    assert.equal(renderer.root.findAllByProps({ id: "google-destination-calendar" }).length, 0,
      "dopo l'invio la destinazione non è più modificabile");
    assert.ok(findButton(renderer, "Aggiorna su Google Calendar"));
  } finally { await act(async () => renderer.unmount()); }
});

// Test 16+18+30+36: evento già inviato ⇒ update sempre sul calendario salvato, stesso googleEventId.
test("EventModal: evento già inviato mostra stato e Aggiorna sul MEDESIMO calendario", async () => {
  const sent: { event: CalendarEvent; calendarId: string }[] = [];
  const renderer = await mountModal({
    eventToEdit: manualEvent({ googleEventId: "remote-7", googleCalendarId: "3d@scuola.it", syncedWithGoogle: true }),
    isGoogleConnected: true,
    hasGoogleAccount: true,
    googleWritableCalendars: getWritableGoogleCalendars(calendars),
    onSendToGoogle: async (event, calendarId) => { sent.push({ event, calendarId }); },
  });
  try {
    assert.match(textOf(renderer.root), /Presente su Google Calendar/);
    assert.match(textOf(renderer.root), /Calendario: Consiglio di classe 3D/);
    assert.equal(renderer.root.findAllByProps({ id: "google-destination-calendar" }).length, 0,
      "nessun dropdown per cambiare destinazione dopo l'invio");
    const updateButton = findButton(renderer, "Aggiorna su Google Calendar");
    await act(async () => { await updateButton.props.onClick(); });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].calendarId, "3d@scuola.it");
    assert.equal(sent[0].event.googleEventId, "remote-7");
    assert.equal(sent[0].event.googleCalendarId, "3d@scuola.it");
  } finally { await act(async () => renderer.unmount()); }
});

// Test 17: legacy outbound con googleEventId ma senza googleCalendarId ⇒ primary.
test("EventModal: legacy senza googleCalendarId aggiorna su primary", async () => {
  const sent: { calendarId: string }[] = [];
  const renderer = await mountModal({
    eventToEdit: manualEvent({ googleEventId: "legacy-1", syncedWithGoogle: true }),
    isGoogleConnected: true,
    hasGoogleAccount: true,
    googleWritableCalendars: getWritableGoogleCalendars(calendars),
    onSendToGoogle: async (_event, calendarId) => { sent.push({ calendarId }); },
  });
  try {
    assert.match(textOf(renderer.root), /Calendario: Il mio calendario/);
    const updateButton = findButton(renderer, "Aggiorna su Google Calendar");
    await act(async () => { await updateButton.props.onClick(); });
    assert.equal(sent[0].calendarId, PRIMARY_CALENDAR_ID);
  } finally { await act(async () => renderer.unmount()); }
});

// Test 19+20+32: il semplice Salva non fa MAI POST/PATCH e conserva il link Google.
test("EventModal: Salva Impegno è solo locale (nessuna fetch) e conserva googleEventId/calendarId", async () => {
  const saved: CalendarEvent[] = [];
  await withFetch(() => { throw new Error("nessuna chiamata di rete ammessa dal semplice Salva"); }, async calls => {
    const renderer = await mountModal({
      eventToEdit: manualEvent({ googleEventId: "remote-7", googleCalendarId: "3d@scuola.it", syncedWithGoogle: true }),
      isGoogleConnected: true,
      hasGoogleAccount: true,
      googleWritableCalendars: getWritableGoogleCalendars(calendars),
      onSendToGoogle: async () => { throw new Error("Salva non deve inviare a Google"); },
    });
    try {
      await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
      assert.equal(calls.length, 0, "Salva non deve fare POST né PATCH");
      assert.equal(saved.length, 0);
    } finally { await act(async () => renderer.unmount()); }
  });

  // il payload del Salva conserva il collegamento remoto senza normalizzarlo
  const renderer = await mountModal({
    eventToEdit: manualEvent({ googleEventId: "remote-7", googleCalendarId: "3d@scuola.it", syncedWithGoogle: true }),
    onSave: (event: CalendarEvent) => { saved.push(event); },
    googleWritableCalendars: getWritableGoogleCalendars(calendars),
    onSendToGoogle: async () => {},
    isGoogleConnected: true,
    hasGoogleAccount: true,
  });
  try {
    await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].googleEventId, "remote-7");
    assert.equal(saved[0].googleCalendarId, "3d@scuola.it");
    // il flag legacy viene solo trasportato: nessun nuovo consenso implicito
    assert.equal(saved[0].syncedWithGoogle, true);
  } finally { await act(async () => renderer.unmount()); }
});

// Test 22+24: token assente ⇒ sezione visibile con Ricollega Google esplicito, nessun popup automatico.
test("EventModal: token assente mostra Ricollega Google senza aprire popup automatici", async () => {
  let reconnects = 0;
  let logins = 0;
  const renderer = await mountModal({
    eventToEdit: manualEvent(),
    isGoogleConnected: false,
    hasGoogleAccount: true,
    googleWritableCalendars: null,
    onLoadGoogleWritableCalendars: async () => { throw new Error("senza token non si carica la CalendarList"); },
    onSendToGoogle: async () => {},
    onGoogleReconnect: async () => { reconnects++; },
    onGoogleLogin: async () => { logins++; },
  });
  try {
    assert.equal(outboundSections(renderer).length, 1, "la sezione Google NON va nascosta");
    assert.match(textOf(renderer.root), /devi ricollegare Google/);
    assert.equal(reconnects, 0, "nessun popup o autorizzazione senza gesto utente");
    assert.equal(logins, 0);
    const reconnectButton = findButton(renderer, "Ricollega Google");
    await act(async () => { await reconnectButton.props.onClick(); });
    assert.equal(reconnects, 1);
    assert.equal(logins, 0);
  } finally { await act(async () => renderer.unmount()); }
});

// Test 23+24: nessun account ⇒ Collega Google esplicito.
test("EventModal: account assente mostra Collega Google esplicito", async () => {
  let logins = 0;
  const renderer = await mountModal({
    eventToEdit: manualEvent(),
    isGoogleConnected: false,
    hasGoogleAccount: false,
    onSendToGoogle: async () => {},
    onGoogleLogin: async () => { logins++; },
  });
  try {
    assert.equal(outboundSections(renderer).length, 1);
    const connectButton = findButton(renderer, "Collega Google");
    assert.ok(connectButton);
    assert.equal(logins, 0, "login solo su gesto esplicito");
    await act(async () => { await connectButton.props.onClick(); });
    assert.equal(logins, 1);
  } finally { await act(async () => renderer.unmount()); }
});

// Test 25: CalendarList caricata on-demand una sola volta (cache, mai per-render).
test("EventModal: CalendarList on-demand una sola volta quando c'è token e manca la cache", async () => {
  let loads = 0;
  const renderer = await mountModal({
    eventToEdit: manualEvent(),
    isGoogleConnected: true,
    hasGoogleAccount: true,
    googleWritableCalendars: null,
    onLoadGoogleWritableCalendars: async () => { loads++; return getWritableGoogleCalendars(calendars); },
    onSendToGoogle: async () => {},
  });
  try {
    assert.equal(loads, 1);
    // un re-render qualsiasi non deve rifetchare
    await act(async () => renderer.update(React.createElement(EventModal, {
      isOpen: true, onClose: () => {}, eventToEdit: manualEvent(), profile, onSave: () => {},
      isGoogleConnected: true, hasGoogleAccount: true, googleWritableCalendars: null,
      onLoadGoogleWritableCalendars: async () => { loads++; return getWritableGoogleCalendars(calendars); },
      onSendToGoogle: async () => {},
    })));
    assert.equal(loads, 1, "nessun refetch ad ogni render");
    // la lista caricata alimenta il dropdown con default primary
    const select = renderer.root.findByProps({ id: "google-destination-calendar" });
    assert.equal(select.props.value, "me@scuola.it");
  } finally { await act(async () => renderer.unmount()); }
});

// Test 27+28: errore della POST ⇒ messaggio in modale, l'impegno resta salvato (nessun googleEventId).
test("EventModal: errore invio (es. 403) mostra il messaggio e non collega l'evento", async () => {
  const renderer = await mountModal({
    eventToEdit: manualEvent(),
    isGoogleConnected: true,
    hasGoogleAccount: true,
    googleWritableCalendars: getWritableGoogleCalendars(calendars),
    onSendToGoogle: async () => { throw new Error("Non hai più il permesso di scrivere su questo calendario Google."); },
  });
  try {
    const sendButton = findButton(renderer, "Invia a Google Calendar");
    await act(async () => { await sendButton.props.onClick(); });
    assert.match(textOf(renderer.root), /Non hai più il permesso di scrivere su questo calendario Google\./);
    // destinazione ancora selezionabile: si può scegliere un altro calendario
    assert.ok(renderer.root.findByProps({ id: "google-destination-calendar" }));
    assert.ok(!findButton(renderer, "Aggiorna su Google Calendar"));
  } finally { await act(async () => renderer.unmount()); }
});

// ———————————————————————————— App: handler e flusso locale-prima ————————————————————————————

test("App: Salva è solo locale; l'invio passa SOLO da handleSendEventToGoogle", () => {
  const app = readSource("src/App.tsx");
  // handleSaveEvent non sincronizza più nulla automaticamente
  const saveBody = app.slice(app.indexOf("const handleSaveEvent"), app.indexOf("const handleSaveEvent") + 600);
  assert.ok(!saveBody.includes("syncOptedInGoogleEvents"), "Salva non deve più fare sync automatico");
  assert.ok(!saveBody.includes("createGoogleCalendarEvent"));
  assert.ok(!saveBody.includes("updateGoogleCalendarEvent"));
  assert.ok(!saveBody.includes("isGoogleSyncEnabled"));
  assert.match(saveBody, /showToast\("Impegno salvato con successo\."\)/);

  // handler esplicito: locale prima, poi Google; 403 e calendario sparito gestiti
  const send = app.slice(app.indexOf("const handleSendEventToGoogle"));
  assert.ok(send.indexOf("await storage.saveEvent(event);") < send.indexOf("createGoogleCalendarEvent"),
    "salvataggio locale PRIMA della chiamata Google");
  assert.match(send, /createGoogleCalendarEvent\(token, event, calendarId\)/);
  assert.match(send, /googleEventId, googleCalendarId: calendarId, syncedWithGoogle: false/);
  // update: ignora il calendarId della UI e usa SEMPRE quello salvato (legacy ⇒ primary)
  assert.match(send, /event\.googleCalendarId \?\? PRIMARY_CALENDAR_ID/);
  assert.match(send, /updateGoogleCalendarEvent\(token, event\.googleEventId, event, targetCalendarId\)/);
  assert.match(send, /googleCalendarId: targetCalendarId, syncedWithGoogle: false/);
  // 403 ⇒ messaggio permessi + ricarica CalendarList, nessuna cancellazione
  assert.match(send, /Non hai più il permesso di scrivere su questo calendario Google\./);
  assert.match(send, /loadGoogleCalendars\(true\)/);
  // calendario sparito ⇒ errore chiaro, NESSUN fallback automatico su primary
  assert.match(send, /non è più disponibile/);
  assert.ok(!/status === 404[\s\S]{0,400}createGoogleCalendarEvent/.test(send),
    "mai creare una nuova copia altrove se il calendario è sparito");
  // single-flight per event id
  assert.match(app, /sendToGoogleInFlight/);

  // wiring EventModal
  assert.match(app, /onSendToGoogle=\{handleSendEventToGoogle\}/);
  assert.match(app, /hasGoogleAccount=\{!!googleUser\}/);
  assert.match(app, /onGoogleReconnect=\{handleGoogleReconnect\}/);
  assert.match(app, /googleWritableCalendars=\{googleWritableCalendars\}/);
  assert.match(app, /onLoadGoogleWritableCalendars=\{loadGoogleWritableCalendars\}/);
});

// Test 34: il nuovo flusso salva syncedWithGoogle=false ⇒ la delete locale NON tocca la copia remota.
test("delete locale: un evento inviato con G1.3 (syncedWithGoogle=false) non cancella la copia Google", () => {
  assert.equal(isGoogleSyncEnabled({ syncedWithGoogle: false }), false);
  const workflows = readSource("src/services/eventWorkflows.ts");
  // la cancellazione remota resta vincolata al flag legacy: invio manuale ≠ consenso alla cancellazione
  assert.match(workflows, /event\?\.googleEventId && isGoogleSyncEnabled\(event\) && token/);
});

// Test 35: i vecchi eventi opted-in restano leggibili e riconosciuti.
test("legacy syncedWithGoogle=true resta leggibile e mostra lo stato collegato", async () => {
  assert.equal(isGoogleSyncEnabled({ syncedWithGoogle: true }), true);
  const renderer = await mountModal({
    eventToEdit: manualEvent({ googleEventId: "legacy-9", syncedWithGoogle: true }),
    isGoogleConnected: true,
    hasGoogleAccount: true,
    googleWritableCalendars: getWritableGoogleCalendars(calendars),
    onSendToGoogle: async () => {},
  });
  try {
    assert.match(textOf(renderer.root), /Presente su Google Calendar/);
    assert.ok(findButton(renderer, "Aggiorna su Google Calendar"));
  } finally { await act(async () => renderer.unmount()); }
});

// Test 31: ProfileModal senza batch, con card informativa e ICS invariato.
test("ProfileModal: batch outbound rimosso, card informativa presente, export ICS mantenuto", () => {
  const profileModal = readSource("src/components/ProfileModal.tsx");
  assert.doesNotMatch(profileModal, /onSyncAllToGoogle/);
  assert.doesNotMatch(profileModal, /Invia impegni selezionati a Google Calendar/);
  assert.doesNotMatch(profileModal, /Conferma e Sincronizza Ora/);
  assert.match(profileModal, /Gli impegni vengono inviati singolarmente dalla loro scheda\./);
  assert.match(profileModal, /Puoi scegliere il calendario Google di destinazione prima dell’invio\./);
  assert.match(profileModal, /downloadIcsCalendar\(events\)/);
  const app = readSource("src/App.tsx");
  assert.doesNotMatch(app, /onSyncAllToGoogle/);
});

// Test 33: inbound G1.x invariato (import multi-calendar, cooldown, read-only).
test("inbound G1.x invariato: import automatico e CalendarList inbound non toccati", () => {
  const app = readSource("src/App.tsx");
  assert.match(app, /importSelectedGoogleCalendars\(token, calendarIds\)/);
  assert.match(app, /GOOGLE_CALENDAR_AUTO_IMPORT_COOLDOWN_MS = 5 \* 60 \* 1000/);
  const importService = readSource("src/services/googleCalendarImportService.ts");
  assert.ok(!importService.includes("createGoogleCalendarEvent"), "l'import resta read-only verso Google");
  assert.ok(!importService.includes("updateGoogleCalendarEvent"));
});

// Sicurezza: scope minimi, nessun token persistito.
test("scope minimi per calendari scrivibili e nessuna persistenza di token", () => {
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/calendar.events"),
    "serve calendar.events per scrivere sui calendari condivisi writer");
  assert.ok(!SCOPES.includes("https://www.googleapis.com/auth/calendar"), "mai full access");
  assert.ok(!SCOPES.includes("https://www.googleapis.com/auth/calendar.events.owned"));
  const auth = readSource("src/services/googleAuth.ts");
  assert.match(auth, /NEVER in localStorage\/sessionStorage/);
});
