import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { database } from '../src/services/db';
import { emptyInstallation, storage } from '../src/services/storage';
import { isStudentActive, matchStudentName, compareStudentNames } from '../src/utils/studentMatcher';
import type { Student } from '../src/types';

const legacyStorage = {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const makeStudent = (overrides: Partial<Student> = {}): Student => ({
  id: `student-${Math.random()}`,
  fullName: 'Rossi Matteo',
  className: '2E',
  notes: [],
  ...overrides,
});

async function resetStorage(students: Student[] = []) {
  database.close();
  await database.delete();
  await database.initialize({ ...emptyInstallation(), students }, legacyStorage);
}

test('legacy undefined status is active and archived students are excluded from matching', () => {
  const legacy = makeStudent({ id: 'legacy' });
  const archived = makeStudent({ id: 'archived', status: 'archived' });
  assert.equal(isStudentActive(legacy), true);
  assert.equal(isStudentActive(archived), false);
  assert.equal(matchStudentName('Rossi Matteo', [legacy, archived]).matchedStudentId, 'legacy');
  assert.equal(matchStudentName('Rossi Matteo', [archived]).status, 'unmatched');
});

test('student ordering is deterministic, case/accent/spacing insensitive, without changing fullName', () => {
  const input = [
    makeStudent({ id: '3', fullName: '  Zeta   Luca ' }),
    makeStudent({ id: '2', fullName: 'rossi Matteo' }),
    makeStudent({ id: '1', fullName: 'Ròssi   Anna' }),
    makeStudent({ id: '4', fullName: "D'Angelo Sara" }),
  ];
  const original = input.map((student) => student.fullName);
  const sorted = [...input].sort(compareStudentNames);
  assert.deepEqual(sorted.map((student) => student.id), ['4', '1', '2', '3']);
  assert.deepEqual(input.map((student) => student.fullName), original);
});

test('duplicate name in same class is rejected, including case/spaces/apostrophe variants', async () => {
  const existing = makeStudent({ id: 'existing', fullName: "D'Angelo  Sara", className: '2E' });
  await resetStorage([existing]);
  await assert.rejects(
    storage.saveStudent(makeStudent({ id: 'new', fullName: "d’angelo sara", className: ' 2E ' })),
    /Esiste già l’alunno/,
  );
});

test('same name in another class is allowed and editing the same id does not collide', async () => {
  const existing = makeStudent({ id: 'existing', fullName: 'Rossi Matteo', className: '2E' });
  await resetStorage([existing]);
  await storage.saveStudent(makeStudent({ id: 'other-class', fullName: 'rossi   matteo', className: '3A' }));
  await storage.saveStudent({ ...existing, fullName: 'ROSSI MATTEO' }, existing);
  assert.equal((await storage.getStudents()).length, 2);
});

test('archive preserves the student and restore preserves the same id', async () => {
  const original = makeStudent({ id: 'stable-id', fullName: 'Rossi Matteo', notes: [{
    id: 'note-1', date: '2026-09-10', category: 'didattica', title: 'Nota', content: 'Test', createdAt: '2026-09-10T08:00:00.000Z',
  }] });
  await resetStorage([original]);
  await storage.archiveStudent(original.id);
  const archived = (await storage.getStudents())[0];
  assert.equal(archived.id, original.id);
  assert.equal(archived.status, 'archived');
  assert.ok(archived.archivedAt);
  assert.deepEqual(archived.notes, original.notes);

  await storage.restoreStudent(original.id);
  const restored = (await storage.getStudents())[0];
  assert.equal(restored.id, original.id);
  assert.equal(restored.status, 'active');
  assert.equal(restored.archivedAt, undefined);
  assert.equal(restored.archivedReason, undefined);
  assert.deepEqual(restored.notes, original.notes);
});
