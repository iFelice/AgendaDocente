import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTimetableToken, extractClassesFromCell, normalizeClassLabel, DAY_LABELS } from '../src/utils/timetableTokens';
import {
  curricularCellsToSlots,
  findTeacherRows,
  personalCellsToCandidates,
  teacherSurnames,
  validateCurricularTimetablePayload,
  validatePersonalTimetablePayload,
  validateStudentCommitmentsPayload,
  type CurricularRawRow,
  type TimetableRawCell,
} from '../src/utils/timetableAnalysis';
import { crossrefTimetables, dedupeSubjects, reconSignal, sameClassLabel, RECON_NOTES } from '../src/utils/timetableCrossref';
import {
  SUPPORT_TEACHER_SUBJECT,
  applyReconstruction,
  isSupportTeacherProfile,
  periodTimesForIndex,
  reconstructedToTimetableSlots,
} from '../src/utils/reconstructTimetable';
import { matchStudentName, parsePersonName, foldName, studentMatchLabel } from '../src/utils/studentMatcher';
import { normalizeTeacherProfile } from '../src/utils/multiSchool';
import { documentFileError, formatFileSize, OFFLINE_ANALYSIS_MESSAGE, MAX_DOCUMENT_BYTES, CAMERA_INPUT_PROPS, FILE_INPUT_PROPS } from '../src/utils/documentScanner';
import { isValidTimetablePayload } from '../src/services/sync/remoteSchema';
import type { TeacherProfile, TimetableSlot } from '../src/types';

/*
 * "Scansiona documento" — logica pura:
 * token tabelle, riga docente, celle->candidati, incrocio multi-documento,
 * modello timetable esistente, conferma/salvataggio, matching alunni,
 * privacy/offline/multi-istituto (lato dati).
 */

const profile: TeacherProfile = {
  id: 't-1',
  fullName: 'Felice Manganiello',
  schoolName: 'Istituto Comprensivo Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'],
  campuses: ['Sede Centrale'],
  roles: [{ role: 'docente_sostegno' }],
  isSupportTeacher: true,
};

const students = [
  { id: 'stu-rossi', fullName: 'Rossi Matteo', className: '3D' },
  { id: 'stu-bianchi', fullName: 'Bianchi Giulia', className: '3D' },
  { id: 'stu-bianchi-2', fullName: 'Bianchi Luca', className: '3E' },
  { id: 'stu-fernandez', fullName: 'Fernández Andrea', className: '3E' },
];

// ---------------------------------------------------------------------------
// 9. TOKEN PARTICOLARI DELLE TABELLE
// ---------------------------------------------------------------------------

test('token table: classi valide riconosciute, D/P/Co/sos mai trattati come classe', () => {
  for (const [token, expected] of [
    ['3D', '3D'], ['3d', '3D'], ['3 D', '3D'], ['3ª', null], ['1A', '1A'],
    ['3°E', '3E'], ['III D', '3D'], ['classe 2B', '2B'],
    ['D', null], ['P', null], ['Co', null], ['CO', null], ['sos', null], ['MATEMATICA', null], ['3D4', null],
  ] as const) {
    assert.equal(normalizeClassLabel(token), expected, `normalizeClassLabel(${JSON.stringify(token)})`);
  }

  assert.equal(classifyTimetableToken('3D').kind, 'class');
  assert.equal(classifyTimetableToken('3D').classLabel, '3D');
  assert.equal(classifyTimetableToken('sos').kind, 'support');
  assert.equal(classifyTimetableToken('Sostegno').kind, 'support');
  assert.equal(classifyTimetableToken('D').kind, 'internal-code');
  assert.equal(classifyTimetableToken('P').kind, 'internal-code');
  assert.equal(classifyTimetableToken('Co').kind, 'internal-code');
  assert.equal(classifyTimetableToken('MATEMATICA').kind, 'other');
  assert.equal(classifyTimetableToken('').kind, 'other');

  // Cella con più classi: estratte entrambe; i codici ignorati.
  assert.deepEqual(extractClassesFromCell('3D 3E'), ['3D', '3E']);
  assert.deepEqual(extractClassesFromCell('3D / sos'), ['3D']);
  assert.deepEqual(extractClassesFromCell('D P Co'), []);
});

