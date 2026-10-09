import test from 'node:test';
import assert from 'node:assert/strict';
import {
  googleEventMeetingUrl,
  googleEventToCalendarEvent,
  mergeGoogleCalendarEvents,
  mergeGoogleCalendarGroups,
} from '../src/utils/googleCalendarImport';
import {
  createGoogleCalendarEvent,
  downloadIcsCalendar,
  getGoogleCalendarWebUrl,
  listCalendarEvents,
  toGoogleCalendarPayload,
  updateGoogleCalendarEvent,
  type GoogleCalendarApiEvent,
} from '../src/services/googleCalendarService';
import { importGoogleCalendarEvents, importSelectedGoogleCalendars } from '../src/services/googleCalendarImportService';
import { validateBackup } from '../src/services/backup';
import { emptyInstallation } from '../src/services/storage';
import type { CalendarEvent } from '../src/types';

/**
 * Link della videochiamata da Google Calendar (parte B) e verso Google (parte E).
 *
 * Entrata: `hangoutLink` e la fonte primaria, `conferenceData.entryPoints[type=video]`
 * il ripiego. Uscita: il link salvato finisce nella DESCRIZIONE come testo — l'app non
 * crea e non collega alcuna conference, quindi nessuna videoconferenza viene generata.
 */

const MEET = 'https://meet.google.com/kkj-hfpn-dym';
const ZOOM = 'https://us02web.zoom.us/j/8765432101?pwd=Zm9vYmFy';
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread/0';

const timed = (id: string, overrides: Partial<GoogleCalendarApiEvent> = {}): GoogleCalendarApiEvent => ({
  id,
  summary: 'Consiglio di classe 2E',
  description: 'Ordine del giorno',
  location: 'Aula Magna',
  start: { dateTime: '2026-01-15T12:30:00Z' },
  end: { dateTime: '2026-01-15T13:45:00Z' },
  ...overrides,
});

const video = (uri: string): GoogleCalendarApiEvent['conferenceData'] => ({ entryPoints: [{ entryPointType: 'video', uri }] });

// ---------------------------------------------------------------------------
// B1. Ricavare il link dalla risorsa Event di Google
// ---------------------------------------------------------------------------

test("import: hangoutLink diventa il meetingUrl dell'impegno importato", () => {
  const mapped = googleEventToCalendarEvent(timed('meet-1', { hangoutLink: MEET }));
  assert.equal(mapped.meetingUrl, MEET);
  assert.equal(mapped.title, 'Consiglio di classe 2E');
  assert.equal(mapped.sourceType, 'google_calendar');
  // Il link non sostituisce nulla: luogo e note restano quelli di Google.
  assert.equal(mapped.location, 'Aula Magna');
  assert.equal(mapped.notes, 'Ordine del giorno');
  // Un impegno con videoconferenza resta un evento valido per tutto il resto del sistema.
  assert.doesNotThrow(() => validateBackup({ version: 3, ...emptyInstallation(), events: [mapped] }));
});

test('import: conferenceData, preso il primo entryPoint di tipo video', () => {
  const mapped = googleEventToCalendarEvent(timed('zoom-1', {
    conferenceData: {
      conferenceId: 'zoom-1',
      entryPoints: [
        { entryPointType: 'phone', uri: 'tel:+39021234' },
        { entryPointType: 'sip', uri: 'sip:meet@zoom.us' },
        { entryPointType: 'video', uri: ZOOM },
        { entryPointType: 'video', uri: MEET },
      ],
    },
  }));
  assert.equal(mapped.meetingUrl, ZOOM, 'primo entryPoint video, gli altri ignorati');

  assert.equal(googleEventMeetingUrl(timed('x', { conferenceData: { entryPoints: [{ entryPointType: 'more', uri: ZOOM }] } })), undefined);
  assert.equal(googleEventMeetingUrl(timed('x', { conferenceData: { entryPoints: [{ entryPointType: 'video' }] } })), undefined);
  assert.equal(googleEventMeetingUrl(timed('x', { conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'http://zoom.us/j/1' }] } })), undefined, 'http non accettato');
  assert.equal(googleEventMeetingUrl(timed('x', { conferenceData: { entryPoints: [] } })), undefined);
  assert.equal(googleEventMeetingUrl(timed('x', { conferenceData: {} })), undefined);
  assert.equal(googleEventMeetingUrl(timed('x', { conferenceData: undefined })), undefined);
  // Risposte meno ordinate non fanno esplodere la conversione.
  assert.equal(googleEventMeetingUrl(timed('x', { conferenceData: { entryPoints: null as never } })), undefined);
  assert.equal(googleEventMeetingUrl(timed('x', { conferenceData: { entryPoints: [null as never, { entryPointType: 'video', uri: ZOOM }] } })), ZOOM);
});

