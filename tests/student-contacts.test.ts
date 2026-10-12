/**
 * Test delle funzioni pure per i contatti extra (normalizzazione, email).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isValidEmail,
  normalizeStudentContacts,
  isContactCompletelyEmpty,
  newEmptyContact,
  MAX_EXTRA_CONTACTS,
  CONTACT_STRING_MAX,
  CONTACT_NOTES_MAX,
} from '../src/utils/studentContacts';

test('isValidEmail: vuota è valida (facoltativa)', () => {
  assert.equal(isValidEmail(''), true);
  assert.equal(isValidEmail('   '), true);
});

test('isValidEmail: email benformate passano', () => {
  assert.equal(isValidEmail('m.rossi@asl.it'), true);
  assert.equal(isValidEmail('tutorDSA@scuola.edu'), true);
  assert.equal(isValidEmail('a@b.co'), true);
});

test('isValidEmail: email chiaramente non valide vengono rifiutate', () => {
  assert.equal(isValidEmail('mrossi'), false, 'manca @');
  assert.equal(isValidEmail('mrossi@'), false, 'manca dominio');
  assert.equal(isValidEmail('mrossi@asl'), false, 'manca punto nel dominio');
  assert.equal(isValidEmail('@asl.it'), false, 'manca parte locale');
  assert.equal(isValidEmail('m rossi@asl.it'), false, 'spazi non ammessi');
});

test('normalizeStudentContacts: input non array => undefined', () => {
  assert.equal(normalizeStudentContacts(undefined), undefined);
  assert.equal(normalizeStudentContacts(null), undefined);
  assert.equal(normalizeStudentContacts('x'), undefined);
  assert.equal(normalizeStudentContacts({}), undefined);
});

test('normalizeStudentContacts: array vuoto => undefined (mai [])', () => {
  assert.equal(normalizeStudentContacts([]), undefined);
});

test('normalizeStudentContacts: contatti completamente vuoti sono scartati', () => {
  assert.equal(
    normalizeStudentContacts([{ id: 'a', role: 'tutor' }, { id: 'b', role: 'altro', name: '  ' }]),
    undefined,
  );
});

test('normalizeStudentContacts: ruolo non valido scarta l\'elemento', () => {
  const out = normalizeStudentContacts([
    { id: 'a', role: 'ruolo_inesistente', name: 'Mario' },
    { id: 'b', role: 'tutor', name: 'Anna' },
  ]);
  assert.ok(out);
  assert.equal(out!.length, 1);
  assert.equal(out![0].name, 'Anna');
  assert.equal(out![0].role, 'tutor');
});

test('normalizeStudentContacts: trim e limiti di lunghezza', () => {
  const out = normalizeStudentContacts([{
    id: 'x',
    role: 'terapista',
    name: '  Mario Bianchi  ',
    phone: ' 3331234567 ',
    roleDetail: 'A'.repeat(CONTACT_STRING_MAX + 50),
    notes: 'B'.repeat(CONTACT_NOTES_MAX + 50),
  }]);
  assert.ok(out);
  assert.equal(out![0].name, 'Mario Bianchi');
  assert.equal(out![0].phone, '3331234567');
  assert.equal(out![0].roleDetail!.length, CONTACT_STRING_MAX);
  assert.equal(out![0].notes!.length, CONTACT_NOTES_MAX);
});

test('normalizeStudentContacts: massimo 20 contatti', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`, role: 'altro' as const, name: `Contatto ${i}`,
  }));
  const out = normalizeStudentContacts(many);
  assert.ok(out);
  assert.equal(out!.length, MAX_EXTRA_CONTACTS);
});

test('normalizeStudentContacts: genera un id se mancante o vuoto', () => {
  const out = normalizeStudentContacts([{ role: 'medico', name: 'Dr. House' }]);
  assert.ok(out);
  assert.equal(out!.length, 1);
  assert.ok(typeof out![0].id === 'string' && out![0].id.length > 0);
});

test('isContactCompletelyEmpty: true se nessun campo compilato', () => {
  assert.equal(isContactCompletelyEmpty({}), true);
  assert.equal(isContactCompletelyEmpty({ role: 'tutor' }), true);
  assert.equal(isContactCompletelyEmpty({ id: 'a', role: 'tutor', name: '  ' }), true);
});

test('isContactCompletelyEmpty: false se anche un solo campo è compilato', () => {
  assert.equal(isContactCompletelyEmpty({ role: 'tutor', name: 'Anna' }), false);
  assert.equal(isContactCompletelyEmpty({ role: 'tutor', phone: '123' }), false);
  assert.equal(isContactCompletelyEmpty({ role: 'tutor', email: 'a@b.it' }), false);
  assert.equal(isContactCompletelyEmpty({ role: 'tutor', roleDetail: 'Logopedista' }), false);
  assert.equal(isContactCompletelyEmpty({ role: 'tutor', notes: 'nota' }), false);
});

test('newEmptyContact: produce un contatto bozza con id e ruolo di default', () => {
  const a = newEmptyContact();
  const b = newEmptyContact();
  assert.notEqual(a.id, b.id, 'id unici');
  assert.equal(a.role, 'tutor');
});
