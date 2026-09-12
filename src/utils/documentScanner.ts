/**
 * Helper file per il flusso "Scansiona documento" (mobile-first).
 *
 * Privacy:
 *  - la preview usa object URL revocati dopo l'uso (revokePreviewUrl);
 *  - il base64 esiste solo in memoria durante l'invio all'endpoint di analisi;
 *  - nessuna persistenza (niente IndexedDB/Firestore/backup/Storage).
 */

export const SUPPORTED_DOCUMENT_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024; // coerente con il limite server

export interface DocumentFileMeta {
  name: string;
  size: number;
  type: string;
}

/** Errore (o null) per un file non adatto al flusso di scansione. */
export function documentFileError(file: DocumentFileMeta): string | null {
  const isImage = file.type.startsWith("image/");
  if (!isImage && file.type !== "application/pdf") {
    return "Formato non supportato. Usa una foto (JPEG, PNG, WebP) o un PDF.";
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return "Documento troppo grande: massimo 5 MB.";
  }
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Input "Scatta foto": fotocamera posteriore preferita (capture=environment).
 * Dove `capture` non è supportato (desktop) lo stesso input degrada
 * elegantemente al file picker: nessun crash.
 */
export const CAMERA_INPUT_PROPS = {
  accept: "image/*",
  capture: "environment",
} as const;

/** Input "Scegli foto o file": immagini e PDF. */
export const FILE_INPUT_PROPS = {
  accept: "image/*,application/pdf",
} as const;

/**
 * Legge un file come base64 puro (senza prefisso data:).
 * Usa FileReader in browser; fallback arrayBuffer in ambienti di test.
 */
export function readBlobAsBase64(blob: Blob): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Impossibile leggere il file."));
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(blob);
    });
  }
  return blob.arrayBuffer().then(buf => Buffer.from(buf).toString("base64"));
}

/** Crea l'object URL per la preview (undefined se non disponibile). */
export function createPreviewUrl(file: Blob): string | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return undefined;
  try {
    return URL.createObjectURL(file);
  } catch {
    return undefined;
  }
}

/** Revoca l'object URL della preview: chiamata sempre dopo l'uso. */
export function revokePreviewUrl(url: string | undefined): void {
  if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Nessun oggetto da rilasciare: ignora.
  }
}

/** Connessione disponibile per l'analisi cloud (scatto/selezione restano offline). */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

export const OFFLINE_ANALYSIS_MESSAGE =
  "L'analisi intelligente richiede una connessione Internet.";
