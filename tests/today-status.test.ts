import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TodayView, selectDayAgenda } from '../src/components/TodayView';
import { ProfileModal } from '../src/components/ProfileModal';
import { addDaysISO, localDateISO } from '../src/utils/dates';
import type { TeacherProfile, TimetableSlot } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * "Oggi" screen semantics (visual only, no date logic changes):
 * - the real today shows a green "Oggi" badge and a clearly ACTIVE green "Oggi" button;
 * - any other date turns the "Oggi" button amber ("come back to the present") while the
 *   date badge becomes "Futuro" (amber) or "Passato" (neutral), never green like "Oggi".
 */

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

function classes(instance: any): string[] {
  return String(instance?.props?.className ?? '').split(' ').filter(Boolean);
}

function hasClass(instance: any, token: string): boolean {
  return classes(instance).includes(token);
}

function classString(instance: any): string {
  return String(instance?.props?.className ?? '');
}

function nodeText(node: any): string {
  const parts: string[] = [];
  const walk = (n: any) => {
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return; }
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.children)) n.children.forEach(walk);
    else if (typeof n.children === 'string' || typeof n.children === 'number') parts.push(String(n.children));
  };
  walk(node);
  return parts.join(' ');
}

function flatText(node: any): string {
  return nodeText(node).replace(/\s+/g, ' ').trim();
}

function byId(renderer: any, id: string) {
  const found = renderer.root.findAll((el: any) => el.props?.id === id);
  assert.ok(found.length > 0, `element with id "${id}" must exist`);
  return found[0];
}

/** The desktop and the mobile date badge are the spans with rounded corners and exact label. */
function dateBadges(renderer: any, label: string) {
  return renderer.root.findAll(
    (el: any) => el.type === 'span' && hasClass(el, 'rounded-md') && flatText(el) === label
  );
}

function todayProps(overrides: Partial<React.ComponentProps<typeof TodayView>> = {}) {
  return {
    profile,
    timetable: [] as TimetableSlot[],
    events: [],
    isProvisionalTimetable: false,
    isDefinitiveCompiled: true,
    onOpenNewEvent: () => {},
    onOpenCircularModal: () => {},
    onEditEvent: () => {},
    onDeleteEvent: () => {},
    onToggleComplete: () => {},
    ...overrides,
  };
}

async function renderToday(overrides: Partial<React.ComponentProps<typeof TodayView>> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TodayView, todayProps(overrides)));
  });
  return renderer;
}

async function click(renderer: any, id: string) {
  await act(async () => { byId(renderer, id).props.onClick(); });
}

// ---------------------------------------------------------------------------
// Pure selector: the real today / a future day / a past day
// ---------------------------------------------------------------------------

test('selectDayAgenda marks only the real civil today as isToday', () => {
  const todayIso = localDateISO();
  assert.equal(selectDayAgenda(todayIso, [], []).isToday, true, 'the real today is "today"');
  assert.equal(selectDayAgenda(addDaysISO(todayIso, 1), [], []).isToday, false, 'tomorrow is not "today"');
  assert.equal(selectDayAgenda(addDaysISO(todayIso, -1), [], []).isToday, false, 'yesterday is not "today"');
});

// ---------------------------------------------------------------------------
// Real today: green badge + clearly active green "Oggi" button (never gray)
// ---------------------------------------------------------------------------

test('on the real today the badge is green and the Oggi button reads as already active', async () => {
  const renderer = await renderToday();

  const button = byId(renderer, 'today-back-to-today');
  assert.equal(flatText(button), 'Oggi', 'the label is always "Oggi"');
  assert.equal(button.props.disabled, true, 'nothing to do when already on today');
  assert.equal(button.props['aria-pressed'], true, 'screen readers hear the active state');
  assert.ok(hasClass(button, 'bg-emerald-700'), 'active state is solid green');
  assert.ok(hasClass(button, 'text-white'));
  assert.ok(!classString(button).includes('amber'), 'active state is not amber');
  assert.ok(!hasClass(button, 'bg-stone-50') && !hasClass(button, 'text-stone-400'), 'not the old ambiguous gray');

  const badges = dateBadges(renderer, 'Oggi');
  assert.ok(badges.length >= 2, 'both the desktop and the mobile badge say "Oggi"');
  for (const badge of badges) {
    assert.ok(hasClass(badge, 'bg-emerald-100'), '"Oggi" stays green');
    assert.ok(!classString(badge).includes('amber'), '"Oggi" never uses the warning color');
  }
  assert.equal(dateBadges(renderer, 'Futuro').length, 0);
  assert.equal(dateBadges(renderer, 'Passato').length, 0);
});

// ---------------------------------------------------------------------------
// Future day: amber "Futuro" badge + amber clickable "Oggi" button
// ---------------------------------------------------------------------------

