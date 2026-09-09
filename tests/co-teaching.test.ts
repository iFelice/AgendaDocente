import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { database } from '../src/services/db';
import { initializeStorage, storage, emptyInstallation } from '../src/services/storage';
import { validateBackup } from '../src/services/backup';
import { sanitizeFirestorePayload } from '../src/services/sync/firestoreGateway';
import { classifyRemoteStateDoc, isValidTimetablePayload } from '../src/services/sync/remoteSchema';
import { coTeachingSummary, collectKnownTeacherNames, pruneCoTeachingFields, hasCoTeaching } from '../src/utils/coTeaching';
import { TimetableEditor } from '../src/components/TimetableEditor';
import { TodayView } from '../src/components/TodayView';
import { WeekView } from '../src/components/WeekView';
import type { TeacherProfile, TimetableSlot } from '../src/types';

/**
 * Co-teaching ("compresenza") tests: model, editor UX, compact display in Oggi/Settimana/Orario,
 * backup/restore, Firestore round-trip and retro-compatibility with old TimetableSlot documents.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let memory: Map<string, string>;
beforeEach(async () => {
  memory = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return memory.size; },
      key: (i: number) => [...memory.keys()][i] ?? null,
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => { memory.set(k, String(v)); },
      removeItem: (k: string) => { memory.delete(k); },
    },
  });
  database.close();
  await database.delete();
  await initializeStorage();
});

function profileWith(patch: Partial<TeacherProfile> = {}): TeacherProfile {
  return {
    ...(emptyInstallation().profile as TeacherProfile),
    fullName: 'Prof. Andrea Conti',
    schoolName: 'IC Leonardo Da Vinci',
    schoolYear: '2026/2027',
    schoolLevel: 'ssig',
    classes: ['1A', '2E'],
    primarySubjects: ['Sostegno'],
    campuses: ['Sede Centrale'],
    roles: [],
    ...patch,
  };
}

const baseSlot: TimetableSlot = {
  id: 'tt-cot-1',
  dayOfWeek: 1,
  periodNumber: 3,
  startTime: '09:50',
  endTime: '10:50',
  subject: 'Sostegno',
  className: '2E',
};

// ---------------------------------------------------------------------------
// 1. Model & formatting
// ---------------------------------------------------------------------------

test('coTeachingSummary produces the compact spec formats for support and curricular slots', () => {
  // Sostegno: "Compresenza: Matematica" + "Con: Prof.ssa Rossi"
  assert.equal(
    coTeachingSummary({ ...baseSlot, coTeachingSubjects: ['Matematica'], coSupportTeachers: ['Prof.ssa Rossi'] }),
    'Compresenza: Matematica · Con: Prof.ssa Rossi'
  );
  // Multiple subjects and teachers are supported.
  assert.equal(
    coTeachingSummary({ ...baseSlot, coTeachingSubjects: ['Matematica', 'Scienze'], coSupportTeachers: ['Prof.ssa Rossi', 'Prof. Bianchi'] }),
    'Compresenza: Matematica, Scienze · Con: Prof.ssa Rossi, Prof. Bianchi'
  );
  // Curricolare: "Sostegno: Prof. Bianchi, Prof.ssa Verdi"
  assert.equal(
    coTeachingSummary({ ...baseSlot, subject: 'Matematica', supportTeachers: ['Prof. Bianchi', 'Prof.ssa Verdi'] }),
    'Sostegno: Prof. Bianchi, Prof.ssa Verdi'
  );
  // Old slots without the fields: no summary, no crash.
  assert.equal(coTeachingSummary(baseSlot), null);
  assert.equal(hasCoTeaching(baseSlot), false);
  assert.equal(hasCoTeaching({ ...baseSlot, supportTeachers: ['Prof. Bianchi'] }), true);
});

test('collectKnownTeacherNames reuses names already entered (future directory seam) and pruneCoTeachingFields keeps slots clean', () => {
  const timetables: TimetableSlot[] = [
    { ...baseSlot, id: 'a', coSupportTeachers: ['Prof.ssa Rossi'] },
    { ...baseSlot, id: 'b', supportTeachers: ['Prof. Bianchi', 'Prof.ssa Rossi'] },
  ];
  assert.deepEqual(collectKnownTeacherNames(timetables, []), ['Prof. Bianchi', 'Prof.ssa Rossi']);
  assert.deepEqual(collectKnownTeacherNames([]), []);

  // Empty strings are ignored everywhere.
  assert.deepEqual(collectKnownTeacherNames([{ ...baseSlot, id: 'c', supportTeachers: ['  ', 'Prof.ssa Rossi'] }]), ['Prof.ssa Rossi']);

  const pruned = pruneCoTeachingFields({ ...baseSlot, coTeachingSubjects: [], coSupportTeachers: [], supportTeachers: [] });
  assert.equal('coTeachingSubjects' in pruned, false);
  assert.equal('coSupportTeachers' in pruned, false);
  assert.equal('supportTeachers' in pruned, false);
  const kept = pruneCoTeachingFields({ ...baseSlot, supportTeachers: ['Prof. Bianchi'] });
  assert.deepEqual(kept.supportTeachers, ['Prof. Bianchi']);
});

// ---------------------------------------------------------------------------
// 2. Persistence: IndexedDB, backup/restore, Firestore round-trip, retro-compatibility
// ---------------------------------------------------------------------------

test('slots with co-teaching fields persist in IndexedDB and round-trip through backup/restore', async () => {
  const slot: TimetableSlot = {
    ...baseSlot,
    coTeachingSubjects: ['Matematica', 'Scienze'],
    coSupportTeachers: ['Prof.ssa Rossi'],
  };
  await storage.saveProvisionalTimetable([slot]);

  const read = await storage.getProvisionalTimetable();
  assert.deepEqual(read[0].coTeachingSubjects, ['Matematica', 'Scienze']);
  assert.deepEqual(read[0].coSupportTeachers, ['Prof.ssa Rossi']);

  const backupJson = await storage.exportDataBackup();
  const parsed = JSON.parse(backupJson);
  assert.deepEqual(parsed.provisionalTimetable[0].coTeachingSubjects, ['Matematica', 'Scienze']);
  // The full document passes the strict backup validator (new fields accepted).
  validateBackup(parsed);

  await storage.saveProvisionalTimetable([]);
  assert.equal(await storage.importDataBackup(backupJson), true);
  const restored = await storage.getProvisionalTimetable();
  assert.deepEqual(restored[0].coSupportTeachers, ['Prof.ssa Rossi']);

  // Old-style slots (no new fields) still validate.
  validateBackup({ version: 3, ...emptyInstallation(), provisionalTimetable: [baseSlot] });
});

test('Firestore round-trip: sanitize keeps the new fields and the remote schema classifies them as valid', () => {
  const slot: TimetableSlot = {
    ...baseSlot,
    coTeachingSubjects: ['Italiano', 'Educazione fisica'],
    supportTeachers: ['Prof. Bianchi'],
  };
  const sanitized = sanitizeFirestorePayload([slot]);
  const json = JSON.stringify(sanitized);
  assert.ok(!json.includes('undefined'));
  assert.deepEqual(sanitized[0].coTeachingSubjects, ['Italiano', 'Educazione fisica']);

  // Simulate a full cloud round-trip: write wrapper -> read raw -> classify.
  const remoteDoc = { payload: sanitized, updatedAt: '2026-09-09T17:47:36.312Z', schemaVersion: 1 };
  const verdict = classifyRemoteStateDoc('provisionalTimetable', remoteDoc);
  assert.equal(verdict.status, 'valid');
  assert.ok(isValidTimetablePayload(verdict.doc.payload));

  // Old slots (pre-co-teaching documents) remain valid remote payloads.
  assert.equal(classifyRemoteStateDoc('provisionalTimetable', { payload: [baseSlot], updatedAt: '2026-09-09T17:47:36.312Z', schemaVersion: 1 }).status, 'valid');
});

// ---------------------------------------------------------------------------
// 3. Editor UX: support teacher (multi materie + docenti), curricular teacher, optional
// ---------------------------------------------------------------------------

type EditorProps = React.ComponentProps<typeof TimetableEditor>;

function editorProps(patch: Partial<EditorProps> = {}): EditorProps {
  return {
    profile: profileWith({ isSupportTeacher: true }),
    definitiveTimetable: [],
    provisionalTimetable: [],
    timetableMode: 'auto',
    activeType: 'provvisorio',
    isDefinitiveCompiled: false,
    timeSlotConfig: {
      firstHourStartTime: '07:50',
      periodsPerDay: 6,
      standardDurationMinutes: 60,
      customSlots: [
        { periodNumber: 1, label: '1ª Ora', startTime: '07:50', endTime: '08:50' },
        { periodNumber: 2, label: '2ª Ora', startTime: '08:50', endTime: '09:50' },
        { periodNumber: 3, label: '3ª Ora', startTime: '09:50', endTime: '10:50' },
      ],
    },
    onSaveSlot: () => {},
    onDeleteSlot: () => {},
    onSetTimetableMode: () => {},
    onCopyProvisionalToDefinitive: () => {},
    onCopyDefinitiveToProvisional: () => {},
    onClearTimetable: () => {},
    onSaveProfile: () => {},
    onSaveTimeSlotConfig: () => {},
    ...patch,
  };
}

async function render(props: EditorProps) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, props));
  });
  return renderer;
}

async function openMondayFirstPeriod(renderer: any) {
  const plusButtons = renderer.root.findAll((el: any) => el.type === 'button' && el.props.title && el.props.title.includes('Lunedì'));
  assert.ok(plusButtons.length > 0);
  await act(async () => { plusButtons[0].props.onClick(); });
}

function findInputByPlaceholder(renderer: any, placeholder: string) {
  return renderer.root.findAll((el: any) => el.type === 'input' && el.props.placeholder === placeholder);
}

/** Full text content of a rendered tree (react-test-renderer's toString() is shallow). */
function textContent(renderer: any): string {
  const parts: string[] = [];
  const walk = (node: any) => {
    if (typeof node === 'string' || typeof node === 'number') { parts.push(String(node)); return; }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.children === 'string' || typeof node.children === 'number') parts.push(String(node.children));
    else if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(renderer.root);
  return parts.join(' ');
}