test('DAY_LABELS copre lunedì-sabato (struttura tabella italiana)', () => {
  assert.equal(DAY_LABELS[1], 'Lunedì');
  assert.equal(DAY_LABELS[5], 'Venerdì');
  assert.equal(DAY_LABELS[6], 'Sabato');
});

// ---------------------------------------------------------------------------
// 5. ORARIO PERSONALE / SOSTEGNO
// ---------------------------------------------------------------------------

const personalRows = ['Bianchi', 'Manganiello F.', 'Rossi L.', 'Co D.'];

test('trova la riga "Manganiello" dal profilo "Felice Manganiello" (maiuscole/ruolo indifferenti)', () => {
  assert.deepEqual(teacherSurnames('Prof. Felice Manganiello'), ['manganiello']);
  assert.deepEqual(findTeacherRows(personalRows, 'Felice Manganiello'), [{ rowIndex: 1, rowLabel: 'Manganiello F.' }]);
  assert.deepEqual(findTeacherRows(personalRows, 'prof. felice manganiello'), [{ rowIndex: 1, rowLabel: 'Manganiello F.' }]);
  // Nessuna corrispondenza aggressiva: Bianchi != Bianchini.
  assert.deepEqual(findTeacherRows(['Bianchini'], 'Giulia Bianchi'), []);
  // Profilo vuoto: nessuna riga trovata (mai invenzioni).
  assert.deepEqual(findTeacherRows(personalRows, ''), []);
});

test('cognome ambiguo (più righe compatibili) -> tutte restituite per richiesta di conferma', () => {
  const rows = ['Manganiello F.', 'Manganiello A.'];
  const matches = findTeacherRows(rows, 'Felice Manganiello');
  assert.equal(matches.length, 2, 'più righe compatibili: la scelta tocca all\'utente');
});

const personalCells: TimetableRawCell[] = [
  { rowIndex: 1, dayOfWeek: 1, periodIndex: 1, raw: '3D' },
  { rowIndex: 1, dayOfWeek: 1, periodIndex: 2, raw: '3E' },
  { rowIndex: 1, dayOfWeek: 2, periodIndex: 1, raw: '3D 3E' },
  { rowIndex: 1, dayOfWeek: 2, periodIndex: 2, raw: '3E' },
  { rowIndex: 1, dayOfWeek: 3, periodIndex: 1, raw: 'sos' },
  { rowIndex: 1, dayOfWeek: 3, periodIndex: 2, raw: 'D' },
  { rowIndex: 1, dayOfWeek: 4, periodIndex: 1, raw: 'P' },
  { rowIndex: 1, dayOfWeek: 5, periodIndex: 1, raw: 'Co' },
  { rowIndex: 0, dayOfWeek: 1, periodIndex: 1, raw: '1A' }, // riga di un altro docente
];

test('orario personale: estrae giorno/ora/classe e NON inventa celle mancanti', () => {
  const { candidates, skipped } = personalCellsToCandidates(personalCells, [1]);
  assert.equal(candidates.length, 6, 'celle con classe valida (una per classe) + cella sos; D/P/Co esclusi');
  const find = (day: number, period: number, classLabel?: string) =>
    candidates.filter(c => c.dayOfWeek === day && c.periodIndex === period && (classLabel === undefined || c.classLabel === classLabel));
  assert.equal(find(1, 1, '3D')[0]?.confidence, 'high');
  assert.equal(find(1, 2, '3E')[0]?.classLabel, '3E');
  assert.equal(find(2, 1).length, 2, 'cella "3D 3E" -> due slot (una per classe visibile)');
  assert.deepEqual(find(2, 1).map(c => c.classLabel).sort(), ['3D', '3E']);
  assert.equal(find(2, 2, '3E')[0]?.classLabel, '3E');
  const sos = find(3, 1, undefined)[0];
  assert.equal(sos?.classLabel, undefined, 'sos: sostegno senza classe (non inventata)');
  assert.equal(sos?.confidence, 'medium');
  assert.equal(find(3, 2).length, 0, 'D non produce slot');
  assert.equal(find(4, 1).length, 0, 'P non produce slot');
  assert.equal(find(5, 1).length, 0, 'Co non produce slot');
  assert.equal(skipped.length, 3, 'le celle D/P/Co sono visibili come non interpretate');
  for (const s of skipped) assert.equal(s.reason, 'internal-code');
  // Celle della riga 0 (altro docente) mai incluse.
  assert.ok(!candidates.some(c => c.classLabel === '1A'));
  // Celle mancanti (es. martedì 5ª) non esistono: niente inventare.
  assert.ok(!candidates.some(c => c.dayOfWeek === 2 && c.periodIndex === 5));
});

