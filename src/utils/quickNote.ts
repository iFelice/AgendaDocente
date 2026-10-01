import type { CalendarEvent } from "../types";
import { localDateISO } from "./dates";

/**
 * N2 — nota personale rapida.
 *
 * NON esiste un archivio "note": una nota è un normale `CalendarEvent` manuale
 * con `category: "promemoria"`. Così riusa IndexedDB, backup, account sync,
 * `EventModal`, lo storico N1.1 e il completamento già esistenti, senza nuove
 * tabelle, migrazioni o versioni di backup.
 */

export const QUICK_NOTE_CATEGORY = "promemoria" as const;

export interface QuickNoteDraft {
  title: string;
  date: string;
  /** Opzionale: se assente la nota NON eredita arbitrariamente la prima classe del profilo. */
  className?: string;
  notes?: string;
}

/** Id coerente con il resto del progetto (`ev-…`, come `EventModal`). */
function quickNoteId(now: number = Date.now()): string {
  return `ev-${now}`;
}

/**
 * Costruisce (senza persistere) il `CalendarEvent` della nota rapida.
 * `isAllDay` è implicito: niente orario obbligatorio.
 * `syncedWithGoogle` resta falso: nessuna sincronizzazione automatica.
 * Nessuno `schoolId` inventato.
 */
export function buildQuickNoteEvent(draft: QuickNoteDraft, now: number = Date.now()): CalendarEvent {
  const title = draft.title.trim();
  const className = draft.className?.trim();
  const notes = draft.notes?.trim();
  return {
    id: quickNoteId(now),
    title,
    category: QUICK_NOTE_CATEGORY,
    date: draft.date || localDateISO(),
    isAllDay: true,
    ...(className ? { className } : {}),
    ...(notes ? { notes } : {}),
    sourceType: "manuale",
    completed: false,
    syncedWithGoogle: false,
  };
}
