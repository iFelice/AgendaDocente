import express from 'express';
import { once } from 'node:events';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, geminiCandidateModels, isTransientGeminiCategory, reconstructPersonalRowPayload, timetableGeminiBudgetMs } from '../server';
import {
  GROQ_CHAT_COMPLETIONS_URL,
  GROQ_IMAGE_MIME_TYPES,
  GROQ_MAX_CALLS_PER_PHASE,
  GROQ_MIN_ATTEMPT_MS,
  GROQ_REASONING_EFFORT,
  GROQ_REASONING_FORMAT,
  GROQ_RESPONSE_RESERVE_MS,
  GROQ_RETRY_MIN_ATTEMPT_MS,
  GROQ_TEMPERATURE,
  GROQ_TIMETABLE_RESERVED_MS,
  GROQ_TWO_PASS_A_SHARE,
  GROQ_TWO_PASS_MIN_ATTEMPT_MS,
  GROQ_VISION_MODEL_DEFAULT,
  classifyGroqHttpStatus,
  groqAttemptTimeoutMs,
  groqConfigured,
  groqFallbackDecision,
  groqJsonSchemaFrom,
  groqPassBBudget,
  groqRetryAttemptTimeoutMs,
  groqRetryableCategory,
  groqSemanticFallbackDecision,
  groqSupportsMimeType,
  groqTwoPassBudgets,
  groqVisionModel,
  runGroqJson,
  runGroqJsonWithTransientRetry,
} from '../server/groqAnalysis';
import {
  TIMETABLE_ANALYSIS_TIMEOUT_MS,
  buildCurricularTimetablePrompt,
  buildPersonalTimetablePrompt,
  buildTeacherRowDetectionPrompt,
  buildPersonalRowTranscriptionPrompt,
  curricularTimetableSchema,
  parseTimetableAiResponse,
  personalRowTranscriptionSchema,
  personalTimetableSchema,
  teacherRowDetectionSchema,
  TEACHER_ROW_NOT_RECOGNIZED_MESSAGE,
  TEACHER_ROW_AMBIGUOUS_MESSAGE,
} from '../server/timetableAnalysis';
import {
  MAX_TEACHER_ROW_LABELS,
  MAX_TEACHER_ROW_LABEL_LENGTH,
  TEACHER_ROW_NOT_RECOGNIZED,
  validateTeacherRowLabelsPayload,
  matchTeacherRowLabel,
} from '../src/utils/timetableAnalysis';
import { analysisAuthHeaders, installAnalysisAuthFixture } from './helpers/analysisAuthFixture';

installAnalysisAuthFixture();

/**
 * Settimana RETTANGOLARE di comodo: `week(6)` = `[6, 6, 6, 6, 6]`.
 *
 * La geometria dello scanner è per giorno (`periodsByDay`); questi test
 * descrivono il caso legacy in cui tutti i giorni hanno le stesse ore, e lo
 * dicono esplicitamente invece di nasconderlo dietro un numero. Valori non
 * ammessi (0, 13, decimali) restano tali: servono ai casi di rifiuto.
 */
const week = (periods: number): number[] => [periods, periods, periods, periods, periods];


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
  const outcome = parseTimetableAiResponse('curricular-timetable', JSON.parse(groqCurricularText), '', week(undefined), CURRICULAR_SCOPE);
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
    week(undefined),
    [CURRICULAR_SCOPE[0]],
  );
  assert.equal(coTeaching.cells.length, 2, 'due materie -> due celle sulla stessa coordinata');
  // Una coordinata non richiesta viene scartata anche se Groq la inventa.
  const notRequested = parseTimetableAiResponse(
    'curricular-timetable',
    { targets: [{ dayOfWeek: 5, periodIndex: 5, classLabel: '2B', matches: [{ cellText: '2B', subject: 'Arte' }] }] },
    '',
    week(undefined),
    CURRICULAR_SCOPE,
  );
  assert.equal(notRequested.cells.length, 0, 'nessuna materia per coordinate fuori elenco');
  // Personale: la geometria a blocchi è verificata esattamente come per Gemini.
  assert.throws(
    () => parseTimetableAiResponse('personal-support-timetable', { rowLabel: 'Rossi M.', days: [{ cells: ['', ''] }] }, 'rossi matteo', week(5), undefined),
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
      () => parseTimetableAiResponse('curricular-timetable', value, '', week(undefined), CURRICULAR_SCOPE),
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
  // Il budget di produzione è per uid (e globale). Questi test non verificano
  // il rate limit: alzano solo il tetto, come gli altri file di endpoint.
  process.env.TEST_RATE_LIMIT = 'relaxed';
  server = app.listen(0, '127.0.0.1');
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
/** Fase Groq di ogni chiamata intercettata, nell'ordine: 'detection' (Passo A) o 'transcription' (Passo B/one-shot). */
let groqPhases: Array<'detection' | 'transcription'> = [];

function stubProviders(handlers: {
  gemini: () => { status: number; body: unknown };
  groq?: (req: { phase: 'detection' | 'transcription'; body: any }) => { status: number; body: unknown };
}) {
  intercepted = [];
  groqPhases = [];
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
      // Il Passo A dichiara lo Structured Output `teacher_rows`; ogni altra chiamata
      // (Passo B a due passaggi o one-shot curricolare) usa `timetable_analysis`.
      const body = JSON.parse(String(init?.body ?? '{}'));
      const phase: 'detection' | 'transcription' =
        body?.response_format?.json_schema?.name === 'teacher_rows' ? 'detection' : 'transcription';
      groqPhases.push(phase);
      const outcome = handlers.groq?.({ phase, body }) ?? { status: 503, body: {} };
      return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`chiamata di rete inattesa: ${url}`);
  }) as unknown as typeof fetch;
}

/** Risposta del Passo A: elenco etichette docenti (dati sintetici). */
const detectionOk = (labels: string[]) => ({
  status: 200,
  body: { choices: [{ message: { content: JSON.stringify({ rowLabels: labels }) }, finish_reason: 'stop' }] },
});

/**
 * Handler Groq a DUE PASSAGGI: Passo A restituisce `labels`, Passo B restituisce
 * `transcription` (testo del contratto personale). Salvo override per HTTP/errori.
 */
const groqTwoPass = (labels: string[], transcription: string) =>
  (req: { phase: 'detection' | 'transcription' }) =>
    req.phase === 'detection'
      ? detectionOk(labels)
      : { status: 200, body: { choices: [{ message: { content: transcription }, finish_reason: 'stop' }] } };

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
    headers: { 'Content-Type': 'application/json', ...analysisAuthHeaders() },
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
  // anche quando arriva dal Passo B del percorso a due passaggi (H6: senza
  // rowLabel, che il server ricostruisce dal Passo A).
  const wrongGeometry = passBPayload([{ cells: ['', '', '', '', ''] }]);
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    // Passo A trova la riga (identità ok), il Passo B sbaglia la GEOMETRIA.
    groq: groqTwoPass(['Rossi M.'], wrongGeometry),
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
    assert.equal(res.status, 422, 'validatePersonalSequencePayload si applica anche al Passo B di Groq');
    assert.deepEqual(groqPhases, ['detection', 'transcription'], 'due passaggi: identificazione poi trascrizione');
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

// ---------------------------------------------------------------------------
// 7. FALLBACK SEMANTICO: Gemini risponde, ma la riga docente non è riconosciuta
// ---------------------------------------------------------------------------

/**
 * Caso reale (H3): foto dell'orario personale con la riga chiaramente leggibile,
 * profilo "Felice Manganiello". Gemini restituisce un payload formalmente
 * valido e sbaglia UNA cella di testo — l'etichetta della riga — quindi la
 * guardia d'identità lo rifiuta con `TEACHER_ROW_NOT_RECOGNIZED` e l'utente
 * riceve un 422 pur avendo fotografato il documento giusto.
 *
 * Non è una richiesta sbagliata: è una lettura OCR sbagliata, l'unico rifiuto
 * di forma su cui un secondo modello di visione può riuscire. Groq rilegge la
 * STESSA immagine con lo stesso prompt, lo stesso schema, lo stesso testo utente
 * e il budget RESIDUO; il payload che torna passa nello STESSO validatore.
 *
 * Il matcher NON diventa fuzzy: "Mangianello" resta rifiutato: cambia solo chi
 * viene interrogato una seconda volta.
 *
 * Nomi e geometria di questa sezione riproducono la segnalazione; nessun altro
 * dato reale è presente.
 */

/** Geometria NON rettangolare del caso reale: il giovedì ha 7 ore. */
const REAL_WEEK = [6, 6, 6, 7, 6];

/** Profilo del caso reale: il cognome è l'unico campo che raggiunge il prompt. */
const manganielloProfile = { ...profile, fullName: 'Felice Manganiello' };

/** `days` conforme a `REAL_WEEK`: celle sintetiche, nessun orario reale. */
const realDays = REAL_WEEK.map((periods, dayIndex) => ({
  cells: Array.from({ length: periods }, (_, cellIndex) => (cellIndex === 0 ? `1A` : '')),
}));

