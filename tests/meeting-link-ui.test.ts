import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { database } from '../src/services/db';
import { initializeStorage, storage, emptyInstallation } from '../src/services/storage';
import { EventMeetingLink } from '../src/components/EventMeetingLink';
import { FutureCommitmentsView } from '../src/components/FutureCommitmentsView';
import { TodayView } from '../src/components/TodayView';
import { EventModal } from '../src/components/EventModal';
import type { CalendarEvent, TeacherProfile } from '../src/types';
import { localDateISO } from '../src/utils/dates';

/**
 * Partecipa (parti C e D): il link della videochiamata nelle viste.
 *
 * Regole verificate qui:
 *  - il pulsante c'è SOLO dove esiste un link (salvato o ricavato dal testo) e mai altrove;
 *  - è un link reale: target="_blank" + rel="noopener noreferrer", così la riunione si apre
 *    in una nuova scheda senza esporre l'app alla pagina aperta;
 *  - 44px di area di tocco, anche dentro una riga compatta;
 *  - le viste non riscrivono i dati: un link nel testo non genera alcun meetingUrl;
 *  - l'editor ha il campo modificabile e rifiuta un valore non https.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const MEET = 'https://meet.google.com/kkj-hfpn-dym';
const ZOOM = 'https://us02web.zoom.us/j/8765432101';

let memory: Map<string, string>;
beforeEach(async () => {
  memory = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return memory.size; },
      key: (i: number) => [...memory.keys()][i] ?? null,
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => { memory.set(k, String(v)); },
      removeItem: (k: string) => { memory.delete(k); },
    },
  });
  database.close();
  await database.delete();
  await initializeStorage();
});

const profile: TeacherProfile = {
  ...(emptyInstallation().profile as TeacherProfile),
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci', schoolYear: '2026/2027',
  primarySubjects: ['Matematica'], classes: ['2E'], campuses: ['Sede Centrale'], roles: [],
};

function event(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1', title: 'Consiglio di classe 2E', category: 'consiglio_classe', date: localDateISO(),
    startTime: '15:00', endTime: '16:00', isAllDay: false, sourceType: 'google_calendar', ...patch,
  } as CalendarEvent;
}

const meetingAnchors = (renderer: any) => renderer.root.findAll((node: any) => node.type === 'a' && Boolean(node.props['data-meeting-link']));

function textOf(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  // ReactTestRenderer → si parte dalla radice; TestInstance → .children è già risolto
  // (i nodi di testo arrivano come stringhe).
  const children = typeof node.toJSON === 'function' ? [node.root] : node.children ?? [];
  return children.map(textOf).join(' ');
}

// ---------------------------------------------------------------------------
// 1. Il pulsante, nel suo componente
// ---------------------------------------------------------------------------

test('EventMeetingLink: nessun link, nessun pulsante', async () => {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(EventMeetingLink, { event: event() })); });
  assert.deepEqual(renderer.toJSON(), null);
  assert.equal(renderer.root.findAll((node: any) => node.type === 'a').length, 0);

  await act(async () => { renderer = create(React.createElement(EventMeetingLink, { event: null })); });
  assert.deepEqual(renderer.toJSON(), null);
});

test('EventMeetingLink: <a> in nuova scheda, noopener noreferrer, 44px e icona video', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventMeetingLink, { event: event({ meetingUrl: MEET }), label: 'Consiglio di classe 2E' }));
  });
  const anchor = meetingAnchors(renderer)[0];
  assert.ok(anchor, "il pulsante Partecipa esiste");
  assert.equal(anchor.props.href, MEET);
  assert.equal(anchor.props.target, '_blank');
  assert.equal(anchor.props.rel, 'noopener noreferrer');
  assert.equal(anchor.props['data-meeting-link'], MEET);
  assert.match(textOf(renderer), /Partecipa/);
  assert.match(anchor.props['aria-label'], /Partecipa alla videochiamata — Consiglio di classe 2E/);
  assert.match(anchor.props['aria-label'], /si apre in una nuova scheda/);
  const classNames = String(anchor.props.className);
  assert.match(classNames, /min-h-\[44px\]/, 'area di tocco su mobile');
  assert.match(classNames, /min-w-\[44px\]/);
  assert.match(classNames, /whitespace-nowrap/, 'etichetta compatta su una riga');
  assert.ok(renderer.root.findAll((node: any) => node.type === 'svg').length >= 1, 'icona video (lucide svg)');
  // È un <a>, non un bottone con window.open: tasto centrale e "apri in nuovo tab" funzionano.
  assert.equal(renderer.root.findAll((node: any) => node.type === 'button').length, 0);
});

test('EventMeetingLink: link salvato e link scritto nel testo danno lo stesso pulsante', async () => {
  for (const source of [
    { meetingUrl: MEET },
    { location: `Aula Magna ${MEET}` },
    { notes: `Convocazione. Link: ${MEET}.` },
  ]) {
    let renderer: any;
    await act(async () => { renderer = create(React.createElement(EventMeetingLink, { event: event(source) })); });
    assert.equal(meetingAnchors(renderer)[0]?.props.href, MEET, JSON.stringify(source));
  }
});

test('una sola funzione di derivazione, usata da tutte le viste', () => {
  const component = readFileSync(resolve(here, '../src/components/EventMeetingLink.tsx'), 'utf8');
  assert.match(component, /getEventMeetingUrl\(event\)/, 'il componente non inventa regole proprie');
  assert.match(component, /import \{ getEventMeetingUrl[^}]*\} from "\.\.\/utils\/meetingLinks"/);

  for (const file of ['FutureCommitmentsView.tsx', 'TodayView.tsx', 'EventModal.tsx']) {
    const source = readFileSync(resolve(here, '../src/components', file), 'utf8');
    assert.match(source, /from "\.\/EventMeetingLink"/, `${file} riusa il componente`);
    assert.doesNotMatch(source, /window\.open\(/, `${file} non apre schede a mano`);
    // Nessuna vista re-implementa la ricerca del link nei testi liberi.
    assert.doesNotMatch(source, /matchAll|extractMeetingUrlFromText\(/, `${file} non re-implementa l'estrazione`);
  }
  // Le due viste di sola lettura non producono dati: chi scrive l'evento e solo l'editor.
  for (const file of ['FutureCommitmentsView.tsx', 'TodayView.tsx']) {
    const source = readFileSync(resolve(here, '../src/components', file), 'utf8');
    assert.doesNotMatch(source, /meetingUrl:/, `${file} non costruisce un meetingUrl`);
  }
  const util = readFileSync(resolve(here, '../src/utils/meetingLinks.ts'), 'utf8');
  assert.match(util, /export function getEventMeetingUrl/);
  assert.match(util, /export function extractMeetingUrlFromText/);
  assert.doesNotMatch(util, /saveEvent|localStorage|database/, 'la derivazione non tocca la persistenza');
});

// ---------------------------------------------------------------------------
// 2. Riga di "Note e impegni"
// ---------------------------------------------------------------------------

async function renderCommitments(events: CalendarEvent[]) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(FutureCommitmentsView, {
      events, scheduledAssessments: [], students: [], todayIso: localDateISO(), schoolYear: '2026/2027',
      onEditEvent: () => {}, onEditNote: () => {}, onToggleComplete: () => {},
    }));
  });
  return renderer;
}

test('Note e impegni: Partecipa accanto alla riga, mai dentro il pulsante della riga', async () => {
  const renderer = await renderCommitments([
    event({ id: 'meet', meetingUrl: MEET }),
    event({ id: 'text', meetingUrl: undefined, location: `Sala insegnanti, ${ZOOM}` }),
    event({ id: 'plain', title: 'Ritiro registro', location: 'Segreteria', notes: undefined }),
  ]);
  const anchors = meetingAnchors(renderer);
  assert.equal(anchors.length, 2, 'una riga con il campo, una con il link nel testo');
  assert.deepEqual(anchors.map(a => a.props['data-meeting-link']).sort(), [MEET, ZOOM]);
  for (const anchor of anchors) {
    assert.equal(anchor.props.target, '_blank');
    assert.equal(anchor.props.rel, 'noopener noreferrer');
    // <a> non annidato nel <button>: sarebbe HTML invalido e il tap aprirebbe anche l'editor.
    let parent = anchor.parent;
    while (parent) {
      assert.notEqual(parent.type, 'button', 'il link non può stare dentro la riga tappabile');
      parent = parent.parent;
    }
  }

  const row = renderer.root.findByProps({ 'data-commitment-id': 'event:meet' });
  assert.equal(typeof row.props.onClick, 'function', "la riga resta tappabile per aprire l'impegno");
  assert.match(String(row.parent.props.className), /flex items-start gap-2/);
  assert.equal(row.parent.findAll((node: any) => node.type === 'a').length, 1, 'fratello della riga');
});

test('Note e impegni: nessun link, nessun pulsante', async () => {
  const renderer = await renderCommitments([event({ id: 'plain', title: 'Ritiro registro', location: 'Segreteria' })]);
  assert.equal(meetingAnchors(renderer).length, 0);
  assert.match(textOf(renderer), /Ritiro registro/);
});

test('Note e impegni: la vista non aggiunge meetingUrl ai dati che legge', async () => {
  const source = event({ id: 'text', location: `Aula, ${ZOOM}` });
  const before = structuredClone(source);
  await renderCommitments([source]);
  assert.deepEqual(source, before, "l'oggetto dell'impegno non viene toccato");
  assert.equal('meetingUrl' in source, false);
});

// ---------------------------------------------------------------------------
// 3. Vista Oggi
// ---------------------------------------------------------------------------

async function renderToday(events: CalendarEvent[]) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TodayView, {
      profile,
      timetable: [],
      events,
      isProvisionalTimetable: true,
      isDefinitiveCompiled: false,
      initialDateIso: localDateISO(),
      onOpenNewEvent: () => {},
      onOpenCircularModal: () => {},
      onEditEvent: () => {},
      onDeleteEvent: () => {},
      onToggleComplete: () => {},
    }));
  });
  return renderer;
}

test("Oggi: la card dell'impegno ha Partecipa con gli attributi giusti", async () => {
  const renderer = await renderToday([
    event({ id: 'meet', meetingUrl: MEET }),
    event({ id: 'plain', title: 'Ritiro registro', location: 'Segreteria' }),
  ]);
  const anchors = meetingAnchors(renderer);
  assert.equal(anchors.length, 1, "solo l'impegno con il link");
  assert.equal(anchors[0].props.href, MEET);
  assert.equal(anchors[0].props.target, '_blank');
  assert.equal(anchors[0].props.rel, 'noopener noreferrer');
  assert.match(String(anchors[0].props.className), /min-h-\[44px\]/);
  assert.match(textOf(renderer), /Consiglio di classe 2E/);
});

test('Oggi: un link di conferenza scritto nelle note diventa un pulsante', async () => {
  const renderer = await renderToday([event({ id: 'notes', title: 'Collegio docenti', notes: `Connessione da casa: ${ZOOM}` })]);
  const anchors = meetingAnchors(renderer);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].props.href, ZOOM);
});

// ---------------------------------------------------------------------------
// 4. Scheda / editor dell'impegno
// ---------------------------------------------------------------------------

async function renderModal(patch: Record<string, unknown> = {}) {
  const saved: CalendarEvent[] = [];
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true,
      onClose: () => {},
      eventToEdit: null,
      profile,
      onSave: (next: CalendarEvent) => { saved.push(next); },
      isGoogleConnected: false,
      ...patch,
    }));
  });
  return { renderer, saved };
}

const meetingInput = (renderer: any) => renderer.root.findAll((node: any) => node.type === 'input' && node.props.id === 'event-meeting-url')[0];
/** Il form possiede onSubmit; il bottone Salva è un `type="submit"` senza handler proprio. */
const submitForm = async (renderer: any) => {
  const form = renderer.root.findByType('form');
  await act(async () => { form.props.onSubmit({ preventDefault: () => {} }); });
};

