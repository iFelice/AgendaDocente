import { type RequestHandler, type ErrorRequestHandler } from 'express';
import {
  ANALYSIS_LIMITS,
  AnalysisInputError,
  analysisFailure,
  createAnalysisGuards,
  supportedFiles,
  validateImageFields,
  validateTeacherProfile,
  type AnalysisGuardOptions,
} from './analysisGuards';

export { ANALYSIS_LIMITS, AnalysisInputError };
export type { AnalysisGuardOptions };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max;
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const invalid = () => { throw new AnalysisInputError(400, 'Richiesta di analisi non valida.'); };

/**
 * Validazione payload di analyze-circular (forma storica, invariata):
 * testo e/o file, profilo docente, sede predefinita.
 */
export function validateAnalysisPayload(body: unknown): void {
  if (!record(body)) return invalid();
  if (Object.keys(body).some(k => !['text', 'imageBase64', 'mimeType', 'profile', 'defaultLocation'].includes(k))) return invalid();
  if (typeof body.text === 'string' && body.text.length > ANALYSIS_LIMITS.textChars) throw new AnalysisInputError(413, 'Testo troppo lungo: massimo 100.000 caratteri.');
  if (!optional(body.text, v => text(v, ANALYSIS_LIMITS.textChars)) || !optional(body.defaultLocation, v => text(v))) return invalid();
  validateImageFields(body);
  if (body.imageBase64 === undefined) {
    // Senza file serve il testo (la forma storica dell'endpoint).
    if (supportedFiles.includes(body.mimeType as string) || !text(body.text, ANALYSIS_LIMITS.textChars) || !body.text.trim()) return invalid();
  }
  validateTeacherProfile(body.profile);
}

/**
 * Catena di middleware di analyze-circular. La logica (limiti, bucket,
 * validazione, errori) è quella condivisa di analysisGuards: qui resta solo
 * la validazione specifica del payload circolare.
 */
export function circularAnalysisGuards(options: AnalysisGuardOptions = {}): RequestHandler[] {
  return createAnalysisGuards(validateAnalysisPayload, options);
}

/**
 * Codici applicativi stabili di analyze-circular. Restano nel JSON, mai
 * nell'interfaccia: il campo `error` è la frase già sicura per l'utente.
 */
export const CIRCULAR_ERROR_CODES = [
  'INVALID_INPUT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA',
  'RATE_LIMITED',
  'AI_UNAVAILABLE',
  'AI_TIMEOUT',
  'SERVER_ERROR',
] as const;
export type CircularErrorCode = (typeof CIRCULAR_ERROR_CODES)[number];

export function circularErrorCodeForStatus(status: number): CircularErrorCode {
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_MEDIA';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 408 || status === 504) return 'AI_TIMEOUT';
  if (status === 502 || status === 503) return 'AI_UNAVAILABLE';
  if (status >= 500) return 'SERVER_ERROR';
  return 'INVALID_INPUT';
}

/** Foto/PDF senza chiave: frase storica, così il deploy continua a riconoscerla. */
export const CIRCULAR_AI_NOT_CONFIGURED =
  'Analisi di foto/PDF non disponibile. Incolla il testo oppure riprova più tardi.';
export const CIRCULAR_AI_UNAVAILABLE_MESSAGE =
  'Il documento non è stato elaborato dal servizio AI. Riprova tra poco.';
export const CIRCULAR_AI_TIMEOUT_MESSAGE =
  "L'analisi sta impiegando troppo tempo. Riprova tra poco.";
export const CIRCULAR_SERVER_ERROR_MESSAGE = CIRCULAR_AI_UNAVAILABLE_MESSAGE;

/** Categoria Gemini → risposta pubblica. Nessun messaggio grezzo del provider. */
export function circularCloudFailure(category: string): { status: 503; errorCode: 'AI_TIMEOUT' | 'AI_UNAVAILABLE'; error: string } {
  const timedOut = category === 'deadline' || category === 'annullata' || category === 'budget-esaurito';
  return timedOut
    ? { status: 503, errorCode: 'AI_TIMEOUT', error: CIRCULAR_AI_TIMEOUT_MESSAGE }
    : { status: 503, errorCode: 'AI_UNAVAILABLE', error: CIRCULAR_AI_UNAVAILABLE_MESSAGE };
}

export function circularFailureBody(errorCode: CircularErrorCode, error: string) {
  return { success: false as const, items: [] as [], error, errorCode };
}

const SAFE_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const CATEGORY_RE = /^[a-z0-9-]{1,40}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface CircularPayloadSummary {
  mime: string;
  bytes: number | '-';
  textChars: number;
}

/** Solo MIME noto, lunghezza e byte approssimati. Mai testo, base64 o profilo. */
export function summarizeCircularPayload(body: unknown): CircularPayloadSummary {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const mime = typeof record.mimeType === 'string' && SAFE_MIME.has(record.mimeType) ? record.mimeType : '-';
  const textChars = typeof record.text === 'string' ? record.text.length : 0;
  let bytes: number | '-' = '-';
  if (typeof record.imageBase64 === 'string' && record.imageBase64.length > 0) {
    const raw = record.imageBase64;
    const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
    bytes = Math.max(0, Math.floor((raw.length * 3) / 4) - padding);
  }
  return { mime, bytes, textChars };
}

