/**
 * Import locale dell'orario personale da fogli strutturati.
 *
 * Questo modulo non conosce rete, storage o persistenza: riceve un File nel
 * browser, lo legge in memoria e restituisce soltanto le celle della riga
 * scelta. Da qui il flusso confluisce nella stessa review dello scanner AI.
 */

import type * as XLSX from "xlsx";
import { findTeacherRows, type PersonalTimetablePeriodsByDay, type TimetableRawCell } from "./timetableAnalysis";

export type SpreadsheetImportErrorCode =
  | "file-unreadable"
  | "workbook-empty"
  | "day-headers-unrecognized"
  | "geometry-incompatible"
  | "teacher-not-found"
  | "row-too-short";

/** Errore già pronto per la UI: non contiene mai stack trace o contenuto delle celle. */
export class SpreadsheetTimetableError extends Error {
  readonly code: SpreadsheetImportErrorCode;

  constructor(code: SpreadsheetImportErrorCode, message: string) {
    super(message);
    this.name = "SpreadsheetTimetableError";
    this.code = code;
  }
}

export interface SpreadsheetSheet {
  name: string;
  /** Matrice rettangolare, con celle vuote esplicite. Resta solo in memoria. */
  cells: string[][];
  /** Presente per CSV: serve a distinguere una riga corta dai vuoti dichiarati. */
  rowLengths?: number[];
}

export interface SpreadsheetWorkbook {
  sheets: SpreadsheetSheet[];
}

export interface SpreadsheetDayBlock {
  dayOfWeek: number;
  columns: number[];
}

export interface SpreadsheetTeacherRow {
  /** Indice fisico (base 0) nel foglio. */
  rowIndex: number;
  /** Colonna che contiene l'etichetta docente. */
  columnIndex: number;
  rowLabel: string;
}

export interface SpreadsheetTimetableInspection {
  sheet: SpreadsheetSheet;
  periodsByDay: PersonalTimetablePeriodsByDay;
  dayBlocks: SpreadsheetDayBlock[];
  teacherRows: SpreadsheetTeacherRow[];
}

const DAY_ALIASES: Array<{ day: number; aliases: string[] }> = [
  { day: 1, aliases: ["lun", "lunedi", "monday", "mon"] },
  { day: 2, aliases: ["mar", "martedi", "tuesday", "tue"] },
  { day: 3, aliases: ["mer", "mercoledi", "wednesday", "wed"] },
  { day: 4, aliases: ["gio", "giovedi", "thursday", "thu"] },
  { day: 5, aliases: ["ven", "venerdi", "friday", "fri"] },
];

const TEACHER_HEADER_WORDS = new Set(["docente", "docenti", "prof", "professoressa", "professore", "insegnante", "insegnanti", "nome"]);

function fold(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dayFromHeader(value: unknown): number | null {
  const clean = fold(value);
  if (!clean) return null;
  for (const { day, aliases } of DAY_ALIASES) {
    if (aliases.some(alias => clean === alias || clean.startsWith(`${alias} `))) return day;
  }
  return null;
}

function periodFromHeader(value: unknown): number | null {
  const clean = String(value ?? "").trim();
  const match = clean.match(/^(\d{1,2})(?:\s*(?:ª|°|a|ora))?$/iu);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number >= 1 && number <= 24 ? number : null;
}

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  const value = cell.w ?? cell.v ?? "";
  return String(value).trim();
}

function normalizeMatrix(rows: string[][]): string[][] {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows.map(row => Array.from({ length: width }, (_, column) => row[column] ?? ""));
}

/**
 * Converte un worksheet SheetJS in matrice e propaga le celle unite nella loro
 * area. Le intestazioni "Lunedì" unite su sei colonne diventano quindi una
 * geometria leggibile; se una cella-orario è unita, il suo valore resta visibile
 * in tutte le ore che copre.
 */
function sheetToMatrix(sheet: XLSX.WorkSheet, xlsx: typeof XLSX): string[][] {
  const reference = sheet["!ref"];
  if (!reference) return [];
  let range: XLSX.Range;
  try {
    range = xlsx.utils.decode_range(reference);
  } catch {
    return [];
  }
  const height = range.e.r - range.s.r + 1;
  const width = range.e.c - range.s.c + 1;
  const matrix = Array.from({ length: height }, () => Array.from({ length: width }, () => ""));

  for (let row = range.s.r; row <= range.e.r; row++) {
    for (let column = range.s.c; column <= range.e.c; column++) {
      matrix[row - range.s.r][column - range.s.c] = cellText(sheet[xlsx.utils.encode_cell({ r: row, c: column })]);
    }
  }

  for (const merge of sheet["!merges"] ?? []) {
    const source = cellText(sheet[xlsx.utils.encode_cell({ r: merge.s.r, c: merge.s.c })]);
    if (!source) continue;
    for (let row = Math.max(merge.s.r, range.s.r); row <= Math.min(merge.e.r, range.e.r); row++) {
      for (let column = Math.max(merge.s.c, range.s.c); column <= Math.min(merge.e.c, range.e.c); column++) {
        matrix[row - range.s.r][column - range.s.c] = source;
      }
    }
  }

  return matrix;
}

