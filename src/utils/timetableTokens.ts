/**
 * Normalizzazione esplicita dei token che compaiono nelle tabelle orario.
 *
 * Le celle delle tabelle orari scolastici possono contenere valori che NON sono
 * classi:
 *  - "sos"           -> indicatore di sostegno;
 *  - "D" / "P" / "Co"-> codici interni (es. piano, compresenza, coordinamento);
 *  - "3D", "3 E", "3ª", "III D" -> classi vere.
 *
 * Regola conservativa: un token è una classe SOLO se corrisponde al pattern
 * esplicito numero(1-5 o romano I-V) + lettera A-Z. Qualsiasi altro token
 * alfanumerico (D, P, Co, 3D4, MATEMATICA…) NON viene mai interpretato come
 * classe: viene classificato come codice interno o testo non riconosciuto.
 */

export type TimetableTokenKind = "class" | "support" | "internal-code" | "other";

export interface TimetableToken {
  raw: string;
  kind: TimetableTokenKind;
  /** Popolato solo quando kind === "class". */
  classLabel?: string;
}

const ROMAN_TO_GRADE: Record<string, string> = { I: "1", II: "2", III: "3", IV: "4", V: "5" };

/** Indicatori di sostegno riconosciuti in una cella (case/accenti indifferenti). */
const SUPPORT_TOKENS = new Set(["sos", "sostegno", "sost", "soc"]);

/**
 * Normalizza un token in una sigla di classe ("3d" -> "3D", "3 E" -> "3D",
 * "classe 3ª" -> "3") oppure null quando il token NON è una classe.
 *
 * È volutamente conservativa: numeri romani e decorazioni (°, ª, ^) sono
 * accettati, ma un token senza lettera (es. "3ª") o con testo extra (es. "3D4")
 * non è mai una classe.
 */
export function normalizeClassLabel(raw: unknown): string | null {
  let text = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!text) return null;
  text = text.replace(/^(?:CLASSE|CLASSI|CL\.|SEZ\.|SEZIONE)\s+/, "").trim();
  if (!text) return null;
  // Arabic: "3D", "3 D", "3^D", "3ªD", "3°D"
  const arabic = /^([1-5])(?:\s*[\^°ª]\s*|\s+|\s*)([A-Z])$/.exec(text);
  if (arabic) return `${arabic[1]}${arabic[2]}`;
  // Roman: "III D", "I^A"
  const roman = /^(I|II|III|IV|V)(?:\s*[\^°ª]\s*|\s+|\s*)([A-Z])$/.exec(text);
  if (roman) {
    const grade = ROMAN_TO_GRADE[roman[1]];
    if (grade && roman[1] !== roman[2]) return `${grade}${roman[2]}`; // "IA" is class 1A; "II" alone never is
    if (grade && text.length > 2) return `${grade}${roman[2]}`;
    return null;
  }
  return null;
}

function isSupportToken(text: string): boolean {
  const folded = text.toLowerCase().replace(/\s+/g, "").replace(/\./g, "");
  return SUPPORT_TOKENS.has(folded);
}

/**
 * Classifica un singolo token di tabella.
 *
 * - "class":         sigla di classe esplicita (3D, 1A, III E…);
 * - "support":       indicatore sostegno ("sos", "sostegno", "sost");
 * - "internal-code": 1-3 lettere senza cifra (D, P, Co): codice interno, mai una classe;
 * - "other":         qualsiasi altro testo (materie, parole, sigle non riconosciute).
 */
export function classifyTimetableToken(raw: unknown): TimetableToken {
  const text = String(raw ?? "").trim();
  if (!text) return { raw: text, kind: "other" };
  const classLabel = normalizeClassLabel(text);
  if (classLabel) return { raw: text, kind: "class", classLabel };
  if (isSupportToken(text)) return { raw: text, kind: "support" };
  if (/^[A-Za-z]{1,3}$/.test(text)) return { raw: text, kind: "internal-code" };
  return { raw: text, kind: "other" };
}

/**
 * Estrae TUTTE le classi valide contenute in una cella o in un'intestazione
 * (es. "3D 3E" -> ["3D","3E"], "3D / sos" -> ["3D"]). I token non validi
 * (D, P, Co, sos…) sono ignorati, mai trasformati.
 */
export function extractClassesFromCell(raw: unknown): string[] {
  const text = String(raw ?? "");
  if (!text) return [];
  const found: string[] = [];
  for (const part of text.split(/[\s/;,+|]+/)) {
    const label = normalizeClassLabel(part);
    if (label && !found.includes(label)) found.push(label);
  }
  return found;
}

/** Day-of-week labels used across the app (1 = Lunedì … 6 = Sabato). */
export const DAY_LABELS: Record<number, string> = {
  1: "Lunedì",
  2: "Martedì",
  3: "Mercoledì",
  4: "Giovedì",
  5: "Venerdì",
  6: "Sabato",
};
