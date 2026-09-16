import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import {
  ANALYSIS_COMPLETION_MS,
  ANALYSIS_DONE_HOLD_MS,
  ANALYSIS_MAX_WAIT_PERCENT,
  ANALYSIS_PHASE_LABELS,
  analysisCompletionStageAt,
  analysisPercentLabel,
  analysisValueText,
  analysisWaitStageAt,
  isAnalysisPhaseActive,
} from '../src/utils/analysisProgress';
import { useAnalysisProgress, type AnalysisProgressController } from '../src/hooks/useAnalysisProgress';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Progresso VISIBILE durante l'analisi documenti.
 *
 * Gemini non espone una percentuale reale: la barra è una STIMA dell'avanzamento
 * dell'operazione. Per questo il vincolo importante è: durante l'attesa il valore
 * sale piano e NON supera mai 85; il 100% "Completato" esiste solo DOPO la risposta;
 * errore/chiusura/unmount fermano l'animazione senza lasciare timer in volo.
 */

// ---------------------------------------------------------------------------
// 1. Mappatura pura tempo -> stadio
// ---------------------------------------------------------------------------

test('attesa: 0-10 preparazione, 10-20 invio, poi asintoto verso 85 senza mai superarlo', () => {
  assert.deepEqual(analysisWaitStageAt(0), { phase: "preparing", percent: 0 }, 'si parte da 0');
  assert.equal(analysisWaitStageAt(200).phase, "preparing");
  assert.equal(analysisWaitStageAt(200).percent, 5);
  assert.equal(analysisWaitStageAt(400).phase, "sending");
  assert.ok(analysisWaitStageAt(650).percent > 10 && analysisWaitStageAt(650).percent < 20, '10→20 nella fase di invio');
  assert.equal(analysisWaitStageAt(900).phase, "analyzing");

  assert.equal(ANALYSIS_MAX_WAIT_PERCENT, 85, 'il requisito: mai oltre 85% in attesa');
  let previous = -1;
  for (let ms = 0; ms <= 24 * 60 * 60_000; ms += 60_000) {
    const { percent } = analysisWaitStageAt(ms);
    assert.ok(percent >= previous, `monotono (${ms}ms: ${percent} < ${previous})`);
    assert.ok(percent <= 85, `${ms}ms: la stima non supera 85% (${percent})`);
    previous = percent;
  }
  const forever = analysisWaitStageAt(24 * 60 * 60_000);
  assert.ok(forever.percent < 85, `il valore grezzo non tocca 85 (${forever.percent})`);
  assert.equal(analysisPercentLabel(forever.percent), "85%", 'in UI l’attesa lunghissima resta ferma a 85%, non va a 100');
  // Valori folli non spaccano nulla.
  assert.ok(Number.isFinite(analysisWaitStageAt(Number.NaN).percent));
  assert.ok(analysisWaitStageAt(-1000).percent >= 0);
});

test('il 100% esiste solo dopo la risposta: rampa 88 → 95 → 100 "Completato"', () => {
  assert.deepEqual(analysisCompletionStageAt(0, 42), { phase: "processing", percent: 88 });
  assert.equal(analysisCompletionStageAt(ANALYSIS_COMPLETION_MS / 2, 88).percent, 95);
  assert.deepEqual(analysisCompletionStageAt(ANALYSIS_COMPLETION_MS, 88), { phase: "done", percent: 100 });
  assert.equal(analysisCompletionStageAt(9999, 88).phase, "done");
  // Non fa arretrare il valore già mostrato.
  assert.equal(analysisCompletionStageAt(0, 84).percent, 88);
  assert.ok(analysisCompletionStageAt(ANALYSIS_COMPLETION_MS, Number.NaN).percent === 100);
});

test('etichette di fase coerenti con il requisito (e testo per screen reader)', () => {
  assert.equal(ANALYSIS_PHASE_LABELS.preparing, "Preparazione documento");
  assert.equal(ANALYSIS_PHASE_LABELS.sending, "Invio sicuro");
  assert.equal(ANALYSIS_PHASE_LABELS.analyzing, "Analisi del documento");
  assert.equal(ANALYSIS_PHASE_LABELS.processing, "Elaborazione risultati");
  assert.equal(ANALYSIS_PHASE_LABELS.done, "Completato");
  assert.equal(analysisPercentLabel(42.6), "43%", "percentuale numerica intera");
  assert.equal(analysisPercentLabel(-5), "0%");
  assert.equal(analysisPercentLabel(120), "100%");
  assert.equal(analysisValueText("analyzing", 61), "Analisi del documento — avanzamento stimato 61%");
  assert.deepEqual(
    [isAnalysisPhaseActive("preparing"), isAnalysisPhaseActive("processing"), isAnalysisPhaseActive("done"), isAnalysisPhaseActive("idle")],
    [true, true, false, false]
  );
});

