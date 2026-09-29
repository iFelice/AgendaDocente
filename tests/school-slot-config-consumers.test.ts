import 'fake-indexeddb/auto';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TodayView } from '../src/components/TodayView';
import { WeekView } from '../src/components/WeekView';
import { DocumentScannerModal } from '../src/components/DocumentScannerModal';
import {
  applyReconstruction,
  partitionReconstructedSlots,
  reconstructedToTimetableSlots,
} from '../src/utils/reconstructTimetable';
import { legacyPrimarySchoolId } from '../src/utils/multiSchool';
import { OUT_OF_CONFIG_SLOT_BADGE } from '../src/utils/schoolDayPeriods';
import type { ReconstructedSlot } from '../src/utils/timetableCrossref';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/**
 * MICRO-PASSO G3 — LE CAMPANE DELL'ISTITUTO OVUNQUE, NON SOLO NELL'EDITOR.
 *
 * Dopo G2 la griglia dell'orario usava le fasce della scuola selezionata,
 * mentre Oggi, Settimana, scanner, D1 e D3 leggevano ancora il singleton del
 * docente. Lo stato intermedio produceva letture incoerenti sullo stesso dato:
 * la stessa ora poteva risultare valida in una vista e irregolare in un'altra,
 * e un import destinato a un istituto veniva convalidato con gli orari di un
 * altro.
 *
 * G3 chiude il cerchio: chiunque debba ragionare sulle fasce risolve prima la
 * scuola effettiva e poi le SUE campane, con la globale come fallback.
 *
 * Restano fuori: il riallineamento delle lezioni già salvate quando le campane
 * cambiano (G4).
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SCHOOL_B_ID = 'school-liceo-verdi';

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Felice Manganiello', schoolName: 'IC Rossi',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'], campuses: [], roles: [], isSupportTeacher: true,
};
const PRIMARY_ID = legacyPrimarySchoolId(baseProfile);

/** Costruisce N fasce orarie da `start`, di `minutes` minuti ciascuna. */
function config(count: number, start = '08:00', minutes = 60): TimeSlotConfig {
  const slots = [];
  let [h, m] = start.split(':').map(Number);
  for (let i = 1; i <= count; i += 1) {
    const from = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    let em = m + minutes, eh = h + Math.floor(em / 60);
    em %= 60;
    slots.push({ periodNumber: i, label: `${i}ª Ora`, startTime: from, endTime: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}` });
    h = eh; m = em;
  }
  return { firstHourStartTime: start, periodsPerDay: count, standardDurationMinutes: minutes, customSlots: slots };
}

/** Globale del docente: 6 fasce da 08:00. */
const globalSix = config(6, '08:00', 60);
/** Globale alternativa: 8 fasce. Serve ai casi "globale più lunga della scuola". */
const globalEight = config(8, '08:00', 60);
/** Campane proprie di B: 8 fasce da 08:15, da 55 minuti. */
const configB8 = config(8, '08:15', 55);
/** Campane proprie di B più corte della globale: solo 6 fasce. */
const configB6 = config(6, '08:15', 55);

const schoolA = (over: Partial<SchoolProfile> = {}): SchoolProfile => ({
  id: PRIMARY_ID, name: 'IC Rossi', isPrimary: true, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 6 }, ...over,
});
const schoolB = (over: Partial<SchoolProfile> = {}): SchoolProfile => ({
  id: SCHOOL_B_ID, name: 'Liceo Verdi', isPrimary: false, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 8 }, ...over,
});

const profileWith = (schools: SchoolProfile[]): TeacherProfile => ({ ...baseProfile, schools });
/** A eredita la globale, B ha 8 fasce proprie. Il caso guida di G3. */
const profileB8 = profileWith([schoolA(), schoolB({ timeSlotConfig: configB8 })]);
/** B ha campane proprie PIÙ CORTE della globale. */
const profileB6 = profileWith([schoolA(), schoolB({ timeSlotConfig: configB6 })]);
/** Nessun istituto personalizzato: tutto deve comportarsi come prima di G. */
const profilePlain = profileWith([schoolA(), schoolB()]);
const singleSchool = profileWith([schoolA()]);

function lesson(over: Partial<TimetableSlot> & { id: string }): TimetableSlot {
  return {
    dayOfWeek: 1, periodNumber: 1, startTime: '08:00', endTime: '09:00',
    subject: 'Matematica', className: '3D', isProvisional: false, ...over,
  };
}

let seq = 0;
function item(dayOfWeek: number, periodIndex: number, classLabel = '3D'): ReconstructedSlot {
  seq += 1;
  return {
    id: `r-${seq}`, dayOfWeek, periodIndex, classLabel,
    coTeachingSubjects: [], status: 'ok', confidence: 'high', selected: true,
  } as unknown as ReconstructedSlot;
}

// ---------------------------------------------------------------------------
// Helpers di rendering
// ---------------------------------------------------------------------------

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
const marks = (renderer: any) => renderer.root.findAll((el: any) => el.props?.['data-slot-out-of-config'] === 'true');
const cards = (renderer: any) => renderer.root.findAll((el: any) => el.props?.['data-slot-cell'] === 'lesson');
function isMarked(renderer: any, subject: string): boolean {
  const card = cards(renderer).find((c: any) => flatText(c).includes(subject));
  assert.ok(card, `card di "${subject}" assente`);
  return card!.findAll((el: any) => el.props?.['data-slot-out-of-config'] === 'true').length > 0;
}

const MONDAY_ISO = '2026-09-14';

function todayProps(o: Record<string, unknown> = {}) {
  return {
    profile: profileB8, timeSlotConfig: globalSix, timetable: [] as TimetableSlot[],
    events: [], scheduledAssessments: [], isProvisionalTimetable: false, isDefinitiveCompiled: true,
    timetableType: 'definitivo' as const, onOpenTimetableSlotForEdit: () => {},
    initialDateIso: MONDAY_ISO, onOpenNewEvent: () => {}, onOpenCircularModal: () => {},
    onEditEvent: () => {}, onDeleteEvent: () => {}, onToggleComplete: () => {}, ...o,
  };
}
function weekProps(o: Record<string, unknown> = {}) {
  return {
    profile: profileB8, timeSlotConfig: globalSix, timetable: [] as TimetableSlot[],
    events: [], isProvisionalTimetable: false, timetableType: 'definitivo' as const,
    onOpenTimetableSlotForEdit: () => {}, onOpenNewEvent: () => {}, onEditEvent: () => {},
    targetDateIso: MONDAY_ISO, ...o,
  };
}
async function renderToday(o: Record<string, unknown> = {}) {
  let r: any; await act(async () => { r = create(React.createElement(TodayView, todayProps(o) as any)); }); return r;
}
async function renderWeek(o: Record<string, unknown> = {}) {
  let r: any; await act(async () => { r = create(React.createElement(WeekView, weekProps(o) as any)); }); return r;
}
/** Ogni caso vale per Oggi E Settimana: le due viste devono restare simmetriche. */
const BOTH: Array<[string, (o?: Record<string, unknown>) => Promise<any>]> = [
  ['Oggi', renderToday], ['Settimana', renderWeek],
];

// ---------------------------------------------------------------------------
// 1-6. Today / Week
// ---------------------------------------------------------------------------

for (const [view, render] of BOTH) {
  test(`G3/1. ${view}: B/8 con 8 ore e fasce proprie -> nessun falso "fuori configurazione"`, async () => {
    const slot = lesson({ id: 'b8', periodNumber: 8, startTime: '14:40', endTime: '15:35', subject: 'Greco', schoolId: SCHOOL_B_ID });
    const renderer = await render({ timetable: [slot] });
    try {
      assert.match(flatText(renderer.root), /Greco/);
      assert.equal(marks(renderer).length, 0, 'per B l 8ª ora è regolare');
      assert.equal(flatText(renderer.root).includes(OUT_OF_CONFIG_SLOT_BADGE), false);
    } finally { await act(async () => { renderer.unmount(); }); }
  });

  test(`G3/2. ${view}: la marcatura resta una questione di dayPeriods, non di fasce`, async () => {
    // B ammette 8 ore al giorno ma ha solo 6 fasce proprie: la 7ª NON è
    // "ora non prevista dal giorno" — è un problema di fascia mancante, che è
    // un caso diverso e non si marca qui. Semantica D2 preservata.
    const slot = lesson({ id: 'b7', periodNumber: 7, startTime: '13:45', endTime: '14:40', subject: 'Filosofia', schoolId: SCHOOL_B_ID });
    const renderer = await render({ profile: profileB6, timetable: [slot] });
    try {
      assert.match(flatText(renderer.root), /Filosofia/, 'la lezione resta visibile');
      assert.equal(marks(renderer).length, 0, 'il giorno di B prevede 8 ore: nessuna marcatura');
    } finally { await act(async () => { renderer.unmount(); }); }
  });

  test(`G3/3. ${view}: la primaria senza campane proprie continua sulla globale`, async () => {
    const ok = lesson({ id: 'a6', periodNumber: 6, startTime: '13:00', endTime: '14:00', subject: 'Storia', schoolId: PRIMARY_ID });
    const over = lesson({ id: 'a7', periodNumber: 7, startTime: '14:00', endTime: '15:00', subject: 'Arte', schoolId: PRIMARY_ID });
    const renderer = await render({ timetable: [ok, over] });
    try {
      assert.equal(isMarked(renderer, 'Storia'), false, '6ª: dentro le 6 ore di A');
      assert.equal(isMarked(renderer, 'Arte'), true, '7ª: fuori dalle 6 ore di A');
    } finally { await act(async () => { renderer.unmount(); }); }
  });

  test(`G3/4-5. ${view}: lezione legacy e con istituto orfano -> primaria e sue campane`, async () => {
    const legacy = lesson({ id: 'lg', dayOfWeek: 1, periodNumber: 7, startTime: '14:00', endTime: '15:00', subject: 'Legacy' });
    const orphan = lesson({ id: 'or', dayOfWeek: 1, periodNumber: 7, startTime: '14:00', endTime: '15:00', subject: 'Orfana', schoolId: 'school-rimossa' });
    const renderer = await render({ timetable: [legacy, orphan] });
    try {
      assert.match(flatText(renderer.root), /Legacy/, 'nessuna lezione sparisce');
      assert.match(flatText(renderer.root), /Orfana/);
      // Entrambe valutate sulla primaria (6 ore): la 7ª è fuori configurazione.
      assert.equal(isMarked(renderer, 'Legacy'), true);
      assert.equal(isMarked(renderer, 'Orfana'), true);
    } finally { await act(async () => { renderer.unmount(); }); }
  });
}

test('G3/6. Oggi e Settimana danno lo stesso verdetto sugli stessi dati', async () => {
  const slots = [
    lesson({ id: 'b8', periodNumber: 8, startTime: '14:40', endTime: '15:35', subject: 'Greco', schoolId: SCHOOL_B_ID }),
    lesson({ id: 'a7', periodNumber: 7, startTime: '14:00', endTime: '15:00', subject: 'Arte', schoolId: PRIMARY_ID }),
  ];
  const today = await renderToday({ timetable: slots });
  const week = await renderWeek({ timetable: slots });
  try {
    for (const subject of ['Greco', 'Arte']) {
      assert.equal(isMarked(today, subject), isMarked(week, subject), `verdetto simmetrico su ${subject}`);
    }
    assert.equal(marks(today).length, 1);
    assert.equal(marks(week).length, 1);
  } finally {
    await act(async () => { today.unmount(); });
    await act(async () => { week.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 12-17. D1
// ---------------------------------------------------------------------------

test('G3/12+17. globale 6 fasce, B ne ha 8: B/8 è valido e prende gli orari di B', () => {
  const partition = partitionReconstructedSlots([item(1, 8)], {
    profile: profileB8, timeSlotConfig: globalSix, schoolId: SCHOOL_B_ID,
  });
  assert.equal(partition.rejected.length, 0, 'D1 non usa più la globale: 8 fasce esistono in B');
  assert.equal(partition.slots.length, 1);
  assert.equal(partition.slots[0].schoolId, SCHOOL_B_ID);
  // L'8ª di B parte alle 08:15 + 7 x 55'.
  assert.equal(partition.slots[0].startTime, configB8.customSlots![7].startTime);
  assert.equal(partition.slots[0].endTime, configB8.customSlots![7].endTime);
});

test('G3/13+16. globale 8 fasce, B ne ha 6: B/7 è "missing-period-slot", non "day-not-allowed"', () => {
  const partition = partitionReconstructedSlots([item(1, 7)], {
    profile: profileB6, timeSlotConfig: globalEight, schoolId: SCHOOL_B_ID,
  });
  assert.equal(partition.slots.length, 0);
  assert.equal(partition.rejected.length, 1);
  // Il giorno di B prevede 8 ore, quindi NON è un problema di giorno; è la
  // fascia che manca nella config di B. La 7ª globale non deve essere usata.
  assert.equal(partition.rejected[0].reason, 'missing-period-slot');
});

test('G3/14. oltre i dayPeriods resta "day-not-allowed" anche con fasce disponibili', () => {
  // A ammette 6 ore; la globale ha 8 fasce. La 7ª di A è un problema di GIORNO.
  const partition = partitionReconstructedSlots([item(1, 7)], {
    profile: profileB8, timeSlotConfig: globalEight, schoolId: PRIMARY_ID,
  });
  assert.equal(partition.rejected[0].reason, 'day-not-allowed');
});

test('G3/15+18b. schoolId assente o orfano: primaria e campane della primaria', () => {
  const withOwnPrimary = profileWith([schoolA({ timeSlotConfig: config(6, '07:45', 50) }), schoolB({ timeSlotConfig: configB8 })]);
  for (const schoolId of [undefined, 'school-rimossa']) {
    const partition = partitionReconstructedSlots([item(1, 1)], {
      profile: withOwnPrimary, timeSlotConfig: globalSix, schoolId,
    });
    assert.equal(partition.slots.length, 1, `schoolId=${schoolId}`);
    assert.equal(partition.slots[0].schoolId, PRIMARY_ID, 'mai un id orfano sugli slot');
    assert.equal(partition.slots[0].startTime, '07:45', 'campane della primaria, non globali né di B');
  }
});

test('G3/17b. D1 usa UNA sola config per il giorno e per la fascia reale', () => {
  // Se i due controlli usassero config diverse, questo slot passerebbe il
  // primo con la geometria di B e il secondo con le fasce globali.
  const partition = partitionReconstructedSlots([item(1, 7), item(1, 8)], {
    profile: profileB6, timeSlotConfig: globalEight, schoolId: SCHOOL_B_ID,
  });
  assert.equal(partition.slots.length, 0, 'nessuna delle due entra: B ha solo 6 fasce');
  assert.deepEqual(partition.rejected.map(r => r.reason), ['missing-period-slot', 'missing-period-slot']);
});

// ---------------------------------------------------------------------------
// 18-21. Import e merge
// ---------------------------------------------------------------------------

test('G3/18-19. lo slot importato per B riceve gli orari di B, non quelli globali/A', () => {
  const slots = reconstructedToTimetableSlots([item(1, 1, '3E')], {
    profile: profileB8, timeSlotConfig: globalSix, schoolId: SCHOOL_B_ID,
  });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].schoolId, SCHOOL_B_ID);
  assert.equal(slots[0].startTime, '08:15', 'la 1ª di B, non le 08:00 globali');
  assert.equal(slots[0].endTime, '09:10');
});

test('G3/11+15b. le fasce CUSTOM di B sono usate così come sono, mai rigenerate', () => {
  const custom: TimeSlotConfig = {
    firstHourStartTime: '08:10', periodsPerDay: 3, standardDurationMinutes: 45,
    customSlots: [
      { periodNumber: 1, label: '1ª Ora', startTime: '08:10', endTime: '08:55' },
      { periodNumber: 2, label: '2ª Ora', startTime: '09:05', endTime: '09:50' },
      { periodNumber: 3, label: '3ª Ora', startTime: '10:20', endTime: '11:05' },
    ],
  };
  const profile = profileWith([schoolA(), schoolB({ timeSlotConfig: custom })]);
  const slots = reconstructedToTimetableSlots([item(1, 2), item(1, 3)], {
    profile, timeSlotConfig: globalSix, schoolId: SCHOOL_B_ID,
  });
  // Gli intervalli hanno buchi irregolari: una rigenerazione automatica li
  // appiattirebbe in una scala continua.
  assert.deepEqual(slots.map(s => [s.startTime, s.endTime]), [['09:05', '09:50'], ['10:20', '11:05']]);
  // La 4ª non esiste nella config di B: scartata, mai sintetizzata.
  const partition = partitionReconstructedSlots([item(1, 4)], { profile, timeSlotConfig: globalSix, schoolId: SCHOOL_B_ID });
  assert.equal(partition.slots.length, 0);
  assert.equal(partition.rejected[0].reason, 'missing-period-slot');
});

test('G3/20. A/Lun1 esistente e B/Lun1 importato convivono con orari diversi', () => {
  const existing: TimetableSlot[] = [lesson({ id: 'ex-a', schoolId: PRIMARY_ID })];
  const incoming = reconstructedToTimetableSlots([item(1, 1, '3E')], {
    profile: profileB8, timeSlotConfig: globalSix, schoolId: SCHOOL_B_ID,
  });
  const merged = applyReconstruction(existing, incoming, 'missing-only', { profile: profileB8 });
  assert.equal(merged.slots.length, 2, 'stessa coordinata, istituti diversi: nessun overwrite');
  const a = merged.slots.find(s => s.id === 'ex-a');
  const b = merged.slots.find(s => s.schoolId === SCHOOL_B_ID);
  assert.equal(a?.startTime, '08:00', 'A conserva i suoi orari');
  assert.equal(b?.startTime, '08:15', 'B ha i propri');
});

test('G3/21+10. nessun istituto personalizzato: comportamento identico a prima di G', () => {
  for (const [label, profile] of [['due scuole', profilePlain], ['una sola scuola', singleSchool]] as const) {
    const custom = config(5, '08:20', 55);
    const slots = reconstructedToTimetableSlots([item(1, 1)], {
      profile, timeSlotConfig: custom, schoolId: PRIMARY_ID,
    });
    assert.equal(slots[0].startTime, '08:20', `${label}: fallback alla globale`);
    assert.equal(slots[0].endTime, '09:15');
    // A ammette 6 ore al giorno, ma la globale ha solo 5 fasce: il giorno la
    // prevede, l'orario reale no. La separazione D2 resta intatta anche nel
    // percorso di fallback.
    const partition = partitionReconstructedSlots([item(1, 6)], { profile, timeSlotConfig: custom, schoolId: PRIMARY_ID });
    assert.equal(partition.rejected[0].reason, 'missing-period-slot', `${label}: manca la 6ª fascia, non l'ora del giorno`);
    // Oltre i dayPeriods, invece, è il giorno a rifiutare.
    const toofar = partitionReconstructedSlots([item(1, 7)], { profile, timeSlotConfig: custom, schoolId: PRIMARY_ID });
    assert.equal(toofar.rejected[0].reason, 'day-not-allowed', `${label}: la 7ª eccede le 6 ore di A`);
  }
});

