import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_GRID_PERIODS,
  PERSONAL_SCHOOL_DAYS,
  expectedPersonalCellCount,
  normalizePersonalPeriodsByDay,
  personalCellsToCandidates,
  uniformPersonalPeriodsByDay,
  validatePersonalSequencePayload,
  TimetableShapeError,
} from '../src/utils/timetableAnalysis';
import { derivePersonalScannerPeriodsByDay } from '../src/utils/scannerWeekGeometry';
import {
  buildPersonalTimetablePrompt,
  validateTimetableAnalysisPayload,
} from '../server/timetableAnalysis';
import { partitionReconstructedSlots } from '../src/utils/reconstructTimetable';
import type { ReconstructedSlot } from '../src/utils/timetableCrossref';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig } from '../src/types';

/**
 * MICRO-PASSO D3 — SETTIMANA SCOLASTICA NON RETTANGOLARE.
 *
 * Caso guida: 6/6/6/7/6 (giovedì lungo). Prima di D3 lo scanner conosceva UN
 * solo numero di ore per tutta la settimana: un giovedì da 7 ore obbligava a
 * dichiarare 7 ovunque (e allora ogni altro giorno aveva una colonna di
 * troppo) oppure 6 (e allora la 7ª del giovedì spariva o, peggio, spostava di
 * una posizione tutte le celle dei giorni successivi).
 *
 * Qui si verifica che la geometria sia PER GIORNO lungo tutta la catena:
 * derivazione dal Profilo → request → prompt → validazione → coordinate.
 */

const TARGET = 'Manganiello';
const ROW = 'Manganiello F.';
/** Il caso fondamentale del passo: lunedì-mercoledì 6, giovedì 7, venerdì 6. */
const WEEK = [6, 6, 6, 7, 6] as const;

/** Blocchi giornalieri con la lunghezza richiesta da ogni giorno. */
function daysOf(periodsByDay: readonly number[], fill: (day: number, cell: number) => string = () => '') {
  return periodsByDay.map((periods, day) => ({ cells: Array.from({ length: periods }, (_, cell) => fill(day, cell)) }));
}

const payloadOf = (periodsByDay: readonly number[], fill?: (day: number, cell: number) => string) =>
  ({ rowLabel: ROW, days: daysOf(periodsByDay, fill) });

/** "giorno|periodo" di ogni cella: la coordinata, non il contenuto. */
const coord = (cell: { dayOfWeek: number; periodIndex: number }) => `${cell.dayOfWeek}|${cell.periodIndex}`;

const slotsFor = (count: number): TimeSlotConfig['customSlots'] =>
  Array.from({ length: count }, (_, i) => ({
    periodNumber: i + 1,
    label: `${i + 1}ª Ora`,
    startTime: `${String(8 + i).padStart(2, '0')}:00`,
    endTime: `${String(9 + i).padStart(2, '0')}:00`,
  }));

const config = (count: number): TimeSlotConfig => ({
  firstHourStartTime: '08:00', periodsPerDay: count, standardDurationMinutes: 60, customSlots: slotsFor(count),
});

// ---------------------------------------------------------------------------
// 1. MODELLO DI DOMINIO
// ---------------------------------------------------------------------------

test('D3/1. periodsByDay: cinque interi 1..MAX, niente interpretazioni creative', () => {
  assert.deepEqual(normalizePersonalPeriodsByDay([6, 6, 6, 7, 6]), [6, 6, 6, 7, 6]);
  assert.deepEqual(normalizePersonalPeriodsByDay([1, 1, 1, 1, MAX_GRID_PERIODS]), [1, 1, 1, 1, MAX_GRID_PERIODS]);
  // Rifiutati: lunghezza sbagliata, zero, negativi, decimali, oltre il tetto,
  // stringhe numeriche, buchi. Una geometria attesa sbagliata farebbe passare
  // o rifiutare un'analisi intera, quindi non si "aggiusta" nulla.
  for (const bad of [
    [6, 6, 6, 7], [6, 6, 6, 7, 6, 6], [], [0, 6, 6, 7, 6], [-1, 6, 6, 7, 6],
    [6, 6, 6, 7.5, 6], [6, 6, 6, MAX_GRID_PERIODS + 1, 6], ['6', 6, 6, 7, 6],
    [6, 6, undefined, 7, 6], [6, 6, null, 7, 6], [6, 6, NaN, 7, 6], 6, null, undefined, {},
  ]) {
    assert.equal(normalizePersonalPeriodsByDay(bad), null, `rifiutato: ${JSON.stringify(bad)}`);
  }
});

