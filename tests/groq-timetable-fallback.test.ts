import express from 'express';
import { once } from 'node:events';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, geminiCandidateModels, isTransientGeminiCategory } from '../server';
import {
  GROQ_CHAT_COMPLETIONS_URL,
  GROQ_IMAGE_MIME_TYPES,
  GROQ_REASONING_EFFORT,
  GROQ_REASONING_FORMAT,
  GROQ_TEMPERATURE,
  GROQ_VISION_MODEL_DEFAULT,
  classifyGroqHttpStatus,
  groqAttemptTimeoutMs,
  groqConfigured,
  groqFallbackDecision,
  groqJsonSchemaFrom,
  groqSupportsMimeType,
  groqVisionModel,
  runGroqJson,
} from '../server/groqAnalysis';
import {
  buildCurricularTimetablePrompt,
  curricularTimetableSchema,
  parseTimetableAiResponse,
  personalTimetableSchema,
} from '../server/timetableAnalysis';

/**
 * Fallback Groq Vision su /api/analyze-timetable.
 *
 * Nessuna chiamata reale a Gemini o a Groq: `runGroqJson` riceve un `fetch`
 * iniettato e i test d'endpoint sostituiscono `globalThis.fetch`, che è lo
 * stesso identificatore usato dal SDK `@google/genai`. Le chiavi sono segnaposto
 * e nessuna asserzione dipende dal contenuto del documento.
 *
 * Tutti i dati qui sotto sono sintetici (classi 1A/2B): nessun dato reale.
 */

const TEST_GEMINI_KEY = 'test-gemini-key-placeholder';
const TEST_GROQ_KEY = 'test-groq-key-placeholder';

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

/** PNG fittizio: la firma binaria è reale (i guard la verificano), il resto no. */
const pngBase64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('immagine-sintetica-non-reale'),
]).toString('base64');
const pdfBase64 = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');

/** Risposta curricolare conforme al contratto targets[] (dati sintetici). */
const groqCurricularText = JSON.stringify({
  targets: [
    { dayOfWeek: 1, periodIndex: 1, classLabel: '1A', matches: [{ cellText: '1A', subject: 'Matematica' }] },
    { dayOfWeek: 2, periodIndex: 1, classLabel: '2B', matches: [] },
  ],
});

const CURRICULAR_SCOPE = [
  { dayOfWeek: 1, periodIndex: 1, classLabel: '1A' },
  { dayOfWeek: 2, periodIndex: 1, classLabel: '2B' },
];

/** Categorie che il classificatore Gemini esistente considera transitorie. */
const TRANSIENT = ['sovraccarico', 'quota', 'deadline', 'rete'] as const;
/** Categorie deterministiche: la richiesta è sbagliata, un altro provider non aiuta. */
const DETERMINISTIC = [
  'richiesta-non-valida',
  'modello-non-trovato',
  'chiave-o-permessi',
  'json-non-valido',
  'output-vuoto',
  'output-troncato',
  'budget-esaurito',
  'annullata',
  'non-configurato',
  'sconosciuta',
] as const;