const personalPayload = (rowLabel: string, days: unknown = realDays, declaredClassTotals?: unknown) => JSON.stringify({
  rowLabel,
  ...(declaredClassTotals === undefined ? {} : { declaredClassTotals }),
  days,
});

/**
 * H6 — Payload del PASSO B Groq/Qwen: il modello NON dichiara più la riga, solo
 * `declaredClassTotals` e `days`. Il server ricostruirà `rowLabel` dal match
 * certificato del Passo A prima del validatore condiviso.
 */
const passBPayload = (days: unknown = realDays, declaredClassTotals?: unknown) => JSON.stringify({
  ...(declaredClassTotals === undefined ? {} : { declaredClassTotals }),
  days,
});

const personalBody = {
  imageBase64: pngBase64,
  mimeType: 'image/png',
  documentType: 'personal-support-timetable',
  periodsByDay: REAL_WEEK,
  profile: manganielloProfile,
};

const geminiOk = (text: string) => () => ({ status: 200, body: geminiJsonResponse(text) });
const groqOk = (text: string) => () => ({ status: 200, body: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } });

/** Quante volte ogni provider è stato chiamato in un test d'endpoint. */
const calls = (host: 'gemini' | 'groq') => intercepted.filter((h) => h === host).length;

/** Lista docenti del caso reale (sezione 10): sintetica, nessun dato vero. */
const REAL_TEACHER_LABELS = ['Camilli', 'Costantini', 'Della Gatta', 'Manganiello', 'Mangraviti'];

test('caso reale: Gemini legge "Mangianello", il Passo A trova "Manganiello" (riga 4) e il Passo B lo trascrive SENZA rowLabel -> 200 senza toccare la geometria', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Mangianello')),
    // Passo A: elenco etichette (una sola combacia); Passo B: solo days (H6).
    groq: groqTwoPass(REAL_TEACHER_LABELS, passBPayload()),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200, 'il secondo parere a due passaggi salva una scansione corretta');
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.rowLabel, 'Manganiello', 'vince la riga riconosciuta, non quella di Gemini');
    assert.equal(data.source, GROQ_VISION_MODEL_DEFAULT, 'la risposta dichiara il provider che ha risposto');

    // Geometria INTATTA: il giovedì mantiene 7 celle e nessun periodo scivola.
    const perDay = REAL_WEEK.map((_, dayIndex) => data.cells.filter((c: any) => c.dayOfWeek === dayIndex + 1).length);
    assert.deepEqual(perDay, REAL_WEEK, 'ogni giorno conserva le proprie ore');
    assert.equal(data.cells.length, REAL_WEEK.reduce((a, b) => a + b, 0));
    const thursday = data.cells.filter((c: any) => c.dayOfWeek === 4);
    assert.deepEqual(thursday.map((c: any) => c.periodIndex), [1, 2, 3, 4, 5, 6, 7], 'giovedì: 7 periodi consecutivi');
    // Coordinate derivate dalla POSIZIONE, come sempre: nessuna alterazione.
    assert.deepEqual(
      data.cells.filter((c: any) => c.raw === '1A').map((c: any) => `${c.dayOfWeek}|${c.periodIndex}`),
      ['1|1', '2|1', '3|1', '4|1', '5|1'],
    );

    assert.equal(calls('gemini'), 1, 'Gemini ha risposto al primo colpo: nessun retry tecnico');
    assert.deepEqual(groqPhases, ['detection', 'transcription'], 'due passaggi distinti');
    assert.match(logLines.join('\n'), /fallback=groq motivo=row-docente-non-riconosciuta/, 'motivo semantico tracciato');
    assert.match(logLines.join('\n'), /fase=identificazione-riga esito=ok righe=5/, 'log del Passo A con conteggio righe');
    assert.match(logLines.join('\n'), /fase=trascrizione-riga esito=ok/, 'log del Passo B');
  } finally {
    restore();
  }
});

test('H6: un rowLabel sbagliato nel testo del Passo B viene SCARTATO — vince solo il match del Passo A (200)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Mangianello')),
    // H6: il Passo B non dichiara più la riga. Anche se nel suo testo comparisse
    // un rowLabel sbagliato ("Manganiell"), il server lo scarta e usa
    // ESCLUSIVAMENTE il match certificato del Passo A ("Manganiello").
    groq: groqTwoPass(REAL_TEACHER_LABELS, personalPayload('Manganiell')),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200, 'il rowLabel finale viene solo dal Passo A, mai dal testo del Passo B');
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.rowLabel, 'Manganiello', 'vince il match certificato del Passo A');
    assert.equal(data.cells.length, REAL_WEEK.reduce((a, b) => a + b, 0), 'geometria e celle invariate');
    assert.deepEqual(groqPhases, ['detection', 'transcription']);
  } finally {
    restore();
  }
});

test('fallback semantico: il Passo A fallisce HTTP (503, un solo retry) -> 422 attuale, nessun 503 e nessun crash', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Mangianello')),
    groq: () => ({ status: 503, body: { error: { message: 'overloaded' } } }),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 422, 'il payload di Gemini era decodificabile: resta il rifiuto di forma');
    assert.match((await res.json()).error, /Non ho riconosciuto la riga del tuo orario/i);
    // H6: il 503 del Passo A è transitorio -> UN solo retry, poi ci si ferma.
    // Il Passo B non parte dopo un Passo A fallito.
    assert.deepEqual(groqPhases, ['detection', 'detection'], 'un tentativo + un retry del Passo A, mai il Passo B');
    assert.match(logLines.join('\n'), /provider=groq fase=identificazione-riga .* esito=fallito categoria=sovraccarico/);
    assert.match(logLines.join('\n'), /esito=retry categoria=sovraccarico tentativo=2\/2/);
  } finally {
    restore();
  }
});

test('fallback semantico: Groq non configurato -> 422 attuale, nessuna chiamata', async () => {
  delete process.env.GROQ_API_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Mangianello')),
    groq: groqOk(personalPayload('Manganiello')),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 422, 'senza chiave il comportamento è quello di oggi');
    assert.match((await res.json()).error, /Non ho riconosciuto la riga del tuo orario/i);
    assert.equal(calls('groq'), 0, 'Groq non è raggiungibile senza chiave');
    const dump = logLines.join('\n');
    assert.match(dump, /fallback=groq saltato motivo=non-configurato/);
    assert.doesNotMatch(dump, /GROQ_API_KEY|gsk_/);
  } finally {
    restore();
  }
});

test('fallback semantico: PDF -> Groq NON viene chiamato (nessuna conversione), resta il 422', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Mangianello')),
    groq: groqOk(personalPayload('Manganiello')),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable({ ...personalBody, imageBase64: pdfBase64, mimeType: 'application/pdf' });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /Non ho riconosciuto la riga del tuo orario/i);
    assert.equal(calls('groq'), 0, 'Groq Vision non prende PDF');
    assert.match(logLines.join('\n'), /fallback=groq saltato motivo=mime-non-supportato/);
  } finally {
    restore();
  }
});

test('fallback semantico: un TimetableShapeError diverso NON attiva Groq', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  // Riga RICONOSCIUTA, numero di blocchi giornalieri sbagliato (uno invece di
  // cinque): è una risposta strutturalmente sbagliata, non una lettura sbagliata.
  const restore = captureLogs();
  try {
    stubProviders({
      gemini: geminiOk(personalPayload('Manganiello', [{ cells: ['', '', '', '', '', ''] }])),
      groq: groqOk(personalPayload('Manganiello')),
    });
    const blocks = await postTimetable(personalBody);
    assert.equal(blocks.status, 422, 'numero di giorni errato: 422 immediato');
    assert.match((await blocks.json()).error, /Analisi non riuscita/i, 'messaggio generico, non quello della riga');
    assert.equal(calls('groq'), 0, 'nessun secondo parere su un errore di struttura');

    // `days` assente: forma non valida, stesso trattamento.
    stubProviders({
      gemini: geminiOk(JSON.stringify({ rowLabel: 'Manganiello' })),
      groq: groqOk(personalPayload('Manganiello')),
    });
    const missing = await postTimetable(personalBody);
    assert.equal(missing.status, 422);
    assert.equal(calls('groq'), 0, 'schema non valido: nessun secondo parere');

    // Coordinate curricolari fuori elenco: il fallback semantico è solo personale.
    stubProviders({
      gemini: geminiOk('{"targets":"non-un-array"}'),
      groq: groqOk(groqCurricularText),
    });
    const curricular = await postTimetable(curricularBody);
    assert.equal(curricular.status, 422);
    assert.equal(calls('groq'), 0, 'il curricolare non ha una riga docente da riconoscere');

    assert.doesNotMatch(logLines.join('\n'), /fallback=groq motivo=row-docente-non-riconosciuta/);
  } finally {
    restore();
  }
});

