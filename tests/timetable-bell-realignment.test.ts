import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TimetableEditor } from '../src/components/TimetableEditor';
import { planTimeSlotRealignment } from '../src/utils/timeSlots';
import { legacyPrimarySchoolId, normalizeTeacherProfile } from '../src/utils/multiSchool';
import { calculateSlotMinutes } from '../src/utils/timetableCongruence';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/**
 * MICRO-PASSO G4 — RIALLINEARE LE LEZIONI QUANDO CAMBIANO LE CAMPANE.
 *
 * Gli orari vivono copiati dentro ogni lezione: dopo G2/G3 un istituto può
 * cambiare le proprie fasce, ma le lezioni già salvate restano sugli orari
 * vecchi. Finché le campane erano uniche il caso era raro; ora è la norma.
 *
 * G4 chiude il cerchio senza tradire l'utente: niente aggiornamenti silenziosi
 * (alcuni orari potrebbero essere stati messi a mano), ma una scelta esplicita
 * fra salvare solo le fasce e aggiornare anche le lezioni.
 *
 * Restano fuori: cambio istituto di una lezione (G5) e orari derivati a
 * runtime, esclusi dall'AUDIT G.
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
/** Nuove campane di B: stessa griglia ma spostata di 15 minuti. */
const configBShifted = config(8, '08:15', 60);

const schoolA = (over: Partial<SchoolProfile> = {}): SchoolProfile => ({
  id: PRIMARY_ID, name: 'IC Rossi', isPrimary: true, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 6 }, ...over,
});
const schoolB = (over: Partial<SchoolProfile> = {}): SchoolProfile => ({
  id: SCHOOL_B_ID, name: 'Liceo Verdi', isPrimary: false, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 8 }, ...over,
});

const profileWith = (schools: SchoolProfile[]): TeacherProfile => ({ ...baseProfile, schools });
const twoSchools = profileWith([schoolA(), schoolB()]);
const singleSchool = profileWith([schoolA()]);
const schoolsOf = (profile: TeacherProfile) => normalizeTeacherProfile(profile).schools ?? [];

function lesson(over: Partial<TimetableSlot> & { id: string }): TimetableSlot {
  return {
    dayOfWeek: 1, periodNumber: 3, startTime: '10:00', endTime: '11:00',
    subject: 'Matematica', className: '1A', isProvisional: false, ...over,
  };
}

// ---------------------------------------------------------------------------
// 1-8. Planner puro
// ---------------------------------------------------------------------------

test('G4/1-2. candidato solo se gli orari cambierebbero davvero', () => {
  const schools = schoolsOf(twoSchools);
  const stale = lesson({ id: 'b3', schoolId: SCHOOL_B_ID, startTime: '10:00', endTime: '11:00' });
  // La 3ª di B nella nuova config è 10:15-11:15.
  const aligned = lesson({ id: 'b3ok', schoolId: SCHOOL_B_ID, startTime: '10:15', endTime: '11:15' });

  const plan = planTimeSlotRealignment([stale, aligned], schoolB(), schools, configBShifted);
  assert.deepEqual(plan.affected.map(s => s.id), ['b3'], 'solo la lezione disallineata');
  assert.equal(plan.updated.find(s => s.id === 'b3')?.startTime, '10:15');
  assert.equal(plan.updated.find(s => s.id === 'b3')?.endTime, '11:15');
  // Quella già a posto non viene nemmeno riscritta: stesso riferimento.
  assert.equal(plan.updated.find(s => s.id === 'b3ok'), aligned, 'nessuna scrittura inutile');
});

test('G4/3. le lezioni di un altro istituto non entrano mai nel piano', () => {
  const schools = schoolsOf(twoSchools);
  const a = lesson({ id: 'a3', schoolId: PRIMARY_ID });
  const b = lesson({ id: 'b3', schoolId: SCHOOL_B_ID });
  const plan = planTimeSlotRealignment([a, b], schoolB(), schools, configBShifted);
  assert.deepEqual(plan.affected.map(s => s.id), ['b3']);
  assert.equal(plan.updated.find(s => s.id === 'a3'), a, 'la lezione di A resta identica');
});

