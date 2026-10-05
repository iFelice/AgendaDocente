/**
 * Percorso PDF con testo di /api/analyze-circular: tempo reale per pagina,
 * risposta compatta del modello, nessun fallback Groq/Qwen.
 *
 * Tutti i provider sono simulati (nessuna chiamata reale): la fetch globale
 * viene sostituita e risponde in base all'header `X-Server-Timeout`, cioè al
 * budget che il server concede davvero al singolo tentativo. È così che si
 * riproduce "una pagina che ha bisogno di 20 secondi" senza attendere 20
 * secondi veri.
 */
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  app,
  CIRCULAR_RESPONSE_SCHEMA,
  PDF_PAGE_CONCURRENCY,
  PDF_PAGE_FIRST_MODEL_BUDGET_MS,
  PDF_PAGE_TIMEOUT_MS,
  PDF_SINGLE_CALL_BUDGET_MS,
  PDF_SINGLE_CALL_MAX_CHARS,
  PDF_TEXT_ANALYSIS_TIMEOUT_MS,
  GEMINI_CANDIDATE_MODELS_DEFAULT,
} from '../server';
import { CIRCULAR_REQUEST_TIMEOUT_MS } from '../src/services/aiService';
import { buildMinimalPdf } from './helpers/pdfFixtures';

process.env.TEST_RATE_LIMIT = 'relaxed';

const profile = {
  id: 'teacher', fullName: 'Docente Test', schoolName: 'Scuola Test', schoolYear: '2026/2027',
  primarySubjects: ['Matematica'], classes: ['1A'], campuses: ['Centrale'], roles: [],
};

/** Item nello SCHEMA COMPATTO: nessun relevance, nessun relevanceReason. */
function compactItem(title: string, extra: Record<string, unknown> = {}) {
  return {
    title, category: 'collegio_docenti', date: '2026-09-04', deadlineDate: '',
    startTime: '09:00', endTime: '11:00', className: '', subject: '', location: '', notes: '',
    isDeadline: false, rawSnippet: 'Riga sintetica', recipientGrades: [], recipientClasses: [],
    ...extra,
  };
}

function sevenPagePdf(): string {
  return buildMinimalPdf(Array.from({ length: 7 }, (_, i) => [
    `CURRENT_PAGE_${i + 1}`,
    `Piano annuale pagina ${i + 1} con collegio docenti e attivita programmate per settembre 2026`,
    'Testo sintetico ripetuto per garantire un text layer complessivamente sufficiente alla selezione del percorso per pagina.',
  ])).toString('base64');
}

/** Una sola pagina, text layer sopra la soglia di sufficienza (250 caratteri). */
function onePagePdf(): string {
  return buildMinimalPdf([[
    'CURRENT_PAGE_1',
    'Piano annuale: collegio docenti del 4 settembre 2026 dalle 09.00 alle 11.00 in Aula Magna.',
    'Testo sintetico ripetuto per superare la soglia minima di testo utile di questo documento.',
    'Seconda riga di contorno con altre attivita programmate nel mese di settembre 2026.',
    'Terza riga di contorno per portare il text layer oltre la soglia minima di sufficienza.',
    'Quarta riga di contorno con note organizzative generiche sul calendario delle riunioni.',
  ]]).toString('base64');
}

/** Tre pagine ma testo complessivo breve: niente suddivisione. */
function shortThreePagePdf(): string {
  return buildMinimalPdf(Array.from({ length: 3 }, (_, i) => [
    `CURRENT_PAGE_${i + 1}`,
    `Avviso breve pagina ${i + 1}: collegio docenti 4 settembre 2026 ore 09.00 in Aula Magna.`,
    `Riga di contorno ${i + 1} con poche informazioni organizzative sul calendario.`,
  ])).toString('base64');
}

function currentPage(body: string): number {
  const matches = [...body.matchAll(/CURRENT_PAGE_(\d+)/g)];
  return Number(matches.at(-1)?.[1] ?? 0);
}

