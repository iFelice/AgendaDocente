import React from "react";
import { CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Circle, ListTodo, MapPin, Plus, Users } from "lucide-react";
import type { CalendarEvent, Student, StudentScheduledAssessment } from "../types";
import { formatCivilDateIt, localDateISO } from "../utils/dates";
import { QuickNoteModal } from "./QuickNoteModal";
import {
  deriveFutureCommitments,
  derivePastCommitments,
  groupFutureCommitments,
  FUTURE_COMMITMENT_SOURCE_LABELS,
  type FutureCommitmentItem,
  type FutureCommitmentSource,
} from "../utils/futureCommitments";

/**
 * "Note e impegni": proiezione read-only degli impegni operativi, con storico
 * consultabile a scomparsa. Non è un secondo calendario e non possiede archivi
 * propri: tutto è derivato da `events` + `scheduledAssessments`.
 */

export interface FutureCommitmentsViewProps {
  events: CalendarEvent[];
  scheduledAssessments: StudentScheduledAssessment[];
  students: Student[];
  /** Solo per i CalendarEvent: riusa l'EventModal esistente, nessuna seconda UI di modifica. */
  onEditEvent?: (event: CalendarEvent) => void;
  /** N2: salvataggio della nota rapida; la persistenza resta in App (`storage.saveEvent`). */
  onCreateNote?: (event: CalendarEvent) => void | false | Promise<void | false>;
  /** N2: riusa il flusso esistente `storage.toggleEventCompleted`. */
  onToggleComplete?: (id: string) => void | Promise<void | false> | false;
  /** Classi del profilo per la select opzionale della nota rapida. */
  classes?: string[];
  todayIso?: string;
}

const SOURCE_BADGE_CLASS: Record<FutureCommitmentSource, string> = {
  agenda: "bg-emerald-100 text-emerald-800 border-emerald-300",
  circolare: "bg-amber-100 text-amber-800 border-amber-300",
  verifica: "bg-sky-100 text-sky-800 border-sky-300",
  google: "bg-blue-100 text-blue-800 border-blue-300",
  registro: "bg-violet-100 text-violet-800 border-violet-300",
  nota: "bg-indigo-100 text-indigo-800 border-indigo-300",
};

const CommitmentRow: React.FC<{
  item: FutureCommitmentItem;
  onEditEvent?: (event: CalendarEvent) => void;
  onToggleComplete?: (id: string) => void | Promise<void | false> | false;
}> = ({ item, onEditEvent, onToggleComplete }) => {
  const clickable = item.kind === "calendar-event" && !!onEditEvent && !!item.originalEvent;
  // Il completamento è offerto sulle note personali: restano CalendarEvent con `completed`.
  const completable = item.kind === "calendar-event" && item.source === "nota" && !!onToggleComplete && !!item.originalEvent;
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

  const rowClass = `${completable ? "flex-1 min-w-0" : "w-full"} px-3 py-3 rounded-xl border border-stone-200 bg-white`;
  const row = clickable ? (
    <button
      type="button"
      data-commitment-id={item.id}
      onClick={() => onEditEvent!(item.originalEvent!)}
      className={`${rowClass} text-left hover:bg-stone-50 transition-colors`}
    >
      {content}
    </button>
  ) : (
    <div data-commitment-id={item.id} className={rowClass}>
      {content}
    </div>
  );

  if (!completable) return row;

  return (
    <div className="flex items-start gap-2">
      <button
        type="button"
        data-commitment-toggle={item.id}
        aria-pressed={!!item.completed}
        aria-label={item.completed ? `Segna come da fare: ${item.title}` : `Segna come completata: ${item.title}`}
        title={item.completed ? "Segna come da fare" : "Segna come completata"}
        onClick={() => onToggleComplete!(item.originalEvent!.id)}
        className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-400 hover:text-emerald-700 hover:bg-emerald-50 transition-colors"
      >
        {item.completed ? <CheckCircle2 className="h-5 w-5 text-emerald-700" /> : <Circle className="h-5 w-5" />}
      </button>
      {row}
    </div>
  );
};

export const FutureCommitmentsView: React.FC<FutureCommitmentsViewProps> = ({
  events,
  scheduledAssessments,
  students,
  onEditEvent,
  onCreateNote,
  onToggleComplete,
  classes = [],
  todayIso = localDateISO(),
}) => {
  const [showPast, setShowPast] = React.useState(false);
  const [isQuickNoteOpen, setIsQuickNoteOpen] = React.useState(false);
  const items = deriveFutureCommitments({ events, scheduledAssessments, students, todayIso });
  const groups = groupFutureCommitments(items, todayIso);
  const pastItems = derivePastCommitments({ events, scheduledAssessments, students, todayIso });

  return (
    <div className="space-y-6" data-view="impegni">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-700 text-white flex items-center justify-center shrink-0">
            <ListTodo className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-stone-900">Note e impegni</h2>
            <p className="text-sm text-stone-600">Tutto ciò che devi ricordare nei prossimi giorni, in un unico posto.</p>
          </div>
        </div>
        {onCreateNote && (
          <button
            type="button"
            data-new-note-button
            onClick={() => setIsQuickNoteOpen(true)}
            className="inline-flex min-h-[44px] w-full sm:w-auto shrink-0 items-center justify-center gap-1.5 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 active:bg-emerald-900 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Nuova nota
          </button>
        )}
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
                <CommitmentRow key={item.id} item={item} onEditEvent={onEditEvent} onToggleComplete={onToggleComplete} />
              ))}
            </div>
          </section>
        ))
      )}

      {pastItems.length > 0 && (
        <section data-past-commitments className="border-t border-stone-200 pt-3">
          <button
            type="button"
            data-past-commitments-toggle
            aria-expanded={showPast}
            aria-controls="past-commitments-list"
            onClick={() => setShowPast(current => !current)}
            className="flex min-h-[48px] w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm font-semibold text-stone-700 hover:bg-stone-100 active:bg-stone-200 transition-colors"
          >
            <span className="inline-flex items-center gap-2">
              {showPast ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Note e impegni passati ({pastItems.length})
            </span>
            <span className="text-xs font-medium text-stone-500">{showPast ? "Nascondi" : "Mostra"}</span>
          </button>

          {showPast && (
            <div id="past-commitments-list" data-past-commitments-list className="mt-2 space-y-2">
              {pastItems.map(item => (
                <CommitmentRow key={item.id} item={item} onEditEvent={onEditEvent} />
              ))}
            </div>
          )}
        </section>
      )}

      {onCreateNote && (
        <QuickNoteModal
          isOpen={isQuickNoteOpen}
          onClose={() => setIsQuickNoteOpen(false)}
          onSave={onCreateNote}
          classes={classes}
          todayIso={todayIso}
        />
      )}
    </div>
  );
};
