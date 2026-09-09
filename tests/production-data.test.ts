import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { database } from '../src/services/db';
import {
  DEFAULT_EVENTS,
  DEFAULT_STUDENTS,
  DEFAULT_PROVISIONAL_TIMETABLE,
  demoInstallation,
  emptyInstallation,
  initializeStorage,
  storage,
  stripUnmodifiedSeedRows,
} from '../src/services/storage';
import { selectDayAgenda } from '../src/components/TodayView';
import { formatPersonDisplayName, isPlaceholderFullName } from '../src/utils/names';
import { buildRolesFromChoices } from '../src/utils/teacherRoles';
import type { CalendarEvent, Student, TimetableSlot } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const legacy = { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} };

// ---------- fresh installs must not carry ANY ready-made example content ----------

test('a fresh installation starts with no events, students, circulars, lessons or demo profile', async () => {
  database.close(); await database.delete();
  const data = await initializeStorage(legacy);
  assert.deepEqual(data.events, []);
  assert.deepEqual(data.circulars, []);
  assert.deepEqual(data.students, []);
  assert.deepEqual(data.definitiveTimetable, []);
  assert.deepEqual(data.provisionalTimetable, []);
  assert.equal(data.onboardingCompleted, false);
  assert.ok(isPlaceholderFullName(data.profile.fullName));
  assert.equal(data.profile.schoolName, '');
  assert.deepEqual(data.profile.roles, []);
  database.close(); await database.delete();
});

test('an old beta install with untouched demo rows loses exactly the fake ones and keeps real data', async () => {
  database.close(); await database.delete();
  // Simulate a device seeded by previous versions: full demo data plus one genuine event and one edited student.
  const seed = demoInstallation();
  const realEvent = { ...structuredClone(DEFAULT_EVENTS[0]), id: 'ev-real', title: 'Ricevimento personale' } as CalendarEvent;
  const editedStudent = { ...(seed.students[0] as Student), notes: [...(seed.students[0] as Student).notes, { id: 'n1', title: 'Nota', content: 'Osservazione reale', date: '2026-09-10', category: 'osservazione', createdAt: '2026-09-10T08:00:00.000Z' } as Student['notes'][number]] };
  const data = { ...seed, events: [...seed.events, realEvent], students: [editedStudent, ...seed.students.slice(1)] };
  await database.initialize(data, legacy);
  assert.ok((await storage.getEvents()).length > 1);
  const result = await stripUnmodifiedSeedRows();
  assert.equal(result.removedEvents, DEFAULT_EVENTS.length);
  assert.equal(result.removedStudents, DEFAULT_STUDENTS.length - 1); // edited one kept: notes differ from seed
  assert.equal(result.removedSlots, DEFAULT_PROVISIONAL_TIMETABLE.length);
  const kept = await storage.getEvents();
  assert.deepEqual(kept.map(e => e.id), ['ev-real']);
  const students = await storage.getStudents();
  assert.equal(students.length, 1);
  assert.ok(students[0].notes.some(n => n.content === 'Osservazione reale'));
  assert.deepEqual(await storage.getProvisionalTimetable(), []);
  // profile reset to placeholders (never invented data), keeping nothing fake
  const profile = await storage.getProfile();
  assert.ok(isPlaceholderFullName(profile.fullName));
  assert.equal(profile.schoolName, '');
  database.close(); await database.delete();
});

test('production UI sources contain no demo/example affordances', () => {
  const banned = ['Esempi pronti', 'Usa Account Demo', 'Carica standard 18h', 'Carica Preset Sostegno', 'circolare demo', 'resetProvisionalTimetable', 'resetDefinitiveTimetable'];
  const files = ['components/TimetableEditor.tsx', 'components/OnboardingModal.tsx', 'components/ProfileModal.tsx', 'components/CircularAnalyzerModal.tsx', 'components/CircularsArchiveView.tsx', 'components/TodayView.tsx', 'App.tsx'];
  for (const file of files) {
    const source = readFileSync(resolve(here, '../src', file), 'utf8').toLowerCase();
    for (const needle of banned) assert.ok(!source.includes(needle.toLowerCase()), `${file} must not mention "${needle}"`);
  }
});

// ---------- TodayView: selected-day logic ----------

