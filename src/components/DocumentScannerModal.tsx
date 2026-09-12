import { usePersistenceAction } from "../hooks/usePersistenceAction";
import {
  analyzeStudentDocument,
  analyzeTimetableDocument,
} from "../services/scanService";
import {
  CAMERA_INPUT_PROPS,
  FILE_INPUT_PROPS,
  OFFLINE_ANALYSIS_MESSAGE,
  createPreviewUrl,
  documentFileError,
  formatFileSize,
  isOnline,
  readBlobAsBase64,
  revokePreviewUrl,
  type DocumentFileMeta,
} from "../utils/documentScanner";
import { isSupportTeacherProfile, periodTimesForIndex, reconstructedToTimetableSlots, type TimetableMergeMode } from "../utils/reconstructTimetable";
import { RECON_NOTES, crossrefTimetables, reconSignal, type ReconstructedSlot } from "../utils/timetableCrossref";
import {
  curricularCellsToSlots,
  findTeacherRows,
  personalCellsToCandidates,
  validateStudentCommitmentsPayload,
  type CurricularRawRow,
  type CurricularTimetableSlot,
  type PersonalTimetableSlotCandidate,
  type SkippedCell,
  type StudentCommitmentCandidate,
  type TimetableRawCell,
} from "../utils/timetableAnalysis";
import { DAY_LABELS } from "../utils/timetableTokens";
import { matchStudentName, studentMatchLabel } from "../utils/studentMatcher";
import { normalizeTeacherProfile } from "../utils/multiSchool";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Camera,
  Check,
  ChevronLeft,
  ClipboardCheck,
  CloudUpload,
  FileImage,
  FolderOpen,
  HeartHandshake,
  ImagePlus,
  ScanLine,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type {
  CalendarEvent,
  EventCategory,
  Student,
  TeacherProfile,
  TimeSlotConfig,
  TimetableSlot,
  TimetableType,
} from "../types";

/** Tipi documento del flusso "Scansiona documento". */
type ScanDocType = "circolare" | "personal" | "curricular" | "registro" | "ricostruisci";
/** Documento attualmente in fase di cattura. */
type CaptureFor = "circolare" | "personal" | "curricular" | "registro";
type Step =
  | "type"
  | "source"
  | "preview"
  | "consent"
  | "working"
  | "review-personal"
  | "review-curricular"
  | "review-student"
  | "reconstruct";

interface CircularFileInfo {
  base64: string;
  mimeType: string;
  fileName: string;
}

interface ReconEditSlot extends ReconstructedSlot {
  /** Correzioni manuali dell'utente (classe/materia/giorno/periodo). */
  correctedClass?: string;
  correctedSubject?: string;
}

interface PersonalReviewState {
  rows: string[];
  cells: TimetableRawCell[];
  matches: Array<{ rowIndex: number; rowLabel: string }>;
  confirmedRow: number | null;
  skipped: SkippedCell[];
}

export interface DocumentScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: TeacherProfile;
  students: Student[];
  timeSlotConfig?: TimeSlotConfig;
  provisionalTimetable: TimetableSlot[];
  definitiveTimetable: TimetableSlot[];
  /** Alimentazione del flusso esistente delle circolari (nessun parser duplicato). */
  onOpenCircularWithFile: (info: CircularFileInfo) => void;
  /** Salvataggio confermato dell'orario ricostruito (modello timetable esistente). */
  onSaveReconstructedTimetable: (slots: TimetableSlot[], target: TimetableType, mode: TimetableMergeMode) => void | false | Promise<void | false>;
  /** Salvataggio confermato degli impegni alunni estratti dal registro. */
  onImportStudentCommitments: (events: CalendarEvent[]) => void | false | Promise<void | false>;
}

const DOC_TYPE_OPTIONS: Array<{ id: ScanDocType; label: string; description: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "circolare", label: "Circolare", description: "Impegni, riunioni, scadenze", icon: ClipboardCheck },
  { id: "personal", label: "Orario personale / sostegno", description: "La tua riga nell'orario", icon: HeartHandshake },
  { id: "curricular", label: "Orario curricolare / istituto", description: "Materie per classe e ora", icon: Sparkles },
  { id: "registro", label: "Registro / appunti", description: "Interrogazioni, verifiche, colloqui", icon: Users },
];

