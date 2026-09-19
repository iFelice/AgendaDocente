import assert from 'node:assert/strict';
import test from 'node:test';
import { contentHash, planSync } from '../src/services/sync/merge';
import { CLOUD_PATH_PATTERN } from '../src/services/sync/firestoreGateway';
import type { RemoteSnapshot, SyncStateV1 } from '../src/services/sync/types';
import { emptyInstallation } from '../src/services/storage';
import type { StudentAssessment } from '../src/types';

const assessment = (id: string, studentId = 'student-1'): StudentAssessment => ({
  id, studentId, className: '2E', date: '2026-09-10', assessmentType: 'oral', valueKind: 'numeric', numericValue: 7.25,
  createdAt: '2026-09-10T08:00:00.000Z', updatedAt: '2026-09-10T08:00:00.000Z',
});
const remote = (assessments: Array<{ id: string; payload: unknown; updatedAt: string }>): RemoteSnapshot => ({
  state: {}, items: { events: [], circulars: [], assessments },
});
const synced = (assessmentRow: StudentAssessment, updatedAt = 't0'): SyncStateV1 => ({
  uid: 'uid-1', state: {}, items: {
    events: { docs: {} }, circulars: { docs: {} },
    assessments: { docs: { [assessmentRow.id]: { hash: JSON.stringify(assessmentRow).length.toString(), updatedAt } } },
  },
});

test('assessment sync is item-level at users/{uid}/assessments/{assessmentId}', () => {
  const row = assessment('a1');
  const plan = planSync({ uid: 'uid-1', snapshot: { ...emptyInstallation(), assessments: [row] }, remote: remote([]), syncState: null, nowIso: 't1' });
  assert.deepEqual(plan.remoteWrites.assessments.a1, row);
  assert.equal(CLOUD_PATH_PATTERN.test('users/uid-1/assessments/a1'), true);
  assert.equal(CLOUD_PATH_PATTERN.test('users/uid-1/assessments/a1'), true);
});

test('two assessments remain independent and a remote valid row is imported locally', () => {
  const a1 = assessment('a1');
  const a2 = assessment('a2', 'student-2');
  const plan = planSync({ uid: 'uid-1', snapshot: { ...emptyInstallation(), assessments: [] }, remote: remote([
    { id: 'a1', payload: a1, updatedAt: 't1' }, { id: 'a2', payload: a2, updatedAt: 't1' },
  ]), syncState: null, nowIso: 't2' });
  assert.deepEqual(plan.fullRestore?.assessments, [a1, a2]);
});

test('local modification writes only the changed assessment', () => {
  const a1 = assessment('a1');
  const a2 = assessment('a2');
  const edited = { ...a1, numericValue: 8.5 };
  const state = synced(a1);
  state.items.assessments!.docs.a2 = { hash: contentHash(a2), updatedAt: 't0' };
  const plan = planSync({ uid: 'uid-1', snapshot: { ...emptyInstallation(), assessments: [edited, a2] }, remote: remote([
    { id: 'a1', payload: a1, updatedAt: 't0' }, { id: 'a2', payload: a2, updatedAt: 't0' },
  ]), syncState: state, nowIso: 't1' });
  assert.deepEqual(Object.keys(plan.remoteWrites.assessments), ['a1']);
  assert.deepEqual(plan.remoteDeletes.assessments, []);
});

test('invalid remote assessment is not restored and is scheduled for archive/delete', () => {
  const plan = planSync({ uid: 'uid-1', snapshot: { ...emptyInstallation(), assessments: [] }, remote: remote([
    { id: 'bad', payload: { id: 'bad', studentId: 'student-1' }, updatedAt: 't1' },
  ]), syncState: null, nowIso: 't2' });
  assert.equal(plan.fullRestore, null);
  assert.deepEqual(plan.remoteDeletes.assessments, ['bad']);
  assert.equal(plan.archivedOnOverwrite[0].kind, 'invalid-item:assessments:bad');
});

test('assessment deletion creates a tombstone and does not resurrect after remote edit', () => {
  const row = assessment('a1');
  const state = synced(row, 't0');
  const deleted = planSync({ uid: 'uid-1', snapshot: { ...emptyInstallation(), assessments: [] }, remote: remote([
    { id: 'a1', payload: row, updatedAt: 't0' },
  ]), syncState: state, nowIso: 't1' });
  assert.deepEqual(deleted.remoteDeletes.assessments, ['a1']);
  assert.ok(deleted.nextState.items.assessments?.deleted?.a1);

  const editedRemote = { ...row, numericValue: 9 };
  const afterRemoteEdit = planSync({ uid: 'uid-1', snapshot: { ...emptyInstallation(), assessments: [] }, remote: remote([
    { id: 'a1', payload: editedRemote, updatedAt: 't2' },
  ]), syncState: deleted.nextState, nowIso: 't3' });
  assert.deepEqual(afterRemoteEdit.remoteDeletes.assessments, ['a1']);
  assert.equal(afterRemoteEdit.localAssessments, undefined);
});