// ---------------------------------------------------------------------------
// 2. Hook: clock e timer finti → nessuna attesa reale,断 assert sui timer
// ---------------------------------------------------------------------------

function fakeTimers() {
  let nowValue = 0;
  let nextId = 1;
  const queue: Array<{ id: number; at: number; run: () => void }> = [];
  return {
    now: () => nowValue,
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      queue.push({ id, at: nowValue + Math.max(0, ms), run: callback });
      return id;
    },
    clearTimer: (handle: unknown) => {
      const index = queue.findIndex(entry => entry.id === handle);
      if (index >= 0) queue.splice(index, 1);
    },
    pending: () => queue.length,
    /** Fa scorrere l'orologio, eseguendo i timer in scadenza (nessun timer residuo). */
    async advance(ms: number) {
      const target = nowValue + ms;
      for (;;) {
        const due = queue.filter(entry => entry.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        nowValue = due.at;
        queue.splice(queue.indexOf(due), 1);
        await act(async () => { due.run(); });
      }
      nowValue = target;
      await act(async () => { await Promise.resolve(); });
    },
  };
}

let controller: AnalysisProgressController | null = null;

function Probe({ clock, tickMs = 100, completionMs = 300, doneHoldMs = 100 }: { clock: ReturnType<typeof fakeTimers>; tickMs?: number; completionMs?: number; doneHoldMs?: number }) {
  controller = useAnalysisProgress({
    tickMs,
    completionMs,
    doneHoldMs,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const value = controller;
  return React.createElement('div', {
    'data-percent': value.percent,
    'data-phase': value.phase,
    'data-label': value.label,
    'data-active': String(value.active),
  });
}

async function mountProbe(options: { tickMs?: number; completionMs?: number; doneHoldMs?: number } = {}) {
  const clock = fakeTimers();
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(Probe, { clock, ...options }));
  });
  return { clock, renderer };
}

function read(renderer: any) {
  const node = renderer.root.findAll((el: any) => el.props?.['data-percent'] !== undefined)[0];
  return {
    percent: Number(node.props['data-percent']),
    phase: String(node.props['data-phase']),
    label: String(node.props['data-label']),
    active: node.props['data-active'] === 'true',
  };
}

test('hook: parte da 0 e cresce, ma durante l’attesa non supera 85', async () => {
  const { clock, renderer } = await mountProbe();
  await act(async () => { controller!.start(); });
  assert.deepEqual(read(renderer), { percent: 0, phase: 'preparing', label: 'Preparazione documento', active: true }, 'prima frame: 0%');

  const seen: number[] = [];
  for (let step = 0; step < 30; step++) {
    await clock.advance(100);
    const state = read(renderer);
    seen.push(state.percent);
    assert.ok(state.percent <= 85, `stima entro 85 (${state.percent})`);
    assert.notEqual(state.percent, 100, 'mai "completato" senza risposta');
  }
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `avanzamento progressivo (${seen[i - 1]} → ${seen[i]})`);
  assert.ok(seen[seen.length - 1] > seen[0], 'la barra si muove davvero');
  assert.equal(read(renderer).phase, 'analyzing');
  assert.ok(clock.pending() > 0, 'l’animazione è ancora in volo (attesa in corso)');
  await act(async () => { renderer.unmount(); });
});

