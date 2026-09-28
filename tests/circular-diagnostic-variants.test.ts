import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, getCircularDiagnosticVariant } from '../server';

const pdfBase64 = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');

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

// ---------------------------------------------------------------------------
// 1. env assente / invalido => D
// ---------------------------------------------------------------------------

test('1. env assente, vuoto o non valido ricade sempre sulla variante D (produzione)', () => {
  assert.equal(getCircularDiagnosticVariant({}), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: '' }), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: '   ' }), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'X' }), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'invalid' }), 'D');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'a' }), 'A');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'b' }), 'B');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'c' }), 'C');
  assert.equal(getCircularDiagnosticVariant({ GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: 'd' }), 'D');
});

// ---------------------------------------------------------------------------
// 2. Simulazione chiamate per le 4 varianti A, B, C, D
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
// 6. Privacy dei log
// ---------------------------------------------------------------------------

test('6. I log diagnostici non contengono mai base64, prompt, OCR o dati sensibili', async () => {
  const originalEnv = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = 'A';
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';

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
    if (sUrl.includes('generativelanguage.googleapis.com')) {
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

    const diagLog = logs.find((l) => l.includes('[AI Circolari Diagnostic]'));
    assert.ok(diagLog);
    assert.doesNotMatch(diagLog, /PDF-1\.7/);
    assert.doesNotMatch(diagLog, /AIzaSy/);
    assert.doesNotMatch(diagLog, /Estrai gli eventi/);
    assert.doesNotMatch(diagLog, /password|auth/);
  } finally {
    process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = originalEnv;
    process.env.GEMINI_API_KEY = originalApiKey;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