test('fallback semantico: geometria del giovedì sbagliata -> Groq NON viene chiamato', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  // Settimana dichiarata [6,6,6,7,6], giovedì con 6 celle: una cella persa non
  // si recupera chiedendo a un altro modello, si rifiuta.
  const shortThursday = REAL_WEEK.map((periods, dayIndex) => ({
    cells: Array.from({ length: dayIndex === 3 ? 6 : periods }, () => ''),
  }));
  stubProviders({
    gemini: geminiOk(personalPayload('Manganiello', shortThursday)),
    groq: groqOk(personalPayload('Manganiello')),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /Analisi non riuscita/i);
    assert.equal(calls('groq'), 0, 'la geometria non è un caso da secondo parere');
    assert.doesNotMatch(logLines.join('\n'), /fallback=groq motivo=row-docente-non-riconosciuta/);
  } finally {
    restore();
  }
});

test('fallback semantico: Gemini riconosce la riga -> Groq NON viene chiamato', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Manganiello')),
    groq: groqOk(personalPayload('Manganiello')),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.rowLabel, 'Manganiello');
    assert.equal(data.source, geminiCandidateModels()[0], 'nessun cambio di provider');
    assert.equal(calls('groq'), 0, 'niente da correggere, niente seconda chiamata');
    assert.doesNotMatch(logLines.join('\n'), /fallback=groq/);
  } finally {
    restore();
  }
});

test('fallback tecnico: 503 di Gemini -> Groq a due passaggi, e un Passo B fuori forma NON avvia un secondo parere', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: groqTwoPass(REAL_TEACHER_LABELS, passBPayload()),
  });
  const restore = captureLogs();
  try {
    // Fallback TECNICO ora a due passaggi: Gemini esaurisce i tentativi, il
    // Passo A individua la riga e il Passo B la trascrive; il payload
    // ricostruito dal server (rowLabel dal Passo A) passa lo stesso validatore.
    const ok = await postTimetable(personalBody);
    assert.equal(ok.status, 200, 'fallback tecnico a due passaggi');
    assert.equal((await ok.json()).source, GROQ_VISION_MODEL_DEFAULT);
    assert.deepEqual(groqPhases, ['detection', 'transcription']);
    assert.match(logLines.join('\n'), /fallback=groq motivo=sovraccarico .* percorso=due-passaggi/);

    // Se il Passo B produce un payload fuori forma (un blocco invece di cinque),
    // il fallback semantico non riparte (Gemini non ha prodotto nulla):
    // niente terza chiamata, resta il 422 generico.
    stubProviders({
      gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
      groq: groqTwoPass(REAL_TEACHER_LABELS, passBPayload([{ cells: ['', '', '', '', ''] }])),
    });
    const rejected = await postTimetable(personalBody);
    assert.equal(rejected.status, 422);
    assert.match((await rejected.json()).error, /Analisi non riuscita/i, 'errore di forma: messaggio generico');
    assert.deepEqual(groqPhases, ['detection', 'transcription'], 'solo i due passaggi tecnici, nessun terzo tentativo');
    assert.match(logLines.join('\n'), /fallback=groq saltato motivo=gemini-non-ok/);
  } finally {
    restore();
  }
});

const REAL_DECLARED_TOTALS = [
  { classLabel: '3D', hours: 10 },
  { classLabel: '3E', hours: 6 },
  { classLabel: '1C', hours: 2 },
];

function totalsDays(dHours: number, eHours = 6, cHours = 2) {
  const totalPositions = REAL_WEEK.reduce((sum, periods) => sum + periods, 0);
  const flat = [
    ...Array.from({ length: dHours }, () => '3D'),
    ...Array.from({ length: eHours }, () => '3E'),
    ...Array.from({ length: cHours }, () => '1C'),
  ];
  flat.push(...Array.from({ length: totalPositions - flat.length }, () => ''));
  let offset = 0;
  return REAL_WEEK.map((periods) => {
    const cells = flat.slice(offset, offset + periods);
    offset += periods;
    return { cells };
  });
}

test('H4 endpoint: Gemini 11/6/2 incoerente -> Passo A + Passo B (senza rowLabel) 10/6/2 coerente -> 200', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Manganiello', totalsDays(11), REAL_DECLARED_TOTALS)),
    // Passo A trova la riga; Passo B (solo declaredClassTotals+days) coerente (10/6/2).
    groq: groqTwoPass(REAL_TEACHER_LABELS, passBPayload(totalsDays(10), REAL_DECLARED_TOTALS)),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.source, GROQ_VISION_MODEL_DEFAULT);
    assert.equal(data.cells.filter((cell: any) => cell.raw === '3D').length, 10, 'vince solo la trascrizione coerente');
    assert.equal(calls('gemini'), 1);
    assert.deepEqual(groqPhases, ['detection', 'transcription'], 'anche H4 usa il percorso a due passaggi');
    const dump = logLines.join('\n');
    assert.match(dump, /fase=validazione-totali esito=incoerente classiDichiarate=3 classiLette=3/);
    assert.match(dump, /fallback=groq motivo=totali-classi-incoerenti/);
    assert.doesNotMatch(dump, /3D|3E|1C|Manganiello/, 'log H4 senza classi, conteggi per classe o docente');
  } finally {
    restore();
  }
});

test('H4 endpoint: Gemini mismatch e Passo B mismatch -> 422 controllato con controllo manuale', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Manganiello', totalsDays(11), REAL_DECLARED_TOTALS)),
    // Passo A trova la riga, ma il Passo B resta incoerente (9/7/2): H4 rifiuta.
    groq: groqTwoPass(REAL_TEACHER_LABELS, passBPayload(totalsDays(9, 7, 2), REAL_DECLARED_TOTALS)),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 422);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /riepilogo|ore per classe/i);
    assert.match(data.error, /Riprova|manualmente/i);
    assert.deepEqual(groqPhases, ['detection', 'transcription'], 'i due passaggi partono, ma H4 rifiuta il Passo B');
  } finally {
    restore();
  }
});

test('H4 endpoint: Gemini coerente -> 200 e Groq NON chiamato', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Manganiello', totalsDays(10), REAL_DECLARED_TOTALS)),
    groq: groqOk(personalPayload('Manganiello', totalsDays(10), REAL_DECLARED_TOTALS)),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200);
    assert.equal(calls('groq'), 0);
  } finally {
    restore();
  }
});

test('H4 endpoint: PDF mismatch rispetta il limite provider e non chiama Groq', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Manganiello', totalsDays(11), REAL_DECLARED_TOTALS)),
    groq: groqOk(personalPayload('Manganiello', totalsDays(10), REAL_DECLARED_TOTALS)),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable({ ...personalBody, imageBase64: pdfBase64, mimeType: 'application/pdf' });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /riepilogo|ore per classe/i);
    assert.equal(calls('groq'), 0);
    assert.match(logLines.join('\n'), /fallback=groq saltato motivo=mime-non-supportato/);
  } finally {
    restore();
  }
});

test('matcher strict: il fallback semantico non introduce alcun fuzzy matching', () => {
  // La guardia d'identità è la stessa funzione di prima e resta a parole intere:
  // il secondo parere cambia CHI legge, non COSA viene accettato.
  const week = [6, 6, 6, 7, 6];
  const days = week.map((periods) => ({ cells: Array.from({ length: periods }, () => '') }));
  const parse = (rowLabel: string) =>
    parseTimetableAiResponse('personal-support-timetable', { rowLabel, days }, 'Felice Manganiello', week);

  // Troncature, refusi e prefissi restano rifiutati, da qualunque provider arrivino.
  for (const rowLabel of ['Manganiell', 'Mangianello', 'Manganiellos', 'Mangan', 'Manganielli', 'Felic']) {
    assert.throws(() => parse(rowLabel), (error: any) => {
      assert.equal(error.name, 'TimetableShapeError');
      assert.equal(error.code, TEACHER_ROW_NOT_RECOGNIZED, `"${rowLabel}" resta non riconosciuto`);
      return true;
    }, `"${rowLabel}" non deve combaciare con "Manganiello"`);
  }
  // Le sole forme accettate restano quelle di sempre: parola intera del profilo.
  for (const rowLabel of ['Manganiello', 'MANGANIELLO', 'Manganiello F.', 'Prof. Manganiello', 'Felice Manganiello']) {
    assert.equal(parse(rowLabel).rowLabel, rowLabel, `"${rowLabel}" resta accettato`);
  }
});

