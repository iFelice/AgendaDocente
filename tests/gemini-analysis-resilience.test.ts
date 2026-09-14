import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CIRCULAR_ANALYSIS_TIMEOUT_MS,
  GEMINI_CANDIDATE_MODELS_DEFAULT,
  GEMINI_MAX_ATTEMPTS_PER_MODEL,
  GEMINI_MIN_ATTEMPT_MS,
  GEMINI_RESPONSE_RESERVE_MS,
  classifyGeminiError,
  geminiAttemptTimeoutMs,
  geminiCandidateModels,
  geminiErrorStatus,
  isTransientGeminiCategory,
  parseGeminiJson,
  runGeminiJson,
} from '../server';
import {
  STUDENT_DOCUMENT_TIMEOUT_MS,
  TIMETABLE_ANALYSIS_TIMEOUT_MS,
  describeAnalysisFailure,
  parseTimetableAiResponse,
} from '../server/timetableAnalysis';
import { SCAN_REQUEST_TIMEOUT_MS } from '../src/services/scanService';

/**
 * Causa REALE del 503 "Il documento non è stato elaborato. Riprova più tardi."
 * su /api/analyze-timetable dopo la PR #14 (iPhone/PWA, PNG 636 KB).
 *
 * La richiesta arriva a Gemini (il profilo passa i guard), ma ogni tentativo
 * viene tagliato da `httpOptions.timeout: 20_000` fisso. Nel SDK @google/genai
 * quel valore èsia un abort locale del fetch (AbortError "This operation was
 * aborted", NESSUN codice HTTP nel messaggio) sia l'header `X-Server-Timeout`
 * inviato al backend, cioè una deadline di servizio. Un'estrazione che richiede
 * tutte le celle di una tabella intera (thinking attivo di default sui modelli
 * Gemini 3.x) supera i 20 s: l'errore non era classificato transitorio
 * (`isHighDemand` guardava solo 503/429/UNAVAILABLE/RESOURCE_EXHAUSTED), quindi
 * la cascata si fermava, bruciava il budget dell'endpoint (45 s) e rispondeva
 * 503 senza che nessun modello avesse mai avuto tempo sufficiente.
 *
 * I test qui sotto usano un orologio finto: nessuna attesa reale.
 */

const clock = { now: 0 };
const sleep = async (ms: number) => { clock.now += ms; };

function controller() {
  return new AbortController();
}

type Call = { model: string; config: any };

/** Client Gemini finto: registra le chiamate e si comporta come `behavior` indica. */
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
  const error: any = new Error(`{"error":{"code":${status},"message":${JSON.stringify(message)},"status":"${status === 429 ? 'RESOURCE_EXHAUSTED' : status === 404 ? 'NOT_FOUND' : status === 503 ? 'UNAVAILABLE' : status === 504 ? 'DEADLINE_EXCEEDED' : 'INVALID_ARGUMENT'}"}}`);
  error.name = 'ApiError';
  error.status = status;
  return error;
};

const attemptTimeout = (client: Call[]) => client.map((call) => call.config.httpOptions.timeout as number);

const baseOptions = {
  systemInstruction: 'Estrai la tabella.',
  contents: [{ inlineData: { data: 'BASE64_DOCUMENTO_SENTINELLA', mimeType: 'image/png' } }, { text: 'Analizza la tabella della foto allegata.' }],
  responseSchema: { type: 'OBJECT', properties: {}, required: [] },
};

async function run(behavior: Parameters<typeof stubClient>[0], options: Partial<Parameters<typeof runGeminiJson>[0]> = {}) {
  clock.now = 0;
  const { client, calls } = stubClient(behavior);
  const logs: string[] = [];
  const result = await runGeminiJson({
    ...baseOptions,
    signal: controller().signal,
    label: 'AI Orari',
    budgetMs: 45_000,
    client,
    log: (line) => logs.push(line),
    now: () => clock.now,
    sleep,
    ...options,
  } as any);
  return { result, calls, logs };
}

// ---------------------------------------------------------------------------
// 1. Classificazione: il timeout del tentativo e il 504 erano errori fatali
// ---------------------------------------------------------------------------

test('un timeout del tentativo (AbortError senza status) è transitorio, non un errore definitivo', () => {
  // Riproduce l'errore reale del SDK: name AbortError, messaggio senza codici HTTP.
  const abort: any = new Error('This operation was aborted');
  abort.name = 'AbortError';
  const classified = classifyGeminiError(abort, { aborted: false });
  assert.equal(classified.category, 'deadline');
  assert.equal(classified.status, null);
  assert.equal(isTransientGeminiCategory(classified.category), true, 'la cascata deve proseguire, come per 429/503');

  // Il 504 documentato ("deadline_exceeded") ricade nella stessa classe.
  const deadline = classifyGeminiError(apiError(504, 'Deadline exceeded before response.'), { aborted: false });
  assert.equal(deadline.category, 'deadline');
  assert.equal(isTransientGeminiCategory(deadline.category), true);
});

