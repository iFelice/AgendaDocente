/**
 * SINCRONIZZAZIONE CIFRATA DEI DATI RISERVATI.
 *
 * Copre i punti B del requisito:
 *  - uscita con la chiave: i campi riservati diventano un blob `sensitiveEnc`
 *    per alunno (e uno per il profilo); nessun chiaro arriva al cloud;
 *  - uscita SENZA chiave: i blob già presenti nel cloud tornano invariati
 *    (mai cancellati da chi non ha la chiave);
 *  - ingresso con la chiave: i valori decifrati si applicano con la stessa
 *    precedenza del resto della scheda;
 *  - ingresso senza chiave: valori locali conservati e blob non scartato;
 *  - cambio frase senza ricifrare gli alunni;
 *  - rilevazione delle modifiche: con la cifratura attiva una modifica ai soli
 *    dati riservati produce una sincronizzazione (impronta locale);
 *  - endpoint di analisi e copie "fuori dispositivo" senza blob.
 *
 * Usa la Web Crypto di Node; stesso fake cloud degli altri test di sync.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncEngine, type LocalApply, type SyncStore } from '../src/services/sync/engine';
import {
  localStateHash,
  planSync,
  sensitiveProfileFingerprint,
  sensitiveStudentsFingerprint,
} from '../src/services/sync/merge';
import { stripSensitiveTransportPayload } from '../src/services/sensitiveData';
import type {
  ItemsCollection,
  RemoteConflictArchive,
  RemoteItem,
  RemoteSnapshot,
  StateDocName,
  SyncGateway,
  SyncStateV1,
  SyncableSnapshot,
} from '../src/services/sync/types';
import {
  SENSITIVE_PROFILE_FIELDS,
  SENSITIVE_STUDENT_FIELDS,
  withoutSensitiveProfile,
  withoutSensitiveStudent,
} from '../src/services/sensitiveData';
import {
  EncryptionKeystore,
  createSensitiveSyncAdapter,
  type KeysGateway,
  type KeysMetaStore,
} from '../src/services/encryptionKeys';
import { emptyInstallation, storage } from '../src/services/storage';
import { database } from '../src/services/db';
import type { Student, TeacherProfile } from '../src/types';

const clone = <T>(value: T): T => structuredClone(value);

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

const snapshotWith = (patch: Partial<SyncableSnapshot> = {}): SyncableSnapshot =>
  ({ ...emptyInstallation(), onboardingCompleted: true, profile: profileWith(), ...patch }) as SyncableSnapshot;

// ---------------------------------------------------------------------------
// Fake cloud / dispositivo (stessa forma degli altri test di sync)
// ---------------------------------------------------------------------------

interface FakeCloud {
  gateway(): SyncGateway;
  state: Record<string, unknown>;
  items: Record<ItemsCollection, Map<string, RemoteItem>>;
  conflicts: RemoteConflictArchive[];
  writes: { total: number; byDoc: Record<string, number> };
}

function makeFakeCloud(clock: { now: string }): FakeCloud {
  const cloud: FakeCloud = {
    state: {},
    items: { events: new Map(), circulars: new Map(), assessments: new Map(), scheduledAssessments: new Map() } as Record<ItemsCollection, Map<string, RemoteItem>>,
    conflicts: [],
    writes: { total: 0, byDoc: {} },
    gateway() { return gatewayApi; },
  };
  const gatewayApi: SyncGateway = {
    async readState(name) { return cloud.state[name] ? clone(cloud.state[name]) as never : null; },
    async writeState(name, payload) {
      cloud.writes.total++;
      cloud.writes.byDoc[name] = (cloud.writes.byDoc[name] ?? 0) + 1;
      const updatedAt = clock.now;
      cloud.state[name] = { payload: clone(payload), updatedAt, schemaVersion: 1 };
      return { updatedAt };
    },
    async listItems(coll) { return [...cloud.items[coll].values()].map(clone); },
    async writeItems(coll, entries) {
      cloud.writes.total++;
      for (const { id, payload } of entries) cloud.items[coll].set(id, { id, payload: clone(payload), updatedAt: clock.now });
    },
    async deleteItems(coll, ids) { cloud.writes.total++; for (const id of ids) cloud.items[coll].delete(id); },
    async archiveConflict(kind, payload) { cloud.conflicts.push({ id: `c${cloud.conflicts.length}`, kind, payload: clone(payload) }); },
    async listConflicts() { return clone(cloud.conflicts); },
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

function makeMetaStore(meta: Record<string, unknown>): KeysMetaStore {
  return { read: async key => meta[key], write: async (key, value) => { meta[key] = value; } };
}

function makeKeysGateway(cloud: FakeCloud, clock: { now: string }): KeysGateway {
  return {
    async readState() { return cloud.state.encryptionKeys ? clone(cloud.state.encryptionKeys) : null; },
    async writeState(_name, payload) {
      cloud.writes.byDoc.encryptionKeys = (cloud.writes.byDoc.encryptionKeys ?? 0) + 1;
      const updatedAt = clock.now;
      cloud.state.encryptionKeys = { payload: clone(payload), updatedAt, schemaVersion: 1 };
      return { updatedAt };
    },
  };
}

function makeKeystore(cloud: FakeCloud, clock: { now: string }, device: FakeDevice): EncryptionKeystore {
  return new EncryptionKeystore({ gateway: () => makeKeysGateway(cloud, clock), meta: makeMetaStore(device.meta) });
}

function makeEngine(device: FakeDevice, cloud: FakeCloud, clock: { now: string }, keystore: EncryptionKeystore | null, uid = 'uid-1'): SyncEngine {
  return new SyncEngine({
    gateway: () => cloud.gateway(),
    uid: () => uid,
    store: device.store,
    now: () => clock.now,
    schedule: fn => { fn(); return () => undefined; },
    ...(keystore ? { sensitiveEncryption: createSensitiveSyncAdapter(keystore) } : {}),
  });
}

/** Nessun campo riservato in chiaro, a nessuna profondità. */
function assertNoPlaintextSensitive(value: unknown, message: string): void {
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) { node.forEach((entry, index) => walk(entry, `${path}[${index}]`)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if ((SENSITIVE_STUDENT_FIELDS as readonly string[]).includes(key) || (SENSITIVE_PROFILE_FIELDS as readonly string[]).includes(key)) {
        assert.fail(`${message}: campo riservato in chiaro "${key}" in ${path}`);
      }
      walk(entry, `${path}.${key}`);
    }
  };
  walk(value, '$');
}