// ---------------------------------------------------------------------------
// 7-10. Scanner: prefill D3 e avviso sulle fasce
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let fetchBodies: Array<Record<string, unknown>> = [];

before(() => {
  URL.createObjectURL = () => 'blob:g3';
  URL.revokeObjectURL = () => {};
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
  globalThis.fetch = (async (_u: unknown, o?: { body?: string }) => {
    if (o?.body) fetchBodies.push(JSON.parse(o.body));
    return new Response(JSON.stringify({ success: true, source: 't', rowLabel: 'Manganiello F.', cells: [] }), { status: 200 });
  }) as typeof fetch;
});
after(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  globalThis.fetch = originalFetch;
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
});
beforeEach(() => { fetchBodies = []; });

function scannerProps(o: Record<string, unknown> = {}) {
  return {
    isOpen: true, onClose: () => {}, profile: profileB8, students: [],
    timeSlotConfig: globalSix,
    provisionalTimetable: [] as TimetableSlot[], definitiveTimetable: [] as TimetableSlot[],
    onOpenCircularWithFile: () => {}, onSaveReconstructedTimetable: () => {},
    onImportStudentCommitments: () => {}, ...o,
  };
}
const byId = (r: any, id: string) => {
  const found = r.root.findAll((el: any) => el.props?.id === id);
  assert.ok(found.length > 0, `id "${id}" assente`);
  return found[0];
};
const hasId = (r: any, id: string) => r.root.findAll((el: any) => el.props?.id === id).length > 0;

