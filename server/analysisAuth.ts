import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RequestHandler, Response } from 'express';

/**
 * Autenticazione degli endpoint di analisi documentale.
 *
 * Verifica gli ID token Firebase (RS256) con le chiavi pubbliche di Google
 * (account securetoken) e `node:crypto`. Non usa firebase-admin e non richiede
 * un service account: la firma si controlla con le chiavi pubbliche, e il
 * projectId basta per `aud`/`iss`. Le chiavi sono in cache secondo
 * Cache-Control (max-age / s-maxage, meno Age). `no-store` e `no-cache` non
 * vengono riusate.
 *
 * Fail closed: senza project id o senza elenco email gli endpoint rispondono
 * 503 e non analizzano nulla.
 */

/** Certificati x509 usati da Firebase per firmare gli ID token. */
export const SECURETOKEN_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export const ANALYSIS_NOT_CONFIGURED_MESSAGE = 'Analisi non configurata';
export const ANALYSIS_NOT_CONFIGURED_CODE = 'ANALYSIS_NOT_CONFIGURED';
export const ANALYSIS_UNAUTHENTICATED_MESSAGE = 'Sessione scaduta: accedi di nuovo con Google.';
export const ANALYSIS_UNAUTHORIZED_MESSAGE = 'Questo account non è autorizzato all\'analisi dei documenti.';

const MAX_TOKEN_CHARS = 8_192;
const MAX_CERTS_CHARS = 1_000_000;
const CLOCK_SKEW_SEC = 5;
const UNKNOWN_KID_REFRESH_MS = 30_000;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MOTIVO_RE = /^[a-z0-9-]{1,40}$/;

export interface KeyFetchResponse {
  status: number;
  body: string;
  cacheControl: string | null;
  age: string | null;
}

export type AnalysisKeyFetcher = (url: string) => Promise<KeyFetchResponse>;

interface KeyCache {
  keys: Map<string, KeyObject>;
  expiresAt: number;
  fetchedAt: number;
}

let fetcherOverride: AnalysisKeyFetcher | null = null;
let nowOverride: (() => number) | null = null;
let cache: KeyCache | null = null;
let inflight: Promise<Map<string, KeyObject>> | null = null;
let lastFetchAt = 0;

export function analysisFirebaseProjectId(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = env.FIREBASE_PROJECT_ID?.trim() ?? '';
  if (dedicated) return dedicated;
  return env.VITE_FIREBASE_PROJECT_ID?.trim() ?? '';
}

/** Elenco normalizzato, oppure null se la variabile è assente o vuota (fail closed). */
export function parseAnalysisAllowlist(raw: string | undefined): string[] | null {
  if (raw == null || raw.trim() === '') return null;
  const emails = raw.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  return emails.length === 0 ? null : emails;
}

/**
 * Freschezza residua in millisecondi. `null` = non riusare la risposta.
 * `s-maxage` prevale su `max-age` (siamo una cache condivisa fra le richieste).
 */
export function remainingFreshnessMs(cacheControl: string | null, ageHeader: string | null): number | null {
  if (!cacheControl?.trim()) return null;
  const directives = cacheControl.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  const flags = new Set(directives.filter(part => !part.includes('=')));
  if (flags.has('no-store') || flags.has('no-cache')) return null;
  const read = (name: string): number | null => {
    const raw = directives.find(part => part.startsWith(`${name}=`));
    if (!raw) return null;
    const value = Number(raw.slice(name.length + 1));
    return Number.isInteger(value) && value >= 0 ? value : null;
  };
  const lifetime = read('s-maxage') ?? read('max-age');
  if (lifetime == null || lifetime === 0) return null;
  const age = ageHeader != null && /^\d+$/.test(ageHeader.trim()) ? Number(ageHeader.trim()) : 0;
  const remaining = lifetime - age;
  if (remaining <= 0) return null;
  return remaining * 1000;
}

/** Prime 8 caratteri alfanumerici: mai l'uid intero, mai l'email. */
export function truncateUid(uid: string): string {
  const safe = uid.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return safe || '-';
}