const statePayloadOf = (cloud: FakeCloud, name: StateDocName): any => (cloud.state[name] as { payload: unknown }).payload;
const docUpdatedAt = (cloud: FakeCloud, name: string): string => (cloud.state[name] as { updatedAt: string }).updatedAt;

/** Stato di sync allineato, con o senza cifratura attiva. */
function alignedState(device: FakeDevice, cloud: FakeCloud, sensitiveActive: boolean, updatedAt: string): SyncStateV1 {
  const state: SyncStateV1['state'] = {};
  for (const name of ['profile', 'settings', 'definitiveTimetable', 'provisionalTimetable', 'students'] as StateDocName[]) {
    const doc = cloud.state[name] as { payload: unknown; updatedAt: string } | undefined;
    if (!doc) continue;
    const source = name === 'students' ? device.db.students : name === 'profile' ? device.db.profile : undefined;
    state[name] = {
      lastSyncedLocalHash: localStateHash(name, stripSensitiveTransportPayload(name, doc.payload), sensitiveActive, fingerprintFor(name, source)),
      remoteUpdatedAt: doc.updatedAt,
    };
  }
  return { uid: 'uid-1', state, items: { events: { docs: {} }, circulars: { docs: {} } } } as SyncStateV1;
}

function fingerprintFor(name: StateDocName, source: unknown): string {
  if (name === 'students') return sensitiveStudentsFingerprint(source);
  if (name === 'profile') return sensitiveProfileFingerprint(source);
  return '';
}

// ---------------------------------------------------------------------------
// USCITA con la chiave: blob cifrati, nessun chiaro nel cloud
// ---------------------------------------------------------------------------

