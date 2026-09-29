import React, { useState } from "react";
import { CalendarClock } from "lucide-react";
import type { SchoolDayPeriodsConfig, SchoolWeekday, TimeSlotConfig } from "../types";
import { MAX_PERIODS_PER_DAY, ordinaryPeriodsPerDay, periodsByDay } from "../utils/schoolDayPeriods";

/**
 * STRUTTURA DELLA GIORNATA SCOLASTICA di UN istituto.
 *
 * Risponde a "quante ore prevede la scuola in ciascun giorno", NON a "quante
 * ore lavora il docente": `weeklyDeclaredHours` e `weeklyHours` non entrano qui
 * né come valore iniziale né come vincolo. Un istituto può avere 7 ore il
 * giovedì anche se quel giorno il docente ne fa 4.
 *
 * Componente controllato e riutilizzabile: lo stesso editor serve l'istituto
 * principale e il secondo istituto, che restano configurazioni indipendenti.
 * Nessun calcolo proprio: ordinario, ore per giorno e riepilogo arrivano tutti
 * dalle utility di src/utils/schoolDayPeriods.ts.
 */

/** Giorni mostrati di default: la settimana scolastica lunedì-venerdì.
 *  Il sabato NON è incluso: oggi l'app non ha un'impostazione affidabile e
 *  condivisa di "scuola aperta il sabato" (TimetableEditor e WeekView la
 *  deducono localmente dal grado scolastico), e questo passo non ne inventa una. */
export const DEFAULT_SCHOOL_DAYS: SchoolWeekday[] = [1, 2, 3, 4, 5];

const DAY_LABELS: Record<SchoolWeekday, string> = {
  1: "Lun", 2: "Mar", 3: "Mer", 4: "Gio", 5: "Ven", 6: "Sab",
};
const DAY_FULL_LABELS: Record<SchoolWeekday, string> = {
  1: "lunedì", 2: "martedì", 3: "mercoledì", 4: "giovedì", 5: "venerdì", 6: "sabato",
};

/**
 * Ore aggiuntive selezionabili DALLA UI in questo passo: +0, +1, +2.
 * Il modello dati resta generalizzabile (extraPeriodsByDay accetta di più e le
 * utility clampano a 12): è solo l'interfaccia a non offrire ancora il +3.
 */
export const UI_EXTRA_CHOICES = [0, 1, 2] as const;

/** Almeno una deroga effettiva salvata: decide se il pannello giorni parte aperto. */
export function hasConfiguredExtras(value?: SchoolDayPeriodsConfig): boolean {
  return Object.values(value?.extraPeriodsByDay ?? {}).some(n => typeof n === "number" && n > 0);
}

export interface SchoolDayPeriodsEditorProps {
  /** Configurazione salvata dell'istituto (assente = mai configurata). */
  value?: SchoolDayPeriodsConfig;
  /** Fasce orarie del docente: SOLO per dedurre l'ordinario legacy, mai per limitarlo. */
  timeSlotConfig?: TimeSlotConfig;
  onChange: (next: SchoolDayPeriodsConfig) => void;
  /** Distingue le etichette accessibili quando in pagina ci sono due editor. */
  context: string;
  days?: SchoolWeekday[];
}

