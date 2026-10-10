import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { database } from '../src/services/db';
import { initializeStorage, emptyInstallation } from '../src/services/storage';
import { TodayView } from '../src/components/TodayView';
import { FutureCommitmentsView } from '../src/components/FutureCommitmentsView';
import { EventModal } from '../src/components/EventModal';
import { EventMergeModal } from '../src/components/EventMergeModal';
import { EventMergeContext } from '../src/components/GoogleMergeControls';
import { findPossibleDuplicates } from '../src/utils/googleCalendarMerge';
import type { CalendarEvent, TeacherProfile } from '../src/types';
import { localDateISO } from '../src/utils/dates';

/**
 * Etichetta "Google Calendar", avviso "Possibile doppione · Unisci", anteprima e voce di
 * unione nella modifica, più il motivo di pertinenza nascosto in Oggi.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let memory = new Map<string, string>();

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
  primarySubjects: ['Matematica'], classes: ['3D'], campuses: ['Sede Centrale'], roles: [],
};

const TODAY = localDateISO();
const MEET = 'https://meet.google.com/abc-defg-hij';

function event(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'ev-1',
    title: 'Riunione staff',
    category: 'personale',
    date: TODAY,
    startTime: '10:00',
    endTime: '11:00',
    isAllDay: false,
    sourceType: 'manuale',
    completed: false,
    ...patch,
  } as CalendarEvent;
}

const importedEvent = (patch: Partial<CalendarEvent> = {}) => event({
  id: 'gcal-primary-g1', title: 'Zoom con preside', sourceType: 'google_calendar', googleEventId: 'g1',
  googleCalendarId: 'primary', syncedWithGoogle: false, ...patch,
});

/** Accetta sia un renderer (radice) sia un'istanza già trovata. */
function findAll(renderer: any, predicate: (node: any) => boolean): any[] {
  return (renderer.root ?? renderer).findAll(predicate);
}

function textOf(renderer: any): string {
  return JSON.stringify(renderer.toJSON());
}

async function renderToday(events: CalendarEvent[], requestMerge: (a: CalendarEvent, b: CalendarEvent) => void = () => {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventMergeContext.Provider, { value: requestMerge },
      React.createElement(TodayView, {
        profile, timetable: [], events, isProvisionalTimetable: true, isDefinitiveCompiled: false,
        initialDateIso: TODAY, onOpenNewEvent: () => {}, onOpenCircularModal: () => {},
        onEditEvent: () => {}, onDeleteEvent: () => {}, onToggleComplete: () => {},
      })));
  });
  return renderer;
}

async function renderCommitments(events: CalendarEvent[], requestMerge: (a: CalendarEvent, b: CalendarEvent) => void = () => {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventMergeContext.Provider, { value: requestMerge },
      React.createElement(FutureCommitmentsView, {
        events, scheduledAssessments: [], students: [], todayIso: TODAY, schoolYear: '2026/2027',
        onEditEvent: () => {}, onEditNote: () => {}, onToggleComplete: () => {},
      })));
  });
  return renderer;
}

test('Oggi: etichetta Google Calendar su impegno importato e su impegno unito (entrambe)', async () => {
  const renderer = await renderToday([
    importedEvent({ id: 'gcal-only', title: 'Ricevimento docenti' }),
    event({ id: 'merged', title: 'Consiglio classe', sourceType: 'circolare', sourceCircularTitle: 'Circolare 9',
      googleEventId: 'g2', googleCalendarId: 'primary', meetingUrl: MEET, category: 'consiglio_classe' }),
    event({ id: 'plain', title: 'Nessun collegamento' }),
  ]);
  const labels = findAll(renderer, node => node.props['data-google-calendar-label'] !== undefined);
  assert.equal(labels.length, 2, 'importato + unito, non il manuale');
  const merged = textOf(renderer);
  assert.ok(merged.includes('Da Circolare'), 'l’unito conserva "Da Circolare"');
  assert.ok(merged.includes('Google Calendar'));
});

