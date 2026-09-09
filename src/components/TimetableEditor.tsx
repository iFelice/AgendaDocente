import { usePersistenceAction } from "../hooks/usePersistenceAction";
import React, { useState, useRef } from "react";
import {
  Clock,
  MapPin,
  Plus,
  RotateCcw,
  Trash2,
  BookOpen,
  Calendar,
  Copy,
  Info,
  Check,
  AlertCircle,
  X,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { TeacherProfile, TimetableMode, TimetableSlot, TimetableType } from "../types";

interface TimetableEditorProps {
  profile: TeacherProfile;
  definitiveTimetable: TimetableSlot[];
  provisionalTimetable: TimetableSlot[];
  timetableMode: TimetableMode;
  activeType: TimetableType;
  isDefinitiveCompiled: boolean;
  onSaveSlot: (slot: TimetableSlot, type: TimetableType, expected?: TimetableSlot) => void | false | Promise<void | false>;
  onDeleteSlot: (id: string, type: TimetableType) => void | false | Promise<void | false>;
  onSetTimetableMode: (mode: TimetableMode) => void;
  onCopyProvisionalToDefinitive: () => void;
  onCopyDefinitiveToProvisional: () => void;
  onClearTimetable: (type: TimetableType) => void;
  onResetProvisional: () => void;
  onResetDefinitive: () => void;
  // Optional legacy props
  timetable?: TimetableSlot[];
  onResetTimetable?: () => void;
}

export const TimetableEditor: React.FC<TimetableEditorProps> = ({
  profile,
  definitiveTimetable = [],
  provisionalTimetable = [],
  timetableMode = "auto",
  activeType = "provvisorio",
  isDefinitiveCompiled = false,
  onSaveSlot,
  onDeleteSlot,
  onSetTimetableMode,
  onCopyProvisionalToDefinitive,
  onCopyDefinitiveToProvisional,
  onClearTimetable,
  onResetProvisional,
  onResetDefinitive,
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
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Per i docenti SSIG, "inclusi sabato" viene impostato di default senza spunta
  const isSsig = profile?.schoolLevel === "ssig";
  const [includeSaturday, setIncludeSaturday] = useState<boolean>(!isSsig);

  const currentSlots = activeTab === "provvisorio" ? provisionalTimetable : definitiveTimetable;

  // Standard bell periods configuration
  const periods = [
    { period: 1, label: "1ª Ora", defaultStart: "08:15", defaultEnd: "09:10" },
    { period: 2, label: "2ª Ora", defaultStart: "09:10", defaultEnd: "10:05" },
    { period: 3, label: "3ª Ora", defaultStart: "10:15", defaultEnd: "11:10" },
    { period: 4, label: "4ª Ora", defaultStart: "11:15", defaultEnd: "12:10" },
    { period: 5, label: "5ª Ora", defaultStart: "12:15", defaultEnd: "13:10" },
    { period: 6, label: "6ª Ora", defaultStart: "13:10", defaultEnd: "14:05" },
  ];

  const days: { day: 1 | 2 | 3 | 4 | 5 | 6; label: string }[] = [
    { day: 1, label: "Lunedì" },
    { day: 2, label: "Martedì" },
    { day: 3, label: "Mercoledì" },
    { day: 4, label: "Giovedì" },
    { day: 5, label: "Venerdì" },
    ...(includeSaturday ? [{ day: 6 as const, label: "Sabato" }] : []),
  ];

  const handleOpenAdd = (day: 1 | 2 | 3 | 4 | 5 | 6, periodNum: number) => {
    const periodConf = periods.find((p) => p.period === periodNum);
    editBaseline.current = undefined;
    setEditingSlot({
      id: `tt-${Date.now()}`,
      dayOfWeek: day,
      periodNumber: periodNum,
      startTime: periodConf?.defaultStart || "08:15",
      endTime: periodConf?.defaultEnd || "09:10",
      subject: profile.primarySubjects[0] || "Scienze motorie",
      className: profile.classes[0] || "1A",
      classroom: "Palestra",
      campus: profile.campuses[0] || "Centrale",
      isProvisional: activeTab === "provvisorio",
    });
    setIsModalOpen(true);
  };

  const handleEditSlot = (slot: TimetableSlot) => {
    editBaseline.current = slot;
    setEditingSlot({ ...slot, isProvisional: activeTab === "provvisorio" });
    setIsModalOpen(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSlot) return;
    if (!await save.run(() => onSaveSlot(editingSlot, activeTab, editBaseline.current))) return;
    setIsModalOpen(false);
    setEditingSlot(null);
  };

  return (
    <div className="space-y-6 pb-12">
      {save.error && <p role="alert" className="p-3 text-sm text-rose-700">{save.error}</p>}
        {/* Header with Title & Mode Selector */}
      <div className="bg-white rounded-xl p-5 border border-stone-200 shadow-xs flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <span className="text-xs font-semibold text-emerald-800 uppercase tracking-wider">
            Gestione Cattedra & Lezioni
          </span>
          <h1 className="text-2xl font-bold text-stone-900 mt-0.5">Orario delle Lezioni</h1>
          <p className="text-sm text-stone-500 mt-1">
            Gestisci sia l'orario provvisorio per i primi giorni di scuola, sia l'orario definitivo a regime.
          </p>
        </div>

        {/* Global Timetable Display Mode Selector */}
        <div className="bg-stone-50 border border-stone-200 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-2">
          <span className="text-xs font-semibold text-stone-700 whitespace-nowrap">
            Visualizzazione nei planning:
          </span>
          <div className="inline-flex rounded-lg bg-stone-200/70 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => onSetTimetableMode("auto")}
              className={`px-3 py-1.5 rounded-md font-semibold transition-all ${
                timetableMode === "auto"
                  ? "bg-white text-stone-900 shadow-xs"
                  : "text-stone-600 hover:text-stone-900"
              }`}
              title="Mostra provvisorio se definitivo non compilato, altrimenti definitivo"
            >
              🤖 Automatica
            </button>
            <button
              type="button"
              onClick={() => onSetTimetableMode("provvisorio")}
              className={`px-3 py-1.5 rounded-md font-semibold transition-all ${
                timetableMode === "provvisorio"
                  ? "bg-amber-600 text-white shadow-xs"
                  : "text-stone-600 hover:text-stone-900"
              }`}
              title="Forza visualizzazione orario provvisorio (primi giorni)"
            >
              🕒 Provvisorio
            </button>
            <button
              type="button"
              onClick={() => onSetTimetableMode("definitivo")}
              className={`px-3 py-1.5 rounded-md font-semibold transition-all ${
                timetableMode === "definitivo"
                  ? "bg-emerald-700 text-white shadow-xs"
                  : "text-stone-600 hover:text-stone-900"
              }`}
              title="Forza visualizzazione orario definitivo"
            >
              📅 Definitivo
            </button>
          </div>
        </div>
      </div>

      {/* Segmented Tab Navigation: Provvisorio vs Definitivo */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
              <Clock className={`w-5 h-5 ${activeTab === "provvisorio" ? "text-amber-700" : "text-stone-500"}`} />
              <h2 className="text-sm font-bold text-stone-900">Orario Provvisorio</h2>
            </div>
            {activeType === "provvisorio" && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-200/80 text-amber-950 border border-amber-300">
                ATTIVO NEI PLANNING
              </span>
            )}
          </div>
          <p className="text-xs text-stone-600 mt-1.5">
            Primi giorni di scuola • <strong>{provisionalTimetable.length} ore</strong> impostate
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
              <Calendar className={`w-5 h-5 ${activeTab === "definitivo" ? "text-emerald-700" : "text-stone-500"}`} />
              <h2 className="text-sm font-bold text-stone-900">Orario Definitivo</h2>
            </div>
            {isDefinitiveCompiled ? (
              activeType === "definitivo" ? (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
                  ATTIVO NEI PLANNING
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-stone-100 text-stone-700 border border-stone-200">
                  Compilato ({definitiveTimetable.length} ore)
                </span>
              )
            ) : (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 text-rose-900 border border-rose-300">
                NON ANCORA COMPILATO
              </span>
            )}
          </div>
          <p className="text-xs text-stone-600 mt-1.5">
            Orario di cattedra a regime •{" "}
            <strong>{definitiveTimetable.length} ore</strong> impostate
          </p>
          {!isDefinitiveCompiled && (
            <p className="text-[11px] text-rose-700 font-medium mt-1">
              Attualmente vuoto: compila le ore o copia dal provvisorio.
            </p>
          )}
        </button>
      </div>

      {/* Smart Helper Banner based on Active Tab & Compilation state */}
      {!isDefinitiveCompiled && activeTab === "provvisorio" && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-2xs">
          <div className="flex items-start space-x-3">
            <Info className="w-5 h-5 text-amber-700 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-bold text-amber-950">
                Orario Provvisorio attivo di default per i primi giorni
              </h3>
              <p className="text-xs text-amber-900 mt-0.5">
                L'orario definitivo non è compilato. Tutte le lezioni in <strong>Oggi</strong> e <strong>Settimana</strong> mostrano automaticamente questo orario provvisorio.
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => onCopyProvisionalToDefinitive()}
              className="px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white text-xs font-bold rounded-lg transition-colors flex items-center space-x-1"
              title="Copia queste ore nell'orario definitivo"
            >
              <Copy className="w-3.5 h-3.5 mr-1" />
              <span>Copia in Definitivo</span>
            </button>
          </div>
        </div>
      )}

      {!isDefinitiveCompiled && activeTab === "definitivo" && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-2xs">
          <div className="flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-rose-600 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-bold text-rose-950">
                Orario Definitivo non ancora compilato
              </h3>
              <p className="text-xs text-rose-800 mt-0.5">
                Finché non inserisci le ore definitive, l'applicazione continuerà a mostrare di default l'orario provvisorio nei primi giorni di scuola.
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2 flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onCopyProvisionalToDefinitive()}
              className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition-colors flex items-center space-x-1"
            >
              <Copy className="w-3.5 h-3.5 mr-1" />
              <span>Copia da Provvisorio</span>
            </button>
            <button
              type="button"
              onClick={() => onResetDefinitive()}
              className="px-3 py-1.5 bg-white border border-stone-300 hover:bg-stone-100 text-stone-800 text-xs font-semibold rounded-lg transition-colors"
            >
              Carica standard 18h
            </button>
          </div>
        </div>
      )}

      {/* Grid Action Toolbar */}
      <div className="bg-white rounded-xl p-4 border border-stone-200 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center space-x-2">
          <span className="font-bold text-sm text-stone-900">
            {activeTab === "provvisorio" ? "Griglia Orario Provvisorio" : "Griglia Orario Definitivo"}
          </span>
          <span className="text-xs font-semibold px-2 py-0.5 bg-stone-100 text-stone-700 rounded-full">
            {currentSlots.length} ore assegnate
          </span>
        </div>

        <div className="flex items-center space-x-3 flex-wrap gap-2">
          {/* Include Saturday toggle */}
          <label className="flex items-center space-x-2 text-xs text-stone-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeSaturday}
              onChange={(e) => setIncludeSaturday(e.target.checked)}
              className="rounded-sm text-emerald-700 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
            />
            <span className="font-medium">Includi Sabato</span>
            {isSsig && (
              <span className="text-[10px] text-stone-400 font-normal hidden sm:inline">
                (Default SSIG: senza spunta)
              </span>
            )}
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

          {/* Clear Current Timetable (allows user to easily test fallback to provisional) */}
          {showClearConfirm ? (
            <div className="flex items-center space-x-1.5 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg">
              <span className="text-xs font-semibold text-rose-800">Svuotare orario?</span>
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
              title={
                activeTab === "definitivo"
                  ? "Svuota l'orario definitivo per attivare automaticamente l'orario provvisorio di default"
                  : "Svuota orario provvisorio"
              }
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              <span>Svuota</span>
            </button>
          )}

          {/* Reset demo */}
          {showResetConfirm ? (
            <div className="flex items-center space-x-1.5 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-lg">
              <span className="text-xs font-semibold text-emerald-800">Caricare demo?</span>
              <button
                type="button"
                onClick={() => {
                  setShowResetConfirm(false);
                  if (activeTab === "provvisorio") onResetProvisional();
                  else onResetDefinitive();
                }}
                className="px-2 py-0.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded"
              >
                Sì
              </button>
              <button
                type="button"
                onClick={() => setShowResetConfirm(false)}
                className="px-2 py-0.5 bg-white border border-stone-300 text-stone-700 text-xs rounded"
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              className="px-2.5 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-100 rounded-lg border border-stone-200 transition-colors flex items-center"
              title="Ripristina orario demo predefinito"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1" />
              <span>Demo</span>
            </button>
          )}
        </div>
      </div>

      {/* Timetable Matrix */}
      <div className="bg-white rounded-xl border border-stone-200 shadow-xs overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[700px]">
          <thead>
            <tr className="bg-stone-50 border-b border-stone-200 text-stone-700 text-xs font-semibold uppercase">
              <th className="p-3 w-28 text-center border-r border-stone-200">Campana</th>
              {days.map((d) => (
                <th key={d.day} className="p-3 text-center border-r border-stone-200 last:border-r-0">
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 text-xs">
            {periods.map((p) => (
              <tr key={p.period} className="hover:bg-stone-50/50 transition-colors">
                <td className="p-3 text-center border-r border-stone-200 bg-stone-50/40">
                  <div className="font-bold text-stone-900">{p.label}</div>
                  <div className="text-[10px] text-stone-500 mt-0.5">
                    {p.defaultStart} - {p.defaultEnd}
                  </div>
                </td>

                {days.map((d) => {
                  const slot = currentSlots.find(
                    (s) => s.dayOfWeek === d.day && s.periodNumber === p.period
                  );

                  return (
                    <td
                      key={d.day}
                      className="p-2 border-r border-stone-100 last:border-r-0 align-top h-20 relative group"
                    >
                      {slot ? (
                        <div
                          onClick={() => handleEditSlot(slot)}
                          className={`h-full w-full p-2 rounded-lg border cursor-pointer transition-all flex flex-col justify-between ${
                            activeTab === "provvisorio"
                              ? "border-amber-300 bg-amber-50/70 hover:bg-amber-100/80"
                              : "border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/70"
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between">
                              <span
                                className={`font-bold text-xs ${
                                  activeTab === "provvisorio" ? "text-amber-950" : "text-emerald-950"
                                }`}
                              >
                                {slot.className}
                              </span>
                              <span className="text-[10px] text-stone-400 font-mono">
                                {slot.startTime}
                              </span>
                            </div>
                            <span className="font-medium text-stone-800 text-[11px] block truncate">
                              {slot.subject}
                            </span>
                          </div>
                          <div className="flex items-center space-x-1 text-[10px] text-stone-500 truncate mt-1">
                            <MapPin className="w-3 h-3 text-stone-400 flex-shrink-0" />
                            <span className="truncate">{slot.classroom || slot.campus}</span>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleOpenAdd(d.day, p.period)}
                          className={`w-full h-full rounded-lg border border-dashed border-stone-200 hover:border-emerald-400 hover:bg-emerald-50/30 text-stone-400 hover:text-emerald-700 transition-colors flex items-center justify-center text-xs`}
                          title="Aggiungi ora di lezione"
                        >
                          <Plus className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 backdrop-blur-xs">
          <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-xl border border-stone-200 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-3 border-b border-stone-100">
              <div>
                <h3 className="text-base font-bold text-stone-900">
                  {editingSlot.id.startsWith("tt-") && !currentSlots.some((s) => s.id === editingSlot.id)
                    ? "Aggiungi Ora di Lezione"
                    : "Modifica Ora di Lezione"}
                </h3>
                <span
                  className={`text-[11px] font-semibold ${
                    activeTab === "provvisorio" ? "text-amber-700" : "text-emerald-700"
                  }`}
                >
                  {activeTab === "provvisorio" ? "🕒 Orario Provvisorio" : "📅 Orario Definitivo"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1 rounded-md text-stone-400 hover:text-stone-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="space-y-4 mt-4 text-xs">
              {save.error && <p role="alert" className="text-sm text-rose-700">{save.error}</p>}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-stone-700 mb-1">Giorno della settimana</label>
                  <select
                    value={editingSlot.dayOfWeek}
                    onChange={(e) =>
                      setEditingSlot({ ...editingSlot, dayOfWeek: Number(e.target.value) as any })
                    }
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs"
                  >
                    {days.map((d) => (
                      <option key={d.day} value={d.day}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-stone-700 mb-1">Ora / Periodo</label>
                  <select
                    value={editingSlot.periodNumber}
                    onChange={(e) =>
                      setEditingSlot({ ...editingSlot, periodNumber: Number(e.target.value) })
                    }
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs"
                  >
                    {periods.map((p) => (
                      <option key={p.period} value={p.period}>
                        {p.label} ({p.defaultStart} - {p.defaultEnd})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-stone-700 mb-1">Classe</label>
                  <input
                    type="text"
                    required
                    value={editingSlot.className}
                    onChange={(e) =>
                      setEditingSlot({ ...editingSlot, className: e.target.value.toUpperCase() })
                    }
                    placeholder="es. 1A"
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs"
                  />
                </div>

                <div>
                  <label className="block font-medium text-stone-700 mb-1">Materia</label>
                  <input
                    type="text"
                    required
                    value={editingSlot.subject}
                    onChange={(e) => setEditingSlot({ ...editingSlot, subject: e.target.value })}
                    placeholder="es. Scienze motorie"
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-stone-700 mb-1">Ora Inizio</label>
                  <input
                    type="time"
                    value={editingSlot.startTime}
                    onChange={(e) => setEditingSlot({ ...editingSlot, startTime: e.target.value })}
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs"
                  />
                </div>

                <div>
                  <label className="block font-medium text-stone-700 mb-1">Ora Fine</label>
                  <input
                    type="time"
                    value={editingSlot.endTime}
                    onChange={(e) => setEditingSlot({ ...editingSlot, endTime: e.target.value })}
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-stone-700 mb-1">Aula / Spazio</label>
                  <input
                    type="text"
                    value={editingSlot.classroom || ""}
                    onChange={(e) => setEditingSlot({ ...editingSlot, classroom: e.target.value })}
                    placeholder="es. Palestra A"
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs"
                  />
                </div>

                <div>
                  <label className="block font-medium text-stone-700 mb-1">Plesso / Sede</label>
                  <input
                    type="text"
                    value={editingSlot.campus || ""}
                    onChange={(e) => setEditingSlot({ ...editingSlot, campus: e.target.value })}
                    placeholder="es. Centrale"
                    className="w-full p-2 border border-stone-300 rounded-lg text-xs"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-stone-100">
                {currentSlots.some((s) => s.id === editingSlot.id) ? (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!await save.run(() => onDeleteSlot(editingSlot.id, activeTab))) return;
                      setIsModalOpen(false);
                    }}
                    className="text-rose-600 hover:text-rose-800 text-xs font-semibold flex items-center"
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
                    className="px-3 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg"
                  >
                    Annulla
                  </button>
                  <button
                    type="submit" disabled={save.pending}
                    className={`px-4 py-2 text-xs font-semibold text-white rounded-lg shadow-xs transition-colors ${
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
    </div>
  );
};