export function analysisAuthConfigSummary(env: NodeJS.ProcessEnv = process.env): string {
  const project = analysisFirebaseProjectId(env) ? 'presente' : 'assente';
  const allow = parseAnalysisAllowlist(env.ANALYSIS_ALLOWED_EMAILS);
  return `[analysis-auth] progetto=${project} email-autorizzate=${allow ? allow.length : 0}`;
}

export type AnalysisKeySourceKind = 'test-override' | 'test-file' | 'google';

export function analysisKeySourceKind(): AnalysisKeySourceKind {
  if (process.env.ANALYSIS_AUTH_TEST_HOOK === '1' && fetcherOverride) return 'test-override';
  if (process.env.ANALYSIS_AUTH_TEST_HOOK === '1' && process.env.ANALYSIS_AUTH_TEST_CERTS_FILE) return 'test-file';
  return 'google';
}

/** Solo test: richiede ANALYSIS_AUTH_TEST_HOOK=1. In produzione il setter rifiuta. */
export function setAnalysisKeyFetcherForTests(fetcher: AnalysisKeyFetcher | null): void {
  if (process.env.ANALYSIS_AUTH_TEST_HOOK !== '1') {
    throw new Error('analysis auth test hook disabled');
  }
  fetcherOverride = fetcher;
  cache = null;
  inflight = null;
  lastFetchAt = 0;
}

export function setAnalysisAuthNowForTests(now: (() => number) | null): void {
  if (process.env.ANALYSIS_AUTH_TEST_HOOK !== '1') {
    throw new Error('analysis auth test hook disabled');
  }
  nowOverride = now;
  cache = null;
}

function authNow(): number {
  if (process.env.ANALYSIS_AUTH_TEST_HOOK === '1' && nowOverride) return nowOverride();
  return Date.now();
}

function logAuth(esito: 'accettato' | 'rifiutato', motivo: string, uid?: string): void {
  const safeMotivo = MOTIVO_RE.test(motivo) ? motivo : 'sconosciuto';
  const parts = [`[analysis-auth] esito=${esito}`, `motivo=${safeMotivo}`];
  if (uid && UID_RE.test(uid)) parts.push(`uid=${truncateUid(uid)}`);
  const line = parts.join(' ');
  // Cintura: una riga che somiglia a un token o a un'email non esce.
  if (/bearer|@|eyJ/i.test(line)) return;
  if (esito === 'accettato') console.info(line);
  else console.warn(line);
}

function sendAuth(res: Response, status: 401 | 403 | 503, error: string, errorCode?: string): void {
  res.setHeader('Cache-Control', 'no-store');
  const body: { success: false; error: string; errorCode?: string } = { success: false, error };
  if (errorCode) body.errorCode = errorCode;
  res.status(status).json(body);
}

async function googleFetcher(url: string): Promise<KeyFetchResponse> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  return {
    status: response.status,
    body: await response.text(),
    cacheControl: response.headers.get('cache-control'),
    age: response.headers.get('age'),
  };
}

function fileFetcher(file: string): AnalysisKeyFetcher {
  return async () => {
    const body = readFileSync(file, 'utf8');
    if (body.length > MAX_CERTS_CHARS) throw new Error('certs-too-large');
    return { status: 200, body, cacheControl: 'public, max-age=3600', age: null };
  };
}

function activeFetcher(): AnalysisKeyFetcher {
  if (process.env.ANALYSIS_AUTH_TEST_HOOK === '1' && fetcherOverride) return fetcherOverride;
  const file = process.env.ANALYSIS_AUTH_TEST_CERTS_FILE;
  if (process.env.ANALYSIS_AUTH_TEST_HOOK === '1' && file) return fileFetcher(file);
  return googleFetcher;
}

function parseCerts(body: string): Map<string, KeyObject> {
  if (body.length > MAX_CERTS_CHARS) throw new Error('certs-too-large');
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('certs-malformati');
  const keys = new Map<string, KeyObject>();
  for (const [kid, pem] of Object.entries(parsed)) {
    if (!KID_RE.test(kid) || typeof pem !== 'string' || pem.length > 20_000) continue;
    try {
      keys.set(kid, createPublicKey(pem));
    } catch {
      // Chiave inutilizzabile: si ignora, non si accetta il token.
    }
  }
  if (keys.size === 0) throw new Error('nessuna-chiave');
  return keys;
}

