import { convertExtractedItemToEvent } from "../services/storage";
import { extractedItemError } from "../utils/circularParser";
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
import { analyzeCircular, SAMPLE_CIRCULARS } from "../services/aiService";

interface CircularAnalyzerModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: TeacherProfile;
  onImportEvents: (events: CalendarEvent[], docMeta: CircularDocument) => void;
}

export const CircularAnalyzerModal: React.FC<CircularAnalyzerModalProps> = ({
  isOpen,
  onClose,
  profile,
  onImportEvents,
}) => {
  const [step, setStep] = useState<"input" | "results">("input");
  const [inputMode, setInputMode] = useState<"file" | "text" | "samples">("samples");
  const [circularText, setCircularText] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [fileBase64, setFileBase64] = useState<string | undefined>();
  const [fileMimeType, setFileMimeType] = useState<string | undefined>();
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [extractedItems, setExtractedItems] = useState<ExtractedItem[]>([]);
  const [analysisSource, setAnalysisSource] = useState<string>("");
  const [defaultLocation, setDefaultLocation] = useState<string>("");
  const [relevanceFilter, setRelevanceFilter] = useState<"ALL_RELEVANT" | "VERDE" | "GIALLO" | "ROSSO" | "ALL">(
    "ALL_RELEVANT"
  );
  const [showRawSnippets, setShowRawSnippets] = useState<boolean>(false);
  const [selectionWarning, setSelectionWarning] = useState<string | null>(null);

  const inputRevision = useRef(0);
  const [isReadingFile, setIsReadingFile] = useState(false);
  useEffect(() => {
    inputRevision.current++;
    setStep('input'); setCircularText(''); setFileName(''); setDefaultLocation('');
    setFileBase64(undefined); setFileMimeType(undefined); setExtractedItems([]);
    setAnalysisError(null); setSelectionWarning(null); setIsAnalyzing(false); setIsReadingFile(false);
  }, [isOpen]);

  if (!isOpen) return null;

  // Handle file upload
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const revision = ++inputRevision.current;
    setCircularText(''); setFileBase64(undefined); setFileMimeType(undefined);
    setIsReadingFile(true);
    setFileName(file.name);
    setAnalysisError(null);

    const reader = new FileReader();
    reader.onerror = () => { if (revision === inputRevision.current) { setIsReadingFile(false); setAnalysisError('Impossibile leggere il file.'); } };
    reader.onloadend = () => { if (revision === inputRevision.current) setIsReadingFile(false); };
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
        setCircularText(reader.result as string);
      };
      reader.readAsText(file);
    }
  };

  // Select a preset sample
  const handleSelectSample = (sample: typeof SAMPLE_CIRCULARS[0]) => {
    inputRevision.current++;
    setIsReadingFile(false);
    setCircularText(sample.text);
    setFileName(sample.title);
    setFileBase64(undefined);
    setFileMimeType(undefined);
    setInputMode("text");
  };

  // Run the analysis
  const handleRunAnalysis = async () => {
    if (!circularText.trim() && !fileBase64) {
      setAnalysisError("Inserisci il testo della circolare oppure carica un file.");
      return;
    }

    const revision = ++inputRevision.current;
    setIsAnalyzing(true);
    setAnalysisError(null);

    try {
      const result = await analyzeCircular({
        text: circularText,
        imageBase64: fileBase64,
        mimeType: fileMimeType,
        profile,
        defaultLocation: defaultLocation.trim() || undefined,
      });

      if (revision !== inputRevision.current) return;
      if (!result.success && (!result.items || result.items.length === 0)) {
        throw new Error(result.error || "Impossibile analizzare il documento.");
      }

      setExtractedItems(result.items);
      setAnalysisSource(result.source);
      setStep("results");
    } catch (err: any) {
      console.warn("Avviso analisi circolare:", err?.message || err);
      if (revision !== inputRevision.current) return;
      setAnalysisError(err.message || "Errore durante l'analisi della circolare.");
    } finally {
      if (revision === inputRevision.current) setIsAnalyzing(false);
    }
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

  // Filter items based on current active tab
  const getFilteredItems = () => {
    switch (relevanceFilter) {
      case "VERDE":
        return extractedItems.filter((i) => i.relevance === "VERDE");
      case "GIALLO":
        return extractedItems.filter((i) => i.relevance === "GIALLO");
      case "ROSSO":
        return extractedItems.filter((i) => i.relevance === "ROSSO");
      case "ALL_RELEVANT":
        return extractedItems.filter((i) => i.relevance === "VERDE" || i.relevance === "GIALLO");
      case "ALL":
      default:
        return extractedItems;
    }
  };

  const visibleItems = getFilteredItems();
  const selectedCount = extractedItems.filter((i) => i.selectedForImport).length;

  const countVerde = extractedItems.filter((i) => i.relevance === "VERDE").length;
  const countGiallo = extractedItems.filter((i) => i.relevance === "GIALLO").length;
  const countRosso = extractedItems.filter((i) => i.relevance === "ROSSO").length;

  // Bulk selection helpers
  const handleSelectAllRelevant = () => {
    setExtractedItems((prev) =>
      prev.map((it) => ({
        ...it,
        selectedForImport: it.relevance === "VERDE" || it.relevance === "GIALLO",
      }))
    );
    setSelectionWarning(null);
  };

  const handleSelectAll = () => {
    setExtractedItems((prev) => prev.map((it) => ({ ...it, selectedForImport: true })));
    setSelectionWarning(null);
  };

  const handleDeselectAll = () => {
    setExtractedItems((prev) => prev.map((it) => ({ ...it, selectedForImport: false })));
  };

  const handleDeleteRow = (tempId: string) => {
    setExtractedItems((prev) => prev.filter((i) => i.tempId !== tempId));
  };

  // Final confirmation: convert selected ExtractedItems to CalendarEvent
  const handleConfirmImport = () => {
    const selected = extractedItems.filter((i) => i.selectedForImport);
    if (selected.length === 0) {
      setSelectionWarning("Seleziona almeno un impegno prima di confermare l'importazione oppure clicca su 'Seleziona pertinenti'.");
      return;
    }
    setSelectionWarning(null);

    const invalid = selected.find(it => extractedItemError(it));
    if (invalid) { setSelectionWarning(`${invalid.title}: ${extractedItemError(invalid)}`); return; }
    const circularId = `circ-${crypto.randomUUID()}`;
    const newEvents = selected.map(it => convertExtractedItemToEvent(it, fileName || 'Circolare importata', circularId));

    const docMeta: CircularDocument = {
      id: circularId,
      title: fileName || "Circolare del " + new Date().toLocaleDateString("it-IT"),
      uploadDate: localDateISO(),
      fileType: fileBase64 ? (fileMimeType?.includes("pdf") ? "pdf" : "image") : "text",
      fileName: fileName || "testo_incollato.txt",
      rawText: circularText || undefined,
      extractedCount: extractedItems.length,
      relevantCount: countVerde + countGiallo,
      extractedItems: extractedItems,
    };

    onImportEvents(newEvents, docMeta);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-stone-950/50 backdrop-blur-xs">
      <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[92vh] shadow-2xl border border-stone-200 flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
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
            onClick={onClose}
            className="p-2 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {step === "input" ? (
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
                      Il filtro confronta classi, materie, ordine scolastico e destinatari. Le attività ambigue rimangono da verificare; date e orari mancanti vanno completati prima dell'importazione.
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
                  onClick={() => setInputMode("samples")}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    inputMode === "samples"
                      ? "bg-amber-100 text-amber-900 font-bold"
                      : "text-stone-600 hover:bg-stone-100"
                  }`}
                >
                  ⚡ Esempi Pronti (Test 1-Click)
                </button>
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

              {/* Content Mode 1: Pre-made realistic samples */}
              {inputMode === "samples" && (
                <div className="space-y-3">
                  <div className="text-xs font-medium text-stone-600">
                    Scegli una circolare scolastica realistica per collaudare il filtraggio:
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {SAMPLE_CIRCULARS.map((s, idx) => (
                      <div
                        key={idx}
                        onClick={() => handleSelectSample(s)}
                        className="p-4 rounded-xl border border-stone-200 hover:border-amber-400 hover:bg-amber-50/40 cursor-pointer transition-all space-y-2 group shadow-2xs"
                      >
                        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-0.5 rounded-md">
                          Esempio {idx + 1}
                        </span>
                        <h4 className="text-xs font-bold text-stone-900 group-hover:text-amber-950">
                          {s.title}
                        </h4>
                        <p className="text-[11px] text-stone-500 line-clamp-2">{s.description}</p>
                        <span className="text-[11px] font-semibold text-amber-700 block mt-2">
                          Seleziona ed elabora &rarr;
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Content Mode 2: File Upload (PDF, Photo) */}
              {inputMode === "file" && (
                <div className="space-y-4">
                  <label
                    htmlFor="circular-file-input"
                    className="border-2 border-dashed border-stone-300 hover:border-amber-500 rounded-2xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all bg-stone-50/50 hover:bg-amber-50/20"
                  >
                    <FileUp className="w-10 h-10 text-stone-400 mb-2" />
                    <span className="text-sm font-semibold text-stone-800">
                      Trascina o seleziona il PDF o la foto della circolare
                    </span>
                    <span className="text-xs text-stone-400 mt-1">
                      Supporta PDF, PNG, JPEG (anche foto scattate con smartphone)
                    </span>
                    <input
                      id="circular-file-input"
                      type="file"
                      accept=".pdf,image/png,image/jpeg,image/webp"
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
          ) : (
            /* STEP 2: REVIEW & CONFIRMATION */
            <div className="space-y-4">
              {/* Summary Stats Header */}
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

              {/* Filter Tabs by Relevance & Quick Selection */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 pb-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => setRelevanceFilter("ALL_RELEVANT")}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      relevanceFilter === "ALL_RELEVANT"
                        ? "bg-emerald-700 text-white shadow-xs"
                        : "bg-stone-100 text-stone-700 hover:bg-stone-200"
                    }`}
                  >
                    Pertinenti ({countVerde + countGiallo})
                  </button>
                  <button
                    onClick={() => setRelevanceFilter("VERDE")}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      relevanceFilter === "VERDE"
                        ? "bg-emerald-700 text-white shadow-xs"
                        : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-200"
                    }`}
                  >
                    🟢 Certo ({countVerde})
                  </button>
                  <button
                    onClick={() => setRelevanceFilter("GIALLO")}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      relevanceFilter === "GIALLO"
                        ? "bg-amber-600 text-white shadow-xs"
                        : "bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200"
                    }`}
                  >
                    🟡 Generale ({countGiallo})
                  </button>
                  <button
                    onClick={() => setRelevanceFilter("ROSSO")}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      relevanceFilter === "ROSSO"
                        ? "bg-rose-700 text-white shadow-xs"
                        : "bg-rose-50 text-rose-800 hover:bg-rose-100 border border-rose-200"
                    }`}
                  >
                    🔴 Esclusi ({countRosso})
                  </button>
                </div>

                {/* Quick Selection Shortcuts */}
                <div className="flex items-center space-x-2 text-xs">
                  <span className="text-stone-400 font-medium">Seleziona:</span>
                  <button
                    onClick={handleSelectAllRelevant}
                    className="text-emerald-700 font-semibold hover:underline"
                    title="Seleziona solo impegni pertinenti (Verdi e Gialli)"
                  >
                    Pertinenti
                  </button>
                  <span className="text-stone-300">•</span>
                  <button
                    onClick={handleSelectAll}
                    className="text-stone-600 hover:text-stone-900 font-medium hover:underline"
                  >
                    Tutti
                  </button>
                  <span className="text-stone-300">•</span>
                  <button
                    onClick={handleDeselectAll}
                    className="text-stone-500 hover:text-stone-800 font-medium hover:underline"
                  >
                    Nessuno
                  </button>
                </div>
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

              {/* Items List */}
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

                              {extractedItemError(item) && <p className="text-xs text-amber-800" role="status">{extractedItemError(item)}</p>}
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
          )}
        </div>

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
                className="px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-bold shadow-xs transition-colors flex items-center space-x-1.5"
              >
                <Check className="w-4 h-4" />
                <span>Aggiungi {selectedCount} selezionati all'Agenda</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
