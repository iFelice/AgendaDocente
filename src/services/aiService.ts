import type { ExtractedItem, TeacherProfile } from "../types";
import { parseCircularText, normalizeExtractedItems } from "../utils/circularParser";
export { parseCircularText as clientSideLocalParser } from "../utils/circularParser";

export interface AnalyzeRequest {
  text?: string; imageBase64?: string; mimeType?: string;
  profile: TeacherProfile; defaultLocation?: string;
}
export interface AnalyzeResult {
  success: boolean; source: string; items: ExtractedItem[]; error?: string;
  /** Codice applicativo, mai mostrato nell'interfaccia. */
  errorCode?: CircularAnalysisErrorCode;
}

/** Attesa della POST. Il server chiude a 45 s; qui resta un margine. */
export const CIRCULAR_REQUEST_TIMEOUT_MS = 60_000;

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
    };
  } catch {
    return finishFailure(req, "SERVER_ERROR");
  }
}