const mondaySlot = (period: number, subject: string) => ({ id: `s${period}`, dayOfWeek: 1, periodNumber: period, subject, className: '1A', classroom: 'A1' }) as unknown as TimetableSlot;

test('the day agenda selects lessons by the weekday of the chosen date, not of the real today', () => {
  const timetable = [mondaySlot(1, 'Italiano'), mondaySlot(0, 'Inizio'), { id: 'x', dayOfWeek: 2, periodNumber: 1, subject: 'Matematica', className: '1B', classroom: 'B2' } as unknown as TimetableSlot];
  const events = [
    { id: 'e1', title: 'Cda', date: '2027-02-28', type: 'riunione', completed: false, startTime: '18:00' } as unknown as CalendarEvent,
    { id: 'e2', title: 'Già fatto', date: '2027-02-28', type: 'riunione', completed: true, startTime: '09:00' } as unknown as CalendarEvent,
    { id: 'd1', title: 'PEI', date: '2027-03-02', category: 'pei', completed: false } as unknown as CalendarEvent,
    { id: 'd2', title: 'Scrutinio', date: '2027-03-03', category: 'scadenza', completed: false } as unknown as CalendarEvent,
    { id: 'd3', title: 'GLO', date: '2027-03-04', category: 'promemoria', completed: false } as unknown as CalendarEvent,
    { id: 'd4', title: 'Lontano', date: '2027-03-20', category: 'scadenza', completed: false } as unknown as CalendarEvent,
  ];
  // 28 February 2027 is a Sunday: weekend flag, no lessons, and civil (not UTC) date handling.
  const sunday = selectDayAgenda('2027-02-28', timetable, events);
  assert.equal(sunday.isWeekend, true);
  assert.deepEqual(sunday.lessons, []);
  assert.deepEqual(sunday.dayEvents.map(e => e.id), ['e1']); // completed excluded
  assert.equal(sunday.dayDeadlines.length, 0);
  assert.deepEqual(sunday.nextDeadlines.map(e => e.id), ['d1', 'd2', 'd3']); // max three upcoming
  // 1 March 2027 is a Monday: the Monday lessons belong to the SELECTED day.
  const monday = selectDayAgenda('2027-03-01', timetable, events);
  assert.equal(monday.isWeekend, false);
  assert.deepEqual(monday.lessons.map(l => l.subject), ['Inizio', 'Italiano']);
  assert.equal(monday.displayDate, 'Lunedì 1 marzo 2027');
});

// ---------- role & name utilities are the single source of truth ----------

test('a support teacher alone never earns GLI membership and roles come only from explicit choices', () => {
  const roles = buildRolesFromChoices({ isSupportTeacher: true, additionalRoles: [] });
  assert.deepEqual(roles.map(r => r.role), ['docente_sostegno']);
  const withCoord = buildRolesFromChoices({ isSupportTeacher: false, additionalRoles: [{ role: 'coordinatore', targetClass: '2E' }, { role: 'altro', label: 'Referente Erasmus' }] });
  assert.deepEqual(withCoord.map(r => r.role), ['coordinatore', 'altro']);
  assert.equal(withCoord[0].targetClass, '2E');
  assert.equal(withCoord[1].label, 'Referente Erasmus');
});

test('Google display names are normalized for viewing without touching emails or formatted names', () => {
  assert.equal(formatPersonDisplayName('felice manganiello'), 'Felice Manganiello');
  assert.equal(formatPersonDisplayName('mario de luca'), 'Mario De Luca');
  assert.equal(formatPersonDisplayName("FRANCESCO D'ANGELO"), "Francesco D'Angelo");
  assert.equal(formatPersonDisplayName('mcdonald j.'), 'Mcdonald J.');
  assert.equal(formatPersonDisplayName('Rossi Prof. Laura'), 'Rossi Prof. Laura');
  assert.equal(isPlaceholderFullName('Prof. Mario Rossi'), true);
  assert.equal(isPlaceholderFullName('Felice Manganiello'), false);
  assert.equal(isPlaceholderFullName(''), true);
});

test('emptyInstallation profile has no invented identities at all', () => {
  const p = emptyInstallation().profile;
  assert.equal(p.fullName, '');
  assert.equal(p.schoolName, '');
  assert.deepEqual(p.classes, []);
  assert.deepEqual(p.primarySubjects, []);
  assert.deepEqual(p.campuses, []);
});
