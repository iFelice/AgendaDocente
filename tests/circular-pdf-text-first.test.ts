import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  app,
  CIRCULAR_ANALYSIS_TIMEOUT_MS,
  GEMINI_RESPONSE_RESERVE_MS,
  PDF_TEXT_GROQ_BUDGET_MS,
  PDF_TEXT_GEMINI_TEXT_BUDGET_MS,
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

/** Raccoglie tutte le parti text/inlineData del body inviato al SDK Gemini. */
function geminiBodyParts(body: any): any[] {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  return contents.flatMap((c: any) => (Array.isArray(c?.parts) ? c.parts : []));
}

const multiPagePdfBase64 = buildMultiPagePlanPdf().toString('base64');
const emptyPdfBase64 = buildEmptyPdf().toString('base64');
const invalidPdfBase64 = buildInvalidPdf().toString('base64');

// ---------------------------------------------------------------------------
// 1. (C-PDF2) Groq items:[] -> Gemini TEXT-ONLY sul testo estratto produce
//    elementi validi -> 200 con il risultato Gemini, PDF originale MAI chiamato
// ---------------------------------------------------------------------------

test('1. Groq 0 elementi: Gemini text-only sul testo estratto risponde, il PDF originale NON viene chiamato', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiTextCalls = 0;
  let geminiPdfCalls = 0;
  let groqCalls = 0;
  let capturedGeminiTextBody: any = null;
  const callOrder: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      const bodyStr = opts?.body ? opts.body.toString() : '';
      if (bodyStr.includes('inlineData')) {
        geminiPdfCalls++;
        callOrder.push('gemini-pdf');
        return geminiMockResponse(JSON.stringify([sampleItem]));
      }
      geminiTextCalls++;
      callOrder.push('gemini-text');
      capturedGeminiTextBody = bodyStr ? JSON.parse(bodyStr) : null;
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

    // 1. Groq viene tentato per primo
    assert.equal(groqCalls, 1, 'Groq text-only deve essere chiamato');
    // 2. Gemini TEXT-ONLY viene chiamato come primo fallback
    assert.equal(geminiTextCalls, 1, 'Gemini text-only deve essere chiamato dopo Groq a 0 elementi');
    // 3. Il PDF originale NON viene chiamato
    assert.equal(geminiPdfCalls, 0, 'Gemini sul PDF originale NON deve essere chiamato se il text-only ha successo');
    assert.deepEqual(callOrder, ['groq', 'gemini-text'], 'Ordine: prima Groq, poi Gemini text-only');
    // 4. Gemini riceve TESTO, non inlineData PDF
    assert.ok(capturedGeminiTextBody, 'Gemini text-only deve ricevere un payload');
    const parts = geminiBodyParts(capturedGeminiTextBody);
    assert.ok(parts.every((p: any) => !p.inlineData), 'Nessuna parte inlineData: richiesta text-only');
    const sentText = parts.map((p: any) => p.text ?? '').join('\n');
    assert.ok(sentText.includes('Collegio docenti'), 'Il prompt deve contenere il testo estratto');
    // 5. La risposta finale è quella prodotta da Gemini text-only
    assert.equal(json.success, true);
    assert.equal(json.source, 'gemini-3.8-flash');
    assert.equal(json.items.length, 1);
    assert.equal(json.items[0].title, sampleItem.title);

    // 6. Diagnostica: log distinti per il nuovo passaggio, mai il contenuto
    const emptyLog = logs.find((l) => l.includes('[AI Circolari PDF] primary=groq-text esito=empty categoria=zero-items'));
    assert.ok(emptyLog, `Log primario vuoto mancante: ${JSON.stringify(logs)}`);
    const textStartLog = logs.find((l) => l.includes('[AI Circolari PDF] fallback=gemini-text-extracted budgetMs='));
    assert.ok(textStartLog, `Log di avvio gemini-text-extracted mancante: ${JSON.stringify(logs)}`);
    const textOkLog = logs.find((l) => l.includes('[AI Circolari PDF] fallback=gemini-text-extracted model=gemini-3.8-flash esito=ok') && l.includes('items=1') && l.includes('durationMs='));
    assert.ok(textOkLog, `Log di esito gemini-text-extracted mancante: ${JSON.stringify(logs)}`);
    assert.ok(!logs.some((l) => l.includes('fallback=gemini-original-pdf')), 'Nessun passaggio al PDF originale deve essere loggato');
    assert.ok(!logs.some((l) => l.includes('Collegio docenti ore')), 'Il testo estratto non deve mai finire nei log');
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

// ---------------------------------------------------------------------------
// 2. (C-PDF2) Groq 0 elementi, Gemini text-only risponde [] -> ULTIMO fallback
//    Gemini sul PDF ORIGINALE (stesso base64, mimeType application/pdf)
// ---------------------------------------------------------------------------

test('2. Gemini text-only produce []: fallback finale a Gemini sul PDF ORIGINALE', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiTextCalls = 0;
  let geminiPdfCalls = 0;
  let groqCalls = 0;
  let capturedGeminiPdfBody: any = null;
  const callOrder: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      const bodyStr = opts?.body ? opts.body.toString() : '';
      if (bodyStr.includes('inlineData')) {
        geminiPdfCalls++;
        callOrder.push('gemini-pdf');
        capturedGeminiPdfBody = bodyStr ? JSON.parse(bodyStr) : null;
        return geminiMockResponse(JSON.stringify([sampleItem]));
      }
      geminiTextCalls++;
      callOrder.push('gemini-text');
      // Risposta formalmente valida ma SENZA elementi: il fallback continua.
      return geminiMockResponse('[]');
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

    assert.equal(groqCalls, 1);
    assert.equal(geminiTextCalls, 1, 'Gemini text-only deve essere tentato prima del PDF originale');
    assert.equal(geminiPdfCalls, 1, 'Gemini sul PDF originale deve essere l\'ULTIMO fallback');
    assert.deepEqual(callOrder, ['groq', 'gemini-text', 'gemini-pdf'], 'Ordine: Groq, Gemini text-only, Gemini PDF originale');

    // Il PDF originale arriva a Gemini con mimeType e base64 ORIGINALI.
    assert.ok(capturedGeminiPdfBody, 'Gemini deve ricevere il payload PDF');
    const part = geminiBodyParts(capturedGeminiPdfBody).find((p: any) => p.inlineData);
    assert.ok(part, 'Gemini deve ricevere inlineData');
    assert.equal(part.inlineData.mimeType, 'application/pdf');
    assert.equal(part.inlineData.data, multiPagePdfBase64, 'Gemini deve ricevere il PDF ORIGINALE, byte per byte');

    assert.equal(json.success, true);
    assert.equal(json.source, 'gemini-3.8-flash');
    assert.equal(json.items.length, 1);

    // Diagnostica: entrambi i passaggi devono essere distinguibili nei log.
    const textEmptyLog = logs.find((l) => l.includes('[AI Circolari PDF] fallback=gemini-text-extracted') && l.includes('esito=empty') && l.includes('categoria=zero-items') && l.includes('items=0'));
    assert.ok(textEmptyLog, `Log gemini-text-extracted vuoto mancante: ${JSON.stringify(logs)}`);
    const pdfLog = logs.find((l) => l.includes('[AI Circolari PDF] fallback=gemini-original-pdf remainingBudgetMs='));
    assert.ok(pdfLog, `Log di passaggio al PDF originale mancante: ${JSON.stringify(logs)}`);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

// ---------------------------------------------------------------------------
// 3. Groq produce elementi validi -> risultato immediato, NESSUN Gemini
// ---------------------------------------------------------------------------

test('3. PDF digitale con testo sufficiente: Groq text-only primario, nessun Gemini (text o PDF) chiamato', async () => {
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
    assert.equal(geminiCalls, 0, 'NESSUNA chiamata Gemini (né text-only né PDF) se Groq ha successo');

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
// 4. (C-PDF2) Gemini text-only fallisce con 503 -> Gemini sul PDF ORIGINALE
//    viene comunque tentato con il budget residuo
// ---------------------------------------------------------------------------

test('4. Gemini text-only fallisce con errore transitorio 503: si passa a Gemini sul PDF ORIGINALE', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_CANDIDATE_MODELS: process.env.GEMINI_CANDIDATE_MODELS,
  };
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';
  process.env.GEMINI_CANDIDATE_MODELS = 'gemini-3.8-flash';

  let geminiTextCalls = 0;
  let geminiPdfCalls = 0;
  let groqCalls = 0;
  let capturedGeminiPdfBody: any = null;
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      const bodyStr = opts?.body ? opts.body.toString() : '';
      if (bodyStr.includes('inlineData')) {
        geminiPdfCalls++;
        capturedGeminiPdfBody = bodyStr ? JSON.parse(bodyStr) : null;
        return geminiMockResponse(JSON.stringify([sampleItem]));
      }
      geminiTextCalls++;
      return geminiMockResponse('Service Unavailable', 503);
    }
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      // Anche Groq fallisce (scenario di produzione: 200 senza elementi o 5xx).
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

    assert.equal(groqCalls, 1, 'Groq text-only deve essere tentato per primo');
    assert.equal(geminiTextCalls, 1, 'Gemini text-only deve essere tentato dopo Groq');
    assert.equal(geminiPdfCalls, 1, 'Gemini sul PDF originale deve essere tentato dopo il 503 del text-only');

    const part = geminiBodyParts(capturedGeminiPdfBody).find((p: any) => p.inlineData);
    assert.ok(part, 'Gemini deve ricevere inlineData del PDF originale');
    assert.equal(part.inlineData.mimeType, 'application/pdf');
    assert.equal(part.inlineData.data, multiPagePdfBase64);

    assert.equal(json.success, true);
    assert.equal(json.source, 'gemini-3.8-flash');

    // Diagnostica: fallimento classificato del text-only, poi passaggio al PDF.
    const failLog = logs.find((l) => l.includes('[AI Circolari PDF] fallback=gemini-text-extracted') && l.includes('esito=failed') && l.includes('categoria=sovraccarico') && l.includes('durationMs='));
    assert.ok(failLog, `Log di fallimento gemini-text-extracted mancante: ${JSON.stringify(logs)}`);
    const pdfLog = logs.find((l) => l.includes('[AI Circolari PDF] fallback=gemini-original-pdf remainingBudgetMs='));
    assert.ok(pdfLog, `Log di passaggio al PDF originale mancante: ${JSON.stringify(logs)}`);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

// ---------------------------------------------------------------------------
// 5. PDF senza testo utile (es. scansione): percorso INVARIATO, niente
//    gemini-text-extracted, Gemini direttamente sul PDF originale
// ---------------------------------------------------------------------------

test('5. PDF senza testo utile: Groq e Gemini text-only NON usati, Gemini direttamente sul PDF originale', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiTextCalls = 0;
  let geminiPdfCalls = 0;
  let groqCalls = 0;
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      const bodyStr = opts?.body ? opts.body.toString() : '';
      if (bodyStr.includes('inlineData')) geminiPdfCalls++;
      else geminiTextCalls++;
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
    assert.equal(geminiTextCalls, 0, 'PDF senza testo utile non deve usare il nuovo percorso Gemini text-only');
    assert.equal(geminiPdfCalls, 1, 'Gemini deve essere chiamato direttamente sul PDF originale');
    assert.ok(!logs.some((l) => l.includes('fallback=gemini-text-extracted')), 'Nessun log del nuovo passaggio per PDF senza testo');
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

// ---------------------------------------------------------------------------
// 6. (C-PDF2) PDF multipagina: il prompt Gemini text-only contiene TUTTO il
//    testo estratto, inclusi i separatori di pagina dell'estrattore
// ---------------------------------------------------------------------------

test('6. Il prompt Gemini text-only contiene tutto il testo multipagina estratto, con i separatori di pagina', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let capturedGeminiTextBody: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      const bodyStr = opts?.body ? opts.body.toString() : '';
      if (!bodyStr.includes('inlineData')) {
        capturedGeminiTextBody = bodyStr ? JSON.parse(bodyStr) : null;
      }
      return geminiMockResponse(JSON.stringify([sampleItem]));
    }
    if (sUrl.includes('api.groq.com')) {
      return groqMockResponse(JSON.stringify({ items: [] }));
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

    assert.ok(capturedGeminiTextBody, 'Gemini text-only deve essere stato chiamato');
    const sentText = geminiBodyParts(capturedGeminiTextBody).map((p: any) => p.text ?? '').join('\n');

    // Contenuto di TUTTE le pagine, non solo la prima.
    assert.ok(sentText.includes('SETTEMBRE'));
    assert.ok(sentText.includes('Collegio docenti'));
    assert.ok(sentText.includes('OTTOBRE'));
    assert.ok(sentText.includes('Consiglio di classe 3E'));
    assert.ok(sentText.includes('NOVEMBRE'));
    assert.ok(sentText.includes('GLO classe 2D'));
    // Separatori strutturali dell'estrattore preservati.
    assert.ok(sentText.includes('--- PAGINA 1 ---'));
    assert.ok(sentText.includes('--- PAGINA 2 ---'));
    assert.ok(sentText.includes('--- PAGINA 3 ---'));
    assert.ok(sentText.includes('--- PAGINA 4 ---'));
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 7. (C-PDF2) Budget UNICO dei 45s: il nuovo passaggio consuma budget residuo
//    e il PDF originale riceve SOLO quello che resta, mai un nuovo 45s pieno
// ---------------------------------------------------------------------------

test('7. Il nuovo passaggio non supera il budget complessivo: Gemini PDF riceve il residuo, non un nuovo 45s', async () => {
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
  // i budget dei tentativi leggibili direttamente dai log diagnostici.
  process.env.GEMINI_CANDIDATE_MODELS = 'gemini-3.8-flash';

  const GROQ_DELAY_MS = 2_000;
  const GEMINI_TEXT_DELAY_MS = 1_000;
  let geminiTextCalls = 0;
  let geminiPdfCalls = 0;
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
      const bodyStr = opts?.body ? opts.body.toString() : '';
      if (bodyStr.includes('inlineData')) {
        geminiPdfCalls++;
        return geminiMockResponse(JSON.stringify([sampleItem]));
      }
      geminiTextCalls++;
      // Il text-only consuma tempo reale e poi fallisce (come i 503 visti in produzione).
      await new Promise((resolve) => setTimeout(resolve, GEMINI_TEXT_DELAY_MS));
      return geminiMockResponse('Service Unavailable', 503);
    }
    if (sUrl.includes('api.groq.com')) {
      groqCalls++;
      await new Promise((resolve) => setTimeout(resolve, GROQ_DELAY_MS));
      return groqMockResponse('Service Unavailable', 503);
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;

  try {
    const requestStartedAt = Date.now();
    const json: any = await withServer(async (url) => {
      const res = await originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: multiPagePdfBase64, mimeType: 'application/pdf', profile: validProfile }),
      });
      assert.equal(res.status, 200);
      return res.json();
    });
    const totalDurationMs = Date.now() - requestStartedAt;

    assert.equal(json.success, true);
    assert.equal(groqCalls, 1);
    assert.equal(geminiTextCalls, 1);
    assert.equal(geminiPdfCalls, 1);
    // Mai oltre il deadline complessivo esistente.
    assert.ok(totalDurationMs < CIRCULAR_ANALYSIS_TIMEOUT_MS, `La richiesta deve chiudersi dentro i 45s: ${totalDurationMs}ms`);

    // Il passaggio text-only è vincolato dal suo cap, non dal budget pieno.
    const budgetLog = logs.find((l) => l.includes('[AI Circolari PDF] fallback=gemini-text-extracted budgetMs='));
    assert.ok(budgetLog, `Log budget gemini-text-extracted mancante: ${JSON.stringify(logs)}`);
    const budgetMatch = /budgetMs=(\d+)/.exec(budgetLog!);
    assert.ok(budgetMatch);
    assert.ok(Number(budgetMatch![1]) <= PDF_TEXT_GEMINI_TEXT_BUDGET_MS, `Il budget del text-only non deve superare il cap: ${budgetMatch![1]}`);

    const textAttemptLog = logs.find((l) => l.includes('[AI Circolari PDF-Text]') && l.includes('timeoutMs='));
    assert.ok(textAttemptLog, `Log tentativo Gemini text-only mancante: ${JSON.stringify(logs)}`);
    const textTimeoutMs = Number(/timeoutMs=(\d+)/.exec(textAttemptLog!)![1]);
    assert.ok(
      textTimeoutMs <= PDF_TEXT_GEMINI_TEXT_BUDGET_MS - GEMINI_RESPONSE_RESERVE_MS,
      `Il tentativo text-only deve restare dentro il cap: timeoutMs=${textTimeoutMs}`,
    );

    // Il PDF originale riceve il RESIDUO dei 45s, decurtato da Groq + text-only.
    const pdfAttemptLog = logs.find((l) => l.includes('[AI Circolari]') && !l.includes('PDF-Text') && l.includes('modello=gemini-3.8-flash') && l.includes('timeoutMs='));
    assert.ok(pdfAttemptLog, `Log tentativo Gemini sul PDF mancante: ${JSON.stringify(logs)}`);
    const pdfTimeoutMs = Number(/timeoutMs=(\d+)/.exec(pdfAttemptLog!)![1]);
    const fullBudgetAttempt = CIRCULAR_ANALYSIS_TIMEOUT_MS - GEMINI_RESPONSE_RESERVE_MS;
    assert.ok(
      pdfTimeoutMs < fullBudgetAttempt - GROQ_DELAY_MS - GEMINI_TEXT_DELAY_MS + 500,
      `Gemini PDF non deve ricevere un budget pieno dopo Groq e text-only: timeoutMs=${pdfTimeoutMs}`,
    );
    assert.ok(pdfTimeoutMs > 20_000, `Budget residuo troppo piccolo per un tentativo sensato: timeoutMs=${pdfTimeoutMs}`);

    const fallbackLog = logs.find((l) => l.includes('[AI Circolari PDF] fallback=gemini-original-pdf remainingBudgetMs='));
    assert.ok(fallbackLog, 'Log di fallback con budget residuo mancante');
    const remainingBudgetMs = Number(/remainingBudgetMs=(\d+)/.exec(fallbackLog!)![1]);
    // Il residuo loggato riflette il tempo già consumato da Groq e dal text-only:
    // ben al di sotto dei 45s pieni, ma ancora ampiamente positivo.
    assert.ok(remainingBudgetMs < CIRCULAR_ANALYSIS_TIMEOUT_MS - GROQ_DELAY_MS - GEMINI_TEXT_DELAY_MS + 500);
    assert.ok(remainingBudgetMs > CIRCULAR_ANALYSIS_TIMEOUT_MS - GROQ_DELAY_MS - GEMINI_TEXT_DELAY_MS - 4_000);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// 8. Il payload inviato a GROQ contiene tutto il testo estratto multipagina
//    (comportamento preesistente, invariato)
// ---------------------------------------------------------------------------

test('8. Il payload inviato a Groq contiene tutto il testo estratto multipagina, non solo la prima pagina', async () => {
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
// 9. Estrazione PDF fallisce (PDF non valido) -> niente 500, Gemini PDF
//    direttamente, nessun passaggio text-only (comportamento invariato)
// ---------------------------------------------------------------------------

test('9. Estrazione testo fallisce (PDF non interpretabile): nessun 500, Gemini direttamente sul PDF originale', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiTextCalls = 0;
  let geminiPdfCalls = 0;
  let groqCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      const bodyStr = opts?.body ? opts.body.toString() : '';
      if (bodyStr.includes('inlineData')) geminiPdfCalls++;
      else geminiTextCalls++;
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
    assert.equal(geminiTextCalls, 0, 'Estrazione fallita: Gemini text-only non deve essere tentato');
    assert.equal(geminiPdfCalls, 1, 'Gemini deve comunque essere tentato sul PDF originale');
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 10. Groq restituisce elementi scartati dalla normalizzazione: il fallback
//     parte comunque e il primo tentativo è Gemini TEXT-ONLY
// ---------------------------------------------------------------------------

test('10. Groq restituisce elementi non validi/scartati dalla normalizzazione: fallback a Gemini text-only', async () => {
  const saved = {
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_TEST_GROQ_KEY_123';

  let geminiTextCalls = 0;
  let geminiPdfCalls = 0;
  let groqCalls = 0;
  const callOrder: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    const sUrl = inputUrl.toString();
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      const bodyStr = opts?.body ? opts.body.toString() : '';
      if (bodyStr.includes('inlineData')) {
        geminiPdfCalls++;
        callOrder.push('gemini-pdf');
      } else {
        geminiTextCalls++;
        callOrder.push('gemini-text');
      }
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
    assert.equal(geminiTextCalls, 1, 'Gemini text-only deve intervenire dopo il fallimento di normalizzazione');
    assert.equal(geminiPdfCalls, 0, 'Il PDF originale resta ultimo fallback: non serve se il text-only ha successo');
    assert.deepEqual(callOrder, ['groq', 'gemini-text']);
    assert.equal(json.success, true);
    assert.equal(json.source, 'gemini-3.8-flash');
    assert.equal(json.items.length, 1);
  } finally {
    restoreEnv(saved);
    globalThis.fetch = originalFetch;
  }
});
