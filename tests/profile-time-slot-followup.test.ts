import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MissingTimeSlotCoverageBanner } from '../src/components/MissingTimeSlotCoverageBanner';
import { ProfileModal } from '../src/components/ProfileModal';
import { TimetableEditor } from '../src/components/TimetableEditor';
import { findMissingTimeSlotCoverage, type MissingTimeSlotCoverage } from '../src/utils/timeSlotCoverage';
import { generateDefaultPeriodSlots } from '../src/utils/timeSlots';
import type { TeacherProfile, TimeSlotConfig } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const WEEK = [1, 2, 3, 4, 5] as const;
const config = (count: number): TimeSlotConfig => ({
  firstHourStartTime: '07:50', periodsPerDay: count, standardDurationMinutes: 60,
  customSlots: generateDefaultPeriodSlots('07:50', count, 60),
});
const custom6: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60,
  customSlots: [
    { periodNumber: 1, startTime: '08:00', endTime: '08:55' },
    { periodNumber: 2, startTime: '08:55', endTime: '09:50' },
    { periodNumber: 3, startTime: '10:05', endTime: '11:00' },
    { periodNumber: 4, startTime: '11:00', endTime: '11:55' },
    { periodNumber: 5, startTime: '12:10', endTime: '13:05' },
    { periodNumber: 6, startTime: '13:05', endTime: '14:00' },
  ],
};
const base: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'Scuola A', schoolLevel: 'ssig',
  schoolYear: '2026/2027', primarySubjects: ['Sostegno'], classes: ['1C'], campuses: [],
  roles: [], isSupportTeacher: true,
};
const school = (id: string, name: string, required: number, over: Record<string, unknown> = {}) => ({
  id, name, isPrimary: id === 'a', active: true,
  dayPeriods: required === 7
    ? { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } }
    : { ordinaryPeriodsPerDay: 6 },
  ...over,
});
const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : textOf(child)).join(' ').replace(/\s+/g, ' ').trim();

test('H7 follow-up/1-4: mismatch solo quando max giorno supera le fasce reali', () => {
  const profile7 = { ...base, schools: [school('a', 'Scuola A', 7)] } as TeacherProfile;
  const profile6 = { ...base, schools: [school('a', 'Scuola A', 6)] } as TeacherProfile;

  assert.deepEqual(findMissingTimeSlotCoverage(profile7, config(6), WEEK), [{
    schoolId: 'a', schoolName: 'Scuola A', requiredPeriods: 7, effectivePeriods: 6,
  }]);
  assert.deepEqual(findMissingTimeSlotCoverage(profile7, config(7), WEEK), []);
  assert.deepEqual(findMissingTimeSlotCoverage(profile6, config(6), WEEK), []);
  assert.deepEqual(findMissingTimeSlotCoverage(profile7, config(8), WEEK), []);
});

test('H7 follow-up/5-6: banner visibile e ogni CTA conserva la scuola corretta', async () => {
  const missing: MissingTimeSlotCoverage[] = [
    { schoolId: 'a', schoolName: 'Scuola A', requiredPeriods: 7, effectivePeriods: 6 },
    { schoolId: 'b', schoolName: 'Scuola B', requiredPeriods: 8, effectivePeriods: 6 },
  ];
  const configured: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(MissingTimeSlotCoverageBanner, {
      missing,
      onConfigure: (id: string) => configured.push(id),
    }));
  });
  const alerts = renderer.root.findAll(n => n.props.role === 'alert');
  assert.equal(alerts.length, 2);
  assert.match(textOf(alerts[0]), /7 ore.*Scuola A.*6\s*ª ora/);
  assert.match(textOf(alerts[1]), /8 ore.*Scuola B.*6\s*ª ora/);
  const buttons = renderer.root.findAll(n => n.type === 'button');
  assert.deepEqual(buttons.map(b => b.props['data-school-id']), ['a', 'b']);
  await act(async () => { buttons[1].props.onClick(); });
  assert.deepEqual(configured, ['b'], 'la CTA di B non apre A');
  renderer.unmount();
});

