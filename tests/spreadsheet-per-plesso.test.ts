/**
 * H10 — caso reale `6ORE SOSTEGNO_ULTIMO28-09-26.xlsx`.
 *
 * Il foglio "PER PLESSO" ha le etichette dei giorni CENTRATE nel blocco
 * (LUNEDI' in E anche se il lunedì occupa D:I): la geometria deve nascere dalle
 * sequenze delle ore, non dalla colonna della scritta del giorno.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import type { TeacherProfile, TimeSlotConfig } from '../src/types';
import {
  inspectSpreadsheetTimetable,
  isUsableTimetableSheet,
  readSpreadsheetWorkbook,
  selectUsableTimetableSheets,
  spreadsheetRowToPersonalCells,
  type SpreadsheetSheet,
} from '../src/utils/spreadsheetTimetable';
import { personalCellsToCandidates } from '../src/utils/timetableAnalysis';
import { crossrefTimetables } from '../src/utils/timetableCrossref';
import { partitionReconstructedSlots } from '../src/utils/reconstructTimetable';
import { appendProfileClasses, importedClassesMissingFromProfile } from '../src/utils/profileClasses';

const week = [6, 6, 6, 7, 6] as const;

// Geometria reale, zero-based: D=3 … AH=33.
const blocks = [
  { label: "LUNEDI'", labelColumn: 4, start: 3, length: 6 },   // D:I, label E
  { label: "MARTEDI'", labelColumn: 11, start: 9, length: 6 },  // J:O, label L
  { label: "MERCOLEDI'", labelColumn: 17, start: 15, length: 6 }, // P:U, label R
  { label: "GIOVEDI'", labelColumn: 23, start: 21, length: 7 }, // V:AB, label X
  { label: "VENERDI'", labelColumn: 30, start: 28, length: 6 }, // AC:AH, label AE
];

const monday = ['3D', '3D', '3D', '3E', '', ''];
const tuesday = ['3E', '3E', '3E', '', '', ''];
const wednesday = ['', '', '3D', '3D', '3E', '3D'];
const thursday = ['', '', '', '3D', '3E', '', '1C'];
const friday = ['', '3D', '3D', '3D', '1C', ''];
const dayCells = [monday, tuesday, wednesday, thursday, friday];

const SUMMARY_COLUMN = 34;
const WIDTH = 35;

function emptyRow(): string[] {
  return Array.from({ length: WIDTH }, () => '');
}

/** Riproduce il foglio "PER PLESSO": etichette centrate + riga delle ore. */
function perPlessoRows(options: { withData?: boolean } = {}): string[][] {
  const { withData = true } = options;
  const labelRow = emptyRow();
  labelRow[0] = 'DOCENTE';
  const numberRow = emptyRow();
  const teacherRow = emptyRow();
  teacherRow[0] = 'Manganiello';
  teacherRow[1] = 'sos';
  if (withData) teacherRow[SUMMARY_COLUMN] = '3D10 3E6 1C2';

  blocks.forEach((block, index) => {
    labelRow[block.labelColumn] = block.label;
    for (let offset = 0; offset < block.length; offset++) {
      numberRow[block.start + offset] = String(offset + 1);
      if (withData) teacherRow[block.start + offset] = dayCells[index][offset];
    }
  });

  return [['ORARIO SOSTEGNO', ...emptyRow().slice(1)], labelRow, numberRow, teacherRow];
}

const perPlesso: SpreadsheetSheet = { name: 'PER PLESSO', cells: perPlessoRows() };

const profile: TeacherProfile = {
  id: 't-per-plesso',
  fullName: 'Felice Manganiello',
  schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'],
  campuses: [],
  roles: [],
  isSupportTeacher: true,
  schools: [{
    id: 'school-1',
    name: 'IC Da Vinci',
    isPrimary: true,
    dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
  }],
};

const timeSlotConfig: TimeSlotConfig = {
  firstHourStartTime: '08:00',
  periodsPerDay: 7,
  standardDurationMinutes: 60,
  customSlots: Array.from({ length: 7 }, (_, index) => ({
    periodNumber: index + 1,
    startTime: `${String(8 + index).padStart(2, '0')}:00`,
    endTime: `${String(9 + index).padStart(2, '0')}:00`,
  })),
};

function inspection(sheet: SpreadsheetSheet = perPlesso) {
  return inspectSpreadsheetTimetable(sheet, profile.fullName, week);
}

function totals(cells: ReturnType<typeof spreadsheetRowToPersonalCells>) {
  const result = new Map<string, number>();
  for (const candidate of personalCellsToCandidates(cells, [0]).candidates) {
    if (candidate.classLabel) result.set(candidate.classLabel, (result.get(candidate.classLabel) ?? 0) + 1);
  }
  return Object.fromEntries(result);
}