/** Budget realmente concesso al tentativo, in millisecondi (header in secondi). */
function serverTimeoutMs(init?: RequestInit): number {
  const value = new Headers(init?.headers as any).get('X-Server-Timeout');
  return value ? Number(value) * 1_000 : 0;
}

function geminiResponse(items: any[], status = 200, outputTokens = 42): Response {
  if (status !== 200) return new Response(JSON.stringify({ error: { code: status, message: 'simulated' } }), { status });
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] }, finishReason: 'STOP' }],
    usageMetadata: { candidatesTokenCount: outputTokens },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

interface Call { provider: 'gemini' | 'groq'; page: number; body: string; timeoutMs: number; model: string }

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

/** Sostituisce i provider: nessuna chiamata di rete reale esce dal test. */
async function mockedProviders(
  handler: (call: Call) => Response | Promise<Response>,
  run: (calls: Call[]) => Promise<void>,
) {
  const saved = {
    gemini: process.env.GEMINI_API_KEY,
    groq: process.env.GROQ_API_KEY,
    variant: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
  };
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  process.env.GROQ_API_KEY = 'gsk_FAKE_TEST_KEY';
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const isGemini = url.includes('generativelanguage.googleapis.com');
    const isGroq = url.includes('api.groq.com');
    if (!isGemini && !isGroq) return originalFetch(input, init);
    const body = String(init?.body ?? '');
    const model = /models\/([^:]+):/.exec(url)?.[1] ?? '';
    const call: Call = { provider: isGemini ? 'gemini' : 'groq', page: currentPage(body), body, timeoutMs: serverTimeoutMs(init), model };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  try { await run(calls); } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [['GEMINI_API_KEY', saved.gemini], ['GROQ_API_KEY', saved.groq], ['GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT', saved.variant]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Schema compatto
// ---------------------------------------------------------------------------

test('schema compatto: relevance e relevanceReason non sono più richiesti al modello', () => {
  const properties = (CIRCULAR_RESPONSE_SCHEMA.items as any).properties;
  const required = (CIRCULAR_RESPONSE_SCHEMA.items as any).required as string[];
  assert.equal(properties.relevance, undefined);
  assert.equal(properties.relevanceReason, undefined);
  assert.ok(!required.includes('relevance'));
  assert.ok(!required.includes('relevanceReason'));
  // I campi che restano non cambiano nome né significato.
  for (const field of ['title', 'category', 'date', 'startTime', 'endTime', 'className', 'subject', 'location', 'notes', 'deadlineDate', 'isDeadline', 'rawSnippet', 'recipientGrades', 'recipientClasses']) {
    assert.ok(properties[field], `campo mancante nello schema: ${field}`);
  }
  // rawSnippet resta (evidenza del filtro) ma con il limite esplicito; notes idem.
  assert.match(properties.rawSnippet.description, /120 caratteri/);
  assert.match(properties.notes.description, /120 caratteri/);
});

test('items senza relevance dal modello: la classificazione resta quella deterministica dell\'app', async () => {
  await mockedProviders(
    (call) => geminiResponse([compactItem(`Consiglio pagina ${call.page}`, { className: '1A', category: 'consiglio_classe' })]),
    async (calls) => {
      const result = await postPdf(onePagePdf());
      assert.equal(result.status, 200);
      assert.equal(result.json.items.length, 1);
      // Ricalcolata dall'app (classe 1A del profilo), non dal modello.
      assert.equal(result.json.items[0].relevance, 'VERDE');
      assert.match(result.json.items[0].relevanceReason, /Pertinente per 1A/);
      // Lo schema inviato al modello non chiede più i due campi.
      assert.ok(calls.every((call) => !call.body.includes('relevanceReason')));
      assert.ok(calls.every((call) => !/"relevance"/.test(call.body)));
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Tempo reale per pagina
// ---------------------------------------------------------------------------

test('pagina che ha bisogno di 20 secondi: ora riesce (con 30 s di budget pagina falliva)', async () => {
  await mockedProviders(
    (call) => call.timeoutMs < 20_000
      ? geminiResponse([], 504)
      : geminiResponse([compactItem(`Evento pagina ${call.page}`)]),
    async (calls) => {
      const result = await postPdf(sevenPagePdf());
      assert.equal(result.status, 200);
      assert.equal(result.json.success, true);
      assert.equal(result.json.items.length, 7);
      assert.equal(result.json.notice, undefined);
      // Una sola chiamata per pagina: il primo modello ha già tempo a sufficienza.
      assert.equal(calls.length, 7);
      assert.ok(calls.every((call) => call.timeoutMs >= 20_000), 'ogni pagina riceve almeno 20 s');
      assert.ok(calls.every((call) => call.model === GEMINI_CANDIDATE_MODELS_DEFAULT[0]));
    },
  );
});

test('concorrenza del percorso per pagina: mai più di 2 richieste in volo', async () => {
  let active = 0;
  let maxActive = 0;
  await mockedProviders(
    async (call) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return geminiResponse([compactItem(`Evento pagina ${call.page}`)]);
    },
    async () => {
      const result = await postPdf(sevenPagePdf());
      assert.equal(result.status, 200);
      assert.equal(result.json.items.length, 7);
      assert.ok(maxActive <= 2, `concorrenza osservata ${maxActive}`);
      assert.equal(PDF_PAGE_CONCURRENCY, 2);
    },
  );
});

test('budget: 40 s per pagina, al massimo 25 s al primo modello, il resto al secondo', async () => {
  await mockedProviders(
    (call) => call.model === GEMINI_CANDIDATE_MODELS_DEFAULT[0]
      ? geminiResponse([], 500)
      : geminiResponse([compactItem(`Evento pagina ${call.page}`)]),
    async (calls) => {
      const result = await postPdf(sevenPagePdf());
      assert.equal(result.status, 200);
      assert.equal(result.json.items.length, 7);
      const first = calls.filter((call) => call.model === GEMINI_CANDIDATE_MODELS_DEFAULT[0]);
      const second = calls.filter((call) => call.model === GEMINI_CANDIDATE_MODELS_DEFAULT[1]);
      assert.equal(second.length, 7, 'il secondo modello riceve un tentativo su ogni pagina');
      assert.ok(first.every((call) => call.timeoutMs <= PDF_PAGE_FIRST_MODEL_BUDGET_MS));
      assert.ok(second.every((call) => call.timeoutMs >= 10_000), 'al secondo modello resta un tentativo vero');
      assert.equal(PDF_PAGE_TIMEOUT_MS, 40_000);
    },
  );
});

test('503 su una pagina: un solo retry immediato sullo stesso modello', async () => {
  const perModel = new Map<string, number>();
  await mockedProviders(
    (call) => {
      const key = `${call.page}:${call.model}`;
      const seen = (perModel.get(key) ?? 0) + 1;
      perModel.set(key, seen);
      if (call.page === 2) return geminiResponse([], 503);
      return geminiResponse([compactItem(`Evento pagina ${call.page}`)]);
    },
    async (calls) => {
      const result = await postPdf(sevenPagePdf());
      assert.equal(result.status, 200);
      const page2 = calls.filter((call) => call.page === 2);
      // 2 modelli × (1 tentativo + 1 retry) = al massimo 4 chiamate, mai di più.
      assert.equal(page2.length, 4);
      for (const model of GEMINI_CANDIDATE_MODELS_DEFAULT) {
        assert.equal(page2.filter((call) => call.model === model).length, 2);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Pagine non analizzate ed esito vuoto
// ---------------------------------------------------------------------------

test('pagina fallita: notice con i numeri di pagina e NESSUNA chiamata a Groq', async () => {
  await mockedProviders(
    (call) => call.page === 4 ? geminiResponse([], 400) : geminiResponse([compactItem(`Evento pagina ${call.page}`)]),
    async (calls) => {
      const result = await postPdf(sevenPagePdf());
      assert.equal(result.status, 200);
      assert.equal(result.json.items.length, 6);
      assert.match(result.json.notice, /pagine non analizzate: 4 \(su 7\)/);
      assert.equal(calls.filter((call) => call.provider === 'groq').length, 0);
    },
  );
});

test('tutte le pagine fallite: errore esplicito con il numero di pagine non lette, non "nessun impegno"', async () => {
  await mockedProviders(
    () => geminiResponse([], 400),
    async (calls) => {
      const result = await postPdf(sevenPagePdf());
      assert.equal(result.status, 503);
      assert.equal(result.json.success, false);
      assert.deepEqual(result.json.items, []);
      assert.match(result.json.error, /7 pagine non sono state lette su 7/);
      assert.match(result.json.error, /incolla il testo/);
      assert.doesNotMatch(result.json.error, /[Nn]essun impegno/);
      assert.equal(calls.filter((call) => call.provider === 'groq').length, 0);
    },
  );
});

test('pagine non lette e zero items estratti: errore, mai un esito vuoto silenzioso', async () => {
  await mockedProviders(
    (call) => call.page === 1 ? geminiResponse([]) : geminiResponse([], 400),
    async () => {
      const result = await postPdf(sevenPagePdf());
      assert.equal(result.status, 503);
      assert.equal(result.json.success, false);
      assert.match(result.json.error, /6 pagine non sono state lette su 7/);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Documenti brevi: una sola chiamata
// ---------------------------------------------------------------------------

test('PDF di una pagina: chiamata unica con l\'intero budget, senza blocco di contesto', async () => {
  await mockedProviders(
    () => geminiResponse([compactItem('Collegio docenti')]),
    async (calls) => {
      const result = await postPdf(onePagePdf());
      assert.equal(result.status, 200);
      assert.equal(result.json.items.length, 1);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].timeoutMs > PDF_PAGE_TIMEOUT_MS, 'la chiamata unica non è limitata al budget di pagina');
      assert.ok(!calls[0].body.includes('CONTESTO'), 'nessun blocco di contesto quando il documento è uno solo');
      assert.ok(!calls[0].body.includes('inlineData'), 'il testo estratto sostituisce il PDF originale');
      assert.ok(calls[0].body.includes('CURRENT_PAGE_1'), 'la chiamata porta il testo estratto');
    },
  );
});

test('PDF multipagina ma testo complessivo sotto 1500 caratteri: nessuna suddivisione', async () => {
  await mockedProviders(
    () => geminiResponse([compactItem('Collegio docenti')]),
    async (calls) => {
      const result = await postPdf(shortThreePagePdf());
      assert.equal(result.status, 200);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].body.includes('CURRENT_PAGE_3'), 'la chiamata unica contiene tutte le pagine');
      assert.ok(calls[0].body.includes('CURRENT_PAGE_1'), 'la chiamata unica contiene tutte le pagine');
      assert.ok(!calls[0].body.includes('inlineData'), 'percorso testo, non PDF originale');
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Deadline coerenti
// ---------------------------------------------------------------------------

test('deadline del percorso PDF 150 s, timeout client 160 s, chiamata unica dentro il deadline', () => {
  assert.equal(PDF_TEXT_ANALYSIS_TIMEOUT_MS, 150_000);
  assert.equal(CIRCULAR_REQUEST_TIMEOUT_MS, 160_000);
  assert.ok(PDF_SINGLE_CALL_BUDGET_MS < PDF_TEXT_ANALYSIS_TIMEOUT_MS);
  assert.equal(PDF_SINGLE_CALL_MAX_CHARS, 1_500);
  assert.deepEqual(GEMINI_CANDIDATE_MODELS_DEFAULT, ['gemini-3.1-flash-lite', 'gemini-3.5-flash']);
});