test('D3/2. lo scalare legacy diventa una settimana rettangolare, non resta uno scalare', () => {
  assert.deepEqual(uniformPersonalPeriodsByDay(6), [6, 6, 6, 6, 6]);
  assert.deepEqual(uniformPersonalPeriodsByDay(1), [1, 1, 1, 1, 1]);
  assert.equal(uniformPersonalPeriodsByDay(0), null);
  assert.equal(uniformPersonalPeriodsByDay(MAX_GRID_PERIODS + 1), null);
  assert.equal(uniformPersonalPeriodsByDay(2.5), null);
});

test('D3/3. expectedCellCount è una somma, non un prodotto: 6+6+6+7+6 = 31', () => {
  assert.equal(expectedPersonalCellCount(WEEK), 31);
  assert.equal(expectedPersonalCellCount([6, 6, 6, 6, 6]), 30, 'la settimana rettangolare resta 6 x 5');
  assert.equal(expectedPersonalCellCount([6, 5, 6, 7, 4]), 28, 'anche i giorni CORTI contano');
  assert.equal(
    expectedPersonalCellCount(uniformPersonalPeriodsByDay(MAX_GRID_PERIODS) ?? []),
    MAX_GRID_PERIODS * PERSONAL_SCHOOL_DAYS,
    'sul rettangolo la somma coincide col vecchio prodotto',
  );
});

// ---------------------------------------------------------------------------
// 2. DERIVAZIONE DAL PROFILO
// ---------------------------------------------------------------------------

const schoolWith = (dayPeriods?: SchoolProfile['dayPeriods']): SchoolProfile =>
  ({ id: 's1', name: 'IC Da Vinci', isPrimary: true, active: true, dayPeriods } as SchoolProfile);

test('D3/4. prefill dal Profilo: 6 ordinarie + 1 il giovedì -> [6,6,6,7,6]', () => {
  const school = schoolWith({ ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } });
  assert.deepEqual(derivePersonalScannerPeriodsByDay(school, config(6)), [6, 6, 6, 7, 6]);
  // Più giorni lunghi insieme, e un valore diverso da +1.
  assert.deepEqual(
    derivePersonalScannerPeriodsByDay(schoolWith({ ordinaryPeriodsPerDay: 5, extraPeriodsByDay: { 2: 2, 4: 1 } }), config(5)),
    [5, 7, 5, 6, 5],
  );
});

test('D3/5. compatibilità legacy: senza dayPeriods la settimana resta rettangolare', () => {
  // Profilo vecchio (nessuna struttura dichiarata): il numero di ore è quello
  // delle fasce effettive, identico in tutti i giorni. Nessuna migrazione.
  assert.deepEqual(derivePersonalScannerPeriodsByDay(schoolWith(undefined), config(6)), [6, 6, 6, 6, 6]);
  assert.deepEqual(derivePersonalScannerPeriodsByDay(schoolWith(undefined), config(5)), [5, 5, 5, 5, 5]);
  assert.deepEqual(derivePersonalScannerPeriodsByDay(schoolWith(undefined), config(8)), [8, 8, 8, 8, 8]);
  // Nessuna scuola e nessuna configurazione oraria: il default dell'app (6).
  assert.deepEqual(derivePersonalScannerPeriodsByDay(undefined, undefined), [6, 6, 6, 6, 6]);
  // Configurazione sporca: mai zero ore, mai ore fantasma.
  assert.deepEqual(
    derivePersonalScannerPeriodsByDay(schoolWith({ ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 2: -3, 3: 0.5 } as never }), config(6)),
    [6, 6, 6, 6, 6],
  );
});

// ---------------------------------------------------------------------------
// 3. PARSER — il cuore funzionale di D3
// ---------------------------------------------------------------------------