export const DocumentScannerModal: React.FC<DocumentScannerModalProps> = ({
  isOpen,
  onClose,
  profile,
  students,
  timeSlotConfig,
  provisionalTimetable,
  definitiveTimetable,
  onOpenCircularWithFile,
  onSaveReconstructedTimetable,
  onImportStudentCommitments,
}) => {
  const save = usePersistenceAction();
  const [docType, setDocType] = useState<ScanDocType | null>(null);
  const [captureFor, setCaptureFor] = useState<CaptureFor | null>(null);
  const [step, setStep] = useState<Step>("type");
  const [file, setFile] = useState<DocumentFileMeta | null>(null);
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);
  const [personal, setPersonal] = useState<PersonalReviewState | null>(null);
  const [curricular, setCurricular] = useState<{ rows: CurricularRawRow[]; slots: CurricularTimetableSlot[]; skipped: SkippedCell[] } | null>(null);
  const [studentCandidates, setStudentCandidates] = useState<StudentCommitmentCandidate[] | null>(null);
  const [reconSlots, setReconSlots] = useState<ReconEditSlot[] | null>(null);
  const [reconSchoolId, setReconSchoolId] = useState<string | undefined>(undefined);
  const [reconTarget, setReconTarget] = useState<TimetableType>("provvisorio");
  const [mergeMode, setMergeMode] = useState<TimetableMergeMode>("missing-only");
  const [reconWarning, setReconWarning] = useState<string | null>(null);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<File | null>(null);
  const readingRevision = useRef(0);
  // L'object URL corrente in un ref: il cleanup a unmount deve revocare SEMPRE
  // l'URL vivo al momento (non quello del mount).
  const previewUrlRef = useRef<string | undefined>(undefined);
  const setPreviewSafe = (url: string | undefined) => {
    previewUrlRef.current = url;
    setPreviewUrl(url);
  };

  const support = isSupportTeacherProfile(profile);
  const schools = useMemo(() => normalizeTeacherProfile(profile).schools ?? [], [profile]);
  const multiSchool = schools.length > 1;
  const existingTarget = reconTarget === "provvisorio" ? provisionalTimetable : definitiveTimetable;

  // Reset completo ad ogni apertura.
  useEffect(() => {
    if (!isOpen) return;
    setDocType(null);
    setCaptureFor(null);
    setStep("type");
    setFile(null);
    setFileBase64(null);
    setPreviewSafe(undefined);
    fileRef.current = null;
    setAnalysisError(null);
    setIsAnalyzing(false);
    setIsReading(false);
    setConsentGiven(false);
    setPersonal(null);
    setCurricular(null);
    setStudentCandidates(null);
    setReconSlots(null);
    setReconSchoolId(undefined);
    setReconTarget("provvisorio");
    setMergeMode("missing-only");
    setReconWarning(null);
  }, [isOpen]);

  // Privacy: a unmount si revoca SEMPRE l'object URL corrente (ref sempre aggiornato).
  useEffect(() => {
    return () => {
      revokePreviewUrl(previewUrlRef.current);
      fileRef.current = null;
    };
  }, []);

  if (!isOpen) return null;

  const startCapture = (forWhat: CaptureFor) => {
    setCaptureFor(forWhat);
    setStep("source");
    setAnalysisError(null);
  };

  const handleTypeChoice = (id: ScanDocType) => {
    setDocType(id);
    if (id === "ricostruisci") {
      startCapture("personal");
    } else {
      startCapture(id as CaptureFor);
    }
  };

  /** Scatto o selezione: steso percorso per entrambi gli input (fallback incluso). */
  const handleFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = ""; // permette di ripescare lo stesso file
    if (!picked) return; // annullato: nessun crash, nessun stato
    const meta: DocumentFileMeta = { name: picked.name, size: picked.size, type: picked.type };
    const error = documentFileError(meta);
    if (error) {
      setAnalysisError(error);
      setStep("source");
      return;
    }
    const revision = ++readingRevision.current;
    revokePreviewUrl(previewUrl);
    fileRef.current = picked;
    setPreviewSafe(picked.type.startsWith("image/") ? createPreviewUrl(picked) : undefined);
    setFile(meta);
    setAnalysisError(null);
    setStep("preview");
    setIsReading(true);
    void readBlobAsBase64(picked)
      .then(base64 => {
        if (revision !== readingRevision.current) return;
        setFileBase64(base64);
        setIsReading(false);
      })
      .catch(() => {
        if (revision !== readingRevision.current) return;
        setIsReading(false);
        setAnalysisError("Impossibile leggere il file. Riprova.");
      });
  };

  const resetCapture = () => {
    readingRevision.current++;
    revokePreviewUrl(previewUrl);
    setPreviewSafe(undefined);
    setFile(null);
    setFileBase64(null);
    fileRef.current = null;
    setIsReading(false);
    setAnalysisError(null);
  };

  const isOffline = !isOnline();

  /** "Analizza documento" dalla preview: per le circolari alimenta il flusso
   *  esistente; per gli altri tipi passa al consenso cloud (o blocca offline). */
  const handleAnalyzeFromPreview = () => {
    if (isReading) return;
    if (!file) return;
    if (captureFor === "circolare") {
      // Pipeline circolare esistente: la nuova UI solo la alimenta con il file.
      if (!fileBase64 || !file.type) return;
      onOpenCircularWithFile({ base64: fileBase64, mimeType: file.type, fileName: file.name });
      return;
    }
    if (isOffline) {
      setAnalysisError(OFFLINE_ANALYSIS_MESSAGE);
      return;
    }
    setConsentGiven(false);
    setAnalysisError(null);
    setStep("consent");
  };

  const releaseDocument = () => {
    // Documento analizzato: nessun uso successivo, niente persistenza.
    setFileBase64(null);
    revokePreviewUrl(previewUrl);
    setPreviewSafe(undefined);
  };

  /** Consenso dato: invio al servizio AI cloud. */
  const handleStartAnalysis = async () => {
    if (!file || !fileBase64 || !captureFor || isAnalyzing) return;
    if (isOffline) {
      setAnalysisError(OFFLINE_ANALYSIS_MESSAGE);
      return;
    }
    const revision = readingRevision.current;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setStep("working");
    try {
      if (captureFor === "personal") {
        const result = await analyzeTimetableDocument({
          imageBase64: fileBase64,
          mimeType: file.type,
          documentType: "personal-support-timetable",
          profile,
        });
        if (revision !== readingRevision.current) return;
        const cells = result.cells ?? [];
        const rows = result.rows ?? [];
        setPersonal({ rows, cells, matches: findTeacherRows(rows, profile.fullName), confirmedRow: null, skipped: [] });
        setStep("review-personal");
      } else if (captureFor === "curricular") {
        const result = await analyzeTimetableDocument({
          imageBase64: fileBase64,
          mimeType: file.type,
          documentType: "curricular-timetable",
          profile,
        });
        if (revision !== readingRevision.current) return;
        const rows: CurricularRawRow[] = (result.curricularRows ?? []).map((r, i) => ({
          rowIndex: i,
          rowLabel: r.rowLabel,
          subject: r.subject,
          classes: r.classes,
        }));
        const extraction = curricularCellsToSlots(rows, result.cells ?? []);
        setCurricular({ rows, ...extraction });
        setStep("review-curricular");
      } else if (captureFor === "registro") {
        const result = await analyzeStudentDocument({
          imageBase64: fileBase64,
          mimeType: file.type,
          profile,
        });
        if (revision !== readingRevision.current) return;
        const raw = validateStudentCommitmentsPayload(result.commitments ?? []);
        const candidates: StudentCommitmentCandidate[] = raw.map(entry => {
          const match = entry.studentNameRaw
            ? matchStudentName(entry.studentNameRaw, students)
            : { status: "unmatched" as const, candidates: [] };
          return {
            ...entry,
            matchStatus: match.status,
            matchedStudentId: match.matchedStudentId,
            matchConfidence: match.matchConfidence,
            selected: !!entry.date, // senza data visibile l'impegno non è salvabile
          };
        });
        setStudentCandidates(candidates);
        setStep("review-student");
      }
      releaseDocument();
    } catch (error: unknown) {
      if (revision !== readingRevision.current) return;
      console.warn("Avviso analisi documento: richiesta cloud non completata.");
      setStep("preview");
      setAnalysisError(error instanceof Error ? error.message : "Analisi non riuscita. Riprova.");
    } finally {
      if (revision === readingRevision.current) setIsAnalyzing(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Orario personale: conferma riga -> candidati (mai celle inventate)
  // ---------------------------------------------------------------------------

  const personalCandidates: PersonalTimetableSlotCandidate[] = useMemo(() => {
    if (!personal || personal.confirmedRow === null) return [];
    const extraction = personalCellsToCandidates(personal.cells, [personal.confirmedRow]);
    return extraction.candidates;
  }, [personal]);

  const personalSkipped: SkippedCell[] = useMemo(() => {
    if (!personal || personal.confirmedRow === null) return [];
    return personalCellsToCandidates(personal.cells, [personal.confirmedRow]).skipped;
  }, [personal]);

  const confirmPersonalRow = (rowIndex: number) => {
    if (!personal) return;
    setPersonal({ ...personal, confirmedRow: rowIndex });
  };

  // ---------------------------------------------------------------------------
  // Incrocio multi-documento ("Ricostruisci il mio orario")
  // ---------------------------------------------------------------------------

  const buildReconstruction = () => {
    const personalList = personalCandidates;
    const curricularList = curricular?.slots ?? [];
    const reconstruction = crossrefTimetables(personalList, curricularList).map(slot => ({
      ...slot,
      correctedClass: slot.classLabel ?? "",
      correctedSubject: slot.coTeachingSubjects.length === 1 ? slot.coTeachingSubjects[0] : "",
    }));
    setReconSlots(reconstruction);
    setReconSchoolId(multiSchool ? schools.find(s => s.isPrimary)?.id : undefined);
    setReconTarget("provvisorio");
    setMergeMode("missing-only");
    setReconWarning(null);
    setStep("reconstruct");
  };

  const updateReconSlot = (id: string, patch: Partial<ReconEditSlot>) => {
    setReconSlots(prev => (prev ? prev.map(s => (s.id === id ? { ...s, ...patch } : s)) : prev));
    setReconWarning(null);
  };

  const handleSaveReconstruction = async () => {
    if (!reconSlots) return;
    const selected = reconSlots.filter(s => s.selected !== false);
    if (selected.length === 0) {
      setReconWarning("Seleziona almeno uno slot da salvare.");
      return;
    }
    // Gli slot senza classe non vengono mai salvati (classe mai inventata):
    // si salvano gli altri e l'utente avverte quali sono stati saltati.
    const withoutClass = selected.filter(s => !(s.correctedClass ?? s.classLabel ?? "").trim());
    const toSave = selected.filter(s => (s.correctedClass ?? s.classLabel ?? "").trim());
    if (toSave.length === 0) {
      setReconWarning("Nessuno slot selezionato ha una classe: completala oppure annulla.");
      return;
    }
    const slots = reconstructedToTimetableSlots(toSave, {
      profile,
      timeSlotConfig,
      schoolId: reconSchoolId,
    });
    if (!await save.run(() => onSaveReconstructedTimetable(slots, reconTarget, mergeMode))) return;
    if (withoutClass.length > 0) {
      setReconWarning(`${withoutClass.length} slot senza classe non salvati: completali e conferma di nuovo.`);
    }
    onClose();
  };

  // ---------------------------------------------------------------------------
  // Registro: conferma -> impegni in agenda (mai nuovi studenti automatici)
  // ---------------------------------------------------------------------------

  const updateStudentCandidate = (id: string, patch: Partial<StudentCommitmentCandidate>) => {
    setStudentCandidates(prev => (prev ? prev.map(c => (c.id === id ? { ...c, ...patch } : c)) : prev));
  };

  const categoryForCommitment = (c: StudentCommitmentCandidate): EventCategory => {
    switch (c.type) {
      case "oral_test":
      case "written_test":
      case "recovery":
        return "lezione";
      case "meeting":
        return "ricevimento_genitori";
      case "assignment":
        return "scadenza";
      default:
        return "promemoria";
    }
  };

  const COMMITMENT_TITLES: Record<StudentCommitmentCandidate["type"], string> = {
    oral_test: "Interrogazione",
    written_test: "Verifica",
    recovery: "Recupero",
    meeting: "Colloquio",
    assignment: "Consegna",
    other: "Attività",
  };

  const handleImportCommitments = async () => {
    if (!studentCandidates) return;
    const selected = studentCandidates.filter(c => c.selected);
    if (selected.length === 0) {
      setReconWarning("Seleziona almeno un impegno da aggiungere.");
      return;
    }
    const now = new Date().toISOString();
    const events: CalendarEvent[] = selected.map(c => {
      const student = students.find(s => s.id === c.matchedStudentId);
      const notesParts: string[] = [];
      if (student) notesParts.push(`Alunno: ${student.fullName}`);
      else if (c.studentNameRaw) notesParts.push(`Alunno (non riconosciuto): ${c.studentNameRaw}`);
      if (c.notes) notesParts.push(c.notes);
      return {
        id: `ev-reg-${c.id}`,
        title: c.title || COMMITMENT_TITLES[c.type],
        category: categoryForCommitment(c),
        date: c.date ?? "",
        startTime: c.startTime,
        endTime: c.endTime,
        isAllDay: !c.startTime,
        subject: c.subject,
        className: c.className,
        notes: notesParts.length ? notesParts.join(" · ") : undefined,
        sourceType: "registro",
        updatedAt: now,
      } as CalendarEvent;
    }).filter(e => e.date);
    if (events.length === 0) {
      setReconWarning("Gli impegni selezionati non hanno una data: completala prima di confermare.");
      return;
    }
    if (!await save.run(() => onImportStudentCommitments(events))) return;
    onClose();
  };

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const stepTitle: Record<Step, string> = {
    type: "Scansiona documento",
    source: captureFor === "personal" ? "Orario personale / sostegno" : captureFor === "curricular" ? "Orario curricolare / istituto" : captureFor === "registro" ? "Registro / appunti" : "Circolare",
    preview: "Controlla il documento",
    consent: "Informativa e consenso",
    working: "Analisi in corso",
    "review-personal": "La tua riga nell'orario",
    "review-curricular": "Orario curricolare estratto",
    "review-student": "Impegni estratti",
    reconstruct: "Orario ricostruito",
  };

  return (
    <div className="app-modal app-modal-scroll fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-stone-950/50 backdrop-blur-xs">
      <div className="app-modal-panel bg-white rounded-2xl max-w-2xl w-full max-h-[92vh] shadow-2xl border border-stone-200 flex flex-col overflow-hidden">
        {save.error && <p role="alert" className="p-3 text-sm text-rose-700">{save.error}</p>}
        <div className="modal-sticky-header flex items-center justify-between gap-3 px-4 py-3 border-b border-stone-200 bg-white">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-700 text-white flex items-center justify-center shrink-0">
              <ScanLine className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold text-stone-900 truncate">{stepTitle[step]}</h2>
              <p className="text-[11px] text-stone-500 truncate">I documenti non vengono salvati come immagini in AgendaDocente</p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {(step !== "type" && docType) && (
              <button
                type="button"
                onClick={() => { setStep("type"); resetCapture(); setPersonal(null); setCurricular(null); setStudentCandidates(null); setReconSlots(null); }}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 active:bg-stone-200"
                aria-label="Torna al tipo documento"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 active:bg-stone-200"
              aria-label="Chiudi Scansiona documento"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 momentum-scroll">
          {analysisError && step !== "working" && (
            <div className="mb-3 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2" role="alert">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{analysisError}</span>
            </div>
          )}

          {/* STEP: tipo documento */}
          {step === "type" && (
            <div className="space-y-5">
              <section aria-label="Tipo documento">
                <h3 className="text-xs font-bold uppercase tracking-wide text-stone-500 mb-2">Tipo documento</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {DOC_TYPE_OPTIONS.map(({ id, label, description, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      id={`scan-type-${id}`}
                      onClick={() => handleTypeChoice(id)}
                      className="doc-type-card flex items-center gap-3 rounded-xl border border-stone-200 bg-white p-3 text-left hover:border-emerald-500 hover:bg-emerald-50/40 active:bg-emerald-50 min-h-[64px]"
                    >
                      <Icon className="w-5 h-5 text-emerald-700 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-stone-900 truncate">{label}</span>
                        <span className="block text-[11px] text-stone-500 truncate">{description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              {support && (
                <section aria-label="Ricostruisci il mio orario">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-stone-500 mb-2">Ricostruisci il mio orario</h3>
                  <button
                    type="button"
                    id="scan-reconstruct-entry"
                    onClick={() => handleTypeChoice("ricostruisci")}
                    className="w-full rounded-xl bg-emerald-700 hover:bg-emerald-800 active:bg-emerald-900 text-white p-4 flex items-center gap-3 text-left shadow-xs"
                  >
                    <HeartHandshake className="w-6 h-6 shrink-0" />
                    <span>
                      <span className="block text-sm font-bold">Incrocia i tuoi documenti</span>
                      <span className="block text-[11px] text-emerald-100">
                        Orario personale + orario curricolare = compresenze ricostruite
                      </span>
                    </span>
                  </button>
                </section>
              )}
            </div>
          )}

          {/* STEP: sorgente (scatta foto / scegli foto o file) */}
          {step === "source" && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wide text-stone-500">Sorgente</h3>
              <button
                type="button"
                id="scan-source-camera"
                onClick={() => cameraInputRef.current?.click()}
                className="w-full rounded-xl border-2 border-dashed border-stone-300 hover:border-emerald-500 p-5 flex items-center gap-3 text-left bg-stone-50/60"
              >
                <span className="w-11 h-11 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0">
                  <Camera className="w-6 h-6" />
                </span>
                <span>
                  <span className="block text-sm font-bold text-stone-900">Scatta foto</span>
                  <span className="block text-[11px] text-stone-500">Fotocamera posteriore, sul posto</span>
                </span>
              </button>
              <button
                type="button"
                id="scan-source-file"
                onClick={() => fileInputRef.current?.click()}
                className="w-full rounded-xl border-2 border-dashed border-stone-300 hover:border-emerald-500 p-5 flex items-center gap-3 text-left bg-stone-50/60"
              >
                <span className="w-11 h-11 rounded-xl bg-stone-200 text-stone-700 flex items-center justify-center shrink-0">
                  <FolderOpen className="w-6 h-6" />
                </span>
                <span>
                  <span className="block text-sm font-bold text-stone-900">Scegli foto o file</span>
                  <span className="block text-[11px] text-stone-500">Foto da galleria o PDF</span>
                </span>
              </button>
              {isOffline && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
                  Scatto e selezione funzionano offline: per l'analisi serve una connessione Internet.
                </p>
              )}
              {/* Input nascosti: fotocamera con capture=environment (fallback
                  file picker dove non supportato) e file picker immagini/PDF. */}
              <input ref={cameraInputRef} type="file" className="hidden" onChange={handleFilePicked} {...CAMERA_INPUT_PROPS} aria-label="Scatta foto del documento" />
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleFilePicked} {...FILE_INPUT_PROPS} aria-label="Scegli foto o file" />
            </div>
          )}

          {/* STEP: preview (mai analisi automatica) */}
          {step === "preview" && file && (
            <div className="space-y-4">
              <div className="rounded-xl overflow-hidden border border-stone-200 bg-stone-100">
                {previewUrl ? (
                  <img src={previewUrl} alt={`Anteprima di ${file.name}`} className="w-full max-h-72 object-contain bg-stone-950/5" />
                ) : (
                  <div className="p-6 flex flex-col items-center gap-2 text-stone-500">
                    <FileImage className="w-10 h-10" />
                    <span className="text-xs">Anteprima non disponibile per questo file</span>
                  </div>
                )}
              </div>
              <div className="p-3 rounded-xl bg-stone-50 border border-stone-200 text-xs space-y-1">
                <div className="font-semibold text-stone-900 truncate">{file.name}</div>
                <div className="text-stone-500 flex flex-wrap gap-x-3">
                  <span>{formatFileSize(file.size)}</span>
                  <span>{file.type || "tipo sconosciuto"}</span>
                </div>
              </div>
              {isOffline && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2" role="status">
                  {OFFLINE_ANALYSIS_MESSAGE}
                </p>
              )}
              <div className="flex items-center gap-2 justify-end">
                <button
                  type="button"
                  id="scan-change-image"
                  onClick={resetCapture}
                  className="min-h-[44px] px-4 rounded-xl text-sm font-semibold text-stone-600 hover:bg-stone-100"
                >
                  Cambia immagine
                </button>
                <button
                  type="button"
                  id="scan-analyze-cta"
                  onClick={handleAnalyzeFromPreview}
                  disabled={isReading || !fileBase64}
                  className="min-h-[44px] px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-sm font-bold shadow-xs flex items-center gap-2"
                >
                  <ImagePlus className="w-4 h-4" />
                  {isReading ? "Lettura file…" : "Analizza documento"}
                </button>
              </div>
            </div>
          )}

          {/* STEP: consenso cloud AI (checkbox NON preselezionata) */}
          {step === "consent" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 space-y-2">
                <p className="font-semibold">Informativa privacy</p>
                {captureFor === "registro" ? (
                  <p>
                    Il documento può contenere dati personali degli studenti.
                    Il contenuto verrà inviato temporaneamente al servizio di analisi AI e non sarà salvato come immagine in AgendaDocente.
                  </p>
                ) : (
                  <p>
                    Il documento può contenere dati personali.
                    Il contenuto verrà inviato temporaneamente al servizio di analisi AI e non sarà salvato come immagine in AgendaDocente.
                  </p>
                )}
                <p className="text-amber-800">Dopo l'analisi il file viene scartato dall'app: nessun backup, nessuna copia sul server.</p>
              </div>
              <label className="flex items-start gap-3 p-3 rounded-xl border border-stone-200 bg-white cursor-pointer">
                <input
                  type="checkbox"
                  id="scan-cloud-consent"
                  checked={consentGiven}
                  onChange={e => setConsentGiven(e.target.checked)}
                  className="mt-0.5 w-5 h-5 accent-emerald-700"
                />
                <span className="text-xs text-stone-700">
                  Autorizzo l'invio del documento al servizio di analisi AI per estrarre i dati strutturati.
                </span>
              </label>
              {isOffline && (
                <p className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2" role="alert">
                  {OFFLINE_ANALYSIS_MESSAGE}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setStep("preview")}
                  className="min-h-[44px] px-4 rounded-xl text-sm font-semibold text-stone-600 hover:bg-stone-100"
                >
                  Indietro
                </button>
                <button
                  type="button"
                  id="scan-consent-confirm"
                  onClick={() => void handleStartAnalysis()}
                  disabled={!consentGiven || isOffline || isAnalyzing}
                  className="min-h-[44px] px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-sm font-bold shadow-xs flex items-center gap-2"
                >
                  <CloudUpload className="w-4 h-4" />
                  Invia e analizza
                </button>
              </div>
            </div>
          )}

          {/* STEP: working */}
          {step === "working" && (
            <div className="py-12 flex flex-col items-center gap-3 text-center">
              <CloudUpload className="w-10 h-10 text-emerald-700 animate-pulse" />
              <p className="text-sm font-semibold text-stone-900">Analisi del documento in corso…</p>
              <p className="text-xs text-stone-500 max-w-xs">Il documento non viene salvato: l'elaborazione può richiedere alcuni secondi.</p>
            </div>
          )}

          {/* STEP: revisione orario personale */}
          {step === "review-personal" && personal && (
            <div className="space-y-4">
              {personal.confirmedRow === null ? (
                <>
                  <div className="p-3 rounded-xl bg-stone-50 border border-stone-200 text-xs text-stone-600 space-y-1">
                    <p className="font-semibold text-stone-900">
                      {personal.matches.length === 0
                        ? `Non ho trovato il tuo nome (${profile.fullName || "profilo"}) nelle righe del documento.`
                        : personal.matches.length === 1
                          ? `Riga trovata per ${profile.fullName}.`
                          : `Trovate ${personal.matches.length} righe compatibili con ${profile.fullName}: scegli la tua.`}
                    </p>
                    {personal.matches.length > 1 && (
                      <p>Per evitare errori il sistema non sceglie al posto tuo.</p>
                    )}
                  </div>
                  <div className="space-y-2" role="radiogroup" aria-label="Riga del docente">
                    {personal.rows.map((label, rowIndex) => {
                      const isMatch = personal.matches.some(m => m.rowIndex === rowIndex);
                      return (
                        <label
                          key={rowIndex}
                          className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer text-sm ${
                            isMatch ? "border-emerald-400 bg-emerald-50/50" : "border-stone-200 bg-white"
                          }`}
                        >
                          <input
                            type="radio"
                            name="scan-personal-row"
                            value={String(rowIndex)}
                            checked={false}
                            onChange={() => confirmPersonalRow(rowIndex)}
                            className="w-4 h-4 accent-emerald-700"
                          />
                          <span className="font-medium text-stone-900 truncate">{label || `Riga ${rowIndex + 1}`}</span>
                          {isMatch && <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full shrink-0">compatibile</span>}
                        </label>
                      );
                    })}
                    {personal.rows.length === 0 && (
                      <p className="text-xs text-stone-500 p-3 rounded-xl bg-stone-50 border border-stone-200">
                        Nessuna riga leggibile: riprova con una foto più nitida.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2">
                    <span>
                      Riga confermata: <strong>{personal.rows[personal.confirmedRow]}</strong>
                    </span>
                    <button type="button" onClick={() => setPersonal({ ...personal, confirmedRow: null })} className="font-semibold underline shrink-0">
                      Cambia
                    </button>
                  </div>
                  {personalCandidates.length === 0 ? (
                    <p className="text-xs text-stone-600 p-4 rounded-xl bg-stone-50 border border-stone-200">
                      Nessuna cella interpretabile nella riga: nessuna ora è stata inventata. Puoi riprovare con un'altra foto.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {personalCandidates.map(slot => (
                        <div key={slot.id} className="flex items-center gap-3 p-3 rounded-xl border border-stone-200 bg-white text-sm">
                          <span className="font-semibold text-stone-900 w-24 shrink-0 truncate">{DAY_LABELS[slot.dayOfWeek]}</span>
                          <span className="text-stone-600 w-16 shrink-0">{slot.periodIndex}ª ora</span>
                          <span className={`px-2 py-0.5 rounded-md text-xs font-bold ${slot.classLabel ? "bg-emerald-100 text-emerald-900" : "bg-stone-100 text-stone-500"}`}>
                            {slot.classLabel ?? "classe n.d."}
                          </span>
                          <span className={`ml-auto text-[10px] font-semibold ${slot.confidence === "high" ? "text-emerald-700" : "text-amber-700"}`}>
                            {slot.confidence === "high" ? "certezza alta" : "da verificare"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {personalSkipped.length > 0 && (
                    <p className="text-[11px] text-stone-500">
                      {personalSkipped.length} celle non interpretate (codici D/P/Co o testo non leggibile): non sono state trasformate in orari.
                    </p>
                  )}
                </>
              )}

              {personal.confirmedRow !== null && (
                <div className="flex items-center justify-end gap-2">
                  {support && (docType === "personal" || docType === "ricostruisci") && (
                    <button
                      type="button"
                      id="scan-personal-add-curricular"
                      onClick={() => startCapture("curricular")}
                      className="min-h-[44px] px-4 rounded-xl text-sm font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100"
                    >
                      Aggiungi orario curricolare
                    </button>
                  )}
                  <button
                    type="button"
                    id="scan-personal-continue"
                    onClick={buildReconstruction}
                    disabled={personalCandidates.length === 0}
                    className="min-h-[44px] px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-sm font-bold shadow-xs"
                  >
                    {support ? "Prepara l'orario" : "Prepara la conferma"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* STEP: revisione orario curricolare */}
          {step === "review-curricular" && curricular && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-stone-50 border border-stone-200 text-xs text-stone-600">
                {curricular.rows.length} docenti, {curricular.slots.length} ore con classe e materia.
                Il nome dei docenti curricolari non viene salvato: serve solo a ricostruire le tue compresenze.
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1 momentum-scroll">
                {curricular.slots.slice(0, 60).map((slot, i) => (
                  <div key={`${slot.dayOfWeek}-${slot.periodIndex}-${slot.classLabel}-${i}`} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg bg-stone-50">
                    <span className="font-semibold text-stone-900 w-20 shrink-0 truncate">{DAY_LABELS[slot.dayOfWeek]}</span>
                    <span className="text-stone-500 w-12 shrink-0">{slot.periodIndex}ª</span>
                    <span className="font-bold text-emerald-900 w-10 shrink-0">{slot.classLabel}</span>
                    <span className={`truncate ${slot.subject ? "text-stone-700" : "text-stone-400 italic"}`}>
                      {slot.subject ?? "materia n.d."}
                    </span>
                  </div>
                ))}
                {curricular.slots.length === 0 && (
                  <p className="text-xs text-stone-500 p-3 rounded-xl bg-stone-50 border border-stone-200">
                    Nessuna ora interpretabile: nessuna cella è stata inventata.
                  </p>
                )}
              </div>
              {support ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    id="scan-curricular-reconstruct"
                    onClick={() => {
                      if (personal && personal.confirmedRow !== null && personalCandidates.length > 0) {
                        buildReconstruction();
                      } else {
                        startCapture("personal");
                      }
                    }}
                    className="min-h-[44px] px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold shadow-xs"
                  >
                    Ricostruisci il mio orario
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-stone-500">
                  La ricostruzione delle compresenze è disponibile per i docenti di sostegno.
                </p>
              )}
            </div>
          )}

          {/* STEP: revisione impegni alunni (registro) */}
          {step === "review-student" && studentCandidates && (
            <div className="space-y-3">
              <p className="text-xs text-stone-500">
                Verifica i candidati: gli alunni sono riconosciuti solo dal tuo elenco locale.
                Nessuno studente nuovo viene creato automaticamente.
              </p>
              {studentCandidates.length === 0 && (
                <p className="text-xs text-stone-500 p-4 rounded-xl bg-stone-50 border border-stone-200">
                  Nessun impegno riconosciuto nel documento.
                </p>
              )}
              {studentCandidates.map(c => {
                const match = c.studentNameRaw ? matchStudentName(c.studentNameRaw, students) : { status: "unmatched" as const, candidates: [] };
                const statusColor = c.matchStatus === "exact" ? "bg-emerald-100 text-emerald-900"
                  : c.matchStatus === "probable" ? "bg-emerald-50 text-emerald-800"
                    : c.matchStatus === "ambiguous" ? "bg-amber-100 text-amber-900"
                      : "bg-stone-100 text-stone-500";
                return (
                  <div key={c.id} className={`p-3 rounded-xl border ${c.selected ? "border-emerald-500 bg-emerald-50/20" : "border-stone-200 bg-white opacity-90"}`}>
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={c.selected}
                        onChange={() => updateStudentCandidate(c.id, { selected: !c.selected })}
                        className="mt-1 w-4 h-4 accent-emerald-700"
                        aria-label={`Seleziona ${c.title}`}
                      />
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold text-stone-900 uppercase">{COMMITMENT_TITLES[c.type]}</span>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusColor}`}>{studentMatchLabel(match)}</span>
                        </div>
                        <input
                          type="text"
                          value={c.title}
                          onChange={e => updateStudentCandidate(c.id, { title: e.target.value })}
                          className="w-full text-sm font-semibold text-stone-900 p-1 border-b border-transparent hover:border-stone-300 focus:border-emerald-600 focus:outline-hidden"
                          aria-label="Titolo impegno"
                        />
                        {c.studentNameRaw && (
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="text-stone-500">Alunno:</span>
                            <span className="font-medium text-stone-900 truncate">{c.studentNameRaw}</span>
                            {c.matchStatus === "ambiguous" && match.candidates.length > 0 && (
                              <select
                                value={c.matchedStudentId ?? ""}
                                onChange={e => {
                                  const chosen = students.find(s => s.id === e.target.value);
                                  updateStudentCandidate(c.id, {
                                    matchedStudentId: chosen?.id,
                                    matchStatus: chosen ? "probable" : "unmatched",
                                    matchConfidence: chosen ? 1 : undefined,
                                  });
                                }}
                                className="text-xs border border-stone-300 rounded-lg p-1 bg-white"
                                aria-label="Scegli l'alunno corretto"
                              >
                                <option value="">— scegli —</option>
                                {match.candidates.map(candidate => (
                                  <option key={candidate.id} value={candidate.id}>{candidate.fullName}</option>
                                ))}
                              </select>
                            )}
                            {c.matchStatus === "exact" || c.matchStatus === "probable" ? (
                              <span className="text-emerald-700 font-medium truncate">
                                {students.find(s => s.id === c.matchedStudentId)?.fullName}
                              </span>
                            ) : null}
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <label className="flex items-center gap-1">
                            <span className="text-stone-500 shrink-0">Data</span>
                            <input
                              type="date"
                              value={c.date ?? ""}
                              onChange={e => updateStudentCandidate(c.id, { date: e.target.value || undefined })}
                              className="flex-1 min-w-0 border border-stone-200 rounded-md p-1"
                            />
                          </label>
                          <label className="flex items-center gap-1">
                            <span className="text-stone-500 shrink-0">Ora</span>
                            <input
                              type="time"
                              value={c.startTime ?? ""}
                              onChange={e => updateStudentCandidate(c.id, { startTime: e.target.value || undefined })}
                              className="flex-1 min-w-0 border border-stone-200 rounded-md p-1"
                            />
                          </label>
                          <label className="flex items-center gap-1">
                            <span className="text-stone-500 shrink-0">Classe</span>
                            <input
                              type="text"
                              value={c.className ?? ""}
                              onChange={e => updateStudentCandidate(c.id, { className: e.target.value || undefined })}
                              className="flex-1 min-w-0 border border-stone-200 rounded-md p-1"
                            />
                          </label>
                          <label className="flex items-center gap-1">
                            <span className="text-stone-500 shrink-0">Materia</span>
                            <input
                              type="text"
                              value={c.subject ?? ""}
                              onChange={e => updateStudentCandidate(c.id, { subject: e.target.value || undefined })}
                              className="flex-1 min-w-0 border border-stone-200 rounded-md p-1"
                            />
                          </label>
                        </div>
                        {!c.date && <p className="text-[11px] text-amber-800">Mancante data: completala per poter salvare l'impegno.</p>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* STEP: ORARIO RICOSTRUITO (conferma umana obbligatoria) */}
          {step === "reconstruct" && reconSlots && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-stone-50 border border-stone-200 text-xs text-stone-600 space-y-2">
                <p>
                  Per ogni slot: giorno, ora, classe e materia di compresenza.
                  Correggi, deseleziona o completa gli slot con semaforo giallo/rosso:
                  <strong> nessuna materia viene inventata</strong>.
                </p>
                <div className="flex flex-wrap gap-3">
                  <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" /> certo</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> da verificare</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-rose-400 inline-block" /> materia non identificata</span>
                </div>
              </div>

              {multiSchool && (
                <label className="flex items-center gap-2 text-xs font-medium text-stone-700">
                  <span className="shrink-0">Istituto:</span>
                  <select
                    aria-label="Istituto"
                    value={reconSchoolId ?? schools[0]?.id ?? ""}
                    onChange={e => setReconSchoolId(e.target.value)}
                    className="flex-1 min-w-0 border border-stone-300 rounded-lg p-2 bg-white"
                  >
                    {schools.map(school => (
                      <option key={school.id} value={school.id}>{school.name}</option>
                    ))}
                  </select>
                </label>
              )}

              <label className="flex items-center gap-2 text-xs font-medium text-stone-700">
                <span className="shrink-0">Salva in:</span>
                <select
                  value={reconTarget}
                  onChange={e => { setReconTarget(e.target.value as TimetableType); setMergeMode("missing-only"); }}
                  className="flex-1 min-w-0 border border-stone-300 rounded-lg p-2 bg-white"
                >
                  <option value="provvisorio">Orario provvisorio</option>
                  <option value="definitivo">Orario definitivo</option>
                </select>
              </label>

              {existingTarget.length > 0 && (
                <fieldset className="p-3 rounded-xl border border-stone-200 space-y-2">
                  <legend className="text-xs font-semibold text-stone-700 px-1">
                    Esiste già un orario in questo archivio ({existingTarget.length} ore)
                  </legend>
                  <label className="flex items-start gap-2 text-xs text-stone-700 cursor-pointer">
                    <input type="radio" name="scan-merge-mode" checked={mergeMode === "missing-only"} onChange={() => setMergeMode("missing-only")} className="mt-0.5 accent-emerald-700" />
                    <span><strong>Aggiungi solo gli slot mancanti</strong> (le ore esistenti non vengono toccate)</span>
                  </label>
                  <label className="flex items-start gap-2 text-xs text-stone-700 cursor-pointer">
                    <input type="radio" name="scan-merge-mode" checked={mergeMode === "replace-selected"} onChange={() => setMergeMode("replace-selected")} className="mt-0.5 accent-emerald-700" />
                    <span><strong>Sostituisci gli slot selezionati</strong> (solo dove stesso giorno e periodo)</span>
                  </label>
                  <p className="text-[11px] text-stone-500">L'intero orario non viene mai cancellato da qui.</p>
                </fieldset>
              )}

              {reconSlots.length === 0 ? (
                <p className="text-xs text-stone-500 p-4 rounded-xl bg-stone-50 border border-stone-200">
                  Nessuno slot da confermare: la ricostruzione non ha prodotto orari.
                </p>
              ) : (
                <div className="space-y-3">
                  {reconSlots.map(slot => {
                    const signal = reconSignal(slot);
                    const times = periodTimesForIndex(timeSlotConfig, slot.periodIndex);
                    const hasClass = !!(slot.correctedClass ?? slot.classLabel ?? "").trim();
                    return (
                      <div
                        key={slot.id}
                        id={`recon-slot-${slot.id}`}
                        className={`p-3 rounded-xl border space-y-2 ${slot.selected === false ? "border-stone-200 opacity-70" : "border-stone-300 bg-white"}`}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={slot.selected !== false}
                            onChange={() => updateReconSlot(slot.id, { selected: !(slot.selected !== false) })}
                            className="w-5 h-5 accent-emerald-700"
                            aria-label={`Seleziona slot ${DAY_LABELS[slot.dayOfWeek]} ${slot.periodIndex}ª ora`}
                          />
                          <span
                            aria-hidden
                            className={`w-3 h-3 rounded-full shrink-0 ${signal === "green" ? "bg-emerald-500" : signal === "yellow" ? "bg-amber-400" : "bg-rose-400"}`}
                          />
                          <select
                            value={slot.dayOfWeek}
                            onChange={e => updateReconSlot(slot.id, { dayOfWeek: Number(e.target.value) })}
                            className="text-xs font-semibold text-stone-900 border border-stone-200 rounded-lg p-1.5 bg-white"
                            aria-label="Giorno"
                          >
                            {[1, 2, 3, 4, 5, 6].map(day => (
                              <option key={day} value={day}>{DAY_LABELS[day]}</option>
                            ))}
                          </select>
                          <select
                            value={slot.periodIndex}
                            onChange={e => updateReconSlot(slot.id, { periodIndex: Number(e.target.value) })}
                            className="text-xs font-semibold text-stone-900 border border-stone-200 rounded-lg p-1.5 bg-white"
                            aria-label="Periodo"
                          >
                            {Array.from({ length: 12 }, (_, i) => i + 1).map(p => (
                              <option key={p} value={p}>{`${p}ª ora`}</option>
                            ))}
                          </select>
                          <span className="text-[11px] text-stone-500 ml-auto">{`${times.startTime}–${times.endTime}`}</span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <label className="flex items-center gap-2 text-xs">
                            <span className="text-stone-500 shrink-0 w-14">Classe</span>
                            <input
                              type="text"
                              value={slot.correctedClass ?? ""}
                              onChange={e => updateReconSlot(slot.id, { correctedClass: e.target.value.toUpperCase() })}
                              className={`flex-1 min-w-0 border rounded-lg p-2 ${hasClass ? "border-stone-300 bg-white" : "border-amber-400 bg-amber-50"}`}
                              placeholder="es. 3D"
                            />
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <span className="text-stone-500 shrink-0 w-14">Compresenza</span>
                            <input
                              type="text"
                              value={slot.correctedSubject ?? ""}
                              onChange={e => updateReconSlot(slot.id, { correctedSubject: e.target.value })}
                              className="flex-1 min-w-0 border border-stone-300 rounded-lg p-2 bg-white"
                              placeholder={slot.status === "none" ? "Materia non identificata" : "es. Matematica"}
                            />
                          </label>
                        </div>

                        {slot.status === "ambiguous" && slot.coTeachingSubjects.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[11px] text-amber-800 font-medium">{RECON_NOTES.ambiguous}:</span>
                            {slot.coTeachingSubjects.map(candidate => (
                              <button
                                key={candidate}
                                type="button"
                                onClick={() => updateReconSlot(slot.id, { correctedSubject: candidate })}
                                className="text-[11px] font-semibold px-2 py-1 rounded-full bg-amber-100 text-amber-900 hover:bg-amber-200"
                              >
                                {candidate}
                              </button>
                            ))}
                          </div>
                        )}
                        {slot.status === "none" && (
                          <p className="text-[11px] font-medium text-rose-700">{slot.note ?? RECON_NOTES.none}</p>
                        )}
                        {!hasClass && <p className="text-[11px] text-amber-800">Classe mancante: completala oppure deseleziona lo slot.</p>}
                        <p className="text-[10px] text-stone-400">
                          Materia principale: {support ? "Sostegno" : "come indicato"} · confidenza{" "}
                          {slot.confidence === "high" ? "alta" : slot.confidence === "medium" ? "media" : "bassa"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer azioni */}
        {(step === "review-student" || step === "reconstruct") && (
          <div className="modal-sticky-footer p-3 border-t border-stone-200 bg-white flex items-center justify-between gap-2">
            {step === "reconstruct" ? (
              <>
                <div className="text-xs text-stone-600 min-w-0">
                  <strong className="text-emerald-800">{reconSlots?.filter(s => s.selected !== false).length ?? 0}</strong> slot selezionati · nessun salvataggio prima della conferma
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button type="button" onClick={onClose} className="min-h-[44px] px-4 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-100">
                    Annulla
                  </button>
                  <button
                    type="button"
                    id="recon-confirm-save"
                    onClick={() => void handleSaveReconstruction()}
                    disabled={save.pending}
                    className="min-h-[44px] px-4 sm:px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-bold shadow-xs flex items-center gap-1.5"
                  >
                    <Check className="w-4 h-4" />
                    Conferma e salva
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-xs text-stone-600 min-w-0 truncate">
                  <strong className="text-emerald-800">{studentCandidates?.filter(c => c.selected).length ?? 0}</strong> impegni selezionati
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button type="button" onClick={onClose} className="min-h-[44px] px-4 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-100">
                    Annulla
                  </button>
                  <button
                    type="button"
                    id="student-confirm-save"
                    onClick={() => void handleImportCommitments()}
                    disabled={save.pending}
                    className="min-h-[44px] px-4 sm:px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-bold shadow-xs flex items-center gap-1.5"
                  >
                    <Check className="w-4 h-4" />
                    Aggiungi in agenda
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {reconWarning && (
          <div className="p-2 border-t border-amber-200 bg-amber-50 text-amber-900 text-xs flex items-center justify-between gap-2">
            <span>{reconWarning}</span>
          </div>
        )}
      </div>
    </div>
  );
};
