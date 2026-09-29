import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TimetableEditor, DUPLICATE_SLOT_ERROR } from '../src/components/TimetableEditor';
import { legacyPrimarySchoolId } from '../src/utils/multiSchool';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/**
 * MICRO-PASSO H1 — UNA SOLA LEZIONE PER COORDINATA, DENTRO LO STESSO ISTITUTO.
 *
 * La griglia ha una cella per giorno/ora e la risolve con un `find`: due
 * lezioni della stessa scuola sulla stessa coordinata significano una visibile
 * e una irraggiungibile (recuperabile solo da Oggi/Settimana). Il "+" non
 * poteva crearle, ma cambio giorno, cambio ora e — da G5 — cambio istituto sì.
 *
 * Il blocco sta al SALVATAGGIO, non negli handler: l'utente compone il draft
 * liberamente e viene fermato una volta sola, nel punto in cui il dato
 * diventerebbe permanente.
 *
 * Attenzione al confine: NON è un controllo di sovrapposizione temporale fra
 * istituti diversi (quello resta legittimo e non implementato).
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SCHOOL_B_ID = 'school-liceo-verdi';

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Rossi',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: [], roles: [], isSupportTeacher: true,
};
const PRIMARY_ID = legacyPrimarySchoolId(baseProfile);

const timeSlotConfig: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60,
  customSlots: Array.from({ length: 6 }, (_, i) => ({
    periodNumber: i + 1, label: `${i + 1}ª Ora`,
    startTime: `${String(8 + i).padStart(2, '0')}:00`,
    endTime: `${String(9 + i).padStart(2, '0')}:00`,
  })),
};

const schoolA = (over: Partial<SchoolProfile> = {}): SchoolProfile => ({
  id: PRIMARY_ID, name: 'IC Rossi', isPrimary: true, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 6 }, ...over,
});
const schoolB = (over: Partial<SchoolProfile> = {}): SchoolProfile => ({
  id: SCHOOL_B_ID, name: 'Liceo Verdi', isPrimary: false, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 6 }, ...over,
});

const twoSchools: TeacherProfile = { ...baseProfile, schools: [schoolA(), schoolB()] };
const singleSchool: TeacherProfile = { ...baseProfile, schools: [schoolA()] };

function lesson(over: Partial<TimetableSlot> & { id: string }): TimetableSlot {
  return {
    dayOfWeek: 1, periodNumber: 1, startTime: '08:00', endTime: '09:00',
    subject: 'Matematica', className: '1A', isProvisional: false, ...over,
  };
}

// ---------------------------------------------------------------------------
// Harness
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
const findById = (r: any, id: string) => r.root.findAll((el: any) => el.props?.id === id);
function byId(r: any, id: string) {
  const found = findById(r, id);
  assert.ok(found.length > 0, `id "${id}" assente`);
  return found[0];
}
const hasId = (r: any, id: string) => findById(r, id).length > 0;
const formOf = (r: any) => {
  const forms = r.root.findAll((el: any) => el.type === 'form');
  assert.equal(forms.length, 1, 'modale lezione aperto');
  return forms[0];
};
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
    timeSlotConfig,
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
/** Apre la lezione il cui testo contiene `subject`. */
async function openLesson(r: any, subject: string) {
  const cell = lessonCells(r).find((c: any) => flatText(c).includes(subject));
  assert.ok(cell, `lezione "${subject}" non trovata in griglia`);
  await act(async () => { cell!.props.onClick(); });
}
const setDay = async (r: any, day: string) => {
  await act(async () => { byId(r, 'slot-day').props.onChange({ target: { value: day } }); });
};
const setPeriod = async (r: any, period: string) => {
  await act(async () => { byId(r, 'slot-period').props.onChange({ target: { value: period } }); });
};
const setSlotSchool = async (r: any, id: string) => {
  await act(async () => { byId(r, 'slot-school').props.onChange({ target: { value: id } }); });
};
const submit = async (r: any) => {
  await act(async () => { await formOf(r).props.onSubmit({ preventDefault() {} }); });
};
const conflictShown = (r: any) => hasId(r, 'slot-conflict-error');

// ---------------------------------------------------------------------------
// 1. Cambio istituto (G5) su coordinata occupata
// ---------------------------------------------------------------------------

test('H1/1+9+10. G5: spostare A/Lun1 su B dove esiste già B/Lun1 è bloccato', async () => {
  const saved: TimetableSlot[] = [];
  const a = lesson({ id: 'a1', subject: 'MateA', schoolId: PRIMARY_ID });
  const b = lesson({ id: 'b1', subject: 'LatinoB', schoolId: SCHOOL_B_ID });
  const timetable = [a, b];
  const r = await renderEditor({
    definitiveTimetable: timetable,
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r, 'MateA');
    await setSlotSchool(r, SCHOOL_B_ID);
    await submit(r);

    assert.equal(saved.length, 0, 'nessuna scrittura');
    assert.ok(conflictShown(r), 'errore inline visibile');
    assert.equal(flatText(byId(r, 'slot-conflict-error')), DUPLICATE_SLOT_ERROR);
    assert.equal(byId(r, 'slot-conflict-error').props.role, 'alert');
    assert.equal(formOf(r) && true, true, 'il modale resta aperto per correggere');
    // Gli slot originali non sono stati toccati.
    assert.deepEqual(timetable, [a, b]);
    assert.equal(a.schoolId, PRIMARY_ID);
  } finally { await act(async () => { r.unmount(); }); }
});

