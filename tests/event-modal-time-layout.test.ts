import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { EventModal, getEventModalTimeFields } from '../src/components/EventModal';
import type { CalendarEvent, TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Layout responsive dei campi "Ora Inizio" / "Ora Fine" nel form
 * Nuovo/Modifica Impegno:
 *  - smartphone: impilati, un campo per riga a tutta larghezza;
 *  - da sm (640px, convenzione già usata nel resto dell'app): affiancati;
 *  - gli input mantengono type="time" e possono restringersi senza overflow
 *    (w-full + min-w-0 su input e cella: su iOS Safari il type="time" ha una
 *    larghezza intrinseca rilevante);
 *  - creazione e modifica continuano a usare gli stessi campi con gli stessi valori.
 */

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Matematica'],
  classes: ['2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

const classTokens = (node: any): string[] => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean);

const text = (node: any): string => {
  if (!node) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(text).join(' ');
};

/** I due input time e il loro contenitore grid (ordine DOM: inizio, fine). */
function timeFields(renderer: any) {
  const inputs = renderer.root.findAll((n: any) => n.type === 'input' && n.props.type === 'time');
  assert.equal(inputs.length, 2, 'esattamente due input time (inizio e fine)');
  const cells = [inputs[0].parent, inputs[1].parent];
  const grid = inputs[0].parent.parent;
  return { inputs, cells, grid };
}

function assertTimeLabels(renderer: any) {
  const { cells } = timeFields(renderer);
  const labels = cells.map((cell: any) => {
    const label = cell.children.find((n: any) => n.type === 'label');
    return text(label).trim();
  });
  assert.deepEqual(labels, ['Ora Inizio', 'Ora Fine'], 'etichette invariati, ordine invariato');
}

/**
 * Verifica strutturale del layout: DUE COLONNE a ogni larghezza (anche iPhone),
 * gap adeguato, e ogni pezzo può restringersi senza sovrapposizioni (il vecchio
 * bug iOS nasceva dall'assenza di min-width: 0, non dalla griglia a due
 * colonne). Etichette leggibili e touch target >= 44px.
 */
function assertResponsiveTimeLayout(renderer: any) {
  const { inputs, cells, grid } = timeFields(renderer);
  const tokens = classTokens(grid);
  assert.ok(tokens.includes('grid-cols-2'), 'due colonne anche su smartphone');
  assert.ok(!tokens.includes('grid-cols-1'), 'niente riga impilata: i campi stanno affiancati');
  assert.ok(tokens.includes('gap-3'), 'gap adeguato fra le colonne');
  for (const cell of cells) {
    assert.ok(classTokens(cell).includes('min-w-0'), 'cella della grid può restringersi (min-width: 0)');
  }
  for (const input of inputs) {
    const it = classTokens(input);
    assert.ok(it.includes('w-full'), 'input a tutta la larghezza della sua colonna');
    assert.ok(it.includes('min-w-0'), 'input si restringe senza overflow (min-width: 0, serve a iOS)');
    assert.ok(it.includes('min-h-[44px]'), 'touch target >= 44px');
  }
  assert.deepEqual(inputs.map((i: any) => i.props.type), ['time', 'time'], 'entrambi restano input nativi time');
}

async function renderModal(overrides: Partial<React.ComponentProps<typeof EventModal>> = {}) {
  const saved: CalendarEvent[] = [];
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true,
      onClose: () => {},
      eventToEdit: null,
      profile,
      onSave: (ev) => { saved.push(ev); },
      ...overrides,
    }));
  });
  return { renderer, saved };
}

async function submitForm(renderer: any) {
  const form = renderer.root.findByType('form');
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });
}

test('1. creazione: i campi orari sono affiancati su due colonne anche su mobile e salvano i loro valori', async () => {
  const { renderer, saved } = await renderModal();
  assertResponsiveTimeLayout(renderer);
  assertTimeLabels(renderer);
  const { inputs } = timeFields(renderer);
  const defaults = getEventModalTimeFields(null);
  assert.equal(inputs[0].props.value, defaults.startTime, 'default ora inizio per un nuovo impegno');
  assert.equal(inputs[1].props.value, defaults.endTime, 'default ora fine per un nuovo impegno');
  // Titolo + submit: i due campi orari sono quelli effettivamente salvati.
  const title = renderer.root.findAll((n: any) => n.type === 'input' && n.props.type === 'text' && n.props.required)[0];
  await act(async () => { title.props.onChange({ target: { value: 'Consiglio 2E' } }); });
  await submitForm(renderer);
  assert.equal(saved.length, 1, 'l impegno viene salvato');
  assert.equal(saved[0].startTime, defaults.startTime, 'il campo ora inizio finisce nel salvataggio');
  assert.equal(saved[0].endTime, defaults.endTime, 'il campo ora fine finisce nel salvataggio');
  await act(async () => { renderer.unmount(); });
});

test('2. modifica: stessi campi, stessi valori iniziali, layout identico e salvataggio coerente', async () => {
  const existing: CalendarEvent = {
    id: 'ev-1', title: 'Dipartimento', category: 'dipartimento', date: '2026-09-25',
    startTime: '08:30', endTime: '10:15', isAllDay: false,
    className: '2E', subject: 'Matematica', location: 'Sala Docenti',
    sourceType: 'manuale', completed: false,
  };
  const { renderer, saved } = await renderModal({ eventToEdit: existing });
  assertResponsiveTimeLayout(renderer);
  assertTimeLabels(renderer);
  const { inputs } = timeFields(renderer);
  assert.equal(inputs[0].props.value, '08:30', 'modifica: valore esistente di ora inizio');
  assert.equal(inputs[1].props.value, '10:15', 'modifica: valore esistente di ora fine');
  // Cambio l ora inizio tramite lo stesso campo: il form lo riflette e lo salva.
  await act(async () => { inputs[0].props.onChange({ target: { value: '09:00' } }); });
  assert.equal(timeFields(renderer).inputs[0].props.value, '09:00', 'il campo aggiornato riflette il nuovo valore');
  await submitForm(renderer);
  assert.equal(saved.length, 1, 'la modifica viene salvata');
  assert.equal(saved[0].id, 'ev-1', 'stesso impegno');
  assert.equal(saved[0].startTime, '09:00', 'ora inizio aggiornata');
  assert.equal(saved[0].endTime, '10:15', 'ora fine invariata');
  await act(async () => { renderer.unmount(); });
});

test('3. con "Intera giornata" i campi orari non si mostrano (comportamento preesistente)', async () => {
  const { renderer } = await renderModal();
  const checkbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked === false && n.props.className?.includes('text-emerald-700'));
  assert.ok(checkbox, 'il checkbox "Intera giornata" esiste');
  assert.equal(timeFields(renderer).inputs.length, 2, 'prima: entrambi i campi orari visibili');
  await act(async () => { checkbox.props.onChange({ target: { checked: true } }); });
  const none = renderer.root.findAll((n: any) => n.type === 'input' && n.props.type === 'time');
  assert.equal(none.length, 0, 'dopo: nessun campo orario');
  await act(async () => { renderer.unmount(); });
});
