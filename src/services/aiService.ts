import type { ExtractedItem, TeacherProfile } from "../types";
import { parseCircularText, normalizeExtractedItems } from "../utils/circularParser";
export { parseCircularText as clientSideLocalParser } from "../utils/circularParser";

export interface AnalyzeRequest {
  text?: string; imageBase64?: string; mimeType?: string;
  profile: TeacherProfile; defaultLocation?: string;
}
export interface AnalyzeResult {
  success: boolean; source: string; items: ExtractedItem[]; error?: string;
  /** Codice applicativo stabile del server (diagnostica): mai mostrato nell'interfaccia. */
  errorCode?: string;
}

/** Attesa massima della risposta (oltre il deadline server di 45 s, più margine). */
export const CIRCULAR_REQUEST_TIMEOUT_MS = 60_000;

/** La richiesta NON ha raggiunto/ricevuto risposta dal server: solo qui ha senso parlare di connessione. */
export const CIRCULAR_NETWORK_MESSAGE =
  "Impossibile raggiungere il servizio di analisi. Controlla la connessione e riprova.";
/** Timeout lato client: il server non ha risposto entro CIRCULAR_REQUEST_TIMEOUT_MS. */
export const CIRCULAR_TIMEOUT_MESSAGE =
  "L'analisi sta impiegando troppo tempo. Riprova tra poco.";

/**
 * Timeout portabile: `AbortSignal.timeout` non esiste su iOS Safari < 16, dove
 * chiamarlo lanciava un TypeError scambiato per rete irraggiungibile. Il
 * fallback con AbortController mantiene lo stesso comportamento.
 */
function createCircularTimeout(ms: number): { signal: AbortSignal; expired: () => boolean; clear: () => void } {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    const signal = AbortSignal.timeout(ms);
    return { signal, expired: () => signal.aborted, clear: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, expired: () => controller.signal.aborted, clear: () => clearTimeout(timer) };
}

/**
 * Messaggio per una risposta HTTP non riuscita: il messaggio del server (già
 * pensato per l'utente e privo di contenuto del documento) ha la precedenza;
 * in sua assenza una classe di errore per stato, senza codici tecnici.
 */
export function circularHttpErrorMessage(status: number, serverMessage: string): string {
  const message = serverMessage.trim();
  if (message) return message;
  switch (status) {
    case 400: return "La richiesta non è stata accettata. Verifica il documento e riprova.";
    case 413: return "Il documento è troppo grande: massimo 5 MB.";
    case 415: return "Formato non supportato: usa una foto (JPEG, PNG, WebP) o un PDF oppure incolla il testo.";
    case 429: return "Il servizio di analisi è temporaneamente occupato. Riprova tra poco.";
    case 502: case 503: case 504: return "Il documento non è stato elaborato dal servizio AI. Riprova tra poco.";
    default: return status >= 500
      ? "Il servizio di analisi ha restituito un errore. Riprova più tardi."
      : "Analisi non riuscita. Riprova.";
  }
}

function unavailable(error: string, errorCode?: string): AnalyzeResult {
  return { success: false, source: 'unavailable', items: [], error, ...(errorCode ? { errorCode } : {}) };
}

/**
 * Analisi circolare via server. Gestione errori distinta per categoria:
 *  - fetch rifiutata (rete/timeout): il server NON ha risposto; il parser
 *    locale resta disponibile solo per input testuale, per foto/PDF nessun
 *    fallback simulato;
 *  - risposta HTTP di errore: status e messaggio sicuro del server preservati
 *    (mai trasformati in un falso problema di connessione);
 *  - nessun dettaglio tecnico (status, codici, stack) nel messaggio utente.
 */
export async function analyzeCircular(req: AnalyzeRequest, options?: { timeoutMs?: number }): Promise<AnalyzeResult> {
  const timeout = createCircularTimeout(options?.timeoutMs ?? CIRCULAR_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch("/api/analyze-circular", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req), signal: timeout.signal,
    });
  } catch {
    timeout.clear();
    // Solo qui la richiesta non è mai arrivata a buon fine: rete interrotta o timeout.
    if (!req.imageBase64 && req.text?.trim()) {
      return { success: true, source: 'offline-local', items: parseCircularText(req.text, req.profile, req.defaultLocation) };
    }
    if (timeout.expired()) return unavailable(CIRCULAR_TIMEOUT_MESSAGE);
    return unavailable(CIRCULAR_NETWORK_MESSAGE);
  }
  timeout.clear();
  // Risposta non JSON (pagina di un proxy, errore HTML): mai "successo", mai un crash.
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || data.success !== true) {
    // Diagnostica minima: solo stato HTTP e codice applicativo, mai contenuto del documento.
    const errorCode = typeof data.errorCode === "string" ? data.errorCode : undefined;
    console.warn(`[aiService] analyze-circular: risposta HTTP ${response.status}${errorCode ? ` codice=${errorCode}` : ""}.`);
    const serverMessage = typeof data.error === "string" ? data.error : "";
    return unavailable(circularHttpErrorMessage(response.status, serverMessage), errorCode);
  }
  return { success: true, source: (typeof data.source === "string" && data.source) || 'server', items: normalizeExtractedItems(data.items, req.profile, req.defaultLocation) };
}
