import type { CalendarEvent, EventCategory, ExtractedItem } from "../types";
import { formatCivilDateIt, isValidDate } from "./dates";
import { isRelevanceReasonText } from "./circularRelevance";

/** Categorie specifiche per le quali un disallineamento indica attività distinte. */
const SPECIFIC_CATEGORIES = new Set<EventCategory>([
  "collegio_docenti",
  "consiglio_classe",
  "dipartimento",
  "dipartimento_sostegno",
  "glo",
  "pei",
  "lezione",
  "ricevimento_genitori",
  "formazione",
  "uscita_didattica",
]);

/**
 * Normalizza il titolo per il confronto deterministico:
 * - lowercase
 * - rimozione diacritici Unicode (NFD)
 * - rimozione prefissi documentali estranei all'identità ("circolare n. ...", "convocazione", "oggetto", "avviso")
 * - rimozione punteggiatura
 * - rimozione articoli e preposizioni semplici non distintive
 * - normalizzazione spazi
 */
export function normalizeEventTitle(raw: string): string {
  if (!raw) return "";

  let title = raw.toLowerCase().trim();

  // Rimozione accenti / diacritici
  title = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Rimozione prefissi documentali (es. "Circolare n. 45 - ", "Oggetto: ", "Convocazione ")
  title = title.replace(/^circolare\s+(n\.?|num\.?|numero)?\s*\d+([/-]\d+)?\s*[-:–—]?\s*/i, "");
  title = title.replace(/^(convocazione|oggetto|avviso)\s*[:\-–—]?\s*/i, "");
  title = title.replace(/^(del|della|dello|dei|degli|delle)\s+/i, "");

  // Sostituzione punteggiatura con spazio
  title = title.replace(/[.,;:_'"()\[\]{}!?\/\\#\-–—+]/g, " ");

  // Normalizzazione abbreviazioni scolastiche comuni
  title = title.replace(/\bcdc\b/g, "consiglio classe");

  // Divisione in token e filtro stop-words / articoli / preposizioni semplici
  const STOP_WORDS = new Set([
    "il", "lo", "la", "i", "gli", "le", "l",
    "un", "uno", "una",
    "di", "del", "dello", "della", "dei", "degli", "delle", "d",
    "a", "al", "allo", "alla", "ai", "agli", "alle",
    "da", "dal", "dallo", "dalla", "dai", "dagli", "dalle",
    "in", "nel", "nello", "nella", "nei", "negli", "nelle",
    "su", "sul", "sullo", "sulla", "sui", "sugli", "sulle",
    "con", "per", "tra", "fra",
  ]);

  const tokens = title
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 0 && !STOP_WORDS.has(t));

  return tokens.join(" ");
}

/**
 * Verifica se due categorie sono compatibili per un aggiornamento.
 * Due categorie specifiche differenti (es. "lezione" vs "collegio_docenti")
 * non sono mai compatibili.
 */
export function areCategoriesCompatible(catA?: EventCategory, catB?: EventCategory): boolean {
  if (!catA || !catB) return true;
  if (catA === catB) return true;

  const isSpecificA = SPECIFIC_CATEGORIES.has(catA);
  const isSpecificB = SPECIFIC_CATEGORIES.has(catB);

  // Se entrambe sono specifiche e differenti, sono incompatibili
  if (isSpecificA && isSpecificB) {
    // Eccezione: dipartimento e dipartimento_sostegno possono essere compatibili
    if (
      (catA === "dipartimento" && catB === "dipartimento_sostegno") ||
      (catA === "dipartimento_sostegno" && catB === "dipartimento")
    ) {
      return true;
    }
    return false;
  }

  return true;
}

/**
 * Sigla di classe in un testo libero: cifra dell'anno (1-5), eventuale decorazione
 * ("^", "°", "ª") o spazio, lettera della sezione. Unica fonte per TUTTA
 * l'estrazione di classi (singola e multipla), così le due letture non divergono.
 * La lettera non può essere seguita da altre lettere o cifre: "1Cat" non è "1C".
 */
const CLASS_TEXT_RE = /\b([1-5])(?:\s*[\^°ª]\s*|\s+|\s*)([A-Za-z])(?![A-Za-z0-9])/gi;

/**
 * Tutte le classi scritte in un testo, normalizzate in "1C" e nell'ordine in cui
 * compaiono, senza duplicati. Riconosce "1C", "1 C", "1^C", "1ªC", "1° C",
 * "classe 1 C" e gli elenchi ("1C, 1N" -> ["1C", "1N"]).
 */
export function extractClassTokensFromText(text?: string | null): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const match of text.matchAll(CLASS_TEXT_RE)) {
    const sigla = `${match[1]}${match[2].toUpperCase()}`;
    if (!found.includes(sigla)) found.push(sigla);
  }
  return found;
}

/** Estrae una possibile classe (es. "1A", "3D", "5B") da una stringa. */
export function extractClassToken(text: string): string | null {
  return extractClassTokensFromText(text)[0] ?? null;
}

/**
 * Classi di un impegno: quelle dichiarate nei campi classe (un campo può contenere
 * un elenco: "1C, 1N") più quelle scritte nel titolo. Insieme, perché un impegno
 * importato da Google non ha mai `className`: la classe c'è solo se il titolo la dice.
 */
export function getEventClassTokens(event: {
  title?: string | null;
  className?: string | null;
  /** Elenco di classi in un campo diverso da `className` (es. "classi" di una circolare). */
  classi?: string | null;
}): string[] {
  const found: string[] = [];
  for (const source of [event.className, event.classi, event.title]) {
    for (const sigla of extractClassTokensFromText(source)) {
      if (!found.includes(sigla)) found.push(sigla);
    }
  }
  return found;
}

/**
 * Verifica se le classi associate a due eventi sono compatibili.
 * Se entrambe specificano una classe diversa (es. "1A" vs "2A"), sono incompatibili.
 */
export function areClassesCompatible(
  classA?: string,
  classB?: string,
  titleA?: string,
  titleB?: string
): boolean {
  const normA = (classA || extractClassToken(titleA || ""))?.toUpperCase().replace(/[\sª]/g, "");
  const normB = (classB || extractClassToken(titleB || ""))?.toUpperCase().replace(/[\sª]/g, "");

  if (normA && normB && normA !== normB) {
    return false;
  }
  return true;
}

