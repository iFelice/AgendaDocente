import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSubjects, detectSubjectSigle, evaluateItemRelevance } from '../src/utils/circularRelevance';
import type { TeacherProfile } from '../src/types';

/*
 * Caso reale (piano annuale delle attività, tabella DATA | DOCENTI | ATTIVITÀ | ORARI):
 *   14/12/2026 | SSIG ITA-L2-ARTE-IRC-SOS            | COLLOQUI | 15:00/18:15
 *   15/12/2026 | SSIG MAT-TEC- MUS-SM / STRUMENTO MUSICALE | COLLOQUI | 15:00/18:15 e 09.45/13.00
 *   02/12/2026 | PRIMARIA                             | COLLOQUI 1A-2A-3A-4A-5A | 17.00/20.15
 * Difetti osservati: (a) "SOS" non riconosciuto per un docente di sostegno;
 * (b) orari scritti con la barra o col punto non letti (coperti nei test sugli orari).
 */

const supportProfile: TeacherProfile = {
  id: 'support', fullName: 'Prof. Sostegno', schoolName: 'Test', schoolYear: '2026/2027',
  schoolLevel: 'ssig', isSupportTeacher: true, primarySubjects: ['Sostegno Didattico'],
  classes: ['3E', '3D', '1C'], campuses: [], roles: [],
};

const mathProfile: TeacherProfile = {
  id: 'math', fullName: 'Prof. Matematica', schoolName: 'Test', schoolYear: '2026/2027',
  schoolLevel: 'ssig', isSupportTeacher: false, primarySubjects: ['Matematica'],
  classes: ['3E', '3D', '1C'], campuses: [], roles: [],
};

const ROW_14_12 = '14/12/2026 | SSIG ITA-L2-ARTE-IRC-SOS | COLLOQUI | 15:00/18:15';
const ROW_15_12 = '15/12/2026 | SSIG MAT-TEC- MUS-SM / STRUMENTO MUSICALE | COLLOQUI | 15:00/18:15 e 09.45/13.00';
const ROW_02_12 = '02/12/2026 | PRIMARIA | COLLOQUI 1A-2A-3A-4A-5A | 17.00/20.15';

// ---------------------------------------------------------------------------
// Sigle delle materie: riconosciute SOLO in maiuscolo, isolate o in elenco
// ---------------------------------------------------------------------------

test('sigle maiuscole isolate o in elenco diventano materie (ITA-L2-ARTE-IRC-SOS, MAT-TEC- MUS-SM)', () => {
  assert.deepEqual(
    [...detectSubjects('SSIG ITA-L2-ARTE-IRC-SOS')].sort(),
    ['arte', 'francese', 'inglese', 'italiano', 'lingue straniere', 'religione', 'sostegno', 'spagnolo', 'tedesco'],
  );
  // Spazi irregolari attorno ai separatori: "MAT-TEC- MUS-SM" resta un elenco.
  assert.deepEqual(
    [...detectSubjects('MAT-TEC- MUS-SM')].sort(),
    ['matematica', 'musica', 'scienze motorie', 'tecnologia'],
  );
  assert.deepEqual(detectSubjects('STRUMENTO MUSICALE'), ['strumento musicale']);
  assert.deepEqual(detectSubjects('STRUM e IRC').sort(), ['religione', 'strumento musicale']);
});

test('sigle minuscole o dentro parole NON vengono riconosciute; "arte" resta valida come parola intera', () => {
  assert.deepEqual(detectSubjects('sos'), []);
  assert.deepEqual(detectSubjects('progetto sos'), []);
  assert.deepEqual(detectSubjects('La sospensione delle lezioni'), []);
  assert.deepEqual(detectSubjects('gita in italia'), []);
  assert.deepEqual(detectSubjects('ITALIA'), []);
  assert.deepEqual(detectSubjects('MUSICA e SCIENZE').sort(), ['musica', 'scienze']);
  // "arte" come parola intera resta riconosciuta, in qualsiasi casing.
  assert.deepEqual(detectSubjects('laboratorio di arte'), ['arte']);
  assert.deepEqual(detectSubjects('ARTE'), ['arte']);
});

test('detectSubjectSigle riporta sigla, etichetta e materie di espansione (L2 -> lingue straniere)', () => {
  const sigle = detectSubjectSigle('MAT-TEC- MUS-SM / STRUMENTO MUSICALE');
  assert.deepEqual(sigle.map(s => s.sigla), ['MAT', 'TEC', 'MUS', 'SM']);
  const l2 = detectSubjectSigle('SSIG ITA-L2')[1];
  assert.equal(l2.sigla, 'L2');
  assert.equal(l2.label, 'lingue straniere');
  assert.ok(l2.subjects.includes('inglese') && l2.subjects.includes('tedesco'));
  assert.equal(detectSubjectSigle('sospensione').length, 0);
  assert.equal(detectSubjectSigle('').length, 0);
});