test('classificazione completa: quota, sovraccarico, modello assente, chiave, richiesta valida, abort esterno', () => {
  const cases: Array<[unknown, string, boolean]> = [
    [apiError(429, 'Resource has been exhausted (per-day quota).'), 'quota', true],
    [apiError(503, 'Model is currently unavailable.'), 'sovraccarico', true],
    [apiError(500, 'Internal error.'), 'sovraccarico', true],
    [apiError(404, 'Publisher model `models/gemini-3.8-flash` was not found.'), 'modello-non-trovato', false],
    [apiError(401, 'API key not valid. Please pass a valid API key.'), 'chiave-o-permessi', false],
    [apiError(403, 'Permission denied on resource project.'), 'chiave-o-permessi', false],
    [apiError(400, 'Invalid JSON payload received.'), 'richiesta-non-valida', false],
  ];
  for (const [error, category, transient] of cases) {
    const classified = classifyGeminiError(error, { aborted: false });
    assert.equal(classified.category, category, `categoria di ${category}`);
    assert.equal(isTransientGeminiCategory(classified.category), transient, `retry di ${category}`);
  }

  // Abort esterno (client disconnesso o deadline dell'endpoint): mai ritentare.
  assert.deepEqual(classifyGeminiError(apiError(503, 'x'), { aborted: true }), { category: 'annullata', status: null });

  // Il messaggio del corpo JSON basta da solo quando manca `status`.
  const raw = new Error('{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}');
  assert.equal(geminiErrorStatus(raw), 429);
  assert.equal(classifyGeminiError(raw, { aborted: false }).category, 'quota');
  assert.equal(geminiErrorStatus(new Error('fetch failed')), null);
  assert.equal(classifyGeminiError(new Error('fetch failed'), { aborted: false }).category, 'rete');
});

// ---------------------------------------------------------------------------
// 2. Budget: il tentativo riceve il tempo rimasto, non 20 s fisse
// ---------------------------------------------------------------------------

test('timeout del tentativo = budget rimasto meno il margine di risposta (mai i 20 s fissi)', () => {
  assert.equal(geminiAttemptTimeoutMs(TIMETABLE_ANALYSIS_TIMEOUT_MS), TIMETABLE_ANALYSIS_TIMEOUT_MS - GEMINI_RESPONSE_RESERVE_MS);
  assert.ok(TIMETABLE_ANALYSIS_TIMEOUT_MS - GEMINI_RESPONSE_RESERVE_MS > 20_000, 'un\'analisi di una tabella fotografata deve poter superare i 20 s');
  // Budget quasi esaurito: non parte un tentativo destinato a morire a metà.
  assert.equal(geminiAttemptTimeoutMs(GEMINI_MIN_ATTEMPT_MS + GEMINI_RESPONSE_RESERVE_MS - 1), 0);
  assert.equal(geminiAttemptTimeoutMs(1_000), 0);
  assert.ok(geminiAttemptTimeoutMs(30_000) > geminiAttemptTimeoutMs(20_000), 'budget maggiore ⇒ tentativo maggiore');
});

test('regressione: una generazione da 26 s (limite storico 20 s) completa e l\'analisi riesce', async () => {
  const { result, calls } = await run((call) => {
    clock.now += 26_000; // più del vecchio timeout fisso, meno del budget
    return { text: '{"rows":["Manganiello"],"cells":[]}' };
  });
  assert.equal(result.ok, true, 'il tentativo non deve essere tagliato a 20 s');
  assert.equal(result.source, 'gemini-3.1-flash-lite');
  assert.equal(attemptTimeout(calls)[0], 45_000 - GEMINI_RESPONSE_RESERVE_MS);
  assert.equal(calls.length, 1, 'nessuna cascata quando il primo modello ce la fa');
  assert.deepEqual(result.attempts, [{ model: 'gemini-3.1-flash-lite', attempt: 1, category: 'ok', status: null, durationMs: 26_000, thinking: 'default' }]);
});

// ---------------------------------------------------------------------------
// 3. Cascata: transitori ritentati su entrambi i modelli, definitivi no
// ---------------------------------------------------------------------------

