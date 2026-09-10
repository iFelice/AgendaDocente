import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCongruence, getCongruenceStatus, slotDurationMinutes, calculateTotalTimetableMinutes } from '../src/utils/timetableCongruence';
import type { TeacherProfile, TimetableSlot } from '../src/types';

const primary = 'school-primary-real-id';
const secondary = 'school-secondary-real-id';
const profile: TeacherProfile = {
  id: 'teacher', fullName: 'Docente', schoolName: 'Principale', schoolYear: '2026/2027',
  schoolLevel: 'ssig', primarySubjects: [], classes: [], campuses: [], roles: [], weeklyDeclaredHours: 18,
  schools: [{ id: primary, name: 'Principale', isPrimary: true, weeklyHours: 99 },
    { id: secondary, name: 'Secondaria', weeklyHours: 6, active: true }],
};
const slots = (hours: number, schoolId?: string): TimetableSlot[] => Array.from({ length: hours }, (_, i) => ({
  id: `${schoolId}-${i}`, dayOfWeek: 1, periodNumber: i + 1, startTime: '08:00', endTime: '09:00', subject: 'Italiano', className: '1A', schoolId,
}));
for (const [p, s, totalOk, schoolsOk] of [[12, 6, true, true], [13, 6, false, false], [12, 5, false, false], [11, 7, true, false]] as const) {
  test(`${p}+${s}/18: total=${totalOk}, distribution=${schoolsOk}`, () => {
    const timetable = [...slots(p, primary), ...slots(s, secondary)];
    const result = calculateCongruence(timetable, profile);
    assert.equal(result.totalPlannedMinutes, (p+s)*60);
    assert.equal(result.totalDeclaredMinutes, 18*60);
    assert.deepEqual(result.bySchool[primary], { plannedMinutes: p*60, declaredMinutes: 12*60, differenceMinutes: (p-12)*60 });
    assert.deepEqual(result.bySchool[secondary], { plannedMinutes: s*60, declaredMinutes: 6*60, differenceMinutes: (s-6)*60 });
    assert.equal(result.isTotalCongruent, totalOk);
    assert.equal(result.isBySchoolCongruent, schoolsOk);
    assert.equal(getCongruenceStatus(timetable, profile).isConsistent, totalOk && schoolsOk);
    assert.equal(result.warnings.length === 0, totalOk && schoolsOk);
  });
}
test('legacy slots use the real primary ID without mutating persisted input', () => {
  const timetable = [...slots(6), ...slots(6, primary), ...slots(6, secondary)];
  const before = structuredClone(timetable);
  const result = calculateCongruence(timetable, profile);
  assert.equal(result.bySchool[primary].plannedMinutes, 720);
  assert.equal(result.bySchool.primary, undefined);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(timetable, before);
});
test('single real primary, legacy default 18 and inactive secondary: no warnings', () => {
  const mono = { ...profile, weeklyDeclaredHours: undefined, schools: profile.schools!.map(s => s.id === secondary ? { ...s, active: false } : s) };
  assert.deepEqual(calculateCongruence(slots(18, primary), mono).warnings, []);
  assert.equal(getCongruenceStatus(slots(18, primary), mono).isConsistent, true);
});
test('expected hours exist even when a school has no planned slots', () => {
  const result = calculateCongruence([], profile);
  assert.equal(result.bySchool[primary].declaredMinutes, 720);
  assert.equal(result.bySchool[secondary].declaredMinutes, 360);
  assert.equal(result.isBySchoolCongruent, false);
});
test('50/55/60 minute slots retain exact minute totals', () => {
  const timetable = ['08:50', '08:55', '09:00'].map(endTime => ({ ...slots(1)[0], endTime }));
  assert.equal(calculateTotalTimetableMinutes(timetable), 165);
});
test('invalid times, zero/negative durations and overnight lessons contribute zero', () => {
  for (const [start, end] of [['09:00','08:00'], ['08:00','08:00'], ['23:00','01:00'], ['24:00','25:00'], ['08:60','10:00'], ['bad','10:00'], ['08:00',''], ['8:00','09:00'], [undefined,'09:00'], ['08:00',NaN], [null,'09:00']]) {
    assert.equal(slotDurationMinutes(start as string, end as string), 0, `${start}-${end}`);
  }
});

// Change a single planned slot by an exact signed number of minutes.
const withDifference = (difference: number, schoolId: string, hours: number) => {
  const timetable = slots(hours, schoolId);
  const end = 9 * 60 + difference;
  timetable[0].endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  return timetable;
};
for (const difference of [-20, -5, 5, 6, 10, 30, 50, 60, 90]) {
  test(`school and total difference ${difference} min: matching state and exact warnings`, () => {
    const timetable = [...withDifference(difference, primary, 12), ...slots(6, secondary)];
    const result = calculateCongruence(timetable, profile);
    const status = getCongruenceStatus(timetable, profile);
    const congruent = Math.abs(difference) <= 5;
    assert.equal(result.isTotalCongruent, congruent);
    assert.equal(result.isBySchoolCongruent, congruent);
    assert.equal(status.isConsistent, congruent);
    if (congruent) {
      assert.deepEqual(result.warnings, []);
      assert.equal(status.totalWarning, null);
      assert.deepEqual(status.bySchoolWarnings, []);
    } else {
      const expected = new Map([[-20, '20 min in meno'], [6, '6 min in più'], [10, '10 min in più'], [30, '30 min in più'], [50, '50 min in più'], [60, '1 h in più'], [90, '1 h 30 min in più']]).get(difference)!;
      assert.equal(result.warnings.length, 2);
      for (const warning of result.warnings) assert.ok(warning.includes(expected), warning);
      assert.ok(status.totalWarning?.includes(expected));
      assert.equal(status.bySchoolWarnings.length, 1);
      assert.equal(status.bySchoolWarnings[0].schoolId, primary);
      assert.ok(status.bySchoolWarnings[0].warning.includes(expected));
    }
  });
}
test('correct total with +20/-20 distribution shows both school details and distribution warning', () => {
  const timetable = [...withDifference(20, primary, 12), ...withDifference(-20, secondary, 6)];
  const result = calculateCongruence(timetable, profile);
  const status = getCongruenceStatus(timetable, profile);
  assert.equal(result.isTotalCongruent, true);
  assert.equal(result.isBySchoolCongruent, false);
  assert.equal(status.isConsistent, false);
  assert.equal(status.totalWarning, null);
  assert.equal(result.warnings.length, 3);
  assert.ok(result.warnings.some(w => w.includes('20 min in più')));
  assert.ok(result.warnings.some(w => w.includes('20 min in meno')));
  assert.ok(result.warnings.some(w => w.includes('distribuzione')));
  assert.equal(status.bySchoolWarnings.length, 3);
  assert.match(status.bySchoolWarnings.find(w => w.schoolId === primary)!.warning, /20 min in più/);
  assert.match(status.bySchoolWarnings.find(w => w.schoolId === secondary)!.warning, /20 min in meno/);
  assert.ok(status.bySchoolWarnings.find(w => w.schoolId === 'distribution'));
});
