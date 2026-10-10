import React, { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { CalendarEvent, EventCategory } from "../types";
import { mergeFieldValue, planMerge, type MergeChoice, type MergeChoices } from "../utils/googleCalendarMerge";
import { GOOGLE_CALENDAR_LABEL } from "./GoogleMergeControls";

/**
 * Anteprima dell'unione (D). Mostra SOLO le scelte da fare e il risultato: i campi uguali
 * o vuoti non compaiono come scelta. Su 375 px tutto è in colonna, con aree di tocco da 44 px.
 */

interface EventMergeModalProps {
  base: CalendarEvent;
  other: CalendarEvent;
  categoryLabel: (category: EventCategory) => string;
  onCancel: () => void;
  onConfirm: (merged: CalendarEvent) => void;
}

const sourceName = (event: CalendarEvent): string =>
  event.sourceType === "circolare" ? "Circolare" : event.sourceType === "google_calendar" ? GOOGLE_CALENDAR_LABEL : "Agenda";

const OPTION_BASE = "min-h-[44px] w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors";

export const EventMergeModal: React.FC<EventMergeModalProps> = ({ base, other, categoryLabel, onCancel, onConfirm }) => {
  const [choices, setChoices] = useState<MergeChoices>({});
  const plan = useMemo(() => planMerge(base, other, choices, categoryLabel), [base, other, choices, categoryLabel]);

  const choose = (field: keyof MergeChoices, choice: MergeChoice) =>
    setChoices(previous => ({ ...previous, [field]: choice }));

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-stone-900/40 p-0 sm:p-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-merge-title"
        data-event-merge-modal
        className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white shadow-2xl border border-stone-200 p-4 sm:p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id="event-merge-title" className="text-base font-bold text-stone-900">Unisci impegni</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Chiudi"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-md text-stone-500 hover:bg-stone-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-2 text-xs text-stone-700">
          <div data-merge-base className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 min-w-0">
            <div className="font-semibold text-stone-500 uppercase tracking-wide text-[10px]">Resta nell’app · {sourceName(base)}</div>
            <div className="font-semibold text-stone-900 break-words">{base.title}</div>
            <div className="tabular-nums">{mergeFieldValue(base, "timing") ?? "Orario non indicato"}</div>
          </div>
          <div data-merge-other className="rounded-lg border border-blue-200 bg-blue-50/60 px-3 py-2 min-w-0">
            <div className="font-semibold text-blue-800 uppercase tracking-wide text-[10px]">{GOOGLE_CALENDAR_LABEL} · rimosso dall’app</div>
            <div className="font-semibold text-stone-900 break-words">{other.title}</div>
            <div className="tabular-nums">{mergeFieldValue(other, "timing") ?? "Orario non indicato"}</div>
          </div>
        </div>

        {plan.fields.length > 0 ? (
          <section aria-label="Scelte da fare" className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wide text-stone-500">Da scegliere</h3>
            {plan.fields.map(field => {
              const options: { id: MergeChoice; label: string; value: string }[] = [
                { id: "base", label: sourceName(base), value: field.baseValue ?? "" },
                { id: "other", label: GOOGLE_CALENDAR_LABEL, value: field.otherValue ?? "" },
              ];
              if (field.allowBoth) options.push({ id: "both", label: "Tieni entrambe", value: "Le due note, una sotto l’altra" });
              const selected = choices[field.field as keyof MergeChoices] ?? field.defaultChoice;
              return (
                <fieldset key={field.field} data-merge-field={field.field} className="min-w-0">
                  <legend className="text-sm font-semibold text-stone-900 mb-1.5">{field.label}</legend>
                  <div role="radiogroup" aria-label={field.label} className="space-y-1.5">
                    {options.map(option => {
                      const active = selected === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          data-merge-option={option.id}
                          onClick={() => choose(field.field as keyof MergeChoices, option.id)}
                          className={`${OPTION_BASE} ${active ? "border-blue-600 bg-blue-50 text-blue-950 font-semibold" : "border-stone-300 bg-white text-stone-800 hover:bg-stone-50"}`}
                        >
                          <span className="block text-[10px] uppercase tracking-wide text-stone-500">{option.label}</span>
                          <span className="block break-words whitespace-pre-line">{option.value}</span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
          </section>
        ) : (
          <p className="text-xs text-stone-600">Nessun campo da scegliere: i valori coincidono o si completano da soli.</p>
        )}

        <section aria-label="Risultato" data-merge-summary className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 space-y-1">
          <h3 className="text-xs font-bold uppercase tracking-wide text-emerald-900">Risultato</h3>
          <dl className="text-xs text-stone-800 space-y-1">
            {plan.summary.map(line => (
              <div key={line.field} className="flex flex-col sm:flex-row sm:gap-2 min-w-0">
                <dt className="font-semibold shrink-0 sm:w-36">{line.label}:</dt>
                <dd className="min-w-0 break-words whitespace-pre-line">{line.value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[11px] text-stone-600 pt-1">Google Calendar non viene modificato: l’impegno importato sparisce solo dall’app.</p>
        </section>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
          <button type="button" onClick={onCancel} className="min-h-[44px] rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50">
            Annulla
          </button>
          <button
            type="button"
            onClick={() => onConfirm(plan.merged)}
            className="min-h-[44px] rounded-lg bg-blue-700 px-4 py-2 text-sm font-bold text-white hover:bg-blue-800"
          >
            Conferma unione
          </button>
        </div>
      </div>
    </div>
  );
};
