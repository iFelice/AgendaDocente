import express from 'express';
import { once } from 'node:events';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCircular,
  circularHttpErrorMessage,
  CIRCULAR_NETWORK_MESSAGE,
  CIRCULAR_TIMEOUT_MESSAGE,
} from '../src/services/aiService';
import { app } from '../server';
import { circularAnalysisGuards, analysisErrorHandler, ANALYSIS_LIMITS } from '../server/circularAnalysisGuard';
import type { TeacherProfile } from '../src/types';

/**
 * MICRO-STEP 1 — error handling diagnostico di /api/analyze-circular.
 *
 * Prima: qualunque errore (503 del server, 400 di validazione, 429 di rate
 * limit, timeout, rete assente) diventava il falso messaggio "Foto e PDF
 * richiedono il servizio di analisi online. Riprova con la connessione...".
 *
 * Ora le categorie sono distinte:
 *  1. rete irraggiungibile: solo fetch rifiutata senza risposta;
 *  2. timeout client 60 s: AbortError/TimeoutError del segnale;
 *  3. risposta HTTP di errore: messaggio sicuro del server preservato;
 *  4. provider AI indisponibile/in errore lato server: 503 AI_UNAVAILABLE;
 *  5. input rifiutato: 400/413/415/429 con il messaggio specifico del server.
 *
 * Nessun dettaglio tecnico (status, codici, stack, base64, OCR) raggiunge
 * l'utente: i codici stabili restano in `errorCode` per la sola diagnostica.
 */

const profile = {
  id: 'test',
  fullName: 'Docente',
  schoolName: 'Scuola',
  schoolYear: '2027/2028',
  primarySubjects: [],
  classes: ['1A'],
  campuses: [],
  roles: [],
} as unknown as TeacherProfile;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function withStubbedFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>, run: () => Promise<void>) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try { await run(); }
  finally { globalThis.fetch = savedFetch; }
}

// ---------------------------------------------------------------- CLIENT ---

test('client: HTTP 503 provider AI conserva il messaggio sicuro del server (non "riprova con la connessione")', async () => {
  await withStubbedFetch(async () => jsonResponse(503, {
    success: false, items: [], error: 'Il documento non è stato elaborato. Riprova più tardi.', errorCode: 'AI_UNAVAILABLE',
  }), async () => {
    const result = await analyzeCircular({ imageBase64: 'AAAA', mimeType: 'image/jpeg', profile });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Il documento non è stato elaborato. Riprova più tardi.');
    assert.equal(result.errorCode, 'AI_UNAVAILABLE');
    assert.doesNotMatch(result.error!, /connessione|online/i);
  });
});

test('client: HTTP 400 input rifiutato conserva il messaggio specifico del server', async () => {
  await withStubbedFetch(async () => jsonResponse(400, {
    success: false, items: [], error: 'Richiesta di analisi non valida.', errorCode: 'INVALID_INPUT',
  }), async () => {
    const result = await analyzeCircular({ imageBase64: 'AAAA', mimeType: 'application/pdf', profile });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Richiesta di analisi non valida.');
    assert.equal(result.errorCode, 'INVALID_INPUT');
  });
});

test('client: HTTP 429 conserva il messaggio del server; senza messaggio usa la sua categoria', async () => {
  await withStubbedFetch(async () => jsonResponse(429, {
    success: false, error: 'Troppe richieste. Riprova tra un minuto.', errorCode: 'RATE_LIMITED',
  }), async () => {
    const result = await analyzeCircular({ text: 'Collegio docenti 15:00', profile });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Troppe richieste. Riprova tra un minuto.');
  });
  await withStubbedFetch(async () => jsonResponse(429, { success: false }), async () => {
    const result = await analyzeCircular({ imageBase64: 'AAAA', mimeType: 'image/png', profile });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Il servizio di analisi è temporaneamente occupato. Riprova tra poco.');
  });
});