test('import: hangoutLink ha priorita sugli entryPoint e i link falsi cadono', () => {
  assert.equal(googleEventMeetingUrl(timed('both', { hangoutLink: MEET, conferenceData: video(ZOOM) })), MEET);
  // Un hangoutLink non https non viene salvato e non blocca il ripiego sugli entryPoint.
  assert.equal(googleEventMeetingUrl(timed('weak', { hangoutLink: `http:${MEET.slice(5)}`, conferenceData: video(ZOOM) })), ZOOM);
  for (const junk of [undefined, '', '   ', 'meet.google.com/abc', 'https://', 'javascript:alert(1)', 42, {}]) {
    assert.equal(googleEventMeetingUrl(timed('junk', { hangoutLink: junk as never })), undefined, String(junk));
  }
});

test('import: senza videoconferenza la chiave meetingUrl non esiste nemmeno', () => {
  const mapped = googleEventToCalendarEvent(timed('plain'));
  assert.equal(mapped.meetingUrl, undefined);
  assert.equal('meetingUrl' in mapped, false, 'nessuna chiave vuota su un impegno senza link');
  // Anche un all-day senza link resta identico alla conversione precedente.
  const allDay = googleEventToCalendarEvent({ id: 'all', start: { date: '2026-05-02' }, end: { date: '2026-05-04' }, hangoutLink: MEET });
  assert.equal(allDay.isAllDay, true);
  assert.equal(allDay.meetingUrl, MEET, 'un link ha senso anche su un evento tutto il giorno');
});

// ---------------------------------------------------------------------------
// B2. La richiesta non deve restringere i campi restituiti
// ---------------------------------------------------------------------------

test('fetch eventi: nessun fields=, cosi hangoutLink e conferenceData arrivano', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ items: [timed('meet-1', { hangoutLink: MEET }), timed('zoom-1', { conferenceData: video(ZOOM) })] }), { status: 200 });
  }) as typeof fetch;
  try {
    const events = await listCalendarEvents('token', '2026-09-01T00:00:00Z', '2027-08-31T23:59:59Z');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /singleEvents=true/);
    assert.ok(!/[?&]fields=/.test(urls[0]), `la richiesta non deve limitare i campi: ${urls[0]}`);
    // Gli oggetti passano integri alla conversione: il link sopravvive al fetch.
    assert.equal(googleEventToCalendarEvent(events[0]).meetingUrl, MEET);
    assert.equal(googleEventToCalendarEvent(events[1]).meetingUrl, ZOOM);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// B3. Riconciliazione: limpegno gia importato riceve il link
// ---------------------------------------------------------------------------

test('merge G1: un impegno gia importato riceve il link anche se nulla altro cambia', () => {
  const before = googleEventToCalendarEvent(timed('same'));
  assert.equal('meetingUrl' in before, false);

  // Nessuna novita remota: nessun link inventato e nessun doppione.
  const same = mergeGoogleCalendarEvents([before], [timed('same')]);
  assert.equal(same.added, 0);
  assert.equal(same.events.length, 1);
  assert.equal('meetingUrl' in same.events[0], false);
  assert.equal(same.events[0].title, before.title);

  // Google aggiunge Meet a una riunione gia pianificata: tutti gli altri campi sono uguali.
  const withLink = mergeGoogleCalendarEvents([before], [timed('same', { hangoutLink: MEET })]);
  assert.equal(withLink.updated, 1);
  assert.equal(withLink.added, 0);
  assert.equal(withLink.events.length, 1);
  assert.equal(withLink.events[0].meetingUrl, MEET);
  assert.equal(withLink.events[0].id, before.id, 'l identita locale e preservata');
  assert.equal(withLink.events[0].updatedAt, before.updatedAt, 'un refresh non e una modifica dell utente');

  // Un link rimosso lato Google non cancella il valore locale.
  const linkGone = mergeGoogleCalendarEvents(withLink.events, [timed('same')]);
  assert.equal(linkGone.events[0].meetingUrl, MEET);
});

