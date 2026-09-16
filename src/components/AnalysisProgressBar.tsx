import React from "react";
import { ANALYSIS_MAX_WAIT_PERCENT, analysisPercentLabel, analysisValueText, type AnalysisPhase } from "../utils/analysisProgress";

/**
 * Barra di avanzamento STIMATA dell'analisi documenti.
 *
 * Accessibile (progressbar + valore + testo d'esito in aria-live) e dichiarata
 * come stima: non è una percentuale del backend (Gemini non la espone), quindi
 * durante l'attesa il valore non supera `ANALYSIS_MAX_WAIT_PERCENT`.
 * L'altezza è fissa per le tre righe (stato, barra, nota): il cambio di testo
 * non sposta il contenuto sottostante.
 */
interface AnalysisProgressBarProps {
  percent: number;
  label: string;
  phase: AnalysisPhase;
  /** Id radice, per i test e per legare l'etichetta alla barra. */
  id?: string;
}

export const AnalysisProgressBar: React.FC<AnalysisProgressBarProps> = ({ percent, label, phase, id = "analysis-progress" }) => {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div id={id} className="w-full max-w-sm mx-auto space-y-1.5 text-left">
      <div className="flex items-center justify-between gap-2 min-h-[1.25rem]">
        <span id={`${id}-status`} role="status" aria-live="polite" className="text-xs font-medium text-stone-700 min-w-0 truncate">
          {label}
        </span>
        <span className="text-xs font-bold text-emerald-800 tabular-nums shrink-0" aria-hidden="true">
          {analysisPercentLabel(value)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-labelledby={`${id}-status`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={analysisValueText(phase, value)}
        className="h-2 w-full rounded-full bg-stone-200 overflow-hidden"
      >
        <div
          data-progress-fill
          className="h-full rounded-full bg-emerald-600 transition-[width] duration-150 ease-out"
          style={{ width: `${value}%` }}
        />
      </div>
      <p className="text-[10px] leading-tight text-stone-400">
        Avanzamento stimato dell’operazione (le analisi più lunghe restano intorno al {ANALYSIS_MAX_WAIT_PERCENT}%):
        non è una percentuale reale del servizio cloud.
      </p>
    </div>
  );
};
