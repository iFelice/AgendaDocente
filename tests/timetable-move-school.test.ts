import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TimetableEditor } from '../src/components/TimetableEditor';
import { reassignTimetableSlotSchool } from '../src/utils/schoolDayPeriods';
import { legacyPrimarySchoolId } from '../src/utils/multiSchool';
import { calculateSlotMinutes, calculateTimetableBySchoolMinutes } from '../src/utils/timetableCongruence';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/**
 * MICRO-PASSO G5 — SPOSTARE UNA LEZIONE IN UN ALTRO ISTITUTO.
 *
 * Era l'ultimo pezzo mancante del multi-istituto: una lezione nata nella
 * scuola sbagliata poteva solo essere cancellata e rifatta. Non si poteva
 * spostarla perché, finché le campane erano uniche, "cambiare istituto" non
 * avrebbe saputo che orari darle — problema risolto da G1-G3.
 *
 * Cambiare scuola significa adottarne le regole: le ore che quel giorno
 * prevede e la sua campanella. Qui si verifica che accada esattamente questo,
 * e nient'altro.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SCHOOL_B_ID = 'school-liceo-verdi';

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Rossi',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};
const PRIMARY_ID = legacyPrimarySchoolId(baseProfile);

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

/** Globale (ereditata da A): 8 fasce da 08:00, ore piene. */
const globalEight = config(8, '08:00', 60);
/** Campane di B: 8 fasce da 08:30, da 50 minuti. La 6ª = 12:40-13:30. */
const configB = config(8, '08:30', 50);

const schoolA = (over: Partial<SchoolProfile> = {}): SchoolProfile => ({
  id: PRIMARY_ID, name: 'IC Rossi', isPrimary: true, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 8 }, ...over,
});
const schoolB = (over: Partial<SchoolProfile> = {}): SchoolProfile => ({
  id: SCHOOL_B_ID, name: 'Liceo Verdi', isPrimary: false, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 8 }, timeSlotConfig: configB, ...over,
});

const profileWith = (schools: SchoolProfile[]): TeacherProfile => ({ ...baseProfile, schools });
/** A: 8 ore, campane globali. B: 8 ore, campane proprie. */
const twoSchools = profileWith([schoolA(), schoolB()]);
/** B accetta solo 6 ore al giorno: serve ai casi di clamp. */
const bShortDay = profileWith([schoolA(), schoolB({ dayPeriods: { ordinaryPeriodsPerDay: 6 } })]);
const singleSchool = profileWith([schoolA()]);

function lesson(over: Partial<TimetableSlot> & { id: string }): TimetableSlot {
  return {
    dayOfWeek: 1, periodNumber: 6, startTime: '13:00', endTime: '14:00',
    subject: 'Matematica', className: '1A', isProvisional: false, ...over,
  };
}

// ---------------------------------------------------------------------------
// Helper puro
// ---------------------------------------------------------------------------

test('G5/P1. periodo ammesso: cambia istituto e orari, non il numero d ora', () => {
  const slot = lesson({ id: 's', schoolId: PRIMARY_ID });
  const out = reassignTimetableSlotSchool(slot, schoolB(), configB);
  assert.equal(out.slot.schoolId, SCHOOL_B_ID);
  assert.equal(out.slot.periodNumber, 6, 'la 6ª esiste anche in B');
  assert.equal(out.slot.startTime, '12:40', '6ª fascia di B');
  assert.equal(out.slot.endTime, '13:30');
  assert.equal(out.wasClamped, false);
});

test('G5/P2. periodo non ammesso dal giorno della nuova scuola: clamp', () => {
  const slot = lesson({ id: 's', periodNumber: 8, startTime: '15:00', endTime: '16:00', schoolId: PRIMARY_ID });
  const out = reassignTimetableSlotSchool(slot, schoolB({ dayPeriods: { ordinaryPeriodsPerDay: 6 } }), configB);
  assert.equal(out.wasClamped, true);
  assert.equal(out.previousPeriod, 8);
  assert.equal(out.nextPeriod, 6);
  assert.equal(out.allowed, 6);
  assert.equal(out.slot.periodNumber, 6);
  assert.equal(out.slot.startTime, '12:40', 'orari della 6ª REALE di B');
});