function isNonEmptySheet(sheet: SpreadsheetSheet): boolean {
  return sheet.cells.some(row => row.some(cell => cell.trim().length > 0));
}

function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match?.[1] ?? "";
}

export function isSpreadsheetTimetableFile(file: Pick<File, "name" | "type">): boolean {
  const extension = extensionOf(file.name);
  return extension === ".xlsx" || extension === ".csv"
    || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || file.type === "text/csv"
    || file.type === "text/tab-separated-values";
}

/**
 * Rileva il delimitatore osservando solo caratteri FUORI dalle virgolette. Non
 * usa split, quindi virgole/semicolon/tab in un campo quotato non spezzano la
 * riga. In caso di parità privilegia il punto e virgola, molto comune nei CSV
 * italiani esportati da Excel.
 */
export function detectCsvDelimiter(text: string): "," | ";" | "\t" {
  const counts: Record<"," | ";" | "\t", number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        index++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && (char === "," || char === ";" || char === "\t")) counts[char]++;
  }
  if (counts[";"] >= counts[","] && counts[";"] >= counts["\t"] && counts[";"] > 0) return ";";
  if (counts["\t"] >= counts[","] && counts["\t"] > 0) return "\t";
  return ",";
}

/** Parser CSV UTF-8 locale, con supporto RFC-style per virgolette e "" escape. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const delimiter = detectCsvDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }
  // Nessuna riga fantasma dopo un newline finale, ma preserva l'ultimo campo
  // vuoto quando è dichiarato da un delimitatore terminale.
  if (field !== "" || row.length > 0 || source.length === 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Legge XLSX/CSV esclusivamente nel browser. Il File non viene mai inviato,
 * registrato in IndexedDB/localStorage, né restituito al chiamante.
 */
export async function readSpreadsheetWorkbook(file: File): Promise<SpreadsheetWorkbook> {
  try {
    const extension = extensionOf(file.name);
    const buffer = await file.arrayBuffer();
    if (extension === ".csv" || file.type === "text/csv" || file.type === "text/tab-separated-values") {
      const text = new TextDecoder("utf-8").decode(buffer);
      const rawRows = parseCsv(text);
      const sheet: SpreadsheetSheet = {
        name: file.name.replace(/\.csv$/i, "") || "CSV",
        cells: normalizeMatrix(rawRows),
        rowLengths: rawRows.map(row => row.length),
      };
      const sheets = isNonEmptySheet(sheet) ? [sheet] : [];
      if (!sheets.length) throw new SpreadsheetTimetableError("workbook-empty", "Il file non contiene fogli con dati.");
      return { sheets };
    }

    // Un .xlsx è un contenitore ZIP Open Packaging: SheetJS prova a interpretare
    // byte arbitrari come testo delimitato, che renderebbe un file corrotto un
    // falso foglio CSV. Il controllo del magic number evita quel fallback.
    const bytes = new Uint8Array(buffer);
    const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
      && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
    if (!isZip) {
      throw new SpreadsheetTimetableError(
        "file-unreadable",
        "Non riesco a leggere il foglio. Verifica che il file Excel non sia danneggiato.",
      );
    }
    // Caricamento lazy: il parser Excel è necessario solo dopo una scelta
    // esplicita di .xlsx, non nel bundle iniziale dell'agenda.
    const xlsx = await import("xlsx");
    const workbook = xlsx.read(buffer, { type: "array", cellText: false, cellDates: false });
    const sheets = workbook.SheetNames
      .map(name => ({ name, cells: sheetToMatrix(workbook.Sheets[name], xlsx) }))
      .filter(isNonEmptySheet);
    if (!sheets.length) throw new SpreadsheetTimetableError("workbook-empty", "Il file non contiene fogli con dati.");
    return { sheets };
  } catch (error) {
    if (error instanceof SpreadsheetTimetableError) throw error;
    throw new SpreadsheetTimetableError(
      "file-unreadable",
      "Non riesco a leggere il foglio. Verifica che il file Excel o CSV non sia danneggiato.",
    );
  }
}

