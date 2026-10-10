/**
 * DATI SENSIBILI: non escono mai dal dispositivo.
 *
 * Copre i punti A–F:
 *  A. uscita pulita (documento di stato, scritture in blocco, archivio conflitti);
 *  B. ingresso dal cloud che conserva i dati locali e ignora quelli remoti;
 *  C. riscrittura di pulizia del cloud, una sola volta per account, e conteggio
 *     (senza contenuti) degli archivi conflitti;
 *  D. profilo senza `assignedStudents` verso gli endpoint di analisi;
 *  E. riga informativa nella scheda alunno;
 *  F. backup locale ancora completo.
 *
 * Nessuna dipendenza nuova: stesso fake cloud degli altri test di sync.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { SyncEngine, type LocalApply, type SyncStore } from '../src/services/sync/engine';
import { contentHash, planSync, statePayload } from '../src/services/sync/merge';
import type {
  ItemsCollection,
  RemoteConflictArchive,
  RemoteItem,
  RemoteSnapshot,
  RemoteStateDoc,
  StateDocName,
  SyncGateway,
  SyncStateV1,
  SyncableSnapshot,
} from '../src/services/sync/types';
import {
  LOCAL_ONLY_SENSITIVE_NOTICE,
  SENSITIVE_PROFILE_FIELDS,
  SENSITIVE_STUDENT_FIELDS,
  countSensitiveArchives,
  hasSensitiveStatePayload,
} from '../src/services/sensitiveData';
import { analyzeCircular } from '../src/services/aiService';
import { analyzeStudentDocument, analyzeTimetableDocument } from '../src/services/scanService';
import { ClassesView } from '../src/components/ClassesView';
import { database } from '../src/services/db';
import { emptyInstallation, storage } from '../src/services/storage';
import type { CalendarEvent, Student, TeacherProfile } from '../src/types';
import { installSignedInAnalysisClient } from './helpers/analysisClientSession';
installSignedInAnalysisClient();


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clone = <T>(value: T): T => structuredClone(value);

// ---------------------------------------------------------------------------
// Dati di prova
// ---------------------------------------------------------------------------

const SENSITIVE = {
  isSupportStudent: true,
  peiType: 'differenziato' as const,
  supportHoursPerWeek: 9,
  hasBesDsa: true,
  pdpApproved: true,
  diagnosticSummary: 'Profilo di funzionamento riservato',
  specialists: 'NPI dott.ssa Bianchi, logopedista',
  gloDate: '2026-11-12',
};

const student = (id: string, patch: Partial<Student> = {}): Student => ({
  id,
  fullName: `Alunno ${id}`,
  className: '2E',
  notes: [],
  ...patch,
});

const profileWith = (patch: Partial<TeacherProfile> = {}): TeacherProfile => ({
  ...(emptyInstallation().profile as TeacherProfile),
  fullName: 'Anna Testi',
  schoolName: 'IC Prova',
  roles: [],
  ...patch,
});

const event = (id: string, patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  title: `Evento ${id}`,
  date: '2026-09-15',
  isAllDay: false,
  startTime: '15:00',
  endTime: '16:00',
  category: 'riunione',
  sourceType: 'manuale',
  ...patch,
}) as CalendarEvent;

const snapshotWith = (patch: Partial<SyncableSnapshot> = {}): SyncableSnapshot =>
  ({ ...emptyInstallation(), onboardingCompleted: true, profile: profileWith(), ...patch }) as SyncableSnapshot;

const emptyRemote = (): RemoteSnapshot => ({ state: {}, items: { events: [], circulars: [] } });

/** Nessun campo sensibile, a nessuna profondità, in un valore qualunque. */
function assertNoSensitiveData(value: unknown, message: string): void {
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) { node.forEach((entry, index) => walk(entry, `${path}[${index}]`)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if ((SENSITIVE_STUDENT_FIELDS as readonly string[]).includes(key) || (SENSITIVE_PROFILE_FIELDS as readonly string[]).includes(key)) {
        assert.fail(`${message}: trovato campo riservato "${key}" in ${path}`);
      }
      walk(entry, `${path}.${key}`);
    }
  };
  walk(value, '$');
}

// ---------------------------------------------------------------------------
// Fake cloud / device (stessa forma di tests/sync.test.ts)
// ---------------------------------------------------------------------------

