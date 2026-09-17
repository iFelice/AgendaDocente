import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScanLine } from "lucide-react";
import { analyzeTimetableGeometry, analyzeTimetableStrip } from "../services/scanService";
import {
  COMPOSED_CROP_MIME_TYPE,
  composeCropBase64ForCoordinate,
  isCroppableMimeType,
  loadImage,
} from "../utils/imageCropper";
import { stripOutcomeMessage } from "../utils/timetableStrip";
import {
  subjectColumnCropSpec,
  totalPeriodColumns,
  TimetableGeometryError,
  type TimetableGridGeometry,
} from "../utils/timetableCrops";
import { revokePreviewUrl } from "../utils/documentScanner";

/**
 * PANNELLO DIAGNOSTICO TEMPORANEO — crop curricolare.
 *
 * Serve a verificare SULLA FOTO REALE che la geometria misurata isoli davvero la
 * colonna oraria giusta: mostra `[MATERIA] | [LUNEDÌ 2ª]` e nient'altro.
 *
 * Non è collegato all'analisi delle materie: non invia nulla a
 * `/api/analyze-timetable`, non modifica lo stato dello scanner e non partecipa
 * al salvataggio.
 *
 * ── EFFIMERO PER COSTRUZIONE ─────────────────────────────────────────────────
 * L'immagine composta è un Blob in memoria esposto con un object URL, revocato a
 * ogni nuova esecuzione e allo smontaggio. Non viene scritta su disco, non entra
 * in IndexedDB/Firestore, non va nei backup e non viene loggata.
 *
 * ── COME RIMUOVERLO ──────────────────────────────────────────────────────────
 * Eliminare questo file e la riga `<CropDiagnosticPanel …/>` in
 * `DocumentScannerModal.tsx` (passo di consenso, ramo curricolare). Nessun altro
 * file dipende da questo componente.
 */

/** Coordinata della preview: lunedì, 2ª ora. */
export const CROP_DIAGNOSTIC_COORDINATE = { dayOfWeek: 1, periodIndex: 2 } as const;

/** Classe cercata nella prova end-to-end della strip (diagnostica temporanea). */
export const CROP_DIAGNOSTIC_CLASS_LABEL = "3D";

export const CROP_DIAGNOSTIC_UNSUPPORTED =
  "La preview del crop è disponibile solo per le foto (PNG, JPEG, WebP), non per i PDF.";

export interface CropDiagnosticPanelProps {
  /** Immagine già letta in memoria dal modale (mai persistita). */
  imageBase64: string;
  mimeType: string;
  /** Object URL del file originale, usato come sorgente del canvas. */
  imageUrl: string | undefined;
  /** Ore per giorno confermate dall'utente: 0 = non ancora disponibili. */
  periodsPerDay: number;
}

type Status = "idle" | "running" | "ready" | "error";
type StripStatus = "idle" | "running" | "done" | "error";

