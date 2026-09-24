import express from 'express';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server';
import {
  CIRCULAR_AI_NOT_CONFIGURED,
  CIRCULAR_AI_TIMEOUT_MESSAGE,
  CIRCULAR_AI_UNAVAILABLE_MESSAGE,
  analysisErrorHandler,
  circularAnalysisGuards,
  circularCloudFailure,
  formatCircularDiagnostic,
  observeCircularDiagnostics,
  summarizeCircularPayload,
  summarizeGeminiAttempts,
} from '../server/circularAnalysisGuard';
import {
  CIRCULAR_INPUT_MESSAGE,
  CIRCULAR_NETWORK_MESSAGE,
  CIRCULAR_PROVIDER_MESSAGE,
  CIRCULAR_RATE_LIMIT_MESSAGE,
  CIRCULAR_TIMEOUT_MESSAGE,
  analyzeCircular,
  createCircularTimeout,
  isSafeCircularServerMessage,
} from '../src/services/aiService';
import type { TeacherProfile } from '../src/types';

const profile: TeacherProfile = {
  id: 't-1', fullName: 'Docente', schoolName: 'Scuola', schoolYear: '2027/2028',
  primarySubjects: [], classes: ['1A'], campuses: [], roles: [],
};
const TEXT = '14/09/2027 Collegio docenti 15:00-17:00';
const SENTINEL = 'SENTINEL_CIRCOLARE_SEGRETA';
const imageReq = { imageBase64: 'QUJDRA==', mimeType: 'image/jpeg', profile, text: TEXT };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('il client non contiene più il messaggio generico di connessione per ogni errore foto/PDF', async () => {
  const source = await readFile('src/services/aiService.ts', 'utf8');
  assert.doesNotMatch(source, /Foto e PDF richiedono il servizio di analisi online/);
});

test('HTTP 503 con data.error: il client conserva il messaggio sicuro e non usa il parser', async () => {
  const message = CIRCULAR_AI_UNAVAILABLE_MESSAGE;
  const result = await analyzeCircular(imageReq, {
    fetchImpl: async () => jsonResponse(503, { success: false, items: [], error: message, errorCode: 'AI_UNAVAILABLE' }),
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.items, []);
  assert.equal(result.error, message);
  assert.equal(result.errorCode, 'AI_UNAVAILABLE');
  assert.doesNotMatch(result.error!, /AI_UNAVAILABLE|503/);
});

test('HTTP 400: messaggio server preservato, niente fallback testuale sull\'immagine', async () => {
  const message = 'Richiesta di analisi non valida.';
  const result = await analyzeCircular(imageReq, {
    fetchImpl: async () => jsonResponse(400, { success: false, items: [], error: message, errorCode: 'INVALID_INPUT' }),
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.items, []);
  assert.equal(result.error, message);
  assert.equal(result.errorCode, 'INVALID_INPUT');
});

test('HTTP 400 senza frase: messaggio di input, non di connessione', async () => {
  const result = await analyzeCircular(imageReq, {
    fetchImpl: async () => jsonResponse(400, { success: false, items: [] }),
  });
  assert.equal(result.error, CIRCULAR_INPUT_MESSAGE);
  assert.equal(result.errorCode, 'INVALID_INPUT');
  assert.doesNotMatch(result.error!, /connessione/);
});

test('HTTP 429: errore di occupazione, codice non visibile nella frase', async () => {
  const message = 'Troppe richieste. Riprova tra un minuto.';
  const result = await analyzeCircular(imageReq, {
    fetchImpl: async () => jsonResponse(429, { success: false, error: message }),
  });
  assert.equal(result.success, false);
  assert.equal(result.error, message);
  assert.equal(result.errorCode, 'RATE_LIMITED');
  assert.doesNotMatch(result.error!, /429|RATE_LIMITED/);
});

test('HTTP 429 senza frase: messaggio di occupazione, non di rete', async () => {
  const result = await analyzeCircular(imageReq, {
    fetchImpl: async () => jsonResponse(429, { success: false }),
  });
  assert.equal(result.error, CIRCULAR_RATE_LIMIT_MESSAGE);
  assert.doesNotMatch(result.error!, /connessione/);
});

test('network failure: solo allora il messaggio di connessione; foto senza parser locale', async () => {
  const result = await analyzeCircular(imageReq, {
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.items, []);
  assert.equal(result.error, CIRCULAR_NETWORK_MESSAGE);
  assert.equal(result.errorCode, 'NETWORK');
  assert.doesNotMatch(result.error!, /Foto e PDF/);
});

test('navigator.onLine è solo un segnale: offline non evita la POST e non maschera un 503', async () => {
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  let called = 0;
  try {
    const result = await analyzeCircular(imageReq, {
      fetchImpl: async () => {
        called += 1;
        return jsonResponse(503, { success: false, items: [], error: CIRCULAR_AI_UNAVAILABLE_MESSAGE, errorCode: 'AI_UNAVAILABLE' });
      },
    });
    assert.equal(called, 1);
    assert.equal(result.error, CIRCULAR_AI_UNAVAILABLE_MESSAGE);
    assert.doesNotMatch(result.error!, /connessione/);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: previous, configurable: true });
  }
});

test('onLine true non dimostra che il backend abbia risposto', async () => {
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  try {
    const result = await analyzeCircular(imageReq, {
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    assert.equal(result.errorCode, 'NETWORK');
    assert.equal(result.error, CIRCULAR_NETWORK_MESSAGE);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: previous, configurable: true });
  }
});

test('timeout client: TimeoutError/AbortError non diventano un errore di rete', async () => {
  const timeoutError = new Error('The operation was aborted due to timeout');
  timeoutError.name = 'TimeoutError';
  const timedOut = await analyzeCircular(imageReq, {
    fetchImpl: async () => { throw timeoutError; },
  });
  assert.equal(timedOut.success, false);
  assert.deepEqual(timedOut.items, []);
  assert.equal(timedOut.error, CIRCULAR_TIMEOUT_MESSAGE);
  assert.equal(timedOut.errorCode, 'CLIENT_TIMEOUT');
  assert.doesNotMatch(timedOut.error!, /connessione/);

  const abortError = new Error('The operation was aborted');
  abortError.name = 'AbortError';
  const aborted = await analyzeCircular(imageReq, {
    fetchImpl: async () => { throw abortError; },
  });
  assert.equal(aborted.errorCode, 'CLIENT_TIMEOUT');
  assert.equal(aborted.error, CIRCULAR_TIMEOUT_MESSAGE);
});

test('senza AbortSignal.timeout il timeout resta un timeout, non un errore di rete', async () => {
  const saved = AbortSignal.timeout;
  delete (AbortSignal as { timeout?: unknown }).timeout;
  try {
    const result = await analyzeCircular({ imageBase64: 'QUJD', mimeType: 'image/png', profile }, {
      timeoutMs: 30,
      fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    });
    assert.equal(result.errorCode, 'CLIENT_TIMEOUT');
    assert.equal(result.error, CIRCULAR_TIMEOUT_MESSAGE);
  } finally {
    (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout = saved;
  }
});

test('testo + fallimento cloud: resta il fallback locale', async () => {
  const result = await analyzeCircular({ text: TEXT, profile }, {
    fetchImpl: async () => jsonResponse(503, { success: false, items: [], error: CIRCULAR_AI_UNAVAILABLE_MESSAGE, errorCode: 'AI_UNAVAILABLE' }),
  });
  assert.equal(result.success, true);
  assert.equal(result.source, 'offline-local');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].date, '2027-09-14');
});

