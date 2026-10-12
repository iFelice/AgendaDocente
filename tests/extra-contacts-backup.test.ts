/**
 * Test: backup e ripristino con extraContacts.
 * - backup con extraContacts valido ripristina correttamente;
 * - backup vecchio senza campo continua a funzionare;
 * - backup con extraContacts malformato => errore (come per gli altri campi).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBackup } from '../src/services/backup';

const validBackupBase = {
  version: 3,
  profile: {
    id: 'p1', fullName: 'Anna Test', schoolName: 'IC Prova', schoolYear: '2026/2027',
    primarySubjects: ['Italiano'], classes: ['1A'], campuses: [], roles: [],
  },
  events: [],
  circulars: [],
  students: [{
    id: 's1', fullName: 'Mario Rossi', className: '1A', notes: [],
  }],
  assessments: [],
  scheduledAssessments: [],
  definitiveTimetable: [],
  provisionalTimetable: [],
  timetableMode: 'auto',
  onboardingCompleted: true,
};

test('backup senza extraContacts (legacy) è valido', () => {
  assert.doesNotThrow(() => validateBackup(validBackupBase));
});

test('backup con extraContacts valido passa la validazione', () => {
  const backup = {
    ...validBackupBase,
    students: [{
      ...validBackupBase.students[0],
      extraContacts: [
        { id: 'c1', role: 'tutor', name: 'Anna', phone: '3331234567', email: 'a@b.it' },
        { id: 'c2', role: 'terapista', roleDetail: 'Logopedista', notes: 'martedì pomeriggio' },
      ],
    }],
  };
  assert.doesNotThrow(() => validateBackup(backup));
});

test('backup con extraContacts malformato (ruolo invalido) fallisce', () => {
  const backup = {
    ...validBackupBase,
    students: [{
      ...validBackupBase.students[0],
      extraContacts: [{ id: 'c1', role: 'ruolo_non_valido', name: 'Anna' }],
    }],
  };
  assert.throws(() => validateBackup(backup), /Alunni nel backup non validi/);
});

test('backup con troppi contatti (>20) fallisce', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, role: 'altro', name: `C${i}` }));
  const backup = {
    ...validBackupBase,
    students: [{ ...validBackupBase.students[0], extraContacts: many }],
  };
  assert.throws(() => validateBackup(backup), /Alunni nel backup non validi/);
});

test('backup con contatto con campo troppo lungo fallisce', () => {
  const backup = {
    ...validBackupBase,
    students: [{
      ...validBackupBase.students[0],
      extraContacts: [{ id: 'c1', role: 'tutor', name: 'a'.repeat(300) }],
    }],
  };
  assert.throws(() => validateBackup(backup), /Alunni nel backup non validi/);
});
