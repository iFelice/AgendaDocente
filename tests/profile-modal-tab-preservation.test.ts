import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { create, act } from 'react-test-renderer';
import type { User as FirebaseUser } from 'firebase/auth';
import { ProfileModal } from '../src/components/ProfileModal';
import type { GoogleCalendarListEntry } from '../src/services/googleCalendarService';
import type { TeacherProfile, TimeSlotConfig } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * G1.2.2 — the "Account Istituzionale & Google" tab must survive profile
 * updates while the modal stays open.
 *
 * Bug: the open/refresh effect in ProfileModal depended on `profile` AND ran
 * setActiveTab(initialTab). Every calendar-checkbox save updated
 * profile.googleCalendarImportIds -> new `profile` prop -> the effect fired
 * -> the UI bounced back to "Profilo & Classi". Selecting 4 calendars meant
 * returning to the Google tab 4 times by hand.
 *
 * Fix: tab navigation now runs ONLY on the closed→open transition (wasOpenRef)
 * while a separate effect keeps re-deriving the drafts from profile/timeSlotConfig.
 */

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Lettere'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [],
};

const googleUser = {
  uid: 'uid-tab', email: 'docente@scuola.edu.it',
  displayName: 'Andrea Conti', photoURL: null,
} as unknown as FirebaseUser;

const calendarList: GoogleCalendarListEntry[] = [
  { id: 'primary-id', summary: 'Calendario principale', primary: true, accessRole: 'owner' },
  { id: 'cal-a@group.calendar.google.com', summary: 'Consigli di classe', accessRole: 'reader' },
  { id: 'cal-b@group.calendar.google.com', summary: 'Collegi docenti', accessRole: 'reader' },
  { id: 'cal-c@group.calendar.google.com', summary: 'Festività', accessRole: 'reader' },
];

type Tab = 'profilo' | 'backup' | 'google';

interface HarnessControls {
  setIsOpen: (open: boolean) => void;
  setInitialTab: (tab: Tab) => void;
  setProfile: (profile: TeacherProfile) => void;
  setTimeSlotConfig: (config: TimeSlotConfig | undefined) => void;
  setSelectedIds: (ids: string[]) => void;
}

/** Stateful harness mirroring how App.tsx owns profile/initialTab/selection. */
function Harness({ controls, onSelectionUpdate, initialOpen = true, startTab = 'google' }: {
  controls: HarnessControls;
  onSelectionUpdate?: (ids: string[]) => Promise<void>;
  initialOpen?: boolean;
  startTab?: Tab;
}) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [initialTab, setInitialTab] = useState<Tab>(startTab);
  const [profile, setProfile] = useState<TeacherProfile>(baseProfile);
  const [timeSlotConfig, setTimeSlotConfig] = useState<TimeSlotConfig | undefined>(undefined);
  const [selectedIds, setSelectedIds] = useState<string[]>(['primary']);
  controls.setIsOpen = setIsOpen;
  controls.setInitialTab = setInitialTab;
  controls.setProfile = setProfile;
  controls.setTimeSlotConfig = setTimeSlotConfig;
  controls.setSelectedIds = setSelectedIds;
  return React.createElement(ProfileModal, {
    isOpen,
    onClose: () => setIsOpen(false),
    profile,
    onSaveProfile: () => {},
    onDataImported: () => {},
    googleUser,
    googleAccessToken: 'token',
    events: [],
    googleCalendars: calendarList,
    selectedGoogleCalendarIds: selectedIds,
    onUpdateGoogleCalendarSelection: async (ids: string[]) => {
      // Mirrors App.tsx: the selection save rewrites the profile (new object
      // identity -> new `profile` prop) and immediately triggers the import.
      setSelectedIds(ids);
      setProfile(current => ({ ...current, googleCalendarImportIds: ids }));
      await onSelectionUpdate?.(ids);
    },
    timeSlotConfig,
    initialTab,
  });
}

async function mountHarness(opts: { initialOpen?: boolean; startTab?: Tab; onSelectionUpdate?: (ids: string[]) => Promise<void> } = {}) {
  const controls = {} as HarnessControls;
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(Harness, { controls, ...opts }));
  });
  return { renderer, controls };
}

function activeTabOf(renderer: any): string {
  const selected = renderer.root.findAll((node: any) =>
    node.type === 'button' && node.props.role === 'tab' && node.props['aria-selected'] === true);
  assert.equal(selected.length, 1, 'exactly one tab is selected');
  const text: string[] = [];
  const collect = (node: any) => {
    if (typeof node === 'string') { text.push(node); return; }
    (node.children ?? []).forEach(collect);
  };
  collect(selected[0]);
  return text.join(' ');
}

function calendarCheckbox(renderer: any, calendarId: string) {
  return renderer.root.find((node: any) =>
    node.type === 'input' && node.props.id === `gcal-select-${calendarId}`);
}

async function toggleCalendar(renderer: any, calendarId: string, checked = true) {
  await act(async () => {
    await calendarCheckbox(renderer, calendarId).props.onChange({ target: { checked } });
  });
}

// 1. Opening with initialTab="google" lands on the Google tab.
test('apertura con initialTab="google" mostra il tab Google', async () => {
  const { renderer } = await mountHarness({ startTab: 'google' });
  assert.match(activeTabOf(renderer), /Google/);
  renderer.unmount();
});