test('G5/P3. fascia mancante: si arretra all ultima reale, mai orari inventati', () => {
  // B dichiara 8 ore al giorno ma ha solo 6 fasce configurate.
  const sixBells = config(6, '08:30', 50);
  const slot = lesson({ id: 's', periodNumber: 8, startTime: '15:00', endTime: '16:00', schoolId: PRIMARY_ID });
  const out = reassignTimetableSlotSchool(slot, schoolB({ timeSlotConfig: sixBells }), sixBells);
  assert.equal(out.slot.periodNumber, 6, 'ultima fascia REALE di B');
  assert.equal(out.slot.startTime, '12:40');
  assert.equal(out.slot.endTime, '13:30');
  assert.equal(out.wasClamped, true);
});

test('G5/P4. il giorno non viene mai toccato, e lo slot in ingresso non è mutato', () => {
  const slot = lesson({ id: 's', dayOfWeek: 4, periodNumber: 8, schoolId: PRIMARY_ID });
  const snapshot = { ...slot };
  const out = reassignTimetableSlotSchool(slot, schoolB({ dayPeriods: { ordinaryPeriodsPerDay: 6 } }), configB);
  assert.equal(out.slot.dayOfWeek, 4, 'stesso giorno');
  assert.deepEqual(slot, snapshot, 'funzione pura');
  assert.notEqual(out.slot, slot);
});

test('G5/P5. tutto il resto della lezione resta intatto', () => {
  const slot = lesson({
    id: 's', schoolId: PRIMARY_ID, subject: 'Sostegno', className: '2E',
    classroom: 'Aula 12', campus: 'Sede Centrale', color: '#34d399',
    coTeachingSubjects: ['Matematica'], coSupportTeachers: ['Prof.ssa Rossi'], isProvisional: true,
  });
  const out = reassignTimetableSlotSchool(slot, schoolB(), configB);
  for (const key of ['id', 'subject', 'className', 'classroom', 'campus', 'color', 'isProvisional', 'dayOfWeek'] as const) {
    assert.deepEqual(out.slot[key], slot[key], `${key} invariato`);
  }
  assert.deepEqual(out.slot.coTeachingSubjects, ['Matematica']);
  assert.deepEqual(out.slot.coSupportTeachers, ['Prof.ssa Rossi']);
  assert.equal(out.slot.campus, 'Sede Centrale', 'il plesso resta stringa libera, non normalizzato');
});

// ---------------------------------------------------------------------------
// Harness UI
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
const rootText = (r: any) => flatText(r.root);
const findById = (r: any, id: string) => r.root.findAll((el: any) => el.props?.id === id);
function byId(r: any, id: string) {
  const found = findById(r, id);
  assert.ok(found.length > 0, `id "${id}" assente`);
  return found[0];
}
const hasId = (r: any, id: string) => findById(r, id).length > 0;
const formOf = (r: any) => {
  const forms = r.root.findAll((el: any) => el.type === 'form');
  assert.equal(forms.length, 1, 'modale aperto');
  return forms[0];
};
const timeInputs = (r: any) => formOf(r).findAll((el: any) => el.props?.type === 'time');
const lessonCells = (r: any) =>
  r.root.findAll((el: any) => el.type === 'div' && String(el.props?.className ?? '').includes('cursor-pointer'));

function editorProps(o: Record<string, unknown> = {}) {
  return {
    profile: twoSchools,
    definitiveTimetable: [] as TimetableSlot[],
    provisionalTimetable: [] as TimetableSlot[],
    timetableMode: 'auto' as const,
    activeType: 'definitivo' as const,
    isDefinitiveCompiled: true,
    timeSlotConfig: globalEight,
    onSaveSlot: () => {}, onDeleteSlot: () => {}, onSetTimetableMode: () => {},
    onCopyProvisionalToDefinitive: () => {}, onCopyDefinitiveToProvisional: () => {},
    onClearTimetable: () => {},
    ...o,
  };
}
async function renderEditor(o: Record<string, unknown> = {}) {
  let r: any;
  await act(async () => { r = create(React.createElement(TimetableEditor, editorProps(o) as any)); });
  return r;
}
async function selectSchool(r: any, id: string) {
  await act(async () => { byId(r, 'timetable-school-select').props.onChange({ target: { value: id } }); });
}
async function openLesson(r: any) {
  await act(async () => { lessonCells(r)[0].props.onClick(); });
}
async function changeSlotSchool(r: any, id: string) {
  await act(async () => { byId(r, 'slot-school').props.onChange({ target: { value: id } }); });
}
async function submit(r: any) {
  await act(async () => { await formOf(r).props.onSubmit({ preventDefault() {} }); });
}

