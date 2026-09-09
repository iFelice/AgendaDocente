import React from "react";
import {
  Calendar,
  Clock,
  FileSearch,
  CheckSquare,
  Grid,
  User,
  Plus,
  Sparkles,
  Wifi,
  School,
  CalendarDays,
  HeartHandshake,
  Compass,
  Users,
} from "lucide-react";
import { TeacherProfile, ViewMode } from "../types";
import { PWAInstallButton } from "./PWAInstallButton";
import { User as FirebaseUser } from "firebase/auth";

interface NavbarProps {
  currentView: ViewMode;
  onViewChange: (view: ViewMode) => void;
  profile: TeacherProfile;
  onOpenCircularModal: () => void;
  onOpenNewEventModal: () => void;
  onOpenProfileModal: () => void;
  onOpenTutorial?: () => void;
  googleUser?: FirebaseUser | null;
  onOpenGoogleLogin?: () => void;
  onOpenGoogleTab?: () => void;
  stats: {
    todayEventsCount: number;
    pendingDeadlinesCount: number;
  };
}

export const Navbar: React.FC<NavbarProps> = ({
  currentView,
  onViewChange,
  profile,
  onOpenCircularModal,
  onOpenNewEventModal,
  onOpenProfileModal,
  onOpenTutorial,
  googleUser,
  onOpenGoogleLogin,
  onOpenGoogleTab,
  stats,
}) => {
  const views: { id: ViewMode; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "oggi", label: "Oggi", icon: Clock },
    { id: "settimana", label: "Settimana", icon: CalendarDays },
    { id: "mese", label: "Mese", icon: Calendar },
    { id: "scadenze", label: "Scadenze & PEI", icon: CheckSquare },
    { id: "classi", label: "Classi & Alunni", icon: Users },
    { id: "orario", label: "Orario Lezioni", icon: Grid },
    { id: "circolari", label: "Archivio Circolari", icon: FileSearch },
  ];

  const isSupport = profile.isSupportTeacher || profile.primarySubjects.some(s => s.toLowerCase().includes("sostegno"));

  return (
    <header className="sticky top-0 z-30 bg-white border-b border-stone-200 shadow-xs">
      {/* Top Banner */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Teacher Info */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-700 text-white flex items-center justify-center font-bold shadow-xs">
              <School className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-semibold text-stone-900 text-base tracking-tight">
                  Agenda Docente
                </span>
                {isSupport && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-900 border border-emerald-300">
                    <HeartHandshake className="w-3 h-3 mr-1 text-emerald-700" />
                    Sostegno
                  </span>
                )}
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-purple-100 text-purple-900 border border-purple-300 uppercase">
                  {profile.schoolLevel === "ssig" ? "SSIG" : profile.schoolLevel === "primaria" ? "Primaria" : profile.schoolLevel === "ssiig" ? "SSIIG" : "SSIG"}
                </span>
                <span className="hidden md:inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-stone-100 text-stone-700 border border-stone-200">
                  <Wifi className="w-3 h-3 mr-1 text-emerald-600" />
                  Offline-Ready
                </span>
              </div>
              <p className="text-xs text-stone-500 line-clamp-1">
                {profile.fullName || "Configura il tuo profilo"} • {profile.schoolLevel === "ssig" ? "Secondaria I Grado (SSIG)" : profile.schoolLevel === "primaria" ? "Scuola Primaria" : profile.schoolLevel === "ssiig" ? "Secondaria II Grado" : "SSIG"}{profile.schoolName ? ` • ${profile.schoolName}` : ""}{profile.classes.length > 0 ? ` (${profile.classes.join(", ")})` : ""}
              </p>
            </div>
          </div>

          {/* Quick Actions & PWA Install */}
          <div className="flex items-center space-x-2 sm:space-x-3">
            {/* PWA Install Button */}
            <PWAInstallButton />

            <button
              id="btn-scan-circular"
              onClick={onOpenCircularModal}
              className="inline-flex items-center px-3.5 py-2 rounded-lg text-sm font-medium bg-amber-500 hover:bg-amber-600 text-white transition-colors shadow-xs"
              title="Analizza circolare con intelligenza semantica"
            >
              <Sparkles className="w-4 h-4 mr-1.5" />
              <span className="hidden sm:inline">Analizza Circolare</span>
              <span className="sm:hidden">Circolare</span>
            </button>

            <button
              id="btn-new-event"
              onClick={onOpenNewEventModal}
              className="inline-flex items-center px-3.5 py-2 rounded-lg text-sm font-medium bg-emerald-700 hover:bg-emerald-800 text-white transition-colors shadow-xs"
            >
              <Plus className="w-4 h-4 mr-1" />
              <span className="hidden sm:inline">Nuovo Impegno</span>
              <span className="sm:hidden">Nuovo</span>
            </button>

            {onOpenTutorial && (
              <button
                id="btn-open-tutorial"
                onClick={onOpenTutorial}
                className="inline-flex items-center space-x-1 p-2 rounded-lg text-stone-600 hover:text-emerald-800 hover:bg-emerald-50 transition-colors"
                title="Rivedi Guida & Configurazione Iniziale"
                aria-label="Tutorial e Setup Iniziale"
              >
                <Compass className="w-5 h-5 text-emerald-700" />
                <span className="hidden xl:inline text-xs font-semibold text-emerald-800">Tutorial</span>
              </button>
            )}

            {/* Google Account Status Chip or Login Button */}
            {googleUser ? (
              <button
                id="btn-google-status"
                onClick={onOpenGoogleTab}
                className="inline-flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 transition-colors shadow-2xs text-xs font-semibold"
                title={`Account Istituzionale: ${googleUser.email} (Google Calendar collegato)`}
              >
                <div className="w-3.5 h-3.5 flex-shrink-0">
                  <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="w-full h-full block">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                    <path fill="none" d="M0 0h48v48H0z" />
                  </svg>
                </div>
                <span className="hidden md:inline max-w-[130px] truncate">{googleUser.email}</span>
                <span className="md:hidden">Google</span>
              </button>
            ) : (
              <button
                id="btn-google-login-nav"
                onClick={async () => {
                  try {
                    if (onOpenGoogleLogin) {
                      await onOpenGoogleLogin();
                    } else if (onOpenGoogleTab) {
                      onOpenGoogleTab();
                    }
                  } catch {
                    // Safe guard against unhandled rejection
                  }
                }}
                className="inline-flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border border-stone-300 bg-white hover:bg-stone-50 text-stone-700 transition-colors shadow-2xs text-xs font-semibold"
                title="Accedi con account istituzionale Google Workspace"
              >
                <div className="w-3.5 h-3.5 flex-shrink-0">
                  <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="w-full h-full block">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                    <path fill="none" d="M0 0h48v48H0z" />
                  </svg>
                </div>
                <span className="hidden sm:inline">Accedi con Google</span>
                <span className="sm:hidden">Accedi</span>
              </button>
            )}

            <button
              id="btn-open-profile"
              onClick={onOpenProfileModal}
              className="p-2 rounded-lg text-stone-600 hover:text-stone-900 hover:bg-stone-100 transition-colors"
              title="Profilo Docente e Impostazioni"
              aria-label="Profilo e Impostazioni"
            >
              <User className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="bg-stone-50 border-t border-stone-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <nav className="flex space-x-1 sm:space-x-4 overflow-x-auto py-2 scrollbar-none" aria-label="Tabs">
            {views.map((v) => {
              const Icon = v.icon;
              const isActive = currentView === v.id;
              return (
                <button
                  key={v.id}
                  id={`nav-tab-${v.id}`}
                  onClick={() => onViewChange(v.id)}
                  className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? "bg-white text-emerald-800 shadow-xs border border-stone-200"
                      : "text-stone-600 hover:text-stone-900 hover:bg-stone-100"
                  }`}
                >
                  <Icon className={`w-4 h-4 mr-1.5 ${isActive ? "text-emerald-700" : "text-stone-500"}`} />
                  <span>{v.label}</span>
                  {v.id === "oggi" && stats.todayEventsCount > 0 && (
                    <span className="ml-2 px-1.5 py-0.2 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                      {stats.todayEventsCount}
                    </span>
                  )}
                  {v.id === "scadenze" && stats.pendingDeadlinesCount > 0 && (
                    <span className="ml-2 px-1.5 py-0.2 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                      {stats.pendingDeadlinesCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </div>
    </header>
  );
};