test('la materia del docente prevale sul campo subject scritto a sigle', () => {
  // Il modello può riportare l'elenco di sigle della colonna DOCENTI in subject.
  const evaluation = evaluateItemRelevance({ title: 'Colloqui', subject: 'ITA-L2-ARTE-IRC-SOS' }, supportProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.match(evaluation.relevanceReason, /SOS \(sostegno\)/);
});

test('un docente di lingua è pertinente a una riga L2 (lingue straniere)', () => {
  const englishProfile: TeacherProfile = { ...mathProfile, primarySubjects: ['Inglese'] };
  const evaluation = evaluateItemRelevance({ title: 'Colloqui', rawSnippet: 'SSIG ITA-L2 | COLLOQUI' }, englishProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.match(evaluation.relevanceReason, /L2 \(lingue straniere\)/);
  const notRelevant = evaluateItemRelevance({ title: 'Colloqui', rawSnippet: 'SSIG MAT-SM | COLLOQUI' }, englishProfile);
  assert.equal(notRelevant.relevance, 'ROSSO');
});

// ---------------------------------------------------------------------------
// Le tre righe del caso reale: pertinenza per il profilo (orari nei test dedicati)
// ---------------------------------------------------------------------------

test('caso reale, profilo sostegno SSIG 3E/3D/1C: 14/12 pertinente, 15/12 altra materia, 02/12 altro ordine', () => {
  const r14 = evaluateItemRelevance({ title: 'COLLOQUI', rawSnippet: ROW_14_12 }, supportProfile);
  assert.equal(r14.relevance, 'VERDE');
  assert.equal(r14.selectedForImport, true);
  assert.match(r14.relevanceReason, /SOS \(sostegno\)/);
  assert.doesNotMatch(r14.relevanceReason, /altra materia/i);

  const r15 = evaluateItemRelevance({ title: 'COLLOQUI', notes: 'Altro intervallo: 09.45/13.00.', rawSnippet: ROW_15_12 }, supportProfile);
  assert.equal(r15.relevance, 'ROSSO');
  assert.equal(r15.selectedForImport, false);
  assert.match(r15.relevanceReason, /altra materia/i);
  assert.match(r15.relevanceReason, /MAT \(matematica\)/);
  assert.match(r15.relevanceReason, /SM \(scienze motorie\)/);

  const r02 = evaluateItemRelevance({ title: 'COLLOQUI 1A-2A-3A-4A-5A', rawSnippet: ROW_02_12 }, supportProfile);
  assert.equal(r02.relevance, 'ROSSO');
  assert.equal(r02.relevanceReason, 'Destinato a un altro ordine scolastico.');
});

test('caso reale, profilo matematica: 15/12 pertinente (MAT), 14/12 non pertinente', () => {
  const r15 = evaluateItemRelevance({ title: 'COLLOQUI', rawSnippet: ROW_15_12 }, mathProfile);
  assert.equal(r15.relevance, 'VERDE');
  assert.equal(r15.selectedForImport, true);
  assert.match(r15.relevanceReason, /MAT \(matematica\)/);

  const r14 = evaluateItemRelevance({ title: 'COLLOQUI', rawSnippet: ROW_14_12 }, mathProfile);
  assert.equal(r14.relevance, 'ROSSO');
  assert.equal(r14.selectedForImport, false);
  assert.match(r14.relevanceReason, /altra materia/i);
  assert.match(r14.relevanceReason, /ITA \(italiano\)/);
});

test('DOCENTI finita nel campo location del modello: ordine di scuola e materia restano letti', () => {
  // Il modello può smistare la colonna DOCENTI in location (unico campo testivo
  // fuori dall'evidenza): il riconoscimento la include senza per questo leggere
  // classi da un luogo ("Aula Magna" non genera classi né materie).
  const evaluation = evaluateItemRelevance({ title: 'Colloqui', location: 'SSIG ITA-SOS' }, supportProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.match(evaluation.relevanceReason, /SOS \(sostegno\)/);
  const primaria = evaluateItemRelevance({ title: 'Colloqui', location: 'PRIMARIA' }, supportProfile);
  assert.equal(primaria.relevance, 'ROSSO');
  assert.equal(primaria.relevanceReason, 'Destinato a un altro ordine scolastico.');
  const aula = evaluateItemRelevance({ title: 'Colloqui 3E', location: 'Aula Magna' }, supportProfile);
  assert.equal(aula.relevance, 'VERDE');
  assert.deepEqual(aula.detectedClasses, ['3E']);
});
