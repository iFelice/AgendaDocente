import { localDateISO } from "../utils/dates";
import React, { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight, Clock, MapPin, Plus, FileText, Trash2, Calendar } from "lucide-react";
import { CalendarEvent } from "../types";

interface MonthViewProps {
  events: CalendarEvent[];
  onOpenNewEvent: (initialDate?: string) => void;
  onEditEvent: (event: CalendarEvent) => void;
  onDeleteEvent?: (id: string) => void;
  onNavigateToPlanning?: (dateIso: string, view?: "oggi" | "settimana" | "mese") => void;
  targetDateIso?: string;
}

export const MonthView: React.FC<MonthViewProps> = ({
  events,
  onOpenNewEvent,
  onEditEvent,
  onDeleteEvent,
  onNavigateToPlanning,
  targetDateIso,
}) => {
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [selectedDateIso, setSelectedDateIso] = useState<string>(
    localDateISO()
  );
  const [filterCircularsOnly, setFilterCircularsOnly] = useState<boolean>(false);
  const [confirmingDeleteEventId, setConfirmingDeleteEventId] = useState<string | null>(null);

  // Sync to targetDateIso if supplied
  useEffect(() => {
    if (targetDateIso) {
      const parts = targetDateIso.split("-");
      if (parts.length === 3) {
        const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        setCurrentDate(d);
        setSelectedDateIso(targetDateIso);
      }
    }
  }, [targetDateIso]);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // First day of month
  const firstDayOfMonth = new Date(year, month, 1);
  // Last day of month
  const lastDayOfMonth = new Date(year, month + 1, 0);

  // Month header text
  const monthTitle = new Intl.DateTimeFormat("it-IT", {
    month: "long",
    year: "numeric",
  }).format(currentDate);

  // Adjust for Monday start (0: Sun -> 6, 1: Mon -> 0)
  const startingDayIndex = (firstDayOfMonth.getDay() + 6) % 7;
  const totalDays = lastDayOfMonth.getDate();

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));
  const resetToToday = () => {
    const today = new Date();
    setCurrentDate(today);
    setSelectedDateIso(localDateISO(today));
  };

  const circularEventsCount = events.filter((e) => e.sourceType === "circolare").length;

  // Weekday headers (Lun, Mar, Mer, Gio, Ven, Sab, Dom)
  const weekdays = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

  // Days array
  const daysArray: ({ dayNum: number; iso: string; isCurrentMonth: boolean })[] = [];

  // Padding days from previous month
  const prevMonthLastDay = new Date(year, month, 0).getDate();
  for (let i = startingDayIndex - 1; i >= 0; i--) {
    const dNum = prevMonthLastDay - i;
    const prevDate = new Date(year, month - 1, dNum);
    daysArray.push({
      dayNum: dNum,
      iso: localDateISO(prevDate),
      isCurrentMonth: false,
    });
  }

  // Days of current month
  for (let i = 1; i <= totalDays; i++) {
    const d = new Date(year, month, i);
    daysArray.push({
      dayNum: i,
      iso: localDateISO(d),
      isCurrentMonth: true,
    });
  }

  // Next month padding to fill complete weeks
  const remainingCells = (7 - (daysArray.length % 7)) % 7;
  for (let i = 1; i <= remainingCells; i++) {
    const d = new Date(year, month + 1, i);
    daysArray.push({
      dayNum: i,
      iso: localDateISO(d),
      isCurrentMonth: false,
    });
  }

  const todayIso = localDateISO();

  // Selected date events
  const selectedEvents = events
    .filter((e) => e.date === selectedDateIso)
    .filter((e) => (filterCircularsOnly ? e.sourceType === "circolare" : true))
    .sort((a, b) => (a.startTime || "00:00").localeCompare(b.startTime || "00:00"));

  const getCategoryBadge = (category: string) => {
    switch (category) {
      case "glo":
        return { label: "G.L.O.", color: "bg-emerald-100 text-emerald-900 border-emerald-300" };
      case "pei":
        return { label: "P.E.I.", color: "bg-teal-100 text-teal-900 border-teal-300" };
      case "dipartimento_sostegno":
        return { label: "Dip. Sostegno", color: "bg-emerald-50 text-emerald-800 border-emerald-200" };
      case "consiglio_classe":
        return { label: "CdC", color: "bg-purple-100 text-purple-800 border-purple-200" };
      case "collegio_docenti":
        return { label: "Collegio", color: "bg-blue-100 text-blue-800 border-blue-200" };
      case "scadenza":
        return { label: "Scadenza", color: "bg-rose-100 text-rose-800 border-rose-200" };
      default:
        return { label: category.replace("_", " "), color: "bg-stone-100 text-stone-700 border-stone-200" };
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Month Navigation */}
      <div className="bg-white rounded-xl p-3 sm:p-4 border border-stone-200 shadow-xs flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <h2 className="text-lg sm:text-xl font-bold text-stone-900 capitalize leading-tight">{monthTitle}</h2>
          <button
            onClick={resetToToday}
            className="px-2.5 py-2 text-xs font-semibold rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 min-h-[40px]"
          >
            Oggi
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={prevMonth}
            className="inline-flex items-center justify-center w-[44px] h-[44px] rounded-lg border border-stone-200 hover:bg-stone-50 active:bg-stone-100 text-stone-600 transition-colors"
            title="Mese precedente"
            aria-label="Mese precedente"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={nextMonth}
            className="inline-flex items-center justify-center w-[44px] h-[44px] rounded-lg border border-stone-200 hover:bg-stone-50 active:bg-stone-100 text-stone-600 transition-colors"
            title="Mese successivo"
            aria-label="Mese successivo"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Grid + Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Calendar Grid (2 cols) */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-stone-200 shadow-xs p-4">
          <div className="grid grid-cols-7 gap-1 text-center font-semibold text-xs text-stone-500 mb-2">
            {weekdays.map((wd) => (
              <div key={wd} className="py-1">
                {wd}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {daysArray.map((cell, idx) => {
              const cellEvents = events.filter((e) => e.date === cell.iso);
              const isSelected = selectedDateIso === cell.iso;
              const isToday = todayIso === cell.iso;

              return (
                <button
                  key={`${cell.iso}-${idx}`}
                  onClick={() => setSelectedDateIso(cell.iso)}
                  className={`min-h-[56px] sm:min-h-[75px] p-1 sm:p-2 rounded-lg text-left flex flex-col justify-between border transition-all ${
                    isSelected
                      ? "border-emerald-600 bg-emerald-50/50 shadow-xs ring-1 ring-emerald-600"
                      : isToday
                      ? "border-emerald-400 bg-emerald-50/20"
                      : "border-stone-100 hover:border-stone-200 bg-white"
                  } ${!cell.isCurrentMonth ? "opacity-35" : ""}`}
                >
                  <div className="flex items-center justify-between gap-0.5 min-w-0">
                    <span
                      className={`text-[11px] sm:text-xs font-semibold ${
                        isToday
                          ? "w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-emerald-700 text-white flex items-center justify-center"
                          : isSelected
                          ? "text-emerald-900 font-bold"
                          : "text-stone-800"
                      }`}
                    >
                      {cell.dayNum}
                    </span>
                    {cellEvents.length > 0 && (
                      <span className="text-[9px] sm:text-[10px] px-1 py-px rounded-full font-bold bg-purple-100 text-purple-800">
                        {cellEvents.length}
                      </span>
                    )}
                  </div>

                  {/* Snippets only where there is room (≥sm); phones keep the count pill */}
                  <div className="hidden sm:block space-y-1 mt-1">
                    {cellEvents.slice(0, 2).map((ev) => (
                      <div
                        key={ev.id}
                        className="text-[10px] font-medium truncate px-1 py-0.5 rounded-xs bg-stone-100 text-stone-700"
                      >
                        {ev.title}
                      </div>
                    ))}
                    {cellEvents.length > 2 && (
                      <div className="text-[9px] text-stone-400 pl-1">
                        +{cellEvents.length - 2} altri
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Date Details */}
        <div className="bg-white rounded-xl border border-stone-200 shadow-xs p-5 flex flex-col h-full">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-stone-100">
            <div className="min-w-0">
              <span className="text-xs font-semibold text-emerald-800 uppercase">
                Data Selezionata
              </span>
              <h3 className="text-sm sm:text-base font-bold text-stone-900 mt-0.5 capitalize">
                {new Intl.DateTimeFormat("it-IT", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                }).format(new Date(selectedDateIso + "T12:00:00"))}
              </h3>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {circularEventsCount > 0 && (
                <button
                  onClick={() => setFilterCircularsOnly(!filterCircularsOnly)}
                  className={`px-2 py-2 rounded-lg border text-xs font-semibold flex items-center transition-colors min-h-[40px] ${
                    filterCircularsOnly
                      ? "bg-amber-600 text-white border-amber-600"
                      : "bg-white text-stone-600 border-stone-200 hover:bg-stone-50"
                  }`}
                  title="Filtra solo impegni estratti da circolari"
                >
                  <FileText className="w-3.5 h-3.5 mr-1" />
                  <span>Circolari ({circularEventsCount})</span>
                </button>
              )}
              {onNavigateToPlanning && (
                <button
                  type="button"
                  onClick={() => onNavigateToPlanning(selectedDateIso, "settimana")}
                  className="px-2 py-2 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 hover:text-emerald-800 text-xs font-semibold flex items-center transition-colors shadow-2xs min-h-[40px]"
                  title="Visualizza questa data nella vista Settimana"
                >
                  <Calendar className="w-3.5 h-3.5 mr-1 text-emerald-700" />
                  <span className="hidden sm:inline">Settimana</span>
                </button>
              )}
              <button
                onClick={() => onOpenNewEvent(selectedDateIso)}
                className="inline-flex items-center justify-center w-[44px] h-[44px] rounded-lg bg-emerald-50 text-emerald-800 hover:bg-emerald-100 active:bg-emerald-200 border border-emerald-200 transition-colors"
                title="Aggiungi impegno per questa data"
                aria-label="Aggiungi impegno per questa data"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="mt-4 flex-1 overflow-y-auto space-y-3">
            {selectedEvents.length === 0 ? (
              <div className="py-12 text-center text-stone-400 text-xs">
                {filterCircularsOnly ? "Nessun impegno da circolare in questa data." : "Nessun impegno in questa data."}
                <button
                  onClick={() => onOpenNewEvent(selectedDateIso)}
                  className="block mx-auto mt-2 text-emerald-700 font-semibold hover:underline"
                >
                  + Aggiungi impegno
                </button>
              </div>
            ) : (
              selectedEvents.map((ev) => (
                <div
                  key={ev.id}
                  onClick={() => onEditEvent(ev)}
                  className="p-3 rounded-lg border border-stone-200 hover:border-emerald-300 transition-all cursor-pointer bg-stone-50/40 space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      {(() => {
                        const badge = getCategoryBadge(ev.category);
                        return (
                          <span className={`text-[11px] font-semibold uppercase px-2 py-0.5 rounded-full border ${badge.color}`}>
                            {badge.label}
                          </span>
                        );
                      })()}
                      {ev.className && (
                        <span className="text-xs font-bold text-stone-700 bg-white px-2 py-0.5 rounded-md border border-stone-200">
                          {ev.className}
                        </span>
                      )}
                    </div>

                    {onDeleteEvent && (
                      <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                        {confirmingDeleteEventId === ev.id ? (
                          <div className="flex items-center space-x-1 bg-rose-50 border border-rose-300 px-2 py-0.5 rounded-lg text-xs">
                            <span className="text-[11px] font-bold text-rose-800">Eliminare?</span>
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
                            type="button"
                            onClick={() => setConfirmingDeleteEventId(ev.id)}
                            className="opacity-40 hover:opacity-100 p-1 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-all"
                            title="Elimina impegno"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <h4 className="text-sm font-semibold text-stone-900">{ev.title}</h4>

                  {ev.sourceType === "circolare" && (
                    <div className="flex items-center space-x-1 text-[11px] text-amber-800 font-semibold">
                      <FileText className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                      <span className="truncate">Da Circolare: {ev.sourceCircularTitle || "Scolastica"}</span>
                    </div>
                  )}

                  <div className="flex items-center space-x-3 text-xs text-stone-500">
                    <div className="flex items-center space-x-1">
                      <Clock className="w-3.5 h-3.5" />
                      <span>{ev.isAllDay ? "Tutto il giorno" : `${ev.startTime} - ${ev.endTime}`}</span>
                    </div>
                    {ev.location && (
                      <div className="flex items-center space-x-1 truncate">
                        <MapPin className="w-3.5 h-3.5" />
                        <span className="truncate">{ev.location}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
