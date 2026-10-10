import { database } from "./db";
import { storage } from "./storage";
import type { CalendarEvent } from "../types";

/**
 * Persistenza locale dell'unione di due impegni. Nessuna chiamata a Google Calendar:
 * l'impegno Google viene rimosso SOLO dall'app (non si usa `deleteEventLocallyFirst`,
 * che cancellerebbe anche la copia remota).
 */

export interface EventMergeOriginals {
  base: CalendarEvent;
  secondary: CalendarEvent;
}

/**
 * Una sola scrittura atomica: l'impegno `baseId` diventa `merged`, `secondaryId` esce
 * dall'app. Ritorna gli originali (per l'Annulla) oppure lancia se uno dei due non esiste più.
 */
export async function commitEventMerge(
  baseId: string,
  secondaryId: string,
  merged: CalendarEvent,
): Promise<EventMergeOriginals> {
  return database.atomic(async () => {
    const list = await storage.getEvents();
    const base = list.find(event => event.id === baseId);
    const secondary = list.find(event => event.id === secondaryId);
    if (!base || !secondary) throw new Error("Uno dei due impegni non è più disponibile: nessuna modifica salvata.");
    const stamped: CalendarEvent = { ...merged, id: base.id, updatedAt: new Date().toISOString() };
    const next = list
      .filter(event => event.id !== secondaryId)
      .map(event => (event.id === baseId ? stamped : event));
    await storage.saveEvents(next);
    return { base, secondary };
  });
}

/** Annulla: ripristina i due impegni originali così come erano prima dell'unione. */
export async function restoreEventMerge(originals: EventMergeOriginals): Promise<void> {
  await database.atomic(async () => {
    const list = (await storage.getEvents()).filter(
      event => event.id !== originals.base.id && event.id !== originals.secondary.id,
    );
    await storage.saveEvents([...list, originals.base, originals.secondary]);
  });
}