/** Modello:categoria:status. Un nome non ammissibile non viene copiato nel log. */
export function summarizeGeminiAttempts(attempts: Array<{ model?: string; category?: string; status?: number | null }>): string {
  if (attempts.length === 0) return '-';
  return attempts.map((attempt) => {
    const model = typeof attempt.model === 'string' && MODEL_RE.test(attempt.model) ? attempt.model : 'modello';
    const category = typeof attempt.category === 'string' && CATEGORY_RE.test(attempt.category) ? attempt.category : 'sconosciuta';
    const status = typeof attempt.status === 'number' && Number.isFinite(attempt.status) ? String(attempt.status) : '-';
    return `${model}:${category}:${status}`;
  }).join(',');
}

export interface CircularDiagnosticFields {
  esito: string;
  errorCode?: string;
  categoria?: string;
  mime?: string;
  bytes?: number | '-';
  textChars?: number;
  timeout?: 'si' | 'no';
  durataMs?: number;
  tentativi?: string;
  provider?: string;
  status?: number;
  tipo?: string;
  sorgente?: string;
}

const diagnosticSinks = new Set<(line: string) => void>();

/** Osservatore di test: non sostituisce console, così i file di test possono correre in parallelo. */
export function observeCircularDiagnostics(sink: (line: string) => void): () => void {
  diagnosticSinks.add(sink);
  return () => { diagnosticSinks.delete(sink); };
}

export function emitCircularDiagnostic(fields: CircularDiagnosticFields, level: 'warn' | 'log' = 'warn'): string {
  const line = formatCircularDiagnostic(fields);
  if (level === 'log') console.log(line);
  else console.warn(line);
  for (const sink of diagnosticSinks) sink(line);
  return line;
}

/**
 * Riga di log a campi chiusi. Un valore libero (testo del documento, base64,
 * prompt, chiave) non supera i filtri e viene omesso, non copiato nel log.
 */
export function formatCircularDiagnostic(fields: CircularDiagnosticFields): string {
  const mime = fields.mime && SAFE_MIME.has(fields.mime) ? fields.mime : '-';
  const parts = [
    'endpoint=/api/analyze-circular',
    `provider=${fields.provider && /^[a-z-]{1,20}$/.test(fields.provider) ? fields.provider : 'gemini'}`,
    `esito=${/^[a-z-]{1,32}$/.test(fields.esito) ? fields.esito : 'sconosciuto'}`,
  ];
  if (fields.errorCode && /^[A-Z_]{1,32}$/.test(fields.errorCode)) parts.push(`errorCode=${fields.errorCode}`);
  if (fields.categoria && CATEGORY_RE.test(fields.categoria)) parts.push(`categoria=${fields.categoria}`);
  parts.push(`mime=${mime}`);
  parts.push(`bytes=${typeof fields.bytes === 'number' && Number.isFinite(fields.bytes) ? Math.max(0, Math.floor(fields.bytes)) : '-'}`);
  parts.push(`textChars=${typeof fields.textChars === 'number' && Number.isFinite(fields.textChars) ? Math.max(0, Math.floor(fields.textChars)) : 0}`);
  parts.push(`timeout=${fields.timeout === 'si' ? 'si' : 'no'}`);
  if (typeof fields.durataMs === 'number' && Number.isFinite(fields.durataMs)) parts.push(`durataMs=${Math.max(0, Math.floor(fields.durataMs))}`);
  if (typeof fields.status === 'number' && Number.isFinite(fields.status)) parts.push(`status=${fields.status}`);
  if (fields.tipo && /^[A-Za-z]{1,40}$/.test(fields.tipo)) parts.push(`tipo=${fields.tipo}`);
  if (fields.sorgente && /^(?:local-heuristic|[A-Za-z0-9][A-Za-z0-9._:-]{0,63})$/.test(fields.sorgente)) parts.push(`sorgente=${fields.sorgente}`);
  if (fields.tentativi && /^[A-Za-z0-9._:,-]{1,800}$/.test(fields.tentativi)) parts.push(`tentativi=${fields.tentativi}`);
  return `[AI Circolari] ${parts.join(' ')} (nessun contenuto nel log)`;
}

/** Handler di errore storico (include `items: []`) più il codice applicativo. */
export const analysisErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const { status, message } = analysisFailure(error);
  const errorCode = circularErrorCodeForStatus(status);
  const summary = summarizeCircularPayload(req.body);
  emitCircularDiagnostic({
    esito: 'rifiutato',
    errorCode,
    categoria: 'input',
    provider: 'gemini',
    timeout: 'no',
    status,
    mime: summary.mime,
    bytes: summary.bytes,
    textChars: summary.textChars,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ success: false, items: [], error: message, errorCode });
};
