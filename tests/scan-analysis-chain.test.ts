import 'fake-indexeddb/auto';
import express from 'express';
import { once } from 'node:events';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server';
import { createAnalysisErrorHandler, createAnalysisGuards, validateTeacherProfile } from '../server/analysisGuards';
import { validateTimetableAnalysisPayload } from '../server/timetableAnalysis';
import { DEFAULT_PROFILE } from '../src/services/storage';
import { normalizeTeacherProfile } from '../src/utils/multiSchool';
import { OFFLINE_ANALYSIS_MESSAGE } from '../src/utils/documentScanner';
import {
  NETWORK_ANALYSIS_MESSAGE,
  TIMEOUT_ANALYSIS_MESSAGE,
  analyzeStudentDocument,
  analyzeTimetableDocument,
  scanAnalysisErrorMessage,
} from '../src/services/scanService';
import type { TeacherProfile } from '../src/types';

/**
 * Regressione del bug post-merge "Scansiona documento" (iPhone/PWA).
 *
 * 1) SERVER: il profilo che l'app invia davvero — normalizeTeacherProfile()
 *    aggiunge sempre `schools` e `weeklyDeclaredHours` (salvataggio in
 *    ProfileModal, migrazione multi-scuola, import backup) — veniva respinto
 *    dalla allow-list di validateTeacherProfile con HTTP 400 "Richiesta di
 *    analisi non valida." su /api/analyze-timetable,
 *    /api/analyze-student-document E /api/analyze-circular: la richiesta non
 *    arrivava mai a Gemini.
 * 2) CLIENT: qualunque fetch fallito (timeout, iOS senza AbortSignal.timeout,
 *    rete interrotta) diventava lo stesso messaggio generico e qualunque
 *    risposta non JSON "Analisi non riuscita.": le classi di errore sono ora
 *    distinte, senza dettagli tecnici per l'utente.
 */

/** PNG reale per dimensione (636 KB come lo screenshot iPhone del bug report). */
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngBase64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(636 * 1024 - PNG_SIGNATURE.length, 7)]).toString('base64');

/** Profilo così come arriva dall'app: include schools e weeklyDeclaredHours. */
const realProfile = normalizeTeacherProfile(DEFAULT_PROFILE);

const timetableRequest = (profile: unknown) => ({
  imageBase64: pngBase64,
  mimeType: 'image/png',
  documentType: 'personal-support-timetable',
  profile,
});

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
const previousKey = process.env.GEMINI_API_KEY;

before(async () => {
  // Senza chiave Gemini gli endpoint rispondono 503: la richiesta ha comunque
  // superato rate limit, JSON, body limit e validazione del payload.
  delete process.env.GEMINI_API_KEY;
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (previousKey !== undefined) process.env.GEMINI_API_KEY = previousKey;
  await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 1. SERVER: il profilo reale non è più respinto
// ---------------------------------------------------------------------------

test('analyze-timetable: PNG 636 KB + profilo reale dell\'app supera i guard (non più 400)', async () => {
  assert.ok(Object.keys(realProfile).includes('schools'), 'il profilo reale contiene schools');
  assert.equal(realProfile.weeklyDeclaredHours, 18, 'il profilo reale contiene weeklyDeclaredHours');

  const res = await post('/api/analyze-timetable', timetableRequest(realProfile));
  assert.notEqual(res.status, 400, 'il profilo salvato dall\'app non deve essere respinto');
  assert.equal(res.status, 503, 'senza chiave AI la richiesta arriva al ramo AI e risponde 503');
  const data = await res.json();
  assert.equal(data.success, false);
  assert.doesNotMatch(JSON.stringify(data), /stack|Error:|iVBOR|schools|weeklyDeclaredHours/i, 'nessun dettaglio tecnico né contenuto nella risposta');
});

test('analyze-student-document e analyze-circular: stesso profilo reale accettato (bug su tutta l\'analisi documentale)', async () => {
  const student = await post('/api/analyze-student-document', { imageBase64: pngBase64, mimeType: 'image/png', profile: realProfile });
  assert.notEqual(student.status, 400);
  assert.equal(student.status, 503);

  const circular = await post('/api/analyze-circular', { imageBase64: pngBase64, mimeType: 'image/png', profile: realProfile });
  assert.notEqual(circular.status, 400, 'anche l\'endpoint circolari era bloccato dallo stesso profilo');
  assert.equal(circular.status, 503);
  assert.equal((await circular.json()).success, false);
});

test('validateTeacherProfile: accetta i campi reali, rifiuta chiavi e valori sconosciuti', () => {
  const status = (profile: unknown) => {
    try { validateTeacherProfile(profile); return 0; }
    catch (error: any) { return error.status as number; }
  };
  const bare: TeacherProfile = {
    id: 't-1', fullName: 'Docente', schoolName: 'Scuola', schoolYear: '2026/2027',
    primarySubjects: [], classes: ['1A'], campuses: [], roles: [],
  };

  assert.equal(status(bare), 0, 'profilo minimo valido');
  assert.equal(status({ ...bare, weeklyDeclaredHours: 18 }), 0);
  assert.equal(status({ ...bare, weeklyDeclaredHours: 0 }), 0);
  assert.equal(status({
    ...bare,
    schools: [{ id: 'school-1', name: 'Sede Centrale', campuses: ['Centrale'], schoolLevel: 'ssig', weeklyHours: 6, isPrimary: true, active: true }],
  }), 0, 'istituti del modello multi-scuola');

  // La allow-list resta: niente campi imprevisti, niente valori assurdi.
  assert.equal(status({ ...bare, isAdmin: true }), 400, 'chiave sconosciuta rifiutata');
  assert.equal(status({ ...bare, weeklyDeclaredHours: 200 }), 400, 'ore fuori range');
  assert.equal(status({ ...bare, weeklyDeclaredHours: '18' }), 400, 'ore non numeriche');
  assert.equal(status({ ...bare, schools: [{ id: 'school-1', name: 'X', secret: 'payload' }] }), 400, 'istituto con chiave sconosciuta');
  assert.equal(status({ ...bare, schools: [{ id: 'school-1' }] }), 400, 'istituto senza nome');
  assert.equal(status({ ...bare, schools: 'no' }), 400, 'schools non array');
  assert.equal(status({ ...bare, schools: Array.from({ length: 11 }, (_, i) => ({ id: `s-${i}`, name: 'X' })) }), 400, 'troppi istituti');
});

test('analyze-timetable: profilo con chiave sconosciuta -> ancora 400 generico (nessun contenuto)', async () => {
  // App isolata: non consuma il budget rate-limit dell'app condivisa.
  const isolated = express();
  isolated.post('/api/analyze-timetable', ...createAnalysisGuards(validateTimetableAnalysisPayload), (_req, res) => res.json({ success: true }));
  isolated.use('/api/analyze-timetable', createAnalysisErrorHandler(false));
  const local = isolated.listen(0, '127.0.0.1');
  await once(local, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${(local.address() as { port: number }).port}/api/analyze-timetable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(timetableRequest({ ...realProfile, plan: 'premium' })),
    });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.equal(body, '{"success":false,"error":"Richiesta di analisi non valida."}');
  } finally {
    await new Promise<void>((resolve, reject) => local.close(e => (e ? reject(e) : resolve())));
  }
});

