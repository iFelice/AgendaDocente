import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../src/services/db';
import { initializeStorage, storage, emptyInstallation } from '../src/services/storage';
import { validateBackup } from '../src/services/backup';
import { classifyRemoteStateDoc } from '../src/services/sync/remoteSchema';
import { snapshotFromRemote, statePayload } from '../src/services/sync/merge';
import { normalizeTeacherProfile, getPrimarySchool } from '../src/utils/multiSchool';
import {
  DEFAULT_PERIOD_SLOTS,
  getEffectivePeriodSlots,
  timeSlotConfigForSchool,
} from '../src/utils/timeSlots';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig } from '../src/types';

/**
 * MICRO-PASSO G1 — FASCE ORARIE PER ISTITUTO: SOLO IL MODELLO.
 *
 * `dayPeriods` (quante ore ha ogni giorno) è per istituto dal passo C; le
 * campane (a che ora suonano) sono invece rimaste UNA SOLA per tutto il
 * docente. Due scuole che iniziano a orari diversi non erano rappresentabili.
 *
 * G1 aggiunge il campo e la regola di lettura, e NIENT'ALTRO: nessun
 * componente lo consuma ancora, nessun dato viene migrato, nessuna config
 * viene creata da sola. Deve essere un passo invisibile.
 */

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Configurazione GLOBALE personalizzata: non è il default 07:50 / 6 x 60. */
const globalConfig: TimeSlotConfig = {
  firstHourStartTime: '08:20',
  periodsPerDay: 5,
  standardDurationMinutes: 55,
};

/** Campane proprie di un istituto, diverse dalla globale in ogni campo. */
const configB: TimeSlotConfig = {
  firstHourStartTime: '08:15',
  periodsPerDay: 4,
  standardDurationMinutes: 50,
  customSlots: [
    { periodNumber: 1, label: '1ª Ora', startTime: '08:15', endTime: '09:05' },
    { periodNumber: 2, label: '2ª Ora', startTime: '09:10', endTime: '10:00' },
    { periodNumber: 3, label: '3ª Ora', startTime: '10:15', endTime: '11:05' },
    { periodNumber: 4, label: '4ª Ora', startTime: '11:05', endTime: '11:55' },
  ],
};

const school = (over: Partial<SchoolProfile> & { id: string }): SchoolProfile => ({
  name: 'Istituto', isPrimary: false, active: true, ...over,
});

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Rossi',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A'], campuses: [], roles: [], isSupportTeacher: true,
};

// ---------------------------------------------------------------------------
// 1-5. Risoluzione
// ---------------------------------------------------------------------------

test('G1/1+3+4. senza config propria vale la GLOBALE, mai il default', () => {
  const plain = school({ id: 's1' });
  // Il rischio principale del passo: un `undefined` di troppo farebbe ricadere
  // l'utente sul default 07:50 / 6 x 60 cancellandogli le sue campane.
  assert.equal(timeSlotConfigForSchool(plain, globalConfig), globalConfig);
  assert.equal(timeSlotConfigForSchool(undefined, globalConfig), globalConfig);
  const resolved = timeSlotConfigForSchool(plain, globalConfig);
  assert.equal(resolved?.firstHourStartTime, '08:20');
  assert.equal(resolved?.periodsPerDay, 5);
  assert.equal(resolved?.standardDurationMinutes, 55);
  assert.notDeepEqual(getEffectivePeriodSlots(resolved), DEFAULT_PERIOD_SLOTS, 'niente scivolata sul default');

  // Entrambe assenti: nessun default inventato QUI. Il default resta una
  // responsabilità di getEffectivePeriodSlots, come prima di G1.
  assert.equal(timeSlotConfigForSchool(plain, undefined), undefined);
  assert.equal(timeSlotConfigForSchool(undefined, undefined), undefined);
  assert.deepEqual(getEffectivePeriodSlots(timeSlotConfigForSchool(plain, undefined)), DEFAULT_PERIOD_SLOTS);
});

