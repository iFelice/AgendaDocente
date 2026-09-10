import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { create, act } from 'react-test-renderer';
import { MultiChipInput } from '../src/components/MultiChipInput';
import { normalizeSubjectName, sameSubject, foldSubject, mergeSubjectSuggestions, DEFAULT_SUBJECTS } from '../src/utils/subjects';
import type { TeacherProfile, TimetableSlot } from '../src/types';
import { TimetableEditor } from '../src/components/TimetableEditor';
import { TodayView } from '../src/components/TodayView';
import { WeekView } from '../src/components/WeekView';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SUBJECT_PLACEHOLDER = 'es. Matematica, Italiano…';

/** Minimal stateful harness so the picker behaves exactly like a controlled form field. */
function Harness({ onChange: externalOnChange, ...rest }: Omit<React.ComponentProps<typeof MultiChipInput>, 'values' | 'onChange'> & { onChange?: (v: string[]) => void }) {
  const [values, setValues] = useState<string[]>([]);
  return React.createElement(MultiChipInput, {
    ...rest,
    values,
    onChange: (v: string[]) => { setValues(v); externalOnChange?.(v); },
  });
}

async function mount(props: Partial<Omit<React.ComponentProps<typeof MultiChipInput>, 'values'>> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(Harness, {
      suggestions: [],
      placeholder: SUBJECT_PLACEHOLDER,
      ...props,
    }));
  });
  return renderer;
}