const decide = (overrides: Partial<Parameters<typeof groqFallbackDecision>[0]> = {}) =>
  groqFallbackDecision({
    geminiOk: false,
    geminiTransient: true,
    groqConfigured: true,
    mimeType: 'image/png',
    remainingBudgetMs: 30_000,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// 1. CONDIZIONI DI ATTIVAZIONE
// ---------------------------------------------------------------------------

test('fallback Groq: Gemini a buon fine -> Groq NON viene chiamato', () => {
  const decision = decide({ geminiOk: true, geminiTransient: false });
  assert.equal(decision.proceed, false);
  assert.equal(decision.reason, 'gemini-ok');
  // Anche un esito ok classificato (impossibile, ma difensivo) non attiva nulla.
  assert.equal(decide({ geminiOk: true, geminiTransient: true }).proceed, false);
});

test('fallback Groq: attivato solo sulle categorie che il classificatore Gemini dice transitorie', () => {
  for (const category of TRANSIENT) {
    assert.ok(isTransientGeminiCategory(category), `${category} è transitorio per Gemini`);
    assert.equal(decide({ geminiTransient: isTransientGeminiCategory(category) }).proceed, true, `${category} -> fallback`);
  }
  for (const category of DETERMINISTIC) {
    assert.equal(isTransientGeminiCategory(category), false, `${category} non è transitorio`);
    const decision = decide({ geminiTransient: isTransientGeminiCategory(category) });
    assert.equal(decision.proceed, false, `${category} -> nessun fallback`);
    assert.equal(decision.reason, 'errore-non-transitorio');
  }
});

test('fallback Groq: GROQ_API_KEY assente o vuota -> comportamento attuale, nessun crash', () => {
  assert.equal(groqConfigured({}), false);
  assert.equal(groqConfigured({ GROQ_API_KEY: '' }), false);
  assert.equal(groqConfigured({ GROQ_API_KEY: '   ' }), false);
  assert.equal(groqConfigured({ GROQ_API_KEY: TEST_GROQ_KEY }), true);
  const decision = decide({ groqConfigured: false });
  assert.equal(decision.proceed, false);
  assert.equal(decision.reason, 'non-configurato');
});

test('fallback Groq: rifiutato su PDF e su MIME non supportati, ammesso su PNG/JPEG/WebP', () => {
  for (const mime of GROQ_IMAGE_MIME_TYPES) assert.equal(groqSupportsMimeType(mime), true, `${mime} supportato`);
  for (const mime of ['application/pdf', 'image/gif', 'image/svg+xml', 'text/plain', '']) {
    assert.equal(groqSupportsMimeType(mime), false, `${mime} non supportato`);
    assert.equal(decide({ mimeType: mime }).proceed, false, `${mime} -> nessun fallback`);
  }
  assert.equal(decide({ mimeType: 'application/pdf' }).reason, 'mime-non-supportato');
  assert.equal(decide({ mimeType: 'IMAGE/PNG' }).proceed, true, 'il MIME è normalizzato in minuscolo');
});

test('fallback Groq: budget residuo insufficiente -> nessun tentativo', () => {
  assert.equal(groqAttemptTimeoutMs(30_000) > 0, true);
  assert.equal(groqAttemptTimeoutMs(1_000), 0);
  assert.equal(decide({ remainingBudgetMs: 1_000 }).proceed, false);
  assert.equal(decide({ remainingBudgetMs: 1_000 }).reason, 'budget-esaurito');
});

test('fallback Groq: modello e parametri di estrazione deterministica', () => {
  assert.equal(groqVisionModel({}), GROQ_VISION_MODEL_DEFAULT);
  assert.equal(groqVisionModel({ GROQ_VISION_MODEL: 'qwen/qwen3.6-27b' }), 'qwen/qwen3.6-27b');
  assert.equal(groqVisionModel({ GROQ_VISION_MODEL: 'non valido!' }), GROQ_VISION_MODEL_DEFAULT);
  assert.equal(GROQ_TEMPERATURE, 0, 'estrazione deterministica');
  assert.equal(GROQ_REASONING_EFFORT, 'none', 'nessun reasoning');
  assert.equal(GROQ_REASONING_FORMAT, 'hidden', 'nessuna catena di pensiero nella risposta');
  for (const status of [429, 401, 404, 408, 400, 503, 500, 418]) {
    assert.equal(typeof classifyGroqHttpStatus(status), 'string');
  }
  assert.equal(classifyGroqHttpStatus(503), 'sovraccarico');
  assert.equal(classifyGroqHttpStatus(429), 'quota');
  assert.equal(classifyGroqHttpStatus(401), 'chiave-o-permessi');
});

// ---------------------------------------------------------------------------
// 2. STRUCTURED OUTPUT DERIVATO DAGLI SCHEMI GEMINI ESISTENTI
// ---------------------------------------------------------------------------

test('fallback Groq: lo Structured Output è derivato dagli schemi Gemini, in modalità strict', () => {
  for (const schema of [curricularTimetableSchema, personalTimetableSchema]) {
    const converted = groqJsonSchemaFrom(schema) as Record<string, any>;
    assert.equal(converted.type, 'object');
    assert.equal(converted.additionalProperties, false, 'strict: nessun campo extra');
    assert.deepEqual(
      [...converted.required].sort(),
      Object.keys(converted.properties).sort(),
      'strict: ogni proprietà è richiesta',
    );
  }
  const curricular = groqJsonSchemaFrom(curricularTimetableSchema) as Record<string, any>;
  assert.deepEqual(Object.keys(curricular.properties), ['targets'], 'il contratto applicativo targets[] non cambia');
  const target = curricular.properties.targets.items;
  assert.deepEqual(Object.keys(target.properties).sort(), ['classLabel', 'dayOfWeek', 'matches', 'periodIndex']);
  // La prova della cella viaggia anche nello Structured Output di Groq.
  assert.equal(target.properties.matches.type, 'array');
  const match = target.properties.matches.items;
  assert.equal(match.type, 'object');
  assert.deepEqual(Object.keys(match.properties).sort(), ['cellText', 'subject']);
  assert.equal(match.properties.cellText.type, 'string');
  assert.equal(match.properties.subject.type, 'string');
  assert.deepEqual([...match.required].sort(), ['cellText', 'subject'], 'strict: entrambi i campi della prova sono richiesti');
  assert.equal(match.additionalProperties, false, 'nessun campo extra nella prova');
  assert.equal(target.properties.dayOfWeek.type, 'integer');
  const personal = groqJsonSchemaFrom(personalTimetableSchema) as Record<string, any>;
  assert.equal(personal.properties.days.items.properties.cells.type, 'array', 'geometria personale preservata');
  assert.match(JSON.stringify(curricular.properties.targets.description ?? ''), /coordinata/i, 'le description sopravvivono');
});

test('fallback Groq: uno schema non convertibile non produce una richiesta ambigua', () => {
  for (const bad of [null, undefined, 'testo', { type: 'WIDGET' }, { type: 'OBJECT', properties: { a: { type: 'MAGIA' } } }]) {
    assert.throws(() => groqJsonSchemaFrom(bad), /schema non convertibile/, `rifiutato: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 3. runGroqJson: FORMA DELLA RICHIESTA ED ESITI (fetch iniettato)
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, any>;
}

async function withStubFetch(
  handler: (url: string) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>,
  run: (captured: CapturedRequest[], fetchImpl: typeof fetch) => Promise<void>,
) {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    captured.push({ url, init, body });
    const outcome = await handler(url);
    return new Response(JSON.stringify(outcome.body ?? {}), {
      status: outcome.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  await run(captured, fetchImpl);
  return captured;
}

const groqOptions = (overrides: Partial<Parameters<typeof runGroqJson>[0]> = {}) => ({
  systemInstruction: buildCurricularTimetablePrompt(CURRICULAR_SCOPE),
  userText: 'Analizza la tabella della foto/PDF allegata rispettando le regole del prompt.',
  imageBase64: pngBase64,
  mimeType: 'image/png',
  responseSchema: curricularTimetableSchema,
  signal: new AbortController().signal,
  label: 'AI Orari',
  budgetMs: 30_000,
  apiKey: TEST_GROQ_KEY,
  fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
  log: () => {},
  ...overrides,
});

test('runGroqJson: stessa immagine, stesso prompt e stesso obiettivo JSON di Gemini', async () => {
  const prompt = buildCurricularTimetablePrompt(CURRICULAR_SCOPE);
  let seen: CapturedRequest[] = [];
  await withStubFetch(
    () => ({ status: 200, body: { choices: [{ message: { content: groqCurricularText }, finish_reason: 'stop' }] } }),
    async (calls, fetchImpl) => {
      seen = calls;
      const result = await runGroqJson(groqOptions({ fetchImpl }));
      assert.equal(result.ok, true);
      assert.equal(result.source, GROQ_VISION_MODEL_DEFAULT);
      assert.equal(result.text, groqCurricularText, 'il testo torna al chiamante senza riscritture');
    },
  );
  assert.equal(seen.length, 1, 'un solo tentativo: i retry restano di Gemini');
  assert.equal(seen[0].url, GROQ_CHAT_COMPLETIONS_URL);
  const { init, body } = seen[0];
  assert.equal(init.method, 'POST');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TEST_GROQ_KEY}`, 'chiave solo nell header');
  assert.equal(body.model, GROQ_VISION_MODEL_DEFAULT);
  // Prompt IDENTICO a quello di Gemini, nello stesso ruolo di systemInstruction.
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, prompt);
  // Immagine identica, come data URL nel formato OpenAI-compatible.
  const userParts = body.messages[1].content;
  assert.equal(body.messages[1].role, 'user');
  assert.equal(userParts[0].type, 'text');
  assert.equal(userParts[1].type, 'image_url');
  assert.equal(userParts[1].image_url.url, `data:image/png;base64,${pngBase64}`);
  // Structured Output strict sullo schema applicativo già in uso.
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties), ['targets']);
  // Estrazione deterministica, senza reasoning nell'output.
  assert.equal(body.temperature, GROQ_TEMPERATURE);
  assert.equal(body.reasoning_effort, GROQ_REASONING_EFFORT);
  assert.equal(body.reasoning_format, GROQ_REASONING_FORMAT);
  assert.equal('stream' in body, false, 'nessuno streaming');
});

