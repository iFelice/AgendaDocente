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

/** Colonne-periodo massime plausibili in una griglia orario (geometria reale). */
const MAX_GRID_PERIODS = 24;
/**
 * Celle massime dell'orario personale nel formato DENSO: righe x giorni x colonne
 * (con le vuote incluse). 5000 copre una pagina reale di intero team docente
 * (25 docenti x 5 giorni x 5 ore = 625) e resta un guard contro payload assurdi:
 * il formato precedente, solo celle piene, si fermava a 500 e spezzava le
 * analisi vere con «Celle del documento non valide.».
 * Righe e celle sono due limiti indipendenti: stringerne uno e allargare l'altro
 * produce comunque lo stesso crash, quindi vanno tenuti allineati.
 */
export const MAX_PERSONAL_GRID_CELLS = 5000;
/** Righe docenti massime nell'orario personale (allineate al curricolare). */
export const MAX_PERSONAL_GRID_ROWS = 100;
/**
 * Limite alto per il `periodIndex` GREZZO dell'orario personale: il numero del
 * modello è dato non fidato (può essere un contatore progressivo su tutta la
 * riga) e viene ancorato alle colonne della griglia subito dopo. Quindi la forma
 * viene validata in un range ampio (60: oltre è un payload assurdo) e la coerenza
 * con la griglia la verifica l'ancoraggio, non la validazione del singolo campo.
 */
const MAX_GRID_INDEX_INPUT = 60;

/**
 * Cella personale grezza: stessa validazione di `validateRawCell`, ma con due
 * tolleranze VOLUTE, introdotte dal formato denso (una cella per colonna):
 *  - `periodIndex` accettato fino a 60: il numero grezzo del modello è dato non
 *    fidato (può essere un contatore progressivo sulla riga) e viene ancorato alle
 *    colonne subito dopo — rifiutarlo qui significava perdere l'intera analisi;
 *  - `raw: null` vale come colonna vuota (`""`): `null` e `""` sono lo stesso
 *    fatto nel documento, e nessun valore viene inventato.
 * `raw` ASSENTE resta un errore: la cella non è descritta.
 */
function validatePersonalRawCell(v: unknown, index: number): TimetableRawCell {
  if (!record(v) || !intWithin(v.rowIndex, 0, 100) || !intWithin(v.dayOfWeek, 1, 6)
    || !intWithin(v.periodIndex, 1, MAX_GRID_INDEX_INPUT) || !(v.raw === null || str(v.raw, 60))) {
    invalidShape(`Cella orario non valida (#${index}).`);
  }
  return {
    rowIndex: v.rowIndex,
    dayOfWeek: v.dayOfWeek,
    periodIndex: v.periodIndex,
    raw: typeof v.raw === "string" ? v.raw.trim() : "",
  };
}

/**
 * Colonne-periodo dichiarate dall'intestazione. Campo NUOVO e opzionale: il
 * modello può ometterlo, scrivere `null` o un numero in forma di stringa. Qui si
 * normalizza (mai si rifiuta l'intera analisi per un metadato: la geometria può
 * essere recuperata dalle celle stesse).
 */
export function normalizePeriodsPerDay(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  return 0;
}

/** Etichetta di una riga docenti: `null`/`""` = riga senza etichetta leggibile. */
function normalizeRowLabel(value: unknown, index: number): string {
  if (value === null || value === undefined) return "";
  if (!str(value, 80)) invalidShape(`Riga del documento non valida (#${index}).`);
  return String(value).trim();
}

export interface PersonalGridAnchor {
  /** Celle con `periodIndex` ancorato alle colonne della griglia. */
  cells: TimetableRawCell[];
  /** Colonne per giorno usate per l'ancoraggio (0: griglia non determinabile). */
  periodsPerDay: number;
  /** (riga, giorno) da verificare a mano: geometria incoerente, posizioni NON riparate. */
  positionIssues: number;
}

