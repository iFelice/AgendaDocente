/**
 * Pipeline "Scansiona documento" — orari:
 *  - runtime validation della risposta AI (deterministica, conservativa);
 *  - ricerca della riga del docente nel profilo (cognome, maiuscole indifferenti,
 *    senza matching aggressivo);
 *  - conversione celle -> candidati (mai inventare celle mancanti).
 *
 * Il matching delle classi usa SOLO le regole esplicite di timetableTokens:
 * D/P/Co e gli altri codici interni non diventano mai classi.
 */

import type { TimetableToken } from "./timetableTokens";
import { classifyTimetableToken, extractClassesFromCell } from "./timetableTokens";
import { foldName } from "./studentMatcher";
import { isGenericSubject } from "./circularRelevance";
import { normalizeSubjectName } from "./subjects";
import { isValidDate, isValidTime } from "./dates";

// ---------------------------------------------------------------------------
// Tipi candidati (schema concettuale del documento)
// ---------------------------------------------------------------------------

export interface PersonalTimetableSlotCandidate {
  id: string;
  dayOfWeek: number;      // 1 = Lunedì … 6 = Sabato
  periodIndex: number;    // 1..N
  classLabel?: string;
  schoolId?: string;
  classId?: string;
  sourceType: "personal-support-timetable";
  confidence: "high" | "medium" | "low";
}

export interface CurricularTimetableSlot {
  dayOfWeek: number;
  periodIndex: number;
  classLabel: string;
  subject?: string;
  confidence: "high" | "medium" | "low";
}

export type StudentCommitmentType =
  | "oral_test"
  | "written_test"
  | "recovery"
  | "meeting"
  | "assignment"
  | "other";

export type StudentMatchStatus = "exact" | "probable" | "ambiguous" | "unmatched";

export interface StudentCommitmentCandidate {
  id: string;
  rawText?: string;
  studentNameRaw?: string;
  matchedStudentId?: string;
  matchStatus: StudentMatchStatus;
  matchConfidence?: number;
  type: StudentCommitmentType;
  title: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  subject?: string;
  className?: string;
  notes?: string;
  selected: boolean;
}

// ---------------------------------------------------------------------------
// Risposte grezze (validate a runtime sia lato server che lato client)
// ---------------------------------------------------------------------------

export interface TimetableRawCell {
  rowIndex: number;
  dayOfWeek: number;
  periodIndex: number;
  raw: string;
}

export interface CurricularRawRow {
  rowIndex: number;
  rowLabel?: string;
  subject?: string;
  classes?: string[];
}

export type TimetableDocumentType = "personal-support-timetable" | "curricular-timetable";

const intWithin = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

function invalidShape(message: string): never {
  throw new Error(message);
}

export function validateRawCell(v: unknown, index: number): TimetableRawCell {
  if (!record(v) || !intWithin(v.rowIndex, 0, 100) || !intWithin(v.dayOfWeek, 1, 6)
    || !intWithin(v.periodIndex, 1, 24) || !str(v.raw, 60)) invalidShape(`Cella orario non valida (#${index}).`);
  return { rowIndex: v.rowIndex, dayOfWeek: v.dayOfWeek, periodIndex: v.periodIndex, raw: v.raw.trim() };
}

/** Valida la risposta grezza per l'orario personale/sostegno: { rows, cells }. */
export function validatePersonalTimetablePayload(raw: unknown): { rows: string[]; cells: TimetableRawCell[] } {
  if (!record(raw)) invalidShape("Risposta analisi non valida.");
  if (!Array.isArray(raw.rows) || raw.rows.length > 60 || !raw.rows.every(r => str(r, 80))) invalidShape("Righe del documento non valide.");
  if (!Array.isArray(raw.cells) || raw.cells.length > 500) invalidShape("Celle del documento non valide.");
  return { rows: raw.rows.map(r => String(r).trim()), cells: raw.cells.map((c, i) => validateRawCell(c, i)) };
}