test('runGroqJson: esiti HTTP, output vuoto e troncato classificati senza contenuto nei log', async () => {
  const cases: Array<[number, string]> = [
    [503, 'sovraccarico'],
    [500, 'sovraccarico'],
    [429, 'quota'],
    [504, 'deadline'],
    [401, 'chiave-o-permessi'],
    [404, 'modello-non-trovato'],
    [400, 'richiesta-non-valida'],
    [418, 'sconosciuta'],
  ];
  for (const [status, category] of cases) {
    const lines: string[] = [];
    const result = await runGroqJson(groqOptions({
      log: (line) => lines.push(line),
      fetchImpl: (async () => new Response('errore', { status })) as unknown as typeof fetch,
    }));
    assert.equal(result.ok, false, `status ${status}`);
    assert.equal(result.category, category, `status ${status}`);
    assert.equal(result.text, '', 'nessun testo su fallimento');
    assert.match(lines.join('\n'), /provider=groq .* esito=fallito/, 'log strutturato');
    assert.doesNotMatch(lines.join('\n'), /errore/, 'il corpo della risposta non finisce nei log');
  }
  // HTTP 200 ma contenuto inutilizzabile.
  const empty = await runGroqJson(groqOptions({
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), { status: 200 })) as unknown as typeof fetch,
  }));
  assert.equal(empty.category, 'output-vuoto');
  const truncated = await runGroqJson(groqOptions({
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"targets":[' }, finish_reason: 'length' }] }), { status: 200 })) as unknown as typeof fetch,
  }));
  assert.equal(truncated.category, 'output-troncato');
  const unparsable = await runGroqJson(groqOptions({
    fetchImpl: (async () => new Response('non-json', { status: 200, headers: { 'Content-Type': 'text/plain' } })) as unknown as typeof fetch,
  }));
  assert.equal(unparsable.category, 'output-vuoto', 'corpo non JSON: nessun crash');
});