test('Oggi: coppia per orario sovrapposto mostra l’avviso su entrambe le schede, Unisci passa (Google, app)', async () => {
  const calls: [CalendarEvent, CalendarEvent][] = [];
  const app = event({ id: 'app-1', title: 'Colloquio con i genitori', startTime: '10:30', endTime: '11:30' });
  const google = importedEvent({ id: 'gcal-1', title: 'Zoom con preside', startTime: '10:00', endTime: '11:00' });
  const renderer = await renderToday([app, google], (a, b) => calls.push([a, b]));

  const notices = findAll(renderer, node => node.props['data-possible-duplicate'] !== undefined && node.type === 'div');
  assert.equal(notices.length, 2, 'avviso sulle due schede');
  assert.ok(textOf(renderer).includes('Possibile doppione'));

  // Ogni avviso appartiene a una card: il pulsante "Unisci" di quella card deve passare la coppia.
  const unisci = findAll(notices[0], node => node.type === 'button' && node.props.children === 'Unisci')[0];
  assert.ok(unisci, 'pulsante Unisci presente');
  let stopped = false;
  const clickEvent = { preventDefault: () => {}, stopPropagation: () => { stopped = true; } };
  await act(async () => { unisci.props.onClick(clickEvent); });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map(item => item.id).sort(), [app.id, google.id].sort(), 'coppia corretta');
  assert.equal(stopped, true, 'il click non deve aprire anche la scheda in cui si trova l’avviso');
});

test('Oggi: lezioni, scadenze e impegni tutto il giorno non mostrano avvisi di doppione', async () => {
  const google = importedEvent({ title: 'Consiglio classe 3D', startTime: '10:00', endTime: '11:00' });
  const lesson = event({ id: 'lez', sourceType: 'orario', category: 'lezione', title: 'Consiglio classe 3D' });
  const deadline = event({ id: 'dl', category: 'scadenza', deadlineDate: TODAY, title: 'Consiglio classe 3D' });
  const allDay = event({ id: 'ad', isAllDay: true, startTime: undefined, endTime: undefined, title: 'Consiglio classe 3D' });
  for (const other of [lesson, deadline, allDay]) {
    const renderer = await renderToday([other, google]);
    assert.equal(findAll(renderer, node => node.props['data-possible-duplicate'] !== undefined).length, 0, other.id);
  }
});

test('Oggi: il motivo di pertinenza di una circolare non compare nei dettagli; una nota scritta sì', async () => {
  const relevance = 'Destinato a un altro ordine scolastico.';
  const renderer = await renderToday([
    event({ id: 'circ', sourceType: 'circolare', sourceCircularTitle: 'C1', notes: relevance, title: 'Assemblea' }),
    event({ id: 'note', sourceType: 'manuale', notes: 'Portare la delega firmata', title: 'Uscita' }),
  ]);
  const text = textOf(renderer);
  assert.equal(text.includes(relevance), false, 'motivo di pertinenza nascosto');
  assert.ok(text.includes('Portare la delega firmata'), 'nota utente visibile');
});