/** Valida la risposta grezza per l'orario curricolare: { rows, cells }. */
export function validateCurricularTimetablePayload(raw: unknown): { rows: CurricularRawRow[]; cells: TimetableRawCell[] } {
  if (!record(raw)) invalidShape("Risposta analisi non valida.");
  if (!Array.isArray(raw.rows) || raw.rows.length > 100) invalidShape("Righe del documento non valide.");
  const rows: CurricularRawRow[] = raw.rows.map((r, i) => {
    // subject e classes sono obbligatori nella risposta AI (valori vuoti ammessi, inventati no).
    if (!record(r) || !intWithin(r.rowIndex, 0, 100) || !str(r.subject, 80)
      || !Array.isArray(r.classes) || r.classes.length > 10 || !r.classes.every(c => str(c, 20))) {
      invalidShape(`Riga docente non valida (#${i}).`);
    }
    return {
      rowIndex: r.rowIndex,
      rowLabel: r.rowLabel === undefined ? undefined : (str(r.rowLabel, 80) ? r.rowLabel.trim() : invalidShape("Etichetta riga non valida.")),
      subject: r.subject.trim(),
      classes: r.classes.map(c => c.trim()),
    };
  });
  if (!Array.isArray(raw.cells) || raw.cells.length > 1500) invalidShape("Celle del documento non valide.");
  return { rows, cells: raw.cells.map((c, i) => validateRawCell(c, i)) };
}

const COMMITMENT_TYPES: StudentCommitmentType[] = ["oral_test", "written_test", "recovery", "meeting", "assignment", "other"];

/** Valida l'array impegni estratti da un registro/appunti. */
export function validateStudentCommitmentsPayload(raw: unknown): Array<Omit<StudentCommitmentCandidate, "matchStatus" | "matchedStudentId" | "matchConfidence" | "selected">> {
  if (!Array.isArray(raw) || raw.length > 100) invalidShape("Risposta analisi non valida.");
  return raw.map((entry, index) => {
    if (!record(entry) || !str(entry.title, 200) || !entry.title.trim()) invalidShape(`Impegno non valido (#${index}).`);
    if (!COMMITMENT_TYPES.includes(entry.type as StudentCommitmentType)) invalidShape(`Tipo impegno non valido (#${index}).`);
    const optionalStr = (v: unknown, max: number): string | undefined =>
      v === undefined || v === "" ? undefined : str(v, max) ? v.trim() : invalidShape(`Campo non valido (#${index}).`);
    const date = optionalStr(entry.date, 10);
    const startTime = optionalStr(entry.startTime, 5);
    const endTime = optionalStr(entry.endTime, 5);
    if (date !== undefined && !isValidDate(date)) invalidShape(`Data non valida (#${index}).`);
    if (startTime !== undefined && !isValidTime(startTime)) invalidShape(`Ora di inizio non valida (#${index}).`);
    if (endTime !== undefined && !isValidTime(endTime)) invalidShape(`Ora di fine non valida (#${index}).`);
    return {
      id: `commit-${Date.now()}-${index}`,
      rawText: optionalStr(entry.rawText, 500),
      studentNameRaw: optionalStr(entry.studentNameRaw, 120),
      type: entry.type as StudentCommitmentType,
      title: entry.title.trim(),
      date,
      startTime,
      endTime,
      subject: optionalStr(entry.subject, 80),
      className: optionalStr(entry.className, 20),
      notes: optionalStr(entry.notes, 500),
    };
  });
}

// ---------------------------------------------------------------------------
// Ricerca della riga del docente (conservativa)
// ---------------------------------------------------------------------------

const HONORIFIC_PATTERN = /^(?:prof(?:essore|essoressa|essor|\.|ssa)?|dott(?:ore|oressa|or|\.|ssa)?|ing\.?|arch\.?|dr\.?|avv\.?)\s+/i;

/**
 * Estrae il cognome dal nome completo del profilo ("Prof. Felice Manganiello"
 * -> "Manganiello"). Onorifici rimossi; maiuscole e accenti ignorati a valle.
 */