interface FakeCloud {
  gateway(): SyncGateway;
  state: Record<string, unknown>;
  items: Record<ItemsCollection, Map<string, RemoteItem>>;
  conflicts: RemoteConflictArchive[];
  writes: number;
  conflictReads: number;
}

function makeFakeCloud(clock: { now: string }, conflictArchives: RemoteConflictArchive[] = []): FakeCloud {
  const cloud: FakeCloud = {
    state: {},
    items: { events: new Map(), circulars: new Map(), assessments: new Map(), scheduledAssessments: new Map() } as Record<ItemsCollection, Map<string, RemoteItem>>,
    conflicts: conflictArchives,
    writes: 0,
    conflictReads: 0,
    gateway() { return gatewayApi; },
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
    async archiveConflict(kind, payload) {
      cloud.conflicts.push({ id: `conflict-${cloud.conflicts.length}`, kind, payload: clone(payload) });
    },
    async listConflicts() { cloud.conflictReads++; return clone(cloud.conflicts); },
  };
  return cloud;
}

interface FakeDevice { db: SyncableSnapshot; meta: Record<string, unknown>; store: SyncStore }

function makeDevice(initial?: Partial<SyncableSnapshot>): FakeDevice {
  const db = snapshotWith({ ...initial });
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
      if ('settings' in st) {
        const s = st.settings as { timetableMode?: never; onboardingCompleted?: boolean };
        if (s.timetableMode) db.timetableMode = s.timetableMode;
        if (typeof s.onboardingCompleted === 'boolean') db.onboardingCompleted = s.onboardingCompleted;
      }
      if (changes.localEvents) db.events = clone(changes.localEvents);
      if (changes.localCirculars) db.circulars = clone(changes.localCirculars) as never;
      if (changes.localAssessments) db.assessments = clone(changes.localAssessments) as never;
      if (changes.localScheduledAssessments) db.scheduledAssessments = clone(changes.localScheduledAssessments) as never;
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
    schedule: fn => { fn(); return () => undefined; },
  });
}

const stateDoc = (payload: unknown, updatedAt: string): RemoteStateDoc => ({ payload, updatedAt, schemaVersion: 1 });

/** Stato di sync "già allineato" su tutti i documenti di stato: nessun caricamento iniziale. */
function alignedState(snapshot: SyncableSnapshot, remote: RemoteSnapshot, updatedAt = 't0'): SyncStateV1 {
  const state: SyncStateV1['state'] = {};
  for (const name of ['profile', 'settings', 'definitiveTimetable', 'provisionalTimetable', 'students'] as StateDocName[]) {
    const remoteDoc = remote.state[name];
    // Un documento senza copia remota non ha track: il piano lo tratterebbe come
    // un caricamento iniziale (o come una copia sparita) e scriverebbe comunque.
    if (!remoteDoc) continue;
    state[name] = { lastSyncedLocalHash: contentHash(remoteDoc.payload), remoteUpdatedAt: remoteDoc.updatedAt };
  }
  return { uid: 'uid-1', state, items: { events: { docs: {} }, circulars: { docs: {} } } };
}

// ---------------------------------------------------------------------------
// A. USCITA — documento di stato
// ---------------------------------------------------------------------------

test('A. il primo caricamento scrive alunni e profilo senza dati sensibili', () => {
  const snapshot = snapshotWith({
    students: [student('s1', { ...SENSITIVE }), student('s2')],
    profile: profileWith({ assignedStudents: ['Rossi Matteo (2E, 9 ore - PEI differenziato)'] }),
  });
  const plan = planSync({ uid: 'u1', snapshot, remote: emptyRemote(), syncState: null, nowIso: '2026-09-10T10:00:00.000Z' });

  assertNoSensitiveData(plan.stateWrites.students, 'alunni in uscita');
  assertNoSensitiveData(plan.stateWrites.profile, 'profilo in uscita');
  // Il resto dell'alunno (nome, classe, contatti, diario) continua a viaggiare.
  assert.deepEqual(plan.stateWrites.students, [student('s1'), student('s2')]);
  assert.equal((plan.stateWrites.profile as TeacherProfile).fullName, 'Anna Testi');
  // I dati locali non sono stati toccati dalla ripulitura.
  assert.equal(snapshot.students[0].diagnosticSummary, SENSITIVE.diagnosticSummary);
  assert.deepEqual(snapshot.profile.assignedStudents, ['Rossi Matteo (2E, 9 ore - PEI differenziato)']);
});

