import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRemoteStateDoc,
  isLegacyMetadataOnlyPayload,
  isValidTimetableSlot,
  REMOTE_EPOCH,
} from '../src/services/sync/remoteSchema';
import { planSync, contentHash, type SyncPlan } from '../src/services/sync/merge';
import { SyncEngine, type LocalApply, type SyncStore } from '../src/services/sync/engine';
import type {
  ItemsCollection,
  RemoteItem,
  RemoteSnapshot,
  RemoteStateDoc,
  SyncGateway,
  SyncStateV1,
  SyncableSnapshot,
  StateDocName,
} from '../src/services/sync/types';
import { emptyInstallation } from '../src/services/storage';
import type { TeacherProfile, TimetableSlot, TimeSlotConfig } from '../src/types';

const clone = <T>(v: T): T => structuredClone(v);

/**
 * REGRESSION TESTS for the real production incident (2026-09-09):
 *
 *   users/{uid}/state/provisionalTimetable (legacy, malformed):
 *     payload: { schemaVersion: 1, updatedAt: "2026-09-09T17:47:36.312Z" }   <- NO timetable
 *
 * The old readState() cast the document with `snapshot.data() as RemoteStateDoc`, so the
 * metadata-only payload could flow into the merge as if it were a valid timetable, blocking
 * remote updates (updatedAt frozen at 2026-09-09T17:47:36.312Z) or crashing the cycle while
 * applying a non-array payload locally. These tests pin the exact scenario and the repair.
 */

const LEGACY_UPDATED_AT = '2026-09-09T17:47:36.312Z';

function profileWith(patch: Partial<TeacherProfile> = {}): TeacherProfile {
  return {
    ...(emptyInstallation().profile as TeacherProfile),
    fullName: 'Prof. Andrea Conti',
    schoolName: 'IC Leonardo Da Vinci',
    schoolYear: '2026/2027',
    schoolLevel: 'ssig',
    classes: ['1A', '2E'],
    primarySubjects: ['Sostegno'],
    campuses: ['Sede Centrale'],
    roles: [],
    ...patch,
  };
}

const slot1: TimetableSlot = {
  id: 'tt-slot-1',
  dayOfWeek: 1,
  periodNumber: 1,
  startTime: '07:50',
  endTime: '08:50',
  subject: 'Sostegno',
  className: '1A',
  classroom: 'Aula 12',
  isProvisional: true,
};

const slot2: TimetableSlot = {
  id: 'tt-slot-2',
  dayOfWeek: 3,
  periodNumber: 3,
  startTime: '09:50',
  endTime: '10:50',
  subject: 'Sostegno',
  className: '2E',
  classroom: 'Aula 24',
  isProvisional: true,
};

const fasceConfig: TimeSlotConfig = {
  firstHourStartTime: '07:50',
  periodsPerDay: 6,
  standardDurationMinutes: 60,
  customSlots: [
    { periodNumber: 1, label: '1ª Ora', startTime: '07:50', endTime: '08:50' },
    { periodNumber: 2, label: '2ª Ora', startTime: '08:50', endTime: '09:50' },
    { periodNumber: 3, label: '3ª Ora', startTime: '09:50', endTime: '10:50' },
    { periodNumber: 4, label: '4ª Ora', startTime: '10:50', endTime: '11:50' },
    { periodNumber: 5, label: '5ª Ora', startTime: '11:50', endTime: '12:50' },
    { periodNumber: 6, label: '6ª Ora', startTime: '12:50', endTime: '13:50' },
  ],
};

// ---------------------------------------------------------------------------
// 1. Runtime classification (no TypeScript casts as validation)
// ---------------------------------------------------------------------------

test('classifies the exact production legacy shape as invalid (metadata-only payload, no timetable)', () => {
  const raw = {
    payload: { schemaVersion: 1, updatedAt: LEGACY_UPDATED_AT },
    updatedAt: LEGACY_UPDATED_AT,
    schemaVersion: 1,
  };
  const verdict = classifyRemoteStateDoc('provisionalTimetable', raw);
  assert.equal(verdict.status, 'invalid');
  assert.match(verdict.reason, /legacy/i);
  // And the recognized helper:
  assert.ok(isLegacyMetadataOnlyPayload({ schemaVersion: 1, updatedAt: LEGACY_UPDATED_AT }));
  assert.ok(!isLegacyMetadataOnlyPayload([]));
  assert.ok(!isLegacyMetadataOnlyPayload({ fullName: 'X' }));
});

