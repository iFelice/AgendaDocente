import express from 'express';
import { once } from 'node:events';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server';
import { ANALYSIS_LIMITS, createAnalysisErrorHandler, createAnalysisGuards } from '../server/analysisGuards';
import { validateTimetableAnalysisPayload, validateStudentDocumentPayload } from '../server/timetableAnalysis';

/**
 * Endpoint "Scansiona documento": gli stessi guard di analyze-circular
 * (rate limit, JSON, body limit, validazione payload, firma, errori generici,
 * no-store) applicati a /api/analyze-timetable e /api/analyze-student-document.
 * Senza chiave AI gli endpoint rispondono 503 con messaggio generico:
 * nessuna analisi, nessun contenuto nei log né nella risposta.
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
};

const validPdfBase64 = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
const previousKey = process.env.GEMINI_API_KEY;

before(async () => {
  // Senza chiave Gemini: i nuovi endpoint rispondono 503 (analisi non disponibile).
  delete process.env.GEMINI_API_KEY;
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (previousKey !== undefined) process.env.GEMINI_API_KEY = previousKey;
  await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

async function post(path: string, body: unknown, raw?: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

test('analyze-timetable: PDF valido senza chiave AI -> 503 generico, no-store, forma {success,error}', async () => {
  const res = await post('/api/analyze-timetable', {
    imageBase64: validPdfBase64,
    mimeType: 'application/pdf',
    documentType: 'personal-support-timetable',
    periodsPerDay: 5,
    profile,
  });
  assert.equal(res.status, 503);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const data = await res.json();
  assert.equal(data.success, false);
  assert.match(data.error, /non è disponibile|non è stato elaborato|riprova/i);
  assert.equal('items' in data, false, 'nessun campo inatteso nella risposta');
  assert.doesNotMatch(JSON.stringify(data), /stack|Error:|PDF/i, 'nessun dettaglio tecnico o contenuto nel corpo');
});

test('analyze-timetable: funziona anche con documentType curricolare (stesso 503 senza chiave)', async () => {
  const res = await post('/api/analyze-timetable', {
    imageBase64: validPdfBase64,
    mimeType: 'application/pdf',
    documentType: 'curricular-timetable',
    coordinateScope: [{ dayOfWeek: 2, periodIndex: 1, classLabel: '3D' }],
    profile,
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).success, false);
});

/**
 * `coordinateScope`: l'elenco delle celle da cercare nell'orario curricolare.
 * Validato PRIMA di chiamare Gemini, quindi ogni rifiuto è un 400 senza analisi.
 */
