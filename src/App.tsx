import { deleteEventLocallyFirst } from "./services/eventWorkflows";
import { observeLocalData, retainEqual } from "./services/observeLocalData";
import { persistenceErrorMessage } from "./services/persistenceErrors";
import { isStudentActive } from "./utils/studentMatcher";
import { deriveScheduledAssessmentCalendarItems } from "./utils/scheduledAssessmentCalendar";
import { database, type LocalData } from "./services/db";
import { effectiveDeadlineDate, localDateISO } from "./utils/dates";
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
import { FutureCommitmentsView } from "./components/FutureCommitmentsView";
const TimetableEditor = lazy(() => import("./components/TimetableEditor").then(module => ({default: module.TimetableEditor})));
const CircularsArchiveView = lazy(() => import("./components/CircularsArchiveView").then(module => ({default: module.CircularsArchiveView})));
const ClassesView = lazy(() => import("./components/ClassesView").then(module => ({default: module.ClassesView})));
const RegisterView = lazy(() => import("./components/RegisterView").then(module => ({default: module.RegisterView})));
const CircularAnalyzerModal = lazy(() => import("./components/CircularAnalyzerModal").then(module => ({default: module.CircularAnalyzerModal})));
const DocumentScannerModal = lazy(() => import("./components/DocumentScannerModal").then(module => ({default: module.DocumentScannerModal})));
import { EventModal } from "./components/EventModal";
import { QuickNoteModal } from "./components/QuickNoteModal";
const ProfileModal = lazy(() => import("./components/ProfileModal").then(module => ({default: module.ProfileModal})));
const OnboardingModal = lazy(() => import("./components/OnboardingModal").then(module => ({default: module.OnboardingModal})));
import { OfflineIndicator } from "./components/OfflineIndicator";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { formatPersonDisplayName, isPlaceholderFullName } from "./utils/names";
import { CheckCircle2 } from "lucide-react";
import { User as FirebaseUser } from "firebase/auth";
import {
  initAuth,
  signInWithGoogle,
  signOutFromGoogle,
  getAccessToken,
  isUserCancellationError,
} from "./services/googleAuth";
import {
  createGoogleCalendarEvent, updateGoogleCalendarEvent, PRIMARY_CALENDAR_ID,
  syncOptedInGoogleEvents,
} from "./services/googleCalendarService";
import {
  importSelectedGoogleCalendars,
  resolveImportCalendarIds,
  type GoogleCalendarImportResult,
} from "./services/googleCalendarImportService";
import { removeImportedGoogleEventsForCalendars } from "./utils/googleCalendarImport";
import { listGoogleCalendars, type GoogleCalendarListEntry } from "./services/googleCalendarService";
import {
  cachedGoogleCalendarsToEntries,
  googleCalendarSelectableIds,
  sameCachedGoogleCalendarList,
  toCachedGoogleCalendarList,
} from "./utils/googleCalendarCache";
import { normalizeTeacherProfile } from "./utils/multiSchool";
import { accountSync } from "./services/sync/accountSync";
import type { SyncStatus } from "./services/sync/types";
import { usePWAUpdates } from "./hooks/usePWAUpdates";
import type { MissingTimeSlotCoverage, TimeSlotConfigOpenRequest } from "./utils/timeSlotCoverage";
import { getEffectivePeriodSlots } from "./utils/timeSlots";
import { MissingTimeSlotCoverageBanner } from "./components/MissingTimeSlotCoverageBanner";
import type { ProfileTimeSlotRealignment } from "./components/ProfileModal";

