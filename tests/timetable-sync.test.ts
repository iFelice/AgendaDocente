import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../src/services/db';
import { storage, initializeStorage, emptyInstallation } from '../src/services/storage';
import {
  generateDefaultPeriodSlots,
  getEffectivePeriodSlots,
  normalizeClassName,
  addMinutesToTime,
  DEFAULT_TIME_SLOT_CONFIG,
} from '../src/utils/timeSlots';
import { canonicalStringify, contentHash, isPristineLocal, planSync } from '../src/services/sync/merge';
import { SyncEngine, type LocalApply, type SyncStore } from '../src/services/sync/engine';
import type {
  ItemsCollection,
  RemoteItem,
  RemoteSnapshot,
  SyncGateway,
  SyncStateV1,
  SyncableSnapshot,
  StateDocName,
} from '../src/services/sync/types';
import type { TeacherProfile, TimetableSlot, TimeSlotConfig } from '../src/types';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TimetableEditor } from '../src/components/TimetableEditor';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clone = <T>(v: T): T => structuredClone(v);

function profileWith(patch: Partial<TeacherProfile> = {}): TeacherProfile {
  return {
    ...(emptyInstallation().profile as TeacherProfile),
    fullName: 'Prof. Andrea Conti',
    schoolName: 'IC Leonardo Da Vinci',
    schoolYear: '2026/2027',
    schoolLevel: 'ssig',
    classes: ['1A', '2E'],
    primarySubjects: ['Scienze Motorie', 'Sostegno'],
    campuses: ['Sede Centrale'],
    roles: [],
    ...patch,
  };
}

const slot1: TimetableSlot = {
  id: 'tt-slot-1',
  dayOfWeek: 1, // Lunedì
  periodNumber: 1,
  startTime: '07:50',
  endTime: '08:50',
  subject: 'Scienze Motorie',
  className: '1A',
  classroom: 'Palestra A',
  campus: 'Sede Centrale',
  isProvisional: true,
};

const slot2: TimetableSlot = {
  id: 'tt-slot-2',
  dayOfWeek: 3, // Mercoledì
  periodNumber: 3,
  startTime: '09:50',
  endTime: '10:50',
  subject: 'Scienze Motorie',
  className: '2E',
  classroom: 'Palestra B',
  campus: 'Sede Centrale',
  isProvisional: true,
};