test('B1. uscita con chiave: alunni e profilo viaggiano cifrati, nessun chiaro nel cloud', async () => {
  const clock = { now: '2026-10-01T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const device = makeDevice({
    students: [student('s1', { ...SENSITIVE }), student('s2')],
    profile: profileWith({ assignedStudents: ['Rossi Matteo (2E, 9 ore - PEI differenziato)'] }),
  });
  const keystore = makeKeystore(cloud, clock, device);
  await keystore.activate('uid-1', 'frase segreta di attivazione');
  const engine = makeEngine(device, cloud, clock, keystore);

  await engine.syncNow();

  const students = statePayloadOf(cloud, 'students') as Array<Record<string, unknown>>;
  assertNoPlaintextSensitive(cloud.state.students, 'alunni nel cloud');
  assertNoPlaintextSensitive(cloud.state.profile, 'profilo nel cloud');
  assert.equal(typeof students[0].sensitiveEnc, 'object', 'blob cifrato per l alunno con dati riservati');
  assert.equal((students[0].sensitiveEnc as { v: number }).v, 1);
  assert.equal(students[1].sensitiveEnc, undefined, 'nessun blob senza informazioni riservate');
  assert.equal((statePayloadOf(cloud, 'profile') as { sensitiveEnc?: unknown }).sensitiveEnc !== undefined, true, 'blob del profilo');

  // Il resto della scheda continua a viaggiare in chiaro (nome, classe…).
  assert.equal(students[0].fullName, 'Alunno s1');
  assert.equal((statePayloadOf(cloud, 'profile') as TeacherProfile).fullName, 'Anna Testi');

  // Il blob si apre con la chiave di questo dispositivo e restituisce i valori.
  const key = (await keystore.deviceKey('uid-1'))!;
  const { decryptJson } = await import('../src/services/sensitiveCrypto');
  assert.deepEqual(await decryptJson(key, students[0].sensitiveEnc as never), SENSITIVE);
  assert.deepEqual(await decryptJson(key, (statePayloadOf(cloud, 'profile') as { sensitiveEnc: never }).sensitiveEnc), { assignedStudents: ['Rossi Matteo (2E, 9 ore - PEI differenziato)'] });

  // Secondo ciclo: nessun'altra scrittura (gli hash con impronta sono stabili).
  const writes = cloud.writes.total;
  clock.now = '2026-10-01T10:05:00.000Z';
  await engine.syncNow();
  assert.equal(cloud.writes.total, writes, 'nessun loop di riscrittura');

  // I dati locali restano in chiaro e completi.
  assert.equal(device.db.students[0].diagnosticSummary, SENSITIVE.diagnosticSummary);
});

test('B1b. modifica ai soli dati riservati: senza cifratura non sincronizza, con la cifratura sì', () => {
  const base = snapshotWith({ students: [student('s1')] });
  const remote: RemoteSnapshot = {
    state: { students: { payload: [student('s1')], updatedAt: 't0', schemaVersion: 1 } },
    items: { events: [], circulars: [] },
  } as unknown as RemoteSnapshot;
  const synced: SyncStateV1 = {
    uid: 'u1',
    state: { students: { lastSyncedLocalHash: localStateHash('students', [student('s1')], false, ''), remoteUpdatedAt: 't0' } },
    items: { events: { docs: {} }, circulars: { docs: {} } },
  };

  const edited = snapshotWith({ students: [student('s1', { ...SENSITIVE })] });

  // Cifratura NON attiva: comportamento PR #73, nessuna sincronizzazione.
  const planInactive = planSync({ uid: 'u1', snapshot: edited, remote, syncState: clone(synced), nowIso: 't1' });
  assert.equal(planInactive.stateWrites.students, undefined, 'senza cifratura i dati riservati restano solo locali');

  // Cifratura attiva: la sola modifica riservata produce una scrittura.
  const activeState = clone(synced);
  activeState.state.students!.lastSyncedLocalHash = localStateHash('students', [student('s1')], true, sensitiveStudentsFingerprint([student('s1')]));
  const planActive = planSync({ uid: 'u1', snapshot: edited, remote, syncState: activeState, nowIso: 't1', sensitiveActive: true });
  assert.ok(planActive.stateWrites.students, 'con la cifratura la modifica riservata parte');
  assertNoPlaintextSensitive(planActive.stateWrites.students, 'il piano non porta chiari');
});

// ---------------------------------------------------------------------------
// USCITA senza chiave: i blob del cloud tornano invariati
// ---------------------------------------------------------------------------

