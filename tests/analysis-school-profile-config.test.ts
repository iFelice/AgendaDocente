import express from 'express';
import { once } from 'node:events';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisInputError, validateTeacherProfile } from '../server/analysisGuards';
import { validateTimetableAnalysisPayload } from '../server/timetableAnalysis';
import { app } from '../server';

/**
 * H2 — regressione reale: dopo aver configurato un istituto con la 7ª ora
 * (SchoolProfile.dayPeriods) lo scanner dell'orario rispondeva
 * 400 "Richiesta di analisi non valida.".
 *
 * Causa: la allow-list chiusa di `schools()` in server/analysisGuards.ts non
 * conosceva i campi `dayPeriods` e `timeSlotConfig` introdotti dai passi C/G,
 * quindi validateTeacherProfile() respingeva il profilo PRIMA di interpellare
 * il modello. `periodsByDay=[6,6,6,7,6]` era ed è sempre stato valido: questi
 * test lo verificano esplicitamente, per escludere quella pista.
 *
 * La allow-list resta CHIUSA: una chiave sconosciuta è ancora rifiutata, e i
 * due nuovi campi sono validati nella forma (non solo ammessi), con le stesse
 * soglie di backup e sync.
 */

const baseProfile = {
  id: 'test',
  fullName: 'Docente',
  schoolName: 'Bonifazi',
  schoolYear: '2025/2026',
  primarySubjects: [],
  classes: ['1A'],
  campuses: [],
  roles: [],
};

/** Istituto reale come lo salva l'app dopo i passi C/G: 6 ore + 1 il giovedì. */
const realSchoolPostCG = {
  id: 'school-main',
  name: 'Bonifazi',
  isPrimary: true,
  active: true,
  dayPeriods: {
    ordinaryPeriodsPerDay: 6,
    extraPeriodsByDay: { 4: 1 },
  },
  timeSlotConfig: {
    firstHourStartTime: '08:00',
    periodsPerDay: 7,
    standardDurationMinutes: 60,
  },
};

const withSchools = (...schools: unknown[]) => ({ ...baseProfile, schools });

const googleProfile = {
  ...baseProfile,
  googleCalendarImportIds: ['primary', 'abc@example.com'],
  googleCalendarListCache: [{ id: 'abc@example.com', summary: 'Consiglio di classe', primary: false, accessRole: 'reader' }],
};

const accepts = (profile: unknown) => assert.doesNotThrow(() => validateTeacherProfile(profile));
const rejects = (profile: unknown) => {
  assert.throws(() => validateTeacherProfile(profile), (error: unknown) => {
    assert.ok(error instanceof AnalysisInputError, 'atteso AnalysisInputError');
    assert.equal(error.status, 400);
    assert.equal(error.message, 'Richiesta di analisi non valida.');
    return true;
  });
};

// ---------------------------------------------------------------- caso reale

test('hotfix: profilo con campi Google Calendar realistici è accettato', () => accepts(googleProfile));
test('hotfix: campi Google Calendar mantengono validazione stretta', () => {
  for (const invalid of [
    { ...googleProfile, googleCalendarImportIds: 'primary' },
    { ...googleProfile, googleCalendarListCache: [{ summary: 'Missing id' }] },
    { ...googleProfile, googleCalendarListCache: [{ id: 'x', summary: 'Calendar', primary: 'true' }] },
    { ...googleProfile, googleCalendarListCache: [{ id: 'x', summary: 'Calendar', extra: true }] },
    { ...googleProfile, googleCalendarListCache: Array.from({ length: 501 }, (_, i) => ({ id: `c${i}`, summary: 'Calendar' })) },
    { ...googleProfile, unexpected: true },
  ]) rejects(invalid);
});

test('H2 REGRESSIONE: profilo reale post-C/G (dayPeriods 7ª ora + timeSlotConfig) è accettato', () => {
  accepts(withSchools(realSchoolPostCG));
});

