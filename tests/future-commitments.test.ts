import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { create, act } from 'react-test-renderer';
import {
  deriveFutureCommitments,
  derivePastCommitments,
  deriveArchiveCommitments,
  groupFutureCommitments,
  civilWeekMonday,
  futureCommitmentGroupFor,
} from '../src/utils/futureCommitments';
import { FutureCommitmentsView } from '../src/components/FutureCommitmentsView';
import { MOBILE_NAV_ITEMS } from '../src/components/MobileNav';
import type { CalendarEvent, Student, StudentScheduledAssessment } from '../src/types';
import { addDaysISO } from '../src/utils/dates';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(here, '../src/App.tsx'), 'utf8');
const navbarSource = readFileSync(resolve(here, '../src/components/Navbar.tsx'), 'utf8');
const viewSource = readFileSync(resolve(here, '../src/components/FutureCommitmentsView.tsx'), 'utf8');
const utilSource = readFileSync(resolve(here, '../src/utils/futureCommitments.ts'), 'utf8');

// Mercoledì 2026-04-15 come "oggi" di riferimento (settimana lun 13 → dom 19).
const TODAY = '2026-04-15';

function event(partial: Partial<CalendarEvent> & { id: string; date: string }): CalendarEvent {
  return {
    title: 'Impegno',
    category: 'riunione',
    isAllDay: false,
    sourceType: 'manuale',
    ...partial,
  } as CalendarEvent;
}

const students: Student[] = [
  { id: 'stu-1', fullName: 'Mario Rossi', className: '3E', notes: [] } as unknown as Student,
];

function assessment(partial: Partial<StudentScheduledAssessment> & { id: string; date: string }): StudentScheduledAssessment {
  return {
    studentId: 'stu-1',
    assessmentType: 'written',
    status: 'scheduled',
    ...partial,
  } as StudentScheduledAssessment;
}

function derive(events: CalendarEvent[], assessments: StudentScheduledAssessment[] = []) {
  return deriveFutureCommitments({ events, scheduledAssessments: assessments, students, todayIso: TODAY });
}

function derivePast(events: CalendarEvent[], assessments: StudentScheduledAssessment[] = []) {
  return derivePastCommitments({ events, scheduledAssessments: assessments, students, todayIso: TODAY });
}

function groupOf(items: ReturnType<typeof derive>, id: string) {
  return groupFutureCommitments(items, TODAY).find(group => group.id === id);
}

// --- 1..5: raggruppamento -------------------------------------------------

test('evento di oggi finisce nel gruppo Oggi', () => {
  const items = derive([event({ id: 'a', date: TODAY, title: 'Consiglio di classe 2E', startTime: '15:00' })]);
  assert.deepEqual(groupOf(items, 'oggi')!.items.map(i => i.title), ['Consiglio di classe 2E']);
});

test('evento di domani finisce nel gruppo Domani', () => {
  const items = derive([event({ id: 'a', date: addDaysISO(TODAY, 1) })]);
  assert.equal(groupOf(items, 'domani')!.items.length, 1);
  assert.equal(groupOf(items, 'oggi'), undefined);
});

test('evento successivo nella stessa settimana civile finisce in Questa settimana', () => {
  const items = derive([event({ id: 'a', date: '2026-04-17' })]); // venerdì
  assert.equal(groupOf(items, 'questa-settimana')!.items.length, 1);
});

test('evento della settimana successiva finisce in Prossima settimana', () => {
  const items = derive([event({ id: 'a', date: '2026-04-21' })]); // martedì dopo
  assert.equal(groupOf(items, 'prossima-settimana')!.items.length, 1);
});

test('evento oltre la settimana successiva finisce in Più avanti', () => {
  const items = derive([event({ id: 'a', date: '2026-05-10' })]);
  assert.equal(groupOf(items, 'piu-avanti')!.items.length, 1);
});

// --- 6..8: esclusioni ------------------------------------------------------

test('evento passato escluso', () => {
  assert.equal(derive([event({ id: 'a', date: addDaysISO(TODAY, -1) })]).length, 0);
});

test('evento completato escluso', () => {
  assert.equal(derive([event({ id: 'a', date: TODAY, completed: true })]).length, 0);
});

test('solo sourceType orario esclude la lezione ordinaria', () => {
  const items = derive([
    event({ id: 'l1', date: TODAY, category: 'lezione', sourceType: 'orario', title: 'Matematica 3E' }),
    event({ id: 'l2', date: TODAY, sourceType: 'orario', category: 'promemoria', title: 'Italiano 2D' }),
  ]);
  assert.equal(items.length, 0);
});