// ---------------------------------------------------------------------------
// 1-4. UI del selettore
// ---------------------------------------------------------------------------

test('G5/1. una sola scuola: nessun selettore istituto nel modale', async () => {
  const r = await renderEditor({ profile: singleSchool, definitiveTimetable: [lesson({ id: 's', schoolId: PRIMARY_ID })] });
  try {
    await openLesson(r);
    assert.equal(hasId(r, 'slot-school'), false);
  } finally { await act(async () => { r.unmount(); }); }
});

test('G5/2-3. il selettore compare solo in MODIFICA, mai in creazione', async () => {
  const r = await renderEditor({ definitiveTimetable: [lesson({ id: 's', schoolId: PRIMARY_ID })] });
  try {
    // Creazione: la sede è quella della griglia (F3), nessuna domanda in più.
    const add = r.root.findAll((el: any) => el.type === 'button' && String(el.props?.title ?? '').startsWith('Aggiungi lezione'))[0];
    await act(async () => { add.props.onClick(); });
    assert.equal(hasId(r, 'slot-school'), false, 'nessun selettore in creazione');
    await act(async () => { r.root.findAll((el: any) => el.props?.['aria-label'] === 'Chiudi')[0].props.onClick(); });

    // Modifica: il selettore c è.
    await openLesson(r);
    assert.ok(hasId(r, 'slot-school'), 'selettore presente in modifica');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G5/4+16+19. valore iniziale = istituto EFFETTIVO (esplicito, legacy, orfano)', async () => {
  for (const [label, slot, expected] of [
    ['esplicito B', lesson({ id: 'b', schoolId: SCHOOL_B_ID }), SCHOOL_B_ID],
    ['legacy', lesson({ id: 'lg' }), PRIMARY_ID],
    ['orfano', lesson({ id: 'or', schoolId: 'school-rimossa' }), PRIMARY_ID],
  ] as const) {
    const r = await renderEditor({ definitiveTimetable: [slot] });
    try {
      if (expected === SCHOOL_B_ID) await selectSchool(r, SCHOOL_B_ID);
      await openLesson(r);
      assert.equal(byId(r, 'slot-school').props.value, expected, `${label}: valore iniziale`);
      assert.notEqual(byId(r, 'slot-school').props.value, '', 'mai vuoto');
    } finally { await act(async () => { r.unmount(); }); }
  }
});

// ---------------------------------------------------------------------------
// 5-7. Cambio semplice
// ---------------------------------------------------------------------------

test('G5/5. A/6 -> B: schoolId B, periodo 6, orari della 6ª di B', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 's', schoolId: PRIMARY_ID })],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r);
    assert.equal(timeInputs(r)[0].props.value, '13:00', 'partenza: 6ª di A');
    await changeSlotSchool(r, SCHOOL_B_ID);

    // L effetto è immediato e visibile nei campi, prima del salvataggio.
    assert.equal(byId(r, 'slot-period').props.value, 6, 'ora invariata');
    assert.equal(timeInputs(r)[0].props.value, '12:40', '6ª di B');
    assert.equal(timeInputs(r)[1].props.value, '13:30');
    assert.equal(rootText(r).includes('è stata spostata'), false, 'nessun avviso di clamp: non serviva');

    await submit(r);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].schoolId, SCHOOL_B_ID);
    assert.equal(saved[0].periodNumber, 6);
    assert.equal(saved[0].startTime, '12:40');
    assert.equal(saved[0].endTime, '13:30');
    assert.equal(saved[0].id, 's', 'stessa lezione, non una nuova');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G5/6-7. orario manuale sostituito dal cambio scuola, poi ancora modificabile', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 's', periodNumber: 3, startTime: '10:20', endTime: '11:20', schoolId: PRIMARY_ID })],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r);
    await changeSlotSchool(r, SCHOOL_B_ID);
    // 3ª di B = 08:30 + 2x50' -> 10:10-11:00.
    assert.equal(timeInputs(r)[0].props.value, '10:10', 'l orario manuale cede al contesto della nuova scuola');

    // La libertà di ritoccare a mano resta.
    await act(async () => { timeInputs(r)[0].props.onChange({ target: { value: '10:05' } }); });
    await submit(r);
    assert.equal(saved[0].startTime, '10:05', 'modifica manuale successiva consentita');
    assert.equal(saved[0].schoolId, SCHOOL_B_ID);
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 8-12. Clamp e fasce mancanti
// ---------------------------------------------------------------------------