test('analyze-timetable: coordinateScope accettato solo per il curricolare, normalizzato e mai vuoto', async () => {
  await withIsolatedEndpoint(async post => {
    const base = { imageBase64: validPdfBase64, mimeType: 'application/pdf', profile };
    const curricular = (coordinateScope: unknown) => post({ ...base, documentType: 'curricular-timetable', coordinateScope });
    const personal = (extra: Record<string, unknown> = {}) =>
      post({ ...base, documentType: 'personal-support-timetable', periodsPerDay: 5, ...extra });

    // Accettato: i guard passano e la richiesta arriva all'handler dell'endpoint
    // isolato (che risponde 200 senza chiamare Gemini).
    const ok = await curricular([{ dayOfWeek: 2, periodIndex: 1, classLabel: '3D' }]);
    assert.equal(ok.status, 200, 'scope valido: nessuna rejection dei guard');

    // Rifiutato per l'orario personale: la geometria personale nasce dalla posizione.
    const onPersonal = await personal({ coordinateScope: [{ dayOfWeek: 2, periodIndex: 1, classLabel: '3D' }] });
    assert.equal(onPersonal.status, 400);
    assert.match((await onPersonal.json()).error, /non sono previste per l'orario personale/i);

    // Obbligatorio e mai vuoto per il curricolare.
    for (const empty of [undefined, [], null, 'none', {}]) {
      const res = await curricular(empty);
      assert.equal(res.status, 400, `scope ${JSON.stringify(empty)} rifiutato`);
      assert.match((await res.json()).error, /Nessuna coordinata da cercare/i);
    }

    // Ogni elemento è validato rigidamente: forma, intervalli, classe reale.
    const invalidElements: unknown[] = [
      [{ dayOfWeek: 2, periodIndex: 1 }],                                   // classe assente
      [{ dayOfWeek: 2, periodIndex: 1, classLabel: 'Co' }],                  // codice interno, non una classe
      [{ dayOfWeek: 0, periodIndex: 1, classLabel: '3D' }],                  // giorno fuori intervallo
      [{ dayOfWeek: 2, periodIndex: 0, classLabel: '3D' }],                  // ora fuori intervallo
      [{ dayOfWeek: 2, periodIndex: 99, classLabel: '3D' }],                 // oltre MAX_GRID_PERIODS
      [{ dayOfWeek: '2', periodIndex: 1, classLabel: '3D' }],                // giorno non intero
      [{ dayOfWeek: 2, periodIndex: 1, classLabel: '3D', key: '2|1|3D' }],   // chiave interna non ammessa
      'non-un-array',
    ];
    for (const element of invalidElements) {
      const res = await curricular(element);
      assert.equal(res.status, 400, `elemento ${JSON.stringify(element)} rifiutato`);
    }

    // Tetto coerente con la geometria massima della griglia.
    const tooMany = Array.from({ length: 200 }, (_, i) => ({
      dayOfWeek: (i % 6) + 1, periodIndex: (i % 12) + 1, classLabel: `${(i % 5) + 1}${String.fromCharCode(65 + (i % 26))}`,
    }));
    assert.equal((await curricular(tooMany)).status, 400, 'oltre il tetto: nessuna richiesta chilometrica');
  }, { perIp: 200, global: 200 });
});

test('analyze-timetable: coordinateScope duplicato e con grafie diverse collassa in una sola richiesta', async () => {
  const scope = validateTimetableAnalysisPayload({
    imageBase64: validPdfBase64,
    mimeType: 'application/pdf',
    documentType: 'curricular-timetable',
    profile,
    coordinateScope: [
      { dayOfWeek: 2, periodIndex: 1, classLabel: '3D' },
      { dayOfWeek: 2, periodIndex: 1, classLabel: '3 D' },     // stessa classe, altra grafia
      { dayOfWeek: 2, periodIndex: 1, classLabel: '3°D' },     // e un'altra ancora
      { dayOfWeek: 3, periodIndex: 2, classLabel: 'classe 3E' },
    ],
  }).coordinateScope;
  assert.deepEqual(scope, [
    { dayOfWeek: 2, periodIndex: 1, classLabel: '3D' },
    { dayOfWeek: 3, periodIndex: 2, classLabel: '3E' },
  ], 'una sola coordinata per celle uguali, con la sigla normalizzata');
});

test('analyze-timetable: il personale non restituisce coordinateScope e il curricolare non riceve ore per giorno', async () => {
  const personal = validateTimetableAnalysisPayload({
    imageBase64: validPdfBase64, mimeType: 'application/pdf',
    documentType: 'personal-support-timetable', periodsPerDay: 5, profile,
  });
  assert.equal(personal.periodsPerDay, 5);
  assert.equal(personal.coordinateScope, undefined);

  const curricular = validateTimetableAnalysisPayload({
    imageBase64: validPdfBase64, mimeType: 'application/pdf',
    documentType: 'curricular-timetable', periodsPerDay: 5,
    coordinateScope: [{ dayOfWeek: 2, periodIndex: 1, classLabel: '3D' }], profile,
  });
  assert.equal(curricular.periodsPerDay, undefined, 'le ore per giorno restano un dato del personale');
  assert.equal(curricular.coordinateScope?.length, 1);
});

test('analyze-timetable: payload invalidi -> 400/415 con messaggi generici', async () => {
  // documentType non valido
  const badType = await post('/api/analyze-timetable', {
    imageBase64: validPdfBase64,
    mimeType: 'application/pdf',
    documentType: 'circolare',
    profile,
  });
  assert.equal(badType.status, 400);
  assert.match((await badType.json()).error, /non valido/i);

  // immagine mancante
  const noImage = await post('/api/analyze-timetable', { documentType: 'personal-support-timetable', profile });
  assert.equal(noImage.status, 400);

  // MIME non supportato
  const badMime = await post('/api/analyze-timetable', {
    imageBase64: validPdfBase64,
    mimeType: 'text/html',
    documentType: 'personal-support-timetable',
    profile,
  });
  assert.equal(badMime.status, 415);
  assert.match((await badMime.json()).error, /non supportato/i);

  // Firma PDF falsa
  const badSig = await post('/api/analyze-timetable', {
    imageBase64: Buffer.from('not a pdf at all').toString('base64'),
    mimeType: 'application/pdf',
    documentType: 'personal-support-timetable',
    profile,
  });
  assert.equal(badSig.status, 400);
  assert.match((await badSig.json()).error, /non valida/i);

  // Profilo malformato
  const badProfile = await post('/api/analyze-timetable', {
    imageBase64: validPdfBase64,
    mimeType: 'application/pdf',
    documentType: 'personal-support-timetable',
    periodsPerDay: 5,
    profile: { classes: '1A' },
  });
  assert.equal(badProfile.status, 400);
});

test('analyze-timetable: ore per giorno obbligatorie e valide per l orario personale', async () => {
  // Endpoint isolato: contatore rate-limit dedicato (la validazione è la stessa).
  await withIsolatedEndpoint(async post => {
    const base = { imageBase64: validPdfBase64, mimeType: 'application/pdf', documentType: 'personal-support-timetable', profile };

    // Assente: l'analisi non può partire (nessuna lunghezza attesa verificabile).
    const missing = await post(base);
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /ore/i);

    // Non intero, non positivo, non numerico: sempre 400 con messaggio per l'utente.
    for (const bad of [0, 2.5, '5']) {
      const res = await post({ ...base, periodsPerDay: bad });
      assert.equal(res.status, 400, `periodsPerDay=${JSON.stringify(bad)} deve essere rifiutato`);
      const body = await res.json();
      assert.match(body.error, /ore/i);
      assert.doesNotMatch(JSON.stringify(body), /stack|Error:|TypeError/i, 'nessun dettaglio tecnico nel corpo');
    }

    // Valido: supera i guard e arriva all'handler.
    const ok = await post({ ...base, periodsPerDay: 5 });
    assert.equal(ok.status, 200);
  });

  // Curricolare: le ore per giorno non sono richieste (503 senza chiave AI);
  // servono invece le coordinate da cercare.
  const curricular = await post('/api/analyze-timetable', {
    imageBase64: validPdfBase64,
    mimeType: 'application/pdf',
    documentType: 'curricular-timetable',
    coordinateScope: [{ dayOfWeek: 2, periodIndex: 1, classLabel: '3D' }],
    profile,
  });
  assert.equal(curricular.status, 503);
});