test('H1/11. corretta l ora, lo stesso spostamento riesce', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [
      lesson({ id: 'a1', subject: 'MateA', schoolId: PRIMARY_ID }),
      lesson({ id: 'b1', subject: 'LatinoB', schoolId: SCHOOL_B_ID }),
    ],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r, 'MateA');
    await setSlotSchool(r, SCHOOL_B_ID);
    await submit(r);
    assert.ok(conflictShown(r), 'prima bloccato');

    // L'utente sposta la lezione alla 2ª ora: la coordinata è libera.
    await setPeriod(r, '2');
    await submit(r);
    assert.equal(saved.length, 1, 'ora si salva');
    assert.equal(saved[0].schoolId, SCHOOL_B_ID);
    assert.equal(saved[0].periodNumber, 2);
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 2-3. Cambio giorno e cambio ora
// ---------------------------------------------------------------------------

test('H1/2. cambio giorno su coordinata occupata: bloccato', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [
      lesson({ id: 'mar3', dayOfWeek: 2, periodNumber: 3, subject: 'Occupata', schoolId: SCHOOL_B_ID }),
      lesson({ id: 'lun3', dayOfWeek: 1, periodNumber: 3, subject: 'DaSpostare', schoolId: SCHOOL_B_ID }),
    ],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openLesson(r, 'DaSpostare');
    await setDay(r, '2');
    await submit(r);
    assert.equal(saved.length, 0);
    assert.ok(conflictShown(r));
  } finally { await act(async () => { r.unmount(); }); }
});

test('H1/3. cambio ora su coordinata occupata: bloccato', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [
      lesson({ id: 'lun4', periodNumber: 4, subject: 'Occupata', schoolId: SCHOOL_B_ID }),
      lesson({ id: 'lun3', periodNumber: 3, subject: 'DaSpostare', schoolId: SCHOOL_B_ID }),
    ],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openLesson(r, 'DaSpostare');
    await setPeriod(r, '4');
    await submit(r);
    assert.equal(saved.length, 0);
    assert.ok(conflictShown(r));
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 4-5. Nessun falso positivo
// ---------------------------------------------------------------------------

test('H1/4. risalvare la stessa lezione senza spostarla NON è un conflitto con sé stessa', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 'solo', subject: 'Unica', schoolId: SCHOOL_B_ID })],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openLesson(r, 'Unica');
    await submit(r);
    assert.equal(saved.length, 1, 'salvata');
    assert.equal(conflictShown(r), false);
  } finally { await act(async () => { r.unmount(); }); }
});

test('H1/5. stessa coordinata ma istituti diversi: resta consentito (F2/F5 protetti)', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [
      lesson({ id: 'a1', subject: 'MateA', schoolId: PRIMARY_ID }),
      lesson({ id: 'b1', subject: 'LatinoB', schoolId: SCHOOL_B_ID }),
    ],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    // Due lezioni sulla stessa coordinata in scuole diverse convivono già:
    // risalvarne una non deve essere bloccato.
    await openLesson(r, 'MateA');
    await submit(r);
    assert.equal(saved.length, 1, 'la sovrapposizione fra istituti è legittima');
    assert.equal(conflictShown(r), false);
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 6-7. Identità canonica: legacy e orfani
// ---------------------------------------------------------------------------

test('H1/6. lezione legacy e lezione esplicita della primaria occupano la stessa coordinata', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [
      lesson({ id: 'legacy', subject: 'Legacy' }),                                   // senza schoolId
      lesson({ id: 'expl', periodNumber: 2, subject: 'Esplicita', schoolId: PRIMARY_ID }),
    ],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    // La esplicita (primaria) si sposta sulla 1ª, dove c'è la legacy: stessa
    // scuola effettiva, quindi conflitto.
    await openLesson(r, 'Esplicita');
    await setPeriod(r, '1');
    await submit(r);
    assert.equal(saved.length, 0, 'legacy == primaria: conflitto riconosciuto');
    assert.ok(conflictShown(r));
  } finally { await act(async () => { r.unmount(); }); }
});

test('H1/7. lezione con istituto orfano e lezione della primaria: stessa coordinata = conflitto', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [
      lesson({ id: 'orphan', subject: 'Orfana', schoolId: 'school-rimossa' }),
      lesson({ id: 'expl', periodNumber: 2, subject: 'Esplicita', schoolId: PRIMARY_ID }),
    ],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r, 'Esplicita');
    await setPeriod(r, '1');
    await submit(r);
    assert.equal(saved.length, 0, 'orfano ricade sulla primaria: conflitto');
    assert.ok(conflictShown(r));
  } finally { await act(async () => { r.unmount(); }); }
});