test('runGroqJson: senza chiave, con PDF, senza budget o con richiesta interrotta non parte alcuna chiamata', async () => {
  const guards: Array<[string, Partial<Parameters<typeof runGroqJson>[0]>, string]> = [
    ['chiave assente', { apiKey: '' }, 'non-configurato'],
    ['PDF', { mimeType: 'application/pdf', imageBase64: pdfBase64 }, 'mime-non-supportato'],
    ['budget esaurito', { budgetMs: 1_000 }, 'budget-esaurito'],
    ['schema non convertibile', { responseSchema: { type: 'WIDGET' } }, 'richiesta-non-valida'],
  ];
  for (const [name, overrides, category] of guards) {
    let called = 0;
    const result = await runGroqJson(groqOptions({
      ...overrides,
      log: () => {},
      fetchImpl: (async () => { called += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
    }));
    assert.equal(result.ok, false, name);
    assert.equal(result.category, category, name);
    assert.equal(called, 0, `${name}: nessuna chiamata di rete`);
  }
  const aborted = new AbortController();
  aborted.abort();
  const result = await runGroqJson(groqOptions({ signal: aborted.signal, log: () => {} }));
  assert.equal(result.category, 'annullata');
});

test('runGroqJson: errore di rete e timeout del tentativo sono classificati, non propagati', async () => {
  const network = await runGroqJson(groqOptions({
    log: () => {},
    fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
  }));
  assert.equal(network.ok, false);
  assert.equal(network.category, 'rete');
  // Timeout del singolo tentativo: il segnale passato a fetch è un controller
  // INTERNO (non quello dell'endpoint), quindi può scadere da solo; un AbortError
  // non causato dal segnale esterno è classificato deadline, non annullata.
  const external = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const timeout = await runGroqJson(groqOptions({
    signal: external.signal,
    log: () => {},
    fetchImpl: (async (_input: any, init: any) => {
      seenSignal = init.signal as AbortSignal;
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch,
  }));
  assert.equal(timeout.ok, false);
  assert.equal(timeout.category, 'deadline', 'timeout del tentativo, non annullamento del client');
  assert.ok(seenSignal instanceof AbortSignal, 'a fetch arriva un segnale di timeout');
  assert.notEqual(seenSignal, external.signal, 'il timeout è armato su un controller interno');
  assert.equal(external.signal.aborted, false, 'il segnale dell endpoint non viene toccato');
  // L'annullamento esterno resta invece una categoria a sé.
  external.abort();
  const cancelled = await runGroqJson(groqOptions({ signal: external.signal, log: () => {} }));
  assert.equal(cancelled.category, 'annullata');
});

// ---------------------------------------------------------------------------
// 4. IL PROVIDER NON PUÒ BYPASSARE IL VALIDATORE APPLICATIVO
// ---------------------------------------------------------------------------

test('validatore condiviso: il JSON di Groq passa nello STESSO parseTimetableAiResponse', () => {
  // Curricolare: la risposta di Groq produce le stesse righe/celle di Gemini.
  const outcome = parseTimetableAiResponse('curricular-timetable', JSON.parse(groqCurricularText), '', undefined, CURRICULAR_SCOPE);
  assert.equal(outcome.curricularRows.length, 1, 'solo la coordinata con una materia');
  assert.equal(outcome.cells.length, 1);
  assert.deepEqual(
    outcome.cells.map((cell) => `${cell.dayOfWeek}|${cell.periodIndex}|${cell.raw}`),
    ['1|1|1A'],
  );
  // Più materie sulla stessa coordinata: il crossref le vedrà come ambigue.
  const coTeaching = parseTimetableAiResponse(
    'curricular-timetable',
    { targets: [{ dayOfWeek: 1, periodIndex: 1, classLabel: '1A', matches: [{ cellText: '1A', subject: 'Matematica' }, { cellText: '1A 1B', subject: 'Scienze' }] }] },
    '',
    undefined,
    [CURRICULAR_SCOPE[0]],
  );
  assert.equal(coTeaching.cells.length, 2, 'due materie -> due celle sulla stessa coordinata');
  // Una coordinata non richiesta viene scartata anche se Groq la inventa.
  const notRequested = parseTimetableAiResponse(
    'curricular-timetable',
    { targets: [{ dayOfWeek: 5, periodIndex: 5, classLabel: '2B', matches: [{ cellText: '2B', subject: 'Arte' }] }] },
    '',
    undefined,
    CURRICULAR_SCOPE,
  );
  assert.equal(notRequested.cells.length, 0, 'nessuna materia per coordinate fuori elenco');
  // Personale: la geometria a blocchi è verificata esattamente come per Gemini.
  assert.throws(
    () => parseTimetableAiResponse('personal-support-timetable', { rowLabel: 'Rossi M.', days: [{ cells: ['', ''] }] }, 'rossi matteo', 5, undefined),
    /non valid|giorni|blocc|celle|forma/i,
    'un payload personale con 1 blocco invece di 5 è rifiutato anche se arriva da Groq',
  );
});

test('validatore condiviso: JSON o schema non validi da Groq sono rifiutati, non accettati', () => {
  const invalid: unknown[] = [
    { targets: 'non-un-array' },
    { targets: [{ dayOfWeek: 1, periodIndex: 1, classLabel: '1A' }] }, // matches mancante
    { targets: [{ dayOfWeek: 1, periodIndex: 1, classLabel: '1A', matches: 'Matematica' }] },
    { targets: [{ dayOfWeek: 99, periodIndex: 1, classLabel: '1A', matches: [] }] },
    { rows: [], cells: [] }, // vecchio contratto di trascrizione
    { targets: [{ dayOfWeek: 1, periodIndex: 1, classLabel: '1A', subjects: ['Matematica'] }] }, // contratto senza evidenza
    { targets: [{ dayOfWeek: 1, periodIndex: 1, classLabel: 'Co', matches: [{ cellText: 'Co', subject: 'Arte' }] }] }, // codice interno
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseTimetableAiResponse('curricular-timetable', value, '', undefined, CURRICULAR_SCOPE),
      /./,
      `rifiutato: ${JSON.stringify(value)}`,
    );
  }
  assert.throws(() => JSON.parse('non è JSON'), /./, 'un testo non JSON non arriva nemmeno al validatore');
});

// ---------------------------------------------------------------------------
// 5. PRIVACY DEI LOG
// ---------------------------------------------------------------------------

test('privacy: i log del fallback contengono solo modello, categoria e durata', async () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  await runGroqJson(groqOptions({ log, apiKey: TEST_GROQ_KEY }));
  await runGroqJson(groqOptions({ log, apiKey: '' }));
  await runGroqJson(groqOptions({ log, fetchImpl: (async () => new Response('errore', { status: 503 })) as unknown as typeof fetch }));
  const dump = lines.join('\n');
  assert.match(dump, /provider=groq/, 'i log identificano il provider');
  assert.ok(dump.includes(GROQ_VISION_MODEL_DEFAULT), 'il modello è tracciato');
  assert.doesNotMatch(dump, new RegExp(TEST_GROQ_KEY), 'la chiave non finisce nei log');
  assert.doesNotMatch(dump, new RegExp(pngBase64.slice(0, 24)), 'nessun frammento di base64');
  assert.doesNotMatch(dump, /data:image/, 'nessuna data URL');
  for (const secret of ['1A', '2B', 'Matematica', 'Scienze', 'Docente', 'targets', 'COORDINATE']) {
    assert.ok(!dump.includes(secret), `nessun contenuto del documento o del prompt: ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// 6. ENDPOINT REALE: /api/analyze-timetable con fetch globale sostituito
// ---------------------------------------------------------------------------

const GEMINI_HOST = 'generativelanguage.googleapis.com';
const GROQ_HOST = 'api.groq.com';

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
const realFetch = globalThis.fetch;
const previousGeminiKey = process.env.GEMINI_API_KEY;
const previousGroqKey = process.env.GROQ_API_KEY;
/** Richieste intercettate durante un test d'endpoint, per host. */
let intercepted: string[] = [];
let logLines: string[] = [];

before(async () => {
  process.env.GEMINI_API_KEY = TEST_GEMINI_KEY;
  delete process.env.GROQ_API_KEY;
  server = app.listen(0, '127.0.0.1');
  // Il guard di /api/analyze-timetable concede 10 richieste/min per IP e questi
  // test ne fanno di più di proposito: ogni connessione presenta un indirizzo
  // sorgente distinto. È un gancio solo sul server DI TEST (nessun cambiamento
  // al guard né alla produzione) e rende la suite indipendente dal numero di POST.
  let sourceIndex = 0;
  server.on('connection', (socket) => {
    sourceIndex += 1;
    Object.defineProperty(socket, 'remoteAddress', { value: `10.0.${Math.floor(sourceIndex / 250)}.${(sourceIndex % 250) + 1}`, configurable: true });
  });
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = previousGeminiKey;
  if (previousGroqKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = previousGroqKey;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

/** Risposta Gemini conforme al contratto targets[] (stesso formato di Groq). */
const geminiJsonResponse = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
});

/**
 * Sostituisce `globalThis.fetch`: le chiamate al server locale passano davvero,
 * quelle verso Gemini e Groq sono simulate. Nessuna richiesta esce dal test.
 */
function stubProviders(handlers: {
  gemini: () => { status: number; body: unknown };
  groq?: () => { status: number; body: unknown };
}) {
  intercepted = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith(baseUrl)) return realFetch(input, init);
    if (url.includes(GEMINI_HOST)) {
      intercepted.push('gemini');
      const outcome = handlers.gemini();
      return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes(GROQ_HOST)) {
      intercepted.push('groq');
      const outcome = handlers.groq?.() ?? { status: 503, body: {} };
      return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`chiamata di rete inattesa: ${url}`);
  }) as unknown as typeof fetch;
}

function captureLogs() {
  logLines = [];
  const warn = console.warn;
  const info = console.log;
  console.warn = (line: unknown) => { logLines.push(String(line)); };
  console.log = (line: unknown) => { logLines.push(String(line)); };
  return () => { console.warn = warn; console.log = info; };
}

async function postTimetable(body: unknown) {
  return realFetch(`${baseUrl}/api/analyze-timetable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const curricularBody = {
  imageBase64: pngBase64,
  mimeType: 'image/png',
  documentType: 'curricular-timetable',
  coordinateScope: CURRICULAR_SCOPE,
  profile,
};

test('endpoint: Gemini a buon fine -> Groq NON viene chiamato e il contratto non cambia', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({ gemini: () => ({ status: 200, body: geminiJsonResponse(groqCurricularText) }) });
  const restore = captureLogs();
  try {
    const res = await postTimetable(curricularBody);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.source, geminiCandidateModels()[0], 'source = il modello Gemini che ha risposto');
    assert.equal(data.cells.length, 1);
    assert.deepEqual(intercepted.filter((host) => host === 'groq'), [], 'nessuna chiamata a Groq');
    assert.ok(intercepted.includes('gemini'), 'Gemini è stato chiamato');
    assert.match(logLines.join('\n'), /provider=gemini esito=ok/, 'log del provider primario');
    assert.doesNotMatch(logLines.join('\n'), /fallback=groq/, 'nessun log di fallback');
  } finally {
    restore();
  }
});

test('endpoint: Gemini 503 dopo i retry -> Groq risponde e il risultato passa nello stesso validator', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'Model is currently experiencing high demand' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: groqCurricularText }, finish_reason: 'stop' }] } }),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(curricularBody);
    assert.equal(res.status, 200, 'il fallback salva l analisi');
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.source, GROQ_VISION_MODEL_DEFAULT, 'la risposta dichiara il provider di fallback');
    // Stesso contratto HTTP di prima: righe e celle, nessuna forma nuova.
    assert.equal(data.cells.length, 1);
    assert.deepEqual(data.cells.map((c: any) => `${c.dayOfWeek}|${c.periodIndex}|${c.raw}`), ['1|1|1A']);
    assert.ok(intercepted.filter((h) => h === 'gemini').length >= 2, 'Gemini ha esaurito i suoi tentativi');
    assert.deepEqual(intercepted.filter((h) => h === 'groq'), ['groq'], 'una sola chiamata a Groq');
    const dump = logLines.join('\n');
    assert.match(dump, /provider=gemini esito=fallito categoria=sovraccarico/, 'esito di Gemini tracciato');
    assert.match(dump, /fallback=groq motivo=sovraccarico/, 'motivo del fallback tracciato');
    assert.match(dump, /provider=groq modello=qwen\/qwen3\.8-27b esito=ok/, 'esito di Groq tracciato');
  } finally {
    restore();
  }
});

