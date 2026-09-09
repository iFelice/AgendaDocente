import type { ExtractedItem, TeacherProfile } from "../types";
import { parseCircularText, normalizeExtractedItems } from "../utils/circularParser";
export { parseCircularText as clientSideLocalParser } from "../utils/circularParser";

export interface AnalyzeRequest {
  text?: string; imageBase64?: string; mimeType?: string;
  profile: TeacherProfile; defaultLocation?: string;
}
export interface AnalyzeResult {
  success: boolean; source: string; items: ExtractedItem[]; error?: string;
}
export async function analyzeCircular(req: AnalyzeRequest): Promise<AnalyzeResult> {
  try {
    const response = await fetch("/api/analyze-circular", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req), signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) throw new Error(data.error || "Analisi non riuscita.");
    return { success: true, source: data.source || 'server', items: normalizeExtractedItems(data.items, req.profile, req.defaultLocation) };
  } catch (error) {
    if (req.imageBase64 || !req.text?.trim()) return {
      success: false, source: 'unavailable', items: [],
      error: "Foto e PDF richiedono il servizio di analisi online. Riprova con la connessione oppure incolla il testo del documento.",
    };
    return { success: true, source: 'offline-local', items: parseCircularText(req.text, req.profile, req.defaultLocation) };
  }
}