test('decisione semantica: pura, e stretta su ogni condizione', () => {
  const semantic = (overrides: Partial<Parameters<typeof groqSemanticFallbackDecision>[0]> = {}) =>
    groqSemanticFallbackDecision({
      geminiOk: true,
      personalDocument: true,
      rowNotRecognized: true,
      groqConfigured: true,
      mimeType: 'image/png',
      remainingBudgetMs: 30_000,
      ...overrides,
    });

  assert.equal(semantic().proceed, true, 'il caso previsto passa');
  assert.deepEqual(semantic({ geminiOk: false }), { proceed: false, reason: 'gemini-non-ok' });
  assert.deepEqual(semantic({ personalDocument: false }), { proceed: false, reason: 'documento-non-personale' });
  assert.deepEqual(semantic({ rowNotRecognized: false }), { proceed: false, reason: 'errore-non-semantico' });
  assert.equal(semantic({ rowNotRecognized: false, classTotalsMismatch: true }).proceed, true, 'H4 è il secondo errore di lettura ammesso');
  assert.deepEqual(semantic({ rowNotRecognized: false, classTotalsMismatch: false }), { proceed: false, reason: 'errore-non-semantico' });
  assert.deepEqual(semantic({ groqConfigured: false }), { proceed: false, reason: 'non-configurato' });
  assert.deepEqual(semantic({ mimeType: 'application/pdf' }), { proceed: false, reason: 'mime-non-supportato' });
  assert.deepEqual(semantic({ remainingBudgetMs: 3_000 }), { proceed: false, reason: 'budget-esaurito' });

  // Stessi MIME del fallback tecnico: nessun elenco parallelo.
  for (const mimeType of GROQ_IMAGE_MIME_TYPES) assert.equal(semantic({ mimeType }).proceed, true, mimeType);
  // Il budget è quello RESIDUO: sotto la soglia minima il tentativo non parte.
  assert.equal(semantic({ remainingBudgetMs: GROQ_MIN_ATTEMPT_MS + GROQ_RESPONSE_RESERVE_MS }).proceed, true);
  assert.equal(semantic({ remainingBudgetMs: GROQ_MIN_ATTEMPT_MS + GROQ_RESPONSE_RESERVE_MS - 1 }).proceed, false);
});

