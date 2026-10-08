import React from "react";
import { CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Circle, ListTodo, MapPin, Plus, Users } from "lucide-react";
import type { CalendarEvent, Student, StudentScheduledAssessment } from "../types";
import { civilDayOfWeek, formatCivilDateIt, isValidDate, localDateISO, parseCivilDate } from "../utils/dates";
import { isRelevanceReasonText } from "../utils/circularRelevance";
import {
  deriveArchiveCommitments,
  deriveFutureCommitments,
  groupFutureCommitments,
  splitFutureCommitmentsBySchoolYearEnd,
  FUTURE_COMMITMENT_SOURCE_LABELS,
  type FutureCommitmentItem,
  type FutureCommitmentSource,
} from "../utils/futureCommitments";
import { getSchoolYearBoundaries } from "../utils/schoolYear";

/**
 * "Note e impegni": proiezione read-only degli impegni operativi, con Archivio
 * consultabile a scomparsa. Non è un secondo calendario e non possiede archivi
 * propri: tutto è derivato da `events` + `scheduledAssessments`.
 */

export interface FutureCommitmentsViewProps {
  events: CalendarEvent[];
  scheduledAssessments: StudentScheduledAssessment[];
  students: Student[];
  /** Gli impegni normali continuano ad aprire l'EventModal esistente. */
  onEditEvent?: (event: CalendarEvent) => void;
  /** Le note rapide aprono sempre il loro editor rapido, anche dall'Archivio. */
  onEditNote?: (event: CalendarEvent) => void;
  /** App possiede il singolo QuickNoteModal e apre la modalità creazione. */
  onCreateNote?: () => void;
  /** Riusa il flusso esistente `storage.toggleEventCompleted`. */
  onToggleComplete?: (id: string) => void | Promise<void | false> | false;
  todayIso?: string;
  /**
   * Anno scolastico del profilo ("AAAA/AAAA"). L'elenco mostra solo gli impegni fino al
   * 31 agosto di quell'anno: quelli oltre restano salvati (viste calendario) e qui sono
   * riassunti in fondo da un solo conteggio. Mancante o non valido ⇒ anno corrente.
   */
  schoolYear?: string;
}

const SOURCE_BADGE_CLASS: Record<FutureCommitmentSource, string> = {
  agenda: "bg-emerald-100 text-emerald-800 border-emerald-300",
  circolare: "bg-amber-100 text-amber-800 border-amber-300",
  verifica: "bg-sky-100 text-sky-800 border-sky-300",
  google: "bg-blue-100 text-blue-800 border-blue-300",
  registro: "bg-violet-100 text-violet-800 border-violet-300",
  nota: "bg-indigo-100 text-indigo-800 border-indigo-300",
};

const WEEKDAY_ABBREVIATIONS_IT = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"] as const;

