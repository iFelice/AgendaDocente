import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTimetableToken, extractClassesFromCell, normalizeClassLabel, DAY_LABELS } from '../src/utils/timetableTokens';
import {
  buildPersonalCoordinateScope,
  curricularCellsToSlots,
  findTeacherRows,
  restrictCurricularSlotsToCoordinates,
  summarizeCurricularCoverage,
  anchorPersonalCellsToGrid,
  MAX_PERSONAL_GRID_CELLS,
  MAX_PERSONAL_GRID_ROWS,
  personalCellsToCandidates,
  TimetableShapeError,
  teacherSurnames,
  validateCurricularTimetablePayload,
  validatePersonalTimetablePayload,
  validateStudentCommitmentsPayload,
  type CurricularRawRow,
  type TimetableRawCell,
} from '../src/utils/timetableAnalysis';
import { crossrefTimetables, dedupeSubjects, reconSignal, sameClassLabel, RECON_NOTES } from '../src/utils/timetableCrossref';
import { parseTimetableAiResponse } from '../server/timetableAnalysis';
import {
  SUPPORT_TEACHER_SUBJECT,
  applyReconstruction,
  isSupportTeacherProfile,
  periodTimesForIndex,
  reconstructedToTimetableSlots,
} from '../src/utils/reconstructTimetable';
import { matchStudentName, parsePersonName, foldName, studentMatchLabel } from '../src/utils/studentMatcher';
import { normalizeTeacherProfile } from '../src/utils/multiSchool';
import { documentFileError, formatFileSize, OFFLINE_ANALYSIS_MESSAGE, MAX_DOCUMENT_BYTES, CAMERA_INPUT_PROPS, FILE_INPUT_PROPS } from '../src/utils/documentScanner';
import { isValidTimetablePayload } from '../src/services/sync/remoteSchema';
import type { TeacherProfile, TimetableSlot } from '../src/types';

/*
 * "Scansiona documento" — logica pura:
 * token tabelle, riga docente, celle->candidati, incrocio multi-documento,
 * modello timetable esistente, conferma/salvataggio, matching alunni,
 * privacy/offline/multi-istituto (lato dati).
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

const students = [
  { id: 'stu-rossi', fullName: 'Rossi Matteo', className: '3D' },
  { id: 'stu-bianchi', fullName: 'Bianchi Giulia', className: '3D' },
  { id: 'stu-bianchi-2', fullName: 'Bianchi Luca', className: '3E' },
  { id: 'stu-fernandez', fullName: 'Fernández Andrea', className: '3E' },
];

// ---------------------------------------------------------------------------
// 9. TOKEN PARTICOLARI DELLE TABELLE
// ---------------------------------------------------------------------------

test('token table: classi valide riconosciute, D/P/Co/sos mai trattati come classe', () => {
  for (const [token, expected] of [
    ['3D', '3D'], ['3d', '3D'], ['3 D', '3D'], ['3ª', null], ['1A', '1A'],
    ['3°E', '3E'], ['III D', '3D'], ['classe 2B', '2B'],
    ['D', null], ['P', null], ['Co', null], ['CO', null], ['sos', null], ['MATEMATICA', null], ['3D4', null],
  ] as const) {
    assert.equal(normalizeClassLabel(token), expected, `normalizeClassLabel(${JSON.stringify(token)})`);
  }

  assert.equal(classifyTimetableToken('3D').kind, 'class');
  assert.equal(classifyTimetableToken('3D').classLabel, '3D');
  assert.equal(classifyTimetableToken('sos').kind, 'support');
  assert.equal(classifyTimetableToken('Sostegno').kind, 'support');
  assert.equal(classifyTimetableToken('D').kind, 'internal-code');
  assert.equal(classifyTimetableToken('P').kind, 'internal-code');
  assert.equal(classifyTimetableToken('Co').kind, 'internal-code');
  assert.equal(classifyTimetableToken('MATEMATICA').kind, 'other');
  assert.equal(classifyTimetableToken('').kind, 'other');

  // Cella con più classi: estratte entrambe; i codici ignorati.
  assert.deepEqual(extractClassesFromCell('3D 3E'), ['3D', '3E']);
  assert.deepEqual(extractClassesFromCell('3D / sos'), ['3D']);
  assert.deepEqual(extractClassesFromCell('D P Co'), []);
});

test('DAY_LABELS copre lunedì-sabato (struttura tabella italiana)', () => {
  assert.equal(DAY_LABELS[1], 'Lunedì');
  assert.equal(DAY_LABELS[5], 'Venerdì');
  assert.equal(DAY_LABELS[6], 'Sabato');
});

// ---------------------------------------------------------------------------
// 5. ORARIO PERSONALE / SOSTEGNO
// ---------------------------------------------------------------------------

const personalRows = ['Bianchi', 'Manganiello F.', 'Rossi L.', 'Co D.'];

test('trova la riga "Manganiello" dal profilo "Felice Manganiello" (maiuscole/ruolo indifferenti)', () => {
  assert.deepEqual(teacherSurnames('Prof. Felice Manganiello'), ['manganiello']);
  assert.deepEqual(findTeacherRows(personalRows, 'Felice Manganiello'), [{ rowIndex: 1, rowLabel: 'Manganiello F.' }]);
  assert.deepEqual(findTeacherRows(personalRows, 'prof. felice manganiello'), [{ rowIndex: 1, rowLabel: 'Manganiello F.' }]);
  // Nessuna corrispondenza aggressiva: Bianchi != Bianchini.
  assert.deepEqual(findTeacherRows(['Bianchini'], 'Giulia Bianchi'), []);
  // Profilo vuoto: nessuna riga trovata (mai invenzioni).
  assert.deepEqual(findTeacherRows(personalRows, ''), []);
});

test('cognome ambiguo (più righe compatibili) -> tutte restituite per richiesta di conferma', () => {
  const rows = ['Manganiello F.', 'Manganiello A.'];
  const matches = findTeacherRows(rows, 'Felice Manganiello');
  assert.equal(matches.length, 2, 'più righe compatibili: la scelta tocca all\'utente');
});

const personalCells: TimetableRawCell[] = [
  { rowIndex: 1, dayOfWeek: 1, periodIndex: 1, raw: '3D' },
  { rowIndex: 1, dayOfWeek: 1, periodIndex: 2, raw: '3E' },
  { rowIndex: 1, dayOfWeek: 2, periodIndex: 1, raw: '3D 3E' },
  { rowIndex: 1, dayOfWeek: 2, periodIndex: 2, raw: '3E' },
  { rowIndex: 1, dayOfWeek: 3, periodIndex: 1, raw: 'sos' },
  { rowIndex: 1, dayOfWeek: 3, periodIndex: 2, raw: 'D' },
  { rowIndex: 1, dayOfWeek: 4, periodIndex: 1, raw: 'P' },
  { rowIndex: 1, dayOfWeek: 5, periodIndex: 1, raw: 'Co' },
  { rowIndex: 0, dayOfWeek: 1, periodIndex: 1, raw: '1A' }, // riga di un altro docente
];

test('orario personale: estrae giorno/ora/classe e NON inventa celle mancanti', () => {
  const { candidates, skipped } = personalCellsToCandidates(personalCells, [1]);
  assert.equal(candidates.length, 6, 'celle con classe valida (una per classe) + cella sos; D/P/Co esclusi');
  const find = (day: number, period: number, classLabel?: string) =>
    candidates.filter(c => c.dayOfWeek === day && c.periodIndex === period && (classLabel === undefined || c.classLabel === classLabel));
  assert.equal(find(1, 1, '3D')[0]?.confidence, 'high');
  assert.equal(find(1, 2, '3E')[0]?.classLabel, '3E');
  assert.equal(find(2, 1).length, 2, 'cella "3D 3E" -> due slot (una per classe visibile)');
  assert.deepEqual(find(2, 1).map(c => c.classLabel).sort(), ['3D', '3E']);
  assert.equal(find(2, 2, '3E')[0]?.classLabel, '3E');
  const sos = find(3, 1, undefined)[0];
  assert.equal(sos?.classLabel, undefined, 'sos: sostegno senza classe (non inventata)');
  assert.equal(sos?.confidence, 'medium');
  assert.equal(find(3, 2).length, 0, 'D non produce slot');
  assert.equal(find(4, 1).length, 0, 'P non produce slot');
  assert.equal(find(5, 1).length, 0, 'Co non produce slot');
  assert.equal(skipped.length, 3, 'le celle D/P/Co sono visibili come non interpretate');
  for (const s of skipped) assert.equal(s.reason, 'internal-code');
  // Celle della riga 0 (altro docente) mai incluse.
  assert.ok(!candidates.some(c => c.classLabel === '1A'));
  // Celle mancanti (es. martedì 5ª) non esistono: niente inventare.
  assert.ok(!candidates.some(c => c.dayOfWeek === 2 && c.periodIndex === 5));
});

test('orario personale Manganiello: preserva le 18 coordinate assolute e le colonne vuote', () => {
  const groundTruth: Array<Array<string | undefined>> = [
    ['3D', '3D', '3E', '3E', undefined],
    ['3D', undefined, '3D', '3D', '3E'],
    [undefined, '3E', '3E', '3D', '3E'],
    [undefined, '3E', '3D', '3E', undefined],
    ['3E', '3D', '3E', undefined, undefined],
  ];
  const cells: TimetableRawCell[] = groundTruth.flatMap((periods, dayIndex) => periods.flatMap((raw, periodIndex) =>
    raw === undefined ? [] : [{ rowIndex: 1, dayOfWeek: dayIndex + 1, periodIndex: periodIndex + 1, raw }]
  ));
  const { candidates } = personalCellsToCandidates(cells, [1]);
  assert.equal(candidates.length, 18);
  for (let day = 1; day <= 5; day++) {
    for (let period = 1; period <= 5; period++) {
      const expected = groundTruth[day - 1][period - 1];
      const found = candidates.filter(c => c.dayOfWeek === day && c.periodIndex === period);
      assert.equal(found.length, expected === undefined ? 0 : 1, `coordinate ${day}/${period}`);
      if (expected !== undefined) assert.equal(found[0]?.classLabel, expected, `class at ${day}/${period}`);
    }
  }
  assert.equal(candidates.some(c => c.dayOfWeek === 2 && c.periodIndex === 2), false, 'Martedì 2 vuoto');
  assert.equal(candidates.find(c => c.dayOfWeek === 2 && c.periodIndex === 5)?.classLabel, '3E');
  assert.equal(candidates.some(c => c.dayOfWeek === 3 && c.periodIndex === 1), false, 'Mercoledì 1 vuoto');
  assert.equal(candidates.find(c => c.dayOfWeek === 3 && c.periodIndex === 5)?.classLabel, '3E');
  assert.equal(candidates.some(c => c.dayOfWeek === 4 && c.periodIndex === 1), false, 'Giovedì 1 vuoto');
  assert.equal(candidates.find(c => c.dayOfWeek === 4 && c.periodIndex === 4)?.classLabel, '3E');
  assert.equal(candidates.some(c => c.dayOfWeek === 5 && (c.periodIndex === 4 || c.periodIndex === 5)), false, 'Venerdì 4 e 5 vuoti');
});

// ---------------------------------------------------------------------------
// 9c. ORARIO PERSONALE: LA POSIZIONE NELLA GRIGLIA DETERMINA IL PERIODO
//     Una cella vuota non deve mai far scorrere a sinistra le ore successive.
//     Ground truth: documento reale del docente di sostegno, 18 ore su 5x5.
// ---------------------------------------------------------------------------

const REAL_GRID: Array<Array<string | undefined>> = [
  [undefined, '3D', '3D', '3E', '3E'],        // LUNEDÌ
  ['3D', undefined, '3D', '3D', '3E'],        // MARTEDÌ
  [undefined, '3E', '3E', '3D', '3E'],        // MERCOLEDÌ
  [undefined, '3E', '3D', '3E', undefined],   // GIOVEDÌ
  ['3E', '3D', '3E', undefined, undefined],   // VENERDÌ
];

/** Le 18 coordinate (giorno, periodo, classe) del documento, 1-based come in archivio. */
const REAL_COORDINATES = REAL_GRID.flatMap((periods, dayIndex) =>
  periods
    .map((raw, periodIndex) => ({ day: dayIndex + 1, period: periodIndex + 1, raw: raw as string }))
    .filter(c => c.raw !== undefined)
);

