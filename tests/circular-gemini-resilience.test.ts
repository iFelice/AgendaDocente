import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CIRCULAR_ANALYSIS_TIMEOUT_MS,
  GEMINI_CANDIDATE_MODELS_DEFAULT,
  geminiCandidateModels,
  runGeminiJson,
  type RunGeminiJsonOptions,
} from '../server';

const clock = { now: 0 };
const sleep = async (ms: number) => { clock.now += ms; };

function controller() {
  return new AbortController();
}

type Call = { model: string; config: any };

function stubClient(behavior: (call: Call, index: number) => { text?: string; finishReason?: string } | Error) {
  const calls: Call[] = [];
  const client = {
    models: {
      generateContent: async (params: any) => {
        const call: Call = { model: params.model, config: params.config };
        calls.push(call);
        const outcome = behavior(call, calls.length - 1);
        if (outcome instanceof Error) throw outcome;
        return { text: outcome.text, candidates: outcome.finishReason ? [{ finishReason: outcome.finishReason }] : [] };
      },
    },
  };
  return { client, calls };
}

const apiError = (status: number, message: string) => {
  const error: any = new Error(
    `{"error":{"code":${status},"message":${JSON.stringify(message)},"status":"${
      status === 429
        ? 'RESOURCE_EXHAUSTED'
        : status === 404
        ? 'NOT_FOUND'
        : status === 503
        ? 'UNAVAILABLE'
        : status === 504
        ? 'DEADLINE_EXCEEDED'
        : status === 401
        ? 'UNAUTHENTICATED'
        : 'INVALID_ARGUMENT'
    }"}}`
  );
  error.name = 'ApiError';
  error.status = status;
  return error;
};

const baseOptions = {
  systemInstruction: 'Estrai gli impegni dalla circolare.',
  contents: [
    { inlineData: { data: 'BASE64_CIRCOLARE_SEGRETA_SENTINELLA', mimeType: 'image/jpeg' } },
    { text: 'Analizza il testo della circolare riservata con codice OCR_SEGRETO_DOCENTI.' },
  ],
  responseSchema: { type: 'ARRAY', items: { type: 'OBJECT', properties: {}, required: [] } },
};

async function runTest(
  behavior: Parameters<typeof stubClient>[0],
  options: Partial<RunGeminiJsonOptions> = {}
) {
  clock.now = 0;
  const { client, calls } = stubClient(behavior);
  const logs: string[] = [];
  const result = await runGeminiJson({
    ...baseOptions,
    signal: controller().signal,
    label: 'AI Circolari',
    budgetMs: CIRCULAR_ANALYSIS_TIMEOUT_MS,
    thinkingLevel: 'low',
    client,
    log: (line) => logs.push(line),
    now: () => clock.now,
    sleep,
    ...options,
  } as any);
  return { result, calls, logs };
}

// ---------------------------------------------------------------------------
// 1. 3.8 successo -> 3.7 non chiamato
// ---------------------------------------------------------------------------

