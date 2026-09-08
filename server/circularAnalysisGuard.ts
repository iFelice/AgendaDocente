import express, { type RequestHandler, type ErrorRequestHandler } from 'express';
import { isIP } from 'node:net';

export const ANALYSIS_LIMITS = { textChars: 100_000, fileBytes: 5 * 1024 * 1024, jsonBytes: 8 * 1024 * 1024 };
const supportedFiles = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max;
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const strings = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every(x => text(x));

export class AnalysisInputError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const invalid = () => { throw new AnalysisInputError(400, 'Richiesta di analisi non valida.'); };

export function validateAnalysisPayload(body: unknown): void {
  if (!record(body)) return invalid();
  if (Object.keys(body).some(k => !['text','imageBase64','mimeType','profile','defaultLocation'].includes(k))) return invalid();
  if (typeof body.text === 'string' && body.text.length > ANALYSIS_LIMITS.textChars) throw new AnalysisInputError(413, 'Testo troppo lungo: massimo 100.000 caratteri.');
  if (!optional(body.text, v => text(v, ANALYSIS_LIMITS.textChars)) || !optional(body.defaultLocation, v => text(v))) return invalid();
  if (!optional(body.mimeType, v => text(v, 64))) return invalid();
  if (body.mimeType !== undefined && ![...supportedFiles, 'text/plain'].includes(body.mimeType as string)) throw new AnalysisInputError(415, 'Formato non supportato. Usa PDF, PNG, JPEG, WebP o testo.');
  const p = body.profile;
  if (!record(p) || !text(p.id) || !text(p.fullName) || !text(p.schoolName) || !text(p.schoolYear, 9)
    || !/^\d{4}\/\d{4}$/.test(p.schoolYear) || !['primarySubjects','classes','campuses'].every(k => strings(p[k]))
    || !optional(p.schoolLevel, v => ['infanzia','primaria','ssig','ssiig'].includes(v as string))
    || !optional(p.isSupportTeacher, v => typeof v === 'boolean') || !optional(p.assignedStudents, strings)
    || !['email','googleCalendarAccount'].every(k => optional(p[k], v => text(v)))
    || !optional(p.googleCalendarLinked, v => typeof v === 'boolean')
    || !Array.isArray(p.roles) || p.roles.length > 30
    || !p.roles.every(r => record(r) && ['coordinatore','segretario','tutor','referente','docente_sostegno','referente_inclusione','membro_gli'].includes(r.role as string)
      && optional(r.targetClass, v => text(v)) && optional(r.description, v => text(v, 1000)))) return invalid();
  const profileKeys = ['id','fullName','schoolName','schoolYear','primarySubjects','classes','campuses','schoolLevel','isSupportTeacher','assignedStudents','email','googleCalendarAccount','googleCalendarLinked','roles'];
  if (Object.keys(p).some(k => !profileKeys.includes(k))) return invalid();
  if (body.imageBase64 !== undefined) {
    if (typeof body.imageBase64 !== 'string' || !body.imageBase64) return invalid();
    if (!supportedFiles.includes(body.mimeType as string)) return invalid();
    const base64 = body.imageBase64;
    if (base64.length > Math.ceil(ANALYSIS_LIMITS.fileBytes / 3) * 4) throw new AnalysisInputError(413, 'File troppo grande: massimo 5 MB.');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return invalid();
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > ANALYSIS_LIMITS.fileBytes) throw new AnalysisInputError(413, 'File troppo grande: massimo 5 MB.');
    if (bytes.toString('base64') !== base64) return invalid();
    const matchingSignature = body.mimeType === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-'
      : body.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : body.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
    if (!matchingSignature) return invalid();
  } else if (supportedFiles.includes(body.mimeType as string) || !text(body.text, ANALYSIS_LIMITS.textChars) || !body.text.trim()) return invalid();
}

/** Process-local limits: 10 requests/minute per socket IP, 60 globally, 4 in flight. */
export function circularAnalysisGuards(options: { now?: () => number; perIp?: number; global?: number; concurrent?: number } = {}) {
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
      }).flat().slice(0,4).join(':') : address;
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 1000) { res.setHeader('Retry-After', '60'); return res.status(429).json({ success:false, items:[], error:'Troppe richieste. Riprova tra un minuto.' }); }
      bucket = { count: 0, expires: time + windowMs }; buckets.set(key, bucket);
    }
    bucket.count++; globalBucket.count++;
    if (bucket.count > (options.perIp ?? 10) || globalBucket.count > (options.global ?? 60) || active >= (options.concurrent ?? 4)) {
      res.setHeader('Retry-After', '60'); return res.status(429).json({ success:false, items:[], error:'Troppe richieste. Riprova tra un minuto.' });
    }
    active++;
    let released = false;
    const release = () => { if (!released) { active--; released = true; } };
    res.once('finish', release); res.once('close', release);
    next();
  };
  const requireJson: RequestHandler = (req,res,next) => {
    res.setHeader('Cache-Control','no-store');
    if (!req.is('application/json')) return res.status(415).json({ success:false, items:[], error:'Invia una richiesta JSON.' });
    next();
  };
  const validate: RequestHandler = (req,res,next) => {
    try { validateAnalysisPayload(req.body); next(); }
    catch (error) { next(error); }
  };
  return [limit, requireJson, express.json({ limit: ANALYSIS_LIMITS.jsonBytes, inflate: false }), validate];
}

export const analysisErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = error instanceof AnalysisInputError ? error.status : error?.type === 'entity.too.large' ? 413 : error?.status === 415 ? 415 : 400;
  const message = error instanceof AnalysisInputError ? error.message : status === 413 ? 'Richiesta troppo grande.' : 'Richiesta di analisi non valida.';
  // Never echo parsing errors (which may contain the raw document) or exception details.
  res.setHeader('Cache-Control','no-store');
  res.status(status).json({ success:false, items:[], error:message });
};
