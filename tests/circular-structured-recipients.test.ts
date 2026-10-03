import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateItemRelevance,
  normalizeRecipientClasses,
  normalizeRecipientGrades,
  formatRecipientsLabel,
  matchGradesToClasses,
} from '../src/utils/circularRelevance';
import { normalizeExtractedItems } from '../src/utils/circularParser';
import type { TeacherProfile } from '../src/types';

/*
 * Caso reale "Giochi Matematici di Prisma": i destinatari ("classi I e III") sono
 * dichiarati nell'intestazione del documento e NON compaiono né in notes né in
 * rawSnippet dei singoli impegni. Senza i campi strutturati recipientGrades /
 * recipientClasses la pertinenza non riceveva alcuna evidenza e l'evento finiva
 * ROSSO con "Destinato ad altra materia: matematica".
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
// 15. Svolgimento Giochi di Prisma: destinatari solo nel campo strutturato
// ---------------------------------------------------------------------------

test('sostegno: recipientGrades [1,3] rende pertinente lo svolgimento dei Giochi di Prisma', () => {
  const item = {
    title: 'Svolgimento Giochi Matematici di Prisma',
    subject: 'matematica',
    date: '2026-11-26',
    recipientGrades: [1, 3],
    notes: '',
    rawSnippet: 'Il primo appuntamento è fissato per il 26 novembre 2026...',
  };
  assert.deepEqual(matchGradesToClasses(item.recipientGrades, supportProfile.classes), [1, 3]);
  const evaluation = evaluateItemRelevance(item, supportProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.equal(evaluation.selectedForImport, true);
  assert.doesNotMatch(evaluation.relevanceReason, /altra materia/i);
  assert.match(evaluation.relevanceReason, /1°.*3°|3°.*1°/);
});

// ---------------------------------------------------------------------------
// 16. Versamento quota d'iscrizione: stessa attività, stessi destinatari
// ---------------------------------------------------------------------------

test("sostegno: la scadenza della quota d'iscrizione eredita i destinatari dell'attività", () => {
  const item = {
    title: "Versamento quota d'iscrizione e compilazione modulo Giochi di Prisma",
    subject: 'matematica',
    date: '2026-10-14',
    recipientGrades: [1, 3],
    notes: '',
    rawSnippet: 'Entro il 14 ottobre 2026 versamento della quota.',
  };
  const evaluation = evaluateItemRelevance(item, supportProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.equal(evaluation.selectedForImport, true);
  assert.doesNotMatch(evaluation.relevanceReason, /altra materia/i);
});

// ---------------------------------------------------------------------------
// 7-8. Gerarchia e unione delle evidenze
// ---------------------------------------------------------------------------

test('i destinatari strutturati prevalgono sul className del modello', () => {
  const evaluation = evaluateItemRelevance({
    title: 'Giochi Matematici di Prisma',
    subject: 'matematica',
    className: '1V',
    recipientGrades: [1, 3],
  }, supportProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.ok(!evaluation.detectedClasses.includes('1V'));
});

test('recipientGrades e anni ricavati dal testo si uniscono senza duplicati', () => {
  const evaluation = evaluateItemRelevance({
    title: 'Giochi Matematici di Prisma',
    subject: 'matematica',
    recipientGrades: [1, 3],
    rawSnippet: 'Attività rivolta alle classi III.',
  }, supportProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.match(evaluation.relevanceReason, /1°.*3°|3°.*1°/);
});

test('recipientClasses è evidenza esplicita di classe completa', () => {
  const evaluation = evaluateItemRelevance({
    title: 'Giochi Matematici di Prisma', subject: 'matematica', recipientClasses: ['3E'],
  }, supportProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.match(evaluation.relevanceReason, /3E/);
  assert.deepEqual(evaluation.detectedClasses, ['3E']);
});

// ---------------------------------------------------------------------------
// 12. Non rendere tutto pertinente
// ---------------------------------------------------------------------------

test('recipientGrades di un altro anno resta ROSSO', () => {
  const evaluation = evaluateItemRelevance({ title: 'Progetto', subject: 'matematica', recipientGrades: [2] }, supportProfile);
  assert.equal(evaluation.relevance, 'ROSSO');
  assert.equal(evaluation.relevanceReason, 'Destinato a un altro anno di corso.');
});

test('recipientClasses non assegnata resta ROSSO', () => {
  const evaluation = evaluateItemRelevance({ title: 'Progetto', subject: 'matematica', recipientClasses: ['2B'] }, supportProfile);
  assert.equal(evaluation.relevance, 'ROSSO');
  assert.match(evaluation.relevanceReason, /non assegnate al docente/);
});

test('curricolare: il filtro materia resta invariato anche con destinatari strutturati', () => {
  const evaluation = evaluateItemRelevance({ title: 'Gara', subject: 'matematica', recipientGrades: [3] }, curricularProfile);
  assert.equal(evaluation.relevance, 'ROSSO');
  assert.match(evaluation.relevanceReason, /altra materia/i);
});

// ---------------------------------------------------------------------------
// 17. Normalizzazione dei campi strutturati
// ---------------------------------------------------------------------------

test('normalizeRecipientGrades filtra, deduplica e ordina', () => {
  assert.deepEqual(normalizeRecipientGrades([3, 1, 3, 8, 0]), [1, 3]);
  assert.deepEqual(normalizeRecipientGrades([2.5, -1, 'x', null, 4]), [4]);
  assert.deepEqual(normalizeRecipientGrades('classi I e III'), []);
  assert.deepEqual(normalizeRecipientGrades(undefined), []);
});

test('normalizeRecipientClasses accetta solo classi complete e deduplica', () => {
  assert.deepEqual(normalizeRecipientClasses(['3E', '3 E', 'III E']), ['3E']);
  assert.deepEqual(normalizeRecipientClasses(['3D', '1C']), ['3D', '1C']);
  // Anni romani isolati non sono classi; una sezione V reale invece resta valida.
  assert.deepEqual(normalizeRecipientClasses(['IV', 'I', 'III']), []);
  assert.deepEqual(normalizeRecipientClasses(['1V', '2V', 'III V']), ['1V', '2V', '3V']);
  assert.deepEqual(normalizeRecipientClasses([42, '', null]), []);
});

test('normalizeExtractedItems normalizza i destinatari strutturati', () => {
  const [item] = normalizeExtractedItems([{
    title: 'Svolgimento Giochi Matematici di Prisma',
    category: 'riunione', date: '2026-11-26', subject: 'matematica',
    recipientGrades: [3, 1, 3, 8, 0], recipientClasses: ['III E', '3E', 'IV'],
  }], supportProfile);
  assert.deepEqual(item.recipientGrades, [1, 3]);
  assert.deepEqual(item.recipientClasses, ['3E']);
  assert.equal(item.relevance, 'VERDE');
});

// ---------------------------------------------------------------------------
// 14. Etichetta UI dei destinatari rilevati
// ---------------------------------------------------------------------------

test('formatRecipientsLabel produce etichette leggibili', () => {
  assert.equal(formatRecipientsLabel({ recipientGrades: [1, 3] }), 'classi I e III');
  assert.equal(formatRecipientsLabel({ recipientClasses: ['3E', '1C'] }), '3E, 1C');
  assert.equal(formatRecipientsLabel({}), null);
});

// ---------------------------------------------------------------------------
// 18. Regressione PR #46: un anno di corso non genera mai una sigla di classe
// ---------------------------------------------------------------------------

test("recipientGrades [4] non produce automaticamente le sigle 1V o 4V", () => {
  const evaluation = evaluateItemRelevance(
    { title: 'Uscita didattica', notes: 'Riservata alle classi IV.', recipientGrades: [4] },
    supportProfile,
  );
  assert.ok(!evaluation.detectedClasses.includes('1V'));
  assert.ok(!evaluation.detectedClasses.includes('4V'));
  assert.deepEqual(evaluation.detectedClasses, []);
  // Il docente non ha classi del quarto anno: resta ROSSO per annualità.
  assert.equal(evaluation.relevance, 'ROSSO');
  assert.equal(evaluation.relevanceReason, 'Destinato a un altro anno di corso.');
});