test('attività circolare classificata lezione compare negli impegni', () => {
  const items = derive([event({ id: 'prisma', date: '2026-11-26', category: 'lezione', sourceType: 'circolare', title: 'Svolgimento Giochi Matematici di Prisma', isAllDay: true })]);
  assert.equal(items.length, 1);
});

// --- 9..12: provenienze ----------------------------------------------------

test('evento da circolare compare una sola volta con badge Circolare', () => {
  const items = derive([
    event({ id: 'c1', date: TODAY, sourceType: 'circolare', sourceCircularId: 'circ-1', sourceItemId: 'it-1', title: 'Consegna PEI' }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'circolare');
});

test('assessment scheduled futuro presente con provenienza verifica', () => {
  const items = derive([], [assessment({ id: 'as-1', date: addDaysISO(TODAY, 1), subject: 'Storia' })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'verifica');
  assert.equal(items[0].kind, 'scheduled-assessment');
  assert.equal(items[0].assessmentId, 'as-1');
  assert.match(items[0].title, /Mario Rossi/);
});

test('assessment completed escluso', () => {
  assert.equal(derive([], [assessment({ id: 'as-1', date: addDaysISO(TODAY, 1), status: 'completed' as any })]).length, 0);
});

test('assessment cancelled escluso', () => {
  assert.equal(derive([], [assessment({ id: 'as-1', date: addDaysISO(TODAY, 1), status: 'cancelled' as any })]).length, 0);
});

test('assessment passato escluso', () => {
  assert.equal(derive([], [assessment({ id: 'as-1', date: addDaysISO(TODAY, -3) })]).length, 0);
});

// --- 13..16: ordinamento, confini, identità --------------------------------

test('ordinamento stabile per data, ora e titolo', () => {
  const items = derive([
    event({ id: 'd', date: '2026-04-16', startTime: '09:00', title: 'B' }),
    event({ id: 'c', date: TODAY, startTime: '15:00', title: 'Z' }),
    event({ id: 'b', date: TODAY, startTime: '15:00', title: 'A' }),
    event({ id: 'a', date: TODAY, isAllDay: true, title: 'Tutto il giorno' }),
  ]);
  assert.deepEqual(items.map(i => i.id), ['event:a', 'event:b', 'event:c', 'event:d']);
});

test('confini settimana civile lunedì → domenica', () => {
  assert.equal(civilWeekMonday('2026-04-19'), '2026-04-13'); // domenica → lunedì 13
  assert.equal(civilWeekMonday('2026-04-20'), '2026-04-20'); // lunedì
  assert.equal(futureCommitmentGroupFor('2026-04-19', TODAY), 'questa-settimana');
  assert.equal(futureCommitmentGroupFor('2026-04-20', TODAY), 'prossima-settimana');
  assert.equal(futureCommitmentGroupFor('2026-04-26', TODAY), 'prossima-settimana'); // domenica
  assert.equal(futureCommitmentGroupFor('2026-04-27', TODAY), 'piu-avanti');
});

test('domenica come oggi: lunedì seguente è Domani e non Prossima settimana', () => {
  assert.equal(futureCommitmentGroupFor('2026-04-20', '2026-04-19'), 'domani');
  assert.equal(futureCommitmentGroupFor('2026-04-22', '2026-04-19'), 'prossima-settimana');
});

test('civil date senza regressioni timezone (mezzanotte e cambio mese)', () => {
  const items = derive([event({ id: 'a', date: '2026-04-30', startTime: '00:00' }), event({ id: 'b', date: '2026-05-01' })]);
  assert.deepEqual(items.map(i => i.date), ['2026-04-30', '2026-05-01']);
  assert.ok(!/toISOString|Date\.UTC|getUTC/.test(utilSource), 'la utility non deve usare parsing UTC');
});

test('lo stesso CalendarEvent non viene duplicato', () => {
  const single = event({ id: 'dup', date: TODAY, title: 'Collegio docenti' });
  const items = derive([single, single]);
  assert.equal(items.length, 1);
  assert.equal(items[0].originalEvent, single);
});

// --- 17: nessuna persistenza ----------------------------------------------

test('nessuna nuova scrittura DB: derivazione pura senza import di storage', () => {
  assert.ok(!/from "\.\.\/services/.test(utilSource));
  assert.ok(!/from "\.\.\/services/.test(viewSource));
  assert.ok(!/db\.|indexedDB|saveEvent/.test(utilSource));
  const input = [event({ id: 'a', date: TODAY, title: 'X' })];
  const snapshot = JSON.stringify(input);
  derive(input);
  assert.equal(JSON.stringify(input), snapshot, 'gli eventi di ingresso non devono essere mutati');
});

// --- 18..20: navigazione e non-regressione ---------------------------------

test('la view è raggiungibile da desktop (Navbar) e montata in App', () => {
  assert.match(navbarSource, /id: "impegni", label: "Note e impegni"/);
  assert.match(appSource, /currentView === "impegni"/);
  assert.match(appSource, /<FutureCommitmentsView/);
});

test('la view è raggiungibile da mobile', () => {
  // "Impegni" vive ora direttamente nella barra inferiore (non più nel foglio
  // "Altro"): etichetta breve in barra, nome completo nell'aria-label.
  assert.ok(MOBILE_NAV_ITEMS.some(item => item.id === 'impegni' && item.fullLabel === 'Note e impegni'));
});

test('nessuna regressione: Oggi/Settimana/Mese/Scadenze restano montate', () => {
  for (const view of ['oggi', 'settimana', 'mese', 'scadenze']) {
    assert.match(appSource, new RegExp(`currentView === "${view}"`));
  }
});

test('render: gruppi e badge visibili, titolo Note e impegni', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(FutureCommitmentsView, {
        events: [
          event({ id: 'a', date: TODAY, startTime: '15:00', title: 'Consiglio di classe 2E', location: 'Aula riunioni' }),
          event({ id: 'past', date: addDaysISO(TODAY, -2), title: 'Vecchio' }),
          event({ id: 'lez', date: TODAY, category: 'lezione', sourceType: 'orario', title: 'Matematica 3E' }),
        ],
        scheduledAssessments: [assessment({ id: 'as-1', date: addDaysISO(TODAY, 1) })],
        students,
        todayIso: TODAY,
      }),
    );
  });
  const json = JSON.stringify(renderer.toJSON());
  assert.match(json, /Note e impegni/);
  assert.match(json, /Consiglio di classe 2E/);
  assert.match(json, /Verifica/);
  assert.ok(!json.includes('Matematica 3E'));
  assert.ok(!json.includes('Vecchio'));
  const groups = renderer.root.findAll((el: any) => typeof el.props?.['data-commitment-group'] === 'string');
  assert.deepEqual(groups.map((g: any) => g.props['data-commitment-group']), ['oggi', 'domani']);
  await act(async () => renderer.unmount());
});

test('click su CalendarEvent riusa EventModal esistente (nessuna seconda UI)', async () => {
  const target = event({ id: 'a', date: TODAY, startTime: '09:00', title: 'GLO 2E' });
  const opened: CalendarEvent[] = [];
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(FutureCommitmentsView, {
        events: [target],
        scheduledAssessments: [],
        students,
        todayIso: TODAY,
        onEditEvent: (e: CalendarEvent) => opened.push(e),
      }),
    );
  });
  const row = renderer.root.findAll((el: any) => el.props?.['data-commitment-id'] === 'event:a')[0];
  await act(async () => row.props.onClick());
  assert.deepEqual(opened, [target]);
  await act(async () => renderer.unmount());
});

