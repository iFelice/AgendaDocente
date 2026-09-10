import { localDateISO } from "../utils/dates";
import React, { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock,
  Filter,
  MapPin,
  Plus,
  Trash2,
  Pencil,
} from "lucide-react";
import { CalendarEvent } from "../types";

interface DeadlinesViewProps {
  events: CalendarEvent[];
  onOpenNewEvent: (initialDate?: string) => void;
  onEditEvent: (event: CalendarEvent) => void;
  onDeleteEvent: (id: string) => void;
  onToggleComplete: (id: string) => void;
}

export const DeadlinesView: React.FC<DeadlinesViewProps> = ({
  events,
  onOpenNewEvent,
  onEditEvent,
  onDeleteEvent,
  onToggleComplete,
}) => {
  const [filter, setFilter] = useState<"pending" | "completed" | "all">("pending");
  const [confirmingDeleteEventId, setConfirmingDeleteEventId] = useState<string | null>(null);

  const todayIso = localDateISO();

  // Filter deadlines, PEI commitments, and reminders
  const allDeadlines = events.filter(
    (e) => e.category === "scadenza" || e.category === "promemoria" || e.category === "pei"
  );

  const filteredDeadlines = allDeadlines
    .filter((e) => {
      if (filter === "pending") return !e.completed;
      if (filter === "completed") return !!e.completed;
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const getUrgencyBadge = (dateIso: string, completed?: boolean) => {
    if (completed) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          Completata
        </span>
      );
    }

    const today = new Date(todayIso + "T00:00:00");
    const target = new Date(dateIso + "T00:00:00");
    const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800">
          <AlertTriangle className="w-3 h-3 mr-1" />
          Scaduta da {Math.abs(diffDays)} gg
        </span>
      );
    } else if (diffDays === 0) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-900 animate-pulse">
          <Clock className="w-3 h-3 mr-1" />
          Scade OGGI!
        </span>
      );
    } else if (diffDays === 1) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
          Scade domani
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-stone-100 text-stone-700">
          Tra {diffDays} giorni
        </span>
      );
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="bg-white rounded-xl p-5 border border-stone-200 shadow-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <span className="text-xs font-semibold text-rose-800 uppercase tracking-wider">
            Scadenziario & Adempimenti Docente
          </span>
          <h1 className="text-2xl font-bold text-stone-900 mt-0.5">Scadenze e Promemoria</h1>
          <p className="text-sm text-stone-500 mt-1">
            Gestisci consegne verbali, programmazioni didattiche, registri, adozioni libri e promemoria personali.
          </p>
        </div>

        <button
          onClick={() => onOpenNewEvent()}
          className="inline-flex items-center px-4 py-2.5 rounded-lg text-sm font-medium bg-rose-700 hover:bg-rose-800 text-white transition-colors shadow-xs self-start sm:self-auto"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Nuova Scadenza
        </button>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center space-x-2 bg-stone-100 p-1 rounded-xl w-fit">
        <button
          onClick={() => setFilter("pending")}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            filter === "pending"
              ? "bg-white text-stone-900 shadow-xs"
              : "text-stone-600 hover:text-stone-900"
          }`}
        >
          In Sospeso ({allDeadlines.filter((d) => !d.completed).length})
        </button>
        <button
          onClick={() => setFilter("completed")}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            filter === "completed"
              ? "bg-white text-stone-900 shadow-xs"
              : "text-stone-600 hover:text-stone-900"
          }`}
        >
          Completate ({allDeadlines.filter((d) => d.completed).length})
        </button>
        <button
          onClick={() => setFilter("all")}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            filter === "all"
              ? "bg-white text-stone-900 shadow-xs"
              : "text-stone-600 hover:text-stone-900"
          }`}
        >
          Tutte ({allDeadlines.length})
        </button>
      </div>

      {/* Deadlines List */}
      <div className="bg-white rounded-xl border border-stone-200 shadow-xs divide-y divide-stone-100 overflow-hidden">
        {filteredDeadlines.length === 0 ? (
          /* Empty section: one compact row instead of a large empty block. */
          <div className="px-3 sm:px-4 py-3 flex items-center justify-between gap-2">
            <p className="text-xs text-stone-500 min-w-0 truncate">
              Nessuna scadenza in questa sezione
            </p>
            <button
              type="button"
              onClick={() => onOpenNewEvent()}
              className="shrink-0 inline-flex items-center gap-1 min-h-[40px] px-3 rounded-lg text-xs font-semibold text-rose-800 bg-rose-50 hover:bg-rose-100 border border-rose-200"
            >
              <Plus className="w-3.5 h-3.5" />
              Aggiungi
            </button>
          </div>
        ) : (
          filteredDeadlines.map((item) => (
            <div
              key={item.id}
              className={`p-4 flex items-start justify-between gap-4 hover:bg-stone-50/70 transition-colors ${
                item.completed ? "opacity-60 bg-stone-50/40" : ""
              }`}
            >
              <div className="flex items-start space-x-3 flex-1">
                <button
                  onClick={() => onToggleComplete(item.id)}
                  className="mt-0.5 text-stone-400 hover:text-emerald-600 transition-colors"
                  title={item.completed ? "Segna come da fare" : "Segna come completata"}
                >
                  {item.completed ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <Circle className="w-5 h-5 text-stone-400" />
                  )}
                </button>

                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-sm font-semibold ${
                        item.completed ? "line-through text-stone-500" : "text-stone-900"
                      }`}
                    >
                      {item.title}
                    </span>
                    {getUrgencyBadge(item.date, item.completed)}
                    {item.category === "pei" && (
                      <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                        Inclusione / PEI
                      </span>
                    )}
                    {item.sourceCircularTitle && (
                      <span className="text-[10px] px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200">
                        {item.sourceCircularTitle}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-4 text-xs text-stone-500">
                    <div className="flex items-center space-x-1">
                      <Clock className="w-3.5 h-3.5 text-stone-400" />
                      <span>Data limite: {item.date} {item.startTime && `ore ${item.startTime}`}</span>
                    </div>
                    {item.location && (
                      <div className="flex items-center space-x-1">
                        <MapPin className="w-3.5 h-3.5 text-stone-400" />
                        <span>{item.location}</span>
                      </div>
                    )}
                  </div>

                  {item.notes && (
                    <p className="text-xs text-stone-600 bg-stone-100/60 p-2 rounded-md max-w-2xl mt-1">
                      {item.notes}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-1">
                <button
                  onClick={() => onEditEvent(item)}
                  className="p-1.5 rounded-md text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
                  title="Modifica"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                {confirmingDeleteEventId === item.id ? (
                  <div className="flex items-center space-x-1 bg-rose-50 border border-rose-300 px-2 py-0.5 rounded-lg text-xs">
                    <span className="text-[11px] font-bold text-rose-800">Elimina?</span>
                    <button
                      type="button"
                      onClick={() => {
                        onDeleteEvent(item.id);
                        setConfirmingDeleteEventId(null);
                      }}
                      className="px-2 py-0.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded text-xs transition-colors"
                    >
                      Sì
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDeleteEventId(null)}
                      className="px-1 text-stone-600 hover:text-stone-900 text-xs"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingDeleteEventId(item.id)}
                    className="p-1.5 rounded-md text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                    title="Elimina"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
