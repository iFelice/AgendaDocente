import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import {
  EventModal,
  EVENT_CATEGORIES,
  LEGACY_DIPARTIMENTO_CATEGORY,
} from '../src/components/EventModal';
import { TodayView } from '../src/components/TodayView';
import { TimetableEditor } from '../src/components/TimetableEditor';
import { parseCircularText } from '../src/utils/circularParser';
import type { CalendarEvent, TeacherProfile, TimetableSlot } from '../src/types';

/*
 * Pulizia UI: due sole correzioni, con compatibilità legacy verificata.
 *
 * A. "Dipartimento disciplinare" NON è più fra le categorie offerte per i
 *    nuovi eventi (EVENT_CATEGORIES + chip del modale), MA:
 *    - l'identificatore resta valido (tipi, formatter, parser): i dati salvati
 *      e quelli estratti dalle circolari continuano a caricarsi, vedersi,
 *      modificarsi, salvarsi ed esportarsi;
 *    - aprendo un evento che la possiede già, l'opzione compare (marcata
 *      "legacy") per TUTTA la sessione di modifica e la categoria non viene
 *      mai persa o convertita in silenzio.
 * B. Il conteggio ore/lezioni usa il singolare con 1: "1 ora di lezione in
 *    programma" (e gli altri punti UI con lo stesso identico problema:
 *    tab e griglia dell'editor orario, anteprime delle fasce). 0 e >1 restano
 *    come prima. Nessun sistema i18n, nessun refactor di pluralizzazione.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Matematica'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
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
function buttonsWithText(renderer: any, text: string): any[] {
  return renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === text);
}

// ---------------------------------------------------------------------------
// A. "Dipartimento disciplinare": fuori dalle scelte, vivo nei dati legacy
// ---------------------------------------------------------------------------

test('A1. EVENT_CATEGORIES non offre più "dipartimento"; le altre categorie restano', () => {
  assert.equal(EVENT_CATEGORIES.some((c) => c.id === 'dipartimento'), false, 'rimossa dalle opzioni normali');
  assert.ok(EVENT_CATEGORIES.some((c) => c.id === 'dipartimento_sostegno'), 'il Dipartimento Sostegno NON è toccato');
  assert.ok(EVENT_CATEGORIES.some((c) => c.id === 'consiglio_classe'));
  // L'identificatore legacy resta valido come opzione guardata (stesso id, label marcata).
  assert.equal(LEGACY_DIPARTIMENTO_CATEGORY.id, 'dipartimento');
  assert.ok(LEGACY_DIPARTIMENTO_CATEGORY.label.includes('legacy'));
});

test('A2. nuovo evento: nessun chip "Dipartimento Disciplinare" nel modale', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true, onClose: () => {}, eventToEdit: null, profile, onSave: () => {},
    }));
  });
  const texts = renderer.root.findAll((el: any) => el.type === 'button').map((b: any) => flatText(b));
  assert.ok(!texts.some((t: string) => t.startsWith('Dipartimento Disciplinare')), 'nessuna variante della categoria offerta');
  assert.ok(texts.includes('Consiglio di Classe'), 'le categorie normali ci sono');
});

test('A3. evento legacy "dipartimento": si apre senza crash, opzione legacy visibile e selezionata', async () => {
  const legacyEvent: CalendarEvent = {
    id: 'ev-legacy', title: 'Riunione Dipartimento di Matematica', category: 'dipartimento',
    date: '2026-09-15', startTime: '15:00', endTime: '16:30', isAllDay: false, sourceType: 'manuale',
  };
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true, onClose: () => {}, eventToEdit: legacyEvent, profile, onSave: () => {},
    }));
  });
  const legacyChips = buttonsWithText(renderer, 'Dipartimento Disciplinare (legacy)');
  assert.equal(legacyChips.length, 1, 'l\'opzione legacy è visibile SOLO per l\'evento che la possiede');
  assert.ok(String(legacyChips[0].props.className).includes('bg-emerald-700'), 'la categoria è selezionata, non persa');
  assert.ok(!buttonsWithText(renderer, 'Dipartimento Disciplinare').length, 'nessun doppio chip non marcato');
});

test('A4. salvataggio: la categoria legacy NON viene convertita né perduta', async () => {
  const legacyEvent: CalendarEvent = {
    id: 'ev-legacy', title: 'Riunione Dipartimento', category: 'dipartimento',
    date: '2026-09-15', startTime: '15:00', endTime: '16:30', isAllDay: false, sourceType: 'manuale',
  };
  const saved: CalendarEvent[] = [];
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true, onClose: () => {}, eventToEdit: legacyEvent, profile,
      onSave: (ev) => { saved.push(ev); },
    }));
  });
  // Ri-seleziona esplicitamente il chip legacy (resta disponibile per tutta la modifica) e salva.
  await act(async () => { buttonsWithText(renderer, 'Dipartimento Disciplinare (legacy)')[0].props.onClick(); });
  const form = renderer.root.findByType('form');
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].category, 'dipartimento', 'salva ESATTAMENTE la categoria legacy');
});

test('A5. parser circolari: la categoria legacy continua a essere prodotta/accettata', () => {
  const [item] = parseCircularText('14/09/2027 Riunione Dipartimento di Matematica 15:00-17:00', profile);
  assert.ok(item, 'la circolare produce un candidato');
  assert.equal(item.category, 'dipartimento', 'il flusso circolari continua a classificare come prima');
});

// ---------------------------------------------------------------------------
// B. "1 ora" / "N ore"
// ---------------------------------------------------------------------------

/** Martedì fisso: le lezioni di test sono su dayOfWeek 2. */
const FIXED_TUESDAY = '2026-09-15';

