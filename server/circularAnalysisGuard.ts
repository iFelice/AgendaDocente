import { type RequestHandler, type ErrorRequestHandler } from 'express';
import {
  ANALYSIS_LIMITS,
  AnalysisInputError,
  createAnalysisErrorHandler,
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

/** Handler di errore storico (include `items: []` per compatibilità). */
export const analysisErrorHandler: ErrorRequestHandler = createAnalysisErrorHandler(true);
