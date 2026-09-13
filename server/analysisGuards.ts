import express, { type RequestHandler, type ErrorRequestHandler } from 'express';
import { isIP } from 'node:net';
import { TEACHER_ROLE_KINDS, type TeacherRoleKind } from '../src/types';

/**
 * Guardia condivisa per gli endpoint di analisi documentale
 * (circolari, orari, registri): rate limiting, JSON, body limit,
 * validazione payload e errori generici.
 *
 * L'endpoint circolare riutilizza questa stessa infrastruttura: la sua
 * configurazione (limiti, bucket, messaggi) non viene toccata.
 */

export const ANALYSIS_LIMITS = { textChars: 100_000, fileBytes: 5 * 1024 * 1024, jsonBytes: 8 * 1024 * 1024 };
export const supportedFiles = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max;
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const strings = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every(x => text(x));
const SCHOOL_LEVELS = ['infanzia', 'primaria', 'ssig', 'ssiig'];
const hours = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 40;

/**
 * Istituti del modello multi-scuola (SchoolProfile): forma nota e limitata,
 * mai chiavi impreviste. È un campo reale del profilo salvato dall'app, quindi
 * deve essere accettato: rifiutarlo blocca ogni analisi documentale.
 */
function schools(v: unknown): boolean {
  const keys = ['id', 'name', 'institutionalEmail', 'campuses', 'schoolLevel', 'weeklyHours', 'isPrimary', 'active'];
  return Array.isArray(v) && v.length <= 10 && v.every(s => record(s) && text(s.id) && text(s.name)
    && optional(s.institutionalEmail, x => text(x)) && optional(s.campuses, strings)
    && optional(s.schoolLevel, x => SCHOOL_LEVELS.includes(x as string)) && optional(s.weeklyHours, hours)
    && optional(s.isPrimary, x => typeof x === 'boolean') && optional(s.active, x => typeof x === 'boolean')
    && !Object.keys(s).some(k => !keys.includes(k)));
}

export class AnalysisInputError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const invalid = () => { throw new AnalysisInputError(400, 'Richiesta di analisi non valida.'); };

/**
 * Confronta il binario (firma) con il MIME dichiarato: un PDF non è mai
 * accettato se non inizia con %PDF-, e così via.
 */
export function payloadMatchesSignature(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return false;
}

/**
 * Valida imageBase64+mimeType: MIME supportato, base64 valido, dimensione,
 * firma coerente con il contenuto reale.
 */
export function validateImageFields(body: Record<string, unknown>): void {
  if (!record(body)) return invalid();
  if (!optional(body.mimeType, v => text(v, 64))) return invalid();
  if (body.mimeType !== undefined && !supportedFiles.includes(body.mimeType as string)) {
    throw new AnalysisInputError(415, 'Formato non supportato. Usa PDF, PNG, JPEG o WebP.');
  }
  if (body.imageBase64 === undefined) return;
  if (typeof body.imageBase64 !== 'string' || !body.imageBase64) return invalid();
  if (!supportedFiles.includes(body.mimeType as string)) return invalid();
  const base64 = body.imageBase64;
  if (base64.length > Math.ceil(ANALYSIS_LIMITS.fileBytes / 3) * 4) throw new AnalysisInputError(413, 'File troppo grande: massimo 5 MB.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return invalid();
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > ANALYSIS_LIMITS.fileBytes) throw new AnalysisInputError(413, 'File troppo grande: massimo 5 MB.');
  if (bytes.toString('base64') !== base64) return invalid();
  if (!payloadMatchesSignature(body.mimeType as string, bytes)) return invalid();
}

/**
 * Validazione del profilo docente (stessa forma attesa da analyze-circular).
 * Accetta ESATTAMENTE i campi che l'app invia davvero: anche `schools` e
 * `weeklyDeclaredHours`, aggiunti al profilo da normalizeTeacherProfile() al
 * salvataggio in ProfileModal e dalla migrazione multi-scuola. Senza di essi
 * ogni profilo reale veniva respinto con 400 "Richiesta di analisi non valida."
 */