const customFasceConfig: TimeSlotConfig = {
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

interface FakeCloud {
  gateway(): SyncGateway;
  state: Record<string, { payload: unknown; updatedAt: string; schemaVersion: 1 } | null>;
  items: Record<ItemsCollection, Map<string, RemoteItem>>;
  conflicts: { kind: string; loser: unknown }[];
  writes: number;
}

function makeFakeCloud(clock: { now: string }): FakeCloud {
  const cloud = {
    state: {} as Record<string, { payload: unknown; updatedAt: string; schemaVersion: 1 } | null>,
    items: {
      events: new Map<string, RemoteItem>(),
      circulars: new Map<string, RemoteItem>(),
    } as Record<ItemsCollection, Map<string, RemoteItem>>,
    conflicts: [] as { kind: string; loser: unknown }[],
    writes: 0,
    gateway(): SyncGateway {
      return gatewayApi;
    },
  };
  const gatewayApi: SyncGateway = {
    async readState(name: StateDocName) {
      return cloud.state[name] ? clone(cloud.state[name]) : null;
    },
    async writeState(name: StateDocName, payload: unknown) {
      cloud.writes++;
      const updatedAt = clock.now;
      // Sanitize undefined like production firestoreGateway does
      const sanitized = JSON.parse(JSON.stringify(payload ?? null));
      cloud.state[name] = { payload: sanitized, updatedAt, schemaVersion: 1 };
      return { updatedAt };
    },
    async listItems(coll: ItemsCollection) {
      return [...cloud.items[coll].values()].map(clone);
    },
    async writeItems(coll: ItemsCollection, entries: { id: string; payload: unknown }[]) {
      cloud.writes++;
      for (const { id, payload } of entries) {
        const sanitized = JSON.parse(JSON.stringify(payload ?? null));
        cloud.items[coll].set(id, { id, payload: sanitized, updatedAt: clock.now });
      }
    },
    async deleteItems(coll: ItemsCollection, ids: string[]) {
      cloud.writes++;
      for (const id of ids) cloud.items[coll].delete(id);
    },
    async archiveConflict(kind: string, loser: unknown) {
      cloud.conflicts.push({ kind, loser: clone(loser) });
    },
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
    db: {
      ...emptyInstallation(),
      profile: profileWith(),
      onboardingCompleted: true,
      ...initial,
    },
    meta: {},
    store: null as unknown as SyncStore,
  };

  device.store = {
    mode: () => 'indexeddb',
    readSnapshot: async () => clone(device.db),
    readMeta: async (key: string) => device.meta[key],
    writeMeta: async (key: string, value: unknown) => {
      device.meta[key] = clone(value);
    },
    applyLocal: async (changes: LocalApply) => {
      if (changes.fullRestore) {
        device.db = clone(changes.fullRestore);
        return;
      }
      const st = changes.localApplyState ?? {};
      if ('profile' in st) device.db.profile = clone(st.profile) as TeacherProfile;
      if ('students' in st) device.db.students = clone(st.students) as never;
      if ('definitiveTimetable' in st) device.db.definitiveTimetable = clone(st.definitiveTimetable) as never;
      if ('provisionalTimetable' in st) device.db.provisionalTimetable = clone(st.provisionalTimetable) as never;
      if ('settings' in st) {
        const s = st.settings as {
          timetableMode?: never;
          onboardingCompleted?: boolean;
          timeSlotConfig?: TimeSlotConfig;
        };
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

function makeEngine(
  device: FakeDevice,
  cloud: FakeCloud,
  clock: { now: string },
  uid = 'uid-test'
): SyncEngine {
  return new SyncEngine({
    gateway: () => cloud.gateway(),
    uid: () => uid,
    store: device.store,
    now: () => clock.now,
    schedule: (fn) => {
      fn();
      return () => undefined;
    },
  });
}

let memory: Map<string, string>;
beforeEach(async () => {
  memory = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return memory.size;
      },
      key: (i: number) => [...memory.keys()][i] ?? null,
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memory.set(k, String(v));
      },
      removeItem: (k: string) => memory.delete(k),
    },
  });
  database.close();
  await database.delete();
  await initializeStorage();
});

// =========================================================================
// 1. FASCE ORARIE & GENERATION TESTS
// =========================================================================

test('slot generation 07:50 + 60 min produces exact 6 consecutive 60-minute periods', () => {
  const slots = generateDefaultPeriodSlots('07:50', 6, 60);
  assert.equal(slots.length, 6);
  assert.deepEqual(slots, [
    { periodNumber: 1, label: '1ª Ora', startTime: '07:50', endTime: '08:50' },
    { periodNumber: 2, label: '2ª Ora', startTime: '08:50', endTime: '09:50' },
    { periodNumber: 3, label: '3ª Ora', startTime: '09:50', endTime: '10:50' },
    { periodNumber: 4, label: '4ª Ora', startTime: '10:50', endTime: '11:50' },
    { periodNumber: 5, label: '5ª Ora', startTime: '11:50', endTime: '12:50' },
    { periodNumber: 6, label: '6ª Ora', startTime: '12:50', endTime: '13:50' },
  ]);
});

test('addMinutesToTime handles standard addition, hour transitions and day wrap', () => {
  assert.equal(addMinutesToTime('07:50', 60), '08:50');
  assert.equal(addMinutesToTime('08:50', 55), '09:45');
  assert.equal(addMinutesToTime('09:45', 15), '10:00');
  assert.equal(addMinutesToTime('23:30', 45), '00:15');
});