test('on a future day the badge is amber "Futuro" and the Oggi button becomes an amber call-to-action', async () => {
  const renderer = await renderToday();
  await click(renderer, 'today-next-day');

  const button = byId(renderer, 'today-back-to-today');
  assert.equal(flatText(button), 'Oggi', 'the label stays "Oggi"');
  assert.equal(button.props.disabled, false, 'the shortcut is clickable');
  assert.equal(button.props['aria-pressed'], false);
  assert.ok(hasClass(button, 'bg-amber-400'), 'amber = "attention / return to the present"');
  assert.ok(hasClass(button, 'text-amber-950'), 'text/background pair keeps contrast');
  assert.ok(classString(button).includes('hover:bg-amber-300'), 'the affordance reacts to hover');
  assert.ok(!classString(button).includes('emerald'), 'no green while away from today');

  const badges = dateBadges(renderer, 'Futuro');
  assert.ok(badges.length >= 2, 'both badges say "Futuro"');
  for (const badge of badges) {
    assert.ok(hasClass(badge, 'bg-amber-100'), '"Futuro" is amber');
    assert.ok(!classString(badge).includes('emerald'), '"Futuro" never shares the green semantics of "Oggi"');
  }
  assert.equal(dateBadges(renderer, 'Oggi').length, 0);
  assert.equal(dateBadges(renderer, 'Passato').length, 0);
});

// ---------------------------------------------------------------------------
// Past day: neutral "Passato" badge + amber clickable "Oggi" button
// ---------------------------------------------------------------------------

test('on a past day the badge is neutral "Passato" and the Oggi button stays amber', async () => {
  const renderer = await renderToday();
  await click(renderer, 'today-previous-day');

  const button = byId(renderer, 'today-back-to-today');
  assert.equal(flatText(button), 'Oggi');
  assert.equal(button.props.disabled, false);
  assert.ok(hasClass(button, 'bg-amber-400'), 'still an amber "back to today" affordance');
  assert.ok(!classString(button).includes('emerald'));

  const badges = dateBadges(renderer, 'Passato');
  assert.ok(badges.length >= 2, 'both badges say "Passato"');
  for (const badge of badges) {
    assert.ok(hasClass(badge, 'bg-stone-100') && hasClass(badge, 'text-stone-600'), '"Passato" is neutral');
    assert.ok(!classString(badge).includes('emerald'), '"Passato" is never green');
  }
  assert.equal(dateBadges(renderer, 'Oggi').length, 0);
  assert.equal(dateBadges(renderer, 'Futuro').length, 0);
});

// ---------------------------------------------------------------------------
// The amber button really brings the agenda back to the real today
// ---------------------------------------------------------------------------

test('clicking the amber Oggi button returns to the real today state', async () => {
  const renderer = await renderToday();
  await click(renderer, 'today-next-day');
  assert.equal(byId(renderer, 'today-back-to-today').props.disabled, false);

  await click(renderer, 'today-back-to-today');
  const button = byId(renderer, 'today-back-to-today');
  assert.equal(button.props.disabled, true, 'back on today the button is the active one again');
  assert.ok(hasClass(button, 'bg-emerald-700'));
  assert.ok(dateBadges(renderer, 'Oggi').length >= 2, 'the green "Oggi" badge is back');
});

// ---------------------------------------------------------------------------
// ProfileModal: the students section is gone from the UI, the data is not
// ---------------------------------------------------------------------------

test('ProfileModal shows no students editor and saving keeps assignedStudents untouched', async () => {
  const supportProfile: TeacherProfile = {
    ...profile,
    assignedStudents: ['Studente M.R. (Classe 2E, 9 ore - PEI differenziato)', 'Studente L.B. (Classe 1A, 6 ore)'],
  };
  let saved: TeacherProfile | null = null;
  let closed = 0;
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(ProfileModal, {
      isOpen: true,
      onClose: () => { closed += 1; },
      profile: supportProfile,
      onSaveProfile: async (updated: TeacherProfile) => { saved = updated; },
      onDataImported: () => {},
    }));
  });

  // The whole "Studenti Seguiti & Quote Orarie" UI is gone from the profile editor.
  const text = flatText(renderer.root);
  assert.ok(!text.includes('Studenti Seguiti'), 'no students section header');
  assert.ok(!text.includes('Quote Orarie'));
  assert.ok(!renderer.root.findAll((el: any) => el.props?.placeholder === 'es. Studente M.R. (Classe 2E, 9 ore - PEI differenziato)').length, 'no student input field');
  assert.ok(!text.includes('Studente M.R.'), 'existing student rows are not listed in the profile');
  // The school data is grouped under the "Istituto Principale" heading.
  assert.ok(text.includes('Istituto Principale'));

  // Submitting the profile carries the existing students over verbatim.
  const form = renderer.root.findByType('form');
  await act(async () => { form.props.onSubmit({ preventDefault: () => {} }); });
  assert.ok(saved, 'the save handler ran');
  assert.deepEqual(saved!.assignedStudents, supportProfile.assignedStudents, 'student assignments survive a profile save untouched');
  assert.equal(saved!.fullName, supportProfile.fullName);
  assert.equal(saved!.schoolName, supportProfile.schoolName);
  assert.equal(closed, 1, 'the modal closes after a successful save');
});
