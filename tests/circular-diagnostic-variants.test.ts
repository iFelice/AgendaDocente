import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, getCircularDiagnosticVariant, GROQ_CIRCULAR_RESPONSE_SCHEMA } from '../server';

process.env.TEST_RATE_LIMIT = 'relaxed';

const pdfBase64 = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');
const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const webpBase64 = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]).toString('base64');

const validProfile = {
  id: 'test-teacher-id',
  fullName: 'Docente Test',
  schoolName: 'Scuola Test',
  schoolYear: '2026/2027',
  primarySubjects: ['Matematica'],
  classes: ['1A'],
  campuses: ['Centrale'],
  roles: [],
};

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [key, val] of Object.entries(saved)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

function geminiMockResponse(text: string, status = 200): Response {
  if (status !== 200) {
    return new Response(JSON.stringify({ error: { code: status, message: 'Gemini error' } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function groqMockResponse(content: string, status = 200): Response {
  if (status !== 200) {
    return new Response(JSON.stringify({ error: { message: 'Groq error' } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: 'stop',
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

const sampleItem = {
  title: 'Consiglio di Classe 1A',
  category: 'consiglio_classe',
  date: '2026-10-20',
  startTime: '15:30',
  endTime: '16:30',
  className: '1A',
  subject: 'Matematica',
  location: 'Aula Magna',
  notes: 'Docenti 1A',
  isDeadline: false,
  relevance: 'VERDE',
  relevanceReason: 'Classe docente',
  rawSnippet: '20/10/2026 Consiglio 1A 15:30-16:30',
};

// ---------------------------------------------------------------------------
// 1. env assente / invalido => D / G valido
// ---------------------------------------------------------------------------

test('1. env assente, vuoto o non valido ricade sempre sulla variante D (produzione); G è riconosciuta', () => {
  assert.equal(getCircularDiagnosticVariant({}), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: '' }), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: '   ' }), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'X' }), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'invalid' }), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'a' }), 'A');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'b' }), 'B');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'c' }), 'C');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'd' }), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'g' }), 'G');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'G' }), 'G');
});

// ---------------------------------------------------------------------------
// 2. Verifica statica dello Structured Outputs JSON Schema per Groq
// ---------------------------------------------------------------------------

test('2. Verifica statica dello Structured Outputs JSON Schema per Groq (15 campi required, strict=true, enum, additionalProperties=false)', () => {
  assert.equal(GROQ_CIRCULAR_RESPONSE_SCHEMA.type, 'json_schema');
  assert.equal(GROQ_CIRCULAR_RESPONSE_SCHEMA.json_schema.name, 'circular_events');
  assert.equal(GROQ_CIRCULAR_RESPONSE_SCHEMA.json_schema.strict, true);

  const topSchema = GROQ_CIRCULAR_RESPONSE_SCHEMA.json_schema.schema;
  assert.equal(topSchema.type, 'object');
  assert.deepEqual(topSchema.required, ['items']);
  assert.equal(topSchema.additionalProperties, false);

  const itemSchema = topSchema.properties.items.items;
  assert.equal(itemSchema.type, 'object');
  assert.equal(itemSchema.additionalProperties, false);

  const expectedFields = [
    'title',
    'category',
    'date',
    'startTime',
    'endTime',
    'className',
    'subject',
    'location',
    'notes',
    'isDeadline',
    'relevance',
    'relevanceReason',
    'rawSnippet',
    // Destinatari strutturati: sempre presenti (array vuoto se assenti) perché lo schema è strict.
    'recipientGrades',
    'recipientClasses',
  ];

  assert.equal(expectedFields.length, 15);
  for (const field of expectedFields) {
    assert.ok(itemSchema.properties[field], `Campo ${field} deve essere definito nelle properties`);
  }
  assert.deepEqual(itemSchema.required, expectedFields, 'Tutti i 15 campi devono essere required');
  assert.deepEqual(itemSchema.properties.relevance.enum, ['VERDE', 'GIALLO', 'ROSSO']);
  assert.equal(itemSchema.properties.isDeadline.type, 'boolean');
});

// ---------------------------------------------------------------------------
// 3. PRODUZIONE DEFAULT (variant D / unset) — IMMAGINI (JPEG, PNG, WEBP) → GROQ PRIMARIO
// ---------------------------------------------------------------------------