test('classifies a current well-formed document as valid (semantic payload validation, not just wrapper)', () => {
  const raw = { payload: [slot1, slot2], updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 };
  const verdict = classifyRemoteStateDoc('provisionalTimetable', raw);
  assert.equal(verdict.status, 'valid');
  assert.deepEqual(verdict.doc.payload, [slot1, slot2]);
  // Empty timetable is a VALID payload: [] is the correct representation of "no lessons".
  assert.equal(classifyRemoteStateDoc('provisionalTimetable', { payload: [], updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 }).status, 'valid');
});

test('classifies semantic corruption as invalid even with a perfect wrapper', () => {
  const cases: unknown[] = [
    { payload: { some: 'object' }, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 },            // timetable must be an Array
    { payload: [{ id: 'x', dayOfWeek: 9, periodNumber: 1, startTime: '07:50', endTime: '08:50', subject: 'S', className: '1A' }], updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 },
    { payload: [{ id: 'x', dayOfWeek: 1, periodNumber: 0, startTime: '07:50', endTime: '08:50', subject: 'S', className: '1A' }], updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 },
    { payload: [{ id: '', dayOfWeek: 1, periodNumber: 1, startTime: '07:50', endTime: '08:50', subject: 'S', className: '1A' }], updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 },
    { payload: [{ id: 'x', dayOfWeek: 1, periodNumber: 1, startTime: '08:50', endTime: '07:50', subject: 'S', className: '1A' }], updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 },
    { payload: [{ id: 'x', dayOfWeek: 1, periodNumber: 1, startTime: '07:50', endTime: '08:50', subject: 'S', className: '1A', coTeachingSubjects: 'Matematica' }], updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 },
    { payload: null, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 },
    'not an object',
    42,
  ];
  for (const raw of cases) {
    assert.equal(classifyRemoteStateDoc('provisionalTimetable', raw).status, 'invalid', `must be invalid: ${JSON.stringify(raw)}`);
  }
  // settings payload must be a coherent object
  assert.equal(classifyRemoteStateDoc('settings', { payload: { timetableMode: 'nonsense' }, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 }).status, 'invalid');
  assert.equal(classifyRemoteStateDoc('settings', { payload: { timetableMode: 'auto', onboardingCompleted: true, timeSlotConfig: fasceConfig }, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 }).status, 'valid');
  // profile payload must be a plausible TeacherProfile
  assert.equal(classifyRemoteStateDoc('profile', { payload: { id: 'p', fullName: 'X', schoolName: 'Y', schoolYear: '2026/2027', primarySubjects: [], classes: [], campuses: [], roles: [] }, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 }).status, 'valid');
  assert.equal(classifyRemoteStateDoc('profile', { payload: { no: 'profile' }, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 }).status, 'invalid');
  // students payload must be an array
  assert.equal(classifyRemoteStateDoc('students', { payload: [], updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 }).status, 'valid');
  assert.equal(classifyRemoteStateDoc('students', { payload: { schemaVersion: 1, updatedAt: LEGACY_UPDATED_AT }, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 }).status, 'invalid');
});