test('G1/2. la config dell istituto vince INTERAMENTE, senza fusioni', () => {
  const withOwn = school({ id: 's2', timeSlotConfig: configB });
  const resolved = timeSlotConfigForSchool(withOwn, globalConfig);
  assert.equal(resolved, configB, 'stessa identità: nessun oggetto ricostruito');
  assert.deepEqual(resolved, configB);
  // Nessun campo della globale sopravvive: una fusione campo-per-campo
  // produrrebbe orari che non appartengono a nessuna delle due scuole.
  assert.equal(resolved?.firstHourStartTime, '08:15');
  assert.equal(resolved?.periodsPerDay, 4);
  assert.equal(resolved?.standardDurationMinutes, 50);
});

test('G1/5. le fasce personalizzate arrivano intatte a getEffectivePeriodSlots', () => {
  const withOwn = school({ id: 's2', timeSlotConfig: configB });
  const slots = getEffectivePeriodSlots(timeSlotConfigForSchool(withOwn, globalConfig));
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map(s => s.startTime), ['08:15', '09:10', '10:15', '11:05']);
  assert.deepEqual(slots.map(s => s.endTime), ['09:05', '10:00', '11:05', '11:55']);
});

test('G1/extra. la risoluzione non conosce profili né id', () => {
  // Contratto deliberato: identità della scuola a monte, regola dayPeriods
  // altrove. Qui solo "quale config vale per questa scuola".
  assert.equal(timeSlotConfigForSchool({ timeSlotConfig: configB }, globalConfig), configB);
  assert.equal(timeSlotConfigForSchool({ timeSlotConfig: undefined }, globalConfig), globalConfig);
});

// ---------------------------------------------------------------------------
// 6-9. Normalizzazione del profilo
// ---------------------------------------------------------------------------

test('G1/6-7. la normalizzazione preserva la config di primaria e secondaria', () => {
  // La normalizzazione RICOSTRUISCE la proiezione della primaria: se lo facesse
  // campo per campo, le campane sparirebbero a ogni caricamento.
  const profile: TeacherProfile = {
    ...baseProfile,
    schools: [
      school({ id: 'a', name: 'IC Rossi', isPrimary: true, timeSlotConfig: globalConfig }),
      school({ id: 'b', name: 'Liceo Verdi', timeSlotConfig: configB }),
    ],
  };
  const normalized = normalizeTeacherProfile(profile);
  const [primary, secondary] = normalized.schools ?? [];
  assert.deepEqual(primary.timeSlotConfig, globalConfig, 'primaria: config preservata');
  assert.deepEqual(secondary.timeSlotConfig, configB, 'secondaria: config preservata');
  assert.deepEqual(secondary.timeSlotConfig?.customSlots, configB.customSlots, 'fasce custom intatte');
  // Idempotenza: normalizzare due volte non cambia nulla.
  assert.deepEqual(normalizeTeacherProfile(normalized).schools, normalized.schools);
});

test('G1/8. la normalizzazione NON inventa una config quando manca', () => {
  const profile: TeacherProfile = {
    ...baseProfile,
    schools: [school({ id: 'a', name: 'IC Rossi', isPrimary: true }), school({ id: 'b', name: 'Liceo Verdi' })],
  };
  const normalized = normalizeTeacherProfile(profile);
  for (const s of normalized.schools ?? []) {
    assert.equal('timeSlotConfig' in s, false, `nessuna config creata per ${s.id}`);
  }
  // Profilo legacy senza schools[]: la primaria sintetizzata nasce senza campane proprie.
  const legacy = normalizeTeacherProfile(baseProfile);
  assert.equal(legacy.schools?.length, 1);
  assert.equal(legacy.schools?.[0].timeSlotConfig, undefined, 'nessuna duplicazione implicita della globale');
  assert.equal(getPrimarySchool(baseProfile)?.timeSlotConfig, undefined);
});

