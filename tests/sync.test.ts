import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalStringify, contentHash, isPristineLocal, planSync } from '../src/services/sync/merge';
import { sanitizeError, SyncEngine, type LocalApply, type SyncStore } from '../src/services/sync/engine';
import type { ItemsCollection, RemoteItem, RemoteSnapshot, SyncGateway, SyncStateV1, SyncableSnapshot } from '../src/services/sync/types';
import { emptyInstallation } from '../src/services/storage';
import type { CalendarEvent, TeacherProfile } from '../src/types';

const clone = <T>(v: T): T => structuredClone(v);

function snapshotWith(patch: Partial<SyncableSnapshot> = {}): SyncableSnapshot {
  return { ...emptyInstallation(), onboardingCompleted: true, ...patch } as SyncableSnapshot;
}
function event(id: string, patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, title: `Evento ${id}`, date: '2026-09-15', type: 'riunione', priority: 'medio', completed: false, startTime: '15:00', endTime: '16:00', ...patch } as CalendarEvent;
}
function profileWith(patch: Partial<TeacherProfile> = {}): TeacherProfile {
  return { ...(emptyInstallation().profile as TeacherProfile), fullName: 'Anna Testi', schoolName: 'IC Prova', roles: [], ...patch } as TeacherProfile;
}
const emptyRemote = (): RemoteSnapshot => ({ state: {}, items: { events: [], circulars: [] } });

// ---------- pure helpers ----------

test('canonicalStringify is key-order insensitive and content hashes stable', () => {
  assert.equal(canonicalStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), canonicalStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
  assert.equal(contentHash({ x: 1, y: undefined }), contentHash({ y: undefined, x: 1 }));
  assert.notEqual(contentHash({ x: 1 }), contentHash({ x: 2 }));
});

test('a fresh install counts as pristine only while it holds no real data', () => {
  assert.ok(isPristineLocal(snapshotWith({ profile: emptyInstallation().profile as TeacherProfile })));
  assert.ok(!isPristineLocal(snapshotWith({ profile: profileWith(), events: [event('e1')] })));
});

test('first sync with empty cloud uploads local data instead of pulling anything', () => {
  const snap = snapshotWith({ profile: profileWith(), events: [event('e1')] });
  const plan = planSync({ uid: 'u1', snapshot: snap, remote: emptyRemote(), syncState: null, nowIso: '2026-09-09T10:00:00.000Z' });
  assert.equal(plan.fullRestore, null);
  assert.deepEqual(Object.keys(plan.stateWrites).sort(), ['definitiveTimetable', 'profile', 'provisionalTimetable', 'settings', 'students']);
  assert.deepEqual(Object.keys(plan.remoteWrites.events), ['e1']);
  assert.deepEqual(plan.remoteWrites.events.e1, snap.events[0]);
  assert.equal(plan.changedSomething, true);
});

test('pristine local + populated cloud restores everything down without re-uploading', () => {
  const snap = snapshotWith();
  const remote: RemoteSnapshot = {
    state: { profile: { payload: profileWith(), updatedAt: '2026-09-08T10:00:00.000Z', schemaVersion: 1 }, events: null as never, circulars: null as never, settings: null as never, students: null as never, definitiveTimetable: null as never, provisionalTimetable: null as never },
    items: { events: [{ id: 'e1', payload: event('e1', { title: 'Da cloud' }), updatedAt: '2026-09-08T10:00:00.000Z' }], circulars: [] },
  } as RemoteSnapshot;
  delete (remote.state as Record<string, unknown>).events; // only profile + one event exist remotely
  const plan = planSync({ uid: 'u1', snapshot: snap, remote, syncState: null, nowIso: '2026-09-09T10:00:00.000Z' });
  assert.ok(plan.fullRestore);
  assert.equal((plan.fullRestore!.profile as TeacherProfile).fullName, 'Anna Testi');
  assert.equal(plan.fullRestore!.events[0].title, 'Da cloud');
  assert.deepEqual(plan.stateWrites, {});
  assert.deepEqual(plan.remoteWrites.events, {});
});

