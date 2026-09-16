import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedPersonalCellCount,
  MAX_GRID_PERIODS,
  PERSONAL_SCHOOL_DAYS,
  personalCellsToCandidates,
  TimetableShapeError,
  validatePersonalSequencePayload,
  type TimetableRawCell,
} from '../src/utils/timetableAnalysis';
import {
  buildPersonalTimetablePrompt,
  parseTimetableAiResponse,
  personalTargetSurname,
} from '../server/timetableAnalysis';
import { crossrefTimetables } from '../src/utils/timetableCrossref';
import { reconstructedToTimetableSlots } from '../src/utils/reconstructTimetable';
import { DAY_LABELS } from '../src/utils/timetableTokens';
import type { TeacherProfile } from '../src/types';

/*
 * Contratto AI dell'ORARIO PERSONALE per blocchi giornalieri:
 * `{ rowLabel, days: [{ cells }, … x 5] }`.
 *
 * Il formato piatto `cells[]` controllava solo il totale delle celle, quindi una
 * lettura spostata di una colonna (venerdì letto come "", 3E, 3D, 3E, "") dava
 * comunque 25 posizioni e veniva salvata sulle coordinate sbagliate. Qui ogni
 * blocco ha una lunghezza verificata: lo stesso errore è un rifiuto.
 */

const profile: TeacherProfile = {
  id: 't-1',
  fullName: 'Felice Manganiello',
  schoolName: 'Istituto Comprensivo Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'],
  campuses: ['Sede Centrale'],
  roles: [{ role: 'docente_sostegno' }],
  isSupportTeacher: true,
};

const TARGET_SURNAME = personalTargetSurname(profile);
const PERIODS = 5;

/** Ground truth della riga Manganiello, giorno per giorno (lunedì → venerdì). */
const GROUND_TRUTH_DAYS: string[][] = [
  ['', '3D', '3D', '3E', '3E'],      // LUNEDÌ
  ['3D', '', '3D', '3D', '3E'],      // MARTEDÌ
  ['', '3E', '3E', '3D', '3E'],      // MERCOLEDÌ
  ['', '3E', '3D', '3E', ''],        // GIOVEDÌ
  ['3E', '3D', '3E', '', ''],        // VENERDÌ
];

/** Sequenza piatta equivalente: ciò che il codice produce dai blocchi. */
const GROUND_TRUTH_FLAT = GROUND_TRUTH_DAYS.flat();

/** Payload conforme al contratto: etichetta della riga + blocchi giornalieri. */
function daysPayload(days: string[][], rowLabel = 'Manganiello F.') {
  return { rowLabel, days: days.map(cells => ({ cells })) };
}

/** Validazione + appiattimento deterministico fatto dal codice. */
function cellsFromDays(days: string[][], periodsPerDay = PERIODS, rowLabel = 'Manganiello F.'): TimetableRawCell[] {
  return validatePersonalSequencePayload(daysPayload(days, rowLabel), TARGET_SURNAME, periodsPerDay).cells;
}

const coord = (cell: TimetableRawCell) => `${cell.dayOfWeek}|${cell.periodIndex}`;

test('A. ground truth: 25 posizioni, 18 occupate, 7 vuote, coordinate esatte', () => {
  assert.equal(GROUND_TRUTH_FLAT.length, expectedPersonalCellCount(PERIODS), 'la ground truth ha le posizioni attese');
  assert.equal(GROUND_TRUTH_FLAT.filter(raw => raw !== '').length, 18, '18 celle occupate');
  assert.equal(GROUND_TRUTH_FLAT.filter(raw => raw === '').length, 7, '7 celle vuote');

  const cells = cellsFromDays(GROUND_TRUTH_DAYS);
  assert.equal(cells.length, 25, 'una cella per posizione fisica, vuoti inclusi');
  assert.equal(cells.filter(c => c.raw.trim()).length, 18, '18 posizioni occupate');
  assert.equal(cells.filter(c => !c.raw.trim()).length, 7, '7 posizioni vuote');

  // Le 25 coordinate, una per una: giorno dall'indice del blocco, periodo
  // dall'indice della cella nel blocco.
  const expected = GROUND_TRUTH_DAYS.flatMap((day, dayIndex) =>
    day.map((raw, cellIndex) => `${dayIndex + 1}|${cellIndex + 1}|${raw}`),
  );
  assert.equal(expected.length, 25);
  assert.deepEqual(cells.map(c => `${c.dayOfWeek}|${c.periodIndex}|${c.raw}`), expected, 'nessuna coordinata spostata');
  assert.ok(cells.every(c => c.rowIndex === 0), 'riga sintetica 0: il modello non dichiara indici di riga');
  assert.deepEqual(
    cells.map((c, index) => (c.dayOfWeek === Math.floor(index / PERIODS) + 1 && c.periodIndex === (index % PERIODS) + 1)),
    Array.from({ length: 25 }, () => true),
    'le coordinate coincidono con la formula posizionale',
  );
});