test('errori transitori: due tentativi per modello con backoff, poi 503 con categoria nota', async () => {
  const waits: number[] = [];
  const { result, calls } = await run(
    (call) => { clock.now += 400; return apiError(503, 'Model is currently unavailable.'); },
    { sleep: async (ms: number) => { waits.push(ms); clock.now += ms; } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.category, 'sovraccarico');
  assert.equal(calls.length, GEMINI_MAX_ATTEMPTS_PER_MODEL * GEMINI_CANDIDATE_MODELS_DEFAULT.length);
  assert.deepEqual(calls.map((call) => call.model), GEMINI_CANDIDATE_MODELS_DEFAULT.flatMap((model) => [model, model]), 'due tentativi sullo stesso modello, poi il modello successivo');
  assert.deepEqual(waits, [1_000, 2_000], 'backoff esponenziale (non il fisso 500 ms che non aiuta con 429/503)');
  assert.deepEqual(result.attempts.map((a) => `${a.model}:${a.category}:${a.status}`), [
    'gemini-3.1-flash-lite:sovraccarico:503', 'gemini-3.1-flash-lite:sovraccarico:503',
    'gemini-3.8-flash:sovraccarico:503', 'gemini-3.8-flash:sovraccarico:503',
  ]);
});

test('429 di quota: retry su entrambi i modelli con backoff crescente', async () => {
  const { result, calls } = await run(() => apiError(429, 'Resource has been exhausted'));
  assert.equal(result.category, 'quota');
  assert.equal(calls.length, 4, '2 tentativi × 2 modelli');
  assert.equal(result.ok, false);
});

test('timeout del tentativo: nessun modello viene tagliato a 20 s e il tempo residuo non viene sprecato in tentativi spacciati', async () => {
  // Ogni tentativo "costa" 20 s (orologio finto): con il budget di 45 s il primo
  // modello ha spazio per due tentativi realistici, il secondo no → si risponde
  // subito 503 invece di restare appesi fin oltre il deadline dell'endpoint.
  const { result, calls, logs } = await run(() => {
    clock.now += 20_000;
    const error: any = new Error('This operation was aborted');
    error.name = 'AbortError';
    return error;
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, 'deadline');
  assert.equal(calls.length, 2, 'il secondo modello non riceve un tentativo spacciato: si risponde subito');
  assert.ok(attemptTimeout(calls).every((timeout) => timeout > 20_000), `timeout mai più corti del vecchio limite fisso: ${attemptTimeout(calls).join(',')}`);
  assert.match(logs.at(-1) ?? '', /budget di tempo terminato/);
});

test('abort esterno (client disconnesso): nessun tentativo, la cascata si ferma', async () => {
  const ctrl = controller();
  ctrl.abort();
  const { client, calls } = stubClient(() => ({ text: '{}' }));
  clock.now = 0;
  const aborted = await runGeminiJson({ ...baseOptions, signal: ctrl.signal, label: 'AI Orari', budgetMs: 45_000, client, log: () => {}, now: () => clock.now, sleep } as any);
  assert.equal(calls.length, 0, 'con il segnale già abortito Gemini non deve essere chiamato');
  assert.equal(aborted.ok, false);
  assert.equal(aborted.category, 'annullata');
});

test('abort durante un tentativo: mai ritentare su una richiesta già chiusa', async () => {
  const ctrl = controller();
  clock.now = 0;
  const logs: string[] = [];
  const client = {
    models: {
      generateContent: async () => {
        ctrl.abort(); // il deadline dell'endpoint scatta mentre il modello sta lavorando
        clock.now += 45_000;
        const error: any = new Error('This operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    },
  };
  const result = await runGeminiJson({ ...baseOptions, signal: ctrl.signal, label: 'AI Orari', budgetMs: 45_000, client, log: (line) => logs.push(line), now: () => clock.now, sleep } as any);
  assert.equal(result.ok, false);
  assert.equal(result.category, 'annullata');
  assert.equal(result.attempts.length, 1, 'un solo tentativo registrato');
});

// ---------------------------------------------------------------------------
// 4. Esiti HTTP 200 inutilizzabili: bloccati o JSON malformato
// ---------------------------------------------------------------------------

test('output bloccato/vuoto (200 senza testo) e output troncato sono tentativi falliti, non successi', async () => {
  const empty = await run(() => ({ text: undefined }));
  assert.equal(empty.result.ok, false);
  assert.equal(empty.result.category, 'output-vuoto');

  const truncated = await run((call, index) =>
    index === 0 ? { text: '{"rows":["x"', finishReason: 'MAX_TOKENS' } : { text: '{"rows":[],"cells":[]}' },
  );
  assert.equal(truncated.result.ok, true, 'output troncato: si prova il modello successivo');
  assert.equal(truncated.result.attempts[0].category, 'output-troncato');
});

test('parseGeminiJson: un JSON non interpretabile è diagnostica controllata, mai un crash con contenuto', () => {
  const logs: string[] = [];
  const broken = parseGeminiJson('{"rows":[], CUT-OFF', 'AI Orari', (line) => logs.push(line));
  assert.equal(broken.ok, false);
  assert.match(logs[0], /json-non-valido/);
  assert.doesNotMatch(logs.join('\n'), /rows|CUT-OFF/, 'il corpo della risposta non finisce nei log');

  const missing = parseGeminiJson('', 'AI Orari', () => {});
  assert.deepEqual(missing, { ok: true, value: null }, 'assenza di testo è gestita dal chiamante');
  assert.deepEqual(parseGeminiJson('{"a":1}', 'AI Orari', () => {}), { ok: true, value: { a: 1 } });
});

// ---------------------------------------------------------------------------
// 5. Thinking: richiesta bassa, con degrado automatico se il modello la rifiuta
// ---------------------------------------------------------------------------

test('thinking basso per l\'estrazione strutturata; se il modello risponde 400 si riprova senza senza consumare tentativi', async () => {
  const ok = await run(() => ({ text: '{"rows":[],"cells":[]}' }), { thinkingLevel: 'low' });
  assert.deepEqual(ok.calls[0].config.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(ok.result.attempts[0].thinking, 'basso');

  let first = true;
  const degraded = await run(() => {
    if (first) { first = false; return apiError(400, 'Field `generation_config.thinking_config` is not supported for this model.'); }
    return { text: '{"rows":[],"cells":[]}' };
  }, { thinkingLevel: 'low' });
  assert.equal(degraded.result.ok, true, 'un modello che non accetta thinkingLevel non può bloccare l\'analisi');
  assert.deepEqual(degraded.calls.map((call) => call.config.thinkingConfig), [{ thinkingLevel: 'low' }, undefined]);
  assert.equal(degraded.calls[1].model, degraded.calls[0].model, 'il degrado riprova lo stesso modello');
  assert.equal(degraded.result.attempts.length, 2, 'degrado + successo restano un solo tentativo utile');

  // Senza thinkingLevel (circolari) il comportamento resta quello storico.
  const plain = await run(() => ({ text: '[]' }));
  assert.equal(plain.calls[0].config.thinkingConfig, undefined);
});

// ---------------------------------------------------------------------------
// 6. Configurazione dei modelli e privacy dei log
// ---------------------------------------------------------------------------

test('GEMINI_CANDIDATE_MODELS permette di verificare i modelli reali senza rifare il build', () => {
  assert.deepEqual(geminiCandidateModels({}), GEMINI_CANDIDATE_MODELS_DEFAULT);
  assert.deepEqual(geminiCandidateModels({ GEMINI_CANDIDATE_MODELS: 'gemini-3.5-flash' }), ['gemini-3.5-flash']);
  assert.deepEqual(geminiCandidateModels({ GEMINI_CANDIDATE_MODELS: ' gemini-3.5-flash , gemini-3.1-flash-lite ' }), ['gemini-3.5-flash', 'gemini-3.1-flash-lite']);
  // Valori assurdi o tentativi di iniezione: si resta sui predefiniti.
  for (const raw of ['', '   ', 'no spaces allowed', 'a'.repeat(80), 'ok-model,'.repeat(6), 'model/../../etc', 'MODEL;DROP']) {
    assert.deepEqual(geminiCandidateModels({ GEMINI_CANDIDATE_MODELS: raw }), GEMINI_CANDIDATE_MODELS_DEFAULT, `valore rifiutato: ${raw.slice(0, 20)}`);
  }
});

test('chiave AI assente: categoria esplicita, messaggio invariato per l\'utente', async () => {
  clock.now = 0;
  const logs: string[] = [];
  const result = await runGeminiJson({ ...baseOptions, signal: controller().signal, label: 'AI Orari', budgetMs: 45_000, client: null, log: (line) => logs.push(line), now: () => clock.now, sleep } as any);
  assert.equal(result.ok, false);
  assert.equal(result.category, 'non-configurato');
  assert.match(logs.join('\n'), /GEMINI_API_KEY assente/);
  assert.doesNotMatch(JSON.stringify(result), /BASE64_DOCUMENTO_SENTINELLA|Analizza la tabella/, 'né il documento né il prompt nei risultati');
});

test('diagnostica leggibile su Render: modello, tentativo, status, categoria, durata — mai il documento', async () => {
  const { logs } = await run((call, index) => (index === 0 ? apiError(429, 'Resource has been exhausted') : { text: '{"rows":[],"cells":[]}' }));
  const line = logs[0];
  assert.match(line, /^\[AI Orari\] modello=gemini-3\.1-flash-lite tentativo=1\/2 esito=fallito categoria=quota status=429 thinking=default timeoutMs=\d+ durataMs=\d+$/);
  const all = logs.join('\n');
  for (const forbidden of ['BASE64_DOCUMENTO_SENTINELLA', 'iVBOR', 'Analizza la tabella', 'Estrai la tabella', 'responseSchema', 'Manganiello', 'properties']) {
    assert.ok(!all.includes(forbidden), `il log non deve contenere "${forbidden}"`);
  }
  assert.match(all.slice(-400), /analisi cloud non riuscita|esito=ok/, 'esito finale o successo registrato');
});

// ---------------------------------------------------------------------------
// 7. Coerenza dei budget fra client, endpoint e runner
// ---------------------------------------------------------------------------

test('i budget sono coerenti: endpoint < client, e il runner ha spazio per la cascata e per la risposta', () => {
  for (const budget of [CIRCULAR_ANALYSIS_TIMEOUT_MS, TIMETABLE_ANALYSIS_TIMEOUT_MS, STUDENT_DOCUMENT_TIMEOUT_MS]) {
    assert.ok(budget - GEMINI_RESPONSE_RESERVE_MS >= 2 * GEMINI_MIN_ATTEMPT_MS, `budget ${budget}: almeno due tentativi utili`);
    assert.ok(SCAN_REQUEST_TIMEOUT_MS > budget, 'il client deve aspettare la risposta 503/200 del server');
  }
  assert.equal(TIMETABLE_ANALYSIS_TIMEOUT_MS, 45_000, 'deadline invariato: nessuna attesa extra per l\'utente');
});

// ---------------------------------------------------------------------------
// DIAGNOSTICA DELLA FASE DI VALIDAZIONE (crash iPhone dopo il formato denso)
// ---------------------------------------------------------------------------

test('diagnostica validazione: esito controllato e log privacy-safe (solo tipi e conteggi)', () => {
  // Cella senza `raw`: forma errata -> errore di forma con messaggio fisso.
  const shapePayload = { rows: ['Rossi Matteo'], periodsPerDay: 5, cells: [{ rowIndex: 0, dayOfWeek: 2, periodIndex: 1 }] };
  let shapeError: unknown = null;
  try {
    parseTimetableAiResponse('personal-support-timetable', shapePayload);
    assert.fail('la forma errata deve essere rifiutata');
  } catch (error) {
    shapeError = error;
  }
  const shapeLog = describeAnalysisFailure(shapeError, shapePayload, 'personal-support-timetable');
  assert.match(shapeLog, /\[AI Orari\] fase=validazione documento=personale esito=fallito motivo=Cella orario non valida/);
  assert.match(shapeLog, /tipo=TimetableShapeError/);
  assert.match(shapeLog, /righe=1 celle=1 periodsPerDay=5/, 'conteggi utili a capire il payload senza leggerlo');
  assert.ok(!shapeLog.includes('Rossi'), 'nessun nome di docente nel log');
  assert.ok(!shapeLog.includes('3D'), 'nessuna classe nel log');

  // Errore interno inatteso: SOLO il tipo. Il messaggio di un TypeError pu\u00f2
  // contenere frammenti del payload e non viene mai riportato.
  const exploding = {
    get rows(): never {
      throw new TypeError('Cannot read properties of undefined (reading \u201cRossi Matteo 3D\u201d)');
    },
    cells: [],
  };
  let internalError: unknown = null;
  try {
    parseTimetableAiResponse('personal-support-timetable', exploding);
    assert.fail('l\u2019errore interno deve propagarsi al catch dell\u2019endpoint');
  } catch (error) {
    internalError = error;
  }
  const internalLog = describeAnalysisFailure(internalError, { rows: 3, cells: 'no', periodsPerDay: 'x' }, 'personal-support-timetable');
  assert.match(internalLog, /motivo=errore interno di validazione tipo=TypeError/);
  assert.match(internalLog, /righe=-1 celle=-1 periodsPerDay=assente/, 'conteggi difensivi su payload non interpretabile');
  assert.ok(!/Rossi|Matteo|3D|trim/.test(internalLog), 'nessun frammento di documento o di messaggio interno nel log');
});