test('D3/6. CASO FONDAMENTALE 6/6/6/7/6: 31 posizioni, nessuno shift dopo il giovedì', () => {
  const { cells } = validatePersonalSequencePayload(
    payloadOf(WEEK, (day, cell) => `d${day + 1}p${cell + 1}`), TARGET, WEEK,
  );
  assert.equal(cells.length, 31, '6+6+6+7+6 = 31 posizioni');
  // Il giovedì arriva davvero alla 7ª...
  assert.deepEqual(
    cells.filter(c => c.dayOfWeek === 4).map(c => c.periodIndex), [1, 2, 3, 4, 5, 6, 7],
  );
  const thursdaySeventh = cells.find(c => c.dayOfWeek === 4 && c.periodIndex === 7);
  assert.equal(thursdaySeventh?.raw, 'd4p7', 'la 7ª del giovedì è letta, non scartata');
  // ...e la cella in più NON sposta il venerdì di una posizione: è esattamente
  // la regressione che il modello scalare produceva.
  const fridayFirst = cells.find(c => c.dayOfWeek === 5 && c.periodIndex === 1);
  assert.equal(fridayFirst?.raw, 'd5p1', 'Ven/1 resta Ven/1');
  assert.deepEqual(cells.filter(c => c.dayOfWeek === 5).map(c => c.periodIndex), [1, 2, 3, 4, 5, 6]);
  // Ogni giorno ha esattamente le sue ore, in ordine.
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(day => cells.filter(c => c.dayOfWeek === day).length), [6, 6, 6, 7, 6],
  );
  // I giorni escono nell'ordine lunedì → venerdì, mai mescolati.
  assert.deepEqual(cells.map(c => c.dayOfWeek), [...cells.map(c => c.dayOfWeek)].sort((a, b) => a - b));
  assert.equal(cells[0] && coord(cells[0]), '1|1');
  assert.equal(coord(cells[cells.length - 1]), '5|6');
  assert.ok(cells.every(c => c.rowIndex === 0), 'riga sintetica unica');
});

test('D3/7. geometria legacy 6/6/6/6/6: comportamento identico a prima di D3', () => {
  const rect = [6, 6, 6, 6, 6];
  const { cells } = validatePersonalSequencePayload(payloadOf(rect, (d, c) => `d${d + 1}p${c + 1}`), TARGET, rect);
  assert.equal(cells.length, 30);
  assert.deepEqual(cells.slice(0, 7).map(coord), ['1|1', '1|2', '1|3', '1|4', '1|5', '1|6', '2|1']);
});

test('D3/8. giorni arbitrari anche IN DIFETTO: [6,5,6,7,4] è una settimana valida', () => {
  // Il Profilo oggi sa esprimere solo "ordinarie + extra" e quindi non può
  // produrre un giorno più CORTO dell'ordinario. Lo scanner non deve
  // reincorporare quel limite: il suo contratto interno è un intero per giorno.
  const week = [6, 5, 6, 7, 4];
  const { cells } = validatePersonalSequencePayload(payloadOf(week, (d, c) => `d${d + 1}p${c + 1}`), TARGET, week);
  assert.equal(cells.length, 28);
  assert.deepEqual([1, 2, 3, 4, 5].map(day => cells.filter(c => c.dayOfWeek === day).length), week);
  assert.equal(cells.find(c => c.dayOfWeek === 5 && c.periodIndex === 1)?.raw, 'd5p1', 'il venerdì corto parte comunque dalla 1ª');
  assert.equal(cells.some(c => c.dayOfWeek === 5 && c.periodIndex === 5), false, 'il venerdì si ferma alla 4ª');
});

test('D3/9. giovedì CORTO (7 attese, 6 ricevute) -> analisi rifiutata, nessuna coordinata', () => {
  const short = { rowLabel: ROW, days: daysOf([6, 6, 6, 6, 6]) }; // il modello ha saltato una cella del giovedì
  assert.throws(
    () => validatePersonalSequencePayload(short, TARGET, WEEK),
    /Giovedì: attese 7 celle, ricevute 6\./,
    'il messaggio nomina giorno, atteso e ricevuto',
  );
  assert.throws(() => validatePersonalSequencePayload(short, TARGET, WEEK), TimetableShapeError);
});

