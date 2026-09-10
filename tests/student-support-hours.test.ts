import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { ClassesView } from '../src/components/ClassesView';
import { parseSupportHoursDraft } from '../src/utils/supportHours';
import type { Student, TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Per-student support-hours input ("Ore settimanali sostegno"):
 *
 *   9 -> Backspace -> "" -> 10   must just work (the old UI snapped back to 9 because the
 *   controlled value was `supportHoursPerWeek || 9` and `Number("") === 0`, so the empty
 *   draft was immediately re-rendered as the previous/default value).
 *
 * The field is now backed by a raw string draft while editing; normalization to
 * `number | undefined` happens on blur/save and invalid values are never stored.
 */

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

const baseStudent = (overrides: Partial<Student> = {}): Student => ({
  id: 'stu-1',
  fullName: 'Mario Rossi',
  className: '1A',
  isSupportStudent: true,
  peiType: 'ordinario',
  supportHoursPerWeek: 9,
  hasBesDsa: false,
  notes: [],
  ...overrides,
});

interface Props { students: Student[]; onSaveStudent: (s: Student) => Promise<void> }

async function mount(props: Props) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(ClassesView, {
      profile,
      students: props.students,
      onSaveStudent: props.onSaveStudent,
      onDeleteStudent: () => {},
      onAddNote: () => {},
      onDeleteNote: () => {},
      onScheduleEvent: () => {},
    }));
  });
  return renderer;
}

async function openEditModal(renderer: any) {
  const editButton = renderer.root.findAllByType('button')
    .find((b: any) => b.props.title === 'Modifica dati alunno');
  assert.ok(editButton, 'the student row exposes an edit button');
  await act(async () => { editButton.props.onClick({ stopPropagation() {} }); });
}

function findHoursInput(renderer: any) {
  const inputs = renderer.root.findAll((el: any) => el.type === 'input' && el.props.type === 'number');
  assert.equal(inputs.length, 1, 'exactly one numeric input: the support-hours field');
  return inputs[0];
}

async function submitForm(renderer: any) {
  // Like a user tap: focus leaves the field (blur) before the form is submitted.
  const input = findHoursInput(renderer);
  await act(async () => { input.props.onBlur?.(); });
  const form = renderer.root.findByType('form');
  await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

test('parseSupportHoursDraft: empty/valid/invalid classification', () => {
  assert.deepEqual(parseSupportHoursDraft(''), { kind: 'empty' });
  assert.deepEqual(parseSupportHoursDraft('   '), { kind: 'empty' });
  assert.deepEqual(parseSupportHoursDraft('10'), { kind: 'valid', hours: 10 });
  assert.deepEqual(parseSupportHoursDraft('0'), { kind: 'valid', hours: 0 });
  assert.deepEqual(parseSupportHoursDraft('9,5'), { kind: 'valid', hours: 9.5 });
  assert.equal(parseSupportHoursDraft('-3').kind, 'invalid', 'negative is not a valid amount');
  assert.equal(parseSupportHoursDraft('abc').kind, 'invalid');
  assert.equal(parseSupportHoursDraft('1e').kind, 'invalid');
  assert.equal(parseSupportHoursDraft('-').kind, 'invalid');
});

test('9 -> Backspace -> "" -> 10: typing works normally and 10 is saved', async () => {
  const saved: Student[] = [];
  const onSaveStudent = async (s: Student) => { saved.push(s); };
  const renderer = await mount({ students: [baseStudent()], onSaveStudent });

  await openEditModal(renderer);
  let input = findHoursInput(renderer);
  assert.equal(input.props.value, '9', 'opens with the stored value');

  // Backspace: the field becomes (and stays) empty — no snap-back to 9.
  await act(async () => { input.props.onChange({ target: { value: '' } }); });
  input = findHoursInput(renderer);
  assert.equal(input.props.value, '', 'empty draft is NOT reverted to the old/default value');

  // Type the new value normally.
  await act(async () => { input.props.onChange({ target: { value: '1' } }); });
  await act(async () => { input.props.onChange({ target: { value: '10' } }); });
  input = findHoursInput(renderer);
  assert.equal(input.props.value, '10');

  await submitForm(renderer);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].supportHoursPerWeek, 10, 'the typed value 10 reaches the model');
});

test('editing 9 -> 12 by typing normally saves 12', async () => {
  const saved: Student[] = [];
  const onSaveStudent = async (s: Student) => { saved.push(s); };
  const renderer = await mount({ students: [baseStudent()], onSaveStudent });

  await openEditModal(renderer);
  const input = findHoursInput(renderer);
  await act(async () => { input.props.onChange({ target: { value: '12' } }); });
  assert.equal(findHoursInput(renderer).props.value, '12');

  await submitForm(renderer);
  assert.equal(saved[0].supportHoursPerWeek, 12);
});

test('empty value saves undefined (never re-inserts the old value) and reopens empty', async () => {
  const saved: Student[] = [];
  const onSaveStudent = async (s: Student) => { saved.push(s); };
  const renderer = await mount({ students: [baseStudent()], onSaveStudent });

  await openEditModal(renderer);
  const input = findHoursInput(renderer);
  await act(async () => { input.props.onChange({ target: { value: '' } }); });
  await act(async () => { input.props.onBlur?.(); });
  assert.equal(findHoursInput(renderer).props.value, '', 'blur keeps the field empty');

  await submitForm(renderer);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].supportHoursPerWeek, undefined, 'empty commits undefined, not 9 or 0');

  // Reopening shows the saved (empty) state, without inventing a default.
  const reopened = await mount({ students: [saved[0]], onSaveStudent });
  await openEditModal(reopened);
  assert.equal(findHoursInput(reopened).props.value, '');
});

test('0 is a valid value and survives save + reopen', async () => {
  const saved: Student[] = [];
  const onSaveStudent = async (s: Student) => { saved.push(s); };
  const renderer = await mount({ students: [baseStudent()], onSaveStudent });

  await openEditModal(renderer);
  const input = findHoursInput(renderer);
  await act(async () => { input.props.onChange({ target: { value: '0' } }); });
  await act(async () => { input.props.onBlur?.(); });

  await submitForm(renderer);
  assert.equal(saved[0].supportHoursPerWeek, 0, '0 is stored as 0');

  const reopened = await mount({ students: [saved[0]], onSaveStudent });
  await openEditModal(reopened);
  assert.equal(findHoursInput(reopened).props.value, '0');
});

test('negative value is invalid: field reverts on blur and the stored value is never replaced', async () => {
  const saved: Student[] = [];
  const onSaveStudent = async (s: Student) => { saved.push(s); };
  const renderer = await mount({ students: [baseStudent()], onSaveStudent });

  await openEditModal(renderer);
  const input = findHoursInput(renderer);
  await act(async () => { input.props.onChange({ target: { value: '-3' } }); });
  await act(async () => { input.props.onBlur?.(); });
  assert.equal(findHoursInput(renderer).props.value, '9', 'invalid draft reverts to the committed value');

  await submitForm(renderer);
  assert.equal(saved[0].supportHoursPerWeek, 9, 'a negative amount is never saved');
});

test('submit without an explicit blur still flushes the draft', async () => {
  const saved: Student[] = [];
  const onSaveStudent = async (s: Student) => { saved.push(s); };
  const renderer = await mount({ students: [baseStudent()], onSaveStudent });

  await openEditModal(renderer);
  const input = findHoursInput(renderer);
  await act(async () => { input.props.onChange({ target: { value: '15' } }); });
  // No blur: submit directly (keyboard submit path).
  const form = renderer.root.findByType('form');
  await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].supportHoursPerWeek, 15);
});
