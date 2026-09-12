/**
 * Client delle endpoint di analisi documenti ("Scansiona documento").
 *
 * Privacy:
 *  - l'immagine/PDF (base64) vive solo in memoria ed è inviata all'endpoint;
 *  - dopo la risposta il chiamante DEVE scartare il base64 (niente persistenza);
 *  - errori generici: nessun contenuto del documento nei messaggi o nei log.
 */

import type { TeacherProfile } from "../types";
import { OFFLINE_ANALYSIS_MESSAGE, isOnline } from "../utils/documentScanner";

export type ScanTimetableDocumentType = "personal-support-timetable" | "curricular-timetable";

export interface ScanTimetableRequest {
  imageBase64: string;
  mimeType: string;
  documentType: ScanTimetableDocumentType;
  profile: TeacherProfile;
}

export interface ScanTimetableResult {
  success: boolean;
  source?: string;
  error?: string;
  /** Righe della colonna docenti (orario personale). */
  rows?: string[];
  /** Righe docente curricolare: label/materia/classi (orario curricolare). */
  curricularRows?: Array<{ rowIndex: number; rowLabel?: string; subject?: string; classes?: string[] }>;
  /** Celle grezze della griglia giorno/periodo (validate a runtime). */
  cells?: Array<{ rowIndex: number; dayOfWeek: number; periodIndex: number; raw: string }>;
}

export interface ScanStudentDocumentRequest {
  imageBase64: string;
  mimeType: string;
  profile: TeacherProfile;
}

export interface ScanStudentDocumentResult {
  success: boolean;
  source?: string;
  error?: string;
  commitments?: unknown[];
}

class OfflineAnalysisError extends Error {
  constructor() {
    super(OFFLINE_ANALYSIS_MESSAGE);
    this.name = "OfflineAnalysisError";
  }
}

async function postScan(endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  if (!isOnline()) throw new OfflineAnalysisError();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    // Rete assente (o interrotta a metà): messaggio chiaro, nessun contenuto.
    if (!isOnline()) throw new OfflineAnalysisError();
    throw new Error("Impossibile raggiungere il servizio di analisi. Riprova.");
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || data.success !== true) {
    throw new Error(typeof data.error === "string" && data.error ? data.error : "Analisi non riuscita. Riprova.");
  }
  return data;
}

/** Analizza una foto/PDF di un orario (personale o curricolare). */
export async function analyzeTimetableDocument(req: ScanTimetableRequest): Promise<ScanTimetableResult> {
  const data = await postScan("/api/analyze-timetable", req);
  const result: ScanTimetableResult = {
    success: true,
    source: typeof data.source === "string" ? data.source : undefined,
    cells: Array.isArray(data.cells) ? (data.cells as ScanTimetableResult["cells"]) : [],
  };
  if (Array.isArray(data.rows)) result.rows = data.rows.map(String);
  if (Array.isArray(data.curricularRows)) result.curricularRows = data.curricularRows as ScanTimetableResult["curricularRows"];
  return result;
}

/** Analizza una foto/appunti di registro per estrarre impegni alunni. */
export async function analyzeStudentDocument(req: ScanStudentDocumentRequest): Promise<ScanStudentDocumentResult> {
  const data = await postScan("/api/analyze-student-document", req);
  return {
    success: true,
    source: typeof data.source === "string" ? data.source : undefined,
    commitments: Array.isArray(data.commitments) ? data.commitments : [],
  };
}