test('endpoint: Gemini 429 (rate limit) -> fallback consentito', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 429, body: { error: { code: 429, message: 'RESOURCE_EXHAUSTED' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: groqCurricularText }, finish_reason: 'stop' }] } }),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(curricularBody);
    assert.equal(res.status, 200, 'il rate limit di Gemini è transitorio: il fallback risponde');
    assert.equal((await res.json()).source, GROQ_VISION_MODEL_DEFAULT);
    assert.deepEqual(intercepted.filter((h) => h === 'groq'), ['groq']);
    assert.match(logLines.join('\n'), /fallback=groq motivo=quota/);
  } finally {
    restore();
  }
});

test('endpoint: errore di validazione client -> Groq NON viene chiamato', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: {} }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: groqCurricularText } }] } }),
  });
  const restore = captureLogs();
  try {
    // coordinateScope non valido: i guard rifiutano PRIMA di qualsiasi provider.
    const invalid = await postTimetable({ ...curricularBody, coordinateScope: [{ dayOfWeek: 9, periodIndex: 1, classLabel: '1A' }] });
    assert.equal(invalid.status, 400);
    const empty = await postTimetable({ ...curricularBody, coordinateScope: [] });
    assert.equal(empty.status, 400);
    // MIME non supportato.
    const mime = await postTimetable({ ...curricularBody, mimeType: 'image/gif' });
    assert.equal(mime.status, 415);
    // Profilo non valido.
    const badProfile = await postTimetable({ ...curricularBody, profile: { id: 'x' } });
    assert.equal(badProfile.status, 400);
    assert.deepEqual(intercepted, [], 'nessuna chiamata a Gemini né a Groq su request non valida');
    assert.doesNotMatch(logLines.join('\n'), /fallback=groq/);
  } finally {
    restore();
  }
});