test('B2. dispositivo senza chiave: riporta invariato il sensitiveEnc remoto e non manda chiari', async () => {
  const clock = { now: '2026-10-01T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const deviceA = makeDevice({
    students: [student('s1', { ...SENSITIVE })],
    profile: profileWith({ assignedStudents: ['Rossi Matteo (2E)'] }),
  });
  const keystoreA = makeKeystore(cloud, clock, deviceA);
  await keystoreA.activate('uid-1', 'frase segreta dispositivo A');
  await makeEngine(deviceA, cloud, clock, keystoreA).syncNow();
  const blobStudent = clone((statePayloadOf(cloud, 'students') as Array<{ sensitiveEnc: unknown }>)[0].sensitiveEnc);
  const blobProfile = clone((statePayloadOf(cloud, 'profile') as { sensitiveEnc: unknown }).sensitiveEnc);
  const writesAfterA = clone(cloud.writes.byDoc);

  // Dispositivo B: stesse chiavi nel cloud, ma NON sbloccato. Riceve la storia.
  clock.now = '2026-10-01T11:00:00.000Z';
  const deviceB = makeDevice({ students: [student('s1')], profile: profileWith() });
  const keystoreB = makeKeystore(cloud, clock, deviceB);
  const engineB = makeEngine(deviceB, cloud, clock, keystoreB);
  assert.equal(await keystoreB.status('uid-1'), 'locked');
  deviceB.meta['sync:state'] = alignedState(deviceB, cloud, true, docUpdatedAt(cloud, 'students'));

  // B modifica un dato NON riservato e spinge.
  deviceB.db.students[0].className = '3F';
  clock.now = '2026-10-01T11:30:00.000Z';
  await engineB.syncNow();

  const students = statePayloadOf(cloud, 'students') as Array<Record<string, unknown>>;
  assert.equal(students[0].className, '3F', 'la modifica non riservata parte');
  assert.deepEqual(students[0].sensitiveEnc, blobStudent, 'il blob scritto da A torna invariato');
  assert.deepEqual((statePayloadOf(cloud, 'profile') as { sensitiveEnc: unknown }).sensitiveEnc, blobProfile, 'blob del profilo invariato');
  assertNoPlaintextSensitive(cloud.state.students, 'nessun chiaro dal dispositivo senza chiave');
  assert.equal(cloud.writes.byDoc.encryptionKeys, writesAfterA.encryptionKeys, 'il documento chiavi non viene toccato');

  // B non ha acquisito dati riservati in locale.
  assert.equal(deviceB.db.students[0].diagnosticSummary, undefined);
});

// ---------------------------------------------------------------------------
// INGRESSO con la chiave: valori decifrati applicati
// ---------------------------------------------------------------------------

test('B3. nuovo dispositivo sbloccato: il ripristino applica i valori decifrati', async () => {
  const clock = { now: '2026-10-01T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const deviceA = makeDevice({
    students: [student('s1', { ...SENSITIVE })],
    profile: profileWith({ assignedStudents: ['Rossi Matteo (2E)'] }),
  });
  const keystoreA = makeKeystore(cloud, clock, deviceA);
  const { recoveryCode } = await keystoreA.activate('uid-1', 'frase segreta dispositivo A');
  await makeEngine(deviceA, cloud, clock, keystoreA).syncNow();

  // Nuovo dispositivo: locale pulito (profilo placeholder), sbloccato PRIMA del primo sync.
  const deviceB = makeDevice({ profile: emptyInstallation().profile as TeacherProfile });
  const keystoreB = makeKeystore(cloud, clock, deviceB);
  await keystoreB.unlock('uid-1', recoveryCode, 'recovery');
  clock.now = '2026-10-02T09:00:00.000Z';
  await makeEngine(deviceB, cloud, clock, keystoreB).syncNow();

  assert.equal(deviceB.db.students[0].fullName, 'Alunno s1', 'il resto della scheda arriva');
  assert.deepEqual(
    SENSITIVE_STUDENT_FIELDS.map(f => deviceB.db.students[0][f]),
    SENSITIVE_STUDENT_FIELDS.map(f => SENSITIVE[f]),
    'i dati riservati decifrati si applicano con la precedenza del remoto',
  );
  assert.deepEqual(deviceB.db.profile.assignedStudents, ['Rossi Matteo (2E)']);
  assert.equal(deviceB.db.students[0].sensitiveEnc, undefined, 'il blob non resta in locale una volta decifrato');
});

