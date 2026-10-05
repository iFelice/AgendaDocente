import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, GEMINI_MIN_ATTEMPT_MS, runGeminiJson } from '../server';
import { buildEmptyPdf, buildMinimalPdf } from './helpers/pdfFixtures';

process.env.TEST_RATE_LIMIT = 'relaxed';

const profile = {
  id: 'teacher', fullName: 'Docente Test', schoolName: 'Scuola Test', schoolYear: '2026/2027',
  primarySubjects: ['Matematica'], classes: ['1A'], campuses: ['Centrale'], roles: [],
};

function item(title: string) {
  return {
    title, category: 'collegio_docenti', date: '2026-09-04', deadlineDate: '',
    startTime: '09:00', endTime: '11:00', className: '', subject: '', location: '', notes: '',
    isDeadline: false, relevance: 'GIALLO', relevanceReason: 'Collegiale', rawSnippet: 'Riga sintetica',
    recipientGrades: [], recipientClasses: [],
  };
}

function sevenPagePdf(): string {
  return buildMinimalPdf(Array.from({ length: 7 }, (_, i) => [
    `CURRENT_PAGE_${i + 1}`,
    `Piano annuale pagina ${i + 1} con collegio docenti e attivita programmate per settembre 2026`,
    'Testo sintetico ripetuto per garantire un text layer complessivamente sufficiente alla selezione del percorso per pagina.',
  ])).toString('base64');
}

function currentPage(body: string): number {
  const matches = [...body.matchAll(/CURRENT_PAGE_(\d+)/g)];
  return Number(matches.at(-1)?.[1] ?? 0);
}

function geminiResponse(items: any[], status = 200): Response {
  if (status !== 200) return new Response(JSON.stringify({ error: { code: status, message: 'simulated' } }), { status });
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] }, finishReason: 'STOP' }],
    usageMetadata: { candidatesTokenCount: 42 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function groqResponse(items: any[], status = 200): Response {
  if (status !== 200) return new Response(JSON.stringify({ error: { message: 'simulated' } }), { status });
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: 'stop' }],
    usage: { completion_tokens: 24 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function withServer<T>(run: (url: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/analyze-circular`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function postPdf(base64: string): Promise<{ status: number; json: any }> {
  return withServer(async (url) => {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: base64, mimeType: 'application/pdf', profile }),
    });
    return { status: response.status, json: await response.json() };
  });
}

async function mockedProviders(
  handler: (provider: 'gemini' | 'groq', page: number, body: string) => Response | Promise<Response>,
  run: () => Promise<void>,
) {
  const savedGemini = process.env.GEMINI_API_KEY;
  const savedGroq = process.env.GROQ_API_KEY;
  const savedVariant = process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_FAKE_TEST_KEY';
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('generativelanguage.googleapis.com')) {
      const body = String(init?.body ?? '');
      return handler('gemini', currentPage(body), body);
    }
    if (url.includes('api.groq.com')) {
      const body = String(init?.body ?? '');
      return handler('groq', currentPage(body), body);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try { await run(); } finally {
    globalThis.fetch = originalFetch;
    if (savedGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedGemini;
    if (savedGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = savedGroq;
    if (savedVariant === undefined) delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT; else process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT = savedVariant;
  }
}

test('PDF digitale di 7 pagine: tutte analizzate per pagina con concorrenza massima 4', async () => {
  let active = 0;
  let maxActive = 0;
  const pages: number[] = [];
  await mockedProviders(async (provider, page) => {
    assert.equal(provider, 'gemini');
    active += 1; maxActive = Math.max(maxActive, active); pages.push(page);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return geminiResponse([item(`Evento pagina ${page}`)]);
  }, async () => {
    const result = await postPdf(sevenPagePdf());
    assert.equal(result.status, 200);
    assert.equal(result.json.success, true);
    assert.equal(result.json.items.length, 7);
    assert.equal(result.json.notice, undefined);
    assert.deepEqual(pages.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(maxActive <= 4);
    assert.ok(maxActive > 1);
  });
});

test('fallback per pagina: Gemini fallisce e Groq riesce sulla stessa pagina', async () => {
  const groqPages: number[] = [];
  await mockedProviders((provider, page) => {
    if (provider === 'gemini' && page === 3) return geminiResponse([], 400);
    if (provider === 'groq') { groqPages.push(page); return groqResponse([item(`Groq pagina ${page}`)]); }
    return geminiResponse([item(`Gemini pagina ${page}`)]);
  }, async () => {
    const result = await postPdf(sevenPagePdf());
    assert.equal(result.status, 200);
    assert.deepEqual(groqPages, [3]);
    assert.equal(result.json.items.some((value: any) => value.title === 'Groq pagina 3'), true);
  });
});

test('una pagina fallisce su entrambi: successo parziale con notice', async () => {
  await mockedProviders((provider, page) => {
    if (page === 4) return provider === 'gemini' ? geminiResponse([], 400) : groqResponse([], 503);
    return geminiResponse([item(`Evento pagina ${page}`)]);
  }, async () => {
    const result = await postPdf(sevenPagePdf());
    assert.equal(result.status, 200);
    assert.equal(result.json.items.length, 6);
    assert.match(result.json.notice, /pagine non analizzate: 4/);
  });
});

test('tutte le pagine fallite: errore controllato', async () => {
  await mockedProviders((provider) => provider === 'gemini' ? geminiResponse([], 400) : groqResponse([], 503), async () => {
    const result = await postPdf(sevenPagePdf());
    assert.equal(result.status, 503);
    assert.equal(result.json.success, false);
    assert.deepEqual(result.json.items, []);
  });
});

test('deduplica esatta conserva il primo elemento in ordine pagina', async () => {
  await mockedProviders(() => geminiResponse([item('Evento duplicato')]), async () => {
    const result = await postPdf(sevenPagePdf());
    assert.equal(result.status, 200);
    assert.equal(result.json.items.length, 1);
    assert.equal(result.json.items[0].title, 'Evento duplicato');
  });
});

test('runGeminiJson non avvia mai un tentativo con meno di 10 secondi', async () => {
  let calls = 0;
  const logs: string[] = [];
  const result = await runGeminiJson({
    contents: [{ text: 'test sintetico' }], signal: new AbortController().signal,
    label: 'Test budget', budgetMs: GEMINI_MIN_ATTEMPT_MS + 1_999,
    models: ['gemini-test'], client: { models: { generateContent: async () => { calls += 1; return { text: '[]' }; } } },
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.ok(logs.some((line) => line.includes('esito=skipped') && line.includes('budget-insufficiente')));
});

test('PDF scansione senza testo usa ancora Gemini sul file originale', async () => {
  let inlineDataCalls = 0;
  let groqCalls = 0;
  await mockedProviders((provider, _page, body) => {
    if (provider === 'groq') { groqCalls += 1; return groqResponse([]); }
    if (body.includes('inlineData')) inlineDataCalls += 1;
    return geminiResponse([item('Evento da scansione')]);
  }, async () => {
    const result = await postPdf(buildEmptyPdf().toString('base64'));
    assert.equal(result.status, 200);
    assert.equal(result.json.items.length, 1);
    assert.equal(inlineDataCalls, 1);
    assert.equal(groqCalls, 0);
  });
});
