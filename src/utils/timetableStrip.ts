/**
 * Lettura di UNA strip curricolare: `[MATERIA] | [UNA COLONNA ORARIA]`.
 *
 * La strip è già stata ritagliata e composta dal client: il modello vede SOLO la
 * colonna MATERIA e la singola colonna oraria di interesse, quindi non può
 * leggere altre classi in altre ore. Questo modulo classifica la sua risposta.
 *
 * REGOLA DI FONDO (la stessa introdotta in `6448910` per l'analisi curricolare):
 * un match esiste SOLO se la cella letta contiene davvero la classe richiesta.
 * La verifica riusa `curricularCellTextContainsClass`, cioè la stessa
 * normalizzazione delle celle reali, così request, celle personali e strip non
 * possono divergere su cosa sia "la cella contiene 3D".
 *
 * NON c'è alcun recupero: se la classe non compare, l'esito è `none`. Non si
 * inferisce una materia, non si guarda la riga sopra o sotto, non si compensano
 * celle vuote.
 */

import { curricularCellTextContainsClass, MAX_CURRICULAR_CELL_TEXT_LENGTH } from "./timetableAnalysis";
import { isGenericSubject } from "./circularRelevance";
import { sameSubject } from "./subjects";

/** Esito della lettura di una strip per una classe richiesta. */
export type StripMatchOutcome = "none" | "unique" | "ambiguous";

/** Un match accettato: la materia esiste solo insieme alla cella da cui è letta. */
export interface StripMatch {
  cellText: string;
  subject: string;
}

export interface StripMatchClassification {
  outcome: StripMatchOutcome;
  /** Materie dei soli match validi, nell'ordine in cui sono state lette. */
  subjects: string[];
  /** Quanti match hanno superato la verifica della classe nella cella. */
  acceptedMatches: number;
  /** Quanti elementi sono stati scartati perché la cella non contiene la classe. */
  rejectedMatches: number;
}

/** Tetto strutturale: una colonna oraria non può contenere decine di classi. */
export const MAX_STRIP_MATCHES = 6;
/** Lunghezza massima di una materia letta dalla colonna MATERIA. */
export const MAX_STRIP_SUBJECT_LENGTH = 80;

/** Forma della risposta non conforme: rifiuto esplicito, mai accettazione tacita. */
export class TimetableStripShapeError extends Error {
  readonly code: string;
  constructor(message: string, code = "strip-forma-non-valida") {
    super(message);
    this.name = "TimetableStripShapeError";
    this.code = code;
  }
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const boundedText = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

/**
 * Classifica la risposta del modello su una strip.
 *
 * - `matches` assente, non array o troppo lungo -> rifiuto (forma non valida);
 * - `cellText` mancante o non stringa è fuori contratto (rifiuto); una cella
 *   VUOTA invece è semplicemente assenza di prova, quindi il match è scartato:
 *   distinguere "non c'è" da "non ho capito" resta possibile senza accettare
 *   una materia priva della cella che la giustifica;
 * - `subject` mancante, vuoto o troppo lungo è fuori contratto (rifiuto);
 * - un match è VALIDO solo se `cellText` contiene la classe richiesta: "3D 3E"
 *   vale per 3D, mentre "3E" e "" no;
 * - materia vuota, generica o già presente viene tolta (due righe che riportano
 *   la stessa materia non sono un'ambiguità);
 * - 0 validi -> `none`, 1 -> `unique`, più di 1 -> `ambiguous`.
 *
 * Funzione PURA: nessuna rete, nessun contenuto persistito, nessun log.
 */
export function classifyStripMatches(classLabel: string, matches: unknown): StripMatchClassification {
  if (!Array.isArray(matches)) {
    throw new TimetableStripShapeError("Risposta della strip non valida: elenco delle celle assente.");
  }
  if (matches.length > MAX_STRIP_MATCHES) {
    throw new TimetableStripShapeError("Risposta della strip non valida: troppe celle dichiarate.");
  }
  const accepted: StripMatch[] = [];
  let rejectedMatches = 0;
  matches.forEach((match, index) => {
    if (!record(match)) throw new TimetableStripShapeError(`Risposta della strip non valida (cella #${index}).`);
    if (typeof match.cellText !== "string" || match.cellText.length > MAX_CURRICULAR_CELL_TEXT_LENGTH) {
      throw new TimetableStripShapeError(`Risposta della strip non valida (testo cella #${index}).`);
    }
    if (!boundedText(match.subject, MAX_STRIP_SUBJECT_LENGTH)) {
      throw new TimetableStripShapeError(`Risposta della strip non valida (materia #${index}).`);
    }
    // Evidenza obbligatoria: senza la classe nella cella il match non esiste.
    if (!curricularCellTextContainsClass(classLabel, match.cellText)) {
      rejectedMatches += 1;
      return;
    }
    const subject = match.subject.trim();
    if (isGenericSubject(subject)) return; // "materia", "disciplina": non è una disciplina
    if (accepted.some((existing) => sameSubject(existing.subject, subject))) return;
    accepted.push({ cellText: match.cellText, subject });
  });

  const outcome: StripMatchOutcome = accepted.length === 0 ? "none" : accepted.length === 1 ? "unique" : "ambiguous";
  return {
    outcome,
    subjects: accepted.map((match) => match.subject),
    acceptedMatches: accepted.length,
    rejectedMatches,
  };
}

/**
 * Diagnostica PRIVACY-SAFE di un esito strip.
 *
 * Escono SOLO esito e conteggi: mai la classe cercata, mai `cellText`, mai la
 * materia, mai testo OCR. È l'unica informazione che arriva nei log del server.
 */
export function describeStripOutcome(classification: StripMatchClassification): string {
  return `esitoStrip=${classification.outcome} numeroMatch=${classification.acceptedMatches} scartati=${classification.rejectedMatches}`;
}

/**
 * Messaggio per l'utente della UI diagnostica: solo classe richiesta e materie.
 *
 * Accetta la forma minima (`outcome` + `subjects`) così il client può usarla con
 * la risposta HTTP senza ricostruire i conteggi interni.
 */
export function stripOutcomeMessage(
  classLabel: string,
  classification: Pick<StripMatchClassification, "outcome" | "subjects">,
): string {
  if (classification.outcome === "none") return `${classLabel} non presente nella colonna richiesta`;
  return `${classLabel} → ${classification.subjects.join(", ")}`;
}
