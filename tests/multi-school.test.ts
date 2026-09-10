import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSchoolLinkedData, normalizeTeacherProfile, findTimetableConflicts, legacyPrimarySchoolId } from '../src/utils/multiSchool';
import { validateBackup } from '../src/services/backup';
import type { CalendarEvent, CircularDocument, TeacherProfile, TimetableSlot } from '../src/types';

const profile = (): TeacherProfile => ({ id: 'teacher-1', fullName: 'Docente', schoolName: 'Istituto A', email: 'a@scuola.it', schoolYear: '2026/2027', schoolLevel: 'ssig', primarySubjects: [], classes: ['1A'], campuses: ['Centro'], roles: [] });
const slot = (id: string, schoolId?: string): TimetableSlot => ({ id, dayOfWeek: 1, periodNumber: 1, startTime: '08:00', endTime: '09:00', subject: 'Italiano', className: '1A', schoolId });
const circular = (id = 'c1'): CircularDocument => ({ id, title: 'C', uploadDate: '2026-09-01', fileType: 'text', fileName: 'c.txt', extractedCount: 0, relevantCount: 0 });
const event = (sourceType: CalendarEvent['sourceType'] = 'manuale'): CalendarEvent => ({ id: 'e1', title: 'Impegno', category: 'personale', date: '2026-09-10', isAllDay: true, sourceType });

test('legacy profile migration is stable and complete', () => {
  const migrated = normalizeTeacherProfile(profile());
  assert.equal(migrated.schools?.length, 1);
  assert.equal(migrated.schools?.[0].id, legacyPrimarySchoolId(profile()));
  assert.equal(migrated.schools?.[0].isPrimary, true);
  assert.equal(migrated.schools?.[0].institutionalEmail, profile().email);
  assert.deepEqual(normalizeTeacherProfile(migrated), migrated);
});
test('partial legacy school data is retained without inventing values', () => {
  const p = profile(); p.schoolName = ''; p.email = undefined; p.campuses = [];
  const s = normalizeTeacherProfile(p).schools![0]; assert.equal(s.name, ''); assert.equal(s.institutionalEmail, undefined); assert.deepEqual(s.campuses, []);
});
test('existing schools are not duplicated and secondary inactive data is retained', () => {
  const p = { ...profile(), schools: [{ id: 'a', name: 'A', isPrimary: true, active: true }, { id: 'b', name: 'B', active: false }] };
  const n = normalizeTeacherProfile(p); assert.deepEqual(n.schools?.map(s => s.id), ['a', 'b']); assert.equal(n.schools?.[1].active, false); // normalized active means usable data, UI controls visibility
});
test('legacy linked collections receive primary schoolId, general events do not', () => {
  const p = profile(); const data = normalizeSchoolLinkedData({ profile: p, events: [event(), event('circolare')], circulars: [circular()], students: [], definitiveTimetable: [slot('t')], provisionalTimetable: [] });
  assert.equal(data.definitiveTimetable[0].schoolId, data.profile.schools[0].id);
  assert.equal(data.circulars[0].schoolId, data.profile.schools[0].id);
  assert.equal(data.events[0].schoolId, undefined); assert.equal(data.events[1].schoolId, data.profile.schools[0].id);
});
test('new schoolId round trips through backup validation', () => {
  const p = normalizeTeacherProfile(profile()); const data = normalizeSchoolLinkedData({ profile: p, events: [], circulars: [circular()], students: [], definitiveTimetable: [slot('t', 'b')], provisionalTimetable: [], timetableMode: 'auto', onboardingCompleted: true });
  assert.doesNotThrow(() => validateBackup({ version: 3, ...data })); assert.equal(data.definitiveTimetable[0].schoolId, 'b');
});
test('different schools overlapping lessons are reported, same school is not', () => {
  assert.equal(findTimetableConflicts([slot('a', 'school-a'), slot('b', 'school-b')]).length, 1);
  assert.equal(findTimetableConflicts([slot('a', 'school-a'), slot('b', 'school-a')]).length, 0);
});
test('secondary school can be switched off without deletion', () => {
  const p = { ...profile(), schools: [{ id: 'a', name: 'A', isPrimary: true, active: true }, { id: 'b', name: 'B', active: false }] };
  const n = normalizeTeacherProfile(p); assert.equal(n.schools?.find(s => s.id === 'b')?.name, 'B');
});
