/**
 * CIFRATURA A BUSTA DEI DATI RISERVATI — primitive (Web Crypto API).
 *
 * Copre il modello delle chiavi:
 *  - cifra e decifra (AES-GCM 256 con la chiave dati);
 *  - IV diversi a ogni cifratura, mai riutilizzati;
 *  - derivazione PBKDF2-HMAC-SHA256 (frase e codice di recupero, stesso sale
 *    ma domini diversi);
 *  - involucro della chiave dati: apertura con il secret giusto, rifiuto con
 *    quello sbagliato;
 *  - valore di verifica: "frase errata" senza decifrare i dati;
 *  - forma del codice di recupero (generato, normalizzato, rifiutato se errato).
 *
 * Usa la Web Crypto di Node (stessa API del browser): nessuna dipendenza nuova.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PBKDF2_ITERATIONS,
  VERIFY_CONSTANT,
  decryptJson,
  deriveWrappingKey,
  encryptJson,
  fromBase64,
  generateDataKey,
  generateRecoveryCode,
  generateSalt,
  importDataKey,
  isSensitiveEncryptedBlob,
  isWrappedKey,
  normalizeRecoveryCode,
  unwrapRawKey,
  wrapRawKey,
} from '../src/services/sensitiveCrypto';

test('cifratura e decifratura: il valore torna identico, il blob è opaco', async () => {
  const { key } = await generateDataKey();
  const dati = { isSupportStudent: true, peiType: 'differenziato', diagnosticSummary: 'Profilo riservato' };
  const blob = await encryptJson(key, dati);
  assert.equal(isSensitiveEncryptedBlob(blob), true, 'il blob ha la forma {v, iv, ct}');
  assert.equal(blob.v, 1);
  assert.equal(fromBase64(blob.iv).length, 12, 'IV di 12 byte');
  // Il cifrato non lascia trapelare il contenuto.
  const ct = Buffer.from(blob.ct, 'base64').toString('utf8');
  assert.ok(!ct.includes('riservato') && !ct.includes('peiType'));
  assert.deepEqual(await decryptJson(key, blob), dati);
});

test('IV diversi a ogni cifratura: due blob dello stesso valore non coincidono', async () => {
  const { key } = await generateDataKey();
  const dati = { assignedStudents: ['Rossi Matteo (2E)'] };
  const blobs = await Promise.all([encryptJson(key, dati), encryptJson(key, dati), encryptJson(key, dati)]);
  const ivs = new Set(blobs.map(b => b.iv));
  const cts = new Set(blobs.map(b => b.ct));
  assert.equal(ivs.size, 3, 'IV mai riutilizzato');
  assert.equal(cts.size, 3, 'cifrati sempre diversi a parità di contenuto');
  for (const blob of blobs) assert.deepEqual(await decryptJson(key, blob), dati);
});

test('la decifratura con una chiave diversa fallisce', async () => {
  const a = await generateDataKey();
  const b = await generateDataKey();
  const blob = await encryptJson(a.key, { specialists: 'NPI dott.ssa Bianchi' });
  await assert.rejects(() => decryptJson(b.key, blob));
});

test('derivazione: parametri richiesti e stessa frase+sale riapre lo stesso involucro', async () => {
  assert.equal(PBKDF2_ITERATIONS, 600_000, '600.000 iterazioni PBKDF2-HMAC-SHA256');
  const salt = generateSalt();
  assert.equal(fromBase64(salt).length, 16, 'sale casuale di 16 byte per account');
  const { raw } = await generateDataKey();

  const wrapping = await deriveWrappingKey('una frase segreta lunga abbastanza', salt, 'phrase');
  const wrapped = await wrapRawKey(raw, wrapping);
  assert.equal(isWrappedKey(wrapped), true, 'involucro {iv, ct}');

  const again = await deriveWrappingKey('una frase segreta lunga abbastanza', salt, 'phrase');
  const opened = await unwrapRawKey(wrapped, again);
  assert.deepEqual(opened, raw, 'la stessa frase riapre la chiave dati');
});

test('frase errata: involucro respinto e verifica fallita senza decifrare i dati', async () => {
  const salt = generateSalt();
  const { key, raw } = await generateDataKey();
  const wrapped = await wrapRawKey(raw, await deriveWrappingKey('frase corretta numero uno', salt, 'phrase'));
  const verify = await encryptJson(key, VERIFY_CONSTANT);

  // Con la frase giusta la verifica riesce.
  const okRaw = await unwrapRawKey(wrapped, await deriveWrappingKey('frase corretta numero uno', salt, 'phrase'));
  assert.deepEqual(await decryptJson(await importDataKey(okRaw), verify), VERIFY_CONSTANT);

  // Con la frase sbagliata si fallisce già sull'involucro/verifica,
  // senza mai provare a decifrare i dati degli alunni.
  const wrongKey = await deriveWrappingKey('frase sbagliata numero due', salt, 'phrase');
  await assert.rejects(() => unwrapRawKey(wrapped, wrongKey), 'involucro non apribile con frase errata');
});

test('domini separati: lo stesso sale non fa coincidere frase e codice di recupero', async () => {
  const salt = generateSalt();
  const secret = 'STESSASEQUENZADICARATTERI1';
  const fromPhrase = await deriveWrappingKey(secret, salt, 'phrase');
  const fromRecovery = await deriveWrappingKey(normalizeRecoveryCode(secret) ?? secret, salt, 'recovery');
  const { raw } = await generateDataKey();
  const wrapped = await wrapRawKey(raw, fromPhrase);
  await assert.rejects(() => unwrapRawKey(wrapped, fromRecovery), 'il dominio di derivazione è diverso');
});

test('codice di recupero: forma, normalizzazione e apertura della chiave dati', async () => {
  const code = generateRecoveryCode();
  const digits = code.replace(/-/g, '');
  assert.equal(digits.length, 24, '24 caratteri a gruppi di 4');
  assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){5}$/);
  assert.ok(!/[OI01]/.test(digits), 'nessun carattere ambiguo');

  // Normalizzazione: minuscole, spazi e trattini non contano.
  const messy = `  ${code.slice(0, 4).toLowerCase()} ${code.slice(5, 9)}-${code.slice(10)}  `;
  assert.equal(normalizeRecoveryCode(messy), digits);
  assert.equal(normalizeRecoveryCode('BREVE'), null, 'troppo corto: non è un codice');
  assert.equal(normalizeRecoveryCode('OOOO-OOOO-OOOO-OOOO-OOOO-OOOO'), null, 'caratteri fuori alfabeto');

  // Il codice sblocca davvero la chiave dati.
  const salt = generateSalt();
  const { key, raw } = await generateDataKey();
  const wrapped = await wrapRawKey(raw, await deriveWrappingKey(digits, salt, 'recovery'));
  const reopened = await unwrapRawKey(wrapped, await deriveWrappingKey(normalizeRecoveryCode(code)!, salt, 'recovery'));
  const blob = await encryptJson(key, { gloDate: '2026-11-12' });
  assert.deepEqual(await decryptJson(await importDataKey(reopened), blob), { gloDate: '2026-11-12' });
});

test('chiave dati sul dispositivo: importabile come CryptoKey non estraibile', async () => {
  const { raw } = await generateDataKey();
  const key = await importDataKey(raw, false);
  assert.equal(key.extractable, false, 'non estraibile in IndexedDB');
  assert.equal(key.type, 'secret');
  const blob = await encryptJson(key, { hasBesDsa: true });
  assert.deepEqual(await decryptJson(key, blob), { hasBesDsa: true });
});

// ---------------------------------------------------------------------------
// Keystore: documento chiavi, attivazione, sblocco, cambio frase
// ---------------------------------------------------------------------------

import {
  AlreadyActiveError,
  EncryptionKeystore,
  MIN_PHRASE_LENGTH,
  WrongSecretError,
  type KeysGateway,
  type KeysMetaStore,
} from '../src/services/encryptionKeys';
import { classifyRemoteStateDoc } from '../src/services/sync/remoteSchema';
import { isValidEncryptionKeysPayload } from '../src/services/sync/remoteSchema';
import { toBase64 } from '../src/services/sensitiveCrypto';

interface FakeKeysCloud { doc: { payload: unknown; updatedAt: string; schemaVersion: 1 } | null; writes: number }

function makeKeysCloud(cloud: FakeKeysCloud): KeysGateway {
  return {
    async readState() { return cloud.doc ? structuredClone(cloud.doc) : null; },
    async writeState(_name, payload) {
      cloud.writes++;
      cloud.doc = { payload: structuredClone(payload), updatedAt: new Date(Date.UTC(2026, 9, 9, 10, cloud.writes)).toISOString(), schemaVersion: 1 };
      return { updatedAt: cloud.doc.updatedAt };
    },
  };
}

function makeMeta(): { store: KeysMetaStore; rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return { rows, store: { read: async key => rows.get(key), write: async (key, value) => { rows.set(key, value); } } };
}

const makeKeystore = (cloud: FakeKeysCloud, meta: KeysMetaStore) =>
  new EncryptionKeystore({ gateway: () => makeKeysCloud(cloud), meta });

test('attivazione: documento chiavi nel cloud senza nulla in chiaro, dispositivo sbloccato', async () => {
  const cloud: FakeKeysCloud = { doc: null, writes: 0 };
  const { store, rows } = makeMeta();
  const keystore = makeKeystore(cloud, store);

  assert.equal(await keystore.status('uid-1'), 'inactive');
  await assert.rejects(() => keystore.activate('uid-1', 'corta'), /almeno/, 'frase troppo corta rifiutata');

  const { recoveryCode } = await keystore.activate('uid-1', 'la mia frase segreta lunga');
  assert.match(recoveryCode, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){5}$/, 'codice di recupero generato');

  // Il documento chiavi ha la forma prevista dallo schema remoto.
  const verdict = classifyRemoteStateDoc('encryptionKeys', cloud.doc);
  assert.equal(verdict.status, 'valid');
  assert.equal(isValidEncryptionKeysPayload(cloud.doc!.payload), true);

  // Nessun segreto in chiaro nel cloud: né frase, né codice, né chiave dati.
  const serialized = JSON.stringify(cloud.doc);
  assert.ok(!serialized.includes('la mia frase segreta lunga'), 'la frase non finisce nel cloud');
  assert.ok(!serialized.includes(recoveryCode.replace(/-/g, '')), 'il codice non finisce nel cloud');

  // La chiave dati è sul dispositivo come CryptoKey non estraibile.
  const deviceKey = await keystore.deviceKey('uid-1');
  assert.ok(deviceKey instanceof CryptoKey, 'CryptoKey conservata nelle righe metadata');
  assert.equal(deviceKey!.extractable, false);
  assert.equal([...rows.keys()].length, 1, 'una sola riga locale: la chiave');

  assert.equal(await keystore.status('uid-1'), 'unlocked');
  await assert.rejects(() => keystore.activate('uid-1', 'un altra frase valida qui'), AlreadyActiveError, 'una sola attivazione per account');
});

test('sblocco su un altro dispositivo: con la frase, col codice; frase errata rifiutata dalla verifica', async () => {
  const cloud: FakeKeysCloud = { doc: null, writes: 0 };
  const deviceA = makeMeta();
  const keystoreA = makeKeystore(cloud, deviceA.store);
  const { recoveryCode } = await keystoreA.activate('uid-1', 'prima frase segreta scelta');

  const deviceB = makeMeta();
  const keystoreB = makeKeystore(cloud, deviceB.store);
  assert.equal(await keystoreB.status('uid-1'), 'locked', 'chiavi nel cloud ma dispositivo da sbloccare');

  await assert.rejects(() => keystoreB.unlock('uid-1', 'frase completamente sbagliata', 'phrase'), WrongSecretError);

  await keystoreB.unlock('uid-1', 'prima frase segreta scelta', 'phrase');
  assert.equal(await keystoreB.status('uid-1'), 'unlocked');

  // Il codice di recupero sblocca un terzo dispositivo.
  const deviceC = makeMeta();
  const keystoreC = makeKeystore(cloud, deviceC.store);
  await keystoreC.unlock('uid-1', recoveryCode.toLowerCase().replace(/-/g, ' '), 'recovery');
  assert.equal(await keystoreC.status('uid-1'), 'unlocked');

  // Tutti e tre i dispositivi aprono lo stesso cifrato.
  const dati = { diagnosticSummary: 'Profilo di funzionamento' };
  const blob = await encryptJson((await keystoreA.deviceKey('uid-1'))!, dati);
  assert.deepEqual(await decryptJson((await keystoreB.deviceKey('uid-1'))!, blob), dati);
  assert.deepEqual(await decryptJson((await keystoreC.deviceKey('uid-1'))!, blob), dati);
});

test('cambio frase: riprotegge solo la chiave dati, senza ricifrare gli alunni', async () => {
  const cloud: FakeKeysCloud = { doc: null, writes: 0 };
  const { store } = makeMeta();
  const keystore = makeKeystore(cloud, store);
  const { recoveryCode } = await keystore.activate('uid-1', 'vecchia frase segreta lunga');

  // Cifrato di un alunno scritto PRIMA del cambio frase.
  const chiave = (await keystore.deviceKey('uid-1'))!;
  const blobAlunno = await encryptJson(chiave, { peiType: 'differenziato', supportHoursPerWeek: 9 });
  const prima = JSON.stringify(cloud.doc!.payload);

  await keystore.changePassphrase('uid-1', { secret: 'vecchia frase segreta lunga', kind: 'phrase' }, 'nuova frase segreta lunga');
  const dopo = cloud.doc!.payload as { wrappedPhrase: unknown; wrappedRecovery: unknown; verify: unknown; salt: string };
  const primaPayload = JSON.parse(prima) as { wrappedPhrase: unknown; wrappedRecovery: unknown; verify: unknown; salt: string };

  assert.notDeepEqual(dopo.wrappedPhrase, primaPayload.wrappedPhrase, 'involucro frase aggiornato');
  assert.deepEqual(dopo.wrappedRecovery, primaPayload.wrappedRecovery, 'codice di recupero invariato');
  assert.deepEqual(dopo.verify, primaPayload.verify, 'verifica invariata');
  assert.equal(dopo.salt, primaPayload.salt, 'sale invariato');

  // La chiave dati è la stessa: il blob dell'alunno si apre ancora, senza ricifrature.
  const deviceB = makeMeta();
  const keystoreB = makeKeystore(cloud, deviceB.store);
  await keystoreB.unlock('uid-1', 'nuova frase segreta lunga', 'phrase');
  assert.deepEqual(await decryptJson((await keystoreB.deviceKey('uid-1'))!, blobAlunno), { peiType: 'differenziato', supportHoursPerWeek: 9 });
  await assert.rejects(() => keystoreB.unlock('uid-1', 'vecchia frase segreta lunga', 'phrase'), WrongSecretError, 'la vecchia frase non apre più');

  // Il cambio frase funziona anche presentando il codice di recupero.
  await keystore.changePassphrase('uid-1', { secret: recoveryCode, kind: 'recovery' }, 'terza frase segreta valida');
  const deviceC = makeMeta();
  const keystoreC = makeKeystore(cloud, deviceC.store);
  await keystoreC.unlock('uid-1', 'terza frase segreta valida', 'phrase');
  assert.deepEqual(await decryptJson((await keystoreC.deviceKey('uid-1'))!, blobAlunno), { peiType: 'differenziato', supportHoursPerWeek: 9 });
});

test('sblocco automatico: stesso campo per frase o codice di recupero', async () => {
  const cloud: FakeKeysCloud = { doc: null, writes: 0 };
  const keystoreA = makeKeystore(cloud, makeMeta().store);
  const { recoveryCode } = await keystoreA.activate('uid-1', 'frase segreta numero uno');

  const b = makeMeta();
  const keystoreB = makeKeystore(cloud, b.store);
  await keystoreB.unlockAuto('uid-1', '  frase segreta numero uno  ');
  assert.equal(await keystoreB.status('uid-1'), 'unlocked');

  const c = makeMeta();
  const keystoreC = makeKeystore(cloud, c.store);
  await keystoreC.unlockAuto('uid-1', recoveryCode);
  assert.equal(await keystoreC.status('uid-1'), 'unlocked');

  const d = makeMeta();
  const keystoreD = makeKeystore(cloud, d.store);
  await assert.rejects(() => keystoreD.unlockAuto('uid-1', 'qualcosa che non c entra'), WrongSecretError);
});

test('costanti e utilità: lunghezza frase minima e chiave AES-GCM', async () => {
  assert.equal(MIN_PHRASE_LENGTH, 12, 'frase segreta di almeno 12 caratteri');
  assert.equal(typeof toBase64(new Uint8Array([1, 2, 3])), 'string');
  const { key } = await generateDataKey();
  assert.equal((key.algorithm as { name: string }).name, 'AES-GCM');
});

test('cambio frase automatico: stesso campo per frase attuale o codice di recupero', async () => {
  const cloud: FakeKeysCloud = { doc: null, writes: 0 };
  const keystore = makeKeystore(cloud, makeMeta().store);
  const { recoveryCode } = await keystore.activate('uid-1', 'prima frase segreta lunga');

  await keystore.changePassphraseAuto('uid-1', 'prima frase segreta lunga', 'seconda frase segreta lunga');
  const b = makeMeta();
  const keystoreB = makeKeystore(cloud, b.store);
  await keystoreB.unlock('uid-1', 'seconda frase segreta lunga', 'phrase');

  await keystoreB.changePassphraseAuto('uid-1', recoveryCode, 'terza frase segreta valida');
  const c = makeMeta();
  const keystoreC = makeKeystore(cloud, c.store);
  await keystoreC.unlock('uid-1', 'terza frase segreta valida', 'phrase');
  await assert.rejects(() => keystoreC.unlock('uid-1', 'seconda frase segreta lunga', 'phrase'), WrongSecretError);
});