test('custom slots are preserved in order when provided in config', () => {
  const customConfig: TimeSlotConfig = {
    firstHourStartTime: '08:00',
    periodsPerDay: 5,
    standardDurationMinutes: 50,
    customSlots: [
      { periodNumber: 1, label: '1ª Ora', startTime: '08:00', endTime: '08:55' },
      { periodNumber: 2, label: '2ª Ora', startTime: '08:55', endTime: '09:50' },
      { periodNumber: 3, label: '3ª Ora (Ricreazione)', startTime: '10:05', endTime: '11:00' },
      { periodNumber: 4, label: '4ª Ora', startTime: '11:00', endTime: '11:55' },
      { periodNumber: 5, label: '5ª Ora', startTime: '11:55', endTime: '12:50' },
    ],
  };

  const effective = getEffectivePeriodSlots(customConfig);
  assert.equal(effective.length, 5);
  assert.equal(effective[0].startTime, '08:00');
  assert.equal(effective[0].endTime, '08:55');
  assert.equal(effective[2].startTime, '10:05');
  assert.equal(effective[2].endTime, '11:00');
});

test('getEffectivePeriodSlots falls back to defaults when config is undefined', () => {
  const effective = getEffectivePeriodSlots(undefined);
  assert.ok(effective.length >= 6);
  assert.equal(effective[0].periodNumber, 1);
});

// =========================================================================
// 2. CLASS NORMALIZATION TESTS
// =========================================================================

test('duplicate class normalization trims spaces and uppercases names', () => {
  assert.equal(normalizeClassName(' 1a '), '1A');
  assert.equal(normalizeClassName('2e'), '2E');
  assert.equal(normalizeClassName('  3c  '), '3C');

  const classes = ['1A', '2E'];
  const newClassInput = '  1a  ';
  const normalized = normalizeClassName(newClassInput);
  const isDuplicate = classes.some((c) => normalizeClassName(c) === normalized);
  assert.equal(isDuplicate, true);

  const distinctClass = ' 3b ';
  const normalizedDistinct = normalizeClassName(distinctClass);
  const isDistinctDuplicate = classes.some((c) => normalizeClassName(c) === normalizedDistinct);
  assert.equal(isDistinctDuplicate, false);
});

// =========================================================================
// 3. PERSISTENCE & BACKUP/RESTORE OF FASCE ORARIE
// =========================================================================

test('persistence of fasce in IndexedDB roundtrips correctly', async () => {
  await storage.saveTimeSlotConfig(customFasceConfig);
  const retrieved = await storage.getTimeSlotConfig();
  assert.deepEqual(retrieved, customFasceConfig);

  const snapshot = await database.readSnapshot();
  assert.deepEqual(snapshot.timeSlotConfig, customFasceConfig);
});

test('backup and restore of fasce preserves custom configuration', async () => {
  await storage.saveTimeSlotConfig(customFasceConfig);
  await storage.saveProvisionalTimetable([slot1, slot2]);

  const backupJson = await storage.exportDataBackup();
  const parsed = JSON.parse(backupJson);
  assert.equal(parsed.version, 3);
  assert.deepEqual(parsed.timeSlotConfig, customFasceConfig);
  assert.equal(parsed.provisionalTimetable.length, 2);

  // Clear data and restore from backup
  await storage.saveTimeSlotConfig(DEFAULT_TIME_SLOT_CONFIG);
  await storage.saveProvisionalTimetable([]);
  const success = await storage.importDataBackup(backupJson);
  assert.equal(success, true);

  const restoredConfig = await storage.getTimeSlotConfig();
  assert.deepEqual(restoredConfig, customFasceConfig);
  const restoredSlots = await storage.getProvisionalTimetable();
  assert.equal(restoredSlots.length, 2);
  assert.equal(restoredSlots[0].className, '1A');
  assert.equal(restoredSlots[1].className, '2E');
});

// =========================================================================
// 4. TIMETABLE SERIALIZATION & FIRESTORE UPLOAD
// =========================================================================

