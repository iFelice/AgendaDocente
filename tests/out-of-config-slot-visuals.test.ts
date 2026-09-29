import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act, type ReactTestInstance } from 'react-test-renderer';
import { TodayView } from '../src/components/TodayView';
import { WeekView } from '../src/components/WeekView';
import { TimetableEditor } from '../src/components/TimetableEditor';
import {
  isSlotOutOfConfiguredDay,
  OUT_OF_CONFIG_SLOT_BADGE,
  OUT_OF_CONFIG_SLOT_TITLE,
} from '../src/utils/schoolDayPeriods';
import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/*
 * COERENZA VISIVA DELLE LEZIONI FUORI CONFIGURAZIONE (micro-passo D2).
 *
 * C2 marcava in griglia le lezioni salvate in un'ora che il giorno non prevede,
 * ma Oggi e Settimana le mostravano identiche a tutte le altre. Qui si verifica
 * che le tre viste raccontino la stessa cosa con le stesse parole, senza che
 * nulla venga filtrato, spostato o reso non modificabile.
 *
 * Confine sorvegliato: "fuori configurazione" dipende SOLO da dayPeriods. Una
 * lezione la cui fascia oraria non e piu configurata NON viene marcata cosi:
 * e un caso diverso, descritto dalla colonna Campana della griglia.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

/** Scuola con 6 ore ordinarie e 7 il giovedi. */
const profileThursday7: TeacherProfile = {
  ...baseProfile,
  schools: [{
    id: 's1', name: 'IC Leonardo Da Vinci', isPrimary: true, active: true,
    dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
  }],
};

const slotsFor = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    periodNumber: i + 1,
    label: `${i + 1}ª Ora`,
    startTime: `${String(8 + i).padStart(2, '0')}:00`,
    endTime: `${String(9 + i).padStart(2, '0')}:00`,
  }));

const config = (count: number): TimeSlotConfig => ({
  firstHourStartTime: '08:00', periodsPerDay: count, standardDurationMinutes: 60,
  customSlots: slotsFor(count),
});

/** Lunedi 2026-09-14 (la settimana di riferimento dei test Planning). */
const MONDAY_ISO = '2026-09-14';

const lessonMon6: TimetableSlot = {
  id: 'tt-mon-6', dayOfWeek: 1, periodNumber: 6, startTime: '13:00', endTime: '14:00',
  subject: 'Matematica', className: '1A',
};
/** Lunedi 7ª: il lunedi ne ammette 6 -> fuori configurazione. */
const lessonMon7: TimetableSlot = {
  id: 'tt-mon-7', dayOfWeek: 1, periodNumber: 7, startTime: '14:00', endTime: '15:00',
  subject: 'Storia', className: '2E',
};

function nodeText(node: any): string {
  const parts: string[] = [];
  const walk = (n: any) => {
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return; }
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.children)) n.children.forEach(walk);
    else if (typeof n.children === 'string' || typeof n.children === 'number') parts.push(String(n.children));
  };
  walk(node);
  return parts.join(' ');
}
const flatText = (node: any) => nodeText(node).replace(/\s+/g, ' ').trim();

/** Marcature "fuori configurazione" presenti nell'albero. */
const marks = (renderer: any): ReactTestInstance[] =>
  renderer.root.findAll((el: any) => el.props?.['data-slot-out-of-config'] === 'true');

/** Card lezione (button con data-slot-cell="lesson"). */
const lessonCards = (renderer: any): ReactTestInstance[] =>
  renderer.root.findAll((el: any) => el.props?.['data-slot-cell'] === 'lesson');

// ---------------------------------------------------------------------------
// Predicato condiviso
// ---------------------------------------------------------------------------