test('merge multi-calendario: il link arriva anche su un calendario condiviso', () => {
  const local = googleEventToCalendarEvent(timed('shared'), 'scuola@gmail.com');
  assert.equal('meetingUrl' in local, false);
  const merged = mergeGoogleCalendarGroups([local], [{
    calendarId: 'scuola@gmail.com',
    events: [timed('shared', { conferenceData: video(TEAMS) })],
  }]);
  assert.equal(merged.updated, 1);
  assert.equal(merged.added, 0);
  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0].meetingUrl, TEAMS);
  assert.equal(merged.events[0].googleCalendarId, 'scuola@gmail.com');
});

test('merge multi-calendario: un impegno dell Agenda collegato a Google non viene toccato', () => {
  const agendaEvent: CalendarEvent = {
    id: 'ev-1', title: 'Riunione mia', category: 'riunione', date: '2026-01-15', startTime: '13:30', endTime: '14:45',
    isAllDay: false, sourceType: 'manuale', googleEventId: 'shared', googleCalendarId: 'primary',
    syncedWithGoogle: true, meetingUrl: ZOOM,
  };
  const merged = mergeGoogleCalendarGroups([agendaEvent], [{
    calendarId: 'primary', isPrimary: true, events: [timed('shared', { hangoutLink: MEET, summary: 'Titolo remoto' })],
  }]);
  assert.equal(merged.linked, 1);
  assert.deepEqual(merged.events[0], agendaEvent, 'ne il titolo ne il link vengono sovrascritti');
});

// ---------------------------------------------------------------------------
// B4. Il flusso reale di importazione persiste il link
// ---------------------------------------------------------------------------

function importHarness(initial: CalendarEvent[]) {
  let state = initial;
  let writes = 0;
  return {
    writes: () => writes,
    state: () => state,
    dependencies: (remote: GoogleCalendarApiEvent[]) => ({
      list: async () => Object.assign([...remote], { partial: false, pagesRead: 1 }),
      read: async () => state,
      write: async (events: CalendarEvent[]) => { writes++; state = events; },
      atomic: async <T,>(operation: () => Promise<T>): Promise<T> => operation(),
      now: new Date(2026, 9, 1, 12),
      schoolYear: '2026/2027',
    }),
  };
}

test('workflow G1: il link di un impegno gia scaricato viene scritto al refresh successivo', async () => {
  const harness = importHarness([]);
  const first = await importGoogleCalendarEvents('token', harness.dependencies([timed('meet-1')]));
  assert.equal(first.added, 1);
  assert.equal('meetingUrl' in harness.state()[0], false);

  const second = await importGoogleCalendarEvents('token', harness.dependencies([timed('meet-1', { hangoutLink: MEET })]));
  assert.equal(second.added, 0, 'nessun duplicato');
  assert.equal(second.updated, 1);
  assert.equal(harness.state().length, 1);
  assert.equal(harness.state()[0].meetingUrl, MEET, 'il link arriva nell archivio locale');

  const third = await importGoogleCalendarEvents('token', harness.dependencies([timed('meet-1', { hangoutLink: MEET })]));
  assert.equal(third.added, 0);
  assert.equal(harness.state().length, 1);
  assert.equal(harness.state()[0].meetingUrl, MEET);
  assert.equal(harness.writes(), 3, 'una scrittura per ciclo, come prima');
});