test('D3/10. giovedì LUNGO (7 attese, 8 ricevute) -> analisi rifiutata', () => {
  assert.throws(
    () => validatePersonalSequencePayload({ rowLabel: ROW, days: daysOf([6, 6, 6, 8, 6]) }, TARGET, WEEK),
    /Giovedì: attese 7 celle, ricevute 8\./,
  );
});

test('D3/11. nessuna compensazione fra giorni: il totale giusto non salva un giorno sbagliato', () => {
  // 6+6+6+6+7 = 31, esattamente come 6/6/6/7/6: il totale tornerebbe, ma il
  // giovedì ha perso un'ora e il venerdì ne ha una che non è sua.
  const compensated = { rowLabel: ROW, days: daysOf([6, 6, 6, 6, 7]) };
  assert.equal(compensated.days.reduce((n, d) => n + d.cells.length, 0), expectedPersonalCellCount(WEEK));
  assert.throws(() => validatePersonalSequencePayload(compensated, TARGET, WEEK), /Giovedì: attese 7 celle, ricevute 6\./);
});

test('D3/12. celle vuote: presenti occupano posizione, omesse sono un rifiuto', () => {
  // 7 elementi di cui uno vuoto: valido, e il vuoto tiene il suo posto.
  const withEmpty = { rowLabel: ROW, days: daysOf(WEEK, (day, cell) => (day === 3 && cell === 2 ? '' : '3D')) };
  const { cells } = validatePersonalSequencePayload(withEmpty, TARGET, WEEK);
  assert.equal(cells.length, 31);
  assert.equal(cells.find(c => c.dayOfWeek === 4 && c.periodIndex === 3)?.raw, '', 'la cella vuota è al suo posto');
  assert.equal(cells.find(c => c.dayOfWeek === 4 && c.periodIndex === 4)?.raw, '3D', 'le successive non scalano');
  // `null` resta una cella vuota valida (stesso fatto nel documento).
  const days = daysOf(WEEK, () => '3D').map((d, i) => (i === 3 ? { cells: d.cells.map((c, j) => (j === 6 ? null : c)) } : d));
  const withNull = validatePersonalSequencePayload({ rowLabel: ROW, days }, TARGET, WEEK);
  assert.equal(withNull.cells.find(c => c.dayOfWeek === 4 && c.periodIndex === 7)?.raw, '');
  // La stessa cella OMESSA (6 elementi perché il modello l'ha saltata) è un rifiuto.
  const omitted = { rowLabel: ROW, days: daysOf(WEEK).map((d, i) => (i === 3 ? { cells: d.cells.slice(0, 6) } : d)) };
  assert.throws(() => validatePersonalSequencePayload(omitted, TARGET, WEEK), /Giovedì: attese 7 celle, ricevute 6\./);
});

test('D3/13. le candidate nascono dalle coordinate del parser, non dalla geometria', () => {
  const { cells } = validatePersonalSequencePayload(
    payloadOf(WEEK, (day, cell) => (day === 3 && cell === 6 ? '3E' : '')), TARGET, WEEK,
  );
  const { candidates } = personalCellsToCandidates(cells, [0]);
  assert.equal(candidates.length, 1, 'solo la cella occupata diventa una candidata');
  assert.equal(candidates[0].dayOfWeek, 4);
  assert.equal(candidates[0].periodIndex, 7, 'la 7ª del giovedì arriva intatta alla ricostruzione');
});

// ---------------------------------------------------------------------------
// 4. PROMPT
// ---------------------------------------------------------------------------