test('timetable serialization & Firestore upload: mock Firestore contains full lesson objects, not empty metadata', async () => {
  const clock = { now: '2026-09-09T17:47:36.000Z' };
  const cloud = makeFakeCloud(clock);
  const device = makeDevice({
    provisionalTimetable: [slot1, slot2],
    definitiveTimetable: [],
    timeSlotConfig: customFasceConfig,
  });

  const engine = makeEngine(device, cloud, clock, 'uid-user-1');
  await engine.syncNow();

  // Verify Firestore state documents are created
  assert.ok(cloud.state.provisionalTimetable, 'provisionalTimetable doc must exist in Firestore');
  assert.ok(cloud.state.settings, 'settings doc must exist in Firestore');
  assert.ok(cloud.state.profile, 'profile doc must exist in Firestore');

  // Verify that provisionalTimetable payload REALLY contains the 2 lessons
  const provDoc = cloud.state.provisionalTimetable!;
  assert.equal(provDoc.schemaVersion, 1);
  assert.equal(provDoc.updatedAt, clock.now);
  assert.ok(Array.isArray(provDoc.payload), 'provisionalTimetable payload must be an array');
  const uploadedLessons = provDoc.payload as TimetableSlot[];
  assert.equal(uploadedLessons.length, 2, 'Firestore payload must contain exactly 2 lessons');
  assert.equal(uploadedLessons[0].id, 'tt-slot-1');
  assert.equal(uploadedLessons[0].dayOfWeek, 1);
  assert.equal(uploadedLessons[0].periodNumber, 1);
  assert.equal(uploadedLessons[0].startTime, '07:50');
  assert.equal(uploadedLessons[0].endTime, '08:50');
  assert.equal(uploadedLessons[0].subject, 'Scienze Motorie');
  assert.equal(uploadedLessons[0].className, '1A');

  assert.equal(uploadedLessons[1].id, 'tt-slot-2');
  assert.equal(uploadedLessons[1].dayOfWeek, 3);
  assert.equal(uploadedLessons[1].periodNumber, 3);
  assert.equal(uploadedLessons[1].startTime, '09:50');
  assert.equal(uploadedLessons[1].endTime, '10:50');
  assert.equal(uploadedLessons[1].subject, 'Scienze Motorie');
  assert.equal(uploadedLessons[1].className, '2E');

  // Verify settings document contains timeSlotConfig
  const settingsDoc = cloud.state.settings!;
  const settingsPayload = settingsDoc.payload as { timeSlotConfig?: TimeSlotConfig };
  assert.ok(settingsPayload.timeSlotConfig, 'settings payload must contain timeSlotConfig');
  assert.equal(settingsPayload.timeSlotConfig!.firstHourStartTime, '07:50');
  assert.equal(settingsPayload.timeSlotConfig!.periodsPerDay, 6);
  assert.equal(settingsPayload.timeSlotConfig!.standardDurationMinutes, 60);
});

// =========================================================================
// 5. REMOTE -> LOCAL TIMETABLE RESTORE (SECOND DEVICE / IPHONE)
// =========================================================================

test('remote -> local restore on empty second device reconstructs profile, fasce and both timetable lessons', async () => {
  const clock = { now: '2026-09-09T18:00:00.000Z' };
  const cloud = makeFakeCloud(clock);

  // Step 1: Device A (Mac) populates and uploads data
  const deviceA = makeDevice({
    profile: profileWith({ fullName: 'Prof. Andrea Conti', classes: ['1A', '2E'] }),
    provisionalTimetable: [slot1, slot2],
    definitiveTimetable: [],
    timeSlotConfig: customFasceConfig,
    onboardingCompleted: true,
  });
  const engineA = makeEngine(deviceA, cloud, clock, 'uid-user-1');
  await engineA.syncNow();

  // Step 2: Device B (iPhone) starts with clean/pristine IndexedDB
  clock.now = '2026-09-09T18:05:00.000Z';
  const deviceB = makeDevice();
  // Simulate fresh install state on Device B
  deviceB.db = {
    ...emptyInstallation(),
    profile: { ...emptyInstallation().profile, id: 'teacher-device-b' },
  };
  deviceB.meta = {};

  const engineB = makeEngine(deviceB, cloud, clock, 'uid-user-1');
  await engineB.syncNow(); // First sync of Device B

  // Verify Device B adopted everything from cloud
  assert.equal(deviceB.db.profile.fullName, 'Prof. Andrea Conti');
  assert.deepEqual(deviceB.db.profile.classes, ['1A', '2E']);
  assert.equal(deviceB.db.onboardingCompleted, true, 'Device B must not be asked to re-onboard');
  assert.deepEqual(deviceB.db.timeSlotConfig, customFasceConfig);

  // Verify both lessons are reconstructed on Device B
  assert.equal(deviceB.db.provisionalTimetable.length, 2);
  assert.equal(deviceB.db.provisionalTimetable[0].id, 'tt-slot-1');
  assert.equal(deviceB.db.provisionalTimetable[0].className, '1A');
  assert.equal(deviceB.db.provisionalTimetable[0].startTime, '07:50');
  assert.equal(deviceB.db.provisionalTimetable[0].endTime, '08:50');

  assert.equal(deviceB.db.provisionalTimetable[1].id, 'tt-slot-2');
  assert.equal(deviceB.db.provisionalTimetable[1].className, '2E');
  assert.equal(deviceB.db.provisionalTimetable[1].startTime, '09:50');
  assert.equal(deviceB.db.provisionalTimetable[1].endTime, '10:50');
});

