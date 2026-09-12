/**
 * Motore "Ricostruisci il mio orario": incrocio multi-documento.
 *
 * Per ogni slot personale (giorno + periodo + classe) cerca nello slot
 * curricolare: stesso giorno + stesso periodo + stessa classe (normalizzata).
 *
 * Semaforo (mai inventare):
 * - VERDE  (unique/high)   -> una sola materia compatibile;
 * - GIALLO (unique/medium) -> OCR ambiguo / cella poco chiara;
 * - GIALLO (ambiguous)     -> più materie possibili;
 * - ROSSO/GRIGIO (none)    -> nessuna materia identificabile
 *                              ("Materia non identificata").
 *
 * Il nome del docente curricolare NON è necessario e NON viene salvato.
 */

import { sameSubject } from "./subjects";
import type { CurricularTimetableSlot, PersonalTimetableSlotCandidate } from "./timetableAnalysis";

export type ReconStatus = "unique" | "ambiguous" | "none";

export interface ReconstructedSlot {
  id: string;
  dayOfWeek: number;
  periodIndex: number;
  classLabel?: string;
  /** Materie curricolari in compresenza (vuoto se non identificabili). */
  coTeachingSubjects: string[];
  status: ReconStatus;
  confidence: "high" | "medium" | "low";
  note?: string;
  selected: boolean;
}

/** Confronto classi normalizzato: "3d" === "3 D" === "3D". */
export function sameClassLabel(a: string, b: string): boolean {
  const fold = (v: string) => v.toUpperCase().replace(/\s+/g, "").replace(/[\^°ª]/g, "");
  return fold(a) === fold(b);
}

/** De-duplicazione materie indifferente a maiuscole/accenti ("matematica" ~ "Matematica"). */
export function dedupeSubjects(subjects: Array<string | undefined>): string[] {
  const result: string[] = [];
  for (const raw of subjects) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    if (!result.some(existing => sameSubject(existing, value))) result.push(value);
  }
  return result;
}

export const RECON_NOTES = {
  none: "Materia non identificata",
  noClass: "Classe non identificata nella cella",
  ambiguous: "Più materie possibili",
} as const;

/**
 * Incrocio principale. I candidati personali in ingresso sono quelli già
 * confermati dall'utente (o comunque selezionati); l'incrocio NON aggiunge
 * slot: ogni output corrisponde 1:1 a uno slot personale.
 */
export function crossrefTimetables(
  personal: PersonalTimetableSlotCandidate[],
  curricular: CurricularTimetableSlot[]
): ReconstructedSlot[] {
  return personal.map(candidate => {
    const base = {
      id: candidate.id,
      dayOfWeek: candidate.dayOfWeek,
      periodIndex: candidate.periodIndex,
      classLabel: candidate.classLabel,
      selected: true,
    };

    if (!candidate.classLabel) {
      return { ...base, coTeachingSubjects: [], status: "none", confidence: "low", note: RECON_NOTES.noClass };
    }

    // Stesso giorno + stesso periodo + stessa classe (normalizzata).
    const matches = curricular.filter(c =>
      c.dayOfWeek === candidate.dayOfWeek &&
      c.periodIndex === candidate.periodIndex &&
      sameClassLabel(c.classLabel, candidate.classLabel!)
    );

    if (matches.length === 0) {
      return { ...base, coTeachingSubjects: [], status: "none", confidence: "low", note: RECON_NOTES.none };
    }

    const subjects = dedupeSubjects(matches.map(m => m.subject));
    if (subjects.length === 0) {
      return { ...base, coTeachingSubjects: [], status: "none", confidence: "low", note: RECON_NOTES.none };
    }

    if (subjects.length === 1) {
      // Ambiguità residua dall'OCR (cella poco chiara) abbassa la confidenza.
      const ambiguousSource = candidate.confidence === "low" || matches.some(m => m.confidence === "low");
      return {
        ...base,
        coTeachingSubjects: subjects,
        status: "unique",
        confidence: ambiguousSource ? "medium" : "high",
      };
    }

    return {
      ...base,
      coTeachingSubjects: subjects,
      status: "ambiguous",
      confidence: "medium",
      note: RECON_NOTES.ambiguous,
    };
  });
}

/** Mappa lo stato sul semaforo UI (verde/giallo/rosso). */
export function reconSignal(slot: Pick<ReconstructedSlot, "status" | "confidence">): "green" | "yellow" | "red" {
  if (slot.status === "unique" && slot.confidence === "high") return "green";
  if (slot.status === "none") return "red";
  return "yellow";
}
