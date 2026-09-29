import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PERIODS_PER_DAY,
  extraPeriodsForDay,
  maxPeriodsInWeek,
  ordinaryPeriodsPerDay,
  periodsByDay,
  periodsForDay,
} from '../src/utils/schoolDayPeriods';
import { MAX_GRID_PERIODS } from '../src/utils/timetableAnalysis';
import { generateDefaultPeriodSlots, getEffectivePeriodSlots } from '../src/utils/timeSlots';
import { normalizeTeacherProfile } from '../src/utils/multiSchool';
import { isValidProfilePayload } from '../src/services/sync/remoteSchema';
import { validateBackup } from '../src/services/backup';
import type { SchoolProfile, SchoolWeekday, TeacherProfile, TimeSlotConfig } from '../src/types';

/*
 * STRUTTURA DELLA GIORNATA SCOLASTICA (SchoolProfile.dayPeriods).
 *
 * Concetto distinto dal carico del docente: weeklyDeclaredHours e weeklyHours
 * non entrano MAI in questi calcoli. Qui si risponde a "quante ore ha il
 * giovedì in questa scuola", non a "quante ne lavora il docente".
 *
 * Invariante di retrocompatibilità: senza dayPeriods il numero di ore di ogni
 * giorno è getEffectivePeriodSlots(timeSlotConfig).length — NON la costante 6.
 */

const WEEK: SchoolWeekday[] = [1, 2, 3, 4, 5];

function school(dayPeriods?: SchoolProfile['dayPeriods']): SchoolProfile {
  return { id: 'school-1', name: 'IC Da Vinci', isPrimary: true, active: true, dayPeriods };
}

/** Configurazione oraria con N fasce esplicite (customSlots), come la salva l'editor. */
function configWithSlots(count: number): TimeSlotConfig {
  return {
    firstHourStartTime: '07:50',
    periodsPerDay: count,
    standardDurationMinutes: 60,
    customSlots: generateDefaultPeriodSlots('07:50', count, 60),
  };
}

// ---------------------------------------------------------------------------
// 1-2. Legacy: nessun dayPeriods → si segue la configurazione oraria esistente
// ---------------------------------------------------------------------------

test('legacy senza dayPeriods con config a 6 fasce: ogni giorno ha 6 ore', () => {
  const config = configWithSlots(6);
  assert.deepEqual(periodsByDay(WEEK, school(), config), [6, 6, 6, 6, 6]);
  assert.equal(periodsForDay(4, school(), config), 6);
  assert.equal(maxPeriodsInWeek(WEEK, school(), config), 6);
});

test('legacy senza dayPeriods con config a 7 fasce: ogni giorno ha 7 ore (non 6 forzato)', () => {
  const config = configWithSlots(7);
  assert.deepEqual(periodsByDay(WEEK, school(), config), [7, 7, 7, 7, 7]);
  assert.equal(ordinaryPeriodsPerDay(school(), config), 7);
});

test('legacy: il fallback e esattamente getEffectivePeriodSlots().length, customSlots inclusi', () => {
  // customSlots vince su periodsPerDay in getEffectivePeriodSlots: il fallback
  // deve seguire la stessa regola, altrimenti un orario custom cambierebbe
  // comportamento solo per aver introdotto questo modello.
  const incoherent: TimeSlotConfig = {
    firstHourStartTime: '08:00',
    periodsPerDay: 6,
    standardDurationMinutes: 55,
    customSlots: generateDefaultPeriodSlots('08:00', 5, 55),
  };
  assert.equal(getEffectivePeriodSlots(incoherent).length, 5);
  assert.equal(ordinaryPeriodsPerDay(school(), incoherent), 5);
  assert.deepEqual(periodsByDay(WEEK, school(), incoherent), [5, 5, 5, 5, 5]);
});

test('nessuna config oraria: si applica il default dell app (6), senza costanti locali', () => {
  assert.equal(ordinaryPeriodsPerDay(undefined, undefined), getEffectivePeriodSlots(undefined).length);
  assert.equal(ordinaryPeriodsPerDay(undefined, undefined), 6);
});

// ---------------------------------------------------------------------------
// 3-6. Ordinario + ore aggiuntive per singolo giorno
// ---------------------------------------------------------------------------

test('ordinary=6 senza extra: tutti i giorni a 6', () => {
  const s = school({ ordinaryPeriodsPerDay: 6 });
  assert.deepEqual(periodsByDay(WEEK, s), [6, 6, 6, 6, 6]);
});

test('ordinary=6 con giovedi +1: 6/6/6/7/6', () => {
  const s = school({ ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } });
  assert.deepEqual(periodsByDay(WEEK, s), [6, 6, 6, 7, 6]);
  assert.equal(periodsForDay(4, s), 7);
});