// --- N1.1: storico a scomparsa --------------------------------------------

test('storico include ieri ma esclude oggi e futuro', () => {
  const items = derivePast([
    event({ id: 'yesterday', date: addDaysISO(TODAY, -1) }),
    event({ id: 'today', date: TODAY }),
    event({ id: 'future', date: addDaysISO(TODAY, 1) }),
  ]);
  assert.deepEqual(items.map(item => item.id), ['event:yesterday']);
});

test('storico include CalendarEvent passati sia completati sia non completati', () => {
  const items = derivePast([
    event({ id: 'done', date: addDaysISO(TODAY, -1), completed: true }),
    event({ id: 'open', date: addDaysISO(TODAY, -2), completed: false }),
  ]);
  assert.deepEqual(items.map(item => item.id), ['event:done', 'event:open']);
});

test('storico esclude solo gli eventi con sourceType orario', () => {
  const items = derivePast([
    event({ id: 'lesson', date: addDaysISO(TODAY, -1), category: 'lezione' }),
    event({ id: 'timetable', date: addDaysISO(TODAY, -1), sourceType: 'orario' }),
    event({ id: 'meeting', date: addDaysISO(TODAY, -1), category: 'riunione' }),
  ]);
  assert.deepEqual(items.map(item => item.id), ['event:lesson', 'event:meeting']);
});

