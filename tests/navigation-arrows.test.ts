import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TodayView } from '../src/components/TodayView';
import { WeekView } from '../src/components/WeekView';
import type { TeacherProfile, TimetableSlot } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Discreet prev/next arrows (Oggi + Settimana): the *visible* element shrinks to a light
 * 30px box with an 18px icon and no heavy shadow, while the real clickable target keeps
 * the >= 44x44 touch size and the accessibility labels.
 */

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

const slot = (dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 = 1): TimetableSlot => ({
  id: 's1', dayOfWeek, periodNumber: 1, startTime: '07:50', endTime: '08:50',
  subject: 'Sostegno', className: '2E',
});

function classNamesOf(node: any): string {
  return typeof node?.props?.className === 'string' ? node.props.className : '';
}

function assertDiscreetArrow(renderer: any, ariaLabel: string) {
  const button = renderer.root.findAllByType('button').find((b: any) => b.props['aria-label'] === ariaLabel);
  assert.ok(button, `button with aria-label "${ariaLabel}" exists`);
  // Accessibility + true touch target unchanged…
  assert.match(classNamesOf(button), /min-w-\[44px\]/, 'touch target width stays >= 44px');
  assert.match(classNamesOf(button), /min-h-\[44px\]/, 'touch target height stays >= 44px');
  // …while the visible inner box is small, light and shadow-free.
  const span = button.findByType('span');
  assert.match(classNamesOf(span), /w-\[30px\] h-\[30px\]/, 'visible area is ~30px');
  assert.match(classNamesOf(span), /border-stone-200\/\d+/, 'light hairline border');
  assert.doesNotMatch(classNamesOf(span) + ' ' + classNamesOf(button), /shadow-(sm|md|lg|xl|2xl)/, 'no heavy shadow');
  const icons = button.findAll((n: any) => n.type === 'svg' && String(n.props?.className ?? '').includes('w-[18px]'));
  assert.equal(icons.length, 1, 'exactly one 18px chevron icon');
  return button;
}

test('Oggi (TodayView): prev/next day arrows are visually discreet with 44px touch targets', async () => {
  const jsDay = new Date().getDay();
  const day = (jsDay >= 1 && jsDay <= 6 ? jsDay : 1) as 1 | 2 | 3 | 4 | 5 | 6;
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TodayView, {
      profile,
      timetable: [slot(day)],
      events: [],
      isProvisionalTimetable: true,
      isDefinitiveCompiled: false,
      onOpenNewEvent: () => {},
      onOpenCircularModal: () => {},
      onEditEvent: () => {},
      onDeleteEvent: () => {},
      onToggleComplete: () => {},
    }));
  });
  for (const label of ['Giorno precedente', 'Giorno successivo']) {
    const button = assertDiscreetArrow(renderer, label);
    // Behavior unchanged: clicking navigates without errors.
    await act(async () => { button.props.onClick(); });
  }
  await act(async () => { renderer.unmount(); });
});

test('Settimana (WeekView): prev/next week arrows are visually discreet with 44px touch targets', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(WeekView, {
      profile,
      timetable: [slot()],
      events: [],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
    }));
  });
  for (const label of ['Settimana precedente', 'Settimana successiva']) {
    const button = assertDiscreetArrow(renderer, label);
    await act(async () => { button.props.onClick(); });
  }
  await act(async () => { renderer.unmount(); });
});
