import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { useEffect, useState } from 'react';
import { create, act } from 'react-test-renderer';
import { CloudSync } from '../src/components/CloudSyncCard';
import { SyncEngine, type LocalApply, type SyncStore } from '../src/services/sync/engine';
import type {
  ItemsCollection,
  RemoteItem,
  RemoteStateDoc,
  StateDocName,
  SyncGateway,
  SyncStatus,
  SyncableSnapshot,
} from '../src/services/sync/types';
import type { CalendarEvent } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Manual "Sincronizza ora" (CloudSync card):
 *   - the button drives the REAL SyncEngine cycle (pull/push/reconcile), never a page reload;
 *   - success / error / offline UI feedback, transient back to neutral;
 *   - double clicks never create concurrent cycles and the Web Lock is respected;
 *   - failures and offline never damage local data; the cloud side is never applied blindly
 *     (merge + conflict protection of the existing engine).
 */

const tick = () => new Promise((resolve) => setImmediate(resolve));

function emptySnapshot(): SyncableSnapshot {
  return {
    profile: {
      id: 'p1', fullName: '', schoolName: '', schoolLevel: 'ssig', schoolYear: '2026/2027',
      primarySubjects: [], classes: [], campuses: [], roles: [],
    },
    events: [], circulars: [], students: [], definitiveTimetable: [], provisionalTimetable: [],
    timetableMode: 'auto', onboardingCompleted: false,
  };
}

function event(id: string, title: string, date = '2026-09-15'): CalendarEvent {
  return {
    id, title, date, startTime: '09:00', endTime: '10:00', type: 'lezioni',
    createdAt: '2026-09-09T10:00:00.000Z', updatedAt: '2026-09-09T10:00:00.000Z',
  } as unknown as CalendarEvent;
}

/** In-memory SyncStore mirroring createStoreAdapter semantics (settings doc -> 3 fields). */
function memoryStore(overrides: Partial<SyncableSnapshot> = {}): SyncStore & { snapshot: SyncableSnapshot; meta: Map<string, unknown> } {
  const snapshot: SyncableSnapshot = { ...emptySnapshot(), ...overrides };
  const meta = new Map<string, unknown>();
  return {
    snapshot, meta,
    mode: () => 'indexeddb',
    async readSnapshot() { return structuredClone(snapshot); },
    async applyLocal(changes: LocalApply) {
      if (changes.fullRestore) { Object.assign(snapshot, structuredClone(changes.fullRestore)); return; }
      const state = changes.localApplyState ?? {};
      if ('profile' in state) snapshot.profile = structuredClone(state.profile) as SyncableSnapshot['profile'];
      if ('students' in state) snapshot.students = structuredClone(state.students) as SyncableSnapshot['students'];
      if ('definitiveTimetable' in state) snapshot.definitiveTimetable = structuredClone(state.definitiveTimetable) as SyncableSnapshot['definitiveTimetable'];
      if ('provisionalTimetable' in state) snapshot.provisionalTimetable = structuredClone(state.provisionalTimetable) as SyncableSnapshot['provisionalTimetable'];
      if ('settings' in state) {
        const settings = state.settings as { timetableMode?: SyncableSnapshot['timetableMode']; onboardingCompleted?: boolean; timeSlotConfig?: SyncableSnapshot['timeSlotConfig'] };
        if (settings?.timetableMode) snapshot.timetableMode = settings.timetableMode;
        if (typeof settings?.onboardingCompleted === 'boolean') snapshot.onboardingCompleted = settings.onboardingCompleted;
        if (settings?.timeSlotConfig) snapshot.timeSlotConfig = settings.timeSlotConfig;
      }
      if (changes.localEvents) snapshot.events = structuredClone(changes.localEvents);
      if (changes.localCirculars) snapshot.circulars = structuredClone(changes.localCirculars);
    },
    async readMeta(key: string) { return meta.get(key); },
    async writeMeta(key: string, value: unknown) { meta.set(key, structuredClone(value)); },
  };
}