/**
 * Payload AI nel formato richiesto al modello per l'orario personale: UNA cella
 * per OGNI colonna della griglia, anche vuote (`raw: ""`), in ordine da sinistra.
 * `numbering` modella la numerazione che il modello restituisce (può essere
 * sbagliata: è il parsing che deve ancorare le celle alle colonne).
 */
function densePersonalPayload(numbering: 'columns' | 'rowCounter' | 'reversed' | 'duplicates' = 'columns') {
  const cells: Array<{ rowIndex: number; dayOfWeek: number; periodIndex: number; raw: string }> = [];
  let running = 0;
  REAL_GRID.forEach((periods, dayIndex) => {
    periods.forEach((raw, periodIndex) => {
      running += 1;
      let period = periodIndex + 1;
      if (numbering === 'rowCounter') period = running;                    // contatore progressivo sull'intera riga
      if (numbering === 'reversed') period = periods.length - periodIndex; // colonne invertite
      if (numbering === 'duplicates') period = Math.ceil(period / 2);      // due colonne sullo stesso numero
      cells.push({ rowIndex: 0, dayOfWeek: dayIndex + 1, periodIndex: period, raw: raw ?? '' });
    });
  });
  return { rows: ['Manganiello F.'], periodsPerDay: periodsPerDayOf(), cells };
}

function periodsPerDayOf(): number {
  return REAL_GRID[0].length;
}

/** Pipeline reale: risposta AI -> celle validate/ancorate -> candidati -> slot salvati. */
function personalFromPayload(payload: unknown) {
  const outcome = parseTimetableAiResponse('personal-support-timetable', payload);
  const extraction = personalCellsToCandidates(outcome.cells, [0]);
  const recon = crossrefTimetables(extraction.candidates, []).map(s => ({ ...s, correctedClass: s.classLabel ?? '' }));
  const slots = reconstructedToTimetableSlots(recon, { profile, timeSlotConfig: undefined });
  return { outcome, candidates: extraction.candidates, skipped: extraction.skipped, slots };
}

const coords = (values: Array<{ day: number; period: number } | { dayOfWeek: number; periodNumber: number }>) =>
  new Set(values.map(v => 'day' in v ? `${v.day}|${v.period}` : `${v.dayOfWeek}|${v.periodNumber}`));

/** ASSERT OBBLIGATORI: 18 slot, nessuna ora sulle colonne vuote, classi sulle giuste coordinate. */
function assertRealGrid(label: string, slots: Array<{ dayOfWeek: number; periodNumber: number; className?: string }>) {
  const expected = coords(REAL_COORDINATES);
  const got = coords(slots);
  assert.equal(REAL_COORDINATES.length, 18, 'la griglia di riferimento ha 18 ore');
  assert.equal(slots.length, 18, `${label}: 18 slot totali`);
  assert.deepEqual([...got].sort(), [...expected].sort(), `${label}: le coordinate sono quelle del documento`);
  assert.equal(got.has('2|2'), false, `${label}: nessuno slot Martídì periodo 2`);
  assert.equal(got.has('1|1'), false, `${label}: nessuno slot Lunedì periodo 1`);
  assert.equal(got.has('3|1'), false, `${label}: nessuno slot Mercoledì periodo 1`);
  assert.equal(got.has('4|1'), false, `${label}: nessuno slot Giovedì periodo 1`);
  assert.equal(got.has('4|5'), false, `${label}: nessuno slot Giovedì periodo 5`);
  assert.equal(got.has('5|4'), false, `${label}: nessuno slot Venerdì periodo 4`);
  assert.equal(got.has('5|5'), false, `${label}: nessuno slot Venerdì periodo 5`);
  for (const c of REAL_COORDINATES) {
    const slot = slots.find(s => s.dayOfWeek === c.day && s.periodNumber === c.period);
    assert.equal(slot?.className, c.raw, `${label}: ${DAY_LABELS[c.day]} ${c.period}ª = ${c.raw}`);
  }
}

test('orario personale (ground truth 18 ore): payload denso -> coordinate esatte, nessuna ora che slitta', () => {
  const { outcome, candidates, skipped, slots } = personalFromPayload(densePersonalPayload());
  assert.equal(outcome.periodsPerDay, 5, 'geometria della griglia riconosciuta');
  assert.equal(outcome.positionIssues, 0, 'numerazione coerente: nessun avviso');
  assert.equal(candidates.length, 18, 'solo le celle con un valore diventano candidati');
  assert.equal(skipped.length, 0, 'le colonne vuote NON sono celle «non interpretate»');
  assertRealGrid('denso', slots);
});

test('orario personale: numerazione AI rinumerata/invertita/duplicata non sposta le ore (vince la colonna)', () => {
  for (const numbering of ['rowCounter', 'reversed', 'duplicates'] as const) {
    const { outcome, slots } = personalFromPayload(densePersonalPayload(numbering));
    assert.equal(outcome.positionIssues, 0, `${numbering}: griglia ricostruibile, nessuna posizione da verificare`);
    assertRealGrid(numbering, slots);
  }
});

test('orario personale: payload senza celle vuote (numeri assoluti) mantiene le 18 coordinate, mai ricompattate', () => {
  const cells = REAL_GRID.flatMap((periods, dayIndex) => periods.flatMap((raw, periodIndex) =>
    raw === undefined ? [] : [{ rowIndex: 0, dayOfWeek: dayIndex + 1, periodIndex: periodIndex + 1, raw }]
  ));
  const { outcome, candidates, slots } = personalFromPayload({ rows: ['Manganiello F.'], cells });
  assert.equal(candidates.length, 18);
  assert.equal(outcome.positionIssues, 0, 'nessun duplicato: posizioni già ancorate ai numeri del documento');
  assertRealGrid('senza vuoti', slots);
});

