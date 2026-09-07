import React, { useState } from "react";
import {
  FileText,
  FileSearch,
  Trash2,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Calendar,
  Clock,
  MapPin,
  ArrowRight,
  Plus,
  RefreshCw,
  Eye,
  EyeOff,
} from "lucide-react";
import { CalendarEvent, CircularDocument, ExtractedItem, TeacherProfile } from "../types";
import { convertExtractedItemToEvent, isCommitmentInEvents } from "../services/storage";

interface CircularsArchiveViewProps {
  circulars: CircularDocument[];
  events: CalendarEvent[];
  profile: TeacherProfile;
  onOpenCircularModal: () => void;
  onDeleteCircular: (id: string) => void;
  onDeleteExtractedItem?: (circularId: string, item: ExtractedItem) => void;
  onAddEventsToPlanning: (newEvents: CalendarEvent[], feedbackTitle?: string) => void;
  onNavigateToPlanning: (dateIso: string, view?: "oggi" | "settimana" | "mese") => void;
}

export const CircularsArchiveView: React.FC<CircularsArchiveViewProps> = ({
  circulars,
  events,
  onOpenCircularModal,
  onDeleteCircular,
  onDeleteExtractedItem,
  onAddEventsToPlanning,
  onNavigateToPlanning,
}) => {
  // Expanded state for circular cards (by default expand the first one if present)
  const [expandedCircularIds, setExpandedCircularIds] = useState<string[]>(
    circulars.length > 0 ? [circulars[0].id] : []
  );
  const [activeFilterByCircId, setActiveFilterByCircId] = useState<Record<string, "ALL" | "RELEVANT" | "UNSYNCED">>({});
  const [showOriginalTextId, setShowOriginalTextId] = useState<string | null>(null);
  const [circularToDelete, setCircularToDelete] = useState<CircularDocument | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedCircularIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  // Helper to format date in Italian
  const formatDateItalian = (dateIso: string) => {
    try {
      const [y, m, d] = dateIso.split("-").map(Number);
      const date = new Date(y, m - 1, d);
      return new Intl.DateTimeFormat("it-IT", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(date);
    } catch {
      return dateIso;
    }
  };

  // Compute global stats
  let totalExtracted = 0;
  let totalInPlanning = 0;
  let totalMissingRelevant = 0;
  const allUnsyncedRelevantEvents: CalendarEvent[] = [];

  circulars.forEach((circ) => {
    const items = circ.extractedItems || [];
    totalExtracted += items.length;
    items.forEach((it) => {
      const inPlan = isCommitmentInEvents(it, events);
      if (inPlan) {
        totalInPlanning++;
      } else {
        if (it.relevance === "VERDE" || it.relevance === "GIALLO") {
          totalMissingRelevant++;
          allUnsyncedRelevantEvents.push(convertExtractedItemToEvent(it, circ.title));
        }
      }
    });
  });

  // Bulk sync all missing relevant commitments across all circulars
  const handleSyncAllMissing = () => {
    if (allUnsyncedRelevantEvents.length === 0) return;
    onAddEventsToPlanning(
      allUnsyncedRelevantEvents,
      `${allUnsyncedRelevantEvents.length} impegni dalle circolari aggiunti al tuo planning!`
    );
  };

  // Sync specific circular
  const handleSyncCircular = (circ: CircularDocument, onlyRelevant: boolean = true) => {
    const items = circ.extractedItems || [];
    const missingItems = items.filter((it) => {
      const inPlan = isCommitmentInEvents(it, events);
      if (inPlan) return false;
      if (onlyRelevant) {
        return it.relevance === "VERDE" || it.relevance === "GIALLO";
      }
      return true;
    });

    if (missingItems.length === 0) return;

    const newEvents = missingItems.map((it) => convertExtractedItemToEvent(it, circ.title));
    onAddEventsToPlanning(
      newEvents,
      `${newEvents.length} impegni della circolare "${circ.title}" aggiunti al planning!`
    );
  };

  // Add a single commitment to planning
  const handleAddSingleItem = (it: ExtractedItem, circTitle: string) => {
    const ev = convertExtractedItemToEvent(it, circTitle);
    onAddEventsToPlanning([ev], `Impegno "${it.title}" aggiunto al tuo planning!`);
  };

  return (
    <div className="space-y-6 pb-16 max-w-7xl mx-auto">
      {/* Header */}
      <div className="bg-white rounded-xl p-5 border border-stone-200 shadow-2xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <span className="text-xs font-semibold text-amber-800 uppercase tracking-wider">
              Archivio Documentale & Planning
            </span>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-200">
              {circulars.length} {circulars.length === 1 ? "circolare" : "circolari"}
            </span>
          </div>
          <h1 className="text-2xl font-bold text-stone-900 mt-1">Circolari & Impegni Individuati</h1>
          <p className="text-sm text-stone-500 mt-1">
            Consulta gli impegni individuati da ciascuna circolare, controlla quali sono già nella tua agenda e sincronizza quelli mancanti nel planning.
          </p>
        </div>

        <button
          onClick={onOpenCircularModal}
          className="inline-flex items-center px-4 py-2.5 rounded-xl text-sm font-semibold bg-emerald-700 hover:bg-emerald-800 text-white transition-colors shadow-2xs self-start sm:self-auto"
        >
          <Sparkles className="w-4 h-4 mr-2" />
          Scansiona o Incolla Circolare
        </button>
      </div>

      {/* Global Sync Alert Banner if commitments are missing */}
      {totalMissingRelevant > 0 && (
        <div className="p-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-950 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-2xs">
          <div className="flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-amber-700 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-bold text-amber-900">
                {totalMissingRelevant} {totalMissingRelevant === 1 ? "impegno pertinente non è ancora nel planning" : "impegni pertinenti non sono ancora nel planning"}
              </h3>
              <p className="text-xs text-amber-800 mt-0.5">
                Hai circolari archiviate con date ed orari individuati che non compaiono ancora nel tuo calendario/agenda. Puoi aggiungerli tutti immediatamente.
              </p>
            </div>
          </div>
          <button
            onClick={handleSyncAllMissing}
            className="px-4 py-2.5 bg-amber-700 hover:bg-amber-800 text-white rounded-lg text-xs font-bold transition-colors whitespace-nowrap shadow-xs flex items-center justify-center self-start sm:self-auto"
          >
            <CheckCircle2 className="w-4 h-4 mr-1.5" />
            Sincronizza tutti nel Planning ({totalMissingRelevant})
          </button>
        </div>
      )}

      {/* Stats Ribbon */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3.5 bg-white rounded-xl border border-stone-200 shadow-2xs">
          <span className="text-xs text-stone-500 font-medium">Circolari Archiviate</span>
          <div className="text-xl font-bold text-stone-900 mt-0.5">{circulars.length}</div>
        </div>
        <div className="p-3.5 bg-white rounded-xl border border-stone-200 shadow-2xs">
          <span className="text-xs text-stone-500 font-medium">Impegni Estratti Totali</span>
          <div className="text-xl font-bold text-stone-900 mt-0.5">{totalExtracted}</div>
        </div>
        <div className="p-3.5 bg-white rounded-xl border border-stone-200 shadow-2xs">
          <span className="text-xs text-stone-500 font-medium">Presenti nel Planning</span>
          <div className="text-xl font-bold text-emerald-800 mt-0.5 flex items-center">
            <CheckCircle2 className="w-4 h-4 mr-1.5 text-emerald-600" />
            {totalInPlanning}
          </div>
        </div>
        <div className="p-3.5 bg-white rounded-xl border border-stone-200 shadow-2xs">
          <span className="text-xs text-stone-500 font-medium">Da Sincronizzare</span>
          <div className={`text-xl font-bold mt-0.5 ${totalMissingRelevant > 0 ? "text-amber-700" : "text-stone-700"}`}>
            {totalMissingRelevant}
          </div>
        </div>
      </div>

      {/* Circulars List */}
      {circulars.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center text-stone-400 space-y-4 shadow-2xs">
          <FileSearch className="w-12 h-12 mx-auto text-stone-300" />
          <div className="max-w-md mx-auto">
            <h3 className="text-base font-semibold text-stone-800">Nessuna circolare archiviata</h3>
            <p className="text-xs text-stone-500 mt-1">
              Carica una circolare in formato PDF, immagine o incolla il testo per estrarre automaticamente collegi, consigli di classe, GLO e scadenze.
            </p>
          </div>
          <button
            onClick={onOpenCircularModal}
            className="px-4 py-2.5 rounded-xl bg-emerald-700 text-white font-semibold text-xs hover:bg-emerald-800 shadow-xs"
          >
            Prova una circolare di esempio
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {circulars.map((circ) => {
            const isExpanded = expandedCircularIds.includes(circ.id);
            const items = circ.extractedItems || [];
            const activeFilter = activeFilterByCircId[circ.id] || "ALL";

            // Count in planning
            const inPlanningCount = items.filter((it) => isCommitmentInEvents(it, events)).length;
            const relevantItems = items.filter((it) => it.relevance === "VERDE" || it.relevance === "GIALLO");
            const unsyncedRelevantCount = relevantItems.filter((it) => !isCommitmentInEvents(it, events)).length;
            const allInPlanning = relevantItems.length > 0 && unsyncedRelevantCount === 0;

            // Filtered items
            const filteredItems = items.filter((it) => {
              const inPlan = isCommitmentInEvents(it, events);
              if (activeFilter === "RELEVANT") return it.relevance === "VERDE" || it.relevance === "GIALLO";
              if (activeFilter === "UNSYNCED") return !inPlan;
              return true;
            });

            return (
              <div
                key={circ.id}
                className="bg-white rounded-xl border border-stone-200 shadow-2xs overflow-hidden transition-all"
              >
                {/* Card Header */}
                <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-stone-50/50 transition-colors">
                  <div
                    onClick={() => toggleExpand(circ.id)}
                    className="flex items-start space-x-3.5 flex-1 cursor-pointer"
                  >
                    <div className="w-11 h-11 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <FileText className="w-5 h-5 text-amber-700" />
                    </div>
                    <div className="space-y-1 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-bold text-stone-900 leading-snug">{circ.title}</h3>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-stone-100 text-stone-600 border border-stone-200">
                          {circ.fileType || "testo"}
                        </span>
                        {allInPlanning ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3 mr-1" />
                            Tutti nel Planning
                          </span>
                        ) : unsyncedRelevantCount > 0 ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                            <AlertCircle className="w-3 h-3 mr-1 text-amber-700" />
                            {unsyncedRelevantCount} da aggiungere al Planning
                          </span>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
                        <span>Data elaborazione: {formatDateItalian(circ.uploadDate)}</span>
                        <span>•</span>
                        <span className="font-semibold text-emerald-800">
                          {relevantItems.length} impegni pertinenti
                        </span>
                        <span>•</span>
                        <span>
                          {inPlanningCount} di {items.length} presenti nel planning
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Right Actions */}
                  <div className="flex items-center space-x-2 self-end sm:self-auto flex-shrink-0">
                    {unsyncedRelevantCount > 0 && (
                      <button
                        onClick={() => handleSyncCircular(circ, true)}
                        className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-bold transition-colors shadow-2xs flex items-center space-x-1"
                        title="Aggiungi gli impegni pertinenti mancanti al calendario"
                      >
                        <Plus className="w-3.5 h-3.5 mr-1" />
                        <span>Aggiungi al Planning ({unsyncedRelevantCount})</span>
                      </button>
                    )}

                    <button
                      onClick={() => toggleExpand(circ.id)}
                      className="p-1.5 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg transition-colors flex items-center text-xs font-medium"
                      title={isExpanded ? "Comprimi dettagli" : "Mostra impegni"}
                    >
                      <span className="mr-1 hidden sm:inline">{isExpanded ? "Comprimi" : "Dettagli"}</span>
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>

                    <button
                      onClick={() => setCircularToDelete(circ)}
                      className="p-1.5 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                      title="Elimina circolare"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Expanded Details: Identified commitments list */}
                {isExpanded && (
                  <div className="border-t border-stone-100 bg-stone-50/40 p-4 sm:p-5 space-y-4">
                    {/* Filter bar inside card */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 pb-3">
                      <div className="flex items-center space-x-2 text-xs">
                        <span className="font-medium text-stone-500">Mostra:</span>
                        <button
                          onClick={() =>
                            setActiveFilterByCircId((prev) => ({ ...prev, [circ.id]: "ALL" }))
                          }
                          className={`px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                            activeFilter === "ALL"
                              ? "bg-stone-800 text-white"
                              : "bg-white text-stone-600 border border-stone-200 hover:bg-stone-100"
                          }`}
                        >
                          Tutti ({items.length})
                        </button>
                        <button
                          onClick={() =>
                            setActiveFilterByCircId((prev) => ({ ...prev, [circ.id]: "RELEVANT" }))
                          }
                          className={`px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                            activeFilter === "RELEVANT"
                              ? "bg-emerald-700 text-white"
                              : "bg-white text-emerald-800 border border-emerald-200 hover:bg-emerald-50"
                          }`}
                        >
                          Pertinenti ({relevantItems.length})
                        </button>
                        <button
                          onClick={() =>
                            setActiveFilterByCircId((prev) => ({ ...prev, [circ.id]: "UNSYNCED" }))
                          }
                          className={`px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                            activeFilter === "UNSYNCED"
                              ? "bg-amber-600 text-white"
                              : "bg-white text-amber-800 border border-amber-200 hover:bg-amber-50"
                          }`}
                        >
                          Mancanti nel Planning ({items.length - inPlanningCount})
                        </button>
                      </div>

                      {/* Right actions: sync all or toggle original text */}
                      <div className="flex items-center space-x-2 text-xs">
                        {circ.rawText && (
                          <button
                            onClick={() =>
                              setShowOriginalTextId(showOriginalTextId === circ.id ? null : circ.id)
                            }
                            className="px-2.5 py-1 rounded-lg bg-white border border-stone-200 text-stone-600 hover:text-stone-900 flex items-center space-x-1"
                          >
                            {showOriginalTextId === circ.id ? (
                              <EyeOff className="w-3.5 h-3.5 mr-1" />
                            ) : (
                              <Eye className="w-3.5 h-3.5 mr-1" />
                            )}
                            <span>{showOriginalTextId === circ.id ? "Nascondi Testo" : "Testo Originale"}</span>
                          </button>
                        )}

                        <button
                          onClick={() => handleSyncCircular(circ, false)}
                          className="px-2.5 py-1 rounded-lg bg-white border border-stone-300 text-stone-700 hover:bg-stone-100 font-semibold"
                          title="Aggiunge tutti gli impegni individuati, compresi quelli generali"
                        >
                          Importa Tutti al Planning
                        </button>
                      </div>
                    </div>

                    {/* Original Text drawer if requested */}
                    {showOriginalTextId === circ.id && circ.rawText && (
                      <div className="p-3 bg-white border border-stone-200 rounded-xl text-xs text-stone-700 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed">
                        <div className="font-bold text-stone-900 mb-1 font-sans">Contenuto Testuale:</div>
                        {circ.rawText}
                      </div>
                    )}

                    {/* Commitments list */}
                    {items.length === 0 ? (
                      <div className="p-6 text-center text-stone-400 text-xs bg-white rounded-xl border border-stone-200">
                        Nessun impegno salvato per questa circolare.
                      </div>
                    ) : filteredItems.length === 0 ? (
                      <div className="p-6 text-center text-stone-400 text-xs bg-white rounded-xl border border-stone-200">
                        Nessun impegno corrisponde al filtro selezionato.
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {filteredItems.map((it) => {
                          const inPlan = isCommitmentInEvents(it, events);
                          const isVerde = it.relevance === "VERDE";
                          const isGiallo = it.relevance === "GIALLO";
                          const isRosso = it.relevance === "ROSSO";

                          return (
                            <div
                              key={it.tempId || `${it.title}-${it.date}-${it.startTime}`}
                              className={`p-3.5 rounded-xl border bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-2xs transition-all ${
                                inPlan ? "border-stone-200" : isVerde ? "border-emerald-300 ring-1 ring-emerald-400/20" : "border-stone-200"
                              }`}
                            >
                              {/* Left Info */}
                              <div className="space-y-1.5 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h4 className="text-sm font-bold text-stone-900 leading-snug">
                                    {it.title}
                                  </h4>

                                  {/* Relevance Tag */}
                                  {isVerde && (
                                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
                                      🟢 PERTINENTE PER TE
                                    </span>
                                  )}
                                  {isGiallo && (
                                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                                      🟡 GENERALE D'ISTITUTO
                                    </span>
                                  )}
                                  {isRosso && (
                                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-100 text-rose-900 border border-rose-200">
                                      🔴 ALTRE CLASSI / ESCLUSO
                                    </span>
                                  )}

                                  {/* Category */}
                                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-stone-100 text-stone-700 border border-stone-200">
                                    {it.category.replace("_", " ")}
                                  </span>

                                  {it.className && (
                                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-purple-50 text-purple-900 border border-purple-200">
                                      Classe {it.className}
                                    </span>
                                  )}
                                </div>

                                {/* Date & Time & Location */}
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-600">
                                  <span className="flex items-center font-semibold text-stone-800">
                                    <Calendar className="w-3.5 h-3.5 mr-1 text-emerald-700" />
                                    {formatDateItalian(it.date)}
                                  </span>
                                  <span className="flex items-center font-medium">
                                    <Clock className="w-3.5 h-3.5 mr-1 text-stone-400" />
                                    {it.isDeadline ? "Scadenza" : `${it.startTime || "15:00"} - ${it.endTime || "16:30"}`}
                                  </span>
                                  {it.location && (
                                    <span className="flex items-center text-stone-500">
                                      <MapPin className="w-3.5 h-3.5 mr-1 text-stone-400" />
                                      {it.location}
                                    </span>
                                  )}
                                </div>

                                {/* Relevance Motivation */}
                                {it.relevanceReason && (
                                  <p className="text-[11px] text-stone-500 italic bg-stone-50/70 p-1.5 rounded-md border border-stone-100">
                                    <span className="font-semibold text-stone-700 not-italic">Motivazione: </span>
                                    {it.relevanceReason}
                                  </p>
                                )}
                              </div>

                              {/* Right Status & Action */}
                              <div className="flex items-center space-x-2.5 self-end sm:self-auto flex-shrink-0">
                                {inPlan ? (
                                  <div className="flex items-center space-x-2">
                                    <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                                      <CheckCircle2 className="w-3.5 h-3.5 mr-1 text-emerald-600" />
                                      Nel Planning
                                    </span>
                                    <button
                                      onClick={() => onNavigateToPlanning(it.date, "settimana")}
                                      className="px-2.5 py-1 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-semibold flex items-center transition-colors"
                                      title="Vai alla data nel planning settimanale"
                                    >
                                      <span>Vedi nel Planning</span>
                                      <ArrowRight className="w-3.5 h-3.5 ml-1" />
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center space-x-2">
                                    <span className="text-xs text-amber-700 font-medium">
                                      Non nel planning
                                    </span>
                                    <button
                                      onClick={() => handleAddSingleItem(it, circ.title)}
                                      className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-bold transition-colors shadow-2xs flex items-center"
                                    >
                                      <Plus className="w-3.5 h-3.5 mr-1" />
                                      <span>Aggiungi al Planning</span>
                                    </button>
                                  </div>
                                )}

                                {/* Delete single extracted row */}
                                {onDeleteExtractedItem && (
                                  <button
                                    type="button"
                                    onClick={() => onDeleteExtractedItem(circ.id, it)}
                                    className="p-1.5 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors ml-1"
                                    title="Elimina questa riga estrapolata dalla circolare"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {circularToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-950/40 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-stone-200 space-y-4">
            <div className="w-12 h-12 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center">
              <Trash2 className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-stone-900">Rimuovere questa circolare?</h3>
              <p className="text-xs text-stone-500 mt-1">
                Stai per eliminare dall'archivio: <span className="font-semibold text-stone-800">"{circularToDelete.title}"</span>.
                Gli impegni già importati nel tuo calendario/planning non verranno cancellati.
              </p>
            </div>
            <div className="flex items-center justify-end space-x-3 pt-2">
              <button
                onClick={() => setCircularToDelete(null)}
                className="px-4 py-2 rounded-xl border border-stone-200 text-stone-700 hover:bg-stone-50 text-xs font-semibold"
              >
                Annulla
              </button>
              <button
                onClick={() => {
                  onDeleteCircular(circularToDelete.id);
                  setCircularToDelete(null);
                }}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold shadow-xs"
              >
                Elimina Circolare
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
