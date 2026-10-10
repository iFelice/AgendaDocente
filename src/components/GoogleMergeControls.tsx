import React, { createContext, useContext } from "react";
import type { CalendarEvent } from "../types";

/**
 * Richiesta di unione condivisa dalle viste: ogni vista chiama `requestMerge(a, b)` e App
 * decide ruoli, anteprima e persistenza. Il default non fa nulla (viste montate da sole).
 */
export type RequestEventMerge = (first: CalendarEvent, second: CalendarEvent) => void;

export const EventMergeContext = createContext<RequestEventMerge>(() => {});

export function useRequestEventMerge(): RequestEventMerge {
  return useContext(EventMergeContext);
}

/** Etichetta "Google Calendar" (impegni importati e impegni dell'app collegati/uniti). */
export const GOOGLE_CALENDAR_LABEL = "Google Calendar";

export const GoogleCalendarBadge: React.FC<{ variant?: "pill" | "compact" }> = ({ variant = "pill" }) => {
  if (variant === "compact") {
    return (
      <div data-google-calendar-label className="flex items-center space-x-1 text-[10px] text-blue-800 font-medium truncate">
        <span className="truncate">{GOOGLE_CALENDAR_LABEL}</span>
      </div>
    );
  }
  return (
    <span data-google-calendar-label className="text-[11px] px-2 py-0.5 rounded-md font-normal bg-blue-50 text-blue-800 border border-blue-200 whitespace-nowrap">
      {GOOGLE_CALENDAR_LABEL}
    </span>
  );
};

/**
 * Avviso compatto sulle due schede di una coppia. Il pulsante "Unisci" è dentro una vista
 * che può essere cliccabile: il click non deve aprire anche la modifica.
 */
export const PossibleDuplicateNotice: React.FC<{
  event: CalendarEvent;
  partner: CalendarEvent;
  className?: string;
}> = ({ event, partner, className = "" }) => {
  const requestMerge = useRequestEventMerge();
  return (
    <div
      data-possible-duplicate
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 ${className}`}
    >
      <span className="font-semibold">Possibile doppione</span>
      <span aria-hidden="true" className="text-amber-700">·</span>
      <button
        type="button"
        onClick={(click) => {
          click.preventDefault();
          click.stopPropagation();
          requestMerge(event, partner);
        }}
        className="min-h-[32px] font-bold underline underline-offset-2 hover:text-amber-950"
      >
        Unisci
      </button>
    </div>
  );
};