test('G4/4. ore senza fascia nella nuova config: intatte, mai spostate né inventate', () => {
  const schools = schoolsOf(twoSchools);
  // B passa da 8 a 6 fasce: la 7ª e l 8ª non hanno più un orario reale.
  const seventh = lesson({ id: 'b7', periodNumber: 7, startTime: '14:00', endTime: '15:00', schoolId: SCHOOL_B_ID });
  const eighth = lesson({ id: 'b8', periodNumber: 8, startTime: '15:00', endTime: '16:00', schoolId: SCHOOL_B_ID });
  const third = lesson({ id: 'b3', schoolId: SCHOOL_B_ID });

  const plan = planTimeSlotRealignment([seventh, eighth, third], schoolB(), schools, config(6, '08:15', 60));
  assert.deepEqual(plan.affected.map(s => s.id), ['b3'], 'solo la 3ª, che una fascia ce l ha');
  assert.equal(plan.updated.find(s => s.id === 'b7'), seventh, '7ª intatta');
  assert.equal(plan.updated.find(s => s.id === 'b8'), eighth, '8ª intatta');
  assert.equal(plan.updated.length, 3, 'nessuna lezione eliminata');
});

test('G4/5-6. lezioni legacy e con istituto orfano seguono la PRIMARIA', () => {
  const schools = schoolsOf(twoSchools);
  const legacy = lesson({ id: 'lg' });                                   // nessun schoolId
  const orphan = lesson({ id: 'or', schoolId: 'school-rimossa' });       // id inesistente
  const ofB = lesson({ id: 'b3', schoolId: SCHOOL_B_ID });
  const newPrimary = config(6, '08:30', 60);                             // 3ª = 10:30-11:30

  // Cambiando le campane della PRIMARIA entrano entrambe.
  const primaryPlan = planTimeSlotRealignment([legacy, orphan, ofB], schoolA(), schools, newPrimary);
  assert.deepEqual(primaryPlan.affected.map(s => s.id).sort(), ['lg', 'or']);
  assert.equal(primaryPlan.updated.find(s => s.id === 'lg')?.startTime, '10:30');
  assert.equal(primaryPlan.updated.find(s => s.id === 'or')?.startTime, '10:30');
  assert.equal(primaryPlan.updated.find(s => s.id === 'b3'), ofB, 'quella di B non è toccata');

  // Cambiando quelle di B, invece, non entrano.
  const bPlan = planTimeSlotRealignment([legacy, orphan, ofB], schoolB(), schools, configBShifted);
  assert.deepEqual(bPlan.affected.map(s => s.id), ['b3']);
});

test('G4/7. config CUSTOM: si usano esattamente quegli orari, non una scala rigenerata', () => {
  const schools = schoolsOf(twoSchools);
  const custom: TimeSlotConfig = {
    firstHourStartTime: '08:10', periodsPerDay: 3, standardDurationMinutes: 45,
    customSlots: [
      { periodNumber: 1, label: '1ª Ora', startTime: '08:10', endTime: '08:55' },
      { periodNumber: 2, label: '2ª Ora', startTime: '09:05', endTime: '09:50' },
      { periodNumber: 3, label: '3ª Ora', startTime: '10:20', endTime: '11:05' },
    ],
  };
  const slot = lesson({ id: 'b3', schoolId: SCHOOL_B_ID });
  const plan = planTimeSlotRealignment([slot], schoolB(), schools, custom);
  // 10:20-11:05 ha un buco irregolare prima: una rigenerazione automatica da
  // firstHourStartTime + durata darebbe 09:40-10:25.
  assert.equal(plan.updated[0].startTime, '10:20');
  assert.equal(plan.updated[0].endTime, '11:05');
});