const SUBJECT_PLACEHOLDER = 'es. Matematica, Italiano…';
const TEACHER_PLACEHOLDER = 'es. Maria Rossi…';

async function addChipValue(renderer: any, placeholder: string, value: string) {
  const inputs = findInputByPlaceholder(renderer, placeholder);
  assert.ok(inputs.length > 0, `input with placeholder "${placeholder}" must exist`);
  await act(async () => { inputs[0].props.onChange({ target: { value } }); });
  await act(async () => { inputs[0].props.onKeyDown({ key: 'Enter', preventDefault: () => {} }); });
}

test('support teacher can add MULTIPLE co-teaching subjects and co-support teachers (all optional)', async () => {
  let saved: TimetableSlot | undefined;
  const renderer = await render(editorProps({ onSaveSlot: (slot: TimetableSlot) => { saved = slot; } }));
  await openMondayFirstPeriod(renderer);

  // Materia principale dell'ora: "Sostegno"
  const subjectInput = renderer.root.findAll((el: any) => el.type === 'input').find((el: any) => el.props.placeholder === 'es. Sostegno');
  assert.ok(subjectInput, 'support teacher subject input present');
  await act(async () => { subjectInput.props.onChange({ target: { value: 'Sostegno' } }); });

  // Multi materie in compresenza.
  await addChipValue(renderer, SUBJECT_PLACEHOLDER, 'Matematica');
  await addChipValue(renderer, SUBJECT_PLACEHOLDER, 'Scienze');
  // Altri docenti di sostegno presenti (normalized Nome Cognome).
  await addChipValue(renderer, TEACHER_PLACEHOLDER, 'prof.ssa rossi');

  const form = renderer.root.findByType('form');
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });

  assert.ok(saved);
  assert.equal(saved!.subject, 'Sostegno');
  assert.equal(saved!.className, '1A');
  assert.deepEqual(saved!.coTeachingSubjects, ['Matematica', 'Scienze'], 'multiple co-teaching subjects');
  assert.deepEqual(saved!.coSupportTeachers, ['Prof.ssa Rossi'], 'normalized teacher name');
  assert.equal(saved!.supportTeachers, undefined, 'curricular-only field not set for a support teacher');
});

