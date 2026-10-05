import React, { useEffect, useRef, useState } from "react";
import {
  Calendar,
  CalendarDays,
  CheckSquare,
  ChevronUp,
  Clock,
  FileSearch,
  Grid,
  ListTodo,
  HelpCircle,
  MoreHorizontal,
  Plus,
  ScanLine,
  Sparkles,
  User,
  Users,
  BookOpen,
  StickyNote,
  X,
} from "lucide-react";
import type { ViewMode } from "../types";
import { PWAInstallRow } from "./PWAInstallButton";
import { GoogleGlyph } from "./GoogleGlyph";

type IconType = React.ComponentType<{ className?: string }>;

/**
 * Mobile-first bottom navigation.
 *
 * On phones AND tablets (below 1280px) the main destinations live here instead
 * of the header tab strip: a fixed, thumb-reachable, safe-area aware bar with
 * exactly five entries — Oggi, Scadenze, Note (Note e impegni), Orario (Orario
 * Lezioni), Altro. Every entry is icon + short label, >= 44px tall, with an
 * unmistakable active state (filled emerald pill).
 *
 * "Oggi" is also the entry point of the whole calendar group (Oggi/Settimana/
 * Mese): it stays the active destination while any of the three is selected.
 * A tap behaves differently depending on where you are (see `MobileNavProps`
 * and the component body for the exact rule):
 *  - away from "la giornata corrente" (another section, Settimana/Mese, or
 *    Oggi moved to a different day) it jumps back to Oggi/today;
 *  - already on "la giornata corrente" it opens the "Viste calendario" sheet
 *    (Settimana / Mese), mirroring the "Altro" sheet's structure and a11y.
 *
 * Everything else (Classi, Registro, Circolari, Profilo, Google, circolare AI,
 * installa app, guida) is one tap away inside the "Altro" sheet, so the header
 * stays minimal (brand + profile only).
 *
 * Desktop (>= 1280px) keeps the full top navigation: the whole component is
 * wrapped in `xl:hidden`.
 */

export const MOBILE_NAV_ITEMS: { id: ViewMode | "altro"; label: string; fullLabel: string; icon: IconType }[] = [
  { id: "oggi", label: "Oggi", fullLabel: "Oggi", icon: Clock },
  { id: "scadenze", label: "Scadenze", fullLabel: "Scadenze", icon: CheckSquare },
  // Nomi completi disponibili nell'aria-label: a 320px l'etichetta in barra resta
  // corta per non troncare e non andare su due righe.
  { id: "impegni", label: "Note", fullLabel: "Note e impegni", icon: ListTodo },
  { id: "orario", label: "Orario", fullLabel: "Orario Lezioni", icon: Grid },
  { id: "altro", label: "Altro", fullLabel: "Altro", icon: MoreHorizontal },
];

/** Secondary destinations that live inside the "Altro" sheet. */
export const MOBILE_MORE_VIEWS: { id: ViewMode; label: string; icon: IconType }[] = [
  { id: "classi", label: "Classi & Alunni", icon: Users },
  { id: "registro", label: "Registro", icon: BookOpen },
  { id: "circolari", label: "Archivio Circolari", icon: FileSearch },
];

/** The two calendar views reachable from "Oggi" when already on the current day. */
const CALENDAR_SHEET_VIEWS: { id: ViewMode; label: string; icon: IconType }[] = [
  { id: "settimana", label: "Settimana", icon: CalendarDays },
  { id: "mese", label: "Mese", icon: Calendar },
];

export interface MobileNavProps {
  currentView: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onOpenNewEvent: () => void;
  onOpenNewNote?: () => void;
  onOpenProfileModal: () => void;
  onOpenGoogleTab?: () => void;
  onOpenGoogleLogin?: () => void;
  onOpenTutorial?: () => void;
  onOpenCircularModal?: () => void;
  /** Ingresso unificato "Scansiona documento" (fotocamera/file). */
  onOpenScanner?: () => void;
  googleUser?: { email?: string | null } | null;
  stats?: { todayEventsCount: number; pendingDeadlinesCount: number };
  /**
   * "Giornata corrente" = vista Oggi E data visualizzata uguale a oggi. Questo
   * flag dice se, una volta su Oggi, la data mostrata è proprio quella di
   * oggi: lo decide App (che conosce la data di TodayView), MobileNav si
   * limita a combinarlo con `currentView === "oggi"`. Default true così i
   * consumer che non seguono il flusso del giorno (vecchi test, storie
   * isolate) non devono preoccuparsene.
   */
  isOggiShowingToday?: boolean;
  /**
   * Tap su "Oggi" quando NON si è sulla giornata corrente: riporta la vista
   * su Oggi/oggi. Se assente, ricade su `onViewChange("oggi")` (nessuna
   * duplicazione di logica: il reset della data resta un'unica funzione lato
   * App).
   */
  onGoToToday?: () => void;
}

