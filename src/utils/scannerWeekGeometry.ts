/**
 * STRUTTURA DELLA SETTIMANA proposta allo scanner dell'orario personale.
 *
 * Unico punto in cui la geometria settimanale dello scanner viene DERIVATA da
 * una scuola: qui si decide da quale `SchoolProfile` nasce il prefill. Oggi è
 * sempre la scuola primaria del profilo (come C1/C2/D1/D2); quando il multi-
 * istituto arriverà davvero, passare la scuola selezionata per l'import sarà
 * una sola modifica nel chiamante, non una caccia alle occorrenze.
 *
 * Confine concettuale (da non confondere, sono tre cose diverse):
 *  - FASCE ORARIE (`TimeSlotConfig`): a che ora suona la campana e quanto dura
 *    un'ora. Non dicono quante ore ha il giovedì.
 *  - STRUTTURA DELLA SETTIMANA (questo modulo): quante ore ha ciascun giorno
 *    secondo la scuola. È ciò che serve allo scanner per sapere quante celle
 *    aspettarsi in ogni blocco giornaliero.
 *  - ORE EFFETTIVE del docente: quante di quelle posizioni sono sue. Non
 *    riguarda questo modulo: lo scanner deve leggere anche le celle vuote.
 *
 * Funzione pura, nessuno stato, nessuna persistenza: il risultato è una
 * proposta effimera che l'utente conferma o corregge per la singola scansione.
 */

import type { SchoolProfile, SchoolWeekday, TimeSlotConfig } from "../types";
import { periodsByDay } from "./schoolDayPeriods";
import {
  normalizePersonalPeriodsByDay,
  uniformPersonalPeriodsByDay,
  type PersonalTimetablePeriodsByDay,
} from "./timetableAnalysis";

/**
 * I giorni dello scanner, nell'ordine delle colonne del documento: lunedì →
 * venerdì. Stesso ordine degli indici di `PersonalTimetablePeriodsByDay` e dei
 * blocchi `days[]` chiesti al modello: è l'unico ordine ammesso dal contratto.
 */
export const PERSONAL_SCANNER_DAYS: readonly SchoolWeekday[] = [1, 2, 3, 4, 5];

/**
 * Ore di ogni giorno della settimana secondo la scuola indicata.
 *
 * Retrocompatibilità: con una scuola senza `dayPeriods` — o senza scuola —
 * `periodsForDay` risponde lo STESSO numero per tutti i giorni, cioè le fasce
 * effettive della configurazione oraria (6 col default dell'app). Il fallback
 * non è duplicato qui: arriva tutto da `schoolDayPeriods`, così scanner, griglia
 * e viste Oggi/Settimana non possono divergere sul significato di "quante ore
 * ha questo giorno".
 *
 * @returns sempre 5 valori interi validi (lun→ven); mai `null`, perché
 * `periodsForDay` è già clampata dentro `1..MAX_PERIODS_PER_DAY`.
 */
export function derivePersonalScannerPeriodsByDay(
  school?: Pick<SchoolProfile, "dayPeriods">,
  timeSlotConfig?: TimeSlotConfig,
): PersonalTimetablePeriodsByDay {
  const derived = periodsByDay(PERSONAL_SCANNER_DAYS, school, timeSlotConfig);
  // Il clamp a monte garantisce valori ammessi; la normalizzazione resta come
  // rete (tetto dello scanner diverso da quello di dominio, un giorno).
  return normalizePersonalPeriodsByDay(derived)
    ?? uniformPersonalPeriodsByDay(derived[0])
    ?? ([1, 1, 1, 1, 1] as const);
}
