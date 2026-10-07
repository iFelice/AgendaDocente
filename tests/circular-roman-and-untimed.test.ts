import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExtractedItems, extractedItemError } from '../src/utils/circularParser';
import { evaluateItemRelevance, extractClassesFromText, extractGradesFromText } from '../src/utils/circularRelevance';
import { convertExtractedItemToEvent } from '../src/services/storage';
import type { TeacherProfile, ExtractedItem } from '../src/types';

// Synthetic profile: no school document, no personal data.
const profile: TeacherProfile = {
  id: 'test', fullName: 'Test', schoolName: 'Test', schoolYear: '2026/2027', schoolLevel: 'ssig',
  primarySubjects: ['Matematica'], classes: ['3E', '3D', '1C'], campuses: [], roles: [],
};

test('Roman year without section never becomes an invented class', () => {
  // "IV" must not be split into Roman "I" + section "V".
  for (const text of ['classi IV', 'classe IV', 'L\'attività è destinata alle classi IV', 'IV']) {
    assert.deepEqual(extractClassesFromText(text).filter(c => c === '1V' || c === '4V'), []);
  }
  assert.deepEqual(extractClassesFromText('classi IV'), []);
  assert.deepEqual(extractGradesFromText('classi IV'), [4]);
  assert.deepEqual(extractGradesFromText('classe I'), [1]);
  assert.deepEqual(extractGradesFromText('classi II'), [2]);
  assert.deepEqual(extractGradesFromText('classe III'), [3]);
  assert.deepEqual(extractGradesFromText('classi V'), [5]);
  // Italian wording keeps working.
  assert.deepEqual(extractGradesFromText('classi prime'), [1]);
  assert.deepEqual(extractGradesFromText('classi quarte'), [4]);
});

test('Roman classes with a real section keep working', () => {
  assert.deepEqual(extractClassesFromText('classe III E'), ['3E']);
  assert.deepEqual(extractClassesFromText('II D'), ['2D']);
  assert.deepEqual(extractClassesFromText('I D'), ['1D']);
  assert.deepEqual(extractClassesFromText('classi IV B'), ['4B']);
  assert.deepEqual(extractClassesFromText('1D'), ['1D']);
  assert.deepEqual(extractClassesFromText('classe 3E'), ['3E']);
});

test('document evidence beats a hallucinated AI className (real screenshot case)', () => {
  const raw = {
    title: 'Svolgimento Giochi Matematici di Prisma (divieto uscite didattiche)',
    date: '2026-11-26', className: '1V',
    rawSnippet: "Il primo appuntamento è fissato per il 26 novembre 2026, l'attività riguarda le classi IV",
  };
  const [item] = normalizeExtractedItems([raw], profile);
  assert.equal(item.className, '');
  const evaluation = evaluateItemRelevance(raw, profile);
  assert.deepEqual(evaluation.detectedClasses, []);
  assert.equal(evaluation.relevance, 'ROSSO');
  assert.equal(evaluation.relevanceReason, 'Destinato a un altro anno di corso.');
  assert.doesNotMatch(item.relevanceReason, /1V|4V|non assegnate/);
  // The AI class is only a fallback: with no document evidence it is still usable.
  assert.deepEqual(evaluateItemRelevance({ title: 'Riunione', className: '2B' }, profile).detectedClasses, ['2B']);
});

test('new circular events keep user notes but do not save the relevance reason as notes', () => {
  const item: ExtractedItem = {
    tempId: 'notes-1', title: 'Riunione', category: 'riunione', date: '2026-11-26',
    relevance: 'VERDE', relevanceReason: 'Destinato a tutti i docenti.', selectedForImport: true,
  };
  const withoutNotes = convertExtractedItemToEvent(item, 'Circolare sintetica', 'synthetic-notes');
  assert.equal(withoutNotes.notes, undefined);

  const userNotes = 'Portare il registro elettronico.';
  const withNotes = convertExtractedItemToEvent({ ...item, notes: userNotes }, 'Circolare sintetica', 'synthetic-notes');
  assert.equal(withNotes.notes, userNotes);
});

test('an untimed circular item is valid and becomes an all-day event', () => {
  const item: ExtractedItem = {
    tempId: 'untimed-1', title: 'Svolgimento Giochi Matematici di Prisma (divieto uscite didattiche)',
    category: 'riunione', date: '2026-11-26', startTime: undefined, endTime: undefined,
    isDeadline: false, relevance: 'VERDE', relevanceReason: 'Destinato a tutti i docenti.', selectedForImport: true,
  };
  assert.equal(extractedItemError(item), null);
  const event = convertExtractedItemToEvent(item, 'Circolare sintetica', 'synthetic-untimed');
  assert.equal(event.isAllDay, true);
  assert.equal(event.startTime, undefined);
  assert.equal(event.endTime, undefined);
});

test('partial, complete and reversed intervals keep their own semantics', () => {
  const base = { title: 'Riunione', date: '2026-11-26', isDeadline: false } as const;
  assert.equal(extractedItemError({ ...base, startTime: '09:00', endTime: undefined }),
    "Completa l'ora di inizio e di fine oppure lascia entrambi vuoti.");
  assert.equal(extractedItemError({ ...base, startTime: undefined, endTime: '11:00' }),
    "Completa l'ora di inizio e di fine oppure lascia entrambi vuoti.");
  assert.equal(extractedItemError({ ...base, startTime: '09:00', endTime: '11:00' }), null);
  assert.equal(extractedItemError({ ...base, startTime: '11:00', endTime: '09:00' }),
    "L'ora di fine deve essere successiva all'ora di inizio.");
  assert.equal(extractedItemError({ ...base, date: '2026-13-01' }), 'Inserisci una data valida.');
  const timed = convertExtractedItemToEvent({
    tempId: 'timed-1', ...base, category: 'riunione', startTime: '09:00', endTime: '11:00',
    relevance: 'VERDE', relevanceReason: '', selectedForImport: true,
  }, 'Circolare sintetica', 'synthetic-timed');
  assert.equal(timed.isAllDay, false);
});

test('a green untimed item can still be auto-selected, a half-timed one cannot', () => {
  const [untimed] = normalizeExtractedItems([{
    title: 'Collegio docenti', category: 'collegio_docenti', date: '2026-11-26',
  }], profile);
  assert.equal(untimed.relevance, 'VERDE');
  assert.equal(untimed.selectedForImport, true);
  const [halfTimed] = normalizeExtractedItems([{
    title: 'Collegio docenti', category: 'collegio_docenti', date: '2026-11-26',
    startTime: '09:00', rawSnippet: 'Collegio docenti ore 09:00',
  }], profile);
  assert.equal(halfTimed.endTime, undefined);
  assert.equal(halfTimed.selectedForImport, false);
});