export function validateTeacherProfile(p: unknown): void {
  if (!record(p) || !text(p.id) || !text(p.fullName) || !text(p.schoolName) || !text(p.schoolYear, 9)
    || !/^\d{4}\/\d{4}$/.test(p.schoolYear) || !['primarySubjects', 'classes', 'campuses'].every(k => strings(p[k]))
    || !optional(p.schoolLevel, v => SCHOOL_LEVELS.includes(v as string))
    || !optional(p.isSupportTeacher, v => typeof v === 'boolean') || !optional(p.assignedStudents, strings)
    || !['email', 'googleCalendarAccount'].every(k => optional(p[k], v => text(v)))
    || !optional(p.googleCalendarLinked, v => typeof v === 'boolean')
    || !optional(p.weeklyDeclaredHours, hours) || !optional(p.schools, schools)
    || !Array.isArray(p.roles) || p.roles.length > 30
    || !p.roles.every(r => record(r) && TEACHER_ROLE_KINDS.includes(r.role as TeacherRoleKind)
      && optional(r.targetClass, v => text(v)) && optional(r.description, v => text(v, 1000)) && optional(r.label, v => text(v)))) return invalid();
  const profileKeys = ['id', 'fullName', 'schoolName', 'schoolYear', 'primarySubjects', 'classes', 'campuses', 'schoolLevel', 'isSupportTeacher', 'assignedStudents', 'email', 'googleCalendarAccount', 'googleCalendarLinked', 'roles', 'weeklyDeclaredHours', 'schools'];
  if (Object.keys(p).some(k => !profileKeys.includes(k))) return invalid();
}

export interface AnalysisGuardOptions {
  now?: () => number;
  perIp?: number;
  global?: number;
  concurrent?: number;
}

/**
 * Costruisce la catena di middleware [rate-limit, require-json, json, validate]
 * per un endpoint di analisi. I limiti processuali (10 req/min per IP, 60
 * globali, 4 in-flight) sono gli stessi di analyze-circular.
 */
export function createAnalysisGuards(validator: (body: unknown) => void, options: AnalysisGuardOptions = {}): RequestHandler[] {
  const now = options.now || Date.now;
  const windowMs = 60_000;
  const buckets = new Map<string, { count: number; expires: number }>();
  let globalBucket = { count: 0, expires: 0 }, active = 0;
  const limit: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const time = now();
    for (const [key, bucket] of buckets) if (bucket.expires <= time) buckets.delete(key);
    if (globalBucket.expires <= time) globalBucket = { count: 0, expires: time + windowMs };
    // Do not trust user-supplied X-Forwarded-For. Reverse proxies share this budget by default.
    const address = req.socket.remoteAddress || 'unknown';
    // Group IPv6 clients by /64 to avoid bypass by rotating addresses within one network.
    const key = isIP(address) === 6 && !address.startsWith('::ffff:')
      ? new URL(`http://[${address}]/`).hostname.replace(/[\[\]]/g, '').split('::').map((part, i, parts) => {
        const words = part ? part.split(':') : [];
        if (parts.length === 2 && i === 0) return [...words, ...Array(8 - parts.flatMap(p => p ? p.split(':') : []).length).fill('0')];
        return words;
      }).flat().slice(0, 4).join(':') : address;
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 1000) { res.setHeader('Retry-After', '60'); return res.status(429).json({ success: false, error: 'Troppe richieste. Riprova tra un minuto.' }); }
      bucket = { count: 0, expires: time + windowMs }; buckets.set(key, bucket);
    }
    bucket.count++; globalBucket.count++;
    if (bucket.count > (options.perIp ?? 10) || globalBucket.count > (options.global ?? 60) || active >= (options.concurrent ?? 4)) {
      res.setHeader('Retry-After', '60'); return res.status(429).json({ success: false, error: 'Troppe richieste. Riprova tra un minuto.' });
    }
    active++;
    let released = false;
    const release = () => { if (!released) { active--; released = true; } };
    res.once('finish', release); res.once('close', release);
    next();
  };
  const requireJson: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.is('application/json')) return res.status(415).json({ success: false, error: 'Invia una richiesta JSON.' });
    next();
  };
  const validate: RequestHandler = (req, res, next) => {
    try { validator(req.body); next(); }
    catch (error) { next(error); }
  };
  return [limit, requireJson, express.json({ limit: ANALYSIS_LIMITS.jsonBytes, inflate: false }), validate];
}

/**
 * Handler di errore generico: mai dettagli del parsing o del contenuto
 * (potrebbero contenere il documento). `withItems` mantiene la forma storica
 * { items: [] } usata dall'endpoint circolare.
 */
export function createAnalysisErrorHandler(withItems: boolean): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    const status = error instanceof AnalysisInputError ? error.status : error?.type === 'entity.too.large' ? 413 : error?.status === 415 ? 415 : 400;
    const message = error instanceof AnalysisInputError ? error.message : status === 413 ? 'Richiesta troppo grande.' : 'Richiesta di analisi non valida.';
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(withItems ? { success: false, items: [], error: message } : { success: false, error: message });
  };
}