test('storico mantiene una sola circolare e i badge Circolare, Google e Registro', () => {
  const circular = event({ id: 'circular', date: addDaysISO(TODAY, -1), sourceType: 'circolare' });
  const items = derivePast([
    circular,
    circular,
    event({ id: 'google', date: addDaysISO(TODAY, -2), sourceType: 'google_calendar' }),
    event({ id: 'register', date: addDaysISO(TODAY, -3), sourceType: 'registro' }),
  ]);
  assert.deepEqual(items.map(item => [item.id, item.source]), [
    ['event:circular', 'circolare'],
    ['event:google', 'google'],
    ['event:register', 'registro'],
  ]);
});

test('storico verifiche include scheduled e completed passate ma esclude cancelled', () => {
  const items = derivePast([], [
    assessment({ id: 'scheduled', date: addDaysISO(TODAY, -1), status: 'scheduled' }),
    assessment({ id: 'completed', date: addDaysISO(TODAY, -2), status: 'completed' }),
    assessment({ id: 'cancelled', date: addDaysISO(TODAY, -3), status: 'cancelled' }),
    assessment({ id: 'today', date: TODAY, status: 'scheduled' }),
  ]);
  assert.deepEqual(items.map(item => item.id), ['assessment:scheduled', 'assessment:completed']);
  assert.ok(items.every(item => item.kind === 'scheduled-assessment' && item.source === 'verifica'));
});

test('storico è ordinato dal più recente al più vecchio e deterministicamente nello stesso giorno', () => {
  const yesterday = addDaysISO(TODAY, -1);
  const items = derivePast([
    event({ id: 'old', date: addDaysISO(TODAY, -4), startTime: '18:00', title: 'Vecchio' }),
    event({ id: 'late-b', date: yesterday, startTime: '15:00', title: 'B' }),
    event({ id: 'late-z', date: yesterday, startTime: '15:00', title: 'A' }),
    event({ id: 'late-a', date: yesterday, startTime: '15:00', title: 'A' }),
    event({ id: 'early', date: yesterday, startTime: '09:00', title: 'A' }),
  ]);
  assert.deepEqual(items.map(item => item.id), [
    'event:late-a',
    'event:late-z',
    'event:late-b',
    'event:early',
    'event:old',
  ]);
});

test('derivePastCommitments non muta gli array di input e non introduce persistenza', () => {
  const events = [event({ id: 'b', date: addDaysISO(TODAY, -2) }), event({ id: 'a', date: addDaysISO(TODAY, -1) })];
  const assessments = [assessment({ id: 'as', date: addDaysISO(TODAY, -3), status: 'completed' })];
  const before = JSON.stringify({ events, assessments, students });
  derivePastCommitments({ events, scheduledAssessments: assessments, students, todayIso: TODAY });
  assert.equal(JSON.stringify({ events, assessments, students }), before);
  assert.ok(!/db\.|indexedDB|saveEvent|CircularDocument|extractedItems/.test(utilSource));
});

test('deriveFutureCommitments conserva il contratto N1', () => {
  const items = derive([
    event({ id: 'past', date: addDaysISO(TODAY, -1) }),
    event({ id: 'today', date: TODAY }),
    event({ id: 'done', date: addDaysISO(TODAY, 1), completed: true }),
    event({ id: 'lesson', date: addDaysISO(TODAY, 1), category: 'lezione', sourceType: 'orario' }),
    event({ id: 'future', date: addDaysISO(TODAY, 2) }),
  ], [
    assessment({ id: 'scheduled-future', date: addDaysISO(TODAY, 1), status: 'scheduled' }),
    assessment({ id: 'completed-future', date: addDaysISO(TODAY, 1), status: 'completed' }),
    assessment({ id: 'scheduled-past', date: addDaysISO(TODAY, -1), status: 'scheduled' }),
  ]);
  assert.deepEqual(items.map(item => item.id), [
    'event:today',
    'assessment:scheduled-future',
    'event:future',
  ]);
});

test('pannello storico è chiuso di default e il click lo apre e lo richiude', async () => {
  const pastTitle = 'Collegio docenti passato';
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(FutureCommitmentsView, {
        events: [event({ id: 'past', date: addDaysISO(TODAY, -1), title: pastTitle })],
        scheduledAssessments: [],
        students,
        todayIso: TODAY,
      }),
    );
  });

  let toggle = renderer.root.findByProps({ 'data-past-commitments-toggle': true });
  assert.equal(toggle.props['aria-expanded'], false);
  assert.ok(!JSON.stringify(renderer.toJSON()).includes(pastTitle));
  assert.equal(renderer.root.findAllByProps({ 'data-past-commitments-list': true }).length, 0);

  await act(async () => toggle.props.onClick());
  toggle = renderer.root.findByProps({ 'data-past-commitments-toggle': true });
  assert.equal(toggle.props['aria-expanded'], true);
  assert.ok(JSON.stringify(renderer.toJSON()).includes(pastTitle));
  assert.equal(renderer.root.findAllByProps({ 'data-past-commitments-list': true }).length, 1);

  await act(async () => toggle.props.onClick());
  assert.equal(renderer.root.findByProps({ 'data-past-commitments-toggle': true }).props['aria-expanded'], false);
  assert.ok(!JSON.stringify(renderer.toJSON()).includes(pastTitle));
  await act(async () => renderer.unmount());
});

