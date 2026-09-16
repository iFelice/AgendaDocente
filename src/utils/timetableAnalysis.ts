/**
 * Pipeline "Scansiona documento" — orari:
 *  - runtime validation della risposta AI (deterministica, conservativa);
 *  - ricerca della riga del docente nel profilo (cognome, maiuscole indifferenti,
 *    senza matching aggressivo);
 *  - conversione celle -> candidati (mai inventare celle mancanti).
 *
 * ORARIO PERSONALE: il modello restituisce la riga del docente divisa nei suoi
 * CINQUE blocchi giornalieri (`{ rowLabel, days: [{ cells: string[] }, …] }`) —
 * nessun giorno, nessun periodo, nessun indice di riga dichiarati. Le
 * coordinate sono derivate dal codice dalla POSIZIONE: indice del blocco
 * (lunedì → venerdì) e indice della cella dentro il blocco (vedi
 * `validatePersonalSequencePayload`).
 *
 * Il matching delle classi usa SOLO le regole esplicite di timetableTokens:
 * D/P/Co e gli altri codici interni non diventano mai classi.
 */

import type { TimetableSlot } from "../types";
import type { TimetableToken } from "./timetableTokens";
import { classifyTimetableToken, extractClassesFromCell } from "./timetableTokens";
import { foldName } from "./studentMatcher";
import { isGenericSubject } from "./circularRelevance";
import { normalizeSubjectName, sameSubject } from "./subjects";
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

/**
 * Errore di FORMA del payload AI: i messaggi sono stringhe fisse del validatore
 * (mai testo del documento), quindi sono sicuri da mettere nei log del server.
 */
export class TimetableShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimetableShapeError";
  }
}

function invalidShape(message: string): never {
  throw new TimetableShapeError(message);
}

export function validateRawCell(v: unknown, index: number): TimetableRawCell {
  if (!record(v) || !intWithin(v.rowIndex, 0, 100) || !intWithin(v.dayOfWeek, 1, 6)
    || !intWithin(v.periodIndex, 1, 24) || !str(v.raw, 60)) invalidShape(`Cella orario non valida (#${index}).`);
  return { rowIndex: v.rowIndex, dayOfWeek: v.dayOfWeek, periodIndex: v.periodIndex, raw: v.raw.trim() };
}

/**
 * Ore per giorno massime dichiarabili per l'orario personale.
 *
 * Il tetto coincide con le fasce orarie dell'app: la configurazione dichiara al
 * massimo 12 periodi per giorno, quindi un periodo dal 13º in poi normalmente
 * non ha una fascia propria e `periodTimesForIndex` lo farebbe ricadere sugli
 * orari della 1ª ora (ore duplicate o sbagliate in archivio). Meglio rifiutare
 * la dichiarazione dell'utente che salvare un orario incoerente: oltre 12
 * l'analisi non parte.
 */
export const MAX_GRID_PERIODS = 12;

/**
 * Giorni scolastici del percorso personale corrente: lunedì-venerdì.
 *
 * Unico moltiplicatore della geometria ammesso da questo contratto: il sabato
 * non ne fa parte (nessuna domanda sui giorni, nessuna UI dedicata).
 */
export const PERSONAL_SCHOOL_DAYS = 5;

/**
 * Celle attese nella sequenza dell'orario personale.
 *
 * È l'UNICA geometria ammessa e NON è una costante: il numero di celle non
 * compare mai scritto a mano, è il prodotto fra le ore per giorno dichiarate
 * dall'UTENTE e i giorni scolastici del percorso (5 ore x 5 giorni = 25
 * posizioni fisiche).
 */
export function expectedPersonalCellCount(periodsPerDay: number): number {
  return periodsPerDay * PERSONAL_SCHOOL_DAYS;
}

/** Etichetta della riga docenti: `null`/`""` = riga senza etichetta leggibile. */
function normalizeRowLabel(value: unknown, index: number): string {
  if (value === null || value === undefined) return "";
  if (!str(value, 80)) invalidShape(`Riga del documento non valida (#${index}).`);
  return String(value).trim();
}

/**
 * Una posizione della sequenza personale: il testo ESATTO della cella.
 *
 * `null` vale come cella vuota (`""`): nel documento sono lo stesso fatto e
 * nessuna geometria dipende da questo campo (dipende dalla posizione della
 * cella dentro il suo blocco giornaliero). Un valore non stringa — `undefined`
 * incluso — resta un errore: la posizione non è descritta e non viene inventata.
 */
function normalizeSequenceCell(value: unknown, index: number): string {
  if (value === null) return "";
  if (!str(value, 60)) invalidShape(`Cella orario non valida (#${index}).`);
  return value.trim();
}

export interface PersonalSequence {
  /**
   * Etichetta della riga letta dal modello. È SOLO una guardia d'identità:
   * non contiene e non produce coordinate.
   */
  rowLabel: string;
  /**
   * Celle della riga del docente, appiattite dai blocchi giornalieri nell'ordine
   * dei giorni: una per posizione fisica, vuoti inclusi. È lo stesso
   * `TimetableRawCell[]` di sempre (riga sintetica 0), quindi tutto ciò che sta
   * a valle del validatore è invariato.
   */
  cells: TimetableRawCell[];
}

