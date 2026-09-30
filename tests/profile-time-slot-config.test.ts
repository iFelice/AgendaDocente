import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ProfileModal, type ProfileTimeSlotRealignment } from '../src/components/ProfileModal';
import { partitionReconstructedSlots } from '../src/utils/reconstructTimetable';
import { getEffectivePeriodSlots, generateDefaultPeriodSlots } from '../src/utils/timeSlots';
import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';
import type { ReconstructedSlot } from '../src/utils/timetableCrossref';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PRIMARY = 'istituto principale';
const auto = (count: number): TimeSlotConfig => ({
  firstHourStartTime: '07:50',
  periodsPerDay: count,
  standardDurationMinutes: 60,
  customSlots: generateDefaultPeriodSlots('07:50', count, 60),
});
const custom6: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60,
  customSlots: [
    { periodNumber: 1, label: '1ª Ora', startTime: '08:00', endTime: '08:55' },
    { periodNumber: 2, label: '2ª Ora', startTime: '08:55', endTime: '09:50' },
    { periodNumber: 3, label: '3ª Ora', startTime: '10:10', endTime: '11:05' },
    { periodNumber: 4, label: '4ª Ora', startTime: '11:05', endTime: '12:00' },
    { periodNumber: 5, label: '5ª Ora', startTime: '12:10', endTime: '13:05' },
    { periodNumber: 6, label: '6ª Ora', startTime: '13:05', endTime: '14:00' },
  ],
};
const base: TeacherProfile = {
  id: 'p-h8', fullName: 'Prof. H8', schoolName: 'IC H8', schoolLevel: 'ssig', schoolYear: '2026/2027',
  primarySubjects: ['Matematica'], classes: ['1C'], campuses: [], roles: [], isSupportTeacher: false,
  schools: [{ id: 'primary', name: 'IC H8', isPrimary: true, active: true, dayPeriods: { ordinaryPeriodsPerDay: 6 } }],
};

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : textOf(child)).join(' ').replace(/\s+/g, ' ').trim();
const byLabel = (root: ReactTestInstance, label: string): ReactTestInstance => {
  const match = root.findAll(node => node.props['aria-label'] === label)[0];
  assert.ok(match, `controllo non trovato: ${label}`);
  return match;
};
const primaryOf = (profile: TeacherProfile) => profile.schools?.find(school => school.isPrimary)!;

interface Mounted {
  renderer: ReactTestRenderer;
  saves: Array<{ profile: TeacherProfile; realignment?: ProfileTimeSlotRealignment }>;
}

async function mount(
  profile: TeacherProfile = base,
  global: TimeSlotConfig = auto(6),
  provisionalTimetable: TimetableSlot[] = [],
  definitiveTimetable: TimetableSlot[] = [],
): Promise<Mounted> {
  const saves: Array<{ profile: TeacherProfile; realignment?: ProfileTimeSlotRealignment }> = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(ProfileModal, {
      isOpen: true,
      onClose: () => {},
      profile,
      timeSlotConfig: global,
      provisionalTimetable,
      definitiveTimetable,
      onSaveProfile: (next: TeacherProfile, _expected?: TeacherProfile, realignment?: ProfileTimeSlotRealignment) => {
        saves.push({ profile: next, realignment });
      },
      onDataImported: () => {},
      events: [],
      initialTab: 'profilo',
    }));
  });
  return { renderer, saves };
}

async function setThursdayExtra(m: Mounted, checked = true) {
  const checkbox = byLabel(m.renderer.root, `Ci sono giorni con ore aggiuntive (${PRIMARY})`);
  await act(async () => { checkbox.props.onChange({ target: { checked } }); });
  if (checked) {
    await act(async () => {
      byLabel(m.renderer.root, `giovedì piu 1 ore (${PRIMARY})`).props.onClick();
    });
  }
}
async function save(m: Mounted) {
  const form = m.renderer.root.findAll(node => node.type === 'form')[0];
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
}
function previewText(m: Mounted) {
  return m.renderer.root.findAll(node => typeof node.props.className === 'string' && node.props.className.includes('bg-emerald-50/50')).map(textOf).join(' ');
}

// 1–6: the complete normal Profile flow, including scanner import boundaries.
test('H8/Profile auto: Gio +1 propone 7ª nel draft, non salva prima e salva struttura + campane coerenti', async () => {
  const global = auto(6);
  const globalBefore = structuredClone(global);
  const m = await mount(base, global);
  try {
    await setThursdayExtra(m);
    assert.equal(byLabel(m.renderer.root, `N° fasce orarie (${PRIMARY})`).props.value, 7);
    assert.match(previewText(m), /1\s*ª:\s*07:50\s*–\s*08:50/);
    assert.match(previewText(m), /7\s*ª:\s*13:50\s*–\s*14:50/);
    assert.match(textOf(m.renderer.root), /struttura della settimana arriva alla 7/);
    assert.equal(m.saves.length, 0, 'il draft non ha persistenza propria');

    await save(m);
    assert.equal(m.saves.length, 1);
    const savedSchool = primaryOf(m.saves[0].profile);
    assert.deepEqual(savedSchool.dayPeriods, { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } });
    assert.equal(savedSchool.timeSlotConfig?.periodsPerDay, 7);
    assert.deepEqual(getEffectivePeriodSlots(savedSchool.timeSlotConfig)[6], {
      periodNumber: 7, label: '7ª Ora', startTime: '13:50', endTime: '14:50',
    });
    assert.deepEqual(global, globalBefore, 'la config globale legacy non cambia');

    const source: ReconstructedSlot = {
      id: 'gio-7', dayOfWeek: 4, periodIndex: 7, classLabel: '1C', coTeachingSubjects: [], status: 'unique', confidence: 'high', selected: true,
    };
    const imported = partitionReconstructedSlots([source], { profile: m.saves[0].profile, timeSlotConfig: global });
    assert.equal(imported.rejected.length, 0, 'Giovedì 7ª diventa importabile subito');
    assert.equal(imported.slots[0].startTime, '13:50');

    const monday = partitionReconstructedSlots([{ ...source, id: 'lun-7', dayOfWeek: 1 }], { profile: m.saves[0].profile, timeSlotConfig: global });
    assert.equal(monday.rejected[0].reason, 'day-not-allowed', 'lunedì resta limitato a 6');
  } finally { m.renderer.unmount(); }
});

