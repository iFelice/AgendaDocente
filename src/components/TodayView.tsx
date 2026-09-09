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
    <div className="space-y-6 pb-12">
      {/* Header Banner with day navigation (works on mobile and desktop) */}
      <div className="bg-white rounded-xl p-4 sm:p-5 border border-stone-200 shadow-xs flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <span className="text-xs font-semibold text-emerald-800 uppercase tracking-wider flex items-center gap-2">
              Panoramica della Giornata
              {isToday ? (
                <span className="px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-800 text-[10px] font-bold normal-case tracking-normal">Oggi</span>
              ) : (
                <span className="px-1.5 py-0.5 rounded-md bg-stone-100 text-stone-600 text-[10px] font-bold normal-case tracking-normal">
                  {isFutureDay ? "Giorno futuro" : "Giorno passato"}
                </span>
              )}
            </span>
            <h1 className="text-lg sm:text-2xl font-bold text-stone-900 mt-0.5 break-words">{displayDate}</h1>
            <p className="text-sm text-stone-500 mt-1">
              {todayLessons.length > 0
                ? `${todayLessons.length} ore di lezione in programma`
                : "Nessuna lezione curricolare prevista"}
              {todayEvents.length > 0 && ` • ${todayEvents.length} impegni/riunioni`}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1" role="group" aria-label="Navigazione del giorno">
            <button
              id="today-previous-day"
              type="button"
              onClick={() => setSelectedIso((iso) => addDaysISO(iso, -1))}
              className="p-2 rounded-lg border border-stone-200 hover:bg-stone-50 text-stone-600 transition-colors"
              title="Giorno precedente"
              aria-label="Giorno precedente"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              id="today-back-to-today"
              type="button"
              onClick={() => setSelectedIso(todayIso)}
              disabled={isToday}
              className={`px-3 py-2 rounded-lg border text-xs font-semibold transition-colors ${
                isToday
                  ? "border-stone-100 bg-stone-50 text-stone-400 cursor-default"
                  : "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
              }`}
              title="Torna alla data corrente"
            >
              Oggi
            </button>
            <button
              id="today-next-day"
              type="button"
              onClick={() => setSelectedIso((iso) => addDaysISO(iso, 1))}
              className="p-2 rounded-lg border border-stone-200 hover:bg-stone-50 text-stone-600 transition-colors"
              title="Giorno successivo"
              aria-label="Giorno successivo"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="today-quick-add"
              onClick={() => onOpenNewEvent(selectedIso)}
              className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg text-emerald-800 bg-emerald-50 hover:bg-emerald-100 transition-colors border border-emerald-200"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              Aggiungi{isToday ? " per oggi" : ""}
            </button>
            <button
              id="today-quick-scan"
              onClick={onOpenCircularModal}
              className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg text-amber-800 bg-amber-50 hover:bg-amber-100 transition-colors border border-amber-200"
            >
              <Sparkles className="w-4 h-4 mr-1.5 text-amber-600" />
              Importa circolare
            </button>
          </div>
        </div>
      </div>

      {/* Grid: Lessons + Afternoon Meetings */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Lessons & Afternoon */}
        <div className="lg:col-span-2 space-y-6">
          {/* Section 1: Morning Lessons */}
          <div className="bg-white rounded-xl border border-stone-200 shadow-xs overflow-hidden">
            <div className="p-4 border-b border-stone-100 flex items-center justify-between bg-stone-50/70">
              <div className="flex items-center space-x-2">
                <BookOpen className="w-5 h-5 text-emerald-700" />
                <h2 className="text-base font-semibold text-stone-900">Lezioni Curricolari{isToday ? " di Oggi" : " del Giorno"}</h2>
                {isProvisionalTimetable && (
                  <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                    🕒 Orario Provvisorio
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-2">
                {isProvisionalTimetable && !isDefinitiveCompiled && (
                  <span className="text-[11px] text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 hidden sm:inline">
                    Definitivo non compilato
                  </span>
                )}
                <span className="text-xs font-semibold px-2.5 py-1 bg-stone-100 text-stone-700 rounded-full">
                  {todayLessons.length} {todayLessons.length === 1 ? "ora" : "ore"}
                </span>
              </div>
            </div>

            <div className="p-4">
              {todayLessons.length === 0 ? (
                <div className="py-8 text-center space-y-2">
                  <p className="text-sm text-stone-600 font-medium">
                    {isWeekend
                      ? "Fine settimana: nessuna lezione curricolare prevista."
                      : "Nessuna lezione inserita per questo giorno della settimana."}
                  </p>
                  <p className="text-xs text-stone-400">
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
                <div className="space-y-3">
                  {todayLessons.map((slot) => (
                    <div
                      key={slot.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-stone-200 hover:border-emerald-300 transition-colors bg-white"
                    >
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-800 flex flex-col items-center justify-center font-bold text-xs border border-emerald-200">
                          <span>{slot.periodNumber}ª</span>
                          <span className="text-[10px] font-normal text-emerald-600">ora</span>
                        </div>
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="font-bold text-stone-900 text-sm">{slot.className}</span>
                            <span className="text-stone-300">•</span>
                            <span className="font-medium text-stone-800 text-sm">{slot.subject}</span>
                          </div>
                          <div className="flex items-center space-x-2 text-xs text-stone-500 mt-0.5">
                            <Clock className="w-3.5 h-3.5 text-stone-400" />
                            <span>
                              {slot.startTime} – {slot.endTime}
                            </span>
                            {slot.classroom && (
                              <>
                                <span>•</span>
                                <MapPin className="w-3.5 h-3.5 text-stone-400" />
                                <span>{slot.classroom}</span>
                              </>
                            )}
                          </div>
                          {coTeachingSummary(slot) && (
                            <div
                              className="mt-1 inline-flex items-center max-w-full text-[11px] leading-snug text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-md px-1.5 py-0.5"
                              title={coTeachingSummary(slot) ?? undefined}
                            >
                              <span className="truncate">{coTeachingSummary(slot)}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="text-right">
                        <span className="text-xs px-2.5 py-1 rounded-md font-medium bg-stone-100 text-stone-700 border border-stone-200">
                          {slot.campus || "Centrale"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {isProvisionalTimetable && !isDefinitiveCompiled && (
              <div className="p-3 bg-amber-50/70 border-t border-amber-200 text-xs text-amber-900 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Clock className="w-4 h-4 text-amber-700 flex-shrink-0" />
                  <span>
                    Orario provvisorio per i primi giorni di scuola attivo di default (orario definitivo non ancora compilato).
                  </span>
                </div>
                {onNavigateToTimetable && (
                  <button
                    type="button"
                    onClick={onNavigateToTimetable}
                    className="font-bold underline hover:text-amber-950 text-[11px] whitespace-nowrap ml-2"
                  >
                    Compila Definitivo &rarr;
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Section 2: Meetings & Events */}
          <div className="bg-white rounded-xl border border-stone-200 shadow-xs overflow-hidden">
            <div className="p-4 border-b border-stone-100 flex items-center justify-between bg-stone-50/70">
              <div className="flex items-center space-x-2">
                <Calendar className="w-5 h-5 text-purple-700" />
                <h2 className="text-base font-semibold text-stone-900">Impegni & Riunioni{isToday ? "" : " del giorno selezionato"}</h2>
              </div>
              <button
                onClick={() => onOpenNewEvent(selectedIso)}
                className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 flex items-center"
              >
                <Plus className="w-3.5 h-3.5 mr-1" />
                Aggiungi
              </button>
            </div>

            <div className="p-4">
              {todayEvents.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-sm text-stone-500">Nessun impegno registrato per questa data.</p>
                  <p className="text-xs text-stone-400 mt-1">I consigli di classe o le riunioni appariranno qui quando inseriti.</p>
                </div>
              ) : (
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

                        <div className="flex items-center space-x-1">
                          <button
                            onClick={() => onEditEvent(ev)}
                            className="p-1 rounded-md text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
                            title="Modifica"
                          >
                            <Pencil className="w-3.5 h-3.5" />
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
                              className="p-1 rounded-md text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                              title="Elimina"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
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

                      {ev.notes && <p className="text-xs text-stone-500 bg-stone-50 p-2 rounded-md">{ev.notes}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Col: Deadlines & Quick Reference */}
        <div className="space-y-6">
          {/* Deadlines of the selected day, then the nearest upcoming ones */}
          <div className="bg-white rounded-xl border border-stone-200 shadow-xs overflow-hidden">
            <div className="p-4 border-b border-stone-100 flex items-center justify-between bg-stone-50/70">
              <div className="flex items-center space-x-2">
                <AlertCircle className="w-5 h-5 text-amber-600" />
                <h2 className="text-base font-semibold text-stone-900">Scadenze & Adempimenti</h2>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
                {dayDeadlines.length} {isToday ? "oggi" : "del giorno"}
              </span>
            </div>

            <div className="p-4">
              {dayDeadlines.length === 0 && nextDeadlines.length === 0 ? (
                <div className="py-6 text-center text-stone-400 text-xs">
                  Nessuna scadenza in sospeso per questa data. Ottimo lavoro!
                </div>
              ) : (
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
              )}
            </div>
          </div>

          {/* Quick AI Circular Promo Box */}
          <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl border border-amber-200 p-4 space-y-3">
            <div className="flex items-center space-x-2 text-amber-900 font-semibold text-sm">
              <Sparkles className="w-4 h-4 text-amber-600" />
              <span>Hai ricevuto una nuova circolare?</span>
            </div>
            <p className="text-xs text-amber-800 leading-relaxed">
              Non ricopiare a mano gli orari dei consigli o le date del collegio. Carica il PDF o scatta una foto: l'app seleziona
              solo gli impegni pertinenti alle tue classi e al tuo grado.
            </p>
            <button
              onClick={onOpenCircularModal}
              className="w-full py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium text-xs shadow-xs transition-colors text-center"
            >
              Apri Analizzatore Circolari
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