/**
 * Sigla di classe già normalizzata (es. "3d", "1c", "1n").
 * Non è una parola da confrontare: della classe si occupa `areClassesCompatible`.
 */
const CLASS_TOKEN_RE = /^[1-5]ª?[a-z]$/;

/**
 * Radice di una parola: alle parole di almeno 5 lettere si tolgono le vocali
 * finali, così singolare/plurale e maschile/femminile coincidono
 * (consiglio/consigli, classe/classi, colloquio/colloqui,
 * dipartimento/dipartimenti, scrutinio/scrutini, docente/docenti).
 * Le parole più corte e i token con cifre restano invariati.
 */
export function titleWordStem(word: string): string {
  if (word.length < 5) return word;
  if (/\d/.test(word)) return word;
  const stem = word.replace(/[aeiou]+$/, "");
  return stem.length > 0 ? stem : word;
}

/**
 * Parole significative di un titolo, pronte per il confronto:
 * normalizzate, senza le sigle di classe, ridotte alla radice.
 */
export function significantTitleWords(raw: string): string[] {
  const normalized = normalizeEventTitle(raw);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !CLASS_TOKEN_RE.test(t))
    .map(titleWordStem);
}

/**
 * Confronta due titoli per verificare se identificano lo stesso evento,
 * confrontando gli INSIEMI di parole significative (non le sottostringhe):
 * - insiemi uguali;
 * - oppure tutte le parole del titolo più corto presenti nel più lungo,
 *   con almeno 2 parole significative per lato.
 *
 * Le sigle di classe ("3D", "1C", "1N") non entrano nel confronto: la
 * compatibilità delle classi resta affidata ad `areClassesCompatible`.
 */
export function isTitleMatch(rawA: string, rawB: string): boolean {
  const wordsA = new Set(significantTitleWords(rawA));
  const wordsB = new Set(significantTitleWords(rawB));

  if (wordsA.size === 0 || wordsB.size === 0) return false;

  const contains = (subset: Set<string>, superset: Set<string>) =>
    [...subset].every((w) => superset.has(w));

  // Insiemi di parole identici
  if (wordsA.size === wordsB.size && contains(wordsA, wordsB)) return true;

  // Tutte le parole del titolo più corto compaiono nel più lungo
  if (wordsA.size >= 2 && wordsB.size >= 2) {
    const shorter = wordsA.size <= wordsB.size ? wordsA : wordsB;
    const longer = shorter === wordsA ? wordsB : wordsA;
    if (contains(shorter, longer)) return true;
  }

  return false;
}

/** Minuti trascorsi dalla mezzanotte; null se l'orario manca o non è valido. */
export function timeToMinutes(time?: string | null): number | null {
  if (!time) return null;
  const parsed = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (!parsed) return null;
  const hours = Number(parsed[1]);
  const minutes = Number(parsed[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Orario scritto dentro un titolo, già normalizzato in "HH:MM". */
export interface TitleTimes {
  start?: string;
  end?: string;
}

/**
 * Orario completo in un titolo: "16:30" o "16.30". I due punti (o il punto) sono
 * obbligatori: è quello che distingue un orario da una data ("13/10" non ne ha).
 * - `(?<![\d:])` esclude i pezzi finali di un numero lungo o di un orario con i secondi;
 * - `(?!\d)` esclude che i minuti siano troncati ("16.305" non è un orario).
 */
const FULL_TIME_IN_TITLE_RE = /(?<![\d:])(\d{1,2})[.:](\d{2})(?!\d)/g;

/** Ora sola, priva di minuti: credibile SOLO dopo "ore", "dalle", "alle" (o "ora"). */
const BARE_HOUR_IN_TITLE_RE = /(?:\bore|\bora|\bdalle|\balle)\s+(\d{1,2})\b(?!\s*[.:]\s*\d)/g;

/**
 * Testo ammesso fra due orari dello stesso titolo: un trattino, una barra, una
 * virgola o le congiunzioni usate a scuola ("dalle 16 alle 17", "16:30-17:15",
 * "16:30 e 17:15"). Un testo più lungo ("e recupero") NON è un intervallo, e
 * "ore" non lo è nemmeno: separa un orario dalla data che lo precede.
 */
function isTitleTimeRangeGap(gap: string): boolean {
  const cleaned = gap.toLowerCase().replace(/[^a-z]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return true;
  return /^(?:e|ed|ad|alle|dalle)(?:\s+(?:e|ed|ad|alle|dalle))*$/.test(cleaned);
}

const padTime = (value: number): string => String(value).padStart(2, "0");

/**
 * Orari scritti nel titolo di un impegno: "Consiglio 1 C del 13 Ottobre ore
 * 16:30/17:15", "dalle 16.30 alle 17.15", "ore 16:30 alle 17:15", "16:30-17:15".
 *
 * Restituisce al massimo una coppia (inizio, fine) in "HH:MM": il primo orario del
 * titolo e, se legato da un separatore da intervallo, il secondo. Date ("13/10"),
 * sigle di classe ("1C") e numeri isolati non producono alcun orario; un'ora senza
 * minuti è ammessa solo dopo "ore"/"dalle"/"alle".
 */
export function extractTimesFromTitle(title?: string | null): TitleTimes {
  if (!title) return {};
  const text = String(title);

  interface TimeToken {
    from: number;
    to: number;
    hours: number;
    minutes: number;
    /** Preceduto da "ore"/"dalle"/"alle": è l'unico che dichiara davvero un orario. */
    anchored: boolean;
  }
  const valid = (hours: number, minutes: number): boolean =>
    Number.isInteger(hours) && Number.isInteger(minutes) && hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;

  const found: TimeToken[] = [];
  for (const match of text.matchAll(FULL_TIME_IN_TITLE_RE)) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!valid(hours, minutes)) continue;
    const from = match.index ?? 0;
    found.push({ from, to: from + match[0].length, hours, minutes, anchored: false });
  }
  for (const match of text.matchAll(BARE_HOUR_IN_TITLE_RE)) {
    const hours = Number(match[1]);
    if (!Number.isInteger(hours) || hours < 0 || hours > 23) continue;
    const from = (match.index ?? 0) + match[0].lastIndexOf(match[1]);
    if (found.some((token) => from >= token.from && from < token.to)) continue;
    found.push({ from, to: from + match[1].length, hours, minutes: 0, anchored: true });
  }
  found.sort((a, b) => a.from - b.from);
  if (found.length === 0) return {};

  const format = (token: TimeToken): string => `${padTime(token.hours)}:${padTime(token.minutes)}`;

  // La coppia è l'intervallo dichiarato dal titolo: la prima adiacente legata da
  // un separatore da intervallo ("16:30/17:15", "dalle 16 alle 17").
  for (let index = 0; index + 1 < found.length; index++) {
    const from = found[index];
    const to = found[index + 1];
    if (isTitleTimeRangeGap(text.slice(from.to, to.from))) {
      return { start: format(from), end: format(to) };
    }
  }

  // Nessun intervallo: un orario solo, dando la precedenza a uno annunciato da
  // "ore"/"dalle"/"alle" (in un titolo la data può essere scritta come "13.10").
  const single = found.find((token) => token.anchored) ?? found[0];
  return { start: format(single) };
}

/** Intervallo orario di un impegno, o null se non è confrontabile sugli orari. */
interface TimeWindow {
  start: number;
  /** null = impegno senza orario di fine. */
  end: number | null;
}

/**
 * Finestra oraria di un impegno. Resta null (quindi fuori dal confronto sugli
 * orari) per gli impegni tutto il giorno e per quelli senza orario di inizio.
 */
function timeWindowOf(event: {
  startTime?: string | null;
  endTime?: string | null;
  isAllDay?: boolean | null;
}): TimeWindow | null {
  if (event.isAllDay) return null;
  const start = timeToMinutes(event.startTime);
  if (start === null) return null;
  return { start, end: timeToMinutes(event.endTime) };
}

/** Scadenze: categoria "scadenza" sugli eventi in agenda, flag dedicato sugli elementi estratti. */
function isDeadlineLike(item: { category?: EventCategory; isDeadline?: boolean }): boolean {
  return item.category === "scadenza" || item.isDeadline === true;
}

/**
 * Le lezioni dell'orario sono CalendarEvent con categoria "lezione": non
 * entrano nel confronto sugli orari (un impegno da circolare che cade su
 * un'ora di lezione non è un doppione).
 */
function isLessonLike(item: { category?: EventCategory }): boolean {
  return item.category === "lezione";
}

/**
 * Due finestre si sovrappongono quando si intersecano davvero:
 * gli orari contigui (15:00–15:45 e 15:45–16:30) NON si sovrappongono.
 * Se un lato ha solo l'inizio, vale l'uguaglianza dell'inizio oppure
 * l'inizio compreso nell'intervallo dell'altro.
 */
function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  if (a.end !== null && b.end !== null) return a.start < b.end && b.start < a.end;
  if (a.end === null && b.end === null) return a.start === b.start;
  if (a.end === null) return b.start <= a.start && a.start < (b.end as number);
  // L'evento in agenda è un istante: basta che cada dentro l'intervallo del nuovo.
  return a.start <= b.start && b.start < (a.end as number);
}

/** Minuti di sovrapposizione fra due finestre (0 se non si sovrappongono). */
function overlapMinutes(a: TimeWindow, b: TimeWindow): number {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end ?? a.start, b.end ?? b.start);
  return Math.max(0, end - start);
}