/** Scanner personale fino allo schermo di consenso (dove si sceglie l'istituto). */
async function toConsent(o: Record<string, unknown> = {}) {
  let r: any;
  await act(async () => { r = create(React.createElement(DocumentScannerModal, scannerProps(o) as any)); });
  await act(async () => { byId(r, 'scan-type-personal').props.onClick(); });
  await act(async () => { byId(r, 'scan-source-camera').props.onClick(); });
  const input = r.root.findByProps({ 'aria-label': 'Scatta foto del documento' });
  await act(async () => {
    input.props.onChange({ target: { files: [new File([new Uint8Array(2000)], 'o.jpg', { type: 'image/jpeg' })], value: 'p' } });
    await new Promise(res => setTimeout(res, 0));
  });
  await act(async () => { byId(r, 'scan-analyze-cta').props.onClick(); });
  return r;
}
const summary = (r: any) => flatText(byId(r, 'scan-week-structure-summary'));
async function pickSchool(r: any, id: string) {
  await act(async () => { byId(r, 'scan-school-select').props.onChange({ target: { value: id } }); });
}

test('G3/7-8. prefill D3 e avviso fasce seguono le campane di B', async () => {
  const renderer = await toConsent();
  try {
    // A: 6 ore, globale 6 fasce -> nessun avviso.
    assert.match(summary(renderer), /Lun 6 · Mar 6 · Mer 6 · Gio 6 · Ven 6/);
    assert.equal(hasId(renderer, 'scan-week-structure-slots-warning'), false, 'A è coperta');

    // B: 8 ore e 8 fasce PROPRIE -> nessun falso avviso, anche se la globale ne ha 6.
    await pickSchool(renderer, SCHOOL_B_ID);
    assert.match(summary(renderer), /Lun 8 · Mar 8 · Mer 8 · Gio 8 · Ven 8/, 'geometria di B');
    assert.equal(
      hasId(renderer, 'scan-week-structure-slots-warning'), false,
      'le 8 fasce di B esistono: nessun avviso basato sulla globale a 6',
    );
  } finally { await act(async () => { renderer.unmount(); }); }
});

