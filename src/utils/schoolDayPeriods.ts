/**
 * QUANTE ore scolastiche ha ciascun giorno, secondo la configurazione
 * dell'ISTITUTO.
 *
 * Confine concettuale (da non confondere mai):
 *  - `TimeSlotConfig` descrive gli SLOT ORARI disponibili: a che ora suona la
 *    campana, quanto dura un'ora. È la griglia temporale del docente ed è
 *    uguale per tutti i giorni.
 *  - `SchoolProfile.dayPeriods` descrive QUANTI di quegli slot sono usati in
 *    ciascun giorno: è la struttura della giornata della SCUOLA.
 *  - `TeacherProfile.weeklyDeclaredHours` e `SchoolProfile.weeklyHours` sono il
 *    CARICO del docente e NON entrano in questo calcolo: un istituto può avere
 *    7 ore il giovedì anche se quel giorno il docente ne lavora 4.
 *
 * Funzioni pure, nessuno stato, nessun accesso a storage.
 */

import type { SchoolProfile, SchoolWeekday, TimeSlotConfig } from "../types";
import { getEffectivePeriodSlots } from "./timeSlots";

/**
 * Tetto di ore in un singolo giorno.
 *
 * Coincide con il limite già in vigore altrove nell'app: il clamp di
 * `generateDefaultPeriodSlots`, la validazione sync (`intWithin(periodsPerDay, 1, 12)`)
 * e `MAX_GRID_PERIODS` dello scanner. È ridichiarato qui — invece di importare
 * il modulo dello scanner — per non legare un'utility di dominio scuola alla
 * pipeline di analisi documenti; un test verifica che i due valori restino
 * allineati.
 */
export const MAX_PERIODS_PER_DAY = 12;

/** Minimo sensato: una giornata scolastica ha almeno un'ora. */
export const MIN_PERIODS_PER_DAY = 1;

const clamp = (value: number): number =>
  Math.min(MAX_PERIODS_PER_DAY, Math.max(MIN_PERIODS_PER_DAY, value));

/** Intero finito e positivo (niente NaN, Infinity, decimali, stringhe numeriche). */
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

/**
 * Ore ordinarie della giornata.
 *
 * Priorità:
 *  1. `school.dayPeriods.ordinaryPeriodsPerDay`, se è un intero >= 1;
 *  2. RETROCOMPATIBILITÀ: il numero di fasce effettive della configurazione
 *     oraria esistente, cioè `getEffectivePeriodSlots(timeSlotConfig).length`.
 *
 * Il fallback NON è la costante 6: esistono configurazioni legacy/custom con un
 * numero diverso di slot, e per quelle il comportamento deve restare IDENTICO a
 * oggi. Il 6 arriva comunque, ma solo perché è il default di
 * `getEffectivePeriodSlots(undefined)`.
 */
export function ordinaryPeriodsPerDay(
  school?: Pick<SchoolProfile, "dayPeriods">,
  timeSlotConfig?: TimeSlotConfig
): number {
  const declared = school?.dayPeriods?.ordinaryPeriodsPerDay;
  if (isPositiveInteger(declared)) return clamp(declared);
  return clamp(getEffectivePeriodSlots(timeSlotConfig).length);
}

/**
 * Ore AGGIUNTIVE dichiarate per un giorno.
 *
 * Qualsiasi valore non utilizzabile (assente, negativo, decimale, NaN, non
 * numerico) vale 0: una configurazione sporca non deve mai far sparire ore né
 * generarne di fantasma. Il valore non è clampato qui — il tetto è applicato
 * sulla somma da `periodsForDay`.
 */
export function extraPeriodsForDay(
  dayOfWeek: SchoolWeekday,
  school?: Pick<SchoolProfile, "dayPeriods">
): number {
  const extra = school?.dayPeriods?.extraPeriodsByDay?.[dayOfWeek];
  if (typeof extra !== "number" || !Number.isInteger(extra) || extra <= 0) return 0;
  return extra;
}