test('1. 3.8 successo -> 3.7 non chiamato', async () => {
  const { result, calls } = await runTest((call) => {
    if (call.model === 'gemini-3.1-flash-lite') {
      return { text: '[{"title":"Collegio Docenti","category":"collegio_docenti","date":"2026-10-15"}]' };
    }
    return apiError(503, 'Unavailable');
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'gemini-3.1-flash-lite');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gemini-3.1-flash-lite');
});

// ---------------------------------------------------------------------------
// 2. 3.8 503 persistente -> fallback 3.7
// ---------------------------------------------------------------------------

test('2. 3.8 503 persistente -> fallback 3.7', async () => {
  const { result, calls, logs } = await runTest((call) => {
    if (call.model === 'gemini-3.1-flash-lite') {
      return apiError(503, 'Model is currently unavailable due to overload.');
    }
    if (call.model === 'gemini-3.5-flash') {
      return { text: '[{"title":"Collegio Docenti","category":"collegio_docenti","date":"2026-10-15"}]' };
    }
    return apiError(500, 'Error');
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'gemini-3.5-flash');
  assert.equal(calls.length, 3, '2 tentativi su 3.8-flash, poi 1 tentativo vincente su 3.7-flash');
  assert.equal(calls[0].model, 'gemini-3.1-flash-lite');
  assert.equal(calls[1].model, 'gemini-3.1-flash-lite');
  assert.equal(calls[2].model, 'gemini-3.5-flash');

  assert.ok(logs.some((l) => l.includes('modello=gemini-3.1-flash-lite') && l.includes('tentativo=1/2')));
  assert.ok(logs.some((l) => l.includes('modello=gemini-3.1-flash-lite') && l.includes('tentativo=2/2')));
  assert.ok(logs.some((l) => l.includes('modello=gemini-3.5-flash') && l.includes('tentativo=1/2')));
});

// ---------------------------------------------------------------------------
// 3. 3.8 429 persistente -> fallback 3.7
// ---------------------------------------------------------------------------

test('3. 3.8 429 persistente -> fallback 3.7', async () => {
  const { result, calls } = await runTest((call) => {
    if (call.model === 'gemini-3.1-flash-lite') {
      return apiError(429, 'Resource has been exhausted (rate limit).');
    }
    if (call.model === 'gemini-3.5-flash') {
      return { text: '[{"title":"Collegio Docenti","category":"collegio_docenti","date":"2026-10-15"}]' };
    }
    return apiError(500, 'Error');
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'gemini-3.5-flash');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].model, 'gemini-3.1-flash-lite');
  assert.equal(calls[1].model, 'gemini-3.1-flash-lite');
  assert.equal(calls[2].model, 'gemini-3.5-flash');
});

// ---------------------------------------------------------------------------
// 4. errore non retryable -> nessun fallback
// ---------------------------------------------------------------------------

test('4. errore non retryable (400 / 401) -> nessun fallback a 3.7', async () => {
  // Test 401: API key invalida (chiave-o-permessi) -> 1 chiamata sola, nessun fallback
  const unauth = await runTest(() => apiError(401, 'API key not valid.'));
  assert.equal(unauth.result.ok, false);
  assert.equal(unauth.result.category, 'chiave-o-permessi');
  assert.equal(unauth.calls.length, 1, 'Nessun fallback su errore di autenticazione');
  assert.equal(unauth.calls[0].model, 'gemini-3.1-flash-lite');

  // Test 400: payload invalido (richiesta-non-valida) -> nessuna chiamata al modello di fallback 3.7
  const invalid = await runTest(() => apiError(400, 'Invalid JSON payload.'));
  assert.equal(invalid.result.ok, false);
  assert.equal(invalid.result.category, 'richiesta-non-valida');
  assert.ok(invalid.calls.every((c) => c.model === 'gemini-3.1-flash-lite'), 'Nessuna chiamata a gemini-3.5-flash');
});

// ---------------------------------------------------------------------------
// 5. candidate models senza duplicati e con default prudente
// ---------------------------------------------------------------------------

test('5. candidate models default = [gemini-3.1-flash-lite, gemini-3.5-flash] e deduplicazione env', () => {
  assert.deepEqual(GEMINI_CANDIDATE_MODELS_DEFAULT, ['gemini-3.1-flash-lite', 'gemini-3.5-flash']);
  assert.deepEqual(geminiCandidateModels({}), ['gemini-3.1-flash-lite', 'gemini-3.5-flash']);

  // Deduplicazione mantenendo l'ordine
  const deduplicated = geminiCandidateModels({
    GEMINI_CANDIDATE_MODELS: 'gemini-3.1-flash-lite, gemini-3.1-flash-lite, gemini-3.5-flash',
  });
  assert.deepEqual(deduplicated, ['gemini-3.1-flash-lite', 'gemini-3.5-flash']);

  // Modelli singoli validi
  assert.deepEqual(geminiCandidateModels({ GEMINI_CANDIDATE_MODELS: 'gemini-2.5-flash' }), ['gemini-2.5-flash']);
});

// ---------------------------------------------------------------------------
// 6. backoff presente tra retry transitori
// ---------------------------------------------------------------------------

test('6. backoff presente tra retry transitori (nessun retry immediato)', async () => {
  const { calls, logs } = await runTest((call) => {
    if (call.model === 'gemini-3.1-flash-lite') {
      return apiError(503, 'Unavailable');
    }
    return { text: '[]' };
  });

  assert.equal(calls.length, 3);
  // Verifica che sia stato loggato ed eseguito il backoff
  const backoffLog = logs.find((l) => l.includes('backoffMs='));
  assert.ok(backoffLog, 'Deve essere presente un log esplicito del backoff');
  assert.ok(backoffLog.includes('modello=gemini-3.1-flash-lite'));
  assert.ok(clock.now >= 1000, `Il tempo simulato è avanzato di almeno 1000ms: clock=${clock.now}`);
});

// ---------------------------------------------------------------------------
// 7. thinkingLevel low nella richiesta circolari
// ---------------------------------------------------------------------------

test('7. thinkingLevel low nella configurazione inviata a Gemini', async () => {
  const { calls } = await runTest(() => ({ text: '[]' }));

  assert.equal(calls.length, 1);
  const config = calls[0].config;
  assert.equal(config.thinkingConfig?.thinkingLevel, 'low', 'thinkingLevel deve essere low');
});

// ---------------------------------------------------------------------------
// 8. nessun contenuto sensibile nei log
// ---------------------------------------------------------------------------

test('8. nessun contenuto circolare, OCR, base64, prompt o API key nei log', async () => {
  const { logs } = await runTest((call) => {
    if (call.model === 'gemini-3.1-flash-lite') {
      return apiError(503, 'Unavailable');
    }
    return { text: '[{"title":"Test"}]' };
  });

  for (const line of logs) {
    assert.doesNotMatch(line, /BASE64_CIRCOLARE_SEGRETA_SENTINELLA/, 'Nessun frammento base64 nei log');
    assert.doesNotMatch(line, /OCR_SEGRETO_DOCENTI/, 'Nessun OCR nei log');
    assert.doesNotMatch(line, /Analizza il testo della circolare/, 'Nessun prompt utente nei log');
    assert.doesNotMatch(line, /Estrai gli impegni dalla circolare/, 'Nessuna systemInstruction nei log');
    assert.doesNotMatch(line, /AIzaSy/, 'Nessuna API key nei log');
  }
});