test('only-local change pushes; only-remote change pulls', () => {
  const base = snapshotWith({ profile: profileWith(), events: [event('e1')] });
  const remote: RemoteSnapshot = { state: { profile: { payload: base.profile, updatedAt: 't0', schemaVersion: 1 } }, items: { events: [{ id: 'e1', payload: base.events[0], updatedAt: 't0' }], circulars: [] } } as RemoteSnapshot;
  const synced: SyncStateV1 = {
    uid: 'u1',
    state: { profile: { lastSyncedLocalHash: contentHash(base.profile), remoteUpdatedAt: 't0' }, settings: { lastSyncedLocalHash: contentHash({ timetableMode: base.timetableMode, onboardingCompleted: true }), remoteUpdatedAt: 't0' }, students: { lastSyncedLocalHash: contentHash([]), remoteUpdatedAt: 't0' }, definitiveTimetable: { lastSyncedLocalHash: contentHash([]), remoteUpdatedAt: 't0' }, provisionalTimetable: { lastSyncedLocalHash: contentHash([]), remoteUpdatedAt: 't0' } },
    items: { events: { docs: { e1: { hash: contentHash(base.events[0]), updatedAt: 't0' } } }, circulars: { docs: {} } },
  };
  // local edit only -> push
  const edited = snapshotWith({ profile: profileWith({ schoolName: 'IC Prova Nord' }), events: [event('e1', { title: 'Locale' })] });
  const planPush = planSync({ uid: 'u1', snapshot: edited, remote, syncState: synced, nowIso: 't1' });
  assert.deepEqual(planPush.remoteWrites.events, { e1: edited.events[0] });
  assert.equal(planPush.localEvents, undefined);
  // remote edit only -> pull
  const remoteEdited: RemoteSnapshot = clone(remote);
  (remoteEdited.items.events[0].payload as CalendarEvent).title = 'Remoto';
  remoteEdited.items.events[0].updatedAt = 't2';
  const planPull = planSync({ uid: 'u1', snapshot: base, remote: remoteEdited, syncState: { ...clone(synced), state: { ...synced.state, profile: { ...synced.state.profile!, remoteUpdatedAt: 't2' } } }, nowIso: 't3' });
  assert.ok(planPull.localEvents);
  assert.equal(planPull.localEvents!.find(e => e.id === 'e1')!.title, 'Remoto');
  assert.deepEqual(planPull.remoteWrites.events, {});
});

test('both sides edit the same row: newer wall clock wins and the loser is archived, never dropped', () => {
  const base = snapshotWith({ events: [event('e1')] });
  const synced: SyncStateV1 = { uid: 'u1', state: {}, items: { events: { changedAt: '2026-09-09T12:00:00.000Z', docs: { e1: { hash: contentHash(base.events[0]), updatedAt: '2026-09-09T09:00:00.000Z' } } }, circulars: { docs: {} } } };
  const local = snapshotWith({ events: [event('e1', { title: 'Modifica locale' })] });
  const remote: RemoteSnapshot = { state: {}, items: { events: [{ id: 'e1', payload: event('e1', { title: 'Modifica cloud' }), updatedAt: '2026-09-09T11:00:00.000Z' }], circulars: [] } };
  // local changedAt (12:00) newer than remote (11:00): local wins, remote copy archived
  const plan = planSync({ uid: 'u1', snapshot: local, remote, syncState: synced, nowIso: '2026-09-09T13:00:00.000Z' });
  assert.equal(plan.localEvents, undefined);
  assert.deepEqual(Object.keys(plan.remoteWrites.events), ['e1']);
  assert.equal((plan.remoteWrites.events.e1 as CalendarEvent).title, 'Modifica locale');
  assert.equal(plan.archivedOnOverwrite.length, 1);
  assert.equal((plan.archivedOnOverwrite[0].loser as CalendarEvent).title, 'Modifica cloud');
  // remote newer: pull down; local copy will be re-pushed by the other device later — nothing lost
  const plan2 = planSync({ uid: 'u1', snapshot: local, remote, syncState: { ...synced, items: { ...synced.items, events: { ...synced.items.events, changedAt: '2026-09-09T10:00:00.000Z' } } }, nowIso: '2026-09-09T13:00:00.000Z' });
  assert.equal(plan2.localEvents!.find(e => e.id === 'e1')!.title, 'Modifica cloud');
  assert.deepEqual(plan2.remoteWrites.events, {});
});

