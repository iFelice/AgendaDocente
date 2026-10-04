import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  app,
  CIRCULAR_ANALYSIS_TIMEOUT_MS,
  GEMINI_RESPONSE_RESERVE_MS,
  PDF_TEXT_GROQ_BUDGET_MS,
} from '../server';
import { buildEmptyPdf, buildInvalidPdf, buildMultiPagePlanPdf } from './helpers/pdfFixtures';

process.env.TEST_RATE_LIMIT = 'relaxed';

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

const sampleItem = {
  title: 'Collegio docenti',
  category: 'collegio_docenti',
  date: '2026-09-04',
  deadlineDate: '',
  startTime: '09:00',
  endTime: '11:00',
  className: '',
  subject: '',
  location: '',
  notes: '',
  isDeadline: false,
  relevance: 'GIALLO',
  relevanceReason: 'Collegiale',
  rawSnippet: '4 settembre 2026 Collegio docenti ore 09:00-11:00',
  recipientGrades: [],
  recipientClasses: [],
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
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
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
    JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(`http://127.0.0.1:${port}/api/analyze-circular`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

const multiPagePdfBase64 = buildMultiPagePlanPdf().toString('base64');
const emptyPdfBase64 = buildEmptyPdf().toString('base64');
const invalidPdfBase64 = buildInvalidPdf().toString('base64');

// ---------------------------------------------------------------------------
// 1. Groq formalmente OK ma items vuoti -> Fallback Gemini sul PDF ORIGINALE
// ---------------------------------------------------------------------------

test('1. Groq formalmente OK ma items vuoti: fallback a Gemini sul PDF ORIGINALE', async () => {
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
  let capturedGeminiBody: any = null;
  const callOrder: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      callOrder.push('gemini');
      capturedGeminiBody = opts?.body ? JSON.parse(opts.body.toString()) : null;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      callOrder.push('groq');
      return groqMockResponse(JSON.stringify({ items: [] }));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const json: any = await withServer(async (url) => {
      const res = await originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: multiPagePdfBase64, mimeType: 'application/pdf', profile: validProfile }),
      });
      assert.equal(res.status, 200);
      return res.json();
    });

    // 1. Groq viene chiamato
    assert.equal(groqCalls, 1, 'Groq text-only deve essere chiamato');
    // 2. Gemini viene chiamato
    assert.equal(geminiCalls, 1, 'Gemini deve intervenire come fallback');
    // 3. Ordine: prima Groq, poi Gemini
    assert.deepEqual(callOrder, ['groq', 'gemini'], 'Ordine: prima Groq, poi Gemini');
    // 4. Gemini riceve il PDF ORIGINALE
    assert.ok(capturedGeminiBody, 'Gemini deve ricevere un payload');
    const part = capturedGeminiBody.contents[0].parts.find((p: any) => p.inlineData);
    assert.ok(part, 'Gemini deve ricevere inlineData');
    assert.equal(part.inlineData.mimeType, 'application/pdf');
    assert.equal(part.inlineData.data, multiPagePdfBase64, 'Gemini deve ricevere il PDF ORIGINALE');
    // 5. La risposta finale è quella prodotta da Gemini
    assert.equal(json.success, true);
    assert.equal(json.source, 'gemini-3.8-flash');
    assert.equal(json.items.length, 1);
    assert.equal(json.items[0].title, sampleItem.title);

    // 6. Diagnostica: log sanitizzato quando Groq produce 0 impegni
    const emptyLog = logs.find((l) => l.includes('[AI Circolari PDF] primary=groq-text esito=empty categoria=zero-items'));
    assert.ok(emptyLog, `Log primario vuoto mancante: ${JSON.stringify(logs)}`);
    const fallbackLog = logs.find((l) => l.includes('[AI Circolari PDF] fallback=gemini-original-pdf remainingBudgetMs='));
    assert.ok(fallbackLog, `Log di fallback mancante: ${JSON.stringify(logs)}`);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

