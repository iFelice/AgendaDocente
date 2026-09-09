import { usePersistenceAction } from "../hooks/usePersistenceAction";
import React, { useState, useEffect } from "react";
import {
  School,
  User,
  BookOpen,
  Users,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  ShieldCheck,
  HeartHandshake,
  Check,
  Building2,
  Calendar,
  Zap,
  X,
} from "lucide-react";
import { SchoolLevel, TeacherProfile, TeacherRole, TEACHER_ROLE_KINDS } from "../types";
import { getCurrentSchoolYear, getSuggestedSchoolYears } from "../utils/schoolYear";
import { signInWithGoogle, isUserCancellationError } from "../services/googleAuth";
import { buildRolesFromChoices, ONBOARDING_ADDITIONAL_ROLES, ROLE_LABELS, roleDisplayName, type OnboardingRoleChoice } from "../utils/teacherRoles";
import { formatPersonDisplayName, isPlaceholderFullName } from "../utils/names";
import { CLASS_BOUND_ROLE_KINDS } from "../types";

interface OnboardingModalProps {
  isOpen: boolean;
  initialProfile: TeacherProfile;
  onFinish: (profile: TeacherProfile, openCircularScannerImmediately?: boolean) => void | false | Promise<void | false>;
  onClose: () => void;
  googleUser?: { displayName?: string | null; email?: string | null; photoURL?: string | null } | null;
  onGoogleLogin?: () => Promise<any>;
}

const COMMON_SUBJECTS = [
  "Attività di Sostegno",
  "Italiano e Storia",
  "Matematica e Fisica",
  "Lingua Inglese",
  "Scienze Naturali",
  "Arte e Immagine",
  "Scienze Motorie",
  "Informatica e Tecnologia",
  "Filosofia e Storia",
  "Diritto ed Economia",
];