// 7–9 and UX regression: shrinking day structure never deletes a configured bell.
test('H8/Profile: togliere Gio +1 conserva la 7ª, che viene riusata al successivo +1', async () => {
  const profile: TeacherProfile = {
    ...base,
    schools: [{ ...primaryOf(base), dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } }, timeSlotConfig: auto(7) }],
  };
  const m = await mount(profile);
  try {
    await setThursdayExtra(m, false);
    assert.equal(byLabel(m.renderer.root, `N° fasce orarie (${PRIMARY})`).props.value, 7);
    assert.match(previewText(m), /7\s*ª:\s*13:50\s*–\s*14:50/);
    await setThursdayExtra(m, true);
    assert.equal(byLabel(m.renderer.root, `N° fasce orarie (${PRIMARY})`).props.value, 7, 'la 7ª ricompare senza configurazione aggiuntiva');
    assert.equal(m.saves.length, 0);
  } finally { m.renderer.unmount(); }
});

// 10–11: a custom legacy scan is extended locally and explicitly marked.
test('H8/Profile custom: 6→required7 aggiunge una bozza Da verificare senza persistere', async () => {
  const profile: TeacherProfile = { ...base, schools: [{ ...primaryOf(base), timeSlotConfig: custom6 }] };
  const m = await mount(profile);
  try {
    await setThursdayExtra(m);
    assert.equal(m.saves.length, 0);
    const advanced = m.renderer.root.findAll(node => node.type === 'button' && /Personalizzazione avanzata/.test(textOf(node)))[0];
    await act(async () => { advanced.props.onClick(); });
    assert.match(textOf(m.renderer.root), /7\s*ª Ora Da verificare/);
    const timeInputs = m.renderer.root.findAll(node => node.type === 'input' && node.props.type === 'time');
    const last = timeInputs.slice(-2);
    assert.deepEqual(last.map(input => input.props.value), ['14:00', '15:00']);
  } finally { m.renderer.unmount(); }
});

// 12–13: school scope is strict; the secondary is never overwritten by primary save.
test('H8/Profile multi-school: il salvataggio della primaria non modifica dayPeriods né campane della secondaria', async () => {
  const secondaryConfig = auto(8);
  const profile: TeacherProfile = {
    ...base,
    schools: [
      { ...primaryOf(base) },
      { id: 'secondary', name: 'Liceo H8', isPrimary: false, active: true, dayPeriods: { ordinaryPeriodsPerDay: 8 }, timeSlotConfig: secondaryConfig },
    ],
  };
  const m = await mount(profile);
  try {
    await setThursdayExtra(m);
    await save(m);
    const savedSecondary = m.saves[0].profile.schools?.find(school => school.id === 'secondary');
    assert.deepEqual(savedSecondary?.dayPeriods, { ordinaryPeriodsPerDay: 8 });
    assert.deepEqual(savedSecondary?.timeSlotConfig, secondaryConfig);
  } finally { m.renderer.unmount(); }
});

// 14–15: same confirmation contract as the Timetable drawer.
test('H8/Profile realignment: aggiungere la 7ª non chiede conferma, cambiare le fasce esistenti sì', async () => {
  const current: TimetableSlot = {
    id: 'lesson-1', dayOfWeek: 1, periodNumber: 1, className: '1C', subject: 'Matematica', classroom: '', startTime: '07:50', endTime: '08:50', schoolId: 'primary', isProvisional: false,
  };
  const addOnly = await mount(base, auto(6), [], [current]);
  try {
    await setThursdayExtra(addOnly);
    await save(addOnly);
    assert.equal(addOnly.saves.length, 1);
    assert.equal(addOnly.saves[0].realignment, undefined, '1ª–6ª invariate non vengono riallineate');
  } finally { addOnly.renderer.unmount(); }

  const changed = await mount(base, auto(6), [], [current]);
  try {
    const firstHour = byLabel(changed.renderer.root, `Inizio 1ª ora (${PRIMARY})`);
    await act(async () => { firstHour.props.onChange({ target: { value: '08:10' } }); });
    await save(changed);
    assert.equal(changed.saves.length, 0, 'nessuna scrittura prima della scelta');
    const prompt = changed.renderer.root.findByProps({ id: 'profile-realign-dialog' });
    assert.match(textOf(prompt), /1 lezione ha orari diversi/);
    await act(async () => { changed.renderer.root.findByProps({ id: 'profile-realign-confirm' }).props.onClick(); });
    assert.equal(changed.saves.length, 1);
    assert.equal(changed.saves[0].realignment?.definitive[0].startTime, '08:10');
  } finally { changed.renderer.unmount(); }
});

test('H8/architettura: Profilo e drawer Orario montano lo stesso TimeSlotConfigEditor', async () => {
  const fs = await import('node:fs/promises');
  const [profileSource, timetableSource] = await Promise.all([
    fs.readFile(new URL('../src/components/ProfileModal.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/TimetableEditor.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(profileSource, /<TimeSlotConfigEditor/);
  assert.match(timetableSource, /<TimeSlotConfigEditor/);
  assert.match(timetableSource, /from "\.\/TimeSlotConfigEditor"/);
});
