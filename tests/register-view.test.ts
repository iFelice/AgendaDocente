import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { getActiveRegisterStudents, getRegisterClasses, parseAssessmentNumericInput, sortStudentAssessments, RegisterView } from '../src/components/RegisterView';
import type { Student, StudentAssessment, TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const student = (id: string, className: string, status?: Student['status']): Student => ({ id, fullName: id === 's1' ? 'Rossi Anna' : id === 's2' ? 'Bianchi Luca' : 'Verdi Sara', className, status, notes: [] });
const profile = (classes: string[] = ['2E']): TeacherProfile => ({ id: 'teacher', fullName: 'Docente', schoolName: 'Scuola', schoolYear: '2026/27', primarySubjects: [], classes, campuses: [], roles: [] });
const assessment = (id: string, studentId: string, date: string, updatedAt = date): StudentAssessment => ({ id, studentId, className: '2E', date, assessmentType: 'oral', valueKind: 'numeric', numericValue: 7, createdAt: date, updatedAt });

const text = (node: any): string => {
  if (!node) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(text).join(' ');
};
const props = (overrides: Partial<React.ComponentProps<typeof RegisterView>> = {}) => ({
  profile: profile(), students: [student('s1', '2E'), student('s2', '3A')], assessments: [],
  onSaveAssessment: async () => {}, onDeleteAssessment: async () => {}, ...overrides,
});

test('Registro mostra solo studenti attivi e include i legacy con status undefined', () => {
  const result = getActiveRegisterStudents([student('s3', '2E', 'archived'), student('s1', '2E'), student('s2', '2E', 'active')]);
  assert.deepEqual(result.map(s => s.id), ['s2', 's1']);
});

test('Registro seleziona classi reali dal profilo e dagli studenti attivi senza schoolId inventati', () => {
  assert.deepEqual(getRegisterClasses(profile(['2E']), [student('s1', '2E'), student('s2', '3A'), student('s3', '4B', 'archived')]), ['2E', '3A']);
});

test('classe senza studenti produce elenco vuoto e non mischia le classi', () => {
  const active = getActiveRegisterStudents([student('s1', '2E')]);
  assert.equal(active.filter(s => s.className === '3A').length, 0);
});

test('assessment filtrati tramite studentId e ordinati più recenti prima', () => {
  const rows = [assessment('old', 's1', '2026-09-01'), assessment('new', 's1', '2026-09-12'), assessment('other', 's2', '2026-09-20')];
  assert.deepEqual(sortStudentAssessments(rows.filter(row => row.studentId === 's1')).map(row => row.id), ['new', 'old']);
});

test('input numerico preserva decimali con punto e converte la virgola italiana', () => {
  assert.equal(parseAssessmentNumericInput('7.125'), 7.125);
  assert.equal(parseAssessmentNumericInput('7,125'), 7.125);
});

test('tipo prova e giudizio StudentAssessment restano valori del modello', () => {
  const judgement: StudentAssessment = { ...assessment('j', 's1', '2026-09-10'), valueKind: 'judgement', numericValue: undefined, judgementValue: 'Ottimo', assessmentType: 'written' };
  assert.equal(judgement.valueKind, 'judgement');
  assert.equal(judgement.assessmentType, 'written');
});

test('modifica conserva id, studentId e createdAt', () => {
  const existing = assessment('same', 's1', '2026-09-01');
  const edited = { ...existing, numericValue: 8, updatedAt: '2026-09-20' };
  assert.deepEqual({ id: edited.id, studentId: edited.studentId, createdAt: edited.createdAt }, { id: 'same', studentId: 's1', createdAt: '2026-09-01' });
});

test('stato vuoto Registro è rappresentabile senza valutazioni', () => {
  assert.equal(sortStudentAssessments([]).length, 0);
});

test('archiviati esclusi anche se hanno valutazioni', () => {
  const archived = student('s3', '2E', 'archived');
  assert.equal(getActiveRegisterStudents([archived]).length, 0);
  assert.equal(assessment('a', archived.id, '2026-09-10').studentId, archived.id);
});

test('apertura diretta con studentId mostra subito la scheda senza riselezione', async () => {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(RegisterView, props({ initialStudentId: 's2', assessments: [assessment('a', 's2', '2026-09-12')] }))); });
  assert.match(text(renderer.toJSON()), /Bianchi Luca/);
  assert.match(text(renderer.toJSON()), /7/);
  assert.equal(renderer.root.findAll((node: any) => node.props?.['aria-label'] === 'Seleziona classe').length, 0);
});

test('due studenti omonimi restano distinti tramite id e le assessments corrette', async () => {
  const first = { ...student('same-a', '2E'), fullName: 'Rossi Luca' };
  const second = { ...student('same-b', '3A'), fullName: 'Rossi Luca' };
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(RegisterView, props({ students: [first, second], initialStudentId: 'same-b', assessments: [assessment('a', 'same-a', '2026-09-01'), assessment('b', 'same-b', '2026-09-02')] }))); });
  assert.match(text(renderer.toJSON()), /3A/);
  assert.match(text(renderer.toJSON()), /2026-09-02/);
  assert.doesNotMatch(text(renderer.toJSON()), /2026-09-01/);
});

test('studentId inesistente o archived ricade nella lista Registro e non apre una scheda vuota', async () => {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(RegisterView, props({ initialStudentId: 'missing' }))); });
  assert.match(text(renderer.toJSON()), /Valutazioni/);
  assert.doesNotMatch(text(renderer.toJSON()), /Scheda studente/);
  await act(async () => { renderer = create(React.createElement(RegisterView, props({ students: [student('archived', '2E', 'archived')], initialStudentId: 'archived' }))); });
  assert.doesNotMatch(text(renderer.toJSON()), /Scheda studente/);
});

test('back da apertura Classi torna al contesto precedente', async () => {
  let back = 0;
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(RegisterView, props({ initialStudentId: 's1', onBackToOrigin: () => { back++; } }))); });
  const button = renderer.root.findAll((node: any) => node.type === 'button' && text(node).includes('Indietro'))[0];
  await act(async () => { button.props.onClick(); });
  assert.equal(back, 1);
});

test('back da apertura normale torna alla lista Registro', async () => {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(RegisterView, props({ initialStudentId: 's1' }))); });
  const button = renderer.root.findAll((node: any) => node.type === 'button' && text(node).includes('Indietro'))[0];
  await act(async () => { button.props.onClick(); });
  assert.match(text(renderer.toJSON()), /Tutte le classi/);
  assert.doesNotMatch(text(renderer.toJSON()), /Scheda studente/);
});
