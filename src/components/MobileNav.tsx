import React, { useEffect, useRef, useState } from "react";
import {
  Calendar,
  CalendarDays,
  CheckSquare,
  Clock,
  FileSearch,
  Grid,
  HelpCircle,
  MoreHorizontal,
  Plus,
  ScanLine,
  Sparkles,
  User,
  Users,
  X,
} from "lucide-react";
import type { ViewMode } from "../types";
import { PWAInstallRow } from "./PWAInstallButton";
import { GoogleGlyph } from "./GoogleGlyph";

type IconType = React.ComponentType<{ className?: string }>;

/**
 * Mobile-first bottom navigation.
 *
 * Below 768px the main destinations live here instead of the header tab strip:
 * a fixed, thumb-reachable, safe-area aware bar with at most five entries
 * (Oggi, Settimana, Mese, Scadenze, Altro). Every entry is icon + short label,
 * >= 44px tall, with an unmistakable active state (filled emerald pill).
 *
 * Everything else (Orario, Classi, Circolari, Profilo, Google, circolare AI,
 * installa app, guida) is one tap away inside the "Altro" sheet, so the phone
 * header can stay minimal (brand + profile only).
 *
 * Desktop and tablets (>= 768px) keep the full top navigation: the whole
 * component is wrapped in `md:hidden`.
 */

export const MOBILE_NAV_ITEMS: { id: ViewMode | "altro"; label: string; icon: IconType }[] = [
  { id: "oggi", label: "Oggi", icon: Clock },
  { id: "settimana", label: "Settimana", icon: CalendarDays },
  { id: "mese", label: "Mese", icon: Calendar },
  { id: "scadenze", label: "Scadenze", icon: CheckSquare },
  { id: "altro", label: "Altro", icon: MoreHorizontal },
];

/** Secondary destinations that live inside the "Altro" sheet. */
export const MOBILE_MORE_VIEWS: { id: ViewMode; label: string; icon: IconType }[] = [
  { id: "orario", label: "Orario Lezioni", icon: Grid },
  { id: "classi", label: "Classi & Alunni", icon: Users },
  { id: "circolari", label: "Archivio Circolari", icon: FileSearch },
];

export interface MobileNavProps {
  currentView: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onOpenNewEvent: () => void;
  onOpenProfileModal: () => void;
  onOpenGoogleTab?: () => void;
  onOpenGoogleLogin?: () => void;
  onOpenTutorial?: () => void;
  onOpenCircularModal?: () => void;
  /** Ingresso unificato "Scansiona documento" (fotocamera/file). */
  onOpenScanner?: () => void;
  googleUser?: { email?: string | null } | null;
  stats?: { todayEventsCount: number; pendingDeadlinesCount: number };
}