test('G3/9. globale 8 ma B ne configura 6: avviso corretto su B', async () => {
  const renderer = await toConsent({ profile: profileB6, timeSlotConfig: globalEight });
  try {
    await pickSchool(renderer, SCHOOL_B_ID);
    const warning = flatText(byId(renderer, 'scan-week-structure-slots-warning'));
    assert.match(warning, /fino alla 8ª ora/);
    assert.match(warning, /solo 6 fasce orarie/, 'conta le fasce di B, non le 8 globali');
  } finally { await act(async () => { renderer.unmount(); }); }
});

test('G3/10. B senza campane proprie: scanner identico a prima (fallback globale)', async () => {
  const custom = config(5, '08:20', 55);
  const renderer = await toConsent({ profile: profilePlain, timeSlotConfig: custom });
  try {
    await pickSchool(renderer, SCHOOL_B_ID);
    // dayPeriods di B = 8, fasce globali = 5 -> avviso, come prima di G.
    assert.match(summary(renderer), /Lun 8/);
    const warning = flatText(byId(renderer, 'scan-week-structure-slots-warning'));
    assert.match(warning, /solo 5 fasce orarie/, 'usa la globale, che resta il fallback');
  } finally { await act(async () => { renderer.unmount(); }); }
});


// ---------------------------------------------------------------------------
// Istituto che dichiara le CAMPANE ma non la struttura del giorno
//
// `dayPeriods` assente significa "tante ore quante sono le fasce". Quelle
// fasce, dopo G3, sono le SUE: è il caso in cui la config passata a
// `periodsForDay`decide davvero, e distingue una lettura per istituto da una
// lettura globale mascherata.
// ---------------------------------------------------------------------------