// ---------------------------------------------------------------------------
// 2. Groq restituisce elementi ma normalizzazione = zero -> Fallback Gemini
// ---------------------------------------------------------------------------

test('2. Groq restituisce elementi non validi/scartati dalla normalizzazione: fallback a Gemini sul PDF ORIGINALE', async () => {
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
  let capturedGeminiBody: any = null;
  const callOrder: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      callOrder.push('gemini');
      capturedGeminiBody = opts?.body ? JSON.parse(opts.body.toString()) : null;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      callOrder.push('groq');
      // Elemento con struttura non valida che causa errore di normalizzazione
      return groqMockResponse(JSON.stringify({ items: [{ title: null, category: 'collegio_docenti' }] }));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const json: any = await withServer(async (url) => {
      const res = await originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: multiPagePdfBase64, mimeType: 'application/pdf', profile: validProfile }),
      });
      assert.equal(res.status, 200);
      return res.json();
    });

    assert.equal(groqCalls, 1, 'Groq deve essere tentato');
    assert.equal(geminiCalls, 1, 'Gemini deve intervenire dopo il fallimento di normalizzazione');
    assert.deepEqual(callOrder, ['groq', 'gemini']);
    assert.equal(json.success, true);
    assert.equal(json.source, 'gemini-3.8-flash');
    assert.equal(json.items.length, 1);

    const part = capturedGeminiBody.contents[0].parts.find((p: any) => p.inlineData);
    assert.ok(part);
    assert.equal(part.inlineData.mimeType, 'application/pdf');
    assert.equal(part.inlineData.data, multiPagePdfBase64);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 3. PDF + testo sufficiente, Groq successo -> Groq chiamato, Gemini NON chiamato, 200
// ---------------------------------------------------------------------------

test('3. PDF digitale con testo sufficiente: Groq text-only primario, Gemini non chiamato', async () => {
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
  const originalFetch = globalThis.fetch;
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
    const json: any = await withServer(async (url) => {
      const res = await originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: multiPagePdfBase64, mimeType: 'application/pdf', profile: validProfile }),
      });
      assert.equal(res.status, 200);
      return res.json();
    });

    assert.equal(json.success, true);
    assert.equal(json.source, 'qwen/qwen3.8-27b');
    assert.equal(json.items.length, 1);

    assert.equal(groqCalls, 1, 'Groq text-only deve essere chiamato esattamente 1 volta');
    assert.equal(geminiCalls, 0, 'Gemini NON deve essere chiamato se Groq text-only ha successo');

    // Groq deve ricevere SOLO testo, mai il PDF originale (item 7/8 della PR).
    assert.ok(capturedGroqBody, 'Groq deve essere stato chiamato con un body JSON');
    const userMessage = capturedGroqBody.messages.find((m: any) => m.role === 'user');
    assert.ok(Array.isArray(userMessage.content));
    assert.equal(userMessage.content.length, 1, 'Nessuna parte image_url: richiesta text-only');
    assert.equal(userMessage.content[0].type, 'text');
    assert.ok(!JSON.stringify(capturedGroqBody).includes('image_url'));
    assert.equal(capturedGroqBody.response_format?.json_schema?.name, 'circular_events');
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 4. PDF senza testo utile (es. scansione) -> Groq non chiamato, Gemini PDF chiamato
// ---------------------------------------------------------------------------

test('4. PDF senza testo utile (es. scansione): Groq non chiamato, Gemini chiamato sul PDF', async () => {
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
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      return groqMockResponse(JSON.stringify({ items: [sampleItem] }));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const json: any = await withServer(async (url) => {
      const res = await originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: emptyPdfBase64, mimeType: 'application/pdf', profile: validProfile }),
      });
      assert.equal(res.status, 200);
      return res.json();
    });

    assert.equal(json.success, true);
    assert.equal(groqCalls, 0, 'PDF senza testo utile non deve chiamare Groq');
    assert.equal(geminiCalls, 1, 'Gemini deve essere chiamato direttamente sul PDF');
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 5. Contenuto strutturato: il testo multipagina estratto arriva INTERO a Groq
// ---------------------------------------------------------------------------