/**
 * Valida la risposta grezza dell'orario personale:
 * `{ rowLabel, days: [{ cells: string[] }, … x PERSONAL_SCHOOL_DAYS] }`.
 *
 * Il modello NON dichiara giorno, periodo, indice di riga né ore per giorno:
 * restituisce la riga del docente divisa nei suoi blocchi fisici giornalieri,
 * ognuno con le celle di quel giorno nell'ordine delle colonne, vuoti al loro
 * posto. È la geometria che mancava al formato piatto `cells[]`: lì una lettura
 * spostata di una colonna (il venerdì iniziato da una cella vuota) produceva
 * comunque il totale atteso e superava un controllo fatto solo sul totale.
 *
 * Gate duri (nessuna compensazione, nessuna rinumerazione, nessun anchoring):
 *  1. `days` è un array di ESATTAMENTE `PERSONAL_SCHOOL_DAYS` blocchi;
 *  2. ogni blocco è un oggetto con `cells` array lungo ESATTAMENTE
 *     `periodsPerDay`, di stringhe (`null` vale cella vuota, non stringa no);
 *  3. `rowLabel` deve combaciare col cognome del profilo tramite il matcher
 *     già esistente (`findTeacherRows`, cognome come parola intera): se non è
 *     compatibile l'analisi è rifiutata e NESSUN'altra riga viene scelta.
 *
 * Controllare il totale NON basta più: cinque blocchi da 5, 5, 4, 5 e 6 celle
 * sommano le stesse posizioni ma sono rifiutati, perché il giorno corto ha
 * perso un'ora e quello lungo ne contiene una di un altro giorno.
 *
 * Il formato piatto precedente (`{ rowLabel, cells }`) NON è accettato, nemmeno
 * come fallback: senza blocchi non si sa dove finisce un giorno, quindi quel
 * payload è ambiguo per costruzione e si preferisce chiedere una nuova
 * scansione piuttosto che salvare una geometria dubbia.
 *
 * Solo DOPO questi gate la POSIZIONE diventa coordinata: `dayOfWeek = indice del
 * blocco + 1`, `periodIndex = indice della cella nel blocco + 1`, su una riga
 * sintetica `rowIndex = 0`. È l'unica sorgente di coordinate del percorso
 * personale: il modello non può influenzarla.
 *
 * `periodsPerDay` arriva dalla REQUEST (dichiarato dall'utente), mai dal
 * payload del modello.
 */