async function loadKeys(nowMs: number, force: boolean): Promise<Map<string, KeyObject>> {
  if (!force && cache && cache.expiresAt > nowMs) return cache.keys;
  if (!force && inflight) return inflight;
  const run = (async () => {
    const response = await activeFetcher()(SECURETOKEN_CERTS_URL);
    lastFetchAt = nowMs;
    if (response.status !== 200) throw new Error('certs-http');
    const keys = parseCerts(response.body);
    const ttl = remainingFreshnessMs(response.cacheControl, response.age);
    cache = ttl == null ? null : { keys, expiresAt: nowMs + ttl, fetchedAt: nowMs };
    return keys;
  })();
  inflight = run;
  try {
    return await run;
  } finally {
    if (inflight === run) inflight = null;
  }
}

async function keysForKid(kid: string, nowMs: number): Promise<Map<string, KeyObject>> {
  const keys = await loadKeys(nowMs, false);
  if (keys.has(kid)) return keys;
  // Rotazione: un solo refetch, non una richiesta a Google per ogni kid falso.
  if (nowMs - lastFetchAt < UNKNOWN_KID_REFRESH_MS) return keys;
  return loadKeys(nowMs, true);
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('segmento');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

interface VerifiedToken {
  ok: true;
  uid: string;
  email: string;
  emailVerified: boolean;
}

interface RejectedToken {
  ok: false;
  motivo: string;
  uid?: string;
}

function verifySignature(signingInput: string, signature: string, key: KeyObject): boolean {
  let bytes: Buffer;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(signature)) return false;
    bytes = Buffer.from(signature, 'base64url');
  } catch {
    return false;
  }
  if (bytes.length === 0) return false;
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();
  try {
    return verifier.verify(key, bytes);
  } catch {
    return false;
  }
}

export function verifyAnalysisIdToken(
  token: string,
  projectId: string,
  keys: Map<string, KeyObject>,
  nowSec: number,
): VerifiedToken | RejectedToken {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return { ok: false, motivo: 'token-malformato' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, motivo: 'token-malformato' };
  const [h64, p64, s64] = parts;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    const decodedHeader = decodeSegment(h64);
    const decodedPayload = decodeSegment(p64);
    if (!decodedHeader || typeof decodedHeader !== 'object' || Array.isArray(decodedHeader)) {
      return { ok: false, motivo: 'token-malformato' };
    }
    if (!decodedPayload || typeof decodedPayload !== 'object' || Array.isArray(decodedPayload)) {
      return { ok: false, motivo: 'token-malformato' };
    }
    header = decodedHeader as Record<string, unknown>;
    payload = decodedPayload as Record<string, unknown>;
  } catch {
    return { ok: false, motivo: 'token-malformato' };
  }
  // Algoritmo fisso: non si usa quello dichiarato per scegliere la verifica.
  if (header.alg !== 'RS256' || (header.typ !== undefined && header.typ !== 'JWT')) {
    return { ok: false, motivo: 'token-malformato' };
  }
  if (typeof header.kid !== 'string' || !KID_RE.test(header.kid)) return { ok: false, motivo: 'token-malformato' };
  const key = keys.get(header.kid);
  if (!key || !verifySignature(`${h64}.${p64}`, s64, key)) {
    return { ok: false, motivo: 'firma-non-valida' };
  }
  const uid = typeof payload.sub === 'string' ? payload.sub : '';
  const uidForLog = UID_RE.test(uid) ? uid : undefined;
  const expectedIss = `https://securetoken.google.com/${projectId}`;
  if (payload.aud !== projectId || payload.iss !== expectedIss) {
    return { ok: false, motivo: 'progetto-diverso', uid: uidForLog };
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSec - CLOCK_SKEW_SEC) {
    return { ok: false, motivo: 'token-scaduto', uid: uidForLog };
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > nowSec + CLOCK_SKEW_SEC) {
    return { ok: false, motivo: 'token-malformato', uid: uidForLog };
  }
  if (typeof payload.auth_time !== 'number' || !Number.isFinite(payload.auth_time) || payload.auth_time > nowSec + CLOCK_SKEW_SEC) {
    return { ok: false, motivo: 'token-malformato', uid: uidForLog };
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + CLOCK_SKEW_SEC) {
    return { ok: false, motivo: 'token-malformato', uid: uidForLog };
  }
  if (!uidForLog) return { ok: false, motivo: 'token-malformato' };
  if (payload.user_id !== undefined && payload.user_id !== uid) {
    return { ok: false, motivo: 'token-malformato', uid: uidForLog };
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  return { ok: true, uid, email, emailVerified: payload.email_verified === true };
}

function readBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
  return match ? match[1] : null;
}

async function authenticateAnalysis(header: string | undefined, res: Response): Promise<'next' | 'sent'> {
  delete res.locals.analysisUid;
  const projectId = analysisFirebaseProjectId();
  const allowlist = parseAnalysisAllowlist(process.env.ANALYSIS_ALLOWED_EMAILS);
  if (!projectId || !allowlist) {
    logAuth('rifiutato', 'non-configurato');
    sendAuth(res, 503, ANALYSIS_NOT_CONFIGURED_MESSAGE, ANALYSIS_NOT_CONFIGURED_CODE);
    return 'sent';
  }
  const token = readBearer(header);
  if (!token || token.length > MAX_TOKEN_CHARS) {
    logAuth('rifiutato', token ? 'token-malformato' : 'token-assente');
    sendAuth(res, 401, ANALYSIS_UNAUTHENTICATED_MESSAGE);
    return 'sent';
  }
  const nowMs = authNow();
  let headerKid = '';
  try {
    const rawHeader = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as { kid?: unknown };
    headerKid = typeof rawHeader.kid === 'string' ? rawHeader.kid : '';
  } catch {
    headerKid = '';
  }
  let keys: Map<string, KeyObject>;
  try {
    keys = headerKid ? await keysForKid(headerKid, nowMs) : await loadKeys(nowMs, false);
  } catch {
    logAuth('rifiutato', 'chiavi-non-disponibili');
    sendAuth(res, 401, ANALYSIS_UNAUTHENTICATED_MESSAGE);
    return 'sent';
  }
  const verified = verifyAnalysisIdToken(token, projectId, keys, Math.floor(nowMs / 1000));
  if (verified.ok === false) {
    logAuth('rifiutato', verified.motivo, verified.uid);
    sendAuth(res, 401, ANALYSIS_UNAUTHENTICATED_MESSAGE);
    return 'sent';
  }
  if (!verified.emailVerified) {
    logAuth('rifiutato', 'email-non-verificata', verified.uid);
    sendAuth(res, 403, ANALYSIS_UNAUTHORIZED_MESSAGE);
    return 'sent';
  }
  if (!verified.email || !allowlist.includes(verified.email)) {
    logAuth('rifiutato', 'email-non-autorizzata', verified.uid);
    sendAuth(res, 403, ANALYSIS_UNAUTHORIZED_MESSAGE);
    return 'sent';
  }
  res.locals.analysisUid = verified.uid;
  logAuth('accettato', 'ok', verified.uid);
  return 'next';
}

/**
 * Middleware unico: rifiuta prima di qualunque lettura del corpo.
 * L'uid verificato resta in `res.locals.analysisUid` per il rate limit.
 */
export function createAnalysisAuthMiddleware(): RequestHandler {
  return (req, res, next) => {
    const header = req.get('authorization');
    authenticateAnalysis(header, res).then(
      (outcome) => {
        if (outcome === 'next') next();
      },
      () => {
        logAuth('rifiutato', 'errore-interno');
        if (!res.headersSent) sendAuth(res, 401, ANALYSIS_UNAUTHENTICATED_MESSAGE);
      },
    );
  };
}