test('5. Il payload inviato a Groq contiene tutto il testo estratto multipagina, non solo la prima pagina', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let capturedGroqBody: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      return geminiMockResponse('[]');
    }
    if (sUrl.includes('api.groq.com')) {
      capturedGroqBody = opts?.body ? JSON.parse(opts.body.toString()) : null;
      return groqMockResponse(JSON.stringify({ items: [sampleItem] }));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    await withServer(async (url) => {
      const res = await originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: multiPagePdfBase64, mimeType: 'application/pdf', profile: validProfile }),
      });
      assert.equal(res.status, 200);
      return res.json();
    });

    assert.ok(capturedGroqBody, 'Groq deve essere stato chiamato');
    const userMessage = capturedGroqBody.messages.find((m: any) => m.role === 'user');
    const sentText = userMessage.content[0].text as string;

    // Deve contenere contenuto di TUTTE le pagine, non solo la prima.
    assert.ok(sentText.includes('SETTEMBRE'));
    assert.ok(sentText.includes('Collegio docenti'));
    assert.ok(sentText.includes('OTTOBRE'));
    assert.ok(sentText.includes('Consiglio di classe 3E'));
    assert.ok(sentText.includes('NOVEMBRE'));
    assert.ok(sentText.includes('GLO classe 2D'));
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 6. Groq fallisce con errore HTTP -> Gemini sul PDF originale, 200
// ---------------------------------------------------------------------------

test('6. PDF digitale con testo sufficiente: Groq fallisce con HTTP 503, Gemini riceve il PDF ORIGINALE', async () => {
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
  let capturedGeminiBody: any = null;
  const callOrder: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      callOrder.push('gemini');
      capturedGeminiBody = opts?.body ? JSON.parse(opts.body.toString()) : null;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      callOrder.push('groq');
      return groqMockResponse('Service Unavailable', 503);
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const json: any = await withServer(async (url) => {
      const res = await originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: multiPagePdfBase64, mimeType: 'application/pdf', profile: validProfile }),
      });
      assert.equal(res.status, 200);
      return res.json();
    });

    assert.equal(json.success, true);
    assert.equal(json.source, 'gemini-3.8-flash');

    assert.equal(groqCalls, 1, 'Groq text-only deve essere tentato prima');
    assert.equal(geminiCalls, 1, 'Gemini deve intervenire dopo il fallimento di Groq');
    assert.deepEqual(callOrder, ['groq', 'gemini'], 'Ordine: prima Groq, poi Gemini');

    const part = capturedGeminiBody.contents[0].parts.find((p: any) => p.inlineData);
    assert.ok(part, 'Gemini deve ricevere inlineData');
    assert.equal(part.inlineData.mimeType, 'application/pdf');
    assert.equal(part.inlineData.data, multiPagePdfBase64, 'Gemini deve ricevere il PDF ORIGINALE, non il testo estratto');
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 7. Estrazione PDF fallisce (PDF non valido) -> niente 500, Gemini tentato
// ---------------------------------------------------------------------------

test('7. Estrazione testo fallisce (PDF non interpretabile): nessun 500, Gemini tentato sul PDF originale', async () => {
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
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      return groqMockResponse(JSON.stringify({ items: [sampleItem] }));
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const { status, json } = await withServer(async (url) => {
      const res = await originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: invalidPdfBase64, mimeType: 'application/pdf', profile: validProfile }),
      });
      return { status: res.status, json: await res.json() as any };
    });

    assert.notEqual(status, 500, 'Un errore di parsing PDF non deve produrre HTTP 500');
    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.equal(groqCalls, 0, 'Estrazione fallita: Groq text-first non deve essere tentato');
    assert.equal(geminiCalls, 1, 'Gemini deve comunque essere tentato sul PDF originale');
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 8. Groq consuma parte del budget -> Gemini riceve budget residuo, non un nuovo 45s pieno
// ---------------------------------------------------------------------------

