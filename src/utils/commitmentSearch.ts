import type { EventCategory } from "../types";
import {
  compareFutureCommitments,
  comparePastCommitments,
  type FutureCommitmentItem,
} from "./futureCommitments";
import { isRelevanceReasonText } from "./circularRelevance";

/**
 * Ricerca LOCALE degli impegni di "Note e impegni".
 *
 * Nessuna rete e nessuna nuova collezione: la funzione lavora solo sugli elenchi
 * già derivati dalla vista (`deriveFutureCommitments` + `deriveArchiveCommitments`).
 * Non importa componenti React: l'etichetta leggibile della tipologia (es.
 * "Collegio Docenti") arriva dalla vista tramite il parametro `categoryLabel`,
 * costruito su EVENT_CATEGORIES.
 *
 * La normalizzazione tollera gli errori tipici di chi digita velocemente:
 * maiuscole, accenti, punteggiatura, doppie ("colleggio" ≈ "collegio"), forme
 * diverse della classe ("2 C", "2^C", "2ªC" → "2c") e un errore di battitura
 * sulle parole lunghe ("collegko" ≈ "collegio").
 */

const COMBINING_MARKS_PATTERN = /[\u0300-\u036f]/g;
/** Punteggiatura e simboli diventano separatori, come gli spazi. */
const PUNCTUATION_PATTERN = /[^\p{L}\p{N}\s]+/gu;
/**
 * Classi già scritte in forme diverse: "2 C", "2^C" (dopo la punteggiatura è
 * già "2 c") e "2ªC" diventano il token unico "2c". La lettera finale deve essere
 * singola (non "2 co…"), così non saldiamo parole vere al numero che le precede.
 */
const CLASS_TOKEN_PATTERN = /(\p{N})[\s\^ªº°]{0,3}(\p{L})(?![\p{L}\p{N}])/gu;
/** Lettere doppie consecutive ridotte a una: "colleggio" e "collegio" → "colegio". */
const DOUBLE_LETTERS_PATTERN = /(\p{L})\1+/gu;
const MULTI_SPACE_PATTERN = /\s+/g;

/**
 * Normalizza un testo (o una query) per la ricerca: minuscolo, accenti rimossi
 * (NFD), punteggiatura → spazio, doppie ridotte, "2 C"/"2^C"/"2ªC" → "2c",
 * spazi multipli ridotti. La stessa funzione è applicata a query e testi, così
 * i due lati del confronto parlano sempre la stessa lingua.
 */
export function normalizeSearchText(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS_PATTERN, "")
    .replace(PUNCTUATION_PATTERN, " ")
    .replace(CLASS_TOKEN_PATTERN, "$1$2")
    .replace(DOUBLE_LETTERS_PATTERN, "$1")
    .replace(MULTI_SPACE_PATTERN, " ")
    .trim();
}

function splitNormalizedWords(normalized: string): string[] {
  return normalized ? normalized.split(" ") : [];
}

/** Distanza di modifica ≤ 1 (sostituzione, inserimento o cancellazione singola). */
function isEditDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length === b.length) {
      i += 1;
      j += 1;
    } else if (a.length > b.length) {
      i += 1;
    } else {
      j += 1;
    }
  }
  // Caratteri in coda non consumati (es. una lettera di differenza alla fine).
  if (i < a.length || j < b.length) edits += 1;
  return edits <= 1;
}

/**
 * Una parola della query trova riscontro in un impegno se:
 * - è l'inizio di una parola del testo ("coll" → "collegio"), a qualunque lunghezza;
 * - ha almeno 4 caratteri ed è contenuta in una parola del testo;
 * - ha almeno 6 caratteri e dista ≤ 1 modifica da una parola del testo
 *   ("colegko" ≈ "collegio", ma "colegoi" no: due lettere scambiate sono 2 modifiche).
 */
function queryWordMatchesItemWord(itemWords: readonly string[], queryWord: string): boolean {
  for (const word of itemWords) {
    if (word.startsWith(queryWord)) return true;
  }
  if (queryWord.length >= 4) {
    for (const word of itemWords) {
      if (word.includes(queryWord)) return true;
    }
  }
  if (queryWord.length >= 6) {
    for (const word of itemWords) {
      if (Math.abs(word.length - queryWord.length) <= 1 && isEditDistanceAtMostOne(word, queryWord)) return true;
    }
  }
  return false;
}

/**
 * Le parole di un solo carattere generano solo rumore e vengono ignorate. Le
 * classi già normalizzate ("2c") hanno almeno 2 caratteri e restano sempre
 * significative. Una query che dopo la normalizzazione non ha NESSUNA parola
 * significativa (solo doppie che collassano, punteggiatura, spazi o caratteri
 * singoli) non deve mai arrivare all'AND su una lista vuota di parole: l'AND
 * vuoto varrebbe per tutti gli impegni e mostrerebbe l'intero elenco.
 */
function isSignificantQueryWord(word: string): boolean {
  return word.length >= 2;
}

/** Parole significative (≥ 2 caratteri) della query dopo la normalizzazione. */
function significantQueryWords(query: string): string[] {
  return splitNormalizedWords(normalizeSearchText(query)).filter(isSignificantQueryWord);
}

