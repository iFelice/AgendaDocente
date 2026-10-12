import React from "react";
import { CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Circle, ListTodo, MapPin, Plus, Search, Users, X } from "lucide-react";
import type { CalendarEvent, EventCategory, Student, StudentScheduledAssessment } from "../types";
import { EVENT_CATEGORIES } from "./EventModal";
import { buildCommitmentSearchIndex, hasSearchableTerms, searchCommitments } from "../utils/commitmentSearch";
import { civilDayOfWeek, formatCivilDateIt, isValidDate, localDateISO, parseCivilDate } from "../utils/dates";
import { isRelevanceReasonText } from "../utils/circularRelevance";
import { getEventMeetingUrl } from "../utils/meetingLinks";
import { EventMeetingLink } from "./EventMeetingLink";
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
import { findPossibleDuplicates, showsGoogleCalendarLabel } from "../utils/googleCalendarMerge";
import { GOOGLE_CALENDAR_LABEL, PossibleDuplicateNotice } from "./GoogleMergeControls";

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

/**
 * Etichetta leggibile della tipologia per la ricerca: unica fonte EVENT_CATEGORIES.
 * Il modulo di ricerca (utils) non importa componenti React: l'etichetta arriva qui,
 * come parametro `categoryLabel`.
 */
const SEARCH_CATEGORY_LABEL = (category: EventCategory): string =>
  EVENT_CATEGORIES.find(item => item.id === category)?.label ?? category;