function todayProps(lessons: TimetableSlot[]) {
  return {
    profile,
    timetable: lessons,
    events: [],
    scheduledAssessments: [],
    isProvisionalTimetable: false,
    isDefinitiveCompiled: true,
    timetableType: 'definitivo' as const,
    initialDateIso: FIXED_TUESDAY,
    onOpenNewEvent: () => {},
    onOpenCircularModal: () => {},
    onEditEvent: () => {},
    onDeleteEvent: () => {},
    onToggleComplete: () => {},
  };
}

async function renderToday(lessons: TimetableSlot[]) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TodayView, todayProps(lessons) as any));
  });
  return renderer;
}

const oneLesson: TimetableSlot = {
  id: 'tt-1', dayOfWeek: 2, periodNumber: 1, startTime: '07:50', endTime: '08:50',
  subject: 'Matematica', className: '1A',
};

test('B1. Oggi con 1 lezione: "1 ora di lezione in programma"', async () => {
  const renderer = await renderToday([oneLesson]);
  const text = flatText(renderer.root);
  assert.ok(text.includes('1 ora di lezione in programma'), text.slice(0, 200));
  assert.ok(!/1 ore di lezione/.test(text), 'niente singolare sbagliato');
});

test('B2. Oggi con più lezioni: "N ore di lezione in programma" invariato', async () => {
  const renderer = await renderToday([
    oneLesson,
    { ...oneLesson, id: 'tt-2', periodNumber: 2, startTime: '08:50', endTime: '09:50', subject: 'Storia' },
  ]);
  const text = flatText(renderer.root);
  assert.ok(text.includes('2 ore di lezione in programma'));
});

test('B3. Oggi senza lezioni: resta "Nessuna lezione curricolare prevista" (niente "0 ore")', async () => {
  const renderer = await renderToday([]);
  const text = flatText(renderer.root);
  assert.ok(text.includes('Nessuna lezione curricolare prevista'));
  assert.ok(!text.includes('ore di lezione'));
});

// --- Editor orario: stessi conteggi (tab, griglia) ---

const editorConfig = {
  firstHourStartTime: '07:50', periodsPerDay: 3, standardDurationMinutes: 60,
  customSlots: [
    { periodNumber: 1, startTime: '07:50', endTime: '08:50' },
    { periodNumber: 2, startTime: '08:50', endTime: '09:50' },
    { periodNumber: 3, startTime: '09:50', endTime: '10:50' },
  ],
};

function editorProps(slots: TimetableSlot[]) {
  return {
    profile,
    definitiveTimetable: [] as TimetableSlot[],
    provisionalTimetable: slots,
    timetableMode: 'auto' as const,
    activeType: 'provvisorio' as const,
    isDefinitiveCompiled: false,
    timeSlotConfig: editorConfig,
    onSaveSlot: () => {},
    onDeleteSlot: () => {},
    onSetTimetableMode: () => {},
    onCopyProvisionalToDefinitive: () => {},
    onCopyDefinitiveToProvisional: () => {},
    onClearTimetable: () => {},
  };
}

async function renderEditor(slots: TimetableSlot[]) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, editorProps(slots) as any));
  });
  return renderer;
}

test('B4. editor con 1 ora: tab "1 ora" e griglia "1 ora" (mai "1 ore")', async () => {
  const renderer = await renderEditor([
    { id: 'tt-1', dayOfWeek: 1, periodNumber: 1, startTime: '07:50', endTime: '08:50', subject: 'Sostegno', className: '2E' },
  ]);
  const text = flatText(renderer.root);
  assert.ok(text.includes('Primi giorni di scuola • 1 ora'), text.slice(0, 260));
  assert.ok(text.includes('Griglia Provvisorio 1 ora'), 'la pill della griglia usa il singolare');
  assert.ok(!/1 ore/.test(text), `nessun "1 ore" residuo: ${text.match(/\S+ 1 ore\S*/)?.[0] ?? ''}`);
});

test('B5. editor con più ore: i plurali restano "N ore"', async () => {
  const renderer = await renderEditor([
    { id: 'tt-1', dayOfWeek: 1, periodNumber: 1, startTime: '07:50', endTime: '08:50', subject: 'Sostegno', className: '2E' },
    { id: 'tt-2', dayOfWeek: 2, periodNumber: 2, startTime: '08:50', endTime: '09:50', subject: 'Sostegno', className: '1A' },
  ]);
  const text = flatText(renderer.root);
  assert.ok(text.includes('Primi giorni di scuola • 2 ore'));
  assert.ok(text.includes('Griglia Provvisorio 2 ore'));
  assert.ok(!/2 ora\b/.test(text), 'il plurale non viene rotto');
});