test('deletions propagate only when the other side has not touched the row; edited rows resurrect', () => {
  const row = event('e1');
  const synced: SyncStateV1 = { uid: 'u1', state: {}, items: { events: { docs: { e1: { hash: contentHash(row), updatedAt: 't0' } } }, circulars: { docs: {} } } };
  const localDeleted = snapshotWith({ events: [] });
  // untouched remotely -> delete remotely, forget track
  const planDel = planSync({ uid: 'u1', snapshot: localDeleted, remote: { state: {}, items: { events: [{ id: 'e1', payload: row, updatedAt: 't0' }], circulars: [] } }, syncState: clone(synced), nowIso: 't9' });
  assert.deepEqual(planDel.remoteDeletes.events, ['e1']);
  assert.equal(planDel.nextState.items.events.docs.e1, undefined);
  // edited remotely after our deletion -> row comes back locally (never silently lost)
  const editedRemote = clone(row); editedRemote.title = 'Altri toccati';
  const planRes = planSync({ uid: 'u1', snapshot: localDeleted, remote: { state: {}, items: { events: [{ id: 'e1', payload: editedRemote, updatedAt: 't5' }], circulars: [] } }, syncState: clone(synced), nowIso: 't9' });
  assert.deepEqual(planRes.remoteDeletes.events, []);
  assert.equal(planRes.localEvents!.find(e => e.id === 'e1')!.title, 'Altri toccati');
  // remote deleted while local untouched -> mirrored locally
  const planMirror = planSync({ uid: 'u1', snapshot: snapshotWith({ events: [row] }), remote: { state: {}, items: { events: [], circulars: [] } }, syncState: clone(synced), nowIso: 't9' });
  assert.deepEqual(planMirror.localEvents!.map(e => e.id), []);
});

test('state doc edited on both sides without shared history asks the user (no silent overwrite)', () => {
  const local = snapshotWith({ profile: profileWith({ fullName: 'Dispositivo A' }) });
  const remote: RemoteSnapshot = { state: { profile: { payload: profileWith({ fullName: 'Dispositivo B' }), updatedAt: 't1', schemaVersion: 1 } }, items: { events: [], circulars: [] } };
  const plan = planSync({ uid: 'u1', snapshot: local, remote, syncState: null, nowIso: 't2' });
  assert.ok(plan.needsResolution.includes('profile'));
  assert.equal(plan.localApplyState.profile, undefined);
  assert.equal(plan.stateWrites.profile, undefined);
  // explicit choices:
  const forceLocal = planSync({ uid: 'u1', snapshot: local, remote, syncState: null, nowIso: 't2', resolution: 'local' });
  assert.deepEqual((forceLocal.stateWrites.profile as TeacherProfile).fullName, 'Dispositivo A');
  assert.equal(forceLocal.archivedOnOverwrite.length, 1);
  const adoptCloud = planSync({ uid: 'u1', snapshot: local, remote, syncState: null, nowIso: 't2', resolution: 'remote' });
  assert.equal((adoptCloud.fullRestore!.profile as TeacherProfile).fullName, 'Dispositivo B');
});

// ---------- full engine loopback with a fake cloud ----------

interface FakeCloud {
  gateway(): SyncGateway;
  state: Record<string, unknown>;
  items: Record<ItemsCollection, Map<string, RemoteItem>>;
  conflicts: { kind: string; loser: unknown }[];
  writes: number;
}
function makeFakeCloud(clock: { now: string }): FakeCloud {
  const cloud = {
    state: {} as Record<string, unknown>,
    items: { events: new Map<string, RemoteItem>(), circulars: new Map<string, RemoteItem>() } as Record<ItemsCollection, Map<string, RemoteItem>>,
    conflicts: [] as { kind: string; loser: unknown }[],
    writes: 0,
    gateway(): SyncGateway {
      // capture methods referencing `cloud`
      return gatewayApi;
    },
  };
  const gatewayApi: SyncGateway = {
    async readState(name) { return cloud.state[name] ? clone(cloud.state[name]) as never : null; },
    async writeState(name, payload) {
      cloud.writes++;
      const updatedAt = clock.now;
      cloud.state[name] = { payload: clone(payload), updatedAt, schemaVersion: 1 };
      return { updatedAt };
    },
    async listItems(coll) { return [...cloud.items[coll].values()].map(clone); },
    async writeItems(coll, entries) {
      cloud.writes++;
      for (const { id, payload } of entries) cloud.items[coll].set(id, { id, payload: clone(payload), updatedAt: clock.now });
    },
    async deleteItems(coll, ids) { cloud.writes++; for (const id of ids) cloud.items[coll].delete(id); },
    async archiveConflict(kind, loser) { cloud.conflicts.push({ kind, loser: clone(loser) }); },
  };
  return cloud;
}

