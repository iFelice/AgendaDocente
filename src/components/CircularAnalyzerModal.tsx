import { circularUploadError } from "../utils/circularUpload";
import { usePersistenceAction } from "../hooks/usePersistenceAction";
import { convertExtractedItemToEvent } from "../services/storage";
import { extractedItemError } from "../utils/circularParser";
import { formatRecipientsLabel } from "../utils/circularRelevance";
import { localDateISO } from "../utils/dates";
import React, { useState, useEffect, useRef } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  FileText,
  Filter,
  MapPin,
  RefreshCw,
  Sparkles,
  Upload,
  X,
  FileUp,
  HelpCircle,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Trash2,
} from "lucide-react";
import {
  CalendarEvent,
  CircularDocument,
  ExtractedItem,
  RelevanceLevel,
  TeacherProfile,
} from "../types";
import {
  analyzeCircular,
  circularPartialNotice,
  mergeCircularItems,
  CIRCULAR_PDF_WAIT_MESSAGE,
} from "../services/aiService";
import { findPossibleEventUpdate, getEventFieldDiff } from "../utils/eventMatching";

export type UpdateChoice = "update" | "create" | "ignore";

interface CircularAnalyzerModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: TeacherProfile;
  existingEvents?: CalendarEvent[];
  onImportEvents: (
    events: CalendarEvent[],
    docMeta: CircularDocument,
    updatedEvents?: CalendarEvent[]
  ) => void | false | Promise<void | false>;
  /**
   * File già scansionato dal flusso unificato "Scansiona documento":
   * lo si alimenta nel passo di input senza duplicare la pipeline.
   * Se contiene `autoStartToken`, avvia automaticamente l'analisi una sola volta.
   */
  initialFile?: {
    mode?: "file" | "text";
    base64?: string;
    mimeType?: string;
    fileName?: string;
    autoStartToken?: string;
  } | null;
  initialInputMode?: "file" | "text";
}

/** Token di auto-start monouso già consumati per prevenire doppie analisi anche in StrictMode. */
const consumedAutoStartTokens = new Set<string>();

/** Etichette brevi dei mesi in italiano per i pulsanti del filtro mese. */
const MONTH_SHORT_LABELS = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];

/**
 * Chiave mese "YYYY-MM" di un impegno estratto, oppure null se la data
 * non è valida (gli impegni senza data finiscono nel gruppo "Senza data").
 */
