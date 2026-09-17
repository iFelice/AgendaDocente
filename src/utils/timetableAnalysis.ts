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
import { classifyTimetableToken, extractClassesFromCell, normalizeClassLabel } from "./timetableTokens";
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
  /**
   * Motivo stabile e NON testuale del rifiuto: permette all'endpoint di scegliere
   * il messaggio per l'utente senza fare matching sul testo e senza mai rimandare
   * al client un frammento del documento.
   */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "TimetableShapeError";
    this.code = code;
  }
}

function invalidShape(message: string, code?: string): never {
  throw new TimetableShapeError(message, code);
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
    invalidShape("Riga del documento non compatibile col docente.", TEACHER_ROW_NOT_RECOGNIZED);
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

// ---------------------------------------------------------------------------
// AMBITO DELL'ANALISI CURRICOLARE: le coordinate richieste al modello
//
// La tabella d'istituto ha centinaia di celle, ma al docente di sostegno ne
// servono pochissime: solo quelle in cui È presente (giorno + periodo + classe).
// Quelle coordinate sono già calcolate dal client (`buildPersonalCoordinateScope`)
// e da qui viaggiano nella request, così il modello riceve un ELENCO di celle da
// cercare invece dell'istruzione a trascrivere l'intera griglia.
// ---------------------------------------------------------------------------

/**
 * Una coordinata richiesta all'analisi curricolare: giorno + periodo assoluto +
 * classe. È la FORMA WIRE (nessuna `key` interna) con cui il client dichiara al
 * server quali celle della tabella d'istituto servono davvero.
 */
export interface CurricularScopeCoordinate {
  dayOfWeek: number;
  periodIndex: number;
  classLabel: string;
}

/** Esito del modello su UNA coordinata richiesta: 0, 1 o più materie candidate. */
export interface CurricularTarget {
  dayOfWeek: number;
  periodIndex: number;
  classLabel: string;
  subjects: string[];
}

/**
 * Tetto delle coordinate richiedibili, legato alla geometria massima della
 * griglia: 6 giorni x `MAX_GRID_PERIODS` ore, con al più due classi per cella
 * (una cella dell'orario personale può elencare "3D 3E"). Oltre non esiste
 * richiesta legittima: meglio un 400 che un prompt chilometrico.
 */
export const MAX_CURRICULAR_SCOPE_SIZE = 6 * MAX_GRID_PERIODS * 2;
/** Tetto difensivo sulla lunghezza dell'array PRIMA della de-duplicazione. */
export const MAX_CURRICULAR_SCOPE_INPUT = MAX_CURRICULAR_SCOPE_SIZE * 4;
/** Materie massime riportate su una singola coordinata. */
export const MAX_CURRICULAR_SUBJECTS_PER_COORDINATE = 6;
/** Campi ammessi in una coordinata della request (allow-list chiusa). */
const CURRICULAR_SCOPE_COORDINATE_KEYS = ['dayOfWeek', 'periodIndex', 'classLabel'];

/**
 * Legge i tre campi di una coordinata da un oggetto: `null` se non è
 * utilizzabile.
 *
 * La classe passa dalla STESSA utility usata per leggere le celle
 * (`normalizeClassLabel`), così request, prompt e risposta non possono divergere:
 * "3 d", "3°D" e "classe 3D" diventano "3D", mentre D/P/Co, "sos" e il testo
 * libero restano `null` (una classe non si inventa).
 *
 * NON applica l'allow-list delle chiavi, quindi è riutilizzabile anche sulla
 * risposta del modello, dove la coordinata viaggia insieme a "subjects".
 */
function readCoordinateFields(value: unknown): CurricularScopeCoordinate | null {
  if (!record(value)) return null;
  // Stesso intervallo di giorno usato per le celle dell'orario (1=lunedì..6=sabato).
  if (!intWithin(value.dayOfWeek, 1, 6)) return null;
  if (!intWithin(value.periodIndex, 1, MAX_GRID_PERIODS)) return null;
  const classLabel = normalizeClassLabel(value.classLabel);
  if (!classLabel) return null;
  return { dayOfWeek: value.dayOfWeek, periodIndex: value.periodIndex, classLabel };
}

/** Normalizza UNA coordinata della request: `null` quando non è utilizzabile. */
export function normalizeCurricularScopeCoordinate(value: unknown): CurricularScopeCoordinate | null {
  if (!record(value)) return null;
  // Allow-list chiusa anche sull'elemento: la `key` interna e qualsiasi altro
  // campo non fanno parte del contratto e non vengono accettati per tolleranza.
  if (Object.keys(value).some(k => !CURRICULAR_SCOPE_COORDINATE_KEYS.includes(k))) return null;
  return readCoordinateFields(value);
}

/**
 * Valida e normalizza l'intero `coordinateScope` della request curricolare.
 *
 * `null` = scope non utilizzabile (non è un array, è vuoto, supera il tetto, o
 * contiene anche un solo elemento invalido): il server risponde 400 PRIMA di
 * chiamare Gemini. Nessun ambito parziale: una richiesta a metà chiederebbe al
 * modello celle che il client scarterebbe comunque.
 *
 * I duplicati (stessa coordinata scritta due volte, o con grafie diverse della
 * stessa classe) collassano in una sola richiesta.
 */
export function normalizeCurricularCoordinateScope(value: unknown): CurricularScopeCoordinate[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CURRICULAR_SCOPE_INPUT) return null;
  const coordinates: CurricularScopeCoordinate[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const coordinate = normalizeCurricularScopeCoordinate(item);
    if (!coordinate) return null;
    const key = coordinateKey(coordinate.dayOfWeek, coordinate.periodIndex, coordinate.classLabel);
    if (seen.has(key)) continue;
    seen.add(key);
    coordinates.push(coordinate);
  }
  return coordinates.length > 0 && coordinates.length <= MAX_CURRICULAR_SCOPE_SIZE ? coordinates : null;
}

