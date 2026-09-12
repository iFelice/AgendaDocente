/**
 * Matching LOCALE dei nomi alunni (client-side, nessun invio al cloud).
 *
 * Normalizzazione: minuscole, accenti rimossi, punteggiatura/spazi collassati.
 * L'ordine "Cognome Nome" / "Nome Cognome" è gestito confrontando le parti
 * separate, non la stringa intera.
 *
 * Livelli:
 * - exact:     stesso nome completo (ordine indifferente);
 * - probable:  cognome identico + nome (o iniziale) coerente, al massimo un
 *             carattere di differenza sul cognome (refuso), UN solo candidato;
 * - ambiguous: più candidati con lo stesso punteggio migliore;
 * - unmatched: nessun candidato plausibile.
 *
 * Il matching è volutamente NON aggressivo: niente fuzzy su nomi interi,
 * niente creazione automatica di nuovi studenti, nessun punteggio inventato
 * oltre i casi espliciti sopra.
 */

export type StudentMatchStatus = "exact" | "probable" | "ambiguous" | "unmatched";

export interface StudentMatchCandidate {
  id: string;
  fullName: string;
  confidence: number;
}

export interface StudentMatch {
  status: StudentMatchStatus;
  matchedStudentId?: string;
  matchConfidence?: number;
  candidates: StudentMatchCandidate[];
}

/** Fold case-insensitive e accent-insensitive; la punteggiatura diventa spazio. */
export function foldName(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.\-'"’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface ParsedName {
  surname: string;
  given: string;
}

/**
 * Separa cognome/nome in modo conservativo.
 * Gestisce "Nome Cognome", "Cognome Nome" e la forma registro "Cognome N."
 * (iniziale singola alla fine -> il cognome è la PRIMA parte).
 */
export function parsePersonName(raw: unknown): ParsedName {
  const parts = foldName(raw).split(" ").filter(Boolean);
  if (parts.length === 0) return { surname: "", given: "" };
  if (parts.length === 1) return { surname: parts[0], given: "" };
  // "ROSSI M." -> cognome "rossi", iniziale "m"
  if (parts[parts.length - 1].length === 1 && parts[0].length > 1) {
    return { surname: parts[0], given: parts.slice(1).join(" ") };
  }
  // "M. ROSSI" -> cognome "rossi", iniziale "m"
  if (parts[0].length === 1 && parts[parts.length - 1].length > 1) {
    return { surname: parts[parts.length - 1], given: parts.slice(0, -1).join(" ") };
  }
  return { surname: parts[parts.length - 1], given: parts.slice(0, -1).join(" ") };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export interface MatchableStudent {
  id: string;
  fullName: string;
}

interface NameInterpretation {
  surname: string;
  given: string;
}

/**
 * Le due letture possibili di un nome a più parti ("Nome Cognome" e
 * "Cognome Nome"): il confronto le considera entrambe, in modo che
 * "Rossi Matteo" e "matteo rossi" coincidano senza guessing aggressivo.
 */
function nameInterpretations(parts: string[]): NameInterpretation[] {
  const primary = parsePersonName(parts.join(" "));
  const out: NameInterpretation[] = [{ surname: primary.surname, given: primary.given }];
  const swapped = { surname: primary.given, given: primary.surname };
  if (primary.surname !== primary.given && primary.surname !== "" && primary.given !== "") out.push(swapped);
  return out;
}

/** Punteggio (0..1) tra due interpretazioni di nome; 0 = niente. */
function scorePair(raw: NameInterpretation, target: NameInterpretation): number {
  if (raw.surname === target.surname && raw.given === target.given && raw.given !== "") return 1;
  if (raw.surname === target.surname && raw.given !== "" && target.given !== "") {
    if (raw.given[0] === target.given[0]) return 0.85; // cognome + iniziale
    if (levenshtein(raw.given, target.given) <= 1 && Math.min(raw.given.length, target.given.length) >= 4) return 0.75; // refuso sul nome
  }
  if (raw.surname === target.surname && raw.given === "") return 0.8; // solo cognome nel documento
  if (
    raw.surname !== target.surname &&
    raw.surname.length >= 4 &&
    target.surname.length >= 4 &&
    levenshtein(raw.surname, target.surname) <= 1 &&
    (raw.given === "" || (target.given !== "" && (raw.given[0] === target.given[0] || levenshtein(raw.given, target.given) <= 1)))
  ) {
    return 0.7; // refuso sul cognome, nome coerente o assente
  }
  return 0;
}

/**
 * Confronta un nome estratto da un documento con l'elenco alunni locale.
 * Non genera mai nuovi studenti: al massimo indica chi è (probabilmente) lui.
 */
export function matchStudentName(raw: string, students: MatchableStudent[]): StudentMatch {
  const rawParts = foldName(raw).split(" ").filter(Boolean);
  if (!rawParts.length) return { status: "unmatched", candidates: [] };
  const rawInterps = nameInterpretations(rawParts);

  const scored: StudentMatchCandidate[] = [];
  for (const student of students) {
    const studentParts = foldName(student.fullName).split(" ").filter(Boolean);
    if (!studentParts.length) continue;

    let confidence = 0;
    // Exact: stesso insieme di parti, ordine indifferente.
    if (rawParts.length === studentParts.length && [...rawParts].sort().join(" ") === [...studentParts].sort().join(" ")) {
      confidence = 1;
    }
    for (const rawInterp of rawInterps) {
      for (const targetInterp of nameInterpretations(studentParts)) {
        confidence = Math.max(confidence, scorePair(rawInterp, targetInterp));
      }
    }

    if (confidence > 0) scored.push({ id: student.id, fullName: student.fullName, confidence });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  const best = scored[0];
  if (!best) return { status: "unmatched", candidates: [] };
  if (best.confidence >= 1) {
    return { status: "exact", matchedStudentId: best.id, matchConfidence: 1, candidates: scored };
  }
  const tied = scored.filter(c => c.confidence === best.confidence);
  if (tied.length > 1) {
    return { status: "ambiguous", matchConfidence: best.confidence, candidates: tied };
  }
  return { status: "probable", matchedStudentId: best.id, matchConfidence: best.confidence, candidates: scored };
}

/** Etichetta leggibile per il semaforo di matching (UI). */
export function studentMatchLabel(match: StudentMatch): string {
  switch (match.status) {
    case "exact":
      return "Corrispondenza certa";
    case "probable":
      return "Corrispondenza probabile";
    case "ambiguous":
      return "Più alunni possibili";
    default:
      return "Alunno non riconosciuto";
  }
}