export interface EventFieldDiff {
  title: boolean;
  date: boolean;
  deadlineDate: boolean;
  startTime: boolean;
  endTime: boolean;
  isAllDay: boolean;
  location: boolean;
  notes: boolean;
  category: boolean;
  className: boolean;
  subject: boolean;
  completed: boolean;
}

type EventDifferenceCandidate = Pick<
  ExtractedItem,
  | "title" | "date" | "deadlineDate" | "isDeadline" | "startTime" | "endTime"
  | "location" | "notes" | "category" | "className" | "subject"
>;

const cleanEventField = (value?: string) => (value ?? "").trim();
/** Confronto insensibile a maiuscole/minuscole e spazi ripetuti. */
const foldEventField = (value?: string) => cleanEventField(value).toLowerCase().replace(/\s+/g, " ");

/** Un campo testuale usato con `candidate || existing` cambia solo se il nuovo è valorizzato. */
function providedTextDiffers(existing?: string, candidate?: string): boolean {
  const next = cleanEventField(candidate);
  return next.length > 0 && foldEventField(existing) !== foldEventField(next);
}

/**
 * Campi testuali che "Aggiorna" assegna con fallback (`nuovo || esistente`) e che
 * condividono la regola "non riscrivere un testo già presente in un altro campo":
 * luogo, note e classe.
 */
const FALLBACK_TEXT_FIELDS = ["location", "notes", "className"] as const;

/** Uno dei campi testuali con fallback soggetti alle regole A e B (luogo, note, classe). */
export type FallbackTextField = (typeof FALLBACK_TEXT_FIELDS)[number];

/**
 * B: le note di un impegno PROVENIENTE DA CIRCOLARE riconosciute come motivo di
 * pertinenza (salvate dalle vecchie importazioni) valgono come vuote: non
 * producono una differenza "Note" e non contano come testo già presente per gli
 * altri campi. Le note scritte dall'utente (non riconosciute da
 * `isRelevanceReasonText`) e gli impegni non da circolare restano note normali.
 */
function hasRelevanceReasonNotes(existing: CalendarEvent): boolean {
  if (existing.sourceType !== "circolare") return false;
  const notes = cleanEventField(existing.notes);
  return notes.length > 0 && isRelevanceReasonText(notes);
}

/** Valore esistente di un campo con fallback usato nei confronti (B: note-motivo come vuote). */
function comparableExistingField(existing: CalendarEvent, field: FallbackTextField): string {
  if (field === "notes" && hasRelevanceReasonNotes(existing)) return "";
  return cleanEventField(existing[field]);
}

/**
 * A: il testo che "Aggiorna" scriverebbe in un campo è già contenuto in un ALTRO
 * campo fra luogo, note e classe dell'impegno esistente (confronto senza
 * maiuscole/minuscole e spazi ripetuti).
 */
function isTextAlreadyInOtherField(
  existing: CalendarEvent,
  field: FallbackTextField,
  candidateValue?: string
): boolean {
  const folded = foldEventField(candidateValue);
  if (!folded) return false;
  return FALLBACK_TEXT_FIELDS.some(
    (other) => other !== field && foldEventField(comparableExistingField(existing, other)) === folded
  );
}