test('3. JPEG default produzione -> Groq primario (1 sola chiamata), Gemini 0 chiamate, provider=groq', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  let groqCalls = 0;
  let capturedGroqBody: any = null;

  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: any[]) => { logs.push(args.join(' ')); originalLog(...args); };
  console.warn = (...args: any[]) => { logs.push(args.join(' ')); originalWarn(...args); };

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse('[]');
    }
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      capturedGroqBody = opts?.body ? JSON.parse(opts.body.toString()) : null;
      return groqMockResponse(JSON.stringify({ items: [sampleItem] }));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: jpegBase64,
        mimeType: 'image/jpeg',
        profile: validProfile,
      }),
    });

    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.source, 'qwen/qwen3.8-27b');
    assert.equal(json.items.length, 1);
    assert.equal(json.items[0].title, 'Consiglio di Classe 1A');

    assert.equal(groqCalls, 1, 'Groq deve essere chiamato esattamente 1 volta');
    assert.equal(geminiCalls, 0, 'Gemini NON deve essere chiamato se Groq ha successo');
    assert.equal(capturedGroqBody.response_format?.type, 'json_schema');
    assert.equal(capturedGroqBody.response_format?.json_schema?.strict, true);

    const outcomeLog = logs.find((l) => l.includes('[AI Circolari] endpoint=/api/analyze-circular'));
    assert.ok(outcomeLog);
    assert.ok(outcomeLog.includes('provider=groq'), `Log deve riportare provider=groq: ${outcomeLog}`);
    assert.ok(outcomeLog.includes('esito=ok'));
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('4. PNG e WEBP default produzione -> Groq primario, Gemini 0 chiamate', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  let groqCalls = 0;

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse('[]');
    }
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      return groqMockResponse(JSON.stringify({ items: [sampleItem] }));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    // Prova con PNG
    const resPng = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: pngBase64,
        mimeType: 'image/png',
        profile: validProfile,
      }),
    });
    assert.equal(resPng.status, 200);
    const jsonPng: any = await resPng.json();
    assert.equal(jsonPng.success, true);
    assert.equal(jsonPng.source, 'qwen/qwen3.8-27b');

    // Prova con WEBP
    const resWebp = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: webpBase64,
        mimeType: 'image/webp',
        profile: validProfile,
      }),
    });
    assert.equal(resWebp.status, 200);
    const jsonWebp: any = await resWebp.json();
    assert.equal(jsonWebp.success, true);
    assert.equal(jsonWebp.source, 'qwen/qwen3.8-27b');

    assert.equal(groqCalls, 2);
    assert.equal(geminiCalls, 0);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

// ---------------------------------------------------------------------------
// 4. FALLBACK GROQ -> GEMINI (429, 5xx, Network Error, Parse Failure)
// ---------------------------------------------------------------------------