/** Fake cloud with read/write counters and concurrency instrumentation. */
function makeFakeCloud(clock: { now: string }, failReads = false) {
  const cloud = {
    state: {} as Record<string, RemoteStateDoc>,
    items: { events: new Map<string, RemoteItem>(), circulars: new Map<string, RemoteItem>() } as Record<ItemsCollection, Map<string, RemoteItem>>,
    conflicts: [] as { kind: string; loser: unknown }[],
    reads: 0, writes: 0,
    /** Reads within one cycle legitimately run in parallel (Promise.all); writes never may. */
    writeInFlight: 0, maxWriteInFlight: 0,
  };
  const trackWrite = async <T,>(op: () => Promise<T>): Promise<T> => {
    cloud.writeInFlight++; cloud.maxWriteInFlight = Math.max(cloud.maxWriteInFlight, cloud.writeInFlight);
    try { return await op(); } finally { cloud.writeInFlight--; }
  };
  const gateway: SyncGateway = {
    async readState(name: StateDocName) {
      if (failReads) throw new Error('Failed to fetch');
      cloud.reads++;
      return cloud.state[name] ? structuredClone(cloud.state[name]) : null;
    },
    async writeState(name: StateDocName, payload: unknown) {
      return trackWrite(async () => {
        if (failReads) throw new Error('Failed to fetch');
        cloud.writes++;
        cloud.state[name] = { payload: JSON.parse(JSON.stringify(payload ?? null)), updatedAt: clock.now, schemaVersion: 1 };
        return { updatedAt: clock.now };
      });
    },
    async listItems(coll: ItemsCollection) {
      if (failReads) throw new Error('Failed to fetch');
      cloud.reads++;
      return [...cloud.items[coll].values()].map((item) => structuredClone(item));
    },
    async writeItems(coll: ItemsCollection, entries: { id: string; payload: unknown }[]) {
      return trackWrite(async () => {
        if (failReads) throw new Error('Failed to fetch');
        cloud.writes++;
        for (const { id, payload } of entries) cloud.items[coll].set(id, { id, payload: structuredClone(payload), updatedAt: clock.now });
      });
    },
    async deleteItems(coll: ItemsCollection, ids: string[]) {
      return trackWrite(async () => {
        if (failReads) throw new Error('Failed to fetch');
        cloud.writes++;
        for (const id of ids) cloud.items[coll].delete(id);
      });
    },
    async archiveConflict(kind: string, loser: unknown) { cloud.conflicts.push({ kind, loser: structuredClone(loser) }); },
  };
  return { cloud, gateway: () => gateway };
}

/** Engine with an observable scheduler queue (no real timers), plus a bounded drainer. */
function makeEngine(store: SyncStore, gateway: () => SyncGateway, clock: { now: string }) {
  const queue: { fn: () => void }[] = [];
  const cancelled = new Set<{ fn: () => void }>();
  const engine = new SyncEngine({
    gateway,
    uid: () => 'uid-manual',
    store,
    now: () => clock.now,
    schedule: (fn) => {
      const call = { fn };
      queue.push(call);
      return () => { cancelled.add(call); };
    },
  });
  /** Runs queued cycles until the queue stays empty (bounded so retry loops cannot hang). */
  const drain = async (maxRounds = 12) => {
    for (let round = 0; round < maxRounds; round++) {
      const pending = queue.splice(0).filter((call) => !cancelled.has(call));
      for (const call of pending) call.fn();
      await tick();
    }
  };
  return { engine, queue, drain };
}

// ---------- card harness wired exactly like App.tsx ----------

function Harness({ engine, online }: { engine: SyncEngine; online?: boolean }) {
  const [status, setStatus] = useState<SyncStatus>(engine.getStatus());
  useEffect(() => engine.subscribe(setStatus), [engine]);
  return React.createElement(CloudSync, {
    status,
    online,
    onSyncNow: () => { void engine.syncNow(); },
    onToggle: () => {},
    onResolve: () => {},
  });
}

async function mountCard(engine: SyncEngine, online?: boolean) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(Harness, { engine, online }));
  });
  return renderer;
}

const SYNC_LABELS = ['Sincronizza ora', 'Sincronizzazione…', 'Aggiornato ora', 'Sincronizzazione non riuscita'];