/** B: nessun dayPeriods, ma 8 fasce proprie -> i suoi giorni hanno 8 ore. */
const bBellsOnly = profileWith([
  schoolA({ dayPeriods: undefined }),
  schoolB({ dayPeriods: undefined, timeSlotConfig: configB8 }),
]);

test('G3/14b. senza dayPeriods il limite del giorno viene dalle fasce DELL ISTITUTO', () => {
  // Globale: 6 fasce. B: 8 proprie. La 7ª di B è ammessa dal suo giorno.
  const toB = partitionReconstructedSlots([item(1, 7)], {
    profile: bBellsOnly, timeSlotConfig: globalSix, schoolId: SCHOOL_B_ID,
  });
  assert.equal(toB.rejected.length, 0, 'con le 8 fasce di B il giorno arriva alla 7ª');
  assert.equal(toB.slots[0].startTime, configB8.customSlots![6].startTime, 'e usa l orario di B');

  // Stessa ora sulla primaria, che eredita le 6 fasce globali: il GIORNO la rifiuta.
  const toA = partitionReconstructedSlots([item(1, 7)], {
    profile: bBellsOnly, timeSlotConfig: globalSix, schoolId: PRIMARY_ID,
  });
  assert.equal(toA.rejected[0].reason, 'day-not-allowed', 'A: 6 fasce globali = 6 ore al giorno');
});

for (const [view, render] of BOTH) {
  test(`G3/2b. ${view}: senza dayPeriods la marcatura segue le fasce dell istituto`, async () => {
    const b7 = lesson({ id: 'b7', periodNumber: 7, startTime: '13:45', endTime: '14:40', subject: 'GrecoB', schoolId: SCHOOL_B_ID });
    const a7 = lesson({ id: 'a7', periodNumber: 7, startTime: '14:00', endTime: '15:00', subject: 'ArteA', schoolId: PRIMARY_ID });
    const renderer = await render({ profile: bBellsOnly, timetable: [b7, a7] });
    try {
      assert.equal(isMarked(renderer, 'GrecoB'), false, 'B ha 8 fasce proprie: la 7ª è regolare');
      assert.equal(isMarked(renderer, 'ArteA'), true, 'A eredita 6 fasce globali: la 7ª è fuori');
      assert.equal(marks(renderer).length, 1, 'una sola marcatura, quella giusta');
    } finally { await act(async () => { renderer.unmount(); }); }
  });
}
