/**
 * Ripresa delle pagine mancanti nel client (percorso PDF per pagina).
 *
 * Il server può rispondere 200 con un'analisi PARZIALE: `notice` testuale e,
 * da questa PR, l'elenco strutturato `unanalyzedPages`. Qui si verifica che la
 * finestra mostri il pulsante "Riprova le pagine mancanti", che il clic
 * rimandi lo STESSO file chiedendo SOLO quelle pagine, e soprattutto che
 * l'unione sia additiva: nessun impegno già a schermo viene sostituito, le
 * modifiche manuali, le selezioni e le eliminazioni restano intatte, i
 * duplicati esatti non vengono aggiunti.
 *
 * Nessuna chiamata di rete reale: la fetch globale è sostituita.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import {
  circularItemKey,
  circularPartialNotice,
  circularTotalPagesFromNotice,
  mergeCircularItems,
  sanitizeUnanalyzedPages,
  CIRCULAR_AUTO_RESUME_DELAY_MS,
  CIRCULAR_AUTO_RESUME_MAX_ATTEMPTS,
} from '../src/services/aiService';
import type { ExtractedItem, TeacherProfile } from '../src/types';
import { installSignedInAnalysisClient } from './helpers/analysisClientSession';
installSignedInAnalysisClient();


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

const profile: TeacherProfile = {
  id: 'teacher', fullName: 'Docente Test', schoolName: 'Scuola Test', schoolLevel: 'ssig',
  schoolYear: '2026/2027', primarySubjects: ['Matematica'], classes: ['1A'], campuses: [], roles: [],
};

/** Impegno sintetico: nessun documento scolastico reale, nessun dato personale. */
function item(title: string, extra: Record<string, unknown> = {}) {
  return { title, category: 'riunione', date: '2026-12-10', startTime: '09:00', endTime: '11:00', ...extra };
}

interface ServerReply { items: any[]; unanalyzedPages?: number[]; notice?: string; status?: number; error?: string; errorCode?: string }

interface Capture { body: any }

/**
 * Sostituisce la fetch: la prima risposta è l'analisi iniziale, le successive
 * sono le riprese, nell'ordine. Ogni richiesta viene registrata.
 */