const monthKeyOf = (item: ExtractedItem): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.date || "");
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}`;
};

export const CircularAnalyzerModal: React.FC<CircularAnalyzerModalProps> = ({
  isOpen,
  onClose,
  profile,
  existingEvents,
  onImportEvents,
  initialFile,
  initialInputMode,
}) => {
  const save = usePersistenceAction();
  const [step, setStep] = useState<"input" | "results">("input");
  const [inputMode, setInputMode] = useState<"file" | "text">("file");
  const [circularText, setCircularText] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [fileBase64, setFileBase64] = useState<string | undefined>();
  const [fileMimeType, setFileMimeType] = useState<string | undefined>();
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [extractedItems, setExtractedItems] = useState<ExtractedItem[]>([]);
  const [analysisSource, setAnalysisSource] = useState<string>("");
  const [analysisNotice, setAnalysisNotice] = useState<string | null>(null);
  /**
   * Pagine che il server non è riuscito ad analizzare: sono esattamente
   * quelle che la ripresa rimanda. Vuoto = nessuna pagina mancante.
   */
  const [unanalyzedPages, setUnanalyzedPages] = useState<number[]>([]);
  const [isResuming, setIsResuming] = useState<boolean>(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [defaultLocation, setDefaultLocation] = useState<string>("");
  const [relevanceFilter, setRelevanceFilter] = useState<"ALL_RELEVANT" | "VERDE" | "GIALLO" | "ROSSO" | "ALL">(
    "ALL_RELEVANT"
  );
  const [monthFilter, setMonthFilter] = useState<string>("ALL"); // "ALL" | "NODATE" | "YYYY-MM"
  const [isHeaderCompact, setIsHeaderCompact] = useState<boolean>(false);
  const [showRawSnippets, setShowRawSnippets] = useState<boolean>(false);
  const [selectionWarning, setSelectionWarning] = useState<string | null>(null);
  const [updateChoices, setUpdateChoices] = useState<Record<string, UpdateChoice>>({});

  const inputRevision = useRef(0);
  const handledAutoTokenRef = useRef<string | null>(null);
  const [isReadingFile, setIsReadingFile] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const handleModalClose = () => {
    inputRevision.current++;
    onClose();
  };

  // Esegue l'analisi: supporta parametri espliciti per l'auto-start o i valori correnti dello stato.
  const executeAnalysis = async (params?: { text?: string; base64?: string; mimeType?: string }) => {
    const textToAnalyze = params ? (params.text ?? "") : circularText;
    const base64ToAnalyze = params ? params.base64 : fileBase64;
    const mimeTypeToAnalyze = params ? params.mimeType : fileMimeType;

    if (!textToAnalyze.trim() && !base64ToAnalyze) {
      setAnalysisError("Inserisci il testo della circolare oppure carica un file.");
      return;
    }

    const revision = ++inputRevision.current;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setAnalysisNotice(null);
    setUnanalyzedPages([]);
    setResumeError(null);

    try {
      const result = await analyzeCircular({
        text: textToAnalyze,
        imageBase64: base64ToAnalyze,
        mimeType: mimeTypeToAnalyze,
        profile,
        defaultLocation: defaultLocation.trim() || undefined,
      });

      if (revision !== inputRevision.current) return;
      if (!result.success && (!result.items || result.items.length === 0)) {
        throw new Error(result.error || "Impossibile analizzare il documento.");
      }
      if (result.items.length === 0) {
        setExtractedItems([]);
        setAnalysisError("Nessun impegno riconosciuto nel documento. Puoi riprovare o incollare il testo.");
        return;
      }

      setExtractedItems(result.items);
      setAnalysisSource(result.source);
      setAnalysisNotice(result.notice ?? null);
      setUnanalyzedPages(result.unanalyzedPages ?? []);
      setMonthFilter("ALL");
      setIsHeaderCompact(false);
      setStep("results");
    } catch (err: any) {
      console.warn("Avviso analisi circolare:", err?.message || err);
      if (revision !== inputRevision.current) return;
      setAnalysisError(err.message || "Errore durante l'analisi della circolare.");
    } finally {
      if (revision === inputRevision.current) setIsAnalyzing(false);
    }
  };

  const handleRunAnalysis = () => {
    void executeAnalysis();
  };

  /**
   * Ripresa delle sole pagine rimaste indietro. Rimanda lo STESSO file (ancora
   * in memoria in questa finestra) chiedendo solo quelle pagine: i risultati
   * già a schermo restano visibili e utilizzabili per tutta la richiesta, e
   * l'esito si AGGIUNGE senza toccare modifiche, selezioni ed eliminazioni.
   * Se la finestra è stata riaperta il file non c'è più: il pulsante non
   * compare e resta il solo avviso.
   */
  const handleRetryMissingPages = async () => {
    if (isResuming || unanalyzedPages.length === 0 || !fileBase64 || !fileMimeType) return;
    const requestedPages = [...unanalyzedPages];
    const revision = inputRevision.current;
    setIsResuming(true);
    setResumeError(null);

    try {
      const result = await analyzeCircular({
        text: "",
        imageBase64: fileBase64,
        mimeType: fileMimeType,
        profile,
        defaultLocation: defaultLocation.trim() || undefined,
        pages: requestedPages,
      });

      if (revision !== inputRevision.current) return;
      if (!result.success) {
        setResumeError(result.error || "Non è stato possibile rileggere le pagine mancanti. Riprova tra poco.");
        return;
      }

      // Le pagine ancora mancanti sono quelle che il server dichiara non
      // analizzate anche in questa ripresa: le altre sono state lette.
      const stillMissing = requestedPages.filter((page) => (result.unanalyzedPages ?? []).includes(page));
      setExtractedItems((prev) => mergeCircularItems(prev, result.items));
      setUnanalyzedPages(stillMissing);
      setAnalysisNotice(stillMissing.length > 0 ? circularPartialNotice(stillMissing) : null);
      if (stillMissing.length > 0) {
        setResumeError(null);
      }
    } catch (err: any) {
      console.warn("Avviso ripresa pagine circolare:", err?.message || err);
      if (revision !== inputRevision.current) return;
      setResumeError("Non è stato possibile rileggere le pagine mancanti. Riprova tra poco.");
    } finally {
      if (revision === inputRevision.current) setIsResuming(false);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      inputRevision.current++;
      handledAutoTokenRef.current = null;
      return;
    }

    const autoToken = initialFile?.autoStartToken;

    // Se questo handoff con autoStartToken è già stato avviato da questa istanza, non resettare lo stato
    if (autoToken && handledAutoTokenRef.current === autoToken) {
      return;
    }

    const shouldAutoStart = Boolean(autoToken && !consumedAutoStartTokens.has(autoToken));

    if (autoToken) {
      handledAutoTokenRef.current = autoToken;
      if (shouldAutoStart) {
        consumedAutoStartTokens.add(autoToken);
      }
    } else {
      handledAutoTokenRef.current = null;
    }

    inputRevision.current++;
    setStep("input");
    const effectiveMode = initialFile?.mode ?? initialInputMode ?? "file";
    setInputMode(effectiveMode);
    setCircularText("");
    setDefaultLocation("");
    setExtractedItems([]);
    setAnalysisError(null);
    setAnalysisNotice(null);
    setUnanalyzedPages([]);
    setResumeError(null);
    setIsResuming(false);
    setSelectionWarning(null);
    setUpdateChoices({});
    setMonthFilter("ALL");
    setIsHeaderCompact(false);
    setIsReadingFile(false);

    if (initialFile && initialFile.base64 && initialFile.mimeType) {
      setFileName(initialFile.fileName || "");
      setFileBase64(initialFile.base64);
      setFileMimeType(initialFile.mimeType);

      if (shouldAutoStart) {
        void executeAnalysis({
          text: "",
          base64: initialFile.base64,
          mimeType: initialFile.mimeType,
        });
      } else {
        setIsAnalyzing(false);
      }
    } else {
      setFileName("");
      setFileBase64(undefined);
      setFileMimeType(undefined);
      setIsAnalyzing(false);
    }
  }, [isOpen, initialFile, initialInputMode]);

  if (!isOpen) return null;

  // Handle file processing for both file input and drag & drop
  const processCircularFile = (file: File) => {
    const revision = ++inputRevision.current;
    setCircularText("");
    setFileBase64(undefined);
    setFileMimeType(undefined);
    const fileError = circularUploadError(file);
    if (fileError) {
      setIsReadingFile(false);
      setAnalysisError(fileError);
      return;
    }
    setIsReadingFile(true);
    setFileName(file.name);
    setAnalysisError(null);

    const reader = new FileReader();
    reader.onerror = () => {
      if (revision === inputRevision.current) {
        setIsReadingFile(false);
        setAnalysisError("Impossibile leggere il file.");
      }
    };
    reader.onloadend = () => {
      if (revision === inputRevision.current) setIsReadingFile(false);
    };
    if (file.type.startsWith("image/") || file.type === "application/pdf") {
      reader.onload = () => {
        if (revision !== inputRevision.current) return;
        const resultStr = reader.result as string;
        // Strip data:url prefix for raw base64
        const base64Data = resultStr.split(",")[1];
        setFileBase64(base64Data);
        setFileMimeType(file.type);
      };
      reader.readAsDataURL(file);
    } else {
      // Text file
      reader.onload = () => {
        if (revision !== inputRevision.current) return;
        const text = reader.result as string;
        if (text.length > 100_000) {
          setAnalysisError("Testo troppo lungo: massimo 100.000 caratteri.");
          return;
        }
        setCircularText(text);
      };
      reader.readAsText(file);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processCircularFile(file);
  };

  const handleDragOver = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    processCircularFile(file);
  };


  // Toggle selection of an extracted item
  const toggleItemSelection = (tempId: string) => {
    setExtractedItems((prev) =>
      prev.map((it) => (it.tempId === tempId ? { ...it, selectedForImport: !it.selectedForImport } : it))
    );
  };

  // Update item field inline
  const updateItemField = (tempId: string, field: keyof ExtractedItem, value: any) => {
    setExtractedItems((prev) =>
      prev.map((it) => (it.tempId === tempId ? { ...it, [field]: value } : it))
    );
  };

  // Relevance predicate for the current active tab
  const matchesRelevance = (i: ExtractedItem): boolean => {
    switch (relevanceFilter) {
      case "VERDE":
        return i.relevance === "VERDE";
      case "GIALLO":
        return i.relevance === "GIALLO";
      case "ROSSO":
        return i.relevance === "ROSSO";
      case "ALL_RELEVANT":
        return i.relevance === "VERDE" || i.relevance === "GIALLO";
      case "ALL":
      default:
        return true;
    }
  };

  // Mesi effettivamente presenti negli impegni estratti, in ordine cronologico.
  const monthKeys = extractedItems
    .map(monthKeyOf)
    .filter((k): k is string => k !== null)
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .sort();
  const hasUndatedItems = extractedItems.some((i) => monthKeyOf(i) === null);
  const spansMultipleYears = monthKeys.some((k) => k.slice(0, 4) !== monthKeys[0].slice(0, 4));
  const monthLabel = (key: string): string => {
    const [year, month] = key.split("-");
    const base = MONTH_SHORT_LABELS[Number(month) - 1] || key;
    return spansMultipleYears ? `${base} ${year}` : base;
  };

  // Se il mese selezionato non esiste più (es. righe eliminate), si torna a "Tutti i mesi".
  const effectiveMonthFilter =
    monthFilter === "ALL" ||
    (monthFilter === "NODATE" && hasUndatedItems) ||
    monthKeys.includes(monthFilter)
      ? monthFilter
      : "ALL";

  const matchesMonth = (i: ExtractedItem): boolean => {
    if (effectiveMonthFilter === "ALL") return true;
    if (effectiveMonthFilter === "NODATE") return monthKeyOf(i) === null;
    return monthKeyOf(i) === effectiveMonthFilter;
  };

  // I due filtri si combinano: la lista mostra solo gli impegni che li soddisfano entrambi.
  const visibleItems = extractedItems.filter((i) => matchesRelevance(i) && matchesMonth(i));
  // Conteggi incrociati: la pertinenza riflette il mese selezionato e viceversa.
  const itemsInMonth = extractedItems.filter(matchesMonth);
  const itemsInRelevance = extractedItems.filter(matchesRelevance);
  const monthCount = (key: string): number =>
    itemsInRelevance.filter((i) => (key === "NODATE" ? monthKeyOf(i) === null : monthKeyOf(i) === key)).length;
  const selectedItems = extractedItems.filter((i) => i.selectedForImport);
  const selectedCount = selectedItems.length;

  const toCreateCount = selectedItems.filter((it) => {
    const match = findPossibleEventUpdate(it, existingEvents);
    return !match || updateChoices[it.tempId] === "create";
  }).length;

  const toUpdateCount = selectedItems.filter((it) => {
    const match = findPossibleEventUpdate(it, existingEvents);
    return !!match && updateChoices[it.tempId] === "update";
  }).length;

  const isAllIgnored =
    selectedCount > 0 &&
    toCreateCount === 0 &&
    toUpdateCount === 0 &&
    selectedItems.every((it) => {
      const match = findPossibleEventUpdate(it, existingEvents);
      return match && updateChoices[it.tempId] === "ignore";
    });

  const countVerde = itemsInMonth.filter((i) => i.relevance === "VERDE").length;
  const countGiallo = itemsInMonth.filter((i) => i.relevance === "GIALLO").length;
  const countRosso = itemsInMonth.filter((i) => i.relevance === "ROSSO").length;

  // Bulk selection helpers, scoped to the items currently visible with the active
  // filters: the selection of the other items is never touched. Invalid rows
  // (missing or end<=start intervals) are never auto-selected: times must come
  // from the document, not from a default or a neighbour.
  const visibleIds = new Set(visibleItems.map((i) => i.tempId));

  const handleSelectAllRelevant = () => {
    setExtractedItems((prev) =>
      prev.map((it) =>
        visibleIds.has(it.tempId)
          ? {
              ...it,
              selectedForImport:
                (it.relevance === "VERDE" || it.relevance === "GIALLO") && !extractedItemError(it),
            }
          : it
      )
    );
    setSelectionWarning(null);
  };

  const handleSelectAll = () => {
    setExtractedItems((prev) =>
      prev.map((it) => (visibleIds.has(it.tempId) ? { ...it, selectedForImport: true } : it))
    );
    setSelectionWarning(null);
  };

  const handleDeselectAll = () => {
    setExtractedItems((prev) =>
      prev.map((it) => (visibleIds.has(it.tempId) ? { ...it, selectedForImport: false } : it))
    );
  };

  // Compatta il riquadro del titolo durante lo scroll dell'elenco, così
  // l'intestazione fissa resta entro ~30% dell'altezza visibile sugli schermi stretti.
  const handleListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const compact = e.currentTarget.scrollTop > 24;
    setIsHeaderCompact((prev) => (prev === compact ? prev : compact));
  };

  const handleDeleteRow = (tempId: string) => {
    setExtractedItems((prev) => prev.filter((i) => i.tempId !== tempId));
  };

  // Final confirmation: convert selected ExtractedItems to CalendarEvent or updated existing events
  const handleConfirmImport = async () => {
    const selected = extractedItems.filter((i) => i.selectedForImport);
    if (selected.length === 0) {
      setSelectionWarning("Seleziona almeno un impegno prima di confermare l'importazione oppure clicca su 'Seleziona pertinenti'.");
      return;
    }
    setSelectionWarning(null);

    // Verifica che per tutti gli impegni con possibile aggiornamento sia stata fatta una scelta esplicita
    for (const it of selected) {
      const match = findPossibleEventUpdate(it, existingEvents);
      if (match && !updateChoices[it.tempId]) {
        setSelectionWarning(`Effettua una scelta per l'impegno "${it.title}" (Possibile aggiornamento di un impegno esistente).`);
        return;
      }
    }

    const toImportOrUpdate = selected.filter((it) => {
      const match = findPossibleEventUpdate(it, existingEvents);
      const choice = match ? updateChoices[it.tempId] : undefined;
      return !(match && choice === "ignore");
    });
    const invalid = toImportOrUpdate.find((it) => extractedItemError(it));
    if (invalid) {
      setSelectionWarning(`${invalid.title}: ${extractedItemError(invalid)}`);
      return;
    }

    const circularId = `circ-${crypto.randomUUID()}`;
    const newEvents: CalendarEvent[] = [];
    const updatedEvents: CalendarEvent[] = [];

    for (const it of selected) {
      const match = findPossibleEventUpdate(it, existingEvents);
      const choice = match ? updateChoices[it.tempId] : undefined;

      if (match && choice === "update") {
        const updatedDeadlineDate =
          it.deadlineDate ||
          (it.isDeadline === true ? it.date : undefined);
        // Aggiorna l'evento esistente preservando ID e metadati tecnici
        const updatedEvent: CalendarEvent = {
          ...match,
          title: it.title,
          category: it.category,
          date: it.date,
          deadlineDate: updatedDeadlineDate,
          startTime: it.startTime || undefined,
          endTime: it.endTime || undefined,
          isAllDay: !it.startTime && !it.endTime,
          className: it.className || match.className,
          subject: it.subject || match.subject,
          location: it.location || match.location,
          notes: it.notes || match.notes,
          completed: false,
          sourceCircularId: match.sourceCircularId || circularId,
          sourceCircularTitle: match.sourceCircularTitle || fileName || "Circolare importata",
          sourceItemId: match.sourceItemId || it.tempId,
          sourceType: match.sourceType || "circolare",
          updatedAt: new Date().toISOString(),
        };
        updatedEvents.push(updatedEvent);
      } else if (match && choice === "ignore") {
        // Ignorato: non crea né aggiorna nulla
        continue;
      } else {
        // Nuovo impegno da aggiungere (senza match oppure con scelta esplicita "create")
        newEvents.push(convertExtractedItemToEvent(it, fileName || "Circolare importata", circularId));
      }
    }

    // CASO A: Tutti gli elementi selezionati sono stati ignorati (nessuna modifica da salvare)
    if (newEvents.length === 0 && updatedEvents.length === 0) {
      handleModalClose();
      return;
    }

    const docMeta: CircularDocument = {
      id: circularId,
      title: fileName || "Circolare del " + new Date().toLocaleDateString("it-IT"),
      uploadDate: localDateISO(),
      fileType: fileBase64 ? (fileMimeType?.includes("pdf") ? "pdf" : "image") : "text",
      fileName: fileName || "testo_incollato.txt",
      rawText: circularText || undefined,
      extractedCount: extractedItems.length,
      relevantCount: extractedItems.filter((i) => i.relevance === "VERDE" || i.relevance === "GIALLO").length,
      extractedItems: extractedItems,
    };

    if (!await save.run(() => onImportEvents(newEvents, docMeta, updatedEvents))) return;
    onClose();
  };

  return (
    <div className="app-modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-stone-950/50 backdrop-blur-xs">
      <div className="app-modal-panel bg-white rounded-2xl max-w-4xl w-full max-h-[92vh] shadow-2xl border border-stone-200 flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
        {save.error && <p role="alert" className="p-3 text-sm text-rose-700">{save.error}</p>}
        {/* Modal Top Bar */}
        <div className="p-4 sm:p-5 border-b border-stone-200 flex items-center justify-between bg-stone-50">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center shadow-xs">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-stone-900">
                Analizzatore Intelligente di Circolari
              </h2>
              <p className="text-xs text-stone-500">
                Filtra automaticamente per il tuo grado ({profile.schoolLevel === "primaria" ? "Primaria" : profile.schoolLevel === "ssiig" ? "SSIIG" : "SSIG"}), classi ({profile.classes.join(", ")}) e materia ({profile.primarySubjects[0] || "Docente"})
              </p>
            </div>
          </div>

          <button
            onClick={handleModalClose}
            className="p-2 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        {step === "input" ? (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="space-y-6">
              {/* Profile Match & Default Location Configuration */}
              <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 text-xs space-y-3">
                <div className="flex items-start space-x-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <div className="font-semibold text-stone-900 mb-1">
                      Filtro di pertinenza e attribuzione sede:
                    </div>
                    <div className="text-stone-600 leading-relaxed">
                      Grado: <strong className="uppercase text-stone-900">{profile.schoolLevel || "SSIG"}</strong>.
                      Il filtro confronta classi, materie, ordine scolastico e destinatari. Le attività ambigue rimangono da verificare; la data deve essere presente. Se l’orario non è indicato, l’impegno viene aggiunto per l’intera giornata.
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-stone-200">
                  {/* Assigned Classes */}
                  <div className="space-y-1">
                    <span className="font-medium text-stone-700 block">
                      Classi di appartenenza del docente:
                    </span>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {profile.classes && profile.classes.length > 0 ? (
                        profile.classes.map((cls) => (
                          <span
                            key={cls}
                            className="px-2 py-0.5 rounded-md font-bold text-xs bg-emerald-100 text-emerald-900 border border-emerald-300"
                          >
                            {cls}
                          </span>
                        ))
                      ) : (
                        <span className="text-stone-500 italic text-[11px]">Nessuna classe configurata nel profilo</span>
                      )}
                    </div>
                    <p className="text-[11px] text-stone-500">
                      Avvisi o consigli per classi non assegnate (es. 1D) verranno esclusi in <span className="font-semibold text-rose-600">ROSSO</span>.
                    </p>
                  </div>

                  {/* Default Location */}
                  <div className="space-y-1">
                    <label htmlFor="analyzer-default-location" className="font-medium text-stone-700 flex items-center space-x-1">
                      <MapPin className="w-3.5 h-3.5 text-stone-500" />
                      <span>Sede facoltativa per impegni senza luogo:</span>
                    </label>
                    <div className="flex items-center space-x-2">
                      <input
                        id="analyzer-default-location"
                        type="text"
                        value={defaultLocation}
                        onChange={(e) => setDefaultLocation(e.target.value)}
                        placeholder="Lascia vuoto se non conosci la sede"
                        className="w-full px-2.5 py-1.5 rounded-lg border border-stone-300 bg-white text-xs text-stone-900 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
                      />
                      {profile.campuses && profile.campuses.length > 1 && (
                        <select
                          value={profile.campuses.includes(defaultLocation) ? defaultLocation : ""}
                          onChange={(e) => {
                            if (e.target.value) setDefaultLocation(e.target.value);
                          }}
                          className="px-2 py-1.5 rounded-lg border border-stone-300 bg-white text-xs text-stone-700 focus:outline-hidden"
                          title="Scegli tra i plessi del tuo profilo"
                        >
                          <option value="">Scegli plesso...</option>
                          {profile.campuses.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    <p className="text-[11px] text-stone-500">
                      Quando la circolare non specifica aula o sede, verrà inserito questo luogo.
                    </p>
                  </div>
                </div>
              </div>

              {/* Mode Switcher */}
              <div className="flex items-center space-x-2 border-b border-stone-200 pb-2">
                <button
                  onClick={() => setInputMode("file")}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    inputMode === "file"
                      ? "bg-amber-100 text-amber-900 font-bold"
                      : "text-stone-600 hover:bg-stone-100"
                  }`}
                >
                  Carica File (PDF / Immagine)
                </button>
                <button
                  onClick={() => { inputRevision.current++; setIsReadingFile(false); setFileBase64(undefined); setFileMimeType(undefined); setInputMode("text"); }}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    inputMode === "text"
                      ? "bg-amber-100 text-amber-900 font-bold"
                      : "text-stone-600 hover:bg-stone-100"
                  }`}
                >
                  Incolla Testo Circolare
                </button>
              </div>

              {/* Content Mode 2: File Upload (PDF, Photo) */}
              {inputMode === "file" && (
                <div className="space-y-4">
                  <label
                    htmlFor="circular-file-input"
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all ${
                      isDragging
                        ? "border-amber-500 bg-amber-50/60 ring-2 ring-amber-400/50"
                        : "border-stone-300 hover:border-amber-500 bg-stone-50/50 hover:bg-amber-50/20"
                    }`}
                  >
                    <FileUp className={`w-10 h-10 mb-2 transition-colors ${isDragging ? "text-amber-600" : "text-stone-400"}`} />
                    <span className="text-sm font-semibold text-stone-800">
                      Trascina o seleziona il PDF o la foto della circolare
                    </span>
                    <span className="text-xs text-stone-400 mt-1">
                      Supporta PDF, PNG, JPEG (anche foto scattate con smartphone)
                    </span>
                    <input
                      id="circular-file-input"
                      type="file"
                      accept=".pdf,.txt,text/plain,image/png,image/jpeg,image/webp"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                  </label>

                  {fileName && (
                    <div className="p-3 rounded-xl bg-stone-100 border border-stone-200 flex items-center justify-between text-xs">
                      <div className="flex items-center space-x-2">
                        <FileText className="w-4 h-4 text-emerald-700" />
                        <span className="font-semibold text-stone-900">{fileName}</span>
                      </div>
                      <span className="text-stone-500">{fileMimeType || "File selezionato"}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Content Mode 3: Text Paste */}
              {inputMode === "text" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-stone-700">
                      Testo della circolare o dell'avviso scolastico:
                    </label>
                    {fileName && (
                      <span className="text-xs text-amber-800 font-medium">Documento: {fileName}</span>
                    )}
                  </div>
                  <textarea
                    rows={8}
                    value={circularText}
                    onChange={(e) => setCircularText(e.target.value)}
                    placeholder="Incolla qui il testo della circolare, del calendario consigli di classe o del piano annuale..."
                    className="w-full p-3 rounded-xl border border-stone-300 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 text-xs font-mono leading-relaxed"
                  />
                </div>
              )}

              {analysisError && (
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 text-rose-600" />
                  <span>{analysisError}</span>
                </div>
              )}

              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <strong>Analisi AI nel cloud.</strong> Avviando l’analisi, il PDF o l’immagine può essere inviato a Google Gemini per estrarre gli impegni. Il server dell’app non salva il file su disco. Evita documenti con dati personali non necessari.
                <p className="mt-1">Anche il testo può essere analizzato nel cloud; se il servizio non è disponibile, resta attivo il parser testuale locale.</p>
              </div>
              {isAnalyzing && fileMimeType === "application/pdf" && (
                <div className="p-3 rounded-lg bg-sky-50 border border-sky-200 text-sky-900 text-xs flex items-center space-x-2" role="status">
                  <RefreshCw className="w-4 h-4 flex-shrink-0 animate-spin" />
                  <span>{CIRCULAR_PDF_WAIT_MESSAGE}</span>
                </div>
              )}
              {/* Action */}
              <div className="flex justify-end pt-2">
                <button
                  id="btn-run-analysis"
                  disabled={isAnalyzing || isReadingFile || (!circularText.trim() && !fileBase64)}
                  onClick={handleRunAnalysis}
                  className="px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-bold text-sm shadow-md transition-all flex items-center space-x-2"
                >
                  {isAnalyzing ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Analisi semantica in corso...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>{fileBase64 ? "Analizza documento nel cloud" : "Avvia Analisi & Filtraggio"}</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* STEP 2: REVIEW & CONFIRMATION */
          <div className="flex-1 flex flex-col min-h-0">
            {/* Intestazione fissa: resta visibile (sfondo pieno) mentre l'elenco scorre */}
            <div className="shrink-0 bg-white border-b border-stone-200 px-4 sm:px-6 pt-3 pb-2 space-y-2">
              {analysisNotice && !isHeaderCompact && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs flex flex-col sm:flex-row sm:items-center gap-2" role="status">
                  <div className="flex items-center space-x-2 flex-1 min-w-0">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{analysisNotice}</span>
                  </div>
                  {/* Il file è ancora in memoria in questa finestra: la ripresa è possibile.
                      Riaprendo la finestra il file non c'è più e resta il solo avviso. */}
                  {unanalyzedPages.length > 0 && !!fileBase64 && !!fileMimeType && (
                    <button
                      id="btn-retry-missing-pages"
                      type="button"
                      disabled={isResuming}
                      onClick={() => { void handleRetryMissingPages(); }}
                      className="shrink-0 self-start sm:self-auto px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white font-semibold text-xs flex items-center space-x-1.5 transition-colors"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isResuming ? "animate-spin" : ""}`} />
                      <span>{isResuming ? "Rilettura in corso..." : "Riprova le pagine mancanti"}</span>
                    </button>
                  )}
                </div>
              )}
              {resumeError && !isHeaderCompact && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-center space-x-2" role="status">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{resumeError}</span>
                </div>
              )}
              {/* Summary Stats Header (compresso durante lo scroll per restare entro ~30% dell'altezza) */}
              {isHeaderCompact ? (
                <div className="px-3 py-1.5 rounded-lg bg-stone-50 border border-stone-200 flex items-center justify-between gap-2">
                  <span className="font-bold text-xs text-stone-900 truncate">Risultati Analisi Circolare</span>
                  <span className="text-[11px] text-stone-500 whitespace-nowrap">
                    {extractedItems.length} impegni nel documento
                  </span>
                </div>
              ) : (
                <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="font-bold text-sm text-stone-900">Risultati Analisi Circolare</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-semibold">
                        Motore: {analysisSource}
                      </span>
                    </div>
                    <p className="text-xs text-stone-500 mt-0.5">
                      Trovati {extractedItems.length} impegni complessivi nel documento.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowRawSnippets(!showRawSnippets)}
                      className="text-xs text-stone-600 hover:text-stone-900 border border-stone-200 px-2.5 py-1.5 rounded-lg bg-white flex items-center space-x-1"
                    >
                      {showRawSnippets ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      <span>{showRawSnippets ? "Nascondi estratti" : "Mostra testo originale"}</span>
                    </button>
                    <button
                      onClick={() => setStep("input")}
                      className="text-xs text-stone-600 hover:text-stone-900 border border-stone-200 px-2.5 py-1.5 rounded-lg bg-white"
                    >
                      &larr; Altra circolare
                    </button>
                  </div>
                </div>
              )}

              {/* Filter Tabs by Relevance & Quick Selection */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 pb-2">
                <div
                  role="group"
                  aria-label="Filtra per pertinenza"
                  className="flex flex-nowrap items-center gap-1.5 overflow-x-auto max-w-full"
                >
                  <button
                    onClick={() => setRelevanceFilter("ALL_RELEVANT")}
                    aria-pressed={relevanceFilter === "ALL_RELEVANT"}
                    className={`min-h-11 sm:min-h-0 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      relevanceFilter === "ALL_RELEVANT"
                        ? "bg-emerald-700 text-white shadow-xs"
                        : "bg-stone-100 text-stone-700 hover:bg-stone-200"
                    }`}
                  >
                    Pertinenti ({countVerde + countGiallo})
                  </button>
                  <button
                    onClick={() => setRelevanceFilter("VERDE")}
                    aria-pressed={relevanceFilter === "VERDE"}
                    className={`min-h-11 sm:min-h-0 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      relevanceFilter === "VERDE"
                        ? "bg-emerald-700 text-white shadow-xs"
                        : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-200"
                    }`}
                  >
                    🟢 Certo ({countVerde})
                  </button>
                  <button
                    onClick={() => setRelevanceFilter("GIALLO")}
                    aria-pressed={relevanceFilter === "GIALLO"}
                    className={`min-h-11 sm:min-h-0 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      relevanceFilter === "GIALLO"
                        ? "bg-amber-600 text-white shadow-xs"
                        : "bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200"
                    }`}
                  >
                    🟡 Generale ({countGiallo})
                  </button>
                  <button
                    onClick={() => setRelevanceFilter("ROSSO")}
                    aria-pressed={relevanceFilter === "ROSSO"}
                    className={`min-h-11 sm:min-h-0 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      relevanceFilter === "ROSSO"
                        ? "bg-rose-700 text-white shadow-xs"
                        : "bg-rose-50 text-rose-800 hover:bg-rose-100 border border-rose-200"
                    }`}
                  >
                    🔴 Esclusi ({countRosso})
                  </button>
                </div>

                {/* Quick Selection Shortcuts (agiscono solo sugli impegni visibili con i filtri attivi) */}
                <div className="flex items-center space-x-2 text-xs">
                  <span className="text-stone-400 font-medium">Seleziona:</span>
                  <button
                    onClick={handleSelectAllRelevant}
                    className="min-h-11 sm:min-h-0 px-1 text-emerald-700 font-semibold hover:underline"
                    title="Seleziona solo impegni pertinenti (Verdi e Gialli) tra quelli visibili"
                  >
                    Pertinenti
                  </button>
                  <span className="text-stone-300">•</span>
                  <button
                    onClick={handleSelectAll}
                    className="min-h-11 sm:min-h-0 px-1 text-stone-600 hover:text-stone-900 font-medium hover:underline"
                  >
                    Tutti
                  </button>
                  <span className="text-stone-300">•</span>
                  <button
                    onClick={handleDeselectAll}
                    className="min-h-11 sm:min-h-0 px-1 text-stone-500 hover:text-stone-800 font-medium hover:underline"
                  >
                    Nessuno
                  </button>
                </div>
              </div>

              {/* Month filter row: scorre in orizzontale, si combina con la pertinenza */}
              <div
                role="group"
                aria-label="Filtra per mese"
                className="flex flex-nowrap items-center gap-1.5 overflow-x-auto pb-1"
              >
                <button
                  onClick={() => setMonthFilter("ALL")}
                  aria-pressed={effectiveMonthFilter === "ALL"}
                  className={`min-h-11 sm:min-h-0 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    effectiveMonthFilter === "ALL"
                      ? "bg-stone-800 text-white shadow-xs"
                      : "bg-stone-100 text-stone-700 hover:bg-stone-200"
                  }`}
                >
                  Tutti i mesi ({itemsInRelevance.length})
                </button>
                {monthKeys.map((key) => (
                  <button
                    key={key}
                    onClick={() => setMonthFilter(key)}
                    aria-pressed={effectiveMonthFilter === key}
                    className={`min-h-11 sm:min-h-0 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      effectiveMonthFilter === key
                        ? "bg-stone-800 text-white shadow-xs"
                        : "bg-stone-100 text-stone-700 hover:bg-stone-200"
                    }`}
                  >
                    {monthLabel(key)} ({monthCount(key)})
                  </button>
                ))}
                {hasUndatedItems && (
                  <button
                    onClick={() => setMonthFilter("NODATE")}
                    aria-pressed={effectiveMonthFilter === "NODATE"}
                    className={`min-h-11 sm:min-h-0 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      effectiveMonthFilter === "NODATE"
                        ? "bg-stone-800 text-white shadow-xs"
                        : "bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200"
                    }`}
                  >
                    Senza data ({monthCount("NODATE")})
                  </button>
                )}
              </div>

              {/* In-Modal Warning if nothing selected */}
              {selectionWarning && (
                <div className="p-3 bg-amber-50 border border-amber-300 text-amber-900 text-xs rounded-xl flex items-center justify-between">
                  <span>{selectionWarning}</span>
                  <button
                    onClick={handleSelectAllRelevant}
                    className="ml-3 px-2 py-1 bg-amber-600 text-white font-semibold rounded-md text-[11px] hover:bg-amber-700 whitespace-nowrap"
                  >
                    Seleziona Pertinenti
                  </button>
                </div>
              )}
            </div>

            {/* Items List (unica area scorrevole del passo risultati) */}
            <div onScroll={handleListScroll} className="flex-1 overflow-y-auto p-4 sm:p-6">
              <div className="space-y-3">
                {visibleItems.length === 0 ? (
                  <div className="py-12 text-center text-stone-400 text-xs">
                    Nessun impegno in questa categoria.
                  </div>
                ) : (
                  visibleItems.map((item) => {
                    const isVerde = item.relevance === "VERDE";
                    const isGiallo = item.relevance === "GIALLO";
                    const isRosso = item.relevance === "ROSSO";
                    const match = findPossibleEventUpdate(item, existingEvents);
                    const diff = match ? getEventFieldDiff(match, item) : null;
                    const choice = updateChoices[item.tempId];

                    return (
                      <div
                        key={item.tempId}
                        className={`p-4 rounded-xl border transition-all ${
                          item.selectedForImport
                            ? "border-emerald-500 bg-emerald-50/20 shadow-xs"
                            : "border-stone-200 bg-white opacity-85"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          {/* Checkbox */}
                          <div className="flex items-start space-x-3 flex-1">
                            <input
                              type="checkbox"
                              checked={item.selectedForImport}
                              onChange={() => toggleItemSelection(item.tempId)}
                              className="mt-1 w-4 h-4 rounded-sm text-emerald-700 focus:ring-emerald-500 cursor-pointer"
                            />

                            <div className="space-y-2 flex-1">
                              {/* Header Badges */}
                              <div className="flex flex-wrap items-center gap-2">
                                {/* Relevance Badge */}
                                {isVerde && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
                                    🟢 PERTINENTE PER TE
                                  </span>
                                )}
                                {isGiallo && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">
                                    🟡 GENERALE D'ISTITUTO
                                  </span>
                                )}
                                {isRosso && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-900 border border-rose-300">
                                    🔴 ALTRE CLASSI / NON PERTINENTE
                                  </span>
                                )}

                                <span className="text-xs px-2 py-0.5 rounded-md font-semibold bg-stone-100 text-stone-700 uppercase">
                                  {item.category.replace("_", " ")}
                                </span>

                                {item.className && (
                                  <span className="text-xs px-2 py-0.5 rounded-md font-bold bg-purple-100 text-purple-800">
                                    Classe {item.className}
                                  </span>
                                )}
                              </div>

                              {/* Editable Title */}
                              <input
                                type="text"
                                value={item.title}
                                onChange={(e) => updateItemField(item.tempId, "title", e.target.value)}
                                className="w-full font-semibold text-stone-900 text-sm p-1 border-b border-transparent hover:border-stone-300 focus:border-emerald-600 focus:outline-hidden"
                              />

                              {/* Date & Time Controls */}
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                                <div className="flex items-center space-x-1">
                                  <span className="text-stone-500 font-medium">Data:</span>
                                  <input
                                    type="date"
                                    value={item.date}
                                    onChange={(e) => updateItemField(item.tempId, "date", e.target.value)}
                                    className="p-1 border border-stone-200 rounded-md text-xs"
                                  />
                                </div>

                                <div className="flex items-center space-x-1">
                                  <span className="text-stone-500 font-medium">Orario:</span>
                                  <input
                                    type="time"
                                    value={item.startTime || ""}
                                    onChange={(e) => updateItemField(item.tempId, "startTime", e.target.value)}
                                    className="p-1 border border-stone-200 rounded-md text-xs w-20"
                                  />
                                  <span>-</span>
                                  <input
                                    type="time"
                                    value={item.endTime || ""}
                                    onChange={(e) => updateItemField(item.tempId, "endTime", e.target.value)}
                                    className="p-1 border border-stone-200 rounded-md text-xs w-20"
                                  />
                                </div>

                                <div className="flex items-center space-x-1">
                                  <span className="text-stone-500 font-medium">Luogo:</span>
                                  <input
                                    type="text"
                                    value={item.location || ""}
                                    onChange={(e) => updateItemField(item.tempId, "location", e.target.value)}
                                    placeholder="Aula Magna / Meet"
                                    className="p-1 border border-stone-200 rounded-md text-xs flex-1"
                                  />
                                </div>
                              </div>

                              {extractedItemError(item)
                                ? <p className="text-xs text-amber-800" role="status">{extractedItemError(item)}</p>
                                : !item.startTime && !item.endTime && (
                                  <p className="text-xs text-stone-500" role="status">Senza orario: verrà aggiunto come impegno per l'intera giornata.</p>
                                )}
                              {/* Destinatari strutturati rilevati dall'AI (verifica manuale rapida) */}
                              {formatRecipientsLabel(item) && (
                                <p className="text-[11px] text-stone-500">
                                  Destinatari rilevati: {formatRecipientsLabel(item)}
                                </p>
                              )}

                              {/* Relevance Reason */}
                              <div className="text-xs text-stone-600 bg-stone-50 p-2 rounded-md border border-stone-100">
                                <span className="font-semibold text-stone-700">Motivo pertinenza: </span>
                                {item.relevanceReason}
                              </div>

                              {/* Optional Raw Snippet */}
                              {showRawSnippets && item.rawSnippet && (
                                <div className="text-[11px] font-mono text-stone-500 bg-stone-100 p-2 rounded-md">
                                  "{item.rawSnippet}"
                                </div>
                              )}

                              {/* Possibile aggiornamento di un impegno esistente */}
                              {match && diff && (
                                <div className="mt-3 p-3 rounded-xl border border-amber-300 bg-amber-50/70 space-y-3">
                                  <div className="flex items-center gap-1.5 text-xs font-bold text-amber-900">
                                    <RefreshCw className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                                    <span>Possibile aggiornamento di un impegno esistente</span>
                                  </div>

                                  {/* Confronto compatto mobile-first */}
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                                    {/* Esistente */}
                                    <div className="bg-white border border-stone-200 rounded-lg p-2.5 space-y-1">
                                      <span className="text-[10px] uppercase font-bold text-stone-500 tracking-wider block">
                                        Esistente in agenda
                                      </span>
                                      <div className="font-semibold text-stone-800">{match.title}</div>
                                      <div className="text-stone-600">
                                        <span>{match.date}</span>
                                        {(match.startTime || match.endTime) && (
                                          <span className="ml-1.5 font-mono">
                                            {match.startTime || "--:--"}{match.endTime ? ` - ${match.endTime}` : ""}
                                          </span>
                                        )}
                                      </div>
                                      {match.location && <div className="text-stone-500">📍 {match.location}</div>}
                                      {match.notes && <div className="text-stone-500 italic text-[11px]">{match.notes}</div>}
                                      {match.deadlineDate && <div className="text-[11px] text-stone-500">Scadenza: {match.deadlineDate}</div>}
                                      <div className="text-[11px] text-stone-400 capitalize">
                                        Categoria: {match.category.replace("_", " ")}
                                      </div>
                                    </div>

                                    {/* Dalla nuova circolare */}
                                    <div className="bg-white border border-amber-300 rounded-lg p-2.5 space-y-1">
                                      <span className="text-[10px] uppercase font-bold text-amber-700 tracking-wider block">
                                        Dalla nuova circolare
                                      </span>
                                      <div className={`font-semibold ${diff.title ? "text-amber-900 font-bold bg-amber-100/70 px-1 rounded inline-block" : "text-stone-800"}`}>
                                        {item.title}
                                      </div>
                                      <div className="text-stone-600">
                                        <span className={diff.date ? "bg-amber-100 font-semibold px-1 rounded text-amber-900" : ""}>{item.date}</span>
                                        {(item.startTime || item.endTime) && (
                                          <span className={`ml-1.5 font-mono ${diff.startTime || diff.endTime ? "bg-amber-100 font-bold px-1 rounded text-amber-900" : ""}`}>
                                            {item.startTime || "--:--"}{item.endTime ? ` - ${item.endTime}` : ""}
                                          </span>
                                        )}
                                      </div>
                                      {item.location && (
                                        <div className={`text-stone-600 ${diff.location ? "bg-amber-100 font-semibold px-1 rounded text-amber-900 inline-block" : ""}`}>
                                          📍 {item.location}
                                        </div>
                                      )}
                                      {item.notes && (
                                        <div className={`text-[11px] italic ${diff.notes ? "bg-amber-100 text-amber-900 px-1 rounded block" : "text-stone-500"}`}>
                                          {item.notes}
                                        </div>
                                      )}
                                      {(item.deadlineDate || item.isDeadline || match.deadlineDate) && (
                                        <div className={`text-[11px] ${diff.deadlineDate ? "bg-amber-100 font-semibold px-1 rounded text-amber-900 inline-block" : "text-stone-500"}`}>
                                          Scadenza: {item.deadlineDate || (item.isDeadline ? item.date : "Nessuna")}
                                        </div>
                                      )}
                                      <div className={`text-[11px] capitalize ${diff.category ? "bg-amber-100 font-semibold px-1 rounded text-amber-900 inline-block" : "text-stone-400"}`}>
                                        Categoria: {item.category.replace("_", " ")}
                                      </div>
                                    </div>
                                  </div>

                                  {/* Selezione esplicita */}
                                  <div className="pt-1">
                                    <span className="text-[11px] font-semibold text-stone-700 block mb-1.5">Scegli come procedere:</span>
                                    <div className="flex flex-wrap gap-2">
                                      <button
                                        type="button"
                                        onClick={() => setUpdateChoices((prev) => ({ ...prev, [item.tempId]: "update" }))}
                                        className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                                          choice === "update"
                                            ? "bg-emerald-700 border-emerald-800 text-white shadow-xs"
                                            : "bg-white border-stone-300 text-stone-700 hover:bg-stone-50"
                                        }`}
                                      >
                                        Aggiorna esistente
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setUpdateChoices((prev) => ({ ...prev, [item.tempId]: "create" }))}
                                        className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                                          choice === "create"
                                            ? "bg-amber-600 border-amber-700 text-white shadow-xs"
                                            : "bg-white border-stone-300 text-stone-700 hover:bg-stone-50"
                                        }`}
                                      >
                                        Aggiungi come nuovo
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setUpdateChoices((prev) => ({ ...prev, [item.tempId]: "ignore" }))}
                                        className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                                          choice === "ignore"
                                            ? "bg-stone-700 border-stone-800 text-white shadow-xs"
                                            : "bg-white border-stone-300 text-stone-700 hover:bg-stone-50"
                                        }`}
                                      >
                                        Ignora
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Delete row button */}
                          <button
                            type="button"
                            onClick={() => handleDeleteRow(item.tempId)}
                            title="Elimina questa riga estrapolata"
                            className="p-1.5 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors flex-shrink-0"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* Modal Bottom Bar */}
        {step === "results" && (
          <div className="p-4 border-t border-stone-200 bg-stone-50 flex items-center justify-between">
            <div className="text-xs text-stone-600">
              <strong className="text-emerald-800 font-bold">{selectedCount}</strong> impegni selezionati su{" "}
              {extractedItems.length}
            </div>

            <div className="flex items-center space-x-3">
              <button
                onClick={() => setStep("input")}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-200"
              >
                Annulla
              </button>
              <button
                id="btn-confirm-circular-import"
                onClick={handleConfirmImport}
                disabled={selectedCount === 0}
                className={`px-5 py-2.5 rounded-xl text-white text-xs font-bold shadow-xs transition-colors flex items-center space-x-1.5 ${
                  isAllIgnored
                    ? "bg-stone-700 hover:bg-stone-800"
                    : "bg-emerald-700 hover:bg-emerald-800"
                } disabled:opacity-50`}
              >
                <Check className="w-4 h-4" />
                <span>
                  {isAllIgnored
                    ? "Chiudi senza modifiche"
                    : `Aggiungi ${selectedCount} selezionati all'Agenda`}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