test('editor: campo Link videochiamata modificabile, precompilato, con Partecipa', async () => {
  const { renderer } = await renderModal({ eventToEdit: event({ meetingUrl: MEET }) });
  const labels = renderer.root.findAll((node: any) => node.type === 'label' && textOf(node).includes('Link videochiamata'));
  assert.equal(labels.length, 1);
  assert.equal(labels[0].props.htmlFor, 'event-meeting-url');

  const input = meetingInput(renderer);
  assert.ok(input, 'input dedicato al link');
  assert.equal(input.props.value, MEET);
  assert.equal(input.props.type, 'text', "validazione dell'app, non tooltip nativo del browser");
  assert.equal(input.props.inputMode, 'url');
  assert.equal(input.props.autoCapitalize, 'none');
  assert.equal(input.props.autoCorrect, 'off');
  assert.match(String(input.props.className), /min-h-\[44px\]/);

  const anchors = meetingAnchors(renderer);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].props.href, MEET);
  assert.equal(anchors[0].props.target, '_blank');
  assert.equal(anchors[0].props.rel, 'noopener noreferrer');
});

test('editor: il link digitato appare subito nel pulsante senza salvare nulla', async () => {
  const { renderer, saved } = await renderModal();
  assert.equal(meetingAnchors(renderer).length, 0, 'nessun pulsante su un impegno nuovo');
  await act(async () => { meetingInput(renderer).props.onChange({ target: { value: ZOOM } }); });
  assert.equal(meetingAnchors(renderer)[0].props.href, ZOOM);
  assert.equal(saved.length, 0, 'nessuna scrittura solo per mostrare il link');

  // Un link presente solo nel luogo viene mostrato, ma il campo resta vuoto.
  const fromText = await renderModal({ eventToEdit: event({ meetingUrl: undefined, location: `Aula, ${MEET}` }) });
  assert.equal(meetingAnchors(fromText.renderer)[0].props.href, MEET);
  assert.equal(meetingInput(fromText.renderer).props.value, '', 'il testo non viene copiato nel campo');
});