test('H10 reale: la geometria nasce dalle sequenze delle ore, non dalla colonna della scritta del giorno', () => {
  const detected = inspection().dayBlocks;
  assert.deepEqual(detected, blocks.map((block, index) => ({
    dayOfWeek: index + 1,
    columns: Array.from({ length: block.length }, (_, offset) => block.start + offset),
  })));

  // Lunedì D:I con label su E, martedì J:O con label su L, giovedì 7 ore V:AB,
  // venerdì AC:AH: nessun blocco inizia dalla colonna dell'etichetta.
  assert.deepEqual(detected[0].columns, [3, 4, 5, 6, 7, 8]);
  assert.deepEqual(detected[1].columns, [9, 10, 11, 12, 13, 14]);
  assert.deepEqual(detected[2].columns, [15, 16, 17, 18, 19, 20]);
  assert.deepEqual(detected[3].columns, [21, 22, 23, 24, 25, 26, 27]);
  assert.deepEqual(detected[4].columns, [28, 29, 30, 31, 32, 33]);
  assert.deepEqual(detected.map(block => block.columns.length), [6, 6, 6, 7, 6]);
  blocks.forEach((block, index) => {
    assert.ok(detected[index].columns.includes(block.labelColumn), 'la label resta dentro il blocco');
    assert.notEqual(detected[index].columns[0], block.labelColumn, 'la label non è la prima colonna');
  });
});

test('H10 reale: nessun falso mismatch 2/2/2/2/1 sul foglio PER PLESSO', () => {
  assert.doesNotThrow(() => inspection());
  const lengths = inspection().dayBlocks.map(block => block.columns.length);
  assert.notDeepEqual(lengths, [2, 2, 2, 2, 1]);
});

test('H10 reale: riga Manganiello → 31 posizioni, 18 occupate, riepilogo 3D10 3E6 1C2', () => {
  const found = inspection();
  assert.equal(found.teacherRows.length, 1);
  assert.equal(found.teacherRows[0].rowLabel, 'Manganiello');

  const cells = spreadsheetRowToPersonalCells(found, found.teacherRows[0].rowIndex);
  assert.equal(cells.length, 31);
  assert.equal(cells.filter(cell => cell.raw).length, 18);
  assert.deepEqual(cells.filter(cell => cell.dayOfWeek === 1).map(cell => cell.raw), monday);
  assert.deepEqual(cells.filter(cell => cell.dayOfWeek === 2).map(cell => cell.raw), tuesday);
  assert.deepEqual(cells.filter(cell => cell.dayOfWeek === 3).map(cell => cell.raw), wednesday);
  assert.deepEqual(cells.filter(cell => cell.dayOfWeek === 4).map(cell => cell.raw), thursday);
  assert.deepEqual(cells.filter(cell => cell.dayOfWeek === 5).map(cell => cell.raw), friday);

  const counts = totals(cells);
  assert.deepEqual(counts, { '3D': 10, '3E': 6, '1C': 2 });
  // Il riepilogo stampato nel foglio reale coincide con i totali calcolati.
  assert.equal(
    perPlesso.cells[3][SUMMARY_COLUMN],
    `3D${counts['3D']} 3E${counts['3E']} 1C${counts['1C']}`,
  );
});

test('H10 reale + H9: 1C (Gio 7ª e Ven 5ª) arriva negli slot ed è proposta come classe nuova', () => {
  const found = inspection();
  const cells = spreadsheetRowToPersonalCells(found, found.teacherRows[0].rowIndex);
  assert.equal(cells.find(cell => cell.dayOfWeek === 4 && cell.periodIndex === 7)?.raw, '1C');
  assert.equal(cells.find(cell => cell.dayOfWeek === 5 && cell.periodIndex === 5)?.raw, '1C');

  const reconstruction = crossrefTimetables(personalCellsToCandidates(cells, [0]).candidates, []);
  const partition = partitionReconstructedSlots(reconstruction, { profile, timeSlotConfig });
  assert.equal(partition.slots.length, 18, '18 ore importabili');
  assert.equal(partition.rejected.length, 0);
  assert.equal(partition.slots.filter(slot => slot.className === '1C').length, 2);

  const missing = importedClassesMissingFromProfile(profile, partition.slots);
  assert.deepEqual(missing, ['1C'], 'H9 rileva 1C come nuova classe');
  assert.deepEqual(appendProfileClasses(profile.classes, missing), ['3D', '3E', '1C'], 'nessun duplicato');
  assert.deepEqual(appendProfileClasses(['3D', '3E', '1C'], missing), ['3D', '3E', '1C']);
});

test('H10 reale: PER PLESSO è candidato, Foglio1 vuoto è ignorato, ORDINE ALFABETICO non lo sostituisce', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(perPlessoRows()), 'PER PLESSO');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['']]), 'Foglio1');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(perPlessoRows({ withData: false })), 'ORDINE ALFABETICO');
  const content = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  const workbook = await readSpreadsheetWorkbook(new File([content], '6ORE SOSTEGNO_ULTIMO28-09-26.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));

  assert.deepEqual(workbook.sheets.map(sheet => sheet.name), ['PER PLESSO', 'ORDINE ALFABETICO'], 'Foglio1 vuoto ignorato');
  const usable = selectUsableTimetableSheets(workbook.sheets, profile.fullName, week);
  assert.deepEqual(usable.map(sheet => sheet.name), ['PER PLESSO']);
  assert.equal(isUsableTimetableSheet(workbook.sheets[0], profile.fullName, week), true);
  assert.equal(isUsableTimetableSheet(workbook.sheets[1], profile.fullName, week), false);

  const cells = spreadsheetRowToPersonalCells(inspectSpreadsheetTimetable(usable[0], profile.fullName, week), 3);
  assert.equal(cells.length, 31);
  assert.equal(cells.filter(cell => cell.raw).length, 18);
  assert.deepEqual(totals(cells), { '3D': 10, '3E': 6, '1C': 2 });
});
