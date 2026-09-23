/**
 * Regole della gesture di swipe orizzontale (cambio di giorno) su dispositivi
 * touch, condivise da tutte le viste che navigano il giorno: la vista Oggi e
 * l'area del giorno della vista Orario. Una sola fonte di verità per soglia,
 * prevalenza orizzontale e direzione, così lo swipe si comporta uguale in
 * tutta l'app. Nessuna logica date qui: il cambio di giorno vero e proprio
 * spetta a chi lo riceve (es. addDaysISO).
 */

/**
 * Spostamento orizzontale minimo perché il gesto sia considerato uno swipe (px
 * CSS). Sotto questa soglia restano tocchi, micro-movimenti e scroll: nessun
 * cambio di giorno.
 */
export const DAY_SWIPE_MIN_DISTANCE_PX = 48;

/**
 * Quanto il gesto deve essere orizzontale: lo spostamento orizzontale deve
 * essere almeno questo multiplo di quello verticale. Con 1.5 una diagonale a 45°
 * e un normale scroll verticale non cambiano mai il giorno.
 */
export const DAY_SWIPE_HORIZONTAL_RATIO = 1.5;

/**
 * Controlli da cui uno swipe NON deve mai partire: chip dei giorni, pulsanti di
 * navigazione, campi dei modali, link. Il gesto resta riservato alle superfici
 * non interattive.
 */
export const DAY_SWIPE_INTERACTIVE_SELECTOR = 'button, input, select, textarea, a, label, [role="button"]';

/** Direzione di uno swipe fra i giorni: `null` = il gesto non è uno swipe. */
export type DaySwipeDirection = "next" | "previous" | null;

/**
 * Decide se lo spostamento di un gesto è uno swipe fra i giorni e in che
 * direzione: sinistra = giorno successivo, destra = giorno precedente.
 *
 * Regole (nessuna ambiguità con lo scroll verticale):
 *  - almeno `DAY_SWIPE_MIN_DISTANCE_PX` px di spostamento orizzontale;
 *  - spostamento orizzontale >= `DAY_SWIPE_HORIZONTAL_RATIO` x quello verticale.
 */
export function daySwipeDirection(deltaX: number, deltaY: number): DaySwipeDirection {
  const horizontal = Math.abs(deltaX);
  const vertical = Math.abs(deltaY);
  if (horizontal < DAY_SWIPE_MIN_DISTANCE_PX) return null;
  if (horizontal < vertical * DAY_SWIPE_HORIZONTAL_RATIO) return null;
  return deltaX < 0 ? "next" : "previous";
}

/**
 * True se il gesto parte da un controllo interattivo (pulsante, campo, link,
 * `role="button"`) e NON va interpretato come swipe. Un nodo privo di `closest`
 * viene trattato come superficie non interattiva solo quando esiste davvero;
 * un oggetto privo del metodo viene scartato per prudenza.
 */
export function isInteractiveSwipeTarget(target: unknown): boolean {
  const element = target as Element | null | undefined;
  if (!element || typeof element.closest !== "function") return false;
  return element.closest(DAY_SWIPE_INTERACTIVE_SELECTOR) != null;
}
