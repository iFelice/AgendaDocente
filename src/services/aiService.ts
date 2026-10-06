import type { ExtractedItem, TeacherProfile } from "../types";
import { parseCircularText, normalizeExtractedItems } from "../utils/circularParser";
export { parseCircularText as clientSideLocalParser } from "../utils/circularParser";

export interface AnalyzeRequest {
  text?: string; imageBase64?: string; mimeType?: string;
  profile: TeacherProfile; defaultLocation?: string;
  /**
   * Ripresa: pagine (1-based) da analizzare davvero. Assente = tutto il
   * documento. Ammesso solo su un PDF; il server valida interi, intervallo,
   * duplicati e numero massimo e risponde 400 se l'elenco non è ammissibile.
   */
  pages?: number[];
}
export interface AnalyzeResult {
  success: boolean; source: string; items: ExtractedItem[]; error?: string;
  notice?: string;
  /**
   * Pagine che il server NON è riuscito ad analizzare in questa richiesta:
   * sono esattamente quelle da rimandare in una ripresa.
   */
  unanalyzedPages?: number[];
  /** Codice applicativo, mai mostrato nell'interfaccia. */
  errorCode?: CircularAnalysisErrorCode;
}

/** Attesa della POST: 170 s lato server per i PDF per pagina, più margine client. */
export const CIRCULAR_REQUEST_TIMEOUT_MS = 180_000;

/**
 * Avanzamento del percorso PDF per pagina. Un vero "pagina 3 di 7" richiede un
 * canale di progresso (stream/polling) che cambierebbe il formato della
 * risposta: fuori perimetro. Resta quindi un'attesa dichiarata, coerente con
 * il deadline server di 170 s.
 */
export const CIRCULAR_PDF_WAIT_MESSAGE =
  "Analisi del PDF pagina per pagina: può richiedere fino a 3 minuti.";

/** Numero massimo di pagine richiedibili in una sola ripresa (limite server). */
export const CIRCULAR_RESUME_PAGES_MAX = 30;

/**
 * Pagine non analizzate dichiarate dal server: solo interi positivi, ordinati
 * e senza duplicati. Un campo malformato non deve mai produrre un pulsante di
 * ripresa che il server rifiuterebbe con 400.
 */
export function sanitizeUnanalyzedPages(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pages = new Set<number>();
  for (const page of value) {
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) continue;
    pages.add(page);
  }
  if (pages.size === 0) return undefined;
  return [...pages].sort((a, b) => a - b);
}

/** Testo dell'avviso di analisi parziale, ricalcolato a ogni ripresa. */
export function circularPartialNotice(unanalyzedPages: number[]): string {
  return `Analisi parziale: ${unanalyzedPages.length === 1 ? "pagina non analizzata" : "pagine non analizzate"}: ${unanalyzedPages.join(", ")}. Controllale nel documento originale.`;
}

/**
 * Identità "duplicato esatto" di un impegno estratto: gli stessi campi che il
 * server usa per deduplicare fra pagine. `tempId`, selezione e modifiche
 * dell'utente non ne fanno parte: un impegno già a schermo resta quello che è.
 */
export function circularItemKey(item: ExtractedItem): string {
  return JSON.stringify([
    (item.date ?? "").trim(),
    (item.title ?? "").trim(),
    (item.startTime ?? "").trim(),
    (item.endTime ?? "").trim(),
    (item.className ?? "").trim(),
    item.recipientGrades ?? [],
    item.recipientClasses ?? [],
  ]);
}

/**
 * Unione della ripresa: i nuovi impegni si AGGIUNGONO in coda a quelli già a
 * schermo. Nessun impegno esistente viene sostituito o riordinato, quindi
 * modifiche manuali, selezioni ed eliminazioni restano intatte; i duplicati
 * esatti non vengono aggiunti. L'ordine finale segue le pagine perché le
 * pagine riprese sono, per costruzione, successive a quelle già analizzate.
 */