test('curricular teacher can add optional support teachers (none, one or more) and is never forced to', async () => {
  let saved: TimetableSlot | undefined;
  const renderer = await render(editorProps({
    profile: profileWith({ isSupportTeacher: false, primarySubjects: ['Matematica'] }),
    onSaveSlot: (slot: TimetableSlot) => { saved = slot; },
  }));
  await openMondayFirstPeriod(renderer);

  // The support-teacher-only widgets must not appear for a curricular teacher.
  assert.equal(findInputByPlaceholder(renderer, SUBJECT_PLACEHOLDER).length, 0, 'no co-teaching subjects input for curricular teacher');

  // The curricular teacher field is present and OPTIONAL: submit without filling it.
  const form = renderer.root.findByType('form');
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });
  assert.ok(saved, 'saving without any co-teaching data must work (fields are optional)');
  assert.equal('supportTeachers' in saved!, false, 'empty optional fields are pruned');

  // Reopen the editor and add one, then a second support teacher.
  await openMondayFirstPeriod(renderer);
  await addChipValue(renderer, TEACHER_PLACEHOLDER, 'prof. bianchi');
  await addChipValue(renderer, TEACHER_PLACEHOLDER, 'prof.ssa verdi');
  const form2 = renderer.root.findByType('form');
  await act(async () => { await form2.props.onSubmit({ preventDefault: () => {} }); });
  assert.ok(saved);
  assert.deepEqual(saved!.supportTeachers, ['Prof. Bianchi', 'Prof.ssa Verdi']);
});