export const MobileNav: React.FC<MobileNavProps> = ({
  currentView,
  onViewChange,
  onOpenNewEvent,
  onOpenNewNote,
  onOpenProfileModal,
  onOpenGoogleTab,
  onOpenGoogleLogin,
  onOpenTutorial,
  onOpenCircularModal,
  onOpenScanner,
  googleUser,
  stats,
  isOggiShowingToday = true,
  onGoToToday,
}) => {
  const [isMoreOpen, setMoreOpen] = useState(false);
  const [isCalendarSheetOpen, setCalendarSheetOpen] = useState(false);
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const calendarSheetRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const oggiButtonRef = useRef<HTMLButtonElement>(null);
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

  // "Viste calendario" sheet: stesso comportamento di "Altro" (focus
  // all'apertura, chiusura con Escape, ripristino del focus su "Oggi").
  useEffect(() => {
    if (!isCalendarSheetOpen || typeof document === "undefined") return;
    calendarSheetRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCalendarSheetOpen(false);
      oggiButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isCalendarSheetOpen]);

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

  const goToCalendarView = (view: ViewMode) => {
    setCalendarSheetOpen(false);
    onViewChange(view);
  };

  // I due fogli (Altro / Viste calendario) non sono mai aperti insieme.
  const toggleMore = () => {
    setCalendarSheetOpen(false);
    setMoreOpen((open) => !open);
  };
  const toggleCalendarSheet = () => {
    setMoreOpen(false);
    setCalendarSheetOpen((open) => !open);
  };

  // "Altro" is the active destination while one of its sections is open.
  const moreViewIds = MOBILE_MORE_VIEWS.map((item) => item.id);
  const isMoreActive = moreViewIds.includes(currentView);

  // "Oggi" è il punto d'accesso del gruppo calendario (Oggi/Settimana/Mese):
  // resta attivo per tutte e tre le viste, anche quando il tap porta altrove.
  const isCalendarGroupActive = currentView === "oggi" || currentView === "settimana" || currentView === "mese";
  // Giornata corrente = vista Oggi E data visualizzata = oggi. Solo in questo
  // stato il tap apre il foglio "Viste calendario"; altrimenti riporta a Oggi/oggi.
  const isOnCurrentDay = currentView === "oggi" && isOggiShowingToday;

  const handleOggiTap = () => {
    if (isOnCurrentDay) {
      toggleCalendarSheet();
      return;
    }
    setMoreOpen(false);
    setCalendarSheetOpen(false);
    if (onGoToToday) onGoToToday();
    else onViewChange("oggi");
  };

  return (
    <div className="xl:hidden">
      {/* Primary action: always one thumb away, above the bar (never a sixth nav item).
          The "+" opens the quick-actions sheet: new commitment, note, or scan. */}
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
            {onOpenNewNote && (
              <button
                type="button"
                id="mobile-fab-new-note"
                role="menuitem"
                onClick={() => {
                  setIsActionsOpen(false);
                  onOpenNewNote();
                }}
                className="quick-actions-item"
              >
                <StickyNote className="h-5 w-5 shrink-0 text-emerald-700" />
                <span className="text-sm font-semibold">Nuova nota</span>
              </button>
            )}
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
          const isOggi = item.id === "oggi";
          const badge =
            item.id === "oggi"
              ? stats?.todayEventsCount ?? 0
              : item.id === "scadenze"
              ? stats?.pendingDeadlinesCount ?? 0
              : 0;

          if (isAltro) {
            const isActive = isMoreActive;
            return (
              <button
                key={item.id}
                type="button"
                ref={moreButtonRef}
                id="mobile-nav-altro"
                onClick={toggleMore}
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

          if (isOggi) {
            const isActive = isCalendarGroupActive;
            return (
              <button
                key={item.id}
                type="button"
                ref={oggiButtonRef}
                id="mobile-nav-oggi"
                onClick={handleOggiTap}
                aria-current={isActive ? "page" : undefined}
                aria-label={badge > 0 ? `${item.fullLabel}, ${badge}` : item.fullLabel}
                // L'affordance (haspopup/expanded) esiste SOLO quando il tap apre il
                // foglio "Viste calendario" (si è già sulla giornata corrente).
                {...(isOnCurrentDay
                  ? { "aria-haspopup": "dialog" as const, "aria-expanded": isCalendarSheetOpen }
                  : {})}
                className="bottom-nav-item relative"
              >
                {badge > 0 && (
                  <span
                    aria-hidden
                    className={`bottom-nav-badge ${isActive ? "bg-white text-emerald-800" : "bg-emerald-600 text-white"}`}
                  >
                    {badge}
                  </span>
                )}
                <span className="relative inline-flex items-center justify-center">
                  <Icon className="w-5 h-5" />
                  {isOnCurrentDay && (
                    <ChevronUp
                      aria-hidden
                      data-testid="mobile-nav-oggi-chevron"
                      className="absolute -top-1.5 -right-2.5 h-3 w-3"
                    />
                  )}
                </span>
                <span className="bottom-nav-label">{item.label}</span>
              </button>
            );
          }

          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              id={`mobile-nav-${item.id}`}
              onClick={() => onViewChange(item.id as ViewMode)}
              aria-current={isActive ? "page" : undefined}
              aria-label={badge > 0 ? `${item.fullLabel}, ${badge}` : item.fullLabel}
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

      {isCalendarSheetOpen && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-stone-950/45"
            onClick={() => setCalendarSheetOpen(false)}
            aria-hidden
          />
          <div
            ref={calendarSheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Viste calendario"
            tabIndex={-1}
            className="more-sheet"
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-100 bg-white px-4 pt-3 pb-2">
              <h2 className="text-sm font-bold text-stone-900">Viste calendario</h2>
              <button
                type="button"
                onClick={() => setCalendarSheetOpen(false)}
                aria-label="Chiudi menu Viste calendario"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 active:bg-stone-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="py-1">
              {CALENDAR_SHEET_VIEWS.map((item) => {
                const Icon = item.icon;
                const isActive = currentView === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    id={`mobile-calendar-${item.id}`}
                    onClick={() => goToCalendarView(item.id)}
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
            </div>
          </div>
        </>
      )}

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
