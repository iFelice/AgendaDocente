import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../src/services/db';
import { initializeStorage, storage } from '../src/services/storage';
import { createStoreAdapter, observeLocalCommits } from '../src/services/sync/localStore';
import { SyncEngine } from '../src/services/sync/engine';
import type { ItemsCollection, RemoteItem, RemoteStateDoc, SyncGateway, StateDocName } from '../src/services/sync/types';
import type { TimetableSlot } from '../src/types';

/**
 * REAL trigger-path regression tests:
 *
 *   storage.saveTimetableSlot -> IndexedDB commit -> observeLocalCommits -> scheduleSync
 *   -> SyncEngine cycle -> gateway.writeState
 *
 * These tests run against the REAL Dexie/IndexedDB stack (fake-indexeddb) with the production
 * store adapter and observer. The scheduled cycle is executed by draining the engine's own
 * scheduler queue — syncNow() is never called after the save, so the upload can only happen
 * if the commit really triggered the sync pipeline.
 */

let memory: Map<string, string>;
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
  database.close();
  await database.delete();
  await initializeStorage();
});

const newSlot = (id: string, dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6, periodNumber: number): TimetableSlot => ({
  id,
  dayOfWeek,
  periodNumber,
  startTime: '07:50',
  endTime: '08:50',
  subject: 'Sostegno',
  className: '1A',
  coTeachingSubjects: ['Matematica'],
  coSupportTeachers: ['Prof.ssa Rossi'],
  isProvisional: true,
});

function makeFakeCloud(clock: { now: string }) {
  const cloud = {
    state: {} as Record<string, RemoteStateDoc>,
    items: { events: new Map<string, RemoteItem>(), circulars: new Map<string, RemoteItem>() } as Record<ItemsCollection, Map<string, RemoteItem>>,
    conflicts: [] as { kind: string; loser: unknown }[],
    writes: 0,
  };
  const gateway: SyncGateway = {
    async readState(name: StateDocName) { return cloud.state[name] ? structuredClone(cloud.state[name]) : null; },
    async writeState(name: StateDocName, payload: unknown) {
      cloud.writes++;
      cloud.state[name] = { payload: JSON.parse(JSON.stringify(payload ?? null)), updatedAt: clock.now, schemaVersion: 1 };
      return { updatedAt: clock.now };
    },
    async listItems(coll: ItemsCollection) { return [...cloud.items[coll].values()].map(item => structuredClone(item)); },
    async writeItems(coll: ItemsCollection, entries: { id: string; payload: unknown }[]) {
      cloud.writes++;
      for (const { id, payload } of entries) cloud.items[coll].set(id, { id, payload: structuredClone(payload), updatedAt: clock.now });
    },
    async deleteItems(coll: ItemsCollection, ids: string[]) { cloud.writes++; for (const id of ids) cloud.items[coll].delete(id); },
    async archiveConflict(kind: string, loser: unknown) { cloud.conflicts.push({ kind, loser: structuredClone(loser) }); },
  };
  return { cloud, gateway: () => gateway };
}

interface ScheduledCall { fn: () => void; ms: number }

/**
 * Builds an engine whose scheduler QUEUE is observable and controllable: scheduleSync only
 * records the callback (exactly what a real debounce does before firing it).
 */
function makeEngineWithQueue(clock: { now: string }) {
  const { cloud, gateway } = makeFakeCloud(clock);
  const queue: ScheduledCall[] = [];
  const cancelled = new Set<ScheduledCall>();
  const engine = new SyncEngine({
    gateway,
    uid: () => 'uid-trigger',
    store: createStoreAdapter(),
    observeLocalCommits,
    now: () => clock.now,
    schedule: (fn, ms) => {
      const call: ScheduledCall = { fn, ms };
      queue.push(call);
      return () => { cancelled.add(call); };
    },
  });
  /** Runs every queued (non-cancelled) cycle, letting async work and observers settle. */
  async function drain(maxRounds = 200): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      const pending = queue.splice(0).filter(call => !cancelled.has(call));
      if (pending.length === 0) {
        // Give liveQuery/observers a final chance to emit before declaring quiet.
        await new Promise(resolve => setTimeout(resolve, 25));
        if (queue.length === 0) return;
        continue;
      }
      for (const call of pending) call.fn();
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('sync scheduler did not settle (possible loop)');
  }
  return { engine, cloud, queue, drain };
}

