/**
 * Client delle endpoint di analisi documenti ("Scansiona documento").
 *
 * Privacy:
 *  - l'immagine/PDF (base64) vive solo in memoria ed è inviata all'endpoint;
 *  - dopo la risposta il chiamante DEVE scartare il base64 (niente persistenza);
 *  - errori generici: nessun contenuto del documento nei messaggi o nei log.
 */

import type { TeacherProfile } from "../types";
import { OFFLINE_ANALYSIS_MESSAGE, isOnline } from "../utils/documentScanner";

export type ScanTimetableDocumentType = "personal-support-timetable" | "curricular-timetable";

export interface ScanTimetableRequest {
  imageBase64: string;
  mimeType: string;
  documentType: ScanTimetableDocumentType;
  profile: TeacherProfile;
}

export interface ScanTimetableResult {
  success: boolean;
  source?: string;
  error?: string;
  /** Righe della colonna docenti (orario personale). */
  rows?: string[];
  /** Righe docente curricolare: label/materia/classi (orario curricolare). */
  curricularRows?: Array<{ rowIndex: number; rowLabel?: string; subject?: string; classes?: string[] }>;
  /** Celle grezze della griglia giorno/periodo (validate a runtime). */
  cells?: Array<{ rowIndex: number; dayOfWeek: number; periodIndex: number; raw: string }>;
}

export interface ScanStudentDocumentRequest {
  imageBase64: string;
  mimeType: string;
  profile: TeacherProfile;
}

export interface ScanStudentDocumentResult {
  success: boolean;
  source?: string;
  error?: string;
  commitments?: unknown[];
}

class OfflineAnalysisError extends Error {
  constructor() {
    super(OFFLINE_ANALYSIS_MESSAGE);
    this.name = "OfflineAnalysisError";
  }
}

/** Attesa massima della risposta: oltre il timeout del server (45 s) più margine. */
export const SCAN_REQUEST_TIMEOUT_MS = 90_000;

export const NETWORK_ANALYSIS_MESSAGE =
  "Impossibile raggiungere il servizio di analisi. Controlla la connessione e riprova.";
export const TIMEOUT_ANALYSIS_MESSAGE =
  "L'analisi sta richiedendo troppo tempo. Riprova con una foto più ravvicinata e leggibile.";

/**
 * Timeout portabile: `AbortSignal.timeout` non esiste su iOS Safari < 16, dove
 * chiamarlo lanciava un TypeError che veniva scambiato per rete irraggiungibile.
 * Il fallback con AbortController mantiene lo stesso comportamento.
 */
function createScanTimeout(ms: number): { signal: AbortSignal; expired: () => boolean; clear: () => void } {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    const signal = AbortSignal.timeout(ms);
    return { signal, expired: () => signal.aborted, clear: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, expired: () => controller.signal.aborted, clear: () => clearTimeout(timer) };
}

/**
 * Messaggio per una risposta non riuscita: una classe di errore per ogni caso,
 * senza status code né dettagli tecnici. Il messaggio del server (già pensato
 * per l'utente e privo di contenuto del documento) ha la precedenza.
 */
export function scanAnalysisErrorMessage(status: number, serverMessage: string): string {
  if (serverMessage) return serverMessage;
  switch (status) {
    case 400: return "La richiesta non è stata accettata. Scatta di nuovo il documento e riprova.";
    case 404: return "L'analisi documenti non è disponibile in questa versione del servizio. Aggiorna l'app e riprova.";
    case 413: return "Il documento è troppo grande: massimo 5 MB.";
    case 415: return "Formato non supportato: usa una foto (JPEG, PNG, WebP) o un PDF.";
    case 429: return "Troppe analisi in questo momento: riprova tra un minuto.";
    case 502: case 503: case 504: return "Il servizio di analisi è temporaneamente non disponibile: riprova più tardi.";
    default: return status >= 500
      ? "Il servizio di analisi ha restituito un errore: riprova più tardi."
      : "Analisi non riuscita. Riprova.";
  }
}

async function postScan(endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  if (!isOnline()) throw new OfflineAnalysisError();
  const timeout = createScanTimeout(SCAN_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
  } catch {
    timeout.clear();
    // Solo qui la richiesta non è mai arrivata a buon fine: offline, timeout o rete interrotta.
    if (!isOnline()) throw new OfflineAnalysisError();
    if (timeout.expired()) throw new Error(TIMEOUT_ANALYSIS_MESSAGE);
    throw new Error(NETWORK_ANALYSIS_MESSAGE);
  }
  timeout.clear();
  // Risposta non JSON (pagina di un proxy, errore HTML): mai "successo", mai un crash.
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || data.success !== true) {
    // Diagnostica minima: solo lo stato HTTP, mai il contenuto del documento.
    console.warn(`Analisi documento: risposta ${response.status} da ${endpoint}.`);
    throw new Error(scanAnalysisErrorMessage(response.status, typeof data.error === "string" ? data.error.trim() : ""));
  }
  return data;
}

/** Analizza una foto/PDF di un orario (personale o curricolare). */
export async function analyzeTimetableDocument(req: ScanTimetableRequest): Promise<ScanTimetableResult> {
  const data = await postScan("/api/analyze-timetable", req);
  const result: ScanTimetableResult = {
    success: true,
    source: typeof data.source === "string" ? data.source : undefined,
    cells: Array.isArray(data.cells) ? (data.cells as ScanTimetableResult["cells"]) : [],
  };
  if (Array.isArray(data.rows)) result.rows = data.rows.map(String);
  if (Array.isArray(data.curricularRows)) result.curricularRows = data.curricularRows as ScanTimetableResult["curricularRows"];
  return result;
}

/** Analizza una foto/appunti di registro per estrarre impegni alunni. */
export async function analyzeStudentDocument(req: ScanStudentDocumentRequest): Promise<ScanStudentDocumentResult> {
  const data = await postScan("/api/analyze-student-document", req);
  return {
    success: true,
    source: typeof data.source === "string" ? data.source : undefined,
    commitments: Array.isArray(data.commitments) ? data.commitments : [],
  };
}