/**
 * Àncora le celle estratte alla GRIGLIA del documento.
 *
 * Regola madre: **la colonna del documento determina il periodo**. Una cella
 * vuota non deve mai far scorrere a sinistra le ore successive ([3D, vuota, 3D,
 * 3D, 3E] -> 1, 3, 4, 5, mai 1, 2, 3, 4) e nessuna posizione viene mai
 * ricostruita sul numero di celle non vuote.
 *
 * Come, senza alcuna inferenza sul contenuto:
 * - le colonne per giorno sono `periodsPerDay` dichiarato dall'intestazione
 *   quando c'è, altrimenti il numero di colonne osservato;
 * - gruppo DENSO (una cella per colonna, vuote `raw: ""` incluse):
 *   1. se i `periodIndex` sono una PERMUTAZIONE ESATTA di 1..width (ogni colonna
 *      reclamata una e una sola volta) COMANDANO I NUMERI: il payload dice già
 *      quale colonna è vuota, e sostituirli con l'ordine dell'array sposterebbe
 *      l'intero giorno (caso reale: il vuoto della 1ª emesso in coda -> 3E in 1ª);
 *   2. se i numeri NON sono una permutazione (duplicati, buchi, contatore delle
 *      sole celle piene) le celle restano COI LORO NUMERI e il giorno è contato in
 *      `positionIssues`: nessuna posizione viene mai ricostruita dall'ordine
 *      dell'array, perché sarebbe un'invenzione e nasconderebbe il difetto.
 * - gruppo incompleto (l'AI ha omesso le colonne vuote): i numeri assoluti sono
 *   gli unici usati e NON sono mai ricompattati o rinumerati; si conta in
 *   `positionIssues` sia la numerazione incoerente (duplicati, colonna oltre
 *   `width`) sia il pattern sospetto `1..k` con `k < width` — identico a un
 *   giorno legittimamente più corto, quindi è un AVVISO e mai una correzione.
 *
 * Le celle vuote partecipano all'ancoraggio (sono la geometria della griglia) e
 * vengono scartate solo dopo, in `personalCellsToCandidates`.
 */
export function anchorPersonalCellsToGrid(cells: TimetableRawCell[], declaredPeriodsPerDay?: number): PersonalGridAnchor {
  const declared = intWithin(declaredPeriodsPerDay, 1, MAX_GRID_PERIODS) ? declaredPeriodsPerDay! : 0;
  if (cells.length === 0) return { cells, periodsPerDay: declared, positionIssues: 0 };

  let observed = 0;
  for (const cell of cells) observed = Math.max(observed, cell.periodIndex);
  // La geometria dichiarata dal documento (intestazione) prevale sul massimo
  // osservato: è l'unica àncora indipendente dalla numerazione del modello.
  const width = declared > 0 ? declared : observed;

  const groups = new Map<string, TimetableRawCell[]>();
  for (const cell of cells) {
    const key = `${cell.rowIndex}|${cell.dayOfWeek}`;
    const group = groups.get(key);
    if (group) group.push(cell);
    else groups.set(key, [cell]);
  }

  let positionIssues = 0;
  const anchored: TimetableRawCell[] = [];
  for (const group of groups.values()) {
    if (group.length === width) {
      // Denso: una cella per colonna, vuote incluse. È affidabile quando ogni
      // colonna della griglia è reclamata ESATTAMENTE una volta (i periodIndex
      // sono una permutazione di 1..width): in tal caso le celle restano sulla
      // LORO colonna, qualunque sia l'ordine con cui l'AI le ha elencate.
      const numbers = group.map(cell => cell.periodIndex);
      const declaresEveryColumn = new Set(numbers).size === width && numbers.every(n => n >= 1 && n <= width);
      if (!declaresEveryColumn) {
        // Numeri incoerenti con la griglia (duplicati, buchi, contatore delle sole
        // celle piene): le celle restano sui LORO periodIndex e il giorno viene
        // contato in `positionIssues`. Prima si rinumerava per ordine di emissione
        // (`index + 1`), e un giorno ruotato dal modello diventava un orario
        // apparentemente valido (caso reale: martedì [3E,3D,3D,3D,3E] numerati
        // [1,2,3,4,4] -> «3E in 1ª ora»). Mostrare l'incoerenza vale più che
        // inventare una posizione: l'anchoring NON tocca mai i periodIndex.
        positionIssues++;
      } else {
        // Geometria coerente: i numeri del modello SONO la griglia e l'ordine di
        // emissione è irrilevante (payload conforme -> celle esattamente invariate).
      }
      for (const cell of group) anchored.push({ ...cell });
      continue;
    }
    // Incompleta: l'unico indizio disponibile è la numerazione del modello.
    const ordered = [...group].sort((a, b) => a.periodIndex - b.periodIndex);
    // (l'AI ha omesso le colonne vuote): la posizione esatta non è deducibile,
    // quindi i numeri assoluti del modello restano gli unici usati e NON vengono
    // mai ricompattati o rinumerati per "indovinare" le vuote.
    const seen = new Set<number>();
    let coherent = true;
    for (const cell of ordered) {
      // Numeri duplicati sulla stessa riga/giorno, o fuori dalle colonne dichiarate:
      // la griglia non è ricostruibile e la posizione di quell'ora va verificata.
      if (seen.has(cell.periodIndex) || cell.periodIndex > width) coherent = false;
      seen.add(cell.periodIndex);
    }
    // Pattern sospetto da ricompattazione: k celle numerate esattamente 1..k su
    // una griglia da `width` colonne. NON è distinguibile da un giorno
    // legittimamente più corto, quindi si SEGNALA e basta: nessuna cella viene
    // spostata e nessuna numerazione viene "corretta" (mai inventare).
    const compactPrefix = group.length < width && ordered.every((cell, index) => cell.periodIndex === index + 1);
    if (!coherent || compactPrefix) positionIssues++;
    anchored.push(...ordered);
  }

  return {
    cells: anchored.sort((a, b) => a.rowIndex - b.rowIndex || a.dayOfWeek - b.dayOfWeek || a.periodIndex - b.periodIndex),
    periodsPerDay: width,
    positionIssues,
  };
}