test('ordinary=6 con mercoledi +2 (ottava ora): 6/6/8/6/6', () => {
  const s = school({ ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 3: 2 } });
  assert.deepEqual(periodsByDay(WEEK, s), [6, 6, 8, 6, 6]);
});

test('configurazione generica 6/6/8/6/7: nessuna soluzione speciale "settima ora"', () => {
  const s = school({ ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 3: 2, 5: 1 } });
  assert.deepEqual(periodsByDay(WEEK, s), [6, 6, 8, 6, 7]);
});

test('i giorni non configurati restano al valore ordinario, sabato incluso', () => {
  const s = school({ ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } });
  assert.deepEqual(periodsByDay([1, 2, 3, 4, 5, 6], s), [6, 6, 6, 7, 6, 6]);
  assert.equal(periodsForDay(6, s), 6);
});

// ---------------------------------------------------------------------------
// 7. Multi-istituto: due scuole, due strutture giornaliere
// ---------------------------------------------------------------------------

test('due SchoolProfile producono mappe diverse con la stessa configurazione oraria', () => {
  const config = configWithSlots(6);
  const primary: SchoolProfile = { id: 'a', name: 'Istituto A', dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } } };
  const secondary: SchoolProfile = { id: 'b', name: 'Istituto B', dayPeriods: { ordinaryPeriodsPerDay: 5, extraPeriodsByDay: { 2: 2 } } };
  assert.deepEqual(periodsByDay(WEEK, primary, config), [6, 6, 6, 7, 6]);
  assert.deepEqual(periodsByDay(WEEK, secondary, config), [5, 7, 5, 5, 5]);
});

// ---------------------------------------------------------------------------
// 8-10. Valori sporchi e tetto giornaliero
// ---------------------------------------------------------------------------

test('extra negativo vale 0: non toglie mai ore', () => {
  const s = school({ ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: -3 } });
  assert.equal(extraPeriodsForDay(4, s), 0);
  assert.equal(periodsForDay(4, s), 6);
});

test('extra non intero o non numerico vale 0 (nessun NaN, nessun crash)', () => {
  const dirty = { 1: 1.5, 2: NaN, 3: Infinity, 4: '2', 5: null } as unknown as Record<SchoolWeekday, number>;
  const s = school({ ordinaryPeriodsPerDay: 6, extraPeriodsByDay: dirty });
  assert.deepEqual(periodsByDay(WEEK, s), [6, 6, 6, 6, 6]);
  assert.ok(periodsByDay(WEEK, s).every(Number.isInteger));
});

test('ordinary non valido ricade sul legacy invece di propagare il valore sporco', () => {
  const config = configWithSlots(7);
  for (const bad of [0, -4, 6.5, NaN, '6', null, undefined]) {
    const s = school({ ordinaryPeriodsPerDay: bad as unknown as number });
    assert.equal(ordinaryPeriodsPerDay(s, config), 7, `ordinary=${String(bad)}`);
  }
});

test('base + extra oltre il tetto viene limitato a 12', () => {
  const s = school({ ordinaryPeriodsPerDay: 11, extraPeriodsByDay: { 4: 5 } });
  assert.equal(periodsForDay(4, s), MAX_PERIODS_PER_DAY);
  assert.equal(periodsForDay(1, s), 11);
  const huge = school({ ordinaryPeriodsPerDay: 40 });
  assert.equal(periodsForDay(1, huge), MAX_PERIODS_PER_DAY);
});

test('il tetto giornaliero resta allineato al limite gia in vigore nello scanner', () => {
  assert.equal(MAX_PERIODS_PER_DAY, MAX_GRID_PERIODS);
  assert.equal(MAX_PERIODS_PER_DAY, 12);
});

// ---------------------------------------------------------------------------
// 11-14. Contratto delle funzioni
// ---------------------------------------------------------------------------

test('maxPeriodsInWeek su 6/6/6/7/6 vale 7', () => {
  const s = school({ ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } });
  assert.equal(maxPeriodsInWeek(WEEK, s), 7);
  assert.equal(maxPeriodsInWeek([1, 2, 3, 5], s), 6, 'escludendo il giovedi il massimo torna 6');
  assert.equal(maxPeriodsInWeek([], s), 6, 'nessun giorno: si restituisce l ordinario, mai 0');
});

test('periodsByDay conserva l ordine richiesto, duplicati compresi', () => {
  const s = school({ ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1, 2: 2 } });
  assert.deepEqual(periodsByDay([4, 1, 2, 4], s), [7, 6, 8, 7]);
  assert.deepEqual(periodsByDay([], s), []);
});