test('gruppo storico non viene mostrato quando è vuoto', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(FutureCommitmentsView, {
        events: [event({ id: 'today', date: TODAY })],
        scheduledAssessments: [],
        students,
        todayIso: TODAY,
      }),
    );
  });
  assert.equal(renderer.root.findAllByProps({ 'data-past-commitments': true }).length, 0);
  assert.ok(!JSON.stringify(renderer.toJSON()).includes('Note e impegni passati'));
  await act(async () => renderer.unmount());
});

test('click su CalendarEvent storico riusa onEditEvent; le verifiche restano read-only', async () => {
  const target = event({ id: 'past', date: addDaysISO(TODAY, -1), title: 'Ultimo collegio' });
  const opened: CalendarEvent[] = [];
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(FutureCommitmentsView, {
        events: [target],
        scheduledAssessments: [assessment({ id: 'past-assessment', date: addDaysISO(TODAY, -2), status: 'completed' })],
        students,
        todayIso: TODAY,
        onEditEvent: (item: CalendarEvent) => opened.push(item),
      }),
    );
  });
  await act(async () => renderer.root.findByProps({ 'data-past-commitments-toggle': true }).props.onClick());
  const eventRow = renderer.root.findByProps({ 'data-commitment-id': 'event:past' });
  const assessmentRow = renderer.root.findByProps({ 'data-commitment-id': 'assessment:past-assessment' });
  await act(async () => eventRow.props.onClick());
  assert.deepEqual(opened, [target]);
  assert.equal(assessmentRow.props.onClick, undefined);
  await act(async () => renderer.unmount());
});

test('contratto Note e impegni ed Archivio: preserva quick note completed, circolare futura, esclusione orario ed eventi passati', () => {
  const quickNoteCompleted: CalendarEvent = {
    id: 'qn-completed',
    title: 'Nota rapida completata',
    category: 'promemoria',
    date: addDaysISO(TODAY, 2),
    isAllDay: true,
    sourceType: 'manuale',
    completed: true,
  };

  const circularFutureActive: CalendarEvent = {
    id: 'circ-active',
    title: 'Circolare futura attiva',
    category: 'promemoria',
    date: addDaysISO(TODAY, 3),
    isAllDay: true,
    sourceType: 'circolare',
    completed: false,
  };

  const lessonOrario: CalendarEvent = {
    id: 'lesson-orario',
    title: 'Lezione orario ordinaria',
    category: 'lezione',
    date: addDaysISO(TODAY, 1),
    isAllDay: false,
    sourceType: 'orario',
  };

  const pastEvent: CalendarEvent = {
    id: 'past-event',
    title: 'Evento passato',
    category: 'riunione',
    date: addDaysISO(TODAY, -2),
    isAllDay: false,
    sourceType: 'manuale',
  };

  const allEvents = [quickNoteCompleted, circularFutureActive, lessonOrario, pastEvent];

  // 1. deriveFutureCommitments (Note e impegni futuri)
  const futureItems = deriveFutureCommitments({
    events: allEvents,
    scheduledAssessments: [],
    students,
    todayIso: TODAY,
  });

  // Solo l'evento circolare futuro completed:false deve comparire
  assert.deepEqual(futureItems.map(i => i.id), ['event:circ-active']);

  // 2. deriveArchiveCommitments (Archivio)
  const archiveItems = deriveArchiveCommitments({
    events: allEvents,
    scheduledAssessments: [],
    students,
    todayIso: TODAY,
  });

  // Include la quick note completata futura e l'evento passato; esclude la lezione orario e l'evento circolare futuro non passato
  const archiveIds = archiveItems.map(i => i.id);
  assert.ok(archiveIds.includes('event:qn-completed'), 'Quick note completata futura inclusa in Archivio');
  assert.ok(archiveIds.includes('event:past-event'), 'Evento passato incluso in Archivio');
  assert.ok(!archiveIds.includes('event:lesson-orario'), 'Evento sourceType orario escluso da Archivio');
  assert.ok(!archiveIds.includes('event:circ-active'), 'Evento circolare futuro non completato escluso da Archivio');
});