test('H1/7b. una lezione orfana NON entra in conflitto con una della secondaria', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [
      lesson({ id: 'orphan', subject: 'Orfana', schoolId: 'school-rimossa' }),
      lesson({ id: 'b2', periodNumber: 2, subject: 'SecondB', schoolId: SCHOOL_B_ID }),
    ],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openLesson(r, 'SecondB');
    await setPeriod(r, '1');
    await submit(r);
    assert.equal(saved.length, 1, 'orfana sta nella primaria: nessun conflitto con B');
    assert.equal(conflictShown(r), false);
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 8. Creazione: secondo livello di sicurezza
// ---------------------------------------------------------------------------

test('H1/8. anche una nuova lezione è fermata se la coordinata è occupata', async () => {
  // Il "+" non compare su una cella occupata, quindi si arriva qui spostando
  // il draft di una NUOVA lezione su una coordinata già presa: il guard finale
  // non si fida del solo rendering della cella.
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 'occ', periodNumber: 4, subject: 'Occupata', schoolId: PRIMARY_ID })],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    const add = r.root.findAll(
      (el: any) => el.type === 'button' && String(el.props?.title ?? '') === 'Aggiungi lezione Lunedì 2ª Ora',
    )[0];
    assert.ok(add, 'cella libera disponibile');
    await act(async () => { add.props.onClick(); });

    // Si sposta il draft sulla 4ª, che è occupata.
    await setPeriod(r, '4');
    const classSelect = formOf(r).findAllByType('select').find((el: any) => el.props.id === undefined);
    if (classSelect) await act(async () => { classSelect.props.onChange({ target: { value: '1A' } }); });
    await submit(r);

    assert.equal(saved.length, 0, 'nessuna nuova lezione duplicata');
    assert.ok(conflictShown(r));
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 12. Provvisorio e definitivo sono indipendenti
// ---------------------------------------------------------------------------

test('H1/12. la stessa coordinata nell ALTRO archivio non blocca il salvataggio', async () => {
  const saved: Array<{ slot: TimetableSlot; type: string }> = [];
  const r = await renderEditor({
    // Stessa scuola, stesso giorno, stessa ora: una nel provvisorio, una nel
    // definitivo. Sono pianificazioni alternative, non un duplicato.
    provisionalTimetable: [lesson({ id: 'prov', subject: 'Prov', schoolId: PRIMARY_ID, isProvisional: true })],
    definitiveTimetable: [lesson({ id: 'def', subject: 'Def', schoolId: PRIMARY_ID })],
    onSaveSlot: (slot: TimetableSlot, type: string) => { saved.push({ slot, type }); },
  });
  try {
    await openLesson(r, 'Def');
    await submit(r);
    assert.equal(saved.length, 1, 'il definitivo si salva nonostante il provvisorio occupi la stessa coordinata');
    assert.equal(saved[0].type, 'definitivo');
    assert.equal(conflictShown(r), false);
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// Non-regressione
// ---------------------------------------------------------------------------

test('H1/extra. con una sola scuola il guard vale comunque', async () => {
  const saved: TimetableSlot[] = [];
  const r = await renderEditor({
    profile: singleSchool,
    definitiveTimetable: [
      lesson({ id: 'occ', periodNumber: 2, subject: 'Occupata', schoolId: PRIMARY_ID }),
      lesson({ id: 'mov', periodNumber: 1, subject: 'DaSpostare', schoolId: PRIMARY_ID }),
    ],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    await openLesson(r, 'DaSpostare');
    await setPeriod(r, '2');
    await submit(r);
    assert.equal(saved.length, 0);
    assert.ok(conflictShown(r));
  } finally { await act(async () => { r.unmount(); }); }
});

test('H1/extra2. l avviso non sopravvive all apertura di un altra lezione', async () => {
  const r = await renderEditor({
    definitiveTimetable: [
      lesson({ id: 'occ', periodNumber: 2, subject: 'Occupata', schoolId: PRIMARY_ID }),
      lesson({ id: 'mov', periodNumber: 1, subject: 'DaSpostare', schoolId: PRIMARY_ID }),
    ],
  });
  try {
    await openLesson(r, 'DaSpostare');
    await setPeriod(r, '2');
    await submit(r);
    assert.ok(conflictShown(r), 'errore mostrato');
    // Chiudo e apro un'altra lezione: nessun avviso ereditato.
    await act(async () => { r.root.findAll((el: any) => el.props?.['aria-label'] === 'Chiudi')[0].props.onClick(); });
    await openLesson(r, 'Occupata');
    assert.equal(conflictShown(r), false, 'avviso azzerato');
  } finally { await act(async () => { r.unmount(); }); }
});
