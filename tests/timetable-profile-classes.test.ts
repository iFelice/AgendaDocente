import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionReconstructedSlots,
  applyReconstruction,
  rejectionReasonLabel,
} from '../src/utils/reconstructTimetable';
import { appendProfileClasses, importedClassesMissingFromProfile } from '../src/utils/profileClasses';
import type { ReconstructedSlot } from '../src/utils/timetableCrossref';
import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

const profile: TeacherProfile = {
  id: 't-1',
  fullName: 'Docente Test',
  schoolName: 'IC Test',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'],
  campuses: [],
  roles: [],
  isSupportTeacher: true,
  schools: [{ id: 's1', name: 'IC Test', isPrimary: true, active: true }],
};

const multiSchoolProfile: TeacherProfile = {
  ...profile,
  schools: [
    { id: 's1', name: 'IC Primario', isPrimary: true, active: true },
    { id: 's2', name: 'IC Secondario', isPrimary: false, active: true, dayPeriods: { ordinaryPeriodsPerDay: 6 } },
  ],
};

const config6: TimeSlotConfig = {
  firstHourStartTime: '08:00',
  periodsPerDay: 6,
  standardDurationMinutes: 60,
  customSlots: Array.from({ length: 6 }, (_, index) => ({
    periodNumber: index + 1,
    label: `${index + 1}ª Ora`,
    startTime: `${String(8 + index).padStart(2, '0')}:00`,
    endTime: `${String(9 + index).padStart(2, '0')}:00`,
  })),
};

const config1: TimeSlotConfig = {
  ...config6,
  periodsPerDay: 1,
  customSlots: [config6.customSlots![0]],
};

let seq = 0;
function item(dayOfWeek: number, periodIndex: number, classLabel: string, selected = true): ReconstructedSlot {
  seq += 1;
  return {
    id: `h9-${seq}`,
    dayOfWeek,
    periodIndex,
    classLabel,
    coTeachingSubjects: [],
    status: 'none',
    confidence: 'low',
    selected,
  };
}

function validSlots(classes: string[]): TimetableSlot[] {
  const { slots, rejected } = partitionReconstructedSlots(
    classes.map((className, index) => item(1, index + 1, className)),
    { profile, timeSlotConfig: config6 },
  );
  assert.equal(rejected.length, 0);
  return slots;
}

test('H9: profilo 3D/3E e import 3D,3E,1C rileva solo 1C', () => {
  const slots = validSlots(['3D', '3E', '1C']);
  assert.deepEqual(importedClassesMissingFromProfile(profile, slots), ['1C']);
});

test('H9: classe gia presente non produce warning', () => {
  const slots = validSlots(['3D']);
  assert.deepEqual(importedClassesMissingFromProfile(profile, slots), []);
});

test('H9: confronto case-insensitive e trim evita falsi positivi', () => {
  const lowerProfile = { ...profile, classes: [' 1c ', '3d'] };
  const slots = validSlots(['1C', '3D']);
  assert.deepEqual(importedClassesMissingFromProfile(lowerProfile, slots), []);
});

test('H9: la normalizzazione resta conservativa', () => {
  const oneC = { ...profile, classes: ['1C'] };
  assert.deepEqual(importedClassesMissingFromProfile(oneC, validSlots(['1°C'])), ['1°C']);
  assert.deepEqual(importedClassesMissingFromProfile(oneC, validSlots(['1 C?'])), ['1 C?']);
});

test('H9: due nuove classi sono entrambe mostrate in ordine stabile', () => {
  const slots = validSlots(['2B', '3D', '1C', '2B']);
  assert.deepEqual(importedClassesMissingFromProfile(profile, slots), ['2B', '1C']);
});

test('H9: slot deselezionato con classe nuova non viene rilevato', () => {
  const { slots, rejected } = partitionReconstructedSlots(
    [item(1, 1, '1C', false), item(1, 2, '3D')],
    { profile, timeSlotConfig: config6 },
  );
  assert.equal(rejected.length, 0);
  assert.deepEqual(importedClassesMissingFromProfile(profile, slots), []);
});

test('H9: slot rifiutato non viene rilevato', () => {
  const { slots, rejected } = partitionReconstructedSlots(
    [item(1, 2, '1C')],
    { profile, timeSlotConfig: config1 },
  );
  assert.equal(slots.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'day-not-allowed');
  assert.deepEqual(importedClassesMissingFromProfile(profile, slots), []);
});

test('H9: slot importato con classe nuova resta importabile', () => {
  const { slots, rejected } = partitionReconstructedSlots(
    [item(1, 1, '1C')],
    { profile, timeSlotConfig: config6 },
  );
  assert.equal(rejected.length, 0);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].className, '1C');

  const merged = applyReconstruction([], slots, 'missing-only', { profile });
  assert.equal(merged.addedCount, 1);
  assert.equal(merged.slots[0].className, '1C');
});

test('H9: aggiunta al Profilo preserva esistenti, deduplica e usa classi canoniche', () => {
  assert.deepEqual(appendProfileClasses(['3D', '3E'], ['1C']), ['3D', '3E', '1C']);
  assert.deepEqual(appendProfileClasses(['3D', '1c'], ['1C', '2b', '2B']), ['3D', '1c', '2B']);
});

test('H9: nessun nuovo rejection reason e semantica di partitionReconstructedSlots invariata', () => {
  const { slots, rejected } = partitionReconstructedSlots(
    [item(1, 1, '1C'), item(1, 7, '2B'), item(1, 8, '3F')],
    { profile, timeSlotConfig: config6 },
  );
  assert.equal(slots.length, 1, 'la classe sconosciuta valida entra comunque');
  assert.equal(slots[0].className, '1C');
  assert.deepEqual(rejected.map(r => r.reason), ['day-not-allowed', 'day-not-allowed']);
  assert.equal(rejectionReasonLabel(rejected[0].reason), 'Ora non prevista per questo giorno');
});

test('H9: multi-school mantiene la destinazione sugli slot e non altera le altre scuole del Profilo', () => {
  const originalSchools = structuredClone(multiSchoolProfile.schools);
  const { slots, rejected } = partitionReconstructedSlots(
    [item(1, 1, '1C')],
    { profile: multiSchoolProfile, timeSlotConfig: config6, schoolId: 's2' },
  );
  assert.equal(rejected.length, 0);
  assert.equal(slots[0].schoolId, 's2');
  assert.deepEqual(importedClassesMissingFromProfile(multiSchoolProfile, slots), ['1C']);

  const updatedProfile: TeacherProfile = {
    ...multiSchoolProfile,
    classes: appendProfileClasses(multiSchoolProfile.classes, ['1C']),
  };
  assert.deepEqual(updatedProfile.schools, originalSchools, 'nessun refactor/contaminazione del modello scuole');
  assert.deepEqual(updatedProfile.classes, ['3D', '3E', '1C']);
});