test('D3/14. prompt: lunghezze dichiarate GIORNO PER GIORNO, totale e nessun "N ogni giorno"', () => {
  const prompt = buildPersonalTimetablePrompt(TARGET, WEEK);
  assert.ok(prompt.includes('LUNEDÌ: 6, MARTEDÌ: 6, MERCOLEDÌ: 6, GIOVEDÌ: 7, VENERDÌ: 6'), 'geometria per giorno');
  assert.ok(prompt.includes('GIOVEDÌ: ESATTAMENTE 7 celle'), 'il giovedì chiede 7 celle');
  assert.ok(prompt.includes('VENERDÌ: ESATTAMENTE 6 celle'), 'il venerdì resta a 6');
  assert.ok(prompt.includes('In tutto la riga del docente ha 31 celle.'), 'il totale è la somma, non un prodotto');
  assert.ok(prompt.includes('31 posizioni in tutto'), 'il riepilogo ripete il totale corretto');
  // Nessuna istruzione contraddittoria con un numero unico per tutti i giorni.
  assert.ok(!/ESATTAMENTE \d+ COLONNE FISICHE/.test(prompt), 'nessuna lunghezza unica residua');
  assert.ok(prompt.includes('I giorni NON hanno per forza lo stesso numero di ore.'), 'la non rettangolarità è esplicita');
  // Esempio JSON: ogni blocco ha la SUA lunghezza (tre da 6, uno da 7, uno da 6).
  assert.equal(prompt.split('{ "cells": ["", "", "", "", "", ""] }').length - 1, 4, 'quattro blocchi da 6');
  assert.equal(prompt.split('{ "cells": ["", "", "", "", "", "", ""] }').length - 1, 1, 'un blocco da 7');
  // Il contratto della risposta NON cambia: cinque blocchi, nessuna coordinata.
  assert.ok(prompt.includes('ESATTAMENTE 5 oggetti'), 'sempre cinque blocchi giornalieri');
  assert.ok(prompt.includes('non restituire rowIndex, dayOfWeek o periodIndex'), 'il modello non dichiara coordinate');
  assert.ok(!prompt.includes('periodsByDay'), 'il nome del campo interno non arriva al modello');
});

test('D3/15. prompt: regole forti preservate e geometria arbitraria interpolata', () => {
  const prompt = buildPersonalTimetablePrompt(TARGET, [6, 5, 6, 7, 4]);
  assert.ok(prompt.includes('LUNEDÌ: 6, MARTEDÌ: 5, MERCOLEDÌ: 6, GIOVEDÌ: 7, VENERDÌ: 4'));
  assert.ok(prompt.includes('In tutto la riga del docente ha 28 celle.'));
  for (const rule of [
    'Una cella vuota è la stringa vuota ""',
    "mai omessa e mai spostata all'inizio o alla fine del giorno",
    'NON comprimere le celle',
    'NON compensare una cella mancante in un giorno aggiungendone una in un altro',
    'il primo è LUNEDÌ, poi MARTEDÌ, MERCOLEDÌ, GIOVEDÌ e l\'ultimo è VENERDÌ',
    'anche una colonna senza testo è una posizione e va restituita',
  ]) {
    assert.ok(prompt.includes(rule), `regola forte preservata: ${rule}`);
  }
  // Tabella graficamente rettangolare (7 colonne disegnate) ma geometria
  // dichiarata più corta: vince la struttura dichiarata dall'utente.
  assert.ok(
    prompt.includes('restituisci solo le prime colonne previste per quel giorno e ignora le eccedenti'),
    'la geometria attesa è quella dichiarata, non quella disegnata',
  );
});

test('D3/16. prompt: geometria non valida -> nessuna geometria dichiarata al modello', () => {
  // Conservativo: non si inventa un numero di colonne.
  const prompt = buildPersonalTimetablePrompt(TARGET, [6, 6, 6]);
  assert.ok(prompt.includes('LUNEDÌ: 0'), 'nessuna lunghezza inventata');
});

// ---------------------------------------------------------------------------
// 5. REQUEST (server)
// ---------------------------------------------------------------------------

const baseRequest = {
  imageBase64: Buffer.from('%PDF-1.7\n%%EOF').toString('base64'),
  mimeType: 'application/pdf',
  documentType: 'personal-support-timetable',
  profile: {
    id: 't-1', fullName: 'Felice Manganiello', schoolName: 'Istituto Comprensivo Da Vinci',
    schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
    classes: ['3D', '3E'], campuses: ['Sede Centrale'], roles: [{ role: 'docente_sostegno' }],
    isSupportTeacher: true,
  },
};