function syncButton(renderer: any) {
  const button = renderer.root.findAllByType('button')
    .find((b: any) => SYNC_LABELS.includes(b.props['aria-label']));
  assert.ok(button, 'the "Sincronizza ora" button is rendered');
  return button;
}

async function clickSync(renderer: any) {
  await act(async () => { syncButton(renderer).props.onClick(); });
}

function nodeText(node: any): string {
  const parts: string[] = [];
  const walk = (n: any) => {
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return; }
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.children)) n.children.forEach(walk);
    else if (typeof n.children === 'string' || typeof n.children === 'number') parts.push(String(n.children));
  };
  walk(node);
  return parts.join(' ');
}

async function loggedInDevice(
  clock: { now: string },
  overrides: Partial<SyncableSnapshot> = {},
  failReads = false,
  sharedCloud?: ReturnType<typeof makeFakeCloud>,
) {
  const store = memoryStore(overrides);
  const fake = sharedCloud ?? makeFakeCloud(clock, failReads);
  const device = makeEngine(store, fake.gateway, clock);
  device.engine.startSession('uid-manual');
  await act(async () => { await device.drain(); });
  return { store, ...fake, ...device };
}

// ---------------------------------------------------------------------------

test('the manual button runs the real sync engine (uploads through it) and never reloads the page', async () => {
  const reload = (() => { let calls = 0; return { fn: () => { calls++; }, get calls() { return calls; } }; })();
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = { location: { reload: reload.fn } };
  try {
    const clock = { now: '2026-09-09T18:00:00.000Z' };
    const device = await loggedInDevice(clock);
    assert.equal(device.cloud.items.events.size, 0, 'empty local + empty cloud: no items uploaded by the initial cycle');

    // A local edit happens after the initial cycle: only the button click can upload it.
    device.store.snapshot.events = [event('e1', 'Consiglio di classe')];
    const renderer = await mountCard(device.engine);
    assert.equal(syncButton(renderer).props['aria-label'], 'Sincronizza ora');

    await clickSync(renderer);
    await act(async () => { await device.drain(); });

    assert.equal(device.cloud.items.events.size, 1, 'the event reached the cloud through the real engine');
    assert.equal(reload.calls, 0, 'no page reload was performed');
    assert.equal(device.engine.getStatus().phase, 'idle');
    assert.equal(syncButton(renderer).props['aria-label'], 'Aggiornato ora');

    // The production wiring goes through accountSync.syncNow(), not location.reload().
    const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    assert.match(appSource, /onSyncNow=\{\(\) => void accountSync\.syncNow\(\)\}/);
    for (const file of ['src/App.tsx', 'src/components/CloudSyncCard.tsx', 'src/components/ProfileModal.tsx']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /location\.reload/, `${file} never reloads the page`);
    }
    await act(async () => { renderer.unmount(); });
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
  }
});

test('success updates the UI (label + Ultimo aggiornamento) and returns to the neutral state after a few seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { now: '2026-09-09T18:30:00.000Z' };
  const device = await loggedInDevice(clock);
  device.store.snapshot.events = [event('e1', 'Ore di sostegno')];

  const renderer = await mountCard(device.engine);
  await clickSync(renderer);
  await act(async () => { await device.drain(); });

  assert.equal(syncButton(renderer).props['aria-label'], 'Aggiornato ora');
  assert.equal(device.engine.getStatus().lastSyncedAt, clock.now, 'last-sync timestamp updated');
  assert.match(nodeText(renderer.root), /Ultimo aggiornamento:/);

  // Transient: after ~4s the button is neutral again.
  await act(async () => { t.mock.timers.tick(4100); });
  assert.equal(syncButton(renderer).props['aria-label'], 'Sincronizza ora');
  await act(async () => { renderer.unmount(); });
});