test('teacher names already used in the timetable are offered as datalist suggestions', async () => {
  const existing: TimetableSlot = { ...baseSlot, id: 'tt-prev', supportTeachers: ['Prof.ssa Rossi'] };
  const renderer = await render(editorProps({
    profile: profileWith({ isSupportTeacher: false }),
    provisionalTimetable: [existing],
  }));
  await openMondayFirstPeriod(renderer);

  const teacherInputs = findInputByPlaceholder(renderer, TEACHER_PLACEHOLDER);
  assert.ok(teacherInputs.length > 0);
  const listId = teacherInputs[0].props.list;
  assert.ok(listId, 'input must reference a datalist');
  const datalist = renderer.root.findAll((el: any) => el.type === 'datalist').find((el: any) => el.props.id === listId);
  assert.ok(datalist, 'the referenced datalist must exist');
  const options = datalist.findAllByType('option').map((o: any) => o.props.value);
  assert.deepEqual(options, ['Prof.ssa Rossi'], 'previously used names appear as suggestions');
});

test('editing a slot with co-teaching data keeps the values and the grid shows the compact summary', async () => {
  let saved: TimetableSlot | undefined;
  const slot: TimetableSlot = { ...baseSlot, coTeachingSubjects: ['Matematica'], coSupportTeachers: ['Prof.ssa Rossi'] };
  const renderer = await render(editorProps({
    provisionalTimetable: [slot],
    onSaveSlot: (s: TimetableSlot) => { saved = s; },
  }));

  // The timetable grid cell shows the compact co-teaching line.
  const cellText = textContent(renderer);
  assert.ok(cellText.includes('Compresenza: Matematica'), 'grid shows the co-teaching summary');
  assert.ok(cellText.includes('Con: Prof.ssa Rossi'));

  // Open the slot editor: the values are still there and survive a plain re-save.
  const editButtons = renderer.root.findAll((el: any) => el.type === 'div' && String(el.props.className ?? '').includes('cursor-pointer'));
  assert.ok(editButtons.length > 0, 'slot cells are clickable');
  await act(async () => { editButtons[0].props.onClick(); });
  const form = renderer.root.findByType('form');
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });
  assert.ok(saved);
  assert.deepEqual(saved!.coTeachingSubjects, ['Matematica']);
  assert.deepEqual(saved!.coSupportTeachers, ['Prof.ssa Rossi']);
});