test('5. Groq 429 -> Fallback a Gemini (1 sola chiamata Groq, Gemini ha successo, provider=gemini fallbackFrom=groq)', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  let groqCalls = 0;

  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: any[]) => { logs.push(args.join(' ')); originalLog(...args); };
  console.warn = (...args: any[]) => { logs.push(args.join(' ')); originalWarn(...args); };

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      return groqMockResponse('Rate limited', 429);
    }
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: jpegBase64,
        mimeType: 'image/jpeg',
        profile: validProfile,
      }),
    });

    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.source, 'gemini-3.8-flash');
    assert.equal(json.items.length, 1);

    assert.equal(groqCalls, 1, 'Groq 1 sola chiamata prima del fallback');
    assert.equal(geminiCalls, 1, 'Gemini fallback chiamato 1 volta');

    // Verifica log: Groq fallito seguito da Gemini con fallbackFrom=groq
    const groqFailLog = logs.find((l) => l.includes('provider=groq') && l.includes('esito=fallito') && l.includes('categoria=quota'));
    assert.ok(groqFailLog, `Log fallimento Groq quota presente: ${logs.join(' | ')}`);

    const geminiSuccessLog = logs.find((l) => l.includes('provider=gemini') && l.includes('fallbackFrom=groq') && l.includes('esito=ok'));
    assert.ok(geminiSuccessLog, `Log successo Gemini fallback presente: ${logs.join(' | ')}`);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('6. Groq 500/503 -> Fallback a Gemini', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  let groqCalls = 0;

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      return groqMockResponse('Internal Server Error', 503);
    }
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: jpegBase64,
        mimeType: 'image/jpeg',
        profile: validProfile,
      }),
    });

    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.equal(groqCalls, 1);
    assert.equal(geminiCalls, 1);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('7. Groq network error -> Fallback a Gemini', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  let groqCalls = 0;

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      throw new Error('ECONNRESET');
    }
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: jpegBase64,
        mimeType: 'image/jpeg',
        profile: validProfile,
      }),
    });

    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.equal(groqCalls, 1);
    assert.equal(geminiCalls, 1);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('8. Groq parse failure (HTTP 200 ma non json valido o mancante di items) -> Fallback a Gemini', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  let groqCalls = 0;

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      return groqMockResponse('{"invalid": true}');
    }
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: jpegBase64,
        mimeType: 'image/jpeg',
        profile: validProfile,
      }),
    });

    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.equal(groqCalls, 1);
    assert.equal(geminiCalls, 1);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('9. Fallback Gemini economico: massimo 1 tentativo per modello candidato (Groq 1 -> 3.8 1 volta -> 3.7 1 volta)', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_CANDIDATE_MODELS: process.env.GEMINI_CANDIDATE_MODELS,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';
  process.env.GEMINI_CANDIDATE_MODELS = 'gemini-3.8-flash,gemini-3.7-flash';

  const geminiModelsCalled: string[] = [];
  let groqCalls = 0;

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      return groqMockResponse('Rate limited', 429);
    }
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      const match = sUrl.match(/models\/([^:]+):generateContent/);
      const model = match ? match[1] : 'unknown';
      geminiModelsCalled.push(model);
      if (model === 'gemini-3.8-flash') {
        return geminiMockResponse('Overloaded', 503);
      }
      if (model === 'gemini-3.7-flash') {
        return geminiMockResponse(JSON.stringify([sampleItem]));
      }
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: jpegBase64,
        mimeType: 'image/jpeg',
        profile: validProfile,
      }),
    });

    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.source, 'gemini-3.7-flash');

    assert.equal(groqCalls, 1);
    // Deve chiamare 3.8 una sola volta e 3.7 una sola volta (nessun 2+2)
    assert.deepEqual(geminiModelsCalled, ['gemini-3.8-flash', 'gemini-3.7-flash']);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('10. Fallimento Groq + Fallimento Gemini -> status 503 con AI_UNAVAILABLE coerente, nessun crash', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_CANDIDATE_MODELS: process.env.GEMINI_CANDIDATE_MODELS,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      return groqMockResponse('Service Unavailable', 503);
    }
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      return geminiMockResponse('Service Unavailable', 503);
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: jpegBase64,
        mimeType: 'image/jpeg',
        profile: validProfile,
      }),
    });

    assert.equal(res.status, 503);
    const json: any = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.errorCode, 'AI_UNAVAILABLE');
    assert.deepEqual(json.items, []);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

// ---------------------------------------------------------------------------
// 5. PDF e TESTO INCOLLATO (Groq 0 chiamate, Gemini diretto)
// ---------------------------------------------------------------------------

test('11. PDF in default produzione -> Groq 0 chiamate, Gemini diretto', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_CANDIDATE_MODELS: process.env.GEMINI_CANDIDATE_MODELS,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  let groqCalls = 0;

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      return groqMockResponse('[]');
    }
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: pdfBase64,
        mimeType: 'application/pdf',
        profile: validProfile,
      }),
    });

    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.source, 'gemini-3.8-flash');

    assert.equal(groqCalls, 0, 'PDF non deve chiamare Groq');
    assert.equal(geminiCalls, 1, 'PDF va direttamente a Gemini');
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('12. Testo incollato in default produzione -> Groq 0 chiamate, Gemini diretto (e fallback locale se Gemini fallisce)', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_CANDIDATE_MODELS: process.env.GEMINI_CANDIDATE_MODELS,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  let groqCalls = 0;

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      return groqMockResponse('[]');
    }
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse('Service Unavailable', 503);
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const textContent = 'Circolare n. 12: Convocazione Collegio Docenti il giorno 20/10/2026 ore 16:00 in Aula Magna.';
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: textContent,
        profile: validProfile,
      }),
    });

    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.source, 'local-heuristic');
    assert.ok(json.items.length > 0);

    assert.equal(groqCalls, 0, 'Testo incollato non deve chiamare Groq');
    assert.ok(geminiCalls >= 1, 'Gemini tentato prima del fallback locale');
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