const CommitmentRow: React.FC<{
  item: FutureCommitmentItem;
  todayIso: string;
  onEditEvent?: (event: CalendarEvent) => void;
  onEditNote?: (event: CalendarEvent) => void;
  onToggleComplete?: (id: string) => void | Promise<void | false> | false;
}> = ({ item, todayIso, onEditEvent, onEditNote, onToggleComplete }) => {
  const editCallback = item.source === "nota" ? onEditNote : onEditEvent;
  const clickable = item.kind === "calendar-event" && !!editCallback && !!item.originalEvent;
  // Il completamento è offerto sulle note personali: restano CalendarEvent con `completed`.
  const completable = item.kind === "calendar-event" && item.source === "nota" && !!onToggleComplete && !!item.originalEvent;
  const event = item.originalEvent;
  const startTime = event?.startTime || item.startTime;
  const timeLabel = event?.isAllDay || !startTime
    ? "Tutto il giorno"
    : event?.endTime ? `${startTime}–${event.endTime}` : startTime;
  const [year, month, day] = item.date.split("-");
  const dateLabel = year === todayIso.slice(0, 4) ? `${day}/${month}` : `${day}/${month}/${year}`;
  const weekdayLabel = WEEKDAY_ABBREVIATIONS_IT[civilDayOfWeek(item.date)];
  const hideRelevanceReason = event?.sourceType === "circolare"
    && !!item.details
    && isRelevanceReasonText(item.details);
  const content = (
    <div data-commitment-row-content className="flex w-full min-w-0 items-start gap-2">
      <div data-commitment-date className="w-[4.5rem] shrink-0 pt-0.5 text-[11px] font-semibold leading-4 text-stone-700 tabular-nums">
        <span className="block">{weekdayLabel}</span>
        <span className="block whitespace-nowrap">{dateLabel}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          <div data-commitment-title className="min-w-0 flex-1 truncate font-medium text-stone-900">{item.title}</div>
          <span
            className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${SOURCE_BADGE_CLASS[item.source]}`}
          >
            {FUTURE_COMMITMENT_SOURCE_LABELS[item.source]}
          </span>
        </div>
        <div data-commitment-details-row className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-600">
          <span data-commitment-time className="shrink-0 whitespace-nowrap font-medium tabular-nums">{timeLabel}</span>
          {item.className && (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
              <Users className="h-3 w-3 shrink-0" />
              {item.className}
            </span>
          )}
          {item.subject && <span>{item.subject}</span>}
          {item.location && (
            <span className="inline-flex min-w-0 max-w-full items-start gap-1 break-words">
              <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{item.location}</span>
            </span>
          )}
        </div>
        {item.details && !hideRelevanceReason && (
          <div data-commitment-notes className="mt-1 text-xs text-stone-500 line-clamp-2">{item.details}</div>
        )}
      </div>
    </div>
  );

  const rowClass = `${completable ? "flex-1 min-w-0" : "w-full"} px-3 py-3 rounded-xl border border-stone-200 bg-white`;
  const row = clickable ? (
    <button
      type="button"
      data-commitment-id={item.id}
      onClick={() => editCallback!(item.originalEvent!)}
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
  onEditNote,
  onCreateNote,
  onToggleComplete,
  todayIso = localDateISO(),
  schoolYear,
}) => {
  const [showArchive, setShowArchive] = React.useState(false);
  // Confini dell'anno scolastico del profilo (unica fonte: `getSchoolYearBoundaries`).
  // Il riferimento temporale è il "oggi" della vista, così il fallback sull'anno corrente
  // resta deterministico rispetto a `todayIso`.
  const schoolYearEnd = getSchoolYearBoundaries(
    schoolYear,
    isValidDate(todayIso) ? parseCivilDate(todayIso) : new Date(),
  ).end;
  const items = deriveFutureCommitments({ events, scheduledAssessments, students, todayIso });
  const { withinSchoolYear, beyondSchoolYear } = splitFutureCommitmentsBySchoolYearEnd(items, schoolYearEnd);
  const groups = groupFutureCommitments(withinSchoolYear, todayIso);
  const archiveItems = deriveArchiveCommitments({ events, scheduledAssessments, students, todayIso });

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
            onClick={onCreateNote}
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
                <CommitmentRow key={item.id} item={item} todayIso={todayIso} onEditEvent={onEditEvent} onEditNote={onEditNote} onToggleComplete={onToggleComplete} />
              ))}
            </div>
          </section>
        ))
      )}

      {beyondSchoolYear.length > 0 && (
        /* Riga discreta, senza elencarli: gli impegni oltre il 31 agosto restano salvati
           e visibili nelle viste calendario, qui non sporcano l'elenco operativo. */
        <p
          data-commitments-beyond-school-year={schoolYearEnd}
          data-commitments-beyond-count={beyondSchoolYear.length}
          className="px-3 text-xs text-stone-500"
        >
          {beyondSchoolYear.length === 1
            ? `1 impegno oltre il ${formatCivilDateIt(schoolYearEnd)}`
            : `${beyondSchoolYear.length} impegni oltre il ${formatCivilDateIt(schoolYearEnd)}`}
        </p>
      )}

      {archiveItems.length > 0 && (
        <section data-archive-commitments data-past-commitments className="border-t border-stone-200 pt-3">
          <button
            type="button"
            data-archive-commitments-toggle
            data-past-commitments-toggle
            aria-expanded={showArchive}
            aria-controls="archive-commitments-list"
            onClick={() => setShowArchive(current => !current)}
            className="flex min-h-[48px] w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm font-semibold text-stone-700 hover:bg-stone-100 active:bg-stone-200 transition-colors"
          >
            <span className="inline-flex items-center gap-2">
              {showArchive ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Archivio note e impegni ({archiveItems.length})
            </span>
            <span className="text-xs font-medium text-stone-500">{showArchive ? "Nascondi" : "Mostra"}</span>
          </button>

          {showArchive && (
            <div id="archive-commitments-list" data-archive-commitments-list data-past-commitments-list className="mt-2 space-y-2">
              {archiveItems.map(item => (
                <CommitmentRow key={item.id} item={item} todayIso={todayIso} onEditEvent={onEditEvent} onEditNote={onEditNote} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
