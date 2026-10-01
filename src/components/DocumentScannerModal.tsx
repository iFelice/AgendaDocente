import { useAnalysisProgress } from "../hooks/useAnalysisProgress";
import { usePersistenceAction } from "../hooks/usePersistenceAction";
import {
  analyzeStudentDocument,
  analyzeTimetableDocument,
} from "../services/scanService";
import {
  CAMERA_INPUT_PROPS,
  FILE_INPUT_PROPS,
  PERSONAL_TIMETABLE_FILE_INPUT_PROPS,
  OFFLINE_ANALYSIS_MESSAGE,
  createPreviewUrl,
  documentFileError,
  formatFileSize,
  isOnline,
  readBlobAsBase64,
  revokePreviewUrl,
  type DocumentFileMeta,
} from "../utils/documentScanner";
import {
  partitionReconstructedSlots,
  rejectionReasonLabel,
  previewReconstruction,
  reconstructedToTimetableSlots,
  slotsInReplacementScope,
  type TimetableMergeMode,
} from "../utils/reconstructTimetable";
import { getEffectivePeriodSlots, timeSlotConfigForSchool } from "../utils/timeSlots";
import { appendProfileClasses, importedClassesMissingFromProfile } from "../utils/profileClasses";
import { isSupportTeacherOf } from "../utils/teacherType";
import { AnalysisProgressBar } from "./AnalysisProgressBar";
import { RECON_NOTES, crossrefTimetables, reconSignal, type ReconstructedSlot } from "../utils/timetableCrossref";
import {
  MAX_GRID_PERIODS,
  PERSONAL_SCHOOL_DAYS,
  buildPersonalCoordinateScope,
  curricularCellsToSlots,
  curricularScopeToRequestPayload,
  expectedPersonalCellCount,
  normalizePersonalPeriodsByDay,
  personalCellsToCandidates,
  restrictCurricularSlotsToCoordinates,
  summarizeCurricularCoverage,
  validateStudentCommitmentsPayload,
  type CurricularRawRow,
  type PersonalCoordinate,
  type PersonalTimetablePeriodsByDay,
  type CurricularTimetableSlot,
  type PersonalTimetableSlotCandidate,
  type SkippedCell,
  type StudentCommitmentCandidate,
  type TimetableRawCell,
} from "../utils/timetableAnalysis";
import { DAY_LABELS } from "../utils/timetableTokens";
import { matchStudentName, studentMatchLabel } from "../utils/studentMatcher";
import { getPrimarySchool, normalizeTeacherProfile, schoolByIdOrPrimary } from "../utils/multiSchool";
import { derivePersonalScannerPeriodsByDay } from "../utils/scannerWeekGeometry";
import {
  SpreadsheetTimetableError,
  inspectSpreadsheetTimetable,
  isSpreadsheetTimetableFile,
  readSpreadsheetWorkbook,
  spreadsheetRowToPersonalCells,
  type SpreadsheetSheet,
  type SpreadsheetTimetableInspection,
} from "../utils/spreadsheetTimetable";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Camera,
  Check,
  ChevronLeft,
  ClipboardCheck,
  CloudUpload,
  FileImage,
  FileText,
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
  | "spreadsheet-sheet"
  | "spreadsheet-row"
  | "consent"
  | "working"
  | "review-personal"
  | "review-curricular"
  | "review-student"
  | "reconstruct";

export interface CircularFileInfo {
  mode?: "file" | "text";
  base64?: string;
  mimeType?: string;
  fileName?: string;
  autoStartToken?: string;
}

interface ReconEditSlot extends ReconstructedSlot {
  /** Correzioni manuali dell'utente (classe/materia/giorno/periodo). */
  correctedClass?: string;
  correctedSubject?: string;
}

interface SpreadsheetImportState {
  sheets: SpreadsheetSheet[];
  inspection?: SpreadsheetTimetableInspection;
}

interface PersonalReviewState {
  /**
   * Etichetta della riga letta dal modello. È già stata verificata sul server
   * contro il cognome del profilo: qui è solo informazione per l'utente.
   */
  rowLabel: string;
  /**
   * Sequenza COMPLETA della riga del docente: una cella per posizione fisica,
   * da sinistra a destra, celle vuote incluse. Giorno e periodo di ogni cella
   * sono stati derivati dal server dalla posizione, non dal modello.
   */
  cells: TimetableRawCell[];
  /** Struttura della settimana dichiarata dall'utente per questa analisi. */
  periodsByDay: PersonalTimetablePeriodsByDay;
}

/**
 * Riga sintetica dell'orario personale: il modello legge UNA sola riga e le
 * coordinate nascono dall'indice della sequenza, quindi tutte le celle
 * appartengono alla riga 0. È il valore atteso da `personalCellsToCandidates`.
 */
const PERSONAL_ROW_INDEX = 0;

/** Domanda obbligatoria prima dell'analisi dell'orario personale. */
export const PERIODS_PER_DAY_QUESTION = "Quante ore ci sono in ogni giornata scolastica?";
/**
 * Proposta iniziale della domanda. È solo una proposta: l'analisi non parte finché
 * l'utente non conferma il numero, perché per un orario provvisorio le ore per
 * giorno non sono deducibili in modo affidabile né dall'immagine né dalla
 * configurazione delle fasce orarie dell'app.
 */
export const PERIODS_PER_DAY_DEFAULT_PROPOSAL = 5;
export const PERIODS_PER_DAY_CONFIRM_ERROR =
  "Conferma quante ore ci sono in ogni giornata scolastica prima di avviare l'analisi.";
/** Messaggio quando il valore non è (ancora) utilizzabile. */
export const PERIODS_PER_DAY_QUESTION_ERROR =
  `Indica quante ore ci sono in ogni giornata scolastica (numero intero da 1 a ${MAX_GRID_PERIODS}).`;

/**
 * Domanda sulla STRUTTURA DELLA SETTIMANA (orario personale).
 *
 * Sostituisce la vecchia domanda scalare «quante ore in ogni giornata»: la
 * settimana scolastica non è per forza rettangolare (6/6/6/7/6) e una domanda
 * con una sola risposta costringeva a mentire su almeno un giorno.
 */
export const WEEK_STRUCTURE_QUESTION = "Struttura della settimana";
/** Etichette dei cinque giorni, nell'ordine dei blocchi chiesti al modello. */
export const WEEK_STRUCTURE_DAY_LABELS = ["Lun", "Mar", "Mer", "Gio", "Ven"] as const;
export const WEEK_STRUCTURE_EDIT_LABEL = "Modifica";
export const WEEK_STRUCTURE_DONE_LABEL = "Fatto";
export const WEEK_STRUCTURE_CONFIRM_ERROR =
  "Conferma la struttura della settimana prima di avviare l'analisi.";
export const WEEK_STRUCTURE_QUESTION_ERROR =
  `Indica quante ore ha ciascun giorno, da 1 a ${MAX_GRID_PERIODS}.`;

/**
 * Riepilogo leggibile della struttura: «Lun 6 · Mar 6 · Mer 6 · Gio 7 · Ven 6».
 * Un'unica stringa (non figli JSX affiancati) così il testo letto dall'utente e
 * quello asserito dai test coincidono carattere per carattere.
 */
export function formatWeekStructureSummary(periodsByDay: readonly number[]): string {
  return periodsByDay.map((periods, index) => `${WEEK_STRUCTURE_DAY_LABELS[index] ?? index + 1} ${periods}`).join(" · ");
}

/**
 * Avviso PRE-SCANSIONE: la settimana arriva più in là delle fasce orarie
 * configurate (es. struttura fino alla 7ª ora ma solo 6 fasce). Non blocca
 * nulla — la scansione parte lo stesso e D1 scarterà in preview le ore prive di
 * fascia — ma dirlo prima evita la sorpresa dopo l'analisi.
 *
 * @returns il messaggio, oppure `null` se le fasce bastano.
 */
export function missingTimeSlotsWarning(
  periodsByDay: readonly number[],
  configuredSlots: number,
): string | null {
  const longestDay = periodsByDay.reduce((max, periods) => (periods > max ? periods : max), 0);
  if (longestDay <= configuredSlots) return null;
  return `La struttura della settimana prevede fino alla ${longestDay}ª ora, ma sono configurate solo ${configuredSlots} fasce orarie. Le lezioni oltre le fasce configurate non potranno essere importate.`;
}

/**
 * Messaggio quando l'orario curricolare viene chiesto senza alcuna coordinata.
 *
 * L'analisi curricolare non chiede più al modello l'intera tabella d'istituto:
 * cerca SOLO le coordinate (giorno + periodo + classe) in cui il docente è
 * presente. Senza coordinate non esiste nulla da cercare, quindi la richiesta
 * non parte (il server la rifiuterebbe comunque con 400).
 */
export const CURRICULAR_SCOPE_EMPTY_MESSAGE =
  "Nessuna coordinata da cercare: analizza e salva prima il tuo orario personale, poi ripeti con l'orario curricolare.";

/** Id del contenitore scrollabile del modale (fallback del ref, vedi `useEffect` di scroll). */
export const SCAN_MODAL_BODY_ID = "scan-modal-body";

/**
 * Id della SEZIONE OPERATIVA con la scelta «Mantieni e aggiungi / Sovrascrivi
 * orario esistente»: è la destinazione dello scroll quando la review dell'orario
 * personale è pronta (fallback del ref, vedi `useEffect` di scroll).
 */
export const SCAN_MERGE_CHOICE_ID = "scan-merge-choice";

/** Nodo su cui è possibile chiedere uno scroll (DOM reale o equivalente). */
export type ScrollableNode = {
  scrollTo?: (options: { top?: number; behavior?: string }) => void;
  scrollTop?: number;
};

/** Nodo a cui si può chiedere di essere portato in vista (DOM reale o equivalente). */
export type ScrollIntoViewNode = {
  scrollIntoView?: (options?: { behavior?: string; block?: string }) => void;
};

/**
 * Porta in vista una sezione del modale: `scrollIntoView` muove il PRIMO
 * contenitore scrollabile — il corpo del modale — e `block: "start"` allinea
 * l'inizio della sezione al suo bordo superiore (`scroll-mt-*` sulla sezione
 * tiene il margine sotto l'header sticky). Non è uno scroll generico in cima al
 * modale e non tocca mai `window`.
 * @returns true se uno scroll è stato davvero richiesto.
 */