export function teacherSurnames(fullName: unknown): string[] {
  const clean = String(fullName ?? "").trim().replace(HONORIFIC_PATTERN, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  return [foldName(parts[parts.length - 1])].filter(Boolean);
}

export interface TeacherRowMatch {
  rowIndex: number;
  rowLabel: string;
}

/**
 * Trova le righe della tabella compatibili con il docente del profilo.
 *
 * Regole conservative:
 *  - si confronta SOLO il cognome del profilo, come parola intera
 *    (mai sottostringhe: "Bianchi" non combacia con "Bianchini");
 *  - maiuscole, accenti e punteggiatura non contano;
 *  - se più righe sono compatibili vengono tutte restituite: la scelta
 *    definitiva spetta sempre all'utente (niente auto-selezione);
 *  - se nessuna riga è compatibile, la lista resta vuota (l'utente può
 *    comunque scegliere manualmente la riga corretta).
 */
export function findTeacherRows(rowLabels: string[], profileName: unknown): TeacherRowMatch[] {
  const surnames = teacherSurnames(profileName);
  if (!surnames.length) return [];
  const matches: TeacherRowMatch[] = [];
  rowLabels.forEach((label, rowIndex) => {
    const words = foldName(label).split(" ").filter(Boolean);
    if (surnames.some(s => words.includes(s))) matches.push({ rowIndex, rowLabel: label });
  });
  return matches;
}

// ---------------------------------------------------------------------------
// Conversione celle -> candidati (mai inventare)
// ---------------------------------------------------------------------------

export interface SkippedCell {
  rowIndex: number;
  dayOfWeek: number;
  periodIndex: number;
  raw: string;
  reason: "internal-code" | "unrecognized";
}

export interface PersonalExtraction {
  candidates: PersonalTimetableSlotCandidate[];
  skipped: SkippedCell[];
}

function cellConfidence(raw: string): "high" | "medium" {
  const tokens = raw.split(/[\s/;,+|]+/).filter(Boolean);
  return tokens.every(t => classifyTimetableToken(t).kind === "class" || classifyTimetableToken(t).kind === "support") ? "high" : "medium";
}

/**
 * Trasforma le celle (riga del docente) in candidati orari.
 *
 * - cella con classe valida   -> candidato (uno per classe presente);
 * - cella "sos" (sostegno)    -> candidato senza classe (l'utente la completa);
 * - cella D/P/Co o illeggibile-> NESSUN candidato: va in "skipped" e l'utente
 *                               vede che la cella non è stata interpretata.
 * Le celle mancanti (non restituite dal documento) non vengono MAI inventate.
 */
export function personalCellsToCandidates(
  cells: TimetableRawCell[],
  matchedRowIndexes: number[],
  idPrefix = "pts"
): PersonalExtraction {
  const candidates: PersonalTimetableSlotCandidate[] = [];
  const skipped: SkippedCell[] = [];
  const rows = new Set(matchedRowIndexes);

  for (const cell of cells) {
    if (!rows.has(cell.rowIndex)) continue;
    const classes = extractClassesFromCell(cell.raw);
    const base = { id: `${idPrefix}-${cell.rowIndex}-${cell.dayOfWeek}-${cell.periodIndex}`, dayOfWeek: cell.dayOfWeek, periodIndex: cell.periodIndex, sourceType: "personal-support-timetable" as const };
    if (classes.length > 0) {
      for (const classLabel of classes) {
        candidates.push({ ...base, id: `${base.id}-${classLabel}`, classLabel, confidence: cellConfidence(cell.raw) });
      }
      continue;
    }
    const token: TimetableToken = classifyTimetableToken(cell.raw);
    if (token.kind === "support") {
      candidates.push({ ...base, classLabel: undefined, confidence: "medium" });
    } else {
      skipped.push({ ...cell, reason: token.kind === "internal-code" ? "internal-code" : "unrecognized" });
    }
  }

  // De-duplicazione deterministica (stessa riga/giorno/periodo/classe una volta sola).
  const seen = new Set<string>();
  const unique = candidates.filter(c => {
    const key = `${c.dayOfWeek}|${c.periodIndex}|${c.classLabel ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { candidates: unique, skipped };
}

export interface CurricularExtraction {
  slots: CurricularTimetableSlot[];
  skipped: SkippedCell[];
}

/**
 * Trasforma le celle (tutte le righe docenti) in slot curricolari.
 * La materia viene presa SOLO dalla riga: se manca resta undefined
 * (mai inventata). D/P/Co non diventano mai classi.
 */
export function curricularCellsToSlots(rows: CurricularRawRow[], cells: TimetableRawCell[]): CurricularExtraction {
  const rowByIndex = new Map(rows.map(r => [r.rowIndex, r]));
  const slots: CurricularTimetableSlot[] = [];
  const skipped: SkippedCell[] = [];

  for (const cell of cells) {
    const row = rowByIndex.get(cell.rowIndex);
    if (!row) {
      skipped.push({ ...cell, reason: "unrecognized" });
      continue;
    }
    const classes = extractClassesFromCell(cell.raw);
    if (classes.length === 0) {
      const token = classifyTimetableToken(cell.raw);
      skipped.push({ ...cell, reason: token.kind === "internal-code" ? "internal-code" : "unrecognized" });
      continue;
    }
    const subject = row.subject && !isGenericSubject(row.subject) ? normalizeSubjectName(row.subject) : undefined;
    for (const classLabel of classes) {
      slots.push({
        dayOfWeek: cell.dayOfWeek,
        periodIndex: cell.periodIndex,
        classLabel,
        subject,
        confidence: subject ? "high" : "low",
      });
    }
  }

  const seen = new Set<string>();
  const unique = slots.filter(s => {
    const key = `${s.dayOfWeek}|${s.periodIndex}|${s.classLabel}|${s.subject ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { slots: unique, skipped };
}
