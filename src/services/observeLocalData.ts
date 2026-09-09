import { liveQuery } from 'dexie';
import type { AgendaDatabase, LocalData } from './db';

/** Dexie propagates committed invalidations across tabs via BroadcastChannel (storage-event fallback).
 * Only invalidations/keys travel across tabs; each reader obtains a transactional local snapshot.
 */
export function observeLocalData(db: AgendaDatabase, next: (data: LocalData) => void, error: (error: unknown) => void) {
  const subscription = liveQuery(() => db.readSnapshot()).subscribe({ next, error });
  return () => subscription.unsubscribe();
}

// Keep unchanged props referentially stable: unrelated writes must not reset open editors.
export function retainEqual<T>(current: T, incoming: T): T {
  return JSON.stringify(current) === JSON.stringify(incoming) ? current : incoming;
}