test('editor: il salvataggio normalizza https e la cancellazione rimuove il link', async () => {
  // initialEventData porta un titolo: la validazione blocca il link solo se il resto e gia' valido.
  const typed = await renderModal({ initialEventData: { title: 'Collegio docenti', date: localDateISO(), startTime: '15:00', endTime: '16:00' } });
  await act(async () => { meetingInput(typed.renderer).props.onChange({ target: { value: `  ${MEET}  ` } }); });
  await submitForm(typed.renderer);
  assert.equal(typed.saved.length, 1);
  assert.equal(typed.saved[0].meetingUrl, MEET, 'il valore viene normalizzato al salvataggio');
  assert.equal(typed.saved[0].title, 'Collegio docenti', 'il resto del form non cambia');

  // Cancellare il campo rimuove davvero il link: niente vecchio valore ereditato.
  const cleared = await renderModal({ eventToEdit: event({ meetingUrl: MEET }) });
  await act(async () => { meetingInput(cleared.renderer).props.onChange({ target: { value: '' } }); });
  await submitForm(cleared.renderer);
  assert.equal(cleared.saved.length, 1);
  assert.equal(cleared.saved[0].meetingUrl, undefined);
});

test("editor: un link non https è un errore, e non viene salvato", async () => {
  for (const bad of ['http://meet.google.com/abc', 'meet.google.com/abc', 'javascript:alert(1)', 'https://']) {
    const { renderer, saved } = await renderModal({ initialEventData: { title: 'Collegio docenti', date: localDateISO(), startTime: '15:00', endTime: '16:00' } });
    await act(async () => { meetingInput(renderer).props.onChange({ target: { value: bad } }); });
    await submitForm(renderer);
    assert.equal(saved.length, 0, `nessun salvataggio con "${bad}"`);
    assert.match(textOf(renderer), /deve iniziare con https:\/\//);
    assert.equal(meetingAnchors(renderer).length, 0, 'non appare nemmeno il pulsante');
  }
});

// ---------------------------------------------------------------------------
// 5. Persistenza: le viste leggono cio che e salvato
// ---------------------------------------------------------------------------

test("dopo il salvataggio il link è in archivio e la riga lo rilegge", async () => {
  await storage.saveEvents([event({ id: 'meet', meetingUrl: MEET })]);
  const stored = await storage.getEvents();
  assert.equal(stored[0].meetingUrl, MEET);
  const renderer = await renderCommitments(stored);
  assert.equal(meetingAnchors(renderer)[0].props.href, MEET);
});