/**
 * Forma wire dello scope: le coordinate personali già costruite dal client,
 * senza la `key` interna (dettaglio di implementazione, non dato inviato).
 */
export function curricularScopeToRequestPayload(coordinates: PersonalCoordinate[]): CurricularScopeCoordinate[] {
  return coordinates.map(({ dayOfWeek, periodIndex, classLabel }) => ({ dayOfWeek, periodIndex, classLabel }));
}

/**
 * Valida la risposta del modello sull'orario curricolare: `{ targets: [...] }`.
 *
 * Regole (mai inventare):
 *  - sopravvivono SOLO le coordinate richieste: una voce su un giorno/periodo/
 *    classe fuori elenco viene SCARTATA, mai ricollocata o "corretta";
 *  - `subjects` può essere vuoto (coordinata non leggibile o materia non
 *    determinabile), avere una materia, o averne più di una: in compresenza più
 *    docenti insistono sulla stessa classe/ora, e il crossref esistente deve
 *    poterle vedere tutte per produrre lo stato "ambiguo";
 *  - materie vuote, generiche o duplicate vengono tolte; le altre restano come
 *    scritte (nessuna normalizzazione del testo oltre al trim).
 */
export function validateCurricularTargetsPayload(raw: unknown, scope: CurricularScopeCoordinate[]): CurricularTarget[] {
  if (scope.length === 0) invalidShape("Coordinate di analisi non valide.");
  if (!record(raw) || !Array.isArray(raw.targets) || raw.targets.length > MAX_CURRICULAR_SCOPE_SIZE) {
    invalidShape("Risposta analisi non valida.");
  }
  const requested = new Set(scope.map(c => coordinateKey(c.dayOfWeek, c.periodIndex, c.classLabel)));
  const targets: CurricularTarget[] = [];
  const seen = new Set<string>();
  raw.targets.forEach((item, index) => {
    // Stessi vincoli della request (giorno, ora, classe reale) ma senza
    // allow-list delle chiavi: qui la coordinata viaggia insieme a "subjects".
    const coordinate = readCoordinateFields(item);
    if (!coordinate) invalidShape(`Coordinata non valida (#${index}).`);
    const key = coordinateKey(coordinate.dayOfWeek, coordinate.periodIndex, coordinate.classLabel);
    if (!requested.has(key)) return; // coordinata non richiesta: scartata (mai inventata)
    if (seen.has(key)) return;       // una sola voce per coordinata
    if (!Array.isArray(item.subjects) || item.subjects.length > MAX_CURRICULAR_SUBJECTS_PER_COORDINATE) {
      invalidShape(`Materie della coordinata non valide (#${index}).`);
    }
    seen.add(key);
    const subjects: string[] = [];
    for (const value of item.subjects) {
      if (!str(value, 80)) invalidShape(`Materia non valida (#${index}).`);
      const subject = value.trim();
      if (!subject || isGenericSubject(subject)) continue; // vuota/generica: non è una disciplina
      if (subjects.some(existing => sameSubject(existing, subject))) continue;
      subjects.push(subject);
    }
    targets.push({ ...coordinate, subjects });
  });
  return targets;
}

