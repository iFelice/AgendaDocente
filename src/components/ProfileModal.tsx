import { restoreAndRefresh } from "../services/restoreWorkflow";
import { usePersistenceAction } from "../hooks/usePersistenceAction";
import { localDateISO } from "../utils/dates";
import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Download,
  Save,
  Trash2,
  Upload,
  User,
  X,
  School,
  ShieldCheck,
  CheckCircle2,
  Calendar,
  Compass,
  LogOut,
  RefreshCw,
  AlertCircle,
  CalendarCheck,
  Check,
  CloudOff,
  TriangleAlert,
} from "lucide-react";
import { User as FirebaseUser } from "firebase/auth";
import { TeacherProfile, TeacherRole, TeacherRoleKind, TEACHER_ROLE_KINDS, SchoolLevel, CalendarEvent, SchoolProfile, SchoolDayPeriodsConfig, TimeSlotConfig, TimetableSlot } from "../types";
import { ROLE_LABELS, roleDisplayName } from "../utils/teacherRoles";
import { formatPersonDisplayName } from "../utils/names";
import { storage } from "../services/storage";
import { getCurrentSchoolYear, getSuggestedSchoolYears } from "../utils/schoolYear";
import { GoogleSignInButton } from "./GoogleSignInButton";
import { isUserCancellationError } from "../services/googleAuth";
import { downloadIcsCalendar } from "../services/googleCalendarService";
import type { SyncStatus } from "../services/sync/types";
import type { GoogleCalendarImportResult } from "../services/googleCalendarImportService";
import { CloudSync } from "./CloudSyncCard";
import { useManualSync } from "../hooks/useManualSync";
import { hasActiveSecondarySchool, normalizeTeacherProfile } from "../utils/multiSchool";
import { DEFAULT_SCHOOL_DAYS, SchoolDayPeriodsEditor } from "./SchoolDayPeriodsEditor";
import { isSupportTeacherOf } from "../utils/teacherType";
import { planTimeSlotRealignment, timeSlotConfigForSchool } from "../utils/timeSlots";
import { findMissingTimeSlotCoverage, type MissingTimeSlotCoverage } from "../utils/timeSlotCoverage";
import { maxPeriodsInWeek } from "../utils/schoolDayPeriods";
import {
  TimeSlotConfigEditor,
  createTimeSlotConfigDraft,
  finalizedTimeSlotConfigDraft,
  timeSlotConfigEditorMode,
  type TimeSlotConfigEditorMode,
} from "./TimeSlotConfigEditor";

export interface ProfileTimeSlotRealignment {
  provisional: TimetableSlot[];
  definitive: TimetableSlot[];
}

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: TeacherProfile;
  /** Saves profile fields and, when confirmed, both timetable archives atomically. */
  onSaveProfile: (
    updatedProfile: TeacherProfile,
    expected?: TeacherProfile,
    realignment?: ProfileTimeSlotRealignment,
  ) => void | false | Promise<void | false>;
  provisionalTimetable?: TimetableSlot[];
  definitiveTimetable?: TimetableSlot[];
  /** Reports, after a successful save, schools whose longest day still lacks a real bell slot. */
  onMissingTimeSlotCoverage?: (missing: MissingTimeSlotCoverage[]) => void;
  onDataImported: () => void | false | Promise<void | false>;
  onOpenTutorial?: () => void;
  googleUser?: FirebaseUser | null;
  googleAccessToken?: string | null;
  onGoogleLogin?: () => Promise<void>;
  onGoogleLogout?: () => Promise<void>;
  events?: CalendarEvent[];
  onImportFromGoogle?: () => Promise<GoogleCalendarImportResult>;
  googleAutoImportStatus?: "idle" | "syncing" | "success" | "error" | "needs-auth";
  lastImportResult?: GoogleCalendarImportResult | null;
  lastSuccessfulImportAt?: number | null;
  onAutomaticImport?: () => Promise<GoogleCalendarImportResult | null>;
  onSyncAllToGoogle?: () => Promise<{ syncedCount: number; errorCount: number }>;
  accountSyncStatus?: SyncStatus;
  onSyncNow?: () => void;
  onSyncToggle?: (enabled: boolean) => void;
  onSyncResolve?: (choice: "local" | "remote") => void;
  /** Device connectivity, forwarded to the account-sync card (offline message + badge). */
  online?: boolean;
  /**
   * Config globale legacy: è solo il punto di partenza per una scuola senza
   * campane proprie. Il Profilo non la modifica; al Salva materializza invece
   * una copia coerente in `SchoolProfile.timeSlotConfig`.
   */
  timeSlotConfig?: TimeSlotConfig;
  initialTab?: "profilo" | "backup" | "google";
}

/**
 * SchoolProfile primaria secondo il modello multi-istituto esistente: si passa
 * sempre dalla normalizzazione, cosi un profilo legacy senza schools[] espone
 * comunque la primaria che normalizeTeacherProfile crea gia oggi.
 */
function primarySchoolOf(profile: TeacherProfile): SchoolProfile | undefined {
  const schools = normalizeTeacherProfile(profile).schools ?? [];
  return schools.find(s => s.isPrimary) ?? schools[0];
}

/**
 * Scrive la struttura giornaliera nella SchoolProfile PRIMARIA del profilo gia
 * normalizzato, preservando ogni altro campo (id, nome, email, sedi, grado,
 * weeklyHours, isPrimary, active). Gli altri istituti non vengono toccati.
 */
export function withPrimaryDayPeriods(profile: TeacherProfile, dayPeriods?: SchoolDayPeriodsConfig): TeacherProfile {
  const schools = profile.schools ?? [];
  const primaryIndex = schools.findIndex(s => s.isPrimary);
  const targetIndex = primaryIndex >= 0 ? primaryIndex : 0;
  if (schools.length === 0) return profile;
  return {
    ...profile,
    schools: schools.map((school, index) =>
      index === targetIndex
        ? (dayPeriods ? { ...school, dayPeriods } : (({ dayPeriods: _drop, ...rest }) => rest)(school))
        : school
    ),
  };
}

/**
 * La config delle campane e la struttura giornata sono due campi della STESSA
 * SchoolProfile primaria. Tenerli in questo helper rende esplicito che il
 * salvataggio Profilo non scrive mai la configurazione globale legacy.
 */
export function withPrimaryTimeSlotConfig(profile: TeacherProfile, timeSlotConfig: TimeSlotConfig): TeacherProfile {
  const schools = profile.schools ?? [];
  const primaryIndex = schools.findIndex(s => s.isPrimary);
  const targetIndex = primaryIndex >= 0 ? primaryIndex : 0;
  if (schools.length === 0) return profile;
  return {
    ...profile,
    schools: schools.map((school, index) =>
      index === targetIndex ? { ...school, timeSlotConfig } : school
    ),
  };
}

