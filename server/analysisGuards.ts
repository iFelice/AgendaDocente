import express, { type RequestHandler, type ErrorRequestHandler } from 'express';
import { isIP } from 'node:net';
import { TEACHER_ROLE_KINDS, type TeacherRoleKind } from '../src/types';
import { isValidTime } from '../src/utils/dates';

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

/** Metadata-only Google CalendarList cache; deliberately kept server-local. */
function googleCalendarListCache(v: unknown): boolean {
  const keys = ['id', 'summary', 'primary', 'accessRole'];
  return Array.isArray(v) && v.length <= 500 && v.every(calendar => record(calendar)
    && typeof calendar.id === 'string' && calendar.id.length > 0 && calendar.id.length <= 512
    && typeof calendar.summary === 'string'
    && optional(calendar.primary, value => typeof value === 'boolean')
    && optional(calendar.accessRole, value => typeof value === 'string')
    && !Object.keys(calendar).some(key => !keys.includes(key)));
}

const SCHOOL_LEVELS = ['infanzia', 'primaria', 'ssig', 'ssiig'];
/**
 * Ore settimanali: numero finito e non negativo, come nello schema di sync
 * (remoteSchema.isValidProfilePayload). Nessun tetto artificiale: l'editor del
 * profilo accetta fino a 100 ore dichiarate e non limita le ore di un altro
 * istituto, quindi un valore più alto è un profilo legittimo che l'analisi non
 * deve respingere. I limiti strutturali restano allow-list e numero di istituti.
 */
const hours = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Intero entro un intervallo chiuso: stesso predicato usato dai validatori di
 * backup (dayPeriodsInt) e di sync (intWithin).
 */
const intWithin = (v: unknown, min: number, max: number): boolean =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/**
 * SchoolProfile.dayPeriods — struttura della giornata scolastica dell'istituto.
 *
 * Soglie IDENTICHE a backup (src/services/backup.ts, dayPeriodsValidator) e a
 * sync (src/services/sync/remoteSchema.ts, isValidSchoolDayPeriods):
 * ordinario 1..12, giorni ammessi solo "1".."6", ore aggiuntive 0..11.
 * Accettare qui una forma che sync poi rifiuta produrrebbe profili analizzabili
 * ma non sincronizzabili; accettarla senza validarla riaprirebbe un buco nella
 * allow-list chiusa. Il predicato resta duplicato e indipendente di proposito
 * (nessuna dipendenza fra server e servizi client): ad allinearlo sono i test.
 */
function dayPeriods(v: unknown): boolean {
  return record(v)
    && optional(v.ordinaryPeriodsPerDay, n => intWithin(n, 1, 12))
    && optional(v.extraPeriodsByDay, map => record(map)
      && Object.entries(map).every(([day, extra]) => /^[1-6]$/.test(day) && intWithin(extra, 0, 11)))
    && !Object.keys(v).some(k => !['ordinaryPeriodsPerDay', 'extraPeriodsByDay'].includes(k));
}

/** Un singolo PeriodSlot di customSlots: ora di fine sempre dopo quella di inizio. */
function periodSlot(v: unknown): boolean {
  return record(v) && Number.isInteger(v.periodNumber) && (v.periodNumber as number) > 0
    && isValidTime(v.startTime) && isValidTime(v.endTime) && (v.endTime as string) > (v.startTime as string)
    && optional(v.label, x => text(x))
    && !Object.keys(v).some(k => !['periodNumber', 'label', 'startTime', 'endTime'].includes(k));
}

/**
 * SchoolProfile.timeSlotConfig — le "campane" dell'istituto. Vincoli allineati
 * a backup (timeSlotConfigValidator): orari HH:MM, periodsPerDay e
 * standardDurationMinutes interi positivi, customSlots opzionale e coerente.
 */
function timeSlotConfig(v: unknown): boolean {
  return record(v) && isValidTime(v.firstHourStartTime)
    && Number.isInteger(v.periodsPerDay) && (v.periodsPerDay as number) > 0
    && Number.isInteger(v.standardDurationMinutes) && (v.standardDurationMinutes as number) > 0
    && optional(v.customSlots, slots => Array.isArray(slots) && slots.every(periodSlot))
    && !Object.keys(v).some(k => !['firstHourStartTime', 'periodsPerDay', 'standardDurationMinutes', 'customSlots'].includes(k));
}