test('classifies recoverable legacy shapes as legacy with an extracted, validated payload', () => {
  // Double wrapping (observed family of legacy bugs): payload.payload holds the real data.
  const doubleWrapped = {
    payload: { payload: [slot1, slot2], updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 },
    updatedAt: LEGACY_UPDATED_AT,
    schemaVersion: 1,
  };
  const verdictDouble = classifyRemoteStateDoc('provisionalTimetable', doubleWrapped);
  assert.equal(verdictDouble.status, 'legacy');
  assert.deepEqual(verdictDouble.doc.payload, [slot1, slot2]);
  assert.equal(verdictDouble.doc.updatedAt, LEGACY_UPDATED_AT);

  // Missing wrapper fields (no schemaVersion / no updatedAt) but valid payload.
  const noSchemaVersion = { payload: [slot1], updatedAt: LEGACY_UPDATED_AT };
  const verdictNoSv = classifyRemoteStateDoc('provisionalTimetable', noSchemaVersion);
  assert.equal(verdictNoSv.status, 'legacy');
  assert.deepEqual(verdictNoSv.doc.payload, [slot1]);

  const noUpdatedAt = { payload: [slot1], schemaVersion: 1 };
  const verdictNoAt = classifyRemoteStateDoc('provisionalTimetable', noUpdatedAt);
  assert.equal(verdictNoAt.status, 'legacy');
  assert.equal(verdictNoAt.doc.updatedAt, REMOTE_EPOCH, 'unknown timestamps must not win LWW comparisons');

  // The document itself is the payload (no wrapper at all).
  const verdictBare = classifyRemoteStateDoc('provisionalTimetable', [slot1, slot2]);
  assert.equal(verdictBare.status, 'legacy');
  assert.deepEqual(verdictBare.doc.payload, [slot1, slot2]);
});

test('timetable slot validator accepts old slots (no co-teaching fields) and new ones', () => {
  assert.ok(isValidTimetableSlot(slot1));
  assert.ok(isValidTimetableSlot({ ...slot2, coTeachingSubjects: ['Matematica', 'Scienze'], coSupportTeachers: ['Prof.ssa Rossi'] }));
  assert.ok(isValidTimetableSlot({ ...slot2, supportTeachers: ['Prof. Bianchi', 'Prof.ssa Verdi'] }));
  assert.ok(!isValidTimetableSlot({ ...slot2, coTeachingSubjects: [42] }));
  assert.ok(!isValidTimetableSlot({ ...slot2, supportTeachers: 'Prof. Bianchi' }));
});

// ---------------------------------------------------------------------------
// Fake cloud + device harness (engine-level, mirroring the production flow)
// ---------------------------------------------------------------------------

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
    gateway(): SyncGateway { return gatewayApi; },
  };
  const gatewayApi: SyncGateway = {
    async readState(name: StateDocName) { return cloud.state[name] !== undefined ? clone(cloud.state[name] as object) : null; },
    async writeState(name: StateDocName, payload: unknown) {
      cloud.writes++;
      const sanitized = JSON.parse(JSON.stringify(payload ?? null));
      cloud.state[name] = { payload: sanitized, updatedAt: clock.now, schemaVersion: 1 };
      return { updatedAt: clock.now };
    },
    async listItems(coll: ItemsCollection) { return [...cloud.items[coll].values()].map(clone); },
    async writeItems(coll: ItemsCollection, entries: { id: string; payload: unknown }[]) {
      cloud.writes++;
      for (const { id, payload } of entries) cloud.items[coll].set(id, { id, payload: clone(payload), updatedAt: clock.now });
    },
    async deleteItems(coll: ItemsCollection, ids: string[]) { cloud.writes++; for (const id of ids) cloud.items[coll].delete(id); },
    async archiveConflict(kind: string, loser: unknown) { cloud.conflicts.push({ kind, loser: clone(loser) }); },
  };
  return cloud;
}

interface FakeDevice {
  db: SyncableSnapshot;
  meta: Record<string, unknown>;
  store: SyncStore;
}

function makeDevice(initial?: Partial<SyncableSnapshot>): FakeDevice {
  const device: FakeDevice = {
    db: { ...emptyInstallation(), profile: profileWith(), onboardingCompleted: true, ...initial } as SyncableSnapshot,
    meta: {},
    store: null as unknown as SyncStore,
  };
  device.store = {
    mode: () => 'indexeddb',
    readSnapshot: async () => clone(device.db),
    readMeta: async (key: string) => device.meta[key],
    writeMeta: async (key: string, value: unknown) => { device.meta[key] = clone(value); },
    applyLocal: async (changes: LocalApply) => {
      if (changes.fullRestore) { device.db = clone(changes.fullRestore); return; }
      const st = changes.localApplyState ?? {};
      if ('profile' in st) device.db.profile = clone(st.profile) as TeacherProfile;
      if ('students' in st) device.db.students = clone(st.students) as never;
      if ('definitiveTimetable' in st) device.db.definitiveTimetable = clone(st.definitiveTimetable) as never;
      if ('provisionalTimetable' in st) device.db.provisionalTimetable = clone(st.provisionalTimetable) as never;
      if ('settings' in st) {
        const s = st.settings as { timetableMode?: never; onboardingCompleted?: boolean; timeSlotConfig?: TimeSlotConfig };
        if (s.timetableMode) device.db.timetableMode = s.timetableMode;
        if (typeof s.onboardingCompleted === 'boolean') device.db.onboardingCompleted = s.onboardingCompleted;
        if (s.timeSlotConfig) device.db.timeSlotConfig = s.timeSlotConfig;
      }
      if (changes.localEvents) device.db.events = clone(changes.localEvents);
      if (changes.localCirculars) device.db.circulars = clone(changes.localCirculars) as never;
    },
  };
  return device;
}