test('endpoint: GROQ_API_KEY assente -> 503 controllato, nessun crash, nessun log della chiave', async () => {
  delete process.env.GROQ_API_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: groqCurricularText } }] } }),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(curricularBody);
    assert.equal(res.status, 503, 'comportamento attuale senza chiave Groq');
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /non è stato elaborato/i, 'messaggio utente invariato');
    assert.deepEqual(intercepted.filter((h) => h === 'groq'), [], 'Groq non è raggiungibile senza chiave');
    assert.match(logLines.join('\n'), /fallback=groq saltato motivo=non-configurato/);
    assert.doesNotMatch(logLines.join('\n'), /GROQ_API_KEY|gsk_/);
  } finally {
    restore();
  }
});

test('endpoint: PDF con Gemini in sovraccarico -> resta Gemini-only, Groq non viene chiamato', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: groqCurricularText } }] } }),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable({ ...curricularBody, imageBase64: pdfBase64, mimeType: 'application/pdf' });
    assert.equal(res.status, 503, 'nessuna conversione PDF: il caso resta Gemini-only');
    assert.deepEqual(intercepted.filter((h) => h === 'groq'), [], 'Groq non riceve PDF');
    assert.match(logLines.join('\n'), /fallback=groq saltato motivo=mime-non-supportato/);
  } finally {
    restore();
  }
});

