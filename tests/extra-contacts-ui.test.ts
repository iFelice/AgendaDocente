/**
 * Test UI per "Altri contatti" nella scheda alunno.
 * - alunno senza contatti: solo pulsante aggiungi, nessun input di contatto;
 * - "+ Aggiungi contatto" mostra una scheda;
 * - "Rimuovi" la elimina;
 * - dispositivo bloccato: avviso e nessun pulsante;
 * - il colloquio generato NON contiene contatti extra.
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { ClassesView } from '../src/components/ClassesView';
import { LOCKED_SENSITIVE_NOTICE } from '../src/services/sensitiveData';
import { encryptJson, generateDataKey } from '../src/services/sensitiveCrypto';
import type { Student, TeacherProfile, CalendarEvent } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const textAll = (node: any): string => {
  if (!node) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(textAll).join(' ');
};

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Test', schoolName: 'IC Prova',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A'], campuses: [], roles: [], isSupportTeacher: true,
};

const baseStudent = (patch: Partial<Student> = {}): Student => ({
  id: 's1',
  fullName: 'Mario Rossi',
  className: '1A',
  notes: [],
  ...patch,
});

async function mount(students: Student[], onScheduleEvent: (e: Partial<CalendarEvent>) => void = () => {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(ClassesView, {
      profile,
      students,
      onSaveStudent: () => {},
      onDeleteStudent: () => {},
      onAddNote: () => {},
      onDeleteNote: () => {},
      onScheduleEvent,
    }));
  });
  return renderer;
}

function buttonLabel(b: any): string {
  const ch = b.props?.children;
  if (typeof ch === 'string') return ch;
  if (Array.isArray(ch)) return ch.map((c: any) => typeof c === 'string' ? c : (c?.props?.children ? String(c.props.children) : '')).join(' ');
  return '';
}

test('UI: alunno nuovo: pulsante "+ Aggiungi contatto" e nessuna scheda; clic la aggiunge; Rimuovi la elimina', async () => {
  const renderer = await mount([]);

  // Apri il modale "Nuovo Alunno"
  const addBtn = renderer.root.findByProps({ id: 'btn-add-student' });
  await act(async () => { addBtn.props.onClick(); });

  const rendered = textAll(renderer.toJSON());
  assert.ok(rendered.includes('Altri contatti (tutor, terapisti, educatori)'), 'sezione presente');
  assert.ok(rendered.includes('Dati riservati: cifrati come PEI ed équipe.'), 'riga riservatezza');
  assert.ok(rendered.includes('Aggiungi contatto'), 'pulsante + Aggiungi contatto visibile');

  // Nessuna scheda di contatto iniziale (il bottone Rimuovi NON c'è)
  let buttons = renderer.root.findAllByType('button').map(buttonLabel);
  assert.ok(!buttons.some((l: string) => l.includes('Rimuovi')), 'nessun Rimuovi a video');

  // Clic "+ Aggiungi contatto"
  const addContactBtn = renderer.root.findAllByType('button').find(
    (b: any) => buttonLabel(b).includes('Aggiungi contatto')
  );
  assert.ok(addContactBtn, 'pulsante Aggiungi contatto trovato');
  await act(async () => { addContactBtn.props.onClick(); });

  const afterAdd = textAll(renderer.toJSON());
  assert.ok(afterAdd.includes('Tutore legale'), 'dopo aggiunta: compare il ruolo');
  assert.ok(afterAdd.includes('Rimuovi'), 'compare Rimuovi');

  buttons = renderer.root.findAllByType('button').map(buttonLabel);
  assert.equal(buttons.filter((l: string) => l.includes('Rimuovi')).length, 1, 'un solo contatto => un solo Rimuovi');

  // Rimuovi
  const removeBtn = renderer.root.findAllByType('button').find((b: any) => buttonLabel(b).includes('Rimuovi'));
  await act(async () => { removeBtn.props.onClick(); });

  const afterRemove = textAll(renderer.toJSON());
  assert.ok(!afterRemove.includes('Rimuovi'), 'dopo rimozione: scheda scomparsa');
  assert.ok(afterRemove.includes('Aggiungi contatto'));

  renderer.unmount();
});

test('UI: dispositivo bloccato -> avviso LOCKED_SENSITIVE_NOTICE e nessun pulsante Aggiungi', async () => {
  const { key } = await generateDataKey();
  const sensitive = { extraContacts: [{ id: 'c1', role: 'tutor' as const, name: 'Anna' }] };
  const blob = await encryptJson(key, sensitive);
  const lockedStudent = baseStudent({ sensitiveEnc: blob });

  const renderer = await mount([lockedStudent]);

  // Apri modifica
  const editBtn = renderer.root.findAllByType('button').find((b: any) => b.props.title === 'Modifica dati alunno');
  assert.ok(editBtn, 'trovato il pulsante modifica');
  await act(async () => { editBtn.props.onClick({ stopPropagation: () => {} }); });

  const rendered = textAll(renderer.toJSON());
  assert.ok(rendered.includes(LOCKED_SENSITIVE_NOTICE), 'avviso di blocco visibile');
  const buttons = renderer.root.findAllByType('button').map(buttonLabel);
  assert.ok(!buttons.some((l: string) => l.includes('Aggiungi contatto')), 'pulsante Aggiungi non presente (bloccato)');

  renderer.unmount();
});

test('Colloquio genitori: i contatti extra NON finiscono nelle note dell\'evento', async () => {
  let scheduled: Partial<CalendarEvent> | null = null;
  const student = baseStudent({
    contactParents: { parentNames: 'Sig.ra Rossi', phone: '0612345' },
    extraContacts: [{ id: 'c1', role: 'terapista' as const, name: 'Dr.ssa Nera', phone: '9999999', email: 'n@asl.it' }],
  });

  const renderer = await mount([student], (p) => { scheduled = p; });

  // Cerca il bottone "+ Colloquio" sulla card.
  const colloquioBtn = renderer.root.findAllByType('button').find(
    (b: any) => b.props.title === 'Fissa colloquio con i genitori nel calendario'
  );
  assert.ok(colloquioBtn);
  await act(async () => { colloquioBtn.props.onClick(); });

  assert.ok(scheduled, 'evento schedulato');
  const notes = scheduled!.notes || '';
  assert.ok(notes.includes('0612345'), 'recapito genitori nelle note');
  assert.ok(!notes.includes('9999999'), 'telefono extra contatto NON nelle note');
  assert.ok(!notes.includes('n@asl.it'), 'email extra contatto NON nelle note');
  assert.ok(!notes.includes('Dr.ssa Nera'), 'nome terapista NON nelle note');

  renderer.unmount();
});

test('UI: massimo 20 contatti -> pulsante disattivato con messaggio', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`, role: 'altro' as const, name: `Contatto ${i}`,
  }));
  const student = baseStudent({ extraContacts: many });

  const renderer = await mount([student]);

  const editBtn = renderer.root.findAllByType('button').find((b: any) => b.props.title === 'Modifica dati alunno');
  await act(async () => { editBtn.props.onClick({ stopPropagation: () => {} }); });

  const addBtn = renderer.root.findAllByType('button').find((b: any) => buttonLabel(b).includes('Aggiungi contatto') || buttonLabel(b).includes('Massimo 20 contatti'));
  assert.ok(addBtn, 'pulsante presente');
  assert.equal(addBtn.props.disabled, true, 'pulsante disattivato');
  assert.ok(buttonLabel(addBtn).includes('Massimo 20 contatti'));

  renderer.unmount();
});