export function validatePersonalSequencePayload(
  raw: unknown,
  targetTeacherSurname: string,
  periodsPerDay: number,
): PersonalSequence {
  if (!record(raw)) invalidShape("Risposta analisi non valida.");
  const periods = intWithin(periodsPerDay, 1, MAX_GRID_PERIODS) ? periodsPerDay : 0;
  if (periods === 0) invalidShape("Ore per giorno non valide.");

  const rowLabel = normalizeRowLabel(raw.rowLabel, 0);
  // Guardia d'identità col matcher esistente (cognome intero, mai sottostringa):
  // senza una riga compatibile non si sceglie un'altra riga, si rifiuta.
  if (findTeacherRows([rowLabel], targetTeacherSurname).length !== 1) {
    invalidShape("Riga del documento non compatibile col docente.");
  }

  // Nessun fallback al formato piatto: un payload che porta ancora `cells` alla
  // radice non viene reinterpretato né convertito, viene rifiutato.
  if (raw.cells !== undefined) invalidShape("Formato della risposta non supportato: attesi i blocchi giornalieri.");
  if (!Array.isArray(raw.days)) invalidShape("Giorni del documento non validi.");
  if (raw.days.length !== PERSONAL_SCHOOL_DAYS) invalidShape("Numero di giorni dell'orario non valido.");

  // Derivazione deterministica: unica origine di giorno e periodo.
  const cells: TimetableRawCell[] = [];
  raw.days.forEach((day, dayIndex) => {
    if (!record(day)) invalidShape(`Giorno non valido (#${dayIndex}).`);
    if (!Array.isArray(day.cells)) invalidShape(`Celle del giorno non valide (#${dayIndex}).`);
    // Lunghezza del SINGOLO blocco: il totale delle celle non è una prova
    // sufficiente (5+5+4+5+6 fa lo stesso totale di 5+5+5+5+5).
    if (day.cells.length !== periods) invalidShape(`Lunghezza del giorno non valida (#${dayIndex}).`);
    day.cells.forEach((value, cellIndex) => {
      cells.push({
        rowIndex: 0,
        dayOfWeek: dayIndex + 1,
        periodIndex: cellIndex + 1,
        raw: normalizeSequenceCell(value, dayIndex * periods + cellIndex),
      });
    });
  });
  return { rowLabel, cells };
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
    // Colonna vuota del documento (raw vuoto): serve ad ancorare le posizioni, ma
    // non è un candidato e non è una cella da interpretare: nessun rumore in
    // «skipped» (altrimenti ogni ora libera risulterebbe «non letta»).
    if (!cell.raw.trim()) continue;
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

// ---------------------------------------------------------------------------
// AMBITO DELLA RICOSTRUZIONE: l'orario curricolare d'istituto è solo una
// SORGENTE per le compresenze, mai un orario da mostrare o da salvare.
// ---------------------------------------------------------------------------

/**
 * Una coordinata del mio orario: giorno + periodo + classe. È l'unica grana
 * con cui l'orario curricolare viene consultato.
 */
export interface PersonalCoordinate {
  dayOfWeek: number;
  periodIndex: number;
  classLabel: string;
  key: string;
}

/** "3 d", "3°D", " 3D " -> tutti alla stessa chiave di classe. */
export function foldClassKey(classLabel: string): string {
  return String(classLabel ?? "").trim().toUpperCase().replace(/\s+/g, "").replace(/[\^°ª]/g, "");
}

export function coordinateKey(dayOfWeek: number, periodIndex: number, classLabel: string): string {
  return `${dayOfWeek}|${periodIndex}|${foldClassKey(classLabel)}`;
}

/**
 * Le coordinate (giorno + periodo + classe) in cui il docente è davvero presente:
 * candidati personali di QUESTA sessione + ore già salvate nel proprio orario
 * (provvisorio e definitivo). Le ore salvate contano perché l'orario curricolare
 * viene aggiunto dopo il salvataggio della Fase A — e anche quando il modale è
 * stato chiuso e riaperto.
 */
export function buildPersonalCoordinateScope(input: {
  candidates?: Array<Pick<PersonalTimetableSlotCandidate, "dayOfWeek" | "periodIndex" | "classLabel">>;
  savedSlots?: Array<Pick<TimetableSlot, "dayOfWeek" | "periodNumber" | "className">>;
}): PersonalCoordinate[] {
  const coordinates: PersonalCoordinate[] = [];
  const seen = new Set<string>();
  const push = (dayOfWeek: number, periodIndex: number, classLabel: string | undefined) => {
    const clean = String(classLabel ?? "").trim();
    if (!clean) return; // ora personale senza classe: nessuna classe da cercare (mai inventata)
    const key = coordinateKey(dayOfWeek, periodIndex, clean);
    if (seen.has(key)) return;
    seen.add(key);
    coordinates.push({ dayOfWeek, periodIndex, classLabel: clean, key });
  };
  for (const candidate of input.candidates ?? []) push(candidate.dayOfWeek, candidate.periodIndex, candidate.classLabel);
  for (const slot of input.savedSlots ?? []) push(slot.dayOfWeek, slot.periodNumber, slot.className);
  return coordinates;
}

/**
 * Tiene solo gli slot curricolari che cadono su una mia coordinata.
 * - classe giusta ma giorno/periodo diversi -> esclusi;
 * - giorno/periodo giusti ma classe diversa -> esclusi;
 * - nulla viene aggiunto o inventato: il filtro può solo togliere.
 */
export function restrictCurricularSlotsToCoordinates(
  slots: CurricularTimetableSlot[],
  coordinates: PersonalCoordinate[]
): { slots: CurricularTimetableSlot[]; droppedCount: number } {
  if (coordinates.length === 0) return { slots, droppedCount: 0 }; // nessun orario personale: niente da filtrare
  const scope = new Set(coordinates.map(c => c.key));
  const kept = slots.filter(s => scope.has(coordinateKey(s.dayOfWeek, s.periodIndex, s.classLabel)));
  return { slots: kept, droppedCount: slots.length - kept.length };
}

/**
 * Riepilogo per il docente: quante delle MIE ore hanno una materia trovata,
 * quante sono ambigue (scelta manuale), quante senza identificazione.
 * Gli slot fuori ambito sono già stati scartati, quindi non compaiono qui.
 */
export interface CurricularCoverageSummary {
  /** Ore del mio orario considerate. */
  hours: number;
  /** Ore con una sola materia curricolare trovata. */
  found: number;
  /** Ore con più materie possibili (l'utente deve scegliere). */
  ambiguous: number;
  /** Ore senza materia identificata: mai inventate. */
  missing: number;
}

export function summarizeCurricularCoverage(
  coordinates: PersonalCoordinate[],
  slots: CurricularTimetableSlot[]
): CurricularCoverageSummary {
  const summary: CurricularCoverageSummary = { hours: coordinates.length, found: 0, ambiguous: 0, missing: 0 };
  for (const coordinate of coordinates) {
    const subjects: string[] = [];
    for (const slot of slots) {
      if (coordinateKey(slot.dayOfWeek, slot.periodIndex, slot.classLabel) !== coordinate.key) continue;
      const value = String(slot.subject ?? "").trim();
      if (!value) continue; // materia non indicata: non si inventa nulla
      if (!subjects.some(existing => sameSubject(existing, value))) subjects.push(value);
    }
    if (subjects.length === 0) summary.missing++;
    else if (subjects.length === 1) summary.found++;
    else summary.ambiguous++;
  }
  return summary;
}