test('endpoint: anche Groq in errore -> stessa risposta 503 controllata di prima', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: () => ({ status: 503, body: { error: { message: 'overloaded' } } }),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(curricularBody);
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /non è stato elaborato/i);
    assert.doesNotMatch(JSON.stringify(data), /stack|Error:|groq|gemini/i, 'nessun dettaglio tecnico nella risposta');
    assert.match(logLines.join('\n'), /provider=groq .* esito=fallito categoria=sovraccarico/);
  } finally {
    restore();
  }
});

test('endpoint: JSON di Groq fuori contratto -> 422 dallo STESSO validatore applicativo', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: '{"targets":"non-un-array"}' }, finish_reason: 'stop' }] } }),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(curricularBody);
    assert.equal(res.status, 422, 'il provider non può bypassare il validatore');
    assert.equal((await res.json()).success, false);
  } finally {
    restore();
  }
});

test('endpoint: testo di Groq non interpretabile -> 503, nessun dettaglio tecnico', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: 'non è JSON' }, finish_reason: 'stop' }] } }),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(curricularBody);
    assert.equal(res.status, 503);
    const raw = await res.text();
    assert.doesNotMatch(raw, /non è JSON|stack|Error:/i, 'nessun contenuto del modello nella risposta');
  } finally {
    restore();
  }
});