test('G1/9. disattivare e riattivare un istituto non perde le sue campane', () => {
  const active: TeacherProfile = {
    ...baseProfile,
    schools: [
      school({ id: 'a', name: 'IC Rossi', isPrimary: true }),
      school({ id: 'b', name: 'Liceo Verdi', active: true, timeSlotConfig: configB }),
    ],
  };
  // La UI del Profilo disattiva, non elimina: l'istituto resta nell'array.
  const deactivated: TeacherProfile = {
    ...active,
    schools: (active.schools ?? []).map(s => (s.id === 'b' ? { ...s, active: false } : s)),
  };
  const afterOff = normalizeTeacherProfile(deactivated).schools?.find(s => s.id === 'b');
  assert.equal(afterOff?.active, false);
  assert.deepEqual(afterOff?.timeSlotConfig, configB, 'config conservata da spenta');

  const reactivated: TeacherProfile = {
    ...deactivated,
    schools: (deactivated.schools ?? []).map(s => (s.id === 'b' ? { ...s, active: true } : s)),
  };
  const afterOn = normalizeTeacherProfile(reactivated).schools?.find(s => s.id === 'b');
  assert.deepEqual(afterOn?.timeSlotConfig, configB, 'riattivata: le campane sono ancora le sue');
});

// ---------------------------------------------------------------------------
// 10-13. Backup
// ---------------------------------------------------------------------------

const backupWithSchools = (schools: SchoolProfile[], global?: TimeSlotConfig) => ({
  version: 3,
  ...emptyInstallation(),
  profile: { ...baseProfile, schools },
  ...(global ? { timeSlotConfig: global } : {}),
});

test('G1/10. backup legacy: istituti senza campane proprie restano validi', () => {
  validateBackup(backupWithSchools([school({ id: 'a', name: 'IC Rossi', isPrimary: true })], globalConfig));
});

test('G1/11. backup nuovo: config scolastiche valide accettate', () => {
  validateBackup(backupWithSchools([
    school({ id: 'a', name: 'IC Rossi', isPrimary: true, timeSlotConfig: globalConfig }),
    school({ id: 'b', name: 'Liceo Verdi', timeSlotConfig: configB }),
  ], globalConfig));
});

test('G1/12. backup con config scolastica malformata: rifiutato', () => {
  const invalid: unknown[] = [
    { firstHourStartTime: '25:99', periodsPerDay: 5, standardDurationMinutes: 55 },
    { firstHourStartTime: '08:00', periodsPerDay: 0, standardDurationMinutes: 55 },
    { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: -1 },
    { firstHourStartTime: '08:00', periodsPerDay: 5.5, standardDurationMinutes: 55 },
    { periodsPerDay: 5, standardDurationMinutes: 55 },
    { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: 55, customSlots: [{ periodNumber: 1, startTime: '10:00', endTime: '09:00' }] },
    'non-un-oggetto',
  ];
  for (const bad of invalid) {
    assert.throws(
      () => validateBackup(backupWithSchools([school({ id: 'a', name: 'IC Rossi', isPrimary: true, timeSlotConfig: bad as TimeSlotConfig })])),
      /Profilo nel backup non valido/,
      `deve rifiutare ${JSON.stringify(bad)}`,
    );
  }
});

let memory: Map<string, string>;
beforeEach(async () => {
  memory = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return memory.size; },
      key: (i: number) => [...memory.keys()][i] ?? null,
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => { memory.set(k, String(v)); },
      removeItem: (k: string) => { memory.delete(k); },
    },
  });
  database.close();
  await database.delete();
  await initializeStorage();
});

