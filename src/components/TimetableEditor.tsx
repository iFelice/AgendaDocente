import { usePersistenceAction } from "../hooks/usePersistenceAction";
import React, { useState, useRef, useMemo } from "react";
import {
  Clock,
  MapPin,
  Plus,
  Trash2,
  Calendar,
  Copy,
  Info,
  Check,
  AlertCircle,
  X,
  Settings2,
  Sliders,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  TeacherProfile,
  TimeSlotConfig,
  TimetableMode,
  TimetableSlot,
  TimetableType,
} from "../types";
import {
  DEFAULT_PERIOD_SLOTS,
  generateDefaultPeriodSlots,
  getEffectivePeriodSlots,
  normalizeClassName,
} from "../utils/timeSlots";

interface TimetableEditorProps {
  profile: TeacherProfile;
  definitiveTimetable: TimetableSlot[];
  provisionalTimetable: TimetableSlot[];
  timetableMode: TimetableMode;
  activeType: TimetableType;
  isDefinitiveCompiled: boolean;
  timeSlotConfig?: TimeSlotConfig;
  onSaveSlot: (
    slot: TimetableSlot,
    type: TimetableType,
    expected?: TimetableSlot
  ) => void | false | Promise<void | false>;
  onDeleteSlot: (
    id: string,
    type: TimetableType
  ) => void | false | Promise<void | false>;
  onSetTimetableMode: (mode: TimetableMode) => void;
  onCopyProvisionalToDefinitive: () => void;
  onCopyDefinitiveToProvisional: () => void;
  onClearTimetable: (type: TimetableType) => void;
  onSaveProfile?: (
    profile: TeacherProfile,
    expected?: TeacherProfile
  ) => void | false | Promise<void | false>;
  onSaveTimeSlotConfig?: (
    config: TimeSlotConfig
  ) => void | false | Promise<void | false>;
}