test('endpoint: orario personale con Groq -> la geometria a blocchi è verificata come per Gemini', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  // Un solo blocco invece di cinque: il validatore personale deve rifiutarlo
  // anche quando arriva dal provider di fallback.
  const wrongGeometry = JSON.stringify({ rowLabel: 'Rossi M.', days: [{ cells: ['', '', '', '', ''] }] });
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: wrongGeometry }, finish_reason: 'stop' }] } }),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable({
      imageBase64: pngBase64,
      mimeType: 'image/png',
      documentType: 'personal-support-timetable',
      periodsPerDay: 5,
      // Profilo nominato e riga compatibile: ciò che deve fallire è la GEOMETRIA
      // (un blocco invece di cinque), non la guardia d'identità.
      profile: { ...profile, fullName: 'Rossi Matteo' },
    });
    assert.equal(res.status, 422, 'validatePersonalSequencePayload si applica anche a Groq');
    assert.deepEqual(intercepted.filter((h) => h === 'groq'), ['groq'], 'il fallback vale per entrambi i tipi di orario');
  } finally {
    restore();
  }
});

test('endpoint: i log dell intero flusso non contengono chiave, immagine né contenuto', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: groqCurricularText }, finish_reason: 'stop' }] } }),
  });
  const restore = captureLogs();
  try {
    await postTimetable(curricularBody);
    const dump = logLines.join('\n');
    assert.match(dump, /provider=gemini/, 'flusso tracciato');
    assert.match(dump, /fallback=groq/, 'fallback tracciato');
    assert.doesNotMatch(dump, new RegExp(TEST_GROQ_KEY), 'nessuna chiave Groq');
    assert.doesNotMatch(dump, new RegExp(TEST_GEMINI_KEY), 'nessuna chiave Gemini');
    assert.doesNotMatch(dump, new RegExp(pngBase64.slice(0, 24)), 'nessun frammento di base64');
    assert.doesNotMatch(dump, /data:image/, 'nessuna data URL');
    assert.doesNotMatch(dump, /Matematica|Scienze/, 'nessuna materia estratta');
    assert.doesNotMatch(dump, /Docente/, 'nessun nome');
    // Le coordinate restano solo conteggi, come nel log curricolare esistente.
    assert.match(dump, /coordinateRichieste=\d+ coordinateRestituite=\d+ celle=\d+/);
  } finally {
    restore();
  }
});