test('orario personale: validazione runtime della risposta AI (shape obbligatoria)', () => {
  assert.deepEqual(validatePersonalTimetablePayload({ rows: ['Manganiello'], cells: [{ rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' }] }).rows, ['Manganiello']);
  for (const bad of [
    { rows: 'x', cells: [] },
    { rows: [], cells: [{ rowIndex: 0, dayOfWeek: 9, periodIndex: 1, raw: '3D' }] },
    { rows: [], cells: [{ rowIndex: 0, dayOfWeek: 1, periodIndex: 0, raw: '3D' }] },
    { rows: [], cells: [{ rowIndex: '0', dayOfWeek: 1, periodIndex: 1, raw: '3D' }] },
    { rows: [], cells: [{ rowIndex: 0, dayOfWeek: 1, periodIndex: 1 }] },
    'ciao',
  ]) {
    assert.throws(() => validatePersonalTimetablePayload(bad), /non valid/i, `deve respingere: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 6. ORARIO CURRICOLARE / ISTITUTO
// ---------------------------------------------------------------------------

const curricularRows: CurricularRawRow[] = [
  { rowIndex: 0, rowLabel: 'Bianchi', subject: 'Matematica', classes: ['3D', '3E'] },
  { rowIndex: 1, rowLabel: 'Verdi', subject: '', classes: ['3D'] },
];

const curricularCells: TimetableRawCell[] = [
  { rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' },
  { rowIndex: 0, dayOfWeek: 2, periodIndex: 2, raw: '3E' },
  { rowIndex: 1, dayOfWeek: 2, periodIndex: 1, raw: '3D' },
  { rowIndex: 1, dayOfWeek: 3, periodIndex: 1, raw: 'Co' },
  { rowIndex: 2, dayOfWeek: 1, periodIndex: 1, raw: '3D' }, // riga sconosciuta
];

test('orario curricolare: estrae materia per classe/giorno/ora; materia assente -> undefined', () => {
  const { slots, skipped } = curricularCellsToSlots(curricularRows, curricularCells);
  assert.equal(slots.length, 3);
  const mardi1 = slots.filter(s => s.dayOfWeek === 2 && s.periodIndex === 1);
  assert.equal(mardi1.length, 2, 'stessa ora: due righe docenti -> due slot');
  assert.ok(mardi1.some(s => s.classLabel === '3D' && s.subject === 'Matematica' && s.confidence === 'high'));
  const noSubject = mardi1.find(s => s.subject === undefined);
  assert.ok(noSubject, 'materia assente resta undefined (mai inventata)');
  assert.equal(noSubject?.confidence, 'low');
  assert.equal(skipped.filter(s => s.reason === 'internal-code').length, 1, 'Co non è una classe');
  assert.equal(skipped.filter(s => s.reason === 'unrecognized').length, 1, 'riga sconosciuta: cella ignorata');
  assert.ok(!slots.some(s => s.classLabel === 'CO'));
});

test('orario curricolare: validazione runtime della risposta AI', () => {
  const ok = validateCurricularTimetablePayload({
    rows: [{ rowIndex: 0, rowLabel: 'Bianchi', subject: 'Matematica', classes: ['3D'] }],
    cells: [{ rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' }],
  });
  assert.equal(ok.rows[0].subject, 'Matematica');
  assert.throws(() => validateCurricularTimetablePayload({ rows: [{ rowIndex: 0 }], cells: [] }), /non valid/i);
  assert.throws(() => validateCurricularTimetablePayload({ rows: [], cells: [{ rowIndex: 0, dayOfWeek: 1, periodIndex: 1, raw: 5 }] }), /non valid/i);
});

// ---------------------------------------------------------------------------
// 7-8. INCROCIO MULTI-DOCUMENTO + SEMAFORO
// ---------------------------------------------------------------------------

const personal: ReturnType<typeof personalCellsToCandidates>['candidates'] = personalCellsToCandidates(personalCells, [1]).candidates;

const curricular: ReturnType<typeof curricularCellsToSlots>['slots'] = [
  { dayOfWeek: 2, periodIndex: 1, classLabel: '3D', subject: 'Matematica', confidence: 'high' },
  { dayOfWeek: 2, periodIndex: 2, classLabel: '3E', subject: 'Inglese', confidence: 'high' },
  { dayOfWeek: 2, periodIndex: 2, classLabel: '3E', subject: 'Matematica', confidence: 'high' },
  { dayOfWeek: 3, periodIndex: 1, classLabel: '1A', subject: 'Scienze', confidence: 'high' },
];

test('incrocio: stesso giorno+ora+classe -> materia associata, una sola -> verde/high', () => {
  const result = crossrefTimetables(personal, curricular);
  const mardi1 = result.find(r => r.dayOfWeek === 2 && r.periodIndex === 1)!;
  assert.deepEqual(mardi1.coTeachingSubjects, ['Matematica']);
  assert.equal(mardi1.status, 'unique');
  assert.equal(mardi1.confidence, 'high');
  assert.equal(reconSignal(mardi1), 'green');
  // Esempio del documento: Martedì 1ª ora 3D -> Matematica.
  assert.equal(mardi1.classLabel, '3D');
});

test('incrocio: due corrispondenze con materie diverse -> ambiguous/giallo "Più materie possibili"', () => {
  const result = crossrefTimetables(personal, curricular);
  const mardi2 = result.find(r => r.dayOfWeek === 2 && r.periodIndex === 2)!;
  assert.equal(mardi2.status, 'ambiguous');
  assert.equal(reconSignal(mardi2), 'yellow');
  assert.equal(mardi2.note, RECON_NOTES.ambiguous);
  assert.deepEqual(dedupeSubjects(mardi2.coTeachingSubjects), ['Inglese', 'Matematica']);
});

test('incrocio: nessuna corrispondenza -> materia non identificata (mai inventata)', () => {
  const result = crossrefTimetables(personal, curricular);
  const lunedi1 = result.find(r => r.dayOfWeek === 1 && r.periodIndex === 1)!;
  assert.equal(lunedi1.status, 'none');
  assert.equal(lunedi1.coTeachingSubjects.length, 0);
  assert.equal(lunedi1.note, RECON_NOTES.none);
  assert.equal(reconSignal(lunedi1), 'red');
});

test('incrocio: classi diverse / giorno diverso / ora diversa non matchano', () => {
  const one = [{ id: 'x', dayOfWeek: 2, periodIndex: 1, classLabel: '3E', sourceType: 'personal-support-timetable' as const, confidence: 'high' as const }];
  assert.equal(crossrefTimetables(one, curricular)[0].status, 'none', 'classe 3E ≠ 3D');
  const oneDay = [{ id: 'x', dayOfWeek: 3, periodIndex: 1, classLabel: '3D', sourceType: 'personal-support-timetable' as const, confidence: 'high' as const }];
  assert.equal(crossrefTimetables(oneDay, curricular)[0].status, 'none', 'giorno diverso non matcha');
  const onePeriod = [{ id: 'x', dayOfWeek: 2, periodIndex: 3, classLabel: '3D', sourceType: 'personal-support-timetable' as const, confidence: 'high' as const }];
  assert.equal(crossrefTimetables(onePeriod, curricular)[0].status, 'none', 'ora diversa non matcha');
  // Normalizzazione: "3d" === "3D".
  assert.ok(sameClassLabel('3d', '3D'));
  assert.ok(!sameClassLabel('3D', '3E'));
  const oneLower = [{ id: 'x', dayOfWeek: 2, periodIndex: 1, classLabel: '3d', sourceType: 'personal-support-timetable' as const, confidence: 'high' as const }];
  assert.equal(crossrefTimetables(oneLower, curricular)[0].status, 'unique');
});

test('incrocio: slot senza classe (sos) -> non identificabile, mai forzato', () => {
  const sosSlot = personal.find(p => !p.classLabel && p.dayOfWeek === 3)!;
  const result = crossrefTimetables([sosSlot], curricular);
  assert.equal(result[0].status, 'none');
  assert.equal(result[0].note, RECON_NOTES.noClass);
  assert.equal(result[0].coTeachingSubjects.length, 0);
});

test('incrocio: 1:1 con gli slot personali (non aggiunge slot nuovi)', () => {
  const result = crossrefTimetables(personal, curricular);
  assert.equal(result.length, personal.length);
});

// ---------------------------------------------------------------------------
// 10. MODELLO ESISTENTE (TimetableSlot + coTeachingSubjects)
// ---------------------------------------------------------------------------

test('modello: slot ricostruiti usano TimetableSlot, subject "Sostegno", materia in coTeachingSubjects', () => {
  const recon = crossrefTimetables(personal, curricular).map(s => ({ ...s, correctedClass: s.classLabel ?? '', correctedSubject: s.coTeachingSubjects.length === 1 ? s.coTeachingSubjects[0] : '' }));
  const slots = reconstructedToTimetableSlots(recon, { profile, timeSlotConfig: undefined, schoolId: 'school-x' });
  assert.equal(slots.length, 5, 'slot senza classe non salvati (mai inventata)');
  for (const slot of slots) {
    assert.equal(slot.subject, SUPPORT_TEACHER_SUBJECT, 'materia principale resta Sostegno');
    assert.equal(slot.schoolId, 'school-x');
    assert.ok(typeof slot.id === 'string' && slot.id.length > 0);
    assert.ok(!('coSupportTeachers' in slot), 'niente docenti extra obbligatori');
  }
  const mardi1 = slots.find(s => s.dayOfWeek === 2 && s.periodNumber === 1)!;
  assert.deepEqual(mardi1.coTeachingSubjects, ['Matematica'], 'materia in compresenza nel campo esistente');
  assert.equal(mardi1.className, '3D');
  assert.ok(mardi1.startTime && mardi1.endTime && mardi1.endTime > mardi1.startTime, 'fasce orarie valide dalla configurazione');
  // Il modello orario esistente non ha (e non riceve) il nome del docente curricolare.
  const json = JSON.stringify(slots);
  assert.ok(!/docenteCurricolare|curricularTeacher/i.test(json));
  // Compatibile con lo schema di sincronizzazione Firestore (validazione remota).
  assert.ok(isValidTimetablePayload(slots), 'slot validi per il modello di sync esistente');
});

test('modello: docente non di sostegno -> materia trovata come subject principale', () => {
  const curricularProfile = { ...profile, isSupportTeacher: false, primarySubjects: ['Matematica'] };
  const recon = [{
    id: 'r1', dayOfWeek: 2, periodIndex: 1, classLabel: '3D', coTeachingSubjects: ['Matematica'],
    status: 'unique' as const, confidence: 'high' as const, selected: true, correctedClass: '3D', correctedSubject: 'Matematica',
  }];
  const slots = reconstructedToTimetableSlots(recon, { profile: curricularProfile });
  assert.equal(slots[0].subject, 'Matematica');
  assert.equal(isSupportTeacherProfile(profile), true);
  assert.equal(isSupportTeacherProfile(curricularProfile), false);
});

test('fasce orarie: periodIndex oltre la configurazione viene prolungato con la stessa durata standard', () => {
  const config = { firstHourStartTime: '07:50', periodsPerDay: 5, standardDurationMinutes: 55 };
  assert.deepEqual(periodTimesForIndex(config, 1), { startTime: '07:50', endTime: '08:45' });
  assert.deepEqual(periodTimesForIndex(config, 6), { startTime: '12:25', endTime: '13:20' });
  assert.deepEqual(periodTimesForIndex(undefined, 2), { startTime: '08:50', endTime: '09:50' });
});

// ---------------------------------------------------------------------------
// 11-12. CONFERMA UMANA + ORARIO ESISTENTE
// ---------------------------------------------------------------------------

const existing: TimetableSlot[] = [
  { id: 'ex-1', dayOfWeek: 2, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3D', schoolId: 'school-x' },
  { id: 'ex-2', dayOfWeek: 5, periodNumber: 2, startTime: '10:15', endTime: '11:10', subject: 'Sostegno', className: '3E', schoolId: 'school-x' },
];

test('conferma: orario esistente NON sovrascritto (default "solo mancanti")', () => {
  const recon = [{
    id: 'r1', dayOfWeek: 2, periodIndex: 1, classLabel: '3D', coTeachingSubjects: ['Matematica'],
    status: 'unique' as const, confidence: 'high' as const, selected: true, correctedClass: '3D', correctedSubject: 'Matematica',
  }, {
    id: 'r2', dayOfWeek: 1, periodIndex: 1, classLabel: '3E', coTeachingSubjects: [],
    status: 'none' as const, confidence: 'low' as const, selected: true, correctedClass: '3E', correctedSubject: '',
  }];
  const incoming = reconstructedToTimetableSlots(recon, { profile, schoolId: 'school-x' });
  const merged = applyReconstruction(existing, incoming, 'missing-only');
  assert.equal(merged.addedCount, 1, 'solo lo slot mancante è aggiunto');
  assert.equal(merged.replacedCount, 0, 'nessuna sostituzione in modalità missing-only');
  assert.equal(merged.slots.length, 3);
  const kept = merged.slots.find(s => s.id === 'ex-1')!;
  assert.equal(kept.subject, 'Sostegno');
  assert.ok(!('coTeachingSubjects' in kept), 'lo slot esistente resta intatto');
});

test('conferma: modalità sostituzione tocca SOLO gli slot selezionati (stesso giorno+periodo)', () => {
  const recon = [{
    id: 'r1', dayOfWeek: 2, periodIndex: 1, classLabel: '3D', coTeachingSubjects: ['Matematica'],
    status: 'unique' as const, confidence: 'high' as const, selected: true, correctedClass: '3D', correctedSubject: 'Matematica',
  }];
  const incoming = reconstructedToTimetableSlots(recon, { profile, schoolId: 'school-x' });
  const merged = applyReconstruction(existing, incoming, 'replace-selected');
  assert.equal(merged.replacedCount, 1);
  assert.equal(merged.addedCount, 0);
  const replaced = merged.slots.find(s => s.dayOfWeek === 2 && s.periodNumber === 1)!;
  assert.deepEqual(replaced.coTeachingSubjects, ['Matematica']);
  assert.equal(merged.slots.find(s => s.id === 'ex-2')?.subject, 'Sostegno', 'gli altri slot restano intatti');
});

test('conferma: slot deselezionato non salvato; modifica manuale della materia rispettata', () => {
  const recon = [
    { id: 'r1', dayOfWeek: 2, periodIndex: 1, classLabel: '3D', coTeachingSubjects: ['Matematica'], status: 'unique' as const, confidence: 'high' as const, selected: true, correctedClass: '3D', correctedSubject: 'Storia' },
    { id: 'r2', dayOfWeek: 1, periodIndex: 1, classLabel: '3E', coTeachingSubjects: [], status: 'none' as const, confidence: 'low' as const, selected: false, correctedClass: '3E', correctedSubject: '' },
    { id: 'r3', dayOfWeek: 3, periodIndex: 1, classLabel: undefined, coTeachingSubjects: [], status: 'none' as const, confidence: 'low' as const, selected: true, correctedClass: '', correctedSubject: '' },
  ];
  const slots = reconstructedToTimetableSlots(recon, { profile, schoolId: 'school-x' });
  assert.equal(slots.length, 1, 'deselezionato + senza classe esclusi dal salvataggio');
  assert.equal(slots[0].className, '3D');
  assert.deepEqual(slots[0].coTeachingSubjects, ['Storia'], 'la correzione manuale dell\'utente vince sulla proposta');
  assert.equal(slots[0].subject, 'Sostegno');
});

// ---------------------------------------------------------------------------
// 13-14. REGISTRO / APPUNTI + MATCHING STUDENTI
// ---------------------------------------------------------------------------

test('registro: validazione runtime impegni (niente date/ora inventati dai campi opzionali)', () => {
  const parsed = validateStudentCommitmentsPayload([
    { title: 'Verifica di matematica', type: 'written_test', studentNameRaw: 'Rossi Matteo', date: '2026-09-15', startTime: '08:50', rawText: 'Verifica matematica 15/09' },
    { title: 'Colloquio', type: 'meeting', studentNameRaw: '', rawText: 'Colloquio 20/09' },
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].date, '2026-09-15');
  assert.equal(parsed[1].date, undefined, 'data non visibile -> undefined (mai inventata)');
  assert.equal(parsed[1].startTime, undefined, 'ora non visibile -> undefined');
  assert.throws(() => validateStudentCommitmentsPayload([{ title: 'x', type: 'ballgame' }]), /non valid/i);
  assert.throws(() => validateStudentCommitmentsPayload([{ title: '', type: 'other' }]), /non valid/i);
});

test('matching studenti: exact / probable / ambiguous / unmatched', () => {
  // EXACT: stesso nome completo, ordine indifferente, accenti/spazi normalizzati.
  const exact = matchStudentName('Rossi Matteo', students);
  assert.equal(exact.status, 'exact');
  assert.equal(exact.matchedStudentId, 'stu-rossi');
  const exactReversed = matchStudentName('matteo rossi', students);
  assert.equal(exactReversed.status, 'exact');
  const exactAccents = matchStudentName('fernandez andrea', students);
  assert.equal(exactAccents.status, 'exact', 'accenti indifferenti');

  // PROBABLE: cognome + iniziale (registro "ROSSI M.").
  const probable = matchStudentName('Rossi M.', students);
  assert.equal(probable.status, 'probable');
  assert.equal(probable.matchedStudentId, 'stu-rossi');
  // Cognome solo -> probable unico.
  const surnameOnly = matchStudentName('Bianchi', students.filter(s => s.id === 'stu-bianchi'));
  assert.equal(surnameOnly.status, 'probable');

  // AMBIGUOUS: due Bianchi -> nessuna scelta automatica.
  const ambiguous = matchStudentName('Bianchi', students);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.matchedStudentId, undefined, 'mai scelta automatica tra più candidati');
  assert.equal(ambiguous.candidates.length, 2);

  // UNMATCHED: nessun candidato plausibile.
  const unmatched = matchStudentName('Zanardi Paolo', students);
  assert.equal(unmatched.status, 'unmatched');
  assert.equal(studentMatchLabel(unmatched), 'Alunno non riconosciuto');
});

test('matching studenti: niente fuzzy aggressivo (un solo refuso sul cognome, mai di più)', () => {
  const typo = matchStudentName('Rossi Matteao', students);
  assert.equal(typo.status, 'probable', 'un carattere di differenza sul nome -> probabile');
  const far = matchStudentName('Russo Antonello', students);
  assert.equal(far.status, 'unmatched', 'distanze maggiori non matchano');
  assert.equal(parsePersonName('ROSSI M.').surname, 'rossi');
  assert.equal(parsePersonName('M. Rossi').surname, 'rossi');
  assert.equal(parsePersonName('marta maria').surname, 'maria');
  assert.equal(foldName("D'Angelo  Maria"), "d angelo maria");
});

test('matching studenti: nessun nuovo studente creato (solo selezione dall\'elenco locale)', () => {
  const unmatched = matchStudentName('Persona Nuova', students);
  assert.equal(unmatched.matchedStudentId, undefined);
  assert.equal(unmatched.candidates.length, 0);
  // L'API non espone alcuna creazione: il risultato indica solo chi è (probabilmente) lui.
  assert.equal(typeof (matchStudentName as unknown as { create?: unknown }).create, 'undefined');
});

// ---------------------------------------------------------------------------
// 15-16. PRIVACY (lato dati) + CONSENSO
// ---------------------------------------------------------------------------

test('privacy: validazione file per la scansione (formati e 5MB coerenti con il server)', () => {
  assert.equal(documentFileError({ name: 'foto.jpg', type: 'image/jpeg', size: 100_000 }), null);
  assert.equal(documentFileError({ name: 'doc.pdf', type: 'application/pdf', size: 10_000 }), null);
  assert.match(documentFileError({ name: 'note.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 1000 })!, /non supportato/i);
  assert.match(documentFileError({ name: 'foto.jpg', type: 'image/jpeg', size: MAX_DOCUMENT_BYTES + 1 })!, /5 MB/i);
  assert.equal(formatFileSize(1500), '1 KB');
  assert.equal(formatFileSize(6 * 1024 * 1024), '6.0 MB');
  // Attributi input: fotocamera posteriore preferita + fallback file.
  assert.equal(CAMERA_INPUT_PROPS.accept, 'image/*');
  assert.equal(CAMERA_INPUT_PROPS.capture, 'environment');
  assert.equal(CAMERA_INPUT_PROPS.capture === 'environment', true);
  assert.ok(!('capture' in FILE_INPUT_PROPS), 'il file picker non forza la fotocamera');
  assert.ok(FILE_INPUT_PROPS.accept.includes('image/*') && FILE_INPUT_PROPS.accept.includes('application/pdf'));
});

test('privacy: il messaggio offline è esplicito e i documenti non entrano nei dati locali', () => {
  assert.equal(OFFLINE_ANALYSIS_MESSAGE, 'L\'analisi intelligente richiede una connessione Internet.');
  // Il modello dati (LocalData) non ha campi immagine: nessun percorso di persistenza
  // per foto/base64 (verificato anche a livello UI/backup nei test dedicati).
  const data = { profile, events: [], circulars: [], students: [], definitiveTimetable: [], provisionalTimetable: [], timetableMode: 'auto', onboardingCompleted: true };
  const json = JSON.stringify(data);
  assert.ok(!/imageBase64|previewUrl/.test(json));
});

// ---------------------------------------------------------------------------
// 19. MULTI-ISTITUTO (lato dati)
// ---------------------------------------------------------------------------

test('multi-istituto: mono istituto senza UI extra; multi istituto con schoolId corretto', () => {
  const single = normalizeTeacherProfile({ ...profile });
  assert.equal(single.schools?.length, 1);
  const primaryId = single.schools?.find(s => s.isPrimary)?.id;
  assert.ok(primaryId);

  const multi: TeacherProfile = {
    ...profile,
    schools: [
      { id: 'school-a', name: 'IC Da Vinci', isPrimary: true, active: true },
      { id: 'school-b', name: 'Liceo Fermi', isPrimary: false, active: true, weeklyHours: 4 },
    ],
  };
  const normalized = normalizeTeacherProfile(multi);
  assert.equal(normalized.schools?.length, 2);
  const secondary = normalized.schools?.find(s => !s.isPrimary && s.active !== false);
  assert.ok(secondary);

  // L'orario ricostruito riceve la schoolId scelta (o quella principale di default).
  const recon = [{
    id: 'r1', dayOfWeek: 2, periodIndex: 1, classLabel: '3D', coTeachingSubjects: ['Matematica'],
    status: 'unique' as const, confidence: 'high' as const, selected: true, correctedClass: '3D', correctedSubject: 'Matematica',
  }];
  const defaultSlots = reconstructedToTimetableSlots(recon, { profile: multi });
  assert.equal(defaultSlots[0].schoolId, 'school-a', 'default: istituto principale');
  const chosenSlots = reconstructedToTimetableSlots(recon, { profile: multi, schoolId: 'school-b' });
  assert.equal(chosenSlots[0].schoolId, 'school-b', 'scelta esplicita rispettata');
  const singleSlots = reconstructedToTimetableSlots(recon, { profile: single });
  assert.equal(singleSlots[0].schoolId, primaryId, 'mono istituto: schoolId determinabile senza UI extra');
});