interface FakeDevice { db: SyncableSnapshot; meta: Record<string, unknown>; store: SyncStore }
function makeDevice(initial?: Partial<SyncableSnapshot>): FakeDevice {
  const db = snapshotWith({ profile: profileWith(), ...initial });
  const meta: Record<string, unknown> = {};
  const store: SyncStore = {
    mode: () => 'indexeddb',
    readSnapshot: async () => clone(db),
    readMeta: async key => meta[key],
    writeMeta: async (key, value) => { meta[key] = clone(value); },
    applyLocal: async (changes: LocalApply) => {
      if (changes.fullRestore) { Object.assign(db, clone(changes.fullRestore)); return; }
      const st = changes.localApplyState ?? {};
      if ('profile' in st) db.profile = clone(st.profile) as TeacherProfile;
      if ('students' in st) db.students = clone(st.students) as never;
      if ('definitiveTimetable' in st) db.definitiveTimetable = clone(st.definitiveTimetable) as never;
      if ('provisionalTimetable' in st) db.provisionalTimetable = clone(st.provisionalTimetable) as never;
      if ('settings' in st) { const s = st.settings as { timetableMode?: never; onboardingCompleted?: boolean }; if (s.timetableMode) db.timetableMode = s.timetableMode; if (typeof s.onboardingCompleted === 'boolean') db.onboardingCompleted = s.onboardingCompleted; }
      if (changes.localEvents) db.events = clone(changes.localEvents);
      if (changes.localCirculars) db.circulars = clone(changes.localCirculars) as never;
    },
  };
  return { db, meta, store };
}

function makeEngine(device: FakeDevice, cloud: FakeCloud, clock: { now: string }, uid = 'uid-1'): SyncEngine {
  return new SyncEngine({
    gateway: () => cloud.gateway(),
    uid: () => uid,
    store: device.store,
    now: () => clock.now,
    schedule: fn => { fn(); return () => undefined; }, // immediate for determinism
  });
}

