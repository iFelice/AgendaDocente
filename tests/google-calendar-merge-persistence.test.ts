import 'fake-indexeddb/auto';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../src/services/db';
import { initializeStorage, storage } from '../src/services/storage';
import { commitEventMerge, restoreEventMerge } from '../src/services/googleCalendarMergeService';
import { planMerge } from '../src/utils/googleCalendarMerge';
import type { CalendarEvent } from '../src/types';

/** Unione persistita: nessuna chiamata di rete, annulla ripristina gli originali. */

const app: CalendarEvent = {
  id: 'ev-app', title: 'Consiglio di classe 3D', category: 'consiglio_classe', date: '2026-10-12',
  startTime: '15:00', endTime: '16:00', isAllDay: false, sourceType: 'circolare', sourceCircularId: 'circ-1',
  sourceCircularTitle: 'Circolare 42', className: '3D', completed: false, updatedAt: '2026-10-01T10:00:00.000Z',
};
const google: CalendarEvent = {
  id: 'gcal-primary-g1', title: 'Consiglio classe 3D', category: 'personale', date: '2026-10-12',
  startTime: '15:00', endTime: '16:00', isAllDay: false, sourceType: 'google_calendar', googleEventId: 'g1',
  googleCalendarId: 'primary', meetingUrl: 'https://meet.google.com/abc-defg-hij', syncedWithGoogle: false, completed: false,
};

let originalFetch: typeof fetch;
let networkCalls: string[];

let memory = new Map<string, string>();

beforeEach(async () => {
  memory = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return memory.size; },
      key: (i: number) => [...memory.keys()][i] ?? null,
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => { memory.set(k, String(v)); },
      removeItem: (k: string) => { memory.delete(k); },
    },
  });
  originalFetch = globalThis.fetch;
  networkCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    networkCalls.push(String(input));
    throw new Error('network disabled in test');
  }) as typeof fetch;
  database.close();
  await database.delete();
  await initializeStorage();
  await storage.saveEvents([app, google]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('commit: il duplicato Google esce dall\'app, il risultato prende il suo link, nessuna chiamata di rete', async () => {
  const plan = planMerge(app, google);
  const originals = await commitEventMerge(app.id, google.id, plan.merged);
  assert.equal(originals.base.id, app.id);
  assert.equal(originals.secondary.id, google.id);

  const events = await storage.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'ev-app');
  assert.equal(events[0].sourceType, 'circolare');
  assert.equal(events[0].meetingUrl, 'https://meet.google.com/abc-defg-hij');
  assert.equal(events[0].googleEventId, 'g1');
  assert.equal(events[0].googleCalendarId, 'primary');
  assert.equal(events[0].className, '3D');
  assert.deepEqual(networkCalls, []);
});

test('annulla: ripristina i due impegni originali senza chiamate di rete', async () => {
  const plan = planMerge(app, google);
  const originals = await commitEventMerge(app.id, google.id, plan.merged);
  await restoreEventMerge(originals);

  const events = await storage.getEvents();
  const byId = new Map(events.map(event => [event.id, event]));
  assert.equal(events.length, 2);
  assert.deepEqual(byId.get('ev-app'), app);
  assert.deepEqual(byId.get('gcal-primary-g1'), google);
  assert.deepEqual(networkCalls, []);
});

test('commit: se uno dei due impegni non esiste più non scrive nulla', async () => {
  await assert.rejects(commitEventMerge(app.id, 'ev-missing', planMerge(app, google).merged));
  const events = await storage.getEvents();
  assert.equal(events.length, 2);
  assert.deepEqual(networkCalls, []);
});
