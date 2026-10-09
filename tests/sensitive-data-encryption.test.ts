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
