import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBackup } from '../src/services/backup';
import { database } from '../src/services/db';
import { emptyInstallation, storage } from '../src/services/storage';
import { isValidStudentPayload } from '../src/services/sync/remoteSchema';
import { planSync } from '../src/services/sync/merge';
import type { Student } from '../src/types';

const legacyStorage = {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const note = {
  id: 'note-1',
  date: '2026-09-10',
  category: 'didattica' as const,
  title: 'Osservazione',
  content: 'Nota personale',
  createdAt: '2026-09-10T08:00:00.000Z',
};

const student = (metadata: Partial<Student> = {}): Student => ({
  id: 'student-1',
  fullName: 'Rossi Matteo',
  className: '2E',
  notes: [note],
  ...metadata,
});

function backupData(students: Student[]) {
  return { version: 3, ...emptyInstallation(), students };
}

test('legacy Student without school metadata remains valid in backup and remote schema', () => {
  const value = student();
  assert.doesNotThrow(() => validateBackup(backupData([value])));
  assert.equal(isValidStudentPayload(value), true);
});

test('active Student school metadata is preserved and validated', () => {
  const value = student({ schoolId: 'school-ic-centro', schoolYear: '2026-27', status: 'active' });
  assert.doesNotThrow(() => validateBackup(backupData([value])));
  assert.equal(isValidStudentPayload(value), true);
});

test('archived Student metadata is preserved and invalid status is rejected', () => {
  const value = student({
    schoolId: 'school-ic-centro',
    schoolYear: '2026-27',
    status: 'archived',
    archivedAt: '2026-09-10T08:00:00.000Z',
    archivedReason: 'Cambio di istituto',
  });
  assert.doesNotThrow(() => validateBackup(backupData([value])));
  assert.equal(isValidStudentPayload(value), true);

  assert.throws(() => validateBackup(backupData([student({ status: 'deleted' as Student['status'] })])));
  assert.equal(isValidStudentPayload(student({ status: 'deleted' as Student['status'] })), false);
});

test('backup export and restore preserve Student school and archive metadata', async () => {
  database.close();
  await database.delete();
  await database.initialize(emptyInstallation(), legacyStorage);

  const value = student({
    schoolId: 'school-ic-centro',
    schoolYear: '2026-27',
    status: 'archived',
    archivedAt: '2026-09-10T08:00:00.000Z',
    archivedReason: 'Cambio di istituto',
  });
  await storage.saveStudents([value]);
  const exported = await storage.exportDataBackup();
  await storage.saveStudents([]);
  assert.equal(await storage.importDataBackup(exported), true);
  assert.deepEqual((await storage.getStudents())[0], value);

  database.close();
  await database.delete();
});

test('remote students payload and sync plan preserve the new optional metadata', () => {
  const value = student({
    schoolId: 'school-ic-centro',
    schoolYear: '2026-27',
    status: 'archived',
    archivedAt: '2026-09-10T08:00:00.000Z',
    archivedReason: 'Cambio di istituto',
  });
  assert.equal(isValidStudentPayload({ ...value }), true);
  const snapshot = { ...emptyInstallation(), students: [value] };
  const plan = planSync({
    uid: 'uid-1',
    snapshot,
    remote: { state: {}, items: { events: [], circulars: [] } },
    syncState: null,
    nowIso: '2026-09-10T09:00:00.000Z',
  });
  assert.deepEqual(plan.stateWrites.students, [value]);
});
