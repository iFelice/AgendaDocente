/**
 * Test: extraContacts è un campo riservato.
 * - rimosso dal payload cloud e dal payload analisi;
 * - presente nel blob cifrato e ripristinato dopo decifratura (round-trip);
 * - decifratura con extraContacts malformato scarta elementi invalidi.
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptJson, decryptJson, generateDataKey } from '../src/services/sensitiveCrypto';
import {
  SENSITIVE_STUDENT_FIELDS,
  withoutSensitiveStudent,
  withoutSensitiveProfile,
  pickSensitiveStudentFields,
  stripSensitiveStudentFields,
  hasSensitiveStudentData,
} from '../src/services/sensitiveData';
import { normalizeStudentContacts } from '../src/utils/studentContacts';
import type { Student } from '../src/types';

test('extraContacts è nell\'elenco dei campi riservati', () => {
  assert.ok((SENSITIVE_STUDENT_FIELDS as readonly string[]).includes('extraContacts'));
});

test('withoutSensitiveStudent rimuove extraContacts', () => {
  const s: Student = {
    id: 's1', fullName: 'Mario', className: '2A', notes: [],
    extraContacts: [{ id: 'c1', role: 'tutor', name: 'Anna' }],
    diagnosticSummary: 'riservato',
  };
  const clean = withoutSensitiveStudent(s);
  assert.equal(clean.extraContacts, undefined);
  assert.equal(clean.diagnosticSummary, undefined);
  assert.equal(clean.fullName, 'Mario', 'gli altri campi restano');
  // originale intatto
  assert.ok(s.extraContacts);
});

test('stripSensitiveStudentFields (input non fidato) rimuove extraContacts', () => {
  const clean = stripSensitiveStudentFields({
    id: 's1', fullName: 'Mario',
    extraContacts: [{ id: 'c1', role: 'terapista' }],
  }) as Record<string, unknown>;
  assert.equal(clean.extraContacts, undefined);
  assert.equal(clean.fullName, 'Mario');
});

test('pickSensitiveStudentFields include extraContacts solo se è un array non vuoto', () => {
  const withEmpty = pickSensitiveStudentFields({ id: 's', extraContacts: [] });
  assert.equal(withEmpty.extraContacts, undefined, 'array vuoto non cifrato');
  const withData = pickSensitiveStudentFields({
    id: 's', extraContacts: [{ id: 'c1', role: 'medico', name: 'Dr.' }],
  });
  assert.ok(Array.isArray(withData.extraContacts));
  assert.equal((withData.extraContacts as any[]).length, 1);
});

test('hasSensitiveStudentData: un array vuoto NON conta', () => {
  assert.equal(hasSensitiveStudentData({ id: 's', extraContacts: [] }), false);
  assert.equal(hasSensitiveStudentData({ id: 's', extraContacts: undefined }), false);
  assert.equal(hasSensitiveStudentData({ id: 's' }), false);
  assert.equal(hasSensitiveStudentData({ id: 's', extraContacts: [{ id: 'c1', role: 'tutor' }] }), true);
});

test('cifratura/decifratura round-trip di extraContacts', async () => {
  const { key } = await generateDataKey();
  const sensitive = {
    diagnosticSummary: 'sintesi',
    extraContacts: [
      { id: 'c1', role: 'terapista', name: 'Laura', phone: '3330000000' },
      { id: 'c2', role: 'educatore', roleDetail: 'AEC comunale', name: 'Marco', email: 'm@coop.it' },
    ],
  };
  const blob = await encryptJson(key, sensitive);
  const decrypted = await decryptJson(key, blob) as Record<string, unknown>;
  assert.equal(decrypted.diagnosticSummary, 'sintesi');
  assert.ok(Array.isArray(decrypted.extraContacts));
  const normalized = normalizeStudentContacts(decrypted.extraContacts);
  assert.ok(normalized);
  assert.equal(normalized!.length, 2);
  assert.equal(normalized![0].name, 'Laura');
});

test('decifratura con extraContacts malformato: elementi invalidi scartati, resto intatto', async () => {
  const { key } = await generateDataKey();
  const garbage = {
    diagnosticSummary: 'dati validi',
    extraContacts: [
      { id: 'ok', role: 'tutor', name: 'Valido' },
      { id: 'bad1', role: 'ruolo_inesistente', name: 'Da scartare' }, // ruolo invalido
      'non-oggetto', // non è un oggetto
      { id: 'bad2' }, // manca role
      null,
      { id: 'empty', role: 'altro' }, // completamente vuoto
      { id: 'ok2', role: 'medico', name: 'Dr. X', notes: 'NPI' },
    ],
  };
  const blob = await encryptJson(key, garbage);
  const decrypted = await decryptJson(key, blob) as Record<string, unknown>;
  assert.equal(decrypted.diagnosticSummary, 'dati validi', 'gli altri campi sono intatti');
  const cleaned = normalizeStudentContacts(decrypted.extraContacts);
  assert.ok(cleaned);
  assert.equal(cleaned!.length, 2);
  assert.equal(cleaned![0].name, 'Valido');
  assert.equal(cleaned![1].name, 'Dr. X');
});

test('normalizeStudentContacts tollera un campo con lunghezza eccessiva (troncato) e campi non-stringa', () => {
  const cleaned = normalizeStudentContacts([{
    id: 'c1', role: 'tutor', name: 42 as any, phone: { toString: () => 'x' } as any, email: 'a@b.it',
  }]);
  assert.ok(cleaned);
  assert.equal(cleaned!.length, 1);
  assert.equal(cleaned![0].name, undefined, 'number scartato');
  assert.equal(cleaned![0].phone, undefined, 'oggetto non stringa scartato');
  assert.equal(cleaned![0].email, 'a@b.it');
});
