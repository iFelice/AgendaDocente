import React from "react";
import { Cloud, CloudOff, RefreshCw } from "lucide-react";
import type { SyncStatus } from "../services/sync/types";

/**
 * Account sync status card shown inside ProfileModal. Purely informational + explicit actions:
 * automatic mirroring cannot be silently disabled/enabled by the app itself, and a two-sided
 * conflict is only resolved by a conscious user choice.
 */
export const CloudSync: React.FC<{
  status?: SyncStatus;
  onSyncNow?: () => void;
  onToggle?: (enabled: boolean) => void;
  onResolve?: (choice: "local" | "remote") => void;
}> = ({ status, onSyncNow, onToggle, onResolve }) => {
  const phase = status?.phase ?? "disabled";
  const badge =
    phase === "syncing" ? { text: "In corso…", cls: "bg-blue-50 text-blue-800 border-blue-200" }
    : phase === "awaiting-resolution" ? { text: "Conflitto", cls: "bg-amber-50 text-amber-900 border-amber-300" }
    : phase === "offline" ? { text: "Offline", cls: "bg-rose-50 text-rose-800 border-rose-200" }
    : phase === "error" ? { text: "Errore", cls: "bg-rose-50 text-rose-800 border-rose-200" }
    : phase === "disabled" ? { text: "Disattivata", cls: "bg-stone-100 text-stone-600 border-stone-200" }
    : { text: "Sincronizzato", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" };

  return (
    <div className="p-5 rounded-2xl border border-stone-200 bg-white space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            {phase === "offline" || phase === "disabled" ? (
              <CloudOff className="w-4 h-4 text-stone-500" />
            ) : (
              <Cloud className="w-4 h-4 text-blue-700" />
            )}
            <h4 className="font-bold text-stone-900 text-sm">Sincronizzazione account (multi-dispositivo)</h4>
          </div>
          <p className="text-xs text-stone-500">
            Profilo, ruoli, orari, impegni e circolari vengono rispecchiati nel cloud personale associato a questo
            account Google, così li ritrovi su tablet e altri dispositivi. L'archivio locale (IndexedDB) resta la
            fonte primaria: l'app funziona sempre anche offline e il cloud non sovrascrive mai dati più recenti.
          </p>
        </div>
        <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded-lg border ${badge.cls}`}>
          {badge.text}
        </span>
      </div>

      {status?.lastSyncedAt && phase !== "disabled" && (
        <p className="text-[11px] text-stone-500">Ultima sincronizzazione riuscita: {formatDateTime(status.lastSyncedAt)}</p>
      )}
      {status?.message && (
        <p className="text-[11px] text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-2.5 py-1.5">{status.message}</p>
      )}

      {(status?.notices?.length || status?.lastAttemptAt || status?.syncedSections?.length) && phase !== "disabled" && (
        <div className="text-[11px] text-stone-600 bg-stone-50 border border-stone-100 rounded-lg px-2.5 py-2 space-y-1">
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
        </div>
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
              className="px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-xs font-bold shadow-xs"
            >
              Mantieni dati di questo dispositivo
            </button>
            <button
              type="button"
              onClick={() => onResolve?.("remote")}
              className="px-3 py-1.5 rounded-lg bg-white border border-amber-400 text-amber-900 hover:bg-amber-100 text-xs font-bold"
            >
              Usa i dati del cloud
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <label className={`flex items-center gap-2 text-xs font-semibold text-stone-700 ${onToggle ? "cursor-pointer" : "opacity-60"}`}>
          <input
            type="checkbox"
            checked={status?.enabled !== false && phase !== "disabled"}
            disabled={!onToggle || phase === "disabled"}
            onChange={(e) => onToggle?.(e.target.checked)}
            className="rounded border-stone-300 text-blue-700 focus:ring-blue-600"
          />
          Sincronizza automaticamente
        </label>
        <button
          type="button"
          onClick={() => onSyncNow?.()}
          disabled={!onSyncNow || phase === "syncing" || phase === "disabled"}
          className="px-3 py-1.5 rounded-lg bg-white border border-stone-300 hover:bg-stone-50 text-stone-800 text-xs font-bold disabled:opacity-50 flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3 h-3 ${phase === "syncing" ? "animate-spin" : ""}`} />
          Sincronizza ora
        </button>
      </div>
      <p className="text-[10px] text-stone-400">
        La disconnessione dall'account non elimina alcun dato: l'archivio locale resta intatto su questo dispositivo.
      </p>
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