test('G1/13. round-trip backup: due istituti con campane diverse + globale distinta', async () => {
  await storage.saveTimeSlotConfig(globalConfig);
  await storage.saveProfile({
    ...baseProfile,
    schools: [
      school({ id: 'a', name: 'IC Rossi', isPrimary: true, timeSlotConfig: { ...globalConfig, firstHourStartTime: '08:00' } }),
      school({ id: 'b', name: 'Liceo Verdi', timeSlotConfig: configB }),
    ],
  });

  const json = await storage.exportDataBackup();
  const parsed = JSON.parse(json);
  validateBackup(parsed);
  assert.equal(parsed.profile.schools[0].timeSlotConfig.firstHourStartTime, '08:00', 'A esportata');
  assert.deepEqual(parsed.profile.schools[1].timeSlotConfig, configB, 'B esportata');
  assert.deepEqual(parsed.timeSlotConfig, globalConfig, 'la globale resta un dato separato');

  // Si azzera tutto e si reimporta.
  await storage.saveProfile({ ...baseProfile, schools: [] });
  assert.equal(await storage.importDataBackup(json), true);

  const restored = await storage.getProfile();
  const schools = normalizeTeacherProfile(restored).schools ?? [];
  const a = schools.find(s => s.id === 'a');
  const b = schools.find(s => s.id === 'b');
  assert.equal(a?.timeSlotConfig?.firstHourStartTime, '08:00', 'A ripristinata');
  assert.deepEqual(b?.timeSlotConfig, configB, 'B ripristinata, fasce custom incluse');
  assert.notDeepEqual(a?.timeSlotConfig, b?.timeSlotConfig, 'le due config non si sono sovrascritte');
  assert.deepEqual(await storage.getTimeSlotConfig(), globalConfig, 'la globale non è stata rimpiazzata');
});

test('G1/13b. backup vecchio (solo globale): import valido e fallback runtime corretto', async () => {
  await storage.saveTimeSlotConfig(globalConfig);
  await storage.saveProfile({
    ...baseProfile,
    schools: [school({ id: 'a', name: 'IC Rossi', isPrimary: true }), school({ id: 'b', name: 'Liceo Verdi' })],
  });
  const json = await storage.exportDataBackup();
  assert.equal(await storage.importDataBackup(json), true);

  const restored = normalizeTeacherProfile(await storage.getProfile());
  const global = await storage.getTimeSlotConfig();
  for (const s of restored.schools ?? []) {
    assert.equal(s.timeSlotConfig, undefined, 'nessuna config materializzata dall import');
    assert.equal(timeSlotConfigForSchool(s, global), global, 'entrambe leggono la globale');
  }
});

// ---------------------------------------------------------------------------
// 14-17. Schema remoto e sync
// ---------------------------------------------------------------------------

const remoteProfileDoc = (schools: unknown) => ({
  payload: { ...baseProfile, schools },
  updatedAt: '2026-01-01T00:00:00.000Z',
  schemaVersion: 1,
});

test('G1/14. profilo remoto legacy (senza config scolastiche): valido', () => {
  const verdict = classifyRemoteStateDoc('profile', remoteProfileDoc([{ id: 'a', name: 'IC Rossi', isPrimary: true }]));
  assert.equal(verdict.status, 'valid');
});

test('G1/15. profilo remoto con campane proprie: valido e conservato', () => {
  const verdict = classifyRemoteStateDoc('profile', remoteProfileDoc([
    { id: 'a', name: 'IC Rossi', isPrimary: true },
    { id: 'b', name: 'Liceo Verdi', timeSlotConfig: configB },
  ]));
  assert.equal(verdict.status, 'valid');
});

test('G1/16. profilo remoto con config scolastica invalida: respinto', () => {
  for (const bad of [
    { firstHourStartTime: 'boh', periodsPerDay: 5, standardDurationMinutes: 55 },
    { firstHourStartTime: '08:00', periodsPerDay: 99, standardDurationMinutes: 55 },
    { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: 0 },
    { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: 55, customSlots: [{ periodNumber: 1, startTime: '09:00', endTime: '08:00' }] },
  ]) {
    const verdict = classifyRemoteStateDoc('profile', remoteProfileDoc([{ id: 'a', name: 'IC Rossi', isPrimary: true, timeSlotConfig: bad }]));
    assert.equal(verdict.status, 'invalid', `deve respingere ${JSON.stringify(bad)}`);
  }
});

