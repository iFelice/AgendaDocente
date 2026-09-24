import { deleteEventLocallyFirst } from "./services/eventWorkflows";
import { observeLocalData, retainEqual } from "./services/observeLocalData";
import { persistenceErrorMessage } from "./services/persistenceErrors";
import { isStudentActive } from "./utils/studentMatcher";
import { deriveScheduledAssessmentCalendarItems } from "./utils/scheduledAssessmentCalendar";
import { database, type LocalData } from "./services/db";
import { localDateISO } from "./utils/dates";
import React, { useState, useEffect, useRef, lazy, Suspense, useCallback } from "react";
import {
  CalendarEvent,
  CircularDocument,
  ExtractedItem,
  Student,
  StudentAssessment,
  StudentScheduledAssessment,
  StudentNote,
  TeacherProfile,
  TimeSlotConfig,
  TimetableMode,
  TimetableSlot,
  TimetableType,
  ViewMode,
} from "./types";
import { storage } from "./services/storage";
import { applyReconstruction, type TimetableMergeMode } from "./utils/reconstructTimetable";
import {
  backFromRegister,
  clearRegisterStudent,
  initialRegisterNavigation,
  isRegisterOpenForStudent,
  openRegisterForStudent,
  type RegisterNavigation,
  type RegisterSection,
} from "./utils/registerNavigation";
import {
  backFromSlotEdit,
  clearSlotEdit,
  initialSlotEditNavigation,
  isSlotEditOpen,
  openSlotForEdit,
  type SlotEditNavigation,
  type SlotEditOriginView,
} from "./utils/timetableEditNavigation";
import { Navbar } from "./components/Navbar";
import { MobileNav } from "./components/MobileNav";
import { TodayView } from "./components/TodayView";
import { WeekView } from "./components/WeekView";
import { MonthView } from "./components/MonthView";
import { DeadlinesView } from "./components/DeadlinesView";
const TimetableEditor = lazy(() => import("./components/TimetableEditor").then(module => ({default: module.TimetableEditor})));
const CircularsArchiveView = lazy(() => import("./components/CircularsArchiveView").then(module => ({default: module.CircularsArchiveView})));
const ClassesView = lazy(() => import("./components/ClassesView").then(module => ({default: module.ClassesView})));
const RegisterView = lazy(() => import("./components/RegisterView").then(module => ({default: module.RegisterView})));
const CircularAnalyzerModal = lazy(() => import("./components/CircularAnalyzerModal").then(module => ({default: module.CircularAnalyzerModal})));
const DocumentScannerModal = lazy(() => import("./components/DocumentScannerModal").then(module => ({default: module.DocumentScannerModal})));
import { EventModal } from "./components/EventModal";
const ProfileModal = lazy(() => import("./components/ProfileModal").then(module => ({default: module.ProfileModal})));
const OnboardingModal = lazy(() => import("./components/OnboardingModal").then(module => ({default: module.OnboardingModal})));
import { OfflineIndicator } from "./components/OfflineIndicator";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { formatPersonDisplayName, isPlaceholderFullName } from "./utils/names";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { User as FirebaseUser } from "firebase/auth";
import {
  initAuth,
  signInWithGoogle,
  signOutFromGoogle,
  getAccessToken,
  isUserCancellationError,
} from "./services/googleAuth";
import {
  isGoogleSyncEnabled,
  syncOptedInGoogleEvents,
} from "./services/googleCalendarService";
import { accountSync } from "./services/sync/accountSync";
import type { SyncStatus } from "./services/sync/types";
import { usePWAUpdates } from "./hooks/usePWAUpdates";