/**
 * Ore scolastiche di UN giorno: ordinarie + aggiuntive di quel giorno,
 * limitate al tetto giornaliero.
 *
 * Con `school` assente, o senza `dayPeriods`, il risultato è lo stesso numero
 * di ore per ogni giorno, esattamente come si comportava l'app prima di questo
 * modello.
 */
export function periodsForDay(
  dayOfWeek: SchoolWeekday,
  school?: Pick<SchoolProfile, "dayPeriods">,
  timeSlotConfig?: TimeSlotConfig
): number {
  const base = ordinaryPeriodsPerDay(school, timeSlotConfig);
  return clamp(base + extraPeriodsForDay(dayOfWeek, school));
}

/**
 * Ore scolastiche dei giorni richiesti, NELLO STESSO ORDINE.
 *
 * L'elenco dei giorni è deciso dal chiamante (lunedì-venerdì, con o senza
 * sabato): questa utility non decide quali giorni esistono, risponde solo su
 * quelli che le vengono passati. Duplicati e ordini non crescenti sono
 * rispettati così come arrivano.
 */
export function periodsByDay(
  days: readonly SchoolWeekday[],
  school?: Pick<SchoolProfile, "dayPeriods">,
  timeSlotConfig?: TimeSlotConfig
): number[] {
  const base = ordinaryPeriodsPerDay(school, timeSlotConfig);
  return days.map(day => clamp(base + extraPeriodsForDay(day, school)));
}

/**
 * Il giorno più lungo della settimana considerata: quante righe/fasce servono
 * per coprire tutti i giorni (6/6/6/7/6 → 7).
 *
 * Con un elenco di giorni vuoto non c'è nessun giorno più lungo: si restituisce
 * il numero ordinario, mai 0.
 */
export function maxPeriodsInWeek(
  days: readonly SchoolWeekday[],
  school?: Pick<SchoolProfile, "dayPeriods">,
  timeSlotConfig?: TimeSlotConfig
): number {
  const base = ordinaryPeriodsPerDay(school, timeSlotConfig);
  if (days.length === 0) return base;
  return periodsByDay(days, school, timeSlotConfig).reduce((max, n) => (n > max ? n : max), 0);
}

/**
 * Testi UNICI della marcatura "fuori configurazione", condivisi fra griglia,
 * Oggi e Settimana: la stessa situazione non deve essere descritta con parole
 * diverse a seconda della vista.
 */
export const OUT_OF_CONFIG_SLOT_TITLE = "Ora non prevista dalla configurazione della scuola";
export const OUT_OF_CONFIG_SLOT_BADGE = "Ora non prevista";

/**
 * La lezione occupa un'ora che il suo giorno NON prevede.
 *
 * Attenzione al confine: qui si risponde solo con `dayPeriods` (quante ore ha
 * quel giorno). Una lezione la cui FASCIA ORARIA non è più configurata non è
 * "fuori configurazione" in questo senso — è un altro caso, descritto dalla
 * colonna Campana della griglia — e non viene marcata da qui.
 *
 * Nessuna validazione e nessuna scrittura: è solo un predicato di
 * presentazione.
 *
 * La scuola la sceglie il CHIAMANTE e deve essere quella EFFETTIVA della
 * lezione (`effectiveSchoolForSlot`), non una scuola qualsiasi: valutare una
 * lezione di un istituto con le ore di un altro produce marcature false in
 * entrambe le direzioni. Qui dentro resta solo la regola `dayPeriods`: la
 * risoluzione dell'identità non è responsabilità di questo modulo.
 */
export function isSlotOutOfConfiguredDay(
  slot: { dayOfWeek: number; periodNumber: number },
  school?: Pick<SchoolProfile, "dayPeriods">,
  timeSlotConfig?: TimeSlotConfig
): boolean {
  return slot.periodNumber > periodsForDay(slot.dayOfWeek as SchoolWeekday, school, timeSlotConfig);
}
