import { getReferenceMonday } from "../utils/weekNavigation";
import { localDateISO } from "../utils/dates";
import React, { useState, useEffect } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Clock,
  MapPin,
  Plus,
  BookOpen,
  Calendar,
  FileText,
  Trash2,
} from "lucide-react";
import { CalendarEvent, TeacherProfile, TimetableSlot, TimetableType } from "../types";
import { coTeachingSummary } from "../utils/coTeaching";
import type { ScheduledAssessmentCalendarItem } from "../utils/scheduledAssessmentCalendar";
import { scheduledAssessmentTypeLabel } from "../utils/scheduledAssessmentCalendar";
import { readWeeklyCollapse, writeWeeklyCollapse, type CollapseGroup } from "../utils/collapsePreferences";

interface WeekViewProps {
  profile?: TeacherProfile;
  timetable: TimetableSlot[];
  events: CalendarEvent[];
  isProvisionalTimetable?: boolean;
  onOpenNewEvent: (initialDate?: string) => void;
  onEditEvent: (event: CalendarEvent) => void;
  onDeleteEvent?: (id: string) => void;
  targetDateIso?: string;
  scheduledAssessments?: ScheduledAssessmentCalendarItem[];
  onOpenScheduledAssessment?: (studentId: string) => void;
  /**
   * Apre la modifica DIRETTA di una lezione dell'orario (tap sulla card).
   * Come in Oggi il tipo orario NON è dedotto da `slot.isProvisional`: la
   * fonte autorevole arriva da App (`activeType` dell'orario visualizzato,
   * passata tramite `timetableType`) e la data è il `day.iso` DEL GIORNO
   * VISUALIZZATO (è ciò che permette il ritorno alla stessa settimana).
   */
  onOpenTimetableSlotForEdit?: (slot: TimetableSlot, type: TimetableType, dateIso: string) => void;
  /** Orario a cui appartiene l'array `timetable` (da App: activeType). */
  timetableType?: TimetableType;
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
  scheduledAssessments = [],
  onOpenScheduledAssessment,
  onOpenTimetableSlotForEdit,
  timetableType,
}) => {
  const [currentWeekOffset, setCurrentWeekOffset] = useState<number>(0);
  
  // Per i docenti del SSIG (Scuola Secondaria di I Grado), la settimana corta è lo standard:
  // "inclusi sabato" viene impostato di default SENZA spunta (false).
  const isSsig = profile?.schoolLevel === "ssig";
  const [includeSaturday, setIncludeSaturday] = useState<boolean>(!isSsig);
  const [filterMode, setFilterMode] = useState<"ALL" | "CIRCULARS">("ALL");
  const [collapsed, setCollapsed] = useState(() => readWeeklyCollapse());
  const toggleCollapse = (group: CollapseGroup) => setCollapsed(previous => { const next = { ...previous, [group]: !previous[group] }; writeWeeklyCollapse(next); return next; });
  const [confirmingDeleteEventId, setConfirmingDeleteEventId] = useState<string | null>(null);

  // Aggiorna la selezione di default se il profilo cambia livello a SSIG
  useEffect(() => {
    if (profile?.schoolLevel === "ssig") {
      setIncludeSaturday(false);
    }
  }, [profile?.schoolLevel]);

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

  // Compare local reference Mondays, not a rounded distance from today's date.
  const isCurrentWeek = monday.getTime() === getReferenceMonday(now, true).getTime();

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

  // Tipo orario della richiesta di modifica: fonte autorevole da App
  // (timetableType = activeType dell'orario visualizzato). Per i chiamanti
  // legacy che passano solo il flag storico, quel flag arriva comunque da App
  // e descrive lo stesso array; mai `slot.isProvisional`.
  const lessonType: TimetableType =
    timetableType ?? (isProvisionalTimetable ? "provvisorio" : "definitivo");

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
      case "uscita_didattica":
        return "border-sky-300 bg-sky-50 text-sky-900";
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
        {/*
          Mobile: la riga di navigazione (← "Questa Settimana" →) e l'intervallo date
          sono contenitori separati, così il testo della settimana non comprime mai i
          pulsanti e non può sovrapporsi alle frecce. Da sm in su, dove lo spazio basta,
          stanno sulla stessa riga (con wrap di sicurezza alle larghezze intermedie).
        */}
        <div id="week-header-controls" className="flex min-w-0 flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-1.5 lg:gap-2">
          <div id="week-navigation" className="flex items-center gap-1.5 sm:gap-2 shrink-0" role="group" aria-label="Navigazione della settimana">
            <button
              onClick={() => setCurrentWeekOffset((prev) => prev - 1)}
              className="group min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-stone-600"
              title="Settimana precedente"
              aria-label="Settimana precedente"
            >
              <span className="w-[30px] h-[30px] inline-flex items-center justify-center rounded-lg border border-stone-200/60 text-stone-500 group-hover:bg-stone-50 group-active:bg-stone-100 transition-colors"><ChevronLeft className="w-[18px] h-[18px]" /></span>
            </button>
            {/* Pulsante "Questa settimana" con semantica verde/ambra */}
            <button
              onClick={() => setCurrentWeekOffset(0)}
              aria-pressed={isCurrentWeek}
              disabled={isCurrentWeek}
              className={`inline-flex items-center px-3 py-2 min-h-[44px] rounded-lg border text-xs font-semibold transition-colors ${isCurrentWeek
                ? "border-emerald-600 bg-emerald-100 text-emerald-900"
                : "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"}`}
            >
              {isWeekendToday ? "Settimana Entrante" : "Questa Settimana"}
            </button>
            <button
              onClick={() => setCurrentWeekOffset((prev) => prev + 1)}
              className="group min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-stone-600"
              title="Settimana successiva"
              aria-label="Settimana successiva"
            >
              <span className="w-[30px] h-[30px] inline-flex items-center justify-center rounded-lg border border-stone-200/60 text-stone-500 group-hover:bg-stone-50 group-active:bg-stone-100 transition-colors"><ChevronRight className="w-[18px] h-[18px]" /></span>
            </button>
          </div>
          <span
            id="week-range"
            className="text-xs sm:text-sm font-semibold text-stone-800 min-w-0 break-words leading-snug sm:ml-1"
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
          const dayScheduled = scheduledAssessments.filter(item => item.date === day.iso);
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
                  <button type="button" aria-expanded={!collapsed.timetable} className="flex min-h-[44px] w-full items-center justify-between text-[11px] font-semibold text-stone-500 mb-1.5 px-1" onClick={() => toggleCollapse("timetable")}><span className="flex items-center"><BookOpen className="w-3 h-3 mr-1 text-emerald-700" />Orario lezioni ({dayLessons.length}h)</span>{collapsed.timetable ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button>

                  {!collapsed.timetable && <>
                  {dayLessons.length === 0 ? (
                    <div className="text-[11px] text-stone-400 italic text-center py-2 bg-stone-50/50 rounded-md">
                      Nessuna lezione
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {dayLessons.map((slot) => {
                        const summary = coTeachingSummary(slot);
                        const lessonBody = (
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
                        );
                        // Con il callback di modifica la card diventa
                        // semanticamente interattiva: button a larghezza piena,
                        // touch target comodo, focus visibile, stessa estetica.
                        // Il marker `data-slot-cell="lesson"` la identifica
                        // (stesso attributo delle card di Oggi; qui lo swipe
                        // non esiste e il tap passa il `day.iso` del giorno
                        // visualizzato, base del ritorno alla settimana).
                        if (onOpenTimetableSlotForEdit) {
                          return (
                            <button
                              key={slot.id}
                              type="button"
                              data-slot-cell="lesson"
                              aria-label={`Modifica la lezione: ${slot.subject}, classe ${slot.className}, ${slot.periodNumber}\u00aa ora (${slot.startTime}\u2013${slot.endTime})`}
                              onClick={() => onOpenTimetableSlotForEdit(slot, lessonType, day.iso)}
                              className="block w-full min-h-[44px] text-left p-2 rounded-lg border border-emerald-100 bg-emerald-50/40 text-xs hover:border-emerald-300 active:border-emerald-400 focus-visible:outline-2 focus-visible:outline-emerald-600 focus-visible:outline-offset-2 transition-colors"
                            >
                              {lessonBody}
                            </button>
                          );
                        }
                        return (
                          <div
                            key={slot.id}
                            className="p-2 rounded-lg border border-emerald-100 bg-emerald-50/40 text-xs"
                          >
                            {lessonBody}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  </>}
                </div>

                {/* Derived scheduled assessments: never persisted as CalendarEvent. */}
                <div className="mb-2"><button type="button" aria-expanded={!collapsed.scheduledAssessments} className="flex min-h-[44px] w-full items-center justify-between px-1 text-[11px] font-bold text-amber-900" onClick={() => toggleCollapse("scheduledAssessments")}><span>Prove programmate ({dayScheduled.length})</span>{collapsed.scheduledAssessments ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button>{!collapsed.scheduledAssessments && dayScheduled.length > 0 && <div className="space-y-1.5">{dayScheduled.map(item => <button key={`scheduled-${item.id}`} type="button" onClick={() => onOpenScheduledAssessment?.(item.studentId)} className="w-full min-h-[72px] rounded-lg border border-amber-300 bg-amber-50 p-2 text-left text-xs"><span className="block font-bold uppercase text-amber-900">Prova programmata</span><span className="block font-semibold text-stone-900">{item.studentName}</span><span className="block text-stone-700">{item.subject || "Materia non indicata"} · {scheduledAssessmentTypeLabel[item.assessmentType]}</span>{item.topic && <span className="block truncate font-semibold text-stone-900">{item.topic}</span>}</button>)}</div>}</div>

                {/* Events Block */}
                <div className="flex-1 flex flex-col">
                  <button type="button" aria-expanded={!collapsed.commitments} className="flex min-h-[44px] w-full items-center justify-between text-[11px] font-semibold text-stone-500 mb-1.5 px-1" onClick={() => toggleCollapse("commitments")}><span className="flex items-center"><Calendar className="w-3 h-3 mr-1 text-purple-700" />Impegni ({dayEvents.length})</span>{collapsed.commitments ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} </button><div className={collapsed.commitments ? "hidden" : ""}>
                    <button
                      onClick={() => onOpenNewEvent(day.iso)}
                      className="text-emerald-700 hover:text-emerald-900 p-0.5 rounded-xs"
                      title="Aggiungi impegno per questo giorno"
                    >
                      <Plus className="w-3 h-3" />
                    </button>

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
            </div>
          );
        })}
      </div>
      <p className="md:hidden text-[10px] text-stone-400 text-center -mt-2">Scorri lateralmente per vedere tutti i giorni della settimana &rarr;</p>
    </div>
  );
};