/**
 * Regola UNICA con cui "Aggiorna" tratta luogo, note e classe, condivisa
 * dall'elenco delle differenze e dall'applicazione dell'importazione:
 * - nuovo valore vuoto -> il campo esistente non cambia;
 * - A: nuovo valore già presente in un altro di questi campi -> non viene scritto;
 * - B: note esistenti riconosciute come motivo di pertinenza -> mai una
 *   differenza "Note" (valgono come vuote);
 * - altrimenti il campo cambia se il nuovo valore differisce dall'esistente.
 */
function fallbackFieldDiffers(existing: CalendarEvent, field: FallbackTextField, candidateValue?: string): boolean {
  const next = cleanEventField(candidateValue);
  if (!next) return false;
  if (field === "notes" && hasRelevanceReasonNotes(existing)) return false;
  if (isTextAlreadyInOtherField(existing, field, next)) return false;
  return foldEventField(comparableExistingField(existing, field)) !== foldEventField(next);
}

/**
 * Valore che "Aggiorna" scrive DAVVERO in luogo, note o classe: la stessa regola
 * dell'elenco delle differenze, definita una volta sola. Il nuovo valore viene
 * scritto solo se non vuoto e non già presente in un altro di questi campi (A);
 * altrimenti resta il valore esistente. Per le note che valgono come vuote (B)
 * il nuovo valore sostituisce il motivo di pertinenza quando c'è, e il motivo
 * resta dov'è quando il nuovo valore è vuoto.
 */
export function resolveUpdatedField(
  existing: CalendarEvent,
  field: FallbackTextField,
  candidateValue?: string
): string | undefined {
  const next = cleanEventField(candidateValue);
  if (next && !isTextAlreadyInOtherField(existing, field, next)) return candidateValue;
  return existing[field];
}

/**
 * Calcola le differenze che `handleConfirmImport` produrrebbe davvero con
 * "Aggiorna": orario/data/titolo/categoria e scadenza vengono assegnati; luogo,
 * note, classe e materia conservano il valore esistente se il nuovo è vuoto,
 * mentre un evento completato viene riattivato.
 *
 * Luogo, note e classe seguono la regola unica di `resolveUpdatedField`:
 * un testo già presente in un altro di questi campi non viene scritto (A) e le
 * note da circolare riconosciute come motivo di pertinenza valgono come vuote
 * (B), quindi nessuna differenza "Note" per quei campi.
 */
export function getEventFieldDiff(existing: CalendarEvent, candidate: EventDifferenceCandidate): EventFieldDiff {
  const candidateDeadline = candidate.deadlineDate || (candidate.isDeadline === true ? candidate.date : undefined);
  const candidateAllDay = !candidate.startTime && !candidate.endTime;

  return {
    title: cleanEventField(existing.title) !== cleanEventField(candidate.title)
      && !isTitleMatch(existing.title ?? "", candidate.title ?? ""),
    date: cleanEventField(existing.date) !== cleanEventField(candidate.date),
    deadlineDate: cleanEventField(existing.deadlineDate) !== cleanEventField(candidateDeadline),
    startTime: cleanEventField(existing.startTime) !== cleanEventField(candidate.startTime),
    endTime: cleanEventField(existing.endTime) !== cleanEventField(candidate.endTime),
    isAllDay: !!existing.isAllDay !== candidateAllDay,
    location: fallbackFieldDiffers(existing, "location", candidate.location),
    notes: fallbackFieldDiffers(existing, "notes", candidate.notes),
    category: existing.category !== candidate.category
      && SPECIFIC_CATEGORIES.has(existing.category)
      && SPECIFIC_CATEGORIES.has(candidate.category),
    className: fallbackFieldDiffers(existing, "className", candidate.className),
    subject: providedTextDiffers(existing.subject, candidate.subject),
    // L'azione "Aggiorna" riattiva sempre un evento completato.
    completed: existing.completed === true,
  };
}

/** Valore assente in una riga di differenza (campo vuoto da un lato). */
const EMPTY_FIELD = "—";

/** Etichetta breve di un campo che differisce fra agenda e circolare. */
export interface EventFieldDifference {
  /** Chiave tecnica del campo confrontato ("time" accorpa inizio/fine e tutto-il-giorno). */
  field: "title" | "date" | "deadlineDate" | "time" | "location" | "notes" | "category" | "className" | "subject" | "completed";
  /** Etichetta mostrata a schermo ("Orario", "Luogo", …). */
  label: string;
  /** Valore già in agenda, oppure "—" se assente. */
  from: string;
  /** Valore della riga della circolare, oppure "—" se assente. */
  to: string;
}

/** Intervallo orario leggibile, un solo estremo, assenza o "Tutto il giorno". */
function timeRangeLabel(start?: string | null, end?: string | null, isAllDay = false): string {
  if (isAllDay) return "Tutto il giorno";
  const from = (start ?? "").trim();
  const to = (end ?? "").trim();
  if (!from && !to) return EMPTY_FIELD;
  if (from && to) return `${from}–${to}`;
  return from || to;
}

/** Data civile in formato italiano; stringa non valida o assente -> "—". */
function dateLabel(iso?: string | null): string {
  const clean = (iso ?? "").trim();
  if (!clean) return EMPTY_FIELD;
  return isValidDate(clean) ? formatCivilDateIt(clean) : clean;
}

/** Categoria leggibile ("collegio_docenti" -> "collegio docenti"). */
function categoryLabel(category?: EventCategory): string {
  return (category ?? "").replace(/_/g, " ") || EMPTY_FIELD;
}

/**
 * Solo le differenze effettive dell'azione "Aggiorna".
 * I campi testuali aggiornati con fallback (`nuovo || esistente`) non mostrano
 * una rimozione quando il nuovo valore è vuoto; luogo, note e classe seguono la
 * regola unica di `resolveUpdatedField` (A: testo già presente in un altro di
 * quei campi non scritto; B: note da circolare che sono un motivo di pertinenza
 * valgono come vuote); le categorie sono confrontate solo se entrambe
 * specifiche; un completato riattivato è mostrato come Stato.
 * Inizio/fine e stato tutto-il-giorno hanno una sola riga Orario.
 */
