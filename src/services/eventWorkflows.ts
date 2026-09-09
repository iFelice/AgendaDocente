import { database } from './db';
import { storage } from './storage';
import { deleteGoogleCalendarEvent, isGoogleSyncEnabled } from './googleCalendarService';

/** A failed local commit must not delete the only good remote copy. */
export async function deleteEventLocallyFirst(id: string, token: string | null): Promise<boolean> {
  const event = await database.atomic(async () => {
    const current = (await storage.getEvents()).find(event => event.id === id);
    await storage.deleteEvent(id);
    return current;
  });
  if (event?.googleEventId && isGoogleSyncEnabled(event) && token) {
    try { await deleteGoogleCalendarEvent(token, event.googleEventId); }
    catch { return false; }
  }
  return true;
}