test('B4. sblocco dopo il ripristino: i blob locali si decifrano senza attendere il cloud', async () => {
  const clock = { now: '2026-10-01T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const deviceA = makeDevice({ students: [student('s1', { ...SENSITIVE })] });
  const keystoreA = makeKeystore(cloud, clock, deviceA);
  await keystoreA.activate('uid-1', 'frase segreta dispositivo A');
  await makeEngine(deviceA, cloud, clock, keystoreA).syncNow();

  // Nuovo dispositivo: ripristino da BLOCCATO -> i blob restano nelle righe locali.
  const deviceB = makeDevice({ profile: emptyInstallation().profile as TeacherProfile });
  const keystoreB = makeKeystore(cloud, clock, deviceB);
  await makeEngine(deviceB, cloud, clock, keystoreB).syncNow();
  assert.ok(deviceB.db.students[0].sensitiveEnc, 'il blob non viene scartato dal dispositivo bloccato');
  assert.equal(deviceB.db.students[0].diagnosticSummary, undefined);

  // Sblocco: la decifratura dei blob locali avviene subito, in locale.
  await keystoreB.unlock('uid-1', 'frase segreta dispositivo A', 'phrase');
  const { decryptLocalStudents } = await import('../src/services/encryptionKeys');
  const key = (await keystoreB.deviceKey('uid-1'))!;
  const { students, changed } = await decryptLocalStudents(deviceB.db.students, key);
  assert.equal(changed, true);
  assert.equal(students[0].diagnosticSummary, SENSITIVE.diagnosticSummary);
  assert.equal(students[0].sensitiveEnc, undefined, 'il blob lascia il posto ai valori');

  // Il ciclo successivo rimanda al cloud la propria cifratura senza perdere nulla.
  deviceB.db.students = students;
  clock.now = '2026-10-02T09:00:00.000Z';
  await makeEngine(deviceB, cloud, clock, keystoreB).syncNow();
  assertNoPlaintextSensitive(cloud.state.students, 'cloud sempre senza chiari');
  const blob = (statePayloadOf(cloud, 'students') as Array<{ sensitiveEnc: never }>)[0].sensitiveEnc;
  const { decryptJson } = await import('../src/services/sensitiveCrypto');
  assert.deepEqual(await decryptJson(key, blob), SENSITIVE, 'il nuovo blob contiene gli stessi valori');
});

// ---------------------------------------------------------------------------
// INGRESSO senza chiave: valori locali conservati, blob non scartato
// ---------------------------------------------------------------------------

test('B5. ingresso senza chiave: i valori locali restano e il blob sopravvive', async () => {
  const clock = { now: '2026-10-01T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const deviceA = makeDevice({ students: [student('s1', { ...SENSITIVE })] });
  const keystoreA = makeKeystore(cloud, clock, deviceA);
  await keystoreA.activate('uid-1', 'frase segreta dispositivo A');
  const engineA = makeEngine(deviceA, cloud, clock, keystoreA);
  await engineA.syncNow();

  // B ha gli stessi alunni con valori riservati LOCALI diversi, senza chiave.
  const deviceB = makeDevice({ students: [student('s1', { diagnosticSummary: 'Sintesi raccolta a mano da B' })] });
  const keystoreB = makeKeystore(cloud, clock, deviceB);
  const engineB = makeEngine(deviceB, cloud, clock, keystoreB);
  deviceB.meta['sync:state'] = alignedState(deviceB, cloud, true, docUpdatedAt(cloud, 'students'));

  // A aggiorna il resto della scheda: il cloud diventa più recente (ogni
  // scrittura di A rifirma il blob con un IV nuovo: il riferimento va preso ora).
  clock.now = '2026-10-01T12:00:00.000Z';
  deviceA.db.students[0].className = '3G';
  await engineA.syncNow();
  const blob = clone((statePayloadOf(cloud, 'students') as Array<{ sensitiveEnc: unknown }>)[0].sensitiveEnc);

  // B tira: il remoto vince sul resto della scheda, ma i riservati locali restano.
  clock.now = '2026-10-01T13:00:00.000Z';
  await engineB.syncNow();
  assert.equal(deviceB.db.students[0].className, '3G', 'il resto della scheda segue il cloud');
  assert.equal(deviceB.db.students[0].diagnosticSummary, 'Sintesi raccolta a mano da B', 'i riservati locali sono conservati');
  assert.deepEqual(deviceB.db.students[0].sensitiveEnc, blob, 'il blob cifrato non è scartato');

  // Una successiva scrittura di B non cancella il blob di A.
  deviceB.db.students[0].fullName = 'Alunno aggiornato da B';
  clock.now = '2026-10-01T14:00:00.000Z';
  await engineB.syncNow();
  assert.deepEqual((statePayloadOf(cloud, 'students') as Array<{ sensitiveEnc: unknown }>)[0].sensitiveEnc, blob, 'blob invariato anche dopo la scrittura di B');
  assertNoPlaintextSensitive(cloud.state.students, 'nessun chiaro in uscita da B');
});

// ---------------------------------------------------------------------------
// CAMBIO FRASE senza ricifrare gli alunni
// ---------------------------------------------------------------------------

test('B6. cambio frase: gli alunni cifrati nel cloud non vengono toccati', async () => {
  const clock = { now: '2026-10-01T10:00:00.000Z' };
  const cloud = makeFakeCloud(clock);
  const device = makeDevice({ students: [student('s1', { ...SENSITIVE })] });
  const keystore = makeKeystore(cloud, clock, device);
  await keystore.activate('uid-1', 'prima frase segreta lunga');
  const engine = makeEngine(device, cloud, clock, keystore);
  await engine.syncNow();

  const studentsBefore = JSON.stringify(cloud.state.students);
  const studentsWrites = cloud.writes.byDoc.students ?? 0;

  clock.now = '2026-10-01T11:00:00.000Z';
  await keystore.changePassphrase('uid-1', { secret: 'prima frase segreta lunga', kind: 'phrase' }, 'seconda frase segreta lunga');
  await engine.syncNow();

  assert.equal(JSON.stringify(cloud.state.students), studentsBefore, 'documento alunni identico (stessi blob, stesso updatedAt)');
  assert.equal(cloud.writes.byDoc.students ?? 0, studentsWrites, 'nessuna riscrittura degli alunni');
  assert.equal(cloud.writes.byDoc.encryptionKeys, 2, 'solo il documento chiavi è stato aggiornato');

  // La nuova frase sblocca e apre gli stessi blob.
  const deviceC = makeDevice();
  const keystoreC = makeKeystore(cloud, clock, deviceC);
  await keystoreC.unlock('uid-1', 'seconda frase segreta lunga', 'phrase');
  const { decryptJson } = await import('../src/services/sensitiveCrypto');
  const blob = (statePayloadOf(cloud, 'students') as Array<{ sensitiveEnc: never }>)[0].sensitiveEnc;
  assert.deepEqual(await decryptJson((await keystoreC.deviceKey('uid-1'))!, blob), SENSITIVE);
});

// ---------------------------------------------------------------------------
// Copie "fuori dispositivo": blob mai presenti
// ---------------------------------------------------------------------------

test('B7. endpoint di analisi e copie locali: niente blob cifrati in giro', () => {
  const withBlob = student('s1', { ...SENSITIVE, sensitiveEnc: { v: 1, iv: 'AAAA', ct: 'BBBB' } });
  const clean = withoutSensitiveStudent(withBlob) as unknown as Record<string, unknown>;
  assert.equal(clean.sensitiveEnc, undefined, 'il blob non va agli endpoint di analisi');
  assert.equal(clean.diagnosticSummary, undefined, 'nemmeno i campi in chiaro');
  assert.equal(withBlob.sensitiveEnc !== undefined, true, 'l originale non è mutato');

  const profile = profileWith({ assignedStudents: ['Rossi'], sensitiveEnc: { v: 1, iv: 'AAAA', ct: 'BBBB' } });
  const cleanProfile = withoutSensitiveProfile(profile) as unknown as Record<string, unknown>;
  assert.equal(cleanProfile.sensitiveEnc, undefined);
  assert.equal(cleanProfile.assignedStudents, undefined);
});

test('B8. backup locale resta completo: chiari e blob sono dati dell utente', async () => {
  const legacyStorage = { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} };
  database.close();
  await database.delete();
  const value = student('s1', { ...SENSITIVE, sensitiveEnc: { v: 1, iv: 'AAAA', ct: 'BBBB' } });
  await database.initialize({ ...emptyInstallation(), students: [value] }, legacyStorage);
  await storage.saveStudents([value]);
  const exported = JSON.parse(await storage.exportDataBackup()) as { students: Student[] };
  assert.deepEqual(exported.students[0], value, 'il backup contiene tutto: è un file dell utente');
  await storage.saveStudents([]);
  assert.equal(await storage.importDataBackup(JSON.stringify(exported)), true);
  assert.deepEqual((await storage.getStudents())[0], value);
  database.close();
  await database.delete();
});
