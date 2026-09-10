import { addDaysISO, civilDayOfWeek, civilTimetableDay, localDateISO, parseCivilDate } from "../utils/dates";
import React from "react";
import {
  BookOpen,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  MapPin,
  Plus,
  Sparkles,
  Users,
  AlertCircle,
  Pencil,
  Trash2,
} from "lucide-react";
import { CalendarEvent, TeacherProfile, TimetableSlot } from "../types";
import { coTeachingSummary } from "../utils/coTeaching";

/**
 * Pure day selector for the "Oggi" view: everything is computed from the *selected civil
 * date*, never from a UTC instant. Lessons follow the weekday of the selected date and
 * events/deadlines are the ones recorded for that exact day.
 */
export function selectDayAgenda(
  selectedIso: string,
  timetable: TimetableSlot[],
  events: CalendarEvent[]
) {
  const todayIso = localDateISO();
  const weekday = civilDayOfWeek(selectedIso); // 0 = Sunday … 6 = Saturday
  const timetableDay = civilTimetableDay(selectedIso);
  const lessons = timetableDay
    ? timetable.filter((slot) => slot.dayOfWeek === timetableDay).sort((a, b) => a.periodNumber - b.periodNumber)
    : [];
  const dayEvents = events
    .filter((e) => e.date === selectedIso && !e.completed)
    .sort((a, b) => (a.startTime || "00:00").localeCompare(b.startTime || "00:00"));
  const isDeadlineLike = (e: CalendarEvent) => e.category === "scadenza" || e.category === "promemoria" || e.category === "pei";
  const pending = events.filter((e) => isDeadlineLike(e) && !e.completed).sort((a, b) => a.date.localeCompare(b.date));
  const dayDeadlines = pending.filter((e) => e.date === selectedIso);
  const nextDeadlines = pending.filter((e) => e.date > selectedIso).slice(0, 3);
  const formattedDate = new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(parseCivilDate(selectedIso));
  return {
    isToday: selectedIso === todayIso,
    isWeekend: weekday === 0 || weekday === 6,
    lessons,
    dayEvents,
    dayDeadlines,
    nextDeadlines,
    displayDate: formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1),
  };
}

interface TodayViewProps {
  profile: TeacherProfile;
  timetable: TimetableSlot[];
  events: CalendarEvent[];
  isProvisionalTimetable?: boolean;
  isDefinitiveCompiled?: boolean;
  onOpenNewEvent: (initialDate?: string) => void;
  onOpenCircularModal: () => void;
  onEditEvent: (event: CalendarEvent) => void;
  onDeleteEvent: (id: string) => void;
  onToggleComplete: (id: string) => void;
  onNavigateToPlanning?: (dateIso: string, view?: "oggi" | "settimana" | "mese") => void;
  onNavigateToTimetable?: () => void;
}

