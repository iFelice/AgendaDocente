import 'fake-indexeddb/auto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import * as XLSX from 'xlsx';
import { DocumentScannerModal } from '../src/components/DocumentScannerModal';
import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';
import {
  SpreadsheetTimetableError,
  detectCsvDelimiter,
  inspectSpreadsheetTimetable,
  parseCsv,
  readSpreadsheetWorkbook,
  spreadsheetRowToPersonalCells,
  type SpreadsheetSheet,
} from '../src/utils/spreadsheetTimetable';
import { personalCellsToCandidates } from '../src/utils/timetableAnalysis';
import { crossrefTimetables } from '../src/utils/timetableCrossref';
import { partitionReconstructedSlots } from '../src/utils/reconstructTimetable';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

before(() => {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
});
after(() => {
  globalThis.fetch = originalFetch;
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
});

const week = [6, 6, 6, 7, 6] as const;
const monday = ['3D', '3D', '3D', '3E', '', ''];
const tuesday = ['3E', '3E', '3E', '', '', ''];
const wednesday = ['', '', '3D', '3D', '3E', '3D'];
const thursday = ['', '', '', '3D', '3E', '', '1C'];
const friday = ['', '3D', '3D', '3D', '1C', ''];
const periods = [monday, tuesday, wednesday, thursday, friday];
const dayNames = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven'];

function fixtureRows(): string[][] {
  const headers = periods.flatMap((day, dayIndex) => day.map(() => dayNames[dayIndex]));
  const numbers = periods.flatMap(day => day.map((_, index) => String(index + 1)));
  return [
    ['DOCENTE', ...headers],
    ['Nome', ...numbers],
    ['Manganiello', ...periods.flat()],
  ].map(row => [...row]);
}

const fixtureSheet: SpreadsheetSheet = { name: 'Orario sostegno', cells: fixtureRows() };

const profile: TeacherProfile = {
  id: 't-spreadsheet',
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

function fixtureInspection(sheet = fixtureSheet) {
  return inspectSpreadsheetTimetable(sheet, profile.fullName, week);
}

function classTotals(cells: ReturnType<typeof spreadsheetRowToPersonalCells>) {
  const result = new Map<string, number>();
  for (const candidate of personalCellsToCandidates(cells, [0]).candidates) {
    if (candidate.classLabel) result.set(candidate.classLabel, (result.get(candidate.classLabel) ?? 0) + 1);
  }
  return Object.fromEntries(result);
}

test('H10: riga Manganiello da foglio strutturato preserva vuoti, 6/6/6/7/6, 18 ore e totali', () => {
  const inspection = fixtureInspection();
  assert.equal(inspection.teacherRows.length, 1);
  assert.equal(inspection.teacherRows[0].rowLabel, 'Manganiello');

  const cells = spreadsheetRowToPersonalCells(inspection, inspection.teacherRows[0].rowIndex);
  assert.equal(cells.length, 31, 'tutte le posizioni fisiche, anche vuote');
  assert.equal(cells.filter(cell => cell.raw).length, 18);
  assert.deepEqual(cells.filter(cell => cell.dayOfWeek === 1).map(cell => cell.raw), monday);
  assert.deepEqual(cells.filter(cell => cell.dayOfWeek === 2).map(cell => cell.raw), tuesday);
  assert.deepEqual(cells.filter(cell => cell.dayOfWeek === 3).map(cell => cell.raw), wednesday);
  assert.deepEqual(cells.filter(cell => cell.dayOfWeek === 4).map(cell => cell.raw), thursday);
  assert.deepEqual(cells.filter(cell => cell.dayOfWeek === 5).map(cell => cell.raw), friday);
  assert.equal(cells.find(cell => cell.dayOfWeek === 4 && cell.periodIndex === 7)?.raw, '1C');
  assert.equal(cells.find(cell => cell.dayOfWeek === 5 && cell.periodIndex === 5)?.raw, '1C');
  assert.deepEqual(classTotals(cells), { '3D': 10, '3E': 6, '1C': 2 });

  // Il downstream è quello esistente: cells -> candidati -> crossref -> D1.
  const reconstruction = crossrefTimetables(personalCellsToCandidates(cells, [0]).candidates, []);
  const partition = partitionReconstructedSlots(reconstruction, { profile, timeSlotConfig });
  assert.equal(partition.slots.length, 18, 'nessuna regressione nella partition ReconstructedSlot');
  assert.equal(partition.rejected.length, 0, 'la settima del giovedì ha una fascia reale');
});

test('H10: legge un XLSX con intestazioni unite e ignora fogli completamente vuoti', async () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(fixtureRows());
  let start = 1;
  for (const day of periods) {
    sheet['!merges'] ??= [];
    sheet['!merges'].push({ s: { r: 0, c: start }, e: { r: 0, c: start + day.length - 1 } });
    // Per rendere davvero una merge, le celle coperte non devono essere sorgenti.
    for (let column = start + 1; column < start + day.length; column++) delete sheet[XLSX.utils.encode_cell({ r: 0, c: column })];
    start += day.length;
  }
  XLSX.utils.book_append_sheet(book, sheet, 'Orario');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['']]), 'Vuoto');
  const content = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  const workbook = await readSpreadsheetWorkbook(new File([content], 'orario.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));

  assert.deepEqual(workbook.sheets.map(entry => entry.name), ['Orario']);
  const cells = spreadsheetRowToPersonalCells(inspectSpreadsheetTimetable(workbook.sheets[0], profile.fullName, week), 2);
  assert.equal(cells.length, 31);
  assert.equal(cells.find(cell => cell.dayOfWeek === 4 && cell.periodIndex === 7)?.raw, '1C');
});

