import { deleteEventLocallyFirst } from "./services/eventWorkflows";
import { observeLocalData, retainEqual } from "./services/observeLocalData";
import { persistenceErrorMessage } from "./services/persistenceErrors";
import { database, type LocalData } from "./services/db";
import { localDateISO } from "./utils/dates";
import React, { useState, useEffect, useRef, lazy, Suspense } from "react";
import {
  CalendarEvent,
  CircularDocument,
  ExtractedItem,
  Student,
  StudentNote,
  TeacherProfile,
  TimeSlotConfig,
  TimetableMode,
  TimetableSlot,
  TimetableType,
  ViewMode,
} from "./types";
import { storage } from "./services/storage";
import { Navbar } from "./components/Navbar";
import { TodayView } from "./components/TodayView";
import { WeekView } from "./components/WeekView";
import { MonthView } from "./components/MonthView";
import { DeadlinesView } from "./components/DeadlinesView";
const TimetableEditor = lazy(() => import("./components/TimetableEditor").then(module => ({default: module.TimetableEditor})));
const CircularsArchiveView = lazy(() => import("./components/CircularsArchiveView").then(module => ({default: module.CircularsArchiveView})));
const ClassesView = lazy(() => import("./components/ClassesView").then(module => ({default: module.ClassesView})));
const CircularAnalyzerModal = lazy(() => import("./components/CircularAnalyzerModal").then(module => ({default: module.CircularAnalyzerModal})));
import { EventModal } from "./components/EventModal";
const ProfileModal = lazy(() => import("./components/ProfileModal").then(module => ({default: module.ProfileModal})));
const OnboardingModal = lazy(() => import("./components/OnboardingModal").then(module => ({default: module.OnboardingModal})));
import { OfflineIndicator } from "./components/OfflineIndicator";
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
  const [isCircularModalOpen, setIsCircularModalOpen] = useState(false);
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(() => !initialData.onboardingCompleted);

  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [targetDateForNewEvent, setTargetDateForNewEvent] = useState<string | undefined>();
  const [planningTargetDate, setPlanningTargetDate] = useState<string | undefined>();
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
  useEffect(() => {
    if (googleUser) accountSync.startSession(googleUser.uid);
    else accountSync.stopSession();
  }, [googleUser?.uid]);

  // Service-worker update availability for the installed PWA (explicit, never surprise reloads).
  const pwaUpdate = usePWAUpdates();

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
    await storage.deleteStudent(studentId);

    showToast("Alunno rimosso dall'elenco.");
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
      const list = (await storage.getStudents()).filter((s) => !studentIds.includes(s.id));
    await storage.saveStudents(list);
    });
    showToast(`${studentIds.length} alunni rimossi.`);
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
    await storage.saveStudents([]);
    showToast("Elenco alunni azzerato.");
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
        onViewChange={setCurrentView}
        profile={profile}
        onOpenCircularModal={() => setIsCircularModalOpen(true)}
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
      />

      {/* Floating Notification Toast */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 animate-in slide-in-from-bottom-5 fade-in duration-200">
          <div className="bg-stone-900 text-white px-4 py-3 rounded-xl shadow-xl border border-stone-700 flex items-center space-x-2 text-xs font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span>{toastMessage}</span>
          </div>
        </div>
      )}

      {/* Main View Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6">
        {currentView === "oggi" && (
          <TodayView
            profile={profile}
            timetable={timetable}
            events={events}
            isProvisionalTimetable={isProvisionalActive}
            isDefinitiveCompiled={isDefinitiveCompiled}
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
            isProvisionalTimetable={isProvisionalActive}
            onOpenNewEvent={handleOpenNewEvent}
            onEditEvent={handleEditEvent}
            onDeleteEvent={handleDeleteEvent}
            targetDateIso={planningTargetDate}
          />
        )}

        {currentView === "mese" && (
          <MonthView
            events={events}
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
            onAddNote={handleAddStudentNote}
            onDeleteNote={handleDeleteStudentNote}
            onScheduleEvent={handleScheduleStudentEvent}
            onDeleteMultipleStudents={handleDeleteMultipleStudents}
            onReassignStudentsClass={handleReassignStudentsClass}
            onClearAllStudents={handleClearAllStudents}
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

      {/* MODALS */}
      {isCircularModalOpen && (
      <CircularAnalyzerModal
        isOpen={isCircularModalOpen}
        onClose={() => setIsCircularModalOpen(false)}
        profile={profile}
        onImportEvents={handleImportCircularEvents}
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

      {pwaUpdate.updateAvailable && (
        <div
          role="status"
          className="fixed bottom-20 left-1/2 z-[80] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 rounded-xl border border-amber-300 bg-white px-4 py-3 shadow-lg flex items-center gap-3"
        >
          <span className="text-sm font-semibold text-amber-900 flex-1">È disponibile una nuova versione</span>
          <button
            type="button"
            onClick={pwaUpdate.applyUpdate}
            className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold shadow-xs hover:bg-amber-700"
          >
            Aggiorna adesso
          </button>
        </div>
      )}
      <OfflineIndicator />
    </div>
    </Suspense>
  );
}
