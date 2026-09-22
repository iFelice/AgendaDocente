import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { EventModal, getEventModalTimeFields } from '../src/components/EventModal';
import type { CalendarEvent, TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../src/index.css'), 'utf8');

/*
 * Layout dei campi "Ora Inizio" / "Ora Fine" nel form Nuovo/Modifica Impegno:
 *  - smartphone: impilati su una colonna a tutta larghezza (un campo per riga
 *    non puo mai sovrapporsi); da sm (640px) in su affiancati su due colonne;
 *  - la classe scoped event-time-duo e la relativa regola appearance:none sono
 *    state RIMOSSE (tentativo superato): il layout a 4 campi (Ora Inizio,
 *    Aula/Spazio, Ora Fine, Plesso/Sede) vive nel modal slot-edit del
 *    TimetableEditor come griglia unica 2 righe x 2 colonne;
 *  - il font mobile 16px anti auto-zoom NON viene toccato;
 *  - gli input mantengono type="time", w-full, min-w-0 e touch target >= 44px;
 *  - creazione, modifica e all-day continuano a comportarsi come prima.
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
 * Verifica strutturale del layout: UNA COLONNA su smartphone (i campi sono
 * impilati: nessuna sovrapposizione possibile fra i controlli nativi type=time
 * di iOS) e DUE COLONNE da sm (640px) in su. Nessuna classe scoped residua
 * (event-time-duo rimosso). min-w-0/w-full come difesa strutturale, touch
 * target >= 44px, etichette leggibili.
 */
function assertResponsiveTimeLayout(renderer: any) {
  const { inputs, cells, grid } = timeFields(renderer);
  const tokens = classTokens(grid);
  assert.ok(tokens.includes('grid-cols-1'), 'smartphone: una colonna (campi impilati, mai sovrapposti)');
  assert.ok(tokens.includes('sm:grid-cols-2'), 'da sm (640px) in su: due colonne affiancate');
  assert.ok(!tokens.includes('grid-cols-2'), 'nessuna griglia a due colonne fissa a tutti i breakpoint');
  assert.ok(!tokens.includes('event-time-duo'), 'classe sperimentale event-time-duo rimossa');
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

test('1. creazione: i campi orari sono impilati su mobile, affiancati da sm, e salvano i loro valori', async () => {
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

test('4. event-time-duo e la regola appearance:none sono rimasti indietro; il font mobile 16px resta invariato', () => {
  const componentSource = readFileSync(resolve(here, '../src/components/EventModal.tsx'), 'utf8');
  assert.ok(!css.includes('event-time-duo'), 'nessun residuo CSS di event-time-duo in index.css');
  assert.ok(!css.includes('.event-time-duo input[type="time"]'), 'il selettore scoped è stato rimosso');
  assert.ok(!css.includes('-webkit-appearance'), 'nessuna regola -webkit-appearance residua in index.css');
  assert.ok(!css.includes('appearance: none'), 'nessuna regola appearance:none residua in index.css');
  assert.ok(!componentSource.includes('event-time-duo'), 'nessun residuo della classe nel componente');
  const fontIdx = css.indexOf('font-size: 16px');
  assert.ok(fontIdx > -1, 'la regola globale del font mobile 16px è ancora presente');
  const fontMedia = css.lastIndexOf('@media (max-width: 767.98px)', fontIdx);
  assert.ok(fontMedia > -1 && css.slice(fontMedia, fontIdx).includes('input,'), 'la regola 16px continua a coprire input, select e textarea');
});