test('H10: XLSX corrotto produce un errore leggibile', async () => {
  await assert.rejects(
    () => readSpreadsheetWorkbook(new File([new Uint8Array([1, 2, 3, 4])], 'corrotto.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })),
    (error: unknown) => error instanceof SpreadsheetTimetableError
      && error.code === 'file-unreadable'
      && /non riesco a leggere/i.test(error.message),
  );
});

test('H10: CSV UTF-8 con BOM, punto e virgola, virgolette e celle vuote', async () => {
  const csv = `\uFEFFDOCENTE;${periods.flatMap((day, dayIndex) => day.map(() => dayNames[dayIndex])).join(';')}\nNome;${periods.flatMap(day => day.map((_, index) => index + 1)).join(';')}\nManganiello;${periods.flat().map(value => value ? `"${value}"` : '').join(';')}\n`;
  assert.equal(detectCsvDelimiter(csv), ';');
  assert.deepEqual(parseCsv('a;"x;y";\n').at(0), ['a', 'x;y', ''], 'virgolette e vuoto terminale non rompono la riga');
  const workbook = await readSpreadsheetWorkbook(new File([csv], 'orario.csv', { type: 'text/csv' }));
  const cells = spreadsheetRowToPersonalCells(inspectSpreadsheetTimetable(workbook.sheets[0], profile.fullName, week), 2);
  assert.equal(cells.filter(cell => !cell.raw).length, 13);
  assert.deepEqual(classTotals(cells), { '3D': 10, '3E': 6, '1C': 2 });
});

test('H10: più fogli con dati restano disponibili per una scelta esplicita', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Legenda'], ['orario sostegno']]), 'Legenda');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(fixtureRows()), 'Orario');
  const content = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  const workbook = await readSpreadsheetWorkbook(new File([content], 'molti-fogli.xlsx'));
  assert.deepEqual(workbook.sheets.map(sheet => sheet.name), ['Legenda', 'Orario']);
});

test('H10: docente assente, righe ambigue, intestazioni invalide, geometria e riga corta hanno errori leggibili', () => {
  assert.throws(
    () => inspectSpreadsheetTimetable({ ...fixtureSheet, cells: fixtureRows().map((row, index) => index === 2 ? ['Bianchi', ...row.slice(1)] : row) }, profile.fullName, week),
    (error: unknown) => error instanceof SpreadsheetTimetableError && error.code === 'teacher-not-found',
  );

  const duplicate = fixtureRows();
  duplicate.push(['Manganiello A.', ...periods.flat()]);
  const ambiguous = inspectSpreadsheetTimetable({ name: 'Duplicati', cells: duplicate }, profile.fullName, week);
  assert.equal(ambiguous.teacherRows.length, 2, 'nessuna riga viene scelta automaticamente');

  assert.throws(
    () => inspectSpreadsheetTimetable({ name: 'Senza giorni', cells: [['DOCENTE', 'A'], ['Manganiello', '3D']] }, profile.fullName, week),
    (error: unknown) => error instanceof SpreadsheetTimetableError && error.code === 'day-headers-unrecognized',
  );

  const sevenMonday = fixtureRows();
  sevenMonday[0].splice(7, 0, 'Lun');
  sevenMonday[1].splice(7, 0, '7');
  sevenMonday[2].splice(7, 0, '3D');
  assert.throws(
    () => inspectSpreadsheetTimetable({ name: 'Geometria errata', cells: sevenMonday }, profile.fullName, week),
    (error: unknown) => error instanceof SpreadsheetTimetableError && error.code === 'geometry-incompatible',
  );

  const shortCsv: SpreadsheetSheet = { name: 'Corta', cells: fixtureRows(), rowLengths: [32, 32, 30] };
  assert.throws(
    () => spreadsheetRowToPersonalCells(inspectSpreadsheetTimetable(shortCsv, profile.fullName, week), 2),
    (error: unknown) => error instanceof SpreadsheetTimetableError && error.code === 'row-too-short',
  );
});

function nodeText(node: any): string {
  const values: string[] = [];
  const visit = (entry: any) => {
    if (typeof entry === 'string' || typeof entry === 'number') values.push(String(entry));
    else if (entry && typeof entry === 'object' && Array.isArray(entry.children)) entry.children.forEach(visit);
  };
  visit(node);
  return values.join(' ').replace(/\s+/g, ' ').trim();
}

function byId(renderer: any, id: string) {
  const node = renderer.root.findAll((entry: any) => entry.props?.id === id)[0];
  assert.ok(node, `elemento ${id} assente`);
  return node;
}

async function waitForText(renderer: any, expected: string, timeout = 2500) {
  const started = Date.now();
  while (!nodeText(renderer.root).includes(expected)) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    if (Date.now() - started > timeout) throw new Error(`testo non raggiunto: ${expected}`);
  }
}