test('G4/8. il planner è puro: non muta gli input', () => {
  const schools = schoolsOf(twoSchools);
  const slot = lesson({ id: 'b3', schoolId: SCHOOL_B_ID });
  const snapshot = { ...slot };
  const input = [slot];
  const plan = planTimeSlotRealignment(input, schoolB(), schools, configBShifted);
  assert.deepEqual(slot, snapshot, 'lo slot originale non è stato toccato');
  assert.deepEqual(input, [slot], 'array in ingresso invariato');
  assert.notEqual(plan.updated[0], slot, 'la versione aggiornata è una copia');
});

test('G4/extra. senza istituto risolvibile non si pianifica nulla', () => {
  const slot = lesson({ id: 'b3', schoolId: SCHOOL_B_ID });
  const plan = planTimeSlotRealignment([slot], undefined, schoolsOf(twoSchools), configBShifted);
  assert.deepEqual(plan.affected, []);
  assert.deepEqual(plan.updated, [slot]);
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

type SaveCall = { schoolId: string; config: TimeSlotConfig; realignment?: { provisional: TimetableSlot[]; definitive: TimetableSlot[] } };

function editorProps(o: Record<string, unknown> = {}) {
  return {
    profile: twoSchools,
    definitiveTimetable: [] as TimetableSlot[],
    provisionalTimetable: [] as TimetableSlot[],
    timetableMode: 'auto' as const,
    activeType: 'definitivo' as const,
    isDefinitiveCompiled: true,
    timeSlotConfig: globalSix,
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
function buttonWithText(r: any, text: string) {
  return r.root.findAll((el: any) => el.type === 'button' && flatText(el).includes(text))[0];
}
async function selectSchool(r: any, schoolId: string) {
  await act(async () => { byId(r, 'timetable-school-select').props.onChange({ target: { value: schoolId } }); });
}
async function openDrawer(r: any) {
  await act(async () => { buttonWithText(r, 'Fasce Orarie').props.onClick(); });
}
/** Sposta l'inizio della 1ª ora nel draft: tutte le fasce slittano. */
async function shiftFirstHour(r: any, value: string) {
  const input = r.root.findAll((el: any) => el.props?.type === 'time')[0];
  await act(async () => { input.props.onChange({ target: { value } }); });
}
async function saveDrawer(r: any) {
  await act(async () => { buttonWithText(r, 'Salva Fasce Orarie').props.onClick(); });
}

// ---------------------------------------------------------------------------
// 9-15. Salvataggio e dialog
// ---------------------------------------------------------------------------

test('G4/9+21. nessuna lezione divergente: si salva subito, senza dialog', async () => {
  const calls: SaveCall[] = [];
  const r = await renderEditor({
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig, realignment?: any) => { calls.push({ schoolId, config, realignment }); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);
    assert.equal(hasId(r, 'realign-dialog'), false, 'nessun attrito quando non c è nulla da riallineare');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].realignment, undefined, 'salvate solo le fasce');
    assert.equal(rootText(r).includes('Configurazione Fasce Orarie'), false, 'drawer chiuso');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G4/10-12. con lezioni divergenti compare il dialog e NIENTE viene scritto prima', async () => {
  const calls: SaveCall[] = [];
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 'b3', schoolId: SCHOOL_B_ID })],
    provisionalTimetable: [
      lesson({ id: 'p1s', schoolId: SCHOOL_B_ID, isProvisional: true }),
      lesson({ id: 'p2s', periodNumber: 2, startTime: '09:00', endTime: '10:00', schoolId: SCHOOL_B_ID, isProvisional: true }),
    ],
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig, realignment?: any) => { calls.push({ schoolId, config, realignment }); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);

    assert.ok(hasId(r, 'realign-dialog'), 'la conferma appare prima di scrivere');
    assert.equal(calls.length, 0, 'nessuna scrittura finché l utente non sceglie');
    const message = flatText(byId(r, 'realign-message'));
    assert.match(message, /3 lezioni/, 'conteggio su provvisorio + definitivo');
    assert.match(message, /Liceo Verdi/, 'dice di quale istituto');
    assert.match(rootText(r), /orari modificati a mano verranno sostituiti/i, 'avverte sugli orari manuali');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G4/13. Annulla: né fasce né lezioni vengono scritte', async () => {
  const calls: SaveCall[] = [];
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 'b3', schoolId: SCHOOL_B_ID })],
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig) => { calls.push({ schoolId, config }); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);
    await act(async () => { byId(r, 'realign-cancel').props.onClick(); });

    assert.equal(calls.length, 0, 'nessun salvataggio');
    assert.equal(hasId(r, 'realign-dialog'), false, 'dialog chiuso');
    assert.match(rootText(r), /Configurazione Fasce Orarie/, 'si resta nel drawer, il draft è ancora lì');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G4/14. "Salva solo le fasce": config aggiornata, lezioni invariate', async () => {
  const calls: SaveCall[] = [];
  const slot = lesson({ id: 'b3', schoolId: SCHOOL_B_ID });
  const r = await renderEditor({
    definitiveTimetable: [slot],
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig, realignment?: any) => { calls.push({ schoolId, config, realignment }); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);
    await act(async () => { byId(r, 'realign-config-only').props.onClick(); });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].schoolId, SCHOOL_B_ID);
    assert.equal(calls[0].config.firstHourStartTime, '08:15');
    assert.equal(calls[0].realignment, undefined, 'le lezioni NON vengono riallineate');
    assert.equal(slot.startTime, '10:00', 'e restano sui loro orari');
    assert.equal(hasId(r, 'realign-dialog'), false);
  } finally { await act(async () => { r.unmount(); }); }
});

