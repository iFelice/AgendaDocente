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
 * Confronta due titoli per verificare se identificano lo stesso evento:
 * - Titoli normalizzati identici
 * - Oppure uno è contenuto nell'altro mantenendo tutte le parole chiave
 */
export function isTitleMatch(rawA: string, rawB: string): boolean {
  const normA = normalizeEventTitle(rawA);
  const normB = normalizeEventTitle(rawB);

  if (!normA || !normB) return false;
  if (normA === normB) return true;

  // Se uno contiene l'altro ed entrambi hanno almeno 2 parole significative
  const wordsA = normA.split(" ");
  const wordsB = normB.split(" ");

  if (wordsA.length >= 2 && wordsB.length >= 2) {
    if (normA.includes(normB) || normB.includes(normA)) {
      return true;
    }
  }

  return false;
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

/**
 * Trova un eventuale evento esistente che rappresenta un possibile aggiornamento
 * dell'elemento estratto dalla circolare.
 *
 * Regole deterministiche:
 * 1. Stessa data ISO obbligatoria.
 * 2. Categorie compatibili.
 * 3. Classi compatibili.
 * 4. Titolo normalizzato corrispondente.
 * 5. Se ci sono più candidati plausibili nello stesso giorno -> NON associa (nessun match forzato).
 */
export function findPossibleEventUpdate(
  candidate: Pick<ExtractedItem, "title" | "date" | "category" | "className">,
  existingEvents: CalendarEvent[] | undefined | null
): CalendarEvent | null {
  if (!existingEvents || existingEvents.length === 0) return null;
  if (!candidate.date || !candidate.title) return null;

  const matches = existingEvents.filter((existing) => {
    // 1. Data obbligatoriamente identica
    if (existing.date !== candidate.date) return false;

    // 2. Categorie compatibili
    if (!areCategoriesCompatible(candidate.category, existing.category)) return false;

    // 3. Classi compatibili
    if (!areClassesCompatible(candidate.className, existing.className, candidate.title, existing.title)) {
      return false;
    }

    // 4. Titolo normalizzato corrispondente
    if (!isTitleMatch(candidate.title, existing.title)) return false;

    return true;
  });

  // Solo se c'è esattamente un candidato univoco
  if (matches.length === 1) {
    return matches[0];
  }

  // Se 0 o > 1 (ambiguità), nessun match automatico
  return null;
}