function modalProps(overrides: Partial<React.ComponentProps<typeof DocumentScannerModal>> = {}) {
  return {
    isOpen: true,
    onClose: () => {},
    profile,
    students: [],
    timeSlotConfig,
    provisionalTimetable: [] as TimetableSlot[],
    definitiveTimetable: [] as TimetableSlot[],
    onOpenCircularWithFile: () => {},
    onSaveReconstructedTimetable: () => {},
    onSaveProfile: () => {},
    onImportStudentCommitments: () => {},
    ...overrides,
  };
}

async function localSpreadsheetFlow(file: File, overrides: Partial<React.ComponentProps<typeof DocumentScannerModal>> = {}) {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(DocumentScannerModal, modalProps(overrides))); });
  await act(async () => { byId(renderer, 'scan-type-personal').props.onClick(); });
  const input = renderer.root.findByProps({ 'aria-label': 'Scegli foto o file' });
  await act(async () => {
    input.props.onChange({ target: { files: [file], value: 'selected' } });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await waitForText(renderer, 'Riga letta nel documento');
  return renderer;
}

test('H10 UI: XLSX e CSV non chiamano analyze-timetable né chiedono consenso cloud; H9 importa e propone 1C', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  const csv = `DOCENTE;${periods.flatMap((day, dayIndex) => day.map(() => dayNames[dayIndex])).join(';')}\nNome;${periods.flatMap(day => day.map((_, index) => index + 1)).join(';')}\nManganiello;${periods.flat().join(';')}\n`;
  const saved: TimetableSlot[][] = [];
  let savedProfile: TeacherProfile | null = null;
  const csvRenderer = await localSpreadsheetFlow(new File([csv], 'orario.csv', { type: 'text/csv' }), {
    onSaveReconstructedTimetable: slots => { saved.push(slots); },
    onSaveProfile: updated => { savedProfile = updated; },
  });
  assert.equal(nodeText(csvRenderer.root).includes('Informativa e consenso'), false);
  assert.equal(calls.filter(url => url.includes('/api/analyze-timetable')).length, 0, 'CSV: zero chiamate AI');
  await act(async () => { byId(csvRenderer, 'scan-personal-continue').props.onClick(); });
  await act(async () => { byId(csvRenderer, 'recon-confirm-save').props.onClick(); });
  assert.equal(saved[0].length, 18);
  assert.equal(saved[0].filter(slot => slot.className === '1C').length, 2, 'H9: 1C non viene scartata');
  assert.ok(nodeText(byId(csvRenderer, 'scan-profile-class-suggestion')).includes('Nuova classe rilevata'));
  await act(async () => { byId(csvRenderer, 'scan-profile-classes-add').props.onClick(); });
  assert.deepEqual(savedProfile?.classes, ['3D', '3E', '1C'], 'H9: click salva una sola 1C nel Profilo');
  await act(async () => { csvRenderer.unmount(); });

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(fixtureRows()), 'Orario');
  const xlsx = new File([XLSX.write(book, { bookType: 'xlsx', type: 'array' })], 'orario.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const xlsxRenderer = await localSpreadsheetFlow(xlsx);
  assert.equal(calls.filter(url => url.includes('/api/analyze-timetable')).length, 0, 'XLSX: zero chiamate AI');
  assert.equal(nodeText(xlsxRenderer.root).includes('Informativa e consenso'), false);
  await act(async () => { xlsxRenderer.unmount(); });
});

