import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateItemRelevance,
  extractGradesFromText,
  matchGradesToClasses,
} from '../src/utils/circularRelevance';
import type { TeacherProfile } from '../src/types';

/*
 * Caso reale (screenshot): docente di sostegno, classi 3E/3D/1C, circolare "Giochi
 * Matematici di Prisma" destinata alle "classi I e III". Prima del fix veniva
 * classificata ROSSO con "Destinato ad altra materia: matematica." perché il filtro
 * materia non considerava la pertinenza per classe/anno del docente di sostegno.
 */
const supportProfile: TeacherProfile = {
  id: 'support', fullName: 'Prof. Sostegno', schoolName: 'Test', schoolYear: '2026/2027',
  schoolLevel: 'ssig', isSupportTeacher: true, primarySubjects: ['Sostegno Didattico'],
  classes: ['3E', '3D', '1C'], campuses: [], roles: [],
};

const curricularProfile: TeacherProfile = {
  id: 'curricular', fullName: 'Prof. Scienze Motorie', schoolName: 'Test', schoolYear: '2026/2027',
  schoolLevel: 'ssig', isSupportTeacher: false, primarySubjects: ['Scienze Motorie'],
  classes: ['3E'], campuses: [], roles: [],
};

// ---------------------------------------------------------------------------
// 8-9. extractGradesFromText: forme multiple delle circolari scolastiche
// ---------------------------------------------------------------------------

test('extractGradesFromText riconosce liste e forme multiple di anno di corso', () => {
  assert.deepEqual(extractGradesFromText('classi I e III'), [1, 3]);
  assert.deepEqual(extractGradesFromText('classi I, II e III'), [1, 2, 3]);
  assert.deepEqual(extractGradesFromText('classi I-III'), [1, 2, 3]);
  assert.deepEqual(extractGradesFromText('classi prime e terze'), [1, 3]);
  assert.deepEqual(extractGradesFromText('classi prime, seconde e terze'), [1, 2, 3]);
  assert.deepEqual(extractGradesFromText('1° e 3° anno'), [1, 3]);
  assert.deepEqual(extractGradesFromText('primo e terzo anno'), [1, 3]);
  // Preservati: la sigla completa resta di extractClassesFromText, non un anno isolato.
  assert.deepEqual(extractGradesFromText('classe III E'), []);
  assert.deepEqual(extractGradesFromText('classi III'), [3]);
});

test('matchGradesToClasses incrocia anni rilevati con le classi assegnate', () => {
  assert.deepEqual(matchGradesToClasses([1, 3], ['3E', '3D', '1C']), [1, 3]);
  assert.deepEqual(matchGradesToClasses([2], ['3E', '3D', '1C']), []);
  assert.deepEqual(matchGradesToClasses([], ['3E']), []);
});

// ---------------------------------------------------------------------------
// 10. Caso screenshot reale: Giochi Matematici di Prisma
// ---------------------------------------------------------------------------

test('sostegno: Giochi Matematici di Prisma (classi I e III) è pertinente, non ROSSO per materia', () => {
  const item = {
    title: 'Svolgimento Giochi Matematici di Prisma',
    subject: 'matematica',
    date: '2026-11-26',
    notes: 'Attività rivolta alle classi I e III.',
    rawSnippet: "Il primo appuntamento è fissato per il 26 novembre 2026...",
  };
  const grades = extractGradesFromText(`${item.title} ${item.subject} ${item.notes} ${item.rawSnippet}`);
  assert.deepEqual(grades, [1, 3]);
  const matchedGrades = matchGradesToClasses(grades, supportProfile.classes);
  assert.deepEqual(matchedGrades, [1, 3]);

  const evaluation = evaluateItemRelevance(item, supportProfile);
  assert.notEqual(evaluation.relevance, 'ROSSO');
  assert.equal(evaluation.relevance, 'VERDE');
  assert.equal(evaluation.selectedForImport, true);
  assert.doesNotMatch(evaluation.relevanceReason, /altra materia/i);
  assert.match(evaluation.relevanceReason, /1°.*3°|3°.*1°/);
});

// ---------------------------------------------------------------------------
// 11. Anno non pertinente: la regola sostegno non bypassa il filtro annualità
// ---------------------------------------------------------------------------

test('sostegno: anno non pertinente resta ROSSO anche con materia diversa', () => {
  const item = { title: 'Corso di aggiornamento', subject: 'matematica', notes: 'Rivolto alle classi II.' };
  const evaluation = evaluateItemRelevance(item, supportProfile);
  assert.equal(evaluation.relevance, 'ROSSO');
  assert.equal(evaluation.relevanceReason, 'Destinato a un altro anno di corso.');
});

// ---------------------------------------------------------------------------
// 12. Materia senza evidenza di classe/anno: nessuna presunzione automatica
// ---------------------------------------------------------------------------

test('sostegno: materia diversa senza classe/anno non diventa automaticamente pertinente', () => {
  const item = { title: 'Corso di matematica riservato ai docenti di matematica', subject: 'matematica' };
  const evaluation = evaluateItemRelevance(item, supportProfile);
  assert.equal(evaluation.relevance, 'ROSSO');
  assert.match(evaluation.relevanceReason, /altra materia/i);
});

// ---------------------------------------------------------------------------
// 13. Classe completa pertinente / non pertinente
// ---------------------------------------------------------------------------

test('sostegno: classe completa assegnata è pertinente anche con materia diversa', () => {
  const evaluation = evaluateItemRelevance(
    { title: 'Verifica di matematica - classe 3E', subject: 'matematica' },
    supportProfile,
  );
  assert.equal(evaluation.relevance, 'VERDE');
  assert.match(evaluation.relevanceReason, /3E/);
  assert.doesNotMatch(evaluation.relevanceReason, /altra materia/i);
});

test('sostegno: classe non assegnata resta ROSSO', () => {
  const evaluation = evaluateItemRelevance(
    { title: 'Verifica di matematica - classe 2B', subject: 'matematica' },
    supportProfile,
  );
  assert.equal(evaluation.relevance, 'ROSSO');
  assert.match(evaluation.relevanceReason, /non assegnate al docente/);
});

// ---------------------------------------------------------------------------
// 14. Docente curricolare invariato
// ---------------------------------------------------------------------------

test('curricolare: stessa classe ma materia diversa resta ROSSO (comportamento precedente)', () => {
  const evaluation = evaluateItemRelevance(
    { title: 'Verifica di matematica - classe 3E', subject: 'matematica' },
    curricularProfile,
  );
  assert.equal(evaluation.relevance, 'ROSSO');
  assert.match(evaluation.relevanceReason, /altra materia/i);
});

// ---------------------------------------------------------------------------
// 16. Ulteriori casi suggeriti: più anni, filtri rispettati, ordine scolastico
// ---------------------------------------------------------------------------

test('sostegno: un solo anno pertinente produce un motivo al singolare', () => {
  const evaluation = evaluateItemRelevance(
    { title: 'Progetto scientifico', subject: 'matematica', notes: 'Destinato alle classi terze.' },
    supportProfile,
  );
  assert.equal(evaluation.relevance, 'VERDE');
  assert.match(evaluation.relevanceReason, /3° anno/);
});

test('sostegno: i filtri di ordine scolastico restano attivi (non bypassati dalla regola sostegno)', () => {
  const evaluation = evaluateItemRelevance(
    { title: 'Riunione', notes: 'Riservato alla scuola primaria, classi III.' },
    supportProfile,
  );
  assert.equal(evaluation.relevance, 'ROSSO');
  assert.equal(evaluation.relevanceReason, 'Destinato a un altro ordine scolastico.');
});