/**
 * Filtro difensivo del contratto "celle SOLO delle righe candidate".
 *
 * Il prompt chiede a Gemini le etichette di TUTTE le righe (costano ~14 char
 * l'una) e la griglia densa solo delle righe compatibili col cognome: sono le
 * righe altre a valere ~95% dell'output (625 celle su una pagina da 25 docenti).
 * Se il modello ne ha comunque incluse altre, qui vengono scartate PRIMA di
 * ancorare e PRIMA di rispondere, così nessun chiamante può dimenticarlo.
 *
 * Regola conservativa (mai peggiorare un caso che oggi funziona):
 * - `matches.length >= 1` -> restano solo le celle delle righe localmente
 *   candidate: il modello non può far entrare in archivio la riga di un collega;
 * - `matches.length === 0` -> le celle ricevute RESTANO: il matcher locale
 *   confronta il cognome come parola intera e un'etichetta letta male
 *   ("Manganiello F.") non combacia, mentre il modello potrebbe aver azzeccato
 *   la riga. La scelta resta umana (`confirmedRow` parte null) e nessuna ora è
 *   creata automaticamente: qui non si scarta, e non si aggiunge fuzzy matching.
 * Senza cognome target (chiamanti senza profilo, test, payload legacy) il
 * comportamento è esattamente quello storico: nessuna selezione per riga.
 */
export function restrictPersonalCellsToTargetRows(
  cells: TimetableRawCell[],
  rowLabels: string[],
  targetTeacherSurname?: string,
): { cells: TimetableRawCell[]; dropped: number } {
  const target = String(targetTeacherSurname ?? "").trim();
  if (!target || cells.length === 0) return { cells, dropped: 0 };
  const matches = findTeacherRows(rowLabels, target);
  if (matches.length === 0) return { cells, dropped: 0 };
  const allowed = new Set(matches.map(m => m.rowIndex));
  const kept = cells.filter(cell => allowed.has(cell.rowIndex));
  return { cells: kept, dropped: cells.length - kept.length };
}

/** Valida la risposta grezza per l'orario personale/sostegno: { rows, cells }. */
export function validatePersonalTimetablePayload(raw: unknown, targetTeacherSurname?: string): {
  rows: string[];
  cells: TimetableRawCell[];
  periodsPerDay: number;
  positionIssues: number;
  /** Celle di righe non candidate scartate dal contratto (0: nessun filtro applicato). */
  droppedForeignCells: number;
} {
  if (!record(raw)) invalidShape("Risposta analisi non valida.");
  // Righe: stesso limite dell'orario curricolare (una pagina reale di istituto può
  // superarne 60) — un limite troppo stretto qui significava analisi persa.
  if (!Array.isArray(raw.rows) || raw.rows.length > MAX_PERSONAL_GRID_ROWS) invalidShape("Righe del documento non valide.");
  // Il formato denso (una cella per colonna, vuote incluse) moltiplica le celle
  // per il numero di colonne: il vecchio limite di 500, tarato sul formato che
  // riportava solo le celle non vuote, scartava pagine reali di intero consiglio
  // di classe (25 docenti x 5 giorni x 5 ore = 625) facendo fallire l'analisi.
  if (!Array.isArray(raw.cells) || raw.cells.length > MAX_PERSONAL_GRID_CELLS) invalidShape("Celle del documento non valide.");
  // Metadato NON critico: numeri assurdi vengono ignorati dall'ancoraggio
  // (che ammette solo 1..MAX_GRID_PERIODS) invece di far fallire l'analisi.
  const declared = normalizePeriodsPerDay(raw.periodsPerDay);
  const cells = raw.cells.map((c, i) => validatePersonalRawCell(c, i));
  const rows = raw.rows.map((r, i) => normalizeRowLabel(r, i));
  // Prima si seleziona la riga (contratto "celle solo delle candidate"), POI si
  // àncora: l'ancoraggio deve vedere solo la geometria che verrà mostrata.
  const scoped = restrictPersonalCellsToTargetRows(cells, rows, targetTeacherSurname);
  // Le posizioni vengono ancorate alla griglia QUI: è l'unico punto in cui il
  // documento viene interpretato, così nessun chiamante può dimenticarlo.
  const anchored = anchorPersonalCellsToGrid(scoped.cells, declared > 0 ? declared : undefined);
  return {
    rows,
    cells: anchored.cells,
    periodsPerDay: anchored.periodsPerDay,
    positionIssues: anchored.positionIssues,
    droppedForeignCells: scoped.dropped,
  };
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
