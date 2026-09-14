/**
 * Progresso STIMATO dell'analisi documenti (solo UI).
 *
 * Gemini non espone una percentuale reale: i numeri qui sono una mappatura del
 * TEMPO TRASCORSO, cioè un indicatore di avanzamento dell'operazione — non una
 * misura del backend. Per questo:
 *  - durante l'attesa la barra NON supera mai `ANALYSIS_MAX_WAIT_PERCENT` (85):
 *  raggiungerla vorrebbe dire «sto per finire», che non possiamo sapere;
 *  - il 100% compare solo DOPO la risposta reale (rampa breve 85 -> 95 -> 100);
 *  - in caso di errore o chiusura l'animazione si ferma (vedi hook).
 *
 * Logica pura: nessuna API, nessun timer, nessun React → deterministica e testabile.
 */

/** Soglia massima durante l'attesa della risposta cloud. */
export const ANALYSIS_MAX_WAIT_PERCENT = 85;
/** Passo dell'animazione (UI): il valore è interpolato sul tempo, non sui tick. */
export const ANALYSIS_TICK_MS = 120;
/** Rampa finale dopo la risposta: 85 -> 95 -> 100. */
export const ANALYSIS_COMPLETION_MS = 320;
/** Tempo in cui il "Completato" al 100% resta visibile prima della schermata successiva. */
export const ANALYSIS_DONE_HOLD_MS = 180;
/** Fine fase "Preparazione documento" (0-10%). */
export const ANALYSIS_PREPARING_MS = 400;
/** Fine fase "Invio sicuro" (10-20%). */
export const ANALYSIS_SENDING_MS = 900;
/** Costante temporale del rallentamento asintotico verso 85. */
export const ANALYSIS_ANALYZING_TAU_MS = 20_000;
/** Tetto difensivo: oltre questo tempo l'attesa resta vicina a 85, senza derive numeriche. */
export const ANALYSIS_WAIT_HORIZON_MS = 10 * 60_000;

export type AnalysisPhase = "idle" | "preparing" | "sending" | "analyzing" | "processing" | "done";

export const ANALYSIS_PHASE_LABELS: Record<AnalysisPhase, string> = {
  idle: "Pronto",
  preparing: "Preparazione documento",
  sending: "Invio sicuro",
  analyzing: "Analisi del documento",
  processing: "Elaborazione risultati",
  done: "Completato",
};

/** Fasi che rappresentano un'operazione in corso (animazione attiva). */
export function isAnalysisPhaseActive(phase: AnalysisPhase): boolean {
  return phase === "preparing" || phase === "sending" || phase === "analyzing" || phase === "processing";
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export interface AnalysisStage {
  phase: AnalysisPhase;
  /** 0-100, valore UI stimato (arrotondato al chiamante). */
  percent: number;
}

/**
 * Stadio dell'attesa in funzione del tempo trascorso dall'inizio:
 * 0→10 preparazione, 10→20 invio, poi 20→85 con passo via via più lento
 * (asintotico: non tocca 85 e non lo supera, per nessuna durata).
 */
export function analysisWaitStageAt(elapsedMs: number): AnalysisStage {
  const elapsed = clamp(Number.isFinite(elapsedMs) ? elapsedMs : 0, 0, ANALYSIS_WAIT_HORIZON_MS);
  if (elapsed < ANALYSIS_PREPARING_MS) {
    return { phase: "preparing", percent: (elapsed / ANALYSIS_PREPARING_MS) * 10 };
  }
  if (elapsed < ANALYSIS_SENDING_MS) {
    const ratio = (elapsed - ANALYSIS_PREPARING_MS) / (ANALYSIS_SENDING_MS - ANALYSIS_PREPARING_MS);
    return { phase: "sending", percent: 10 + ratio * 10 };
  }
  const ratio = 1 - Math.exp(-(elapsed - ANALYSIS_SENDING_MS) / ANALYSIS_ANALYZING_TAU_MS);
  return { phase: "analyzing", percent: 20 + (ANALYSIS_MAX_WAIT_PERCENT - 20) * ratio };
}

/**
 * Stadio dopo la risposta reale: parte dal valore già mostrato (non torna
 * indietro), passa per "Elaborazione risultati" e chiude a 100 "Completato".
 */
export function analysisCompletionStageAt(msSinceResponse: number, floorPercent = 0): AnalysisStage {
  const from = clamp(Number.isFinite(floorPercent) ? floorPercent : 0, 0, ANALYSIS_MAX_WAIT_PERCENT);
  const elapsed = Number.isFinite(msSinceResponse) ? Math.max(0, msSinceResponse) : 0;
  if (elapsed >= ANALYSIS_COMPLETION_MS) return { phase: "done", percent: 100 };
  if (elapsed >= ANALYSIS_COMPLETION_MS / 2) return { phase: "processing", percent: Math.max(from, 95) };
  return { phase: "processing", percent: Math.max(from, 88) };
}

/** Testo della barra: "42%". */
export function analysisPercentLabel(percent: number): string {
  return `${Math.round(clamp(percent, 0, 100))}%`;
}

/** Descrizione unica per screen reader (stato + stima). */
export function analysisValueText(phase: AnalysisPhase, percent: number): string {
  return `${ANALYSIS_PHASE_LABELS[phase]} — avanzamento stimato ${analysisPercentLabel(percent)}`;
}
