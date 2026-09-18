import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBackup, validateStudentAssessment } from '../src/services/backup';
import { database } from '../src/services/db';
import { emptyInstallation, storage } from '../src/services/storage';
import type { StudentAssessment } from '../src/types';

const legacyStorage = {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const assessment = (overrides: Partial<StudentAssessment> = {}): StudentAssessment => ({
  id: 'assessment-1',
  studentId: 'student-1',
  className: '2E',
  date: '2026-09-10',
  assessmentType: 'oral',
  valueKind: 'numeric',
  numericValue: 7.25,
  createdAt: '2026-09-10T08:00:00.000Z',
  updatedAt: '2026-09-10T08:00:00.000Z',
  ...overrides,
});

async function resetStorage() {
  database.close();
  await database.delete();
  await database.initialize(emptyInstallation(), legacyStorage);
}

test('numeric assessment accepts and preserves decimal value exactly', () => {
  const value = assessment({ numericValue: 7.125 });
  assert.doesNotThrow(() => validateStudentAssessment(value));
  assert.equal(value.numericValue, 7.125);
});

test('judgement assessment is valid', () => {
  assert.doesNotThrow(() => validateStudentAssessment(assessment({
    valueKind: 'judgement',
    numericValue: undefined,
    judgementValue: 'Avanzato',
  })));
});

test('assessment validation rejects missing conditional values and invalid enums', () => {
  assert.throws(() => validateStudentAssessment(assessment({ numericValue: undefined })));
  assert.throws(() => validateStudentAssessment(assessment({ valueKind: 'judgement', numericValue: undefined, judgementValue: undefined })));
  assert.throws(() => validateStudentAssessment(assessment({ valueKind: 'invalid' as StudentAssessment['valueKind'] })));
  assert.throws(() => validateStudentAssessment(assessment({ assessmentType: 'invalid' as StudentAssessment['assessmentType'] })));
  assert.throws(() => validateStudentAssessment(assessment({ numericValue: Number.NaN })));
  assert.throws(() => validateStudentAssessment(assessment({ valueKind: 'judgement', numericValue: undefined, judgementValue: '   ' })));
});

test('local CRUD, student filtering, deterministic newest-first order, and update createdAt preservation', async () => {
  await resetStorage();
  const first = assessment({ id: 'a1', date: '2026-09-08', createdAt: '2026-09-08T08:00:00.000Z' });
  const second = assessment({ id: 'a2', date: '2026-09-10', createdAt: '2026-09-10T08:00:00.000Z', studentId: 'student-2' });
  await storage.saveAssessment(first);
  await storage.saveAssessment(second);
  assert.deepEqual((await storage.getAssessmentsByStudent('student-1')).map((item) => item.id), ['a1']);
  assert.deepEqual((await storage.getAssessments()).map((item) => item.id), ['a1', 'a2']);

  await storage.saveAssessment({ ...first, numericValue: 8.5, updatedAt: 'ignored-by-storage' });
  const updated = (await storage.getAssessments())[0];
  assert.equal(updated.numericValue, 8.5);
  assert.equal(updated.createdAt, first.createdAt);
  assert.notEqual(updated.updatedAt, 'ignored-by-storage');

  await storage.deleteAssessment('a1');
  assert.deepEqual((await storage.getAssessments()).map((item) => item.id), ['a2']);
});

test('archiving a Student does not delete local assessments', async () => {
  await resetStorage();
  await storage.saveAssessment(assessment());
  await storage.archiveStudent('student-1');
  assert.equal((await storage.getAssessmentsByStudent('student-1')).length, 1);
});

test('new backup includes assessments and restore preserves them', async () => {
  await resetStorage();
  await storage.saveAssessment(assessment());
  const exported = JSON.parse(await storage.exportDataBackup());
  assert.deepEqual(exported.assessments, [assessment({ updatedAt: exported.assessments[0].updatedAt })]);
  await storage.deleteAssessment('assessment-1');
  assert.equal(await storage.importDataBackup(JSON.stringify(exported)), true);
  assert.deepEqual(await storage.getAssessments(), exported.assessments);
});

test('legacy backup without assessments imports with an empty assessment collection', async () => {
  await resetStorage();
  const legacyBackup = JSON.parse(await storage.exportDataBackup()) as Record<string, unknown>;
  delete legacyBackup.assessments;
  assert.doesNotThrow(() => validateBackup(legacyBackup));
  assert.equal(await storage.importDataBackup(JSON.stringify(legacyBackup)), true);
  assert.deepEqual(await storage.getAssessments(), []);
});

test('invalid assessment in restore is rejected atomically', async () => {
  await resetStorage();
  const existing = assessment();
  await storage.saveAssessment(existing);
  const storedExisting = (await storage.getAssessments())[0];
  const backup = JSON.parse(await storage.exportDataBackup());
  backup.assessments = [assessment({ id: 'invalid', numericValue: undefined })];
  assert.equal(await storage.importDataBackup(JSON.stringify(backup)), false);
  assert.deepEqual(await storage.getAssessments(), [storedExisting]);
});