test('il predicato guarda dayPeriods, non le fasce configurate', () => {
  const school = { dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } } };
  assert.equal(isSlotOutOfConfiguredDay({ dayOfWeek: 1, periodNumber: 7 }, school, config(7)), true);
  assert.equal(isSlotOutOfConfiguredDay({ dayOfWeek: 4, periodNumber: 7 }, school, config(7)), false);
  // Fascia mancante ma giorno che la ammette: NON e "fuori configurazione".
  assert.equal(isSlotOutOfConfiguredDay({ dayOfWeek: 4, periodNumber: 7 }, school, config(6)), false);
});

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function todayProps(overrides: Record<string, unknown> = {}) {
  return {
    profile: profileThursday7,
    timeSlotConfig: config(7),
    timetable: [lessonMon6, lessonMon7] as TimetableSlot[],
    events: [],
    scheduledAssessments: [],
    isProvisionalTimetable: false,
    isDefinitiveCompiled: true,
    timetableType: 'definitivo' as const,
    onOpenTimetableSlotForEdit: () => {},
    initialDateIso: MONDAY_ISO,
    onOpenNewEvent: () => {},
    onOpenCircularModal: () => {},
    onEditEvent: () => {},
    onDeleteEvent: () => {},
    onToggleComplete: () => {},
    ...overrides,
  };
}

async function renderToday(overrides: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(TodayView, todayProps(overrides) as any)); });
  return renderer;
}

test('Today: la lezione Lun/7 e visibile, marcata e ancora apribile', async () => {
  const opened: TimetableSlot[] = [];
  const renderer = await renderToday({
    onOpenTimetableSlotForEdit: (slot: TimetableSlot) => { opened.push(slot); },
  });

  const text = flatText(renderer.root);
  assert.ok(text.includes('Storia'), 'la lezione resta visibile');
  assert.ok(text.includes('Matematica'), 'anche quella valida');

  const marked = marks(renderer);
  assert.equal(marked.length, 1, 'una sola marcatura: solo la 7ª');
  assert.equal(marked[0].props.title, OUT_OF_CONFIG_SLOT_TITLE);
  assert.ok(text.includes(OUT_OF_CONFIG_SLOT_BADGE), 'etichetta visibile');

  // Due card, entrambe cliccabili: la marcatura non blocca nulla.
  const cards = lessonCards(renderer);
  assert.equal(cards.length, 2);
  const outCard = cards.find((c: any) => flatText(c).includes('Storia'))!;
  assert.equal(outCard.props.title, OUT_OF_CONFIG_SLOT_TITLE);
  assert.match(String(outCard.props.className), /amber/);
  await act(async () => { outCard.props.onClick(); });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].id, 'tt-mon-7', 'apre esattamente lo slot legacy');
  await act(async () => { renderer.unmount(); });
});

test('Today: una lezione valida (Lun/6) non viene marcata', async () => {
  const renderer = await renderToday({ timetable: [lessonMon6] });
  assert.equal(marks(renderer).length, 0);
  assert.equal(flatText(renderer.root).includes(OUT_OF_CONFIG_SLOT_BADGE), false);
  await act(async () => { renderer.unmount(); });
});

test('Today: senza dayPeriods e con slot entro le fasce, nessuna marcatura', async () => {
  const renderer = await renderToday({
    profile: baseProfile,
    timeSlotConfig: config(6),
    timetable: [lessonMon6],
  });
  assert.equal(marks(renderer).length, 0, 'comportamento pre-C2 invariato');
  await act(async () => { renderer.unmount(); });
});

test('Today: senza timeSlotConfig la vista non cambia comportamento', async () => {
  const renderer = await renderToday({ profile: baseProfile, timeSlotConfig: undefined, timetable: [lessonMon6] });
  assert.equal(marks(renderer).length, 0);
  assert.ok(flatText(renderer.root).includes('Matematica'));
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// Week
// ---------------------------------------------------------------------------

function weekProps(overrides: Record<string, unknown> = {}) {
  return {
    profile: profileThursday7,
    timeSlotConfig: config(7),
    timetable: [lessonMon6, lessonMon7] as TimetableSlot[],
    events: [],
    isProvisionalTimetable: false,
    timetableType: 'definitivo' as const,
    onOpenTimetableSlotForEdit: () => {},
    onOpenNewEvent: () => {},
    onEditEvent: () => {},
    targetDateIso: MONDAY_ISO,
    ...overrides,
  };
}

async function renderWeek(overrides: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(WeekView, weekProps(overrides) as any)); });
  return renderer;
}