test('orario personale: [3D, vuoto, 3D, 3D, 3E] produce i periodi 1, 3, 4, 5 (mai 1, 2, 3, 4)', () => {
  const day = (cells: Array<{ periodIndex: number; raw: string }>) =>
    anchorPersonalCellsToGrid(cells.map((c, i) => ({ rowIndex: 0, dayOfWeek: 2, periodIndex: c.periodIndex, raw: c.raw })), 5)
      .cells.filter(c => c.raw).map(c => c.periodIndex);

  assert.deepEqual(day([
    { periodIndex: 1, raw: '3D' }, { periodIndex: 2, raw: '' }, { periodIndex: 3, raw: '3D' },
    { periodIndex: 4, raw: '3D' }, { periodIndex: 5, raw: '3E' },
  ]), [1, 3, 4, 5], 'colonna vuota in posizione 2: le ore dopo restano sulle loro colonne');

  // Stessa griglia, ma con il contatore che salta le vuote: ancorare alle colonne la corregge.
  assert.deepEqual(day([
    { periodIndex: 1, raw: '3D' }, { periodIndex: 1, raw: '' }, { periodIndex: 2, raw: '3D' },
    { periodIndex: 3, raw: '3D' }, { periodIndex: 4, raw: '3E' },
  ]), [1, 3, 4, 5], 'una colonna vuota non fa scorrere le ore successive');
});

test('orario personale: numerazione incoerente -> avviso, ma nessuna ora spostata o inventata', () => {
  const payload = {
    rows: ['Manganiello F.'],
    periodsPerDay: 2,
    cells: [
      { rowIndex: 0, dayOfWeek: 1, periodIndex: 1, raw: '3D' },
      { rowIndex: 0, dayOfWeek: 1, periodIndex: 1, raw: '3E' },  // stesso periodo dichiarato due volte
      { rowIndex: 0, dayOfWeek: 1, periodIndex: 7, raw: '3D' },  // fuori dalle colonne dell'intestazione
    ],
  };
  const outcome = parseTimetableAiResponse('personal-support-timetable', payload);
  assert.equal(outcome.positionIssues, 1, 'un giorno incoerente = un avviso (non una ricompattazione)');
  assert.equal(outcome.cells.length, 3, 'nessuna cella scartata');
  assert.deepEqual(outcome.cells.map(c => c.periodIndex), [1, 1, 7], 'le posizioni restano quelle del documento');
  assert.deepEqual(outcome.cells.map(c => c.raw), ['3D', '3E', '3D'], 'nessun valore inventato o spostato');
});

