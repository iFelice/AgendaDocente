import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, getCircularDiagnosticVariant } from '../server';

const pdfBase64 = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');
const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

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

function geminiMockResponse(text: string): Response {
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
// 2. Simulazione chiamate per le varianti A, B, C, D
// ---------------------------------------------------------------------------

test('2. Variante A: prompt minimale, no systemInstruction, no schema, no responseMimeType, thinking low, solo 3.8', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'A';
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';

  let capturedParams: any = null;
  const originalFetch = globalThis.fetch;

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(' '));
    originalLog(...args);
  };

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      capturedParams = {
        url: sUrl,
        body: opts?.body ? JSON.parse(opts.body.toString()) : null,
      };
      return geminiMockResponse('Risposta testo libero non JSON');
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: pdfBase64,
        mimeType: 'application/pdf',
        profile: validProfile,
      }),
    });

    assert.ok(capturedParams, 'Chiamata a Gemini deve essere stata effettuata');
    assert.ok(capturedParams.url.includes('models/gemini-3.8-flash:generateContent'));

    const genConfig = capturedParams.body.generationConfig;
    assert.equal(genConfig.responseMimeType, undefined, 'A non invia responseMimeType');
    assert.equal(genConfig.responseSchema, undefined, 'A non invia responseSchema');
    assert.equal(genConfig.thinkingConfig?.thinkingLevel, 'low', 'A invia thinkingLevel low');
    assert.equal(capturedParams.body.systemInstruction, undefined, 'A non invia systemInstruction');

    // Prompt minimale
    const userPart = capturedParams.body.contents[0].parts.find((p: any) => p.text);
    assert.equal(userPart.text, 'Estrai gli eventi principali da questo documento.');

    // Log diagnostico distingue call success e parse failed
    const diagLog = logs.find((l) => l.includes('[AI Circolari Diagnostic]'));
    assert.ok(diagLog, 'Log diagnostico presente');
    assert.ok(diagLog.includes('variant=A'));
    assert.ok(diagLog.includes('geminiCall=success'));
    assert.ok(diagLog.includes('parse=failed'), 'Dato che la risposta è testo non JSON, parse deve essere failed');
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    process.env.GEMINI_API_KEY = originalApiKey;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('3. Variante B: prompt reale, systemInstruction reale, responseMimeType application/json, NO schema, thinking low, solo 3.8', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'B';
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';

  let capturedParams: any = null;
  const originalFetch = globalThis.fetch;

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(' '));
    originalLog(...args);
  };

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      capturedParams = {
        url: sUrl,
        body: opts?.body ? JSON.parse(opts.body.toString()) : null,
      };
      return geminiMockResponse(
        '[{"title":"Collegio Docenti","category":"collegio_docenti","date":"2026-10-15","startTime":"15:00","endTime":"16:00","relevance":"VERDE","relevanceReason":"Tutti"}]'
      );
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: pdfBase64,
        mimeType: 'application/pdf',
        profile: validProfile,
      }),
    });

    assert.ok(capturedParams);
    const genConfig = capturedParams.body.generationConfig;
    assert.equal(genConfig.responseMimeType, 'application/json', 'B invia responseMimeType json');
    assert.equal(genConfig.responseSchema, undefined, 'B non invia responseSchema');
    assert.equal(genConfig.thinkingConfig?.thinkingLevel, 'low', 'B invia thinkingLevel low');
    assert.ok(capturedParams.body.systemInstruction, 'B invia systemInstruction reale');

    const diagLog = logs.find((l) => l.includes('[AI Circolari Diagnostic]'));
    assert.ok(diagLog);
    assert.ok(diagLog.includes('variant=B'));
    assert.ok(diagLog.includes('geminiCall=success'));
    assert.ok(diagLog.includes('parse=success'));
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    process.env.GEMINI_API_KEY = originalApiKey;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('4. Variante C: schema reale, systemInstruction reale, responseMimeType json, NO thinkingLevel, solo 3.8', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'C';
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';

  let capturedParams: any = null;
  const originalFetch = globalThis.fetch;

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      capturedParams = {
        url: sUrl,
        body: opts?.body ? JSON.parse(opts.body.toString()) : null,
      };
      return geminiMockResponse('[]');
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: pdfBase64,
        mimeType: 'application/pdf',
        profile: validProfile,
      }),
    });

    assert.ok(capturedParams);
    const genConfig = capturedParams.body.generationConfig;
    assert.equal(genConfig.responseMimeType, 'application/json');
    assert.ok(genConfig.responseSchema, 'C invia responseSchema');
    assert.equal(genConfig.thinkingConfig, undefined, 'C omette thinkingLevel');
    assert.ok(capturedParams.body.systemInstruction, 'C invia systemInstruction');
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    process.env.GEMINI_API_KEY = originalApiKey;
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('5. Variante D: configurazione produzione attuale completa (schema, thinking low, candidati con fallback)', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'D';
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';

  let capturedParams: any = null;
  const originalFetch = globalThis.fetch;

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      capturedParams = {
        url: sUrl,
        body: opts?.body ? JSON.parse(opts.body.toString()) : null,
      };
      return geminiMockResponse('[]');
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: pdfBase64,
        mimeType: 'application/pdf',
        profile: validProfile,
      }),
    });

    assert.ok(capturedParams);
    const genConfig = capturedParams.body.generationConfig;
    assert.equal(genConfig.responseMimeType, 'application/json');
    assert.ok(genConfig.responseSchema);
    assert.equal(genConfig.thinkingConfig?.thinkingLevel, 'low');
    assert.ok(capturedParams.body.systemInstruction);
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    process.env.GEMINI_API_KEY = originalApiKey;
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