/**
 * Istituti del modello multi-scuola (SchoolProfile): forma nota e limitata,
 * mai chiavi impreviste. È un campo reale del profilo salvato dall'app, quindi
 * deve essere accettato: rifiutarlo blocca ogni analisi documentale.
 *
 * `dayPeriods` e `timeSlotConfig` sono campi reali aggiunti dai passi C/G
 * (struttura della giornata e fasce orarie per istituto). Finché mancavano dalla
 * allow-list, un istituto configurato con la 7ª ora faceva fallire
 * validateTeacherProfile() e lo scanner dell'orario rispondeva 400
 * "Richiesta di analisi non valida." prima ancora di interpellare il modello.
 */
function schools(v: unknown): boolean {
  const keys = ['id', 'name', 'institutionalEmail', 'campuses', 'schoolLevel', 'weeklyHours', 'isPrimary', 'active', 'dayPeriods', 'timeSlotConfig'];
  return Array.isArray(v) && v.length <= 10 && v.every(s => record(s) && text(s.id) && text(s.name)
    && optional(s.institutionalEmail, x => text(x)) && optional(s.campuses, strings)
    && optional(s.schoolLevel, x => SCHOOL_LEVELS.includes(x as string)) && optional(s.weeklyHours, hours)
    && optional(s.isPrimary, x => typeof x === 'boolean') && optional(s.active, x => typeof x === 'boolean')
    && optional(s.dayPeriods, dayPeriods) && optional(s.timeSlotConfig, timeSlotConfig)
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
    || !optional(p.googleCalendarImportIds, strings)
    || !optional(p.googleCalendarListCache, googleCalendarListCache)
    || !optional(p.weeklyDeclaredHours, hours) || !optional(p.schools, schools)
    || !Array.isArray(p.roles) || p.roles.length > 30
    || !p.roles.every(r => record(r) && TEACHER_ROLE_KINDS.includes(r.role as TeacherRoleKind)
      && optional(r.targetClass, v => text(v)) && optional(r.description, v => text(v, 1000)) && optional(r.label, v => text(v)))) return invalid();
  const profileKeys = ['id', 'fullName', 'schoolName', 'schoolYear', 'primarySubjects', 'classes', 'campuses', 'schoolLevel', 'isSupportTeacher', 'assignedStudents', 'email', 'googleCalendarAccount', 'googleCalendarLinked', 'googleCalendarImportIds', 'googleCalendarListCache', 'roles', 'weeklyDeclaredHours', 'schools'];
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
    const perIp = options.perIp ?? (process.env.TEST_RATE_LIMIT === 'relaxed' ? 10_000 : 10);
    const globalLimit = options.global ?? (process.env.TEST_RATE_LIMIT === 'relaxed' ? 50_000 : 60);
    if (bucket.count > perIp || globalBucket.count > globalLimit || active >= (options.concurrent ?? 4)) {
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
 * Stato e messaggio pubblico di un errore di input. Mai lo stack, mai il body:
 * il messaggio di AnalysisInputError è già una frase fissa, gli altri casi
 * usano solo frasi fisse.
 */
export function analysisFailure(error: unknown): { status: number; message: string } {
  const candidate = error as { status?: unknown; type?: unknown } | null;
  const status = error instanceof AnalysisInputError ? error.status
    : candidate?.type === 'entity.too.large' ? 413
    : candidate?.status === 415 ? 415
    : 400;
  const message = error instanceof AnalysisInputError ? error.message
    : status === 413 ? 'Richiesta troppo grande.'
    : 'Richiesta di analisi non valida.';
  return { status, message };
}

/**
 * Handler di errore generico: mai dettagli del parsing o del contenuto
 * (potrebbero contenere il documento). `withItems` mantiene la forma storica
 * { items: [] } usata dall'endpoint circolare.
 */
export function createAnalysisErrorHandler(withItems: boolean): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    const { status, message } = analysisFailure(error);
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(withItems ? { success: false, items: [], error: message } : { success: false, error: message });
  };
}