export default function App({ initialData }: { initialData: LocalData }) {
  const [profile, setProfile] = useState<TeacherProfile>(() => initialData.profile);
  const [definitiveTimetable, setDefinitiveTimetable] = useState<TimetableSlot[]>(() =>
    initialData.definitiveTimetable
  );
  const [provisionalTimetable, setProvisionalTimetable] = useState<TimetableSlot[]>(() =>
    initialData.provisionalTimetable
  );
  const [timetableMode, setTimetableMode] = useState<TimetableMode>(() =>
    initialData.timetableMode
  );
  const [timeSlotConfig, setTimeSlotConfig] = useState<TimeSlotConfig | undefined>(() =>
    initialData.timeSlotConfig
  );
  const [events, setEvents] = useState<CalendarEvent[]>(() => initialData.events);
  const [circulars, setCirculars] = useState<CircularDocument[]>(() => initialData.circulars);
  const [students, setStudents] = useState<Student[]>(() => initialData.students);
  const [assessments, setAssessments] = useState<StudentAssessment[]>(() => initialData.assessments);
  const [scheduledAssessments, setScheduledAssessments] = useState<StudentScheduledAssessment[]>(() => initialData.scheduledAssessments);
  const calendarScheduledAssessments = deriveScheduledAssessmentCalendarItems(scheduledAssessments, students);

  // Active Timetable logic: defaults to provisional if definitive is uncompiled
  const activeType = timetableMode !== 'provvisorio' && definitiveTimetable.length > 0 ? 'definitivo' : 'provvisorio';
  const activeTimetableInfo = {
    activeType, slots: activeType === 'definitivo' ? definitiveTimetable : provisionalTimetable,
    isDefinitiveCompiled: definitiveTimetable.length > 0,
    isFallbackToProvisional: timetableMode !== 'provvisorio' && definitiveTimetable.length === 0,
  };
  const timetable = activeTimetableInfo.slots;
  const isProvisionalActive = activeTimetableInfo.activeType === "provvisorio";
  const isDefinitiveCompiled = activeTimetableInfo.isDefinitiveCompiled;

  const [currentView, setCurrentView] = useState<ViewMode>("oggi");
  // Navigazione del Registro: studente aperto, sezione e ORIGINE della
  // navigazione (vista di provenienza per il pulsante "Indietro"). Stato
  // dedicato: non si deduce mai da altri stati.
  const [registerNav, setRegisterNav] = useState<RegisterNavigation>(initialRegisterNavigation);
  // Navigazione della MODIFICA LEZIONE aperta dal Planning (stesso pattern del
  // Registro, logica in timetableEditNavigation.ts): quale lezione è in
  // modifica, in quale orario, da quale vista di Planning e con quale
  // data/settimana tornare. Mai dedotta da altri stati.
  const [slotEditNav, setSlotEditNav] = useState<SlotEditNavigation>(initialSlotEditNavigation);
  const [isCircularModalOpen, setIsCircularModalOpen] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  // File pre-scansionato dal flusso unificato, da alimentare alla pipeline circolare esistente con auto-start.
  const [scannerCircularFile, setScannerCircularFile] = useState<{
    base64: string;
    mimeType: string;
    fileName: string;
    autoStartToken?: string;
  } | null>(null);
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(() => !initialData.onboardingCompleted);

  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [targetDateForNewEvent, setTargetDateForNewEvent] = useState<string | undefined>();
  const [planningTargetDate, setPlanningTargetDate] = useState<string | undefined>();
  // Data da EVIDENZIARE in Settimana ("SELEZIONATO"): è la navigazione
  // INTENZIONALE verso una data precisa (es. "Visualizza la Settimana" da Oggi,
  // tap su un giorno in Mese, circolari). La data usata SOLO come anchor per
  // ripristinare la settimana (ritorno dalla modifica di una lezione) NON viene
  // evidenziata: al ritorno dal Planning non resta nessun giorno marcato.
  const [planningHighlightDate, setPlanningHighlightDate] = useState<string | undefined>();
  // Data civile selezionata nella vista Oggi. Settimana/Mese preservano il
  // contesto tramite planningTargetDate; Oggi porta la data dentro se stesso,
  // quindi la conserviamo qui per riaprirla sullo stesso giorno (es. dopo
  // essersi fermati al Registro) invece che riportare arbitrariamente a oggi.
  const [oggiTargetDate, setOggiTargetDate] = useState<string | undefined>();
  const handleTodaySelectedDate = useCallback((iso: string) => { setOggiTargetDate(iso); }, []);
  const [prefilledEventData, setPrefilledEventData] = useState<Partial<CalendarEvent> | null>(null);

  // Google Workspace / Institutional Account State
  const [googleUser, setGoogleUser] = useState<FirebaseUser | null>(null);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [profileInitialTab, setProfileInitialTab] = useState<"profilo" | "backup" | "google">("profilo");

  // Feedback Notification Banner
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4500);
  };

  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  function withPersistenceFeedback<A extends unknown[]>(operation: (...args: A) => Promise<void>) {
    return async (...args: A): Promise<void | false> => {
      try {
        if (database.mode !== 'indexeddb') throw new Error('Archivio in sola lettura');
        await operation(...args); setPersistenceError(null);
      }
      catch (error) { setPersistenceError(persistenceErrorMessage(error)); return false; }
    };
  }

  const lastOnboarding = useRef(initialData.onboardingCompleted);
  function applySnapshot(data: LocalData) {
    setProfile(previous => retainEqual(previous, data.profile));
    setDefinitiveTimetable(previous => retainEqual(previous, data.definitiveTimetable));
    setProvisionalTimetable(previous => retainEqual(previous, data.provisionalTimetable));
    setTimetableMode(data.timetableMode);
    setTimeSlotConfig(previous => retainEqual(previous, data.timeSlotConfig));
    setEvents(previous => retainEqual(previous, data.events));
    setCirculars(previous => retainEqual(previous, data.circulars));
    setStudents(previous => retainEqual(previous, data.students));
    setAssessments(previous => retainEqual(previous, data.assessments));
    setScheduledAssessments(previous => retainEqual(previous, data.scheduledAssessments));
    if (lastOnboarding.current !== data.onboardingCompleted) setIsOnboardingOpen(!data.onboardingCompleted);
    lastOnboarding.current = data.onboardingCompleted;
  }
  useEffect(() => {
    let stop = () => {};
    const start = () => {
      stop();
      stop = observeLocalData(database, applySnapshot, error => setPersistenceError(persistenceErrorMessage(error)));
    };
    start();
    window.addEventListener('focus', start);
    return () => { stop(); window.removeEventListener('focus', start); };
  }, []);

  // Initialize Google Auth listener
  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        setGoogleUser(user);
        if (token) setGoogleAccessToken(token);
      },
      () => {
        setGoogleUser(null);
        setGoogleAccessToken(null);
      }
    );
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Account sync (multi-device): IndexedDB stays local-first; Firestore mirrors the account
  // keyed by uid. It starts/stops with the authenticated user and never blocks the app.
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(accountSync.getStatus());
  useEffect(() => accountSync.subscribe(setSyncStatus), []);
  const isOnline = useOnlineStatus();
  useEffect(() => {
    if (googleUser) accountSync.startSession(googleUser.uid);
    else accountSync.stopSession();
  }, [googleUser?.uid]);

  // Service-worker update availability for the installed PWA (explicit, never surprise reloads).
  const pwaUpdate = usePWAUpdates();
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const [updateCheckFeedback, setUpdateCheckFeedback] = useState(false);
  useEffect(() => {
    if (pwaUpdate.updateAvailable) setUpdatePromptOpen(true);
  }, [pwaUpdate.updateAvailable]);
  useEffect(() => {
    if (!updateCheckFeedback) return;
    const timeout = window.setTimeout(() => setUpdateCheckFeedback(false), 2600);
    return () => window.clearTimeout(timeout);
  }, [updateCheckFeedback]);

  const handleGoogleLogin = async () => {
    try {
      const result = await signInWithGoogle();
      if (result) {
        setGoogleUser(result.user);
        setGoogleAccessToken(result.accessToken);
        const email = result.user.email || "";
        // Google display names arrive inconsistently cased ("felice manganiello"); normalize
        // the view only when there is no real name yet (empty or old placeholder/seed names).
        const displayName = result.user.displayName ? formatPersonDisplayName(result.user.displayName) : "";
        const updated = {
          ...profile,
          email: email || profile.email,
          fullName: displayName && isPlaceholderFullName(profile.fullName) ? displayName : profile.fullName,
          googleCalendarLinked: true,
          googleCalendarAccount: email,
        };
        if (await handleSaveProfile(updated) === false) return null;
        showToast(`Account istituzionale collegato: ${email}`);
        return result;
      }
      return null;
    } catch (err: unknown) {
      if (isUserCancellationError(err)) {
        return null;
      }
      const msg = err instanceof Error ? err.message : "Accesso istituzionale non riuscito.";
      console.warn("Accesso con Google non completato:", msg);
      showToast(msg);
      return null;
    }
  };

  const handleGoogleLogout = async () => {
    try {
      await signOutFromGoogle();
      setGoogleUser(null);
      setGoogleAccessToken(null);
      const updated = {
        ...profile,
        googleCalendarLinked: false,
        googleCalendarAccount: undefined,
      };
      if (await handleSaveProfile(updated) === false) return;
      showToast("Account Google disconnesso.");
    } catch (err: any) {
      console.error("Disconnessione fallita:", err);
      showToast("Errore durante la disconnessione.");
      throw err;
    }
  };

  const handleSyncAllToGoogle = async (): Promise<{ syncedCount: number; errorCount: number }> => {
    if (database.mode !== "indexeddb") throw new Error("Archivio locale in sola lettura: sincronizzazione sospesa.");
    const token = googleAccessToken || getAccessToken();
    if (!token) {
      throw new Error("Effettua prima l'accesso con il tuo account istituzionale Google.");
    }
    const result = await syncOptedInGoogleEvents(
      token, (await storage.getEvents()).map(event => event.id),
      async id => (await storage.getEvents()).find(event => event.id === id),
      async event => (await storage.saveEvent(event)),
    );

    return result;
  };

  const handleNavigateToPlanning = (
    dateIso: string,
    view: "oggi" | "settimana" | "mese" = "settimana"
  ) => {
    setPlanningTargetDate(dateIso);
    setPlanningHighlightDate(dateIso);
    setCurrentView(view);
  };

  const handleAddEventsToPlanning = withPersistenceFeedback(async (newEvents: CalendarEvent[], feedbackMsg?: string) => {
    const addedCount = (await storage.bulkAddEvents(newEvents));

    showToast(feedbackMsg || `${addedCount} impegni aggiunti al tuo planning!`);
  });

  // Reload all data (e.g. after backup import)
  const refreshAllData = withPersistenceFeedback(async () => {
    const data = await database.readSnapshot();
    applySnapshot(data);
  });

  // Profile Save
  const handleSaveProfile = withPersistenceFeedback(async (updated: TeacherProfile, expected?: TeacherProfile) => {
    await storage.saveProfile(updated, expected);
    showToast("Profilo docente aggiornato con successo.");
  });

  const handleFinishOnboarding = withPersistenceFeedback(async (
    updatedProfile: TeacherProfile,
    openCircularScannerImmediately?: boolean
  ) => {
    await database.atomic(async () => {
      await storage.saveProfile(updatedProfile);
      await storage.setOnboardingCompleted(true);
    });
    setIsOnboardingOpen(false);
    showToast(`Configurazione completata! Benvenuto, ${updatedProfile.fullName}`);
    if (openCircularScannerImmediately) {
      setTimeout(() => {
        setIsCircularModalOpen(true);
      }, 250);
    }
  });

  // Timetable Handlers
  const handleSaveTimetableSlot = withPersistenceFeedback(async (slot: TimetableSlot, type: TimetableType, expected?: TimetableSlot) => {
    await storage.saveTimetableSlot(slot, type, expected);

    showToast(
      type === "provvisorio"
        ? "Ora salvata nell'orario provvisorio."
        : "Ora salvata nell'orario definitivo."
    );
  });

  const handleSaveTimeSlotConfig = withPersistenceFeedback(async (config: TimeSlotConfig) => {
    await storage.saveTimeSlotConfig(config);
    showToast("Fasce orarie aggiornate.");
  });

  const handleDeleteTimetableSlot = withPersistenceFeedback(async (id: string, type: TimetableType) => {
    await storage.deleteTimetableSlot(id, type);

    showToast("Ora rimossa dall'orario.");
  });

  const handleSetTimetableMode = withPersistenceFeedback(async (mode: TimetableMode) => {
    await storage.setTimetableMode(mode);
    showToast(
      mode === "provvisorio"
        ? "Orario provvisorio impostato come attivo nei planning."
        : mode === "definitivo"
        ? "Orario definitivo impostato come attivo nei planning."
        : "Modalità automatica attiva (provvisorio fino a compilazione del definitivo)."
    );
  });

  const handleCopyProvisionalToDefinitive = withPersistenceFeedback(async () => {
    await storage.copyProvisionalToDefinitive();

    showToast("Ore dell'orario provvisorio copiate nell'orario definitivo.");
  });

  const handleCopyDefinitiveToProvisional = withPersistenceFeedback(async () => {
    await storage.copyDefinitiveToProvisional();

    showToast("Ore dell'orario definitivo copiate nell'orario provvisorio.");
  });

  const handleClearTimetable = withPersistenceFeedback(async (type: TimetableType) => {
    await storage.clearTimetable(type);

    showToast(
      type === "definitivo"
        ? "Orario definitivo azzerato (ora l'app mostra di default l'orario provvisorio)."
        : "Orario provvisorio azzerato."
    );
  });

  const handleDeleteExtractedItem = withPersistenceFeedback(async (circularId: string, item: ExtractedItem) => {
    await database.atomic(async () => {
      await storage.deleteExtractedItemFromCircular(circularId, item.tempId);
      await storage.deleteEventMatchingExtractedItem(item, circularId);
    });

    showToast("Riga estrapolata eliminata dalla circolare.");
  });

  // Event Handlers
  const handleSaveEvent = withPersistenceFeedback(async (event: CalendarEvent, expected?: CalendarEvent) => {
    // Save locally first
    await storage.saveEvent(event, expected);

    // If sync with Google is requested and we have an access token
    const token = googleAccessToken || getAccessToken();
    if (isGoogleSyncEnabled(event) && token) {
      try {
      const result = await syncOptedInGoogleEvents(
        token, [event.id],
        async id => (await storage.getEvents()).find(current => current.id === id),
        async current => (await storage.saveEvent(current)),
      );

      showToast(result.errorCount ? "Impegno salvato in locale (errore sync Google Calendar)."
        : result.syncedCount ? "Impegno salvato e sincronizzato su Google Calendar." : "Impegno salvato in locale.");
      } catch { showToast("Impegno salvato in locale; sincronizzazione Google non completata."); }
      return;
    }

    showToast("Impegno salvato con successo.");
  });

  const handleDeleteEvent = withPersistenceFeedback(async (id: string) => {
    const remoteRemoved = await deleteEventLocallyFirst(id, googleAccessToken || getAccessToken());
    showToast(remoteRemoved ? "Impegno eliminato dall’agenda." : "Impegno eliminato in locale; la copia Google non è stata eliminata. Verifica Google Calendar.");
  });

  const handleToggleComplete = withPersistenceFeedback(async (id: string) => {
    await storage.toggleEventCompleted(id);

  });

  const handleOpenNewEvent = (initialDate?: string) => {
    setEditingEvent(null);
    setPrefilledEventData(null);
    setTargetDateForNewEvent(initialDate);
    setIsEventModalOpen(true);
  };

  const handleEditEvent = (event: CalendarEvent) => {
    setEditingEvent(event);
    setPrefilledEventData(null);
    setTargetDateForNewEvent(event.date);
    setIsEventModalOpen(true);
  };

  // Student & Classes Handlers
  const handleSaveStudent = withPersistenceFeedback(async (student: Student, expected?: Student) => {
    await storage.saveStudent(student, expected);

    showToast(`Scheda di ${student.fullName} salvata.`);
  });

  const handleDeleteStudent = withPersistenceFeedback(async (studentId: string) => {
    await storage.archiveStudent(studentId);
    showToast("Alunno archiviato. I dati e le note sono stati conservati.");
  });

  const handleRestoreStudent = withPersistenceFeedback(async (studentId: string) => {
    await storage.restoreStudent(studentId);
    showToast("Alunno ripristinato nell'elenco attivo.");
  });

  const handleAddStudentNote = withPersistenceFeedback(async (studentId: string, note: StudentNote) => {
    await storage.addStudentNote(studentId, note);

    showToast("Nota aggiunta al diario dell'alunno.");
  });

  const handleDeleteStudentNote = withPersistenceFeedback(async (studentId: string, noteId: string) => {
    await storage.deleteStudentNote(studentId, noteId);

    showToast("Nota rimossa dal diario.");
  });

  const handleDeleteMultipleStudents = withPersistenceFeedback(async (studentIds: string[]) => {
    await database.atomic(async () => {
      const list = await storage.getStudents();
      const archivedAt = new Date().toISOString();
      for (const student of list) {
        if (studentIds.includes(student.id)) {
          student.status = "archived";
          student.archivedAt = archivedAt;
        }
      }
      await storage.saveStudents(list);
    });
    showToast(`${studentIds.length} alunni archiviati. I dati sono stati conservati.`);
  });

  const handleReassignStudentsClass = withPersistenceFeedback(async (studentIds: string[], targetClass: string) => {
    await database.atomic(async () => {
      const list = (await storage.getStudents()).map((s) => {
      if (studentIds.includes(s.id)) {
        return { ...s, className: targetClass.toUpperCase(), updatedAt: new Date().toISOString() };
      }
      return s;
    });
    await storage.saveStudents(list);
    });
    showToast(`${studentIds.length} alunni spostati nella classe ${targetClass.toUpperCase()}.`);
  });

  const handleClearAllStudents = withPersistenceFeedback(async () => {
    const list = await storage.getStudents();
    const archivedAt = new Date().toISOString();
    for (const student of list) {
      student.status = "archived";
      student.archivedAt = archivedAt;
    }
    await storage.saveStudents(list);
    showToast("Alunni archiviati. I dati sono stati conservati.");
  });

  const handleScheduleStudentEvent = (prefill: Partial<CalendarEvent>) => {
    setEditingEvent(null);
    setPrefilledEventData(prefill);
    setTargetDateForNewEvent(prefill.date);
    setIsEventModalOpen(true);
  };

  // Circular Import Confirmation
  const handleImportCircularEvents = withPersistenceFeedback(async (
    newEvents: CalendarEvent[],
    docMeta: CircularDocument
  ) => {
    const addedCount = await database.atomic(async () => {
      const added = await storage.bulkAddEvents(newEvents);
      await storage.saveCircular(docMeta);
      return added;
    });

    showToast(`Perfetto! ${addedCount} impegni pertinenti aggiunti all'agenda.`);
    setCurrentView("oggi");
  });

  const handleDeleteCircular = withPersistenceFeedback(async (id: string) => {
    await storage.deleteCircular(id);

    showToast("Circolare rimossa dall'archivio.");
  });

  // Scansiona documento: la circolare pre-scansionata alimenta la pipeline esistente con auto-start.
  const handleScanDocumentToCircular = (info: {
    base64: string;
    mimeType: string;
    fileName: string;
    autoStartToken?: string;
  }) => {
    setScannerCircularFile(info);
    setIsScannerOpen(false);
    setIsCircularModalOpen(true);
  };

  // Orario ricostruito: salvataggio CONFERMATO nel modello timetable esistente.
  // Nessun sovrascrittura automatica: il merge segue la modalità scelta dall'utente.
  const handleSaveReconstructedTimetable = withPersistenceFeedback(async (
    slots: TimetableSlot[],
    type: TimetableType,
    mode: TimetableMergeMode
  ) => {
    let added = 0;
    let replaced = 0;
    let removed = 0;
    await database.atomic(async () => {
      const existing = type === "provvisorio" ? await storage.getProvisionalTimetable() : await storage.getDefinitiveTimetable();
      // "replace-scope" è una sostituzione REALE nell'ambito della ricostruzione: le
      // vecchie ore di sostegno dello stesso istituto spariscono (nessuno slot sopravvive
      // solo perché in una coordinata assente nel nuovo orario). Il profilo serve a
      // riconoscere come "stesso istituto" anche gli slot legacy privi di schoolId.
      const merged = applyReconstruction(existing, slots, mode, { profile });
      added = merged.addedCount;
      replaced = merged.replacedCount;
      removed = merged.removedCount;
      if (type === "provvisorio") await storage.saveProvisionalTimetable(merged.slots);
      else await storage.saveDefinitiveTimetable(merged.slots);
    });
    const targetLabel = type === "provvisorio" ? "orario provvisorio" : "orario definitivo";
    const parts: string[] = [];
    if (added) parts.push(`${added} aggiunte`);
    if (replaced) parts.push(`${replaced} sostituite`);
    if (removed) parts.push(`${removed} vecchie rimosse`);
    showToast(`Orario salvato in ${targetLabel}${parts.length ? ` (${parts.join(", ")})` : ""}.`);
  });

  // Registro/appunti: impegni alunni confermati -> agenda (mai nuovi studenti).
  const handleImportStudentCommitments = withPersistenceFeedback(async (newEvents: CalendarEvent[]) => {
    const addedCount = await storage.bulkAddEvents(newEvents);
    showToast(`${addedCount} impegni dal registro aggiunti all'agenda.`);
  });

  const handleSaveAssessment = withPersistenceFeedback(async (assessment: StudentAssessment) => {
    await storage.saveAssessment(assessment);
    showToast("Valutazione salvata.");
  });
  const handleDeleteAssessment = withPersistenceFeedback(async (assessmentId: string) => {
    await storage.deleteAssessment(assessmentId);
    showToast("Valutazione eliminata.");
  });
  const handleSaveScheduledAssessment = withPersistenceFeedback(async (assessment: StudentScheduledAssessment) => {
    await storage.saveScheduledAssessment(assessment);
    showToast("Prova programmata salvata.");
  });
  const handleDeleteScheduledAssessment = withPersistenceFeedback(async (id: string) => {
    await storage.deleteScheduledAssessment(id);
    showToast("Prova programmata eliminata.");
  });

  const handleViewChange = (view: ViewMode) => {
    setCurrentView(view);
    if (view !== "registro") setRegisterNav((nav) => clearRegisterStudent(nav));
    // Uscita volontaria dal flusso di modifica lezione (o arrivo manuale in
    // Orario dalla navigazione principale): la sessione si chiude qui, così un
    // vecchio initialSlot non può più essere ri-consumato da un futuro remount
    // dell'editor. Il flusso di modifica usa setCurrentView diretto (come il
    // Registro) e non passa da qui.
    setSlotEditNav((nav) => clearSlotEdit(nav));
  };
  const handleOpenRegister = (studentId: string, section: RegisterSection = "assessments") => {
    // L'origine è la vista in cui l'utente si trova al momento dell'apertura:
    // le uniche viste che aprono il Registro per uno studente sono le viste di
    // planning (prova programmata: Oggi/Settimana/Mese) e Classi (scheda alunno).
    // "Indietro" tornerà lì, preservando i contesti temporali già in memoria
    // (planningTargetDate per Settimana/Mese, oggiTargetDate per Oggi).
    setRegisterNav(openRegisterForStudent(studentId, section, currentView));
    setCurrentView("registro");
  };

  // Tap su una lezione del Planning (Oggi/Settimana): apre la modifica diretta
  // della lezione toccata nell'orario ATTIVO (type = activeType, mai il flag
  // dello slot). La data registrata è quella della vista di provenienza
  // (selectedIso di Oggi / day.iso della Settimana): è il contesto da
  // ripristinare al ritorno. setCurrentView diretto (come per il Registro):
  // non passa da handleViewChange, che chiuderebbe la sessione.
  const openSlotEditSession = useCallback((slot: TimetableSlot, type: TimetableType, dateIso: string, origin: SlotEditOriginView) => {
    setSlotEditNav(openSlotForEdit(slot, type, origin, dateIso));
    if (origin === "oggi") {
      setOggiTargetDate(dateIso);
    } else {
      // Anchor per RIPRISTINARE la settimana al ritorno: senza evidenza
      // "SELEZIONATO" (non è una navigazione intenzionale verso quel giorno).
      setPlanningTargetDate(dateIso);
      setPlanningHighlightDate(undefined);
    }
    setCurrentView("orario");
  }, []);

  // Oggi: wrapper sottile, firma e comportamento IDENTICI a prima della
  // generalizzazione (nessun impatto su TodayView e sui suoi test).
  const handleOpenTimetableSlotForEdit = useCallback((slot: TimetableSlot, type: TimetableType, selectedIso: string) => {
    openSlotEditSession(slot, type, selectedIso, "oggi");
  }, [openSlotEditSession]);

  // Settimana: stessa logica centralizzata, origine "settimana" e contesto =
  // planningTargetDate (riutilizzato da WeekView via targetDateIso).
  const handleOpenTimetableSlotFromWeek = useCallback((slot: TimetableSlot, type: TimetableType, dayIso: string) => {
    openSlotEditSession(slot, type, dayIso, "settimana");
  }, [openSlotEditSession]);

  // "Torna al Planning" nell'editor: vista e data di ritorno sono quelle
  // REGISTRATE all'apertura (mai dedotte dagli altri stati); la sessione si
  // chiude con `next` restituito dall'helper.
  const handleBackFromSlotEdit = useCallback(() => {
    const { targetView, targetDateIso, next } = backFromSlotEdit(slotEditNav);
    setSlotEditNav(next);
    if (targetView === "oggi") {
      if (targetDateIso) setOggiTargetDate(targetDateIso);
      setCurrentView("oggi");
    } else if (targetView === "settimana") {
      // La settimana da riaprire è quella REGISTRATA (il day.iso della lezione
      // toccata), non la "settimana corrente" dell'app: WeekView la
      // sincronizza al mount tramite targetDateIso (planningTargetDate). La
      // data resta un ANCHOR: nessun giorno evidenziato come "SELEZIONATO".
      if (targetDateIso) setPlanningTargetDate(targetDateIso);
      setPlanningHighlightDate(undefined);
      setCurrentView("settimana");
    }
  }, [slotEditNav]);

  // Stats for badges
  const todayIso = localDateISO();
  const todayEventsCount = events.filter((e) => e.date === todayIso && !e.completed).length;
  const pendingDeadlinesCount = events.filter(
    (e) => (e.category === "scadenza" || e.category === "promemoria") && !e.completed
  ).length;

  return (
    <Suspense fallback={<p role="status" className="p-6">Caricamento vista locale…</p>}>
    <div className="min-h-screen bg-stone-100/70 text-stone-900 flex flex-col font-sans selection:bg-emerald-100 selection:text-emerald-900">
      {persistenceError && <div role="alert" className="fixed top-0 inset-x-0 z-[10000] p-3 bg-rose-50 text-rose-800">{persistenceError}</div>}
      {/* Top Navigation */}
      <Navbar
        currentView={currentView}
        onViewChange={handleViewChange}
        profile={profile}
        onOpenCircularModal={() => setIsCircularModalOpen(true)}
        onOpenScanner={() => setIsScannerOpen(true)}
        onOpenNewEventModal={() => handleOpenNewEvent()}
        onOpenProfileModal={() => {
          setProfileInitialTab("profilo");
          setIsProfileModalOpen(true);
        }}
        onOpenTutorial={() => setIsOnboardingOpen(true)}
        googleUser={googleUser}
        onOpenGoogleLogin={handleGoogleLogin}
        onOpenGoogleTab={() => {
          setProfileInitialTab("google");
          setIsProfileModalOpen(true);
        }}
        stats={{
          todayEventsCount,
          pendingDeadlinesCount,
        }}
        updateAvailable={pwaUpdate.updateAvailable}
        onOpenUpdatePrompt={() => setUpdatePromptOpen(true)}
        onCheckUpdates={() => setUpdateCheckFeedback(true)}
      />

      {/* Floating notification toast (clears the mobile bottom navigation) */}
      {toastMessage && (
        <div
          role="status"
          className="app-toast fixed left-3 right-3 md:left-auto md:right-5 md:bottom-5 z-50 animate-in slide-in-from-bottom-5 fade-in duration-200"
        >
          <div className="bg-stone-900 text-white px-4 py-3 rounded-xl shadow-xl border border-stone-700 flex items-center space-x-2 text-xs font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span>{toastMessage}</span>
          </div>
        </div>
      )}

      {/* Main View Container: `.app-main` reserves the bottom navigation space on phones */}
      <main className="app-main flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 pt-3 sm:pt-6">
        {currentView === "oggi" && (
          <TodayView
            profile={profile}
            timetable={timetable}
            events={events}
            scheduledAssessments={calendarScheduledAssessments}
            onOpenScheduledAssessment={(studentId) => handleOpenRegister(studentId, "scheduled")}
            initialDateIso={oggiTargetDate}
            onSelectedDateChange={handleTodaySelectedDate}
            isProvisionalTimetable={isProvisionalActive}
            isDefinitiveCompiled={isDefinitiveCompiled}
            timetableType={activeTimetableInfo.activeType}
            onOpenTimetableSlotForEdit={handleOpenTimetableSlotForEdit}
            onOpenNewEvent={handleOpenNewEvent}
            onOpenCircularModal={() => setIsCircularModalOpen(true)}
            onEditEvent={handleEditEvent}
            onDeleteEvent={handleDeleteEvent}
            onToggleComplete={handleToggleComplete}
            onNavigateToPlanning={handleNavigateToPlanning}
            onNavigateToTimetable={() => setCurrentView("orario")}
          />
        )}

        {currentView === "settimana" && (
          <WeekView
            profile={profile}
            timetable={timetable}
            events={events}
            scheduledAssessments={calendarScheduledAssessments}
            onOpenScheduledAssessment={(studentId) => handleOpenRegister(studentId, "scheduled")}
            isProvisionalTimetable={isProvisionalActive}
            onOpenNewEvent={handleOpenNewEvent}
            onEditEvent={handleEditEvent}
            onDeleteEvent={handleDeleteEvent}
            targetDateIso={planningTargetDate}
            highlightDateIso={planningHighlightDate}
            timetableType={activeTimetableInfo.activeType}
            onOpenTimetableSlotForEdit={handleOpenTimetableSlotFromWeek}
          />
        )}

        {currentView === "mese" && (
          <MonthView
            events={events}
            scheduledAssessments={calendarScheduledAssessments}
            onOpenScheduledAssessment={(studentId) => handleOpenRegister(studentId, "scheduled")}
            onOpenNewEvent={handleOpenNewEvent}
            onEditEvent={handleEditEvent}
            onDeleteEvent={handleDeleteEvent}
            onNavigateToPlanning={handleNavigateToPlanning}
            targetDateIso={planningTargetDate}
          />
        )}

        {currentView === "scadenze" && (
          <DeadlinesView
            events={events}
            onOpenNewEvent={handleOpenNewEvent}
            onEditEvent={handleEditEvent}
            onDeleteEvent={handleDeleteEvent}
            onToggleComplete={handleToggleComplete}
          />
        )}

        {currentView === "classi" && (
          <ClassesView
            profile={profile}
            students={students}
            onSaveStudent={handleSaveStudent}
            onDeleteStudent={handleDeleteStudent}
            onRestoreStudent={handleRestoreStudent}
            onAddNote={handleAddStudentNote}
            onDeleteNote={handleDeleteStudentNote}
            onScheduleEvent={handleScheduleStudentEvent}
            onDeleteMultipleStudents={handleDeleteMultipleStudents}
            onReassignStudentsClass={handleReassignStudentsClass}
            onClearAllStudents={handleClearAllStudents}
            onOpenRegister={handleOpenRegister}
          />
        )}

        {currentView === "registro" && (
          <RegisterView
            profile={profile}
            students={students}
            assessments={assessments}
            scheduledAssessments={scheduledAssessments}
            initialStudentId={registerNav.studentId}
            initialSection={registerNav.section}
            onBackToOrigin={isRegisterOpenForStudent(registerNav)
              ? () => {
                  // Torna alla vista di ORIGINE reale (Oggi/Settimana/Mese/Classi),
                  // non arbitrariamente a Classi. I contesti temporali
                  // (planningTargetDate / oggiTargetDate) restano in memoria.
                  const { targetView, next } = backFromRegister(registerNav);
                  setRegisterNav(next);
                  setCurrentView(targetView);
                }
              : undefined}
            onSaveAssessment={handleSaveAssessment}
            onDeleteAssessment={handleDeleteAssessment}
            onSaveScheduledAssessment={handleSaveScheduledAssessment}
            onDeleteScheduledAssessment={handleDeleteScheduledAssessment}
          />
        )}

        {currentView === "orario" && (
          <TimetableEditor
            profile={profile}
            definitiveTimetable={definitiveTimetable}
            provisionalTimetable={provisionalTimetable}
            timetableMode={timetableMode}
            activeType={activeTimetableInfo.activeType}
            isDefinitiveCompiled={isDefinitiveCompiled}
            timeSlotConfig={timeSlotConfig}
            onSaveSlot={handleSaveTimetableSlot}
            onDeleteSlot={handleDeleteTimetableSlot}
            onSetTimetableMode={handleSetTimetableMode}
            onCopyProvisionalToDefinitive={handleCopyProvisionalToDefinitive}
            onCopyDefinitiveToProvisional={handleCopyDefinitiveToProvisional}
            onClearTimetable={handleClearTimetable}
            onSaveProfile={handleSaveProfile}
            onSaveTimeSlotConfig={handleSaveTimeSlotConfig}
            initialSlot={isSlotEditOpen(slotEditNav) ? slotEditNav.slot : null}
            initialSlotType={isSlotEditOpen(slotEditNav) ? slotEditNav.type : null}
            onBackToOrigin={isSlotEditOpen(slotEditNav) ? handleBackFromSlotEdit : undefined}
          />
        )}

        {currentView === "circolari" && (
          <CircularsArchiveView
            circulars={circulars}
            events={events}
            profile={profile}
            onOpenCircularModal={() => setIsCircularModalOpen(true)}
            onDeleteCircular={handleDeleteCircular}
            onDeleteExtractedItem={handleDeleteExtractedItem}
            onAddEventsToPlanning={handleAddEventsToPlanning}
            onNavigateToPlanning={handleNavigateToPlanning}
          />
        )}
      </main>

      {/* Mobile navigation (fixed bottom bar + "Altro" sheet); hidden from 768px up,
          where the header navigation stays in charge. */}
      <MobileNav
        currentView={currentView}
        onViewChange={handleViewChange}
        onOpenNewEvent={() => handleOpenNewEvent()}
        onOpenScanner={() => setIsScannerOpen(true)}
        onOpenProfileModal={() => {
          setProfileInitialTab("profilo");
          setIsProfileModalOpen(true);
        }}
        onOpenGoogleTab={() => {
          setProfileInitialTab("google");
          setIsProfileModalOpen(true);
        }}
        onOpenGoogleLogin={handleGoogleLogin}
        onOpenTutorial={() => setIsOnboardingOpen(true)}
        onOpenCircularModal={() => setIsCircularModalOpen(true)}
        googleUser={googleUser}
        stats={{ todayEventsCount, pendingDeadlinesCount }}
      />

      {/* MODALS */}
      {isScannerOpen && (
      <DocumentScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        profile={profile}
        students={students.filter(isStudentActive)}
        timeSlotConfig={timeSlotConfig}
        provisionalTimetable={provisionalTimetable}
        definitiveTimetable={definitiveTimetable}
        onOpenCircularWithFile={handleScanDocumentToCircular}
        onSaveReconstructedTimetable={handleSaveReconstructedTimetable}
        onImportStudentCommitments={handleImportStudentCommitments}
      />
      )}

      {isCircularModalOpen && (
      <CircularAnalyzerModal
        isOpen={isCircularModalOpen}
        onClose={() => {
          setIsCircularModalOpen(false);
          setScannerCircularFile(null);
        }}
        profile={profile}
        onImportEvents={handleImportCircularEvents}
        initialFile={scannerCircularFile}
      />
      )}

      {isEventModalOpen && (
      <EventModal
        isOpen={isEventModalOpen}
        onClose={() => {
          setIsEventModalOpen(false);
          setPrefilledEventData(null);
        }}
        eventToEdit={editingEvent}
        initialDate={targetDateForNewEvent}
        initialEventData={prefilledEventData}
        profile={profile}
        onSave={handleSaveEvent}
        onDelete={handleDeleteEvent}
        isGoogleConnected={!!googleUser && !!googleAccessToken}
        googleUserEmail={googleUser?.email || undefined}
      />
      )}

      {isProfileModalOpen && (
      <ProfileModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        profile={profile}
        onSaveProfile={handleSaveProfile}
        onDataImported={refreshAllData}
        onOpenTutorial={() => setIsOnboardingOpen(true)}
        googleUser={googleUser}
        googleAccessToken={googleAccessToken}
        onGoogleLogin={handleGoogleLogin}
        onGoogleLogout={handleGoogleLogout}
        events={events}
        onSyncAllToGoogle={handleSyncAllToGoogle}
        accountSyncStatus={syncStatus}
        onSyncNow={() => void accountSync.syncNow()}
        onSyncToggle={(enabled) => void accountSync.setEnabled(enabled)}
        onSyncResolve={(choice) => void accountSync.resolveConflict(choice)}
        online={isOnline}
        initialTab={profileInitialTab}
      />
      )}

      {isOnboardingOpen && (
      <OnboardingModal
        isOpen={isOnboardingOpen}
        initialProfile={profile}
        onFinish={handleFinishOnboarding}
        onClose={() => setIsOnboardingOpen(false)}
        googleUser={googleUser}
        onGoogleLogin={handleGoogleLogin}
      />
      )}

      {!pwaUpdate.updateAvailable && updateCheckFeedback && (
        <div
          role="status"
          className="fixed left-1/2 bottom-20 md:bottom-20 z-[80] -translate-x-1/2 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm font-semibold text-stone-700 shadow-lg"
        >
          Agenda Docente è aggiornata
        </div>
      )}

      {pwaUpdate.updateAvailable && updatePromptOpen && (
        <div
          role="dialog"
          aria-labelledby="pwa-update-title"
          className="app-update-banner fixed left-1/2 bottom-20 md:bottom-20 z-[80] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 rounded-xl border border-amber-300 bg-white px-4 py-3 shadow-lg"
        >
          <div className="flex items-center gap-3">
            <span id="pwa-update-title" className="text-sm font-semibold text-amber-900 flex-1">Nuovo aggiornamento disponibile</span>
            <button
              type="button"
              onClick={() => setUpdatePromptOpen(false)}
              aria-label="Più tardi"
              className="min-h-[44px] px-2 text-xs font-semibold text-stone-600 hover:text-stone-900"
            >
              Più tardi
            </button>
            <button
              type="button"
              onClick={pwaUpdate.applyUpdate}
              className="min-h-[44px] px-3 rounded-lg bg-amber-600 text-white text-xs font-bold shadow-xs hover:bg-amber-700"
            >
              Aggiorna adesso
            </button>
          </div>
          {pwaUpdate.failed && <p role="alert" className="mt-2 text-xs text-rose-700">Aggiornamento non riuscito. Puoi riprovare.</p>}
        </div>
      )}
      <OfflineIndicator />
    </div>
    </Suspense>
  );
}
