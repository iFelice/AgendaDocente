import React from "react";
import { CalendarClock, ListTodo, MapPin, Users } from "lucide-react";
import type { CalendarEvent, Student, StudentScheduledAssessment } from "../types";
import { formatCivilDateIt, localDateISO } from "../utils/dates";
import {
  deriveFutureCommitments,
  groupFutureCommitments,
  FUTURE_COMMITMENT_SOURCE_LABELS,
  type FutureCommitmentItem,
  type FutureCommitmentSource,
} from "../utils/futureCommitments";

/**
 * "Note e impegni": proiezione read-only di tutto ciò che il docente deve
 * ricordare da oggi in avanti. Non è un secondo calendario e non possiede
 * archivi propri: tutto è derivato da `events` + `scheduledAssessments`.
 */

export interface FutureCommitmentsViewProps {
  events: CalendarEvent[];
  scheduledAssessments: StudentScheduledAssessment[];
  students: Student[];
  /** Solo per i CalendarEvent: riusa l'EventModal esistente, nessuna seconda UI di modifica. */
  onEditEvent?: (event: CalendarEvent) => void;
  todayIso?: string;
}

const SOURCE_BADGE_CLASS: Record<FutureCommitmentSource, string> = {
  agenda: "bg-emerald-100 text-emerald-800 border-emerald-300",
  circolare: "bg-amber-100 text-amber-800 border-amber-300",
  verifica: "bg-sky-100 text-sky-800 border-sky-300",
  google: "bg-blue-100 text-blue-800 border-blue-300",
  registro: "bg-violet-100 text-violet-800 border-violet-300",
};

const CommitmentRow: React.FC<{ item: FutureCommitmentItem; onEditEvent?: (event: CalendarEvent) => void }> = ({ item, onEditEvent }) => {
  const clickable = item.kind === "calendar-event" && !!onEditEvent && !!item.originalEvent;
  const content = (
    <div className="flex items-start gap-3 w-full">
      <div className="w-20 shrink-0 text-sm font-semibold text-stone-700 tabular-nums">
        {item.startTime || formatCivilDateIt(item.date).slice(0, 5)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-stone-900 truncate">{item.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-600">
          <span>{formatCivilDateIt(item.date)}</span>
          {item.className && (
            <span className="inline-flex items-center gap-1">
              <Users className="w-3 h-3" />
              {item.className}
            </span>
          )}
          {item.subject && <span>{item.subject}</span>}
          {item.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              {item.location}
            </span>
          )}
        </div>
        {item.details && <div className="mt-1 text-xs text-stone-500 line-clamp-2">{item.details}</div>}
      </div>
      <span
        className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${SOURCE_BADGE_CLASS[item.source]}`}
      >
        {FUTURE_COMMITMENT_SOURCE_LABELS[item.source]}
      </span>
    </div>
  );

  if (clickable) {
    return (
      <button
        type="button"
        data-commitment-id={item.id}
        onClick={() => onEditEvent!(item.originalEvent!)}
        className="w-full text-left px-3 py-3 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 transition-colors"
      >
        {content}
      </button>
    );
  }
  return (
    <div data-commitment-id={item.id} className="w-full px-3 py-3 rounded-xl border border-stone-200 bg-white">
      {content}
    </div>
  );
};

export const FutureCommitmentsView: React.FC<FutureCommitmentsViewProps> = ({
  events,
  scheduledAssessments,
  students,
  onEditEvent,
  todayIso = localDateISO(),
}) => {
  const items = deriveFutureCommitments({ events, scheduledAssessments, students, todayIso });
  const groups = groupFutureCommitments(items, todayIso);

  return (
    <div className="space-y-6" data-view="impegni">
      <header className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-emerald-700 text-white flex items-center justify-center shrink-0">
          <ListTodo className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-stone-900">Note e impegni</h2>
          <p className="text-sm text-stone-600">Tutto ciò che devi ricordare nei prossimi giorni, in un unico posto.</p>
        </div>
      </header>

      {groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white p-8 text-center">
          <CalendarClock className="w-8 h-8 mx-auto text-stone-400" />
          <p className="mt-2 text-sm text-stone-600">Nessun impegno in programma da oggi in avanti.</p>
        </div>
      ) : (
        groups.map(group => (
          <section key={group.id} data-commitment-group={group.id} className="space-y-2">
            <h3 className="text-sm font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200 pb-1">
              {group.label}
            </h3>
            <div className="space-y-2">
              {group.items.map(item => (
                <CommitmentRow key={item.id} item={item} onEditEvent={onEditEvent} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
};
