/**
 * Subject ("materia") helpers shared by the co-teaching pickers and the timetable flows.
 *
 * A single source of truth for the predefined subject list keeps suggestions coherent
 * everywhere (compresenza, future directory of school subjects, …) and lets the pickers
 * normalize free text against the canonical spellings.
 */

/** Predefined curricular subjects offered as suggestions (free text is always allowed). */
export const DEFAULT_SUBJECTS: readonly string[] = [
  "Italiano",
  "Matematica",
  "Scienze",
  "Inglese",
  "Francese",
  "Spagnolo",
  "Storia",
  "Geografia",
  "Tecnologia",
  "Arte e immagine",
  "Musica",
  "Educazione fisica",
  "Religione",
  "Sostegno",
];

/**
 * Case- and accent-insensitive fold used for de-duplication and canonical matching.
 * "matematica", "Matematica" and "MATEMATICA" all fold to the same key, as do
 * "Perché" and "perche".
 */
export function foldSubject(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("it")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when two subject strings are the same subject (ignoring case, accents, extra spaces). */
export function sameSubject(a: unknown, b: unknown): boolean {
  return foldSubject(a) === foldSubject(b);
}

/**
 * Normalize a subject typed by the user:
 * - whitespace is collapsed and trimmed;
 * - when it matches a predefined subject (case/accent-insensitively) the canonical
 *   spelling is returned ("matematica" -> "Matematica");
 * - otherwise the text is preserved (only the first letter is capitalized), so custom
 *   subjects such as "Storia dell'arte" keep their natural casing.
 */
export function normalizeSubjectName(raw: unknown): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const canonical = DEFAULT_SUBJECTS.find((subject) => sameSubject(subject, text));
  if (canonical) return canonical;
  return text.charAt(0).toLocaleUpperCase("it-IT") + text.slice(1);
}

/**
 * Merge several subject sources into one de-duplicated suggestion list, preserving the
 * source order (defaults first, then profile subjects, then subjects already used).
 */
export function mergeSubjectSuggestions(...sources: Array<readonly string[] | undefined | null>): string[] {
  const merged: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const value of source) {
      const clean = String(value ?? "").replace(/\s+/g, " ").trim();
      if (!clean) continue;
      if (!merged.some((existing) => sameSubject(existing, clean))) merged.push(clean);
    }
  }
  return merged;
}