async function saveProfileModal(profile: TeacherProfile, globalConfig: TimeSlotConfig) {
  const saved: TeacherProfile[] = [];
  const reported: MissingTimeSlotCoverage[][] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(ProfileModal, {
      isOpen: true,
      onClose: () => {},
      profile,
      timeSlotConfig: globalConfig,
      onSaveProfile: (next: TeacherProfile) => { saved.push(next); },
      onMissingTimeSlotCoverage: (missing: MissingTimeSlotCoverage[]) => reported.push(missing),
      onDataImported: () => {},
      events: [],
      initialTab: 'profilo',
    }));
  });
  const form = renderer.root.findAll(n => n.type === 'form')[0];
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
  return { renderer, saved, reported };
}

test('H8/legacy profile: Salva materializza una config school-specific coerente senza toccare la globale', async () => {
  const profile = { ...base, schools: [school('a', 'Scuola A', 7)] } as TeacherProfile;
  const global = config(6);
  const before = structuredClone(global);
  const result = await saveProfileModal(profile, global);
  assert.equal(result.saved.length, 1);
  assert.deepEqual(result.saved[0].schools?.[0].dayPeriods, profile.schools?.[0].dayPeriods);
  const schoolConfig = result.saved[0].schools?.[0].timeSlotConfig;
  assert.equal(schoolConfig?.periodsPerDay, 7);
  assert.equal(schoolConfig?.customSlots?.length, 7);
  assert.deepEqual(schoolConfig?.customSlots?.[6], { periodNumber: 7, label: '7ª Ora', startTime: '13:50', endTime: '14:50' });
  assert.deepEqual(global, before, 'la config globale legacy non viene mutata');
  assert.deepEqual(result.reported[0], [], 'il flusso Profilo normale non attiva il banner H7');
  result.renderer.unmount();
});

test('H8/custom legacy: Salva estende localmente la 7ª fascia e non modifica la globale', async () => {
  const profile = {
    ...base,
    schools: [school('a', 'Scuola A', 7, { timeSlotConfig: custom6 })],
  } as TeacherProfile;
  const global = config(6);
  const before = structuredClone(global);
  const result = await saveProfileModal(profile, global);
  const saved = result.saved[0].schools?.[0].timeSlotConfig;
  assert.equal(saved?.periodsPerDay, 7);
  assert.equal(saved?.customSlots?.length, 7);
  assert.deepEqual(saved?.customSlots?.[6], { periodNumber: 7, label: '7ª Ora', startTime: '14:00', endTime: '15:00' });
  assert.deepEqual(global, before, 'la globale resta intatta');
  assert.deepEqual(result.reported[0], []);
  result.renderer.unmount();
});

test('H7 follow-up/5-6-9: richiesta CTA apre il drawer esistente su B e riusa la proposta AUTO', async () => {
  const profile = {
    ...base,
    schools: [
      school('a', 'Scuola A', 6),
      school('b', 'Scuola B', 7),
    ],
  } as TeacherProfile;
  const saves: Array<{ schoolId: string; config: TimeSlotConfig }> = [];
  let handled = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, {
      profile,
      definitiveTimetable: [],
      provisionalTimetable: [],
      timetableMode: 'auto',
      activeType: 'definitivo',
      isDefinitiveCompiled: true,
      timeSlotConfig: config(6),
      onSaveSlot: () => {},
      onDeleteSlot: () => {},
      onSetTimetableMode: () => {},
      onCopyProvisionalToDefinitive: () => {},
      onCopyDefinitiveToProvisional: () => {},
      onClearTimetable: () => {},
      onSaveSchoolTimeSlotConfig: (schoolId: string, next: TimeSlotConfig) => { saves.push({ schoolId, config: next }); },
      timeSlotConfigOpenRequest: { schoolId: 'b', requestId: 1 },
      onTimeSlotConfigOpenRequestHandled: () => { handled += 1; },
    }));
  });

  assert.equal(handled, 1);
  assert.equal(textOf(renderer.root.findByProps({ id: 'slot-config-school' })), 'Scuola B');
  const statusText = renderer.root.findAll(n => n.props.role === 'status').map(textOf).join(' ');
  assert.match(statusText, /proposto 1 fascia in più.*7 ore previste/);
  assert.equal(saves.length, 0, 'aprire il drawer e proporre la fascia non salva nulla');
  const saveButton = renderer.root.findAll(n => n.type === 'button' && textOf(n) === 'Salva Fasce Orarie')[0];
  assert.ok(saveButton, 'resta necessaria la conferma esplicita esistente');
  renderer.unmount();
});
