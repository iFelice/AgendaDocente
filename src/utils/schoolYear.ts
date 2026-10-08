/**
 * Utility per il calcolo e la gestione dell'Anno Scolastico italiano.
 * 
 * Regola:
 * - A partire dal 1° Agosto (mese >= 7): l'anno scolastico è l'anno solare corrente / anno successivo.
 *   Esempio: il 28 agosto 2026 (o settembre 2026) -> "2026/2027"
 * - Prima del 1° Agosto (1 gennaio - 31 luglio): l'anno scolastico è l'anno precedente / anno corrente.
 *   Esempio: il 15 marzo 2026 -> "2025/2026"
 */

export function getCurrentSchoolYear(referenceDate: Date = new Date()): string {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth(); // 0 = Gennaio, 7 = Agosto, 11 = Dicembre

  if (month >= 7) {
    // Dal 1° Agosto in poi
    return `${year}/${year + 1}`;
  } else {
    // Fino al 31 Luglio
    return `${year - 1}/${year}`;
  }
}

/** Inizio e fine dell'anno scolastico, come date civili locali ISO (AAAA-MM-GG). */
export interface SchoolYearBoundaries {
  /** 1 settembre del primo anno dell'anno scolastico. */
  start: string;
  /** 31 agosto del secondo anno dell'anno scolastico. */
  end: string;
}

/**
 * UNICA fonte dei confini dell'anno scolastico: `"AAAA/AAAA"` → 1 settembre del primo
 * anno e 31 agosto del secondo, come date civili locali (`AAAA-MM-GG`), mai istanti UTC.
 *
 * Un valore mancante, malformato o non consecutivo (es. `"2026/2028"`, `"2025/26"`, `""`)
 * viene trattato come assente: si usa l'anno scolastico corrente, con la regola già
 * esistente in `getCurrentSchoolYear`. Nessun altro modulo deve ricalcolare questi confini.
 */
export function getSchoolYearBoundaries(
  schoolYear?: string | null,
  referenceDate: Date = new Date(),
): SchoolYearBoundaries {
  const raw = typeof schoolYear === "string" ? schoolYear.trim() : "";
  const match = /^(\d{4})\/(\d{4})$/.exec(raw);
  const firstYear = match && Number(match[2]) === Number(match[1]) + 1
    ? match[1]
    : getCurrentSchoolYear(referenceDate).split("/")[0];
  const startYear = Number(firstYear);
  return {
    start: `${firstYear}-09-01`,
    end: `${startYear + 1}-08-31`,
  };
}

/**
 * Fornisce una lista di opzioni di anni scolastici per suggerimenti rapidi (precedente, corrente, successivo).
 */
export function getSuggestedSchoolYears(referenceDate: Date = new Date()): string[] {
  const current = getCurrentSchoolYear(referenceDate);
  const [startYear] = current.split("/").map(Number);

  return [
    `${startYear - 1}/${startYear}`,
    current,
    `${startYear + 1}/${startYear + 2}`,
  ];
}
