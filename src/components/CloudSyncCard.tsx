import React, { useState } from "react";
import { Cloud, CloudOff, RefreshCw, ChevronDown, ChevronUp, Check, TriangleAlert } from "lucide-react";
import type { SyncStatus } from "../services/sync/types";
import { useManualSync, type ManualSyncController } from "../hooks/useManualSync";

/**
 * Account sync status card shown inside ProfileModal. Purely informational + explicit actions:
 * automatic mirroring cannot be silently disabled/enabled by the app itself, and a two-sided
 * conflict is only resolved by a conscious user choice.
 *
 * Mobile-friendly: compact spacing, sync status + "Sincronizza ora" always visible, secondary
 * explanations and diagnostics hidden behind an explicit "Dettagli" disclosure.
 *
 * "Sincronizza ora" drives the REAL account-sync engine (SyncEngine.syncNow — full
 * pull/push/reconcile cycle with merge + conflict protection): it is never a page reload.
 * The button gives transient feedback for the manual run —
 *   normal  ↻ Sincronizza ora
 *   during  ↻ Sincronizzazione…
 *   success ✓ Aggiornato ora
 *   error   ⚠ Sincronizzazione non riuscita
 * and returns to the neutral state after a few seconds. Offline the button stays available;
 * a clear message explains that local data remain available (nothing is deleted or lost).
 */