function mockServer(replies: ServerReply[]): Capture[] {
  const captured: Capture[] = [];
  let call = 0;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    captured.push({ body: JSON.parse(String(init?.body ?? '{}')) });
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    if (reply.status && reply.status >= 400) {
      return new Response(JSON.stringify({ success: false, items: [], error: reply.error, errorCode: reply.errorCode ?? 'AI_UNAVAILABLE' }), {
        status: reply.status, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      success: true, source: 'gemini-3.1-flash-lite', items: reply.items,
      ...(reply.notice ? { notice: reply.notice } : {}),
      ...(reply.unanalyzedPages ? { unanalyzedPages: reply.unanalyzedPages } : {}),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return captured;
}

function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return (node.children ?? []).map(textOf).join(' ').replace(/\s+/g, ' ').trim();
}

const retryButton = (root: any) =>
  root.findAll((n: any) => n.type === 'button' && n.props?.id === 'btn-retry-missing-pages')[0];

const stopAutoResumeButton = (root: any) =>
  root.findAll((n: any) => n.type === 'button' && n.props?.id === 'btn-stop-auto-resume')[0];

/** Accelera solo i timer da 4 secondi, registrandoli per verificare la pausa prevista. */
function accelerateAutomaticResumeDelays() {
  const originalSetTimeout = globalThis.setTimeout;
  const scheduledDelays: number[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
    const delay = Number(timeout ?? 0);
    if (delay === CIRCULAR_AUTO_RESUME_DELAY_MS) {
      scheduledDelays.push(delay);
      return originalSetTimeout(handler, 0, ...args);
    }
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;
  return {
    scheduledDelays,
    restore: () => { globalThis.setTimeout = originalSetTimeout; },
  };
}

const scrollContainer = (root: any) =>
  root.findAll((n: any) => n.type === 'div'
    && typeof n.props.onScroll === 'function'
    && /overflow-y-auto/.test(n.props.className ?? ''))[0];

const titleInputs = (root: any) =>
  scrollContainer(root).findAll((n: any) => n.type === 'input' && n.props.type === 'text' && !n.props.placeholder);

const visibleTitles = (root: any) => titleInputs(root).map((n: any) => n.props.value);

const checkboxes = (root: any) =>
  scrollContainer(root).findAll((n: any) => n.type === 'input' && n.props.type === 'checkbox');

const deleteButtons = (root: any) =>
  scrollContainer(root).findAll((n: any) => n.type === 'button' && n.props?.title === 'Elimina questa riga estrapolata');

async function click(node: any) {
  assert.ok(node, 'elemento non trovato');
  await act(async () => { node.props.onClick(); });
}

/** Finestra aperta su un PDF, con analisi avviata automaticamente. */
async function renderPdfAnalysis(withFile = true) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(CircularAnalyzerModal, {
      isOpen: true, onClose: () => {}, profile, onImportEvents: () => {},
      initialFile: withFile
        ? { base64: 'QUJD', mimeType: 'application/pdf', fileName: 'piano.pdf', autoStartToken: `resume-${Math.random()}` }
        : null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// 1. Unione pura (funzione, senza interfaccia)
// ---------------------------------------------------------------------------

const extracted = (over: Partial<ExtractedItem>): ExtractedItem => ({
  tempId: 'id', title: 'Titolo', category: 'riunione', date: '2026-12-10',
  relevance: 'GIALLO', relevanceReason: '', selectedForImport: false, ...over,
});

test('unione: i nuovi impegni si aggiungono in coda, gli esistenti non vengono toccati', () => {
  const existing = [
    extracted({ tempId: 'a', title: 'Pagina 1', selectedForImport: true }),
    extracted({ tempId: 'b', title: 'Titolo corretto a mano' }),
  ];
  const merged = mergeCircularItems(existing, [extracted({ tempId: 'c', title: 'Pagina 4' })]);
  assert.deepEqual(merged.map((i) => i.title), ['Pagina 1', 'Titolo corretto a mano', 'Pagina 4']);
  assert.equal(merged[0], existing[0], 'la riga esistente è esattamente la stessa, non una copia');
  assert.equal(merged[0].selectedForImport, true);
});

test('unione: un duplicato esatto non viene aggiunto', () => {
  const existing = [extracted({ tempId: 'a', title: 'Collegio', startTime: '09:00', endTime: '11:00' })];
  const merged = mergeCircularItems(existing, [
    extracted({ tempId: 'z', title: 'Collegio', startTime: '09:00', endTime: '11:00' }),
    extracted({ tempId: 'y', title: 'Collegio', startTime: '15:00', endTime: '17:00' }),
  ]);
  assert.equal(merged.length, 2, 'il duplicato esatto non viene aggiunto');
  assert.deepEqual(merged.map((i) => i.title), ['Collegio', 'Collegio']);
  // Orario diverso = impegno diverso: non è un duplicato e va aggiunto.
  assert.deepEqual(merged.map((i) => i.startTime), ['09:00', '15:00']);
});

test('unione: nessuna riga nuova = stesso array, nessun re-render inutile', () => {
  const existing = [extracted({ tempId: 'a', title: 'Collegio' })];
  assert.equal(mergeCircularItems(existing, [extracted({ tempId: 'z', title: 'Collegio' })]), existing);
});

test('unione: un tempId in collisione viene reso univoco (selezioni ed eliminazioni restano distinte)', () => {
  const existing = [extracted({ tempId: 'extracted-1-0', title: 'Pagina 1' })];
  const merged = mergeCircularItems(existing, [extracted({ tempId: 'extracted-1-0', title: 'Pagina 4' })]);
  assert.equal(merged.length, 2);
  assert.notEqual(merged[0].tempId, merged[1].tempId);
});

test('la chiave di duplicato ignora tempId, selezione e note: solo i campi dell\'impegno', () => {
  const base = extracted({ tempId: 'a', title: 'Collegio', notes: 'nota' });
  const other = extracted({ tempId: 'b', title: 'Collegio', notes: 'altra nota', selectedForImport: true });
  assert.equal(circularItemKey(base), circularItemKey(other));
});

test('unanalyzedPages malformato non produce mai una ripresa che il server rifiuterebbe', () => {
  assert.equal(sanitizeUnanalyzedPages(undefined), undefined);
  assert.equal(sanitizeUnanalyzedPages('4,5'), undefined);
  assert.equal(sanitizeUnanalyzedPages([]), undefined);
  assert.equal(sanitizeUnanalyzedPages([0, -3, 1.5, 'x']), undefined);
  assert.deepEqual(sanitizeUnanalyzedPages([5, 2, 2, 0]), [2, 5]);
});

test('notice server: il totale si ricava una volta e l\'avviso client ha singolare e plurale', () => {
  assert.equal(circularTotalPagesFromNotice('Analisi parziale: pagine non analizzate: 3, 5 (su 7).'), 7);
  assert.equal(circularTotalPagesFromNotice('Avviso privo del totale'), undefined);
  assert.equal(circularPartialNotice([7], 7), 'Manca 1 pagina su 7: la 7.');
  assert.equal(circularPartialNotice([5, 3], 7), 'Mancano 2 pagine su 7: la 3 e la 5.');
  assert.equal(circularPartialNotice([1, 3, 5], 7), 'Mancano 3 pagine su 7: la 1, la 3 e la 5.');
});

// ---------------------------------------------------------------------------
// 2. Ripresa automatica, arresti e conservazione dei risultati
// ---------------------------------------------------------------------------

test('dopo una risposta parziale la ripresa parte da sola e chiede solo le pagine mancanti', async () => {
  const captured = mockServer([
    {
      items: [item('Collegio pagina 1')],
      unanalyzedPages: [4, 5],
      notice: 'Analisi parziale: pagine non analizzate: 4, 5 (su 5). Controllale nel documento originale.',
    },
    { items: [item('Riunione pagina 4', { date: '2026-12-14' }), item('Riunione pagina 5', { date: '2026-12-15' })] },
  ]);
  const renderer = await renderPdfAnalysis();
  try {
    assert.equal(captured.length, 2, 'la seconda richiesta parte senza clic manuale');
    assert.equal(captured[0].body.pages, undefined, 'la prima analisi non chiede pagine specifiche');
    assert.equal(captured[1].body.imageBase64, 'QUJD', 'viene rimandato lo stesso file');
    assert.equal(captured[1].body.mimeType, 'application/pdf');
    assert.deepEqual(captured[1].body.pages, [4, 5]);
    assert.deepEqual(visibleTitles(renderer.root), ['Collegio pagina 1', 'Riunione pagina 4', 'Riunione pagina 5']);
    assert.equal(stopAutoResumeButton(renderer.root), undefined, 'il ciclo termina quando non mancano più pagine');
    assert.equal(retryButton(renderer.root), undefined, 'non resta una ripresa manuale se l\'analisi è completa');
  } finally {
    await act(async () => renderer.unmount());
  }
});

test('analisi completa: non avvia riprese e non mostra un avviso', async () => {
  const captured = mockServer([{ items: [item('Collegio pagina 1')] }]);
  const renderer = await renderPdfAnalysis();
  try {
    assert.equal(captured.length, 1);
    assert.equal(retryButton(renderer.root), undefined);
    assert.equal(stopAutoResumeButton(renderer.root), undefined);
    assert.doesNotMatch(textOf(renderer.root), /pagine non analizzate/);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test('finestra senza file: resta l\'avviso ma non parte né compare una ripresa', async () => {
  mockServer([{
    items: [item('Collegio pagina 1')],
    unanalyzedPages: [3],
    notice: 'Analisi parziale: pagine non analizzate: 3 (su 3). Controllale nel documento originale.',
  }]);
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(CircularAnalyzerModal, {
      isOpen: true, onClose: () => {}, profile, onImportEvents: () => {},
      initialInputMode: 'text' as const,
    }));
  });
  try {
    const textarea = renderer.root.findAll((n: any) => n.type === 'textarea')[0];
    await act(async () => { textarea.props.onChange({ target: { value: 'Testo della circolare incollato dall\'utente.' } }); });
    const run = renderer.root.findAll((n: any) => n.type === 'button' && n.props?.id === 'btn-run-analysis')[0];
    await act(async () => { run.props.onClick(); await new Promise((r) => setTimeout(r, 60)); });

    assert.match(textOf(renderer.root), /Manca 1 pagina su 3: la 3\./);
    assert.equal(retryButton(renderer.root), undefined, 'senza file in memoria non compare il pulsante');
    assert.equal(stopAutoResumeButton(renderer.root), undefined);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test('tentativi automatici: notice aggiornato, risultati utilizzabili e modifiche utente conservate', async () => {
  const accelerated = accelerateAutomaticResumeDelays();
  const captured: Capture[] = [];
  let call = 0;
  let releaseFirst: (() => void) | null = null;
  let releaseSecond: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const jsonResponse = (body: any) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    captured.push({ body: JSON.parse(String(init?.body ?? '{}')) });
    const current = call++;
    if (current === 0) {
      return jsonResponse({
        success: true, source: 'server',
        items: [item('Collegio pagina 1'), item('Dipartimento pagina 2', { date: '2026-12-11' }), item('Da eliminare', { date: '2026-12-12' })],
        unanalyzedPages: [4, 5], notice: 'Analisi parziale: pagine non analizzate: 4, 5 (su 5).',
      });
    }
    if (current === 1) {
      await firstGate;
      return jsonResponse({
        success: true, source: 'server', items: [item('Riunione pagina 4', { date: '2026-12-14' })],
        unanalyzedPages: [5], notice: 'Analisi parziale: pagine non analizzate: 5 (su 2).',
      });
    }
    await secondGate;
    return jsonResponse({
      success: true, source: 'server', items: [item('Riunione pagina 5', { date: '2026-12-15' })],
    });
  }) as typeof fetch;

  let renderer: any;
  try {
    renderer = await renderPdfAnalysis();
    const root = renderer.root;
    assert.equal(captured.length, 2, 'il primo tentativo automatico è partito senza clic');
    assert.deepEqual(captured[1].body.pages, [4, 5]);
    assert.match(textOf(root), /Mancano 2 pagine su 5: la 4 e la 5\./, 'avviso plurale iniziale');
    assert.match(textOf(root), /Rileggo le pagine mancanti · tentativo 1 di 3/);
    assert.ok(stopAutoResumeButton(root), 'Interrompi è disponibile durante la richiesta');
    assert.equal(retryButton(root), undefined, 'il pulsante manuale non compete con il ciclo automatico');

    // Durante la richiesta, i risultati già arrivati restano modificabili.
    await act(async () => { titleInputs(root)[0].props.onChange({ target: { value: 'Collegio CORRETTO a mano' } }); });
    await act(async () => { checkboxes(root)[1].props.onChange(); });
    await click(deleteButtons(root)[2]);
    assert.deepEqual(checkboxes(root).map((checkbox: any) => checkbox.props.checked), [false, true]);

    // La prima ripresa lascia la pagina 5 mancante: dopo 4 secondi parte il secondo giro.
    await act(async () => { releaseFirst!(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(captured.length, 3);
    assert.deepEqual(captured[2].body.pages, [5]);
    assert.match(textOf(root), /Manca 1 pagina su 5: la 5\./, 'avviso aggiornato mantenendo il totale della prima risposta');
    assert.match(textOf(root), /Rileggo le pagine mancanti · tentativo 2 di 3/);
    assert.ok(stopAutoResumeButton(root));

    await act(async () => { releaseSecond!(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.deepEqual(visibleTitles(root), [
      'Collegio CORRETTO a mano', 'Dipartimento pagina 2', 'Riunione pagina 4', 'Riunione pagina 5',
    ]);
    assert.deepEqual(checkboxes(root).map((checkbox: any) => checkbox.props.checked), [false, true, false, false]);
    assert.ok(!textOf(root).includes('Da eliminare'), 'una riga eliminata non viene ripristinata');
    assert.deepEqual(accelerated.scheduledDelays, [CIRCULAR_AUTO_RESUME_DELAY_MS], 'pausa di 4 secondi fra i giri');
  } finally {
    if (releaseFirst) releaseFirst();
    if (releaseSecond) releaseSecond();
    if (renderer) await act(async () => renderer.unmount());
    accelerated.restore();
  }
});

test('il ciclo automatico si ferma dopo al massimo tre riprese e lascia il pulsante manuale', async () => {
  const accelerated = accelerateAutomaticResumeDelays();
  const captured = mockServer([
    { items: [item('Pagina iniziale')], unanalyzedPages: [4, 5, 6], notice: 'Pagine non analizzate: 4, 5, 6 (su 6).' },
    { items: [item('Pagina 4')], unanalyzedPages: [5, 6] },
    { items: [item('Pagina 5')], unanalyzedPages: [6] },
    { items: [item('Riprova pagina 6')], unanalyzedPages: [6] },
  ]);
  let renderer: any;
  try {
    renderer = await renderPdfAnalysis();
    assert.equal(captured.length, CIRCULAR_AUTO_RESUME_MAX_ATTEMPTS + 1, 'una richiesta iniziale più tre riprese');
    assert.deepEqual(captured.slice(1).map((entry) => entry.body.pages), [[4, 5, 6], [5, 6], [6]]);
    assert.equal(stopAutoResumeButton(renderer.root), undefined, 'il ciclo automatico è terminato');
    assert.ok(retryButton(renderer.root), 'resta disponibile la ripresa manuale');
    assert.equal(retryButton(renderer.root).props.disabled, false);
    assert.match(textOf(renderer.root), /Manca 1 pagina su 6: la 6\./, 'il totale della prima risposta è conservato fino all\'ultimo giro');
    assert.deepEqual(accelerated.scheduledDelays, [CIRCULAR_AUTO_RESUME_DELAY_MS, CIRCULAR_AUTO_RESUME_DELAY_MS]);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    accelerated.restore();
  }
});

test('un errore HTTP 429 interrompe le riprese automatiche e lascia la ripresa manuale', async () => {
  const captured = mockServer([
    { items: [item('Pagina iniziale')], unanalyzedPages: [2], notice: 'Pagine non analizzate: 2 (su 2).' },
    { items: [], status: 429, errorCode: 'RATE_LIMITED', error: 'Il servizio è temporaneamente occupato.' },
  ]);
  const renderer = await renderPdfAnalysis();
  try {
    assert.equal(captured.length, 2, 'dopo il 429 non partono altri tentativi');
    assert.equal(stopAutoResumeButton(renderer.root), undefined);
    assert.ok(retryButton(renderer.root), 'l\'utente può riprovare manualmente più tardi');
    assert.match(textOf(renderer.root), /temporaneamente occupato/);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test('Interrompi annulla la ripresa automatica in corso senza perdere i risultati', async () => {
  const captured: Capture[] = [];
  let call = 0;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    captured.push({ body: JSON.parse(String(init?.body ?? '{}')) });
    if (call++ === 0) {
      return new Response(JSON.stringify({
        success: true, source: 'server', items: [item('Collegio pagina 1')],
        unanalyzedPages: [2], notice: 'Pagine non analizzate: 2 (su 2).',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('request aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  }) as typeof fetch;

  const renderer = await renderPdfAnalysis();
  try {
    assert.equal(captured.length, 2, 'la ripresa automatica è partita');
    assert.ok(stopAutoResumeButton(renderer.root));
    assert.deepEqual(visibleTitles(renderer.root), ['Collegio pagina 1']);
    await click(stopAutoResumeButton(renderer.root));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(stopAutoResumeButton(renderer.root), undefined);
    assert.ok(retryButton(renderer.root), 'dopo l\'interruzione resta il pulsante manuale');
    assert.deepEqual(visibleTitles(renderer.root), ['Collegio pagina 1'], 'nessun risultato già arrivato viene perso');
    assert.equal(captured.length, 2, 'non partono altri giri');
  } finally {
    await act(async () => renderer.unmount());
  }
});
