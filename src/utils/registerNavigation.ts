import type { ViewMode } from "../types";

/**
 * Stato esplicito di navigazione del Registro: quale studente è aperto, quale
 * sezione mostrare e — soprattutto — da quale vista l'utente ha aperto il
 * Registro, cioè dove deve portare "Indietro".
 *
 * L'origine NON viene dedotta da altri stati (es. "se c'è uno studentId allora
 * Classi"): è registrata al momento dell'apertura, così una prova programmata
 * aperta da Oggi/Settimana/Mese riporta alla vista di provenienza e una
 * apertura da Classi riporta a Classi. Nessun history hack: è solo uno stato
 * React in App.
 */

export type RegisterSection = "assessments" | "scheduled";

export interface RegisterNavigation {
  /** Studente aperto nel Registro (null = Registro aperto dalla navigazione principale). */
  studentId: string | null;
  /** Sezione iniziale della scheda studente. */
  section: RegisterSection;
  /** Vista da cui il Registro è stato aperto per lo studente (null = apertura dalla navigazione principale). */
  origin: ViewMode | null;
}

export const initialRegisterNavigation: RegisterNavigation = {
  studentId: null,
  section: "assessments",
  origin: null,
};

/** True se il Registro è stato aperto per uno studente specifico (da una vista). */
export function isRegisterOpenForStudent(nav: RegisterNavigation): boolean {
  return nav.studentId !== null;
}

/**
 * Apre il Registro per uno studente partendo da `originView`. L'origine è
 * memorizzata esplicitamente: è la vista in cui l'utente si trovava al momento
 * dell'apertura (le uniche viste che possono aprire il Registro per uno
 * studente sono le viste di planning — prova programmata — e Classi — scheda
 * alunno).
 */
export function openRegisterForStudent(
  studentId: string,
  section: RegisterSection,
  originView: ViewMode,
): RegisterNavigation {
  // Difesa: l'origine non può mai essere il Registro stesso.
  return { studentId, section, origin: originView === "registro" ? null : originView };
}

/**
 * Risultato di "Indietro" nel Registro aperto per uno studente: la vista da
 * raggiungere (l'origine reale, con Classi come fallback di compatibilità) e
 * lo stato del Registro dopo il ritorno.
 *
 * Le operazioni sulla scheda (modifica/eliminazione di prove o valutazioni)
 * non passano da qui e non toccano questo stato: l'origine non può essere
 * persa in mezzo a un'operazione, e il Registro non si chiude da solo.
 */
export function backFromRegister(nav: RegisterNavigation): { targetView: ViewMode; next: RegisterNavigation } {
  return {
    targetView: nav.origin ?? "classi",
    next: { ...nav, studentId: null, origin: null },
  };
}

/**
 * Abbandono del Registro tramite la navigazione principale (top/bottom nav):
 * si dimenticano studente e origine; la sezione resta com'era
 * (comportamento preesistente).
 */
export function clearRegisterStudent(nav: RegisterNavigation): RegisterNavigation {
  return { ...nav, studentId: null, origin: null };
}