test('A. una modifica ai SOLI dati sensibili non produce alcuna sincronizzazione', () => {
  const base = snapshotWith({ students: [student('s1')] });
  const remote: RemoteSnapshot = {
    state: {
      profile: stateDoc(profileWith(), 't0'),
      settings: stateDoc(statePayload(base, 'settings'), 't0'),
      definitiveTimetable: stateDoc([], 't0'),
      provisionalTimetable: stateDoc([], 't0'),
      students: stateDoc([student('s1')], 't0'),
    },
    items: { events: [], circulars: [] },
  };
  const edited = snapshotWith({ students: [student('s1', { ...SENSITIVE })] });
  const plan = planSync({ uid: 'uid-1', snapshot: edited, remote, syncState: alignedState(base, remote), nowIso: 't1' });
  assert.deepEqual(plan.stateWrites, {}, 'nessun campo riservato => nessuna scrittura');
  assert.deepEqual(plan.localApplyState, {}, 'nessun ritorno dal cloud');
  assert.equal(plan.changedSomething, false);
  assert.equal(edited.students[0].diagnosticSummary, SENSITIVE.diagnosticSummary, 'il dato resta in locale');
});

test('A. il cloud non riceve dati sensibili nemmeno dalle scritture in blocco e dagli archivi conflitti', async () => {
  const clock = { now: '2026-09-10T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const device = makeDevice({
    students: [student('s1', { ...SENSITIVE })],
    profile: profileWith({ assignedStudents: ['Rossi Matteo'] }),
    events: [event('e1')],
  });
  const engine = makeEngine(device, cloud, clock);
  await engine.syncNow();

  // Documenti di stato...
  assertNoSensitiveData(cloud.state.students, 'documento students nel cloud');
  assertNoSensitiveData(cloud.state.profile, 'documento profile nel cloud');
  // ...scritture in blocco (eventi per id)...
  assertNoSensitiveData([...cloud.items.events.values()], 'eventi scritti in blocco');
  // ...e archivi conflitti: prima una copia "sporca" nel cloud, poi una forzatura locale.
  (cloud.state.students as RemoteStateDoc).payload = [student('s1', { ...SENSITIVE })];
  clock.now = '2026-09-10T11:00:00.000Z';
  await engine.resolveConflict('local');
  const archive = cloud.conflicts.find(entry => entry.kind === 'state:students');
  assert.ok(archive, 'la copia perdente è archiviata');
  assertNoSensitiveData(archive!.payload, 'archivio conflitti students');
  // Il dispositivo conserva i suoi dati riservati.
  assert.equal(device.db.students[0].diagnosticSummary, SENSITIVE.diagnosticSummary);
});

test('A. anche un documento legacy recuperato e il suo archivio vengono riscritti puliti', () => {
  const snapshot = snapshotWith({ students: [student('s1', { ...SENSITIVE })] });
  const dirty = [student('s1', { ...SENSITIVE })];
  // Doppio wrapper (legacy) con un payload che contiene ancora dati riservati.
  const raw = { payload: { payload: dirty, updatedAt: '2026-09-01T08:00:00.000Z', schemaVersion: 1 }, updatedAt: '2026-09-01T08:00:00.000Z', schemaVersion: 1 };
  const plan = planSync({
    uid: 'u1',
    snapshot,
    remote: { state: { students: stateDoc(dirty, '2026-09-01T08:00:00.000Z') }, items: { events: [], circulars: [] } },
    syncState: null,
    nowIso: '2026-09-10T10:00:00.000Z',
    remoteRaw: { students: raw },
    remoteLegacy: ['students'],
  });
  const archive = plan.archivedOnOverwrite.find(entry => entry.kind === 'legacy-state:students');
  assert.ok(archive, 'il documento legacy è archiviato');
  assertNoSensitiveData(archive!.loser, 'archivio legacy students');
  assertNoSensitiveData(plan.stateWrites.students, 'riscrittura del documento legacy');
});

// ---------------------------------------------------------------------------
// B. INGRESSO — i dati locali restano, quelli remoti sono ignorati
// ---------------------------------------------------------------------------