// =========================================================================
// 6. LOCAL EMPTY + REMOTE POPULATED (NEVER OVERWRITE CLOUD)
// =========================================================================

test('empty local + populated remote: empty local state NEVER overwrites populated cloud', async () => {
  const clock = { now: '2026-09-09T19:00:00.000Z' };
  const cloud = makeFakeCloud(clock);

  // Cloud already has provisionalTimetable with 2 lessons
  cloud.state.profile = {
    payload: profileWith({ fullName: 'Docente Cloud' }),
    updatedAt: '2026-09-09T18:00:00.000Z',
    schemaVersion: 1,
  };
  cloud.state.settings = {
    payload: { timetableMode: 'provvisorio', onboardingCompleted: true, timeSlotConfig: customFasceConfig },
    updatedAt: '2026-09-09T18:00:00.000Z',
    schemaVersion: 1,
  };
  cloud.state.provisionalTimetable = {
    payload: [slot1, slot2],
    updatedAt: '2026-09-09T18:00:00.000Z',
    schemaVersion: 1,
  };
  cloud.state.definitiveTimetable = {
    payload: [],
    updatedAt: '2026-09-09T18:00:00.000Z',
    schemaVersion: 1,
  };
  cloud.state.students = {
    payload: [],
    updatedAt: '2026-09-09T18:00:00.000Z',
    schemaVersion: 1,
  };

  // Local device has empty provisionalTimetable
  const localDevice = makeDevice({
    profile: profileWith({ fullName: 'Docente Cloud' }),
    provisionalTimetable: [],
    onboardingCompleted: true,
  });

  const engine = makeEngine(localDevice, cloud, clock, 'uid-user-1');
  await engine.syncNow();

  // Cloud provisionalTimetable MUST still contain both lessons!
  const remoteLessons = cloud.state.provisionalTimetable!.payload as TimetableSlot[];
  assert.equal(remoteLessons.length, 2, 'Cloud lessons must NOT be deleted by empty local');
  assert.equal(remoteLessons[0].id, 'tt-slot-1');

  // And local device should adopt the remote lessons
  assert.equal(localDevice.db.provisionalTimetable.length, 2);
  assert.equal(localDevice.db.provisionalTimetable[0].className, '1A');
});

// =========================================================================
// 7. POPULATED LOCAL + EMPTY REMOTE
// =========================================================================

test('populated local + empty remote: pushes local timetable and fasce to cloud', async () => {
  const clock = { now: '2026-09-09T20:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const localDevice = makeDevice({
    profile: profileWith({ fullName: 'Docente A', classes: ['1A', '2E'] }),
    definitiveTimetable: [slot1],
    provisionalTimetable: [slot2],
    timeSlotConfig: customFasceConfig,
  });

  const engine = makeEngine(localDevice, cloud, clock, 'uid-user-1');
  await engine.syncNow();

  assert.ok(cloud.state.definitiveTimetable);
  assert.equal((cloud.state.definitiveTimetable!.payload as TimetableSlot[]).length, 1);
  assert.equal((cloud.state.definitiveTimetable!.payload as TimetableSlot[])[0].id, 'tt-slot-1');

  assert.ok(cloud.state.provisionalTimetable);
  assert.equal((cloud.state.provisionalTimetable!.payload as TimetableSlot[]).length, 1);
  assert.equal((cloud.state.provisionalTimetable!.payload as TimetableSlot[])[0].id, 'tt-slot-2');
});