test('G5/8-10. A/8 -> B che ammette 6 ore: clamp a 6, avviso, giorno invariato', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    profile: bShortDay,
    definitiveTimetable: [lesson({ id: 's', dayOfWeek: 1, periodNumber: 8, startTime: '15:00', endTime: '16:00', schoolId: PRIMARY_ID })],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r);
    await changeSlotSchool(r, SCHOOL_B_ID);

    assert.equal(byId(r, 'slot-period').props.value, 6, 'clamp alla 6ª');
    assert.equal(timeInputs(r)[0].props.value, '12:40', 'orari della 6ª di B');
    const notice = flatText(formOf(r));
    assert.match(notice, /8ª ora non prevista da Liceo Verdi/, 'avviso esplicito');
    assert.match(notice, /spostata alla 6ª/);
    assert.equal(byId(r, 'slot-day').props.value, 1, 'il giorno non è stato toccato');

    await submit(r);
    assert.equal(saved[0].periodNumber, 6);
    assert.equal(saved[0].dayOfWeek, 1);
    assert.equal(saved[0].schoolId, SCHOOL_B_ID);
  } finally { await act(async () => { r.unmount(); }); }
});

test('G5/11-12. B ammette 8 ore ma ha 6 fasce: si atterra sulla 6ª REALE', async () => {
  const sixBells = config(6, '08:30', 50);
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    profile: profileWith([schoolA(), schoolB({ timeSlotConfig: sixBells })]),
    definitiveTimetable: [lesson({ id: 's', periodNumber: 8, startTime: '15:00', endTime: '16:00', schoolId: PRIMARY_ID })],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r);
    await changeSlotSchool(r, SCHOOL_B_ID);
    await submit(r);
    assert.equal(saved[0].periodNumber, 6, 'ultima fascia reale di B');
    assert.equal(saved[0].startTime, '12:40', 'orario reale, non sintetizzato');
    assert.equal(saved[0].endTime, '13:30');
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 13-15. Config diverse e cambi ripetuti
// ---------------------------------------------------------------------------

test('G5/13-14. AUTO -> CUSTOM e CUSTOM -> AUTO usano sempre le fasce reali', async () => {
  const custom: TimeSlotConfig = {
    firstHourStartTime: '08:10', periodsPerDay: 3, standardDurationMinutes: 45,
    customSlots: [
      { periodNumber: 1, label: '1ª Ora', startTime: '08:10', endTime: '08:55' },
      { periodNumber: 2, label: '2ª Ora', startTime: '09:05', endTime: '09:50' },
      { periodNumber: 3, label: '3ª Ora', startTime: '10:20', endTime: '11:05' },
    ],
  };
  const profile = profileWith([schoolA(), schoolB({ dayPeriods: { ordinaryPeriodsPerDay: 3 }, timeSlotConfig: custom })]);
  const r = await renderEditor({
    profile,
    definitiveTimetable: [lesson({ id: 's', periodNumber: 3, startTime: '10:00', endTime: '11:00', schoolId: PRIMARY_ID })],
  });
  try {
    await openLesson(r);
    await changeSlotSchool(r, SCHOOL_B_ID);
    // Intervallo irregolare: una rigenerazione automatica darebbe 09:40.
    assert.equal(timeInputs(r)[0].props.value, '10:20', 'AUTO -> CUSTOM: orari esatti');

    await changeSlotSchool(r, PRIMARY_ID);
    assert.equal(timeInputs(r)[0].props.value, '10:00', 'CUSTOM -> AUTO: 3ª di A');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G5/15. A -> B -> A -> B: nessuna contaminazione, e il clamp non si "ricorda"', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    profile: bShortDay,
    definitiveTimetable: [lesson({ id: 's', periodNumber: 8, startTime: '15:00', endTime: '16:00', schoolId: PRIMARY_ID })],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r);
    await changeSlotSchool(r, SCHOOL_B_ID);
    assert.equal(byId(r, 'slot-period').props.value, 6, 'clamp a 6');

    // Tornando ad A il draft è ormai la 6ª: non si recupera l 8ª originaria.
    await changeSlotSchool(r, PRIMARY_ID);
    assert.equal(byId(r, 'slot-period').props.value, 6, 'niente memoria dell ora precedente');
    assert.equal(timeInputs(r)[0].props.value, '13:00', '6ª di A');

    await changeSlotSchool(r, SCHOOL_B_ID);
    assert.equal(timeInputs(r)[0].props.value, '12:40', '6ª di B, ricalcolata ogni volta');
    await changeSlotSchool(r, PRIMARY_ID);
    assert.equal(timeInputs(r)[0].props.value, '13:00');

    await submit(r);
    assert.equal(saved[0].schoolId, PRIMARY_ID);
    assert.equal(saved[0].periodNumber, 6);
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 17-21. Legacy e orfani
// ---------------------------------------------------------------------------

test('G5/17+20. senza toccare l istituto non c è alcuna migrazione opportunistica', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 'lg' }), lesson({ id: 'or', dayOfWeek: 2, schoolId: 'school-rimossa' })],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    // Legacy: salvato senza toccare il selettore -> resta senza schoolId.
    await openLesson(r);
    await submit(r);
    assert.equal('schoolId' in saved[0], false, 'legacy non convertito');

    // Orfano: resta orfano, nessuna pulizia automatica in G5.
    const cells = lessonCells(r);
    await act(async () => { cells[cells.length - 1].props.onClick(); });
    await submit(r);
    assert.equal(saved[1].schoolId, 'school-rimossa', 'id orfano conservato');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G5/18+21. cambiando esplicitamente istituto, legacy e orfano ricevono un id valido', async () => {
  for (const [label, slot] of [['legacy', lesson({ id: 'lg' })], ['orfano', lesson({ id: 'or', schoolId: 'school-rimossa' })]] as const) {
    const saved: TimetableSlot[] = [];
    const r = await renderEditor({
      definitiveTimetable: [slot],
      onSaveSlot: (s: TimetableSlot) => { saved.push(s); },
    });
    try {
      await openLesson(r);
      await changeSlotSchool(r, SCHOOL_B_ID);
      await submit(r);
      assert.equal(saved[0].schoolId, SCHOOL_B_ID, `${label} -> B esplicito`);
      assert.equal(saved[0].startTime, '12:40', `${label}: orari di B`);
    } finally { await act(async () => { r.unmount(); }); }
  }
});

