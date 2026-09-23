import type { TimetableSlot, TimetableType } from "../types";

/**
 * Stato esplicito di navigazione per una sessione di MODIFICA LEZIONE aperta da
 * una vista di Planning: quale slot è in modifica, in quale orario vive, da
 * quale Planning l'utente l'ha aperta e con quale data/settimana deve tornare.
 *
 * Stesso approccio di `registerNavigation.ts`: l'origine NON viene mai dedotta
 * da altri stati — è registrata al momento dell'apertura, così "Indietro"
 * riporta esattamente al Planning di provenienza sullo stesso contesto.
 * Nessun React state, nessun storage, nessun browser history: è solo un
 * oggetto immutabile che l'App terrà nel proprio stato.
 *
 * La modifica è raggiungibile SOLO da Oggi e Settimana: la vista Mese non
 * mostra TimetableSlot, quindi non è un'origine possibile.
 */

/**
 * Le uniche viste di Planning da cui una lezione può essere aperta in modifica.
 * Unione ristretta a scopo (e non un `ViewMode`): "mese", "registro", "orario",
 * "classi" e le altre sono IMPOSSIBILI a compile-time, senza runtime fallback.
 */
export type SlotEditOriginView = "oggi" | "settimana";

export interface SlotEditNavigation {
  /**
   * Lezione aperta in modifica (copia con gli array condivisi duplicati: la
   * sessione non deve mai mutare gli oggetti del timetable da cui proviene).
   * `null` = nessuna sessione.
   */
  slot: TimetableSlot | null;
  /** Orario a cui appartiene lo slot: quello ATTIVO al momento del tap. */
  type: TimetableType | null;
  /** Planning di provenienza (null = nessuna sessione). */
  originView: SlotEditOriginView | null;
  /**
   * Data civile da ripristinare al ritorno:
   *  - Oggi → il giorno selezionato nella vista;
   *  - Settimana → una data ISO appartenente alla settimana visualizzata
   *    (idealmente la data reale del giorno/card toccato).
   */
  originDateIso: string | null;
}

export const initialSlotEditNavigation: SlotEditNavigation = {
  slot: null,
  type: null,
  originView: null,
  originDateIso: null,
};

/** True se una sessione di modifica lezione è aperta. */
export function isSlotEditOpen(nav: SlotEditNavigation): boolean {
  return nav.slot !== null;
}

/**
 * Copia dello slot conservata nella sessione: scalari per valore e array delle
 * compresenze duplicati, così NIENTE dentro la sessione può mutare gli oggetti
 * (nemmeno gli array) del timetable da cui lo slot proviene. I campi assenti
 * restano assenti (nessuna chiave `undefined` di nascosto).
 */
function cloneSlotForSession(slot: TimetableSlot): TimetableSlot {
  return {
    ...slot,
    ...(slot.coTeachingSubjects ? { coTeachingSubjects: [...slot.coTeachingSubjects] } : {}),
    ...(slot.coSupportTeachers ? { coSupportTeachers: [...slot.coSupportTeachers] } : {}),
    ...(slot.supportTeachers ? { supportTeachers: [...slot.supportTeachers] } : {}),
  };
}

/**
 * Apre la sessione di modifica per `slot` partendo da `originView`.
 *
 * Pure: non muta lo slot ricevuto (lo conserva come copia con gli array
 * duplicati) e restituisce uno stato nuovo. `originView` è tipizzato come
 * `SlotEditOriginView`, quindi un'origine impossibile ("mese", "registro",
 * "orario", …) è un errore di compilazione, non un caso da difendere a runtime.
 */
export function openSlotForEdit(
  slot: TimetableSlot,
  type: TimetableType,
  originView: SlotEditOriginView,
  originDateIso: string,
): SlotEditNavigation {
  return {
    slot: cloneSlotForSession(slot),
    type,
    originView,
    originDateIso,
  };
}

/**
 * Risultato di "Indietro" nella sessione di modifica:
 *  - `targetView`: il Planning di origine (null se nessuna sessione aperta:
 *    nessuna silenziosa sostituzione con "oggi" — chi mostra "Indietro" lo
 *    mostra solo con sessione aperta);
 *  - `targetDateIso`: la data/settimana da ripristinare;
 *  - `next`: lo stato della sessione dopo il ritorno (chiusa).
 *
 * Pure: non muta lo stato ricevuto.
 */
export function backFromSlotEdit(nav: SlotEditNavigation): {
  targetView: SlotEditOriginView | null;
  targetDateIso: string | null;
  next: SlotEditNavigation;
} {
  if (!isSlotEditOpen(nav)) {
    return { targetView: null, targetDateIso: null, next: nav };
  }
  return {
    targetView: nav.originView,
    targetDateIso: nav.originDateIso,
    next: { slot: null, type: null, originView: null, originDateIso: null },
  };
}

/**
 * Abbandono della sessione tramite la navigazione principale (l'utente lascia
 * l'editor dalle tab/bottom nav invece che con "Indietro"): si chiude senza
 * ricordare nulla. Pure: non muta lo stato ricevuto.
 */
export function clearSlotEdit(nav: SlotEditNavigation): SlotEditNavigation {
  return { slot: null, type: null, originView: null, originDateIso: null };
}