test('orario personale: validazione runtime della risposta AI (shape obbligatoria)', () => {
  assert.deepEqual(validatePersonalTimetablePayload({ rows: ['Manganiello'], cells: [{ rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' }] }).rows, ['Manganiello']);
  for (const bad of [
    { rows: 'x', cells: [] },
    { rows: [], cells: [{ rowIndex: 0, dayOfWeek: 9, periodIndex: 1, raw: '3D' }] },
    { rows: [], cells: [{ rowIndex: 0, dayOfWeek: 1, periodIndex: 0, raw: '3D' }] },
    { rows: [], cells: [{ rowIndex: '0', dayOfWeek: 1, periodIndex: 1, raw: '3D' }] },
    { rows: [], cells: [{ rowIndex: 0, dayOfWeek: 1, periodIndex: 1 }] },
    'ciao',
  ]) {
    assert.throws(() => validatePersonalTimetablePayload(bad), /non valid/i, `deve respingere: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 6. ORARIO CURRICOLARE / ISTITUTO
// ---------------------------------------------------------------------------

const curricularRows: CurricularRawRow[] = [
  { rowIndex: 0, rowLabel: 'Bianchi', subject: 'Matematica', classes: ['3D', '3E'] },
  { rowIndex: 1, rowLabel: 'Verdi', subject: '', classes: ['3D'] },
];

const curricularCells: TimetableRawCell[] = [
  { rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' },
  { rowIndex: 0, dayOfWeek: 2, periodIndex: 2, raw: '3E' },
  { rowIndex: 1, dayOfWeek: 2, periodIndex: 1, raw: '3D' },
  { rowIndex: 1, dayOfWeek: 3, periodIndex: 1, raw: 'Co' },
  { rowIndex: 2, dayOfWeek: 1, periodIndex: 1, raw: '3D' }, // riga sconosciuta
];

test('orario curricolare: estrae materia per classe/giorno/ora; materia assente -> undefined', () => {
  const { slots, skipped } = curricularCellsToSlots(curricularRows, curricularCells);
  assert.equal(slots.length, 3);
  const mardi1 = slots.filter(s => s.dayOfWeek === 2 && s.periodIndex === 1);
  assert.equal(mardi1.length, 2, 'stessa ora: due righe docenti -> due slot');
  assert.ok(mardi1.some(s => s.classLabel === '3D' && s.subject === 'Matematica' && s.confidence === 'high'));
  const noSubject = mardi1.find(s => s.subject === undefined);
  assert.ok(noSubject, 'materia assente resta undefined (mai inventata)');
  assert.equal(noSubject?.confidence, 'low');
  assert.equal(skipped.filter(s => s.reason === 'internal-code').length, 1, 'Co non è una classe');
  assert.equal(skipped.filter(s => s.reason === 'unrecognized').length, 1, 'riga sconosciuta: cella ignorata');
  assert.ok(!slots.some(s => s.classLabel === 'CO'));
});

test('orario curricolare: validazione runtime della risposta AI', () => {
  const ok = validateCurricularTimetablePayload({
    rows: [{ rowIndex: 0, rowLabel: 'Bianchi', subject: 'Matematica', classes: ['3D'] }],
    cells: [{ rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' }],
  });
  assert.equal(ok.rows[0].subject, 'Matematica');
  assert.throws(() => validateCurricularTimetablePayload({ rows: [{ rowIndex: 0 }], cells: [] }), /non valid/i);
  assert.throws(() => validateCurricularTimetablePayload({ rows: [], cells: [{ rowIndex: 0, dayOfWeek: 1, periodIndex: 1, raw: 5 }] }), /non valid/i);
});

// ---------------------------------------------------------------------------
// 7-8. INCROCIO MULTI-DOCUMENTO + SEMAFORO
// ---------------------------------------------------------------------------

const personal: ReturnType<typeof personalCellsToCandidates>['candidates'] = personalCellsToCandidates(personalCells, [1]).candidates;

const curricular: ReturnType<typeof curricularCellsToSlots>['slots'] = [
  { dayOfWeek: 2, periodIndex: 1, classLabel: '3D', subject: 'Matematica', confidence: 'high' },
  { dayOfWeek: 2, periodIndex: 2, classLabel: '3E', subject: 'Inglese', confidence: 'high' },
  { dayOfWeek: 2, periodIndex: 2, classLabel: '3E', subject: 'Matematica', confidence: 'high' },
  { dayOfWeek: 3, periodIndex: 1, classLabel: '1A', subject: 'Scienze', confidence: 'high' },
];

test('incrocio: stesso giorno+ora+classe -> materia associata, una sola -> verde/high', () => {
  const result = crossrefTimetables(personal, curricular);
  const mardi1 = result.find(r => r.dayOfWeek === 2 && r.periodIndex === 1)!;
  assert.deepEqual(mardi1.coTeachingSubjects, ['Matematica']);
  assert.equal(mardi1.status, 'unique');
  assert.equal(mardi1.confidence, 'high');
  assert.equal(reconSignal(mardi1), 'green');
  // Esempio del documento: Martedì 1ª ora 3D -> Matematica.
  assert.equal(mardi1.classLabel, '3D');
});

test('incrocio: due corrispondenze con materie diverse -> ambiguous/giallo "Più materie possibili"', () => {
  const result = crossrefTimetables(personal, curricular);
  const mardi2 = result.find(r => r.dayOfWeek === 2 && r.periodIndex === 2)!;
  assert.equal(mardi2.status, 'ambiguous');
  assert.equal(reconSignal(mardi2), 'yellow');
  assert.equal(mardi2.note, RECON_NOTES.ambiguous);
  assert.deepEqual(dedupeSubjects(mardi2.coTeachingSubjects), ['Inglese', 'Matematica']);
});

test('incrocio: nessuna corrispondenza -> materia non identificata (mai inventata)', () => {
  const result = crossrefTimetables(personal, curricular);
  const lunedi1 = result.find(r => r.dayOfWeek === 1 && r.periodIndex === 1)!;
  assert.equal(lunedi1.status, 'none');
  assert.equal(lunedi1.coTeachingSubjects.length, 0);
  assert.equal(lunedi1.note, RECON_NOTES.none);
  assert.equal(reconSignal(lunedi1), 'red');
});

test('incrocio: classi diverse / giorno diverso / ora diversa non matchano', () => {
  const one = [{ id: 'x', dayOfWeek: 2, periodIndex: 1, classLabel: '3E', sourceType: 'personal-support-timetable' as const, confidence: 'high' as const }];
  assert.equal(crossrefTimetables(one, curricular)[0].status, 'none', 'classe 3E ≠ 3D');
  const oneDay = [{ id: 'x', dayOfWeek: 3, periodIndex: 1, classLabel: '3D', sourceType: 'personal-support-timetable' as const, confidence: 'high' as const }];
  assert.equal(crossrefTimetables(oneDay, curricular)[0].status, 'none', 'giorno diverso non matcha');
  const onePeriod = [{ id: 'x', dayOfWeek: 2, periodIndex: 3, classLabel: '3D', sourceType: 'personal-support-timetable' as const, confidence: 'high' as const }];
  assert.equal(crossrefTimetables(onePeriod, curricular)[0].status, 'none', 'ora diversa non matcha');
  // Normalizzazione: "3d" === "3D".
  assert.ok(sameClassLabel('3d', '3D'));
  assert.ok(!sameClassLabel('3D', '3E'));
  const oneLower = [{ id: 'x', dayOfWeek: 2, periodIndex: 1, classLabel: '3d', sourceType: 'personal-support-timetable' as const, confidence: 'high' as const }];
  assert.equal(crossrefTimetables(oneLower, curricular)[0].status, 'unique');
});

test('incrocio: slot senza classe (sos) -> non identificabile, mai forzato', () => {
  const sosSlot = personal.find(p => !p.classLabel && p.dayOfWeek === 3)!;
  const result = crossrefTimetables([sosSlot], curricular);
  assert.equal(result[0].status, 'none');
  assert.equal(result[0].note, RECON_NOTES.noClass);
  assert.equal(result[0].coTeachingSubjects.length, 0);
});

test('incrocio: 1:1 con gli slot personali (non aggiunge slot nuovi)', () => {
  const result = crossrefTimetables(personal, curricular);
  assert.equal(result.length, personal.length);
});

// ---------------------------------------------------------------------------
// 10. MODELLO ESISTENTE (TimetableSlot + coTeachingSubjects)
// ---------------------------------------------------------------------------

test('modello: slot ricostruiti usano TimetableSlot, subject "Sostegno", materia in coTeachingSubjects', () => {
  const recon = crossrefTimetables(personal, curricular).map(s => ({ ...s, correctedClass: s.classLabel ?? '', correctedSubject: s.coTeachingSubjects.length === 1 ? s.coTeachingSubjects[0] : '' }));
  const slots = reconstructedToTimetableSlots(recon, { profile, timeSlotConfig: undefined, schoolId: 'school-x' });
  assert.equal(slots.length, 5, 'slot senza classe non salvati (mai inventata)');
  for (const slot of slots) {
    assert.equal(slot.subject, SUPPORT_TEACHER_SUBJECT, 'materia principale resta Sostegno');
    assert.equal(slot.schoolId, 'school-x');
    assert.ok(typeof slot.id === 'string' && slot.id.length > 0);
    assert.ok(!('coSupportTeachers' in slot), 'niente docenti extra obbligatori');
  }
  const mardi1 = slots.find(s => s.dayOfWeek === 2 && s.periodNumber === 1)!;
  assert.deepEqual(mardi1.coTeachingSubjects, ['Matematica'], 'materia in compresenza nel campo esistente');
  assert.equal(mardi1.className, '3D');
  assert.ok(mardi1.startTime && mardi1.endTime && mardi1.endTime > mardi1.startTime, 'fasce orarie valide dalla configurazione');
  // Il modello orario esistente non ha (e non riceve) il nome del docente curricolare.
  const json = JSON.stringify(slots);
  assert.ok(!/docenteCurricolare|curricularTeacher/i.test(json));
  // Compatibile con lo schema di sincronizzazione Firestore (validazione remota).
  assert.ok(isValidTimetablePayload(slots), 'slot validi per il modello di sync esistente');
});

test('modello: docente non di sostegno -> materia trovata come subject principale', () => {
  const curricularProfile = { ...profile, isSupportTeacher: false, primarySubjects: ['Matematica'] };
  const recon = [{
    id: 'r1', dayOfWeek: 2, periodIndex: 1, classLabel: '3D', coTeachingSubjects: ['Matematica'],
    status: 'unique' as const, confidence: 'high' as const, selected: true, correctedClass: '3D', correctedSubject: 'Matematica',
  }];
  const slots = reconstructedToTimetableSlots(recon, { profile: curricularProfile });
  assert.equal(slots[0].subject, 'Matematica');
  assert.equal(isSupportTeacherProfile(profile), true);
  assert.equal(isSupportTeacherProfile(curricularProfile), false);
});

test('fasce orarie: periodIndex oltre la configurazione viene prolungato con la stessa durata standard', () => {
  const config = { firstHourStartTime: '07:50', periodsPerDay: 5, standardDurationMinutes: 55 };
  assert.deepEqual(periodTimesForIndex(config, 1), { startTime: '07:50', endTime: '08:45' });
  assert.deepEqual(periodTimesForIndex(config, 6), { startTime: '12:25', endTime: '13:20' });
  assert.deepEqual(periodTimesForIndex(undefined, 2), { startTime: '08:50', endTime: '09:50' });
});

// ---------------------------------------------------------------------------
// 11-12. CONFERMA UMANA + ORARIO ESISTENTE
// ---------------------------------------------------------------------------

const existing: TimetableSlot[] = [
  { id: 'ex-1', dayOfWeek: 2, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3D', schoolId: 'school-x' },
  { id: 'ex-2', dayOfWeek: 5, periodNumber: 2, startTime: '10:15', endTime: '11:10', subject: 'Sostegno', className: '3E', schoolId: 'school-x' },
];

test('conferma: orario esistente NON sovrascritto (default "solo mancanti")', () => {
  const recon = [{
    id: 'r1', dayOfWeek: 2, periodIndex: 1, classLabel: '3D', coTeachingSubjects: ['Matematica'],
    status: 'unique' as const, confidence: 'high' as const, selected: true, correctedClass: '3D', correctedSubject: 'Matematica',
  }, {
    id: 'r2', dayOfWeek: 1, periodIndex: 1, classLabel: '3E', coTeachingSubjects: [],
    status: 'none' as const, confidence: 'low' as const, selected: true, correctedClass: '3E', correctedSubject: '',
  }];
  const incoming = reconstructedToTimetableSlots(recon, { profile, schoolId: 'school-x' });
  const merged = applyReconstruction(existing, incoming, 'missing-only');
  assert.equal(merged.addedCount, 1, 'solo lo slot mancante è aggiunto');
  assert.equal(merged.replacedCount, 0, 'nessuna sostituzione in modalità missing-only');
  assert.equal(merged.slots.length, 3);
  const kept = merged.slots.find(s => s.id === 'ex-1')!;
  assert.equal(kept.subject, 'Sostegno');
  assert.ok(!('coTeachingSubjects' in kept), 'lo slot esistente resta intatto');
});

test('conferma: "Sostituisci" è una sostituzione REALE nell’ambito della ricostruzione', () => {
  const recon = [{
    id: 'r1', dayOfWeek: 2, periodIndex: 1, classLabel: '3D', coTeachingSubjects: ['Matematica'],
    status: 'unique' as const, confidence: 'high' as const, selected: true, correctedClass: '3D', correctedSubject: 'Matematica',
  }];
  const incoming = reconstructedToTimetableSlots(recon, { profile, schoolId: 'school-x' });
  const merged = applyReconstruction(existing, incoming, 'replace-scope', { profile });
  assert.equal(merged.replacedCount, 1);
  assert.equal(merged.addedCount, 0);
  const replaced = merged.slots.find(s => s.dayOfWeek === 2 && s.periodNumber === 1)!;
  assert.deepEqual(replaced.coTeachingSubjects, ['Matematica']);
  // Errore storico: "ex-2" (venerdì) sopravviveva perché nessuna coordinata coincideva.
  assert.equal(merged.slots.find(s => s.id === 'ex-2'), undefined, 'le vecchie ore di sostegno non presenti nel nuovo orario vengono rimosse');
  assert.equal(merged.removedCount, 1);
  assert.equal(merged.untouchedCount, 0);
});

// ---------------------------------------------------------------------------
// 11-bis. AMBITO DELLA SOSTITUZIONE: cosa deve restare intatto
// ---------------------------------------------------------------------------

const supportSlot = (
  id: string, dayOfWeek: number, periodNumber: number, extra: Partial<TimetableSlot> = {}
): TimetableSlot => ({
  id, dayOfWeek: dayOfWeek as TimetableSlot["dayOfWeek"], periodNumber,
  startTime: '08:15', endTime: '09:10', subject: SUPPORT_TEACHER_SUBJECT, className: '3D', ...extra,
});

test('replace: non tocca ore di materia dello stesso istituto né ore di altri istituti', () => {
  const primary = normalizeTeacherProfile(profile).schools?.find(s => s.isPrimary)?.id;
  const existingSlots = [
    supportSlot('ex-match', 2, 1),
    supportSlot('ex-solo-vecchia', 4, 1),
    supportSlot('ex-materia', 3, 1, { subject: 'Matematica' }),
    supportSlot('ex-altro-istituto-sostegno', 4, 1, { schoolId: 'school-b' }),
    supportSlot('ex-altro-istituto-materia', 5, 1, { schoolId: 'school-b', subject: 'Fisica' }),
  ];
  const incoming = [supportSlot('new-1', 2, 1, { schoolId: primary })];
  const merged = applyReconstruction(existingSlots, incoming, 'replace-scope', { profile });
  assert.deepEqual(
    merged.slots.map(s => s.id),
    ['ex-materia', 'ex-altro-istituto-sostegno', 'ex-altro-istituto-materia', 'new-1']
  );
  assert.equal(merged.replacedCount, 1, 'martedì: l’ora esistente viene sostituita');
  assert.equal(merged.removedCount, 1, 'giovedì: la vecchia ora di sostegno dello stesso istituto non sopravvive');
  assert.equal(merged.untouchedCount, 3, 'materia dello stesso istituto e ore degli altri istituti intatte');
  assert.equal(merged.slots.find(s => s.id === 'ex-materia')?.className, '3D', 'la materia curricolare resta com’era');
  assert.equal(merged.slots.find(s => s.id === 'ex-altro-istituto-sostegno')?.schoolId, 'school-b', 'l’altro istituto non è nell’ambito');
});

test('replace: stessa coordinata ma natura diversa non viene cancellata', () => {
  const existingSlots = [supportSlot('ex-materia', 2, 1, { subject: 'Matematica', className: '1A' })];
  const incoming = [supportSlot('new-sostegno', 2, 1)];
  const merged = applyReconstruction(existingSlots, incoming, 'replace-scope', { profile });
  assert.ok(merged.slots.some(s => s.id === 'ex-materia'), 'un’ora di materia non è dell’orario di sostegno');
  assert.equal(merged.removedCount, 0);
  assert.equal(merged.slots.length, 2);
});

test('replace: gli slot legacy senza schoolId sono dell’istituto principale; senza profilo nessuna rimozione a sorpresa', () => {
  const primary = normalizeTeacherProfile(profile).schools?.find(s => s.isPrimary)?.id;
  const legacy = [supportSlot('ex-legacy', 4, 1)];
  const incoming = [supportSlot('new-1', 2, 1, { schoolId: primary })];
  assert.equal(applyReconstruction(legacy, incoming, 'replace-scope', { profile }).slots.length, 1, 'con il profilo l’ambito è determinato');
  const cautious = applyReconstruction(legacy, incoming, 'replace-scope');
  assert.equal(cautious.removedCount, 0, 'senza profilo non si eliminano dati incerti');
  assert.equal(cautious.slots.length, 2);
});

test('replace: insieme misto (sostegno + materia) sostituisce entrambe le nature dello stesso istituto', () => {
  const existingSlots = [
    supportSlot('ex-sostegno', 2, 1),
    supportSlot('ex-materia', 3, 1, { subject: 'Matematica' }),
    supportSlot('ex-altro-istituto', 4, 1, { schoolId: 'school-b' }),
  ];
  const incoming = [supportSlot('new-1', 2, 1), supportSlot('new-2', 3, 1, { subject: 'Matematica' })];
  const merged = applyReconstruction(existingSlots, incoming, 'replace-scope', { profile });
  assert.deepEqual(merged.slots.map(s => s.id), ['ex-altro-istituto', 'new-1', 'new-2']);
});

test('merge "solo mancanti": nessuna sovrascrittura e nessuna coordinata duplicata', () => {
  const existingSlots = [supportSlot('ex-1', 2, 1, { className: '3D' })];
  const incoming = [supportSlot('new-dup', 2, 1, { className: '3E' }), supportSlot('new-2', 3, 1)];
  const merged = applyReconstruction(existingSlots, incoming, 'missing-only', { profile });
  assert.equal(merged.addedCount, 1);
  assert.equal(merged.replacedCount, 0);
  assert.equal(merged.slots.length, 2, 'lo slot già presente non viene duplicato');
  assert.equal(merged.slots.find(s => s.dayOfWeek === 2)?.className, '3D', 'l’orario esistente non è toccato');
  const keys = merged.slots.map(s => `${s.schoolId ?? ""}|${s.dayOfWeek}|${s.periodNumber}`);
  assert.equal(new Set(keys).size, keys.length, 'nessuna coordinata due volte');
});

test('salvataggio reale: dopo la conferma gli orari persistono in archivio (anche chiudendo il modale)', async () => {
  const { database } = await import('../src/services/db');
  const { storage, initializeStorage } = await import('../src/services/storage');
  // L’archivio richiede un localStorage (fallback legacy): stub in-memory del test.
  const memory = new Map<string, string>();
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return memory.size; },
      key: (index: number) => [...memory.keys()][index] ?? null,
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, String(value)); },
      removeItem: (key: string) => { memory.delete(key); },
    },
  });
  database.close();
  await database.delete();
  await initializeStorage();

  const primary = normalizeTeacherProfile(profile).schools?.find(s => s.isPrimary)?.id;
  await storage.saveProvisionalTimetable([
    supportSlot('ex-old-thu', 4, 1, { schoolId: primary }),
    supportSlot('ex-old-fri', 5, 2, { schoolId: primary }),
    supportSlot('ex-materia', 2, 3, { subject: 'Matematica', schoolId: primary }),
  ]);

  // Esattamente quello che fa App.handleSaveReconstructedTimetable alla conferma.
  const incoming = [supportSlot('recon-1', 2, 1, { schoolId: primary }), supportSlot('recon-2', 3, 1, { schoolId: primary })];
  await database.atomic(async () => {
    const current = await storage.getProvisionalTimetable();
    const merged = applyReconstruction(current, incoming, 'replace-scope', { profile });
    await storage.saveProvisionalTimetable(merged.slots);
  });

  const persisted = await storage.getProvisionalTimetable();
  assert.deepEqual(persisted.map(s => s.id).sort(), ['ex-materia', 'recon-1', 'recon-2'], 'le vecchie ore di sostegno sono realmente sostituite');

  // Lo snapshot che l’app legge all’avvio (dopo una chiusura/refresh): gli orari
  // vengono dall’archivio, non dallo stato del modale.
  const snapshot = await database.readSnapshot();
  assert.deepEqual(snapshot.provisionalTimetable.map(s => s.id).sort(), ['ex-materia', 'recon-1', 'recon-2']);
  assert.equal(snapshot.provisionalTimetable.some(s => s.id === 'ex-old-thu' || s.id === 'ex-old-fri'), false,
    'le vecchie ore non sono più nell’archivio: la sostituzione è reale anche su disco');

  // Ri-apertura dell’app (l’utente ha chiuso il modale): l’archivio viene riletto e
  // contiene ancora gli slot confermati, perché il salvataggio è avvenuto alla conferma.
  database.close();
  await initializeStorage();
  const afterReopen = (await storage.getProvisionalTimetable()).map(s => s.id).sort();
  assert.deepEqual(afterReopen, ['ex-materia', 'recon-1', 'recon-2']);
  await database.close();
  if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
  else delete (globalThis as any).localStorage;
});

test('preview di merge: gli stessi conteggi del salvataggio, usati per avvisare l’utente', async () => {
  const { previewReconstruction } = await import('../src/utils/reconstructTimetable');
  const existingSlots = [supportSlot('ex-1', 2, 1), supportSlot('ex-2', 4, 1)];
  const incoming = [supportSlot('new-1', 2, 1)];
  assert.deepEqual(previewReconstruction(existingSlots, incoming, 'replace-scope', { profile }), {
    addedCount: 0, replacedCount: 1, removedCount: 1, untouchedCount: 0,
  });
  assert.deepEqual(previewReconstruction(existingSlots, incoming, 'missing-only', { profile }), {
    addedCount: 0, replacedCount: 0, removedCount: 0, untouchedCount: 2,
  });
  // L’anteprima non ha alcun effetto: i conteggi applicati sono identici.
  assert.deepEqual(applyReconstruction(existingSlots, incoming, 'replace-scope', { profile }).slots.map(s => s.id), ['new-1']);
});

test('conferma: slot deselezionato non salvato; modifica manuale della materia rispettata', () => {
  const recon = [
    { id: 'r1', dayOfWeek: 2, periodIndex: 1, classLabel: '3D', coTeachingSubjects: ['Matematica'], status: 'unique' as const, confidence: 'high' as const, selected: true, correctedClass: '3D', correctedSubject: 'Storia' },
    { id: 'r2', dayOfWeek: 1, periodIndex: 1, classLabel: '3E', coTeachingSubjects: [], status: 'none' as const, confidence: 'low' as const, selected: false, correctedClass: '3E', correctedSubject: '' },
    { id: 'r3', dayOfWeek: 3, periodIndex: 1, classLabel: undefined, coTeachingSubjects: [], status: 'none' as const, confidence: 'low' as const, selected: true, correctedClass: '', correctedSubject: '' },
  ];
  const slots = reconstructedToTimetableSlots(recon, { profile, schoolId: 'school-x' });
  assert.equal(slots.length, 1, 'deselezionato + senza classe esclusi dal salvataggio');
  assert.equal(slots[0].className, '3D');
  assert.deepEqual(slots[0].coTeachingSubjects, ['Storia'], 'la correzione manuale dell\'utente vince sulla proposta');
  assert.equal(slots[0].subject, 'Sostegno');
});

// ---------------------------------------------------------------------------
// 12-bis. AMBITO DELLA FASE CURRICOLARE: solo le MIE compresenze
// ---------------------------------------------------------------------------

/** Coordinate personali del docente: 3D martedì 1ª e venerdì 1ª, 3E mercoledì 2ª, un sostegno senza classe. */
const myPersonalCells: TimetableRawCell[] = [
  { rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' },
  { rowIndex: 0, dayOfWeek: 3, periodIndex: 2, raw: '3E' },
  { rowIndex: 0, dayOfWeek: 4, periodIndex: 3, raw: 'sos' },
  { rowIndex: 0, dayOfWeek: 5, periodIndex: 1, raw: '3D' },
];

/** Tabella d’istituto “vera”: decine di classi × 5 giorni × 6 ore, più i casi limite. */
const noiseClasses = ['1A', '1B', '2A', '2B', '3A', '3B', '3C', '4A', '4B', '5A', '5B'];
const curricularRowsFixture: CurricularRawRow[] = [
  { rowIndex: 0, rowLabel: 'Rossi', subject: 'Matematica', classes: ['3D'] },
  { rowIndex: 1, rowLabel: 'Bianchi', subject: 'Italiano', classes: ['3E'] },
  { rowIndex: 2, rowLabel: 'Neri', subject: 'Inglese', classes: ['3E'] },
  { rowIndex: 3, rowLabel: 'Verdi', subject: 'Scienze', classes: ['1A'] },
  ...noiseClasses.map((className, i) => ({
    rowIndex: 4 + i, rowLabel: `Docente ${i + 1}`, subject: `Materia ${i + 1}`, classes: [className],
  })),
];

const curricularCellsFixture: TimetableRawCell[] = [
  // Le mie coordinate: una materia (martedì 1ª 3D) e DUE materie (mercoledì 2ª 3E) -> ambigua.
  { rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' },
  { rowIndex: 1, dayOfWeek: 3, periodIndex: 2, raw: '3E' },
  { rowIndex: 2, dayOfWeek: 3, periodIndex: 2, raw: '3E' },
  // Classe giusta ma giorno/periodo diverso (3D giovedì 3ª, 3D lunedì 1ª).
  { rowIndex: 0, dayOfWeek: 4, periodIndex: 3, raw: '3D' },
  { rowIndex: 0, dayOfWeek: 1, periodIndex: 1, raw: '3D' },
  // Giorno/periodo giusti ma classe diversa (venerdì 1ª -> 1A; martedì 1ª -> 3A).
  { rowIndex: 3, dayOfWeek: 5, periodIndex: 1, raw: '1A' },
  { rowIndex: 3, dayOfWeek: 2, periodIndex: 1, raw: '3A' },
  // Rumore d’istituto: tutte le altre classi su tutta la settimana.
  ...noiseClasses.flatMap((className, i) =>
    [1, 2, 3, 4, 5].flatMap(dayOfWeek =>
      [1, 2, 3, 4, 5, 6].map(periodIndex => ({ rowIndex: 4 + i, dayOfWeek, periodIndex, raw: className }))
    )
  ),
];

test('ambito curricolare: solo le coordinate (giorno, periodo, classe) del mio orario sopravvivono', () => {
  const extraction = curricularCellsToSlots(curricularRowsFixture, curricularCellsFixture);
  const coordinates = buildPersonalCoordinateScope({ candidates: personalCellsToCandidates(myPersonalCells, [0]).candidates });

  const before = extraction.slots.length;
  assert.ok(before > 300, `la tabella d’istituto è grande davvero (${before} slot)`);

  const scoped = restrictCurricularSlotsToCoordinates(extraction.slots, coordinates);
  assert.deepEqual(
    scoped.slots.map(s => `${s.dayOfWeek}|${s.periodIndex}|${s.classLabel}|${s.subject}`).sort(),
    ['2|1|3D|Matematica', '3|2|3E|Inglese', '3|2|3E|Italiano'],
    'restano solo le mie ore, con le materie che le riguardano'
  );
  assert.equal(scoped.droppedCount, before - 3, 'tutto il resto è scartato prima della UI');
  // classi corrette in giorno/periodo diversi e giorno/periodo corretti in altre classi
  assert.ok(!scoped.slots.some(s => s.dayOfWeek === 4 || s.dayOfWeek === 1), 'giorno/periodo diversi esclusi');
  assert.ok(!scoped.slots.some(s => s.classLabel !== '3D' && s.classLabel !== '3E'), 'altre classi escluse');
  assert.equal(scoped.slots.filter(s => s.classLabel === '3D' && s.dayOfWeek === 5).length, 0, 'la classe 1A di venerdì non diventa una mia materia');
});

test('ambito curricolare: incrocio 1:1 con le mie ore — unique, ambiguous e none preservati, nessuna materia inventata', () => {
  const candidates = personalCellsToCandidates(myPersonalCells, [0]).candidates;
  const coordinates = buildPersonalCoordinateScope({ candidates });
  const scoped = restrictCurricularSlotsToCoordinates(curricularCellsToSlots(curricularRowsFixture, curricularCellsFixture).slots, coordinates);
  const reconstruction = crossrefTimetables(candidates, scoped.slots);

  assert.equal(reconstruction.length, candidates.length, 'un output per ogni ora personale, mai di più');
  const byCoord = (day: number, period: number) => reconstruction.find(r => r.dayOfWeek === day && r.periodIndex === period)!;

  const tue = byCoord(2, 1);
  assert.equal(tue.status, 'unique');
  assert.equal(tue.confidence, 'high');
  assert.deepEqual(tue.coTeachingSubjects, ['Matematica'], 'una sola materia -> certa');

  const wed = byCoord(3, 2);
  assert.equal(wed.status, 'ambiguous', 'più materie sulla stessa coordinata -> scelta manuale');
  assert.deepEqual(wed.coTeachingSubjects, ['Italiano', 'Inglese']);

  const fri = byCoord(5, 1);
  assert.equal(fri.status, 'none', 'ora personale senza materia nella tabella -> nessuna materia');
  assert.deepEqual(fri.coTeachingSubjects, []);
  // Le uniche materie che circolano sono quelle delle mie coordinate: niente rumore d’istituto.
  const subjects = [...new Set(reconstruction.flatMap(r => r.coTeachingSubjects))].sort();
  assert.deepEqual(subjects, ['Inglese', 'Italiano', 'Matematica']);
  assert.ok(!reconstruction.some(r => /Scienze|Materia \d|3A|1A/.test(JSON.stringify(r))),
    'materie e classi non pertinenti non entrano nella ricostruzione');

  const supportHour = byCoord(4, 3);
  assert.equal(supportHour.status, 'none', 'ora personale senza classe: la classe non viene inventata');
  assert.equal(supportHour.note, RECON_NOTES.noClass);
  assert.deepEqual(supportHour.coTeachingSubjects, [], 'la 3D di giovedì non viene assegnata al mio sostegno senza classe');

  // Cosa verrebbe salvato: solo le mie classi, senza materie inventate.
  const slotsToSave = reconstruction.filter(r => r.status === 'unique' || (r.status === 'ambiguous' && r.coTeachingSubjects.length === 1))
    .map(r => ({ ...r, correctedClass: r.classLabel ?? '', correctedSubject: r.coTeachingSubjects[0] ?? '' }));
  const saved = reconstructedToTimetableSlots(slotsToSave, { profile });
  assert.deepEqual(saved.map(s => `${s.dayOfWeek}-${s.periodNumber}:${s.className}`), ['2-1:3D']);
});

test('ambito curricolare: le ore già salvate contano (Fase B dopo il salvataggio, modale riaperto)', () => {
  const fromArchive = buildPersonalCoordinateScope({
    candidates: [],
    savedSlots: [
      { dayOfWeek: 2, periodNumber: 1, className: '3 D' },   // spazi diversi: stessa classe
      { dayOfWeek: 5, periodNumber: 1, className: '3E' },
    ],
  });
  assert.deepEqual(fromArchive.map(c => c.key), ['2|1|3D', '5|1|3E']);

  const scoped = restrictCurricularSlotsToCoordinates(curricularCellsToSlots(curricularRowsFixture, curricularCellsFixture).slots, fromArchive);
  assert.deepEqual(scoped.slots.map(s => `${s.dayOfWeek}|${s.periodIndex}|${s.classLabel}`), ['2|1|3D'],
    'venerdì 1ª: la tabella non ha una 3E in quella ora, quindi niente materia');

  // Nessun orario personale -> nessun filtro (la fase curricolare non viene svuotata).
  const nothing = restrictCurricularSlotsToCoordinates(curricularCellsToSlots(curricularRowsFixture, curricularCellsFixture).slots, []);
  assert.equal(nothing.droppedCount, 0);
});

test('riepilogo copertura: ore del mio orario, trovate, ambigue, non identificate', () => {
  const coordinates = buildPersonalCoordinateScope({ candidates: personalCellsToCandidates(myPersonalCells, [0]).candidates });
  const scoped = restrictCurricularSlotsToCoordinates(curricularCellsToSlots(curricularRowsFixture, curricularCellsFixture).slots, coordinates);
  const summary = summarizeCurricularCoverage(coordinates, scoped.slots);
  assert.deepEqual(summary, { hours: 3, found: 1, ambiguous: 1, missing: 1 });
  assert.equal(coordinates.length, 3, 'l’ora di sostegno senza classe non diventa una coordinata inventata');

  // Senza tabella curricolare: tutte le mie ore restano "non identificate".
  assert.deepEqual(summarizeCurricularCoverage(coordinates, []), { hours: 3, found: 0, ambiguous: 0, missing: 3 });
});

// ---------------------------------------------------------------------------
// 13-14. REGISTRO / APPUNTI + MATCHING STUDENTI
// ---------------------------------------------------------------------------

test('registro: validazione runtime impegni (niente date/ora inventati dai campi opzionali)', () => {
  const parsed = validateStudentCommitmentsPayload([
    { title: 'Verifica di matematica', type: 'written_test', studentNameRaw: 'Rossi Matteo', date: '2026-09-15', startTime: '08:50', rawText: 'Verifica matematica 15/09' },
    { title: 'Colloquio', type: 'meeting', studentNameRaw: '', rawText: 'Colloquio 20/09' },
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].date, '2026-09-15');
  assert.equal(parsed[1].date, undefined, 'data non visibile -> undefined (mai inventata)');
  assert.equal(parsed[1].startTime, undefined, 'ora non visibile -> undefined');
  assert.throws(() => validateStudentCommitmentsPayload([{ title: 'x', type: 'ballgame' }]), /non valid/i);
  assert.throws(() => validateStudentCommitmentsPayload([{ title: '', type: 'other' }]), /non valid/i);
  assert.throws(() => validateStudentCommitmentsPayload([{ title: 'x', type: 'other', date: '2026-02-31' }]), /data non valida/i);
  assert.throws(() => validateStudentCommitmentsPayload([{ title: 'x', type: 'other', startTime: '25:99' }]), /ora di inizio non valida/i);
  assert.throws(() => validateStudentCommitmentsPayload([{ title: 'x', type: 'other', endTime: '9:00' }]), /ora di fine non valida/i);
});

test('matching studenti: exact / probable / ambiguous / unmatched', () => {
  // EXACT: stesso nome completo, ordine indifferente, accenti/spazi normalizzati.
  const exact = matchStudentName('Rossi Matteo', students);
  assert.equal(exact.status, 'exact');
  assert.equal(exact.matchedStudentId, 'stu-rossi');
  const exactReversed = matchStudentName('matteo rossi', students);
  assert.equal(exactReversed.status, 'exact');
  const exactAccents = matchStudentName('fernandez andrea', students);
  assert.equal(exactAccents.status, 'exact', 'accenti indifferenti');

  // PROBABLE: cognome + iniziale (registro "ROSSI M.").
  const probable = matchStudentName('Rossi M.', students);
  assert.equal(probable.status, 'probable');
  assert.equal(probable.matchedStudentId, 'stu-rossi');
  // Cognome solo -> probable unico.
  const surnameOnly = matchStudentName('Bianchi', students.filter(s => s.id === 'stu-bianchi'));
  assert.equal(surnameOnly.status, 'probable');

  // AMBIGUOUS: due Bianchi -> nessuna scelta automatica.
  const ambiguous = matchStudentName('Bianchi', students);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.matchedStudentId, undefined, 'mai scelta automatica tra più candidati');
  assert.equal(ambiguous.candidates.length, 2);

  // UNMATCHED: nessun candidato plausibile.
  const unmatched = matchStudentName('Zanardi Paolo', students);
  assert.equal(unmatched.status, 'unmatched');
  assert.equal(studentMatchLabel(unmatched), 'Alunno non riconosciuto');
});

test('matching studenti: niente fuzzy aggressivo (un solo refuso sul cognome, mai di più)', () => {
  const typo = matchStudentName('Rossi Matteao', students);
  assert.equal(typo.status, 'probable', 'un carattere di differenza sul nome -> probabile');
  const far = matchStudentName('Russo Antonello', students);
  assert.equal(far.status, 'unmatched', 'distanze maggiori non matchano');
  assert.equal(parsePersonName('ROSSI M.').surname, 'rossi');
  assert.equal(parsePersonName('M. Rossi').surname, 'rossi');
  assert.equal(parsePersonName('marta maria').surname, 'maria');
  assert.equal(foldName("D'Angelo  Maria"), "d angelo maria");
});

test('matching studenti: nessun nuovo studente creato (solo selezione dall\'elenco locale)', () => {
  const unmatched = matchStudentName('Persona Nuova', students);
  assert.equal(unmatched.matchedStudentId, undefined);
  assert.equal(unmatched.candidates.length, 0);
  // L'API non espone alcuna creazione: il risultato indica solo chi è (probabilmente) lui.
  assert.equal(typeof (matchStudentName as unknown as { create?: unknown }).create, 'undefined');
});

// ---------------------------------------------------------------------------
// 15-16. PRIVACY (lato dati) + CONSENSO
// ---------------------------------------------------------------------------

test('privacy: validazione file per la scansione (formati e 5MB coerenti con il server)', () => {
  assert.equal(documentFileError({ name: 'foto.jpg', type: 'image/jpeg', size: 100_000 }), null);
  assert.equal(documentFileError({ name: 'doc.pdf', type: 'application/pdf', size: 10_000 }), null);
  assert.match(documentFileError({ name: 'note.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 1000 })!, /non supportato/i);
  assert.match(documentFileError({ name: 'foto.jpg', type: 'image/jpeg', size: MAX_DOCUMENT_BYTES + 1 })!, /5 MB/i);
  assert.equal(formatFileSize(1500), '1 KB');
  assert.equal(formatFileSize(6 * 1024 * 1024), '6.0 MB');
  // Attributi input: fotocamera posteriore preferita + fallback file.
  assert.equal(CAMERA_INPUT_PROPS.accept, 'image/*');
  assert.equal(CAMERA_INPUT_PROPS.capture, 'environment');
  assert.equal(CAMERA_INPUT_PROPS.capture === 'environment', true);
  assert.ok(!('capture' in FILE_INPUT_PROPS), 'il file picker non forza la fotocamera');
  assert.ok(FILE_INPUT_PROPS.accept.includes('image/*') && FILE_INPUT_PROPS.accept.includes('application/pdf'));
});

test('privacy: il messaggio offline è esplicito e i documenti non entrano nei dati locali', () => {
  assert.equal(OFFLINE_ANALYSIS_MESSAGE, 'L\'analisi intelligente richiede una connessione Internet.');
  // Il modello dati (LocalData) non ha campi immagine: nessun percorso di persistenza
  // per foto/base64 (verificato anche a livello UI/backup nei test dedicati).
  const data = { profile, events: [], circulars: [], students: [], definitiveTimetable: [], provisionalTimetable: [], timetableMode: 'auto', onboardingCompleted: true };
  const json = JSON.stringify(data);
  assert.ok(!/imageBase64|previewUrl/.test(json));
});

// ---------------------------------------------------------------------------
// 19. MULTI-ISTITUTO (lato dati)
// ---------------------------------------------------------------------------

test('multi-istituto: mono istituto senza UI extra; multi istituto con schoolId corretto', () => {
  const single = normalizeTeacherProfile({ ...profile });
  assert.equal(single.schools?.length, 1);
  const primaryId = single.schools?.find(s => s.isPrimary)?.id;
  assert.ok(primaryId);

  const multi: TeacherProfile = {
    ...profile,
    schools: [
      { id: 'school-a', name: 'IC Da Vinci', isPrimary: true, active: true },
      { id: 'school-b', name: 'Liceo Fermi', isPrimary: false, active: true, weeklyHours: 4 },
    ],
  };
  const normalized = normalizeTeacherProfile(multi);
  assert.equal(normalized.schools?.length, 2);
  const secondary = normalized.schools?.find(s => !s.isPrimary && s.active !== false);
  assert.ok(secondary);

  // L'orario ricostruito riceve la schoolId scelta (o quella principale di default).
  const recon = [{
    id: 'r1', dayOfWeek: 2, periodIndex: 1, classLabel: '3D', coTeachingSubjects: ['Matematica'],
    status: 'unique' as const, confidence: 'high' as const, selected: true, correctedClass: '3D', correctedSubject: 'Matematica',
  }];
  const defaultSlots = reconstructedToTimetableSlots(recon, { profile: multi });
  assert.equal(defaultSlots[0].schoolId, 'school-a', 'default: istituto principale');
  const chosenSlots = reconstructedToTimetableSlots(recon, { profile: multi, schoolId: 'school-b' });
  assert.equal(chosenSlots[0].schoolId, 'school-b', 'scelta esplicita rispettata');
  const singleSlots = reconstructedToTimetableSlots(recon, { profile: single });
  assert.equal(singleSlots[0].schoolId, primaryId, 'mono istituto: schoolId determinabile senza UI extra');
});

// ---------------------------------------------------------------------------
// 9d. BUG REALE (iPhone, dopo il formato denso): la fase di parsing NON deve
//     far finire l'analisi nel catch generico ("Analisi non riuscita. Riprova.")
// ---------------------------------------------------------------------------

/**
 * Payload realistico nel formato denso richiesto all'AI: `teacherRows` righe
 * docente, 5 giorni x `columns` colonne, celle vuote riportate ESPLICITE.
 */
function denseTeamPayload(
  teacherRows: number,
  columns = 5,
  options: { periodsPerDay?: unknown; emptyStyle?: 'empty' | 'null' | 'omitted' } = {}
) {
  const cells: Array<Record<string, unknown>> = [];
  for (let row = 0; row < teacherRows; row++) {
    for (let day = 1; day <= 5; day++) {
      for (let col = 1; col <= columns; col++) {
        const filled = (row + day + col) % 3 !== 0;
        if (!filled && options.emptyStyle === 'omitted') continue;
        cells.push({
          rowIndex: row,
          dayOfWeek: day,
          periodIndex: col,
          raw: filled ? `${(row % 3) + 1}${'ABCDE'[col % 5]}` : options.emptyStyle === 'null' ? null : '',
        });
      }
    }
  }
  const payload: Record<string, unknown> = {
    rows: Array.from({ length: teacherRows }, (_, i) => `Docente ${i + 1}`),
    cells,
  };
  if (options.periodsPerDay !== undefined) payload.periodsPerDay = options.periodsPerDay;
  return payload;
}

test('formato denso: payload realistici dell\u2019orario personale non lanciano eccezioni', () => {
  const payloads: Array<[string, unknown]> = [
    ['una riga, 5 colonne, vuoti come raw ""', denseTeamPayload(1, 5, { periodsPerDay: 5 })],
    ['team intero (25 righe x 5 giorni x 5 colonne = 625 celle dense)', denseTeamPayload(25, 5, { periodsPerDay: 5 })],
    ['giorno da 6 ore, 20 righe', denseTeamPayload(20, 6, { periodsPerDay: 6 })],
    ['periodsPerDay null', denseTeamPayload(3, 5, { periodsPerDay: null })],
    ['periodsPerDay stringa "5"', denseTeamPayload(3, 5, { periodsPerDay: '5' })],
    ['periodsPerDay assente', denseTeamPayload(3, 5)],
    ['periodsPerDay assurdo (999, -2, "ciao")', denseTeamPayload(2, 5, { periodsPerDay: 999 })],
    ['celle vuote come null', denseTeamPayload(4, 5, { periodsPerDay: 5, emptyStyle: 'null' })],
    ['celle vuote omesse (payload pi\u00f9 corto del dichiarato)', denseTeamPayload(4, 5, { periodsPerDay: 5, emptyStyle: 'omitted' })],
  ];
  for (const [label, payload] of payloads) {
    assert.doesNotThrow(() => parseTimetableAiResponse('personal-support-timetable', payload), label);
  }
  // Numeri assurdi vengono ignorati, non fatti pagare all\u2019intera analisi.
  for (const junk of [999, -2, 'ciao', {}, []]) {
    const outcome = parseTimetableAiResponse('personal-support-timetable', denseTeamPayload(2, 5, { periodsPerDay: junk }));
    assert.equal(outcome.cells.length, 50, `periodsPerDay=${JSON.stringify(junk)}: celle conserve`);
  }
});

test('formato denso: 625 celle di una pagina reale vengono analizzate (il vecchio limite di 500 le respingeva)', () => {
  const payload = denseTeamPayload(25, 5, { periodsPerDay: 5 });
  assert.equal((payload.cells as unknown[]).length, 625, 'la pagina reale del team \u00e8 oltre il limite sparse');
  const outcome = parseTimetableAiResponse('personal-support-timetable', payload);
  assert.equal(outcome.cells.length, 625);
  assert.equal(outcome.periodsPerDay, 5, 'geometria riconosciuta dalle colonne');
  assert.equal(outcome.positionIssues, 0);
  assert.ok(MAX_PERSONAL_GRID_CELLS >= 625, 'il limite celle tiene conto del formato denso');
  assert.equal(MAX_PERSONAL_GRID_ROWS, 100, 'le pagine reali di istituto non si fermano a 60 righe');
});

test('limiti di parsing: una pagina lunga resta analizzabile, il resto è rifiuto controllato', () => {
  // 100 righe x 5 giorni x 2 colonne = 1000 celle: oltre i vecchi 60 righe / 500 celle.
  const payload = denseTeamPayload(100, 2, { periodsPerDay: 2 });
  assert.equal((payload.rows as string[]).length, 100);
  assert.equal((payload.cells as unknown[]).length, 1000);
  const outcome = parseTimetableAiResponse('personal-support-timetable', payload);
  assert.equal(outcome.rows.length, 100, 'tutte le righe restano disponibili per la scelta del docente');
  assert.equal(outcome.cells.length, 1000, 'nessuna cella scartata dal limite');

  // Oltre il limite il rifiuto è un errore di forma (controllato, con conteggi nel
  // log), non un crash senza indizi: è ciò che rendeva il bug incomprensibile.
  const huge = denseTeamPayload(100, 24, { periodsPerDay: 24 });
  assert.ok((huge.cells as unknown[]).length > MAX_PERSONAL_GRID_CELLS, 'payload oltre ogni griglia scolastica reale');
  assert.throws(() => parseTimetableAiResponse('personal-support-timetable', huge), /Celle del documento non valide/);
});

test('formato denso: la dichiarazione delle colonne è ciò che rende riparabile una numerazione compattata', () => {
  const compacted = [
    { rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' },
    { rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '' },   // contatore dell’AI: duplicato
    { rowIndex: 0, dayOfWeek: 2, periodIndex: 2, raw: '3D' },
    { rowIndex: 0, dayOfWeek: 2, periodIndex: 3, raw: '3D' },
    { rowIndex: 0, dayOfWeek: 2, periodIndex: 4, raw: '3E' },
  ];
  // Dichiarazione letta correttamente -> la griglia è da 5 colonne, le posizioni si riparano.
  for (const declared of [5, '5', ' 5 ']) {
    const outcome = parseTimetableAiResponse('personal-support-timetable', {
      rows: ['Manganiello F.'], periodsPerDay: declared, cells: compacted,
    });
    assert.equal(outcome.periodsPerDay, 5, `periodsPerDay=${JSON.stringify(declared)}`);
    assert.equal(outcome.positionIssues, 0, `${JSON.stringify(declared)}: griglia ricostruita, nessun avviso`);
    assert.deepEqual(
      outcome.cells.filter(c => c.raw).map(c => c.periodIndex),
      [1, 3, 4, 5],
      `${JSON.stringify(declared)}: martedì [3D, vuoto, 3D, 3D, 3E] -> 1, 3, 4, 5`
    );
  }
  // Senza dichiarazione la stessa numerazione compattata non è riparabile:
  // nessun riordino inventato, solo l’indicazione che le ore vanno verificate.
  const undeclared = parseTimetableAiResponse('personal-support-timetable', { rows: ['X'], cells: compacted });
  assert.equal(undeclared.positionIssues, 1, 'duplicato non risolvibile senza geometria: avviso');
  assert.deepEqual(undeclared.cells.map(c => c.periodIndex), [1, 1, 2, 3, 4], 'nessuna ora spostata a forza');
});

test('formato denso: raw "" \u00e8 accettato e i buchi restano buchi (nessuna ora Compattata)', () => {
  const payload = denseTeamPayload(1, 5, { periodsPerDay: 5 });
  const outcome = parseTimetableAiResponse('personal-support-timetable', payload);
  const empties = outcome.cells.filter(c => c.raw === '');
  assert.equal(outcome.cells.length, 25, 'una cella per ogni colonna');
  assert.ok(empties.length > 0, 'le colonne vuote sono nel payload');
  const { candidates, skipped } = personalCellsToCandidates(outcome.cells, [0]);
  assert.equal(skipped.length, 0, 'una colonna vuota non \u00e8 una cella da interpretare');
  const occupied = new Set(candidates.map(c => `${c.dayOfWeek}|${c.periodIndex}`));
  for (const empty of empties) {
    assert.equal(occupied.has(`${empty.dayOfWeek}|${empty.periodIndex}`), false, `giorno ${empty.dayOfWeek} ora ${empty.periodIndex} resta vuoto`);
  }
  assert.equal(candidates.length + empties.length, 25, 'ogni colonna \u00e8 o un\u2019ora o un vuoto: niente duplicati, niente slittamenti');
});

test('payload malformato: fallimento controllato (TimetableShapeError), non eccezione non gestita', () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ['cells non \u00e8 un array', { rows: [], cells: 'no' }, /Celle del documento non valide/],
    ['cella senza raw', { rows: [], cells: [{ rowIndex: 0, dayOfWeek: 2, periodIndex: 1 }] }, /Cella orario non valida/],
    ['giorno inesistente', { rows: [], cells: [{ rowIndex: 0, dayOfWeek: 9, periodIndex: 1, raw: '3D' }] }, /Cella orario non valida/],
    ['payload non oggetto', 'ciao', /Risposta analisi non valida/],
  ];
  for (const [label, payload, pattern] of bad) {
    let error: unknown = null;
    try {
      parseTimetableAiResponse('personal-support-timetable', payload);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof TimetableShapeError, `${label}: errore tipizzato di forma, non un crash`);
    assert.match((error as Error).message, pattern, label);
  }
});