const CommitmentRow: React.FC<{
  item: FutureCommitmentItem;
  todayIso: string;
  /** Possibili doppioni Google ↔ app (per id), calcolati dalla vista. */
  duplicatePairs: Map<string, CalendarEvent>;
  onEditEvent?: (event: CalendarEvent) => void;
  onEditNote?: (event: CalendarEvent) => void;
  onToggleComplete?: (id: string) => void | Promise<void | false> | false;
}> = ({ item, todayIso, duplicatePairs, onEditEvent, onEditNote, onToggleComplete }) => {
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
          {/* Un impegno unito (es. circolare + Google) mostra entrambe le origini. */}
          {item.source !== "google" && event && showsGoogleCalendarLabel(event) && (
            <span data-commitment-google-label className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-blue-50 text-blue-800 border-blue-200">
              {GOOGLE_CALENDAR_LABEL}
            </span>
          )}
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

  // Il link si ricava qui e solo per la visualizzazione, con l'unica funzione usata da
  // tutte le viste (campo meetingUrl, poi luogo, poi note): nessun dato viene riscritto.
  // Vale anche per l'Archivio, che mostra gli stessi impegni già passati.
  const meetingUrl = getEventMeetingUrl(event);

  const rowClass = `${completable || meetingUrl ? "flex-1 min-w-0" : "w-full"} px-3 py-3 rounded-xl border border-stone-200 bg-white`;
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

  // Il link è un FRATELLO della riga, non un discendente: la riga tappabile è un
  // <button>, e un <a> dentro un <button> non è HTML valido (il tap sul link
  // finirebbe per aprire anche l'editor).
  // L'avviso di doppione è un FRATELLO della riga, come il link: la riga può essere un <button>.
  const partner = event ? duplicatePairs.get(event.id) : undefined;
  const duplicateNotice = event && partner
    ? <PossibleDuplicateNotice event={event} partner={partner} className="mt-1" />
    : null;

  if (!completable && !meetingUrl) return <>{row}{duplicateNotice}</>;

  return (
    <>
    <div className="flex items-start gap-2">
      {completable && (
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
      )}
      {row}
      {meetingUrl && <EventMeetingLink event={event} label={item.title} className="mt-0.5" />}
    </div>
    {duplicateNotice}
    </>
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
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  // Confini dell'anno scolastico del profilo (unica fonte: `getSchoolYearBoundaries`).
  // Il riferimento temporale è il "oggi" della vista, così il fallback sull'anno corrente
  // resta deterministico rispetto a `todayIso`.
  const schoolYearEnd = getSchoolYearBoundaries(
    schoolYear,
    isValidDate(todayIso) ? parseCivilDate(todayIso) : new Date(),
  ).end;
  // Derivazioni memoizzate: le liste cambiano solo quando cambiano le fonti, così anche
  // l'indice di ricerca sottostante resta stabile durante la digitazione.
  const items = React.useMemo(
    () => deriveFutureCommitments({ events, scheduledAssessments, students, todayIso }),
    [events, scheduledAssessments, students, todayIso],
  );
  const duplicatePairs = React.useMemo(() => findPossibleDuplicates(events), [events]);
  const { withinSchoolYear, beyondSchoolYear } = splitFutureCommitmentsBySchoolYearEnd(items, schoolYearEnd);
  const groups = groupFutureCommitments(withinSchoolYear, todayIso);
  const archiveItems = React.useMemo(
    () => deriveArchiveCommitments({ events, scheduledAssessments, students, todayIso }),
    [events, scheduledAssessments, students, todayIso],
  );
  // Fonti della ricerca: le stesse già usate dalla vista (impegni, compresi quelli
  // oltre il 31 agosto, e Archivio). Nessun'altra collezione, nessuna chiamata di rete.
  const searchItems = React.useMemo(() => [...items, ...archiveItems], [items, archiveItems]);
  // Testo normalizzato calcolato UNA volta per elenco (useMemo): a ogni battuta si filtra
  // un indice già pronto e la digitazione resta fluida con qualche migliaio di impegni.
  const searchIndex = React.useMemo(
    () => buildCommitmentSearchIndex(searchItems, SEARCH_CATEGORY_LABEL),
    [searchItems],
  );

  const trimmedQuery = searchQuery.trim();
  // La ricerca parte solo se la query ha almeno una parola utile (≥ 2 caratteri non
  // annientati da doppie, punteggiatura o spazi). Con meno di 2 caratteri la vista
  // resta identica a oggi; con almeno 2 caratteri ma nessuna parola utile (es. "aa",
  // "..", "c d") compare il suggerimento, mai l'intero elenco né un conteggio.
  const queryWritten = trimmedQuery.length >= 2;
  const queryHasTerms = hasSearchableTerms(trimmedQuery);
  const searchActive = searchOpen && queryWritten && queryHasTerms;
  const showSearchHint = searchOpen && queryWritten && !queryHasTerms;
  const searchResult = React.useMemo(
    () => (searchActive ? searchCommitments(searchIndex, trimmedQuery, { todayIso, categoryLabel: SEARCH_CATEGORY_LABEL }) : null),
    [searchActive, searchIndex, trimmedQuery, todayIso],
  );
  const closeSearch = React.useCallback(() => {
    setSearchQuery("");
    setSearchOpen(false);
  }, []);

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
        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <button
            type="button"
            data-commitments-search-toggle
            aria-label="Cerca negli impegni"
            aria-expanded={searchOpen}
            title="Cerca negli impegni"
            onClick={() => setSearchOpen(current => !current)}
            className={`inline-flex h-11 w-11 shrink-0 items-center justify-center self-end rounded-xl border transition-colors sm:self-auto ${
              searchOpen
                ? "border-emerald-700 bg-emerald-50 text-emerald-800"
                : "border-stone-300 bg-white text-stone-600 hover:bg-stone-100 active:bg-stone-200"
            }`}
          >
            <Search className="h-5 w-5" aria-hidden="true" />
          </button>
          {onCreateNote && (
            <button
              type="button"
              data-new-note-button
              onClick={onCreateNote}
              className="inline-flex min-h-[44px] w-full sm:w-auto items-center justify-center gap-1.5 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 active:bg-emerald-900 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Nuova nota
            </button>
          )}
        </div>
      </header>

      {searchOpen && (
        /* Campo di ricerca: compare sotto l'header, occupa tutta la larghezza su mobile.
           X e Esc svuotano la query e chiudono, senza toccare lo stato dell'Archivio. */
        <div data-commitments-search className="relative flex items-center">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" aria-hidden="true" />
          <input
            type="search"
            data-commitments-search-input
            autoFocus
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Escape") closeSearch();
            }}
            placeholder="Cerca: collegio, GLO, 2C, uscita…"
            aria-label="Cerca negli impegni"
            className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-white pl-9 pr-11 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-700/20 [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            type="button"
            data-commitments-search-clear
            aria-label="Svuota e chiudi la ricerca"
            title="Svuota e chiudi la ricerca"
            onClick={closeSearch}
            className="absolute right-1.5 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 active:bg-stone-200 transition-colors"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {showSearchHint ? (
        /* Almeno 2 caratteri scritti ma nessuna parola utile (solo doppie,
           punteggiatura, spazi, lettere singole): suggerimento al posto dei
           risultati, senza mostrare la vista normale né "N risultati". */
        <p data-search-hint role="status" className="px-1 text-sm text-stone-600">
          Scrivi almeno una parola di 2 lettere.
        </p>
      ) : searchActive && searchResult ? (
        /* Modalità ricerca: al posto dei gruppi normali e dell'Archivio mostra il
           riepilogo, gli impegni in programma (oggi incluso, oltre il 31 agosto
           compreso) e quelli passati, ciascuno solo se non vuoto. */
        searchResult.upcoming.length + searchResult.past.length === 0 ? (
          <div data-search-empty className="rounded-2xl border border-dashed border-stone-300 bg-white p-8 text-center">
            <Search className="w-8 h-8 mx-auto text-stone-400" aria-hidden="true" />
            <p className="mt-2 text-sm text-stone-600">Nessun impegno trovato per «{trimmedQuery}»</p>
          </div>
        ) : (
          <div data-search-results className="space-y-6">
            <p data-search-results-summary className="text-sm font-semibold text-stone-700">
              {searchResult.upcoming.length + searchResult.past.length === 1
                ? "1 risultato"
                : `${searchResult.upcoming.length + searchResult.past.length} risultati`} per «{trimmedQuery}»
            </p>

            {searchResult.upcoming.length > 0 && (
              <section data-search-section="in-programma" className="space-y-2">
                <h3 className="text-sm font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200 pb-1">
                  In programma ({searchResult.upcoming.length})
                </h3>
                <div className="space-y-2">
                  {searchResult.upcoming.map(item => (
                    <CommitmentRow key={item.id} item={item} todayIso={todayIso} duplicatePairs={duplicatePairs} onEditEvent={onEditEvent} onEditNote={onEditNote} onToggleComplete={onToggleComplete} />
                  ))}
                </div>
              </section>
            )}

            {searchResult.past.length > 0 && (
              <section data-search-section="passati" className="space-y-2">
                <h3 className="text-sm font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200 pb-1">
                  Passati ({searchResult.past.length})
                </h3>
                <div className="space-y-2">
                  {searchResult.past.map(item => (
                    <CommitmentRow key={item.id} item={item} todayIso={todayIso} duplicatePairs={duplicatePairs} onEditEvent={onEditEvent} onEditNote={onEditNote} onToggleComplete={onToggleComplete} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )
      ) : (
        <>
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
                    <CommitmentRow key={item.id} item={item} todayIso={todayIso} duplicatePairs={duplicatePairs} onEditEvent={onEditEvent} onEditNote={onEditNote} onToggleComplete={onToggleComplete} />
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
                    <CommitmentRow key={item.id} item={item} todayIso={todayIso} duplicatePairs={duplicatePairs} onEditEvent={onEditEvent} onEditNote={onEditNote} />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
};
