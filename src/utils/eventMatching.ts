import type { CalendarEvent, EventCategory, ExtractedItem } from "../types";

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

/** Estrae una possibile classe (es. "1A", "3D", "5B") da una stringa. */
export function extractClassToken(text: string): string | null {
  if (!text) return null;
  const match = /\b([1-5]\s*[a-z]|[1-5]ª\s*[a-z])\b/i.exec(text);
  if (!match) return null;
  return match[1].toUpperCase().replace(/[\sª]/g, "");
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
  location: boolean;
  notes: boolean;
  category: boolean;
  className: boolean;
}

/**
 * Calcola quali campi differiscono tra un evento esistente e un elemento da circolare.
 */
export function getEventFieldDiff(
  existing: CalendarEvent,
  candidate: Pick<ExtractedItem, "title" | "date" | "deadlineDate" | "isDeadline" | "startTime" | "endTime" | "location" | "notes" | "category" | "className">
): EventFieldDiff {
  const cleanStr = (s?: string) => (s ?? "").trim();
  const candidateDeadline = candidate.deadlineDate || (candidate.isDeadline === true ? candidate.date : undefined);

  return {
    title: cleanStr(existing.title) !== cleanStr(candidate.title),
    date: cleanStr(existing.date) !== cleanStr(candidate.date),
    deadlineDate: cleanStr(existing.deadlineDate) !== cleanStr(candidateDeadline),
    startTime: cleanStr(existing.startTime) !== cleanStr(candidate.startTime),
    endTime: cleanStr(existing.endTime) !== cleanStr(candidate.endTime),
    location: cleanStr(existing.location) !== cleanStr(candidate.location),
    notes: cleanStr(existing.notes) !== cleanStr(candidate.notes),
    category: existing.category !== candidate.category,
    className: cleanStr(existing.className) !== cleanStr(candidate.className),
  };
}

/**
 * Un conflitto è "identico" quando l'impegno estratto non porta alcuna
 * differenza rispetto all'impegno già in agenda:
 * - stesso titolo, senza distinzione di maiuscole e spazi;
 * - stessa data, stessi orari di inizio e fine, stessa categoria;
 * - nessun campo non vuoto del nuovo (luogo, classe, note) diverso dal
 *   corrispondente esistente. Un campo vuoto nel nuovo non è una differenza
 *   e lo stesso testo spostato in un campo diverso (es. la sede finita nelle
 *   note) non è una differenza.
 *
 * È la definizione usata per preselezionare "Ignora" sui doppioni già in
 * agenda; non va confusa con `getEventFieldDiff`, che evidenzia le differenze
 * simmetriche (inclusi i campi vuoti) nel confronto mostrato a schermo.
 */
export function isIdenticalEventUpdate(
  existing: CalendarEvent,
  candidate: Pick<
    ExtractedItem,
    "title" | "date" | "startTime" | "endTime" | "category" | "className" | "location" | "notes"
  >
): boolean {
  const foldTitle = (raw?: string) => (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const clean = (raw?: string) => (raw ?? "").trim();

  if (foldTitle(existing.title) !== foldTitle(candidate.title)) return false;
  if (clean(existing.date) !== clean(candidate.date)) return false;
  if (clean(existing.startTime) !== clean(candidate.startTime)) return false;
  if (clean(existing.endTime) !== clean(candidate.endTime)) return false;
  if ((existing.category ?? "") !== (candidate.category ?? "")) return false;

  // Testi già presenti nell'impegno esistente (luogo, classe, note): un valore
  // del nuovo che li riproduce, anche in un campo diverso, non è una differenza.
  const existingTexts = new Set(
    [clean(existing.location), clean(existing.className), clean(existing.notes)].filter((t) => t.length > 0)
  );
  const carriesDifference = (value: string, corresponding?: string) =>
    value.length > 0 && value !== clean(corresponding) && !existingTexts.has(value);

  return (
    !carriesDifference(clean(candidate.location), existing.location) &&
    !carriesDifference(clean(candidate.className), existing.className) &&
    !carriesDifference(clean(candidate.notes), existing.notes)
  );
}

/** Tipo di riconoscimento: per titolo (possibile aggiornamento) o per orario. */
export type EventMatchKind = "titolo" | "orario";

export interface EventMatchResult {
  /** Impegno già in agenda riconosciuto. */
  event: CalendarEvent;
  /** Criterio che lo ha riconosciuto: il titolo ha la precedenza sull'orario. */
  kind: EventMatchKind;
  /** Altri impegni trovati dallo stesso criterio (solo "orario"): quanti ne restano fuori. */
  others: number;
}

/** Elemento estratto nella parte che serve al riconoscimento. */
export type EventMatchCandidate = Pick<ExtractedItem, "title" | "date" | "category" | "className"> &
  Partial<Pick<ExtractedItem, "startTime" | "endTime" | "isDeadline">>;

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
 * 2. ORARIO (stessa data, intervalli che si sovrappongono): è lo stesso
 *    impegno con un nome diverso. Fuori dal confronto: lezioni, scadenze,
 *    impegni tutto il giorno o senza orario (su entrambi i lati).
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

  // La data è obbligatoria per entrambi i criteri.
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

  const overlapping = sameDay
    // Categorie e classi restano un discrimine anche qui: a parità di orario,
    // un consiglio di classe 3D non è lo stesso impegno di un consiglio 1C.
    .filter((existing) => areCategoriesCompatible(candidate.category, existing.category))
    .filter((existing) =>
      areClassesCompatible(candidate.className, existing.className, candidate.title, existing.title)
    )
    .filter((existing) => !isDeadlineLike(existing) && !isLessonLike(existing))
    .map((existing) => ({ existing, window: timeWindowOf(existing) }))
    .filter((entry): entry is { existing: CalendarEvent; window: TimeWindow } => entry.window !== null)
    .filter((entry) => windowsOverlap(candidateWindow, entry.window));

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

  return { event: best.existing, kind: "orario", others: overlapping.length - 1 };
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