export function mergeCircularItems(existing: ExtractedItem[], incoming: ExtractedItem[]): ExtractedItem[] {
  const seenKeys = new Set(existing.map(circularItemKey));
  const seenIds = new Set(existing.map((item) => item.tempId));
  const added: ExtractedItem[] = [];
  for (const item of incoming) {
    const key = circularItemKey(item);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    // `tempId` è generato da un timestamp: una collisione renderebbe
    // indistinguibili due righe nelle selezioni e nelle eliminazioni.
    let tempId = item.tempId;
    while (seenIds.has(tempId)) tempId = `${tempId}-r`;
    seenIds.add(tempId);
    added.push(tempId === item.tempId ? item : { ...item, tempId });
  }
  return added.length === 0 ? existing : [...existing, ...added];
}

export const CIRCULAR_NETWORK_MESSAGE =
  "Impossibile raggiungere il servizio di analisi. Controlla la connessione e riprova.";
export const CIRCULAR_TIMEOUT_MESSAGE =
  "L'analisi sta impiegando troppo tempo. Riprova tra poco.";
export const CIRCULAR_RATE_LIMIT_MESSAGE =
  "Il servizio di analisi è temporaneamente occupato. Riprova tra poco.";
export const CIRCULAR_PROVIDER_MESSAGE =
  "Il documento non è stato elaborato dal servizio AI. Riprova tra poco.";
export const CIRCULAR_INPUT_MESSAGE =
  "La richiesta non è stata accettata. Controlla il documento e riprova.";
export const CIRCULAR_TOO_LARGE_MESSAGE =
  "Il documento è troppo grande: massimo 5 MB.";
export const CIRCULAR_UNSUPPORTED_MESSAGE =
  "Formato non supportato. Usa PDF, PNG, JPEG o WebP.";

export const CIRCULAR_ERROR_CODES = [
  "INVALID_INPUT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA",
  "RATE_LIMITED",
  "AI_UNAVAILABLE",
  "AI_TIMEOUT",
  "SERVER_ERROR",
  "NETWORK",
  "CLIENT_TIMEOUT",
] as const;
export type CircularAnalysisErrorCode = (typeof CIRCULAR_ERROR_CODES)[number];

const SERVER_ERROR_CODES = new Set<string>([
  "INVALID_INPUT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA",
  "RATE_LIMITED",
  "AI_UNAVAILABLE",
  "AI_TIMEOUT",
  "SERVER_ERROR",
]);

const LOCAL_TEXT_FALLBACK = new Set<CircularAnalysisErrorCode>([
  "NETWORK",
  "CLIENT_TIMEOUT",
  "AI_UNAVAILABLE",
  "AI_TIMEOUT",
  "SERVER_ERROR",
]);