interface DayHeaderGroup {
  dayOfWeek: number;
  start: number;
  end: number;
}

function dayGroupsInRow(row: string[]): DayHeaderGroup[] {
  const groups: DayHeaderGroup[] = [];
  let column = 0;
  while (column < row.length) {
    const day = dayFromHeader(row[column]);
    if (!day) {
      column++;
      continue;
    }
    const start = column;
    while (column + 1 < row.length && dayFromHeader(row[column + 1]) === day) column++;
    groups.push({ dayOfWeek: day, start, end: column });
    column++;
  }
  return groups;
}

function firstOrderedWeekGroups(row: string[]): DayHeaderGroup[] | null {
  const groups = dayGroupsInRow(row);
  const ordered: DayHeaderGroup[] = [];
  let lastColumn = -1;
  for (let day = 1; day <= 5; day++) {
    const group = groups.find(entry => entry.dayOfWeek === day && entry.start > lastColumn);
    if (!group) return null;
    ordered.push(group);
    lastColumn = group.end;
  }
  return ordered;
}

interface PeriodRun {
  rowIndex: number;
  columns: number[];
}

function periodRunsInSegment(matrix: string[][], headerRow: number, start: number, endExclusive: number): PeriodRun[] {
  const runs: PeriodRun[] = [];
  const from = Math.max(0, headerRow - 2);
  const to = Math.min(matrix.length - 1, headerRow + 3);
  for (let rowIndex = from; rowIndex <= to; rowIndex++) {
    const row = matrix[rowIndex] ?? [];
    for (let column = start; column < endExclusive; column++) {
      if (periodFromHeader(row[column]) !== 1) continue;
      const columns: number[] = [];
      let expected = 1;
      while (column + columns.length < endExclusive && periodFromHeader(row[column + columns.length]) === expected) {
        columns.push(column + columns.length);
        expected++;
      }
      if (columns.length) runs.push({ rowIndex, columns });
    }
  }
  return runs;
}

function describeGeometry(periods: readonly number[]): string {
  const short = ["Lun", "Mar", "Mer", "Gio", "Ven"];
  return periods.map((period, index) => `${short[index]} ${period}`).join(" · ");
}

interface LayoutCandidate {
  headerRow: number;
  periodHeaderRow: number;
  dayBlocks: SpreadsheetDayBlock[];
  score: number;
}

function layoutCandidates(matrix: string[][], periodsByDay: PersonalTimetablePeriodsByDay): { candidates: LayoutCandidate[]; hasDayHeaders: boolean; mismatch?: number[] } {
  const candidates: LayoutCandidate[] = [];
  let hasDayHeaders = false;
  let mismatch: number[] | undefined;

  for (let headerRow = 0; headerRow < matrix.length; headerRow++) {
    const groups = firstOrderedWeekGroups(matrix[headerRow] ?? []);
    if (!groups) continue;
    hasDayHeaders = true;
    const blocks: SpreadsheetDayBlock[] = [];
    let periodHeaderRow = headerRow;
    let valid = true;
    const actualLengths: number[] = [];

    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      const nextStart = groups[index + 1]?.start ?? matrix[headerRow].length;
      const runs = periodRunsInSegment(matrix, headerRow, group.start, nextStart);
      const longest = runs.sort((a, b) => b.columns.length - a.columns.length || Math.abs(a.rowIndex - headerRow) - Math.abs(b.rowIndex - headerRow))[0];
      const expected = periodsByDay[index];
      if (longest) {
        actualLengths.push(longest.columns.length);
        if (longest.columns.length !== expected) {
          valid = false;
          continue;
        }
        blocks.push({ dayOfWeek: index + 1, columns: longest.columns });
        periodHeaderRow = Math.max(periodHeaderRow, longest.rowIndex);
        continue;
      }

      // Intestazione unita: se il giorno copre ESATTAMENTE le colonne previste,
      // la geometria è già determinata anche quando la riga dei numeri manca.
      const mergedWidth = group.end - group.start + 1;
      actualLengths.push(mergedWidth);
      if (mergedWidth !== expected) {
        valid = false;
        continue;
      }
      blocks.push({ dayOfWeek: index + 1, columns: Array.from({ length: expected }, (_, offset) => group.start + offset) });
    }

    if (!valid || blocks.length !== 5) {
      if (actualLengths.length === 5) mismatch = actualLengths;
      continue;
    }
    candidates.push({
      headerRow,
      periodHeaderRow,
      dayBlocks: blocks,
      score: blocks.reduce((sum, block) => sum + block.columns.length, 0),
    });
  }
  return { candidates, hasDayHeaders, mismatch };
}