export const TimetableEditor: React.FC<TimetableEditorProps> = ({
  profile,
  definitiveTimetable = [],
  provisionalTimetable = [],
  timetableMode = "auto",
  activeType = "provvisorio",
  isDefinitiveCompiled = false,
  timeSlotConfig,
  onSaveSlot,
  onDeleteSlot,
  onSetTimetableMode,
  onCopyProvisionalToDefinitive,
  onCopyDefinitiveToProvisional,
  onClearTimetable,
  onSaveProfile,
  onSaveTimeSlotConfig,
}) => {
  const save = usePersistenceAction();
  const editBaseline = useRef<TimetableSlot | undefined>(undefined);

  // If definitive is not compiled, default tab to provisional
  const [activeTab, setActiveTab] = useState<TimetableType>(
    !isDefinitiveCompiled ? "provvisorio" : "definitivo"
  );
  const [editingSlot, setEditingSlot] = useState<TimetableSlot | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Class selection state
  const [isAddingNewClass, setIsAddingNewClass] = useState(false);
  const [newClassNameInput, setNewClassNameInput] = useState("");
  const [classAddError, setClassAddError] = useState<string | null>(null);

  // Time slot settings modal/drawer
  const [isSlotConfigOpen, setIsSlotConfigOpen] = useState(false);
  const [firstHourTime, setFirstHourTime] = useState(
    timeSlotConfig?.firstHourStartTime || "07:50"
  );
  const [periodsCount, setPeriodsCount] = useState(
    timeSlotConfig?.periodsPerDay || 6
  );
  const [periodDuration, setPeriodDuration] = useState(
    timeSlotConfig?.standardDurationMinutes || 60
  );
  const [customSlotsDraft, setCustomSlotsDraft] = useState(
    () => getEffectivePeriodSlots(timeSlotConfig)
  );
  const [showAdvancedSlots, setShowAdvancedSlots] = useState(false);

  // Mobile selected day filter for compact view
  const [mobileSelectedDay, setMobileSelectedDay] = useState<number | "all">("all");

  // Per i docenti SSIG, "inclusi sabato" viene impostato di default senza spunta
  const isSsig = profile?.schoolLevel === "ssig";
  const [includeSaturday, setIncludeSaturday] = useState<boolean>(!isSsig);

  const currentSlots =
    activeTab === "provvisorio" ? provisionalTimetable : definitiveTimetable;

  // Effective period slots calculated from config
  const periods = useMemo(
    () => getEffectivePeriodSlots(timeSlotConfig),
    [timeSlotConfig]
  );

  const days: { day: 1 | 2 | 3 | 4 | 5 | 6; label: string; short: string }[] = [
    { day: 1, label: "Lunedì", short: "Lun" },
    { day: 2, label: "Martedì", short: "Mar" },
    { day: 3, label: "Mercoledì", short: "Mer" },
    { day: 4, label: "Giovedì", short: "Gio" },
    { day: 5, label: "Venerdì", short: "Ven" },
    ...(includeSaturday
      ? [{ day: 6 as const, label: "Sabato", short: "Sab" }]
      : []),
  ];

  // Open Add slot modal prefilled with the selected day and period
  const handleOpenAdd = (day: 1 | 2 | 3 | 4 | 5 | 6, periodNum: number) => {
    const periodConf = periods.find((p) => p.periodNumber === periodNum) || periods[0] || {
      periodNumber: 1,
      startTime: "08:15",
      endTime: "09:10",
    };
    editBaseline.current = undefined;
    setIsAddingNewClass(false);
    setNewClassNameInput("");
    setClassAddError(null);

    const initialClass =
      profile.classes && profile.classes.length > 0 ? profile.classes[0] : "";

    setEditingSlot({
      id: `tt-${Date.now()}`,
      dayOfWeek: day,
      periodNumber: periodConf.periodNumber,
      startTime: periodConf.startTime,
      endTime: periodConf.endTime,
      subject: (profile.primarySubjects && profile.primarySubjects[0]) || "",
      className: initialClass,
      classroom: "",
      campus: (profile.campuses && profile.campuses[0]) || "",
      isProvisional: activeTab === "provvisorio",
    });
    setIsModalOpen(true);
  };

  const handleEditSlot = (slot: TimetableSlot) => {
    editBaseline.current = slot;
    setIsAddingNewClass(false);
    setNewClassNameInput("");
    setClassAddError(null);
    setEditingSlot({ ...slot, isProvisional: activeTab === "provvisorio" });
    setIsModalOpen(true);
  };

  // When changing period number in modal, automatically update start & end times
  const handlePeriodChange = (newPeriodNum: number) => {
    if (!editingSlot) return;
    const periodConf = periods.find((p) => p.periodNumber === newPeriodNum);
    if (periodConf) {
      setEditingSlot({
        ...editingSlot,
        periodNumber: newPeriodNum,
        startTime: periodConf.startTime,
        endTime: periodConf.endTime,
      });
    } else {
      setEditingSlot({
        ...editingSlot,
        periodNumber: newPeriodNum,
      });
    }
  };

  // Add a new class to profile and immediately select it
  const handleAddNewClassToProfile = async () => {
    const normalized = normalizeClassName(newClassNameInput);
    if (!normalized) {
      setClassAddError("Inserisci un nome per la classe (es. 1A, 2E).");
      return;
    }

    const currentClasses = profile.classes || [];
    const exists = currentClasses.some(
      (c) => normalizeClassName(c) === normalized
    );

    if (exists) {
      // If already exists, just select it
      if (editingSlot) {
        setEditingSlot({ ...editingSlot, className: normalized });
      }
      setIsAddingNewClass(false);
      setNewClassNameInput("");
      setClassAddError(null);
      return;
    }

    const updatedClasses = [...currentClasses, normalized];
    const updatedProfile: TeacherProfile = {
      ...profile,
      classes: updatedClasses,
    };

    if (onSaveProfile) {
      const result = await onSaveProfile(updatedProfile);
      if (result === false) {
        setClassAddError("Impossibile salvare la nuova classe nel profilo.");
        return;
      }
    }

    if (editingSlot) {
      setEditingSlot({ ...editingSlot, className: normalized });
    }
    setIsAddingNewClass(false);
    setNewClassNameInput("");
    setClassAddError(null);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSlot) return;
    if (!editingSlot.className.trim()) {
      setClassAddError("Seleziona o aggiungi una classe.");
      return;
    }
    if (!await save.run(() => onSaveSlot(editingSlot, activeTab, editBaseline.current))) return;
    setIsModalOpen(false);
    setEditingSlot(null);
  };

  // Open config drawer and sync draft state
  const handleOpenSlotConfig = () => {
    const effective = getEffectivePeriodSlots(timeSlotConfig);
    setFirstHourTime(timeSlotConfig?.firstHourStartTime || effective[0]?.startTime || "07:50");
    setPeriodsCount(timeSlotConfig?.periodsPerDay || effective.length || 6);
    setPeriodDuration(timeSlotConfig?.standardDurationMinutes || 60);
    setCustomSlotsDraft(effective);
    setIsSlotConfigOpen(true);
  };

  // Generate standard slots from firstHourTime, periodsCount, periodDuration
  const handleAutoGenerateSlots = () => {
    const generated = generateDefaultPeriodSlots(
      firstHourTime,
      periodsCount,
      periodDuration
    );
    setCustomSlotsDraft(generated);
  };

  // Save the new slot config
  const handleSaveSlotConfig = async () => {
    const newConfig: TimeSlotConfig = {
      firstHourStartTime: firstHourTime,
      periodsPerDay: periodsCount,
      standardDurationMinutes: periodDuration,
      customSlots: customSlotsDraft,
    };

    if (onSaveTimeSlotConfig) {
      await onSaveTimeSlotConfig(newConfig);
    }
    setIsSlotConfigOpen(false);
  };

  return (
    <div className="space-y-6 pb-12 max-w-full overflow-x-hidden">
      {save.error && (
        <p role="alert" className="p-3 text-sm text-rose-700 bg-rose-50 rounded-xl border border-rose-200">
          {save.error}
        </p>
      )}

      {/* Header with Title, Slot Config trigger & Mode Selector */}
      <div className="bg-white rounded-xl p-4 sm:p-5 border border-stone-200 shadow-xs flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <span className="text-xs font-semibold text-emerald-800 uppercase tracking-wider">
            Gestione Cattedra & Lezioni
          </span>
          <h1 className="text-xl sm:text-2xl font-bold text-stone-900 mt-0.5">
            Orario delle Lezioni
          </h1>
          <p className="text-xs sm:text-sm text-stone-500 mt-1">
            Gestisci l'orario provvisorio (primi giorni) e l'orario definitivo a regime con fasce orarie configurabili.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* Button to configure Time Slots (Fasce Orarie) */}
          <button
            type="button"
            onClick={handleOpenSlotConfig}
            className="inline-flex items-center px-3 py-2 text-xs font-semibold rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-stone-700 shadow-2xs transition-colors"
            title="Configura ora di inizio, durata e fasce orarie"
          >
            <Sliders className="w-4 h-4 mr-1.5 text-emerald-700" />
            <span>Fasce Orarie</span>
          </button>

          {/* Global Timetable Display Mode Selector */}
          <div className="bg-stone-50 border border-stone-200 rounded-xl p-1.5 sm:p-2 flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-stone-600 hidden sm:inline whitespace-nowrap">
              Planning:
            </span>
            <div className="inline-flex rounded-lg bg-stone-200/70 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => onSetTimetableMode("auto")}
                className={`px-2.5 py-1.5 rounded-md font-semibold transition-all text-xs ${
                  timetableMode === "auto"
                    ? "bg-white text-stone-900 shadow-xs"
                    : "text-stone-600 hover:text-stone-900"
                }`}
                title="Automatica (provvisorio se definitivo non compilato)"
              >
                Auto
              </button>
              <button
                type="button"
                onClick={() => onSetTimetableMode("provvisorio")}
                className={`px-2.5 py-1.5 rounded-md font-semibold transition-all text-xs ${
                  timetableMode === "provvisorio"
                    ? "bg-amber-600 text-white shadow-xs"
                    : "text-stone-600 hover:text-stone-900"
                }`}
                title="Forza provvisorio"
              >
                Provvisorio
              </button>
              <button
                type="button"
                onClick={() => onSetTimetableMode("definitivo")}
                className={`px-2.5 py-1.5 rounded-md font-semibold transition-all text-xs ${
                  timetableMode === "definitivo"
                    ? "bg-emerald-700 text-white shadow-xs"
                    : "text-stone-600 hover:text-stone-900"
                }`}
                title="Forza definitivo"
              >
                Definitivo
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Segmented Tab Navigation: Provvisorio vs Definitivo */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Tab 1: Provvisorio */}
        <button
          type="button"
          onClick={() => setActiveTab("provvisorio")}
          className={`p-4 rounded-xl border text-left transition-all ${
            activeTab === "provvisorio"
              ? "bg-amber-50/70 border-amber-400 ring-2 ring-amber-300 shadow-sm"
              : "bg-white border-stone-200 hover:border-stone-300 shadow-2xs"
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Clock
                className={`w-5 h-5 ${
                  activeTab === "provvisorio" ? "text-amber-700" : "text-stone-500"
                }`}
              />
              <h2 className="text-sm font-bold text-stone-900">Orario Provvisorio</h2>
            </div>
            {activeType === "provvisorio" && (
              <span className="px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-bold bg-amber-200/80 text-amber-950 border border-amber-300">
                ATTIVO
              </span>
            )}
          </div>
          <p className="text-xs text-stone-600 mt-1.5">
            Primi giorni di scuola • <strong>{provisionalTimetable.length} ore</strong>
          </p>
          {!isDefinitiveCompiled && (
            <p className="text-[11px] text-amber-800 font-medium mt-1">
              Visualizzato di default perché il definitivo non è ancora compilato.
            </p>
          )}
        </button>

        {/* Tab 2: Definitivo */}
        <button
          type="button"
          onClick={() => setActiveTab("definitivo")}
          className={`p-4 rounded-xl border text-left transition-all ${
            activeTab === "definitivo"
              ? "bg-emerald-50/70 border-emerald-500 ring-2 ring-emerald-300 shadow-sm"
              : "bg-white border-stone-200 hover:border-stone-300 shadow-2xs"
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Calendar
                className={`w-5 h-5 ${
                  activeTab === "definitivo" ? "text-emerald-700" : "text-stone-500"
                }`}
              />
              <h2 className="text-sm font-bold text-stone-900">Orario Definitivo</h2>
            </div>
            {isDefinitiveCompiled ? (
              activeType === "definitivo" ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
                  ATTIVO
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-semibold bg-stone-100 text-stone-700 border border-stone-200">
                  {definitiveTimetable.length} ore
                </span>
              )
            ) : (
              <span className="px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-bold bg-rose-100 text-rose-900 border border-rose-300">
                DA COMPILARE
              </span>
            )}
          </div>
          <p className="text-xs text-stone-600 mt-1.5">
            Orario di cattedra a regime •{" "}
            <strong>{definitiveTimetable.length} ore</strong>
          </p>
          {!isDefinitiveCompiled && (
            <p className="text-[11px] text-rose-700 font-medium mt-1">
              Compila le ore o copia dal provvisorio.
            </p>
          )}
        </button>
      </div>

      {/* Helper Banner for uncompiled definitive */}
      {!isDefinitiveCompiled && activeTab === "provvisorio" && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-2xs">
          <div className="flex items-start space-x-3">
            <Info className="w-5 h-5 text-amber-700 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-bold text-amber-950">
                Orario Provvisorio attivo di default
              </h3>
              <p className="text-xs text-amber-900 mt-0.5">
                Le lezioni in <strong>Oggi</strong> e <strong>Settimana</strong> mostrano questo orario provvisorio finché il definitivo non sarà compilato.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onCopyProvisionalToDefinitive()}
            className="px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white text-xs font-bold rounded-lg transition-colors flex items-center space-x-1 whitespace-nowrap self-stretch sm:self-auto justify-center"
          >
            <Copy className="w-3.5 h-3.5 mr-1" />
            <span>Copia in Definitivo</span>
          </button>
        </div>
      )}

      {/* Grid Action Toolbar */}
      <div className="bg-white rounded-xl p-4 border border-stone-200 shadow-xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center space-x-2">
          <span className="font-bold text-sm text-stone-900">
            {activeTab === "provvisorio" ? "Griglia Provvisorio" : "Griglia Definitivo"}
          </span>
          <span className="text-xs font-semibold px-2 py-0.5 bg-stone-100 text-stone-700 rounded-full">
            {currentSlots.length} ore
          </span>
        </div>

        <div className="flex items-center space-x-3 flex-wrap gap-2 justify-between sm:justify-end">
          {/* Include Saturday toggle */}
          <label className="flex items-center space-x-2 text-xs text-stone-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeSaturday}
              onChange={(e) => setIncludeSaturday(e.target.checked)}
              className="rounded-sm text-emerald-700 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
            />
            <span className="font-medium">Includi Sabato</span>
          </label>

          {/* Transfer hours between timetables */}
          {activeTab === "definitivo" && (
            <button
              type="button"
              onClick={() => onCopyDefinitiveToProvisional()}
              className="px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100 rounded-lg border border-stone-200 transition-colors flex items-center"
              title="Copia l'orario definitivo nell'orario provvisorio"
            >
              <Copy className="w-3.5 h-3.5 mr-1" />
              <span>Copia in Provvisorio</span>
            </button>
          )}

          {/* Clear Current Timetable */}
          {showClearConfirm ? (
            <div className="flex items-center space-x-1.5 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg">
              <span className="text-xs font-semibold text-rose-800">Svuotare?</span>
              <button
                type="button"
                onClick={() => {
                  setShowClearConfirm(false);
                  onClearTimetable(activeTab);
                }}
                className="px-2 py-0.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded"
              >
                Sì
              </button>
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                className="px-2 py-0.5 bg-white border border-stone-300 text-stone-700 text-xs rounded"
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowClearConfirm(true)}
              className="px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 rounded-lg border border-rose-200 transition-colors flex items-center"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              <span>Svuota</span>
            </button>
          )}
        </div>
      </div>

      {/* Mobile Day Filter Tabs (visible on small screens for easy navigation) */}
      <div className="flex sm:hidden overflow-x-auto pb-1 gap-1.5 text-xs">
        <button
          type="button"
          onClick={() => setMobileSelectedDay("all")}
          className={`px-3 py-1.5 rounded-lg font-medium whitespace-nowrap transition-colors ${
            mobileSelectedDay === "all"
              ? "bg-emerald-700 text-white shadow-xs"
              : "bg-white border border-stone-200 text-stone-700"
          }`}
        >
          Tutti i giorni
        </button>
        {days.map((d) => (
          <button
            key={d.day}
            type="button"
            onClick={() => setMobileSelectedDay(d.day)}
            className={`px-3 py-1.5 rounded-lg font-medium whitespace-nowrap transition-colors ${
              mobileSelectedDay === d.day
                ? "bg-emerald-700 text-white shadow-xs"
                : "bg-white border border-stone-200 text-stone-700"
            }`}
          >
            {d.short}
          </button>
        ))}
      </div>

      {/* Timetable Matrix Table (Scrollable on mobile without body overflow) */}
      <div className="bg-white rounded-xl border border-stone-200 shadow-xs overflow-x-auto max-w-full">
        <table className="w-full text-left border-collapse min-w-[620px]">
          <thead>
            <tr className="bg-stone-50 border-b border-stone-200 text-stone-700 text-xs font-semibold uppercase">
              <th className="p-3 w-28 text-center border-r border-stone-200 bg-stone-50 sticky left-0 z-10">
                Campana
              </th>
              {days
                .filter((d) => mobileSelectedDay === "all" || mobileSelectedDay === d.day)
                .map((d) => (
                  <th
                    key={d.day}
                    className="p-3 text-center border-r border-stone-200 last:border-r-0 min-w-[110px]"
                  >
                    {d.label}
                  </th>
                ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 text-xs">
            {periods.map((p) => (
              <tr key={p.periodNumber} className="hover:bg-stone-50/50 transition-colors">
                <td className="p-3 text-center border-r border-stone-200 bg-stone-50/80 sticky left-0 z-10 shadow-2xs">
                  <div className="font-bold text-stone-900">{p.label || `${p.periodNumber}ª Ora`}</div>
                  <div className="text-[10px] text-stone-500 mt-0.5 font-mono">
                    {p.startTime} – {p.endTime}
                  </div>
                </td>

                {days
                  .filter((d) => mobileSelectedDay === "all" || mobileSelectedDay === d.day)
                  .map((d) => {
                    const slot = currentSlots.find(
                      (s) =>
                        s.dayOfWeek === d.day &&
                        s.periodNumber === p.periodNumber
                    );

                    return (
                      <td
                        key={d.day}
                        className="p-2 border-r border-stone-100 last:border-r-0 align-top h-24 relative group"
                      >
                        {slot ? (
                          <div
                            onClick={() => handleEditSlot(slot)}
                            className={`h-full w-full p-2 rounded-lg border cursor-pointer transition-all flex flex-col justify-between shadow-2xs hover:shadow-xs ${
                              activeTab === "provvisorio"
                                ? "border-amber-300 bg-amber-50/80 hover:bg-amber-100"
                                : "border-emerald-200 bg-emerald-50/70 hover:bg-emerald-100"
                            }`}
                          >
                            <div>
                              <div className="flex items-center justify-between">
                                <span
                                  className={`font-bold text-xs ${
                                    activeTab === "provvisorio"
                                      ? "text-amber-950"
                                      : "text-emerald-950"
                                  }`}
                                >
                                  {slot.className}
                                </span>
                                <span className="text-[10px] text-stone-500 font-mono">
                                  {slot.startTime}
                                </span>
                              </div>
                              <span className="font-medium text-stone-800 text-[11px] block truncate mt-0.5">
                                {slot.subject}
                              </span>
                            </div>
                            <div className="flex items-center space-x-1 text-[10px] text-stone-500 truncate mt-1">
                              <MapPin className="w-3 h-3 text-stone-400 flex-shrink-0" />
                              <span className="truncate">
                                {slot.classroom || slot.campus || "Centrale"}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleOpenAdd(d.day, p.periodNumber)}
                            className="w-full h-full min-h-[44px] rounded-lg border border-dashed border-stone-200 hover:border-emerald-400 hover:bg-emerald-50/40 text-stone-400 hover:text-emerald-700 transition-colors flex items-center justify-center text-xs"
                            title={`Aggiungi lezione ${d.label} ${p.label || `${p.periodNumber}ª ora`}`}
                          >
                            <Plus className="w-4 h-4 opacity-40 group-hover:opacity-100 transition-opacity" />
                          </button>
                        )}
                      </td>
                    );
                  })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Edit/Add Slot Modal */}
      {isModalOpen && editingSlot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-900/40 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-md w-full p-5 sm:p-6 shadow-xl border border-stone-200 animate-in fade-in zoom-in-95 my-auto max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-stone-100">
              <div>
                <h3 className="text-base font-bold text-stone-900">
                  {editingSlot.id.startsWith("tt-") &&
                  !currentSlots.some((s) => s.id === editingSlot.id)
                    ? "Aggiungi Ora di Lezione"
                    : "Modifica Ora di Lezione"}
                </h3>
                <span
                  className={`text-[11px] font-semibold ${
                    activeTab === "provvisorio"
                      ? "text-amber-700"
                      : "text-emerald-700"
                  }`}
                >
                  {activeTab === "provvisorio"
                    ? "🕒 Orario Provvisorio"
                    : "📅 Orario Definitivo"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="space-y-4 mt-4 text-xs">
              {save.error && (
                <p role="alert" className="text-sm text-rose-700 bg-rose-50 p-2 rounded-lg">
                  {save.error}
                </p>
              )}

              {/* Day & Period Selection (Primary Mental Model) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-stone-700 mb-1">
                    Giorno della settimana
                  </label>
                  <select
                    value={editingSlot.dayOfWeek}
                    onChange={(e) =>
                      setEditingSlot({
                        ...editingSlot,
                        dayOfWeek: Number(e.target.value) as any,
                      })
                    }
                    className="w-full p-2.5 border border-stone-300 rounded-lg text-xs bg-white text-stone-900 min-h-[42px]"
                  >
                    {days.map((d) => (
                      <option key={d.day} value={d.day}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-stone-700 mb-1">
                    Numero dell'ora
                  </label>
                  <select
                    value={editingSlot.periodNumber}
                    onChange={(e) => handlePeriodChange(Number(e.target.value))}
                    className="w-full p-2.5 border border-stone-300 rounded-lg text-xs bg-white text-stone-900 min-h-[42px]"
                  >
                    {periods.map((p) => (
                      <option key={p.periodNumber} value={p.periodNumber}>
                        {p.label || `${p.periodNumber}ª Ora`} ({p.startTime} – {p.endTime})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Class Selection via Dropdown (with + Aggiungi classe) */}
              <div className="space-y-2">
                <label className="block font-medium text-stone-700">
                  Classe <span className="text-rose-500">*</span>
                </label>

                {!isAddingNewClass ? (
                  <div className="flex items-center gap-2">
                    <select
                      value={editingSlot.className}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "__ADD_NEW__") {
                          setIsAddingNewClass(true);
                          setNewClassNameInput("");
                          setClassAddError(null);
                        } else {
                          setEditingSlot({ ...editingSlot, className: val });
                          setClassAddError(null);
                        }
                      }}
                      className="w-full p-2.5 border border-stone-300 rounded-lg text-xs bg-white text-stone-900 min-h-[42px]"
                    >
                      <option value="" disabled>
                        Seleziona una classe...
                      </option>
                      {(profile.classes || []).map((cls) => (
                        <option key={cls} value={cls}>
                          {cls}
                        </option>
                      ))}
                      {/* If the current slot className is not in profile.classes, keep it in select */}
                      {editingSlot.className &&
                        !(profile.classes || []).includes(editingSlot.className) && (
                          <option value={editingSlot.className}>
                            {editingSlot.className}
                          </option>
                        )}
                      <option disabled>────────────</option>
                      <option value="__ADD_NEW__">+ Aggiungi classe...</option>
                    </select>

                    <button
                      type="button"
                      onClick={() => {
                        setIsAddingNewClass(true);
                        setNewClassNameInput("");
                        setClassAddError(null);
                      }}
                      className="px-3 py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-lg text-xs font-semibold whitespace-nowrap min-h-[42px]"
                      title="Aggiungi una nuova classe"
                    >
                      <Plus className="w-4 h-4 inline mr-1" />
                      Nuova
                    </button>
                  </div>
                ) : (
                  <div className="p-3 bg-emerald-50/70 border border-emerald-300 rounded-xl space-y-2">
                    <span className="text-[11px] font-bold text-emerald-900 block">
                      Aggiungi nuova classe al profilo:
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        autoFocus
                        value={newClassNameInput}
                        onChange={(e) => setNewClassNameInput(e.target.value.toUpperCase())}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleAddNewClassToProfile();
                          }
                        }}
                        placeholder="es. 1A, 2E, 3B"
                        className="flex-1 p-2 border border-emerald-300 rounded-lg text-xs bg-white uppercase font-bold"
                      />
                      <button
                        type="button"
                        onClick={() => void handleAddNewClassToProfile()}
                        className="px-3 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-bold whitespace-nowrap shadow-xs"
                      >
                        Aggiungi
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsAddingNewClass(false);
                          setClassAddError(null);
                        }}
                        className="px-2.5 py-2 text-stone-600 hover:text-stone-900 text-xs"
                      >
                        Annulla
                      </button>
                    </div>
                  </div>
                )}

                {classAddError && (
                  <p className="text-[11px] text-rose-600 font-medium">{classAddError}</p>
                )}
              </div>

              {/* Subject Input */}
              <div>
                <label className="block font-medium text-stone-700 mb-1">
                  Materia <span className="text-rose-500">*</span>
                </label>
                <div className="space-y-1.5">
                  <input
                    type="text"
                    required
                    value={editingSlot.subject}
                    onChange={(e) =>
                      setEditingSlot({ ...editingSlot, subject: e.target.value })
                    }
                    placeholder="es. Scienze motorie, Matematica, Sostegno"
                    className="w-full p-2.5 border border-stone-300 rounded-lg text-xs min-h-[42px]"
                  />
                  {profile.primarySubjects && profile.primarySubjects.length > 0 && (
                    <div className="flex flex-wrap gap-1 items-center pt-0.5">
                      <span className="text-[10px] text-stone-400">Suggerite:</span>
                      {profile.primarySubjects.map((sub) => (
                        <button
                          key={sub}
                          type="button"
                          onClick={() =>
                            setEditingSlot({ ...editingSlot, subject: sub })
                          }
                          className="text-[10px] px-2 py-0.5 rounded bg-stone-100 hover:bg-stone-200 text-stone-700"
                        >
                          {sub}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Start Time & End Time (Derived automatically, still editable for custom cases) */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block font-medium text-stone-700 mb-1">
                    Ora Inizio
                  </label>
                  <input
                    type="time"
                    required
                    value={editingSlot.startTime}
                    onChange={(e) =>
                      setEditingSlot({ ...editingSlot, startTime: e.target.value })
                    }
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs font-mono min-h-[42px]"
                  />
                </div>

                <div>
                  <label className="block font-medium text-stone-700 mb-1">
                    Ora Fine
                  </label>
                  <input
                    type="time"
                    required
                    value={editingSlot.endTime}
                    onChange={(e) =>
                      setEditingSlot({ ...editingSlot, endTime: e.target.value })
                    }
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs font-mono min-h-[42px]"
                  />
                </div>
              </div>

              {/* Classroom & Campus */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-stone-700 mb-1">
                    Aula / Spazio
                  </label>
                  <input
                    type="text"
                    value={editingSlot.classroom || ""}
                    onChange={(e) =>
                      setEditingSlot({ ...editingSlot, classroom: e.target.value })
                    }
                    placeholder="es. Palestra A, Aula 12"
                    className="w-full p-2.5 border border-stone-300 rounded-lg text-xs min-h-[42px]"
                  />
                </div>

                <div>
                  <label className="block font-medium text-stone-700 mb-1">
                    Plesso / Sede
                  </label>
                  <input
                    type="text"
                    value={editingSlot.campus || ""}
                    onChange={(e) =>
                      setEditingSlot({ ...editingSlot, campus: e.target.value })
                    }
                    placeholder="es. Centrale, Succursale"
                    className="w-full p-2.5 border border-stone-300 rounded-lg text-xs min-h-[42px]"
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-4 border-t border-stone-100 gap-2">
                {currentSlots.some((s) => s.id === editingSlot.id) ? (
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        !await save.run(() =>
                          onDeleteSlot(editingSlot.id, activeTab)
                        )
                      )
                        return;
                      setIsModalOpen(false);
                    }}
                    className="text-rose-600 hover:text-rose-800 text-xs font-semibold flex items-center p-2 rounded-lg hover:bg-rose-50 transition-colors"
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    Elimina ora
                  </button>
                ) : (
                  <div />
                )}

                <div className="flex space-x-2">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-3 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg min-h-[42px]"
                  >
                    Annulla
                  </button>
                  <button
                    type="submit"
                    disabled={save.pending}
                    className={`px-4 py-2 text-xs font-semibold text-white rounded-lg shadow-xs transition-colors min-h-[42px] ${
                      activeTab === "provvisorio"
                        ? "bg-amber-700 hover:bg-amber-800"
                        : "bg-emerald-700 hover:bg-emerald-800"
                    }`}
                  >
                    Salva in {activeTab === "provvisorio" ? "Provvisorio" : "Definitivo"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Time Slot Configuration Drawer / Modal */}
      {isSlotConfigOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-900/40 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-lg w-full p-5 sm:p-6 shadow-xl border border-stone-200 animate-in fade-in zoom-in-95 my-auto max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-stone-100">
              <div className="flex items-center space-x-2">
                <Sliders className="w-5 h-5 text-emerald-700" />
                <h3 className="text-base font-bold text-stone-900">
                  Configurazione Fasce Orarie
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsSlotConfigOpen(false)}
                className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 mt-4 text-xs">
              <p className="text-stone-600 leading-relaxed">
                Imposta i parametri della scansione oraria della scuola per generare automaticamente le fasce delle lezioni.
              </p>

              {/* Generator Parameters */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 bg-stone-50 rounded-xl border border-stone-200">
                <div>
                  <label className="block font-medium text-stone-700 mb-1">
                    Inizio 1ª Ora
                  </label>
                  <input
                    type="time"
                    value={firstHourTime}
                    onChange={(e) => setFirstHourTime(e.target.value)}
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs font-mono bg-white"
                  />
                </div>

                <div>
                  <label className="block font-medium text-stone-700 mb-1">
                    Nº Ore Giornaliere
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={periodsCount}
                    onChange={(e) => setPeriodsCount(Number(e.target.value))}
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs bg-white"
                  />
                </div>

                <div>
                  <label className="block font-medium text-stone-700 mb-1">
                    Durata (minuti)
                  </label>
                  <input
                    type="number"
                    min="30"
                    max="120"
                    step="5"
                    value={periodDuration}
                    onChange={(e) => setPeriodDuration(Number(e.target.value))}
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs bg-white"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleAutoGenerateSlots}
                  className="px-3 py-1.5 bg-stone-200 hover:bg-stone-300 text-stone-800 rounded-lg text-xs font-semibold transition-colors"
                >
                  ⚡ Rigenera fasce automatiche ({firstHourTime} • {periodsCount} ore da {periodDuration}m)
                </button>
              </div>

              {/* Advanced Customization Toggle */}
              <div className="border-t border-stone-100 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAdvancedSlots(!showAdvancedSlots)}
                  className="flex items-center justify-between w-full py-1 text-xs font-bold text-stone-700 hover:text-stone-900"
                >
                  <span>Personalizzazione avanzata singole fasce</span>
                  {showAdvancedSlots ? (
                    <ChevronUp className="w-4 h-4 text-stone-500" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-stone-500" />
                  )}
                </button>

                {showAdvancedSlots && (
                  <div className="mt-2 space-y-2 max-h-56 overflow-y-auto pr-1">
                    <p className="text-[11px] text-stone-500 mb-2">
                      Puoi modificare manualmente l'inizio e la fine di ciascuna ora per gestire ricreazioni, intervalli o ore ridotte.
                    </p>
                    {customSlotsDraft.map((slot, index) => (
                      <div
                        key={slot.periodNumber}
                        className="flex items-center gap-2 p-2 bg-stone-50 rounded-lg border border-stone-200"
                      >
                        <span className="w-16 font-bold text-stone-700 shrink-0">
                          {slot.periodNumber}ª Ora
                        </span>
                        <input
                          type="time"
                          value={slot.startTime}
                          onChange={(e) => {
                            const val = e.target.value;
                            setCustomSlotsDraft((prev) =>
                              prev.map((s, i) =>
                                i === index ? { ...s, startTime: val } : s
                              )
                            );
                          }}
                          className="p-1.5 border border-stone-300 rounded text-xs font-mono bg-white w-24"
                        />
                        <span className="text-stone-400">–</span>
                        <input
                          type="time"
                          value={slot.endTime}
                          onChange={(e) => {
                            const val = e.target.value;
                            setCustomSlotsDraft((prev) =>
                              prev.map((s, i) =>
                                i === index ? { ...s, endTime: val } : s
                              )
                            );
                          }}
                          className="p-1.5 border border-stone-300 rounded text-xs font-mono bg-white w-24"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setCustomSlotsDraft((prev) =>
                              prev
                                .filter((_, i) => i !== index)
                                .map((s, i) => ({ ...s, periodNumber: i + 1, label: `${i + 1}ª Ora` }))
                            );
                          }}
                          className="p-1 text-stone-400 hover:text-rose-600 ml-auto"
                          title="Rimuovi questa ora"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}

                    <button
                      type="button"
                      onClick={() => {
                        const nextNum = customSlotsDraft.length + 1;
                        const lastSlot = customSlotsDraft[customSlotsDraft.length - 1];
                        const start = lastSlot ? lastSlot.endTime : "08:00";
                        const end = generateDefaultPeriodSlots(start, 1, periodDuration)[0].endTime;
                        setCustomSlotsDraft((prev) => [
                          ...prev,
                          {
                            periodNumber: nextNum,
                            label: `${nextNum}ª Ora`,
                            startTime: start,
                            endTime: end,
                          },
                        ]);
                      }}
                      className="inline-flex items-center text-xs font-semibold text-emerald-700 hover:text-emerald-800 p-1"
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      Aggiungi ulteriore ora
                    </button>
                  </div>
                )}
              </div>

              {/* Preview of Effective Slots */}
              <div className="bg-emerald-50/50 rounded-xl p-3 border border-emerald-200 text-xs">
                <span className="font-bold text-emerald-950 block mb-1">
                  Anteprima scansione oraria ({customSlotsDraft.length} ore):
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {customSlotsDraft.map((s) => (
                    <span
                      key={s.periodNumber}
                      className="px-2 py-0.5 bg-white border border-emerald-300 text-emerald-900 rounded font-medium text-[11px]"
                    >
                      {s.periodNumber}ª: {s.startTime}–{s.endTime}
                    </span>
                  ))}
                </div>
              </div>

              {/* Drawer Footer */}
              <div className="flex justify-end space-x-2 pt-3 border-t border-stone-100">
                <button
                  type="button"
                  onClick={() => setIsSlotConfigOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg min-h-[42px]"
                >
                  Annulla
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveSlotConfig()}
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg shadow-xs transition-colors min-h-[42px]"
                >
                  Salva Fasce Orarie
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