/**
 * Vero se la query contiene almeno una parola utile (≥ 2 caratteri dopo la
 * normalizzazione: doppie ridotte, punteggiatura e spazi non contano). La vista
 * la usa per decidere se la ricerca può partire.
 */
export function hasSearchableTerms(query: string): boolean {
  return significantQueryWords(query).length > 0;
}

export type CommitmentCategoryLabel = (category: EventCategory) => string;

export interface PreparedCommitment {
  readonly item: FutureCommitmentItem;
  /** Parole del testo di ricerca normalizzato, calcolate una sola volta. */
  readonly words: readonly string[];
}

export interface CommitmentSearchIndex {
  readonly entries: readonly PreparedCommitment[];
}

/**
 * Testo ricercabile di un impegno: titolo, dettagli/note, luogo, classe, materia
 * ed etichetta della tipologia. Dalle note si ESCLUDE il motivo di pertinenza
 * delle circolari (`isRelevanceReasonText`): nella riga non viene mostrato, quindi
 * non deve nemmeno generare risultati invisibili all'utente.
 */
function searchableText(item: FutureCommitmentItem, categoryLabel: CommitmentCategoryLabel): string {
  const event = item.originalEvent;
  const detailsHidden = !!event
    && event.sourceType === "circolare"
    && !!item.details
    && isRelevanceReasonText(item.details);
  const parts: string[] = [item.title];
  if (item.details && !detailsHidden) parts.push(item.details);
  if (item.location) parts.push(item.location);
  if (item.className) parts.push(item.className);
  if (item.subject) parts.push(item.subject);
  if (event?.category) parts.push(categoryLabel(event.category));
  return parts.join(" ");
}

/**
 * Prepara l'elenco per la ricerca: il testo normalizzato di ogni impegno viene
 * calcolato UNA sola volta. La vista lo memoizza (`useMemo`), così a ogni battuta
 * si filtra un indice già pronto e la digitazione resta fluida anche con
 * qualche migliaio di impegni.
 */
export function buildCommitmentSearchIndex(
  items: readonly FutureCommitmentItem[],
  categoryLabel: CommitmentCategoryLabel,
): CommitmentSearchIndex {
  return {
    entries: items.map(item => ({
      item,
      words: splitNormalizedWords(normalizeSearchText(searchableText(item, categoryLabel))),
    })),
  };
}

export interface CommitmentSearchOptions {
  todayIso: string;
  categoryLabel: CommitmentCategoryLabel;
}

export interface CommitmentSearchResult {
  /** Impegni da oggi in avanti, per data crescente (oggi incluso). */
  upcoming: FutureCommitmentItem[];
  /** Impegni passati, dal più recente al più vecchio. */
  past: FutureCommitmentItem[];
  /**
   * Vero quando la query non contiene nessuna parola utile (es. "aa", "..",
   * "c d"): in quel caso entrambe le liste sono vuote e la ricerca non viene
   * nemmeno eseguita, invece di restituire l'intero elenco.
   */
  tooShort: boolean;
}

function isCommitmentSearchIndex(items: readonly FutureCommitmentItem[] | CommitmentSearchIndex): items is CommitmentSearchIndex {
  return !Array.isArray(items);
}

function toIndex(
  items: readonly FutureCommitmentItem[] | CommitmentSearchIndex,
  categoryLabel: CommitmentCategoryLabel,
): CommitmentSearchIndex {
  return isCommitmentSearchIndex(items) ? items : buildCommitmentSearchIndex(items, categoryLabel);
}

/**
 * Ricerca gli impegni che corrispondono alla query: TUTTE le parole della query
 * devono trovare riscontro (AND). Restituisce gli impegni separati in futuri
 * (oggi incluso, data crescente, compresi quelli oltre il 31 agosto) e passati
 * (dal più recente al più vecchio), già ordinati.
 *
 * `items` può essere l'elenco grezzo oppure l'indice precalcolato con
 * `buildCommitmentSearchIndex` (scelta preferita dalla vista per le prestazioni).
 */
export function searchCommitments(
  items: readonly FutureCommitmentItem[] | CommitmentSearchIndex,
  query: string,
  { todayIso, categoryLabel }: CommitmentSearchOptions,
): CommitmentSearchResult {
  const queryWords = significantQueryWords(query);
  // Nessuna parola utile (solo doppie, punteggiatura, spazi o caratteri singoli):
  // nessun risultato, mai l'intero elenco. L'AND su una lista vuota di parole
  // non viene nemmeno tentato.
  if (queryWords.length === 0) {
    return { upcoming: [], past: [], tooShort: true };
  }
  const index = toIndex(items, categoryLabel);
  const upcoming: FutureCommitmentItem[] = [];
  const past: FutureCommitmentItem[] = [];
  for (const { item, words } of index.entries) {
    if (!queryWords.every(queryWord => queryWordMatchesItemWord(words, queryWord))) continue;
    (item.date >= todayIso ? upcoming : past).push(item);
  }
  upcoming.sort(compareFutureCommitments);
  past.sort(comparePastCommitments);
  return { upcoming, past, tooShort: false };
}