export function describeEventDifferences(existing: CalendarEvent, candidate: EventDifferenceCandidate): EventFieldDifference[] {
  const diff = getEventFieldDiff(existing, candidate);
  const candidateDeadline = candidate.deadlineDate || (candidate.isDeadline === true ? candidate.date : undefined);
  const candidateAllDay = !candidate.startTime && !candidate.endTime;
  const differences: EventFieldDifference[] = [];

  if (diff.startTime || diff.endTime || diff.isAllDay) {
    differences.push({
      field: "time",
      label: "Orario",
      from: timeRangeLabel(existing.startTime, existing.endTime, existing.isAllDay),
      to: timeRangeLabel(candidate.startTime, candidate.endTime, candidateAllDay),
    });
  }
  if (diff.date) {
    differences.push({ field: "date", label: "Data", from: dateLabel(existing.date), to: dateLabel(candidate.date) });
  }
  if (diff.location) {
    differences.push({
      field: "location",
      label: "Luogo",
      from: cleanEventField(existing.location) || EMPTY_FIELD,
      to: cleanEventField(candidate.location) || EMPTY_FIELD,
    });
  }
  if (diff.title) {
    differences.push({
      field: "title",
      label: "Titolo",
      from: cleanEventField(existing.title) || EMPTY_FIELD,
      to: cleanEventField(candidate.title) || EMPTY_FIELD,
    });
  }
  if (diff.className) {
    differences.push({
      field: "className",
      label: "Classe",
      from: cleanEventField(existing.className) || EMPTY_FIELD,
      to: cleanEventField(candidate.className) || EMPTY_FIELD,
    });
  }
  if (diff.subject) {
    differences.push({
      field: "subject",
      label: "Materia",
      from: cleanEventField(existing.subject) || EMPTY_FIELD,
      to: cleanEventField(candidate.subject) || EMPTY_FIELD,
    });
  }
  if (diff.category) {
    differences.push({
      field: "category",
      label: "Categoria",
      from: categoryLabel(existing.category),
      to: categoryLabel(candidate.category),
    });
  }
  if (diff.completed) {
    differences.push({ field: "completed", label: "Stato", from: "Completato", to: "Da fare" });
  }
  if (diff.deadlineDate) {
    differences.push({
      field: "deadlineDate",
      label: "Scadenza",
      from: dateLabel(existing.deadlineDate),
      to: dateLabel(candidateDeadline),
    });
  }
  if (diff.notes) {
    differences.push({
      field: "notes",
      label: "Note",
      from: cleanEventField(existing.notes) || EMPTY_FIELD,
      to: cleanEventField(candidate.notes) || EMPTY_FIELD,
    });
  }

  return differences;
}

/**
 * Un conflitto per titolo è identico esattamente quando la stessa lista delle
 * differenze mostrata all'utente è vuota: UI, preselezione "Salta" e blocco
 * import condividono quindi un'unica definizione.
 */
export function isIdenticalEventUpdate(existing: CalendarEvent, candidate: EventDifferenceCandidate): boolean {
  return describeEventDifferences(existing, candidate).length === 0;
}

/**
 * Tipo di riconoscimento: per titolo (possibile aggiornamento) o per orario.
 * `"affinita"` è prodotto solo da `findAffinityMatch` e vale solo come SUGGERIMENTO
 * di doppione: non aggiorna e non fonde nulla (vedi i vincoli in `findAffinityMatch`).
 */
export type EventMatchKind = "titolo" | "orario" | "sovrapposizione" | "affinita";

export interface EventMatchResult {
  /** Impegno già in agenda riconosciuto. */
  event: CalendarEvent;
  /** Criterio che lo ha riconosciuto: il titolo ha la precedenza sull'orario. */
  kind: EventMatchKind;
  /** Altri impegni trovati dallo stesso criterio ("orario" e "sovrapposizione"): quanti ne restano fuori. */
  others: number;
}

/** Elemento estratto nella parte che serve al riconoscimento. */
export type EventMatchCandidate = Pick<ExtractedItem, "title" | "date" | "category" | "className"> &
  Partial<Pick<ExtractedItem, "startTime" | "endTime" | "isDeadline">> & { isAllDay?: boolean };

/**
 * Fra più candidati per TITOLO sceglie quello con lo stesso inizio+fine del
 * nuovo, altrimenti quello con lo stesso inizio. Se restano più candidati
 * (o il nuovo non ha un orario di inizio per spartire), nessuna associazione.
 */
function disambiguateTitleMatches(
  matches: CalendarEvent[],
  candidate: EventMatchCandidate
): CalendarEvent | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const candidateStart = timeToMinutes(candidate.startTime);
  if (candidateStart === null) return null; // senza orario non c'è spareggio possibile
  const candidateEnd = timeToMinutes(candidate.endTime);

  const sameBoth = matches.filter(
    (e) => timeToMinutes(e.startTime) === candidateStart && timeToMinutes(e.endTime) === candidateEnd
  );
  if (sameBoth.length === 1) return sameBoth[0];
  if (sameBoth.length > 1) return null;

  const sameStart = matches.filter((e) => timeToMinutes(e.startTime) === candidateStart);
  if (sameStart.length === 1) return sameStart[0];

  return null;
}

/**
 * Riconosce un impegno già in agenda che potrebbe corrispondere all'elemento
 * estratto dalla circolare, così da non creare un doppione.
 *
 * Criteri, in ordine di precedenza:
 *
 * 1. TITOLO (stessa data obbligatoria, categorie e classi compatibili, titolo
 *    corrispondente parola per parola): è un possibile aggiornamento.
 * 2. ORARIO (stessa data, intervalli sovrapposti, categorie e classi compatibili): possibile stesso
 *    impegno con un nome diverso. Fuori dal confronto: lezioni, scadenze,
 *    impegni tutto il giorno o senza orario (su entrambi i lati).
 *
 * 3. SOVRAPPOSIZIONE: stessi vincoli temporali ed esclusioni del criterio orario,
 *    ma qualsiasi categoria e classe. Impegni distinti, mai da aggiornare.
 *
 * In caso di più candidati lo spareggio è sugli orari (stesso inizio+fine,
 * poi stesso inizio, poi sovrapposizione più lunga); se resta ambiguità il
 * criterio del titolo non associa nulla, quello dell'orario segnala anche
 * quanti altri impegni restano ("altri N alla stessa ora").
 */