test('G4/15+18. "Salva e aggiorna": config + lezioni, ciascuna nel suo archivio', async () => {
  const calls: SaveCall[] = [];
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 'def3', schoolId: SCHOOL_B_ID })],
    provisionalTimetable: [lesson({ id: 'prov3', schoolId: SCHOOL_B_ID, isProvisional: true })],
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig, realignment?: any) => { calls.push({ schoolId, config, realignment }); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);
    assert.match(flatText(byId(r, 'realign-message')), /2 lezioni/);
    await act(async () => { byId(r, 'realign-confirm').props.onClick(); });

    assert.equal(calls.length, 1, 'una sola operazione');
    const { realignment } = calls[0];
    assert.ok(realignment, 'le lezioni riallineate viaggiano col salvataggio');
    assert.equal(realignment!.definitive[0].id, 'def3');
    assert.equal(realignment!.definitive[0].startTime, '10:15', 'definitiva aggiornata');
    assert.equal(realignment!.provisional[0].id, 'prov3');
    assert.equal(realignment!.provisional[0].startTime, '10:15', 'provvisoria aggiornata');
    assert.equal(realignment!.provisional[0].isProvisional, true, 'nessuno spostamento fra archivi');
    assert.equal(hasId(r, 'realign-dialog'), false, 'operazione conclusa');
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 16-20. Multi-istituto
// ---------------------------------------------------------------------------

