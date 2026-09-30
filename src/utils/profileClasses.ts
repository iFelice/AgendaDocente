import type { TeacherProfile, TimetableSlot } from "../types";
import { normalizeClassName } from "./timeSlots";

/**
 * Classi presenti negli slot importabili ma non ancora nel Profilo.
 *
 * Input intenzionale: TimetableSlot gia finali/importabili, non righe OCR grezze.
 * In questo modo slot deselezionati, scartati o privi di classe restano fuori a
 * monte e non producono avvisi. Il confronto e conservativo: trim + uppercase,
 * senza fuzzy matching o normalizzazioni specifiche dello scanner.
 */
export function importedClassesMissingFromProfile(
  profile: Pick<TeacherProfile, "classes">,
  slots: readonly Pick<TimetableSlot, "className">[],
): string[] {
  const known = new Set((profile.classes ?? []).map(normalizeClassName).filter(Boolean));
  const detected = new Set<string>();
  const missing: string[] = [];

  for (const slot of slots) {
    const normalized = normalizeClassName(slot.className ?? "");
    if (!normalized || known.has(normalized) || detected.has(normalized)) continue;
    detected.add(normalized);
    missing.push(normalized);
  }

  return missing;
}

/**
 * Aggiunge classi al Profilo preservando l'ordine esistente, senza duplicati
 * case-insensitive/trim. Le classi nuove vengono salvate in forma canonica
 * (trim + uppercase), coerente con il resto dell'orario.
 */
export function appendProfileClasses(
  existingClasses: readonly string[],
  classesToAdd: readonly string[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of existingClasses) {
    const normalized = normalizeClassName(value ?? "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(String(value).trim());
  }

  for (const value of classesToAdd) {
    const normalized = normalizeClassName(value ?? "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}