export const SchoolDayPeriodsEditor: React.FC<SchoolDayPeriodsEditorProps> = ({
  value,
  timeSlotConfig,
  onChange,
  context,
  days = DEFAULT_SCHOOL_DAYS,
}) => {
  // Valore mostrato nel campo: quello salvato se c'è, altrimenti il LEGACY dedotto
  // dalle fasce orarie effettive (6 con la configurazione di default, 7 con una a 7
  // fasce). Nessun fallback riscritto a mano: è la stessa utility del resto dell'app.
  const ordinary = ordinaryPeriodsPerDay(value ? { dayPeriods: value } : undefined, timeSlotConfig);
  const [extrasEnabled, setExtrasEnabled] = useState<boolean>(() => hasConfiguredExtras(value));
  const [ordinaryInput, setOrdinaryInput] = useState<string>(() => String(ordinary));

  // Riepilogo e colori derivano dalla stessa utility che userà il resto dell'app:
  // qui non si somma nulla a mano.
  const effective = periodsByDay(days, { dayPeriods: { ...value, ordinaryPeriodsPerDay: ordinary } }, timeSlotConfig);

  const emit = (next: SchoolDayPeriodsConfig) => onChange(next);

  const handleOrdinary = (raw: string) => {
    setOrdinaryInput(raw);
    const parsed = Number(raw);
    if (!raw.trim() || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PERIODS_PER_DAY) return;
    emit({ ...value, ordinaryPeriodsPerDay: parsed });
  };
  // Un campo lasciato vuoto o fuori scala non salva un valore inventato: torna a mostrare
  // l'ordinario corrente (l'ultimo valido, oppure il legacy dedotto).
  const handleOrdinaryBlur = () => setOrdinaryInput(String(ordinary));

  const handleToggleExtras = (enabled: boolean) => {
    setExtrasEnabled(enabled);
    if (enabled) return; // accendere non cambia i dati: i giorni partono tutti a +0
    // Spegnere rimuove SOLO le deroghe: l'ordinario e ogni altro campo restano.
    const { extraPeriodsByDay: _dropped, ...rest } = { ...value, ordinaryPeriodsPerDay: ordinary };
    emit(rest);
  };

  const handleExtra = (day: SchoolWeekday, extra: number) => {
    const nextExtras = { ...(value?.extraPeriodsByDay ?? {}) };
    if (extra > 0) nextExtras[day] = extra;
    else delete nextExtras[day];
    const base = { ...value, ordinaryPeriodsPerDay: ordinary };
    if (Object.keys(nextExtras).length === 0) {
      const { extraPeriodsByDay: _dropped, ...rest } = base;
      emit(rest);
      return;
    }
    emit({ ...base, extraPeriodsByDay: nextExtras });
  };

  return (
    <div className="p-3.5 rounded-xl border border-stone-200 bg-white space-y-3" data-testid={`day-periods-${context}`}>
      <div className="flex items-center space-x-2">
        <CalendarClock className="w-4 h-4 text-stone-700 shrink-0" />
        <span className="block font-bold text-stone-800 text-xs">Struttura giornata scolastica</span>
      </div>
      <p className="text-[11px] text-stone-600 leading-relaxed">
        Indica quante ore prevede normalmente la scuola. Puoi aggiungere ore solo nei giorni che fanno eccezione.
      </p>

      <div className="flex items-center gap-2">
        <label className="text-xs font-semibold text-stone-700 flex-1" htmlFor={`ordinary-periods-${context}`}>
          Ore ordinarie al giorno
        </label>
        <input
          id={`ordinary-periods-${context}`}
          aria-label={`Ore ordinarie al giorno (${context})`}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_PERIODS_PER_DAY}
          step={1}
          value={ordinaryInput}
          onChange={e => handleOrdinary(e.target.value)}
          onBlur={handleOrdinaryBlur}
          className="w-20 min-h-[44px] p-2.5 border border-stone-300 rounded-xl text-xs text-center"
        />
      </div>

      <label className="flex items-center gap-2 min-h-[44px] text-xs font-semibold text-stone-700 cursor-pointer">
        <input
          type="checkbox"
          aria-label={`Ci sono giorni con ore aggiuntive (${context})`}
          checked={extrasEnabled}
          onChange={e => handleToggleExtras(e.target.checked)}
          className="w-5 h-5 accent-amber-600"
        />
        Ci sono giorni con ore aggiuntive
      </label>

      {extrasEnabled && (
        <div className="space-y-1.5">
          {days.map(day => {
            const current = value?.extraPeriodsByDay?.[day] ?? 0;
            return (
              <div key={day} className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-xs font-semibold text-stone-700">{DAY_LABELS[day]}</span>
                <div className="flex gap-1.5 flex-1" role="group" aria-label={`Ore aggiuntive di ${DAY_FULL_LABELS[day]} (${context})`}>
                  {UI_EXTRA_CHOICES.map(choice => {
                    const selected = current === choice;
                    return (
                      <button
                        key={choice}
                        type="button"
                        aria-pressed={selected}
                        aria-label={`${DAY_FULL_LABELS[day]} piu ${choice} ore (${context})`}
                        onClick={() => handleExtra(day, choice)}
                        className={`flex-1 min-h-[44px] min-w-[44px] rounded-xl border text-xs font-semibold transition-colors ${
                          selected
                            ? choice === 0
                              ? "border-stone-400 bg-stone-200 text-stone-800"
                              : "border-amber-400 bg-amber-100 text-amber-900"
                            : "border-stone-200 bg-white text-stone-600"
                        }`}
                      >
                        +{choice}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div
        className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-stone-600"
        aria-label={`Riepilogo ore per giorno (${context})`}
      >
        {days.map((day, index) => {
          const hasExtra = effective[index] > ordinary;
          return (
            <React.Fragment key={day}>
              {index > 0 && <span className="text-stone-300">·</span>}
              <span className={hasExtra ? "font-bold text-amber-700" : "text-stone-600"}>
                {DAY_LABELS[day]} {effective[index]}
              </span>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