type QuickNoteState =
  | { mode: "closed" }
  | { mode: "creating" }
  | { mode: "editing"; event: CalendarEvent };

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
  // File o modalità scansionata dal flusso unificato, da alimentare alla pipeline circolare esistente.
  const [scannerCircularFile, setScannerCircularFile] = useState<{
    mode?: "file" | "text";
    base64?: string;
    mimeType?: string;
    fileName?: string;
    autoStartToken?: string;
  } | null>(null);
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  // Un solo QuickNoteModal, apribile da Note e impegni, dal menu desktop e dal FAB.
  const [quickNoteState, setQuickNoteState] = useState<QuickNoteState>({ mode: "closed" });
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [missingTimeSlotCoverage, setMissingTimeSlotCoverage] = useState<MissingTimeSlotCoverage[]>([]);
  const [timeSlotConfigOpenRequest, setTimeSlotConfigOpenRequest] = useState<TimeSlotConfigOpenRequest | null>(null);
  const timeSlotConfigRequestSequence = useRef(0);
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
  // Forza il remount di TodayView quando si chiede "torna a oggi" mentre si è
  // GIA' sulla vista Oggi (altrimenti currentView resterebbe "oggi" e la vista
  // non riceverebbe alcun segnale per abbandonare il giorno su cui è ferma).
  // Nessuna logica di "qual è oggi" duplicata: il remount fa semplicemente
  // rieseguire l'inizializzazione già esistente di TodayView (default a
  // localDateISO() quando non c'è una data esplicita).
  const [oggiResetNonce, setOggiResetNonce] = useState(0);
  const [prefilledEventData, setPrefilledEventData] = useState<Partial<CalendarEvent> | null>(null);

  // Google Workspace / Institutional Account State
  const [googleUser, setGoogleUser] = useState<FirebaseUser | null>(null);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  // G1.1: automatic inbound Calendar refresh is session-only. There is no
  // background worker: it runs only while the app is open, online and the
  // OAuth token is available.
  const autoImportInFlight = useRef<Promise<GoogleCalendarImportResult | null> | null>(null);
  const lastSuccessfulImportAt = useRef<number | null>(null);
  // G1.2/§22: the first import of a session must run immediately, never waiting the cooldown.
  const sessionImportDone = useRef(false);
  // G1.2.4 — BOOTSTRAP: at startup the OAuth token is gone, but the CalendarList
  // cached in the profile (metadata only) is enough to show the calendars and let
  // the teacher change the checkboxes offline.
  const [googleCalendars, setGoogleCalendars] = useState<GoogleCalendarListEntry[] | null>(() => {
    const bootstrapped = cachedGoogleCalendarsToEntries(initialData.profile.googleCalendarListCache);
    return bootstrapped.length > 0 ? bootstrapped : null;
  });
  /** Distinguishes a list restored from the persisted cache from one fetched in this session. */
  const [googleCalendarListSource, setGoogleCalendarListSource] = useState<"cache" | "live" | null>(() =>
    cachedGoogleCalendarsToEntries(initialData.profile.googleCalendarListCache).length > 0 ? "cache" : null);
  const googleCalendarsLoading = useRef(false);
  const previousOnline = useRef<boolean | null>(null);
  const [profileInitialTab, setProfileInitialTab] = useState<"profilo" | "backup" | "google">("profilo");

  // Feedback Notification Banner
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [googleAutoImportStatus, setGoogleAutoImportStatus] = useState<"idle" | "syncing" | "success" | "error" | "needs-auth">("idle");
  const [lastImportResult, setLastImportResult] = useState<GoogleCalendarImportResult | null>(null);
  const [lastSuccessfulImportAtState, setLastSuccessfulImportAtState] = useState<number | null>(null);
  const GOOGLE_CALENDAR_AUTO_IMPORT_COOLDOWN_MS = 5 * 60 * 1000;

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

  const runAutomaticGoogleImport = useCallback(async (force = false, tokenOverride?: string, userOverride?: FirebaseUser, calendarIdsOverride?: string[]): Promise<GoogleCalendarImportResult | null> => {
    const activeGoogleUser = userOverride || googleUser;
    if (!activeGoogleUser || !isOnline) return null;
    const token = tokenOverride || googleAccessToken || getAccessToken();
    if (!token) {
      setGoogleAutoImportStatus("needs-auth");
      return null;
    }
    const last = lastSuccessfulImportAt.current;
    // Session start (and explicit user actions) bypass the 5-minute cooldown.
    const immediate = force || !sessionImportDone.current;
    if (!immediate && last !== null && Date.now() - last < GOOGLE_CALENDAR_AUTO_IMPORT_COOLDOWN_MS) return null;
    // Single-flight: one running import already covers ALL selected calendars.
    if (autoImportInFlight.current) return autoImportInFlight.current;
    const calendarIds = calendarIdsOverride ?? resolveImportCalendarIds(profile);
    const request = (async () => {
      setGoogleAutoImportStatus("syncing");
      try {
        const result = await importSelectedGoogleCalendars(token, calendarIds);
        sessionImportDone.current = true;
        lastSuccessfulImportAt.current = Date.now();
        setLastSuccessfulImportAtState(lastSuccessfulImportAt.current);
        setLastImportResult(result);
        setGoogleAutoImportStatus("success");
        return result;
      } catch (error) {
        console.warn("Aggiornamento automatico Google Calendar non riuscito:", error);
        setGoogleAutoImportStatus("error");
        return null;
      } finally {
        autoImportInFlight.current = null;
      }
    })();
    autoImportInFlight.current = request;
    return request;
  }, [googleUser, googleAccessToken, isOnline, profile.googleCalendarImportIds]);

  // G1.2.4 — re-bootstrap from the persisted cache whenever no list is available in
  // memory: startup, backup restore and account-sync pulls all flow through `profile`.
  useEffect(() => {
    if (googleCalendars !== null) return;
    const cached = cachedGoogleCalendarsToEntries(profile.googleCalendarListCache);
    if (cached.length === 0) return;
    setGoogleCalendars(cached);
    setGoogleCalendarListSource("cache");
  }, [profile.googleCalendarListCache, googleCalendars]);

  /**
   * G1.2.4 — a CalendarList really downloaded from Google becomes the live list AND
   * replaces the persisted cache (metadata only: never a token).
   *
   * The persisted selection (`googleCalendarImportIds`) is never rewritten here, with one
   * audited exception: a calendar that no longer exists in the live list is dropped from
   * the selection and its locally imported events are cleaned up (same local cleanup as
   * G1.2.3). Legacy profiles without an explicit selection are left untouched.
   */
  const applyLiveGoogleCalendarList = useCallback(async (calendars: GoogleCalendarListEntry[]) => {
    setGoogleCalendars(calendars);
    setGoogleCalendarListSource("live");
    const cache = toCachedGoogleCalendarList(calendars);
    let staleIds: string[] = [];
    try {
      await database.atomic(async () => {
        const current = await storage.getProfile();
        const liveIds = googleCalendarSelectableIds(calendars);
        const selection = current.googleCalendarImportIds;
        staleIds = Array.isArray(selection) ? selection.filter(id => !liveIds.has(id)) : [];
        const cacheChanged = !sameCachedGoogleCalendarList(current.googleCalendarListCache, cache);
        if (!cacheChanged && staleIds.length === 0) return;
        const nextProfile: TeacherProfile = { ...current, googleCalendarListCache: cache };
        if (staleIds.length > 0) nextProfile.googleCalendarImportIds = selection!.filter(id => liveIds.has(id));
        await storage.saveProfile(nextProfile);
        if (staleIds.length > 0) {
          const currentEvents = await storage.getEvents();
          const cleaned = removeImportedGoogleEventsForCalendars(currentEvents, staleIds);
          if (cleaned.length !== currentEvents.length) await storage.saveEvents(cleaned);
        }
      });
    } catch (error) {
      // The cache is an optimization: a persistence failure must never hide the live list.
      console.warn("Cache elenco calendari Google non aggiornata:", error);
      return;
    }
    if (staleIds.length > 0) {
      showToast(staleIds.length === 1
        ? "Un calendario non è più disponibile ed è stato rimosso dalla selezione."
        : "Alcuni calendari non sono più disponibili e sono stati rimossi dalla selezione.");
    }
  }, []);

  /** Loads the CalendarList once per session/token; the UI never refetches on every render. */
  const loadGoogleCalendars = useCallback(async (forceReload = false): Promise<GoogleCalendarListEntry[]> => {
    const token = googleAccessToken || getAccessToken();
    if (!token) {
      setGoogleAutoImportStatus("needs-auth");
      throw new Error("Ricollega Google per aggiornare l’elenco dei calendari.");
    }
    // A cached list is shown but is NOT a session list: with a valid token it is refreshed.
    const hasLiveList = googleCalendars !== null && googleCalendarListSource === "live";
    if (!forceReload && hasLiveList) return googleCalendars!;
    if (googleCalendarsLoading.current && hasLiveList) return googleCalendars!;
    googleCalendarsLoading.current = true;
    try {
      const calendars = await listGoogleCalendars(token);
      await applyLiveGoogleCalendarList(calendars);
      return calendars;
    } finally {
      googleCalendarsLoading.current = false;
    }
  }, [googleAccessToken, googleCalendars, googleCalendarListSource, applyLiveGoogleCalendarList]);

  /**
   * Persists the selection (IDs only) and imports the new set immediately, bypassing the cooldown.
   *
   * G1.2.4 — changing the checkboxes is a LOCAL operation:
   * - token available: save profile → cleanup removed → import the new selection;
   * - token missing:   save profile → cleanup removed → stop, with NO error and NO Google call.
   * One single call handles bulk actions too ("Seleziona tutti" / "Deseleziona tutti"):
   * one profile save, one cleanup, at most one import.
   */
  const handleUpdateGoogleCalendarSelection = useCallback(async (calendarIds: string[]) => {
    const rawUnique = Array.from(new Set(calendarIds));
    // CalendarList may expose the primary as its real email id; use one stable
    // identity for diffing and cleanup, while preserving other calendar ids.
    const primaryEntry = googleCalendars?.find(calendar => calendar.primary);
    const canonical = (id: string) => primaryEntry && id === primaryEntry.id ? PRIMARY_CALENDAR_ID : id;
    const previousIds = resolveImportCalendarIds(profile).map(canonical);
    const nextIds = rawUnique.map(canonical);
    const removedIds = previousIds.filter(id => !nextIds.includes(id));
    const addedIds = nextIds.filter(id => !previousIds.includes(id));
    const normalizedNext = Array.from(new Set(nextIds));
    // Keep the persisted selection equivalent to googleCalendarImportIds: unique.
    const unique = normalizedNext;
    // Read the token BEFORE any write: it decides only whether an import follows.
    const token = googleAccessToken || getAccessToken();

    // Persist first: a failed profile save must never delete local events.
    if (await handleSaveProfile({ ...profile, googleCalendarImportIds: normalizedNext }) === false) return;
    let removedCount = 0;
    if (removedIds.length > 0) {
      await database.atomic(async () => {
        const current = await storage.getEvents();
        const cleaned = removeImportedGoogleEventsForCalendars(current, removedIds);
        removedCount = current.length - cleaned.length;
        if (removedCount > 0) await storage.saveEvents(cleaned);
      });
    }
    if (removedCount > 0) {
      showToast(removedIds.length === 1
        ? `Calendario deselezionato: rimossi ${removedCount} eventi importati da AgendaDocente.`
        : `Calendari aggiornati: rimossi ${removedCount} eventi importati da calendari deselezionati.`);
    } else if (removedIds.length > 0) {
      showToast("Selezione calendari aggiornata.");
    }
    if (!token) {
      // Offline/senza token: la selezione è già salvata e il cleanup locale è già avvenuto.
      // Nessun errore, nessuna chiamata a Google, nessun runAutomaticGoogleImport().
      setGoogleAutoImportStatus("needs-auth");
      if (addedIds.length > 0) {
        showToast("Calendario selezionato. Gli eventi verranno importati alla prossima riconnessione Google.");
      }
      return;
    }
    // Selection changes bypass cooldown and import only the new selection.
    await runAutomaticGoogleImport(true, undefined, undefined, unique);
  }, [profile, googleCalendars, googleAccessToken, runAutomaticGoogleImport]);

  // Focus and online transitions are the only automatic triggers. Missing OAuth
  // tokens never cause a popup; the card asks the user to reconnect instead.
  useEffect(() => {
    const onFocus = () => { void runAutomaticGoogleImport(false); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [runAutomaticGoogleImport]);
  useEffect(() => {
    const cameOnline = previousOnline.current === false && isOnline;
    previousOnline.current = isOnline;
    if (cameOnline) void runAutomaticGoogleImport(false);
  }, [isOnline, runAutomaticGoogleImport]);
  useEffect(() => {
    if (googleUser && googleAccessToken && isOnline) void runAutomaticGoogleImport(false);
  }, [googleUser, googleAccessToken, isOnline, runAutomaticGoogleImport]);

  /** Shared bookkeeping for a successful Google login (normal login AND explicit reconnect). */
  const applyGoogleLoginResult = async (result: { user: FirebaseUser; accessToken: string }) => {
    setGoogleUser(result.user);
    setGoogleAccessToken(result.accessToken);
    // Explicit login bypasses the cooldown and imports immediately.
    void runAutomaticGoogleImport(true, result.accessToken, result.user);
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
  };

  /** Single sign-in pipeline; `forceConsent` is reserved for the explicit reconnect gesture. */
  const runGoogleSignIn = async (options?: { forceConsent?: boolean }) => {
    try {
      const result = await signInWithGoogle(options);
      if (!result) return null;
      return await applyGoogleLoginResult(result);
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

  /** Normal login: never forces the Google consent screen. */
  const handleGoogleLogin = async () => runGoogleSignIn();

  /**
   * G1.2.1 — explicit "Ricollega Google": forces prompt="consent select_account" so the
   * new read-only CalendarList scopes are actually granted, then invalidates the cached
   * CalendarList and reloads it with the fresh token. The automatic import starts
   * immediately (cooldown bypassed) inside applyGoogleLoginResult.
   */
  const handleGoogleReconnect = async () => {
    const result = await runGoogleSignIn({ forceConsent: true });
    if (!result) return null;
    // G1.2.4 — the previously shown list may come from the persisted cache: mark it stale
    // and refetch right away, so the open modal updates without a close/reopen cycle.
    // The visible list is NOT cleared: a failed refetch must never leave an empty card.
    setGoogleCalendarListSource(previous => (previous === "live" ? "cache" : previous));
    try {
      await applyLiveGoogleCalendarList(await listGoogleCalendars(result.accessToken));
    } catch (error) {
      console.warn("Elenco calendari non aggiornato dopo la riconnessione:", error);
    }
    return result;
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

  const handleImportFromGoogle = async (): Promise<GoogleCalendarImportResult> => {
    if (database.mode !== "indexeddb") throw new Error("Archivio locale in sola lettura: importazione sospesa.");
    let token = googleAccessToken || getAccessToken();
    let loginUser: FirebaseUser | undefined;
    if (!token) {
      const login = await handleGoogleLogin();
      token = login?.accessToken ?? null;
      loginUser = login?.user;
    }
    if (!token) throw new Error("Riconnetti l’account Google per autorizzare il download degli eventi.");
    // Manual refresh uses the same single-flight G1 pipeline and only bypasses
    // its cooldown; it never creates a second import implementation.
    const result = await runAutomaticGoogleImport(true, token, loginUser || googleUser || undefined);
    if (!result) throw new Error("Aggiornamento Google Calendar non disponibile.");
    return result;
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

  // Profile Save. Quando il Profilo conferma il riallineamento, profilo
  // (dayPeriods + campane school-specific) e i due archivi orario condividono
  // una sola transazione: nessuno stato intermedio può arrivare al sync.
  const handleSaveProfile = withPersistenceFeedback(async (
    updated: TeacherProfile,
    expected?: TeacherProfile,
    realignment?: ProfileTimeSlotRealignment,
  ) => {
    await database.atomic(async () => {
      await storage.saveProfile(updated, expected);
      if (realignment) {
        await storage.saveProvisionalTimetable(realignment.provisional);
        await storage.saveDefinitiveTimetable(realignment.definitive);
      }
    });
    showToast(realignment
      ? "Profilo, fasce orarie e lezioni aggiornati con successo."
      : "Profilo docente aggiornato con successo.");
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

  /**
   * Fasce orarie di UN istituto.
   *
   * Scrive SOLO `schools[i].timeSlotConfig` della scuola indicata: gli altri
   * istituti e la configurazione globale (che resta il default di chi non si è
   * ancora personalizzato) non vengono toccati. Il profilo si aggiorna per
   * spread, così nessun campo dell'istituto va perso.
   *
   * Si parte dal profilo NORMALIZZATO perché è lì che un profilo legacy espone
   * la sua primaria: senza normalizzare, `schools` potrebbe non contenere
   * ancora la scuola che l'utente sta configurando.
   */
  const handleSaveSchoolTimeSlotConfig = withPersistenceFeedback(async (
    schoolId: string,
    config: TimeSlotConfig,
    realignment?: { provisional: TimetableSlot[]; definitive: TimetableSlot[] }
  ) => {
    const normalized = normalizeTeacherProfile(profile);
    const schools = normalized.schools ?? [];
    // Istituto inesistente: non si scrive nulla e non si mente all'utente con
    // un messaggio di conferma.
    if (!schools.some(school => school.id === schoolId)) {
      throw new Error("Istituto non trovato nel profilo.");
    }
    const updatedProfile: TeacherProfile = {
      ...normalized,
      schools: schools.map(school =>
        school.id === schoolId ? { ...school, timeSlotConfig: config } : school
      ),
    };

    // Fasce e lezioni riallineate sono UNA sola operazione: se fallisse a metà
    // resterebbero campane nuove e lezioni sui vecchi orari, cioè proprio
    // l'incoerenza che questo passo elimina.
    await database.atomic(async () => {
      await storage.saveProfile(updatedProfile);
      if (realignment) {
        await storage.saveProvisionalTimetable(realignment.provisional);
        await storage.saveDefinitiveTimetable(realignment.definitive);
      }
    });
    const effectiveCount = getEffectivePeriodSlots(config).length;
    setMissingTimeSlotCoverage(current =>
      current.filter(item => item.schoolId !== schoolId || item.requiredPeriods > effectiveCount)
    );
    showToast(realignment ? "Fasce orarie e lezioni aggiornate." : "Fasce orarie aggiornate.");
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
    await storage.saveEvent(event, expected);
    showToast("Impegno salvato con successo.");
  });


  const googleSendFlights = useRef(new Map<string, Promise<CalendarEvent>>());
  const handleSendEventToGoogle = async (event: CalendarEvent, requestedCalendarId: string): Promise<CalendarEvent> => {
    const existing = googleSendFlights.current.get(event.id);
    if (existing) return existing;
    const request = (async () => {
      // Local-first is deliberate: a remote failure must never lose form edits.
      await storage.saveEvent(event);
      const token = googleAccessToken || getAccessToken();
      if (!token) throw new Error("Ricollega Google prima di inviare l’impegno.");
      const calendarId = event.googleEventId ? (event.googleCalendarId || PRIMARY_CALENDAR_ID) : requestedCalendarId;
      try {
        let googleEventId = event.googleEventId;
        if (googleEventId) await updateGoogleCalendarEvent(token, googleEventId, event, calendarId);
        else googleEventId = await createGoogleCalendarEvent(token, event, calendarId);
        const linked = { ...event, googleEventId, googleCalendarId: calendarId, syncedWithGoogle: false };
        await storage.saveEvent(linked);
        setEditingEvent(linked);
        showToast(event.googleEventId ? "Copia Google aggiornata." : "Impegno inviato a Google Calendar.");
        return linked;
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (status === 403) {
          void loadGoogleCalendars(true).catch(() => undefined);
          throw new Error("Non hai più il permesso di scrivere su questo calendario Google.");
        }
        throw error;
      }
    })().finally(() => googleSendFlights.current.delete(event.id));
    googleSendFlights.current.set(event.id, request);
    return request;
  };

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

  const handleOpenNewQuickNote = () => {
    setQuickNoteState({ mode: "creating" });
  };

  const handleEditQuickNote = (event: CalendarEvent) => {
    setQuickNoteState({ mode: "editing", event });
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
    docMeta: CircularDocument,
    updatedEvents: CalendarEvent[] = []
  ) => {
    const result = await database.atomic(async () => {
      const counts = await storage.importCircularEvents(newEvents, updatedEvents);
      await storage.saveCircular(docMeta);
      return counts;
    });

    const msg = result.updated > 0 && result.added > 0
      ? `Perfetto! ${result.added} impegni aggiunti e ${result.updated} aggiornati.`
      : result.updated > 0
      ? `Perfetto! ${result.updated} impegni aggiornati.`
      : `Perfetto! ${result.added} impegni pertinenti aggiunti all'agenda.`;
    showToast(msg);
    setCurrentView("oggi");
  });

  const handleDeleteCircular = withPersistenceFeedback(async (id: string) => {
    await storage.deleteCircular(id);

    showToast("Circolare rimossa dall'archivio.");
  });

  // Scansiona documento: la circolare (file con auto-start o handoff testo) alimenta la pipeline esistente.
  const handleScanDocumentToCircular = (info: {
    mode?: "file" | "text";
    base64?: string;
    mimeType?: string;
    fileName?: string;
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

  // Unica funzione che riporta la vista Oggi sul giorno odierno: usata dal
  // tap su "Oggi" della navigazione mobile quando non si è sulla "giornata
  // corrente" (altra sezione, Settimana/Mese, o Oggi spostata su un altro
  // giorno). Passa sempre da handleViewChange (stessi effetti collaterali di
  // qualunque altra navigazione) e azzera oggiTargetDate: se la vista Oggi è
  // già montata, oggiResetNonce forza il remount a riprendere il valore di
  // default (oggi reale).
  const goToToday = useCallback(() => {
    handleViewChange("oggi");
    setOggiTargetDate(undefined);
    setOggiResetNonce((n) => n + 1);
  }, []);
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
  // "Giornata corrente" per la navigazione mobile: vista Oggi E data mostrata
  // = oggi. oggiTargetDate è undefined finché TodayView non ha ancora
  // riportato la propria data (equivale a "oggi", il suo stesso default).
  const isOggiShowingToday = oggiTargetDate === undefined || oggiTargetDate === todayIso;
  const todayEventsCount = events.filter((e) => e.date === todayIso && !e.completed).length;
  const pendingDeadlinesCount = events.filter(
    (e) => !!effectiveDeadlineDate(e) && !e.completed
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
        onOpenNewNote={handleOpenNewQuickNote}
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

      {/* Follow-up after saving dayPeriods: persistent until the matching school
          has enough real bell slots. The CTA opens the existing drawer; no slot
          is generated or persisted here. */}
      <MissingTimeSlotCoverageBanner
        missing={missingTimeSlotCoverage}
        onConfigure={(schoolId) => {
          timeSlotConfigRequestSequence.current += 1;
          setTimeSlotConfigOpenRequest({ schoolId, requestId: timeSlotConfigRequestSequence.current });
          handleViewChange("orario");
        }}
      />

      {/* Main View Container: `.app-main` reserves the bottom navigation space on phones */}
      <main className="app-main flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 pt-3 sm:pt-6">
        {currentView === "oggi" && (
          <TodayView
            key={oggiResetNonce}
            profile={profile}
            timeSlotConfig={timeSlotConfig}
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
            timeSlotConfig={timeSlotConfig}
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

        {currentView === "impegni" && (
          <FutureCommitmentsView
            events={events}
            scheduledAssessments={scheduledAssessments}
            students={students}
            onEditEvent={handleEditEvent}
            onEditNote={handleEditQuickNote}
            onCreateNote={handleOpenNewQuickNote}
            onToggleComplete={handleToggleComplete}
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
            onSaveSchoolTimeSlotConfig={handleSaveSchoolTimeSlotConfig}
            timeSlotConfigOpenRequest={timeSlotConfigOpenRequest}
            onTimeSlotConfigOpenRequestHandled={() => setTimeSlotConfigOpenRequest(null)}
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
        isOggiShowingToday={isOggiShowingToday}
        onGoToToday={goToToday}
        onOpenNewEvent={() => handleOpenNewEvent()}
        onOpenNewNote={handleOpenNewQuickNote}
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
        onSaveProfile={handleSaveProfile}
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
        existingEvents={events}
        onImportEvents={handleImportCircularEvents}
        initialFile={scannerCircularFile}
        initialInputMode={scannerCircularFile?.mode ?? "file"}
      />
      )}

      <QuickNoteModal
        isOpen={quickNoteState.mode !== "closed"}
        onClose={() => setQuickNoteState({ mode: "closed" })}
        noteToEdit={quickNoteState.mode === "editing" ? quickNoteState.event : null}
        onSave={handleSaveEvent}
        onDelete={handleDeleteEvent}
        classes={profile.classes}
      />

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
        googleWritableCalendars={(googleCalendars || []).filter(calendar => ["owner", "writer", "organizer"].includes(calendar.accessRole || ""))}
        googleCalendarsLoaded={googleCalendars !== null && googleCalendarListSource === "live"}
        onLoadGoogleCalendars={() => loadGoogleCalendars()}
        onGoogleConnect={googleUser ? handleGoogleReconnect : handleGoogleLogin}
        onSendToGoogle={handleSendEventToGoogle}
      />
      )}

      {isProfileModalOpen && (
      <ProfileModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        profile={profile}
        timeSlotConfig={timeSlotConfig}
        provisionalTimetable={provisionalTimetable}
        definitiveTimetable={definitiveTimetable}
        onSaveProfile={handleSaveProfile}
        onMissingTimeSlotCoverage={setMissingTimeSlotCoverage}
        onDataImported={refreshAllData}
        onOpenTutorial={() => setIsOnboardingOpen(true)}
        googleUser={googleUser}
        googleAccessToken={googleAccessToken}
        onGoogleLogin={handleGoogleLogin}
        onGoogleReconnect={handleGoogleReconnect}
        onGoogleLogout={handleGoogleLogout}
        events={events}
        onImportFromGoogle={handleImportFromGoogle}
        googleAutoImportStatus={googleAutoImportStatus}
        lastImportResult={lastImportResult}
        lastSuccessfulImportAt={lastSuccessfulImportAtState}
        onAutomaticImport={() => runAutomaticGoogleImport(true)}
        googleCalendars={googleCalendars}
        googleCalendarListSource={googleCalendarListSource}
        onLoadGoogleCalendars={loadGoogleCalendars}
        selectedGoogleCalendarIds={resolveImportCalendarIds(profile)}
        onUpdateGoogleCalendarSelection={handleUpdateGoogleCalendarSelection}
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