const COMMON_CLASSES = ["1A", "1B", "2A", "2E", "3A", "3B", "4A", "5A", "5B"];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  initialProfile,
  onFinish,
  onClose,
  googleUser,
  onGoogleLogin,
}) => {
  const save = usePersistenceAction();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);

  // Form State
  const [fullName, setFullName] = useState(
    formatPersonDisplayName(googleUser?.displayName || (isPlaceholderFullName(initialProfile.fullName) ? "" : initialProfile.fullName))
  );
  const [email, setEmail] = useState(googleUser?.email || initialProfile.email || "");
  const [schoolName, setSchoolName] = useState(initialProfile.schoolName || "");
  const [schoolLevel, setSchoolLevel] = useState<SchoolLevel>(initialProfile.schoolLevel || "ssig");
  const [campus, setCampus] = useState(initialProfile.campuses[0] || "Sede Centrale");
  const currentCalculatedSchoolYear = getCurrentSchoolYear();
  const [schoolYear, setSchoolYear] = useState<string>(() => {
    if (initialProfile.schoolYear && initialProfile.schoolYear !== "2025/2026") {
      return initialProfile.schoolYear;
    }
    return currentCalculatedSchoolYear;
  });

  const [isSupportTeacher, setIsSupportTeacher] = useState(initialProfile.isSupportTeacher ?? false);
  // Additional roles come ONLY from explicit user choice; the support/curricular type never
  // auto-assigns anything (no implicit GLI, no automatic coordinatore).
  const [additionalRoles, setAdditionalRoles] = useState<OnboardingRoleChoice[]>(() =>
    (initialProfile.roles || [])
      .filter((r) => r.role !== "docente_sostegno")
      .map((r) => ({ role: r.role, ...(r.targetClass ? { targetClass: r.targetClass } : {}), ...(r.label ? { label: r.label } : {}) }))
  );
  const [customRoleLabel, setCustomRoleLabel] = useState("");
  const [primarySubjects, setPrimarySubjects] = useState<string[]>(
    initialProfile.primarySubjects.length > 0
      ? initialProfile.primarySubjects
      : []
  );
  const [newSubjectInput, setNewSubjectInput] = useState("");

  const [classes, setClasses] = useState<string[]>(initialProfile.classes.length > 0 ? initialProfile.classes : []);
  const [newClassInput, setNewClassInput] = useState("");

  // Google Login and connection state
  const [googleConnected, setGoogleConnected] = useState(
    Boolean(googleUser || initialProfile.googleCalendarLinked)
  );
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginSuccessMessage, setLoginSuccessMessage] = useState<string | null>(null);

  // Sync state if googleUser or initialProfile changes when opening
  useEffect(() => {
    if (isOpen) {
      if (googleUser?.email) {
        setEmail(googleUser.email);
        setGoogleConnected(true);
        if (googleUser.displayName) {
          // Never overwrite a real, already-set name; only fill placeholders — always title-cased.
          setFullName(prev => (isPlaceholderFullName(prev) ? formatPersonDisplayName(googleUser.displayName!) : prev));
        }
      } else if (initialProfile.email) {
        setEmail(initialProfile.email);
        setGoogleConnected(Boolean(initialProfile.googleCalendarLinked));
      }
      if (!schoolYear || schoolYear === "2025/2026") {
        setSchoolYear(
          initialProfile.schoolYear && initialProfile.schoolYear !== "2025/2026"
            ? initialProfile.schoolYear
            : getCurrentSchoolYear()
        );
      }
    }
  }, [
    isOpen,
    googleUser?.email,
    googleUser?.displayName,
    initialProfile.email,
    initialProfile.googleCalendarLinked,
    initialProfile.schoolYear,
  ]);

  if (!isOpen) return null;

  // Toggle subject
  const toggleSubject = (subject: string) => {
    if (primarySubjects.includes(subject)) {
      setPrimarySubjects(primarySubjects.filter((s) => s !== subject));
    } else {
      setPrimarySubjects([...primarySubjects, subject]);
    }
  };

  const handleAddCustomSubject = () => {
    if (!newSubjectInput.trim()) return;
    if (!primarySubjects.includes(newSubjectInput.trim())) {
      setPrimarySubjects([...primarySubjects, newSubjectInput.trim()]);
    }
    setNewSubjectInput("");
  };

  // Toggle class
  const toggleClass = (c: string) => {
    if (classes.includes(c)) {
      setClasses(classes.filter((item) => item !== c));
    } else {
      setClasses([...classes, c]);
    }
  };

  const handleRemoveClass = (c: string) => {
    setClasses(classes.filter((item) => item !== c));
  };

  const handleRemoveSubject = (sub: string) => {
    setPrimarySubjects(primarySubjects.filter((s) => s !== sub));
  };

  const handleAddCustomClass = () => {
    if (!newClassInput.trim()) return;
    const formatted = newClassInput.trim().toUpperCase();
    if (!classes.includes(formatted)) {
      setClasses([...classes, formatted]);
    }
    setNewClassInput("");
  };

  // Real Google Login with Account Chooser
  const handleRealGoogleLogin = async () => {
    setIsLoggingIn(true);
    setLoginError(null);
    setLoginSuccessMessage(null);

    try {
      const result = onGoogleLogin ? await onGoogleLogin() : await signInWithGoogle();
      if (result && result.user) {
        const userEmail = result.user.email || "";
        setEmail(userEmail);
        if (result.user.displayName) {
          setFullName(formatPersonDisplayName(result.user.displayName));
        }
        setGoogleConnected(true);
        setLoginSuccessMessage(`Account selezionato: ${userEmail}`);
        // Advance to step 2 after showing the selected account confirmation
        setTimeout(() => {
          setStep(2);
        }, 900);
      } else {
        // User closed the popup window without selecting an account.
        // Remain on step 1 without advancing!
      }
    } catch (err: unknown) {
      if (!isUserCancellationError(err)) {
        const msg = err instanceof Error ? err.message : "Accesso con Google non riuscito.";
        setLoginError(msg);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSkipLogin = () => {
    setGoogleConnected(false);
    setStep(2);
  };

  // Support Mode Quick Presets
  const setSupportRole = (support: boolean) => {
    setIsSupportTeacher(support);
    // Only pre-fills the subject suggestion when nothing was chosen yet; classes are never invented.
    if (support) setPrimarySubjects(prev => prev.length > 0 ? prev : ["Attività di Sostegno", "Sostegno Didattico"]);
  };

  // Additional-role toggling (explicit user choices only)
  const toggleAdditionalRole = (role: TeacherRole["role"]) => {
    setAdditionalRoles(prev => {
      const exists = prev.some(r => r.role === role);
      if (exists) return prev.filter(r => r.role !== role);
      return [...prev, { role }];
    });
  };
  const updateRoleClass = (role: TeacherRole["role"], targetClass: string) => {
    setAdditionalRoles(prev => prev.map(r => r.role === role ? { ...r, targetClass: targetClass.trim().toUpperCase() || undefined } : r));
  };
  const handleAddCustomRole = () => {
    const label = customRoleLabel.trim();
    if (!label) return;
    setAdditionalRoles(prev => prev.some(r => r.role === "altro" && r.label === label) ? prev : [...prev, { role: "altro", label }]);
    setCustomRoleLabel("");
  };
  const removeRoleChoice = (choice: OnboardingRoleChoice) => {
    setAdditionalRoles(prev => prev.filter(r => !(r.role === choice.role && (r.label || "") === (choice.label || ""))));
  };

  const buildProfile = (): TeacherProfile => {
    return {
      ...initialProfile,
      fullName: fullName.trim() || "Docente",
      email: email.trim() || undefined,
      schoolName: schoolName.trim(),
      schoolLevel,
      schoolYear: schoolYear.trim() || getCurrentSchoolYear(),
      primarySubjects,
      classes,
      campuses: campus.trim() ? [campus.trim()] : [],
      isSupportTeacher,
      googleCalendarLinked: googleConnected,
      // Roles derive exclusively from what the teacher selected in this wizard.
      roles: buildRolesFromChoices({ isSupportTeacher, additionalRoles }),
    };
  };

  const handleCompleteSetup = async (openScanner: boolean) => {
    const updatedProfile = buildProfile();
    if (!await save.run(() => onFinish(updatedProfile, openScanner))) return;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-2xl w-full shadow-2xl border border-stone-200 flex flex-col overflow-hidden my-auto animate-in fade-in zoom-in-95">
        {save.error && <p role="alert" className="p-3 text-sm text-rose-700">{save.error}</p>}
        {/* Header with Step indicator */}
        <div className="bg-emerald-800 text-white p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-lg bg-emerald-700/80 flex items-center justify-center font-bold">
                <School className="w-4 h-4 text-emerald-200" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-bold tracking-tight">
                  Configurazione Guidata & Tutorial
                </h2>
                <p className="text-xs text-emerald-200">
                  Passaggio {step} di 5:{" "}
                  {step === 1 && "Accesso Istituzionale"}
                  {step === 2 && "Dati Anagrafici & Scuola"}
                  {step === 3 && "Ruolo & Materie"}
                  {step === 4 && "Classi Assegnate"}
                  {step === 5 && "Pronto al Test!"}
                </p>
              </div>
            </div>

            <button
              onClick={onClose}
              className="text-xs px-2.5 py-1 rounded-md bg-emerald-700/60 hover:bg-emerald-700 text-emerald-100 transition-colors"
              title="Chiudi guida"
            >
              Chiudi
            </button>
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-emerald-900/60 h-1.5 rounded-full mt-4 overflow-hidden">
            <div
              className="bg-emerald-300 h-full transition-all duration-300 rounded-full"
              style={{ width: `${(step / 5) * 100}%` }}
            />
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5 sm:p-6 space-y-5 text-stone-800 max-h-[70vh] overflow-y-auto">
          {/* STEP 1: LOGIN ISTITUZIONALE O SALTA */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="text-center space-y-1.5 py-2">
                <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-700 mx-auto flex items-center justify-center border border-emerald-200 shadow-xs">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <h3 className="text-base sm:text-lg font-bold text-stone-900">
                  Benvenuto nella tua nuova Agenda Docente
                </h3>
                <p className="text-xs text-stone-500 max-w-md mx-auto">
                  L'agenda scolastica offline-first, pensata per gestire lezioni, scadenze PEI/GLO e
                  analizzare istantaneamente le circolari con semaforo di pertinenza.
                </p>
              </div>

              {/* Box Login Istituzionale */}
              <div className="p-4 rounded-xl border-2 border-emerald-500/30 bg-emerald-50/40 space-y-3">
                <div className="flex items-center space-x-2 text-emerald-950 font-bold text-xs sm:text-sm">
                  <Building2 className="w-4 h-4 text-emerald-700 shrink-0" />
                  <span>Accedi con l'account della tua scuola (@scuola.edu.it / Workspace)</span>
                </div>
                <p className="text-xs text-emerald-900 leading-relaxed">
                  Collega il tuo indirizzo email o account Google Workspace per sincronizzare il calendario istituzionale e gli impegni.
                </p>

                {loginSuccessMessage && (
                  <div className="p-2.5 bg-emerald-100 border border-emerald-300 rounded-lg flex items-center space-x-2 text-xs text-emerald-900 font-semibold animate-pulse">
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                    <span>{loginSuccessMessage} - passaggio al prossimo step...</span>
                  </div>
                )}

                {googleConnected && !loginSuccessMessage && (
                  <div className="p-2.5 bg-emerald-100/80 border border-emerald-300 rounded-lg flex items-center space-x-2 text-xs text-emerald-900 font-medium">
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                    <span>
                      Account Google collegato: <strong>{email}</strong>
                    </span>
                  </div>
                )}

                {loginError && (
                  <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700 leading-relaxed">
                    {loginError}
                  </div>
                )}

                <div className="space-y-2 pt-1">
                  <label className="block text-xs font-semibold text-stone-700">
                    Indirizzo Email Istituzionale
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="es. nome.cognome@scuola.edu.it"
                    className="w-full p-2.5 border border-stone-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600"
                  />
                </div>

                <div className="flex flex-col gap-2 pt-1">
                  <button
                    type="button"
                    id="btn-onboarding-google-login"
                    disabled={isLoggingIn}
                    onClick={handleRealGoogleLogin}
                    className="flex-1 py-2.5 px-3 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white font-semibold text-xs transition-colors flex items-center justify-center space-x-2 shadow-xs cursor-pointer"
                  >
                    {isLoggingIn ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Apertura selezione account...</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                          <path
                            fill="currentColor"
                            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                          />
                          <path
                            fill="currentColor"
                            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                          />
                          <path
                            fill="currentColor"
                            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                          />
                          <path
                            fill="currentColor"
                            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                          />
                        </svg>
                        <span>
                          {googleConnected
                            ? "Seleziona / Cambia Account Google"
                            : "Accedi con Google Istituzionale"}
                        </span>
                      </>
                    )}
                  </button>

                </div>
              </div>

              {/* Tasto Salta */}
              <div className="pt-2 flex flex-col items-center">
                <button
                  type="button"
                  onClick={handleSkipLogin}
                  className="text-xs text-stone-500 hover:text-stone-800 font-medium underline underline-offset-4 py-1"
                >
                  Salta questo passaggio (Continua offline / Configura manualmente)
                </button>
                <span className="text-[11px] text-stone-400 mt-1">
                  Non è richiesta alcuna registrazione per usare l'applicazione
                </span>
              </div>
            </div>
          )}

          {/* STEP 2: DATI ANAGRAFICI & SCUOLA */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-bold text-stone-900">Dati Anagrafici e Istituto</h3>
                <p className="text-xs text-stone-500">
                  Inserisci le informazioni base utilizzate per intestare l'orario e le scadenze.
                </p>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Nome e Cognome *
                  </label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="es. Prof. Andrea Conti"
                    className="w-full p-2.5 border border-stone-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-emerald-600"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Nome Istituto Scolastico *
                  </label>
                  <input
                    type="text"
                    value={schoolName}
                    onChange={(e) => setSchoolName(e.target.value)}
                    placeholder="es. Istituto Superiore 'G. Galilei'"
                    className="w-full p-2.5 border border-stone-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-emerald-600"
                  />
                  {/* Quick School Chips */}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {[
                      "Liceo Scientifico 'G. Galilei'",
                      "I.I.S. 'Leonardo da Vinci'",
                      "I.C. 'Dante Alighieri'",
                      "Istituto Tecnico 'E. Fermi'",
                    ].map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSchoolName(s)}
                        className="text-[10px] px-2 py-0.5 rounded-md bg-stone-100 hover:bg-emerald-50 hover:text-emerald-800 text-stone-600 border border-stone-200"
                      >
                        + {s}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Grado Scolastico di Appartenenza */}
                <div className="p-3 rounded-xl border border-stone-200 bg-stone-50/70 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-bold text-stone-800">
                      Grado Scolastico di Appartenenza *
                    </label>
                    <span className="text-[10px] text-emerald-800 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded font-medium">
                      Filtro Circolari
                    </span>
                  </div>
                  <p className="text-[11px] text-stone-500">
                    Gli impegni scolastici rivolti al tuo grado (es. <strong>SSIG</strong>) o a <strong>TUTTI i docenti</strong> verranno evidenziati in verde nell'archivio circolari.
                  </p>
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    {[
                      { id: "primaria", label: "Primaria", sub: "Scuola Primaria" },
                      { id: "ssig", label: "SSIG", sub: "Secondaria I Grado" },
                      { id: "ssiig", label: "SSIIG", sub: "Secondaria II Grado" },
                    ].map((lvl) => {
                      const isSelected = schoolLevel === lvl.id;
                      return (
                        <button
                          key={lvl.id}
                          type="button"
                          onClick={() => setSchoolLevel(lvl.id as SchoolLevel)}
                          className={`p-2 rounded-xl border text-center transition-all ${
                            isSelected
                              ? "border-emerald-600 bg-emerald-50 text-emerald-950 font-bold shadow-xs ring-1 ring-emerald-600"
                              : "border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50"
                          }`}
                        >
                          <div className="text-xs font-bold">{lvl.label}</div>
                          <div className="text-[10px] text-stone-500 mt-0.5">{lvl.sub}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Plesso / Sede
                    </label>
                    <input
                      type="text"
                      value={campus}
                      onChange={(e) => setCampus(e.target.value)}
                      placeholder="es. Sede Centrale"
                      className="w-full p-2.5 border border-stone-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-semibold text-stone-700">
                        Anno Scolastico
                      </label>
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
                      className="w-full p-2.5 border border-stone-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-emerald-600 font-mono font-medium"
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
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: RUOLO & MATERIE */}
          {step === 3 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-bold text-stone-900">Ruolo Docente & Materie</h3>
                <p className="text-xs text-stone-500">
                  Indica se svolgi attività su posto comune (curricolare) o su posto di sostegno.
                </p>
              </div>

              {/* Ruolo Switch Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div
                  onClick={() => setSupportRole(true)}
                  className={`p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                    isSupportTeacher
                      ? "border-emerald-600 bg-emerald-50/60 shadow-xs"
                      : "border-stone-200 hover:border-emerald-300 bg-white"
                  }`}
                >
                  <div className="flex items-center space-x-2 text-emerald-900 font-bold text-xs sm:text-sm">
                    <HeartHandshake className="w-4 h-4 text-emerald-700" />
                    <span>Docente di Sostegno</span>
                  </div>
                  <p className="text-[11px] text-stone-600 mt-1">
                    Priorità semantica automatica per convocazioni GLO, scadenze PEI/PDP,
                    dipartimento inclusione e ore di compresenza/individualizzate.
                  </p>
                  {isSupportTeacher && (
                    <span className="inline-flex items-center text-[10px] font-bold text-emerald-700 mt-2">
                      <Check className="w-3 h-3 mr-1" /> Selezionato
                    </span>
                  )}
                </div>

                <div
                  onClick={() => setSupportRole(false)}
                  className={`p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                    !isSupportTeacher
                      ? "border-emerald-600 bg-emerald-50/60 shadow-xs"
                      : "border-stone-200 hover:border-emerald-300 bg-white"
                  }`}
                >
                  <div className="flex items-center space-x-2 text-stone-900 font-bold text-xs sm:text-sm">
                    <BookOpen className="w-4 h-4 text-stone-700" />
                    <span>Docente Curricolare</span>
                  </div>
                  <p className="text-[11px] text-stone-600 mt-1">
                    Focalizzato su materie disciplinari, consigli di classe, ricevimento famiglie e
                    collegi docenti.
                  </p>
                  {!isSupportTeacher && (
                    <span className="inline-flex items-center text-[10px] font-bold text-emerald-700 mt-2">
                      <Check className="w-3 h-3 mr-1" /> Selezionato
                    </span>
                  )}
                </div>
              </div>

              {/* RUOLI AGGIUNTIVI: scelti esclusivamente dal docente, mai dedotti dal tipo di cattedra */}
              <div className="space-y-2 pt-1">
                <label className="block text-xs font-semibold text-stone-700">
                  Ruoli aggiuntivi (facoltativi)
                </label>
                <p className="text-[11px] text-stone-500">
                  Seleziona solo i ruoli effettivamente ricoperti quest'anno. Essere docente di sostegno o curricolare
                  non implica automaticamente altri incarichi.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {ONBOARDING_ADDITIONAL_ROLES.map((kind) => {
                    const isSelected = additionalRoles.some((r) => r.role === kind);
                    return (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => toggleAdditionalRole(kind)}
                        className={`text-xs px-2.5 py-1 rounded-lg border font-medium transition-all ${
                          isSelected
                            ? "bg-emerald-700 text-white border-emerald-700 shadow-xs"
                            : "bg-white text-stone-700 border-stone-200 hover:border-emerald-400"
                        }`}
                      >
                        {isSelected ? `✓ ${ROLE_LABELS[kind]}` : `+ ${ROLE_LABELS[kind]}`}
                      </button>
                    );
                  })}
                </div>

                {/* Classi legate ai ruoli selezionati */}
                {additionalRoles.filter((r) => CLASS_BOUND_ROLE_KINDS.includes(r.role)).map((r) => (
                  <div key={`cls-${r.role}`} className="flex items-center gap-2 text-xs">
                    <span className="text-stone-600 shrink-0">Classe per {ROLE_LABELS[r.role]}:</span>
                    <input
                      type="text"
                      value={r.targetClass || ""}
                      onChange={(e) => updateRoleClass(r.role, e.target.value)}
                      placeholder="es. 2E"
                      className="w-24 p-1.5 border border-stone-300 rounded-lg bg-white uppercase"
                      aria-label={`Classe ${ROLE_LABELS[r.role]}`}
                    />
                  </div>
                ))}

                {/* Custom role */}
                <div className="flex items-center space-x-2 pt-1">
                  <input
                    type="text"
                    value={customRoleLabel}
                    onChange={(e) => setCustomRoleLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddCustomRole();
                      }
                    }}
                    placeholder="Altro ruolo personalizzato (es. Referente Erasmus)..."
                    className="flex-1 p-2 border border-stone-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomRole}
                    className="px-3.5 py-2 bg-stone-800 hover:bg-stone-900 text-white rounded-lg text-xs font-semibold shadow-xs"
                  >
                    + Aggiungi
                  </button>
                </div>

                {additionalRoles.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {additionalRoles.map((r, i) => (
                      <span
                        key={`${r.role}-${r.label || i}`}
                        className="inline-flex items-center pl-2.5 pr-1.5 py-1 rounded-lg bg-emerald-100 text-emerald-950 text-xs font-medium border border-emerald-300 shadow-2xs"
                      >
                        <span>{roleDisplayName({ role: r.role, targetClass: r.targetClass, label: r.label })}</span>
                        <button
                          type="button"
                          onClick={() => removeRoleChoice(r)}
                          className="ml-1.5 p-0.5 rounded-md text-emerald-700 hover:text-rose-700 hover:bg-rose-100 transition-colors"
                          aria-label={`Rimuovi ruolo ${ROLE_LABELS[r.role]}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Materie Selection */}
              <div className="space-y-2 pt-2">
                <label className="block text-xs font-semibold text-stone-700">
                  Materie Insegnate (fai clic per selezionare / deselezionare):
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {COMMON_SUBJECTS.map((sub) => {
                    const isSelected = primarySubjects.includes(sub);
                    return (
                      <button
                        key={sub}
                        type="button"
                        onClick={() => toggleSubject(sub)}
                        className={`text-xs px-2.5 py-1 rounded-lg border font-medium transition-all ${
                          isSelected
                            ? "bg-emerald-700 text-white border-emerald-700 shadow-xs"
                            : "bg-white text-stone-700 border-stone-200 hover:border-emerald-400"
                        }`}
                      >
                        {isSelected ? `✓ ${sub}` : `+ ${sub}`}
                      </button>
                    );
                  })}
                </div>

                {/* Custom Subject Input */}
                <div className="flex items-center space-x-2 pt-2">
                  <input
                    type="text"
                    value={newSubjectInput}
                    onChange={(e) => setNewSubjectInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddCustomSubject();
                      }
                    }}
                    placeholder="Altra materia (es. Chimica dei Materiali)..."
                    className="flex-1 p-2 border border-stone-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomSubject}
                    className="px-3.5 py-2 bg-stone-800 hover:bg-stone-900 text-white rounded-lg text-xs font-semibold shadow-xs"
                  >
                    + Aggiungi
                  </button>
                </div>

                {/* Materie attualmente selezionate con pulsante di rimozione */}
                <div className="pt-2 border-t border-stone-200/70">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-stone-800">
                      Materie selezionate ({primarySubjects.length}):
                    </span>
                    {primarySubjects.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setPrimarySubjects([])}
                        className="text-[11px] text-rose-600 hover:text-rose-800 font-medium underline"
                      >
                        Rimuovi tutte
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {primarySubjects.map((sub) => (
                      <span
                        key={sub}
                        className="inline-flex items-center pl-2.5 pr-1.5 py-1 rounded-lg bg-emerald-100 text-emerald-950 text-xs font-medium border border-emerald-300 shadow-2xs group hover:border-emerald-400"
                      >
                        <span>{sub}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveSubject(sub)}
                          className="ml-1.5 p-0.5 rounded-md text-emerald-700 hover:text-rose-700 hover:bg-rose-100 transition-colors"
                          title={`Rimuovi materia ${sub}`}
                          aria-label={`Rimuovi materia ${sub}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ))}
                    {primarySubjects.length === 0 && (
                      <span className="text-xs text-rose-600 font-medium italic">
                        Nessuna materia selezionata
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: LE TUE CLASSI */}
          {step === 4 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-bold text-stone-900">Le Tue Classi Assegnate</h3>
                <p className="text-xs text-stone-500">
                  Indica le classi in cui insegni quest'anno.
                </p>
              </div>

              {/* Explanation Callout */}
              <div className="p-3.5 rounded-xl border border-amber-200 bg-amber-50/70 text-xs text-amber-900 space-y-1">
                <div className="flex items-center space-x-1.5 font-bold">
                  <Sparkles className="w-4 h-4 text-amber-600 flex-shrink-0" />
                  <span>Perché questo passaggio è fondamentale per l'AI?</span>
                </div>
                <p className="text-[11px] text-amber-800 leading-relaxed">
                  Quando caricherai una circolare chilometrica (es. 20 pagine di convocazioni consigli
                  o scrutini), l'intelligenza semantica verificherà queste classi. Ti assegnerà il
                  semaforo <strong>VERDE</strong> solo per gli impegni che ti riguardano, evitando di
                  farti perdere tempo con circolari irrilevanti.
                </p>
              </div>

              {/* Quick Class Chips */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-stone-700">
                  Seleziona le tue classi:
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {COMMON_CLASSES.map((c) => {
                    const isSelected = classes.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => toggleClass(c)}
                        className={`text-xs px-3 py-1.5 rounded-lg border font-bold transition-all ${
                          isSelected
                            ? "bg-emerald-700 text-white border-emerald-700 shadow-xs"
                            : "bg-white text-stone-700 border-stone-200 hover:border-emerald-400"
                        }`}
                      >
                        {isSelected ? `✓ ${c}` : c}
                      </button>
                    );
                  })}
                </div>

                {/* Custom Class Input */}
                <div className="flex items-center space-x-2 pt-2">
                  <input
                    type="text"
                    value={newClassInput}
                    onChange={(e) => setNewClassInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddCustomClass();
                      }
                    }}
                    placeholder="Aggiungi classe (es. 4F, 2B, 1C)..."
                    className="flex-1 p-2 border border-stone-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600 uppercase"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomClass}
                    className="px-3.5 py-2 bg-stone-800 hover:bg-stone-900 text-white rounded-lg text-xs font-semibold shadow-xs"
                  >
                    + Aggiungi
                  </button>
                </div>

                {/* Current Selected Classes Summary with Remove Buttons */}
                <div className="pt-3 border-t border-stone-200">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-stone-800">
                      Classi attualmente selezionate ({classes.length}):
                    </span>
                    {classes.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setClasses([])}
                        className="text-[11px] text-rose-600 hover:text-rose-800 font-medium underline transition-colors"
                      >
                        Rimuovi tutte
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5 items-center">
                    {classes.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center pl-2.5 pr-1.5 py-1 rounded-lg bg-emerald-100 text-emerald-950 text-xs font-bold border border-emerald-300 shadow-2xs group hover:border-emerald-400 transition-colors"
                      >
                        <span>{c}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveClass(c)}
                          className="ml-1.5 p-0.5 rounded-md text-emerald-700 hover:text-rose-700 hover:bg-rose-100 transition-colors"
                          title={`Rimuovi classe ${c}`}
                          aria-label={`Rimuovi classe ${c}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ))}
                    {classes.length === 0 && (
                      <span className="text-xs text-rose-600 font-medium italic">
                        Nessuna classe selezionata. Fai clic su una classe dai suggerimenti in alto o aggiungila con il campo qui sopra.
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-stone-500 mt-2">
                    💡 <strong>Consiglio:</strong> Se hai inserito o selezionato una classe per sbaglio, fai clic sulla <strong>✕</strong> per rimuoverla istantaneamente.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: PROVA PRATICA & TUTORIAL FINALE */}
          {step === 5 && (
            <div className="space-y-4">
              <div className="text-center space-y-1">
                <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-800 mx-auto flex items-center justify-center font-bold">
                  <CheckCircle2 className="w-6 h-6 text-emerald-700" />
                </div>
                <h3 className="text-base font-bold text-stone-900">Configurazione Completata!</h3>
                <p className="text-xs text-stone-500">
                  Ecco il riepilogo del tuo profilo docente:
                </p>
              </div>

              {/* Profile Summary Card */}
              <div className="p-3.5 rounded-xl border border-stone-200 bg-stone-50/80 space-y-2 text-xs">
                <div className="flex items-center justify-between border-b border-stone-200 pb-2">
                  <span className="text-stone-500">Docente:</span>
                  <span className="font-bold text-stone-900">{fullName}</span>
                </div>
                <div className="flex items-center justify-between border-b border-stone-200 pb-2">
                  <span className="text-stone-500">Scuola / Plesso:</span>
                  <span className="font-semibold text-stone-800">
                    {schoolName} ({campus})
                  </span>
                </div>
                <div className="flex items-center justify-between border-b border-stone-200 pb-2">
                  <span className="text-stone-500">Anno Scolastico:</span>
                  <span className="font-bold text-emerald-900 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                    {schoolYear}
                  </span>
                </div>
                <div className="flex items-center justify-between border-b border-stone-200 pb-2">
                  <span className="text-stone-500">Profilo Operativo:</span>
                  <span className="font-semibold text-emerald-800 text-right">
                    {isSupportTeacher ? "Docente di Sostegno" : "Docente Curricolare"}
                    {additionalRoles.length > 0 && (
                      <span className="block text-[11px] font-medium text-stone-600 mt-0.5">
                        {additionalRoles.map((r) => roleDisplayName({ role: r.role, targetClass: r.targetClass, label: r.label })).join(", ")}
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between border-b border-stone-200 pb-2">
                  <span className="text-stone-500">Materie:</span>
                  <span className="font-medium text-stone-800">
                    {primarySubjects.slice(0, 2).join(", ")}
                    {primarySubjects.length > 2 ? ` (+${primarySubjects.length - 2})` : ""}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-stone-500">Classi Monitorate:</span>
                  <div className="flex flex-wrap gap-1 items-center justify-end max-w-[70%]">
                    {classes.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center pl-1.5 pr-1 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold text-[11px] border border-emerald-200"
                      >
                        <span>{c}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveClass(c)}
                          className="ml-1 p-0.5 rounded text-emerald-700 hover:text-rose-700 hover:bg-rose-100 transition-colors"
                          title={`Rimuovi classe ${c}`}
                          aria-label={`Rimuovi classe ${c}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    {classes.length === 0 && (
                      <span className="text-[11px] text-rose-500 font-medium italic">Nessuna classe</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setStep(4)}
                      className="text-[11px] text-emerald-700 hover:text-emerald-900 underline font-semibold ml-1"
                    >
                      Modifica
                    </button>
                  </div>
                </div>
              </div>

              {/* Real first-circular CTA: no demo document exists or is faked. */}
              <div className="p-4 rounded-xl border-2 border-amber-300 bg-amber-50/80 space-y-2.5">
                <div className="flex items-center space-x-2 text-amber-900 font-bold text-xs sm:text-sm">
                  <Sparkles className="w-4 h-4 text-amber-600 flex-shrink-0" />
                  <span>Hai già una circolare da importare?</span>
                </div>
                <p className="text-xs text-amber-800 leading-relaxed">
                  Al termine della configurazione si apre l'Analizzatore Circolari: carica il PDF della tua scuola, scatta una foto o incolla il testo e vedrai il semaforo di pertinenza in azione. Nessun documento di esempio viene inventato.
                </p>

                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => handleCompleteSetup(true)}
                    className="w-full py-2.5 px-4 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs transition-colors flex items-center justify-center space-x-2 shadow-xs"
                  >
                    <Sparkles className="w-4 h-4" />
                    <span>Configura e apri l'Analizzatore Circolari</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Navigation Buttons */}
        <div className="p-4 sm:p-5 border-t border-stone-200 bg-stone-50 flex items-center justify-between">
          <div>
            {step > 1 ? (
              <button
                type="button"
                onClick={() => setStep((s) => (s - 1) as any)}
                className="inline-flex items-center px-3 py-2 rounded-lg text-xs font-semibold text-stone-600 hover:text-stone-900 hover:bg-stone-200 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5 mr-1" />
                Indietro
              </button>
            ) : (
              <span className="text-xs text-stone-400">Inizio setup</span>
            )}
          </div>

          <div>
            {step < 5 ? (
              <button
                type="button"
                onClick={() => setStep((s) => (s + 1) as any)}
                className="inline-flex items-center px-4 py-2 rounded-lg text-xs font-bold bg-emerald-700 hover:bg-emerald-800 text-white transition-colors shadow-xs"
              >
                <span>Avanti</span>
                <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleCompleteSetup(false)}
                className="inline-flex items-center px-4 py-2 rounded-lg text-xs font-bold bg-stone-900 hover:bg-black text-white transition-colors shadow-xs"
              >
                <span>Entra nell'Agenda</span>
                <Check className="w-3.5 h-3.5 ml-1 text-emerald-400" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