test('school undefined: comportamento legacy identico a scuola senza dayPeriods', () => {
  const config = configWithSlots(7);
  assert.deepEqual(periodsByDay(WEEK, undefined, config), periodsByDay(WEEK, school(), config));
  assert.equal(periodsForDay(4, undefined, config), 7);
});

test('dayPeriods parziale: solo ordinary, oppure solo extra', () => {
  const config = configWithSlots(6);
  assert.deepEqual(periodsByDay(WEEK, school({ ordinaryPeriodsPerDay: 8 }), config), [8, 8, 8, 8, 8]);
  // Senza ordinary l extra si somma alla base legacy dedotta dalla config.
  assert.deepEqual(periodsByDay(WEEK, school({ extraPeriodsByDay: { 4: 1 } }), config), [6, 6, 6, 7, 6]);
  assert.deepEqual(periodsByDay(WEEK, school({}), config), [6, 6, 6, 6, 6]);
});

test('le ore del docente non influenzano la struttura della giornata', () => {
  const config = configWithSlots(6);
  const loaded: SchoolProfile = { id: 'a', name: 'A', weeklyHours: 18, dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } } };
  const light: SchoolProfile = { id: 'b', name: 'B', weeklyHours: 4, dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } } };
  assert.deepEqual(periodsByDay(WEEK, loaded, config), periodsByDay(WEEK, light, config));
});

// ---------------------------------------------------------------------------
// 15. Persistenza: round-trip e validazione di shape
// ---------------------------------------------------------------------------

const baseProfile: TeacherProfile = {
  id: 't-1',
  fullName: 'Felice Manganiello',
  schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Sostegno'],
  classes: ['3D'],
  campuses: ['Sede Centrale'],
  roles: [],
};

test('normalizeTeacherProfile preserva dayPeriods su primaria e secondaria ed e idempotente', () => {
  const profile: TeacherProfile = {
    ...baseProfile,
    schools: [
      { id: 'a', name: 'IC Da Vinci', isPrimary: true, active: true, dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } } },
      { id: 'b', name: 'Istituto B', isPrimary: false, active: true, dayPeriods: { ordinaryPeriodsPerDay: 5 } },
    ],
  };
  const once = normalizeTeacherProfile(profile);
  assert.deepEqual(once.schools?.[0].dayPeriods, { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } });
  assert.deepEqual(once.schools?.[1].dayPeriods, { ordinaryPeriodsPerDay: 5 });
  assert.deepEqual(normalizeTeacherProfile(once), once);
});

test('un profilo legacy senza dayPeriods resta valido dopo la normalizzazione', () => {
  const normalized = normalizeTeacherProfile({ ...baseProfile });
  assert.equal(normalized.schools?.[0].dayPeriods, undefined);
  assert.deepEqual(periodsByDay(WEEK, normalized.schools?.[0], configWithSlots(6)), [6, 6, 6, 6, 6]);
});

test('round-trip JSON (backup/cloud): dayPeriods sopravvive alla serializzazione', () => {
  const profile = normalizeTeacherProfile({
    ...baseProfile,
    schools: [{ id: 'a', name: 'IC Da Vinci', isPrimary: true, active: true, dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 3: 2, 4: 1 } } }],
  });
  const restored = JSON.parse(JSON.stringify(profile)) as TeacherProfile;
  assert.deepEqual(restored.schools?.[0].dayPeriods, { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 3: 2, 4: 1 } });
  assert.deepEqual(periodsByDay(WEEK, restored.schools?.[0]), [6, 6, 8, 7, 6]);
});


/*
 * PARITA DEI CONTRATTI: backup e sincronizzazione devono accettare e rifiutare
 * ESATTAMENTE gli stessi dayPeriods.
 *
 * Erano divergenti: il backup non aveva alcun massimo, quindi un profilo con
 * ordinaryPeriodsPerDay: 40 passava l'import e veniva poi rifiutato dal remote
 * schema (1..12) — dato importabile ma non sincronizzabile. Le utility clampano
 * comunque a 12, ma il clamp non e un contratto di validazione: i due validatori
 * restano indipendenti e sono questi casi a tenerli allineati.
 */

const schoolWith = (dayPeriods?: unknown) => ({
  id: 'a', name: 'IC Da Vinci', isPrimary: true, active: true,
  ...(dayPeriods === undefined ? {} : { dayPeriods }),
});
const profileWith = (dayPeriods?: unknown) => ({ ...baseProfile, schools: [schoolWith(dayPeriods)] });
const backupWith = (dayPeriods?: unknown) => ({
  version: 3,
  profile: profileWith(dayPeriods),
  events: [], circulars: [], students: [], definitiveTimetable: [], provisionalTimetable: [],
  timetableMode: 'auto', onboardingCompleted: true,
});
const backupAccepts = (dayPeriods?: unknown): boolean => {
  try { validateBackup(backupWith(dayPeriods)); return true; } catch { return false; }
};
const remoteAccepts = (dayPeriods?: unknown): boolean => isValidProfilePayload(profileWith(dayPeriods));

