import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExtractedItems, normalizeDateISO, extractedItemError } from '../src/utils/circularParser';
import type { TeacherProfile } from '../src/types';

const profile: TeacherProfile = {
  id: 'test',
  fullName: 'Test',
  schoolName: 'Test',
  schoolYear: '2026/2027',
  schoolLevel: 'ssig',
  primarySubjects: ['Matematica'],
  classes: ['1A', '2A'],
  campuses: ['Centrale'],
  roles: [],
};

test('normalizeDateISO handles standard ISO and varied Italian formats', () => {
  // ISO
  assert.equal(normalizeDateISO('2026-09-04', profile), '2026-09-04');
  // Italian slashes
  assert.equal(normalizeDateISO('04/09/2026', profile), '2026-09-04');
  assert.equal(normalizeDateISO('4/9/2026', profile), '2026-09-04');
  assert.equal(normalizeDateISO('04/09/26', profile), '2026-09-04');
  // Italian dots and dashes
  assert.equal(normalizeDateISO('04.09.2026', profile), '2026-09-04');
  assert.equal(normalizeDateISO('04-09-2026', profile), '2026-09-04');
  // ISO slash
  assert.equal(normalizeDateISO('2026/09/04', profile), '2026-09-04');
  // Textual Italian dates
  assert.equal(normalizeDateISO('4 settembre 2026', profile), '2026-09-04');
  assert.equal(normalizeDateISO('4 settembre', profile), '2026-09-04');
  assert.equal(normalizeDateISO('15 ottobre', profile), '2026-10-15');
  assert.equal(normalizeDateISO('20 gennaio', profile), '2027-01-20');
  // Fallback text
  assert.equal(normalizeDateISO('', profile, 'Riunione fissata per il 12/11/2026 in aula'), '2026-11-12');
  assert.equal(normalizeDateISO(undefined, profile, 'Consiglio del 3 dicembre 2026'), '2026-12-03');
  // Invalid
  assert.equal(normalizeDateISO('non una data', profile), '');
});

test('normalizeExtractedItems normalizes Italian dates, Italian field keys and preserves model times', () => {
  const rawList = [
    {
      // Italian key aliases and Italian date format
      titolo: 'Consiglio di Classe 1A',
      categoria: 'consiglio_classe',
      data: '15/10/2026',
      oraInizio: '15:30',
      oraFine: '16:30',
      classe: '1A',
      luogo: 'Aula Magna',
      note: 'Docenti della classe 1A',
      rawSnippet: '15/10/2026 Consiglio 1A',
    },
    {
      // AI model returned valid times but snippet did not repeat the interval
      title: 'Collegio Docenti Unitario',
      category: 'collegio_docenti',
      date: '02.09.2026',
      startTime: '09:00',
      endTime: '12:00',
      rawSnippet: 'Tutti i docenti sono convocati per il Collegio Docenti Unitario',
    },
    {
      // AI model combined orario string
      title: 'Dipartimento Disciplinare',
      category: 'dipartimento',
      date: '2026-09-10',
      orario: '14:30 - 16:30',
      subject: 'Matematica',
    },
    {
      // Scadenza with Italian date
      titolo: 'Consegna programmazioni',
      scadenza: '30/10/2026',
      isDeadline: true,
    },
  ];

  const items = normalizeExtractedItems(rawList, profile);
  assert.equal(items.length, 4);

  // Item 0
  assert.equal(items[0].title, 'Consiglio di Classe 1A');
  assert.equal(items[0].date, '2026-10-15');
  assert.equal(items[0].startTime, '15:30');
  assert.equal(items[0].endTime, '16:30');
  assert.equal(items[0].className, '1A');
  assert.equal(items[0].location, 'Aula Magna');
  assert.equal(items[0].relevance, 'VERDE');
  assert.equal(items[0].selectedForImport, true);
  assert.equal(extractedItemError(items[0]), null);

  // Item 1
  assert.equal(items[1].title, 'Collegio Docenti Unitario');
  assert.equal(items[1].date, '2026-09-02');
  assert.equal(items[1].startTime, '09:00');
  assert.equal(items[1].endTime, '12:00');
  assert.equal(items[1].relevance, 'VERDE');
  assert.equal(items[1].selectedForImport, true);
  assert.equal(extractedItemError(items[1]), null);

  // Item 2
  assert.equal(items[2].title, 'Dipartimento Disciplinare');
  assert.equal(items[2].date, '2026-09-10');
  assert.equal(items[2].startTime, '14:30');
  assert.equal(items[2].endTime, '16:30');
  assert.equal(items[2].subject, 'Matematica');
  assert.equal(extractedItemError(items[2]), null);

  // Item 3
  assert.equal(items[3].title, 'Consegna programmazioni');
  assert.equal(items[3].date, '2026-10-30');
  assert.equal(items[3].deadlineDate, '2026-10-30');
  assert.equal(items[3].isDeadline, true);
  assert.equal(extractedItemError(items[3]), null);
});