test('analyze-student-document: PDF valido senza chiave AI -> 503; immagine mancante -> 400', async () => {
  const ok503 = await post('/api/analyze-student-document', { imageBase64: validPdfBase64, mimeType: 'application/pdf', profile });
  assert.equal(ok503.status, 503);
  assert.equal((await ok503.json()).success, false);

  const missing = await post('/api/analyze-student-document', { mimeType: 'application/pdf', profile });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /foto|PDF/i);
});

test('route sconosciute /api e GET sugli endpoint -> 404 JSON (mai HTML)', async () => {
  const getOnPost = await fetch(`${baseUrl}/api/analyze-timetable`);
  assert.equal(getOnPost.status, 404);
  assert.match(getOnPost.headers.get('content-type') ?? '', /json/);
  const unknown = await fetch(`${baseUrl}/api/non-esistente`);
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get('content-type') ?? '', /json/);
});

/**
 * Limiti di volume e corpo (413/415/malformed JSON) su un'app isolata con gli
 * stessi guard: evita di consumare il budget rate-limit dell'app reale.
 */
/**
 * `guardOptions` alza i contatori del rate limit quando un test deve provare molti
 * payload in fila: la validazione è la stessa, cambia solo il budget del bucket.
 */
async function withIsolatedEndpoint(
  run: (post: (body: unknown, raw?: string, headers?: Record<string, string>) => Promise<Response>) => Promise<void>,
  guardOptions: { perIp?: number; global?: number; concurrent?: number } = {},
) {
  const isolated = express();
  isolated.post('/api/analyze-timetable', ...createAnalysisGuards(validateTimetableAnalysisPayload, guardOptions), (_req, res) => res.json({ success: true }));
  isolated.use('/api/analyze-timetable', createAnalysisErrorHandler(false));
  const local = isolated.listen(0, '127.0.0.1');
  await once(local, 'listening');
  const base = `http://127.0.0.1:${(local.address() as { port: number }).port}`;
  try {
    await run((body, raw, headers = {}) =>
      fetch(`${base}/api/analyze-timetable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: raw ?? JSON.stringify(body),
      }));
  } finally {
    await new Promise<void>((resolve, reject) => local.close(e => (e ? reject(e) : resolve())));
  }
}

test('guard condivisi: file troppo grande -> 413, body JSON oltre il limite -> 413, JSON malformato -> 400 generico', async () => {
  await withIsolatedEndpoint(async post => {
    const big = await post({
      imageBase64: Buffer.alloc(ANALYSIS_LIMITS.fileBytes + 1).toString('base64'),
      mimeType: 'application/pdf',
      documentType: 'personal-support-timetable',
      profile,
    });
    assert.equal(big.status, 413);
    assert.match((await big.json()).error, /troppo grande/i);

    const hugeJson = await post(null, 'x'.repeat(ANALYSIS_LIMITS.jsonBytes + 1));
    assert.equal(hugeJson.status, 413);

    const malformed = await post(null, '{"secretDocumentContent":"mai rivelato",');
    assert.equal(malformed.status, 400);
    const text = await malformed.text();
    assert.doesNotMatch(text, /secretDocumentContent|SyntaxError/, 'nessuna perdita del contenuto nel corpo di errore');
  });
});

test('guard condivisi: corpo non JSON -> 415 su entrambi gli endpoint', async () => {
  const isolated = express();
  isolated.post('/api/analyze-student-document', ...createAnalysisGuards(validateStudentDocumentPayload), (_req, res) => res.json({ success: true }));
  isolated.use('/api/analyze-student-document', createAnalysisErrorHandler(false));
  const local = isolated.listen(0, '127.0.0.1');
  await once(local, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${(local.address() as { port: number }).port}/api/analyze-student-document`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'plain text',
    });
    assert.equal(res.status, 415);
    assert.match((await res.json()).error, /JSON/i);
  } finally {
    await new Promise<void>((resolve, reject) => local.close(e => (e ? reject(e) : resolve())));
  }
});