export interface AnalyzeCircularOptions {
  /** Solo test: non cambia il contratto della POST. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Timeout portabile. `AbortSignal.timeout` manca su iOS Safari < 16: chiamarlo
 * lanciava un TypeError scambiato per rete irraggiungibile.
 */
export function createCircularTimeout(ms: number): { signal: AbortSignal; expired: () => boolean; clear: () => void } {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    const signal = AbortSignal.timeout(ms);
    return { signal, expired: () => signal.aborted, clear: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, expired: () => controller.signal.aborted, clear: () => clearTimeout(timer) };
}

export function isCircularClientTimeout(error: unknown, expired: boolean): boolean {
  if (expired) return true;
  const name = error instanceof Error ? error.name : "";
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Frase del server già pensata per l'utente. Rifiuta HTML, JSON, percent-encoding,
 * chiavi e blocchi che sembrano documento o base64: in quel caso si usa il
 * messaggio di categoria, non il corpo grezzo.
 */
export function isSafeCircularServerMessage(message: unknown): message is string {
  if (typeof message !== "string") return false;
  const trimmed = message.trim();
  if (trimmed.length < 1 || trimmed.length > 240) return false;
  if (/[\r\n]/.test(trimmed)) return false;
  if (/[%{}<>]/.test(trimmed)) return false;
  if (/api[_ -]?key|bearer\s|stack|gemini_|base64|eyj[a-z0-9]|begin |data:image|data:application|\bprompt\b/i.test(trimmed)) return false;
  if (/[A-Za-z0-9+/]{48,}={0,2}/.test(trimmed)) return false;
  return true;
}

export function circularErrorCodeForHttp(status: number, errorCode: unknown): CircularAnalysisErrorCode {
  if (typeof errorCode === "string" && SERVER_ERROR_CODES.has(errorCode)) return errorCode as CircularAnalysisErrorCode;
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 415) return "UNSUPPORTED_MEDIA";
  if (status === 429) return "RATE_LIMITED";
  if (status === 408 || status === 504) return "AI_TIMEOUT";
  if (status === 404 || status === 502 || status === 503) return "AI_UNAVAILABLE";
  if (status >= 500) return "SERVER_ERROR";
  return "INVALID_INPUT";
}

export function circularPublicMessage(code: CircularAnalysisErrorCode, serverMessage?: string): string {
  if (isSafeCircularServerMessage(serverMessage)) return serverMessage.trim();
  switch (code) {
    case "NETWORK": return CIRCULAR_NETWORK_MESSAGE;
    case "CLIENT_TIMEOUT":
    case "AI_TIMEOUT": return CIRCULAR_TIMEOUT_MESSAGE;
    case "RATE_LIMITED": return CIRCULAR_RATE_LIMIT_MESSAGE;
    case "PAYLOAD_TOO_LARGE": return CIRCULAR_TOO_LARGE_MESSAGE;
    case "UNSUPPORTED_MEDIA": return CIRCULAR_UNSUPPORTED_MESSAGE;
    case "INVALID_INPUT": return CIRCULAR_INPUT_MESSAGE;
    default: return CIRCULAR_PROVIDER_MESSAGE;
  }
}

function hasImage(req: AnalyzeRequest): boolean {
  return typeof req.imageBase64 === "string" && req.imageBase64.length > 0;
}

function canUseLocalTextFallback(req: AnalyzeRequest, code: CircularAnalysisErrorCode): boolean {
  // Foto e PDF non hanno un parser locale: non simularlo.
  if (hasImage(req)) return false;
  if (!req.text?.trim()) return false;
  return LOCAL_TEXT_FALLBACK.has(code);
}

function finishFailure(req: AnalyzeRequest, code: CircularAnalysisErrorCode, serverMessage?: string): AnalyzeResult {
  const fallback = canUseLocalTextFallback(req, code);
  // Solo il codice, mai il corpo della risposta (potrebbe non essere sicuro).
  console.warn(`Analisi circolare: codice=${code}${fallback ? " fallback=locale" : ""}.`);
  if (fallback) {
    return { success: true, source: "offline-local", items: parseCircularText(req.text ?? "", req.profile, req.defaultLocation) };
  }
  return {
    success: false,
    source: "unavailable",
    items: [],
    error: circularPublicMessage(code, serverMessage),
    errorCode: code,
  };
}

export async function analyzeCircular(req: AnalyzeRequest, options: AnalyzeCircularOptions = {}): Promise<AnalyzeResult> {
  // navigator.onLine non è una prova che il backend risponda: la POST parte sempre.
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeout = createCircularTimeout(options.timeoutMs ?? CIRCULAR_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl("/api/analyze-circular", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: timeout.signal,
    });
  } catch (error) {
    const expired = timeout.expired();
    timeout.clear();
    return finishFailure(req, isCircularClientTimeout(error, expired) ? "CLIENT_TIMEOUT" : "NETWORK");
  }
  timeout.clear();
  // Risposta arrivata, anche se non è JSON: non è un errore di rete.
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || data.success !== true) {
    const code = circularErrorCodeForHttp(response.status, data.errorCode);
    const serverMessage = typeof data.error === "string" ? data.error : undefined;
    return finishFailure(req, code, serverMessage);
  }
  try {
    return {
      success: true,
      source: typeof data.source === "string" && data.source ? data.source : "server",
      items: normalizeExtractedItems(data.items, req.profile, req.defaultLocation),
      notice: typeof data.notice === "string" && data.notice.trim() ? data.notice.trim() : undefined,
      unanalyzedPages: sanitizeUnanalyzedPages(data.unanalyzedPages),
    };
  } catch {
    return finishFailure(req, "SERVER_ERROR");
  }
}