// ---------------------------------------------------------------------------
// 6. VARIANTI DIAGNOSTICHE ESPLICITE (A, B, C, G)
// ---------------------------------------------------------------------------

test('13. Variant=G esplicita -> Groq isolato senza Gemini fallback', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_CANDIDATE_MODELS: process.env.GEMINI_CANDIDATE_MODELS,
  };

  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'G';
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  let groqCalls = 0;

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      return groqMockResponse('Rate limited', 429);
    }
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse('[]');
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: jpegBase64,
        mimeType: 'image/jpeg',
        profile: validProfile,
      }),
    });

    assert.equal(res.status, 429);
    const json: any = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.errorCode, 'RATE_LIMITED');

    assert.equal(groqCalls, 1);
    assert.equal(geminiCalls, 0, 'In variante G esplicita NON deve esserci fallback Gemini');
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('14. Varianti A, B, C restano invariate (chiamano Gemini direttamente)', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_CANDIDATE_MODELS: process.env.GEMINI_CANDIDATE_MODELS,
  };

  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  for (const v of ['A', 'B', 'C'] as const) {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = v;
    let geminiCalls = 0;
    let groqCalls = 0;

    const originalFetch = globalThis.fetch;
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/api/analyze-circular`;

    globalThis.fetch = (async (inputUrl: any, opts: any) => {
      const sUrl = inputUrl.toString();
      if (sUrl.includes('api.groq.com')) {
        groqCalls++;
        return groqMockResponse('[]');
      }
      if (sUrl.includes('generativelanguage.googleapis.com')) {
        geminiCalls++;
        return geminiMockResponse(JSON.stringify([sampleItem]));
      }
      return originalFetch(inputUrl, opts);
    }) as typeof fetch;

    try {
      const res = await originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: jpegBase64,
          mimeType: 'image/jpeg',
          profile: validProfile,
        }),
      });

      assert.equal(res.status, 200, `Variante ${v} deve rispondere 200`);
      assert.equal(groqCalls, 0, `Variante ${v} non deve chiamare Groq`);
      assert.equal(geminiCalls, 1, `Variante ${v} deve chiamare Gemini`);
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }

  restoreEnv(saved);
});

// ---------------------------------------------------------------------------
// 7. Privacy e Assenza Leak nei Log
// ---------------------------------------------------------------------------

test('15. I log di routing e fallback non contengono mai base64, prompt, OCR, chiavi o dati sensibili', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_CANDIDATE_MODELS: process.env.GEMINI_CANDIDATE_MODELS,
  };

  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_SECRET_GEMINI_KEY';
  process.env.GROQ_API_KEY = 'gsk_SECRET_GROQ_KEY';

  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: any[]) => { logs.push(args.join(' ')); originalLog(...args); };
  console.warn = (...args: any[]) => { logs.push(args.join(' ')); originalWarn(...args); };

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      return groqMockResponse('Server Error', 500);
    }
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const secretSnippet = 'INFORMAZIONE_RISERVATA_DOCENTE_12345';
    await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: secretSnippet,
        imageBase64: jpegBase64,
        mimeType: 'image/jpeg',
        profile: { ...validProfile, fullName: 'Mario Rossi Segreto' },
      }),
    });

    for (const logLine of logs) {
      assert.doesNotMatch(logLine, /SECRET_GEMINI_KEY|SECRET_GROQ_KEY/, 'Nessuna API key nei log');
      assert.doesNotMatch(logLine, new RegExp(secretSnippet), 'Nessun testo o OCR nei log');
      assert.doesNotMatch(logLine, /Mario Rossi Segreto/, 'Nessun nome utente nei log');
      assert.doesNotMatch(logLine, new RegExp(jpegBase64.slice(0, 16)), 'Nessun base64 nei log');
    }
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