test('client: network failure -> messaggio connessione SOLO per richiesta senza risposta', async () => {
  await withStubbedFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
    const result = await analyzeCircular({ imageBase64: 'AAAA', mimeType: 'image/jpeg', profile });
    assert.equal(result.success, false);
    assert.equal(result.error, CIRCULAR_NETWORK_MESSAGE);
    assert.equal(result.source, 'unavailable');
    // Il vecchio messaggio fuorviante non esiste più.
    assert.doesNotMatch(result.error!, /servizio di analisi online/);
  });
});

test('client: timeout distinto dalla rete (AbortError/TimeoutError del timeout 60 s)', async () => {
  await withStubbedFetch(
    (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('The operation timed out.');
        error.name = 'TimeoutError';
        reject(error);
      });
    }),
    async () => {
      const result = await analyzeCircular(
        { imageBase64: 'AAAA', mimeType: 'application/pdf', profile },
        { timeoutMs: 20 },
      );
      assert.equal(result.success, false);
      assert.equal(result.error, CIRCULAR_TIMEOUT_MESSAGE);
      assert.notEqual(result.error, CIRCULAR_NETWORK_MESSAGE);
    },
  );
});

test('client: risposte HTTP di errore senza messaggio server usano la categoria, senza codici tecnici', async () => {
  const cases: Array<[number, string]> = [
    [400, 'La richiesta non è stata accettata. Verifica il documento e riprova.'],
    [413, 'Il documento è troppo grande: massimo 5 MB.'],
    [415, 'Formato non supportato: usa una foto (JPEG, PNG, WebP) o un PDF oppure incolla il testo.'],
    [503, 'Il documento non è stato elaborato dal servizio AI. Riprova tra poco.'],
    [500, 'Il servizio di analisi ha restituito un errore. Riprova più tardi.'],
  ];
  for (const [status, expected] of cases) {
    await withStubbedFetch(async () => jsonResponse(status, { success: false }), async () => {
      const result = await analyzeCircular({ imageBase64: 'AAAA', mimeType: 'image/png', profile });
      assert.equal(result.success, false);
      assert.equal(result.error, expected, `status ${status}`);
      assert.notEqual(result.error, CIRCULAR_NETWORK_MESSAGE, `status ${status} non è un errore di rete`);
      assert.doesNotMatch(result.error!, /\d{3}|AI_[A-Z_]+|stack|Error:/, `status ${status}: nessun dettaglio tecnico`);
    });
  }
  // Il messaggio del server non vuoto vince sempre sulla categoria.
  assert.equal(circularHttpErrorMessage(503, '  '), 'Il documento non è stato elaborato dal servizio AI. Riprova tra poco.');
  assert.equal(circularHttpErrorMessage(418, ''), 'Analisi non riuscita. Riprova.');
});

test('client: testo + cloud irraggiungibile -> il fallback parser locale continua a funzionare', async () => {
  await withStubbedFetch(async () => { throw new TypeError('network down'); }, async () => {
    const result = await analyzeCircular({ text: '14/09/2027 Collegio docenti 15:00-17:00', profile });
    assert.equal(result.success, true);
    assert.equal(result.source, 'offline-local');
    assert.equal(result.items.length, 1);
  });
});

test('client: immagine + cloud irraggiungibile -> errore, MAI parser testuale simulato', async () => {
  await withStubbedFetch(async () => { throw new TypeError('network down'); }, async () => {
    const result = await analyzeCircular({
      text: '14/09/2027 Collegio docenti 15:00-17:00', // presente ma irrilevante: il binario comanda
      imageBase64: 'AAAA', mimeType: 'image/jpeg', profile,
    });
    assert.equal(result.success, false);
    assert.equal(result.items.length, 0, 'nessun item inventato dal parser locale');
    assert.equal(result.source, 'unavailable');
    assert.match(result.error!, /connessione/);
  });
});