export function findEventMatch(
  candidate: EventMatchCandidate,
  existingEvents: CalendarEvent[] | undefined | null
): EventMatchResult | null {
  if (!existingEvents || existingEvents.length === 0) return null;
  if (!candidate.date || !candidate.title) return null;

  // La data è obbligatoria per tutti i criteri.
  const sameDay = existingEvents.filter((existing) => existing.date === candidate.date);
  if (sameDay.length === 0) return null;

  // 1. Criterio del titolo: possibile aggiornamento di un impegno esistente.
  const titleMatches = sameDay.filter((existing) => {
    if (!areCategoriesCompatible(candidate.category, existing.category)) return false;
    if (!areClassesCompatible(candidate.className, existing.className, candidate.title, existing.title)) {
      return false;
    }
    return isTitleMatch(candidate.title, existing.title);
  });

  const byTitle = disambiguateTitleMatches(titleMatches, candidate);
  if (byTitle) return { event: byTitle, kind: "titolo", others: 0 };

  // 2. Criterio dell'orario: stesso giorno, intervalli sovrapposti.
  if (isDeadlineLike(candidate) || isLessonLike(candidate)) return null;
  const candidateWindow = timeWindowOf(candidate);
  if (!candidateWindow) return null;

  const allOverlapping = sameDay
    .filter((existing) => !isDeadlineLike(existing) && !isLessonLike(existing))
    .map((existing) => ({ existing, window: timeWindowOf(existing) }))
    .filter((entry): entry is { existing: CalendarEvent; window: TimeWindow } => entry.window !== null)
    .filter((entry) => windowsOverlap(candidateWindow, entry.window));

  const compatible = allOverlapping.filter(({ existing }) =>
    areCategoriesCompatible(candidate.category, existing.category) &&
    areClassesCompatible(candidate.className, existing.className, candidate.title, existing.title)
  );
  // 3. Se non è un possibile doppione, segnala comunque il conflitto del docente.
  const kind: EventMatchKind = compatible.length > 0 ? "orario" : "sovrapposizione";
  const overlapping = compatible.length > 0 ? compatible : allOverlapping;
  if (overlapping.length === 0) return null;

  // Spareggio: stesso inizio+fine, poi stesso inizio, poi sovrapposizione più lunga.
  const candidateStart = candidateWindow.start;
  const candidateEnd = candidateWindow.end;
  const sameBoth = overlapping.filter(
    (entry) => entry.window.start === candidateStart && entry.window.end === candidateEnd
  );
  const sameStart = overlapping.filter((entry) => entry.window.start === candidateStart);
  const pool = sameBoth.length > 0 ? sameBoth : sameStart.length > 0 ? sameStart : overlapping;

  let best = pool[0];
  let bestOverlap = overlapMinutes(candidateWindow, best.window);
  for (const entry of pool.slice(1)) {
    const minutes = overlapMinutes(candidateWindow, entry.window);
    if (minutes > bestOverlap) {
      best = entry;
      bestOverlap = minutes;
    }
  }

  return { event: best.existing, kind, others: overlapping.length - 1 };
}

/** Minuti massimi di distanza fra due impegni affini perché contino come vicini. */
const AFFINITY_MAX_GAP_MINUTES = 60;

/**
 * Parole che annunciano una riunione collegiale. Si confrontano per RADICE con
 * `titleWordStem` (già usata dal confronto dei titoli), così
 * "consiglio/consigli", "colloquio/colloqui", "dipartimento/dipartimenti",
 * "scrutinio/scrutini" e "assemblea/assemblee" coincidono.
 */
const MEETING_KEYWORD_STEMS: ReadonlySet<string> = new Set(
  [
    "consiglio", "collegio", "dipartimento", "scrutinio", "glo", "gli",
    "colloqui", "ricevimento", "riunione", "incontro", "assemblea",
  ].map(titleWordStem)
);

/**
 * Parole di un testo ridotte alla radice, per cercare le parole "di riunione".
 * Qui NON si usa `normalizeEventTitle`: gli articoli si tolgono lì, ma "GLI"
 * (Gruppi di Lavoro per l'Inclusione) è anche un articolo e sparirebbe.
 */
function meetingWordsOf(text?: string | null): string[] {
  if (!text) return [];
  const folded = String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bcdc\b/g, "consiglio classe");
  return folded
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !CLASS_TOKEN_RE.test(word))
    .map(titleWordStem);
}

/**
 * Vera se i due testi condividono almeno una parola che annuncia una riunione
 * (consiglio, collegio, dipartimento, scrutinio, GLO, GLI, colloqui,
 * ricevimento, riunione, incontro, assemblea).
 */
export function sharesMeetingKeyword(textA?: string | null, textB?: string | null): boolean {
  const stems = new Set(meetingWordsOf(textA).filter((word) => MEETING_KEYWORD_STEMS.has(word)));
  if (stems.size === 0) return false;
  return meetingWordsOf(textB).some((word) => stems.has(word));
}

/**
 * Minuti che separano due finestre orarie: 0 quando si sovrappongono o si
 * toccano (15:30–16:30 e 16:30–17:15), altrimenti la distanza più breve fra
 * la fine di una e l'inizio dell'altra.
 */
function gapBetweenWindows(a: TimeWindow, b: TimeWindow): number {
  const endA = a.end ?? a.start;
  const endB = b.end ?? b.start;
  if (a.start <= endB && b.start <= endA) return 0;
  return Math.min(Math.abs(b.start - endA), Math.abs(a.start - endB));
}

/** Un impegno ridotto a ciò che serve per giudicare l'affinità. */
export type AffinityCandidate = EventMatchCandidate & { id?: string; deadlineDate?: string };

/** Lezioni, scadenze e tutto il giorno restano fuori dal giudizio di affinità. */
function isExcludedFromAffinity(item: AffinityCandidate): boolean {
  return isDeadlineLike(item) || isLessonLike(item) || !!cleanEventField(item.deadlineDate) || item.isAllDay === true;
}

/**
 * L'orario scritto nel titolo di `titled` coincide con l'orario effettivo di
 * `other`: basta l'inizio; se il titolo dichiara anche la fine, devono coincidere
 * entrambi.
 */