test('Note e impegni: Google Calendar su importato, Circolare + Google su unito, avviso di doppione fuori dalla riga', async () => {
  const calls: [CalendarEvent, CalendarEvent][] = [];
  const merged = event({ id: 'm1', title: 'Consiglio classe 3D', sourceType: 'circolare', sourceCircularTitle: 'C2',
    googleEventId: 'g7', googleCalendarId: 'primary', startTime: '09:00', endTime: '10:00', category: 'consiglio_classe' });
  const imported = importedEvent({ id: 'gcal-x', title: 'Visita ispettiva', startTime: '12:00', endTime: '13:00' });
  const renderer = await renderCommitments([merged, imported], (a, b) => calls.push([a, b]));
  const text = textOf(renderer);
  assert.ok(text.includes('Google Calendar'));
  assert.ok(text.includes('Circolare'), 'origine circolare ancora mostrata');
  const labels = findAll(renderer, node => node.props['data-commitment-google-label'] !== undefined);
  assert.equal(labels.length, 1, 'l’unito mostra l’etichetta Google accanto a Circolare; l’importato usa la sua origine');

  // Nessun doppione con questa coppia (orari diversi, titoli diversi): nessun avviso.
  assert.equal(findAll(renderer, node => node.props['data-possible-duplicate'] !== undefined).length, 0);

  const overlapping = importedEvent({ id: 'gcal-y', title: 'Riunione con genitori', startTime: '09:30', endTime: '10:30' });
  const second = await renderCommitments([event({ id: 'a2', title: 'Colloquio', startTime: '09:00', endTime: '10:00' }), overlapping], (a, b) => calls.push([a, b]));
  const notices = findAll(second, node => node.props['data-possible-duplicate'] !== undefined);
  assert.equal(notices.length, 2);
  // L'avviso è un fratello della riga: non sta dentro il <button> della riga.
  for (const notice of notices) {
    const insideButton = findAll(second, node => node.type === 'button' && node.findAll(child => child === notice).length > 0);
    assert.equal(insideButton.length, 0, 'avviso non annidato in un pulsante');
  }
});

test('Anteprima: scelte solo per campi pieni e diversi; uguali e vuoti non compaiono', async () => {
  const base = event({ id: 'b', title: 'Consiglio classe 3D', sourceType: 'circolare', sourceCircularTitle: 'C3', sourceCircularId: 'circ-3',
    category: 'consiglio_classe', className: '3D', location: 'Aula 2', startTime: '15:00', endTime: '16:00', notes: 'Portare il verbale' });
  // categoria "glo" reale: il default "personale" dell'import Google non genera scelta
  const other = importedEvent({ id: 'gcal-z', title: 'Consiglio straordinario', category: 'glo',
    startTime: '15:00', endTime: '16:00', location: 'Aula 2', notes: 'Portare il registro', meetingUrl: MEET });
  let confirmed: CalendarEvent | null = null;
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventMergeModal, {
      base, other, categoryLabel: (c: string) => c,
      onCancel: () => {}, onConfirm: (merged: CalendarEvent) => { confirmed = merged; },
    }));
  });
  const fieldNames = findAll(renderer, node => node.props['data-merge-field'] !== undefined).map(node => node.props['data-merge-field']);
  assert.deepEqual(fieldNames.sort(), ['category', 'notes', 'title'], 'solo titolo, categoria e note sono scelte');
  assert.equal(findAll(renderer, node => node.props['data-merge-field'] === 'location').length, 0, 'luogo uguale: nessuna scelta');
  assert.equal(findAll(renderer, node => node.props['data-merge-field'] === 'meetingUrl').length, 0, 'link vuoto nella base: non è una scelta');

  // Tieni entrambe sulle note, poi conferma.
  const option = findAll(renderer, node => node.props['data-merge-option'] === 'both')[0];
  assert.ok(option, '"Tieni entrambe" solo per le note');
  await act(async () => { option.props.onClick(); });
  const confirm = findAll(renderer, node => node.type === 'button' && node.props.children === 'Conferma unione')[0];
  await act(async () => { confirm.props.onClick(); });
  assert.ok(confirmed);
  const merged = confirmed as unknown as CalendarEvent;
  assert.equal(merged.id, 'b');
  assert.equal(merged.sourceType, 'circolare');
  assert.equal(merged.sourceCircularId, 'circ-3');
  assert.equal(merged.notes, 'Portare il verbale\nPortare il registro');
  assert.equal(merged.meetingUrl, MEET);
  assert.equal(merged.className, '3D');
  assert.equal(merged.googleEventId, 'g1');
  assert.equal(merged.category, 'consiglio_classe');
});