test('H10 UI: se 1C è già nel Profilo, l’import locale non mostra il banner H9', async () => {
  const csv = `DOCENTE;${periods.flatMap((day, dayIndex) => day.map(() => dayNames[dayIndex])).join(';')}\nNome;${periods.flatMap(day => day.map((_, index) => index + 1)).join(';')}\nManganiello;${periods.flat().join(';')}\n`;
  const renderer = await localSpreadsheetFlow(new File([csv], 'orario.csv', { type: 'text/csv' }), {
    profile: { ...profile, classes: ['3D', '3E', '1C'] },
    onSaveReconstructedTimetable: () => {},
  });
  await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  assert.equal(renderer.root.findAll((entry: any) => entry.props?.id === 'scan-profile-class-suggestion').length, 0);
  await act(async () => { renderer.unmount(); });
});

test('H10 UI: più fogli e più righe compatibili richiedono una scelta esplicita', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Note'], ['scegli Orario']]), 'Note');
  const ambiguous = fixtureRows();
  ambiguous.push(['Manganiello A.', ...periods.flat()]);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(ambiguous), 'Orario');
  const file = new File([XLSX.write(book, { bookType: 'xlsx', type: 'array' })], 'multi.xlsx');
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(DocumentScannerModal, modalProps())); });
  await act(async () => { byId(renderer, 'scan-type-personal').props.onClick(); });
  const input = renderer.root.findByProps({ 'aria-label': 'Scegli foto o file' });
  await act(async () => {
    input.props.onChange({ target: { files: [file], value: 'selected' } });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await waitForText(renderer, 'più fogli con dati');
  assert.ok(byId(renderer, 'scan-spreadsheet-sheet-0'));
  await act(async () => { byId(renderer, 'scan-spreadsheet-sheet-1').props.onClick(); });
  await waitForText(renderer, 'più righe compatibili');
  assert.ok(byId(renderer, 'scan-spreadsheet-row-0'));
  assert.ok(byId(renderer, 'scan-spreadsheet-row-1'));
  await act(async () => { renderer.unmount(); });
});
