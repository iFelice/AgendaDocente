import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { database } from '../src/services/db';
import { emptyInstallation, storage } from '../src/services/storage';
import { isValidStudentScheduledAssessment, validateBackup, validateStudentScheduledAssessment } from '../src/services/backup';
import type { StudentScheduledAssessment } from '../src/types';
import { createStoreAdapter } from '../src/services/sync/localStore';

const legacyStorage = { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} };
const item = (overrides: Partial<StudentScheduledAssessment> = {}): StudentScheduledAssessment => ({
  id: 'scheduled-1', studentId: 'student-1', className: '2E', date: '2026-09-25', subject: 'Matematica',
  assessmentType: 'written', topic: 'Equazioni di primo grado', note: 'Ripassare gli esercizi assegnati',
  status: 'scheduled', createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z', ...overrides,
});

async function reset() {
  database.close();
  await database.delete();
  await database.initialize(emptyInstallation(), legacyStorage);
}

test('scheduled assessment model validates required fields and valid enums', () => {
  assert.doesNotThrow(() => validateStudentScheduledAssessment(item()));
  assert.equal(isValidStudentScheduledAssessment(item()), true);
  assert.equal(isValidStudentScheduledAssessment({ ...item(), studentId: '' }), false);
  assert.equal(isValidStudentScheduledAssessment({ ...item(), className: '' }), false);
  assert.equal(isValidStudentScheduledAssessment({ ...item(), date: '25/09/2026' }), false);
  assert.equal(isValidStudentScheduledAssessment({ ...item(), assessmentType: 'unknown' as never }), false);
  assert.equal(isValidStudentScheduledAssessment({ ...item(), status: 'unknown' as never }), false);
});

test('scheduled assessment cannot contain an actual grade', () => {
  assert.equal(isValidStudentScheduledAssessment({ ...item(), numericValue: 7 } as never), false);
  assert.equal(isValidStudentScheduledAssessment({ ...item(), judgementValue: 'Buono' } as never), false);
  assert.equal(isValidStudentScheduledAssessment({ ...item(), valueKind: 'numeric' } as never), false);
});

test('creation defaults status to scheduled and CRUD uses studentId with deterministic scheduled-first ordering', async () => {
  await reset();
  const withoutStatus = item() as Omit<StudentScheduledAssessment, 'status'>;
  await storage.saveScheduledAssessment(withoutStatus);
  assert.equal((await storage.getScheduledAssessments())[0].status, 'scheduled');
  await storage.saveScheduledAssessment(item({ id: 'completed', studentId: 'student-1', date: '2026-09-10', status: 'completed' }));
  await storage.saveScheduledAssessment(item({ id: 'other-student', studentId: 'student-2' }));
  const rows = await storage.getScheduledAssessmentsByStudent('student-1');
  assert.deepEqual(rows.map(row => row.id), ['scheduled-1', 'completed']);
  assert.equal(rows[0].topic, 'Equazioni di primo grado');
  assert.equal(rows[0].note, 'Ripassare gli esercizi assegnati');
  await storage.deleteScheduledAssessment('completed');
  assert.deepEqual((await storage.getScheduledAssessments()).map(row => row.id), ['scheduled-1', 'other-student']);
});

test('update preserves id, studentId and createdAt while storage updates updatedAt', async () => {
  await reset();
  const original = item();
  await storage.saveScheduledAssessment(original);
  const saved = (await storage.getScheduledAssessments())[0];
  await storage.saveScheduledAssessment({ ...saved, topic: 'Nuovo argomento', createdAt: '1999-01-01T00:00:00.000Z', updatedAt: '1999-01-01T00:00:00.000Z' });
  const updated = (await storage.getScheduledAssessments())[0];
  assert.equal(updated.id, original.id);
  assert.equal(updated.studentId, original.studentId);
  assert.equal(updated.createdAt, original.createdAt);
  assert.notEqual(updated.updatedAt, '1999-01-01T00:00:00.000Z');
  assert.equal(updated.topic, 'Nuovo argomento');
});

test('student archive leaves scheduled assessments and actual assessments untouched', async () => {
  await reset();
  await storage.saveScheduledAssessment(item());
  await storage.archiveStudent('student-1');
  assert.equal((await storage.getScheduledAssessmentsByStudent('student-1')).length, 1);
});

test('backup includes scheduledAssessments and restore preserves them', async () => {
  await reset();
  await storage.saveScheduledAssessment(item());
  const exported = JSON.parse(await storage.exportDataBackup());
  assert.deepEqual(exported.scheduledAssessments.map((row: StudentScheduledAssessment) => row.topic), ['Equazioni di primo grado']);
  await storage.deleteScheduledAssessment('scheduled-1');
  assert.equal((await storage.getScheduledAssessments()).length, 0);
  assert.equal(await storage.importDataBackup(JSON.stringify(exported)), true);
  assert.equal((await storage.getScheduledAssessments())[0].id, 'scheduled-1');
});

test('legacy backup without scheduledAssessments restores an empty collection', async () => {
  await reset();
  const backup = JSON.parse(await storage.exportDataBackup());
  delete backup.scheduledAssessments;
  assert.doesNotThrow(() => validateBackup(backup));
  await storage.saveScheduledAssessment(item());
  assert.equal(await storage.importDataBackup(JSON.stringify(backup)), true);
  assert.deepEqual(await storage.getScheduledAssessments(), []);
});

test('invalid scheduled assessment restore remains atomic', async () => {
  await reset();
  await storage.saveScheduledAssessment(item());
  const backup = JSON.parse(await storage.exportDataBackup());
  backup.scheduledAssessments = [{ ...item({ id: 'invalid' }), topic: 'x'.repeat(501) }];
  assert.equal(await storage.importDataBackup(JSON.stringify(backup)), false);
  assert.deepEqual((await storage.getScheduledAssessments()).map(row => row.id), ['scheduled-1']);
});

test('remote full restore applies the scheduled-assessment collection from the sync snapshot', async () => {
  await reset();
  await storage.saveScheduledAssessment(item());
  const snapshot = await database.readSnapshot();
  await createStoreAdapter().applyLocal({ fullRestore: { ...snapshot, scheduledAssessments: [] } });
  assert.deepEqual(await storage.getScheduledAssessments(), []);
});

test('new Dexie collection coexists with existing StudentAssessment data', async () => {
  await reset();
  const actualAssessment = { id: 'assessment-1', studentId: 'student-1', className: '2E', date: '2026-09-10', assessmentType: 'oral' as const, valueKind: 'numeric' as const, numericValue: 7, createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z' };
  await storage.saveAssessment(actualAssessment);
  await storage.saveScheduledAssessment(item());
  assert.equal((await storage.getAssessments()).length, 1);
  assert.equal((await storage.getScheduledAssessments()).length, 1);
  assert.ok((await database.readSnapshot()).scheduledAssessments);
});