// =========================================================================
// 9. TIMETABLE EDITOR COMPONENT: CLASS DROPDOWN & ADD CLASS & PERIOD PREFILL
// =========================================================================

test('TimetableEditor renders class dropdown from profile, handles + Aggiungi classe with normalization', async () => {
  let savedProfile: TeacherProfile | undefined;
  let savedSlot: TimetableSlot | undefined;
  const testProfile = profileWith({ classes: ['1A', '2E'] });

  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(TimetableEditor, {
        profile: testProfile,
        definitiveTimetable: [],
        provisionalTimetable: [],
        timetableMode: 'auto',
        activeType: 'provvisorio',
        isDefinitiveCompiled: false,
        timeSlotConfig: customFasceConfig,
        onSaveSlot: (s: TimetableSlot) => { savedSlot = s; },
        onDeleteSlot: () => {},
        onSetTimetableMode: () => {},
        onCopyProvisionalToDefinitive: () => {},
        onCopyDefinitiveToProvisional: () => {},
        onClearTimetable: () => {},
        onSaveProfile: (p: TeacherProfile) => { savedProfile = p; },
        onSaveTimeSlotConfig: () => {},
      })
    );
  });

  // Find the button to add a slot in Monday period 1
  const plusButtons = renderer.root.findAll((el: any) =>
    el.type === 'button' && el.props.title && el.props.title.includes('Lunedì')
  );
  assert.ok(plusButtons.length > 0, 'Must find grid slot add buttons');

  // Click on Monday period 1 cell
  await act(async () => {
    plusButtons[0].props.onClick();
  });

  // Check that the modal opened and find the class select
  const selects = renderer.root.findAllByType('select');
  const classSelect = selects.find((sel: any) =>
    sel.findAllByType && sel.findAllByType('option').some((o: any) => o.props.value === '1A')
  );
  assert.ok(classSelect, 'Class select must be present');

  // Verify options in class select include 1A and 2E
  const options = classSelect.findAllByType('option').map((o: any) => o.props.value);
  assert.ok(options.includes('1A'));
  assert.ok(options.includes('2E'));
  assert.ok(options.includes('__ADD_NEW__'));

  // Click "+ Nuova" button to switch to inline class creation
  const nuovaClassBtn = renderer.root.find((el: any) =>
    el.type === 'button' && el.props.title === 'Aggiungi una nuova classe'
  );
  assert.ok(nuovaClassBtn);

  await act(async () => {
    nuovaClassBtn.props.onClick();
  });

  // Find class input and type " 3b "
  const classInput = renderer.root.find((el: any) =>
    el.type === 'input' && el.props.placeholder && el.props.placeholder.includes('1A')
  );
  assert.ok(classInput);

  await act(async () => {
    classInput.props.onChange({ target: { value: ' 3b ' } });
  });

  // Click Aggiungi button
  const addBtn = renderer.root.find((el: any) =>
    el.type === 'button' && el.children && el.children.includes('Aggiungi')
  );
  assert.ok(addBtn);

  await act(async () => {
    await addBtn.props.onClick();
  });

  // Verify onSaveProfile was called with normalized class "3B"
  assert.ok(savedProfile, 'onSaveProfile must have been called');
  assert.deepEqual(savedProfile.classes, ['1A', '2E', '3B']);

  // Submit the slot form
  const form = renderer.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault: () => {} });
  });

  // Verify slot was saved with class 3B, day 1, period 1, and times derived from fasce
  assert.ok(savedSlot);
  assert.equal(savedSlot.className, '3B');
  assert.equal(savedSlot.dayOfWeek, 1);
  assert.equal(savedSlot.periodNumber, 1);
  assert.equal(savedSlot.startTime, '07:50');
  assert.equal(savedSlot.endTime, '08:50');
});