test('immagine + testo + fallimento cloud: non usa il parser testuale', async () => {
  const result = await analyzeCircular(imageReq, {
    fetchImpl: async () => jsonResponse(503, { success: false, items: [], error: CIRCULAR_PROVIDER_MESSAGE, errorCode: 'AI_UNAVAILABLE' }),
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.items, []);
  assert.equal(result.error, CIRCULAR_PROVIDER_MESSAGE);
});

test('corpo non JSON o messaggio non sicuro: niente HTML, chiave, OCR o base64 in UI', async () => {
  const html = await analyzeCircular(imageReq, {
    fetchImpl: async () => new Response(`<html>${SENTINEL}</html>`, { status: 503, headers: { 'Content-Type': 'text/html' } }),
  });
  assert.equal(html.errorCode, 'AI_UNAVAILABLE');
  assert.equal(html.error, CIRCULAR_PROVIDER_MESSAGE);
  assert.doesNotMatch(html.error!, /SENTINEL|<html/);

  const leaked = `GEMINI_API_KEY=AIzaSySECRET ${SENTINEL} ` + 'A'.repeat(60);
  assert.equal(isSafeCircularServerMessage(leaked), false);
  const unsafe = await analyzeCircular(imageReq, {
    fetchImpl: async () => jsonResponse(500, { success: false, error: leaked, errorCode: 'SERVER_ERROR' }),
  });
  assert.equal(unsafe.error, CIRCULAR_PROVIDER_MESSAGE);
  assert.doesNotMatch(unsafe.error!, /SENTINEL|AIza|GEMINI_API_KEY/);
  assert.doesNotMatch(JSON.stringify(unsafe), /SENTINEL|AIzaSySECRET/);
});

test('categorie Gemini: timeout e indisponibilità hanno frasi pubbliche, senza dettagli del provider', () => {
  assert.equal(circularCloudFailure('deadline').errorCode, 'AI_TIMEOUT');
  assert.equal(circularCloudFailure('budget-esaurito').error, CIRCULAR_AI_TIMEOUT_MESSAGE);
  assert.equal(circularCloudFailure('annullata').errorCode, 'AI_TIMEOUT');
  const missing = circularCloudFailure('modello-non-trovato');
  assert.equal(missing.errorCode, 'AI_UNAVAILABLE');
  assert.equal(missing.error, CIRCULAR_AI_UNAVAILABLE_MESSAGE);
  assert.doesNotMatch(missing.error, /gemini|API|stack|prompt/i);
  const key = circularCloudFailure('chiave-o-permessi');
  assert.doesNotMatch(key.error, /key|chiave|permess/i);
});

test('log circolare: MIME, byte e tentativi; mai testo, base64, prompt o chiave', () => {
  const secret = `${SENTINEL} oggetto della circolare personale`;
  const base64 = Buffer.from(`${SENTINEL}-jpeg-bytes`).toString('base64');
  const summary = summarizeCircularPayload({ text: secret, imageBase64: base64, mimeType: 'image/jpeg', profile: { fullName: secret } });
  assert.equal(summary.mime, 'image/jpeg');
  assert.equal(summary.textChars, secret.length);
  assert.equal(typeof summary.bytes, 'number');
  const poisoned = formatCircularDiagnostic({
    esito: 'fallito',
    errorCode: 'AI_UNAVAILABLE',
    categoria: secret,
    mime: `image/jpeg ${secret}`,
    bytes: summary.bytes,
    textChars: summary.textChars,
    tentativi: secret,
    sorgente: secret,
    tipo: secret,
    provider: secret,
  });
  assert.match(poisoned, /endpoint=\/api\/analyze-circular/);
  assert.match(poisoned, /mime=image\/jpeg|mime=-/);
  assert.match(poisoned, new RegExp(`textChars=${secret.length}`));
  assert.doesNotMatch(poisoned, /SENTINEL|oggetto della circolare|fullName|prompt|API_KEY/);
  assert.doesNotMatch(poisoned, new RegExp(base64.slice(0, 16)));
  const attempts = summarizeGeminiAttempts([
    { model: 'gemini-3.1-flash-lite', category: 'deadline', status: 504 },
    { model: secret, category: 'quota', status: 429 },
  ]);
  assert.match(attempts, /gemini-3\.1-flash-lite:deadline:504/);
  assert.match(attempts, /modello:quota:429/);
  assert.doesNotMatch(attempts, /SENTINEL/);
});

test('guard circolari: 400/413 portano errorCode e non il documento nel corpo né nel log', async () => {
  const isolated = express();
  isolated.post('/api/analyze-circular', ...circularAnalysisGuards(), (_req, res) => res.json({ success: true }));
  isolated.use('/api/analyze-circular', analysisErrorHandler);
  const server = isolated.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const logs: string[] = [];
  const stop = observeCircularDiagnostics(line => { logs.push(line); });
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/analyze-circular`;
    const bad = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: SENTINEL, profile: { classes: 'no' } }),
    });
    assert.equal(bad.status, 400);
    const badBody = await bad.json() as { error: string; errorCode: string };
    assert.equal(badBody.error, 'Richiesta di analisi non valida.');
    assert.equal(badBody.errorCode, 'INVALID_INPUT');
    assert.doesNotMatch(JSON.stringify(badBody), /SENTINEL/);

    const big = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(100_001), profile }),
    });
    assert.equal(big.status, 413);
    assert.equal((await big.json()).errorCode, 'PAYLOAD_TOO_LARGE');
    assert.ok(logs.some(line => line.includes('errorCode=INVALID_INPUT') && line.includes('mime=-')));
    assert.ok(logs.every(line => !line.includes(SENTINEL)));
  } finally {
    stop();
    await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
  }
});

test('endpoint senza chiave: JPEG rifiutato con codice, log privacy-safe, frase storica', async () => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(SENTINEL)]);
  const imageBase64 = jpeg.toString('base64');
  const logs: string[] = [];
  const stop = observeCircularDiagnostics(line => { logs.push(line); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/analyze-circular`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: SENTINEL, imageBase64, mimeType: 'image/jpeg', profile }),
    });
    assert.equal(response.status, 503);
    const body = await response.json() as { success: boolean; error: string; errorCode: string; items: unknown[] };
    assert.equal(body.success, false);
    assert.deepEqual(body.items, []);
    assert.equal(body.error, CIRCULAR_AI_NOT_CONFIGURED);
    assert.equal(body.errorCode, 'AI_UNAVAILABLE');
    assert.match(body.error, /non disponibile/);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(`${SENTINEL}|${imageBase64.slice(0, 20)}`));
    const line = logs.find(entry => entry.includes('endpoint=/api/analyze-circular') && entry.includes('categoria=non-configurato'));
    assert.ok(line, `manca il log diagnostico: ${logs.join(' | ')}`);
    assert.match(line!, /mime=image\/jpeg/);
    assert.match(line!, /errorCode=AI_UNAVAILABLE/);
    assert.match(line!, /bytes=\d+/);
    assert.match(line!, /timeout=no/);
    assert.match(line!, /provider=gemini/);
    assert.doesNotMatch(line!, new RegExp(`${SENTINEL}|${imageBase64.slice(0, 20)}|GEMINI_API_KEY|prompt`));
  } finally {
    stop();
    if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
    await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
  }
});

test('il timeout portabile si può cancellare senza lasciare il timer acceso', () => {
  const saved = AbortSignal.timeout;
  delete (AbortSignal as { timeout?: unknown }).timeout;
  try {
    const timeout = createCircularTimeout(60_000);
    assert.equal(timeout.expired(), false);
    timeout.clear();
  } finally {
    AbortSignal.timeout = saved;
  }
});