function findInput(renderer: any, placeholder: string) {
  const inputs = renderer.root.findAll((el: any) => el.type === 'input' && el.props.placeholder === placeholder);
  assert.ok(inputs.length > 0, `input "${placeholder}" must exist`);
  return inputs[0];
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

function rootText(renderer: any): string {
  return nodeText(renderer.root);
}

async function typeAndEnter(renderer: any, placeholder: string, value: string) {
  const input = findInput(renderer, placeholder);
  await act(async () => { input.props.onChange({ target: { value } }); });
  await act(async () => { findInput(renderer, placeholder).props.onKeyDown({ key: 'Enter', preventDefault: () => {} }); });
}

async function clickOption(renderer: any, placeholder: string, labelPart: string) {
  const input = findInput(renderer, placeholder);
  await act(async () => { input.props.onFocus(); });
  const listbox = renderer.root.findAll((el: any) => el.props.role === 'listbox');
  assert.ok(listbox.length > 0, 'a listbox opens on focus');
  const option = listbox[0].findAll((el: any) => el.type === 'button' && el.props.role === 'option')
    .find((o: any) => nodeText(o).includes(labelPart));
  assert.ok(option, `option containing "${labelPart}" must exist`);
  await act(async () => { option.props.onClick(); });
}

// ---------------------------------------------------------------------------
// 1. No datalist anywhere: the picker is a real search + listbox component.
// ---------------------------------------------------------------------------

test('subject picker renders no datalist and exposes combobox semantics', async () => {
  const renderer = await mount({ suggestions: [...DEFAULT_SUBJECTS], normalize: normalizeSubjectName });
  const input = findInput(renderer, SUBJECT_PLACEHOLDER);
  assert.equal(input.props.list, undefined, 'no list attribute');
  assert.equal(input.props.autoComplete, 'off');
  assert.equal(input.props.role, 'combobox');
  assert.equal(renderer.root.findAll((el: any) => el.type === 'datalist').length, 0, 'no <datalist> element');
  // Suggestions appear only as React-rendered clickable options.
  await act(async () => { input.props.onFocus(); });
  const listboxes = renderer.root.findAll((el: any) => el.props.role === 'listbox');
  assert.equal(listboxes.length, 1);
  const texts = listboxes[0].findAll((el: any) => el.type === 'button' && el.props.role === 'option')
    .map((o: any) => nodeText(o));
  assert.ok(texts.includes('Italiano'));
  assert.ok(texts.includes('Sostegno'), 'predefined list includes Sostegno');
});

// ---------------------------------------------------------------------------
// 2. Multiple selection (the mobile flow: type/choose, type/choose…)
// ---------------------------------------------------------------------------

test('mobile multi-select: subjects accumulate as removable chips', async () => {
  const renderer = await mount({ suggestions: [...DEFAULT_SUBJECTS], normalize: normalizeSubjectName });
  await typeAndEnter(renderer, SUBJECT_PLACEHOLDER, 'Matematica');
  assert.match(rootText(renderer), /Matematica/);
  assert.ok(renderer.root.findAll((el: any) => el.props['aria-label'] === 'Rimuovi Matematica').length === 1);

  // Second value chosen from the clickable suggestion list, like a tap on mobile.
  await typeAndEnter(renderer, SUBJECT_PLACEHOLDER, 'Scienze');
  assert.ok(renderer.root.findAll((el: any) => el.props['aria-label'] === 'Rimuovi Scienze').length === 1);
});

test('tap on a suggestion (listbox option) adds the value', async () => {
  const renderer = await mount({ suggestions: [...DEFAULT_SUBJECTS], normalize: normalizeSubjectName });
  const input = findInput(renderer, SUBJECT_PLACEHOLDER);
  await act(async () => { input.props.onChange({ target: { value: 'sci' } }); });
  await clickOption(renderer, SUBJECT_PLACEHOLDER, 'Scienze');
  assert.ok(renderer.root.findAll((el: any) => el.props['aria-label'] === 'Rimuovi Scienze').length === 1);
  // Typing the same subject again must not add a duplicate chip.
  await typeAndEnter(renderer, SUBJECT_PLACEHOLDER, 'scienze');
  assert.equal(renderer.root.findAll((el: any) => el.props['aria-label'] === 'Rimuovi Scienze').length, 1);
});

// ---------------------------------------------------------------------------
// 3. Chip removal
// ---------------------------------------------------------------------------

test('removing a chip keeps the other values and works also with only one value', async () => {
  const renderer = await mount({ suggestions: [...DEFAULT_SUBJECTS], normalize: normalizeSubjectName });
  await typeAndEnter(renderer, SUBJECT_PLACEHOLDER, 'Italiano');
  await typeAndEnter(renderer, SUBJECT_PLACEHOLDER, 'Storia');
  const removeItaliano = renderer.root.findAll((el: any) => el.props['aria-label'] === 'Rimuovi Italiano');
  assert.equal(removeItaliano.length, 1);
  await act(async () => { removeItaliano[0].props.onClick(); });
  assert.equal(renderer.root.findAll((el: any) => el.props['aria-label'] === 'Rimuovi Italiano').length, 0);
  assert.equal(renderer.root.findAll((el: any) => el.props['aria-label'] === 'Rimuovi Storia').length, 1);
});

// ---------------------------------------------------------------------------
// 4. Custom subject not in the predefined list
// ---------------------------------------------------------------------------

test('custom subject can be added freely and is normalized coherently', async () => {
  const renderer = await mount({ suggestions: [...DEFAULT_SUBJECTS], normalize: normalizeSubjectName });
  await typeAndEnter(renderer, SUBJECT_PLACEHOLDER, '   laboratorio teatrale ');
  const customChip = renderer.root.findAll((el: any) => el.props['aria-label'] && String(el.props['aria-label']).startsWith('Rimuovi '));
  assert.equal(customChip.length, 1);
  const labels = customChip.map((c: any) => String(c.props['aria-label']).replace(/^Rimuovi /, ''));
  assert.deepEqual(labels, ['Laboratorio teatrale'], 'whitespace collapsed, first letter capitalized, stored value unique');
  // No accidental duplicate suggestion row for the typed custom text.
  assert.ok(!rootText(renderer).includes('Aggiungi “laboratorio'), 'no custom row for a committed value');
});

// ---------------------------------------------------------------------------
// 5. Normalization utilities: canonical spellings + de-duplication
// ---------------------------------------------------------------------------

test('normalizeSubjectName maps free text to the canonical predefined spelling', () => {
  assert.equal(normalizeSubjectName(' matematica '), 'Matematica');
  assert.equal(normalizeSubjectName('EDUCAZIONE FISICA'), 'Educazione fisica');
  assert.equal(normalizeSubjectName('storia'), 'Storia');
  assert.equal(normalizeSubjectName('  Storia dell\'arte  '), 'Storia dell\'arte');
  assert.equal(normalizeSubjectName(''), '');
  assert.equal(sameSubject('Matematica', 'matematica'), true);
  assert.equal(sameSubject('Perché', 'perche'), true, 'accent-insensitive');
  assert.equal(foldSubject('  Scienze '), foldSubject('scienze'));
});

test('mergeSubjectSuggestions de-duplicates while preserving source order', () => {
  assert.deepEqual(
    mergeSubjectSuggestions(DEFAULT_SUBJECTS, ['Matematica', 'Coding', 'Sostegno']),
    [...DEFAULT_SUBJECTS, 'Coding']
  );
  assert.deepEqual(mergeSubjectSuggestions(['A', 'B'], undefined, ['B', 'C']), ['A', 'B', 'C']);
});

// ---------------------------------------------------------------------------
// 6. Structural guards against accidental horizontal overflow on the main
//    mobile surfaces (layout is verified on real devices; these tests pin the
//    responsive containers so regressions are caught in CI).
// ---------------------------------------------------------------------------

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

function baseSlot(dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 = 1): TimetableSlot {
  return { id: 's1', dayOfWeek, periodNumber: 1, startTime: '07:50', endTime: '08:50', subject: 'Sostegno', className: '2E', coTeachingSubjects: ['Matematica'], coSupportTeachers: ['Prof.ssa Rossi'] };
}

/** TodayView shows lessons for the weekday of the *selected* date (today). */
function todayDayOfWeek(): 1 | 2 | 3 | 4 | 5 | 6 {
  const js = new Date().getDay();
  return (js >= 1 && js <= 6 ? js : 1) as 1 | 2 | 3 | 4 | 5 | 6;
}

function hasClass(node: any, token: string): boolean {
  return typeof node?.props?.className === 'string' && String(node.props.className).split(' ').includes(token);
}

async function renderComponent(element: React.ReactElement) {
  let renderer: any;
  await act(async () => {
    renderer = create(element);
  });
  return renderer;
}

test('mobile Orario (TimetableEditor) container clips horizontal overflow and day filter keeps per-day matrix', async () => {
  const props = {
    profile,
    definitiveTimetable: [] as TimetableSlot[],
    provisionalTimetable: [baseSlot()] as TimetableSlot[],
    timetableMode: 'auto' as const,
    activeType: 'provvisorio' as const,
    isDefinitiveCompiled: false,
    timeSlotConfig: { firstHourStartTime: '07:50', periodsPerDay: 3, standardDurationMinutes: 60,
      customSlots: [
        { periodNumber: 1, startTime: '07:50', endTime: '08:50' },
        { periodNumber: 2, startTime: '08:50', endTime: '09:50' },
        { periodNumber: 3, startTime: '09:50', endTime: '10:50' },
      ] },
    onSaveSlot: () => {},
    onDeleteSlot: () => {},
    onSetTimetableMode: () => {},
    onCopyProvisionalToDefinitive: () => {},
    onCopyDefinitiveToProvisional: () => {},
    onClearTimetable: () => {},
    onSaveProfile: () => {},
    onSaveTimeSlotConfig: () => {},
  };
  const renderer = await renderComponent(React.createElement(TimetableEditor, props));
  const rootDiv = renderer.root.find((el: any) => el.type === 'div' && hasClass(el, 'overflow-x-hidden'));
  assert.ok(rootDiv, 'the timetable screen clips any accidental horizontal overflow');
  // The subject/teacher chips live behind the combobox, never in a datalist.
  assert.equal(renderer.root.findAll((el: any) => el.type === 'datalist').length, 0);
});

test('mobile Oggi (TodayView) cards use min-w-0 + truncation for lesson metadata', async () => {
  const renderer = await renderComponent(React.createElement(TodayView, {
    profile,
    timetable: [baseSlot(todayDayOfWeek())],
    events: [],
    isProvisionalTimetable: true,
    isDefinitiveCompiled: false,
    onOpenNewEvent: () => {},
    onOpenCircularModal: () => {},
    onEditEvent: () => {},
    onDeleteEvent: () => {},
    onToggleComplete: () => {},
  }));
  const rendered = rootText(renderer);
  assert.ok(rendered.includes('Compresenza: Matematica'));
  assert.ok(rendered.includes('Con: Prof.ssa Rossi'));
  // Every flexible text column must be able to shrink (min-w-0) and long metadata must
  // truncate, so nothing forces the page wider than the viewport.
  assert.ok(renderer.root.findAll((el: any) => el.type === 'div' && hasClass(el, 'min-w-0')).length > 0);
  assert.ok(renderer.root.findAll((el: any) => String(el.props?.className ?? '').includes('truncate')).length >= 1);
});

test('mobile Settimana (WeekView) renders day snap-cards with per-card shrinking text', async () => {
  const renderer = await renderComponent(React.createElement(WeekView, {
    profile,
    timetable: [baseSlot()],
    events: [],
    onOpenNewEvent: () => {},
    onEditEvent: () => {},
  }));
  const text = rootText(renderer);
  assert.ok(text.includes('Compresenza: Matematica'));
  const minW0 = renderer.root.findAll((el: any) => el.type === 'div' && hasClass(el, 'min-w-0'));
  assert.ok(minW0.length > 0, 'lesson rows contain shrinkable text columns');
});