test('8. Groq consuma parte del budget dei 45s: Gemini riceve il budget RESIDUO, non uno nuovo pieno', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_CANDIDATE_MODELS: process.env.GEMINI_CANDIDATE_MODELS,
  };
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';
  // Un solo modello candidato: elimina la ripartizione fra più modelli e rende
  // il budget del tentativo Gemini leggibile direttamente dal log diagnostico.
  process.env.GEMINI_CANDIDATE_MODELS = 'gemini-3.8-flash';

  const GROQ_DELAY_MS = 3_000;
  let geminiCalls = 0;
  let groqCalls = 0;
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };
  console.warn = (...args: any[]) => { logs.push(args.map(String).join(' ')); };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      // Simula un tentativo Groq che impiega tempo reale prima di fallire.
      await new Promise((resolve) => setTimeout(resolve, GROQ_DELAY_MS));
      return groqMockResponse('Service Unavailable', 503);
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const json: any = await withServer(async (url) => {
      const res = await originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: multiPagePdfBase64, mimeType: 'application/pdf', profile: validProfile }),
      });
      assert.equal(res.status, 200);
      return res.json();
    });

    assert.equal(json.success, true);
    assert.equal(groqCalls, 1);
    assert.equal(geminiCalls, 1);

    const attemptLog = logs.find((l) => l.includes('modello=gemini-3.8-flash') && l.includes('timeoutMs='));
    assert.ok(attemptLog, `Log del tentativo Gemini non trovato: ${JSON.stringify(logs)}`);
    const match = /timeoutMs=(\d+)/.exec(attemptLog!);
    assert.ok(match, 'timeoutMs deve comparire nel log del tentativo Gemini');
    const timeoutMs = Number(match![1]);

    // Budget pieno (nessuna riduzione) sarebbe ~ CIRCULAR_ANALYSIS_TIMEOUT_MS - GEMINI_RESPONSE_RESERVE_MS.
    const fullBudgetAttempt = CIRCULAR_ANALYSIS_TIMEOUT_MS - GEMINI_RESPONSE_RESERVE_MS;
    assert.ok(
      timeoutMs < fullBudgetAttempt - GROQ_DELAY_MS + 500,
      `Gemini non deve ricevere un budget pieno da 45s dopo che Groq ne ha consumato una parte: timeoutMs=${timeoutMs}, fullBudgetAttempt=${fullBudgetAttempt}`,
    );
    // Deve comunque restare un budget utile (non prossimo a zero): Groq ha
    // consumato solo un pezzo dei 45s complessivi.
    assert.ok(timeoutMs > 20_000, `Budget residuo troppo piccolo per un tentativo sensato: timeoutMs=${timeoutMs}`);

    const fallbackLog = logs.find((l) => l.includes('[AI Circolari PDF] fallback=gemini-original-pdf remainingBudgetMs='));
    assert.ok(fallbackLog, 'Log di fallback con budget residuo mancante');
    const remainingMatch = /remainingBudgetMs=(\d+)/.exec(fallbackLog!);
    assert.ok(remainingMatch);
    const remainingBudgetMs = Number(remainingMatch![1]);
    // Il budget residuo loggato deve riflettere il tempo già consumato da Groq:
    // ben al di sotto dei 45s pieni, ma ancora ampiamente positivo.
    assert.ok(remainingBudgetMs < CIRCULAR_ANALYSIS_TIMEOUT_MS - GROQ_DELAY_MS + 500);
    assert.ok(remainingBudgetMs > CIRCULAR_ANALYSIS_TIMEOUT_MS - GROQ_DELAY_MS - 2_000);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
  }
});