test('G5/14b. legacy portato a B e riportato alla primaria: id primario ESPLICITO', async () => {
  // Scelta documentata: l utente ha compiuto un azione esplicita di cambio
  // istituto, quindi la lezione smette di essere "implicitamente primaria".
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 'lg' })],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r);
    await changeSlotSchool(r, SCHOOL_B_ID);
    await changeSlotSchool(r, PRIMARY_ID);
    await submit(r);
    assert.equal(saved[0].schoolId, PRIMARY_ID, 'id primario scritto esplicitamente');
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 22-26. Navigazione, archivi
// ---------------------------------------------------------------------------

test('G5/22. lezione aperta da Oggi/Settimana: selettore già sulla sua scuola', async () => {
  const slotB = lesson({ id: 'b', periodNumber: 2, startTime: '09:20', endTime: '10:10', schoolId: SCHOOL_B_ID });
  const r = await renderEditor({
    definitiveTimetable: [slotB],
    initialSlot: slotB,
    initialSlotType: 'definitivo' as const,
  });
  try {
    assert.equal(byId(r, 'slot-school').props.value, SCHOOL_B_ID, 'istituto reale della lezione');
    assert.equal(byId(r, 'timetable-school-select').props.value, SCHOOL_B_ID, 'e la griglia lo segue (F2)');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G5/23-24. dopo il salvataggio la griglia passa alla nuova scuola', async () => {
  const slot = lesson({ id: 's', schoolId: PRIMARY_ID });
  let timetable = [slot];
  const r = await renderEditor({
    definitiveTimetable: timetable,
    onSaveSlot: (saved: TimetableSlot) => { timetable = [saved]; },
  });
  try {
    assert.equal(byId(r, 'timetable-school-select').props.value, PRIMARY_ID);
    await openLesson(r);
    await changeSlotSchool(r, SCHOOL_B_ID);
    await submit(r);
    // La lezione non è "sparita": la griglia si sposta dov è finita.
    assert.equal(byId(r, 'timetable-school-select').props.value, SCHOOL_B_ID, 'griglia su B');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G5/25-26. provvisorio e definitivo: la lezione resta nel suo archivio', async () => {
  for (const [label, type, key] of [
    ['provvisorio', 'provvisorio', 'provisionalTimetable'],
    ['definitivo', 'definitivo', 'definitiveTimetable'],
  ] as const) {
    const saved: Array<{ slot: TimetableSlot; type: string }> = [];
    const slot = lesson({ id: 's', schoolId: PRIMARY_ID, isProvisional: type === 'provvisorio' });
    const r = await renderEditor({
      [key]: [slot],
      isDefinitiveCompiled: type === 'definitivo',
      onSaveSlot: (s: TimetableSlot, t: string) => { saved.push({ slot: s, type: t }); },
    });
    try {
      await openLesson(r);
      await changeSlotSchool(r, SCHOOL_B_ID);
      await submit(r);
      assert.equal(saved[0].type, type, `${label}: archivio invariato`);
      assert.equal(saved[0].slot.schoolId, SCHOOL_B_ID);
    } finally { await act(async () => { r.unmount(); }); }
  }
});

// ---------------------------------------------------------------------------
// 27-30. Non-regressione e integrazione
// ---------------------------------------------------------------------------

test('G5/27-28. il cambio istituto tocca SOLO scuola, ora e orari', async () => {
  const saved: TimetableSlot[] = [];
  const original = lesson({
    id: 's', schoolId: PRIMARY_ID, subject: 'Sostegno', className: '2E',
    classroom: 'Aula 12', campus: 'Sede Centrale', color: '#34d399',
    coTeachingSubjects: ['Matematica'],
  });
  const r = await renderEditor({
    definitiveTimetable: [original],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r);
    await changeSlotSchool(r, SCHOOL_B_ID);
    await submit(r);
    const out = saved[0];
    assert.equal(out.subject, 'Sostegno');
    assert.equal(out.className, '2E');
    assert.equal(out.classroom, 'Aula 12');
    assert.equal(out.campus, 'Sede Centrale', 'plesso non normalizzato');
    assert.equal(out.color, '#34d399');
    assert.deepEqual(out.coTeachingSubjects, ['Matematica']);
    assert.equal(out.dayOfWeek, original.dayOfWeek);
  } finally { await act(async () => { r.unmount(); }); }
});

test('G5/int. congruenza: la lezione passa al gruppo B con la nuova durata', () => {
  const before = lesson({ id: 's', schoolId: PRIMARY_ID });
  assert.equal(calculateSlotMinutes(before), 60);
  const { slot: after } = reassignTimetableSlotSchool(before, schoolB(), configB);
  assert.equal(calculateSlotMinutes(after), 50, 'le ore di B durano 50 minuti');

  const bySchool = calculateTimetableBySchoolMinutes([after], PRIMARY_ID);
  assert.equal(bySchool[SCHOOL_B_ID], 50, 'conteggiata sotto B');
  assert.equal(bySchool[PRIMARY_ID], undefined, 'e non più sotto la primaria');
});