export function titleTimeAgreesWithEvent(
  titled: { title?: string | null },
  other: { startTime?: string | null; endTime?: string | null; isAllDay?: boolean | null }
): boolean {
  const declared = extractTimesFromTitle(titled.title);
  const declaredStart = timeToMinutes(declared.start);
  const otherStart = timeToMinutes(other.startTime);
  if (declaredStart === null || otherStart === null || declaredStart !== otherStart) return false;
  const declaredEnd = timeToMinutes(declared.end);
  const otherEnd = timeToMinutes(other.endTime);
  if (declaredEnd !== null && otherEnd !== null) return declaredEnd === otherEnd;
  return true;
}

export interface EventAffinity {
  /** 0 = sovrapposti o contigui; altrimenti i minuti fra i due intervalli. */
  gapMinutes: number;
  /** L'orario del titolo di uno dei due coincide con l'orario reale dell'altro. */
  titleTimeAgrees: boolean;
}

/**
 * Giudizio di AFFINITÀ fra due impegni: stesso giorno, due riunioni dello stesso
 * tipo sulla stessa classe, con orari vicini o dichiarati nel titolo. Restituisce
 * null quando anche una sola delle condizioni manca.
 *
 * Condizioni (tutte necessarie):
 * 1. stessa data;
 * 2. nessuno dei due è lezione, scadenza o tutto il giorno;
 * 3. entrambi hanno almeno una classe e gli insiemi di classi si intersecano;
 * 4. condividono almeno una parola "di riunione" per radice;
 * 5. e inoltre almeno una fra:
 *    (i) orari sovrapposti, contigui o distanti al massimo 60 minuti;
 *    (ii) l'orario del titolo di uno coincide con l'orario effettivo dell'altro.
 */
export function evaluateEventAffinity(a: AffinityCandidate, b: AffinityCandidate): EventAffinity | null {
  if (!a.date || a.date !== b.date) return null;
  if (!cleanEventField(a.title) || !cleanEventField(b.title)) return null;
  if (isExcludedFromAffinity(a) || isExcludedFromAffinity(b)) return null;

  const classesA = getEventClassTokens(a);
  const classesB = getEventClassTokens(b);
  if (classesA.length === 0 || classesB.length === 0) return null;
  if (!classesA.some((sigla) => classesB.includes(sigla))) return null;

  if (!sharesMeetingKeyword(a.title, b.title)) return null;

  const windowA = timeWindowOf(a);
  const windowB = timeWindowOf(b);
  const gapMinutes = windowA && windowB ? gapBetweenWindows(windowA, windowB) : Number.POSITIVE_INFINITY;
  const titleTimeAgrees = titleTimeAgreesWithEvent(a, b) || titleTimeAgreesWithEvent(b, a);
  if (gapMinutes > AFFINITY_MAX_GAP_MINUTES && !titleTimeAgrees) return null;

  return { gapMinutes, titleTimeAgrees };
}

/** Vera se i due impegni sono affini: possibile doppione da suggerire, mai da fondere. */
export function areEventsAffine(a: AffinityCandidate, b: AffinityCandidate): boolean {
  return evaluateEventAffinity(a, b) !== null;
}

/**
 * Cerca fra gli impegni già in agenda quello più affine al candidato: il possibile
 * doppione che gli altri criteri non riconoscono (orari contigui o titolo che
 * dichiara l'orario dell'altro).
 *
 * È un SUGGERIMENTO e vale solo per l'avviso "Possibile doppione · Unisci"
 * (`findPossibleDuplicates`): non aggiorna e non fonde nulla in automatico, quindi
 * non è usato né da `findEventMatch` né da `assignDocumentMatches` (import da
 * circolare) né dall'import Google.
 */
export function findAffinityMatch(
  candidate: AffinityCandidate,
  existingEvents: CalendarEvent[] | undefined | null
): EventMatchResult | null {
  if (!existingEvents || existingEvents.length === 0) return null;
  if (!candidate.date || !candidate.title) return null;

  const scored: { event: CalendarEvent; affinity: EventAffinity }[] = [];
  for (const event of existingEvents) {
    if (event.date !== candidate.date || event.id === candidate.id) continue;
    const affinity = evaluateEventAffinity(candidate, event);
    if (affinity) scored.push({ event, affinity });
  }
  if (scored.length === 0) return null;

  // Spareggio: prima chi concorda con l'orario scritto nel titolo, poi l'intervallo
  // più vicino, poi l'ordine in agenda.
  scored.sort((a, b) => {
    if (a.affinity.titleTimeAgrees !== b.affinity.titleTimeAgrees) return a.affinity.titleTimeAgrees ? -1 : 1;
    if (a.affinity.gapMinutes !== b.affinity.gapMinutes) return a.affinity.gapMinutes - b.affinity.gapMinutes;
    return 0;
  });

  return { event: scored[0].event, kind: "affinita", others: scored.length - 1 };
}

/** Abbinamento che OCCUPA un impegno già in agenda: la sola sovrapposizione non compare qui. */
export interface OccupiedEventMatch {
  event: CalendarEvent;
  /** "titolo" = possibile aggiornamento; "orario" = possibile stesso impegno con un altro nome. */
  kind: "titolo" | "orario";
}

/** Esito dell'abbinamento per UNA riga del documento. */
export interface DocumentMatchEntry {
  /**
   * Impegno già in agenda che la riga aggiorna o riconosce, oppure null quando
   * la riga è un impegno nuovo (o solo sovrapposto a qualcosa).
   */
  match: OccupiedEventMatch | null;
  /**
   * Impegni già in agenda con cui la riga si sovrappone davvero, dal più
   * significativo: stesso inizio+fine, poi stesso inizio, poi sovrapposizione
   * più lunga, poi ordine in agenda. L'impegno abbinato alla riga è escluso
   * (la scheda lo mostra già); le sovrapposizioni non bloccano mai nulla.
   */
  overlaps: CalendarEvent[];
}

/**
 * Graduatoria con cui una riga rivendica un impegno già in agenda quando
 * l'impegno è conteso: stesso inizio+fine (0), stesso inizio (1), poi la
 * sovrapposizione più lunga; a parità vale l'ordine nel documento.
 */