test('G4/16-17. modificando B si toccano solo le lezioni di B', async () => {
  const calls: SaveCall[] = [];
  const r = await renderEditor({
    definitiveTimetable: [
      lesson({ id: 'a3', schoolId: PRIMARY_ID }),
      lesson({ id: 'b3', schoolId: SCHOOL_B_ID }),
    ],
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig, realignment?: any) => { calls.push({ schoolId, config, realignment }); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);
    assert.match(flatText(byId(r, 'realign-message')), /1 lezione/, 'solo quella di B');
    await act(async () => { byId(r, 'realign-confirm').props.onClick(); });

    const { definitive } = calls[0].realignment!;
    assert.equal(definitive.find(s => s.id === 'b3')?.startTime, '10:15', 'B aggiornata');
    assert.equal(definitive.find(s => s.id === 'a3')?.startTime, '10:00', 'A esattamente com era');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G4/19-20. legacy e orfani entrano modificando la primaria, non modificando B', async () => {
  const slots = [
    lesson({ id: 'lg' }),
    lesson({ id: 'or', schoolId: 'school-rimossa' }),
    lesson({ id: 'b3', schoolId: SCHOOL_B_ID }),
  ];
  // Con B selezionata restano fuori.
  let calls: SaveCall[] = [];
  let r = await renderEditor({
    definitiveTimetable: slots,
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig, realignment?: any) => { calls.push({ schoolId, config, realignment }); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);
    assert.match(flatText(byId(r, 'realign-message')), /1 lezione/, 'solo b3');
  } finally { await act(async () => { r.unmount(); }); }

  // Con la primaria selezionata entrano entrambe.
  calls = [];
  r = await renderEditor({
    definitiveTimetable: slots,
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig, realignment?: any) => { calls.push({ schoolId, config, realignment }); },
  });
  try {
    await openDrawer(r);
    await shiftFirstHour(r, '08:30');
    await saveDrawer(r);
    assert.match(flatText(byId(r, 'realign-message')), /2 lezioni/, 'legacy + orfana');
    await act(async () => { byId(r, 'realign-confirm').props.onClick(); });
    const { definitive } = calls[0].realignment!;
    assert.equal(definitive.find(s => s.id === 'lg')?.startTime, '10:30');
    assert.equal(definitive.find(s => s.id === 'or')?.startTime, '10:30');
    assert.equal(definitive.find(s => s.id === 'b3')?.startTime, '10:00', 'B non toccata');
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 21-24. Periodi e orari manuali
// ---------------------------------------------------------------------------

test('G4/22. una fascia aggiunta rende riallineabile una lezione prima orfana di orario', async () => {
  const calls: SaveCall[] = [];
  // La globale ha 6 fasce: la 7ª di B non ne aveva una. Portando B a 8 fasce,
  // la 7ª esiste e la lezione può essere riallineata.
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 'b7', periodNumber: 7, startTime: '13:30', endTime: '14:20', schoolId: SCHOOL_B_ID })],
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig, realignment?: any) => { calls.push({ schoolId, config, realignment }); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    // Il drawer pre-propone le fasce mancanti fino al fabbisogno di B (8 ore).
    await shiftFirstHour(r, '08:00');
    await saveDrawer(r);
    assert.ok(hasId(r, 'realign-dialog'), 'ora la 7ª ha una fascia e diverge');
    await act(async () => { byId(r, 'realign-confirm').props.onClick(); });
    const updated = calls[0].realignment!.definitive.find(s => s.id === 'b7')!;
    assert.equal(updated.startTime, '14:00', '7ª fascia: 08:00 + 6 ore');
    assert.equal(updated.endTime, '15:00');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G4/23. un orario messo a mano è divergente e viene sostituito solo se si conferma', async () => {
  const calls: SaveCall[] = [];
  const manual = lesson({ id: 'b3', schoolId: SCHOOL_B_ID, startTime: '10:20', endTime: '11:20' });
  const r = await renderEditor({
    definitiveTimetable: [manual],
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig, realignment?: any) => { calls.push({ schoolId, config, realignment }); },
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);
    assert.ok(hasId(r, 'realign-dialog'), 'l orario manuale risulta divergente');
    await act(async () => { byId(r, 'realign-confirm').props.onClick(); });
    assert.equal(calls[0].realignment!.definitive[0].startTime, '10:15', 'sostituito dalla nuova fascia');
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 25-26. Errori
// ---------------------------------------------------------------------------

test('G4/25-26. se il salvataggio fallisce non si dichiara successo', async () => {
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 'b3', schoolId: SCHOOL_B_ID })],
    onSaveSchoolTimeSlotConfig: () => false as const,
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);
    await act(async () => { byId(r, 'realign-confirm').props.onClick(); });

    assert.ok(hasId(r, 'realign-dialog'), 'il dialog resta aperto: l operazione non è riuscita');
    assert.match(rootText(r), /Configurazione Fasce Orarie/, 'e il drawer non si chiude');
  } finally { await act(async () => { r.unmount(); }); }
});