export const CloudSync: React.FC<{
  status?: SyncStatus;
  onSyncNow?: () => void;
  onToggle?: (enabled: boolean) => void;
  onResolve?: (choice: "local" | "remote") => void;
  /** Device connectivity; defaults to navigator.onLine when not provided (browser default true). */
  online?: boolean;
  /**
   * Shared manual-run controller. ProfileModal passes the SAME instance to its
   * header quick-sync button and to this card, so both triggers share one
   * pipeline, one double-trigger guard and one transient feedback state.
   * When omitted (standalone usage) the card owns an equivalent private one.
   */
  controller?: ManualSyncController;
}> = ({ status, onSyncNow, onToggle, onResolve, online: onlineProp, controller }) => {
  const internal = useManualSync({ status, onSyncNow });
  const manual = controller ?? internal;
  const phase = manual.phase;
  const outcome = manual.outcome;
  const handleSyncNow = manual.runSync;
  const online = onlineProp ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);

  const [showDetails, setShowDetails] = useState(false);
  const badge =
    phase === "syncing" ? { text: "In corso…", cls: "bg-blue-50 text-blue-800 border-blue-200" }
    : phase === "awaiting-resolution" ? { text: "Conflitto", cls: "bg-amber-50 text-amber-900 border-amber-300" }
    : phase === "offline" ? { text: "Offline", cls: "bg-rose-50 text-rose-800 border-rose-200" }
    : phase === "error" ? { text: "Errore", cls: "bg-rose-50 text-rose-800 border-rose-200" }
    : phase === "disabled" ? { text: "Disattivata", cls: "bg-stone-100 text-stone-600 border-stone-200" }
    : { text: "Sincronizzato", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" };

  const hasDetails =
    !!status?.lastSyncedAt ||
    !!status?.lastAttemptAt ||
    (status?.syncedSections?.length ?? 0) > 0 ||
    (status?.notices?.length ?? 0) > 0;

  const syncButton =
    outcome === "success" ? { Icon: Check, label: "Aggiornato ora", tone: "border-emerald-300 bg-emerald-50 text-emerald-800" }
    : outcome === "error" ? { Icon: TriangleAlert, label: "Sincronizzazione non riuscita", tone: "border-rose-300 bg-rose-50 text-rose-800" }
    : phase === "syncing" ? { Icon: RefreshCw, label: "Sincronizzazione…", tone: "border-stone-300 bg-white text-stone-800" }
    : { Icon: RefreshCw, label: "Sincronizza ora", tone: "border-stone-300 bg-white text-stone-800" };

  return (
    <div className="p-4 sm:p-5 rounded-2xl border border-stone-200 bg-white space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center space-x-2 min-w-0">
          {phase === "offline" || phase === "disabled" ? (
            <CloudOff className="w-4 h-4 text-stone-500 shrink-0" />
          ) : (
            <Cloud className="w-4 h-4 text-blue-700 shrink-0" />
          )}
          <h4 className="font-bold text-stone-900 text-sm leading-snug">
            Sincronizzazione account
          </h4>
        </div>
        <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded-lg border ${badge.cls}`}>
          {badge.text}
        </span>
      </div>

      <p className="text-xs text-stone-500 leading-relaxed">
        Profilo, ruoli, orari, impegni e circolari vengono rispecchiati nel cloud personale associato a questo
        account Google, così li ritrovi su tablet e altri dispositivi. L'archivio locale (IndexedDB) resta la
        fonte primaria: l'app funziona sempre anche offline.
      </p>

      {status?.lastSyncedAt && phase !== "disabled" && (
        <p className="text-[11px] text-stone-500">
          Ultimo aggiornamento: {formatDateTime(status.lastSyncedAt)}
        </p>
      )}

      {status?.message && (
        <p className="text-[11px] text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-2.5 py-1.5">{status.message}</p>
      )}

      {!online && (
        <p role="status" className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
          Sei offline. I dati locali restano disponibili.
        </p>
      )}

      {status?.conflicts && status.conflicts.length > 0 && (
        <div className="p-3 rounded-xl bg-amber-50 border-2 border-amber-300 space-y-2">
          <p className="text-xs font-bold text-amber-950">
            Questo dispositivo e il cloud contengono modifiche indipendenti ({status.conflicts.map(prettify).join(", ")}).
          </p>
          <p className="text-[11px] text-amber-900">
            Nessuna sovrascrittura automatica: scegli tu quali dati mantenere. L'altra copia viene archiviata nel cloud, non perduta.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onResolve?.("local")}
              className="px-3 py-2 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-xs font-bold shadow-xs min-h-[40px]"
            >
              Mantieni dati di questo dispositivo
            </button>
            <button
              type="button"
              onClick={() => onResolve?.("remote")}
              className="px-3 py-2 rounded-lg bg-white border border-amber-400 text-amber-900 hover:bg-amber-100 text-xs font-bold min-h-[40px]"
            >
              Usa i dati del cloud
            </button>
          </div>
        </div>
      )}

      {/* Secondary details behind an explicit disclosure (compact on mobile) */}
      {(hasDetails || status) && (
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-semibold text-stone-500 hover:text-stone-800 transition-colors py-1"
          aria-expanded={showDetails}
        >
          {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {showDetails ? "Nascondi dettagli" : "Dettagli"}
        </button>
      )}

      {showDetails && (
        <div className="text-[11px] text-stone-600 bg-stone-50 border border-stone-100 rounded-lg px-2.5 py-2 space-y-1.5">
          {status?.lastAttemptAt && (
            <p>
              <span className="font-semibold">Ultimo tentativo:</span> {formatDateTime(status.lastAttemptAt)}
            </p>
          )}
          {status?.syncedSections && status.syncedSections.length > 0 && (
            <p>
              <span className="font-semibold">Sezioni sincronizzate:</span> {status.syncedSections.map(prettify).join(", ")}
            </p>
          )}
          {status?.notices?.map((notice, index) => (
            <p key={index} className="text-amber-800 bg-amber-50 border border-amber-100 rounded px-2 py-1">
              {notice}
            </p>
          ))}
          {!status?.lastSyncedAt && phase === "disabled" && (
            <p>La sincronizzazione è disattivata su questo dispositivo. Puoi riattivarla qui sopra in qualsiasi momento.</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-stone-100">
        <label className={`flex items-center gap-2 text-xs font-semibold text-stone-700 min-h-[40px] ${onToggle ? "cursor-pointer" : "opacity-60"}`}>
          <input
            type="checkbox"
            checked={status?.enabled !== false && phase !== "disabled"}
            disabled={!onToggle || phase === "disabled"}
            onChange={(e) => onToggle?.(e.target.checked)}
            className="rounded border-stone-300 text-blue-700 focus:ring-blue-600 w-4 h-4"
          />
          Sincronizza automaticamente
        </label>
        {/* Manual run feedback is announced to assistive tech without being intrusive. */}
        <span aria-live="polite" className="sr-only">
          {outcome === "success" ? "Sincronizzazione completata" : outcome === "error" ? "Sincronizzazione non riuscita" : ""}
        </span>
        <button
          type="button"
          onClick={handleSyncNow}
          disabled={manual.disabled}
          aria-label={syncButton.label}
          className={`px-3 py-2 rounded-lg border text-xs font-bold disabled:opacity-50 flex items-center gap-1.5 min-h-[40px] max-w-full transition-colors ${syncButton.tone}`}
        >
          <syncButton.Icon className={`w-3.5 h-3.5 shrink-0 ${phase === "syncing" && outcome === "idle" ? "animate-spin" : ""}`} />
          <span className="truncate">{syncButton.label}</span>
        </button>
      </div>
    </div>
  );
};

const prettify = (name: string): string =>
  ({
    profile: "profilo",
    settings: "impostazioni",
    definitiveTimetable: "orario definitivo",
    provisionalTimetable: "orario provvisorio",
    students: "alunni",
    events: "impegni",
    circulars: "circolari",
  }[name] ?? name);

const formatDateTime = (iso: string): string => {
  try { return new Date(iso).toLocaleString("it-IT"); } catch { return iso; }
};
