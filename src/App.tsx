import { localDateISO } from "./utils/dates";
import React, { useState, useEffect } from "react";
import {
  CalendarEvent,
  CircularDocument,
  ExtractedItem,
  Student,
  StudentNote,
  TeacherProfile,
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
import { TimetableEditor } from "./components/TimetableEditor";
import { CircularsArchiveView } from "./components/CircularsArchiveView";
import { ClassesView } from "./components/ClassesView";
import { CircularAnalyzerModal } from "./components/CircularAnalyzerModal";
import { EventModal } from "./components/EventModal";
import { ProfileModal } from "./components/ProfileModal";
import { OnboardingModal } from "./components/OnboardingModal";
import { OfflineIndicator } from "./components/OfflineIndicator";
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
  deleteGoogleCalendarEvent,
} from "./services/googleCalendarService";

export default function App() {
  const [profile, setProfile] = useState<TeacherProfile>(() => storage.getProfile());
  const [definitiveTimetable, setDefinitiveTimetable] = useState<TimetableSlot[]>(() =>
    storage.getDefinitiveTimetable()
  );
  const [provisionalTimetable, setProvisionalTimetable] = useState<TimetableSlot[]>(() =>
    storage.getProvisionalTimetable()
  );
  const [timetableMode, setTimetableMode] = useState<TimetableMode>(() =>
    storage.getTimetableMode()
  );
  const [events, setEvents] = useState<CalendarEvent[]>(() => storage.getEvents());
  const [circulars, setCirculars] = useState<CircularDocument[]>(() => storage.getCirculars());
  const [students, setStudents] = useState<Student[]>(() => storage.getStudents());

  // Active Timetable logic: defaults to provisional if definitive is uncompiled
  const activeTimetableInfo = storage.getActiveTimetableInfo();
  const timetable = activeTimetableInfo.slots;
  const isProvisionalActive = activeTimetableInfo.activeType === "provvisorio";
  const isDefinitiveCompiled = activeTimetableInfo.isDefinitiveCompiled;

  const [currentView, setCurrentView] = useState<ViewMode>("oggi");
  const [isCircularModalOpen, setIsCircularModalOpen] = useState(false);
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(() => !storage.hasCompletedOnboarding());

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

  const handleGoogleLogin = async () => {
    try {
      const result = await signInWithGoogle();
      if (result) {
        setGoogleUser(result.user);
        setGoogleAccessToken(result.accessToken);
        const email = result.user.email || "";
        const updated = {
          ...profile,
          email: email || profile.email,
          fullName:
            profile.fullName === "Prof. Mario Rossi" && result.user.displayName
              ? result.user.displayName
              : profile.fullName,
          googleCalendarLinked: true,
          googleCalendarAccount: email,
        };
        handleSaveProfile(updated);
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
      handleSaveProfile(updated);
      showToast("Account Google disconnesso.");
    } catch (err: any) {
      console.error("Disconnessione fallita:", err);
      showToast("Errore durante la disconnessione.");
      throw err;
    }
  };

  const handleSyncAllToGoogle = async (): Promise<{ syncedCount: number; errorCount: number }> => {
    const token = googleAccessToken || getAccessToken();
    if (!token) {
      throw new Error("Effettua prima l'accesso con il tuo account istituzionale Google.");
    }
    const result = await syncOptedInGoogleEvents(
      token, storage.getEvents().map(event => event.id),
      id => storage.getEvents().find(event => event.id === id),
      event => storage.saveEvent(event),
    );
    setEvents(storage.getEvents());
    return result;
  };

  const handleNavigateToPlanning = (
    dateIso: string,
    view: "oggi" | "settimana" | "mese" = "settimana"
  ) => {
    setPlanningTargetDate(dateIso);
    setCurrentView(view);
  };

  const handleAddEventsToPlanning = (newEvents: CalendarEvent[], feedbackMsg?: string) => {
    const addedCount = storage.bulkAddEvents(newEvents);
    setEvents(storage.getEvents());
    showToast(feedbackMsg || `${addedCount} impegni aggiunti al tuo planning!`);
  };

  // Reload all data (e.g. after backup import)
  const refreshAllData = () => {
    setProfile(storage.getProfile());
    setDefinitiveTimetable(storage.getDefinitiveTimetable());
    setProvisionalTimetable(storage.getProvisionalTimetable());
    setTimetableMode(storage.getTimetableMode());
    setEvents(storage.getEvents());
    setCirculars(storage.getCirculars());
    setStudents(storage.getStudents());
  };

  // Profile Save
  const handleSaveProfile = (updated: TeacherProfile) => {
    setProfile(updated);
    storage.saveProfile(updated);
    showToast("Profilo docente aggiornato con successo.");
  };

  const handleFinishOnboarding = (
    updatedProfile: TeacherProfile,
    openCircularScannerImmediately?: boolean
  ) => {
    storage.saveProfile(updatedProfile);
    storage.setOnboardingCompleted(true);
    setProfile(updatedProfile);
    setIsOnboardingOpen(false);
    showToast(`Configurazione completata! Benvenuto, ${updatedProfile.fullName}`);
    if (openCircularScannerImmediately) {
      setTimeout(() => {
        setIsCircularModalOpen(true);
      }, 250);
    }
  };

  // Timetable Handlers
  const handleSaveTimetableSlot = (slot: TimetableSlot, type: TimetableType) => {
    storage.saveTimetableSlot(slot, type);
    setDefinitiveTimetable(storage.getDefinitiveTimetable());
    setProvisionalTimetable(storage.getProvisionalTimetable());
    showToast(
      type === "provvisorio"
        ? "Ora salvata nell'orario provvisorio."
        : "Ora salvata nell'orario definitivo."
    );
  };

  const handleDeleteTimetableSlot = (id: string, type: TimetableType) => {
    storage.deleteTimetableSlot(id, type);
    setDefinitiveTimetable(storage.getDefinitiveTimetable());
    setProvisionalTimetable(storage.getProvisionalTimetable());
    showToast("Ora rimossa dall'orario.");
  };

  const handleSetTimetableMode = (mode: TimetableMode) => {
    storage.setTimetableMode(mode);
    setTimetableMode(mode);
    showToast(
      mode === "provvisorio"
        ? "Orario provvisorio impostato come attivo nei planning."
        : mode === "definitivo"
        ? "Orario definitivo impostato come attivo nei planning."
        : "Modalità automatica attiva (provvisorio fino a compilazione del definitivo)."
    );
  };

  const handleCopyProvisionalToDefinitive = () => {
    storage.copyProvisionalToDefinitive();
    setDefinitiveTimetable(storage.getDefinitiveTimetable());
    showToast("Ore dell'orario provvisorio copiate nell'orario definitivo.");
  };

  const handleCopyDefinitiveToProvisional = () => {
    storage.copyDefinitiveToProvisional();
    setProvisionalTimetable(storage.getProvisionalTimetable());
    showToast("Ore dell'orario definitivo copiate nell'orario provvisorio.");
  };

  const handleClearTimetable = (type: TimetableType) => {
    storage.clearTimetable(type);
    setDefinitiveTimetable(storage.getDefinitiveTimetable());
    setProvisionalTimetable(storage.getProvisionalTimetable());
    showToast(
      type === "definitivo"
        ? "Orario definitivo azzerato (ora l'app mostra di default l'orario provvisorio)."
        : "Orario provvisorio azzerato."
    );
  };

  const handleResetProvisionalTimetable = () => {
    storage.resetProvisionalTimetable();
    setProvisionalTimetable(storage.getProvisionalTimetable());
    showToast("Orario provvisorio demo ripristinato.");
  };

  const handleResetDefinitiveTimetable = () => {
    storage.resetDefinitiveTimetable();
    setDefinitiveTimetable(storage.getDefinitiveTimetable());
    showToast("Orario definitivo standard (18 ore) caricato.");
  };

  const handleDeleteExtractedItem = (circularId: string, item: ExtractedItem) => {
    storage.deleteExtractedItemFromCircular(circularId, item.tempId);
    storage.deleteEventMatchingExtractedItem(item, circularId);
    setCirculars(storage.getCirculars());
    setEvents(storage.getEvents());
    showToast("Riga estrapolata eliminata dalla circolare.");
  };

  // Event Handlers
  const handleSaveEvent = async (event: CalendarEvent) => {
    // Save locally first
    storage.saveEvent(event);
    setEvents(storage.getEvents());

    // If sync with Google is requested and we have an access token
    const token = googleAccessToken || getAccessToken();
    if (isGoogleSyncEnabled(event) && token) {
      const result = await syncOptedInGoogleEvents(
        token, [event.id],
        id => storage.getEvents().find(current => current.id === id),
        current => storage.saveEvent(current),
      );
      setEvents(storage.getEvents());
      showToast(result.errorCount ? "Impegno salvato in locale (errore sync Google Calendar)."
        : result.syncedCount ? "Impegno salvato e sincronizzato su Google Calendar." : "Impegno salvato in locale.");
      return;
    }

    showToast("Impegno salvato con successo.");
  };

  const handleDeleteEvent = async (id: string) => {
    const ev = events.find((e) => e.id === id);
    const token = googleAccessToken || getAccessToken();
    if (ev?.googleEventId && isGoogleSyncEnabled(ev) && token) {
      try {
        await deleteGoogleCalendarEvent(token, ev.googleEventId);
      } catch (err) {
        console.warn("Impossibile eliminare da Google Calendar:", err);
      }
    }
    storage.deleteEvent(id);
    setEvents(storage.getEvents());
    showToast("Impegno eliminato dall'agenda.");
  };

  const handleToggleComplete = (id: string) => {
    storage.toggleEventCompleted(id);
    setEvents(storage.getEvents());
  };

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
  const handleSaveStudent = (student: Student) => {
    storage.saveStudent(student);
    setStudents(storage.getStudents());
    showToast(`Scheda di ${student.fullName} salvata.`);
  };

  const handleDeleteStudent = (studentId: string) => {
    storage.deleteStudent(studentId);
    setStudents(storage.getStudents());
    showToast("Alunno rimosso dall'elenco.");
  };

  const handleAddStudentNote = (studentId: string, note: StudentNote) => {
    storage.addStudentNote(studentId, note);
    setStudents(storage.getStudents());
    showToast("Nota aggiunta al diario dell'alunno.");
  };

  const handleDeleteStudentNote = (studentId: string, noteId: string) => {
    storage.deleteStudentNote(studentId, noteId);
    setStudents(storage.getStudents());
    showToast("Nota rimossa dal diario.");
  };

  const handleDeleteMultipleStudents = (studentIds: string[]) => {
    const list = storage.getStudents().filter((s) => !studentIds.includes(s.id));
    storage.saveStudents(list);
    setStudents(list);
    showToast(`${studentIds.length} alunni rimossi.`);
  };

  const handleReassignStudentsClass = (studentIds: string[], targetClass: string) => {
    const list = storage.getStudents().map((s) => {
      if (studentIds.includes(s.id)) {
        return { ...s, className: targetClass.toUpperCase(), updatedAt: new Date().toISOString() };
      }
      return s;
    });
    storage.saveStudents(list);
    setStudents(list);
    showToast(`${studentIds.length} alunni spostati nella classe ${targetClass.toUpperCase()}.`);
  };

  const handleClearAllStudents = () => {
    storage.saveStudents([]);
    setStudents([]);
    showToast("Elenco alunni azzerato.");
  };

  const handleScheduleStudentEvent = (prefill: Partial<CalendarEvent>) => {
    setEditingEvent(null);
    setPrefilledEventData(prefill);
    setTargetDateForNewEvent(prefill.date);
    setIsEventModalOpen(true);
  };

  // Circular Import Confirmation
  const handleImportCircularEvents = (
    newEvents: CalendarEvent[],
    docMeta: CircularDocument
  ) => {
    const addedCount = storage.bulkAddEvents(newEvents);
    storage.saveCircular(docMeta);
    setEvents(storage.getEvents());
    setCirculars(storage.getCirculars());
    showToast(`Perfetto! ${addedCount} impegni pertinenti aggiunti all'agenda.`);
    setCurrentView("oggi");
  };

  const handleDeleteCircular = (id: string) => {
    storage.deleteCircular(id);
    setCirculars(storage.getCirculars());
    showToast("Circolare rimossa dall'archivio.");
  };

  // Stats for badges
  const todayIso = localDateISO();
  const todayEventsCount = events.filter((e) => e.date === todayIso && !e.completed).length;
  const pendingDeadlinesCount = events.filter(
    (e) => (e.category === "scadenza" || e.category === "promemoria") && !e.completed
  ).length;

  return (
    <div className="min-h-screen bg-stone-100/70 text-stone-900 flex flex-col font-sans selection:bg-emerald-100 selection:text-emerald-900">
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
            onSaveSlot={handleSaveTimetableSlot}
            onDeleteSlot={handleDeleteTimetableSlot}
            onSetTimetableMode={handleSetTimetableMode}
            onCopyProvisionalToDefinitive={handleCopyProvisionalToDefinitive}
            onCopyDefinitiveToProvisional={handleCopyDefinitiveToProvisional}
            onClearTimetable={handleClearTimetable}
            onResetProvisional={handleResetProvisionalTimetable}
            onResetDefinitive={handleResetDefinitiveTimetable}
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
      <CircularAnalyzerModal
        isOpen={isCircularModalOpen}
        onClose={() => setIsCircularModalOpen(false)}
        profile={profile}
        onImportEvents={handleImportCircularEvents}
      />

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
        initialTab={profileInitialTab}
      />

      <OnboardingModal
        isOpen={isOnboardingOpen}
        initialProfile={profile}
        onFinish={handleFinishOnboarding}
        onClose={() => setIsOnboardingOpen(false)}
        googleUser={googleUser}
        onGoogleLogin={handleGoogleLogin}
      />

      <OfflineIndicator />
    </div>
  );
}