test('Week: la lezione Lun/7 resta nella colonna, marcata e apribile', async () => {
  const opened: TimetableSlot[] = [];
  const renderer = await renderWeek({
    onOpenTimetableSlotForEdit: (slot: TimetableSlot) => { opened.push(slot); },
  });

  const text = flatText(renderer.root);
  assert.ok(text.includes('Storia'));
  assert.ok(text.includes(OUT_OF_CONFIG_SLOT_BADGE));

  const marked = marks(renderer);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].props.title, OUT_OF_CONFIG_SLOT_TITLE);

  const cards = lessonCards(renderer);
  const outCard = cards.find((c: any) => flatText(c).includes('Storia'))!;
  assert.ok(outCard, 'la card esiste ancora');
  assert.match(String(outCard.props.className), /amber/);
  await act(async () => { outCard.props.onClick(); });
  assert.equal(opened[0].id, 'tt-mon-7');

  // Ordinamento invariato: la 6ª resta prima della 7ª nella stessa colonna.
  const order = cards.map((c: any) => flatText(c));
  const iMate = order.findIndex(t => t.includes('Matematica'));
  const iStoria = order.findIndex(t => t.includes('Storia'));
  assert.ok(iMate >= 0 && iStoria > iMate, 'la 7ª resta dopo la 6ª');
  await act(async () => { renderer.unmount(); });
});

test('Week: una lezione valida non viene marcata', async () => {
  const renderer = await renderWeek({ timetable: [lessonMon6] });
  assert.equal(marks(renderer).length, 0);
  await act(async () => { renderer.unmount(); });
});

test('Week: due lezioni nello stesso periodo da istituti diversi restano entrambe visibili', async () => {
  const fromPrimary: TimetableSlot = { ...lessonMon6, id: 'tt-a', subject: 'Matematica', schoolId: 's1' };
  const fromSecondary: TimetableSlot = { ...lessonMon6, id: 'tt-b', subject: 'Inglese', className: '2E', schoolId: 's2' };
  const renderer = await renderWeek({ timetable: [fromPrimary, fromSecondary] });

  const text = flatText(renderer.root);
  assert.ok(text.includes('Matematica'), 'lezione istituto primario visibile');
  assert.ok(text.includes('Inglese'), 'lezione istituto secondario visibile');
  assert.equal(lessonCards(renderer).length, 2, 'D2 non introduce alcun filtro per istituto');
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// TimetableEditor: riga senza fascia
// ---------------------------------------------------------------------------

async function mountEditor(teacher: TeacherProfile, timeSlotConfig: TimeSlotConfig, timetable: TimetableSlot[] = []) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, {
      profile: teacher,
      definitiveTimetable: timetable,
      provisionalTimetable: [],
      timetableMode: 'auto' as const,
      activeType: 'definitivo' as const,
      isDefinitiveCompiled: true,
      timeSlotConfig,
      onSaveSlot: () => {},
      onDeleteSlot: () => {},
      onSetTimetableMode: () => {},
      onCopyProvisionalToDefinitive: () => {},
      onCopyDefinitiveToProvisional: () => {},
      onClearTimetable: () => {},
      onSaveTimeSlotConfig: () => {},
    } as any));
  });
  return renderer;
}

const bodyRows = (renderer: any): ReactTestInstance[] => {
  const tbody = renderer.root.findAll((n: any) => n.type === 'tbody')[0];
  return tbody.findAll((n: any) => n.type === 'tr', { deep: false });
};
const bellOf = (row: ReactTestInstance) => row.findAll((n: any) => n.type === 'td', { deep: false })[0];