test('a failed sync shows the error state and local data are not lost', async () => {
  const clock = { now: '2026-09-09T19:00:00.000Z' };
  const device = await loggedInDevice(clock, { events: [event('e1', 'Row')] }, true);

  const renderer = await mountCard(device.engine);
  await clickSync(renderer);
  await act(async () => { await device.drain(3); }); // bounded: the engine schedules retries

  assert.equal(device.engine.getStatus().phase, 'error');
  assert.equal(syncButton(renderer).props['aria-label'], 'Sincronizzazione non riuscita');
  assert.deepEqual(device.store.snapshot.events.map((e) => e.id), ['e1'], 'local events untouched');
  assert.equal(device.cloud.writes, 0, 'nothing was written to the cloud');
  await act(async () => { renderer.unmount(); });
});

test('offline: the card explains local data stay available, nothing is corrupted, button returns neutral', async () => {
  const clock = { now: '2026-09-09T19:15:00.000Z' };
  const previousOnLine = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  try {
    const device = await loggedInDevice(clock, { events: [event('e1', 'Row')] }, true);
    const renderer = await mountCard(device.engine);

    await clickSync(renderer);
    await act(async () => { await device.drain(3); });

    assert.equal(device.engine.getStatus().phase, 'offline');
    assert.match(nodeText(renderer.root), /Sei offline\. I dati locali restano disponibili\./);
    // No fake "error" label for an offline run: the button is neutral again and data intact.
    assert.equal(syncButton(renderer).props['aria-label'], 'Sincronizza ora');
    assert.deepEqual(device.store.snapshot.events.map((e) => e.id), ['e1']);
  } finally {
    if (previousOnLine) Object.defineProperty(globalThis.navigator, 'onLine', previousOnLine);
    else delete (globalThis.navigator as any).onLine;
  }

  // Pure UI: offline prop keeps the button available and shows the message.
  const clock2 = { now: '2026-09-09T19:20:00.000Z' };
  const device2 = await loggedInDevice(clock2);
  const renderer2 = await mountCard(device2.engine, false);
  assert.match(nodeText(renderer2.root), /Sei offline\. I dati locali restano disponibili\./);
  assert.equal(syncButton(renderer2).props.disabled, false, 'the button stays available offline');
  await act(async () => { renderer2.unmount(); });
});

test('a double click never creates concurrent sync cycles', async () => {
  const clock = { now: '2026-09-09T20:00:00.000Z' };
  const device = await loggedInDevice(clock);
  device.store.snapshot.events = [event('e1', 'Doppio click')];

  const renderer = await mountCard(device.engine);
  await clickSync(renderer);
  await clickSync(renderer); // rapid second tap before any feedback
  await act(async () => { await device.drain(); });

  assert.ok(device.cloud.maxWriteInFlight <= 1, `write operations never overlap (max=${device.cloud.maxWriteInFlight})`);
  assert.equal(device.engine.getStatus().phase, 'idle');
  assert.equal(device.cloud.items.events.size, 1, 'data uploaded exactly once');
  await act(async () => { renderer.unmount(); });
});

test('an existing Web Lock is respected: with the lock busy the manual run does not touch the cloud and reschedules', async () => {
  const clock = { now: '2026-09-09T20:15:00.000Z' };
  const device = await loggedInDevice(clock);
  device.store.snapshot.events = [event('e1', 'Lock')];

  const fakeLocks = { request: (_name: string, _opts: unknown, _cb: (lock: unknown) => Promise<unknown>) => Promise.resolve(null) };
  const hadLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  Object.defineProperty(globalThis.navigator, 'locks', { value: fakeLocks, configurable: true });
  try {
    const renderer = await mountCard(device.engine);
    const readsBefore = device.cloud.reads;
    const writesBefore = device.cloud.writes;
    await clickSync(renderer);
    await act(async () => { await device.drain(3); });

    assert.equal(device.cloud.reads, readsBefore, 'no cloud read while another tab holds the lock');
    assert.equal(device.cloud.writes, writesBefore, 'no cloud write while another tab holds the lock');
    assert.equal(device.cloud.items.events.size, 0, 'nothing uploaded while the lock is busy');
    assert.ok(device.queue.length > 0 || device.engine.getStatus().phase !== 'error', 'the cycle was rescheduled, not dropped');
  } finally {
    if (hadLocks) Object.defineProperty(globalThis.navigator, 'locks', hadLocks);
    else delete (globalThis.navigator as any).locks;
  }
});

