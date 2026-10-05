/**
 * Estrazione testo locale (server-side) per PDF digitali — PR "text-first per
 * circolari PDF lunghe".
 *
 * Perché esiste: `PIANOATTIVITA26.27.pdf` (reale, multipagina, molte attività
 * distribuite lungo l'anno) veniva inviato SOLO a Gemini come `inlineData`
 * PDF. Il percorso Groq/Qwen esistente (`executeGroqCircularAnalysis`) accetta
 * `imageBase64` solo per `image/jpeg|png|webp` e rifiuta `application/pdf`:
 * per i PDF digitali restava un solo tentativo cloud (Gemini) su tutto il
 * documento, senza un percorso testuale più leggero e veloce.
 *
 * Qui viviamo SOLO il text layer dei PDF digitali normali:
 * - nessun OCR;
 * - nessuna conversione delle pagine in immagini;
 * - nessuna deduzione semantica (colonne, riordino, eventi): quella resta
 *   del modello, non di questo modulo.
 *
 * Libreria scelta: `unpdf` (wrapper di pdf.js per ambienti serverless/edge).
 * Motivazioni:
 * - zero dipendenze runtime proprie (il bundle di pdf.js è incluso nel
 *   pacchetto pubblicato, non richiede build/postinstall nativi);
 * - API ESM pulita (`type: module`, `exports` con condizioni `import`),
 *   compatibile con `tsx` (dev) e con `esbuild --format=cjs
 *   --packages=external` (build): la dipendenza resta esterna al bundle e
 *   viene risolta a runtime da `node_modules`, come le altre dipendenze
 *   del progetto (`express`, `@google/genai`, ecc.);
 * - `extractText` restituisce il testo per pagina (`mergePages: false`),
 *   utile per delimitare le pagine senza inventare struttura;
 * - nessuna dipendenza da Canvas/rendering nativo per la sola estrazione
 *   testo (il peer `@napi-rs/canvas` è opzionale e usato solo per il
 *   rendering a immagine, qui mai invocato).
 *
 * Sicurezza: questo modulo non deve MAI loggare testo estratto, titoli,
 * nomi, classi o contenuto del documento. Il chiamante logga solo metadati
 * (`pages`, `textChars`, esito).
 */
import { getDocumentProxy, extractText } from "unpdf";

export interface PdfTextExtractionResult {
  text: string;
  /** Testo normalizzato per pagina, nello stesso ordine del PDF. */
  pages: string[];
  pageCount?: number;
  textChars: number;
}

/** Esito controllato dell'estrazione: mai un'eccezione non gestita verso l'endpoint. */
export type PdfTextExtractionStatus = "success" | "empty" | "failed";

export interface PdfTextExtractionOutcome extends PdfTextExtractionResult {
  status: PdfTextExtractionStatus;
}

/**
 * Soglia conservativa di "testo sufficiente" per preferire Groq/Qwen
 * text-only a Gemini sul PDF originale. Deterministica, nessuna euristica AI:
 * quattro parole o un'intestazione isolata non bastano a descrivere un piano
 * annuale di attività.
 */
export const PDF_TEXT_SUFFICIENT_MIN_CHARS = 250;

/** Conteggio caratteri non whitespace: una metrica semplice e deterministica. */
function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/**
 * NON usa l'AI per decidere: solo una soglia di caratteri non whitespace.
 * Evita di inviare a Groq quattro parole o intestazioni isolate (PDF
 * scansionati senza text layer, pagine vuote, header ripetuti).
 */
export function isPdfTextSufficient(text: string): boolean {
  if (!text) return false;
  return nonWhitespaceLength(text) >= PDF_TEXT_SUFFICIENT_MIN_CHARS;
}

/**
 * Normalizzazioni CONSERVATIVE, mai semantiche:
 * - normalizza `\r\n`/`\r` in `\n`;
 * - elimina NUL;
 * - riduce sequenze eccessive di spazi/tab orizzontali (preserva i ritorni a
 *   capo, quindi la separazione fra righe);
 * - riduce righe vuote multiple consecutive;
 * - NON riordina righe, NON deduce colonne, NON tenta OCR.
 */
function normalizePageText(raw: string): string {
  let normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  normalized = normalized.replace(/\u0000/g, "");
  normalized = normalized.replace(/[ \t]{3,}/g, "  ");
  normalized = normalized.replace(/\n{4,}/g, "\n\n\n");
  return normalized.trim();
}

/**
 * Unisce le pagine con un delimitatore puramente strutturale (nessun
 * contenuto semantico aggiunto) quando sono più di una, così il modello può
 * distinguere attività su pagine diverse senza che il testo le fonda insieme.
 */
function joinPages(pages: string[]): string {
  const normalizedPages = pages.map(normalizePageText);
  if (normalizedPages.length <= 1) return normalizedPages[0] ?? "";
  return normalizedPages
    .map((page, idx) => `--- PAGINA ${idx + 1} ---\n${page}`)
    .join("\n\n");
}

/**
 * Estrae il text layer di un PDF digitale. Nessun OCR, nessun rendering a
 * immagine: solo il testo già incluso nel PDF (pdf.js, via `unpdf`).
 *
 * Un PDF non valido o non interpretabile fa fallire la Promise: il chiamante
 * (endpoint) deve trattarlo come esito controllato `failed`, mai come 500.
 */
export async function extractPdfText(base64: string): Promise<PdfTextExtractionResult> {
  const buffer = Buffer.from(base64, "base64");
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map(normalizePageText);
  const joined = joinPages(pages);
  return {
    text: joined,
    pages,
    pageCount: totalPages,
    textChars: joined.length,
  };
}

/**
 * Wrapper con esito sempre controllato (`success` / `empty` / `failed`),
 * pensato per il routing dell'endpoint: un errore di parsing PDF non deve MAI
 * propagarsi come eccezione non gestita (niente HTTP 500 per questo).
 */
export async function runPdfTextExtraction(base64: string): Promise<PdfTextExtractionOutcome> {
  let result: PdfTextExtractionResult;
  try {
    result = await extractPdfText(base64);
  } catch {
    return { status: "failed", text: "", pages: [], textChars: 0 };
  }
  const status: PdfTextExtractionStatus = isPdfTextSufficient(result.text) ? "success" : "empty";
  return { status, ...result };
}