export function scrollSectionIntoView(node: ScrollIntoViewNode | null | undefined): boolean {
  if (!node || typeof node.scrollIntoView !== "function") return false;
  node.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

/**
 * Porta in cima il contenuto scrollabile del modale: dopo un salvataggio riuscito
 * il messaggio di esito deve essere la prima cosa che l'utente vede (su mobile la
 * schermata restava in fondo e non si capiva se il salvataggio fosse andato a buon
 * fine). Lo scroll è del contenitore INTERNO del modale, mai di `window`.
 * @returns true se uno scroll è stato davvero richiesto.
 */
export function scrollModalBodyToTop(node: ScrollableNode | null | undefined): boolean {
  if (!node) return false;
  if (typeof node.scrollTo === "function") {
    node.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }
  node.scrollTop = 0;
  return true;
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
  /** Aggiornamento del Profilo tramite il normale flusso di persistenza dell'app. */
  onSaveProfile?: (profile: TeacherProfile, expected?: TeacherProfile) => void | false | Promise<void | false>;
  /** Salvataggio confermato degli impegni alunni estratti dal registro. */
  onImportStudentCommitments: (events: CalendarEvent[]) => void | false | Promise<void | false>;
}

const DOC_TYPE_OPTIONS: Array<{ id: ScanDocType; label: string; description: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "circolare", label: "Circolare", description: "Impegni, riunioni, scadenze", icon: ClipboardCheck },
  { id: "personal", label: "Orario personale / sostegno", description: "La tua riga nell'orario", icon: HeartHandshake },
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
  onSaveProfile,
  onImportStudentCommitments,
}) => {
  const save = usePersistenceAction();
  /** Progresso UI stimato dell'analisi (nessuna percentuale reale del backend). */
  const analysisProgress = useAnalysisProgress();
  const { start: startProgress, complete: completeProgress, stop: stopProgress } = analysisProgress;
  const [docType, setDocType] = useState<ScanDocType | null>(null);
  const [captureFor, setCaptureFor] = useState<CaptureFor | null>(null);
  const [step, setStep] = useState<Step>("type");
  const [file, setFile] = useState<DocumentFileMeta | null>(null);
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  /** Workbook e celle vivono solo durante questa apertura del modale. */
  const [spreadsheetImport, setSpreadsheetImport] = useState<SpreadsheetImportState | null>(null);
  const [isSpreadsheetReading, setIsSpreadsheetReading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);
  /**
   * Ore di ogni giornata scolastica, dichiarate dall'utente PRIMA dell'analisi
   * dell'orario personale. È l'unico ingresso della geometria: determina quante
   * celle deve contenere la sequenza (ore x giorni scolastici) e quindi il
   * giorno e il periodo di ogni cella. Stringa perché è il valore di un input.
   */
  const [periodsPerDayInput, setPeriodsPerDayInput] = useState<string>("");
  /**
   * Conferma esplicita del numero di ore. Non è mai preselezionata e si azzera ad
   * ogni modifica del numero: la domanda deve essere letta e accettata, non
   * scavalcata perché il campo era già compilato.
   */
  const [periodsPerDayConfirmed, setPeriodsPerDayConfirmed] = useState<boolean>(false);
  /**
   * STRUTTURA DELLA SETTIMANA dell'orario personale: le ore di ciascun giorno,
   * lunedì → venerdì, come valori di input (stringhe). È l'unico ingresso della
   * geometria dell'analisi personale e sostituisce il vecchio numero unico:
   * determina quante celle deve avere OGNI blocco giornaliero e quindi il
   * giorno e il periodo di ogni cella.
   *
   * Stato EFFIMERO: nasce derivato dal Profilo alla riapertura del modale, vive
   * per la singola scansione e non viene mai persistito. Il Profilo resta
   * l'unica fonte durevole della struttura della settimana.
   */
  const [periodsByDayInput, setPeriodsByDayInput] = useState<string[]>([]);
  /** La struttura è aperta in modifica (cinque campi) invece che in riepilogo. */
  const [weekStructureEditing, setWeekStructureEditing] = useState(false);
  const [personal, setPersonal] = useState<PersonalReviewState | null>(null);
  /** Ore curricolari GIÀ limitate alle mie coordinate: `droppedCount` è quanto è stato scartato. */
  const [curricular, setCurricular] = useState<{ rows: CurricularRawRow[]; slots: CurricularTimetableSlot[]; skipped: SkippedCell[]; droppedCount: number } | null>(null);
  const [studentCandidates, setStudentCandidates] = useState<StudentCommitmentCandidate[] | null>(null);
  const [reconSlots, setReconSlots] = useState<ReconEditSlot[] | null>(null);
  /**
   * ISTITUTO DELLA SCANSIONE, scelto PRIMA di analizzare il documento.
   *
   * Da lui dipende la struttura della settimana proposta, quindi la lunghezza
   * attesa di ogni blocco giornaliero nel prompt: sceglierlo dopo l'analisi
   * significherebbe aver già letto il documento con la geometria sbagliata.
   * Una volta avviata la ricostruzione resta CONGELATO in `reconSchoolId`, così
   * fra analisi e salvataggio la destinazione non può cambiare sotto silenzio.
   */
  const [scanSchoolId, setScanSchoolId] = useState<string | undefined>(undefined);
  const [reconSchoolId, setReconSchoolId] = useState<string | undefined>(undefined);
  /**
   * Archivio di destinazione. `null` = non ancora scelto: succede solo quando
   * esistono vecchie ore pertinenti in ENTRAMBI gli archivi, e in quel caso la
   * scelta spetta all'utente (nessuna cancellazione cross-archive automatica).
   */
  const [reconTarget, setReconTarget] = useState<TimetableType | null>("provvisorio");
  /**
   * Modalità predefinita/automatica: è quella effettivamente usata quando la
   * scelta esplicita non è richiesta (nessun vecchio orario pertinente, oppure
   * Fase B che arricchisce l'orario appena salvato).
   */
  const [mergeMode, setMergeMode] = useState<TimetableMergeMode>("missing-only");
  /**
   * Scelta ESPLICITA «sostituisci / mantieni e aggiungi» della Fase A: `null`
   * finché l'utente non la fa. Non viene mai pre-selezionata dal codice.
   */
  const [mergeChoice, setMergeChoice] = useState<TimetableMergeMode | null>(null);
  const [reconWarning, setReconWarning] = useState<string | null>(null);
  /**
   * FASE A salvata (orario personale/sostegno realmente scritto): da qui in poi
   * chiudere o tornare indietro NON perde l'orario, e viene offerta la Fase B
   * (orario curricolare per le compresenze) come passo facoltativo.
   */
  const [phaseASaved, setPhaseASaved] = useState<{
    hours: number;
    target: TimetableType;
    added: number;
    replaced: number;
    removed: number;
  } | null>(null);
  /** Classi importate ma ancora assenti dal Profilo: suggerimento post-import, non bloccante. */
  const [missingProfileClasses, setMissingProfileClasses] = useState<string[]>([]);
  const [savedDirty, setSavedDirty] = useState(false);

  /**
   * Proposta mostrata nella domanda sulle ore: la configurazione delle fasce
   * orarie dell'utente (`timeSlotConfig.periodsPerDay`) quando è un numero
   * sensato, altrimenti `PERIODS_PER_DAY_DEFAULT_PROPOSAL`. Il campo non è mai
   * vuoto, quindi la domanda si vede; ma resta solo una proposta, e il valore
   * usato è quello che l'utente conferma esplicitamente.
   */
  /**
   * Proposta iniziale della struttura della settimana: le ore che la SCUOLA
   * dichiara per ciascun giorno (6/6/6/7/6 se il Profilo ha un giovedì lungo),
   * o lo stesso numero per tutti i giorni se il Profilo non ha `dayPeriods`.
   *
   * La derivazione è centralizzata in `derivePersonalScannerPeriodsByDay`, che
   * resta indifferente a profili e id: la scuola giusta la sceglie QUI il
   * chiamante, ed è quella selezionata per la scansione (la primaria finché non
   * se ne sceglie un'altra, o se l'id non corrisponde a nessun istituto).
   */
  const scanSchool = useMemo(
    () => schoolByIdOrPrimary(scanSchoolId, normalizeTeacherProfile(profile).schools),
    [scanSchoolId, profile],
  );
  /**
   * FASCE ORARIE dell'istituto della scansione: le sue se le ha, altrimenti
   * quelle globali. Unica derivazione per tutto il percorso — geometria
   * proposta, avviso sulle fasce mancanti e orari degli slot importati devono
   * parlare della stessa scuola.
   */
  const scanTimeSlotConfig = useMemo(
    () => timeSlotConfigForSchool(scanSchool, timeSlotConfig),
    [scanSchool, timeSlotConfig],
  );
  const periodsByDayPrefill = useMemo(
    () => derivePersonalScannerPeriodsByDay(scanSchool, scanTimeSlotConfig),
    [scanSchool, scanTimeSlotConfig],
  );

  const periodsPerDayPrefill =
    typeof timeSlotConfig?.periodsPerDay === "number"
    && Number.isInteger(timeSlotConfig.periodsPerDay)
    && timeSlotConfig.periodsPerDay >= 1
    && timeSlotConfig.periodsPerDay <= MAX_GRID_PERIODS
      ? String(timeSlotConfig.periodsPerDay)
      : String(PERIODS_PER_DAY_DEFAULT_PROPOSAL);

  /** Ore per giorno dichiarate: 0 = valore assente o non accettabile. */
  const periodsPerDay = useMemo(() => {
    const trimmed = periodsPerDayInput.trim();
    // Solo cifre: niente decimali, niente segni, niente testo.
    if (!/^\d+$/.test(trimmed)) return 0;
    const value = Number(trimmed);
    return value >= 1 && value <= MAX_GRID_PERIODS ? value : 0;
  }, [periodsPerDayInput]);
  const periodsPerDayValid = periodsPerDay > 0;
  /**
   * Struttura della settimana dichiarata: `null` finché uno qualsiasi dei
   * cinque valori non è un intero utilizzabile. Nessuna correzione silenziosa:
   * una geometria attesa sbagliata farebbe passare o rifiutare un'analisi
   * intera, quindi o è valida tutta o non si parte.
   */
  const periodsByDay = useMemo<PersonalTimetablePeriodsByDay | null>(() => {
    const parsed = periodsByDayInput.map(value => {
      const trimmed = value.trim();
      // Solo cifre: niente decimali, niente segni, niente testo.
      return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    });
    return normalizePersonalPeriodsByDay(parsed);
  }, [periodsByDayInput]);
  const periodsByDayValid = periodsByDay !== null;
  /**
   * La domanda sulle ore per giorno riguarda sia l'orario personale (fissa la
   * lunghezza attesa della sequenza) sia quello curricolare (fissa il numero di
   * colonne orarie da cui derivare la geometria del crop). In entrambi i casi il
   * numero è dichiarato dall'utente e MAI dedotto dall'immagine.
   */
  const requiresPeriodsPerDay = captureFor === "curricular";
  /**
   * L'orario personale non chiede più un numero unico: chiede la struttura
   * della settimana, giorno per giorno. Il curricolare resta sulla domanda
   * scalare (lì il numero serve alle colonne della griglia d'istituto, che è
   * rettangolare per costruzione): le due domande non appaiono mai insieme,
   * perché `captureFor` è uno solo.
   */
  const requiresWeekStructure = captureFor === "personal";
  /** Celle attese: la SOMMA delle ore dei giorni (6+6+6+7+6 = 31). Informativa. */
  const expectedCellCount = periodsByDay ? expectedPersonalCellCount(periodsByDay) : 0;
  /** Riepilogo «Lun 6 · Mar 6 · Mer 6 · Gio 7 · Ven 6» dei valori inseriti ora. */
  const weekStructureSummary = periodsByDay ? formatWeekStructureSummary(periodsByDay) : "";
  /**
   * Avviso non bloccante: la struttura supera le fasce orarie configurate.
   * Calcolato prima della scansione; D1 resta comunque la rete finale in
   * preview.
   */
  const weekStructureSlotsWarning = useMemo(
    () => (periodsByDay ? missingTimeSlotsWarning(periodsByDay, getEffectivePeriodSlots(scanTimeSlotConfig).length) : null),
    [periodsByDay, scanTimeSlotConfig],
  );
  /**
   * Cambio di uno qualsiasi dei cinque valori: aggiorna quel giorno e azzera la
   * conferma. Il valore confermato è sempre quello che l'utente sta guardando.
   */
  const setDayPeriodsInput = (dayIndex: number, value: string): void => {
    setPeriodsByDayInput(current => current.map((day, index) => (index === dayIndex ? value : day)));
    setPeriodsPerDayConfirmed(false);
  };

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Contenitore scrollabile del corpo del modale: è lui a tornare in cima dopo un salvataggio. */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** Sezione con la scelta Aggiungi/Sovrascrivi: portata in vista quando la review è pronta. */
  const mergeChoiceRef = useRef<HTMLFieldSetElement | null>(null);
  /**
   * Lo scroll alla scelta è già avvenuto per QUESTA comparsa della sezione: un
   * ref (non uno stato) perché non deve provocare render e perché i rerender
   * successivi non devono ripetere lo scroll.
   */
  const mergeChoiceScrolled = useRef(false);
  const fileRef = useRef<File | null>(null);
  const readingRevision = useRef(0);
  // L'object URL corrente in un ref: il cleanup a unmount deve revocare SEMPRE
  // l'URL vivo al momento (non quello del mount).
  const previewUrlRef = useRef<string | undefined>(undefined);
  const setPreviewSafe = (url: string | undefined) => {
    previewUrlRef.current = url;
    setPreviewUrl(url);
  };

  const support = isSupportTeacherOf(profile);
  /** Etichetta dell'ambito sostituito: "sostegno" per i docenti di sostegno. */
  const natureLabel = support ? "sostegno" : "materia";
  const schools = useMemo(() => normalizeTeacherProfile(profile).schools ?? [], [profile]);
  const multiSchool = schools.length > 1;

  /**
   * Cambio dell'istituto prima della scansione.
   *
   * La struttura della settimana torna alla proposta della NUOVA scuola e la
   * conferma si azzera: una conferma data sulla geometria di un istituto non
   * può valere per un altro. Anche le eventuali modifiche manuali vengono
   * scartate — sono state fatte per descrivere un'altra scuola, e tenerle
   * mescolate al prefill del nuovo istituto darebbe una geometria che non
   * appartiene a nessuno dei due.
   *
   * La geometria NON viene ricalcolata qui: si aggiorna solo l'istituto e la
   * proposta arriva da `periodsByDayPrefill`, che resta l'unica derivazione.
   */
  const lastScanSchoolId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastScanSchoolId.current === scanSchoolId) return;
    lastScanSchoolId.current = scanSchoolId;
    setPeriodsByDayInput(periodsByDayPrefill.map(String));
    setWeekStructureEditing(false);
    setPeriodsPerDayConfirmed(false);
  }, [scanSchoolId, periodsByDayPrefill]);
  /** Archivio su cui si sta per scrivere: vuoto finché l'utente non lo sceglie. */
  const existingTarget = reconTarget === "provvisorio"
    ? provisionalTimetable
    : reconTarget === "definitivo"
      ? definitiveTimetable
      : [];

  /**
   * Gli slot che verrebbero REALMENTE salvati: stessa selezione e stesso filtro
   * (nessuna classe -> nessuno slot) di `handleSaveReconstruction`. È l'input
   * unico sia dell'anteprima sia del rilevamento del vecchio orario, così la
   * domanda e la scrittura non possono divergere.
   */
  const savePartition = useMemo(() => {
    const selected = (reconSlots ?? []).filter(s => s.selected !== false);
    const toSave = selected.filter(s => (s.correctedClass ?? s.classLabel ?? "").trim());
    return partitionReconstructedSlots(toSave, { profile, timeSlotConfig, schoolId: reconSchoolId });
  }, [reconSlots, profile, timeSlotConfig, reconSchoolId]);
  const saveableSlots = savePartition.slots;

  /**
   * Fasce orarie REALI dell'istituto di destinazione: unica fonte degli orari
   * mostrati in anteprima, e le stesse con cui D1 costruisce gli slot salvati.
   */
  const effectivePeriodSlots = useMemo(() => getEffectivePeriodSlots(scanTimeSlotConfig), [scanTimeSlotConfig]);

  /**
   * Elementi che NON verranno importati, indicizzati per id: l'anteprima deve
   * spiegarli uno per uno, non farli sparire in silenzio. Stessa partizione del
   * salvataggio, quindi cio che l'utente vede escluso e esattamente cio che
   * resta fuori dall'archivio.
   */
  const rejectedById = useMemo(
    () => new Map(savePartition.rejected.map(r => [r.item.id, r.reason])),
    [savePartition]
  );

  /**
   * Vecchie ore PERTINENTI nei due archivi, con la STESSA regola della
   * sovrascrittura reale (`slotsInReplacementScope`: stesso istituto — gli slot
   * legacy senza `schoolId` valgono l'istituto principale del profilo — e natura
   * dell'orario personale, non dei singoli slot in arrivo). Materie normali, ore di
   * altri istituti e dati fuori ambito non entrano qui, quindi non fanno comparire
   * nessuna domanda.
   */
  const pertinentExisting = useMemo(() => ({
    provvisorio: slotsInReplacementScope(provisionalTimetable, saveableSlots, { profile }),
    definitivo: slotsInReplacementScope(definitiveTimetable, saveableSlots, { profile }),
  }), [provisionalTimetable, definitiveTimetable, saveableSlots, profile]);

  /** CASO D: ore pertinenti in entrambi gli archivi -> la scelta dell'archivio è dell'utente. */
  const archiveChoiceRequired = pertinentExisting.provvisorio.length > 0 && pertinentExisting.definitivo.length > 0;

  /** Ore pertinenti nell'archivio scelto (o in entrambi, se ancora da scegliere). */
  const pertinentCount = reconTarget === "provvisorio"
    ? pertinentExisting.provvisorio.length
    : reconTarget === "definitivo"
      ? pertinentExisting.definitivo.length
      : pertinentExisting.provvisorio.length + pertinentExisting.definitivo.length;

  /**
   * La scelta «sostituisci / mantieni e aggiungi» è OBBLIGATORIA e senza default
   * solo in Fase A, quando esistono vecchie ore pertinenti. La Fase B
   * (`phaseASaved`) continua a usare la modalità preimpostata: serve ad
   * arricchire con le compresenze l'orario appena salvato nello stesso archivio.
   */
  const mergeChoiceRequired = pertinentCount > 0 && !phaseASaved;
  /** Modalità realmente applicata: `null` = scelta ancora dovuta, salvataggio bloccato. */
  const effectiveMergeMode: TimetableMergeMode | null = mergeChoiceRequired ? mergeChoice : mergeMode;

  /**
   * Anteprima della fusione per la schermata di conferma: gli STESSI conteggi che
   * l'applicazione produrrà (`previewReconstruction`), così l'utente sa cosa viene
   * aggiunto, sostituito o rimosso prima di salvare. Nessuna scrittura.
   */
  const mergePreview = useMemo(() => {
    if (saveableSlots.length === 0) return null;
    return previewReconstruction(existingTarget, saveableSlots, effectiveMergeMode ?? "missing-only", { profile });
  }, [saveableSlots, existingTarget, effectiveMergeMode, profile]);

  /**
   * Dopo un salvataggio RIUSCITO il contenuto del modale torna in cima: il messaggio
   * di esito è la prima cosa visibile. `phaseASaved` viene impostato SOLO dopo che
   * `save.run(...)` ha restituito true, quindi nessun salvataggio fallito (e nessuna
   * fase di analisi o di revisione) può provocare questo scroll. Il ref è il
   * percorso reale; il lookup per id è il fallback se il ref non è ancora agganciato.
   */
  useEffect(() => {
    if (!phaseASaved) return;
    const node = bodyRef.current
      ?? (typeof document === "undefined" ? null : document.getElementById(SCAN_MODAL_BODY_ID));
    scrollModalBodyToTop(node as ScrollableNode | null);
  }, [phaseASaved]);

  useEffect(() => {
    if (missingProfileClasses.length === 0) return;
    const stillMissing = importedClassesMissingFromProfile(
      profile,
      missingProfileClasses.map(className => ({ className })),
    );
    const unchanged = stillMissing.length === missingProfileClasses.length
      && stillMissing.every((value, index) => value === missingProfileClasses[index]);
    if (!unchanged) setMissingProfileClasses(stillMissing);
  }, [profile, missingProfileClasses]);

  /**
   * Review personale pronta: la sezione con la scelta «Mantieni e aggiungi /
   * Sovrascrivi orario esistente» viene portata in vista, perché su mobile resta
   * sotto la piega e l'utente doveva cercarla scorrendo a mano.
   *
   * Il trigger è la COMPARSA della sezione, non un render:
   *  - solo a ricostruzione pronta (`reconSlots`) nella schermata di conferma;
   *  - solo nel flusso personale (nessun curricolare incrociato: il percorso
   *    curricolare resta esattamente com'è);
   *  - solo se esistono vecchie ore pertinenti, cioè se la scelta c'è davvero;
   *  - mai durante l'analisi e mai dopo il salvataggio, quando vale l'altro
   *    scroll (in cima, al messaggio di esito).
   * Il flag nel ref fa sì che lo scroll parta UNA sola volta: né i rerender, né
   * un cambio di radio/select su una sezione già visibile lo ripetono.
   */
  const mergeChoiceVisible =
    step === "reconstruct" && !!reconSlots && pertinentCount > 0 && !!personal && !curricular && !phaseASaved;
  useEffect(() => {
    if (!mergeChoiceVisible) {
      // La sezione non è più a schermo (indietro, archivio senza ore pertinenti,
      // salvataggio): una sua nuova comparsa potrà riportarla in vista.
      mergeChoiceScrolled.current = false;
      return;
    }
    if (isAnalyzing || mergeChoiceScrolled.current) return;
    mergeChoiceScrolled.current = true;
    // Il ref è il percorso reale; il lookup per id è il fallback se il ref non è
    // ancora agganciato (stesso meccanismo dello scroll dopo il salvataggio).
    const node = mergeChoiceRef.current
      ?? (typeof document === "undefined" ? null : document.getElementById(SCAN_MERGE_CHOICE_ID));
    scrollSectionIntoView(node as ScrollIntoViewNode | null);
  }, [mergeChoiceVisible, isAnalyzing]);

  // Chiusura: nessuna animazione (e nessun timer) lascia il modale spento.
  useEffect(() => {
    if (isOpen) return;
    stopProgress();
  }, [isOpen, stopProgress]);

  // Reset completo ad ogni apertura: il progresso riparte da 0.
  useEffect(() => {
    if (!isOpen) return;
    stopProgress();
    setDocType(null);
    setCaptureFor(null);
    setStep("type");
    setFile(null);
    setFileBase64(null);
    setPreviewSafe(undefined);
    fileRef.current = null;
    setAnalysisError(null);
    setSpreadsheetImport(null);
    setIsSpreadsheetReading(false);
    setIsAnalyzing(false);
    setIsReading(false);
    setConsentGiven(false);
    setPeriodsPerDayInput(periodsPerDayPrefill);
    setPeriodsByDayInput(periodsByDayPrefill.map(String));
    setWeekStructureEditing(false);
    setPeriodsPerDayConfirmed(false);
    setPersonal(null);
    setCurricular(null);
    setStudentCandidates(null);
    setReconSlots(null);
    setScanSchoolId(undefined);
    setReconSchoolId(undefined);
    setReconTarget("provvisorio");
    setMergeMode("missing-only");
    setMergeChoice(null);
    setReconWarning(null);
    setPhaseASaved(null);
    setMissingProfileClasses([]);
    setSavedDirty(false);
    mergeChoiceScrolled.current = false;
  }, [isOpen]);

  // Privacy: a unmount si revoca SEMPRE l'object URL corrente (ref sempre aggiornato).
  useEffect(() => {
    return () => {
      revokePreviewUrl(previewUrlRef.current);
      fileRef.current = null;
    };
  }, []);

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

  /** Porta una riga letta localmente nello stesso stato review dello scanner AI. */
  const completeSpreadsheetImport = (inspection: SpreadsheetTimetableInspection, rowIndex: number) => {
    const teacher = inspection.teacherRows.find(row => row.rowIndex === rowIndex);
    if (!teacher) {
      setAnalysisError("La riga docente selezionata non è disponibile in questo foglio.");
      setStep("source");
      return;
    }
    try {
      const cells = spreadsheetRowToPersonalCells(inspection, rowIndex);
      // Dopo aver isolato la sola riga necessaria, rilascia l'intero workbook.
      // La review conserva solo le celle del docente, come il flusso AI.
      setSpreadsheetImport(null);
      setPersonal({ rowLabel: teacher.rowLabel, cells, periodsByDay: inspection.periodsByDay });
      setAnalysisError(null);
      setStep("review-personal");
    } catch (error) {
      setAnalysisError(error instanceof SpreadsheetTimetableError ? error.message : "Non riesco a leggere la riga docente del foglio.");
      setStep("source");
    }
  };

  /** Analizza il solo foglio scelto; una riga ambigua viene sempre mostrata in UI. */
  const chooseSpreadsheetSheet = (sheet: SpreadsheetSheet, sheets: SpreadsheetSheet[]) => {
    try {
      const inspection = inspectSpreadsheetTimetable(sheet, profile.fullName, periodsByDayPrefill);
      setSpreadsheetImport({ sheets, inspection });
      if (inspection.teacherRows.length === 1) {
        completeSpreadsheetImport(inspection, inspection.teacherRows[0].rowIndex);
      } else {
        setAnalysisError(null);
        setStep("spreadsheet-row");
      }
    } catch (error) {
      setAnalysisError(error instanceof SpreadsheetTimetableError ? error.message : "Non riesco a leggere il foglio selezionato.");
      // Con più fogli l'utente può provare un altro tab senza ricaricare il file.
      setStep(sheets.length > 1 ? "spreadsheet-sheet" : "source");
    }
  };

  /**
   * Percorso locale dell'orario personale: non crea base64, non chiede consenso
   * cloud e non chiama mai analyzeTimetableDocument. Workbook e file restano in
   * memoria fino a chiusura/reset del modale.
   */
  const startSpreadsheetImport = (picked: File) => {
    const revision = ++readingRevision.current;
    revokePreviewUrl(previewUrl);
    // Il File non serve più dopo arrayBuffer(): non viene trattenuto in stato/ref.
    fileRef.current = null;
    setPreviewSafe(undefined);
    setFile(null);
    setFileBase64(null);
    setSpreadsheetImport(null);
    setAnalysisError(null);
    setIsReading(false);
    setIsSpreadsheetReading(true);
    setStep("working");
    void readSpreadsheetWorkbook(picked)
      .then(workbook => {
        if (revision !== readingRevision.current) return;
        setIsSpreadsheetReading(false);
        if (workbook.sheets.length === 1) {
          chooseSpreadsheetSheet(workbook.sheets[0], workbook.sheets);
        } else {
          setSpreadsheetImport({ sheets: workbook.sheets });
          setStep("spreadsheet-sheet");
        }
      })
      .catch((error: unknown) => {
        if (revision !== readingRevision.current) return;
        setIsSpreadsheetReading(false);
        setAnalysisError(error instanceof SpreadsheetTimetableError
          ? error.message
          : "Non riesco a leggere il foglio. Verifica che il file non sia danneggiato.");
        setStep("source");
      });
  };

  /** Scatto o selezione: stesso percorso per foto/PDF; Excel/CSV solo per l'orario personale. */
  const handleFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = ""; // permette di ripescare lo stesso file
    if (!picked) return; // annullato: nessun crash, nessun stato
    const meta: DocumentFileMeta = { name: picked.name, size: picked.size, type: picked.type };
    if (captureFor === "personal" && isSpreadsheetTimetableFile(picked)) {
      const error = meta.size > 5 * 1024 * 1024 ? "Documento troppo grande: massimo 5 MB." : null;
      if (error) {
        setAnalysisError(error);
        setStep("source");
        return;
      }
      startSpreadsheetImport(picked);
      return;
    }
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
    setSpreadsheetImport(null);
    setIsSpreadsheetReading(false);
    setIsReading(false);
    setAnalysisError(null);
  };

  /** Handoff diretto per circolari: apre l'analizzatore in modalità testo senza passare da foto/file. */
  const handlePasteTextCircular = () => {
    resetCapture();
    onOpenCircularWithFile({
      mode: "text",
    });
  };

  const isOffline = !isOnline();

  /** "Analizza documento" dalla preview: per le circolari alimenta il flusso
   *  esistente con auto-start cloud; per gli altri tipi passa al consenso cloud (o blocca offline). */
  const handleAnalyzeFromPreview = () => {
    if (isReading) return;
    if (!file) return;
    if (captureFor === "circolare") {
      // Pipeline circolare esistente: la nuova UI alimenta l'analizzatore con token auto-start monouso.
      if (!fileBase64 || !file.type) return;
      const autoStartToken = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `circ-auto-${crypto.randomUUID()}`
        : `circ-auto-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      onOpenCircularWithFile({
        mode: "file",
        base64: fileBase64,
        mimeType: file.type,
        fileName: file.name,
        autoStartToken,
      });
      return;
    }
    if (isOffline) {
      setAnalysisError(OFFLINE_ANALYSIS_MESSAGE);
      return;
    }
    setConsentGiven(false);
    // Ogni ingresso nel passo di consenso riparte da zero: come il consenso, la
    // conferma delle ore non è mai ereditata da un'analisi precedente.
    setPeriodsPerDayConfirmed(false);
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
    // Orario personale: senza un numero di ore valido non esiste una lunghezza
    // attesa da verificare, e senza conferma esplicita quel numero è solo una
    // proposta. In entrambi i casi l'analisi non parte (il pulsante è già
    // disabilitato: questa è la stessa regola, difesa anche qui).
    if (requiresPeriodsPerDay && (!periodsPerDayValid || !periodsPerDayConfirmed)) {
      setAnalysisError(periodsPerDayValid ? PERIODS_PER_DAY_CONFIRM_ERROR : PERIODS_PER_DAY_QUESTION_ERROR);
      return;
    }
    // Orario personale: stessa regola, sulla struttura della settimana. Senza
    // cinque valori validi non esiste una lunghezza attesa per ogni giorno, e
    // senza conferma esplicita quella struttura è solo una proposta derivata
    // dal Profilo.
    if (requiresWeekStructure && (!periodsByDay || !periodsPerDayConfirmed)) {
      setAnalysisError(periodsByDay ? WEEK_STRUCTURE_CONFIRM_ERROR : WEEK_STRUCTURE_QUESTION_ERROR);
      return;
    }
    // Orario curricolare: senza coordinate non c'è nulla da cercare, quindi
    // l'analisi non parte (stessa regola del server, difesa anche qui per non
    // spendere una richiesta destinata a un 400).
    if (captureFor === "curricular" && personalCoordinates.length === 0) {
      setAnalysisError(CURRICULAR_SCOPE_EMPTY_MESSAGE);
      return;
    }
    const revision = readingRevision.current;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setStep("working");
    startProgress();
    try {
      if (captureFor === "personal") {
        // Guardia di tipo: il gate qui sopra ha già fermato il caso nullo, ma
        // la geometria non viene mai inviata "a metà".
        if (!periodsByDay) return;
        const result = await analyzeTimetableDocument({
          imageBase64: fileBase64,
          mimeType: file.type,
          documentType: "personal-support-timetable",
          profile,
          // Geometria dichiarata dall'utente, giorno per giorno: il server la
          // usa per verificare la lunghezza di ogni blocco giornaliero e per
          // derivare giorno/periodo.
          periodsByDay,
        });
        if (revision !== readingRevision.current) return;
        // La riga è già stata identificata dal modello e verificata sul server
        // contro il cognome del profilo: nessuna scelta della riga qui.
        const reviewState: PersonalReviewState = {
          rowLabel: result.rowLabel ?? "",
          cells: result.cells ?? [],
          periodsByDay,
        };
        completeProgress(() => {
          if (revision !== readingRevision.current) return; // modale chiuso o analisi annullata: nulla da mostrare
          setPersonal(reviewState);
          setStep("review-personal");
        });
      } else if (captureFor === "curricular") {
        const result = await analyzeTimetableDocument({
          imageBase64: fileBase64,
          mimeType: file.type,
          documentType: "curricular-timetable",
          profile,
          // Le MIE coordinate (giorno + periodo + classe), già costruite da
          // `buildPersonalCoordinateScope`: il modello cerca solo queste celle
          // invece di trascrivere l'intera tabella d'istituto. La `key` interna
          // non viene inviata.
          coordinateScope: curricularScopeToRequestPayload(personalCoordinates),
        });
        if (revision !== readingRevision.current) return;
        const rows: CurricularRawRow[] = (result.curricularRows ?? []).map((r, i) => ({
          rowIndex: Number.isInteger(r.rowIndex) ? r.rowIndex : i,
          rowLabel: r.rowLabel,
          subject: r.subject,
          classes: r.classes,
        }));
        const extraction = curricularCellsToSlots(rows, result.cells ?? []);
        // Filtro locale immediato: l'estrazione può contenere tutta la tabella
        // d'istituto, ma restano solo le mie coordinate (giorno+periodo+classe).
        const scoped = restrictCurricularSlotsToCoordinates(extraction.slots, personalCoordinates);
        const curricularState = { rows, ...extraction, slots: scoped.slots, droppedCount: scoped.droppedCount };
        completeProgress(() => {
          if (revision !== readingRevision.current) return;
          setCurricular(curricularState);
          setStep("review-curricular");
        });
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
        completeProgress(() => {
          if (revision !== readingRevision.current) return;
          setStudentCandidates(candidates);
          setStep("review-student");
        });
      }
      releaseDocument();
    } catch (error: unknown) {
      if (revision !== readingRevision.current) return;
      stopProgress(); // nessuna barra/animazione attiva sopra il messaggio di errore
      console.warn("Avviso analisi documento: richiesta cloud non completata.");
      setStep("preview");
      setAnalysisError(error instanceof Error ? error.message : "Analisi non riuscita. Riprova.");
    } finally {
      if (revision === readingRevision.current) setIsAnalyzing(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Orario personale: sequenza della riga -> candidati (mai celle inventate)
  // ---------------------------------------------------------------------------

  const personalCandidates: PersonalTimetableSlotCandidate[] = useMemo(() => {
    if (!personal) return [];
    const extraction = personalCellsToCandidates(personal.cells, [PERSONAL_ROW_INDEX]);
    return extraction.candidates;
  }, [personal]);

  const personalSkipped: SkippedCell[] = useMemo(() => {
    if (!personal) return [];
    return personalCellsToCandidates(personal.cells, [PERSONAL_ROW_INDEX]).skipped;
  }, [personal]);

  /**
   * Le coordinate (giorno + periodo + classe) del mio orario personale/sostegno:
   * candidati di questa sessione + ore già salvate. Un orario curricolare d'istituto
   * ha centinaia di ore: qui diventano SOLO la sorgente per le compresenze di queste
   * coordinate. Nulla viene mostrato, incrociato o salvato fuori da questo ambito.
   */
  const personalCoordinates = useMemo(
    () => buildPersonalCoordinateScope({
      candidates: personalCandidates,
      savedSlots: [...provisionalTimetable, ...definitiveTimetable],
    }),
    [personalCandidates, provisionalTimetable, definitiveTimetable]
  );

  /** Classi del mio orario: l'unico insieme cercato nella tabella d'istituto. */
  const personalClassLabels = useMemo<string[]>(() => {
    const labels = new Set<string>((personalCoordinates ?? []).map((c: PersonalCoordinate) => c.classLabel.toUpperCase()));
    return Array.from(labels).sort((a, b) => a.localeCompare(b, "it"));
  }, [personalCoordinates]);

  /** Riepilogo "ore del tuo orario · trovate · ambigue · non identificate". */
  const curricularCoverage = useMemo(
    () => summarizeCurricularCoverage(personalCoordinates, curricular?.slots ?? []),
    [personalCoordinates, curricular]
  );

  // Guard di chiusura: sta DOPO l'ultimo hook del componente, così numero e ordine
  // degli hook restano identici anche se il modale resta montato e isOpen passa
  // true -> false (in React «Rendered fewer hooks than expected» sarebbe fatale).
  // Sotto questo punto ci sono solo funzioni e JSX, nessun hook.
  if (!isOpen) return null;

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
    // Istituto CONGELATO: è quello scelto prima dell'analisi, cioè lo stesso
    // con cui è stata dichiarata la struttura della settimana e costruito il
    // prompt. Da qui in poi non cambia più per questa ricostruzione.
    const nextSchoolId = multiSchool ? scanSchool?.id : undefined;
    setReconSchoolId(nextSchoolId);
    // Archivio di destinazione: lo decide la posizione del vecchio orario
    // pertinente, non un default fisso. Gli slot in arrivo sono calcolati con la
    // stessa regola del salvataggio (nessuna classe -> nessuno slot) e la
    // pertinenza con `slotsInReplacementScope`, cioè la stessa della sostituzione.
    const incoming = reconstructedToTimetableSlots(
      reconstruction.filter(s => s.selected !== false && (s.correctedClass ?? s.classLabel ?? "").trim()),
      { profile, timeSlotConfig, schoolId: nextSchoolId },
    );
    const oldInProvisional = slotsInReplacementScope(provisionalTimetable, incoming, { profile }).length;
    const oldInDefinitive = slotsInReplacementScope(definitiveTimetable, incoming, { profile }).length;
    // Dopo il salvataggio della Fase A l'arricchimento (compresenze) deve sostituire
    // gli slot appena salvati: in "missing-only" li troverebbe già occupati e non
    // li toccherebbe. Prima di qualsiasi salvataggio vale la regola storica: mai
    // sovrascrivere automaticamente.
    if (phaseASaved) {
      // FASE B: stesso archivio della Fase A e sostituzione preimpostata (comportamento
      // necessario all'aggiornamento delle ore appena salvate: nessuna scelta da rifare).
      setReconTarget(phaseASaved.target);
      setMergeMode("replace-scope");
    } else if (oldInDefinitive > 0 && oldInProvisional === 0) {
      // CASO B: il vecchio orario pertinente è solo nel definitivo -> si aggiorna lì,
      // invece di scrivere il nuovo nel provvisorio e lasciare intatto il vecchio.
      setReconTarget("definitivo");
      setMergeMode("missing-only");
    } else if (oldInDefinitive > 0 && oldInProvisional > 0) {
      // CASO D: ore pertinenti in entrambi gli archivi. Nessuna cancellazione
      // cross-archive automatica: l'archivio lo sceglie l'utente.
      setReconTarget(null);
      setMergeMode("missing-only");
    } else {
      // CASO A (vecchio orario solo nel provvisorio) e CASO C (nessun vecchio
      // orario pertinente): archivio di default, nessuna domanda da rispondere.
      setReconTarget("provvisorio");
      setMergeMode("missing-only");
    }
    // La scelta esplicita riparte da zero ad ogni ingresso nella revisione: non
    // viene mai ereditata né pre-selezionata.
    setMergeChoice(null);
    setReconWarning(null);
    setMissingProfileClasses([]);
    setStep("reconstruct");
  };

  const updateReconSlot = (id: string, patch: Partial<ReconEditSlot>) => {
    setReconSlots(prev => (prev ? prev.map(s => (s.id === id ? { ...s, ...patch } : s)) : prev));
    setReconWarning(null);
    if (phaseASaved) setSavedDirty(true);
  };

  const handleSaveReconstruction = async () => {
    if (!reconSlots) return;
    const selected = reconSlots.filter(s => s.selected !== false);
    if (selected.length === 0) {
      setReconWarning("Seleziona almeno uno slot da salvare.");
      return;
    }
    // Scelte obbligatorie: senza archivio o senza decisione sostituisci/mantieni
    // non si scrive nulla (il pulsante è già disabilitato: stessa regola, difesa
    // anche qui). Nessuna modalità viene dedotta in silenzio.
    if (reconTarget === null) {
      setReconWarning("Scegli quale archivio aggiornare: provvisorio o definitivo.");
      return;
    }
    if (effectiveMergeMode === null) {
      setReconWarning("Scegli se sostituire l'orario esistente o aggiungere le nuove ore.");
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
    // Gli stessi slot dell'anteprima e del rilevamento del vecchio orario.
    const slots = saveableSlots;
    // Nessun salvataggio prima di qui: la conferma dell'utente è l'unico momento in
    // cui gli slot (e solo quelli confermati) vengono scritti nell'archivio.
    const preview = previewReconstruction(existingTarget, slots, effectiveMergeMode, { profile });
    if (!await save.run(() => onSaveReconstructedTimetable(slots, reconTarget, effectiveMergeMode))) return;
    // Conferma VISIBILE e modale aperto: l'orario è già in archivio, quindi da qui
    // in poi chiudere o tornare indietro non perde nulla (era il guasto su iPhone).
    setPhaseASaved({
      hours: slots.length,
      target: reconTarget,
      added: preview.addedCount,
      replaced: preview.replacedCount,
      removed: preview.removedCount,
    });
    setMissingProfileClasses(importedClassesMissingFromProfile(profile, slots));
    setSavedDirty(false);
    if (withoutClass.length > 0) {
      setReconWarning(`${withoutClass.length} slot senza classe non salvati: completali e salva di nuovo.`);
    }
  };

  const handleAddMissingProfileClasses = async () => {
    if (!onSaveProfile || missingProfileClasses.length === 0) return;
    const updatedClasses = appendProfileClasses(profile.classes ?? [], missingProfileClasses);
    const unchanged = updatedClasses.length === (profile.classes ?? []).length
      && updatedClasses.every((value, index) => value === (profile.classes ?? [])[index]);
    if (unchanged) {
      setMissingProfileClasses([]);
      return;
    }
    const updatedProfile: TeacherProfile = {
      ...profile,
      classes: updatedClasses,
    };
    if (!await save.run(() => onSaveProfile(updatedProfile, profile))) return;
    setMissingProfileClasses([]);
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
    "spreadsheet-sheet": "Scegli il foglio",
    "spreadsheet-row": "Scegli la riga docente",
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
                onClick={() => { stopProgress(); setStep("type"); resetCapture(); setPersonal(null); setCurricular(null); setStudentCandidates(null); setReconSlots(null); }}
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

        <div id={SCAN_MODAL_BODY_ID} ref={bodyRef} className="flex-1 overflow-y-auto p-4 momentum-scroll">
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

            </div>
          )}

          {/* STEP: sorgente (scatta foto / scegli foto o file / incolla testo per circolari) */}
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
                  <span className="block text-[11px] text-stone-500">{captureFor === "personal" ? "Foto · PDF · Excel · CSV" : "Foto da galleria o PDF"}</span>
                </span>
              </button>
              {captureFor === "circolare" && (
                <button
                  type="button"
                  id="scan-source-text"
                  onClick={handlePasteTextCircular}
                  className="w-full rounded-xl border-2 border-dashed border-stone-300 hover:border-amber-500 p-5 flex items-center gap-3 text-left bg-stone-50/60"
                >
                  <span className="w-11 h-11 rounded-xl bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
                    <FileText className="w-6 h-6" />
                  </span>
                  <span>
                    <span className="block text-sm font-bold text-stone-900">Incolla testo</span>
                    <span className="block text-[11px] text-stone-500">Testo copiato da circolare o bacheca</span>
                  </span>
                </button>
              )}
              {isOffline && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
                  {captureFor === "personal"
                    ? "Excel e CSV funzionano offline; foto e PDF richiedono una connessione per l'analisi AI."
                    : "Scatto e selezione funzionano offline: per l'analisi serve una connessione Internet."}
                </p>
              )}
              {/* Input nascosti: fotocamera con capture=environment (fallback
                  file picker dove non supportato) e file picker immagini/PDF. */}
              <input ref={cameraInputRef} type="file" className="hidden" onChange={handleFilePicked} {...CAMERA_INPUT_PROPS} aria-label="Scatta foto del documento" />
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFilePicked}
                {...(captureFor === "personal" ? PERSONAL_TIMETABLE_FILE_INPUT_PROPS : FILE_INPUT_PROPS)}
                aria-label="Scegli foto o file"
              />
            </div>
          )}

          {/* STEP: workbook con più fogli non vuoti: nessuna scelta automatica. */}
          {step === "spreadsheet-sheet" && spreadsheetImport && (
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 space-y-1">
                <p className="font-semibold">Il foglio viene letto solo su questo dispositivo.</p>
                <p>Nessun consenso cloud e nessuna analisi AI sono necessari per Excel o CSV.</p>
              </div>
              <p className="text-sm text-stone-700">Il file contiene più fogli con dati. Scegli quello che contiene il tuo orario:</p>
              <div className="space-y-2">
                {spreadsheetImport.sheets.map((sheet, index) => (
                  <button
                    key={`${sheet.name}-${index}`}
                    type="button"
                    id={`scan-spreadsheet-sheet-${index}`}
                    onClick={() => chooseSpreadsheetSheet(sheet, spreadsheetImport.sheets)}
                    className="w-full min-h-[44px] rounded-xl border border-stone-200 bg-white px-4 py-3 text-left text-sm font-semibold text-stone-900 hover:border-emerald-500 hover:bg-emerald-50"
                  >
                    {sheet.name || `Foglio ${index + 1}`}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => { resetCapture(); setStep("source"); }} className="min-h-[44px] px-4 rounded-xl text-sm font-semibold text-stone-600 hover:bg-stone-100">
                Scegli un altro file
              </button>
            </div>
          )}

          {/* STEP: più righe compatibili: è l'utente a scegliere, mai il parser. */}
          {step === "spreadsheet-row" && spreadsheetImport?.inspection && (
            <div className="space-y-4">
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                Ho trovato più righe compatibili con il nome del Profilo. Scegli la tua riga prima di continuare.
              </div>
              <div className="space-y-2">
                {spreadsheetImport.inspection.teacherRows.map((row, index) => (
                  <button
                    key={`${row.rowIndex}-${row.columnIndex}`}
                    type="button"
                    id={`scan-spreadsheet-row-${index}`}
                    onClick={() => completeSpreadsheetImport(spreadsheetImport.inspection!, row.rowIndex)}
                    className="w-full min-h-[44px] rounded-xl border border-stone-200 bg-white px-4 py-3 text-left text-sm font-semibold text-stone-900 hover:border-emerald-500 hover:bg-emerald-50"
                  >
                    {row.rowLabel || `Riga ${row.rowIndex + 1}`}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setStep("spreadsheet-sheet")} className="min-h-[44px] px-4 rounded-xl text-sm font-semibold text-stone-600 hover:bg-stone-100">
                Cambia foglio
              </button>
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
                  {isReading
                    ? "Lettura file…"
                    : captureFor === "circolare"
                    ? "Analizza nel cloud"
                    : "Analizza documento"}
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
                <p className="text-amber-800">Dopo l&apos;analisi il file viene scartato dall&apos;app: nessun backup, nessuna copia sul server.</p>
              </div>

              {/* Orario personale: la STRUTTURA DELLA SETTIMANA è dichiarata
                  dall'utente PRIMA dell'analisi. Da quanti sono i periodi di
                  ogni giorno dipendono la lunghezza attesa di ogni blocco
                  giornaliero e quindi il giorno/periodo di ogni cella: senza
                  cinque valori validi e confermati l'analisi non parte.
                  Non è la configurazione delle FASCE ORARIE (a che ora suona la
                  campana): quella si modifica dalla griglia dell'orario. */}
              {/* Istituto della scansione. Sta PRIMA della struttura della
                  settimana perché è lui a determinarla: le ore di ogni giorno
                  sono quelle dichiarate da questa scuola. Compare solo con più
                  istituti; con uno solo il percorso resta quello di D3. */}
              {requiresWeekStructure && multiSchool && (
                <label className="flex items-center gap-2 text-xs font-medium text-stone-700">
                  <span className="shrink-0">Istituto</span>
                  <select
                    id="scan-school-select"
                    aria-label="Istituto della scansione"
                    value={scanSchool?.id ?? ""}
                    onChange={e => setScanSchoolId(e.target.value)}
                    className="flex-1 min-w-0 border border-stone-300 rounded-lg p-2 bg-white"
                  >
                    {schools.map(school => (
                      <option key={school.id} value={school.id}>{school.name}</option>
                    ))}
                  </select>
                </label>
              )}

              {requiresWeekStructure && (
                <div className="p-3 rounded-xl border border-stone-200 bg-white space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="block text-xs font-semibold text-stone-900">{WEEK_STRUCTURE_QUESTION}</span>
                    <button
                      type="button"
                      id="scan-week-structure-edit"
                      onClick={() => setWeekStructureEditing(editing => !editing)}
                      className="text-xs font-semibold text-emerald-800 underline min-h-[44px] px-2"
                    >
                      {weekStructureEditing ? WEEK_STRUCTURE_DONE_LABEL : WEEK_STRUCTURE_EDIT_LABEL}
                    </button>
                  </div>
                  <p id="scan-week-structure-summary" className="text-sm text-stone-900">
                    {periodsByDayValid ? weekStructureSummary : WEEK_STRUCTURE_QUESTION_ERROR}
                  </p>
                  {weekStructureEditing && (
                    <div id="scan-week-structure-fields" className="flex flex-wrap gap-2">
                      {WEEK_STRUCTURE_DAY_LABELS.map((label, dayIndex) => (
                        <div key={label} className="flex flex-col gap-1">
                          <label htmlFor={`scan-week-periods-${dayIndex}`} className="text-[11px] font-semibold text-stone-700">
                            {label}
                          </label>
                          <input
                            id={`scan-week-periods-${dayIndex}`}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={MAX_GRID_PERIODS}
                            step={1}
                            value={periodsByDayInput[dayIndex] ?? ""}
                            onChange={event => setDayPeriodsInput(dayIndex, event.target.value)}
                            className="w-16 min-h-[44px] px-2 rounded-lg border border-stone-300 text-sm text-stone-900"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <p id="scan-week-structure-help" className="text-[11px] text-stone-500">
                    {periodsByDayValid
                      ? `La tua riga sarà letta come ${expectedCellCount} posizioni (lunedì-venerdì), celle libere incluse.`
                      : WEEK_STRUCTURE_QUESTION_ERROR}
                  </p>
                  {/* Avviso NON bloccante: la settimana supera le fasce orarie
                      configurate. La scansione parte lo stesso; le ore senza
                      fascia verranno scartate in preview. */}
                  {weekStructureSlotsWarning && (
                    <p id="scan-week-structure-slots-warning" className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
                      {weekStructureSlotsWarning}
                    </p>
                  )}
                  {/* Conferma esplicita: senza di questa l'analisi non parte, e
                      ogni modifica di un giorno la azzera. */}
                  <label
                    htmlFor="scan-week-structure-confirm"
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${periodsByDayValid ? "border-stone-200 bg-stone-50" : "border-stone-200 bg-stone-100 opacity-60"}`}
                  >
                    <input
                      type="checkbox"
                      id="scan-week-structure-confirm"
                      checked={periodsPerDayConfirmed && periodsByDayValid}
                      disabled={!periodsByDayValid}
                      onChange={event => setPeriodsPerDayConfirmed(event.target.checked)}
                      className="mt-0.5 w-5 h-5 accent-emerald-700"
                    />
                    <span className="text-xs text-stone-700">
                      {periodsByDayValid
                        ? `Confermo che il mio orario segue questa struttura: ${weekStructureSummary} (${expectedCellCount} posizioni complessive).`
                        : "Indica prima le ore di ogni giorno per poter confermare."}
                    </span>
                  </label>
                </div>
              )}

              {/* Orario CURRICOLARE: la griglia d'istituto è rettangolare per
                  costruzione, quindi qui resta la domanda con un numero unico —
                  fissa le colonne orarie da cui deriva la geometria del crop.
                  Non compare mai insieme alla struttura della settimana qui
                  sopra: `captureFor` è uno solo. */}
              {requiresPeriodsPerDay && (
                <div className="p-3 rounded-xl border border-stone-200 bg-white space-y-2">
                  <label htmlFor="scan-periods-per-day" className="block text-xs font-semibold text-stone-900">
                    {PERIODS_PER_DAY_QUESTION}
                  </label>
                  <input
                    id="scan-periods-per-day"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_GRID_PERIODS}
                    step={1}
                    value={periodsPerDayInput}
                    onChange={event => {
                      // Ogni modifica invalida la conferma: il numero confermato
                      // è sempre quello che l'utente sta guardando adesso.
                      setPeriodsPerDayInput(event.target.value);
                      setPeriodsPerDayConfirmed(false);
                    }}
                    className="w-24 min-h-[44px] px-3 rounded-lg border border-stone-300 text-sm text-stone-900"
                    aria-describedby="scan-periods-per-day-help"
                  />
                  <p id="scan-periods-per-day-help" className="text-[11px] text-stone-500">
                    {periodsPerDayValid
                      ? `La tua riga sarà letta come ${expectedCellCount} posizioni: ${periodsPerDay} ${periodsPerDay === 1 ? "ora" : "ore"} per ${PERSONAL_SCHOOL_DAYS} giorni (lunedì-venerdì), celle libere incluse.`
                      : PERIODS_PER_DAY_QUESTION_ERROR}
                  </p>
                  {/* Conferma esplicita: senza di questa l'analisi non parte, così
                      il numero proposto non può essere inviato per distrazione. */}
                  <label
                    htmlFor="scan-periods-per-day-confirm"
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${periodsPerDayValid ? "border-stone-200 bg-stone-50" : "border-stone-200 bg-stone-100 opacity-60"}`}
                  >
                    <input
                      type="checkbox"
                      id="scan-periods-per-day-confirm"
                      checked={periodsPerDayConfirmed && periodsPerDayValid}
                      disabled={!periodsPerDayValid}
                      onChange={event => setPeriodsPerDayConfirmed(event.target.checked)}
                      className="mt-0.5 w-5 h-5 accent-emerald-700"
                    />
                    <span className="text-xs text-stone-700">
                      {periodsPerDayValid
                        ? captureFor === "curricular"
                          ? `Confermo: la griglia ha ${periodsPerDay} ${periodsPerDay === 1 ? "ora" : "ore"} ogni giorno (${expectedCellCount} colonne orarie, lunedì-venerdì).`
                          : `Confermo: il mio orario ha ${periodsPerDay} ${periodsPerDay === 1 ? "ora" : "ore"} ogni giorno (${expectedCellCount} posizioni, lunedì-venerdì).`
                        : "Inserisci prima il numero di ore per poter confermare."}
                    </span>
                  </label>
                </div>
              )}

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
                  disabled={
                    !consentGiven || isOffline || isAnalyzing
                    // Orario personale: senza un numero di ore valido E confermato
                    // non esiste una lunghezza attesa certa, quindi non si parte.
                    || (requiresPeriodsPerDay && (!periodsPerDayValid || !periodsPerDayConfirmed))
                    || (requiresWeekStructure && (!periodsByDayValid || !periodsPerDayConfirmed))
                  }
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
            <div className="py-8 sm:py-10 flex flex-col items-center gap-3 text-center">
              <CloudUpload className="w-10 h-10 text-emerald-700 animate-pulse" />
              <p className="text-sm font-semibold text-stone-900">
                {isSpreadsheetReading ? "Lettura del foglio in corso…" : "Analisi del documento in corso…"}
              </p>
              {isSpreadsheetReading ? (
                <p className="text-xs text-stone-500 max-w-xs">Il file Excel o CSV resta nel browser e non viene inviato a servizi AI.</p>
              ) : (
                <>
                  <AnalysisProgressBar
                    percent={analysisProgress.percent}
                    phase={analysisProgress.phase}
                    label={analysisProgress.label}
                  />
                  <p className="text-xs text-stone-500 max-w-xs">Il documento non viene salvato: l'elaborazione può richiedere alcuni secondi.</p>
                </>
              )}
            </div>
          )}

          {/* STEP: revisione orario personale (sequenza completa, vuoti inclusi) */}
          {step === "review-personal" && personal && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-1">
                <p className="font-semibold">
                  Riga letta nel documento: <strong>{personal.rowLabel || "etichetta non leggibile"}</strong>
                </p>
                <p id="scan-personal-sequence-count">
                  {`${personal.cells.length} posizioni (${formatWeekStructureSummary(personal.periodsByDay)}): `}
                  {personal.cells.filter(cell => cell.raw.trim()).length} occupate,{" "}
                  {personal.cells.filter(cell => !cell.raw.trim()).length} vuote.
                </p>
                <p className="text-[11px] text-emerald-800">
                  Giorno e numero d&apos;ora derivano dalla posizione nella sequenza: controlla qui sotto le ore libere
                  prima di salvare. Nessuna ora viene salvata automaticamente.
                </p>
              </div>

              {/* Sequenza COMPLETA della riga: una riga per ogni posizione fisica,
                  celle vuote incluse e visibili. */}
              <div id="scan-personal-sequence" className="space-y-3">
                {Array.from({ length: PERSONAL_SCHOOL_DAYS }, (_, dayOffset) => {
                  const day = dayOffset + 1;
                  const cellsOfDay = personal.cells.filter(cell => cell.dayOfWeek === day);
                  return (
                    <div key={day} className="rounded-xl border border-stone-200 bg-white p-3">
                      <p className="text-xs font-bold text-stone-900 mb-2">{DAY_LABELS[day]}</p>
                      <div className="space-y-1.5">
                        {cellsOfDay.map(cell => {
                          const free = !cell.raw.trim();
                          return (
                            <div
                              key={`${cell.dayOfWeek}-${cell.periodIndex}`}
                              className="flex items-center gap-3 text-xs"
                              data-day={cell.dayOfWeek}
                              data-period={cell.periodIndex}
                            >
                              <span className="w-16 shrink-0 text-stone-500">{cell.periodIndex}ª ora</span>
                              <span
                                className={`px-2 py-0.5 rounded-md font-bold ${free ? "bg-stone-100 text-stone-400 italic" : "bg-emerald-100 text-emerald-900"}`}
                              >
                                {free ? "libera" : cell.raw}
                              </span>
                            </div>
                          );
                        })}
                        {cellsOfDay.length === 0 && (
                          <p className="text-[11px] text-stone-400">Nessuna posizione per questo giorno.</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {personalCandidates.length === 0 ? (
                <p className="text-xs text-stone-600 p-4 rounded-xl bg-stone-50 border border-stone-200">
                  Nessuna cella interpretabile nella riga: nessuna ora è stata inventata. Puoi riprovare con un&apos;altra foto.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold text-stone-600">
                    Ore che verranno salvate ({personalCandidates.length}):
                  </p>
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

              {personalCandidates.length > 0 && (
                <p className="text-[11px] text-stone-500">
                  {phaseASaved
                    ? "Orario personale già salvato: le ore sono nella vista Orario."
                    : "Nessun salvataggio ancora effettuato: rivedi le ore e usa «Salva questo orario»."}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  id="scan-personal-continue"
                  onClick={buildReconstruction}
                  disabled={personalCandidates.length === 0}
                  className="min-h-[44px] px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-sm font-bold shadow-xs"
                >
                  {support ? "Revisiona e salva l'orario" : "Revisiona e conferma"}
                </button>
              </div>
            </div>
          )}

          {/* STEP: revisione orario curricolare */}
          {step === "review-curricular" && curricular && (
            <div className="space-y-4">
              <div id="scan-curricular-summary" className="p-3 rounded-xl bg-stone-50 border border-stone-200 text-xs text-stone-600 space-y-1.5">
                <p id="scan-curricular-counts" className="font-semibold text-stone-900">
                  {curricularCoverage.hours} {curricularCoverage.hours === 1 ? "ora del tuo orario" : "ore del tuo orario"}
                  {" · "}{curricularCoverage.found} {curricularCoverage.found === 1 ? "materia trovata" : "materie trovate"}
                  {" · "}{curricularCoverage.ambiguous} {curricularCoverage.ambiguous === 1 ? "ambigua" : "ambigue"}
                  {" · "}{curricularCoverage.missing} {curricularCoverage.missing === 1 ? "non identificata" : "non identificate"}
                </p>
                {personalClassLabels.length > 0 && (
                  <p className="text-[11px]">
                    Le tue {personalClassLabels.length} {personalClassLabels.length === 1 ? "classe" : "classi"}:{" "}
                    <span className="font-semibold text-emerald-900">{personalClassLabels.join(", ")}</span>
                    {" — "}solo le ore curricolari di queste classi, nei tuoi giorni e orari, vengono considerate.
                  </p>
                )}
                {curricular.droppedCount > 0 && (
                  <p id="scan-curricular-filtered" className="text-[11px] text-stone-500">
                    {curricular.droppedCount} {curricular.droppedCount === 1 ? "ora di altre classi è stata esclusa" : "ore di altre classi sono state escluse"}:
                    non vengono né mostrate, né incrociate, né salvate.
                  </p>
                )}
                <p className="text-[11px] text-stone-500">
                  Il nome dei docenti curricolari non ti serve e non viene salvato: questa tabella è solo la sorgente
                  per ricostruire le tue compresenze.
                </p>
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
                    {curricular.droppedCount > 0
                      ? "Nessuna delle tue ore trova una materia corrispondente nella tabella curricolare: nessuna cella è stata inventata e nessuna ora di altre classi è stata aggiunta."
                      : "Nessuna ora interpretabile: nessuna cella è stata inventata."}
                  </p>
                )}
              </div>
              {support ? (
                <div className="flex items-center justify-end gap-2">
                  {personal !== null && (
                    <button
                      type="button"
                      id="scan-curricular-back-personal"
                      onClick={() => setStep("review-personal")}
                      className="min-h-[44px] px-3 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-100"
                    >
                      Torna alla tua riga
                    </button>
                  )}
                  <button
                    type="button"
                    id="scan-curricular-reconstruct"
                    onClick={() => {
                      if (personal !== null && personalCandidates.length > 0) {
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
                const displayMatch = { ...match, status: c.matchStatus, matchedStudentId: c.matchedStudentId };
                const manualCandidates = c.matchStatus === "ambiguous"
                  ? match.candidates
                  : students.map(student => ({ id: student.id, fullName: student.fullName, confidence: 0 }));
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
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusColor}`}>{studentMatchLabel(displayMatch)}</span>
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
                            {(c.matchStatus === "ambiguous" || c.matchStatus === "unmatched") && manualCandidates.length > 0 && (
                              <select
                                value={c.matchedStudentId ?? ""}
                                onChange={e => {
                                  const chosen = students.find(s => s.id === e.target.value);
                                  updateStudentCandidate(c.id, {
                                    matchedStudentId: chosen?.id,
                                    matchStatus: chosen ? "probable" : c.matchStatus,
                                    matchConfidence: chosen ? 1 : undefined,
                                  });
                                }}
                                className="text-xs border border-stone-300 rounded-lg p-1 bg-white"
                                aria-label="Scegli l'alunno corretto"
                              >
                                <option value="">— scegli —</option>
                                {manualCandidates.map(candidate => (
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
              {phaseASaved && (
                <div
                  id="scan-timetable-saved"
                  role="status"
                  className="p-3 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-900 space-y-2"
                >
                  <p className="text-sm font-bold flex items-center gap-1.5">
                    <Check className="w-4 h-4 shrink-0" />
                    Orario salvato{savedDirty ? " · modifiche non ancora salvate" : ""}
                  </p>
                  <p className="text-xs">
                    {phaseASaved.hours} ore in {phaseASaved.target === "provvisorio" ? "Orario provvisorio" : "Orario definitivo"}
                    {phaseASaved.added > 0 && ` · ${phaseASaved.added} aggiunte`}
                    {phaseASaved.replaced > 0 && `, ${phaseASaved.replaced} sostituite`}
                    {phaseASaved.removed > 0 && `, ${phaseASaved.removed} vecchie rimosse`}
                    . L'orario è già in archivio: puoi chiudere questa finestra e lo trovi nella vista Orario.
                  </p>
                </div>
              )}

              {phaseASaved && missingProfileClasses.length > 0 && (
                <div
                  id="scan-profile-class-suggestion"
                  role="status"
                  className="p-3 rounded-xl border border-sky-300 bg-sky-50 text-sky-950 space-y-2"
                >
                  <p className="text-sm font-bold">
                    {missingProfileClasses.length === 1
                      ? "Nuova classe rilevata nell'orario"
                      : "Nuove classi rilevate nell'orario"}
                  </p>
                  <p className="text-xs">
                    {missingProfileClasses.length === 1
                      ? `L'orario contiene la classe ${missingProfileClasses[0]}, che non è ancora presente nel tuo Profilo.`
                      : `L'orario contiene classi non ancora presenti nel tuo Profilo: ${missingProfileClasses.join(" · ")}.`}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {onSaveProfile && (
                      <button
                        type="button"
                        id="scan-profile-classes-add"
                        onClick={() => void handleAddMissingProfileClasses()}
                        disabled={save.pending}
                        className="min-h-[40px] px-3 rounded-lg bg-sky-700 hover:bg-sky-800 disabled:opacity-50 text-white text-xs font-bold shadow-xs"
                      >
                        {missingProfileClasses.length === 1
                          ? `Aggiungi ${missingProfileClasses[0]} alle mie classi`
                          : "Aggiungi alle mie classi"}
                      </button>
                    )}
                    <button
                      type="button"
                      id="scan-profile-classes-dismiss"
                      onClick={() => setMissingProfileClasses([])}
                      className="min-h-[40px] px-3 rounded-lg text-xs font-semibold text-sky-900 hover:bg-sky-100"
                    >
                      Non ora
                    </button>
                  </div>
                </div>
              )}

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

              {/* Istituto: scelto prima della scansione e ormai congelato. Qui
                  si LEGGE soltanto — cambiarlo adesso significherebbe aver
                  letto il documento con la geometria di un'altra scuola e aver
                  già scartato ore che quella nuova ammetterebbe. */}
              {multiSchool && (
                <p id="recon-school" className="text-xs font-medium text-stone-700">
                  <span>Istituto: </span>
                  <span className="font-semibold text-stone-900">
                    {schoolByIdOrPrimary(reconSchoolId, schools)?.name ?? ""}
                  </span>
                </p>
              )}

              <label className="flex items-center gap-2 text-xs font-medium text-stone-700">
                <span className="shrink-0">Salva in:</span>
                <select
                  id="recon-target"
                  aria-label="Archivio di destinazione"
                  value={reconTarget ?? ""}
                  onChange={e => {
                    const next = e.target.value as TimetableType | "";
                    setReconTarget(next === "" ? null : next);
                    // Cambiando archivio la decisione va rifatta su quello nuovo.
                    setMergeChoice(null);
                    if (phaseASaved) setSavedDirty(true);
                  }}
                  className="flex-1 min-w-0 border border-stone-300 rounded-lg p-2 bg-white"
                >
                  {reconTarget === null && <option value="">Scegli l'archivio…</option>}
                  <option value="provvisorio">Orario provvisorio</option>
                  <option value="definitivo">Orario definitivo</option>
                </select>
              </label>

              {archiveChoiceRequired && (
                <p id="recon-archive-choice" className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                  Vecchie ore di {natureLabel} presenti in <strong>entrambi</strong> gli archivi
                  ({pertinentExisting.provvisorio.length} nel provvisorio, {pertinentExisting.definitivo.length} nel definitivo):
                  scegli quale aggiornare. L&apos;altro archivio non viene toccato.
                </p>
              )}

              {pertinentCount > 0 && (
                <fieldset
                  id={SCAN_MERGE_CHOICE_ID}
                  ref={mergeChoiceRef}
                  className="p-3 rounded-xl border border-stone-200 space-y-2 scroll-mt-3"
                >
                  <legend className="text-xs font-semibold text-stone-700 px-1">
                    Esiste già un orario di {natureLabel} salvato.
                  </legend>
                  <p className="text-[11px] text-stone-500">
                    Archivio: {reconTarget === "definitivo" ? "Definitivo" : reconTarget === "provvisorio" ? "Provvisorio" : "da scegliere"}
                    {" · "}{pertinentCount} {pertinentCount === 1 ? "ora pertinente" : "ore pertinenti"}
                  </p>
                  <label className="flex items-start gap-2 text-xs text-stone-700 cursor-pointer">
                    <input type="radio" name="scan-merge-mode" checked={effectiveMergeMode === "replace-scope"} onChange={() => { setMergeChoice("replace-scope"); setMergeMode("replace-scope"); if (phaseASaved) setSavedDirty(true); }} className="mt-0.5 accent-emerald-700" />
                    <span>
                      <strong>Sovrascrivi orario esistente</strong>
                      <span className="block text-[11px] text-stone-500">Tutte le vecchie ore di {natureLabel} di questo istituto vengono sostituite da quelle scansionate.</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-xs text-stone-700 cursor-pointer">
                    <input type="radio" name="scan-merge-mode" checked={effectiveMergeMode === "missing-only"} onChange={() => { setMergeChoice("missing-only"); setMergeMode("missing-only"); if (phaseASaved) setSavedDirty(true); }} className="mt-0.5 accent-emerald-700" />
                    <span>
                      <strong>Mantieni e aggiungi</strong>
                      <span className="block text-[11px] text-stone-500">Le nuove ore verranno aggiunte senza eliminare quelle esistenti.</span>
                    </span>
                  </label>
                  {effectiveMergeMode === null && (
                    <p id="recon-merge-choice-required" className="text-[11px] font-semibold text-stone-700">
                      Scegli una delle due opzioni per poter salvare.
                    </p>
                  )}
                  {effectiveMergeMode === "replace-scope" && mergePreview && (
                    <p id="recon-replace-preview" className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                      Sostituzione reale: {mergePreview.replacedCount + mergePreview.removedCount} ore esistenti di {natureLabel} verranno sostituite
                      ({mergePreview.replacedCount} aggiornate
                      {mergePreview.removedCount > 0 ? `, ${mergePreview.removedCount} rimosse perché non presenti nel nuovo orario` : ""})
                      {mergePreview.addedCount > 0 ? ` · ${mergePreview.addedCount} nuove` : ""}
                      {mergePreview.untouchedCount > 0 ? ` · ${mergePreview.untouchedCount} ore non pertinenti restano intatte` : ""}.
                    </p>
                  )}
                  <p className="text-[11px] text-stone-500">
                    {effectiveMergeMode === "replace-scope"
                      ? "La sovrascrittura elimina tutte le vecchie ore di sostegno di questo istituto in questo archivio, anche quelle in giorni o classi assenti nel nuovo orario. Ore di materia, di altri istituti e l'altro archivio non vengono toccati."
                      : "L'intero orario non viene mai cancellato da qui."}
                  </p>
                </fieldset>
              )}

              {reconSlots.length === 0 ? (
                <p className="text-xs text-stone-500 p-4 rounded-xl bg-stone-50 border border-stone-200">
                  Nessuno slot da confermare: la ricostruzione non ha prodotto orari.
                </p>
              ) : (
                <div className="space-y-3">
                  {savePartition.rejected.length > 0 && (
                    <div
                      role="status"
                      data-recon-rejected-summary={savePartition.rejected.length}
                      className="p-3 rounded-xl border border-amber-300 bg-amber-50 text-[11px] text-amber-900 space-y-1"
                    >
                      <p className="font-semibold">
                        {`${savePartition.rejected.length} ${savePartition.rejected.length === 1 ? "ora non verra importata" : "ore non verranno importate"}.`}
                      </p>
                      <ul className="space-y-0.5">
                        {savePartition.rejected.map(({ item, reason }) => (
                          <li key={item.id}>
                            {`${DAY_LABELS[item.dayOfWeek]} · ${item.periodIndex}ª ora`}
                            {(item.correctedClass ?? item.classLabel ?? "").trim()
                              ? ` · ${(item.correctedClass ?? item.classLabel ?? "").trim()}`
                              : ""}
                            {item.correctedSubject?.trim() || item.coTeachingSubjects[0]
                              ? ` · ${item.correctedSubject?.trim() || item.coTeachingSubjects[0]}`
                              : ""}
                            {` — ${rejectionReasonLabel(reason)}`}
                          </li>
                        ))}
                      </ul>
                      <p>
                        Le altre ore vengono importate normalmente. Per recuperare queste, configura le
                        fasce orarie o la struttura della giornata nel Profilo e ripeti l'import.
                      </p>
                    </div>
                  )}
                  {reconSlots.map(slot => {
                    const signal = reconSignal(slot);
                    // Orari SOLO dalla fascia reale: se non esiste, l'elemento e
                    // escluso e non si mostra nessun orario sintetizzato.
                    const period = effectivePeriodSlots.find(p => p.periodNumber === slot.periodIndex);
                    const rejectedReason = rejectedById.get(slot.id);
                    const hasClass = !!(slot.correctedClass ?? slot.classLabel ?? "").trim();
                    return (
                      <div
                        key={slot.id}
                        id={`recon-slot-${slot.id}`}
                        className={`p-3 rounded-xl border space-y-2 ${
                          rejectedReason
                            ? "border-amber-400 bg-amber-50/70"
                            : slot.selected === false
                              ? "border-stone-200 opacity-70"
                              : "border-stone-300 bg-white"
                        }`}
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
                          <span className="text-[11px] text-stone-500 ml-auto">
                            {period ? `${period.startTime}–${period.endTime}` : "Orario non configurato"}
                          </span>
                        </div>

                        {rejectedReason && (
                          <p
                            role="status"
                            data-recon-rejected={rejectedReason}
                            className="text-[11px] font-semibold text-amber-900 bg-amber-100/70 border border-amber-300 rounded-lg p-2"
                          >
                            {`Non verra importata · ${DAY_LABELS[slot.dayOfWeek]} · ${slot.periodIndex}ª ora — ${rejectionReasonLabel(rejectedReason)}`}
                          </p>
                        )}

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
                  <strong className="text-emerald-800">{reconSlots?.filter(s => s.selected !== false).length ?? 0}</strong> slot selezionati ·{" "}
                  {phaseASaved ? "orario già in archivio, qui puoi salvare di nuovo" : "nessun salvataggio prima della conferma"}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    id="recon-close"
                    onClick={onClose}
                    className="min-h-[44px] px-4 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-100"
                  >
                    {phaseASaved ? "Chiudi" : "Annulla"}
                  </button>
                  <button
                    type="button"
                    id="recon-confirm-save"
                    onClick={() => void handleSaveReconstruction()}
                    disabled={save.pending || reconTarget === null || effectiveMergeMode === null}
                    className="min-h-[44px] px-4 sm:px-5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-bold shadow-xs flex items-center gap-1.5"
                  >
                    <Check className="w-4 h-4" />
                    {phaseASaved ? "Salva di nuovo" : "Salva questo orario"}
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