test('G1/17. sync: le campane viaggiano dentro il documento profile e sopravvivono al giro', () => {
  const profile: TeacherProfile = {
    ...baseProfile,
    schools: [
      school({ id: 'a', name: 'IC Rossi', isPrimary: true }),
      school({ id: 'b', name: 'Liceo Verdi', timeSlotConfig: configB }),
    ],
  };
  const snapshot = { ...emptyInstallation(), profile, timeSlotConfig: globalConfig } as never;

  // Il payload `profile` porta le config scolastiche...
  const profilePayload = statePayload(snapshot, 'profile') as TeacherProfile;
  assert.deepEqual(profilePayload.schools?.[1].timeSlotConfig, configB);

  // ...e quello `settings` continua a portare SOLO la globale: nessun campo
  // nuovo, nessun documento remoto aggiuntivo.
  const settingsPayload = statePayload(snapshot, 'settings') as Record<string, unknown>;
  assert.deepEqual(settingsPayload.timeSlotConfig, globalConfig);
  assert.deepEqual(Object.keys(settingsPayload).sort(), ['onboardingCompleted', 'timeSlotConfig', 'timetableMode']);

  // Ritorno dal remoto: il profilo è trattato come unità, le config restano.
  const fromRemote = snapshotFromRemote({
    state: {
      profile: { payload: profilePayload, updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 1 },
      settings: { payload: settingsPayload, updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 1 },
    },
    items: { events: [], circulars: [], assessments: [], scheduledAssessments: [] },
  } as never);
  assert.deepEqual((fromRemote.profile as TeacherProfile).schools?.[1].timeSlotConfig, configB);
  assert.deepEqual(fromRemote.timeSlotConfig, globalConfig);
});

// ---------------------------------------------------------------------------
// 18-20. Non-regressione: G1 non deve cambiare l'app
// ---------------------------------------------------------------------------

test('G1/18-19. la globale resta dov era: stessa API, stessa chiave, nessuna chiave nuova', async () => {
  await storage.saveTimeSlotConfig(globalConfig);
  assert.deepEqual(await storage.getTimeSlotConfig(), globalConfig, 'API globale invariata');

  const snapshot = await database.readSnapshot();
  assert.deepEqual(snapshot.timeSlotConfig, globalConfig, 'sempre al primo livello dello snapshot');
  // Nessuna chiave di primo livello nuova: le campane per istituto vivono
  // dentro il profilo, non in un record separato (opzione scartata in AUDIT G).
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['assessments', 'circulars', 'definitiveTimetable', 'events', 'onboardingCompleted', 'profile',
     'provisionalTimetable', 'scheduledAssessments', 'students', 'timeSlotConfig', 'timetableMode'].sort(),
  );
});

test('G1/20. il confine dei consumatori è esplicito: chi risolve per istituto e chi resta puro', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const read = (...file: string[]) => readFileSync(join(process.cwd(), 'src', ...file), 'utf8');

  // CONSUMATORI (G2 + G3): risolvono le campane della scuola effettiva e le
  // usano al posto del singleton del docente. Sono i punti in cui "quale
  // istituto" e "quali orari" devono viaggiare insieme.
  for (const file of [
    ['components', 'TimetableEditor.tsx'],
    ['components', 'TodayView.tsx'],
    ['components', 'WeekView.tsx'],
    ['components', 'DocumentScannerModal.tsx'],
    ['utils', 'reconstructTimetable.ts'],
  ]) {
    assert.match(read(...file), /timeSlotConfigForSchool\(/, `${file.join('/')} deve risolvere le fasce per istituto`);
  }

  // UTILITY DI DOMINIO: restano pure. Ricevono scuola e config come parametri
  // e non leggono il profilo né risolvono identità — è la convenzione che ha
  // reso piccoli D3, F5 e G3, e va difesa.
  for (const file of [
    ['utils', 'scannerWeekGeometry.ts'],
    ['utils', 'schoolDayPeriods.ts'],
  ]) {
    const source = read(...file);
    assert.equal(/timeSlotConfigForSchool/.test(source), false, `${file.join('/')} deve restare puro`);
    assert.equal(/\bschool\w*\s*\??\.\s*timeSlotConfig/i.test(source), false, `${file.join('/')} non deve leggere le campane da una scuola`);
    assert.equal(/normalizeTeacherProfile|getPrimarySchool/.test(source), false, `${file.join('/')} non deve leggere il profilo`);
  }
});