test('hook: 100% solo dopo la risposta, poi la schermata successiva; nessun timer residuo', async () => {
  const { clock, renderer } = await mountProbe();
  await act(async () => { controller!.start(); });
  await clock.advance(500);

  let applied = 0;
  await act(async () => { controller!.complete(() => { applied++; }); });
  assert.equal(read(renderer).percent, 88, 'subito dopo la risposta: elaborazione risultati');
  assert.equal(applied, 0, 'la schermata successiva non è ancora mostrata');

  await clock.advance(200);
  assert.equal(read(renderer).percent, 95, 'rampa rapida');
  assert.equal(applied, 0);

  await clock.advance(100);
  assert.deepEqual(read(renderer), { percent: 100, phase: 'done', label: 'Completato', active: false }, 'il 100% è visibile');
  assert.equal(applied, 0, 'il 100% resta a schermo un istante prima del cambio schermata');

  await clock.advance(100);
  assert.equal(applied, 1, 'poi si passa alla schermata successiva, una sola volta');
  assert.equal(clock.pending(), 0, 'nessun timer lasciato attivo dopo il completamento');

  await clock.advance(1000);
  assert.equal(applied, 1, 'nessuna ripetizione');
  assert.equal(read(renderer).percent, 100, 'il valore resta fermo a 100');
  await act(async () => { renderer.unmount(); });
});

test('hook: errore ferma e azzera l’animazione; nessun timer in volo', async () => {
  const { clock, renderer } = await mountProbe();
  await act(async () => { controller!.start(); });
  await clock.advance(700);
  assert.ok(read(renderer).percent > 0, 'era in corso un’animazione');

  await act(async () => { controller!.stop(); });
  assert.deepEqual(read(renderer), { percent: 0, phase: 'idle', label: 'Pronto', active: false }, 'barra fermata e azzerata');
  assert.equal(clock.pending(), 0, 'nessun timer residuo');

  await clock.advance(5000);
  assert.equal(read(renderer).percent, 0, 'il tempo che passa non riavvia nulla');

  // Una `complete` arrivata tardi (corsa dopo l'errore) non deve bloccare l'UI.
  let applied = 0;
  await act(async () => { controller!.complete(() => { applied++; }); });
  assert.equal(applied, 1, 'se l’animazione è ferma il cambio schermata avviene subito');
  assert.equal(clock.pending(), 0);
  await act(async () => { renderer.unmount(); });
});

test('hook: unmount e chiusura non lasciano timer; la callback rinviata non scatta più', async () => {
  const { clock } = await mountProbe();
  await act(async () => { controller!.start(); });
  await clock.advance(400);

  let applied = 0;
  await act(async () => { controller!.complete(() => { applied++; }); });
  assert.ok(clock.pending() > 0, 'rampa in volo');

  // Chiusura (o unmount) durante il hold: nessun timer superstite, nessuna sorpresa dopo.
  await act(async () => { controller!.stop(); });
  assert.equal(clock.pending(), 0, 'stop() pulisce tutto');
  await act(async () => { controller!.start(); });
  await clock.advance(100);
  await act(async () => { controller!.stop(); });
  await clock.advance(2000);
  assert.equal(applied, 0, 'la callback della sessione annullata non viene più eseguita');

  const { clock: clock2, renderer: renderer2 } = await mountProbe();
  await act(async () => { controller!.start(); });
  await clock2.advance(200);
  await act(async () => { controller!.complete(() => {}); });
  assert.ok(clock2.pending() > 0, 'rampa in volo prima dello smontaggio');
  await act(async () => { renderer2.unmount(); });
  assert.equal(clock2.pending(), 0, 'unmount: nessun timer sopravvive al componente');
  assert.equal(controller!.pendingTimers(), 0, 'e il controller non ne dichiara più');
});

test('hook: nuova analisi riparte da 0', async () => {
  const { clock, renderer } = await mountProbe();
  await act(async () => { controller!.start(); });
  await clock.advance(4000);
  assert.ok(read(renderer).percent > 20, 'la prima analisi era avanzata');

  await act(async () => { controller!.start(); });
  assert.deepEqual(read(renderer), { percent: 0, phase: 'preparing', label: 'Preparazione documento', active: true }, 'seconda analisi: si riparte da zero');
  assert.equal(clock.pending(), 1, 'un solo loop di tick in volo');
  await act(async () => { renderer.unmount(); });
});

test('hook: complete senza start non blocca mai il flusso', async () => {
  const { clock, renderer } = await mountProbe();
  let applied = 0;
  await act(async () => { controller!.complete(() => { applied++; }); });
  assert.equal(applied, 1);
  assert.equal(read(renderer).phase, 'idle');
  assert.equal(clock.pending(), 0);
  await act(async () => { renderer.unmount(); });
});