test('privacy: il percorso a due passaggi non logga riga, nome del profilo, OCR né JSON', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Mangianello')),
    groq: groqTwoPass(REAL_TEACHER_LABELS, passBPayload()),
  });
  const restore = captureLogs();
  try {
    assert.equal((await postTimetable(personalBody)).status, 200);
    const dump = logLines.join('\n');
    assert.match(dump, /fallback=groq motivo=row-docente-non-riconosciuta/, 'il motivo è un codice, non un contenuto');
    // Il Passo A logga solo il CONTEGGio delle righe, mai le etichette lette.
    assert.match(dump, /fase=identificazione-riga esito=ok righe=\d+/, 'solo conteggio righe');
    assert.match(dump, /fase=trascrizione-riga esito=ok/);
    assert.doesNotMatch(dump, /Manganiello|Mangianello/, 'mai la riga letta né il cognome del profilo');
    assert.doesNotMatch(dump, /Camilli|Costantini|Mangraviti|Della Gatta/, 'mai le etichette del Passo A');
    assert.doesNotMatch(dump, /Felice/, 'mai il nome del profilo');
    assert.doesNotMatch(dump, /rowLabel|"days"|rowLabels/, 'mai il JSON del modello');
    assert.doesNotMatch(dump, /1A|2B/, 'mai le classi');
    assert.doesNotMatch(dump, new RegExp(pngBase64.slice(0, 24)), 'nessun frammento di base64');
    assert.doesNotMatch(dump, new RegExp(TEST_GROQ_KEY), 'nessuna chiave');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 8. H5/H6 — PERCORSO GROQ A DUE PASSAGGI (orario personale)
//
// Passo A (identificazione riga) -> matching server-side rigoroso (strict, mai
// fuzzy) -> Passo B (trascrizione della sola riga). H6: il Passo B non dichiara
// più `rowLabel` (schema con solo `declaredClassTotals`+`days`) e il server lo
// ricostruisce dal match certificato; H3/H4 e il validatore condiviso restano
// invariati. Tutti i dati sono sintetici.
// ---------------------------------------------------------------------------

// --- 8a. Validatore del Passo A (allow-list chiusa) --------------------------

test('H5 Passo A validator: accetta il contratto e applica la allow-list chiusa', () => {
  // Caso valido: le etichette tornano identiche, nell'ordine.
  assert.deepEqual(
    validateTeacherRowLabelsPayload({ rowLabels: ['Camilli', 'Costantini', 'Manganiello'] }),
    ['Camilli', 'Costantini', 'Manganiello'],
  );
  // Politica DETERMINISTICA: le stringhe vuote/di soli spazi sono ELIMINATE.
  assert.deepEqual(
    validateTeacherRowLabelsPayload({ rowLabels: ['Camilli', '', '   ', 'Manganiello'] }),
    ['Camilli', 'Manganiello'],
  );
  // Il trim non altera il contenuto significativo.
  assert.deepEqual(validateTeacherRowLabelsPayload({ rowLabels: ['  Manganiello  '] }), ['Manganiello']);
  // Al tetto massimo: ancora valido.
  const atCap = Array.from({ length: MAX_TEACHER_ROW_LABELS }, (_, i) => `Docente${i}`);
  assert.equal(validateTeacherRowLabelsPayload({ rowLabels: atCap }).length, MAX_TEACHER_ROW_LABELS);
});

test('H5 Passo A validator: rifiuta campi extra, non-array, numeri, oggetti, stringhe lunghe e oltre il tetto', () => {
  const rejected: unknown[] = [
    null,
    'testo',
    ['Manganiello'],
    { rowLabels: 'non-un-array' },
    { rowLabels: {} },
    { rowLabels: 42 },
    { rowLabels: ['Camilli'], extra: 1 },
    { rowLabels: [1, 2, 3] },
    { rowLabels: [{ nome: 'Camilli' }] },
    { rowLabels: [['Camilli']] },
    { rowLabels: ['x'.repeat(MAX_TEACHER_ROW_LABEL_LENGTH + 1)] },
    { rowLabels: Array.from({ length: MAX_TEACHER_ROW_LABELS + 1 }, () => 'Docente') },
  ];
  for (const value of rejected) {
    assert.throws(() => validateTeacherRowLabelsPayload(value), (error: any) => {
      assert.equal(error.name, 'TimetableShapeError', `rifiutato: ${JSON.stringify(value).slice(0, 40)}`);
      return true;
    }, `deve rifiutare: ${JSON.stringify(value).slice(0, 40)}`);
  }
});

// --- 8b. Matching server-side (strict, findTeacherRows) ----------------------

test('H5/H6 matching: una sola corrispondenza esatta -> matched CON rowIndex (mutation A: fuzzy -> fallisce)', () => {
  // Caso reale (sezione 2): lista Qwen con esattamente una riga compatibile.
  const labels = ['Camilli', 'Costantini', 'Della Gatta', 'Manganiello', 'Mangraviti'];
  // H6: il match certifica etichetta E posizione (base 0) dentro la lista validata.
  assert.deepEqual(matchTeacherRowLabel(labels, 'Felice Manganiello'), { status: 'matched', label: 'Manganiello', rowIndex: 3 });
  // Il cognome può comparire come "COGNOME N." o esteso: resta una sola riga.
  assert.deepEqual(matchTeacherRowLabel(['Manganiello F.'], 'Felice Manganiello'), { status: 'matched', label: 'Manganiello F.', rowIndex: 0 });
  // La posizione segue la riga anche quando non è né la prima né l'ultima.
  assert.deepEqual(matchTeacherRowLabel(['Camilli', 'Manganiello', 'Mangraviti'], 'Felice Manganiello'), { status: 'matched', label: 'Manganiello', rowIndex: 1 });
});

test('H5/H6 matching: zero corrispondenze -> none (refuso o cognome diverso, mai un quasi-uguale)', () => {
  // Refuso del Passo A: "Mangianello" NON combacia con il profilo "Manganiello".
  assert.deepEqual(matchTeacherRowLabel(['Camilli', 'Mangianello', 'Costantini'], 'Felice Manganiello'), { status: 'none' });
  // Sottostringa/troncatura: mai una corrispondenza (parola intera).
  assert.deepEqual(matchTeacherRowLabel(['Mangraviti', 'Manganiell', 'Mangan'], 'Felice Manganiello'), { status: 'none' });
  // Lista senza il docente.
  assert.deepEqual(matchTeacherRowLabel(['Camilli', 'Costantini'], 'Felice Manganiello'), { status: 'none' });
  // Zero match: nessun rowIndex plausibile da propagare.
  assert.equal(matchTeacherRowLabel(['Mangianello'], 'Felice Manganiello').status, 'none');
});

test('H5/H6 matching: più di una corrispondenza -> ambiguous (nessuna scelta arbitraria)', () => {
  assert.deepEqual(
    matchTeacherRowLabel(['Manganiello F.', 'Manganiello G.'], 'Felice Manganiello'),
    { status: 'ambiguous' },
  );
});

// --- 8c. Prompt e schema dei due passaggi ------------------------------------

test('H5 prompt: il Passo A guarda SOLO i nomi dei docenti e non riceve il target', () => {
  const promptA = buildTeacherRowDetectionPrompt();
  assert.match(promptA, /NOMI DEI DOCENTI/i);
  assert.match(promptA, /rowLabels/);
  assert.match(promptA, /NON leggere classi, materie, giorni/i);
  // È statico: non contiene alcun cognome target del profilo.
  assert.doesNotMatch(promptA, /Manganiello/);
  // Schema convertibile nello Structured Output strict, con il solo campo rowLabels.
  const converted = groqJsonSchemaFrom(teacherRowDetectionSchema) as Record<string, any>;
  assert.deepEqual(Object.keys(converted.properties), ['rowLabels']);
  assert.equal(converted.properties.rowLabels.type, 'array');
  assert.equal(converted.properties.rowLabels.items.type, 'string');
  assert.equal(converted.additionalProperties, false);
});

test('H6 prompt: il Passo B riceve ETICHETTA E POSIZIONE, e NON chiede più rowLabel (mutation: rowLabel reintrodotto o posizione rimossa -> fallisce)', () => {
  // 'Manganiello' era la riga numero 4 (base 1) della lista del Passo A.
  const promptB = buildPersonalRowTranscriptionPrompt('felice manganiello', REAL_WEEK, 'Manganiello', 3);
  // Contratto H4 invariato: riepilogo separato e blocchi giornalieri restano.
  assert.match(promptB, /declaredClassTotals/);
  assert.match(promptB, /"days"/);
  assert.match(promptB, /RIGA GIÀ INDIVIDUATA DAL SERVER/i);
  // H6: il prompt riceve l'etichetta E la posizione certificata (base 1).
  assert.match(promptB, /"Manganiello"/);
  assert.match(promptB, /riga numero 4\b/, 'la posizione (base 1) della riga è nel prompt');
  assert.match(promptB, /PRIMA riga dei docenti è la numero 1/, 'la convenzione di conteggio è dichiarata');
  // ...e NON chiede più al modello di dichiarare la riga: nessun rowLabel.
  assert.doesNotMatch(promptB, /rowLabel/, 'il Passo B non conosce alcun campo rowLabel');
  assert.match(promptB, /il server associa LUI la trascrizione/i, 'il modello sa che la riga la associa il server');
  // La posizione segue l'indice: base 0 -> base 1, nessun fuori-scala.
  assert.match(buildPersonalRowTranscriptionPrompt('felice manganiello', REAL_WEEK, 'Camilli', 0), /riga numero 1\b/);
});

test('H6 prompt: il prompt di Gemini (percorso monolitico) resta invariato, rowLabel inclusa', () => {
  // H3 resta invariato per Gemini: stesso prompt con la regola P7 e il campo rowLabel.
  const geminiPrompt = buildPersonalTimetablePrompt('felice manganiello', REAL_WEEK);
  assert.match(geminiPrompt, /P7\. In "rowLabel" riporta l'etichetta ESATTA/);
  assert.match(geminiPrompt, /\{ "rowLabel": "Cognome N\.", "declaredClassTotals":/);
  assert.match(geminiPrompt, /Riepilogo: "rowLabel" = etichetta della riga letta;/);
  assert.equal(
    buildPersonalTimetablePrompt('felice manganiello', REAL_WEEK, { includeRowLabel: true }),
    geminiPrompt,
    'il default non cambia di una virgola',
  );
  // La variante del Passo B (base del prompt H6) omette SOLO la parte rowLabel.
  const passBBase = buildPersonalTimetablePrompt('felice manganiello', REAL_WEEK, { includeRowLabel: false });
  assert.doesNotMatch(passBBase, /rowLabel/);
  assert.match(passBBase, /P7a\./, 'il riepilogo separato (H4) resta nel prompt');
  assert.match(passBBase, /P7b\./, 'il divieto di ricalcolo (H4) resta nel prompt');
});

test('H6 schema: il Passo B contiene SOLO declaredClassTotals e days (mutation: rowLabel reintrodotto -> fallisce)', () => {
  // Contratto dedicato del Passo B: nessun rowLabel, nessun altro campo.
  assert.deepEqual(Object.keys(personalRowTranscriptionSchema.properties).sort(), ['days', 'declaredClassTotals']);
  assert.deepEqual([...personalRowTranscriptionSchema.required].sort(), ['days', 'declaredClassTotals']);
  assert.equal(JSON.stringify(personalRowTranscriptionSchema).includes('rowLabel'), false, 'rowLabel non compare nello schema');
  // I sotto-schemi sono gli STESSI OGGETTI del contratto Gemini: geometria e
  // riepilogo separato non possono divergere fra i due percorsi.
  assert.equal((personalRowTranscriptionSchema.properties as any).days, (personalTimetableSchema.properties as any).days);
  assert.equal((personalRowTranscriptionSchema.properties as any).declaredClassTotals, (personalTimetableSchema.properties as any).declaredClassTotals);
  // Lo Structured Output strict di Groq NON contiene rowLabel.
  const converted = groqJsonSchemaFrom(personalRowTranscriptionSchema) as Record<string, any>;
  assert.deepEqual([...converted.required].sort(), ['days', 'declaredClassTotals']);
  assert.deepEqual(Object.keys(converted.properties).sort(), ['days', 'declaredClassTotals']);
  assert.equal(converted.additionalProperties, false, 'strict: il provider non può aggiungere campi');
  // ...e il percorso Gemini resta INVARIATO: rowLabel ancora richiesto (H3).
  assert.deepEqual(Object.keys(personalTimetableSchema.properties).sort(), ['days', 'declaredClassTotals', 'rowLabel']);
  assert.deepEqual([...personalTimetableSchema.required].sort(), ['days', 'declaredClassTotals', 'rowLabel']);
});

// --- 8d. Budget riservato e divisione fra i due passaggi ---------------------

test('H5 budget: Gemini non consuma la finestra riservata a Groq (mutation D: senza riserva -> fallisce)', () => {
  // Immagine + Groq configurato: Gemini riceve MENO del deadline totale.
  const geminiBudget = timetableGeminiBudgetMs('image/png', true);
  const reservedForGroq = TIMETABLE_ANALYSIS_TIMEOUT_MS - geminiBudget;
  assert.ok(reservedForGroq >= GROQ_TIMETABLE_RESERVED_MS, 'almeno 10 s riservati a Groq');
  assert.equal(geminiBudget, TIMETABLE_ANALYSIS_TIMEOUT_MS - GROQ_TIMETABLE_RESERVED_MS);
  // Il deadline TOTALE non cambia: senza Groq (PDF o chiave assente) budget pieno.
  assert.equal(timetableGeminiBudgetMs('application/pdf', true), TIMETABLE_ANALYSIS_TIMEOUT_MS, 'PDF: nessuna riserva');
  assert.equal(timetableGeminiBudgetMs('image/png', false), TIMETABLE_ANALYSIS_TIMEOUT_MS, 'Groq non configurato: nessuna riserva');
  // La finestra riservata basta a un percorso a due passaggi.
  const budgets = groqTwoPassBudgets(reservedForGroq);
  assert.ok(budgets.passA > 0 && budgets.passB > 0, 'Passo A parte e Passo B può partire');
});

test('H5 budget: bug reale "budget-esaurito" — Gemini lento non brucia gli ultimi 10 s', () => {
  // Simulazione del bug: deadline 45 s, Gemini ~41 s. La riserva impone che al
  // percorso Groq restino comunque >= 10 s. Mutation D (riserva rimossa) -> il
  // budget di Gemini sarebbe l'intero deadline e questa soglia salterebbe.
  const geminiBudget = timetableGeminiBudgetMs('image/png', true);
  const remainingForGroqWorstCase = TIMETABLE_ANALYSIS_TIMEOUT_MS - geminiBudget;
  assert.ok(remainingForGroqWorstCase >= GROQ_TIMETABLE_RESERVED_MS);
  const budgets = groqTwoPassBudgets(remainingForGroqWorstCase);
  assert.ok(budgets.passA >= GROQ_TWO_PASS_MIN_ATTEMPT_MS, 'Passo A ha budget');
  assert.ok(budgets.passB >= GROQ_TWO_PASS_MIN_ATTEMPT_MS, 'Passo B ha budget');
});

test('H5 budget: divisione deterministica ~40/60 e infattibilità sotto soglia', () => {
  const budgets = groqTwoPassBudgets(10_000);
  const usable = 10_000 - GROQ_RESPONSE_RESERVE_MS;
  assert.equal(budgets.passA, Math.floor(usable * GROQ_TWO_PASS_A_SHARE));
  assert.equal(budgets.passB, usable - budgets.passA);
  assert.ok(budgets.passA < budgets.passB, 'Passo A prende meno del Passo B');
  // Sotto la soglia dei due passaggi: nessun percorso (0/0), errore controllato a monte.
  assert.deepEqual(groqTwoPassBudgets(GROQ_RESPONSE_RESERVE_MS + GROQ_TWO_PASS_MIN_ATTEMPT_MS), { passA: 0, passB: 0 });
});

test('H5 budget: il Passo B non parte se dopo il Passo A non resta tempo (requisito 15)', () => {
  // Tempo sufficiente: il Passo B ottiene la sua quota (capata dal residuo).
  assert.equal(groqPassBBudget(8_000, 4_800), 4_800);
  assert.equal(groqPassBBudget(5_000, 4_800), 5_000 - GROQ_RESPONSE_RESERVE_MS);
  // Tempo insufficiente dopo il Passo A: budget 0 -> Passo B non parte.
  assert.equal(groqPassBBudget(GROQ_RESPONSE_RESERVE_MS + GROQ_TWO_PASS_MIN_ATTEMPT_MS - 1, 4_800), 0);
  assert.equal(groqPassBBudget(2_000, 4_800), 0);
});

// --- 8e. Endpoint: casi del percorso a due passaggi --------------------------

test('H6 endpoint (caso reale): fallback tecnico -> Passo A trova la riga + Passo B (senza rowLabel) -> 200 con 18 ore', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  // Passo B: 3D×10, 3E×6, 1C×2 su geometria [6,6,6,7,6]; riepilogo coerente (H4).
  // H6: il Passo B NON restituisce rowLabel; il server lo ricostruisce dal Passo A.
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: groqTwoPass(REAL_TEACHER_LABELS, passBPayload(totalsDays(10), REAL_DECLARED_TOTALS)),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.rowLabel, 'Manganiello');
    assert.equal(data.source, GROQ_VISION_MODEL_DEFAULT);
    // 18 ore occupate (10+6+2), il resto vuoto; geometria [6,6,6,7,6] intatta.
    const occupied = data.cells.filter((c: any) => c.raw !== '');
    assert.equal(occupied.length, 18, '18 ore occupate');
    const perDay = REAL_WEEK.map((_, dayIndex) => data.cells.filter((c: any) => c.dayOfWeek === dayIndex + 1).length);
    assert.deepEqual(perDay, REAL_WEEK, 'ogni giorno conserva le proprie ore');
    assert.deepEqual(groqPhases, ['detection', 'transcription']);
  } finally {
    restore();
  }
});