test('Anteprima: categoria Google "personale" non genera scelta e il risultato prende quella della circolare', async () => {
  const base = event({ id: 'b', title: 'Consiglio classe 3D', sourceType: 'circolare', sourceCircularTitle: 'C4', sourceCircularId: 'circ-4',
    category: 'consiglio_classe', className: '3D', startTime: '15:00', endTime: '16:00' });
  const other = importedEvent({ id: 'gcal-p', title: 'Consiglio classe 3D', category: 'personale', startTime: '15:00', endTime: '16:00' });
  let confirmed: CalendarEvent | null = null;
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventMergeModal, {
      base, other, categoryLabel: (c: string) => c,
      onCancel: () => {}, onConfirm: (merged: CalendarEvent) => { confirmed = merged; },
    }));
  });
  assert.equal(findAll(renderer, node => node.props['data-merge-field'] === 'category').length, 0, 'nessuna scelta di categoria');
  assert.equal(findAll(renderer, node => node.props['data-merge-field'] !== undefined).length, 0, 'nessuna scelta in tutto: restano solo i campi uguali o da un solo lato');
  const confirm = findAll(renderer, node => node.type === 'button' && node.props.children === 'Conferma unione')[0];
  await act(async () => { confirm.props.onClick(); });
  assert.ok(confirmed);
  assert.equal((confirmed as CalendarEvent).category, 'consiglio_classe', 'categoria della circolare');
  assert.equal((confirmed as CalendarEvent).sourceType, 'circolare');
});

test('Modifica: "Unisci con un altro impegno dello stesso giorno" elenca il giorno e passa la scelta', async () => {
  const editing = event({ id: 'manual-1', title: 'Consiglio straordinario', startTime: '14:00', endTime: '15:00' });
  const sameDay = importedEvent({ id: 'gcal-d', title: 'Zoom con preside', startTime: '14:00', endTime: '15:00' });
  const otherDay = importedEvent({ id: 'gcal-e', title: 'Altro giorno', date: '2099-01-01' });
  const calls: [CalendarEvent, CalendarEvent][] = [];
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventMergeContext.Provider, { value: (a: CalendarEvent, b: CalendarEvent) => calls.push([a, b]) },
      React.createElement(EventModal, {
        isOpen: true, onClose: () => {}, eventToEdit: editing, profile,
        onSave: () => {}, isGoogleConnected: false, sameDayEvents: [sameDay, otherDay],
      })));
  });
  const entry = findAll(renderer, node => node.props['data-merge-section'] !== undefined && node.type === 'div')[0];
  assert.ok(entry, 'sezione di unione presente in modifica');
  assert.ok(textOf(renderer).includes('Unisci con un altro impegno dello stesso giorno'));
  const open = findAll(renderer, node => node.type === 'button' && node.props.children === 'Unisci con un altro impegno dello stesso giorno')[0];
  await act(async () => { open.props.onClick(); });
  const candidates = findAll(renderer, node => node.props['data-merge-candidate'] !== undefined);
  assert.deepEqual(candidates.map(node => node.props['data-merge-candidate']), ['gcal-d'], 'solo impegni dello stesso giorno');
  await act(async () => { candidates[0].props.onClick(); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].id, 'manual-1');
  assert.equal(calls[0][1].id, 'gcal-d');
});

test('Modifica: senza impegni nello stesso giorno l’elenco dice che non c’è nulla da unire', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true, onClose: () => {}, eventToEdit: event({ id: 'solo' }), profile,
      onSave: () => {}, isGoogleConnected: false, sameDayEvents: [],
    }));
  });
  const open = findAll(renderer, node => node.type === 'button' && node.props.children === 'Unisci con un altro impegno dello stesso giorno')[0];
  await act(async () => { open.props.onClick(); });
  assert.ok(textOf(renderer).includes('Nessun altro impegno da unire in questo giorno.'));
});