function claimRank(candidate: EventMatchCandidate, event: CalendarEvent): { tier: number; overlap: number } {
  const candidateWindow = timeWindowOf(candidate);
  const eventWindow = timeWindowOf(event);
  const candidateStart = candidateWindow?.start ?? null;
  const eventStart = eventWindow?.start ?? null;
  const sameStart = candidateStart !== null && candidateStart === eventStart;

  if (sameStart && (candidateWindow?.end ?? null) === (eventWindow?.end ?? null)) return { tier: 0, overlap: 0 };
  if (sameStart) return { tier: 1, overlap: 0 };

  const overlap = candidateWindow && eventWindow ? overlapMinutes(candidateWindow, eventWindow) : 0;
  return { tier: 2, overlap };
}

/** Impegni in agenda che si sovrappongono davvero alla riga, in ordine di rilevanza. */
function overlappingEvents(
  candidate: EventMatchCandidate,
  existingEvents: CalendarEvent[],
  exclude?: CalendarEvent | null
): CalendarEvent[] {
  if (isDeadlineLike(candidate) || isLessonLike(candidate)) return [];
  const candidateWindow = timeWindowOf(candidate);
  if (!candidateWindow) return [];

  return existingEvents
    .map((event, index) => ({ event, index, window: timeWindowOf(event) }))
    .filter((entry) => entry.window !== null && entry.event !== exclude)
    .filter((entry) => entry.event.date === candidate.date)
    .filter((entry) => !isDeadlineLike(entry.event) && !isLessonLike(entry.event))
    .filter((entry) => windowsOverlap(candidateWindow, entry.window as TimeWindow))
    .sort((a, b) => {
      const rankA = claimRank(candidate, a.event);
      const rankB = claimRank(candidate, b.event);
      if (rankA.tier !== rankB.tier) return rankA.tier - rankB.tier;
      if (rankA.overlap !== rankB.overlap) return rankB.overlap - rankA.overlap;
      return a.index - b.index;
    })
    .map((entry) => entry.event);
}

/**
 * Abbinamento UNO A UNO sull'intero documento: ogni impegno già in agenda può
 * essere assegnato per "titolo" o per "orario" a UNA sola riga.
 *
 * L'assegnazione è globale (non riga per riga): fra le righe che rivendicano lo
 * stesso impegno vince quella con stesso inizio+fine, poi quella con lo stesso
 * inizio, poi la sovrapposizione più lunga, poi l'ordine nel documento. Le righe
 * che perdono vengono rivalutate sugli impegni rimasti liberi: se non ne resta
 * nessuno sono impegni nuovi. Il tipo "sovrapposizione" non occupa l'impegno
 * (più righe possono sovrapporsi allo stesso) e resta fuori dall'abbinamento.
 */
export function assignDocumentMatches(
  candidates: EventMatchCandidate[],
  existingEvents: CalendarEvent[] | undefined | null
): DocumentMatchEntry[] {
  const entries: DocumentMatchEntry[] = candidates.map(() => ({ match: null, overlaps: [] }));
  const allEvents = existingEvents ?? [];
  if (candidates.length === 0 || allEvents.length === 0) return entries;

  let available = [...allEvents];
  let pending = candidates.map((_, index) => index);

  while (pending.length > 0 && available.length > 0) {
    // Rivendicazioni della riga sull'insieme ancora libero: la sola
    // sovrapposizione non rivendica nulla e non entra nel giro.
    const claims = pending
      .map((row) => ({ row, match: findEventMatch(candidates[row], available) }))
      .filter(
        (entry): entry is { row: number; match: EventMatchResult & { kind: "titolo" | "orario" } } =>
          !!entry.match && (entry.match.kind === "titolo" || entry.match.kind === "orario")
      );
    if (claims.length === 0) break;

    const byEvent = new Map<CalendarEvent, { row: number; match: EventMatchResult & { kind: "titolo" | "orario" } }[]>();
    for (const claim of claims) {
      const group = byEvent.get(claim.match.event);
      if (group) group.push(claim);
      else byEvent.set(claim.match.event, [claim]);
    }

    // Le righe che perdono una contesa restano in gioco sui soli impegni
    // rimasti liberi: se non ne resta nessuno sono impegni nuovi.
    const leftOver: number[] = [];
    for (const group of byEvent.values()) {
      const winner =
        group.length === 1
          ? group[0]
          : group.reduce((best, claim) => {
              const rankBest = claimRank(candidates[best.row], best.match.event);
              const rankClaim = claimRank(candidates[claim.row], claim.match.event);
              if (rankClaim.tier !== rankBest.tier) return rankClaim.tier < rankBest.tier ? claim : best;
              if (rankClaim.overlap !== rankBest.overlap) return rankClaim.overlap > rankBest.overlap ? claim : best;
              return claim.row < best.row ? claim : best;
            });
      entries[winner.row] = { match: { event: winner.match.event, kind: winner.match.kind }, overlaps: [] };
      for (const claim of group) if (claim !== winner) leftOver.push(claim.row);
    }

    const taken = new Set<CalendarEvent>();
    for (const entry of entries) if (entry.match) taken.add(entry.match.event);
    available = available.filter((event) => !taken.has(event));
    pending = leftOver;
  }

  // Sovrapposizioni: valgono per tutte le righe, anche verso impegni già
  // abbinati ad altre righe, e non tolgono nulla all'abbinamento.
  for (let index = 0; index < candidates.length; index++) {
    entries[index].overlaps = overlappingEvents(
      candidates[index],
      allEvents,
      entries[index].match?.event ?? null
    );
  }

  return entries;
}

/**
 * Trova un eventuale evento esistente che rappresenta un possibile
 * aggiornamento dell'elemento estratto dalla circolare (criterio del titolo).
 *
 * Regole deterministiche:
 * 1. Stessa data ISO obbligatoria.
 * 2. Categorie compatibili.
 * 3. Classi compatibili.
 * 4. Titolo corrispondente parola per parola.
 * 5. Se ci sono più candidati plausibili nello stesso giorno -> spareggio sugli
 *    orari; se restano comunque più candidati, NON associa (nessun match forzato).
 */
export function findPossibleEventUpdate(
  candidate: EventMatchCandidate,
  existingEvents: CalendarEvent[] | undefined | null
): CalendarEvent | null {
  const match = findEventMatch(candidate, existingEvents);
  return match && match.kind === "titolo" ? match.event : null;
}