export const TodayView: React.FC<TodayViewProps> = ({
  timetable,
  events,
  isProvisionalTimetable,
  isDefinitiveCompiled,
  onOpenNewEvent,
  onOpenCircularModal,
  onEditEvent,
  onDeleteEvent,
  onToggleComplete,
  onNavigateToPlanning,
  onNavigateToTimetable,
}) => {
  const [confirmingDeleteEventId, setConfirmingDeleteEventId] = React.useState<string | null>(null);
  // Selected civil date (defaults to the real today). Navigation is day-by-day and must
  // survive month/year/weekend crossings because it works on local Date parts, never UTC.
  const [selectedIso, setSelectedIso] = React.useState<string>(() => localDateISO());
  const todayIso = localDateISO();

  const {
    isToday,
    isWeekend,
    lessons: todayLessons,
    dayEvents: todayEvents,
    dayDeadlines,
    nextDeadlines,
    displayDate,
  } = selectDayAgenda(selectedIso, timetable, events);
  const isFutureDay = selectedIso > todayIso;
  /*
    Visual state of the selected day, shared by the date badge and the "Oggi" shortcut.
    Green is reserved for the real today; a future selection reads as amber ("you are
    ahead of the present") and a past one as neutral, so "Futuro" can never carry the
    same green semantics as "Oggi". Pure presentation: no date logic involved.
  */
  const dayStatus = isToday
    ? { label: "Oggi", badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-300" }
    : isFutureDay
      ? { label: "Futuro", badgeClass: "bg-amber-100 text-amber-900 border-amber-300" }
      : { label: "Passato", badgeClass: "bg-stone-100 text-stone-600 border-stone-200" };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "glo":
        return "bg-emerald-100 text-emerald-900 border-emerald-300 font-semibold";
      case "pei":
        return "bg-teal-100 text-teal-900 border-teal-300 font-semibold";
      case "dipartimento_sostegno":
        return "bg-emerald-50 text-emerald-800 border-emerald-200";
      case "consiglio_classe":
        return "bg-purple-100 text-purple-800 border-purple-200";
      case "collegio_docenti":
        return "bg-blue-100 text-blue-800 border-blue-200";
      case "dipartimento":
        return "bg-teal-100 text-teal-800 border-teal-200";
      case "scadenza":
        return "bg-rose-100 text-rose-800 border-rose-200";
      case "formazione":
        return "bg-indigo-100 text-indigo-800 border-indigo-200";
      case "ricevimento_genitori":
        return "bg-amber-100 text-amber-800 border-amber-200";
      default:
        return "bg-stone-100 text-stone-800 border-stone-200";
    }
  };

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case "glo":
        return "G.L.O. Inclusione";
      case "pei":
        return "P.E.I. / P.D.P.";
      case "dipartimento_sostegno":
        return "Dip. Sostegno";
      case "consiglio_classe":
        return "Consiglio di Classe";
      case "collegio_docenti":
        return "Collegio Docenti";
      case "dipartimento":
        return "Dipartimento";
      case "scadenza":
        return "Scadenza";
      case "formazione":
        return "Formazione";
      case "ricevimento_genitori":
        return "Ricevimento";
      default:
        return "Impegno";
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      {/*
        Day overview: deliberately compact on phones (date + day navigation + one-line
        summary) so the lesson list is above the fold almost immediately. The duplicate
        quick actions live in the header/FAB and in "Altro", so they are desktop only.
      */}
      <div className="bg-white rounded-xl p-3 sm:p-5 border border-stone-200 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <span className="hidden sm:flex text-xs font-semibold text-emerald-800 uppercase tracking-wider items-center gap-2">
              Panoramica della Giornata
              <span
                className={`px-1.5 py-0.5 rounded-md border text-[10px] font-bold normal-case tracking-normal ${dayStatus.badgeClass}`}
                title={isToday ? "Stai visualizzando la data di oggi" : isFutureDay ? "Stai visualizzando una data futura" : "Stai visualizzando una data passata"}
              >
                {dayStatus.label}
              </span>
            </span>
            <h1 className="text-base sm:text-2xl font-bold text-stone-900 mt-0.5 break-words leading-snug">
              <span className="truncate">{displayDate}</span>
              <span className={`sm:hidden ml-1.5 align-middle text-[10px] font-bold px-1.5 py-0.5 rounded-md border ${dayStatus.badgeClass}`}>
                {dayStatus.label}
              </span>
            </h1>
            <p className="text-xs sm:text-sm text-stone-500 mt-0.5 truncate">
              {todayLessons.length > 0
                ? `${todayLessons.length} ore di lezione in programma`
                : "Nessuna lezione curricolare prevista"}
              {todayEvents.length > 0 && ` • ${todayEvents.length} impegni/riunioni`}
            </p>
          </div>

          <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Navigazione del giorno">
            <button
              id="today-previous-day"
              type="button"
              onClick={() => setSelectedIso((iso) => addDaysISO(iso, -1))}
              className="min-w-[36px] min-h-[36px] flex items-center justify-center p-1 rounded-lg border border-stone-200/50 hover:bg-stone-50/20 text-stone-600 transition-colors"
              title="Giorno precedente"
              aria-label="Giorno precedente"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            {/*
              "Oggi" shortcut. On the real today it stays green and clearly ACTIVE (solid,
              never an ambiguous gray); on any other date it turns amber as a "come back
              to the present" call-to-action. Text is always "Oggi".
            */}
            <button
              id="today-back-to-today"
              type="button"
              onClick={() => setSelectedIso(todayIso)}
              disabled={isToday}
              aria-pressed={isToday}
              title={isToday ? "Stai già visualizzando la data di oggi" : "Torna alla data corrente"}
              className={`min-h-[44px] px-2.5 sm:px-3 py-2 rounded-lg border text-xs font-semibold transition-colors ${
                isToday
                  ? "border-emerald-700 bg-emerald-700 text-white cursor-default shadow-xs"
                  : "border-amber-400 bg-amber-400 text-amber-950 hover:bg-amber-300 hover:border-amber-500 active:bg-amber-200"
              }`}
            >
              Oggi
            </button>
            <button
              id="today-next-day"
              type="button"
              onClick={() => setSelectedIso((iso) => addDaysISO(iso, 1))}
              className="min-w-[36px] min-h-[36px] flex items-center justify-center p-1 rounded-lg border border-stone-200/50 hover:bg-stone-50/20 text-stone-600 transition-colors"
              title="Giorno successivo"
              aria-label="Giorno successivo"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Quick actions: desktop/tablet only (on phones: floating "+" and "Altro"). */}
        <div className="hidden md:flex items-center justify-end gap-2 mt-3">
          <button
            id="today-quick-add"
            onClick={() => onOpenNewEvent(selectedIso)}
            className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg text-emerald-800 bg-emerald-50 hover:bg-emerald-100 transition-colors border border-emerald-200 min-h-[44px]"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            Aggiungi{isToday ? " per oggi" : ""}
          </button>
          <button
            id="today-quick-scan"
            onClick={onOpenCircularModal}
            className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg text-amber-800 bg-amber-50 hover:bg-amber-100 transition-colors border border-amber-200 min-h-[44px]"
          >
            <Sparkles className="w-4 h-4 mr-1.5 text-amber-600" />
            Importa circolare
          </button>
        </div>
      </div>

      {/* Grid: Lessons + Afternoon Meetings.
          Phones: single column; tablets (768-1023px): two columns; desktop: 2/3 + 1/3. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Left 2 Cols: Lessons & Afternoon */}
        <div className="md:col-span-1 lg:col-span-2 space-y-4 sm:space-y-6">
          {/* Section 1: Morning Lessons */}
          <div className="bg-white rounded-xl border border-stone-200 shadow-xs overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-stone-100 flex items-center justify-between gap-2 bg-stone-50/70">
              <div className="flex items-center space-x-2 min-w-0">
                <BookOpen className="w-5 h-5 text-emerald-700 shrink-0" />
                <h2 className="text-sm sm:text-base font-semibold text-stone-900 truncate">Lezioni Curricolari{isToday ? " di Oggi" : " del Giorno"}</h2>
                {isProvisionalTimetable && (
                  <span
                    className="shrink-0 px-2 py-0.5 rounded-md text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300 whitespace-nowrap"
                    title="Orario provvisorio per i primi giorni di scuola attivo"
                  >
                    <span className="sm:hidden">Provvisorio</span>
                    <span className="hidden sm:inline">🕒 Orario Provvisorio</span>
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-2 shrink-0">
                {isProvisionalTimetable && !isDefinitiveCompiled && (
                  <span className="text-[11px] text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 hidden sm:inline">
                    Definitivo non compilato
                  </span>
                )}
                <span className="text-xs font-semibold px-2.5 py-1 bg-stone-100 text-stone-700 rounded-full whitespace-nowrap">
                  {todayLessons.length} {todayLessons.length === 1 ? "ora" : "ore"}
                </span>
              </div>
            </div>

            <div className="p-3 sm:p-4">
              {todayLessons.length === 0 ? (
                <div className="py-5 sm:py-8 text-center space-y-1.5 sm:space-y-2">
                  <p className="text-sm text-stone-600 font-medium">
                    {isWeekend
                      ? "Fine settimana: nessuna lezione curricolare prevista."
                      : "Nessuna lezione inserita per questo giorno della settimana."}
                  </p>
                  <p className="hidden sm:block text-xs text-stone-400">
                    Puoi personalizzare la griglia oraria dalla scheda "Orario Lezioni" o visualizzare il planning settimanale.
                  </p>
                  {onNavigateToPlanning && (
                    <button
                      type="button"
                      onClick={() => onNavigateToPlanning(selectedIso, "settimana")}
                      className="mt-2 inline-flex items-center px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 transition-colors"
                    >
                      <Calendar className="w-3.5 h-3.5 mr-1 text-emerald-700" />
                      Visualizza la Settimana
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {todayLessons.map((slot) => {
                    const summary = coTeachingSummary(slot);
                    return (
                      <div
                        key={slot.id}
                        className="p-3 rounded-xl border border-stone-200 hover:border-emerald-300 active:border-emerald-400 transition-colors bg-white"
                      >
                        <div className="flex items-start gap-3">
                          {/* Ora & periodo: blocco verticale compatto */}
                          <div
                            className="w-14 shrink-0 rounded-lg bg-emerald-50 border border-emerald-200 text-center px-1 py-1.5"
                            aria-label={`${slot.periodNumber}ª ora, dalle ${slot.startTime} alle ${slot.endTime}`}
                          >
                            <div className="text-sm font-bold text-emerald-900 leading-none">
                              {slot.periodNumber}ª
                            </div>
                            <div className="text-[10px] text-emerald-700 font-medium leading-tight mt-1">
                              {slot.startTime}
                              <br />– {slot.endTime}
                            </div>
                          </div>

                          {/* Materia + classe, aula/plesso e compresenza */}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <h3 className="text-sm font-bold text-stone-900 leading-snug break-words">
                                {slot.subject}
                              </h3>
                              <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md bg-stone-100 text-stone-700 border border-stone-200 whitespace-nowrap">
                                {slot.className}
                              </span>
                            </div>

                            {(slot.classroom || slot.campus) && (
                              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-stone-500 mt-1">
                                {slot.classroom && (
                                  <span className="inline-flex items-center gap-1 min-w-0">
                                    <MapPin className="w-3 h-3 text-stone-400 shrink-0" />
                                    <span className="truncate">{slot.classroom}</span>
                                  </span>
                                )}
                                {slot.campus && <span className="text-stone-400">{slot.campus}</span>}
                              </div>
                            )}

                            {summary && (
                              <p
                                className="mt-1.5 inline-flex items-center max-w-full text-[11px] leading-snug text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1"
                                title={summary}
                              >
                                <span className="truncate">{summary}</span>
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {isProvisionalTimetable && !isDefinitiveCompiled && (
              /* Compact informational row on phones (no big yellow block): short label +
                 link to complete the timetable; the full explanation stays on >= 640px. */
              <div className="px-3 sm:px-4 py-2 sm:py-3 bg-amber-50/70 border-t border-amber-200 text-[11px] sm:text-xs text-amber-900 flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <Clock className="w-3.5 h-3.5 text-amber-700 flex-shrink-0" />
                  <span className="truncate">
                    <span className="sm:hidden">Orario provvisorio attivo</span>
                    <span className="hidden sm:inline sm:truncate-none">
                      Orario provvisorio per i primi giorni di scuola attivo di default (orario definitivo non ancora compilato).
                    </span>
                  </span>
                </span>
                {onNavigateToTimetable && (
                  <button
                    type="button"
                    id="today-complete-timetable"
                    onClick={onNavigateToTimetable}
                    className="font-bold underline hover:text-amber-950 text-[11px] whitespace-nowrap shrink-0 min-h-[32px]"
                  >
                    <span className="sm:hidden">Completa orario</span>
                    <span className="hidden sm:inline">Compila Definitivo &rarr;</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Section 2: Meetings & Events. With no data the section collapses to a
              single compact row ("Nessun impegno oggi · + Aggiungi") instead of a big
              empty card, and expands only when real items exist. */}
          {todayEvents.length === 0 ? (
            <div className="bg-white rounded-xl border border-stone-200 shadow-xs px-3 py-2.5 flex items-center justify-between gap-2">
              <p className="text-xs text-stone-500 min-w-0 truncate">
                Nessun impegno {isToday ? "oggi" : "in questa data"}
                <span className="text-stone-400"> · i consigli di classe appariranno qui</span>
              </p>
              <button
                type="button"
                id="today-empty-add-event"
                onClick={() => onOpenNewEvent(selectedIso)}
                className="shrink-0 inline-flex items-center gap-1 min-h-[40px] px-3 rounded-lg text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200"
              >
                <Plus className="w-3.5 h-3.5" />
                Aggiungi
              </button>
            </div>
          ) : (
          <div className="bg-white rounded-xl border border-stone-200 shadow-xs overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-stone-100 flex items-center justify-between bg-stone-50/70">
              <div className="flex items-center space-x-2 min-w-0">
                <Calendar className="w-5 h-5 text-purple-700 shrink-0" />
                <h2 className="text-sm sm:text-base font-semibold text-stone-900 truncate">Impegni & Riunioni{isToday ? "" : " del giorno selezionato"}</h2>
              </div>
              <button
                onClick={() => onOpenNewEvent(selectedIso)}
                className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 flex items-center min-h-[36px] px-2 shrink-0"
              >
                <Plus className="w-3.5 h-3.5 mr-1" />
                Aggiungi
              </button>
            </div>

            <div className="p-3 sm:p-4">
                <div className="space-y-3">
                  {todayEvents.map((ev) => (
                    <div
                      key={ev.id}
                      className="p-4 rounded-xl border border-stone-200 hover:border-stone-300 transition-shadow shadow-2xs bg-white space-y-2"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center space-x-2">
                          <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium border ${getCategoryColor(ev.category)}`}>
                            {getCategoryLabel(ev.category)}
                          </span>
                          {ev.className && (
                            <span className="text-xs px-2 py-0.5 rounded-md font-semibold bg-stone-100 text-stone-700 border border-stone-200">
                              Classe {ev.className}
                            </span>
                          )}
                          {ev.sourceType === "circolare" && (
                            <span className="text-[11px] px-2 py-0.5 rounded-md font-normal bg-amber-50 text-amber-800 border border-amber-200">
                              Da Circolare
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => onEditEvent(ev)}
                            className="p-1 rounded-md text-stone-400 hover:text-stone-700 hover:bg-stone-100 active:bg-stone-200 transition-colors"
                            title="Modifica"
                            aria-label="Modifica impegno"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          {confirmingDeleteEventId === ev.id ? (
                            <div className="flex items-center space-x-1 bg-rose-50 border border-rose-300 px-2 py-0.5 rounded-lg text-xs">
                              <span className="text-[11px] font-bold text-rose-800">Elimina?</span>
                              <button
                                type="button"
                                onClick={() => {
                                  onDeleteEvent(ev.id);
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
                              onClick={() => setConfirmingDeleteEventId(ev.id)}
                              className="p-1 rounded-md text-stone-400 hover:text-rose-600 hover:bg-rose-50 active:bg-rose-100 transition-colors"
                              title="Elimina"
                              aria-label="Elimina impegno"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>

                      <h3 className="text-sm font-semibold text-stone-900">{ev.title}</h3>

                      <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600">
                        <div className="flex items-center space-x-1">
                          <Clock className="w-3.5 h-3.5 text-stone-400" />
                          <span>
                            {ev.isAllDay ? "Tutto il giorno" : `${ev.startTime || "15:00"} – ${ev.endTime || "16:30"}`}
                          </span>
                        </div>
                        {ev.location && (
                          <div className="flex items-center space-x-1">
                            <MapPin className="w-3.5 h-3.5 text-stone-400" />
                            <span>{ev.location}</span>
                          </div>
                        )}
                      </div>

                      {ev.notes && <p className="text-xs text-stone-500 bg-stone-50 p-1 rounded-md">{ev.notes}</p>}
                    </div>
                  ))}
                </div>
            </div>
          </div>
          )}
        </div>

        {/* Right Col: Deadlines & Quick Reference */}
        <div className="space-y-4 sm:space-y-6">
          {/* Deadlines of the selected day, then the nearest upcoming ones. With no
              data at all the section is a single compact row, not a big empty card. */}
          {dayDeadlines.length === 0 && nextDeadlines.length === 0 ? (
            <div className="bg-white rounded-xl border border-stone-200 shadow-xs px-3 py-2.5 flex items-center justify-between gap-2">
              <p className="text-xs text-stone-500 min-w-0 truncate">
                Nessuna scadenza {isToday ? "oggi" : "in questa data"}
              </p>
              <button
                type="button"
                id="today-empty-add-deadline"
                onClick={() => onOpenNewEvent(selectedIso)}
                className="shrink-0 inline-flex items-center gap-1 min-h-[40px] px-3 rounded-lg text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200"
              >
                <Plus className="w-3.5 h-3.5" />
                Aggiungi
              </button>
            </div>
          ) : (
          <div className="bg-white rounded-xl border border-stone-200 shadow-xs overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-stone-100 flex items-center justify-between bg-stone-50/70">
              <div className="flex items-center space-x-2 min-w-0">
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
                <h2 className="text-sm sm:text-base font-semibold text-stone-900 truncate">Scadenze & Adempimenti</h2>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium whitespace-nowrap shrink-0">
                {dayDeadlines.length} {isToday ? "oggi" : "del giorno"}
              </span>
            </div>

            <div className="p-3 sm:p-4">
                <div className="space-y-3">
                  {dayDeadlines.map((d) => (
                    <div
                      key={d.id}
                      className="p-3 rounded-lg border border-amber-300 bg-amber-50/60 space-y-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          onClick={() => onToggleComplete(d.id)}
                          className="flex items-start space-x-2 text-left"
                        >
                          <Circle className="w-4 h-4 text-stone-400 mt-0.5 flex-shrink-0 hover:text-emerald-600 transition-colors" />
                          <span className="text-xs font-semibold text-stone-900 leading-snug">{d.title}</span>
                        </button>
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-stone-500 pl-6">
                        <span>Data limite: {d.date}</span>
                        {d.location && <span className="truncate max-w-[120px]">{d.location}</span>}
                      </div>
                    </div>
                  ))}
                  {dayDeadlines.length === 0 && nextDeadlines.length > 0 && (
                    <p className="text-[11px] text-stone-400 font-medium px-1">Nessuna scadenza in questa data. Prossime:</p>
                  )}
                  {dayDeadlines.length === 0 &&
                    nextDeadlines.map((d) => (
                      <div
                        key={d.id}
                        className="p-3 rounded-lg border border-stone-200 hover:border-amber-300 transition-colors bg-stone-50/40 space-y-1.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <button
                            onClick={() => onToggleComplete(d.id)}
                            className="flex items-start space-x-2 text-left"
                          >
                            <Circle className="w-4 h-4 text-stone-400 mt-0.5 flex-shrink-0 hover:text-emerald-600 transition-colors" />
                            <span className="text-xs font-semibold text-stone-900 leading-snug">{d.title}</span>
                          </button>
                        </div>

                        <div className="flex items-center justify-between text-[11px] text-stone-500 pl-6">
                          <span>Data limite: {d.date}</span>
                          {d.location && <span className="truncate max-w-[120px]">{d.location}</span>}
                        </div>
                      </div>
                    ))}
                </div>
            </div>
          </div>
          )}

          {/* Quick AI Circular Promo Box */}
          <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl border border-amber-200 p-3 sm:p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center space-x-2 text-amber-900 font-semibold text-xs sm:text-sm min-w-0">
                <Sparkles className="w-4 h-4 text-amber-600 shrink-0" />
                <span className="truncate">Hai ricevuto una nuova circolare?</span>
              </div>
              <button
                onClick={onOpenCircularModal}
                id="today-circular-cta-mobile"
                className="shrink-0 sm:hidden min-h-[40px] py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium text-xs shadow-xs transition-colors text-center"
              >
                Analizza
              </button>
            </div>
            <p className="hidden sm:block text-xs text-amber-800 leading-relaxed mt-3">
              Non ricopiare a mano gli orari dei consigli o le date del collegio. Carica il PDF o scatta una foto: l'app seleziona
              solo gli impegni pertinenti alle tue classi e al tuo grado.
            </p>
            <button
              onClick={onOpenCircularModal}
              id="today-circular-cta"
              className="hidden sm:block w-full mt-3 py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium text-xs shadow-xs transition-colors text-center"
            >
              Apri Analizzatore Circolari
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