test('manual sync merges instead of overwriting: a fresh device pulls the cloud, newer local edits on the other device survive', async () => {
  const clock = { now: '2026-09-09T21:00:00.000Z' };
  const shared = makeFakeCloud(clock);

  // Device A ("Mac"): real profile + one local event.
  const aProfile = { id: 'p1', fullName: 'Prof. Mac', schoolName: 'IC Leonardo', schoolLevel: 'ssig' as const, schoolYear: '2026/2027', primarySubjects: ['Sostegno'], classes: ['1A'], campuses: ['Sede'], roles: [] };
  const a = await loggedInDevice(clock, {
    profile: structuredClone(aProfile),
    events: [event('e1', 'Lezione sostegno')],
  }, false, shared);
  // First A cycle uploads the local data.
  await act(async () => { await a.drain(); });
  assert.ok(shared.cloud.state.profile, 'profile is in the cloud');

  // Device B ("iPhone", fresh install): manual sync pulls everything down.
  const b = await loggedInDevice(clock, {}, false, shared);
  await act(async () => { await b.drain(); });
  assert.equal(b.store.snapshot.profile.fullName, 'Prof. Mac', 'B adopted the cloud profile');
  assert.deepEqual(b.store.snapshot.events.map((e) => e.id), ['e1'], 'B received the events');

  // Later: B edits locally and syncs; the newer profile must win in the cloud.
  clock.now = '2026-09-09T21:10:00.000Z';
  b.store.snapshot.profile = { ...b.store.snapshot.profile, fullName: 'Prof. iPhone' };
  const rendererB = await mountCard(b.engine);
  await clickSync(rendererB);
  await act(async () => { await b.drain(); });
  assert.equal((a.cloud.state.profile!.payload as { fullName: string }).fullName, 'Prof. iPhone', 'cloud profile updated by B');
  assert.equal(syncButton(rendererB).props['aria-label'], 'Aggiornato ora');

  // A syncs manually: it must PULL the newer profile and KEEP its own newer local event (no blind remote-wins, no conflicts).
  clock.now = '2026-09-09T21:20:00.000Z';
  a.store.snapshot.events = [event('e1', 'Lezione sostegno'), event('e2', 'Nuovo impegno su Mac')];
  const rendererA = await mountCard(a.engine);
  await clickSync(rendererA);
  await act(async () => { await a.drain(); });

  assert.equal(a.store.snapshot.profile.fullName, 'Prof. iPhone', 'A pulled the newer remote profile (merged)');
  assert.deepEqual(a.store.snapshot.events.map((e) => e.id), ['e1', 'e2'], 'A kept its local events');
  assert.equal(a.cloud.items.events.size, 2, 'and pushed its new event');
  assert.equal(a.cloud.conflicts.length, 0, 'no destructive overwrite: nothing needed archiving');
  assert.equal(a.engine.getStatus().phase, 'idle');
  assert.equal(syncButton(rendererA).props['aria-label'], 'Aggiornato ora');

  await act(async () => { rendererA.unmount(); rendererB.unmount(); });
});

test('card states: syncing label while a run is in flight; button disabled without a handler', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(CloudSync, {
      status: { phase: 'syncing', enabled: true, activeUid: 'uid' } as SyncStatus,
      onSyncNow: () => {},
    }));
  });
  const button = syncButton(renderer);
  assert.equal(button.props['aria-label'], 'Sincronizzazione…');
  assert.equal(button.props.disabled, true, 'no second run while syncing');
  await act(async () => { renderer.unmount(); });

  let renderer2: any;
  await act(async () => {
    renderer2 = create(React.createElement(CloudSync, {
      status: { phase: 'idle', enabled: true, activeUid: 'uid' } as SyncStatus,
    }));
  });
  const button2 = syncButton(renderer2);
  assert.equal(button2.props['aria-label'], 'Sincronizza ora');
  assert.equal(button2.props.disabled, true, 'disabled when no sync handler is configured');
  await act(async () => { renderer2.unmount(); });
});