// ---------------------------------------------------------------------------
// 3. VARIANTE G — GROQ VISION (qwen/qwen3.8-27b)
// ---------------------------------------------------------------------------

test('6. Variante G: chiama Groq qwen/qwen3.8-27b una sola volta, NON chiama Gemini', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalGroqKey = process.env.GROQ_API_KEY;

  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'G';
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  let groqCalls = 0;
  let capturedGroqBody: any = null;
  let capturedGroqHeaders: any = null;

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
      capturedGroqHeaders = opts?.headers;
      return groqMockResponse(
        JSON.stringify({
          items: [
            {
              title: 'Consiglio di Classe 1A',
              category: 'consiglio_classe',
              date: '2026-10-20',
              startTime: '15:30',
              endTime: '16:30',
              relevance: 'VERDE',
              relevanceReason: 'Classe docente',
            },
          ],
        })
      );
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

    // Verifiche chiamate
    assert.equal(geminiCalls, 0, 'Gemini NON deve essere chiamato con variant G');
    assert.equal(groqCalls, 1, 'Groq deve essere chiamato esattamente una volta');

    // Verifica configurazione payload Groq
    assert.equal(capturedGroqBody.model, 'qwen/qwen3.8-27b');
    assert.equal(capturedGroqBody.temperature, 0);
    assert.equal(capturedGroqBody.response_format?.type, 'json_object');
    assert.equal(capturedGroqHeaders?.Authorization, 'Bearer gsk_TEST_GROQ_KEY_123');

    // Verifica formato immagine
    const userMsg = capturedGroqBody.messages.find((m: any) => m.role === 'user');
    assert.ok(userMsg);
    const imgPart = userMsg.content.find((p: any) => p.type === 'image_url');
    assert.ok(imgPart, 'Parte image_url deve essere presente');
    assert.equal(imgPart.image_url.url, `data:image/jpeg;base64,${jpegBase64}`);
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    process.env.GEMINI_API_KEY = originalApiKey;
    process.env.GROQ_API_KEY = originalGroqKey;
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('7. Variante G: GROQ_API_KEY assente -> 503 chiaro, nessun crash, nessun Gemini fallback', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalGroqKey = process.env.GROQ_API_KEY;

  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'G';
  delete process.env.GROQ_API_KEY;

  let geminiCalls = 0;
  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    if (inputUrl.toString().includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
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
    assert.equal(geminiCalls, 0, 'Nessun fallback su Gemini');
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    if (originalGroqKey !== undefined) process.env.GROQ_API_KEY = originalGroqKey;
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('8. Variante G: errore 429 da Groq -> 429 con codice RATE_LIMITED, nessun Gemini fallback', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalGroqKey = process.env.GROQ_API_KEY;

  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'G';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiCalls = 0;
  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
    }
    if (sUrl.includes('api.groq.com')) {
      return groqMockResponse('', 429);
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
    assert.equal(geminiCalls, 0, 'Nessun fallback su Gemini');
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    process.env.GROQ_API_KEY = originalGroqKey;
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('9. Variante G: MIME non supportato (es. application/pdf) -> 400 chiaro con INVALID_INPUT', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalGroqKey = process.env.GROQ_API_KEY;

  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'G';
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
    if (sUrl.includes('generativelanguage.googleapis.com')) geminiCalls++;
    if (sUrl.includes('api.groq.com')) groqCalls++;
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

    assert.equal(res.status, 400);
    const json: any = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.errorCode, 'INVALID_INPUT');
    assert.equal(groqCalls, 0);
    assert.equal(geminiCalls, 0);
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    process.env.GROQ_API_KEY = originalGroqKey;
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('10. Variante G: JSON non valido da Groq su immagine -> 503 con AI_UNAVAILABLE, nessun crash', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalGroqKey = process.env.GROQ_API_KEY;

  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'G';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      return groqMockResponse('testo che non e un json valido');
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
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    process.env.GROQ_API_KEY = originalGroqKey;
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

// ---------------------------------------------------------------------------
// 4. Privacy dei log
// ---------------------------------------------------------------------------

test('11. I log diagnostici di G non contengono mai base64, prompt, OCR, chiavi o dati sensibili', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalGroqKey = process.env.GROQ_API_KEY;

  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'G';
  process.env.GROQ_API_KEY = 'gsk_SECRET_KEY_NEVER_LOG';

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(' '));
    originalLog(...args);
  };

  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/analyze-circular`;

  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('api.groq.com')) {
      return groqMockResponse(
        JSON.stringify({
          items: [
            {
              title: 'Collegio Docenti',
              category: 'collegio_docenti',
              date: '2026-10-15',
              startTime: '15:00',
              endTime: '17:00',
              relevance: 'VERDE',
              relevanceReason: 'Tutti',
            },
          ],
        })
      );
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: jpegBase64,
        mimeType: 'image/jpeg',
        profile: validProfile,
      }),
    });

    const diagLog = logs.find((l) => l.includes('[AI Circolari Diagnostic]'));
    assert.ok(diagLog, 'Log diagnostico Groq presente');
    assert.ok(diagLog.includes('variant=G'));
    assert.ok(diagLog.includes('provider=groq'));
    assert.ok(diagLog.includes('model=qwen/qwen3.8-27b'));
    assert.ok(diagLog.includes('call=success'));
    assert.ok(diagLog.includes('parse=success'));

    // Privacy checks
    assert.doesNotMatch(diagLog, /gsk_SECRET_KEY/);
    assert.doesNotMatch(diagLog, /JFIF/);
    assert.doesNotMatch(diagLog, /Estrai esclusivamente/);
    assert.doesNotMatch(diagLog, /Docente Test/);
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    process.env.GROQ_API_KEY = originalGroqKey;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