test('storage.saveTimetableSlot commits to IndexedDB, is observed, schedules the debounced sync and uploads to the gateway', async () => {
  const clock = { now: '2026-09-09T18:00:00.000Z' };
  const { engine, cloud, queue, drain } = makeEngineWithQueue(clock);

  engine.startSession('uid-trigger');
  await drain(); // initial sync settles (uploads the empty installation)

  const initialWrites = cloud.writes;
  const queueDepth = queue.length;

  // === THE user action: save a slot through the normal storage API. No syncNow() here. ===
  await storage.saveTimetableSlot(newSlot('tt-commit-1', 1, 1), 'provvisorio');

  // 1. The commit was observed and a sync was SCHEDULED (debounced), without any manual call.
  assert.ok(queue.length > queueDepth, 'the IndexedDB commit must schedule a sync cycle');

  // 2. Let the debounce fire: the scheduled cycle must push the slot to the cloud.
  await drain();

  const remote = cloud.state.provisionalTimetable;
  assert.ok(remote, 'the engine must have written provisionalTimetable to the gateway');
  assert.ok(Array.isArray(remote.payload), 'payload must be the timetable array');
  const lessons = remote.payload as TimetableSlot[];
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].id, 'tt-commit-1');
  assert.equal(lessons[0].dayOfWeek, 1);
  assert.equal(lessons[0].periodNumber, 1);
  assert.equal(lessons[0].startTime, '07:50');
  assert.equal(lessons[0].coTeachingSubjects?.[0], 'Matematica', 'new co-teaching fields survive the pipeline');
  assert.equal(lessons[0].coSupportTeachers?.[0], 'Prof.ssa Rossi');
  assert.ok(cloud.writes > initialWrites, 'a cloud write must have happened');

  // 3. The local archive still holds the slot (source of truth untouched).
  const local = await storage.getProvisionalTimetable();
  assert.equal(local.length, 1);
  assert.equal(local[0].id, 'tt-commit-1');
  assert.equal(engine.getStatus().phase, 'idle');
});

test('no ping-pong loop: after convergence the engine stops writing to the cloud', async () => {
  const clock = { now: '2026-09-09T18:30:00.000Z' };
  const { engine, cloud, drain } = makeEngineWithQueue(clock);
  engine.startSession('uid-trigger');
  await drain();

  await storage.saveTimetableSlot(newSlot('tt-commit-2', 2, 3), 'provvisorio');
  await drain();

  const writesAfterEdit = cloud.writes;
  const remoteAt = (cloud.state.provisionalTimetable as RemoteStateDoc).updatedAt;

  // Let any residual observation settle: nothing new may be scheduled or written.
  await drain();
  await drain();
  assert.equal(cloud.writes, writesAfterEdit, 'a stable device must not keep writing (loop guard)');
  assert.equal((cloud.state.provisionalTimetable as RemoteStateDoc).updatedAt, remoteAt, 'remote updatedAt stable');
  assert.equal(engine.getStatus().phase, 'idle');
  assert.equal(cloud.conflicts.length, 0);
});

test('a second edit re-triggers the pipeline and the cloud converges to the newest content', async () => {
  const clock = { now: '2026-09-09T19:00:00.000Z' };
  const { engine, cloud, drain } = makeEngineWithQueue(clock);
  engine.startSession('uid-trigger');
  await drain();

  await storage.saveTimetableSlot(newSlot('tt-commit-3', 1, 2), 'provvisorio');
  await drain();

  clock.now = '2026-09-09T19:10:00.000Z';
  // Replace the slot content (delete + re-add path through the storage API).
  await storage.deleteTimetableSlot('tt-commit-3', 'provvisorio');
  await drain();
  await storage.saveTimetableSlot(newSlot('tt-commit-4', 4, 1), 'provvisorio');
  await drain();

  const lessons = (cloud.state.provisionalTimetable as RemoteStateDoc).payload as TimetableSlot[];
  assert.deepEqual(lessons.map(l => l.id), ['tt-commit-4'], 'the cloud must reflect the newest local content');
  const local = await storage.getProvisionalTimetable();
  assert.deepEqual(local.map(l => l.id), ['tt-commit-4']);
  assert.equal(engine.getStatus().phase, 'idle');
});

test('AgendaDatabase.onCommit fires exactly once per committed outermost transaction and never for aborted ones', async () => {
  let commits = 0;
  const stop = database.onCommit(() => { commits++; });
  try {
    await storage.saveTimetableSlot(newSlot('tt-commit-5', 5, 1), 'provvisorio');
    assert.equal(commits, 1, 'one atomic save -> exactly one commit notification');

    // A nested atomic (saveSlot inside another atomic) still notifies only once.
    await database.atomic(async () => {
      await storage.saveTimetableSlot(newSlot('tt-commit-6', 5, 2), 'provvisorio');
    });
    assert.equal(commits, 2, 'nested transactions notify once at the outer commit boundary');

    // An aborted transaction must not notify.
    await assert.rejects(database.atomic(async () => {
      await database.write('events', []);
      throw new Error('abort on purpose');
    }));
    assert.equal(commits, 2, 'rolled-back transactions never notify');
  } finally {
    stop();
  }

  // After detaching, no more notifications.
  await storage.saveTimetableSlot(newSlot('tt-commit-7', 5, 3), 'provvisorio');
  assert.ok(commits === 2, 'detached listeners are not called');
});

test('observeLocalCommits emits for application commits through the explicit notification path', async () => {
  let emissions = 0;
  const stop = observeLocalCommits(() => { emissions++; });
  try {
    // Wait for the liveQuery initial emission to be skipped internally.
    await new Promise(resolve => setTimeout(resolve, 50));
    const before = emissions;
    await storage.saveTimetableSlot(newSlot('tt-commit-8', 3, 2), 'provvisorio');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(emissions > before, 'the observer must emit after an application commit');
  } finally {
    stop();
  }
});
