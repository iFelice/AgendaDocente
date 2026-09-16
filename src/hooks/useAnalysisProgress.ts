import { useCallback, useEffect, useRef, useState } from "react";
import {
  ANALYSIS_COMPLETION_MS,
  ANALYSIS_DONE_HOLD_MS,
  ANALYSIS_TICK_MS,
  ANALYSIS_PHASE_LABELS,
  analysisCompletionStageAt,
  analysisWaitStageAt,
  isAnalysisPhaseActive,
  type AnalysisPhase,
} from "../utils/analysisProgress";

/**
 * Animatore del progresso UI dell'analisi documenti.
 *
 * - un solo loop di timer alla volta, tracciato: `stop()`, unmount o chiusura
 *   del modale non lasciano ALCUN timer attivo (`pendingTimers()` = 0);
 * - `start()` riparte sempre da 0 (nuova analisi = nuovo indicator);
 * - `complete(cb)` si usa quando la risposta arriva DAVVERO: rampa 85 -> 100,
 *   poi esegue la callback (cambio schermata). Se l'utente chiude/torna
 *   indietro la callback non viene più chiamata;
 * - in errore basta `stop()`: barra fermata e azzerata, messaggio esistente in UI.
 *
 * Timer e orologio iniettabili: i test sono deterministici, senza attese reali.
 */
export interface UseAnalysisProgressOptions {
  tickMs?: number;
  completionMs?: number;
  /** Per quanto mostrare il 100% "Completato" prima di cambiare schermata. */
  doneHoldMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

// Default STABILI (identità fissa tra i render): se venissero ricreati a ogni
// render, `cancelAll` cambierebbe identità e l'effetto di cleanup lo chiamerebbe
// a ogni tick, azzerando i timer in volo (barta bloccata).
const defaultNow = () => Date.now();
const defaultSetTimer = (callback: () => void, ms: number) => setTimeout(callback, ms);
const defaultClearTimer = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>);

export interface AnalysisProgressController {
  percent: number;
  phase: AnalysisPhase;
  label: string;
  active: boolean;
  start: () => void;
  complete: (afterPaint: () => void) => void;
  stop: () => void;
  /** Solo per i test/diagnostica: quanti timer risultano ancora in volo. */
  pendingTimers: () => number;
}

export function useAnalysisProgress(options: UseAnalysisProgressOptions = {}): AnalysisProgressController {
  const tickMs = options.tickMs ?? ANALYSIS_TICK_MS;
  const completionMs = options.completionMs ?? ANALYSIS_COMPLETION_MS;
  const doneHoldMs = options.doneHoldMs ?? ANALYSIS_DONE_HOLD_MS;
  const now = options.now ?? defaultNow;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;

  const [stage, setStage] = useState<{ phase: AnalysisPhase; percent: number }>({ phase: "idle", percent: 0 });
  const timers = useRef(new Map<number, unknown>());
  const token = useRef(0);
  const startedAt = useRef(0);
  const respondedAt = useRef<number | null>(null);
  const running = useRef(false);
  /** Lettura sempre aggiornata dello stadio corrente: la rampa finale non arretra. */
  const stageRef = useRef(stage);
  stageRef.current = stage;

  const cancelAll = useCallback(() => {
    for (const handle of timers.current.values()) clearTimer(handle);
    timers.current.clear();
  }, [clearTimer]);

  const schedule = useCallback((callback: () => void, ms: number) => {
    const id = ++token.current;
    const run = () => {
      timers.current.delete(id);
      callback();
    };
    // La maniglia è registrata prima che il callback possa girare (mai sincrono).
    timers.current.set(id, setTimer(run, ms));
  }, [setTimer]);

  const tick = useCallback(() => {
    if (!running.current) return;
    const next = respondedAt.current === null
      ? analysisWaitStageAt(now() - startedAt.current)
      : analysisCompletionStageAt(now() - respondedAt.current, stageRef.current.percent);
    setStage({ phase: next.phase, percent: Math.round(next.percent) });
    if (next.phase === "done") {
      running.current = false;
      cancelAll();
      return;
    }
    schedule(tick, tickMs);
  }, [cancelAll, now, schedule, tickMs]);

  const start = useCallback(() => {
    cancelAll();
    running.current = true;
    respondedAt.current = null;
    startedAt.current = now();
    setStage({ phase: "preparing", percent: 0 });
    schedule(tick, tickMs);
  }, [cancelAll, now, schedule, tick, tickMs]);

  const complete = useCallback((afterPaint: () => void) => {
    if (!running.current) {
      // Nessuna animazione in corso (mai avviata, già ferma o errore): niente da mostrare.
      afterPaint();
      return;
    }
    respondedAt.current = now();
    setStage({ phase: "processing", percent: Math.max(stageRef.current.percent, 88) });
    schedule(() => {
      cancelAll(); // ferma il loop di tick: il 100% resta fermo, non "risale"
      running.current = false;
      respondedAt.current = null;
      setStage({ phase: "done", percent: 100 });
      // Il "Completato" deve essere VISIBILE: la schermata successiva arriva dopo.
      schedule(() => {
        cancelAll();
        afterPaint();
      }, doneHoldMs);
    }, completionMs);
  }, [cancelAll, completionMs, doneHoldMs, now, schedule]);

  const stop = useCallback(() => {
    running.current = false;
    respondedAt.current = null;
    cancelAll();
    setStage({ phase: "idle", percent: 0 });
  }, [cancelAll]);

  // Cleanup garantito all'unmount, senza dipendere dall'identità delle callback:
  // così nessun timer sopravvive al componente (close/unmount/errore).
  const cancelAllRef = useRef(cancelAll);
  cancelAllRef.current = cancelAll;
  useEffect(() => () => cancelAllRef.current(), []);

  return {
    percent: stage.percent,
    phase: stage.phase,
    label: ANALYSIS_PHASE_LABELS[stage.phase],
    active: isAnalysisPhaseActive(stage.phase),
    start,
    complete,
    stop,
    pendingTimers: () => timers.current.size,
  };
}