// ---------------------------------------------------------------------------
// 27-30. Non-regressione
// ---------------------------------------------------------------------------

test('G4/27. il selettore istituto resta bloccato anche mentre il dialog è aperto', async () => {
  const r = await renderEditor({
    definitiveTimetable: [lesson({ id: 'b3', schoolId: SCHOOL_B_ID })],
    onSaveSchoolTimeSlotConfig: () => {},
  });
  try {
    await selectSchool(r, SCHOOL_B_ID);
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);
    assert.ok(hasId(r, 'realign-dialog'));
    assert.equal(byId(r, 'timetable-school-select').props.disabled, true, 'la scuola non può cambiare a metà operazione');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G4/28+30. wizard globale fuori scope e config globale mai toccata dal drawer', async () => {
  const globalCalls: TimeSlotConfig[] = [];
  const schoolCalls: SaveCall[] = [];
  // Wizard: nessuna config globale -> l'editor mostra il primo avvio e salva
  // ancora la GLOBALE, senza alcun riallineamento.
  const wizard = await renderEditor({
    timeSlotConfig: undefined,
    onSaveTimeSlotConfig: (config: TimeSlotConfig) => { globalCalls.push(config); },
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig) => { schoolCalls.push({ schoolId, config }); },
  });
  try {
    const confirm = buttonWithText(wizard, 'Conferma');
    assert.ok(confirm, 'schermata di primo avvio');
    await act(async () => { confirm.props.onClick(); });
    assert.equal(globalCalls.length, 1, 'il wizard scrive la configurazione globale');
    assert.equal(schoolCalls.length, 0, 'e non tocca gli istituti');
    assert.equal(hasId(wizard, 'realign-dialog'), false, 'nessun riallineamento nel wizard');
  } finally { await act(async () => { wizard.unmount(); }); }
});

test('G4/29. una sola scuola: stessa conferma, senza nome istituto ridondante', async () => {
  const calls: SaveCall[] = [];
  const r = await renderEditor({
    profile: singleSchool,
    definitiveTimetable: [lesson({ id: 'a3', schoolId: PRIMARY_ID })],
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig, realignment?: any) => { calls.push({ schoolId, config, realignment }); },
  });
  try {
    assert.equal(hasId(r, 'timetable-school-select'), false, 'nessun selettore');
    await openDrawer(r);
    await shiftFirstHour(r, '08:15');
    await saveDrawer(r);
    assert.ok(hasId(r, 'realign-dialog'), 'la conferma vale anche con un istituto solo');
    assert.match(flatText(byId(r, 'realign-message')), /1 lezione/);
    await act(async () => { byId(r, 'realign-confirm').props.onClick(); });
    assert.equal(calls[0].schoolId, PRIMARY_ID);
    assert.equal(calls[0].realignment!.definitive[0].startTime, '10:15');
  } finally { await act(async () => { r.unmount(); }); }
});

test('G4/27b. la congruenza oraria riflette i nuovi orari dopo il riallineamento', () => {
  const schools = schoolsOf(twoSchools);
  const slot = lesson({ id: 'b3', schoolId: SCHOOL_B_ID, startTime: '10:00', endTime: '11:00' });
  assert.equal(calculateSlotMinutes(slot), 60);
  // Nuova 3ª fascia di B più corta: 50 minuti.
  const shorter = config(8, '08:15', 50);
  const plan = planTimeSlotRealignment([slot], schoolB(), schools, shorter);
  assert.equal(calculateSlotMinutes(plan.updated[0]), 50, 'la durata segue i nuovi orari, senza toccare la utility');
});