test('workflow multi-calendario: conferenceData arriva salvato e il backup resta valido', async () => {
  const harness = importHarness([]);
  const result = await importSelectedGoogleCalendars('token', ['primary'], harness.dependencies([timed('zoom-1', { conferenceData: video(ZOOM) })]));
  assert.equal(result.added, 1);
  assert.equal(harness.state()[0].meetingUrl, ZOOM);
  assert.doesNotThrow(() => validateBackup({ version: 3, ...emptyInstallation(), events: harness.state() }));
});

// ---------------------------------------------------------------------------
// E. Invio verso Google: link nella descrizione, nessuna conference creata
// ---------------------------------------------------------------------------

const agendaEvent = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'ev-1', title: 'Collegio docenti', category: 'collegio_docenti', date: '2026-09-01',
  startTime: '15:00', endTime: '17:00', isAllDay: false, sourceType: 'manuale', ...patch,
}) as CalendarEvent;

test('payload in uscita: meetingUrl nella descrizione, conferenceData assente', () => {
  const payload = toGoogleCalendarPayload(agendaEvent({ meetingUrl: MEET }));
  assert.match(payload.description!, new RegExp(`Videoconferenza: ${MEET}`));
  assert.equal('conferenceData' in payload, false, 'nessuna videoconferenza creata su Google');
  assert.equal(payload.summary, 'Collegio docenti');
  assert.equal(payload.location, undefined);

  // Un impegno senza link ha la descrizione di sempre.
  assert.equal(toGoogleCalendarPayload(agendaEvent()).description, 'Agenda Docente - COLLEGIO DOCENTI');
  // Un link non https (dato manomesso o legacy) non viene spedito.
  assert.equal(toGoogleCalendarPayload(agendaEvent({ meetingUrl: 'http://meet.google.com/abc' })).description, 'Agenda Docente - COLLEGIO DOCENTI');
});

test('payload in uscita: la riga del link precede classe, materia e note', () => {
  const payload = toGoogleCalendarPayload(agendaEvent({ meetingUrl: ZOOM, className: '2E', subject: 'Matematica', notes: 'Portare il registro' }));
  assert.deepEqual(payload.description!.split('\n'), [
    'Agenda Docente - COLLEGIO DOCENTI',
    `Videoconferenza: ${ZOOM}`,
    'Classe: 2E',
    'Materia: Matematica',
    'Note: Portare il registro',
  ]);
});

test('POST e PATCH verso Google portano il link nel body, mai una createRequest', async () => {
  const original = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ id: 'created-1' }), { status: 200 });
  }) as typeof fetch;
  try {
    const event = agendaEvent({ meetingUrl: TEAMS });
    assert.equal(await createGoogleCalendarEvent('token', event), 'created-1');
    await updateGoogleCalendarEvent('token', 'created-1', event);
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.match(body, /Videoconferenza: https:\/\/teams\.microsoft\.com/);
      assert.ok(!/createRequest/.test(body), 'mai chiedere a Google di creare una conference');
      assert.ok(!/hangoutLink/.test(body), 'hangoutLink e un campo di sola lettura');
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('scorciatoie di esportazione: URL web e .ics riportano il link', async () => {
  assert.ok(getGoogleCalendarWebUrl(agendaEvent({ meetingUrl: MEET }))
    .includes(`details=${encodeURIComponent(`Videoconferenza: ${MEET}`)}`));
  assert.equal(getGoogleCalendarWebUrl(agendaEvent()).includes('Videoconferenza'), false);

  let captured: Blob | undefined;
  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  URL.createObjectURL = (blob: Blob) => { captured = blob; return 'blob:test'; };
  URL.revokeObjectURL = () => {};
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } } });
  try {
    downloadIcsCalendar([agendaEvent({ meetingUrl: MEET })]);
    const ics = await captured!.text();
    assert.match(ics, /DESCRIPTION:Categoria: collegio_docenti\\nVideoconferenza: https:\/\/meet\.google\.com\/kkj-hfpn-dym/);
    assert.ok(!/^URL:/m.test(ics), 'nessuna proprieta URL: il link resta testo descrittivo');
  } finally {
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else delete (globalThis as any).document;
  }
});