test('H5 endpoint: Passo A zero match -> Passo B NON parte -> H3 (mutation B: parte -> fallisce)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    // Lista senza la riga del docente: nessuna corrispondenza rigorosa.
    groq: groqTwoPass(['Camilli', 'Costantini', 'Della Gatta'], passBPayload()),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error, TEACHER_ROW_NOT_RECOGNIZED_MESSAGE);
    assert.deepEqual(groqPhases, ['detection'], 'il Passo B non parte senza corrispondenza');
    assert.match(logLines.join('\n'), /fase=identificazione-riga esito=nessuna-corrispondenza/);
  } finally {
    restore();
  }
});

test('H5 endpoint: Passo A refuso "Mangianello" con profilo "Manganiello" -> zero match (requisito 4)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: groqTwoPass(['Camilli', 'Mangianello', 'Costantini'], passBPayload()),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 422, 'un quasi-uguale non è una corrispondenza');
    assert.equal((await res.json()).error, TEACHER_ROW_NOT_RECOGNIZED_MESSAGE);
    assert.deepEqual(groqPhases, ['detection']);
  } finally {
    restore();
  }
});

test('H5 endpoint: Passo A più corrispondenze -> rifiuto conservativo (requisito 3)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    // Due righe compatibili col cognome: il server NON sceglie.
    groq: groqTwoPass(['Manganiello F.', 'Manganiello G.'], passBPayload()),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error, TEACHER_ROW_AMBIGUOUS_MESSAGE);
    assert.deepEqual(groqPhases, ['detection'], 'nessuna trascrizione su corrispondenze multiple');
    assert.match(logLines.join('\n'), /fase=identificazione-riga esito=corrispondenze-multiple/);
  } finally {
    restore();
  }
});

test('H6 endpoint: Passo A fallisce HTTP 429/500 -> UN solo retry, poi errore controllato (requisito 16)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  for (const [status, category] of [[429, 'quota'], [500, 'sovraccarico']] as const) {
    stubProviders({
      gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
      groq: (req) => (req.phase === 'detection' ? { status, body: { error: { message: 'ko' } } } : detectionOk([])),
    });
    const restore = captureLogs();
    try {
      const res = await postTimetable(personalBody);
      assert.equal(res.status, 503, `Passo A ${status}: 503 controllato`);
      assert.match((await res.json()).error, /non è stato elaborato/i);
      // H6: errore transitorio -> esattamente UN retry (max due chiamate per fase).
      assert.deepEqual(groqPhases, ['detection', 'detection'], `Passo A ${status}: un tentativo + un retry, nessun Passo B`);
      assert.match(logLines.join('\n'), new RegExp(`esito=retry categoria=${category} tentativo=2/2`), `Passo A ${status}: retry tracciato`);
    } finally {
      restore();
    }
  }
});

test('H6 endpoint: Passo B fallisce HTTP 429/500 -> UN solo retry, poi errore controllato (requisito 17)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  for (const [status, category] of [[429, 'quota'], [500, 'sovraccarico']] as const) {
    stubProviders({
      gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
      groq: (req) => (req.phase === 'detection' ? detectionOk(REAL_TEACHER_LABELS) : { status, body: { error: { message: 'ko' } } }),
    });
    const restore = captureLogs();
    try {
      const res = await postTimetable(personalBody);
      assert.equal(res.status, 503, `Passo B ${status}: 503 controllato`);
      assert.match((await res.json()).error, /non è stato elaborato/i);
      // H6: il Passo A era riuscito; il Passo B fa un tentativo + UN retry.
      assert.deepEqual(groqPhases, ['detection', 'transcription', 'transcription'], `Passo B ${status}: un tentativo + un retry`);
      assert.match(logLines.join('\n'), new RegExp(`esito=retry categoria=${category} tentativo=2/2`), `Passo B ${status}: retry tracciato`);
    } finally {
      restore();
    }
  }
});

test('H6 endpoint: Passo A 429 poi OK -> il retry SALVA la fase e il percorso conclude (429/503/rete con un retry)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  let detectionCalls = 0;
  let transcriptionCalls = 0;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: (req) => {
      if (req.phase === 'detection') {
        detectionCalls += 1;
        return detectionCalls === 1 ? { status: 429, body: { error: { message: 'rate limit' } } } : detectionOk(REAL_TEACHER_LABELS);
      }
      transcriptionCalls += 1;
      // Passo B: prima un 503 transitorio, poi la trascrizione coerente.
      return transcriptionCalls === 1
        ? { status: 503, body: { error: { message: 'overloaded' } } }
        : { status: 200, body: { choices: [{ message: { content: passBPayload(totalsDays(10), REAL_DECLARED_TOTALS) }, finish_reason: 'stop' }] } };
    },
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200, 'un retry per fase salva entrambe le fasi transitorie');
    const data = await res.json();
    assert.equal(data.rowLabel, 'Manganiello');
    assert.equal(data.cells.filter((c: any) => c.raw !== '').length, 18, '18 ore, H4 coerente');
    assert.deepEqual(groqPhases, ['detection', 'detection', 'transcription', 'transcription']);
    assert.equal(detectionCalls, 2);
    assert.equal(transcriptionCalls, 2);
  } finally {
    restore();
  }
});

test('H6 endpoint: Passo A 400 / 401 / 404 -> NESSUN retry (errori non transitori)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  for (const status of [400, 401, 404]) {
    stubProviders({
      gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
      groq: (req) => (req.phase === 'detection' ? { status, body: { error: { message: 'ko' } } } : detectionOk(REAL_TEACHER_LABELS)),
    });
    const restore = captureLogs();
    try {
      const res = await postTimetable(personalBody);
      assert.equal(res.status, 503, `Passo A ${status}: 503 controllato`);
      // Mutation "retry su 400": una sola chiamata per fase, nessun retry.
      assert.deepEqual(groqPhases, ['detection'], `Passo A ${status}: nessun retry`);
      assert.doesNotMatch(logLines.join('\n'), /esito=retry/, `Passo A ${status}: nessun log di retry`);
    } finally {
      restore();
    }
  }
});

test('H6 endpoint: Passo B 400 -> NESSUN retry (errore non transitorio)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: (req) => (req.phase === 'detection' ? detectionOk(REAL_TEACHER_LABELS) : { status: 400, body: { error: { message: 'bad request' } } }),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 503, 'Passo B 400: 503 controllato');
    assert.deepEqual(groqPhases, ['detection', 'transcription'], 'una sola chiamata al Passo B: nessun retry su 400');
    assert.doesNotMatch(logLines.join('\n'), /esito=retry/);
  } finally {
    restore();
  }
});

test('H6 endpoint: errori transitori PERSISTENTI -> al massimo due chiamate per fase (mutation: retry infinito -> fallisce)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  // Passo A sempre 429: due chiamate totali, mai una terza.
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: (req) => (req.phase === 'detection' ? { status: 429, body: { error: { message: 'rate limit' } } } : detectionOk(REAL_TEACHER_LABELS)),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 503);
    assert.deepEqual(groqPhases, ['detection', 'detection'], `max ${GROQ_MAX_CALLS_PER_PHASE} chiamate al Passo A, poi stop`);
  } finally {
    restore();
  }
  // Passo B sempre 503: una detection + due transcription, mai una terza trascrizione.
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: (req) => (req.phase === 'detection' ? detectionOk(REAL_TEACHER_LABELS) : { status: 503, body: { error: { message: 'overloaded' } } }),
  });
  const restore2 = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 503);
    assert.deepEqual(groqPhases, ['detection', 'transcription', 'transcription'], `max ${GROQ_MAX_CALLS_PER_PHASE} chiamate al Passo B, poi stop`);
  } finally {
    restore2();
  }
});

