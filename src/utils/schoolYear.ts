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