test('B. venerdì: Ven1=3E, Ven2=3D, Ven3=3E, Ven4 e Ven5 vuote', () => {
  const cells = cellsFromDays(GROUND_TRUTH_DAYS);
  const friday = cells.filter(c => c.dayOfWeek === 5).sort((a, b) => a.periodIndex - b.periodIndex);
  assert.deepEqual(friday.map(c => c.raw), ['3E', '3D', '3E', '', ''], 'il venerdì non è spostato di una colonna');
  assert.deepEqual(friday.map(coord), ['5|1', '5|2', '5|3', '5|4', '5|5'], 'una posizione per ogni ora del venerdì');
  const extraction = personalCellsToCandidates(cells, [0]);
  assert.deepEqual(
    extraction.candidates.filter(c => c.dayOfWeek === 5).map(c => `${c.periodIndex}ª ${c.classLabel}`).sort(),
    ['1ª 3E', '2ª 3D', '3ª 3E'].sort(),
    'candidati del venerdì sulle ore giuste',
  );
  assert.equal(extraction.candidates.some(c => c.dayOfWeek === 5 && c.periodIndex > 3), false, 'nessuna ora inventata in Ven4/Ven5');
});

test('C. quattro blocchi giornalieri -> rifiuto', () => {
  const fourDays = GROUND_TRUTH_DAYS.slice(0, 4);
  assert.throws(() => cellsFromDays(fourDays), /Numero di giorni dell'orario non valido/);
  assert.throws(() => cellsFromDays(fourDays), TimetableShapeError, 'rifiuto tipizzato: 422 e analisi da rifare');
});

test('D. sei blocchi giornalieri -> rifiuto', () => {
  const sixDays = [...GROUND_TRUTH_DAYS, ['', '', '', '', '']];
  assert.throws(() => cellsFromDays(sixDays), /Numero di giorni dell'orario non valido/);
  assert.equal(sixDays.flat().length, 30, 'il totale non giustifica un sesto blocco');
});

test('E. lunghezze 5,5,4,5,6 -> rifiuto nonostante il totale sia 25', () => {
  const drifted: string[][] = [
    GROUND_TRUTH_DAYS[0],
    GROUND_TRUTH_DAYS[1],
    GROUND_TRUTH_DAYS[2].slice(0, 4),              // mercoledì corto di una cella
    GROUND_TRUTH_DAYS[3],
    [...GROUND_TRUTH_DAYS[4], '3E'],               // venerdì lungo di una cella
  ];
  assert.deepEqual(drifted.map(day => day.length), [5, 5, 4, 5, 6], 'geometria dello scenario');
  assert.equal(drifted.flat().length, 25, 'il totale è comunque 25: col formato piatto passava');
  assert.throws(() => cellsFromDays(drifted), /Lunghezza del giorno non valida/);
  assert.throws(() => cellsFromDays(drifted), TimetableShapeError);
});

test('F. un giorno con una cella in meno -> rifiuto (per ogni numero di ore)', () => {
  for (const periods of [1, 4, PERIODS, 6, MAX_GRID_PERIODS]) {
    const days = Array.from({ length: PERSONAL_SCHOOL_DAYS }, (_, dayIndex) =>
      Array.from({ length: periods }, (_, cellIndex) => (dayIndex === 2 && cellIndex === 0 ? '' : '3D')),
    );
    days[2] = days[2].slice(0, periods - 1);
    assert.equal(days.flat().length, expectedPersonalCellCount(periods) - 1);
    assert.throws(() => cellsFromDays(days, periods), /Lunghezza del giorno non valida/, `ore per giorno ${periods}`);
  }
});

test('G. un giorno con una cella in più -> rifiuto (per ogni numero di ore)', () => {
  for (const periods of [1, 4, PERIODS, 6, MAX_GRID_PERIODS]) {
    const days = Array.from({ length: PERSONAL_SCHOOL_DAYS }, (_, dayIndex) =>
      Array.from({ length: periods }, (_, cellIndex) => (dayIndex === 4 && cellIndex === 0 ? '' : '3E')),
    );
    days[4] = [...days[4], '3E'];
    assert.equal(days.flat().length, expectedPersonalCellCount(periods) + 1);
    assert.throws(() => cellsFromDays(days, periods), /Lunghezza del giorno non valida/, `ore per giorno ${periods}`);
  }
});

test('H. vecchio payload piatto { rowLabel, cells } -> rifiuto, nessun fallback', () => {
  const legacy = { rowLabel: 'Manganiello F.', cells: GROUND_TRUTH_FLAT };
  assert.throws(() => validatePersonalSequencePayload(legacy, TARGET_SURNAME, PERIODS), /Formato della risposta non supportato/);
  assert.throws(() => validatePersonalSequencePayload(legacy, TARGET_SURNAME, PERIODS), TimetableShapeError);
  // Nemmeno se i blocchi ci sono: la presenza di `cells` alla radice è ambigua.
  const hybrid = { ...daysPayload(GROUND_TRUTH_DAYS), cells: GROUND_TRUTH_FLAT };
  assert.throws(() => validatePersonalSequencePayload(hybrid, TARGET_SURNAME, PERIODS), /Formato della risposta non supportato/);
  // La forma vuota del vecchio contratto non è accettata nemmeno come "nessuna riga".
  assert.throws(
    () => validatePersonalSequencePayload({ rowLabel: 'Manganiello F.', cells: [] }, TARGET_SURNAME, PERIODS),
    /Formato della risposta non supportato/,
  );
});

test('I. rowLabel incompatibile col docente -> rifiuto, nessuna altra riga scelta', () => {
  for (const wrongRow of ['Bianchi M.', 'Bianchini F.', 'Manganiell', '', 'Materia']) {
    assert.throws(
      () => cellsFromDays(GROUND_TRUTH_DAYS, PERIODS, wrongRow),
      /Riga del documento non compatibile col docente/,
      `deve rifiutare la riga "${wrongRow}"`,
    );
  }
  // Etichette diverse MA compatibili: accettate (stesso matcher, nessun fuzzy nuovo).
  for (const okRow of ['Manganiello F.', 'MANGANIELLO', 'prof. Manganiello Felice', 'manganiello']) {
    assert.equal(cellsFromDays(GROUND_TRUTH_DAYS, PERIODS, okRow).length, 25, `riga "${okRow}" accettata`);
  }
  // Senza cognome nel profilo la riga non è verificabile.
  assert.throws(
    () => validatePersonalSequencePayload(daysPayload(GROUND_TRUTH_DAYS), '', PERIODS),
    /non compatibile/,
  );
});

test('J. vuoto interno: martedì 2ª resta ESATTAMENTE vuota', () => {
  const days: string[][] = [
    ['', '3D', '3D', '3E', '3E'],
    ['3D', '', '3D', '3D', '3E'],   // il vuoto interno è il caso in esame
    ['', '3E', '3E', '3D', '3E'],
    ['', '3E', '3D', '3E', ''],
    ['3E', '3D', '3E', '', ''],
  ];
  const cells = cellsFromDays(days);
  const tuesday = cells.filter(c => c.dayOfWeek === 2).sort((a, b) => a.periodIndex - b.periodIndex);
  assert.deepEqual(tuesday.map(c => c.raw), ['3D', '', '3D', '3D', '3E'], 'nessuno spostamento a sinistra');
  assert.equal(cells.find(c => c.dayOfWeek === 2 && c.periodIndex === 2)?.raw, '', 'Mar2 resta vuota');
  assert.equal(cells.find(c => c.dayOfWeek === 2 && c.periodIndex === 3)?.raw, '3D', 'Mar3 non scala in Mar2');
  const extraction = personalCellsToCandidates(cells, [0]);
  assert.equal(extraction.candidates.some(c => c.dayOfWeek === 2 && c.periodIndex === 2), false, 'nessuna candidata su Mar2');
  assert.deepEqual(extraction.candidates.filter(c => c.dayOfWeek === 2).map(c => c.periodIndex), [1, 3, 4, 5], 'ore di martedì');
  assert.equal(extraction.skipped.length, 0, 'una cella vuota non è una cella «non interpretata»');
  // `null` in una cella vale come cella vuota: comportamento preservato.
  const withNull = validatePersonalSequencePayload(
    { rowLabel: 'Manganiello F.', days: [{ cells: ['3D'] }, { cells: [null] }, { cells: [''] }, { cells: [''] }, { cells: [''] }] },
    TARGET_SURNAME, 1,
  );
  assert.deepEqual(withNull.cells.map(c => c.raw), ['3D', '', '', '', ''], 'null -> "" (stesso fatto nel documento)');
  assert.deepEqual(withNull.cells.map(coord), ['1|1', '2|1', '3|1', '4|1', '5|1'], 'la geometria non dipende dal null');
});

test('K. prompt: ore per giorno reali, intestazione giorni, blocchi, colonne fisiche, celle vuote', () => {
  const prompt = buildPersonalTimetablePrompt(TARGET_SURNAME, PERIODS);
  // Ore per giorno interpolate davvero (mai una costante scritta nel prompt).
  assert.ok(prompt.includes('ESATTAMENTE 5 COLONNE FISICHE'), 'periodsPerDay reale: colonne fisiche per blocco');
  assert.ok(prompt.includes('ESATTAMENTE 5 celle'), 'periodsPerDay reale: celle per giorno');
  assert.ok(prompt.includes('ESATTAMENTE 5 oggetti'), 'periodsPerDay non tocca il numero dei blocchi');
  // Intestazione dei giorni e blocchi fisici.
  assert.ok(prompt.includes("INTESTAZIONE della griglia"), 'si parte dall intestazione');
  assert.ok(prompt.includes('LUNEDÌ, MARTEDÌ, MERCOLEDÌ, GIOVEDÌ, VENERDÌ'), 'i cinque giorni dell intestazione');
  assert.ok(prompt.includes('5 BLOCCHI FISICI giornalieri'), 'cinque blocchi fisici');
  // Colonne fisiche, non solo il testo.
  assert.ok(prompt.includes('Conta le COLONNE DELLA GRIGLIA, non solo le celle che contengono del testo'), 'contare la griglia');
  assert.ok(prompt.includes('anche una colonna senza testo è una posizione e va restituita'), 'colonna vuota = posizione');
  // Celle vuote e divieti.
  assert.ok(prompt.includes('Una cella vuota è la stringa vuota ""'), 'cella vuota = ""');
  assert.ok(prompt.includes("mai omessa e mai spostata all'inizio o alla fine del giorno"), 'vuoto mai spostato');
  assert.ok(prompt.includes('NON comprimere le celle'), 'nessuna compressione');
  assert.ok(prompt.includes('NON spostare i valori a sinistra o a destra'), 'nessuno spostamento laterale');
  assert.ok(prompt.includes('NON compensare una cella mancante in un giorno aggiungendone una in un altro'), 'nessuna compensazione fra giorni');
  // Posizione dentro il blocco, senza indici restituiti.
  assert.ok(prompt.includes('la prima stringa è la 1ª colonna fisica'), 'ordine posizionale dichiarato');
  assert.ok(prompt.includes('non restituire rowIndex, dayOfWeek o periodIndex'), 'il modello non dichiara coordinate');
  // L'esempio di formato mostra 5 blocchi da 5 celle.
  assert.equal(prompt.split('{ "cells": ["", "", "", "", ""] }').length - 1, 5, 'esempio: cinque blocchi da cinque colonne');
  // Con 6 ore il prompt cambia geometria, i blocchi restano cinque.
  const six = buildPersonalTimetablePrompt(TARGET_SURNAME, 6);
  assert.ok(six.includes('ESATTAMENTE 6 COLONNE FISICHE') && six.includes('ESATTAMENTE 6 celle'), '6 ore interpolate');
  assert.ok(!six.includes('ESATTAMENTE 5 celle'), 'nessuna geometria residua');
  assert.equal(six.split('{ "cells": ["", "", "", "", "", ""] }').length - 1, 5, 'cinque blocchi anche con 6 ore');
  // Il prompt personale NON incorpora TABLE_RULES (che resta al curricolare).
  assert.ok(!prompt.includes('rowIndex indica la riga'), 'TABLE_RULES non è incorporato');
  assert.ok(!prompt.includes('periodIndex il numero di periodo ASSOLUTO'), 'TABLE_RULES non è incorporato');
});

test('L. end-to-end: blocchi -> risposta AI validata -> candidati -> crossref -> slot', () => {
  const payload = daysPayload(GROUND_TRUTH_DAYS);
  const outcome = parseTimetableAiResponse('personal-support-timetable', payload, TARGET_SURNAME, PERIODS);
  assert.equal(outcome.rowLabel, 'Manganiello F.', 'etichetta riportata, nessuna coordinata dal modello');
  assert.equal(outcome.cells.length, 25, 'il server appiattisce i blocchi nelle stesse celle di prima');
  assert.deepEqual(outcome.cells.map(c => c.raw), GROUND_TRUTH_FLAT, 'stessa sequenza del contratto precedente');

  const extraction = personalCellsToCandidates(outcome.cells, [0]);
  assert.equal(extraction.candidates.length, 18, 'una candidata per cella occupata');
  assert.equal(extraction.skipped.length, 0);

  const reconstruction = crossrefTimetables(extraction.candidates, []).map(slot => ({ ...slot, correctedClass: slot.classLabel ?? '' }));
  const slots = reconstructedToTimetableSlots(reconstruction, { profile, timeSlotConfig: undefined });
  assert.equal(slots.length, 18, '18 slot salvabili');

  // Coordinate salvate: quelle del documento, comprese le tre ore del venerdì.
  const expected = GROUND_TRUTH_DAYS.flatMap((day, dayIndex) =>
    day.map((raw, cellIndex) => ({ dayOfWeek: dayIndex + 1, periodNumber: cellIndex + 1, raw })),
  ).filter(cell => cell.raw !== '');
  assert.deepEqual(
    slots.map(s => `${s.dayOfWeek}|${s.periodNumber}|${s.className}`).sort(),
    expected.map(cell => `${cell.dayOfWeek}|${cell.periodNumber}|${cell.raw}`).sort(),
    'nessuna ora fuori posto dopo crossref e ricostruzione',
  );
  for (const cell of expected) {
    const slot = slots.find(s => s.dayOfWeek === cell.dayOfWeek && s.periodNumber === cell.periodNumber);
    assert.equal(slot?.className, cell.raw, `${DAY_LABELS[cell.dayOfWeek]} ${cell.periodNumber}ª = ${cell.raw}`);
  }
  for (const [day, period] of [[1, 1], [2, 2], [3, 1], [4, 1], [4, 5], [5, 4], [5, 5]] as Array<[number, number]>) {
    assert.equal(slots.some(s => s.dayOfWeek === day && s.periodNumber === period), false, `${DAY_LABELS[day]} ${period}ª resta vuota`);
  }
});

test('M. regressione: 5,5,4,5,6 fallisce PRIMA della derivazione delle coordinate', () => {
  // La cella persa dal mercoledì è finita in fondo al venerdì: col formato piatto
  // il totale era giusto e l'analisi passava.
  const drifted: string[][] = [
    GROUND_TRUTH_DAYS[0],
    GROUND_TRUTH_DAYS[1],
    GROUND_TRUTH_DAYS[2].slice(0, 4),
    GROUND_TRUTH_DAYS[3],
    [...GROUND_TRUTH_DAYS[4], GROUND_TRUTH_DAYS[2][4]],
  ];
  assert.equal(drifted.flat().length, 25, 'totale invariato: è il caso che passava');

  let cells: TimetableRawCell[] | null = ['non-vuoto'] as unknown as TimetableRawCell[];
  let message = '';
  try {
    cells = validatePersonalSequencePayload(daysPayload(drifted), TARGET_SURNAME, PERIODS).cells;
  } catch (error) {
    assert.ok(error instanceof TimetableShapeError, 'rifiuto tipizzato di forma');
    message = (error as Error).message;
  }
  assert.deepEqual(cells, ['non-vuoto'], 'nessuna cella prodotta: il gate precede la derivazione');
  assert.match(message, /Lunghezza del giorno non valida \(#2\)/, 'si ferma sul primo blocco sbagliato, non in fondo');

  // Stesso totale, blocco sbagliato in prima posizione: il rifiuto arriva su #0.
  const frontDrift: string[][] = [
    [...GROUND_TRUTH_DAYS[0], '3D'],
    GROUND_TRUTH_DAYS[1],
    GROUND_TRUTH_DAYS[2],
    GROUND_TRUTH_DAYS[3],
    GROUND_TRUTH_DAYS[4].slice(0, 4),
  ];
  assert.equal(frontDrift.flat().length, 25, 'totale di nuovo 25');
  assert.throws(() => cellsFromDays(frontDrift), /Lunghezza del giorno non valida \(#0\)/);

  // Nessun candidato e nessuno slot possono nascere da un payload rifiutato.
  let candidates: unknown[] = ['non-vuoto'];
  assert.throws(() => { candidates = personalCellsToCandidates(cellsFromDays(drifted), [0]).candidates; }, TimetableShapeError);
  assert.deepEqual(candidates, ['non-vuoto'], 'nessuna ora parziale in archivio');
});