test('H6 endpoint: errore di RETE del Passo B -> UN retry; rete persistente -> due chiamate e stop', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  let transcriptionCalls = 0;
  const networkFailure = () => { throw new TypeError('fetch failed'); };
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: (req) => {
      if (req.phase === 'detection') return detectionOk(REAL_TEACHER_LABELS);
      transcriptionCalls += 1;
      if (transcriptionCalls === 1) return networkFailure();
      return { status: 200, body: { choices: [{ message: { content: passBPayload(totalsDays(10), REAL_DECLARED_TOTALS) }, finish_reason: 'stop' }] } };
    },
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200, 'un errore di rete transitorio viene ritentato una volta');
    assert.equal((await res.json()).rowLabel, 'Manganiello');
    assert.deepEqual(groqPhases, ['detection', 'transcription', 'transcription']);
    assert.match(logLines.join('\n'), /esito=retry categoria=rete tentativo=2\/2/);
  } finally {
    restore();
  }
});

test('H5 endpoint: PDF nel fallback tecnico personale -> Groq NON chiamato (requisito 12)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: groqTwoPass(REAL_TEACHER_LABELS, personalPayload('Manganiello')),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable({ ...personalBody, imageBase64: pdfBase64, mimeType: 'application/pdf' });
    assert.equal(res.status, 503, 'PDF: nessuna conversione, resta Gemini-only');
    assert.deepEqual(groqPhases, [], 'Groq Vision non prende PDF: nessun passaggio');
    assert.match(logLines.join('\n'), /fallback=groq saltato motivo=mime-non-supportato/);
  } finally {
    restore();
  }
});

test('H5 endpoint: Groq non configurato nel fallback tecnico personale -> 503 attuale (requisito 13)', async () => {
  delete process.env.GROQ_API_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: groqTwoPass(REAL_TEACHER_LABELS, personalPayload('Manganiello')),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 503);
    assert.deepEqual(groqPhases, [], 'senza chiave nessun passaggio');
    assert.match(logLines.join('\n'), /fallback=groq saltato motivo=non-configurato/);
  } finally {
    restore();
  }
});

test('H6 endpoint: forma delle richieste — Passo B senza rowLabel, etichetta E posizione solo nel prompt (mutation: rowLabel reintrodotto o posizione rimossa -> fallisce)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  const bodies: any[] = [];
  stubProviders({
    gemini: geminiOk(personalPayload('Mangianello')),
    groq: (req) => {
      bodies.push(req.body);
      return req.phase === 'detection'
        ? detectionOk(REAL_TEACHER_LABELS)
        : { status: 200, body: { choices: [{ message: { content: passBPayload() }, finish_reason: 'stop' }] } };
    },
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200);
    assert.equal(bodies.length, 2, 'due richieste distinte a Groq');
    const [a, b] = bodies;
    // Passo A: contratto dedicato (solo etichette), nessun nome target.
    assert.equal(a.response_format.json_schema.name, 'teacher_rows');
    assert.deepEqual(Object.keys(a.response_format.json_schema.schema.properties), ['rowLabels']);
    assert.doesNotMatch(a.messages[0].content, /Manganiello/, 'il Passo A non riceve il target');
    // Passo B: lo schema contiene SOLO declaredClassTotals e days (H6), nessun rowLabel.
    assert.equal(b.response_format.json_schema.name, 'timetable_analysis');
    assert.deepEqual(Object.keys(b.response_format.json_schema.schema.properties).sort(), ['days', 'declaredClassTotals']);
    assert.deepEqual([...b.response_format.json_schema.schema.required].sort(), ['days', 'declaredClassTotals']);
    assert.doesNotMatch(JSON.stringify(b.response_format.json_schema.schema), /rowLabel/, 'lo schema del Passo B non chiede rowLabel');
    // ...e il prompt riceve ETICHETTA ("Manganiello" = riga 4) E POSIZIONE.
    assert.match(b.messages[0].content, /"Manganiello"/, 'l etichetta viaggia SOLO nel prompt del provider');
    assert.match(b.messages[0].content, /riga numero 4\b/, 'la posizione della riga (base 1) è nel prompt');
    assert.doesNotMatch(b.messages[0].content, /rowLabel/, 'il prompt del Passo B non chiede rowLabel');
    // ...ma NÉ etichetta NÉ posizione finiscono nei log, come sempre.
    assert.doesNotMatch(logLines.join('\n'), /Manganiello/, 'l etichetta individuata non finisce nei log');
    assert.doesNotMatch(logLines.join('\n'), /riga numero/, 'la posizione non finisce nei log');
  } finally {
    restore();
  }
});

test('H5/H6 endpoint: Gemini coerente -> nessun passaggio Groq (requisito 11, mutation E)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: geminiOk(personalPayload('Manganiello')),
    groq: groqTwoPass(REAL_TEACHER_LABELS, passBPayload()),
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).source, geminiCandidateModels()[0]);
    assert.deepEqual(groqPhases, [], 'niente da correggere: nessun passaggio Groq');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 9. H6 — rowLabel RICOSTRUITO DAL SERVER + RETRY TRANSITORIO LIMITATO
//
// H6 bind la trascrizione Groq/Qwen alla riga CERTIFICATA dal match strict del
// Passo A: il Passo B non dichiara più `rowLabel` e il server lo ricostruisce.
// Inoltre ogni fase (Passo A / Passo B) ha AL PIÙ un retry, solo su errori
// transitori (429/503/rete) e solo con budget residuo.
// ---------------------------------------------------------------------------

// --- 9a. Ricostruzione del payload (rowLabel SOLO dal match del Passo A) -----

test('H6 ricostruzione: rowLabel viene ESCLUSIVAMENTE dal match, ogni altro campo del modello è scartato', () => {
  // Il Passo B restituisce solo i due campi del contratto: il server aggiunge rowLabel.
  assert.deepEqual(
    JSON.parse(reconstructPersonalRowPayload({ declaredClassTotals: [{ classLabel: '3D', hours: 10 }], days: [{ cells: ['3D'] }] }, 'Manganiello')!),
    { rowLabel: 'Manganiello', declaredClassTotals: [{ classLabel: '3D', hours: 10 }], days: [{ cells: ['3D'] }] },
  );
  // Mutation "rowLabel dal Passo B": anche un rowLabel nel testo del modello
  // viene SCARTATO (nessuno lo legge), insieme a qualunque campo extra.
  const tampered = reconstructPersonalRowPayload(
    { rowLabel: 'AltroDocente', declaredClassTotals: [], days: [], cells: ['3D'], iniezione: 'testo' },
    'Manganiello',
  )!;
  assert.deepEqual(JSON.parse(tampered), { rowLabel: 'Manganiello', declaredClassTotals: [], days: [] });
  assert.equal(tampered.includes('AltroDocente'), false, 'il contenuto del modello non si propaga');
  assert.equal(tampered.includes('cells'), false, 'i campi extra restano fuori');
  assert.equal(tampered.includes('iniezione'), false, 'campi arbitrari scartati');
  // Un valore non-oggetto è un errore controllato (null), mai un crash.
  for (const invalid of [null, undefined, 'testo', 42, ['Manganiello'], true]) {
    assert.equal(reconstructPersonalRowPayload(invalid, 'Manganiello'), null, `rifiutato: ${JSON.stringify(invalid)}`);
  }
  // Il payload ricostruito passa il validatore condiviso ESATTAMENTE come quello
  // di Gemini: H3 (matcher strict) e geometria inclusi. Caso reale: 18 ore.
  const reconstructed = JSON.parse(reconstructPersonalRowPayload(
    { declaredClassTotals: REAL_DECLARED_TOTALS, days: totalsDays(10) },
    'Manganiello',
  )!);
  const outcome = parseTimetableAiResponse('personal-support-timetable', reconstructed, 'Felice Manganiello', REAL_WEEK);
  assert.equal(outcome.rowLabel, 'Manganiello');
  assert.equal(outcome.cells.filter((c) => c.raw !== '').length, 18, '18 ore, H4 coerente');
});

// --- 9b. Retry: decisioni pure (transitorie vs non, con budget residuo) ------

test('H6 retry: SOLO 429 (quota), 503 (sovraccarico) e rete sono ritentabili', () => {
  for (const category of ['quota', 'sovraccarico', 'rete'] as const) {
    assert.equal(groqRetryableCategory(category), true, `${category} è transitorio`);
  }
  // Tutto il resto non lo è: 400/richiesta-non-valida, autenticazione,
  // modello-non-trovato, deadline, errori di forma/output, budget, abort, ok.
  for (const category of [
    'richiesta-non-valida',
    'chiave-o-permessi',
    'modello-non-trovato',
    'deadline',
    'output-vuoto',
    'output-troncato',
    'budget-esaurito',
    'annullata',
    'non-configurato',
    'mime-non-supportato',
    'sconosciuta',
    'ok',
  ] as const) {
    assert.equal(groqRetryableCategory(category), false, `${category} NON si ritenta`);
    assert.equal(groqRetryAttemptTimeoutMs(category, 30_000), 0, `${category}: nessun timeout di retry`);
  }
  // Classificazione HTTP coerente: 400 e 503 mappano dove devono.
  assert.equal(classifyGroqHttpStatus(503), 'sovraccarico');
  assert.equal(classifyGroqHttpStatus(400), 'richiesta-non-valida');
  assert.equal(classifyGroqHttpStatus(422), 'richiesta-non-valida');
  assert.equal(classifyGroqHttpStatus(404), 'modello-non-trovato');
});

