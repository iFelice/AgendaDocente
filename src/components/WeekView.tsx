import { localDateISO } from "../utils/dates";
import React, { useState, useEffect } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Plus,
  BookOpen,
  Calendar,
  FileText,
  Trash2,
} from "lucide-react";
import { CalendarEvent, TeacherProfile, TimetableSlot } from "../types";
import { coTeachingSummary } from "../utils/coTeaching";

interface WeekViewProps {
  profile?: TeacherProfile;
  timetable: TimetableSlot[];
  events: CalendarEvent[];
  isProvisionalTimetable?: boolean;
  onOpenNewEvent: (initialDate?: string) => void;
  onEditEvent: (event: CalendarEvent) => void;
  onDeleteEvent?: (id: string) => void;
  targetDateIso?: string;
}

export const WeekView: React.FC<WeekViewProps> = ({
  profile,
  timetable,
  events,
  isProvisionalTimetable,
  onOpenNewEvent,
  onEditEvent,
  onDeleteEvent,
  targetDateIso,
}) => {
  const [currentWeekOffset, setCurrentWeekOffset] = useState<number>(0);
  
  // Per i docenti del SSIG (Scuola Secondaria di I Grado), la settimana corta è lo standard:
  // "inclusi sabato" viene impostato di default SENZA spunta (false).
  const isSsig = profile?.schoolLevel === "ssig";
  const [includeSaturday, setIncludeSaturday] = useState<boolean>(!isSsig);
  const [filterMode, setFilterMode] = useState<"ALL" | "CIRCULARS">("ALL");
  const [confirmingDeleteEventId, setConfirmingDeleteEventId] = useState<string | null>(null);

  // Aggiorna la selezione di default se il profilo cambia livello a SSIG
  useEffect(() => {
    if (profile?.schoolLevel === "ssig") {
      setIncludeSaturday(false);
    }
  }, [profile?.schoolLevel]);

  /**
   * Calcola il Lunedì di riferimento per una data:
   * - Se la data cade durante la settimana lavorativa (Lunedì-Venerdì, es. 4 settembre):
   *   mantiene il Lunedì della settimana corrispondente (così il 4 settembre è visibile nel suo contesto).
   * - Se la data cade di Sabato (es. 5 settembre) o Domenica:
   *   salta direttamente al Lunedì successivo (es. 7 settembre), perché la settimana didattica è conclusa.
   */
  const getReferenceMonday = (refDate: Date, rollWeekend: boolean = true): Date => {
    const d = new Date(refDate);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0 = Domenica, 1 = Lunedì, ..., 5 = Venerdì, 6 = Sabato

    if (rollWeekend && (day === 6 || day === 0)) {
      // Sabato (6) -> +2 giorni (Lunedì successivo)
      // Domenica (0) -> +1 giorno (Lunedì successivo)
      const daysToNextMonday = day === 6 ? 2 : 1;
      d.setDate(d.getDate() + daysToNextMonday);
      return d;
    }

    // Regola sul Lunedì della settimana corrente
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    return d;
  };

  // Sync a targetDateIso se fornita (es. click da Oggi o Mese)
  useEffect(() => {
    if (targetDateIso) {
      const parts = targetDateIso.split("-");
      if (parts.length === 3) {
        const target = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        target.setHours(0, 0, 0, 0);

        // Se la data bersaglio è Sabato 5 settembre (o weekend) e Sabato non è mostrato (SSIG),
        // o in base alla regola di weekend, punta a Lunedì 7 settembre
        const shouldRollWeekend = (!includeSaturday && target.getDay() === 6) || target.getDay() === 0;
        const targetMonday = getReferenceMonday(target, shouldRollWeekend);
        const baseMonday = getReferenceMonday(new Date(), true);

        const dayDiff = Math.round((targetMonday.getTime() - baseMonday.getTime()) / (24 * 60 * 60 * 1000));
        const weekDiff = Math.round(dayDiff / 7);
        setCurrentWeekOffset(weekDiff);
      }
    }
  }, [targetDateIso, includeSaturday]);

  // Calcola il Lunedì della settimana correntemente visualizzata
  const getDisplayMonday = (offsetWeeks: number): Date => {
    const baseMonday = getReferenceMonday(new Date(), true);
    const d = new Date(baseMonday);
    d.setDate(baseMonday.getDate() + offsetWeeks * 7);
    return d;
  };

  const monday = getDisplayMonday(currentWeekOffset);
  const now = new Date();
  const isWeekendToday = now.getDay() === 6 || now.getDay() === 0;

  // Generate days array (Lunedì a Venerdì [5 giorni] oppure Sabato [6 giorni])
  const daysCount = includeSaturday ? 6 : 5;
  const days = Array.from({ length: daysCount }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const iso = localDateISO(d);
    const dayOfWeek = (i + 1) as 1 | 2 | 3 | 4 | 5 | 6;
    const isToday = localDateISO() === iso;
    const isTarget = targetDateIso === iso;
    const dayName = new Intl.DateTimeFormat("it-IT", { weekday: "short" }).format(d);
    const dayNum = d.getDate();
    const monthName = new Intl.DateTimeFormat("it-IT", { month: "short" }).format(d);

    return {
      date: d,
      iso,
      dayOfWeek,
      isToday,
      isTarget,
      label: `${dayName.toUpperCase()} ${dayNum} ${monthName.toUpperCase()}`,
      dayNum,
      dayNameShort: dayName.toUpperCase(),
      monthNameShort: monthName.toUpperCase(),
    };
  });

  const circularEventsCount = events.filter((e) => e.sourceType === "circolare").length;

  const getCategoryBorder = (category: string) => {
    switch (category) {
      case "glo":
        return "border-emerald-400 bg-emerald-50 text-emerald-950 font-semibold";
      case "pei":
        return "border-teal-400 bg-teal-50 text-teal-950 font-semibold";
      case "dipartimento_sostegno":
        return "border-emerald-300 bg-emerald-50 text-emerald-900";
      case "consiglio_classe":
        return "border-purple-300 bg-purple-50 text-purple-900";
      case "collegio_docenti":
        return "border-blue-300 bg-blue-50 text-blue-900";
      case "dipartimento":
        return "border-teal-300 bg-teal-50 text-teal-900";
      case "scadenza":
        return "border-rose-300 bg-rose-50 text-rose-900";
      case "ricevimento_genitori":
        return "border-amber-300 bg-amber-50 text-amber-900";
      default:
        return "border-stone-300 bg-stone-50 text-stone-900";
    }
  };

  return (
    <div className="space-y-3 sm:space-y-4 pb-12">
      {/* Top Controls */}
      <div className="bg-white rounded-xl p-3 sm:p-4 border border-stone-200 shadow-xs flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-2.5 sm:gap-3">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-wrap">
          <button
            onClick={() => setCurrentWeekOffset((prev) => prev - 1)}
            className="inline-flex items-center justify-center w-[44px] h-[44px] rounded-lg border border-stone-200 hover:bg-stone-50 active:bg-stone-100 text-stone-600 transition-colors"
            title="Settimana precedente"
            aria-label="Settimana precedente"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={() => setCurrentWeekOffset(0)}
            className="inline-flex items-center px-3 py-2 min-h-[44px] rounded-lg border border-stone-200 hover:bg-stone-50 text-xs font-semibold text-stone-700 transition-colors"
          >
            {isWeekendToday && currentWeekOffset === 0 ? "Settimana Entrante" : "Questa Settimana"}
          </button>
          <button
            onClick={() => setCurrentWeekOffset((prev) => prev + 1)}
            className="inline-flex items-center justify-center w-[44px] h-[44px] rounded-lg border border-stone-200 hover:bg-stone-50 active:bg-stone-100 text-stone-600 transition-colors"
            title="Settimana successiva"
            aria-label="Settimana successiva"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
          <span
            className="text-xs sm:text-sm font-semibold text-stone-800 ml-0.5 sm:ml-1 min-w-0 break-words"
            title={`Settimana dal ${days[0].label} al ${days[days.length - 1].label}`}
          >
            <span className="hidden sm:inline">Settimana dal {days[0].label} al {days[days.length - 1].label}</span>
            <span className="sm:hidden">
              {days[0].dayNameShort} {days[0].dayNum} {days[0].monthNameShort} – {days[days.length - 1].dayNameShort} {days[days.length - 1].dayNum} {days[days.length - 1].monthNameShort}
            </span>
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-between sm:justify-end">
          {circularEventsCount > 0 && (
            <div className="flex items-center bg-stone-100 p-0.5 rounded-lg text-xs">
              <button
                onClick={() => setFilterMode("ALL")}
                className={`px-2.5 py-2 rounded-md font-medium transition-colors ${
                  filterMode === "ALL" ? "bg-white text-stone-900 shadow-2xs" : "text-stone-600 hover:text-stone-900"
                }`}
              >
                Tutti
              </button>
              <button
                onClick={() => setFilterMode("CIRCULARS")}
                className={`px-2.5 py-2 rounded-md font-medium flex items-center gap-1 transition-colors ${
                  filterMode === "CIRCULARS" ? "bg-amber-600 text-white shadow-2xs" : "text-amber-800 hover:text-amber-950"
                }`}
              >
                <FileText className="w-3 h-3" />
                <span>Da Circolari ({circularEventsCount})</span>
              </button>
            </div>
          )}

          {isProvisionalTimetable && (
            <span
              className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs font-semibold bg-amber-50 text-amber-900 border border-amber-300"
              title="Orario provvisorio per i primi giorni di scuola attivo"
            >
              <Clock className="w-3.5 h-3.5 text-amber-700" />
              <span>Provvisorio</span>
            </span>
          )}

          <label className="inline-flex items-center gap-2 text-xs text-stone-600 cursor-pointer select-none min-h-[44px] px-1 rounded-lg hover:bg-stone-50">
            <input
              type="checkbox"
              checked={includeSaturday}
              onChange={(e) => setIncludeSaturday(e.target.checked)}
              className="rounded-sm text-emerald-700 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
            />
            <span className="font-medium">Includi Sabato</span>
            {isSsig && (
              <span className="text-[10px] text-stone-400 font-normal hidden md:inline">
                (Default SSIG: settimana corta)
              </span>
            )}
          </label>
        </div>
      </div>

      {/* Week Grid: horizontal snap cards on phones, multi-column grid as soon as width allows */}
      <div className="week-scroller" data-days={daysCount}>
        {days.map((day) => {
          // Lessons for this day of week
          const dayLessons = timetable
            .filter((slot) => slot.dayOfWeek === day.dayOfWeek)
            .sort((a, b) => a.periodNumber - b.periodNumber);

          // Events on this specific date
          const rawDayEvents = events.filter((e) => e.date === day.iso);
          const dayEvents = (
            filterMode === "CIRCULARS"
              ? rawDayEvents.filter((e) => e.sourceType === "circolare")
              : rawDayEvents
          ).sort((a, b) => (a.startTime || "00:00").localeCompare(b.startTime || "00:00"));

          return (
            <div
              key={day.iso}
              className={`week-day-card rounded-xl border flex flex-col bg-white transition-all shadow-2xs ${
                day.isTarget
                  ? "border-amber-500 ring-2 ring-amber-500/40"
                  : day.isToday
                  ? "border-emerald-500 ring-2 ring-emerald-500/20"
                  : "border-stone-200"
              }`}
            >
              {/* Day Header */}
              <div
                className={`p-3 border-b text-center rounded-t-xl ${
                  day.isTarget
                    ? "bg-amber-600 text-white"
                    : day.isToday
                    ? "bg-emerald-700 text-white"
                    : "bg-stone-50 text-stone-800 border-stone-100"
                }`}
              >
                <span className="block text-xs font-semibold uppercase tracking-wider">{day.label}</span>
                {day.isToday && (
                  <span className="inline-block mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/20 text-white">
                    OGGI
                  </span>
                )}
                {day.isTarget && !day.isToday && (
                  <span className="inline-block mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/20 text-white">
                    SELEZIONATO
                  </span>
                )}
              </div>

              {/* Day Content */}
              <div className="p-2 flex-1 flex flex-col space-y-3">
                {/* Lessons Block */}
                <div>
                  <div className="flex items-center justify-between text-[11px] font-semibold text-stone-500 mb-1.5 px-1">
                    <span className="flex items-center">
                      <BookOpen className="w-3 h-3 mr-1 text-emerald-700" />
                      Orario lezioni ({dayLessons.length}h)
                    </span>
                  </div>

                  {dayLessons.length === 0 ? (
                    <div className="text-[11px] text-stone-400 italic text-center py-2 bg-stone-50/50 rounded-md">
                      Nessuna lezione
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {dayLessons.map((slot) => {
                        const summary = coTeachingSummary(slot);
                        return (
                          <div
                            key={slot.id}
                            className="p-2 rounded-lg border border-emerald-100 bg-emerald-50/40 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-bold text-emerald-950 shrink-0">{slot.periodNumber}ª</span>
                                <span className="font-semibold text-stone-900 truncate min-w-0 flex-1">
                                  {slot.subject}
                                </span>
                                <span className="text-[10px] font-semibold px-1 py-0.5 rounded bg-white text-stone-600 border border-stone-200 shrink-0">
                                  {slot.className}
                                </span>
                              </div>
                              <div className="text-[10px] text-stone-500 mt-1 truncate">
                                {slot.startTime}–{slot.endTime}
                                {slot.classroom ? ` • ${slot.classroom}` : ""}
                              </div>
                              {summary && (
                                <span
                                  className="block truncate text-[10px] text-emerald-800 leading-tight mt-0.5"
                                  title={summary}
                                >
                                  {summary}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Events Block */}
                <div className="flex-1 flex flex-col">
                  <div className="flex items-center justify-between text-[11px] font-semibold text-stone-500 mb-1.5 px-1">
                    <span className="flex items-center">
                      <Calendar className="w-3 h-3 mr-1 text-purple-700" />
                      Impegni ({dayEvents.length})
                    </span>
                    <button
                      onClick={() => onOpenNewEvent(day.iso)}
                      className="text-emerald-700 hover:text-emerald-900 p-0.5 rounded-xs"
                      title="Aggiungi impegno per questo giorno"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>

                  {dayEvents.length === 0 ? (
                    <div className="text-[11px] text-stone-400 italic text-center py-3 bg-stone-50/30 rounded-md flex-1">
                      Libero
                    </div>
                  ) : (
                    <div className="space-y-1.5 flex-1">
                      {dayEvents.map((ev) => (
                        <div
                          key={ev.id}
                          onClick={() => onEditEvent(ev)}
                          className={`p-2 rounded-lg border text-xs cursor-pointer hover:shadow-xs transition-shadow space-y-1 group relative ${getCategoryBorder(
                            ev.category
                          )}`}
                        >
                          <div className="flex items-start justify-between gap-1">
                            <div className="font-semibold line-clamp-2 leading-tight flex-1">{ev.title}</div>
                            {onDeleteEvent && (
                              <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                                {confirmingDeleteEventId === ev.id ? (
                                  <div className="flex items-center space-x-1 bg-rose-50 border border-rose-300 p-0.5 rounded-md text-[10px]">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        onDeleteEvent(ev.id);
                                        setConfirmingDeleteEventId(null);
                                      }}
                                      className="px-1.5 py-0.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded"
                                      title="Conferma eliminazione"
                                    >
                                      Elimina
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmingDeleteEventId(null)}
                                      className="px-1 text-stone-600 hover:text-stone-900"
                                      title="Annulla"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmingDeleteEventId(ev.id)}
                                    className="opacity-70 sm:opacity-40 group-hover:opacity-100 p-1.5 text-stone-400 hover:text-rose-600 hover:bg-rose-50 active:bg-rose-100 rounded transition-all"
                                    title="Elimina impegno"
                                    aria-label="Elimina impegno"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>

                          {ev.sourceType === "circolare" && (
                            <div className="flex items-center space-x-1 text-[10px] text-amber-800 font-medium truncate">
                              <FileText className="w-3 h-3 flex-shrink-0 text-amber-600" />
                              <span className="truncate">Da Circolare</span>
                            </div>
                          )}

                          <div className="flex items-center space-x-1 text-[10px] opacity-80">
                            <Clock className="w-3 h-3 flex-shrink-0" />
                            <span>
                              {ev.isAllDay ? "Tutto il giorno" : `${ev.startTime || "15:00"} - ${ev.endTime || "16:30"}`}
                            </span>
                          </div>
                          {ev.location && (
                            <div className="flex items-center space-x-1 text-[10px] opacity-80 truncate">
                              <MapPin className="w-3 h-3 flex-shrink-0" />
                              <span className="truncate">{ev.location}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="md:hidden text-[10px] text-stone-400 text-center -mt-2">Scorri lateralmente per vedere tutti i giorni della settimana &rarr;</p>
    </div>
  );
};