// ---------------------------------------------------------------------------
// 4. Compact display in Oggi and Settimana
// ---------------------------------------------------------------------------

const todayPropsBase = {
  timetable: [] as TimetableSlot[],
  events: [],
  isProvisionalTimetable: true,
  isDefinitiveCompiled: false,
  onOpenNewEvent: () => {},
  onOpenCircularModal: () => {},
  onEditEvent: () => {},
  onDeleteEvent: () => {},
  onToggleComplete: () => {},
};

function isoOfCurrentWeekday(dayOfWeek: number): string {
  // TodayView shows lessons for the weekday of the *selected* date (today).
  const today = new Date();
  const jsDay = today.getDay() === 0 ? 7 : today.getDay();
  today.setDate(today.getDate() + (dayOfWeek - jsDay));
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

test('TodayView shows the compact co-teaching line for lessons', async () => {
  const todayJsDay = new Date().getDay(); // 0 = Sunday
  const lessonDay = ([1, 2, 3, 4, 5, 6] as const).includes(todayJsDay as 1 | 2 | 3 | 4 | 5 | 6)
    ? (todayJsDay as 1 | 2 | 3 | 4 | 5 | 6)
    : 1;
  const supportLesson: TimetableSlot = {
    ...baseSlot,
    dayOfWeek: lessonDay,
    coTeachingSubjects: ['Matematica'],
    coSupportTeachers: ['Prof.ssa Rossi'],
  };
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TodayView, {
      ...todayPropsBase,
      profile: profileWith(),
      timetable: [supportLesson],
    }));
  });
  const rendered = textContent(renderer);
  assert.ok(rendered.includes('Compresenza: Matematica'), 'TodayView shows the subject in compresenza');
  assert.ok(rendered.includes('Con: Prof.ssa Rossi'), 'TodayView shows the co-support teacher');
});

test('WeekView shows the compact co-teaching line for lessons', async () => {
  const supportLesson: TimetableSlot = {
    ...baseSlot,
    dayOfWeek: 1,
    coTeachingSubjects: ['Matematica'],
    coSupportTeachers: ['Prof.ssa Rossi'],
  };
  const curricularLesson: TimetableSlot = {
    ...baseSlot,
    id: 'tt-cot-2',
    dayOfWeek: 2,
    subject: 'Matematica',
    supportTeachers: ['Prof. Bianchi', 'Prof.ssa Verdi'],
  };
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(WeekView, {
      profile: profileWith(),
      timetable: [supportLesson, curricularLesson],
      events: [],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
    }));
  });
  const rendered = textContent(renderer);
  assert.ok(rendered.includes('Compresenza: Matematica'), 'WeekView shows the subject in compresenza');
  assert.ok(rendered.includes('Con: Prof.ssa Rossi'));
  assert.ok(rendered.includes('Sostegno: Prof. Bianchi, Prof.ssa Verdi'), 'WeekView shows curricular support teachers');
});

// ---------------------------------------------------------------------------
// 5. Full local persistence through the storage API
// ---------------------------------------------------------------------------

test('saveTimetableSlot with co-teaching fields round-trips through the real IndexedDB storage', async () => {
  const slot: TimetableSlot = {
    ...baseSlot,
    coTeachingSubjects: ['Italiano'],
    supportTeachers: ['Prof. Bianchi'],
  };
  await storage.saveTimetableSlot(slot, 'provvisorio');
  const provisional = await storage.getProvisionalTimetable();
  assert.equal(provisional.length, 1);
  assert.deepEqual(provisional[0].coTeachingSubjects, ['Italiano']);
  assert.deepEqual(provisional[0].supportTeachers, ['Prof. Bianchi']);
  assert.equal(provisional[0].isProvisional, true);

  // Old-style slot without the fields coexists seamlessly.
  await storage.saveTimetableSlot({ ...baseSlot, id: 'tt-old-style' }, 'provvisorio');
  const after = await storage.getProvisionalTimetable();
  assert.equal(after.length, 2);
  assert.equal(after[1].coTeachingSubjects, undefined);
});
