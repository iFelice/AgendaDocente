import React, { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { PeriodSlot, TimeSlotConfig } from "../types";
import { MAX_PERIODS_PER_DAY } from "../utils/schoolDayPeriods";
import {
  areSlotsMatchingAuto,
  generateDefaultPeriodSlots,
  getEffectivePeriodSlots,
} from "../utils/timeSlots";

/** The two editing semantics shared by Profile and Timetable. */
export type TimeSlotConfigEditorMode = "auto" | "custom";

/**
 * Porta una lista di fasce ORARIE al numero richiesto, restando nel draft locale.
 *
 * L'estensione continua dall'ultima fascia effettiva: in una scansione custom
 * mantiene intervalli e durate già scelti invece di inventare una nuova scala
 * automatica. La funzione è pura e non ha alcuna persistenza propria.
 */
export function resizePeriodSlotsDraft(
  slots: PeriodSlot[],
  targetCount: number,
  durationMinutes: number,
): PeriodSlot[] {
  const target = Math.max(1, Math.min(MAX_PERIODS_PER_DAY, Math.floor(targetCount) || 1));
  if (slots.length === target) return slots;
  if (slots.length > target) return slots.slice(0, target);

  const extended = [...slots];
  while (extended.length < target) {
    const last = extended[extended.length - 1];
    const startTime = last ? last.endTime : "08:00";
    const periodNumber = extended.length + 1;
    extended.push({
      periodNumber,
      label: `${periodNumber}ª Ora`,
      startTime,
      endTime: generateDefaultPeriodSlots(startTime, 1, durationMinutes)[0].endTime,
    });
  }
  return extended;
}

/**
 * Materializza una configurazione editabile anche per il fallback legacy.
 * Il chiamante può partire dalla config globale, ma questa copia resta locale
 * finché non esegue il proprio salvataggio atomico.
 */
export function createTimeSlotConfigDraft(config?: TimeSlotConfig): TimeSlotConfig {
  const effectiveSlots = getEffectivePeriodSlots(config);
  return {
    firstHourStartTime: config?.firstHourStartTime || effectiveSlots[0]?.startTime || "07:50",
    periodsPerDay: effectiveSlots.length,
    standardDurationMinutes: config?.standardDurationMinutes || 60,
    customSlots: effectiveSlots,
  };
}

/** Riconosce le fasce auto anche quando sono state materializzate in customSlots. */
export function timeSlotConfigEditorMode(config?: TimeSlotConfig): TimeSlotConfigEditorMode {
  const draft = createTimeSlotConfigDraft(config);
  return draft.customSlots && !areSlotsMatchingAuto(
    draft.customSlots,
    draft.firstHourStartTime,
    draft.periodsPerDay,
    draft.standardDurationMinutes,
  ) ? "custom" : "auto";
}

/**
 * Normalizza il draft al formato che viene salvato da entrambi gli ingressi UI.
 * AUTO rigenera sempre dalla terna base; CUSTOM conserva slot, buchi e orari
 * manuali esattamente come sono nel draft.
 */
export function finalizedTimeSlotConfigDraft(
  config: TimeSlotConfig,
  mode: TimeSlotConfigEditorMode,
): TimeSlotConfig {
  const count = Math.max(1, Math.min(MAX_PERIODS_PER_DAY, Math.floor(config.periodsPerDay) || 1));
  const duration = Math.max(15, Math.min(180, Math.floor(config.standardDurationMinutes) || 60));
  const firstHourStartTime = config.firstHourStartTime || "07:50";
  const slots = mode === "auto"
    ? generateDefaultPeriodSlots(firstHourStartTime, count, duration)
    : getEffectivePeriodSlots(config);
  return {
    firstHourStartTime,
    periodsPerDay: slots.length,
    standardDurationMinutes: duration,
    customSlots: slots,
  };
}

export interface TimeSlotConfigEditorProps {
  /** Draft controllato dal contenitore. Questo componente non salva mai. */
  config: TimeSlotConfig;
  /** Massimo numero di ore richiesto dalla struttura della settimana. */
  requiredPeriods: number;
  /** Slot esistenti all'apertura: quelli oltre sono bozze da verificare. */
  confirmedSlotCount: number;
  /** La modalità è controllata dal contenitore per restare uguale nei due ingressi. */
  mode: TimeSlotConfigEditorMode;
  onModeChange: (next: TimeSlotConfigEditorMode) => void;
  onChange: (next: TimeSlotConfig) => void;
  /**
   * Profilo: estende anche una scansione custom quando la struttura cambia.
   * Drawer Orario: conserva il comportamento di scorciatoia, pre-proponendo
   * automaticamente solo la modalità AUTO e lasciando CUSTOM alla conferma
   * esplicita del pulsante di completamento.
   */
  autoCompleteRequiredPeriods?: boolean;
  /** Mostra l'intestazione di sezione quando il componente vive nel Profilo. */
  heading?: string;
  /** ID/label che permette a test e screen reader di distinguere gli editor. */
  context?: string;
}

/**
 * Editor condiviso di fasce orarie: UI e logica di draft sono una sola fonte
 * per Profilo docente e drawer Orario. Non conosce storage, scuole o lezioni.
 */
export const TimeSlotConfigEditor: React.FC<TimeSlotConfigEditorProps> = ({
  config,
  requiredPeriods,
  confirmedSlotCount,
  mode,
  onModeChange,
  onChange,
  autoCompleteRequiredPeriods = false,
  heading,
  context = "fasce orarie",
}) => {
  const [showAdvancedSlots, setShowAdvancedSlots] = useState(false);
  const safeRequiredPeriods = Math.max(1, Math.min(MAX_PERIODS_PER_DAY, Math.floor(requiredPeriods) || 1));
  const slots = useMemo(() => getEffectivePeriodSlots(config), [config]);
  const firstHourTime = config.firstHourStartTime || slots[0]?.startTime || "07:50";
  const periodDuration = Math.max(15, Math.min(180, config.standardDurationMinutes || 60));
  const periodsCount = Math.max(1, Math.min(MAX_PERIODS_PER_DAY, config.periodsPerDay || slots.length || 1));
  const missingSlotCount = Math.max(0, safeRequiredPeriods - slots.length);
  const proposalIsVisible = autoCompleteRequiredPeriods
    && safeRequiredPeriods > confirmedSlotCount
    && slots.length >= safeRequiredPeriods
    && slots.length > confirmedSlotCount;

  /**
   * Reagisce al draft della struttura scolastica SENZA persistere: questo è ciò
   * che consente 6/6/6/7/6 -> settima fascia nella stessa modale Profilo.
   * Non riduce mai: togliere un giorno extra non deve cancellare la 7ª fascia.
   */
  useEffect(() => {
    if (!autoCompleteRequiredPeriods || safeRequiredPeriods <= slots.length) return;
    const nextSlots = mode === "custom"
      ? resizePeriodSlotsDraft(slots, safeRequiredPeriods, periodDuration)
      : generateDefaultPeriodSlots(firstHourTime, safeRequiredPeriods, periodDuration);
    onChange({
      ...config,
      firstHourStartTime: firstHourTime,
      periodsPerDay: nextSlots.length,
      standardDurationMinutes: periodDuration,
      customSlots: nextSlots,
    });
  }, [
    autoCompleteRequiredPeriods,
    config,
    firstHourTime,
    mode,
    onChange,
    periodDuration,
    safeRequiredPeriods,
    slots,
  ]);

  const setAutoParameters = (next: Partial<Pick<TimeSlotConfig, "firstHourStartTime" | "periodsPerDay" | "standardDurationMinutes">>) => {
    const start = next.firstHourStartTime ?? firstHourTime;
    const count = Math.max(1, Math.min(MAX_PERIODS_PER_DAY, Math.floor(next.periodsPerDay ?? periodsCount) || 1));
    const duration = Math.max(15, Math.min(180, Math.floor(next.standardDurationMinutes ?? periodDuration) || 60));
    onChange({
      ...config,
      firstHourStartTime: start,
      periodsPerDay: count,
      standardDurationMinutes: duration,
      customSlots: generateDefaultPeriodSlots(start, count, duration),
    });
  };

  const setCustomCount = (nextCount: number) => {
    const count = Math.max(1, Math.min(MAX_PERIODS_PER_DAY, Math.floor(nextCount) || 1));
    const nextSlots = resizePeriodSlotsDraft(slots, count, periodDuration);
    onChange({ ...config, periodsPerDay: nextSlots.length, customSlots: nextSlots });
  };

  const completeMissingSlots = () => {
    const target = Math.max(safeRequiredPeriods, slots.length);
    const nextSlots = mode === "custom"
      ? resizePeriodSlotsDraft(slots, target, periodDuration)
      : generateDefaultPeriodSlots(firstHourTime, target, periodDuration);
    onChange({ ...config, periodsPerDay: nextSlots.length, customSlots: nextSlots });
  };

  const setCustomSlots = (nextSlots: PeriodSlot[]) => {
    onModeChange("custom");
    onChange({ ...config, periodsPerDay: nextSlots.length, customSlots: nextSlots });
  };

  const resetToAuto = () => {
    onModeChange("auto");
    setAutoParameters({});
  };

  return (
    <section className={heading ? "p-3.5 rounded-xl border border-stone-200 bg-white space-y-3" : "space-y-4"} data-testid={`time-slot-config-${context}`}>
      {heading && (
        <div>
          <h3 className="font-bold text-stone-800 text-xs">{heading}</h3>
          <p className="text-[11px] text-stone-600 leading-relaxed mt-1">
            Configura in un unico punto gli orari reali delle fasce della scuola.
          </p>
        </div>
      )}

      {missingSlotCount > 0 && (
        <div role="status" className="p-3 rounded-xl border border-amber-300 bg-amber-50 space-y-2">
          <p className="text-[11px] text-amber-900 leading-relaxed">
            La tua scuola prevede {safeRequiredPeriods} ore in almeno un giorno: {missingSlotCount === 1
              ? "manca 1 fascia oraria"
              : `mancano ${missingSlotCount} fasce orarie`}.
          </p>
          <button
            type="button"
            onClick={completeMissingSlots}
            className="px-3 py-2 min-h-[42px] bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold rounded-lg inline-flex items-center space-x-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{missingSlotCount === 1 ? "Completa la fascia mancante" : "Completa le fasce mancanti"}</span>
          </button>
        </div>
      )}

      {proposalIsVisible && missingSlotCount === 0 && (
        <p role="status" className="p-3 text-[11px] text-amber-900 bg-amber-50 rounded-xl border border-amber-300 leading-relaxed">
          Abbiamo proposto {slots.length - confirmedSlotCount === 1 ? "1 fascia in più" : `${slots.length - confirmedSlotCount} fasce in più`} per coprire le {safeRequiredPeriods} ore previste dalla tua scuola. La struttura della settimana arriva alla {safeRequiredPeriods}ª ora: abbiamo aggiunto la {safeRequiredPeriods}ª fascia alla configurazione, controlla gli orari prima di salvare.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 bg-stone-50 rounded-xl border border-stone-200">
        <div>
          <label className="block font-medium text-stone-700 mb-1" htmlFor={`first-hour-${context}`}>Inizio 1ª ora</label>
          <input
            id={`first-hour-${context}`}
            aria-label={`Inizio 1ª ora (${context})`}
            type="time"
            value={firstHourTime}
            onChange={(e) => {
              if (mode === "auto") setAutoParameters({ firstHourStartTime: e.target.value });
              else onChange({ ...config, firstHourStartTime: e.target.value });
            }}
            className="w-full p-2 border border-stone-300 rounded-lg text-xs font-mono bg-white text-stone-900"
          />
        </div>
        <div>
          <label className="block font-medium text-stone-700 mb-1" htmlFor={`period-count-${context}`}>N° fasce orarie</label>
          <input
            id={`period-count-${context}`}
            aria-label={`N° fasce orarie (${context})`}
            type="number"
            min="1"
            max={MAX_PERIODS_PER_DAY}
            value={periodsCount}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (mode === "auto") setAutoParameters({ periodsPerDay: next });
              else setCustomCount(next);
            }}
            className="w-full p-2 border border-stone-300 rounded-lg text-xs bg-white text-stone-900"
          />
        </div>
        <div>
          <label className="block font-medium text-stone-700 mb-1" htmlFor={`period-duration-${context}`}>Durata standard</label>
          <input
            id={`period-duration-${context}`}
            aria-label={`Durata standard (${context})`}
            type="number"
            min="30"
            max="120"
            step="5"
            value={periodDuration}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (mode === "auto") setAutoParameters({ standardDurationMinutes: next });
              else onChange({ ...config, standardDurationMinutes: Math.max(15, Math.min(180, next || 60)) });
            }}
            className="w-full p-2 border border-stone-300 rounded-lg text-xs bg-white text-stone-900"
          />
        </div>
      </div>

      <div className="flex items-center justify-between p-2 bg-stone-50 rounded-lg border border-stone-200">
        <div className="flex items-center space-x-2">
          <span className={`w-2 h-2 rounded-full ${mode === "custom" ? "bg-amber-500" : "bg-emerald-500"}`} />
          <span className="font-semibold text-stone-700 text-[11px]">
            Modalità: <strong>{mode === "custom" ? "Personalizzata (modifiche manuali attive)" : "Automatica (aggiornamento istantaneo)"}</strong>
          </span>
        </div>
        {mode === "custom" && (
          <button
            type="button"
            onClick={resetToAuto}
            className="px-2 py-1 bg-white hover:bg-stone-100 text-stone-700 border border-stone-200 rounded text-[11px] font-semibold flex items-center space-x-1"
            title="Rigenera da parametri base"
          >
            <RotateCcw className="w-3 h-3 text-emerald-700" />
            <span>Reimposta automatico</span>
          </button>
        )}
      </div>

      <div className="border-t border-stone-100 pt-3">
        <button
          type="button"
          onClick={() => setShowAdvancedSlots(current => !current)}
          className="flex items-center justify-between w-full py-1 text-xs font-bold text-stone-700 hover:text-stone-900"
        >
          <span>Personalizzazione avanzata singole fasce</span>
          {showAdvancedSlots ? <ChevronUp className="w-4 h-4 text-stone-500" /> : <ChevronDown className="w-4 h-4 text-stone-500" />}
        </button>
        {showAdvancedSlots && (
          <div className="mt-2 space-y-2 max-h-56 overflow-y-auto pr-1">
            <p className="text-[11px] text-stone-500 mb-2">
              Modificando una singola ora passerai in modalità personalizzata per gestire intervalli o orari non uniformi.
            </p>
            {slots.map((slot, index) => (
              <div
                key={slot.periodNumber}
                className={`flex items-center gap-2 p-2 rounded-lg border ${mode === "custom" && index >= confirmedSlotCount ? "bg-amber-50 border-amber-300" : "bg-stone-50 border-stone-200"}`}
              >
                <span className="w-16 font-bold text-stone-700 shrink-0">
                  {slot.periodNumber}ª Ora
                  {mode === "custom" && index >= confirmedSlotCount && (
                    <span className="block text-[9px] font-bold text-amber-700 uppercase tracking-wide">Da verificare</span>
                  )}
                </span>
                <input
                  aria-label={`Inizio ${slot.periodNumber}ª ora (${context})`}
                  type="time"
                  value={slot.startTime}
                  onChange={(e) => setCustomSlots(slots.map((current, itemIndex) => itemIndex === index ? { ...current, startTime: e.target.value } : current))}
                  className="p-1.5 border border-stone-300 rounded text-xs font-mono bg-white w-24"
                />
                <span className="text-stone-400">–</span>
                <input
                  aria-label={`Fine ${slot.periodNumber}ª ora (${context})`}
                  type="time"
                  value={slot.endTime}
                  onChange={(e) => setCustomSlots(slots.map((current, itemIndex) => itemIndex === index ? { ...current, endTime: e.target.value } : current))}
                  className="p-1.5 border border-stone-300 rounded text-xs font-mono bg-white w-24"
                />
                <button
                  type="button"
                  onClick={() => setCustomSlots(slots.filter((_, itemIndex) => itemIndex !== index).map((current, itemIndex) => ({ ...current, periodNumber: itemIndex + 1, label: `${itemIndex + 1}ª Ora` })))}
                  className="p-1 text-stone-400 hover:text-rose-600 ml-auto"
                  title="Rimuovi questa ora"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setCustomSlots(resizePeriodSlotsDraft(slots, slots.length + 1, periodDuration))}
              className="inline-flex items-center text-xs font-semibold text-emerald-700 hover:text-emerald-800 p-1"
            >
              <Plus className="w-3.5 h-3.5 mr-1" />
              Aggiungi ulteriore ora
            </button>
          </div>
        )}
      </div>

      <div className="bg-emerald-50/50 rounded-xl p-3 border border-emerald-200 text-xs">
        <span className="font-bold text-emerald-950 block mb-1">
          Anteprima scansione oraria ({slots.length} {slots.length === 1 ? "ora" : "ore"}):
        </span>
        <div className="flex flex-wrap gap-1.5">
          {slots.map((slot) => (
            <span key={slot.periodNumber} className="px-2 py-0.5 bg-white border border-emerald-300 text-emerald-900 rounded font-medium text-[11px]">
              {slot.periodNumber}ª: {slot.startTime}–{slot.endTime}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
};