// ---------------------------------------------------------------------------
// 2. CLIENT: una classe di errore per ogni esito, mai il messaggio generico
// ---------------------------------------------------------------------------

test('scanAnalysisErrorMessage: ogni status ha il suo messaggio, quello del server vince', () => {
  assert.equal(scanAnalysisErrorMessage(400, ''), 'La richiesta non è stata accettata. Scatta di nuovo il documento e riprova.');
  assert.equal(scanAnalysisErrorMessage(404, ''), 'L\'analisi documenti non è disponibile in questa versione del servizio. Aggiorna l\'app e riprova.');
  assert.equal(scanAnalysisErrorMessage(413, ''), 'Il documento è troppo grande: massimo 5 MB.');
  assert.equal(scanAnalysisErrorMessage(415, ''), 'Formato non supportato: usa una foto (JPEG, PNG, WebP) o un PDF.');
  assert.equal(scanAnalysisErrorMessage(429, ''), 'Troppe analisi in questo momento: riprova tra un minuto.');
  assert.equal(scanAnalysisErrorMessage(503, ''), 'Il servizio di analisi è temporaneamente non disponibile: riprova più tardi.');
  assert.equal(scanAnalysisErrorMessage(502, ''), 'Il servizio di analisi è temporaneamente non disponibile: riprova più tardi.');
  assert.equal(scanAnalysisErrorMessage(500, ''), 'Il servizio di analisi ha restituito un errore: riprova più tardi.');
  assert.equal(scanAnalysisErrorMessage(200, ''), 'Analisi non riuscita. Riprova.');
  assert.equal(scanAnalysisErrorMessage(413, 'File troppo grande: massimo 5 MB.'), 'File troppo grande: massimo 5 MB.');
  for (const status of [400, 404, 413, 415, 429, 500, 502, 503, 504]) {
    assert.doesNotMatch(scanAnalysisErrorMessage(status, ''), new RegExp(NETWORK_ANALYSIS_MESSAGE.slice(0, 20)), `status ${status} scambiato per rete`);
    assert.doesNotMatch(scanAnalysisErrorMessage(status, ''), /HTTP|\b4\d\d\b|\b5\d\d\b/, 'nessuno status code mostrato');
  }
});

const clientProfile: TeacherProfile = {
  id: 't-1', fullName: 'Docente', schoolName: 'Scuola', schoolYear: '2026/2027',
  primarySubjects: [], classes: ['1A'], campuses: [], roles: [],
};

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
after(() => {
  globalThis.fetch = originalFetch;
  (AbortSignal as any).timeout = originalTimeout;
});