test('H2 REGRESSIONE: la request personale [6,6,6,7,6] con profilo post-C/G passa la validazione', () => {
  const result = validateTimetableAnalysisPayload({
    imageBase64: Buffer.from('%PDF-1.7\n%%EOF').toString('base64'),
    mimeType: 'application/pdf',
    documentType: 'personal-support-timetable',
    periodsByDay: [6, 6, 6, 7, 6],
    profile: withSchools(realSchoolPostCG),
  });
  assert.equal(result.documentType, 'personal-support-timetable');
  // La geometria NON uniforme sopravvive intatta: nessun ritorno allo scalare.
  assert.deepEqual(result.periodsByDay, [6, 6, 6, 7, 6]);
});

// ------------------------------------------------------------- casi validi

test('1. istituto legacy senza i nuovi campi resta valido', () => {
  accepts(withSchools({ id: 's1', name: 'Legacy', isPrimary: true, active: true, weeklyHours: 18 }));
});

test('2. dayPeriods valido è accettato', () => {
  accepts(withSchools({ id: 's1', name: 'S', dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } } }));
  accepts(withSchools({ id: 's1', name: 'S', dayPeriods: {} }));
  accepts(withSchools({ id: 's1', name: 'S', dayPeriods: { ordinaryPeriodsPerDay: 1 } }));
  accepts(withSchools({ id: 's1', name: 'S', dayPeriods: { ordinaryPeriodsPerDay: 12 } }));
  accepts(withSchools({ id: 's1', name: 'S', dayPeriods: { extraPeriodsByDay: { 1: 0, 6: 11 } } }));
});

test('3. [6,6,6,7,6] + dayPeriods con giovedì +1: profilo e request entrambi validi', () => {
  const profile = withSchools({ id: 's1', name: 'S', dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } } });
  accepts(profile);
  const result = validateTimetableAnalysisPayload({
    imageBase64: Buffer.from('%PDF-1.7\n%%EOF').toString('base64'),
    mimeType: 'application/pdf',
    documentType: 'personal-support-timetable',
    periodsByDay: [6, 6, 6, 7, 6],
    profile,
  });
  assert.deepEqual(result.periodsByDay, [6, 6, 6, 7, 6]);
});

test('4. timeSlotConfig valido è accettato, anche con customSlots', () => {
  accepts(withSchools({ id: 's1', name: 'S', timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 7, standardDurationMinutes: 60 } }));
  accepts(withSchools({
    id: 's1', name: 'S',
    timeSlotConfig: {
      firstHourStartTime: '07:50', periodsPerDay: 6, standardDurationMinutes: 55,
      customSlots: [{ periodNumber: 1, startTime: '07:50', endTime: '08:45', label: 'Prima' }, { periodNumber: 2, startTime: '08:45', endTime: '09:40' }],
    },
  }));
});

test('5. dayPeriods e timeSlotConfig insieme sono accettati', () => {
  accepts(withSchools(realSchoolPostCG));
});

// ------------------------------------------------------------ casi invalidi

test('6. ordinaryPeriodsPerDay = 0 è rifiutato (soglia 1..12 come backup/sync)', () => {
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { ordinaryPeriodsPerDay: 0 } }));
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { ordinaryPeriodsPerDay: 13 } }));
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { ordinaryPeriodsPerDay: 6.5 } }));
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { ordinaryPeriodsPerDay: '6' } }));
});

test('7. giorno "7" in extraPeriodsByDay è rifiutato (solo 1..6)', () => {
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { extraPeriodsByDay: { 7: 1 } } }));
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { extraPeriodsByDay: { 0: 1 } } }));
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { extraPeriodsByDay: { lunedi: 1 } } }));
});

test('8. ore aggiuntive negative o fuori scala sono rifiutate (0..11)', () => {
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { extraPeriodsByDay: { 4: -1 } } }));
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { extraPeriodsByDay: { 4: 12 } } }));
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { extraPeriodsByDay: { 4: 1.5 } } }));
});