test('B. il ripristino dal cloud conserva i dati sensibili locali e ignora quelli remoti', () => {
  const snapshot = snapshotWith({
    students: [student('s1', { ...SENSITIVE, diagnosticSummary: 'Sintesi locale' }), student('s2')],
    profile: profileWith({ assignedStudents: ['Assegnazione locale'] }),
  });
  const remote: RemoteSnapshot = {
    state: {
      // Documento vecchio: contiene ancora dati riservati (da una versione precedente).
      students: stateDoc([student('s1', { ...SENSITIVE, diagnosticSummary: 'Sintesi dal cloud', supportHoursPerWeek: 12 }), student('s2'), student('s3', { ...SENSITIVE })], 't0'),
      profile: stateDoc(profileWith({ fullName: 'Nome dal cloud', assignedStudents: ['Assegnazione dal cloud'] }), 't0'),
    },
    items: { events: [], circulars: [] },
  };
  const plan = planSync({ uid: 'u1', snapshot, remote, syncState: null, nowIso: 't1', resolution: 'remote' });
  const restored = plan.fullRestore!;

  assert.equal(restored.students.find(s => s.id === 's1')!.diagnosticSummary, 'Sintesi locale', 'vince la copia locale');
  assert.equal(restored.students.find(s => s.id === 's1')!.supportHoursPerWeek, SENSITIVE.supportHoursPerWeek);
  // s2 non ha dati sensibili in locale: nessun campo riservato viene aggiunto.
  assert.equal(restored.students.find(s => s.id === 's2')!.isSupportStudent, undefined);
  // s3 esiste solo nel cloud: arriva SENZA dati sensibili.
  const remoteOnly = restored.students.find(s => s.id === 's3')!;
  assert.equal(remoteOnly.isSupportStudent, undefined);
  assert.equal(remoteOnly.diagnosticSummary, undefined);
  assert.equal(remoteOnly.gloDate, undefined);
  assert.equal(remoteOnly.specialists, undefined);
  // Il profilo tiene la sua assegnazione e prende il resto dal cloud.
  assert.deepEqual(restored.profile.assignedStudents, ['Assegnazione locale']);
  assert.equal(restored.profile.fullName, 'Nome dal cloud');
});

test('B. un aggiornamento singolo dello stato vale come il ripristino: locali conservati, remoti ignorati', () => {
  const local = snapshotWith({
    students: [student('s1', { diagnosticSummary: 'Solo qui', specialists: 'Logopedista' })],
    profile: profileWith({ assignedStudents: ['Assegnazione locale'] }),
  });
  const remote: RemoteSnapshot = {
    state: {
      students: stateDoc([student('s1', { className: '3A', diagnosticSummary: 'Dal cloud' })], 't1'),
      profile: stateDoc(profileWith({ fullName: 'Anna Testi', schoolName: 'IC Nord', assignedStudents: ['Dal cloud'] }), 't1'),
    },
    items: { events: [], circulars: [] },
  };
  const synced: SyncStateV1 = {
    uid: 'u1',
    state: {
      students: { lastSyncedLocalHash: contentHash([student('s1')]), remoteUpdatedAt: 't0' },
      profile: { lastSyncedLocalHash: contentHash(profileWith()), remoteUpdatedAt: 't0' },
    },
    items: { events: { docs: {} }, circulars: { docs: {} } },
  };
  const plan = planSync({ uid: 'u1', snapshot: local, remote, syncState: synced, nowIso: 't2' });
  const students = plan.localApplyState.students as Student[];
  const profile = plan.localApplyState.profile as TeacherProfile;
  assert.equal(students[0].diagnosticSummary, 'Solo qui', 'i dati locali non vengono sovrascritti');
  assert.equal(students[0].specialists, 'Logopedista');
  assert.equal(students[0].className, '3A', 'gli altri campi remoti arrivano');
  assert.deepEqual(profile.assignedStudents, ['Assegnazione locale']);
  assert.equal(profile.schoolName, 'IC Nord');
  // In uscita il documento resta pulito.
  assert.equal(hasSensitiveStatePayload('students', students.map(s => ({ ...s }))) === false, false); // i dati locali ci sono, ma non partiranno
  assertNoSensitiveData(plan.stateWrites, 'nessuna scrittura contiene dati riservati');
});