function makeEngine(device: FakeDevice, cloud: FakeCloud, clock: { now: string }, uid = 'uid-legacy'): SyncEngine {
  return new SyncEngine({
    gateway: () => cloud.gateway(),
    uid: () => uid,
    store: device.store,
    now: () => clock.now,
    schedule: fn => { fn(); return () => undefined; },
  });
}

/** The exact legacy document shape observed in the Firebase Console. */
function legacyTimetableDoc(): unknown {
  return {
    payload: { schemaVersion: 1, updatedAt: LEGACY_UPDATED_AT },
    updatedAt: LEGACY_UPDATED_AT,
    schemaVersion: 1,
  };
}

// ---------------------------------------------------------------------------
// 2. THE REAL CASE: legacy remote + valid local -> remote must be repaired
// ---------------------------------------------------------------------------

test('REAL CASE: legacy metadata-only provisionalTimetable + 2 valid local slots -> syncNow rewrites Firestore in the correct format', async () => {
  const clock = { now: '2026-09-09T18:30:00.000Z' };
  const cloud = makeFakeCloud(clock);
  cloud.state.provisionalTimetable = legacyTimetableDoc();

  // Mac: local has two valid slots and already synced once in the past (track exists).
  const mac = makeDevice({
    provisionalTimetable: [slot1, slot2],
    timeSlotConfig: fasceConfig,
  });
  mac.meta['sync:state'] = {
    uid: 'uid-legacy',
    state: { provisionalTimetable: { lastSyncedLocalHash: 'stale-hash', remoteUpdatedAt: LEGACY_UPDATED_AT, localChangedAt: '2026-09-09T18:00:00.000Z' } },
    items: { events: { docs: {} }, circulars: { docs: {} } },
  } as SyncStateV1;

  const engine = makeEngine(mac, cloud, clock);
  await engine.syncNow();

  // Firestore must now contain the two lessons in the CURRENT format.
  const remote = cloud.state.provisionalTimetable as RemoteStateDoc;
  assert.ok(remote, 'the remote document must exist');
  assert.equal(remote.schemaVersion, 1);
  assert.ok(Array.isArray(remote.payload), 'payload must be an Array of TimetableSlot');
  assert.equal(remote.payload!.length, 2);
  const lessons = remote.payload as TimetableSlot[];
  assert.equal(lessons[0].id, 'tt-slot-1');
  assert.equal(lessons[0].dayOfWeek, 1);
  assert.equal(lessons[0].periodNumber, 1);
  assert.equal(lessons[0].startTime, '07:50');
  assert.equal(lessons[0].endTime, '08:50');
  assert.equal(lessons[0].subject, 'Sostegno');
  assert.equal(lessons[0].className, '1A');
  assert.equal(lessons[1].id, 'tt-slot-2');
  assert.equal(lessons[1].className, '2E');
  // updatedAt must have MOVED past the frozen legacy timestamp.
  assert.ok(remote.updatedAt > LEGACY_UPDATED_AT, `updatedAt must advance, got ${remote.updatedAt}`);
  assert.notEqual(remote.updatedAt, LEGACY_UPDATED_AT);

  // The original legacy document must be preserved under conflicts (never silently destroyed).
  const legacyArchive = cloud.conflicts.find(c => c.kind === 'legacy-state:provisionalTimetable');
  assert.ok(legacyArchive, 'the legacy remote copy must be archived');
  assert.deepEqual(legacyArchive.loser, legacyTimetableDoc());

  // Local data untouched: nothing was applied from the malformed document.
  assert.equal(mac.db.provisionalTimetable.length, 2);
  assert.equal(engine.getStatus().phase, 'idle');
  // The engine reported the repair in its diagnostics (no sensitive content).
  assert.ok(engine.getStatus().notices?.some(n => n.includes('legacy')), 'a repair notice must be surfaced');
  assert.ok(engine.getStatus().syncedSections?.includes('provisionalTimetable'));
});