// 2. Opening with initialTab="profilo" lands on the Profilo tab.
test('apertura con initialTab="profilo" mostra Profilo & Classi', async () => {
  const { renderer } = await mountHarness({ startTab: 'profilo' });
  assert.match(activeTabOf(renderer), /Profilo & Classi/);
  renderer.unmount();
});

// 3. A profile prop change while the Google tab is active must NOT change tab.
test('aggiornamento di profile a modale aperta non cambia il tab attivo', async () => {
  const { renderer, controls } = await mountHarness({ startTab: 'profilo' });
  // User navigates to the Google tab by hand…
  const googleTab = renderer.root.findAll((node: any) =>
    node.type === 'button' && node.props.role === 'tab')[2];
  await act(async () => { googleTab.props.onClick(); });
  assert.match(activeTabOf(renderer), /Google/);
  // …then the profile is saved/synced in the background (new object identity).
  await act(async () => {
    controls.setProfile({ ...baseProfile, fullName: 'Prof.ssa Aggiornata' });
  });
  assert.match(activeTabOf(renderer), /Google/, 'profile change must not reset the tab');
  renderer.unmount();
});

// 4. A timeSlotConfig change while the Google tab is active must NOT change tab.
test('aggiornamento di timeSlotConfig a modale aperta non cambia il tab attivo', async () => {
  const { renderer, controls } = await mountHarness({ startTab: 'google' });
  await act(async () => {
    controls.setTimeSlotConfig({ mode: 'uniform', slotDurationMinutes: 55 } as unknown as TimeSlotConfig);
  });
  assert.match(activeTabOf(renderer), /Google/, 'timeSlotConfig change must not reset the tab');
  renderer.unmount();
});

// 5 + 6. Multi-calendar selection: every checkbox save keeps the Google tab.
test('selezione di più calendari in sequenza resta sul tab Google', async () => {
  const imported: string[][] = [];
  const { renderer } = await mountHarness({
    startTab: 'google',
    onSelectionUpdate: async (ids) => { imported.push(ids); },
  });
  assert.match(activeTabOf(renderer), /Google/);

  await toggleCalendar(renderer, 'cal-a@group.calendar.google.com');
  assert.match(activeTabOf(renderer), /Google/, 'first checkbox must keep the Google tab');

  await toggleCalendar(renderer, 'cal-b@group.calendar.google.com');
  assert.match(activeTabOf(renderer), /Google/, 'second checkbox must keep the Google tab');

  await toggleCalendar(renderer, 'cal-c@group.calendar.google.com');
  assert.match(activeTabOf(renderer), /Google/, 'third checkbox must keep the Google tab');

  // Each save still went through the import pipeline, once per checkbox.
  assert.equal(imported.length, 3);
  assert.deepEqual(imported[2].slice().sort(), [
    'cal-a@group.calendar.google.com',
    'cal-b@group.calendar.google.com',
    'cal-c@group.calendar.google.com',
    'primary',
  ]);
  // The checkboxes reflect the accumulated selection.
  assert.equal(calendarCheckbox(renderer, 'cal-a@group.calendar.google.com').props.checked, true);
  assert.equal(calendarCheckbox(renderer, 'cal-b@group.calendar.google.com').props.checked, true);
  assert.equal(calendarCheckbox(renderer, 'cal-c@group.calendar.google.com').props.checked, true);
  renderer.unmount();
});

// 7. Close and reopen: initialTab is applied again on the new opening.
test('chiusura e riapertura applicano di nuovo initialTab', async () => {
  const { renderer, controls } = await mountHarness({ startTab: 'google' });
  assert.match(activeTabOf(renderer), /Google/);

  // Close the modal (stays mounted, renders null).
  await act(async () => { controls.setIsOpen(false); });
  assert.equal(renderer.toJSON(), null, 'closed modal renders nothing');

  // App navigates to Profilo and reopens: the new initialTab must win.
  await act(async () => {
    controls.setInitialTab('profilo');
    controls.setIsOpen(true);
  });
  assert.match(activeTabOf(renderer), /Profilo & Classi/, 'reopening applies the new initialTab');

  // And reopening towards Google works too.
  await act(async () => { controls.setIsOpen(false); });
  await act(async () => {
    controls.setInitialTab('google');
    controls.setIsOpen(true);
  });
  assert.match(activeTabOf(renderer), /Google/);
  renderer.unmount();
});

// 8. No regression on the other tabs: manual navigation still works and
// survives background profile refreshes.
test('la navigazione manuale fra i tab resta funzionante e stabile', async () => {
  const { renderer, controls } = await mountHarness({ startTab: 'profilo' });
  const tabs = renderer.root.findAll((node: any) =>
    node.type === 'button' && node.props.role === 'tab');
  assert.equal(tabs.length, 3);

  await act(async () => { tabs[1].props.onClick(); });
  assert.match(activeTabOf(renderer), /Backup/);
  await act(async () => {
    controls.setProfile({ ...baseProfile, classes: ['1A', '2E', '3C'] });
  });
  assert.match(activeTabOf(renderer), /Backup/, 'Backup tab survives a profile refresh');

  await act(async () => { tabs[0].props.onClick(); });
  assert.match(activeTabOf(renderer), /Profilo & Classi/);
  renderer.unmount();
});