test('Settimana e Mese: etichetta Google Calendar su importato e su unito, avviso di doppione', async () => {
  const { WeekView } = await import('../src/components/WeekView');
  const { MonthView } = await import('../src/components/MonthView');
  const WEEKDAY = '2026-10-13'; // martedì: la Settimana non mostra il sabato
  const merged = event({ id: 'wm', date: WEEKDAY, title: 'Consiglio classe', sourceType: 'circolare', sourceCircularTitle: 'C5',
    googleEventId: 'g9', googleCalendarId: 'primary', startTime: '10:00', endTime: '11:00', category: 'consiglio_classe' });
  const imported = importedEvent({ id: 'gw', date: WEEKDAY, title: 'Zoom con preside', startTime: '10:30', endTime: '11:30' });
  // Un impegno dell'app SENZA collegamento Google: è lui il doppione possibile dell'importato.
  const plainApp = event({ id: 'wa', date: WEEKDAY, title: 'Colloquio genitori', startTime: '10:00', endTime: '11:00' });
  const calls: [CalendarEvent, CalendarEvent][] = [];
  let week: any;
  let month: any;
  await act(async () => {
    week = create(React.createElement(EventMergeContext.Provider, { value: (a: CalendarEvent, b: CalendarEvent) => calls.push([a, b]) },
      React.createElement(WeekView, {
        profile, timetable: [], events: [merged, imported, plainApp], onOpenNewEvent: () => {}, onEditEvent: () => {},
        onDeleteEvent: () => {}, targetDateIso: WEEKDAY,
      })));
  });
  assert.equal(findAll(week, node => node.props['data-google-calendar-label'] !== undefined).length, 2, 'settimana: unito + importato');
  assert.ok(textOf(week).includes('Da Circolare'), 'settimana: origine circolare dell’unito');
  assert.equal(findAll(week, node => node.props['data-possible-duplicate'] !== undefined).length, 2, 'settimana: avviso su importato e doppione dell’app, non sull’unito');

  await act(async () => {
    month = create(React.createElement(EventMergeContext.Provider, { value: (a: CalendarEvent, b: CalendarEvent) => calls.push([a, b]) },
      React.createElement(MonthView, {
        events: [merged, imported, plainApp], onOpenNewEvent: () => {}, onEditEvent: () => {}, onDeleteEvent: () => {},
        targetDateIso: WEEKDAY,
      })));
  });
  assert.ok(textOf(month).includes('Google Calendar'), 'mese: etichetta Google');
  assert.equal(findAll(month, node => node.props['data-possible-duplicate'] !== undefined).length, 2, 'mese: avviso su importato e doppione dell’app');
});

test('Oggi e Note e impegni: coppia affine (orari contigui + orario nel titolo) avvisa su entrambe le schede', async () => {
  const app = event({
    id: 'aff-app', title: 'Consiglio di Classe 1C, 1N', sourceType: 'circolare', sourceCircularTitle: 'Circolare 7',
    category: 'consiglio_classe', className: '1C, 1N', location: 'Telematica', startTime: '16:30', endTime: '17:15',
  });
  const google = importedEvent({
    id: 'aff-gcal', title: 'Consiglio 1 C del 13 Ottobre ore 16:30/17:15',
    startTime: '15:30', endTime: '16:30', meetingUrl: MEET,
  });

  for (const render of [renderToday, renderCommitments]) {
    const calls: [CalendarEvent, CalendarEvent][] = [];
    const renderer = await render([app, google], (a, b) => calls.push([a, b]));
    const notices = findAll(renderer, node => node.props['data-possible-duplicate'] !== undefined && node.type === 'div');
    assert.equal(notices.length, 2, 'avviso sulle due schede');
    assert.ok(textOf(renderer).includes('Possibile doppione'));

    const unisci = findAll(notices[0], node => node.type === 'button' && node.props.children === 'Unisci')[0];
    assert.ok(unisci, 'il suggerimento offre la scelta, non fonde nulla');
    await act(async () => { unisci.props.onClick({ preventDefault: () => {}, stopPropagation: () => {} }); });
    assert.deepEqual(calls.map(pair => pair.map(item => item.id).sort())[0], [app.id, google.id].sort());
    await act(async () => { renderer.unmount(); });
  }

  // Nessun impegno modificato da solo: la coppia resta separata finché non si conferma.
  assert.equal(findPossibleDuplicates([app, google]).size, 2);
  assert.equal(app.startTime, '16:30');
  assert.equal(google.startTime, '15:30');
});