test('H6 retry: massimo due chiamate per fase e solo con budget residuo', () => {
  assert.equal(GROQ_MAX_CALLS_PER_PHASE, 2, 'un tentativo + UN retry per fase, mai di più');
  assert.ok(GROQ_RETRY_MIN_ATTEMPT_MS >= GROQ_TWO_PASS_MIN_ATTEMPT_MS);
  // Budget residuo sotto soglia -> nessun retry (decisione pura).
  assert.equal(groqRetryAttemptTimeoutMs('quota', GROQ_RETRY_MIN_ATTEMPT_MS - 1), 0, 'budget insufficiente: no retry');
  assert.equal(groqRetryAttemptTimeoutMs('quota', 0), 0);
  assert.equal(groqRetryAttemptTimeoutMs('quota', -500), 0);
  // Budget sufficiente -> si riprova con ESATTAMENTE il residuo.
  assert.equal(groqRetryAttemptTimeoutMs('quota', GROQ_RETRY_MIN_ATTEMPT_MS), GROQ_RETRY_MIN_ATTEMPT_MS);
  assert.equal(groqRetryAttemptTimeoutMs('rete', 2_200), 2_200);
  assert.equal(groqRetryAttemptTimeoutMs('sovraccarico', 1_500.9), 1_500, 'il residuo è intero');
});

test('H6 retry (wrapper): 429 -> una seconda chiamata con esito del secondo tentativo', async () => {
  let calls = 0;
  const result = await runGroqJsonWithTransientRetry(groqOptions({
    attemptTimeoutMs: 3_200,
    log: () => {},
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) return new Response('errore', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: groqCurricularText }, finish_reason: 'stop' }] }), { status: 200 });
    }) as unknown as typeof fetch,
  }));
  assert.equal(calls, 2, 'primo tentativo + UN retry');
  assert.equal(result.ok, true, 'il retry salva la chiamata');
  assert.equal(result.text, groqCurricularText);
});

test('H6 retry (wrapper): 503 e rete ritentate UNA volta; 400/401/404/408 e output-vuoto MAI', async () => {
  const cases: Array<[string, () => Promise<Response>, boolean]> = [
    ['503', async () => new Response('ko', { status: 503 }), true],
    ['rete', async () => { throw new TypeError('fetch failed'); }, true],
    ['400', async () => new Response('ko', { status: 400 }), false],
    ['401', async () => new Response('ko', { status: 401 }), false],
    ['404', async () => new Response('ko', { status: 404 }), false],
    ['408', async () => new Response('ko', { status: 408 }), false],
    ['422 (shape)', async () => new Response('ko', { status: 422 }), false],
    ['output-vuoto', async () => new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }), { status: 200 }), false],
    ['output-troncato', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] }), { status: 200 }), false],
  ];
  for (const [name, respond, retried] of cases) {
    let calls = 0;
    await runGroqJsonWithTransientRetry(groqOptions({
      attemptTimeoutMs: 4_000,
      log: () => {},
      fetchImpl: (async () => { calls += 1; return respond(); }) as unknown as typeof fetch,
    }));
    assert.equal(calls, retried ? 2 : 1, `${name}: ${retried ? 'un retry' : 'nessun retry'}`);
  }
});

test('H6 retry (wrapper): budget residuo insufficiente dopo il primo tentativo -> UNA sola chiamata', async () => {
  // Orologio iniettato: il primo tentativo lascia meno della soglia minima.
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  let calls = 0;
  const result = await runGroqJsonWithTransientRetry(groqOptions({
    attemptTimeoutMs: 2_500,
    now,
    log: () => {},
    fetchImpl: (async () => {
      calls += 1;
      clock.t += 2_000; // il tentativo transitorio consuma quasi tutto il budget di fase
      return new Response('ko', { status: 429 });
    }) as unknown as typeof fetch,
  }));
  assert.equal(result.category, 'quota');
  assert.equal(calls, 1, 'residuo 500 ms < soglia: nessun retry');
});

test('H6 retry (wrapper): errori transitori PERSISTENTI -> esattamente due chiamate, mai una terza (mutation: retry infinito -> fallisce)', async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    const result = await runGroqJsonWithTransientRetry(groqOptions({
      attemptTimeoutMs: 8_000,
      log: () => {},
      fetchImpl: (async () => { calls += 1; return new Response('ko', { status }); }) as unknown as typeof fetch,
    }));
    assert.equal(result.ok, false);
    assert.equal(calls, 2, `${status}: al massimo due chiamate per fase`);
  }
  let networkCalls = 0;
  await runGroqJsonWithTransientRetry(groqOptions({
    attemptTimeoutMs: 8_000,
    log: () => {},
    fetchImpl: (async () => { networkCalls += 1; throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
  }));
  assert.equal(networkCalls, 2, 'rete: al massimo due chiamate per fase');
});

test('H6 retry (wrapper): il log del retry è privacy-safe (solo categoria e tentativo)', async () => {
  const lines: string[] = [];
  await runGroqJsonWithTransientRetry(groqOptions({
    attemptTimeoutMs: 4_000,
    log: (line) => lines.push(line),
    fetchImpl: (async () => new Response('ko', { status: 429 })) as unknown as typeof fetch,
  }));
  const dump = lines.join('\n');
  assert.match(dump, /esito=retry categoria=quota tentativo=2\/2/);
  assert.doesNotMatch(dump, new RegExp(TEST_GROQ_KEY), 'nessuna chiave');
  assert.doesNotMatch(dump, new RegExp(pngBase64.slice(0, 24)), 'nessun base64');
  assert.doesNotMatch(dump, /data:image|1A|2B|Matematica|Docente/, 'nessun contenuto');
});

// --- 9c. Endpoint: retry con budget residuo nel deadline dell'endpoint --------

test('H6 endpoint: il retry del Passo B usa il budget RESIDUO (secondo tentativo dentro il deadline)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  let transcriptionCalls = 0;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: (req) => {
      if (req.phase === 'detection') return detectionOk(REAL_TEACHER_LABELS);
      transcriptionCalls += 1;
      return transcriptionCalls === 1
        ? { status: 503, body: { error: { message: 'overloaded' } } }
        : { status: 200, body: { choices: [{ message: { content: passBPayload(totalsDays(10), REAL_DECLARED_TOTALS) }, finish_reason: 'stop' }] } };
    },
  });
  const restore = captureLogs();
  try {
    const res = await postTimetable(personalBody);
    assert.equal(res.status, 200, 'il retry resta dentro il deadline: nessun timeout, nessun 503');
    assert.equal((await res.json()).rowLabel, 'Manganiello');
    assert.equal(transcriptionCalls, 2);
  } finally {
    restore();
  }
});

// --- 9d. Endpoint: privacy dei log nel percorso H6 completo -------------------

test('H6 endpoint: nemmeno con i retry i log contengono chiavi, immagini, nomi o classi', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  let detectionCalls = 0;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'high demand' } } }),
    groq: (req) => {
      if (req.phase === 'detection') {
        detectionCalls += 1;
        return detectionCalls === 1 ? { status: 429, body: { error: { message: 'rate limit' } } } : detectionOk(REAL_TEACHER_LABELS);
      }
      return { status: 200, body: { choices: [{ message: { content: passBPayload(totalsDays(10), REAL_DECLARED_TOTALS) }, finish_reason: 'stop' }] } };
    },
  });
  const restore = captureLogs();
  try {
    assert.equal((await postTimetable(personalBody)).status, 200);
    const dump = logLines.join('\n');
    assert.match(dump, /esito=retry categoria=quota tentativo=2\/2/, 'retry tracciato');
    assert.doesNotMatch(dump, /Manganiello|Camilli|Costantini|Mangraviti|Della Gatta|Felice/, 'mai nomi o etichette');
    assert.doesNotMatch(dump, /3D|3E|1C|1A|2B/, 'mai le classi');
    assert.doesNotMatch(dump, /riga numero/, 'mai la posizione della riga');
    assert.doesNotMatch(dump, /rowLabel|rowLabels|"days"|declaredClassTotals/, 'mai il JSON del modello');
    assert.doesNotMatch(dump, new RegExp(TEST_GROQ_KEY), 'nessuna chiave Groq');
    assert.doesNotMatch(dump, new RegExp(TEST_GEMINI_KEY), 'nessuna chiave Gemini');
    assert.doesNotMatch(dump, new RegExp(pngBase64.slice(0, 24)), 'nessun frammento di base64');
  } finally {
    restore();
  }
});