test('two devices converge through the engine: push, pull, delete, and zero writes when already in sync', async () => {
  const clock = { now: '2026-09-09T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const a = makeDevice({ events: [event('e1', { title: 'Collegio docenti' })] });
  const b = makeDevice();
  (b.db as { profile: TeacherProfile }).profile = { ...emptyInstallation().profile } as TeacherProfile; // pristine device
  const engineA = makeEngine(a, cloud, clock);
  const engineB = makeEngine(b, cloud, clock);

  await engineA.syncNow(); // first upload from A
  assert.equal(cloud.state.profile !== undefined, true);
  assert.equal(cloud.items.events.get('e1')?.payload !== undefined, true);

  clock.now = '2026-09-09T10:05:00.000Z';
  await engineB.syncNow(); // B is pristine -> full restore
  assert.equal(b.db.events[0].title, 'Collegio docenti');
  assert.equal(b.db.profile.fullName, 'Anna Testi');

  const writesAfterRestore = cloud.writes;
  await engineB.syncNow();
  await engineA.syncNow();
  assert.equal(cloud.writes, writesAfterRestore, 'stable devices must not write to the cloud at all (loop guard)');

  // B edits an event; A syncs and sees the newer copy (remote wins over A's untouched row)
  clock.now = '2026-09-09T11:00:00.000Z';
  b.db.events = [event('e1', { title: 'Collegio docenti — aula magna' })];
  await engineB.syncNow();
  clock.now = '2026-09-09T11:10:00.000Z';
  await engineA.syncNow();
  assert.equal(a.db.events[0].title, 'Collegio docenti — aula magna');

  // A deletes it; deletion propagates through the cloud to B
  clock.now = '2026-09-09T12:00:00.000Z';
  a.db.events = [];
  await engineA.syncNow();
  assert.equal(cloud.items.events.has('e1'), false);
  clock.now = '2026-09-09T12:10:00.000Z';
  await engineB.syncNow();
  assert.deepEqual(b.db.events, []);

  // sync metadata is recorded and stays tied to the uid
  const state = a.meta['sync:state'] as SyncStateV1;
  assert.equal(state.uid, 'uid-1');
});

test('a conflicting concurrent edit keeps the newer side and archives the loser copy', async () => {
  const clock = { now: '2026-09-09T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const a = makeDevice({ events: [event('e1')] });
  const b = makeDevice({ events: [event('e1')] });
  const engineA = makeEngine(a, cloud, clock, 'uid-1');
  const engineB = makeEngine(b, cloud, clock, 'uid-1');
  await engineA.syncNow();
  // Second device of the SAME account that already synced once: copy its bookkeeping.
  b.meta['sync:state'] = structuredClone(a.meta['sync:state']);
  (b.meta['sync:state'] as SyncStateV1).items.events.docs.e1 = { hash: contentHash(event('e1')), updatedAt: cloud.items.events.get('e1')!.updatedAt };
  await engineB.syncNow();

  // Both edit the same row; B's edit lands later on the wall clock, so B wins everywhere.
  clock.now = '2026-09-09T14:00:00.000Z';
  a.db.events = [event('e1', { title: 'A dice' })];
  await engineA.syncNow();
  clock.now = '2026-09-09T15:00:00.000Z';
  b.db.events = [event('e1', { title: 'B dice' })];
  await engineB.syncNow();
  assert.equal((cloud.items.events.get('e1')!.payload as CalendarEvent).title, 'B dice');
  assert.equal(cloud.conflicts.length >= 1, true, 'loser copy archived');
  clock.now = '2026-09-09T15:30:00.000Z';
  await engineA.syncNow();
  assert.equal(a.db.events[0].title, 'B dice');
});

test('unresolvable divergence surfaces awaiting-resolution and honours the explicit choice', async () => {
  const clock = { now: '2026-09-09T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  cloud.state.profile = { payload: profileWith({ fullName: 'Dal Cloud' }), updatedAt: '2026-09-01T10:00:00.000Z', schemaVersion: 1 };
  const a = makeDevice({ profile: profileWith({ fullName: 'Solo su questo dispositivo' }) });
  const engineA = makeEngine(a, cloud, clock);
  await engineA.syncNow();
  assert.equal(engineA.getStatus().phase, 'awaiting-resolution');
  assert.ok(engineA.getStatus().conflicts?.includes('profile'));
  assert.equal(a.db.profile.fullName, 'Solo su questo dispositivo'); // nothing changed silently
  await engineA.resolveConflict('local');
  assert.equal((cloud.state.profile as { payload: TeacherProfile }).payload.fullName, 'Solo su questo dispositivo');
  assert.equal(engineA.getStatus().phase, 'idle');
  assert.ok(cloud.conflicts.some(c => (c.loser as TeacherProfile).fullName === 'Dal Cloud')); // old remote preserved
});

test('offline cloud failure is safe: no writes, retry scheduled, local data untouched', async () => {
  const clock = { now: '2026-09-09T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const a = makeDevice({ events: [event('e1')] });
  let scheduled = 0;
  const engine = new SyncEngine({
    gateway: () => ({
      ...cloud.gateway(),
      async readState() { throw new Error('Failed to fetch'); },
      async listItems() { throw new Error('Failed to fetch'); },
    }),
    uid: () => 'uid-1',
    store: a.store,
    now: () => clock.now,
    schedule: () => { scheduled++; return () => undefined; },
  });
  await engine.syncNow();
  assert.equal(engine.getStatus().phase, 'error');
  assert.match(engine.getStatus().message!, /Connessione|sincronizz/i);
  assert.equal(cloud.writes, 0);
  assert.equal(scheduled >= 1, true); // retry was planned
  assert.equal(a.db.events.length, 1);
});

test('logout stops the session; the engine without a uid never mirrors', async () => {
  const clock = { now: '2026-09-09T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const a = makeDevice({ events: [event('e1')] });
  let uid: string | null = 'uid-1';
  const engine = new SyncEngine({ gateway: () => cloud.gateway(), uid: () => uid, store: a.store, now: () => clock.now, schedule: fn => { fn(); return () => undefined; } });
  engine.startSession(uid!);
  uid = null;
  await engine.syncNow();
  assert.equal(cloud.writes, 0);
  engine.stopSession();
  assert.equal(engine.getStatus().activeUid, null);
});

test('error messages are sanitized and never leak raw SDK/network details', () => {
  assert.match(sanitizeError(new Error('firebase: Missing or insufficient permissions.')), /Verifica l'accesso/);
  assert.match(sanitizeError(new Error('network error at https://firestore.googleapis.com/v1/projects/x')), /riproverà/i);
  const generic = sanitizeError(new Error('Internal assertion {secret: 42}'));
  assert.ok(!generic.includes('secret'));
});