/** Casi esercitati sui DUE validatori: stesso input, stesso verdetto atteso. */
const DAY_PERIODS_CONTRACT: Array<{ label: string; value: unknown; valid: boolean }> = [
  { label: 'dayPeriods assente (legacy)', value: undefined, valid: true },
  { label: 'dayPeriods vuoto', value: {}, valid: true },
  { label: 'configurazione reale: ordinary 6 + giovedi +1', value: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } }, valid: true },
  { label: 'ordinary 1 (minimo)', value: { ordinaryPeriodsPerDay: 1 }, valid: true },
  { label: 'ordinary 12 (massimo)', value: { ordinaryPeriodsPerDay: 12 }, valid: true },
  { label: 'ordinary 13 (oltre il tetto)', value: { ordinaryPeriodsPerDay: 13 }, valid: false },
  { label: 'ordinary 40 (oltre il tetto)', value: { ordinaryPeriodsPerDay: 40 }, valid: false },
  { label: 'ordinary 0', value: { ordinaryPeriodsPerDay: 0 }, valid: false },
  { label: 'ordinary negativo', value: { ordinaryPeriodsPerDay: -6 }, valid: false },
  { label: 'ordinary decimale', value: { ordinaryPeriodsPerDay: 6.5 }, valid: false },
  { label: 'ordinary stringa', value: { ordinaryPeriodsPerDay: 'sei' }, valid: false },
  { label: 'extra 0 (minimo)', value: { extraPeriodsByDay: { 4: 0 } }, valid: true },
  { label: 'extra 11 (massimo)', value: { extraPeriodsByDay: { 4: 11 } }, valid: true },
  { label: 'extra 12 (oltre il massimo)', value: { extraPeriodsByDay: { 4: 12 } }, valid: false },
  { label: 'extra negativo', value: { extraPeriodsByDay: { 4: -1 } }, valid: false },
  { label: 'extra decimale', value: { extraPeriodsByDay: { 4: 1.5 } }, valid: false },
  { label: 'giorni 1..6 tutti configurati', value: { extraPeriodsByDay: { 1: 0, 2: 1, 3: 2, 4: 1, 5: 0, 6: 3 } }, valid: true },
  { label: 'giorno 0 (fuori scala)', value: { extraPeriodsByDay: { 0: 1 } }, valid: false },
  { label: 'giorno 7 (fuori scala)', value: { extraPeriodsByDay: { 7: 1 } }, valid: false },
  { label: 'giorno 9 (fuori scala)', value: { extraPeriodsByDay: { 9: 1 } }, valid: false },
  { label: 'dayPeriods non oggetto', value: '6', valid: false },
  { label: 'extraPeriodsByDay non oggetto', value: { extraPeriodsByDay: 1 }, valid: false },
];

for (const { label, value, valid } of DAY_PERIODS_CONTRACT) {
  test(`contratto dayPeriods coerente backup/remote — ${label}`, () => {
    assert.equal(backupAccepts(value), valid, `backup su: ${label}`);
    assert.equal(remoteAccepts(value), valid, `remote su: ${label}`);
    assert.equal(backupAccepts(value), remoteAccepts(value), `backup e remote divergono su: ${label}`);
  });
}

test('il tetto dei validatori coincide con il clamp delle utility', () => {
  // 12 e accettato dai validatori ed e anche il massimo che le utility possono produrre.
  assert.equal(remoteAccepts({ ordinaryPeriodsPerDay: MAX_PERIODS_PER_DAY }), true);
  assert.equal(backupAccepts({ ordinaryPeriodsPerDay: MAX_PERIODS_PER_DAY }), true);
  assert.equal(remoteAccepts({ ordinaryPeriodsPerDay: MAX_PERIODS_PER_DAY + 1 }), false);
  assert.equal(backupAccepts({ ordinaryPeriodsPerDay: MAX_PERIODS_PER_DAY + 1 }), false);
  // Massimo raggiungibile da una configurazione valida: 12 ordinarie, oppure 1 + 11 extra.
  assert.equal(periodsForDay(4, { dayPeriods: { ordinaryPeriodsPerDay: 1, extraPeriodsByDay: { 4: 11 } } }), MAX_PERIODS_PER_DAY);
});