// ---------------------------------------------------------------- SERVER ---

const validPdfBase64 = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
const previousKey = process.env.GEMINI_API_KEY;

before(async () => {
  // Senza chiave Gemini: l'analisi binaria non è disponibile (503 AI_UNAVAILABLE).
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

test('server: PDF senza chiave AI -> 503 AI_UNAVAILABLE, messaggio sicuro, nessun contenuto sensibile', async () => {
  const response = await post('/api/analyze-circular', {
    imageBase64: validPdfBase64, mimeType: 'application/pdf', profile,
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.errorCode, 'AI_UNAVAILABLE');
  assert.match(body.error, /non disponibile/);
  assert.deepEqual(body.items, []);
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /stack|Error:|GEMINI_API_KEY|prompt/i);
  assert.ok(!raw.includes(validPdfBase64), 'mai base64 del documento nella risposta');
});

test('server: log di fallimento privacy-safe con provider, mimeType, dimensione e timeout', async () => {
  const originalWarn = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const response = await post('/api/analyze-circular', {
      imageBase64: validPdfBase64, mimeType: 'application/pdf', profile,
    });
    assert.equal(response.status, 503);
  } finally {
    console.warn = originalWarn;
  }
  const diagnostic = lines.find(line => line.includes('[analyze-circular] fallimento'));
  assert.ok(diagnostic, 'una riga diagnostica per il fallimento binario');
  assert.match(diagnostic!, /provider=gemini/);
  assert.match(diagnostic!, /categoria=non-configurato/);
  assert.match(diagnostic!, /mimeType=application\/pdf/);
  assert.match(diagnostic!, /dimensioneBytes=\d+/);
  assert.match(diagnostic!, /durataMs=\d+/);
  assert.match(diagnostic!, /timeout=no/);
  const all = lines.join('\n');
  assert.ok(!all.includes(validPdfBase64), 'mai base64 nei log');
  assert.doesNotMatch(all, /GEMINI_API_KEY|Collegio docenti/);
});

test('server: guard di analyze-circular espongono codici applicativi stabili', async () => {
  const mini = express();
  let now = 0;
  // perIp=4: il bucket conta anche le richieste respinte (400/413/415 contano 3),
  // quindi la 4ª (valida) passa e la 5ª è 429.
  mini.post('/api/analyze-circular', ...circularAnalysisGuards({ perIp: 4, now: () => now }), (_req, res) => res.json({ success: true }));
  mini.use(analysisErrorHandler);
  const instance = mini.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  const url = `http://127.0.0.1:${(instance.address() as { port: number }).port}/api/analyze-circular`;
  const send = (body: unknown) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    // Input rifiutato: profilo malformato.
    const invalid = await send({ text: 'Collegio', profile: { classes: '1A' } });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).errorCode, 'INVALID_INPUT');

    // Payload rifiutato: file oltre il limite.
    const oversized = await send({
      mimeType: 'application/pdf', profile,
      imageBase64: Buffer.alloc(ANALYSIS_LIMITS.fileBytes + 1).toString('base64'),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).errorCode, 'PAYLOAD_TOO_LARGE');

    // Media non supportato: richiesta non JSON.
    const notJson = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(notJson.status, 415);
    assert.equal((await notJson.json()).errorCode, 'UNSUPPORTED_MEDIA');

    // Rate limit: budget per-IP configurato a 3, il quarto invio è respinto.
    assert.equal((await send({ text: 'Collegio docenti 15:00', profile })).status, 200);
    const blocked = await send({ text: 'Collegio docenti 15:00', profile });
    assert.equal(blocked.status, 429);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.errorCode, 'RATE_LIMITED');
    assert.equal(blockedBody.error, 'Troppe richieste. Riprova tra un minuto.');
  } finally {
    await new Promise<void>((resolve, reject) => instance.close(e => (e ? reject(e) : resolve())));
    now = 0;
  }
});