test('9. orario "25:00" è rifiutato (HH:MM valido)', () => {
  rejects(withSchools({ id: 's1', name: 'S', timeSlotConfig: { firstHourStartTime: '25:00', periodsPerDay: 6, standardDurationMinutes: 60 } }));
  rejects(withSchools({ id: 's1', name: 'S', timeSlotConfig: { firstHourStartTime: '8:00', periodsPerDay: 6, standardDurationMinutes: 60 } }));
  rejects(withSchools({ id: 's1', name: 'S', timeSlotConfig: { firstHourStartTime: '08:60', periodsPerDay: 6, standardDurationMinutes: 60 } }));
});

test('9b. periodsPerDay / standardDurationMinutes non interi positivi sono rifiutati', () => {
  rejects(withSchools({ id: 's1', name: 'S', timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 0, standardDurationMinutes: 60 } }));
  rejects(withSchools({ id: 's1', name: 'S', timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 0 } }));
  rejects(withSchools({ id: 's1', name: 'S', timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 6.5, standardDurationMinutes: 60 } }));
  // campi obbligatori mancanti
  rejects(withSchools({ id: 's1', name: 'S', timeSlotConfig: { periodsPerDay: 6, standardDurationMinutes: 60 } }));
});

test('10. custom slot con endTime <= startTime è rifiutato', () => {
  const slot = (customSlots: unknown) => withSchools({
    id: 's1', name: 'S',
    timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60, customSlots },
  });
  rejects(slot([{ periodNumber: 1, startTime: '09:00', endTime: '08:00' }]));
  rejects(slot([{ periodNumber: 1, startTime: '09:00', endTime: '09:00' }]));
  rejects(slot([{ periodNumber: 0, startTime: '08:00', endTime: '09:00' }]));
  rejects(slot([{ periodNumber: 1, startTime: '08:00', endTime: '99:00' }]));
  rejects(slot([{ periodNumber: 1, startTime: '08:00', endTime: '09:00', label: 42 }]));
  rejects(slot('non-un-array'));
});

test('11. la allow-list resta CHIUSA: chiavi sconosciute sempre rifiutate', () => {
  rejects(withSchools({ id: 's1', name: 'S', sconosciuto: true }));
  // anche annidate nei nuovi campi
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: { ordinaryPeriodsPerDay: 6, boh: 1 } }));
  rejects(withSchools({ id: 's1', name: 'S', timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60, boh: 1 } }));
  // tipi sbagliati per i nuovi campi
  rejects(withSchools({ id: 's1', name: 'S', dayPeriods: 'no' }));
  rejects(withSchools({ id: 's1', name: 'S', timeSlotConfig: [] }));
});

// ------------------------------------------------------------------ endpoint

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
const previousKey = process.env.GEMINI_API_KEY;

before(async () => {
  // Senza chiave AI l'endpoint risponde 503: basta a dimostrare che la
  // richiesta ha SUPERATO i guard (niente più 400 di validazione).
  delete process.env.GEMINI_API_KEY;
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (previousKey !== undefined) process.env.GEMINI_API_KEY = previousKey;
  await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

test('endpoint POST /api/analyze-timetable: profilo con dayPeriods/timeSlotConfig NON dà più 400', async () => {
  const res = await fetch(`${baseUrl}/api/analyze-timetable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: Buffer.from('%PDF-1.7\n%%EOF').toString('base64'),
      mimeType: 'application/pdf',
      documentType: 'personal-support-timetable',
      periodsByDay: [6, 6, 6, 7, 6],
      profile: withSchools(realSchoolPostCG),
    }),
  });
  const body = await res.json();
  assert.notEqual(res.status, 400, 'la richiesta reale non deve più essere rifiutata dai guard');
  assert.notEqual(body.error, 'Richiesta di analisi non valida.');
  // Superati i guard, senza chiave AI resta il 503 generico già coperto altrove.
  assert.equal(res.status, 503);
});
