import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { database } from '../src/services/db';
import { initializeStorage, storage, emptyInstallation } from '../src/services/storage';
import { validateBackup } from '../src/services/backup';
import { CLOUD_PATH_PATTERN, sanitizeFirestorePayload } from '../src/services/sync/firestoreGateway';
import { isValidCalendarEventMeetingUrl, sanitizeRemoteCalendarEvent } from '../src/services/sync/remoteSchema';
import { planSync } from '../src/services/sync/merge';
import {
  extractMeetingUrlFromText,
  getEventMeetingUrl,
  isHttpsMeetingUrl,
  isKnownMeetingHost,
  normalizeMeetingUrl,
} from '../src/utils/meetingLinks';
import type { CalendarEvent, TeacherProfile } from '../src/types';
import type { RemoteSnapshot, SyncableSnapshot } from '../src/services/sync/types';

/**
 * Link di videochiamata degli impegni (`CalendarEvent.meetingUrl`) — parte A.
 *
 * Contratto del dato: SOLO https. Le porte di ingresso (editor, import Google, righe del
 * cloud, file di backup) e quelle di uscita (Firestore, backup esportato) devono concordare:
 * ogni commit locale di IndexedDB valida l'intero snapshot con `validateBackup`, quindi un
 * solo campo disallineato renderebbe l'archivio illeggibile al riavvio successivo.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MEET = 'https://meet.google.com/abc-def-ghi';
const ZOOM = 'https://us02web.zoom.us/j/123';

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

function event(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1', title: 'Consiglio di classe 2E', category: 'consiglio_classe', date: '2026-09-15',
    startTime: '15:00', endTime: '16:00', isAllDay: false, sourceType: 'manuale', ...patch,
  } as CalendarEvent;
}
function snapshotWith(patch: Partial<SyncableSnapshot> = {}): SyncableSnapshot {
  return { ...emptyInstallation(), onboardingCompleted: true, ...patch } as SyncableSnapshot;
}
function profileWith(patch: Partial<TeacherProfile> = {}): TeacherProfile {
  return { ...(emptyInstallation().profile as TeacherProfile), fullName: 'Anna Testi', schoolName: 'IC Prova', roles: [], ...patch } as TeacherProfile;
}
const backupOf = (events: CalendarEvent[]) => ({ version: 3, ...emptyInstallation(), events });

// ---------------------------------------------------------------------------
// 1. Il contratto https, definito una sola volta
// ---------------------------------------------------------------------------

test('isHttpsMeetingUrl: https valido per qualunque piattaforma di videochiamata', () => {
  for (const url of [
    MEET,
    ZOOM,
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_Njc/0?context=%7b%22Tid%22%3a%22x%22%7d',
    'https://web.exempio-scuola.it/Room/42', // campo libero: non solo Meet/Zoom/Teams
    'HTTPS://MEET.GOOGLE.COM/ABC-DEF-GHI',   // protocollo e host case-insensitive
  ]) assert.equal(isHttpsMeetingUrl(url), true, url);
});

test('isHttpsMeetingUrl: http, javascript:, vuoti e non-stringhe sono rifiutati', () => {
  for (const value of [
    'http://meet.google.com/abc-def-ghi', 'javascript:alert(1)', 'meet.google.com/abc-def-ghi',
    'https://', '', '   ', 'https://meet.google.com/a b',
    'https://user:pwd@meet.google.com/a', `https://x.example/${'y'.repeat(3000)}`,
    undefined, null, 42, true, {}, [],
  ]) assert.equal(isHttpsMeetingUrl(value as never), false, JSON.stringify(value));
});

test('normalizeMeetingUrl taglia gli spazi e scarta tutto cio che non e https', () => {
  assert.equal(normalizeMeetingUrl(`  ${MEET}  `), MEET);
  assert.equal(normalizeMeetingUrl('http://meet.google.com/abc-def-ghi'), undefined);
  assert.equal(normalizeMeetingUrl(undefined), undefined);
  assert.equal(normalizeMeetingUrl(null), undefined);
});

test('isKnownMeetingHost: host esatti e sottodomini, mai prefissi ingannevoli', () => {
  for (const host of ['meet.google.com', 'zoom.us', 'us05web.zoom.us', 'teams.microsoft.com', 'eu.teams.live.com'])
    assert.equal(isKnownMeetingHost(host), true, host);
  // Un host che finisce per somigliare al dominio non basta: potrebbe essere phishing.
  for (const host of ['evil-meet.google.com.attacker.net', 'zoom.us.attacker.net', 'meetgoogle.com', 'teams.live.com.evil.io', ''])
    assert.equal(isKnownMeetingHost(host), false, host);
});

// ---------------------------------------------------------------------------
// 2. Link scritto nel testo: solo visualizzazione, mai riscrittura dei dati
// ---------------------------------------------------------------------------

test('extractMeetingUrlFromText: Meet, Zoom e Teams; nessun link altrui e nessun http', () => {
  assert.equal(extractMeetingUrlFromText(`Collegio in remoto: ${MEET}`), MEET);
  assert.equal(extractMeetingUrlFromText('Riunione (https://us02web.zoom.us/j/123).'), 'https://us02web.zoom.us/j/123');
  assert.equal(extractMeetingUrlFromText(`Link: ${MEET}, poi aula fisica`), MEET);
  assert.equal(extractMeetingUrlFromText('https://teams.live.com/l/meetup/xyz'), 'https://teams.live.com/l/meetup/xyz');
  assert.equal(extractMeetingUrlFromText('Vedi https://circolari.example.gov.it/4812'), undefined);
  assert.equal(extractMeetingUrlFromText('meet.google.com/abc-def-ghi senza protocollo'), undefined);
  assert.equal(extractMeetingUrlFromText('http://meet.google.com/abc-def-ghi'), undefined);
  assert.equal(extractMeetingUrlFromText(undefined), undefined);
  assert.equal(extractMeetingUrlFromText(''), undefined);
  assert.equal(extractMeetingUrlFromText(`https://meet.google.com/uno e ${ZOOM}`), 'https://meet.google.com/uno');
});

test('getEventMeetingUrl: campo dedicato, poi luogo, poi note - e i dati restano intatti', () => {
  assert.equal(getEventMeetingUrl(event({ meetingUrl: MEET, location: `Aula, ${ZOOM}`, notes: 'https://meet.google.com/zzz-zzz-zzz' })), MEET);
  assert.equal(getEventMeetingUrl(event({ location: `Aula Magna ${ZOOM}` })), ZOOM);
  assert.equal(getEventMeetingUrl(event({ notes: `Ordini del giorno\n${ZOOM}` })), ZOOM);
  assert.equal(getEventMeetingUrl(event({ location: 'Aula Magna', notes: 'Portare il registro' })), undefined);
  assert.equal(getEventMeetingUrl(event({ location: 'https://drive.example.com/modulo' })), undefined);
  // Un meetingUrl non https (dato manomesso) non viene mostrato e non blocca il fallback.
  assert.equal(getEventMeetingUrl(event({ meetingUrl: 'http://meet.google.com/abc', location: ZOOM })), ZOOM);
  assert.equal(getEventMeetingUrl(null), undefined);
  assert.equal(getEventMeetingUrl(undefined), undefined);

  // Derivazione di sola lettura: l'oggetto in ingresso non viene toccato, il campo non nasce.
  const source = event({ location: ZOOM });
  const before = structuredClone(source);
  getEventMeetingUrl(source);
  assert.deepEqual(source, before);
  assert.equal('meetingUrl' in source, false);
});

// ---------------------------------------------------------------------------
// 3. Backup: un evento con meetingUrl passa, uno con link non https e rifiutato
// ---------------------------------------------------------------------------

test('validateBackup accetta meetingUrl https e gli eventi che non lo hanno', () => {
  assert.doesNotThrow(() => validateBackup(backupOf([event({ meetingUrl: MEET })])));
  assert.doesNotThrow(() => validateBackup(backupOf([event()])));
  assert.doesNotThrow(() => validateBackup(backupOf([event({ id: 'e0', meetingUrl: ZOOM }), event({ meetingUrl: MEET })])));
});

test('validateBackup rifiuta un meetingUrl non https o di tipo errato', () => {
  for (const bad of ['http://meet.google.com/abc', 'meet.google.com/abc', 'javascript:alert(1)', '', '   ', 42, {}]) {
    assert.throws(
      () => validateBackup(backupOf([event({ meetingUrl: bad as never })])),
      /Eventi nel backup non validi/,
      String(bad),
    );
  }
});

test('meetingUrl sopravvive a IndexedDB, export e re-import del backup', async () => {
  await storage.saveEvents([event({ meetingUrl: MEET }), event({ id: 'e2' })]);
  assert.equal((await storage.getEvents()).find(item => item.id === 'e1')!.meetingUrl, MEET);

  const backupJson = await storage.exportDataBackup();
  const parsed = JSON.parse(backupJson);
  assert.equal(parsed.events.find((item: CalendarEvent) => item.id === 'e1').meetingUrl, MEET);
  validateBackup(parsed); // il documento completo passa il validatore rigoroso

  await storage.saveEvents([]);
  assert.equal(await storage.importDataBackup(backupJson), true);
  assert.equal((await storage.getEvents()).find(item => item.id === 'e1')!.meetingUrl, MEET);

  // Un backup con un link non https non viene applicato e lascia intatti i dati presenti.
  const poisoned = JSON.parse(backupJson);
  poisoned.events.find((item: CalendarEvent) => item.id === 'e1').meetingUrl = 'http://meet.google.com/abc';
  assert.equal(await storage.importDataBackup(JSON.stringify(poisoned)), false);
  assert.equal((await storage.getEvents()).find(item => item.id === 'e1')!.meetingUrl, MEET);
});

// ---------------------------------------------------------------------------
// 4. Sincronizzazione: la riga remota passa, il link malformato viene ripulito
// ---------------------------------------------------------------------------

test('remoteSchema: validatore del campo e pulizia del payload remoto', () => {
  assert.equal(isValidCalendarEventMeetingUrl(undefined), true);
  assert.equal(isValidCalendarEventMeetingUrl(MEET), true);
  assert.equal(isValidCalendarEventMeetingUrl('http://meet.google.com/abc'), false);
  assert.equal(isValidCalendarEventMeetingUrl(42), false);

  const clean = event({ meetingUrl: MEET });
  // Reference identica quando non c'e nulla da pulire: gli hash del merge non si muovono.
  assert.equal(sanitizeRemoteCalendarEvent(clean), clean);
  const withoutLink = event();
  assert.equal(sanitizeRemoteCalendarEvent(withoutLink), withoutLink, 'nessuna riga da pulire = nessun oggetto nuovo');

  const poisoned = event({ meetingUrl: 'http://meet.google.com/abc' });
  const sanitized = sanitizeRemoteCalendarEvent(poisoned);
  assert.equal('meetingUrl' in sanitized, false);
  assert.equal(sanitized.title, poisoned.title);
  assert.equal(sanitized.date, poisoned.date);
  assert.equal(poisoned.meetingUrl, 'http://meet.google.com/abc', 'linput remoto non viene modificato sul posto');

  // Roba non logica passa senza esplodere: qui non si elimina mai una riga intera.
  assert.equal(sanitizeRemoteCalendarEvent(null), null);
  assert.equal(sanitizeRemoteCalendarEvent(42), 42);
});

test('sync: un evento del cloud con meetingUrl arriva in locale nel ripristino completo', () => {
  const remoteEvent = event({ id: 'e9', meetingUrl: MEET });
  const remote = {
    state: {},
    items: { events: [{ id: 'e9', payload: remoteEvent, updatedAt: '2026-09-09T10:00:00.000Z' }], circulars: [] },
  } as RemoteSnapshot;
  // "Usa i dati del cloud" e la scelta esplicita che autorizza il ripristino completo.
  const plan = planSync({ uid: 'u1', snapshot: snapshotWith(), remote, syncState: null, nowIso: '2026-09-09T11:00:00.000Z', resolution: 'remote' });
  assert.ok(plan.fullRestore, 'ripristino completo dal cloud');
  assert.equal(plan.fullRestore!.events.find(item => item.id === 'e9')!.meetingUrl, MEET);
});

test('sync: il pull riga-per-riga ripulisce il link non https e conserva il resto', () => {
  const synced = { uid: 'u1', state: {}, items: { events: { docs: {} }, circulars: { docs: {} } } };
  const remote = {
    state: {},
    items: { events: [{ id: 'e9', payload: event({ id: 'e9', meetingUrl: 'http://meet.google.com/abc', title: 'Da cloud' }), updatedAt: 't1' }], circulars: [] },
  } as RemoteSnapshot;
  const plan = planSync({ uid: 'u1', snapshot: snapshotWith({ profile: profileWith(), events: [] }), remote, syncState: synced, nowIso: 't2' });
  const pulled = plan.localEvents!.find(item => item.id === 'e9')!;
  assert.equal(pulled.title, 'Da cloud');
  assert.equal('meetingUrl' in pulled, false);
  assert.doesNotThrow(() => validateBackup(backupOf(plan.localEvents!)), 'il commit locale non puo fallire');
});

test('sync: un impegno locale con meetingUrl viene spinto al cloud senza alterazioni', () => {
  const snap = snapshotWith({ profile: profileWith(), events: [event({ meetingUrl: MEET })] });
  const plan = planSync({
    uid: 'u1', snapshot: snap, remote: { state: {}, items: { events: [], circulars: [] } } as RemoteSnapshot,
    syncState: null, nowIso: '2026-09-09T11:00:00.000Z',
  });
  assert.deepEqual(plan.remoteWrites.events.e1, snap.events[0]);
  assert.equal((plan.remoteWrites.events.e1 as CalendarEvent).meetingUrl, MEET);
});

// ---------------------------------------------------------------------------
// 5. Firestore conserva il campo
// ---------------------------------------------------------------------------

test('Firestore: sanitize conserva meetingUrl e le regole non filtrano i campi evento', () => {
  const sanitized = sanitizeFirestorePayload(event({ meetingUrl: MEET }));
  assert.equal(sanitized.meetingUrl, MEET);
  assert.ok(!JSON.stringify(sanitized).includes('undefined'));
  // Un evento senza link non porta alcuna chiave vuota nel documento.
  assert.equal('meetingUrl' in sanitizeFirestorePayload(event({ meetingUrl: undefined })), false);

  // Le regole autorizzano l'intero payload senza whitelist di chiavi: un campo additivo
  // come meetingUrl non richiede alcun intervento su firestore.rules.
  assert.ok(CLOUD_PATH_PATTERN.test('users/u-1/events/e1'));
  const rules = readFileSync(resolve(here, '../firestore.rules'), 'utf8');
  const eventsBlock = rules.match(/match \/events\/\{eventId\} \{([\s\S]*?)\n      \}/);
  assert.ok(eventsBlock, 'blocco events presente nelle regole');
  assert.match(eventsBlock![1], /allow create, update: if isOwner\(\) && syncedDocShape\(\);/);
  assert.doesNotMatch(eventsBlock![1], /payload\.data\(\)\.keys\(\)/);
  assert.match(rules, /return request\.resource\.data\.keys\(\)\.hasAll\(\['payload', 'updatedAt'\]\)/);
});

// ---------------------------------------------------------------------------
// 6. Il confine reale: il commit atomico di IndexedDB
// ---------------------------------------------------------------------------

test('commit locale: un evento con meetingUrl non rompe la validazione atomica', async () => {
  await storage.saveEvents([event({ meetingUrl: MEET })]);
  const snapshot = await database.readSnapshot();
  assert.equal(snapshot.events[0].meetingUrl, MEET);
  assert.doesNotThrow(() => validateBackup({ version: 3, ...snapshot }));
  await storage.saveEvents([event({ meetingUrl: ZOOM })]);
  assert.equal((await storage.getEvents())[0].meetingUrl, ZOOM);
});