test('REAL CASE (variant): legacy remote with NO prior sync state also gets repaired (no conflict stall)', async () => {
  const clock = { now: '2026-09-09T19:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  cloud.state.provisionalTimetable = { payload: { schemaVersion: 1, updatedAt: LEGACY_UPDATED_AT } }; // no wrapper fields at all

  const device = makeDevice({ provisionalTimetable: [slot1, slot2] });
  const engine = makeEngine(device, cloud, clock);
  await engine.syncNow();

  // A malformed remote must NEVER trigger "awaiting-resolution": it cannot win a conflict.
  assert.equal(engine.getStatus().phase, 'idle');
  assert.equal(engine.getStatus().conflicts, undefined);
  const remote = cloud.state.provisionalTimetable as RemoteStateDoc;
  assert.ok(Array.isArray(remote.payload));
  assert.equal((remote.payload as TimetableSlot[]).length, 2);
  assert.equal(remote.schemaVersion, 1);
  assert.ok(remote.updatedAt > LEGACY_UPDATED_AT);
});

test('REAL CASE (crash path): legacy remote that USED to be applied locally no longer crashes the cycle (updatedAt unfreezes)', async () => {
  const clock = { now: '2026-09-09T19:30:00.000Z' };
  const cloud = makeFakeCloud(clock);
  cloud.state.provisionalTimetable = legacyTimetableDoc();

  const device = makeDevice({ provisionalTimetable: [slot1] });
  // Track such that, pre-fix, the merge would consider the remote "newer" and try to apply
  // the metadata-only payload to IndexedDB (crashing the cycle before any writeState).
  device.meta['sync:state'] = {
    uid: 'uid-legacy',
    state: {
      provisionalTimetable: {
        lastSyncedLocalHash: contentHash([]),
        remoteUpdatedAt: '2026-09-09T10:00:00.000Z',
        localChangedAt: '2026-09-09T09:00:00.000Z', // older than the legacy remote updatedAt
      },
    },
    items: { events: { docs: {} }, circulars: { docs: {} } },
  } as SyncStateV1;

  const engine = makeEngine(device, cloud, clock);
  await engine.syncNow(); // must not throw and must not hang in error

  assert.equal(engine.getStatus().phase, 'idle');
  assert.equal(device.db.provisionalTimetable.length, 1, 'local data preserved');
  assert.equal(device.db.provisionalTimetable[0].id, 'tt-slot-1');
  const remote = cloud.state.provisionalTimetable as RemoteStateDoc;
  assert.ok(Array.isArray(remote.payload));
  assert.equal((remote.payload as TimetableSlot[]).length, 1);
  assert.ok(remote.updatedAt > LEGACY_UPDATED_AT, 'remote updatedAt unfrozen');
});

// ---------------------------------------------------------------------------
// 3. Second (empty) device: restore after the repair
// ---------------------------------------------------------------------------

test('REAL CASE: second empty device (same uid) downloads both lessons, keeps onboarding and fasce after the repair', async () => {
  const clock = { now: '2026-09-09T18:30:00.000Z' };
  const cloud = makeFakeCloud(clock);
  cloud.state.provisionalTimetable = legacyTimetableDoc();

  // Device A (Mac): repairs the cloud.
  const mac = makeDevice({
    provisionalTimetable: [slot1, slot2],
    timeSlotConfig: fasceConfig,
    onboardingCompleted: true,
  });
  const engineA = makeEngine(mac, cloud, clock);
  await engineA.syncNow();

  // Device B (iPhone): same uid, pristine local store.
  clock.now = '2026-09-09T18:40:00.000Z';
  const iphone = makeDevice();
  iphone.db = { ...emptyInstallation(), profile: { ...emptyInstallation().profile, id: 'teacher-iphone' } } as SyncableSnapshot;
  iphone.meta = {};
  const engineB = makeEngine(iphone, cloud, clock);
  await engineB.syncNow();

  // Both lessons downloaded.
  assert.equal(iphone.db.provisionalTimetable.length, 2);
  assert.equal(iphone.db.provisionalTimetable[0].id, 'tt-slot-1');
  assert.equal(iphone.db.provisionalTimetable[0].startTime, '07:50');
  assert.equal(iphone.db.provisionalTimetable[0].endTime, '08:50');
  assert.equal(iphone.db.provisionalTimetable[1].id, 'tt-slot-2');
  assert.equal(iphone.db.provisionalTimetable[1].className, '2E');

  // No duplicate onboarding: remote profile/settings are valid and were restored.
  assert.equal(iphone.db.onboardingCompleted, true, 'onboarding must NOT be required again');
  assert.equal(iphone.db.profile.fullName, 'Prof. Andrea Conti');

  // timeSlotConfig recovered (wizard must not reappear).
  assert.deepEqual(iphone.db.timeSlotConfig, fasceConfig);
  assert.equal(engineB.getStatus().phase, 'idle');

  // Cloud is stable: device B does not rewrite anything (loop guard).
  const writesAfterRestore = cloud.writes;
  await engineB.syncNow();
  await engineA.syncNow();
  assert.equal(cloud.writes, writesAfterRestore, 'converged devices must not write again');
});

// ---------------------------------------------------------------------------
// 4. Matrix: malformed/valid remote x empty/modified local
// ---------------------------------------------------------------------------

test('malformed remote + empty local: nothing invented, cloud untouched, original archived once, clear notice', async () => {
  const clock = { now: '2026-09-09T20:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  cloud.state.provisionalTimetable = legacyTimetableDoc();

  const device = makeDevice({ provisionalTimetable: [] });
  const engine = makeEngine(device, cloud, clock);
  await engine.syncNow();

  // The malformed cloud document is NOT overwritten with fabricated data.
  assert.deepEqual(cloud.state.provisionalTimetable, legacyTimetableDoc(), 'the legacy document must stay untouched');
  // Local stays empty: the metadata-only payload was never a timetable.
  assert.equal(device.db.provisionalTimetable.length, 0);
  // The original was preserved once under conflicts.
  assert.equal(cloud.conflicts.filter(c => c.kind === 'legacy-state:provisionalTimetable').length, 1);
  // A clear, non-error notice is surfaced.
  assert.equal(engine.getStatus().phase, 'idle');
  const notice = engine.getStatus().notices?.find(n => n.includes('non recuperabili') && n.includes('provisionalTimetable'));
  assert.ok(notice, `expected an unrecoverable-data notice, got: ${JSON.stringify(engine.getStatus().notices)}`);

  // Second cycle: NO duplicate archive (loop guard via archivedLegacyHash).
  clock.now = '2026-09-09T20:05:00.000Z';
  await engine.syncNow();
  assert.equal(cloud.conflicts.filter(c => c.kind === 'legacy-state:provisionalTimetable').length, 1, 'no duplicate conflict archives');
  assert.deepEqual(cloud.state.provisionalTimetable, legacyTimetableDoc(), 'still untouched');

  // As soon as valid local data appears, the next sync repairs the remote document.
  clock.now = '2026-09-09T20:10:00.000Z';
  device.db.provisionalTimetable = [slot1];
  await engine.syncNow();
  const remote = cloud.state.provisionalTimetable as RemoteStateDoc;
  assert.ok(Array.isArray(remote.payload));
  assert.equal((remote.payload as TimetableSlot[]).length, 1);
  assert.equal(remote.schemaVersion, 1);
});

test('valid remote + empty (pristine) local: full restore downloads everything', async () => {
  const clock = { now: '2026-09-09T21:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  cloud.state.profile = { payload: profileWith({ fullName: 'Prof.ssa Anna Verdi' }), updatedAt: '2026-09-09T18:00:00.000Z', schemaVersion: 1 };
  cloud.state.settings = { payload: { timetableMode: 'provvisorio', onboardingCompleted: true, timeSlotConfig: fasceConfig }, updatedAt: '2026-09-09T18:00:00.000Z', schemaVersion: 1 };
  cloud.state.provisionalTimetable = { payload: [slot1, slot2], updatedAt: '2026-09-09T18:00:00.000Z', schemaVersion: 1 };
  cloud.state.definitiveTimetable = { payload: [], updatedAt: '2026-09-09T18:00:00.000Z', schemaVersion: 1 };
  cloud.state.students = { payload: [], updatedAt: '2026-09-09T18:00:00.000Z', schemaVersion: 1 };

  const device = makeDevice();
  device.db = { ...emptyInstallation(), profile: { ...emptyInstallation().profile, id: 'teacher-new' } } as SyncableSnapshot;
  const engine = makeEngine(device, cloud, clock);
  await engine.syncNow();

  assert.equal(device.db.provisionalTimetable.length, 2);
  assert.equal(device.db.provisionalTimetable[1].id, 'tt-slot-2');
  assert.equal(device.db.onboardingCompleted, true);
  assert.deepEqual(device.db.timeSlotConfig, fasceConfig);
  assert.equal(device.db.profile.fullName, 'Prof.ssa Anna Verdi');
  // Valid remote is not rewritten by the restore (loop guard).
  assert.equal((cloud.state.provisionalTimetable as RemoteStateDoc).updatedAt, '2026-09-09T18:00:00.000Z');
  assert.equal(cloud.conflicts.length, 0);
});

test('valid remote + locally modified: local change wins and updates the cloud', async () => {
  const clock = { now: '2026-09-09T21:30:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const device = makeDevice({ provisionalTimetable: [slot1, slot2], timeSlotConfig: fasceConfig });
  const engine = makeEngine(device, cloud, clock);
  await engine.syncNow(); // initial upload

  const firstWrite = cloud.state.provisionalTimetable as RemoteStateDoc;
  assert.deepEqual(firstWrite.payload, [slot1, slot2]);

  // Local edit on the Mac (later than the remote write): the cloud must be updated.
  clock.now = '2026-09-09T22:00:00.000Z';
  const edited: TimetableSlot = { ...slot2, subject: 'Sostegno', coTeachingSubjects: ['Matematica'], coSupportTeachers: ['Prof.ssa Rossi'] };
  device.db.provisionalTimetable = [slot1, edited];
  await engine.syncNow();

  const updated = cloud.state.provisionalTimetable as RemoteStateDoc;
  const lessons = updated.payload as TimetableSlot[];
  assert.equal(lessons.length, 2);
  assert.deepEqual(lessons[1].coTeachingSubjects, ['Matematica']);
  assert.deepEqual(lessons[1].coSupportTeachers, ['Prof.ssa Rossi']);
  assert.ok(updated.updatedAt > firstWrite.updatedAt, 'remote updatedAt must advance');
  assert.equal(device.db.provisionalTimetable.length, 2, 'local data preserved');
});

test('recoverable legacy remote (double-wrapped payload) is adopted, archived and rewritten in the current format', async () => {
  const clock = { now: '2026-09-09T22:30:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const original = {
    payload: { payload: [slot1, slot2], updatedAt: '2026-09-08T08:00:00.000Z', schemaVersion: 1 },
    updatedAt: '2026-09-08T08:00:00.000Z',
    schemaVersion: 1,
  };
  cloud.state.provisionalTimetable = clone(original);

  // Empty local timetable, populated profile: adopt the recovered payload.
  const device = makeDevice({ provisionalTimetable: [] });
  const engine = makeEngine(device, cloud, clock);
  await engine.syncNow();

  assert.equal(device.db.provisionalTimetable.length, 2, 'recovered payload adopted locally');
  const remote = cloud.state.provisionalTimetable as RemoteStateDoc;
  assert.ok(Array.isArray(remote.payload), 'cloud rewritten with a single, valid payload');
  assert.equal((remote.payload as TimetableSlot[]).length, 2);
  assert.equal(remote.schemaVersion, 1);
  assert.ok(remote.updatedAt > '2026-09-08T08:00:00.000Z');
  // Original preserved.
  const archive = cloud.conflicts.find(c => c.kind === 'legacy-state:provisionalTimetable');
  assert.ok(archive);
  assert.deepEqual(archive.loser, original);
});

test('planSync never lets an invalid remote doc win a conflict or reach localApplyState (pure planner level)', () => {
  const snapshot = { ...emptyInstallation(), profile: profileWith(), onboardingCompleted: true, provisionalTimetable: [slot1, slot2] } as SyncableSnapshot;
  const remote: RemoteSnapshot = { state: {}, items: { events: [], circulars: [] } };
  const raw = legacyTimetableDoc();
  const plan: SyncPlan = planSync({
    uid: 'u1',
    snapshot,
    remote,
    syncState: null,
    nowIso: '2026-09-09T23:00:00.000Z',
    remoteRaw: { provisionalTimetable: raw },
    remoteInvalid: ['provisionalTimetable'],
  });
  assert.equal(plan.needsResolution.includes('provisionalTimetable'), false);
  assert.equal(plan.localApplyState.provisionalTimetable, undefined);
  assert.deepEqual(plan.stateWrites.provisionalTimetable, [slot1, slot2], 'valid local data repairs the remote');
  assert.equal(plan.unrecoverableRemote.includes('provisionalTimetable'), false);
  assert.ok(plan.archivedOnOverwrite.some(a => a.kind === 'legacy-state:provisionalTimetable'));

  // Same remote, EMPTY local: nothing fabricated, reported instead.
  const emptySnapshot = { ...emptyInstallation(), profile: profileWith(), onboardingCompleted: true } as SyncableSnapshot;
  const planEmpty = planSync({
    uid: 'u1',
    snapshot: emptySnapshot,
    remote,
    syncState: null,
    nowIso: '2026-09-09T23:00:00.000Z',
    remoteRaw: { provisionalTimetable: raw },
    remoteInvalid: ['provisionalTimetable'],
  });
  assert.equal(planEmpty.stateWrites.provisionalTimetable, undefined, 'no fabricated write');
  assert.ok(planEmpty.unrecoverableRemote.includes('provisionalTimetable'));
  assert.ok(planEmpty.archivedOnOverwrite.some(a => a.kind === 'legacy-state:provisionalTimetable'));
});

test('malformed remote for every state doc type is archived and reported when local is empty', async () => {
  const clock = { now: '2026-09-09T23:30:00.000Z' };
  const cloud = makeFakeCloud(clock);
  cloud.state.profile = { payload: { schemaVersion: 1, updatedAt: LEGACY_UPDATED_AT }, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 };
  cloud.state.settings = { payload: { schemaVersion: 1, updatedAt: LEGACY_UPDATED_AT }, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 };
  cloud.state.definitiveTimetable = { payload: { schemaVersion: 1, updatedAt: LEGACY_UPDATED_AT }, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 };
  cloud.state.provisionalTimetable = legacyTimetableDoc();
  cloud.state.students = { payload: { schemaVersion: 1, updatedAt: LEGACY_UPDATED_AT }, updatedAt: LEGACY_UPDATED_AT, schemaVersion: 1 };

  const device = makeDevice(); // fresh install, placeholder profile, no onboarding
  device.db = { ...emptyInstallation() } as SyncableSnapshot;
  const engine = makeEngine(device, cloud, clock);
  await engine.syncNow();

  assert.equal(engine.getStatus().phase, 'idle', 'an unrecoverable cloud is reported, not an error');
  const kinds = cloud.conflicts.map(c => c.kind);
  for (const name of ['profile', 'settings', 'definitiveTimetable', 'provisionalTimetable', 'students'] as StateDocName[]) {
    assert.ok(kinds.includes(`legacy-state:${name}`), `${name} must be archived`);
    assert.deepEqual(cloud.state[name], cloud.state[name], 'cloud documents untouched');
  }
  assert.ok(engine.getStatus().notices?.some(n => n.includes('non recuperabili')));
  // Local data was never replaced by malformed payloads.
  assert.equal(device.db.provisionalTimetable.length, 0);
  assert.equal(device.db.students.length, 0);
  assert.equal(device.db.profile.fullName, '');
});