test('D3/17. request: periodsByDay accettato e restituito così com è', () => {
  assert.deepEqual(validateTimetableAnalysisPayload({ ...baseRequest, periodsByDay: [6, 6, 6, 7, 6] }).periodsByDay, [6, 6, 6, 7, 6]);
  assert.deepEqual(validateTimetableAnalysisPayload({ ...baseRequest, periodsByDay: [6, 5, 6, 7, 4] }).periodsByDay, [6, 5, 6, 7, 4]);
  assert.deepEqual(
    validateTimetableAnalysisPayload({ ...baseRequest, periodsByDay: [1, 1, 1, 1, MAX_GRID_PERIODS] }).periodsByDay,
    [1, 1, 1, 1, MAX_GRID_PERIODS],
  );
});

test('D3/18. request: geometrie non valide rifiutate con 400', () => {
  for (const bad of [
    [6, 6, 6, 7], [6, 6, 6, 7, 6, 6], [], [0, 6, 6, 7, 6], [13, 6, 6, 7, 6],
    [6, 6, 6, 7.5, 6], ['6', 6, 6, 7, 6], [6, 6, null, 7, 6], 6, 'sei', {},
  ]) {
    assert.throws(
      () => validateTimetableAnalysisPayload({ ...baseRequest, periodsByDay: bad }),
      /ore/i,
      `deve rifiutare periodsByDay=${JSON.stringify(bad)}`,
    );
  }
  // Assente: l'analisi personale non può partire senza geometria.
  assert.throws(() => validateTimetableAnalysisPayload(baseRequest), /ore/i);
});

test('D3/19. request: lo scalare legacy è normalizzato subito, e le due forme non convivono', () => {
  assert.deepEqual(validateTimetableAnalysisPayload({ ...baseRequest, periodsPerDay: 6 }).periodsByDay, [6, 6, 6, 6, 6]);
  // Due fonti di verità insieme: rifiutate, perché se divergessero non
  // esisterebbe una risposta giusta su quale vince.
  assert.throws(
    () => validateTimetableAnalysisPayload({ ...baseRequest, periodsPerDay: 6, periodsByDay: [6, 6, 6, 7, 6] }),
    /ore/i,
    'periodsPerDay e periodsByDay insieme sono un errore',
  );
});

// ---------------------------------------------------------------------------
// 6. RAPPORTO CON D1 (la rete di sicurezza resta)
// ---------------------------------------------------------------------------

test('D3/20. D1 resta a valle: senza la 7ª fascia solo Gio/7 viene scartato', () => {
  // D3 previene a monte (la geometria dichiarata è corretta), ma se le fasce
  // orarie configurate si fermano alla 6ª, la 7ª del giovedì non ha un orario
  // reale: D1 la esclude in preview, e SOLO lei. La rete di sicurezza resta.
  const profile = {
    id: 't-1', fullName: 'Felice Manganiello', schoolName: 'IC Da Vinci',
    schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
    classes: ['3D', '3E'], campuses: [], roles: [], isSupportTeacher: true,
    schools: [{
      id: 's1', name: 'IC Da Vinci', isPrimary: true, active: true,
      dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
    }],
  } as unknown as TeacherProfile;
  const item = (dayOfWeek: number, periodIndex: number): ReconstructedSlot => ({
    id: `r-${dayOfWeek}-${periodIndex}`,
    dayOfWeek, periodIndex, classLabel: '3D', coTeachingSubjects: [],
    status: 'ok', confidence: 'high', selected: true,
  } as unknown as ReconstructedSlot);
  const items = [item(4, 7), item(4, 6), item(5, 1)];

  const partition = partitionReconstructedSlots(items, { profile, timeSlotConfig: config(6) });
  assert.deepEqual(
    partition.rejected.map(r => `${r.item.dayOfWeek}|${r.item.periodIndex}`),
    ['4|7'],
    'solo la 7ª del giovedì è scartata: manca la fascia oraria',
  );
  assert.deepEqual(partition.rejected.map(r => r.reason), ['missing-period-slot']);
  assert.deepEqual(partition.slots.map(s => `${s.dayOfWeek}|${s.periodNumber}`), ['4|6', '5|1'], 'le altre ore restano importabili');

  // Con la 7ª fascia configurata non viene scartato più nulla: la struttura
  // 6/6/6/7/6 è importabile per intero.
  const full = partitionReconstructedSlots(items, { profile, timeSlotConfig: config(7) });
  assert.equal(full.rejected.length, 0);
  assert.equal(full.slots.length, 3);
});