/**
 * Adatta la risposta per coordinate alla struttura `{ rows, cells }` già
 * consumata da `curricularCellsToSlots`: è il punto PIÙ STRETTO in cui il nuovo
 * output del modello entra nella pipeline esistente, quindi filtro client-side,
 * riepilogo di copertura e crossref restano esattamente quelli di prima.
 *
 * Una riga sintetica per ogni coppia (coordinata, materia), con `rowIndex`
 * progressivo e UNIVOCO: `curricularCellsToSlots` indicizza le righe per
 * `rowIndex`, quindi due materie della stessa coordinata devono stare su due
 * righe diverse per sopravvivere entrambe (e diventare "ambigue" nel crossref).
 * `rowLabel` resta vuoto: il nome del docente curricolare non serve e non viene
 * mai salvato.
 */
export function curricularTargetsToRowsAndCells(targets: CurricularTarget[]): { rows: CurricularRawRow[]; cells: TimetableRawCell[] } {
  const rows: CurricularRawRow[] = [];
  const cells: TimetableRawCell[] = [];
  let rowIndex = 0;
  for (const target of targets) {
    for (const subject of target.subjects) {
      rows.push({ rowIndex, rowLabel: "", subject, classes: [target.classLabel] });
      // La cella sintetizzata ripassa dalla stessa guardia delle celle reali:
      // giorno, periodo e testo restano dentro il contratto di TimetableRawCell.
      cells.push(validateRawCell({ rowIndex, dayOfWeek: target.dayOfWeek, periodIndex: target.periodIndex, raw: target.classLabel }, cells.length));
      rowIndex += 1;
    }
  }
  return { rows, cells };
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

/**
 * Codice del rifiuto "riga del docente non riconosciuta": è l'unico motivo di
 * rifiuto che l'utente può risolvere da solo (nome nel profilo o foto illeggibile),
 * quindi è l'unico che riceve un messaggio dedicato invece di quello generico.
 */
export const TEACHER_ROW_NOT_RECOGNIZED = "riga-docente-non-riconosciuta";

/**
 * Onorifici e titoli, dopo la piega: "Prof.ssa" diventa "prof ssa", quindi la
 * lista è di TOKEN e non di prefissi. Vanno esclusi dal confronto perché
 * compaiono sia nel profilo sia nelle etichette delle righe e non identificano
 * nessuno: una riga che dicesse solo "Prof.ssa" non deve combaciare con nulla.
 */
const HONORIFIC_TOKENS = new Set([
  "prof", "ssa", "professore", "professoressa", "professor", "profssa",
  "dott", "dottore", "dottoressa", "dottssa", "ins", "insgn", "insegnante",
  "docente", "maestro", "maestra", "ing", "arch", "dr", "avv", "sig", "sra", "sre",
]);

/** Punteggiatura innocua oltre a quella che `foldName` già trasforma in spazio. */
const EXTRA_NAME_PUNCTUATION = /[,;:/\\|()[\]{}<>+=*_~^\u00b0\u00a7#@\u20ac&%!?`]/g;

/**
 * Piega un'etichetta o un nome per il confronto: maiuscole/minuscole, accenti,
 * apostrofi e punteggiatura innocua non contano, gli spazi in eccesso collassano.
 * È `foldName` più la punteggiatura che nelle tabelle scolastiche separa i nomi
 * senza essere un trattino o un punto ("ROSSI,M.", "Bianchi L. (sostegno)").
 */
export function foldPersonLabel(raw: unknown): string {
  return foldName(raw).replace(EXTRA_NAME_PUNCTUATION, " ").replace(/\s+/g, " ").trim();
}

/**
 * Parole del nome del docente che identificano la sua riga.
 *
 * Sono TUTTE le parole e non solo l'ultima: `fullName` nel profilo è scritto
 * dall'utente e l'ordine non è garantito — "Felice Manganiello" (nome cognome) e
 * "Rossi Matteo" (cognome nome, la forma dei registri e dei seed dell'app) sono
 * entrambi legittimi. Prendere solo l'ultima parola significava cercare "matteo"
 * per il profilo "Rossi Matteo": nelle tabelle la riga è "ROSSI M.", quindi la
 * parola cercata non c'era e l'analisi veniva rifiutata anche quando il modello
 * aveva letto la riga giusta.
 *
 * Restano escluse le iniziali singole (non identificano nessuno) e le parole che
 * non sono lettere: un `fullName` ostile non può inserire marcatori, perché ogni
 * token accettato è `/^[a-z]{2,}$/`.
 */
export function teacherNameTokens(fullName: unknown): string[] {
  const words = foldPersonLabel(fullName).split(" ").filter(Boolean);
  return Array.from(new Set(words.filter((word) => /^[a-z]{2,}$/.test(word) && !HONORIFIC_TOKENS.has(word))));
}

export interface TeacherRowMatch {
  rowIndex: number;
  rowLabel: string;
}

/**
 * Trova le righe della tabella compatibili con il docente del profilo.
 *
 * Regole conservative:
 *  - il confronto è a PAROLE INTERE: "Bianchi" non combacia mai con
 *    "Bianchini", né "Manganiell" con "Manganiello";
 *  - maiuscole/minuscole, spazi in testa o in coda, accenti, apostrofi e
 *    punteggiatura innocua non contano (`foldPersonLabel`);
 *  - onorifici e titoli ("Prof.", "Prof.ssa", "Docente") sono ignorati da
 *    entrambe le parti: non possono né aiutare né impedire il match;
 *  - l'etichetta può riportare solo il cognome, "COGNOME N." oppure nome e
 *    cognome per esteso: basta una parola del nome del profilo;
 *  - un nome DIVERSO resta escluso: senza parole in comune non c'è match;
 *  - se più righe sono compatibili vengono tutte restituite: la scelta
 *    definitiva spetta sempre all'utente (niente auto-selezione);
 *  - se nessuna riga è compatibile, la lista resta vuota.
 */
export function findTeacherRows(rowLabels: string[], profileName: unknown): TeacherRowMatch[] {
  const tokens = teacherNameTokens(profileName);
  if (!tokens.length) return [];
  const matches: TeacherRowMatch[] = [];
  rowLabels.forEach((label, rowIndex) => {
    const words = foldPersonLabel(label).split(" ").filter(Boolean);
    if (tokens.some(token => words.includes(token))) matches.push({ rowIndex, rowLabel: label });
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