export const MobileNav: React.FC<MobileNavProps> = ({
  currentView,
  onViewChange,
  onOpenNewEvent,
  onOpenProfileModal,
  onOpenGoogleTab,
  onOpenGoogleLogin,
  onOpenTutorial,
  onOpenCircularModal,
  onOpenScanner,
  googleUser,
  stats,
}) => {
  const [isMoreOpen, setMoreOpen] = useState(false);
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);

  // Sheet behaviour: focus it on open, close on Escape, restore focus to "Altro".
  useEffect(() => {
    if (!isMoreOpen || typeof document === "undefined") return;
    sheetRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMoreOpen(false);
      moreButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isMoreOpen]);

  // Quick-actions sheet (pulsante +): chiudibile con Escape.
  useEffect(() => {
    if (!isActionsOpen || typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsActionsOpen(false);
      fabRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isActionsOpen]);

  const go = (view: ViewMode) => {
    setMoreOpen(false);
    onViewChange(view);
  };

  // "Altro" is the active destination while one of its sections is open.
  const moreViewIds = MOBILE_MORE_VIEWS.map((item) => item.id);
  const isMoreActive = moreViewIds.includes(currentView);

  return (
    <div className="md:hidden">
      {/* Primary action: always one thumb away, above the bar (never a sixth nav item).
          The "+" opens the quick-actions sheet: new commitment OR scan a document. */}
      <button
        ref={fabRef}
        type="button"
        id="mobile-fab-actions"
        onClick={() => setIsActionsOpen(open => !open)}
        className="app-fab"
        aria-label="Azioni rapide"
        title="Azioni rapide"
        aria-haspopup="menu"
        aria-expanded={isActionsOpen}
      >
        <Plus className="w-6 h-6" />
      </button>

      {isActionsOpen && (
        <>
          <div
            className="fixed inset-0 z-[44] bg-stone-950/45"
            onClick={() => setIsActionsOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            aria-label="Azioni rapide"
            className="quick-actions-sheet"
          >
            <button
              type="button"
              id="mobile-fab-new-event"
              role="menuitem"
              onClick={() => {
                setIsActionsOpen(false);
                onOpenNewEvent();
              }}
              className="quick-actions-item"
            >
              <Plus className="h-5 w-5 shrink-0 text-emerald-700" />
              <span className="text-sm font-semibold">Nuovo impegno</span>
            </button>
            {onOpenScanner && (
              <button
                type="button"
                id="mobile-fab-scan-document"
                role="menuitem"
                onClick={() => {
                  setIsActionsOpen(false);
                  onOpenScanner();
                }}
                className="quick-actions-item"
              >
                <ScanLine className="h-5 w-5 shrink-0 text-emerald-700" />
                <span className="text-sm font-semibold">Scansiona documento</span>
              </button>
            )}
          </div>
        </>
      )}

      <nav aria-label="Navigazione principale" className="bottom-nav">
        {MOBILE_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isAltro = item.id === "altro";
          const isActive = isAltro ? isMoreActive : currentView === item.id;
          const badge =
            item.id === "oggi"
              ? stats?.todayEventsCount ?? 0
              : item.id === "scadenze"
              ? stats?.pendingDeadlinesCount ?? 0
              : 0;

          if (isAltro) {
            return (
              <button
                key={item.id}
                type="button"
                ref={moreButtonRef}
                id="mobile-nav-altro"
                onClick={() => setMoreOpen((open) => !open)}
                aria-current={isActive ? "page" : undefined}
                aria-expanded={isMoreOpen}
                aria-haspopup="dialog"
                aria-label={isActive ? "Altro, sezione attiva" : "Altro"}
                className="bottom-nav-item relative"
              >
                <Icon className="w-5 h-5" />
                <span className="bottom-nav-label">{item.label}</span>
              </button>
            );
          }

          return (
            <button
              key={item.id}
              type="button"
              id={`mobile-nav-${item.id}`}
              onClick={() => onViewChange(item.id as ViewMode)}
              aria-current={isActive ? "page" : undefined}
              aria-label={badge > 0 ? `${item.label}, ${badge}` : item.label}
              className="bottom-nav-item relative"
            >
              {badge > 0 && (
                <span
                  aria-hidden
                  className={`bottom-nav-badge ${
                    isActive ? "bg-white text-emerald-800" : item.id === "scadenze" ? "bg-amber-400 text-amber-950" : "bg-emerald-600 text-white"
                  }`}
                >
                  {badge}
                </span>
              )}
              <Icon className="w-5 h-5" />
              <span className="bottom-nav-label">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {isMoreOpen && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-stone-950/45"
            onClick={() => setMoreOpen(false)}
            aria-hidden
          />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Altre funzioni"
            tabIndex={-1}
            className="more-sheet"
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-100 bg-white px-4 pt-3 pb-2">
              <h2 className="text-sm font-bold text-stone-900">Altro</h2>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Chiudi menu Altro"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 active:bg-stone-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="py-1">
              {MOBILE_MORE_VIEWS.map((item) => {
                const Icon = item.icon;
                const isActive = currentView === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    id={`mobile-more-${item.id}`}
                    onClick={() => go(item.id)}
                    aria-current={isActive ? "page" : undefined}
                    className={`more-sheet-item text-sm font-semibold ${
                      isActive ? "bg-emerald-50 text-emerald-900" : "text-stone-800 active:bg-stone-100"
                    }`}
                  >
                    <Icon className={`h-5 w-5 shrink-0 ${isActive ? "text-emerald-700" : "text-stone-400"}`} />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}

              {onOpenScanner && (
                <button
                  type="button"
                  id="mobile-more-scan-document"
                  onClick={() => {
                    setMoreOpen(false);
                    onOpenScanner();
                  }}
                  className="more-sheet-item text-sm font-semibold text-stone-800 active:bg-stone-100"
                >
                  <ScanLine className="h-5 w-5 shrink-0 text-emerald-600" />
                  <span className="truncate">Scansiona documento</span>
                </button>
              )}

              {onOpenCircularModal && (
                <button
                  type="button"
                  id="mobile-more-circular-analyzer"
                  onClick={() => {
                    setMoreOpen(false);
                    onOpenCircularModal();
                  }}
                  className="more-sheet-item text-sm font-semibold text-stone-800 active:bg-stone-100"
                >
                  <Sparkles className="h-5 w-5 shrink-0 text-amber-500" />
                  <span className="truncate">Analizza Circolare</span>
                </button>
              )}

              <div className="my-1 border-t border-stone-100" />

              <button
                type="button"
                id="mobile-more-profile"
                onClick={() => {
                  setMoreOpen(false);
                  onOpenProfileModal();
                }}
                className="more-sheet-item text-sm font-semibold text-stone-800 active:bg-stone-100"
              >
                <User className="h-5 w-5 shrink-0 text-stone-400" />
                <span className="truncate">Profilo / Impostazioni</span>
              </button>

              <button
                type="button"
                id="mobile-more-google"
                onClick={() => {
                  setMoreOpen(false);
                  if (googleUser) onOpenGoogleTab?.();
                  else if (onOpenGoogleLogin) void onOpenGoogleLogin();
                  else onOpenGoogleTab?.();
                }}
                className="more-sheet-item text-sm font-semibold text-stone-800 active:bg-stone-100"
              >
                <GoogleGlyph className="h-5 w-5" />
                <span className="truncate">
                  {googleUser ? `Account Google${googleUser.email ? ` · ${googleUser.email}` : ""}` : "Accedi con Google"}
                </span>
              </button>

              {onOpenTutorial && (
                <button
                  type="button"
                  id="mobile-more-tutorial"
                  onClick={() => {
                    setMoreOpen(false);
                    onOpenTutorial();
                  }}
                  className="more-sheet-item text-sm font-semibold text-stone-800 active:bg-stone-100"
                >
                  <HelpCircle className="h-5 w-5 shrink-0 text-stone-400" />
                  <span className="truncate">Guida rapida</span>
                </button>
              )}

              {/* Secondary: PWA install (removed from the phone header). The whole
                  row is the action, so a tap always gives feedback — never a
                  dead label next to a tiny button. */}
              <PWAInstallRow />
            </div>
          </div>
        </>
      )}
    </div>
  );
};