export const ProfileModal: React.FC<ProfileModalProps> = ({
  isOpen,
  onClose,
  profile,
  onSaveProfile,
  provisionalTimetable = [],
  definitiveTimetable = [],
  onMissingTimeSlotCoverage,
  onDataImported,
  onOpenTutorial,
  googleUser,
  googleAccessToken,
  onGoogleLogin,
  onGoogleLogout,
  events = [],
  onImportFromGoogle,
  googleAutoImportStatus = "idle",
  lastImportResult,
  lastSuccessfulImportAt,
  onAutomaticImport,
  onSyncAllToGoogle,
  accountSyncStatus,
  onSyncNow,
  onSyncToggle,
  onSyncResolve,
  online,
  timeSlotConfig,
  initialTab = "profilo",
}) => {
  const save = usePersistenceAction();
  const editBaseline = useRef(profile);
  const [activeTab, setActiveTab] = useState<"profilo" | "backup" | "google">(initialTab);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isImportingGoogle, setIsImportingGoogle] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ message: string; isError?: boolean } | null>(null);
  const [showSyncConfirm, setShowSyncConfirm] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [fullName, setFullName] = useState(profile.fullName);
  const [email, setEmail] = useState(profile.email || "");

  useEffect(() => {
    if (isOpen) {
      if (initialTab) {
        setActiveTab(initialTab);
      }
      setSyncStatus(null);
      setShowSyncConfirm(false);
      setShowLogoutConfirm(false);
      // Re-derive the dormant flag on every opening: an inactive saved secondary
      // must not resurrect the multi-school UI after a close/reopen cycle.
      setMultiSchoolEnabled(hasActiveSecondarySchool(profile));
      const secondary = (profile.schools ?? []).find(s => !s.isPrimary);
      if (secondary) setSecondarySchool(secondary);
      // Struttura giornaliera e campane sono ri-derivate a ogni apertura: dopo
      // un salvataggio/sync la modale non deve mostrare un draft stale. Per i
      // legacy si legge solo il fallback globale, senza modificarlo.
      const primary = primarySchoolOf(profile);
      const sourceConfig = timeSlotConfigForSchool(primary, timeSlotConfig);
      const draft = createTimeSlotConfigDraft(sourceConfig);
      setPrimaryDayPeriods(primary?.dayPeriods);
      setPrimaryTimeSlotDraft(draft);
      setPrimaryTimeSlotMode(timeSlotConfigEditorMode(sourceConfig));
      setPrimaryConfirmedSlotCount(draft.customSlots?.length ?? 0);
      setProfileRealignmentPrompt(null);
    }
  }, [isOpen, initialTab, profile, timeSlotConfig]);
  const [schoolName, setSchoolName] = useState(profile.schoolName);
  const [schoolLevel, setSchoolLevel] = useState<SchoolLevel>(profile.schoolLevel || "ssig");
  const [schoolYear, setSchoolYear] = useState(profile.schoolYear);
  const [weeklyDeclaredHours, setWeeklyDeclaredHours] = useState<number | undefined>(
    profile.weeklyDeclaredHours !== undefined ? profile.weeklyDeclaredHours : 18
  );
  const existingSecondary = (profile.schools ?? []).find(s => !s.isPrimary);
  // La struttura giornaliera appartiene alla SchoolProfile primaria: si legge dal
  // profilo normalizzato, cosi anche un profilo legacy senza schools[] parte dalla
  // primaria che normalizeTeacherProfile crea gia oggi.
  const [primaryDayPeriods, setPrimaryDayPeriods] = useState<SchoolDayPeriodsConfig | undefined>(
    () => primarySchoolOf(profile)?.dayPeriods
  );
  /**
   * Draft delle campane della primaria. Parte dalla sua config, o dal fallback
   * globale per i profili legacy, ma viene copiato nella scuola solo al Salva.
   */
  const [primaryTimeSlotDraft, setPrimaryTimeSlotDraft] = useState<TimeSlotConfig>(() =>
    createTimeSlotConfigDraft(timeSlotConfigForSchool(primarySchoolOf(profile), timeSlotConfig))
  );
  const [primaryTimeSlotMode, setPrimaryTimeSlotMode] = useState<TimeSlotConfigEditorMode>(() =>
    timeSlotConfigEditorMode(timeSlotConfigForSchool(primarySchoolOf(profile), timeSlotConfig))
  );
  const [primaryConfirmedSlotCount, setPrimaryConfirmedSlotCount] = useState(() =>
    createTimeSlotConfigDraft(timeSlotConfigForSchool(primarySchoolOf(profile), timeSlotConfig)).customSlots?.length ?? 0
  );
  const [profileRealignmentPrompt, setProfileRealignmentPrompt] = useState<{
    profile: TeacherProfile;
    count: number;
    provisional: TimetableSlot[];
    definitive: TimetableSlot[];
  } | null>(null);
  const [multiSchoolEnabled, setMultiSchoolEnabled] = useState(hasActiveSecondarySchool(profile));
  const [secondarySchool, setSecondarySchool] = useState<SchoolProfile>(existingSecondary ?? { id: `school-secondary-${profile.id}`, name: "", institutionalEmail: "", campuses: [], schoolLevel: profile.schoolLevel, weeklyHours: undefined, active: true, isPrimary: false });
  const [secondaryCampusInput, setSecondaryCampusInput] = useState("");
  const updateSecondary = (patch: Partial<SchoolProfile>) => setSecondarySchool(current => ({ ...current, ...patch }));
  const [primarySubjects, setPrimarySubjects] = useState<string[]>(profile.primarySubjects);
  const [classes, setClasses] = useState<string[]>(profile.classes);
  const [campuses, setCampuses] = useState<string[]>(profile.campuses);
  const [roles, setRoles] = useState<TeacherRole[]>(profile.roles || []);
  // Tipo docente canonico: un flag esplicito (anche false) vince; l'euristica
  // "sostegno" su primarySubjects vale solo per i profili legacy senza flag.
  const [isSupportTeacher, setIsSupportTeacher] = useState<boolean>(isSupportTeacherOf(profile));

  const [newSubjectInput, setNewSubjectInput] = useState("");
  const [newClassInput, setNewClassInput] = useState("");
  const [newCampusInput, setNewCampusInput] = useState("");

  const [newRoleType, setNewRoleType] = useState<TeacherRoleKind>("coordinatore");
  const [newRoleClass, setNewRoleClass] = useState("");
  const [newRoleDesc, setNewRoleDesc] = useState("");
  const [newRoleLabel, setNewRoleLabel] = useState("");

  const [importMessage, setImportMessage] = useState<string | null>(null);

  // ONE manual-sync controller shared by the header quick-sync button and the
  // CloudSync card: same pipeline (accountSync.syncNow), same double-trigger
  // guard, same transient feedback. No second sync engine is ever created here.
  const manualSync = useManualSync({ status: accountSyncStatus, onSyncNow });

  // L'editor primaria vede il SUO draft di campane in tempo reale; il secondo
  // istituto conserva per H8 lo scope corrente e usa ancora il proprio fallback.
  const primaryEffectiveTimeSlots = primaryTimeSlotDraft;
  const secondaryEffectiveTimeSlots = timeSlotConfigForSchool(secondarySchool, timeSlotConfig);
  const primaryDraftSchool = useMemo(() => {
    const primary = primarySchoolOf(profile);
    return primary ? { ...primary, dayPeriods: primaryDayPeriods } : undefined;
  }, [profile, primaryDayPeriods]);
  const primaryRequiredPeriods = maxPeriodsInWeek(
    DEFAULT_SCHOOL_DAYS,
    primaryDraftSchool,
    primaryTimeSlotDraft,
  );

  if (!isOpen) return null;

  // Add subject tag
  const handleAddSubject = () => {
    if (!newSubjectInput.trim()) return;
    if (!primarySubjects.includes(newSubjectInput.trim())) {
      setPrimarySubjects([...primarySubjects, newSubjectInput.trim()]);
    }
    setNewSubjectInput("");
  };

  const handleRemoveSubject = (s: string) => {
    setPrimarySubjects(primarySubjects.filter((item) => item !== s));
  };

  // Add class tag
  const handleAddClass = () => {
    if (!newClassInput.trim()) return;
    const clean = newClassInput.trim().toUpperCase();
    if (!classes.includes(clean)) {
      setClasses([...classes, clean]);
    }
    setNewClassInput("");
  };

  const handleRemoveClass = (c: string) => {
    setClasses(classes.filter((item) => item !== c));
  };

  // Add campus
  const handleAddCampus = () => {
    if (!newCampusInput.trim()) return;
    if (!campuses.includes(newCampusInput.trim())) {
      setCampuses([...campuses, newCampusInput.trim()]);
    }
    setNewCampusInput("");
  };

  const handleRemoveCampus = (c: string) => {
    setCampuses(campuses.filter((item) => item !== c));
  };

  // Add role (a role is stored only when explicitly chosen; nothing is ever auto-assigned)
  const handleAddRole = () => {
    const isCustom = newRoleType === "altro";
    if (isCustom && !newRoleLabel.trim()) return;
    if (!isCustom && !newRoleDesc.trim() && !newRoleClass.trim() && roles.some(r => r.role === newRoleType)) return;
    setRoles([
      ...roles,
      {
        role: newRoleType,
        targetClass: newRoleClass.trim().toUpperCase() || undefined,
        ...(isCustom ? { label: newRoleLabel.trim() } : {}),
        description: newRoleDesc.trim() || (isCustom ? newRoleLabel.trim() : ROLE_LABELS[newRoleType]),
      },
    ]);
    setNewRoleDesc("");
    setNewRoleClass("");
    setNewRoleLabel("");
  };

  const handleRemoveRole = (index: number) => {
    setRoles(roles.filter((_, i) => i !== index));
  };

  /**
   * Persistenza unica del Profilo: dayPeriods e timeSlotConfig sono già nello
   * stesso SchoolProfile. L'App può aggiungere al medesimo commit gli archivi
   * orario quando l'utente conferma il riallineamento.
   */
  const persistProfile = async (
    updatedProfile: TeacherProfile,
    realignment?: ProfileTimeSlotRealignment,
  ) => {
    if (!await save.run(() => onSaveProfile(updatedProfile, editBaseline.current, realignment))) return false;
    // Normalmente e []: il salvataggio Profilo crea la config school-specific
    // coerente. Il banner H7 resta una rete di sicurezza per dati esterni.
    onMissingTimeSlotCoverage?.(
      findMissingTimeSlotCoverage(updatedProfile, timeSlotConfig, DEFAULT_SCHOOL_DAYS)
    );
    setProfileRealignmentPrompt(null);
    onClose();
    return true;
  };

  // Save profile
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const updated: TeacherProfile = {
      ...profile,
      fullName: fullName.trim(),
      email: email.trim() || undefined,
      schoolName: schoolName.trim(),
      schoolLevel,
      schoolYear: schoolYear.trim(),
      weeklyDeclaredHours: weeklyDeclaredHours !== undefined ? weeklyDeclaredHours : undefined,
      primarySubjects,
      classes,
      campuses,
      roles,
      isSupportTeacher,
      // Students are managed in "Classi & Alunni", not in this editor: the existing
      // assignment is carried over verbatim so saving the profile never drops it.
      assignedStudents: profile.assignedStudents,
      schools: [
        ...(profile.schools ?? []).filter(s => s.isPrimary),
        ...(multiSchoolEnabled ? [{ ...secondarySchool, active: true, isPrimary: false, name: secondarySchool.name.trim(), institutionalEmail: secondarySchool.institutionalEmail?.trim() || undefined }] :
          (profile.schools ?? []).filter(s => !s.isPrimary).map(s => ({ ...s, active: false }))),
      ],
    };

    // La primaria può essere creata dalla normalizzazione dei profili legacy:
    // si assegnano poi INSIEME struttura giorno e campane alla primaria finale.
    const finalizedTimeSlots = finalizedTimeSlotConfigDraft(primaryTimeSlotDraft, primaryTimeSlotMode);
    const normalizedUpdated = withPrimaryTimeSlotConfig(
      withPrimaryDayPeriods(normalizeTeacherProfile(updated), primaryDayPeriods),
      finalizedTimeSlots,
    );
    const primary = primarySchoolOf(normalizedUpdated);
    const schools = normalizedUpdated.schools ?? [];
    const provisionalPlan = planTimeSlotRealignment(
      provisionalTimetable,
      primary,
      schools,
      finalizedTimeSlots,
    );
    const definitivePlan = planTimeSlotRealignment(
      definitiveTimetable,
      primary,
      schools,
      finalizedTimeSlots,
    );
    const count = provisionalPlan.affected.length + definitivePlan.affected.length;

    // Aggiungere solo la 7ª fascia non tocca 1ª–6ª e quindi non apre questa
    // conferma; modificare orari già in uso conserva invece la protezione del
    // drawer Orario, con la stessa scelta esplicita dell'utente.
    if (count > 0) {
      setProfileRealignmentPrompt({
        profile: normalizedUpdated,
        count,
        provisional: provisionalPlan.updated,
        definitive: definitivePlan.updated,
      });
      return;
    }

    await persistProfile(normalizedUpdated);
  };

  // Backup Export
  const handleExportBackup = async () => {
    let jsonStr: string;
    try { jsonStr = await storage.exportDataBackup(); }
    catch { setImportMessage("Esportazione non riuscita: impossibile leggere l’archivio locale. Nessun file parziale è stato scaricato."); return; }
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `backup_agenda_docente_${localDateISO()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Backup Import
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await save.run(async () => {
      const json = await file.text();
      setImportMessage(await restoreAndRefresh(json, value => storage.importDataBackup(value), onDataImported));
    });
  };

  // Header quick-sync presentation (the pipeline is the shared manualSync
  // controller: header icon and CloudSync card button are the same action).
  const onlineEffective = online ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const quickSyncing = manualSync.phase === "syncing";
  // Awaiting-resolution is never success: while the engine waits for an explicit
  // user choice (transient outcome or current phase) the header shows amber.
  const quickConflict =
    !quickSyncing &&
    (manualSync.outcome === "conflict" || manualSync.phase === "awaiting-resolution");
  const quickOffline =
    !quickSyncing &&
    !quickConflict &&
    manualSync.outcome !== "success" &&
    manualSync.outcome !== "error" &&
    (manualSync.phase === "offline" || manualSync.outcome === "offline" || !onlineEffective);
  const quickSyncTitle = quickSyncing
    ? "Sincronizzazione in corso…"
    : quickConflict
      ? "Sincronizzazione completata con conflitto da risolvere"
      : manualSync.outcome === "success"
        ? "Sincronizzazione completata"
        : manualSync.outcome === "error"
          ? "Sincronizzazione non riuscita. Riprova più tardi: i dati locali sono al sicuro."
          : quickOffline
            ? "Sei offline. I dati locali restano disponibili."
            : "Sincronizza ora";
  const quickSyncLive = quickSyncing
    ? "Sincronizzazione in corso"
    : quickConflict
      ? "Sincronizzazione richiede una risoluzione del conflitto"
      : manualSync.outcome === "success"
        ? "Sincronizzazione completata"
        : manualSync.outcome === "error"
          ? "Sincronizzazione non riuscita"
          : quickOffline
            ? "Sei offline. I dati locali restano disponibili."
            : "";

  return (
    <div className="app-modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/40 backdrop-blur-xs">
      <div role="dialog" aria-modal={true} aria-label="Configurazione Profilo Docente" className="app-modal-panel bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] shadow-2xl border border-stone-200 flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
        {save.error && <p role="alert" className="p-3 text-sm text-rose-700">{save.error}</p>}
        {/* Header: fixed block (never shrinks, above scrolled content). The title
            truncates inside min-w-0 while the actions keep their size, so the
            quick-sync and close buttons are always fully visible and tappable. */}
        <div className="shrink-0 relative z-10 p-3 sm:p-5 border-b border-stone-200 flex items-center justify-between bg-stone-50 gap-2 sm:gap-3">
          <div className="flex items-center space-x-2.5 sm:space-x-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-xl bg-emerald-700 text-white flex items-center justify-center shadow-xs shrink-0">
              <User className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-bold text-stone-900 truncate">Configurazione Profilo Docente</h2>
              <p className="hidden sm:block text-xs text-stone-500 truncate">
                La matrice di verità usata dall'AI per filtrare le circolari e organizzare l'orario
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {onOpenTutorial && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenTutorial();
                }}
                className="hidden sm:inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 text-xs font-semibold transition-colors"
                title="Riapri il tutorial guidato passo-passo"
              >
                <Compass className="w-4 h-4 text-emerald-700" />
                <span>Riavvia Tutorial</span>
              </button>
            )}
            {/* Quick sync: icon-only trigger of the SAME shared pipeline used by
                the CloudSync card button (same controller, same engine cycle). */}
            <span aria-live="polite" className="sr-only">{quickSyncLive}</span>
            <button
              type="button"
              onClick={manualSync.runSync}
              disabled={manualSync.disabled}
              aria-label="Sincronizza ora"
              title={quickSyncTitle}
              className="min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-xl text-stone-500 hover:text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {quickSyncing ? (
                <RefreshCw className="w-5 h-5 animate-spin" aria-hidden="true" />
              ) : quickConflict ? (
                <TriangleAlert className="w-5 h-5 text-amber-600" aria-hidden="true" />
              ) : manualSync.outcome === "success" ? (
                <Check className="w-5 h-5 text-emerald-600" aria-hidden="true" />
              ) : manualSync.outcome === "error" ? (
                <TriangleAlert className="w-5 h-5 text-rose-600" aria-hidden="true" />
              ) : quickOffline ? (
                <CloudOff className="w-5 h-5" aria-hidden="true" />
              ) : (
                <RefreshCw className="w-5 h-5" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Chiudi"
              title="Chiudi"
              className="min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-xl text-stone-400 hover:text-stone-700 hover:bg-stone-200/60 transition-colors"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Tabs: fixed block above the scrolled content. On phones the three tabs
            share one row with short labels (no scroll strip, nothing clipped);
            sm+ keeps the fuller desktop labels. */}
        <div role="tablist" aria-label="Sezioni profilo" className="shrink-0 relative z-10 grid grid-cols-3 sm:flex border-b border-stone-200 bg-stone-50/60 sm:px-5">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "profilo"}
            onClick={() => setActiveTab("profilo")}
            className={`min-h-[44px] py-2.5 px-2 sm:px-4 text-xs font-semibold border-b-2 transition-colors min-w-0 ${
              activeTab === "profilo"
                ? "border-emerald-700 text-emerald-800"
                : "border-transparent text-stone-600 hover:text-stone-900"
            }`}
          >
            <span className="flex items-center justify-center min-w-0">
              <span className="truncate">Profilo & Classi</span>
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "backup"}
            onClick={() => setActiveTab("backup")}
            className={`min-h-[44px] py-2.5 px-2 sm:px-4 text-xs font-semibold border-b-2 transition-colors min-w-0 ${
              activeTab === "backup"
                ? "border-emerald-700 text-emerald-800"
                : "border-transparent text-stone-600 hover:text-stone-900"
            }`}
          >
            <span className="flex items-center justify-center min-w-0">
              <span className="truncate">
                <span className="sm:hidden">Backup</span>
                <span className="hidden sm:inline">Backup & Ripristino</span>
              </span>
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "google"}
            onClick={() => setActiveTab("google")}
            className={`min-h-[44px] py-2.5 px-2 sm:px-4 text-xs font-semibold border-b-2 transition-colors min-w-0 ${
              activeTab === "google"
                ? "border-emerald-700 text-emerald-800"
                : "border-transparent text-stone-600 hover:text-stone-900"
            }`}
          >
            <span className="flex items-center justify-center gap-1.5 min-w-0">
              <span className="truncate">
                <span className="sm:hidden">Google & Sync</span>
                <span className="hidden sm:inline">Account Istituzionale & Google</span>
              </span>
              {googleUser && (
                <span className="w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-emerald-100 shrink-0" title="Account Google collegato" />
              )}
            </span>
          </button>
        </div>

        {/* Content: the ONLY scrollable area (vertical). min-h-0 lets it shrink
            inside the flex column; the bottom padding respects the home-indicator
            safe area on phones shaped as a bottom sheet. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-4 sm:px-5 sm:pt-5 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-[max(1.25rem,env(safe-area-inset-bottom))] text-xs momentum-scroll">
          {activeTab === "profilo" && (
            <form onSubmit={handleSave} className="space-y-4">
              {/* Tipo docente: curricolare | sostegno. Due opzioni mutuamente
                  esclusive (radiogroup), mobile-first (impilate su smartphone,
                  affiancate da sm); al salvataggio scrive SEMPRE un valore
                  esplicito di isSupportTeacher (niente più ratchet). */}
              <fieldset>
                <legend className="block font-semibold text-stone-700 mb-1.5">Tipo docente</legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" role="radiogroup" aria-label="Tipo docente">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!isSupportTeacher}
                    onClick={() => setIsSupportTeacher(false)}
                    className={`p-3.5 rounded-xl border-2 text-left transition-all min-h-[44px] ${
                      !isSupportTeacher
                        ? "border-emerald-600 bg-emerald-50/60"
                        : "border-stone-200 hover:border-emerald-300 bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-stone-900 text-xs sm:text-sm">Docente curricolare</span>
                      {!isSupportTeacher && <Check className="w-4 h-4 shrink-0 text-emerald-700" />}
                    </div>
                    <p className="text-[11px] text-stone-600 mt-1">
                      Insegna una materia: in compresenza puoi indicare il docente di sostegno presente nell'ora.
                    </p>
                  </button>

                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSupportTeacher}
                    onClick={() => setIsSupportTeacher(true)}
                    className={`p-3.5 rounded-xl border-2 text-left transition-all min-h-[44px] ${
                      isSupportTeacher
                        ? "border-emerald-600 bg-emerald-50/60"
                        : "border-stone-200 hover:border-emerald-300 bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-stone-900 text-xs sm:text-sm">Docente di sostegno</span>
                      {isSupportTeacher && <Check className="w-4 h-4 shrink-0 text-emerald-700" />}
                    </div>
                    <p className="text-[11px] text-stone-600 mt-1">
                      Insegna sostegno: in compresenza puoi indicare la materia curricolare e gli eventuali colleghi di sostegno presenti.
                    </p>
                  </button>
                </div>
              </fieldset>

              {/* Studenti seguiti: la gestione è nell'area "Classi & Alunni"; il profilo
                  docente non contiene più l'elenco studenti (i dati esistenti restano). */}

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Nome e Cognome *</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full p-2.5 border border-stone-300 rounded-xl text-xs"
                />
              </div>

              {/* Istituto Principale: identità della scuola di servizio del docente.
                  Raggruppa i dati d'istituto esistenti (nome, email, anno, sedi) sotto un
                  titolo univoco in vista del futuro supporto multi-istituto. */}
              <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50/50 space-y-3">
                <div className="flex items-center space-x-2">
                  <School className="w-4 h-4 text-emerald-700 shrink-0" />
                  <label className="block font-bold text-stone-800">Istituto Principale</label>
                </div>
                <p className="text-[11px] text-stone-600 leading-relaxed">
                  La scuola in cui presti servizio: nome, email istituzionale, anno scolastico e sedi usati dall'agenda per il filtro circolari e l'orario.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Istituto Scolastico</label>
                    <input
                      type="text"
                      value={schoolName}
                      onChange={(e) => setSchoolName(e.target.value)}
                      className="w-full p-2.5 border border-stone-300 rounded-xl text-xs"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Email Istituzionale</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="nome.cognome@scuola.edu.it"
                      className="w-full p-2.5 border border-stone-300 rounded-xl text-xs"
                    />
                  <div className="pt-1 space-y-2">
                    <label className="block font-semibold text-stone-700">Monte ore settimanale dichiarato</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={weeklyDeclaredHours !== undefined ? String(weeklyDeclaredHours) : ""}
                        onChange={(e) => setWeeklyDeclaredHours(e.target.value ? Number(e.target.value) : undefined)}
                        className="p-2 border border-stone-300 rounded-lg text-xs flex-1 min-w-[60px]"
                      />
                      <span className="text-[10px] text-stone-500">ore settimanali</span>
                    </div>
                    <p className="text-[10px] text-stone-500 mt-1">Default 18 ore per profili legacy. Modificabile in qualsiasi momento.</p>
                  </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block font-semibold text-stone-700">Anno Scolastico</label>
                    <span
                      className="text-[10px] text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded font-bold border border-emerald-200"
                      title="Calcolato automaticamente dal 1° agosto"
                    >
                      Auto: {getCurrentSchoolYear()}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={schoolYear}
                    onChange={(e) => setSchoolYear(e.target.value)}
                    placeholder={getCurrentSchoolYear()}
                    className="w-full p-2.5 border border-stone-300 rounded-xl text-xs font-mono font-medium"
                  />
                  <div className="flex items-center space-x-1.5 mt-1.5 flex-wrap gap-y-1">
                    <span className="text-[10px] text-stone-500 font-medium">Scelta rapida:</span>
                    {getSuggestedSchoolYears().map((yr) => (
                      <button
                        key={yr}
                        type="button"
                        onClick={() => setSchoolYear(yr)}
                        className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                          schoolYear === yr
                            ? "bg-emerald-700 text-white border-emerald-700 font-bold"
                            : "bg-white text-stone-600 border-stone-200 hover:bg-stone-100"
                        }`}
                      >
                        {yr} {yr === getCurrentSchoolYear() ? "(Corrente)" : ""}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-stone-500 mt-1.5 leading-relaxed">
                    💡 Dal 1° agosto in poi l'anno scolastico parte dall'anno in corso più il successivo (es. 28 agosto 2026 → <strong>2026/2027</strong>).
                  </p>
                </div>

                {/* Plessi e Sedi (dati della scuola di servizio) */}
                <div className="pt-1 space-y-2">
                  <label className="block font-bold text-stone-800">Plessi e Sedi</label>
                  <div className="flex flex-wrap gap-1.5">
                    {campuses.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium bg-stone-200 text-stone-800"
                      >
                        {c}
                        <button
                          type="button"
                          onClick={() => handleRemoveCampus(c)}
                          className="ml-1.5 text-stone-600 hover:text-stone-900"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center space-x-2">
                    <input
                      type="text"
                      value={newCampusInput}
                      onChange={(e) => setNewCampusInput(e.target.value)}
                      placeholder="es. Succursale Sud..."
                      className="p-1.5 border border-stone-300 rounded-lg text-xs w-44"
                    />
                    <button
                      type="button"
                      onClick={handleAddCampus}
                      className="px-3 py-1.5 bg-stone-700 text-white rounded-lg font-semibold hover:bg-stone-800 text-xs"
                    >
                      + Aggiungi Plesso
                    </button>
                  </div>
                </div>
              </div>

              {/* Struttura della giornata dell'ISTITUTO PRINCIPALE: quante ore prevede la
                  scuola, non quante ne lavora il docente (quelle restano il monte ore
                  dichiarato, qui sopra, e non entrano in questo calcolo). */}
              <SchoolDayPeriodsEditor
                context="istituto principale"
                value={primaryDayPeriods}
                timeSlotConfig={primaryEffectiveTimeSlots}
                onChange={setPrimaryDayPeriods}
              />

              {/* Stesso editor controllato del drawer Orario: mentre dayPeriods
                  cambia, requiredPeriods aggiorna soltanto il draft locale. */}
              <TimeSlotConfigEditor
                heading="Fasce orarie"
                context="istituto principale"
                config={primaryTimeSlotDraft}
                requiredPeriods={primaryRequiredPeriods}
                confirmedSlotCount={primaryConfirmedSlotCount}
                mode={primaryTimeSlotMode}
                onModeChange={setPrimaryTimeSlotMode}
                onChange={setPrimaryTimeSlotDraft}
                autoCompleteRequiredPeriods
              />

              <div className="rounded-xl border border-stone-200 bg-white p-3.5 space-y-3">
                <label className="flex items-center gap-2 text-xs font-semibold text-stone-700 cursor-pointer">
                  <input type="checkbox" checked={multiSchoolEnabled} onChange={e => setMultiSchoolEnabled(e.target.checked)} className="accent-emerald-700" />
                  Completo il mio orario anche in un altro istituto
                </label>
                {multiSchoolEnabled && <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 space-y-3">
                  <div className="flex items-center gap-2"><School className="w-4 h-4 text-emerald-700" /><strong className="text-sm text-stone-800">Altro istituto</strong></div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input aria-label="Nome altro istituto" value={secondarySchool.name} onChange={e => updateSecondary({ name: e.target.value })} placeholder="Nome istituto" className="p-2.5 border border-stone-300 rounded-xl text-xs" />
                    <input aria-label="Email altro istituto" type="email" value={secondarySchool.institutionalEmail ?? ""} onChange={e => updateSecondary({ institutionalEmail: e.target.value })} placeholder="Email istituzionale" className="p-2.5 border border-stone-300 rounded-xl text-xs" />
                    <input aria-label="Ore settimanali altro istituto" type="number" min="0" value={secondarySchool.weeklyHours ?? ""} onChange={e => updateSecondary({ weeklyHours: e.target.value ? Number(e.target.value) : undefined })} placeholder="Ore settimanali" className="p-2.5 border border-stone-300 rounded-xl text-xs" />
                    <div className="flex gap-2"><input aria-label="Plesso altro istituto" value={secondaryCampusInput} onChange={e => setSecondaryCampusInput(e.target.value)} placeholder="Plesso/Sede" className="min-w-0 flex-1 p-2.5 border border-stone-300 rounded-xl text-xs" /><button type="button" className="px-2 rounded-lg bg-stone-700 text-white text-xs" onClick={() => { const c = secondaryCampusInput.trim(); if (c && !(secondarySchool.campuses ?? []).includes(c)) updateSecondary({ campuses: [...(secondarySchool.campuses ?? []), c] }); setSecondaryCampusInput(""); }}>Aggiungi</button></div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">{(secondarySchool.campuses ?? []).map(c => <span key={c} className="text-[11px] rounded bg-stone-200 px-2 py-1">{c}</span>)}</div>
                  {/* Il secondo istituto ha la PROPRIA struttura giornaliera: puo avere
                      giorni piu lunghi o piu corti del principale. */}
                  <SchoolDayPeriodsEditor
                    context="altro istituto"
                    value={secondarySchool.dayPeriods}
                    timeSlotConfig={secondaryEffectiveTimeSlots}
                    onChange={next => updateSecondary({ dayPeriods: next })}
                  />
                  <p className="text-[11px] text-stone-500">I dati restano conservati anche se disattivi questa opzione.</p>
                </div>}
              </div>

              {/* Grado Scolastico di Appartenenza (SSIG, Primaria, SSIIG) */}
              <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50/70 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block font-bold text-stone-800 text-xs">
                    Grado Scolastico di Appartenenza *
                  </label>
                  <span className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md font-semibold">
                    Filtro Circolari Attivo
                  </span>
                </div>
                <p className="text-[11px] text-stone-600 leading-relaxed">
                  Imposta il grado della scuola in cui presti servizio. Gli impegni riferiti a questo grado (es. <strong>SSIG</strong> o <strong>Primaria</strong>) o a <strong>TUTTI i docenti</strong> verranno evidenziati in <strong className="text-emerald-700">VERDE</strong>, mentre quelli di altri ordini scolastici verranno esclusi in <strong className="text-rose-700">ROSSO</strong>.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                  {[
                    { id: "primaria", label: "Primaria", sub: "Scuola Primaria", badge: "PRIMARIA" },
                    { id: "ssig", label: "SSIG", sub: "Secondaria I Grado (Medie)", badge: "SSIG" },
                    { id: "ssiig", label: "SSIIG", sub: "Secondaria II Grado (Superiori)", badge: "SSIIG" },
                  ].map((lvl) => {
                    const isSelected = schoolLevel === lvl.id;
                    return (
                      <button
                        key={lvl.id}
                        type="button"
                        onClick={() => setSchoolLevel(lvl.id as SchoolLevel)}
                        className={`p-2.5 rounded-xl border text-left transition-all flex flex-col justify-between ${
                          isSelected
                            ? "border-emerald-600 bg-emerald-50/80 text-emerald-950 shadow-xs ring-1 ring-emerald-600"
                            : "border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:bg-stone-50"
                        }`}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="font-bold text-xs">{lvl.label}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold ${
                            isSelected ? "bg-emerald-200 text-emerald-900" : "bg-stone-100 text-stone-600"
                          }`}>
                            {lvl.badge}
                          </span>
                        </div>
                        <span className="text-[10px] text-stone-500 mt-1">{lvl.sub}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Classi Assegnate */}
              <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50/50 space-y-2">
                <label className="block font-bold text-stone-800">
                  Classi Assegnate (Fondamentale per il filtro circolare)
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {classes.map((c) => (
                    <span
                      key={c}
                      className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold bg-purple-100 text-purple-900 border border-purple-200"
                    >
                      {c}
                      <button
                        type="button"
                        onClick={() => handleRemoveClass(c)}
                        className="ml-1.5 text-purple-700 hover:text-purple-950"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex items-center space-x-2 pt-1">
                  <input
                    type="text"
                    value={newClassInput}
                    onChange={(e) => setNewClassInput(e.target.value)}
                    placeholder="es. 4D, 5B..."
                    className="p-1.5 border border-stone-300 rounded-lg text-xs w-32 uppercase"
                  />
                  <button
                    type="button"
                    onClick={handleAddClass}
                    className="px-3 py-1.5 bg-purple-700 text-white rounded-lg font-semibold hover:bg-purple-800 text-xs"
                  >
                    + Aggiungi Classe
                  </button>
                </div>
              </div>

              {/* Materie Insegnate */}
              <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50/50 space-y-2">
                <label className="block font-bold text-stone-800">Materie Insegnate</label>
                <div className="flex flex-wrap gap-1.5">
                  {primarySubjects.map((s) => (
                    <span
                      key={s}
                      className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-100 text-emerald-900 border border-emerald-200"
                    >
                      {s}
                      <button
                        type="button"
                        onClick={() => handleRemoveSubject(s)}
                        className="ml-1.5 text-emerald-700 hover:text-emerald-950"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex items-center space-x-2 pt-1">
                  <input
                    type="text"
                    value={newSubjectInput}
                    onChange={(e) => setNewSubjectInput(e.target.value)}
                    placeholder="es. Scienze naturali, Storia..."
                    className="p-1.5 border border-stone-300 rounded-lg text-xs w-48"
                  />
                  <button
                    type="button"
                    onClick={handleAddSubject}
                    className="px-3 py-1.5 bg-emerald-700 text-white rounded-lg font-semibold hover:bg-emerald-800 text-xs"
                  >
                    + Aggiungi Materia
                  </button>
                </div>
              </div>

              {/* Ruoli Speciali */}
              <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50/50 space-y-2">
                <label className="block font-bold text-stone-800">Ruoli Speciali (Coordinatore, Referente)</label>
                <div className="space-y-1.5">
                  {roles.map((r, i) => (
                    <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-white border border-stone-200">
                      <div>
                        <span className="font-bold text-stone-900 mr-2">{roleDisplayName(r)}</span>
                        <span className="text-stone-500">{r.role === "altro" ? "" : r.description !== ROLE_LABELS[r.role] ? r.description : ""}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveRole(i)}
                        className="text-stone-400 hover:text-rose-600 p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <select
                    value={newRoleType}
                    onChange={(e) => setNewRoleType(e.target.value as TeacherRoleKind)}
                    className="p-1.5 border border-stone-300 rounded-lg text-xs"
                    aria-label="Tipo di ruolo aggiuntivo"
                  >
                    {TEACHER_ROLE_KINDS.map(kind => (
                      <option key={kind} value={kind}>{ROLE_LABELS[kind]}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={newRoleClass}
                    onChange={(e) => setNewRoleClass(e.target.value.toUpperCase())}
                    placeholder="Classe (es. 2E)"
                    className="p-1.5 border border-stone-300 rounded-lg text-xs w-28 uppercase"
                  />
                  {newRoleType === "altro" && (
                    <input
                      type="text"
                      value={newRoleLabel}
                      onChange={(e) => setNewRoleLabel(e.target.value)}
                      placeholder="Nome del ruolo personalizzato"
                      className="p-1.5 border border-stone-300 rounded-lg text-xs flex-1 min-w-[140px]"
                      aria-label="Ruolo personalizzato"
                    />
                  )}
                  <input
                    type="text"
                    value={newRoleDesc}
                    onChange={(e) => setNewRoleDesc(e.target.value)}
                    placeholder="Descrizione ruolo"
                    className="p-1.5 border border-stone-300 rounded-lg text-xs flex-1 min-w-[140px]"
                  />
                  <button
                    type="button"
                    onClick={handleAddRole}
                    className="px-3 py-1.5 bg-stone-700 text-white rounded-lg font-semibold hover:bg-stone-800 text-xs"
                  >
                    + Aggiungi Ruolo
                  </button>
                </div>
              </div>

              <div className="flex justify-end pt-3">
                <button
                  type="submit" disabled={save.pending}
                  className="px-5 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-xl shadow-xs"
                >
                  Salva Modifiche Profilo
                </button>
              </div>
            </form>
          )}

          {activeTab === "backup" && (
            <div className="space-y-5">
              <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 space-y-2">
                <h3 className="font-bold text-stone-900 text-sm flex items-center">
                  <ShieldCheck className="w-4 h-4 text-emerald-700 mr-1.5" />
                  Salvataggio Dati & Privacy
                </h3>
                <p className="text-xs text-stone-600 leading-relaxed">
                  L'Agenda Docente è progettata secondo il principio <strong>local-first</strong>: tutti i tuoi dati,
                  l'orario, gli impegni e le circolari sono salvati in sicurezza nella memoria locale del tuo dispositivo.
                  Puoi esportare un file di backup in qualsiasi momento per trasferirlo su un altro dispositivo o conservarlo
                  come copia di sicurezza.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-5 rounded-xl border border-stone-200 bg-white space-y-3">
                  <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold">
                    <Download className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="font-bold text-stone-900 text-sm">Esporta Backup</h4>
                    <p className="text-xs text-stone-500 mt-0.5">
                      Scarica un file JSON contenente profilo, orario e tutti gli eventi registrati.
                    </p>
                  </div>
                  <button
                    onClick={handleExportBackup}
                    className="w-full py-2 px-3 bg-emerald-700 hover:bg-emerald-800 text-white font-semibold rounded-lg shadow-xs transition-colors"
                  >
                    Scarica File Backup (.json)
                  </button>
                </div>

                <div className="p-5 rounded-xl border border-stone-200 bg-white space-y-3">
                  <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center font-bold">
                    <Upload className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="font-bold text-stone-900 text-sm">Ripristina da Backup</h4>
                    <p className="text-xs text-stone-500 mt-0.5">
                      Carica un file JSON precedentemente esportato per ripristinare i dati.
                    </p>
                  </div>
                  <label className="block w-full py-2 px-3 bg-stone-100 hover:bg-stone-200 text-stone-800 font-semibold rounded-lg text-center cursor-pointer transition-colors">
                    <span>Scegli File JSON...</span>
                    <input type="file" disabled={save.pending} accept=".json" onChange={handleImportFile} className="hidden" />
                  </label>
                </div>
              </div>

              {importMessage && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center space-x-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>{importMessage}</span>
                </div>
              )}
            </div>
          )}

          {activeTab === "google" && (
            <div className="space-y-4">
              {/* Header Info */}
              <div className="p-4 rounded-xl bg-blue-50 border border-blue-200 space-y-2">
                <div className="flex items-center space-x-2 text-blue-900 font-bold text-sm">
                  <Calendar className="w-4 h-4 text-blue-700" />
                  <span>Accesso con Account Istituzionale & Google Calendar</span>
                </div>
                <p className="text-xs text-blue-800 leading-relaxed">
                  Accedi con il tuo account istituzionale (es. <strong>nome.cognome@scuola.edu.it</strong>) tramite 
                  l'autenticazione ufficiale Google Workspace. Ti permette di sincronizzare gli impegni dell'agenda
                  direttamente con il tuo Google Calendar scolastico nel pieno rispetto della privacy.
                </p>
              </div>

              {/* Status Alert if any */}
              {syncStatus && (
                <div
                  className={`p-3.5 rounded-xl border text-xs flex items-start space-x-2.5 ${
                    syncStatus.isError
                      ? "bg-rose-50 border-rose-200 text-rose-800"
                      : "bg-emerald-50 border-emerald-200 text-emerald-800"
                  }`}
                >
                  {syncStatus.isError ? (
                    <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 font-medium">{syncStatus.message}</div>
                  <button
                    type="button"
                    onClick={() => setSyncStatus(null)}
                    className="text-stone-400 hover:text-stone-600 ml-1"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Connected State vs Not Connected */}
              {!googleUser ? (
                <div className="p-5 rounded-2xl border border-stone-200 bg-white space-y-4">
                  <div className="flex items-start space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center font-bold flex-shrink-0">
                      <School className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="font-bold text-stone-900 text-sm">
                        Collega il tuo Account della Scuola
                      </h4>
                      <p className="text-xs text-stone-600 mt-1 leading-relaxed">
                        Effettua l'accesso una sola volta con il tuo indirizzo scolastico per sincronizzare le riunioni,
                        i consigli di classe, i GLO e le scadenze su Google Calendar.
                      </p>
                    </div>
                  </div>

                  <div className="pt-2 flex flex-col sm:flex-row items-center gap-3">
                    <GoogleSignInButton
                      onClick={async () => {
                        if (!onGoogleLogin) return;
                        try {
                          setIsLoggingIn(true);
                          setSyncStatus(null);
                          await onGoogleLogin();
                        } catch (err: unknown) {
                          if (!isUserCancellationError(err)) {
                            const errObj = err as { message?: string };
                            setSyncStatus({
                              message: errObj?.message || "Accesso non riuscito.",
                              isError: true,
                            });
                          }
                        } finally {
                          setIsLoggingIn(false);
                        }
                      }}
                      isLoading={isLoggingIn}
                      text="Accedi con account istituzionale Google"
                      className="w-full sm:w-auto"
                    />
                  </div>

                  <div className="bg-stone-50 rounded-xl p-3 border border-stone-200 text-[11px] text-stone-600 space-y-1">
                    <div className="font-semibold text-stone-700 flex items-center">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 mr-1" />
                      Sicurezza e Trasparenza
                    </div>
                    <p>
                      Nessuna password viene registrata nell'applicazione. Il token di accesso temporaneo è conservato solo in memoria durante la sessione attiva.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Account Card */}
                  <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/50 space-y-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center space-x-3">
                        {googleUser.photoURL ? (
                          <img
                            src={googleUser.photoURL}
                            alt={googleUser.displayName || "Docente"}
                            className="w-10 h-10 rounded-full border border-emerald-300 shadow-2xs"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-emerald-700 text-white font-bold flex items-center justify-center text-sm shadow-2xs">
                            {googleUser.displayName ? googleUser.displayName.charAt(0).toUpperCase() : "D"}
                          </div>
                        )}
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="font-bold text-stone-900 text-sm">
                              {googleUser.displayName || "Docente"}
                            </span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                              <Check className="w-3 h-3 mr-0.5 text-emerald-700" />
                              Collegato
                            </span>
                          </div>
                          <div className="text-xs text-stone-600 font-mono">
                            {googleUser.email}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setShowLogoutConfirm(true)}
                        className="inline-flex items-center space-x-1 px-3 py-1.5 rounded-lg border border-stone-200 bg-white text-stone-600 hover:text-rose-700 hover:border-rose-200 text-xs font-semibold transition-colors"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        <span>Disconnetti</span>
                      </button>
                    </div>

                    {/* Quick profile update button */}
                    {googleUser.email !== email && (
                      <div className="pt-2 border-t border-emerald-200/60 flex items-center justify-between text-xs">
                        <span className="text-emerald-900">
                          Usa questa email per le notifiche dell'agenda:
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (googleUser.email) setEmail(googleUser.email);
                            // "felice manganiello" from Google must display as "Felice Manganiello".
                            if (googleUser.displayName) setFullName(formatPersonDisplayName(googleUser.displayName));
                            setSyncStatus({
                              message: "Dati profilo aggiornati con l'account Google! Ricorda di salvare.",
                              isError: false,
                            });
                          }}
                          className="px-2.5 py-1 bg-white hover:bg-emerald-100 border border-emerald-300 text-emerald-800 font-bold rounded-lg text-[11px] transition-colors"
                        >
                          Aggiorna Profilo
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Disconnect Confirmation Modal / Alert */}
                  {showLogoutConfirm && (
                    <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 space-y-3 animate-fade-in">
                      <div className="flex items-start space-x-2 text-rose-900">
                        <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0 mt-0.5" />
                        <div>
                          <h5 className="font-bold text-xs">Conferma Disconnessione</h5>
                          <p className="text-xs text-rose-700 mt-0.5">
                            Vuoi disconnettere l'account Google istituzionale ({googleUser.email})?
                            Non potrai sincronizzare con Google Calendar finché non effettuerai nuovamente l'accesso.
                          </p>
                        </div>
                      </div>
                      <div className="flex justify-end space-x-2">
                        <button
                          type="button"
                          onClick={() => setShowLogoutConfirm(false)}
                          className="px-3 py-1.5 rounded-lg border border-stone-300 bg-white text-stone-700 text-xs font-semibold"
                        >
                          Annulla
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!onGoogleLogout) return;
                            try {
                              await onGoogleLogout();
                              setShowLogoutConfirm(false);
                              setSyncStatus({ message: "Account Google disconnesso.", isError: false });
                            } catch (err: any) {
                              setSyncStatus({ message: err?.message || "Errore disconnessione", isError: true });
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg bg-rose-700 hover:bg-rose-800 text-white text-xs font-bold shadow-xs"
                        >
                          Sì, Disconnetti
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Read-only primary-calendar download; deliberately separate from Firestore and outbound sync. */}
                  <div className="p-5 rounded-2xl border border-blue-200 bg-blue-50/40 space-y-3" data-google-calendar-import>
                    <div className="flex items-start space-x-3">
                      <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
                        <Download className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="font-bold text-stone-900 text-sm">Google Calendar → AgendaDocente</h4>
                        <p className="text-xs text-stone-600 mt-1 leading-relaxed">
                          Gli eventi creati sul tuo Google Calendar vengono aggiornati automaticamente in AgendaDocente quando l’app è attiva e autorizzata.
                        </p>
                      </div>
                    </div>
                    {googleAutoImportStatus === "needs-auth" && (
                      <div className="flex items-center justify-between gap-3 text-[11px] text-amber-800">
                        <span>Ricollega Google per riattivare l’aggiornamento automatico del Calendar.</span>
                        <button type="button" onClick={() => void onGoogleLogin?.()} className="shrink-0 underline font-bold">Ricollega Google</button>
                      </div>
                    )}
                    <p className={`text-xs font-semibold ${googleAutoImportStatus === "error" ? "text-amber-800" : "text-blue-800"}`}>
                      {googleAutoImportStatus === "syncing" ? "Aggiornamento in corso…" :
                       googleAutoImportStatus === "error" ? "Aggiornamento Google non riuscito. Riproveremo più tardi." :
                       googleAutoImportStatus === "success" ? "Aggiornamento automatico attivo" :
                       googleAutoImportStatus === "needs-auth" ? "Ricollega Google per aggiornare il Calendar" : "Aggiornamento automatico attivo"}
                      {lastImportResult && lastSuccessfulImportAt ? ` · Ultimo aggiornamento: ${new Date(lastSuccessfulImportAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} · ${lastImportResult.added} nuovo · ${lastImportResult.updated} aggiornati` : ""}
                    </p>
                    <button
                      type="button"
                      disabled={isImportingGoogle || !onImportFromGoogle}
                      onClick={async () => {
                        if (!onImportFromGoogle) return;
                        try {
                          setIsImportingGoogle(true);
                          setSyncStatus(null);
                          const result = await onImportFromGoogle();
                          setSyncStatus({
                            message: `Google Calendar aggiornato: ${result.added} nuovi · ${result.updated} aggiornati · ${result.linked} già collegati${result.partial ? " · importazione parziale (limite di sicurezza raggiunto)" : ""}`,
                            isError: false,
                          });
                        } catch (err: any) {
                          setSyncStatus({ message: err?.message || "Errore durante il download da Google Calendar.", isError: true });
                        } finally {
                          setIsImportingGoogle(false);
                        }
                      }}
                      className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:bg-stone-300 text-white text-xs font-bold transition-colors"
                    >
                      <RefreshCw className={`w-4 h-4 ${isImportingGoogle ? "animate-spin" : ""}`} />
                      <span>{isImportingGoogle ? "Aggiornamento…" : "Aggiorna ora"}</span>{/* Scaricamento…; in precedenza: Scarica eventi. Ora l’azione forza un aggiornamento. */}
                    </button>
                  </div>

                  <CloudSync
                    status={accountSyncStatus}
                    onSyncNow={onSyncNow}
                    onToggle={onSyncToggle}
                    onResolve={onSyncResolve}
                    online={online}
                    controller={manualSync}
                  />

                  {/* Google Calendar Sync Section */}
                  <div className="p-5 rounded-2xl border border-stone-200 bg-white space-y-4">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <CalendarCheck className="w-4 h-4 text-emerald-700" />
                          <h4 className="font-bold text-stone-900 text-sm">
                            AgendaDocente → Google Calendar
                          </h4>
                        </div>
                        <p className="text-xs text-stone-500">
                          Invia manualmente su Google Calendar solo gli impegni per cui hai scelto di attivare la condivisione/sincronizzazione.
                        </p>
                      </div>
                    </div>

                    <p className="text-xs font-semibold text-stone-700">
                      {events.filter(e => e.syncedWithGoogle === true && e.sourceType !== "google_calendar").length} impegni selezionati per Google Calendar
                    </p>

                    {/* Sync Confirmation Dialog (Mandatory User Confirmation) */}
                    {showSyncConfirm ? (
                      <div className="p-4 rounded-xl bg-blue-50 border border-blue-200 space-y-3">
                        <div className="flex items-start space-x-2 text-blue-950">
                          <Calendar className="w-5 h-5 text-blue-700 flex-shrink-0 mt-0.5" />
                          <div>
                            <h5 className="font-bold text-xs">Conferma Sincronizzazione Google Calendar</h5>
                            <p className="text-xs text-blue-800 mt-0.5 leading-relaxed">
                              Stai per esportare e sincronizzare <strong>{events.filter(e => e.syncedWithGoogle === true && e.sourceType !== "google_calendar").length} impegni con sincronizzazione abilitata</strong> sul tuo
                              Google Calendar associato all'account <strong>{googleUser.email}</strong>.
                              Vuoi procedere?
                            </p>
                          </div>
                        </div>
                        <div className="flex justify-end space-x-2 pt-1">
                          <button
                            type="button"
                            onClick={() => setShowSyncConfirm(false)}
                            className="px-3 py-1.5 rounded-lg border border-stone-300 bg-white text-stone-700 text-xs font-semibold"
                          >
                            Annulla
                          </button>
                          <button
                            type="button"
                            disabled={isSyncing}
                            onClick={async () => {
                              if (!onSyncAllToGoogle) return;
                              try {
                                setIsSyncing(true);
                                setShowSyncConfirm(false);
                                const res = await onSyncAllToGoogle();
                                setSyncStatus({
                                  message: `Operazione completata con successo: ${res.syncedCount} impegni sincronizzati su Google Calendar${
                                    res.errorCount > 0 ? ` (${res.errorCount} errori)` : ""
                                  }.`,
                                  isError: res.errorCount > 0 && res.syncedCount === 0,
                                });
                              } catch (err: any) {
                                setSyncStatus({
                                  message: err?.message || "Errore durante la sincronizzazione con Google Calendar.",
                                  isError: true,
                                });
                              } finally {
                                setIsSyncing(false);
                              }
                            }}
                            className="inline-flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold shadow-xs transition-colors"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Conferma e Sincronizza Ora</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="pt-1 flex flex-col sm:flex-row gap-2">
                        <button
                          type="button"
                          disabled={isSyncing || !events.some(e => e.syncedWithGoogle === true && e.sourceType !== "google_calendar")}
                          onClick={() => setShowSyncConfirm(true)}
                          className="flex-1 inline-flex items-center justify-center space-x-2 px-4 py-2.5 bg-emerald-700 hover:bg-emerald-800 disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-bold rounded-xl shadow-xs transition-colors cursor-pointer text-xs"
                        >
                          {isSyncing ? (
                            <>
                              <RefreshCw className="w-4 h-4 animate-spin" />
                              <span>Sincronizzazione in corso su Google Calendar...</span>
                            </>
                          ) : (
                            <>
                              <RefreshCw className="w-4 h-4" />
                              <span>Invia impegni selezionati a Google Calendar</span>
                            </>
                          )}
                        </button>
                        {!events.some(e => e.syncedWithGoogle === true && e.sourceType !== "google_calendar") && (
                          <p className="text-[11px] text-stone-500 sm:absolute sm:mt-12">Nessun impegno selezionato. Apri un impegno e abilita l’invio a Google Calendar.</p>
                        )}

                        <button
                          type="button"
                          disabled={events.length === 0}
                          onClick={() => {
                            downloadIcsCalendar(events);
                            setSyncStatus({
                              message:
                                "File agenda_docente.ics generato! Puoi importarlo in Google Calendar o Apple Calendar senza restrizioni.",
                              isError: false,
                            });
                          }}
                          className="inline-flex items-center justify-center space-x-1.5 px-4 py-2.5 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50 text-stone-700 font-semibold text-xs transition-colors shadow-2xs cursor-pointer"
                          title="Esporta tutti gli eventi in formato standard compatibile con tutti i calendari"
                        >
                          <Download className="w-4 h-4 text-emerald-700" />
                          <span>Esporta File .ICS</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Stessa protezione del drawer Orario, applicata al salvataggio unico
          Profilo: le fasce non vengono scritte finché l'utente non decide. */}
      {profileRealignmentPrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-stone-900/50 backdrop-blur-xs">
          <div id="profile-realign-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-realign-title" className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-5 shadow-xl space-y-4">
            <div>
              <h3 id="profile-realign-title" className="text-base font-bold text-stone-900">Aggiornare anche le lezioni?</h3>
              <p id="profile-realign-message" className="mt-1.5 text-xs leading-relaxed text-stone-600">
                {profileRealignmentPrompt.count === 1 ? "1 lezione ha" : `${profileRealignmentPrompt.count} lezioni hanno`} orari diversi dalle nuove fasce. Gli orari modificati a mano verranno sostituiti solo se scegli di aggiornarli.
              </p>
            </div>
            {save.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{save.error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                id="profile-realign-cancel"
                type="button"
                disabled={save.pending}
                onClick={() => setProfileRealignmentPrompt(null)}
                className="px-3 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg min-h-[42px]"
              >
                Annulla
              </button>
              <button
                id="profile-realign-config-only"
                type="button"
                disabled={save.pending}
                onClick={() => void persistProfile(profileRealignmentPrompt.profile)}
                className="px-3 py-2 text-xs font-semibold text-stone-700 border border-stone-300 hover:bg-stone-100 rounded-lg min-h-[42px]"
              >
                Salva solo le fasce
              </button>
              <button
                id="profile-realign-confirm"
                type="button"
                disabled={save.pending}
                onClick={() => void persistProfile(profileRealignmentPrompt.profile, {
                  provisional: profileRealignmentPrompt.provisional,
                  definitive: profileRealignmentPrompt.definitive,
                })}
                className="px-3 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg min-h-[42px]"
              >
                Salva e aggiorna
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