export const CropDiagnosticPanel: React.FC<CropDiagnosticPanelProps> = ({
  imageBase64,
  mimeType,
  imageUrl,
  periodsPerDay,
}) => {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<string | null>(null);
  const [stripStatus, setStripStatus] = useState<StripStatus>("idle");
  const [stripResult, setStripResult] = useState<string | null>(null);
  const [stripError, setStripError] = useState<string | null>(null);
  const objectUrlRef = useRef<string | undefined>(undefined);
  /**
   * Base64 della strip composta: vive SOLO in questo ref, in memoria. Non è
   * scritto su disco, non va in IndexedDB/Firestore, non entra nei backup e non
   * viene loggato. Viene azzerato a ogni nuova esecuzione e allo smontaggio.
   */
  const stripBase64Ref = useRef<string | null>(null);

  /** Nessun object URL sopravvive al componente: revoca allo smontaggio. */
  useEffect(
    () => () => {
      revokePreviewUrl(objectUrlRef.current);
      stripBase64Ref.current = null;
    },
    [],
  );

  const release = useCallback(() => {
    revokePreviewUrl(objectUrlRef.current);
    objectUrlRef.current = undefined;
    stripBase64Ref.current = null;
  }, []);

  const runnable = periodsPerDay > 0 && !!imageBase64 && !!imageUrl;
  const supported = isCroppableMimeType(mimeType);

  const run = useCallback(async () => {
    if (!runnable || !imageUrl) return;
    release();
    setPreviewUrl(undefined);
    setSummary(null);
    setError(null);
    setStripResult(null);
    setStripError(null);
    setStripStatus("idle");
    setStatus("running");
    try {
      const geometry: TimetableGridGeometry = await analyzeTimetableGeometry({
        imageBase64,
        mimeType,
        periodsPerDay,
      });
      const spec = subjectColumnCropSpec(geometry, CROP_DIAGNOSTIC_COORDINATE.dayOfWeek, CROP_DIAGNOSTIC_COORDINATE.periodIndex);
      const { image, width, height } = await loadImage(imageUrl);
      const composed = await composeCropBase64ForCoordinate(image, spec, width, height);
      // La strip è pronta per l'analisi: il provider riceverà SOLO questa.
      stripBase64Ref.current = composed.base64;
      const url = URL.createObjectURL(composed.blob);
      objectUrlRef.current = url;
      setPreviewUrl(url);
      // Solo numeri derivati dall'input dell'utente: nessun contenuto del documento.
      setSummary(
        `colonna ${spec.columnNumber} di ${totalPeriodColumns(periodsPerDay)} — MATERIA + la sola colonna oraria richiesta`,
      );
      setStatus("ready");
    } catch (caught: unknown) {
      release();
      setPreviewUrl(undefined);
      setError(
        caught instanceof TimetableGeometryError
          ? "Geometria della tabella non utilizzabile: nessun crop generato."
          : caught instanceof Error
            ? caught.message
            : "Preview del crop non riuscita.",
      );
      setStatus("error");
    }
  }, [imageBase64, imageUrl, mimeType, periodsPerDay, release, runnable]);

  /**
   * Prova end-to-end sulla strip già composta: il provider riceve SOLO
   * `[MATERIA] | [LUNEDÌ 2ª]` e cerca solo la classe richiesta.
   *
   * L'esito è mostrato e basta: non viene salvato nell'orario, non chiama
   * "Ricostruisci il mio orario", non tocca crossref, Firestore o backup.
   */
  const runStrip = useCallback(async () => {
    const stripBase64 = stripBase64Ref.current;
    if (!stripBase64) return;
    setStripResult(null);
    setStripError(null);
    setStripStatus("running");
    try {
      const result = await analyzeTimetableStrip({
        imageBase64: stripBase64,
        mimeType: COMPOSED_CROP_MIME_TYPE,
        classLabel: CROP_DIAGNOSTIC_CLASS_LABEL,
      });
      setStripResult(stripOutcomeMessage(CROP_DIAGNOSTIC_CLASS_LABEL, { outcome: result.outcome, subjects: result.subjects }));
      setStripStatus("done");
    } catch (caught: unknown) {
      setStripError(caught instanceof Error ? caught.message : "Analisi della strip non riuscita.");
      setStripStatus("error");
    }
  }, []);

  if (!supported) {
    return (
      <p id="crop-diagnostic-unsupported" className="text-[11px] text-stone-500">
        {CROP_DIAGNOSTIC_UNSUPPORTED}
      </p>
    );
  }

  return (
    <div className="p-3 rounded-xl border border-dashed border-stone-300 bg-stone-50 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-stone-600 flex items-center gap-1.5">
          <ScanLine className="w-3.5 h-3.5" />
          Preview crop (diagnostica temporanea)
        </span>
        <button
          type="button"
          id="crop-diagnostic-run"
          onClick={() => void run()}
          disabled={!runnable || status === "running"}
          className="min-h-[36px] px-3 rounded-lg text-xs font-semibold bg-stone-800 text-white disabled:opacity-50"
        >
          {status === "running" ? "Misuro la griglia…" : "Mostra MATERIA + Lunedì 2ª"}
        </button>
      </div>
      <p className="text-[11px] text-stone-500">
        Verifica che la colonna isolata sia quella giusta. L&apos;immagine resta in memoria: non viene salvata né inviata.
      </p>
      {summary && (
        <p id="crop-diagnostic-summary" className="text-[11px] text-stone-600">
          {summary}
        </p>
      )}
      {error && (
        <p id="crop-diagnostic-error" role="status" className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
          {error}
        </p>
      )}
      {previewUrl && (
        <img
          id="crop-diagnostic-preview"
          src={previewUrl}
          alt="Anteprima della colonna MATERIA affiancata alla colonna oraria richiesta"
          className="w-full rounded-lg border border-stone-200 bg-white"
        />
      )}
      {previewUrl && (
        <div className="pt-1 space-y-1.5 border-t border-dashed border-stone-300">
          <button
            type="button"
            id="crop-diagnostic-strip-run"
            onClick={() => void runStrip()}
            disabled={!stripBase64Ref.current || stripStatus === "running"}
            className="min-h-[36px] px-3 rounded-lg text-xs font-semibold bg-stone-700 text-white disabled:opacity-50"
          >
            {stripStatus === "running" ? "Leggo la colonna…" : `Analizza questa strip per ${CROP_DIAGNOSTIC_CLASS_LABEL}`}
          </button>
          {stripResult && (
            <p id="crop-diagnostic-strip-result" role="status" className="text-[11px] font-semibold text-stone-700">
              {stripResult}
            </p>
          )}
          {stripError && (
            <p id="crop-diagnostic-strip-error" role="status" className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
              {stripError}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default CropDiagnosticPanel;