test('B. un dispositivo senza dati sensibili che ripristina dal cloud non ne riceve', async () => {
  const clock = { now: '2026-09-10T12:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  cloud.state.students = stateDoc([student('s1', { ...SENSITIVE })], '2026-09-10T10:00:00.000Z');
  cloud.state.profile = stateDoc(profileWith({ assignedStudents: ['Dal cloud'] }), '2026-09-10T10:00:00.000Z');
  const device = makeDevice({ profile: { ...emptyInstallation().profile, id: 'teacher-new' } as TeacherProfile });
  const engine = makeEngine(device, cloud, clock);
  await engine.syncNow();

  assert.equal(device.db.students.length, 1, 'l’alunno arriva dal cloud');
  assert.equal(device.db.students[0].isSupportStudent, undefined, 'senza dati riservati');
  assert.equal(device.db.students[0].diagnosticSummary, undefined);
  assert.equal(device.db.profile.assignedStudents, undefined, 'il profilo non adotta assegnazioni remote');
});

// ---------------------------------------------------------------------------
// C. PULIZIA DEI DATI GIÀ CARICATI (una sola volta per account)
// ---------------------------------------------------------------------------

test('C. il documento students e il profilo sporchi nel cloud vengono riscritti puliti, una sola volta', async () => {
  const clock = { now: '2026-09-10T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  // Situazione reale: il cloud custodisce dati riservati scritti da una versione precedente,
  // mentre il dispositivo è allineato e non ha NULLA da segnalare come modificato.
  const cloudStudents = [student('s1', { ...SENSITIVE })];
  const cloudProfile = profileWith({ assignedStudents: ['Rossi Matteo (2E, 9 ore)'] });
  cloud.state.students = stateDoc(clone(cloudStudents), '2026-09-09T10:00:00.000Z');
  cloud.state.profile = stateDoc(clone(cloudProfile), '2026-09-09T10:00:00.000Z');
  const device = makeDevice({
    students: [student('s1', { ...SENSITIVE })],
    profile: profileWith({ assignedStudents: ['Rossi Matteo (2E, 9 ore)'] }),
  });
  const synced: SyncStateV1 = {
    uid: 'uid-1',
    state: {
      students: { lastSyncedLocalHash: contentHash(cloudStudents), remoteUpdatedAt: '2026-09-09T10:00:00.000Z' },
      profile: { lastSyncedLocalHash: contentHash(cloudProfile), remoteUpdatedAt: '2026-09-09T10:00:00.000Z' },
    },
    items: { events: { docs: {} }, circulars: { docs: {} } },
  };
  device.meta['sync:state'] = clone(synced);
  const engine = makeEngine(device, cloud, clock);

  await engine.syncNow();
  assertNoSensitiveData(cloud.state.students, 'students riscritto pulito');
  assertNoSensitiveData(cloud.state.profile, 'profilo riscritto pulito');
  assert.deepEqual((cloud.state.students as RemoteStateDoc).payload, [student('s1')], 'contenuto integro, senza campi riservati');
  const marker = device.meta['sync:sensitive-cleanup'] as { uid: string; done: StateDocName[] };
  assert.equal(marker.uid, 'uid-1');
  assert.deepEqual(marker.done.slice().sort(), ['profile', 'students']);

  // Secondo ciclo: nessuna scrittura (indicatore + loop guard).
  const writes = cloud.writes;
  clock.now = '2026-09-10T10:05:00.000Z';
  await engine.syncNow();
  assert.equal(cloud.writes, writes, 'la pulizia non si ripete a ogni ciclo');

  // Anche se il cloud tornasse sporco, la riscrittura è una sola volta per account.
  (cloud.state.students as RemoteStateDoc).payload = [student('s1', { ...SENSITIVE })];
  clock.now = '2026-09-10T10:10:00.000Z';
  await engine.syncNow();
  assert.equal(cloud.writes, writes, 'una sola volta per account');
});

test('C. nulla da pulire: nessuna scrittura quando il cloud è già privo di dati riservati', async () => {
  const clock = { now: '2026-09-10T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const clean = [student('s1')];
  cloud.state.students = stateDoc(clone(clean), '2026-09-09T10:00:00.000Z');
  cloud.state.profile = stateDoc(profileWith(), '2026-09-09T10:00:00.000Z');
  const device = makeDevice({ students: [student('s1', { ...SENSITIVE })] });
  cloud.state.settings = stateDoc(statePayload(device.db, 'settings'), '2026-09-09T10:00:00.000Z');
  cloud.state.definitiveTimetable = stateDoc([], '2026-09-09T10:00:00.000Z');
  cloud.state.provisionalTimetable = stateDoc([], '2026-09-09T10:00:00.000Z');
  const remote: RemoteSnapshot = {
    state: {
      students: cloud.state.students as RemoteStateDoc,
      profile: cloud.state.profile as RemoteStateDoc,
      settings: cloud.state.settings as RemoteStateDoc,
      definitiveTimetable: cloud.state.definitiveTimetable as RemoteStateDoc,
      provisionalTimetable: cloud.state.provisionalTimetable as RemoteStateDoc,
    },
    items: { events: [], circulars: [] },
  };
  device.meta['sync:state'] = alignedState(device.db, remote, '2026-09-09T10:00:00.000Z');
  const engine = makeEngine(device, cloud, clock);
  await engine.syncNow();
  assert.equal(cloud.writes, 0, 'nessun dato riservato nel cloud => nessuna riscrittura');
  assert.equal(device.meta['sync:sensitive-cleanup'], undefined, 'la pulizia resta in sospeso per un cloud già pulito');
  assert.equal(device.db.students[0].diagnosticSummary, SENSITIVE.diagnosticSummary, 'i dati locali restano');
});

test('C. gli archivi conflitti non si riscrivono: si contano, senza contenuti', async () => {
  const clock = { now: '2026-09-10T10:00:00.000Z' };
  const archives: RemoteConflictArchive[] = [
    { id: 'c1', kind: 'state:students', payload: [student('s1', { ...SENSITIVE })] },
    { id: 'c2', kind: 'legacy-state:students', payload: { payload: [student('s2', { ...SENSITIVE })], updatedAt: 'x', schemaVersion: 1 } },
    { id: 'c3', kind: 'state:profile', payload: profileWith({ assignedStudents: ['Rossi Matteo'] }) },
    { id: 'c4', kind: 'state:profile', payload: profileWith() },
    { id: 'c5', kind: 'item:events:e1', payload: event('e1') },
    { id: 'c6', kind: 'legacy-state:provisionalTimetable', payload: { payload: [], updatedAt: 'x', schemaVersion: 1 } },
  ];
  const cloud = makeFakeCloud(clock, archives);
  cloud.state.students = stateDoc([student('s1', { ...SENSITIVE })], '2026-09-09T10:00:00.000Z');
  const device = makeDevice({ students: [student('s1', { ...SENSITIVE })] });
  device.meta['sync:state'] = {
    uid: 'uid-1',
    state: { students: { lastSyncedLocalHash: contentHash([student('s1', { ...SENSITIVE })]), remoteUpdatedAt: '2026-09-09T10:00:00.000Z' } },
    items: { events: { docs: {} }, circulars: { docs: {} } },
  } as SyncStateV1;
  const engine = makeEngine(device, cloud, clock);

  const lines: string[] = [];
  const originalInfo = console.info;
  console.info = (message?: unknown) => { lines.push(String(message)); };
  try {
    await engine.syncNow();
  } finally {
    console.info = originalInfo;
  }

  const line = lines.find(entry => entry.includes('Archivi conflitti'));
  assert.ok(line, 'il conteggio finisce nel log');
  assert.match(line!, /Archivi conflitti con dati riservati: 3 \(alunni: 2, profilo: 1\)/);
  // Nessun contenuto: né sintesi, né specialisti, né assegnazioni.
  assert.doesNotMatch(line!, /Rossi|Sintesi|riservato\"|specialists|Logopedista|NPI/i);
  // Gli archivi restano dove sono (le regole li rendono immutabili).
  assert.equal(cloud.conflicts.length, 6);
  // Il documento di stato, invece, è stato riscritto pulito.
  assertNoSensitiveData(cloud.state.students, 'students riscritto');
});

test('C. conteggio archivi: il contenuto non viene mai incluso, solo il numero', () => {
  const count = countSensitiveArchives([
    { id: 'a', kind: 'state:students', payload: [student('s1', { isSupportStudent: true })] },
    { id: 'b', kind: 'legacy-state:students', payload: { payload: [student('s2', { gloDate: '2026-11-12' })] } },
    { id: 'c', kind: 'state:profile', payload: { assignedStudents: ['x'] } },
    { id: 'd', kind: 'state:profile', payload: {} },
    { id: 'e', kind: 'item:events:e1', payload: { title: 'x', diagnosticSummary: 'non è un alunno' } },
  ]);
  assert.deepEqual(count, { total: 3, students: 2, profile: 1 });
});

// ---------------------------------------------------------------------------
// D. ENDPOINT DI ANALISI
// ---------------------------------------------------------------------------

async function captureAnalysisBody(run: () => Promise<unknown>): Promise<string> {
  const original = globalThis.fetch;
  let body = '';
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    body = String((init as { body?: unknown })?.body ?? '');
    return new Response(JSON.stringify({ success: true, source: 'test', items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
  return body;
}

const sensitiveProfile = profileWith({
  assignedStudents: ['Rossi Matteo (2E, 9 ore - PEI differenziato)'],
});

test('D. il profilo verso /api/analyze-circular non contiene assignedStudents', async () => {
  const body = await captureAnalysisBody(() =>
    analyzeCircular({ text: '14 settembre 2026 Collegio docenti 15:00-17:00', profile: sensitiveProfile }));
  assert.ok(body.includes('"fullName":"Anna Testi"'), 'il profilo parte');
  assert.ok(!body.includes('assignedStudents'), 'nessuna assegnazione verso il servizio di analisi');
  assert.ok(!body.includes('Rossi Matteo'), 'nessun contenuto riservato');
  assert.deepEqual(sensitiveProfile.assignedStudents, ['Rossi Matteo (2E, 9 ore - PEI differenziato)'], 'il profilo locale non è modificato');
});

test('D. anche /api/analyze-timetable e /api/analyze-student-document ricevono un profilo pulito', async () => {
  const timetableBody = await captureAnalysisBody(() =>
    analyzeTimetableDocument({ imageBase64: 'QUJD', mimeType: 'image/png', documentType: 'personal-support-timetable', profile: sensitiveProfile }));
  assert.ok(!timetableBody.includes('assignedStudents'), 'orario: nessuna assegnazione');
  const studentBody = await captureAnalysisBody(() =>
    analyzeStudentDocument({ imageBase64: 'QUJD', mimeType: 'image/png', profile: sensitiveProfile }));
  assert.ok(!studentBody.includes('assignedStudents'), 'documento alunno: nessuna assegnazione');
  assert.ok(!studentBody.includes('Rossi Matteo'), 'nessun dato riservato di alunni');
});

// ---------------------------------------------------------------------------
// E. INTERFACCIA
// ---------------------------------------------------------------------------

const text = (node: any): string => {
  if (!node) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(text).join(' ');
};

test('E. la scheda alunno dichiara che i dati riservati restano sul dispositivo', async () => {
  const profile = profileWith();
  const renderer = create(React.createElement(ClassesView, {
    profile,
    students: [student('s1', { ...SENSITIVE }), student('s2')],
    onSaveStudent: () => {}, onDeleteStudent: () => {}, onAddNote: () => {}, onDeleteNote: () => {},
    onScheduleEvent: () => {},
  }));
  await act(async () => {});
  const rendered = text(renderer.toJSON());
  assert.ok(rendered.includes(LOCAL_ONLY_SENSITIVE_NOTICE), `attesa la riga: ${LOCAL_ONLY_SENSITIVE_NOTICE}`);
  assert.equal(rendered.match(new RegExp(LOCAL_ONLY_SENSITIVE_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))!.length, 1, 'una riga per la scheda con dati riservati');
  renderer.unmount();
});

// ---------------------------------------------------------------------------
// F. BACKUP LOCALE
// ---------------------------------------------------------------------------

test('F. il backup locale continua a contenere tutti i dati, riservati inclusi', async () => {
  const legacyStorage = { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} };
  database.close();
  await database.delete();
  await database.initialize({ ...emptyInstallation(), students: [student('s1', { ...SENSITIVE })] }, legacyStorage);
  const value = student('s1', { ...SENSITIVE });
  await storage.saveStudents([value]);
  const exported = JSON.parse(await storage.exportDataBackup()) as { students: Student[] };
  assert.deepEqual(exported.students[0], value, 'il backup è completo: serve al ripristino');
  assert.equal(exported.students[0].diagnosticSummary, SENSITIVE.diagnosticSummary);
  await storage.saveStudents([]);
  assert.equal(await storage.importDataBackup(JSON.stringify(exported)), true);
  assert.deepEqual((await storage.getStudents())[0], value);
  database.close();
  await database.delete();
});