/** Lezione all'8ª: tiene viva la riga 8 anche con 6 fasce configurate. */
const lessonMon8: TimetableSlot = {
  id: 'tt-mon-8', dayOfWeek: 1, periodNumber: 8, startTime: '15:00', endTime: '16:00',
  subject: 'Geografia', className: '1A',
};

test('griglia: riga 8 senza fascia e SENZA lezioni -> "Orario da configurare" + CTA', async () => {
  // Scuola a 8 ore, 6 fasce: la riga 8 esiste ed e davvero da configurare.
  const profile8: TeacherProfile = {
    ...baseProfile,
    schools: [{
      id: 's1', name: 'IC', isPrimary: true, active: true,
      dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 2 } },
    }],
  };
  const renderer = await mountEditor(profile8, config(6));
  const rows = bodyRows(renderer);
  assert.equal(rows.length, 8);

  const bell = flatText(bellOf(rows[7]));
  assert.match(bell, /Orario da configurare/);
  assert.match(bell, /Configura 8ª ora/);
  await act(async () => { renderer.unmount(); });
});

test('griglia: riga 8 senza fascia ma CON lezione legacy -> nota legacy, nessuna CTA "Configura"', async () => {
  const renderer = await mountEditor(profileThursday7, config(6), [lessonMon8]);
  const rows = bodyRows(renderer);
  assert.equal(rows.length, 8, 'la riga 8 vive grazie alla lezione salvata');

  const row8 = rows[7];
  assert.ok(flatText(row8).includes('Geografia'), 'la lezione resta visibile');

  const bell = flatText(bellOf(row8));
  assert.match(bell, /8ª Ora/);
  assert.match(bell, /Fascia oraria non piu configurata/, 'nota coerente col carattere legacy');
  assert.equal(/Orario da configurare/.test(bell), false, 'niente messaggio ambiguo');
  assert.equal(/Configura 8ª ora/.test(bell), false, 'niente CTA da riga vuota');
  assert.equal(
    bellOf(row8).findAll((n: any) => n.type === 'button').length,
    0,
    'nessun pulsante nella campana di una riga legacy'
  );

  // La riga 7, senza lezioni e senza fascia, conserva invece la CTA.
  const bell7 = flatText(bellOf(rows[6]));
  assert.match(bell7, /Orario da configurare/);
  await act(async () => { renderer.unmount(); });
});

test('griglia: la lezione legacy della riga 8 resta apribile', async () => {
  const renderer = await mountEditor(profileThursday7, config(6), [lessonMon8]);
  const row8 = bodyRows(renderer)[7];
  const card = row8.findAll((n: any) => n.type === 'div' && typeof n.props.onClick === 'function')[0];
  assert.ok(card, 'card interattiva presente');
  await act(async () => { card.props.onClick(); });
  const open = renderer.root.findAll((n: any) => n.type === 'h3' && /Ora di Lezione/.test(flatText(n)));
  assert.equal(open.length, 1, 'il modale si apre');
  await act(async () => { renderer.unmount(); });
});

test('griglia: le celle vuote della riga legacy restano non aggiungibili', async () => {
  const renderer = await mountEditor(profileThursday7, config(6), [lessonMon8]);
  const row8 = bodyRows(renderer)[7];

  assert.equal(
    row8.findAll((n: any) => n.props?.['data-slot-cell'] === 'empty').length,
    0,
    'nessuna cella libera aggiungibile nella riga senza fascia'
  );
  const inert = row8.findAll((n: any) => n.props?.['aria-disabled'] === 'true');
  assert.ok(inert.length > 0, 'le altre celle sono inerti');
  for (const cell of inert) assert.equal(cell.props.onClick, undefined);

  // Nessun orario inventato per la riga 8.
  assert.equal(flatText(bellOf(row8)).includes('15:00'), false);
  await act(async () => { renderer.unmount(); });
});