/** Esegue analyzeTimetableDocument con fetch (e opzionalmente AbortSignal.timeout) sostituiti. */
async function withStub(impl: (url: any, init: any) => Promise<Response>, options: { withoutAbortSignalTimeout?: boolean } = {}) {
  const savedFetch = globalThis.fetch;
  const savedTimeout = AbortSignal.timeout;
  if (options.withoutAbortSignalTimeout) delete (AbortSignal as any).timeout;
  globalThis.fetch = impl as any;
  try {
    return await analyzeTimetableDocument({ imageBase64: 'AAAA', mimeType: 'image/png', documentType: 'personal-support-timetable', profile: clientProfile });
  } finally {
    globalThis.fetch = savedFetch;
    (AbortSignal as any).timeout = savedTimeout;
  }
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const htmlResponse = (status: number) =>
  new Response(`<html><body>${status} Bad Gateway</body></html>`, { status, headers: { 'Content-Type': 'text/html' } });

test('client: 400/413/415/429/500/503 mostrano la causa, non "impossibile raggiungere il servizio"', async () => {
  const cases: Array<[number, string]> = [
    [400, 'La richiesta non è stata accettata. Scatta di nuovo il documento e riprova.'],
    [413, 'Il documento è troppo grande: massimo 5 MB.'],
    [415, 'Formato non supportato: usa una foto (JPEG, PNG, WebP) o un PDF.'],
    [429, 'Troppe analisi in questo momento: riprova tra un minuto.'],
    [500, 'Il servizio di analisi ha restituito un errore: riprova più tardi.'],
    [503, 'Il servizio di analisi è temporaneamente non disponibile: riprova più tardi.'],
    [404, 'L\'analisi documenti non è disponibile in questa versione del servizio. Aggiorna l\'app e riprova.'],
  ];
  for (const [status, expected] of cases) {
    const error = await withStub(async () => jsonResponse(status, { success: false })).then(
      () => null, (e: Error) => e);
    assert.equal(error?.message, expected, `status ${status}`);
    assert.notEqual(error?.message, NETWORK_ANALYSIS_MESSAGE, `status ${status} non è un errore di rete`);
  }
});

test('client: il messaggio del server (già sanitizzato) ha la precedenza sullo status', async () => {
  const error = await withStub(async () => jsonResponse(429, { success: false, error: 'Troppe richieste. Riprova tra un minuto.' }))
    .then(() => null, (e: Error) => e);
  assert.equal(error?.message, 'Troppe richieste. Riprova tra un minuto.');
});

test('client: risposta non JSON (pagina di proxy / 404 HTML) -> messaggio legato allo stato, non "Analisi non riuscita" generico', async () => {
  const gateway = await withStub(async () => htmlResponse(502)).then(() => null, (e: Error) => e);
  assert.equal(gateway?.message, 'Il servizio di analisi è temporaneamente non disponibile: riprova più tardi.');

  const htmlNotFound = await withStub(async () => new Response('Cannot POST /api/analyze-timetable', { status: 404, headers: { 'Content-Type': 'text/html' } }))
    .then(() => null, (e: Error) => e);
  assert.equal(htmlNotFound?.message, 'L\'analisi documenti non è disponibile in questa versione del servizio. Aggiorna l\'app e riprova.');

  const okButUnsuccessful = await withStub(async () => jsonResponse(200, { success: false })).then(() => null, (e: Error) => e);
  assert.equal(okButUnsuccessful?.message, 'Analisi non riuscita. Riprova.');
});

test('client: solo un fetch realmente fallito produce il messaggio di rete; il timeout ha il suo', async () => {
  const network = await withStub(async () => { throw new TypeError('fetch failed'); }).then(() => null, (e: Error) => e);
  assert.equal(network?.message, NETWORK_ANALYSIS_MESSAGE);

  // Timeout scaduto: segnale abortito + errore di abort dal fetch.
  (AbortSignal as any).timeout = () => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  };
  const timedOut = await withStub(async () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  }).then(() => null, (e: Error) => e);
  assert.equal(timedOut?.message, TIMEOUT_ANALYSIS_MESSAGE);
  assert.notEqual(timedOut?.message, NETWORK_ANALYSIS_MESSAGE);
});

test('client: senza AbortSignal.timeout (iOS Safari < 16) la richiesta parte comunque', async () => {
  let called = 0;
  const result = await withStub(async () => {
    called++;
    return jsonResponse(200, { success: true, source: 'gemini', rows: ['Manganiello'], cells: [] });
  }, { withoutAbortSignalTimeout: true });
  assert.equal(called, 1, 'fetch invocata: prima veniva lanciato un TypeError scambiato per rete assente');
  assert.deepEqual(result.rows, ['Manganiello']);
  assert.equal(result.success, true);
});

test('client: registro/offline — messaggio offline distinto, endpoint registro sulla stessa catena', async () => {
  const offline = await (async () => {
    const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse(200, { success: true, commitments: [] })) as any;
    try {
      return await analyzeStudentDocument({ imageBase64: 'AAAA', mimeType: 'image/png', profile: clientProfile }).then(() => null, (e: Error) => e);
    } finally {
      globalThis.fetch = savedFetch;
      if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    }
  })();
  assert.equal(offline?.message, OFFLINE_ANALYSIS_MESSAGE);
  assert.notEqual(offline?.message, NETWORK_ANALYSIS_MESSAGE);
});