function teacherColumns(matrix: string[][], lastHeaderRow: number, occupiedColumns: Set<number>): number[] {
  const explicit = new Set<number>();
  for (let row = 0; row <= lastHeaderRow; row++) {
    (matrix[row] ?? []).forEach((value, column) => {
      const words = fold(value).split(" ").filter(Boolean);
      if (words.some(word => TEACHER_HEADER_WORDS.has(word))) explicit.add(column);
    });
  }
  if (explicit.size) return Array.from(explicit);
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  return Array.from({ length: width }, (_, column) => column).filter(column => !occupiedColumns.has(column));
}

/**
 * Individua intestazioni dei giorni, blocchi orari e righe compatibili col
 * docente. Non sceglie mai una riga quando ce n'è più di una: il chiamante
 * riceve tutte le opzioni e chiede conferma in UI.
 */
export function inspectSpreadsheetTimetable(
  sheet: SpreadsheetSheet,
  profileName: string,
  periodsByDay: PersonalTimetablePeriodsByDay,
): SpreadsheetTimetableInspection {
  const { candidates, hasDayHeaders, mismatch } = layoutCandidates(sheet.cells, periodsByDay);
  if (!candidates.length) {
    if (hasDayHeaders && mismatch) {
      throw new SpreadsheetTimetableError(
        "geometry-incompatible",
        `La struttura del foglio non è compatibile con il Profilo. Atteso: ${describeGeometry(periodsByDay)}; trovato: ${describeGeometry(mismatch)}.`,
      );
    }
    throw new SpreadsheetTimetableError(
      "day-headers-unrecognized",
      "Non riconosco le intestazioni dei giorni o i blocchi delle ore (Lun–Ven) in questo foglio.",
    );
  }

  const layout = candidates.sort((a, b) => b.score - a.score || a.headerRow - b.headerRow)[0];
  const occupiedColumns = new Set(layout.dayBlocks.flatMap(block => block.columns));
  const columns = teacherColumns(sheet.cells, Math.max(layout.headerRow, layout.periodHeaderRow), occupiedColumns);
  const minDataRow = Math.max(layout.headerRow, layout.periodHeaderRow) + 1;
  const byRow = new Map<number, SpreadsheetTeacherRow>();

  for (const columnIndex of columns) {
    const labels = sheet.cells.map(row => row[columnIndex] ?? "");
    for (const match of findTeacherRows(labels, profileName)) {
      if (match.rowIndex < minDataRow || byRow.has(match.rowIndex)) continue;
      byRow.set(match.rowIndex, { rowIndex: match.rowIndex, columnIndex, rowLabel: match.rowLabel });
    }
  }

  const teacherRows = Array.from(byRow.values()).sort((a, b) => a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex);
  if (!teacherRows.length) {
    throw new SpreadsheetTimetableError(
      "teacher-not-found",
      "Non ho trovato una riga compatibile con il docente del Profilo. Controlla il nome nel Profilo o scegli un altro foglio.",
    );
  }

  return { sheet, periodsByDay, dayBlocks: layout.dayBlocks, teacherRows };
}

/**
 * Materializza tutte le posizioni della riga docente (vuoti inclusi) nel tipo
 * già usato da `personalCellsToCandidates`. Qui non nasce un secondo modello
 * orario: dopo questa funzione il flusso è identico a quello AI.
 */
export function spreadsheetRowToPersonalCells(
  inspection: SpreadsheetTimetableInspection,
  rowIndex: number,
): TimetableRawCell[] {
  const teacher = inspection.teacherRows.find(row => row.rowIndex === rowIndex);
  if (!teacher) {
    throw new SpreadsheetTimetableError("teacher-not-found", "La riga docente selezionata non è disponibile in questo foglio.");
  }
  const lastRequiredColumn = Math.max(...inspection.dayBlocks.flatMap(block => block.columns));
  const rowLength = inspection.sheet.rowLengths?.[rowIndex];
  if (typeof rowLength === "number" && rowLength <= lastRequiredColumn) {
    throw new SpreadsheetTimetableError(
      "row-too-short",
      "La riga docente è più corta dei blocchi orari previsti: completa le celle mancanti nel foglio e riprova.",
    );
  }

  const cells: TimetableRawCell[] = [];
  for (const block of inspection.dayBlocks) {
    for (let offset = 0; offset < block.columns.length; offset++) {
      cells.push({
        rowIndex: 0,
        dayOfWeek: block.dayOfWeek,
        periodIndex: offset + 1,
        raw: String(inspection.sheet.cells[rowIndex]?.[block.columns[offset]] ?? "").trim(),
      });
    }
  }
  return cells;
}
