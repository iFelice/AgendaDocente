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
 * Layout compatto del form Nuovo/Modifica Impegno su smartphone (dal test
 * reale su iPhone): UNA SOLA griglia 2 righe x 2 colonne per i quattro campi
 *
 *   RIGA 1: Ora Inizio | Classe Interessata
 *   RIGA 2: Ora Fine   | Materia
 *
 * con Luogo/Modalita e Note sempre a tutta larghezza fuori dalla griglia.
 * Vincolo fondamentale: MAI due input type="time" sulla stessa riga (il
 * controllo nativo iOS ha una larghezza intrinseca rilevante); l'ordine DOM
 * Ora Inizio, Classe, Ora Fine, Materia con la grid che riempie riga per riga
 * lo garantisce strutturalmente. Colonne minmax(0,1.15fr)/minmax(0,0.85fr):
 * entrambe realmente restringibili, piu spazio al controllo time. Con
 * "Intera giornata" le due celle orarie spariscono e la griglia mostra
 * Classe | Materia su una riga, senza buchi. Nessun workaround
 * event-time-duo/appearance:none; il font mobile 16px anti auto-zoom resta
 * invariato. Creazione, modifica, validazione e salvataggio invariati.
 */

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Matematica'],
  classes: ['2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

const QUAD = 'grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]';

const classTokens = (node: any): string[] => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean);

const text = (node: any): string => {
  if (!node) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(text).join(' ');
};

function nodeText(node: any): string {
  const parts: string[] = [];
  const walk = (n: any) => {
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return; }
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.children)) n.children.forEach(walk);
    else if (typeof n.children === 'string' || typeof n.children === 'number') parts.push(String(n.children));
  };
  walk(node);
  return parts.join(' ');
}
const flatText = (node: any) => nodeText(node).replace(/\s+/g, ' ').trim();

/** La griglia quad e le sue celle dirette, senza vincolo sul numero (serve
 * anche in modalita all-day, quando le celle orarie sono nascoste). */
function findQuad(renderer: any) {
  const grids = renderer.root.findAll((n: any) => n.type === 'div' && classTokens(n).includes(QUAD));
  assert.equal(grids.length, 1, 'una sola griglia quad nel form');
  const cells = grids[0].findAll((n: any) => n.type === 'div' && n.parent === grids[0]);
  return { quad: grids[0], cells };
}

/** La griglia quad 2x2 completa e le sue 4 celle dirette nell'ordine DOM. */
function quadOf(renderer: any) {
  const { quad, cells } = findQuad(renderer);
  assert.equal(cells.length, 4, 'esattamente 4 celle dirette nella quad');
  return { quad, cells };
}

function cellLabel(cell: any): string {
  const label = cell.children.find((n: any) => n.type === 'label');
  return flatText(label);
}

function assertQuadLayout(renderer: any) {
  const { quad, cells } = quadOf(renderer);
  const tokens = classTokens(quad);
  assert.ok(tokens.includes('gap-3'), 'gap adeguato fra le colonne');
  assert.ok(!tokens.includes('grid-cols-1'), 'nessuna variante mobile impilata sulla quad');
  assert.ok(!tokens.includes('grid-cols-2'), 'nessuna grid-cols-2 fissa sulla quad');

  // Ordine esatto: riga 1 = Ora Inizio | Classe, riga 2 = Ora Fine | Materia.
  assert.deepEqual(
    cells.map(cellLabel),
    ['Ora Inizio', 'Classe Interessata', 'Ora Fine', 'Materia'],
    'ordine DOM: Ora Inizio, Classe Interessata, Ora Fine, Materia (2 righe esatte)',
  );

  // MAI due input time sulla stessa riga: le celle dei due orari non sono
  // adiacenti (0 e 2: separate dalla cella Classe) e l'unica griglia che li
  // contiene entrambi e la quad.
  const inputs = cells.map((c: any) => c.findAll((n: any) => n.type === 'input'));
  assert.deepEqual(
    inputs.map((pair: any[]) => pair.map((i: any) => i.props.type)),
    [['time'], ['text'], ['time'], ['text']],
    'tipi per cella: time, text, time, text',
  );
  const gridsWithBothTimes = renderer.root.findAll((n: any) =>
    n.type === 'div' &&
    n.findAll((i: any) => i.type === 'input' && i.props.type === 'time' && i.parent.parent === n).length === 2);
  assert.equal(gridsWithBothTimes.length, 1, 'una sola griglia contiene i due input time');
  assert.ok(gridsWithBothTimes[0] === quad, 'quella griglia e la quad');

  // Celle tutte min-w-0; controlli tutti w-full + min-w-0 + min-h-[44px].
  for (const cell of cells) {
    assert.ok(classTokens(cell).includes('min-w-0'), 'cella della grid min-w-0');
  }
  const allInputs = quad.findAll((n: any) => n.type === 'input');
  assert.equal(allInputs.length, 4, 'la quad contiene tutti e 4 i campi');
  for (const input of allInputs) {
    const it = classTokens(input);
    assert.ok(it.includes('w-full'), 'input w-full');
    assert.ok(it.includes('min-w-0'), 'input min-w-0');
    assert.ok(it.includes('min-h-[44px]'), 'touch target >= 44px');
  }
  return { quad, cells, inputs: allInputs };
}

function assertLuogoENoteFullWidth(renderer: any) {
  const { quad } = findQuad(renderer);
  const luogo = renderer.root.findAll((n: any) => n.type === 'input' && String(n.props.placeholder ?? '').includes('Aula Magna'));
  assert.equal(luogo.length, 1, 'il campo Luogo / Modalita esiste');
  assert.ok(!quad.findAll((n: any) => n === luogo[0]).length, 'Luogo / Modalita e fuori dalla quad');
  assert.ok(classTokens(luogo[0]).includes('w-full'), 'Luogo / Modalita a tutta larghezza');
  const notes = renderer.root.findAll((n: any) => n.type === 'textarea');
  assert.equal(notes.length, 1, 'il campo Note esiste');
  assert.ok(!quad.findAll((n: any) => n === notes[0]).length, 'Note e fuori dalla quad');
  assert.ok(classTokens(notes[0]).includes('w-full'), 'Note a tutta larghezza');
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

test('1. creazione: griglia 2x2 (Ora Inizio|Classe, Ora Fine|Materia) e salvataggio con i valori di default', async () => {
  const { renderer, saved } = await renderModal();
  const { inputs } = assertQuadLayout(renderer);
  assertLuogoENoteFullWidth(renderer);
  const defaults = getEventModalTimeFields(null);
  const [inizio, classe, fine, materia] = inputs;
  assert.equal(inizio.props.value, defaults.startTime, 'default ora inizio per un nuovo impegno');
  assert.equal(fine.props.value, defaults.endTime, 'default ora fine per un nuovo impegno');
  // Precompilazione pre-esistente su evento nuovo: prima classe e prima materia del profilo.
  assert.equal(classe.props.value, '2E', 'classe precompilata con profile.classes[0]');
  assert.equal(materia.props.value, 'Matematica', 'materia precompilata con profile.primarySubjects[0]');
  // Titolo + submit: i quattro campi finiscono nel salvataggio com'era prima.
  const title = renderer.root.findAll((n: any) => n.type === 'input' && n.props.type === 'text' && n.props.required)[0];
  await act(async () => { title.props.onChange({ target: { value: 'Consiglio 2E' } }); });
  await act(async () => { classe.props.onChange({ target: { value: '2e' } }); });
  await act(async () => { materia.props.onChange({ target: { value: 'Matematica' } }); });
  await submitForm(renderer);
  assert.equal(saved.length, 1, 'l impegno viene salvato');
  assert.equal(saved[0].startTime, defaults.startTime, 'il campo ora inizio finisce nel salvataggio');
  assert.equal(saved[0].endTime, defaults.endTime, 'il campo ora fine finisce nel salvataggio');
  assert.equal(saved[0].className, '2E', 'la classe finisce nel salvataggio (normalizzazione invariata)');
  assert.equal(saved[0].subject, 'Matematica', 'la materia finisce nel salvataggio');
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
  const { inputs } = assertQuadLayout(renderer);
  assertLuogoENoteFullWidth(renderer);
  const [inizio, classe, fine, materia] = inputs;
  assert.equal(inizio.props.value, '08:30', 'modifica: valore esistente di ora inizio');
  assert.equal(fine.props.value, '10:15', 'modifica: valore esistente di ora fine');
  assert.equal(classe.props.value, '2E', 'modifica: classe esistente');
  assert.equal(materia.props.value, 'Matematica', 'modifica: materia esistente');
  // Cambio l ora inizio tramite lo stesso campo: il form lo riflette e lo salva.
  await act(async () => { inizio.props.onChange({ target: { value: '09:00' } }); });
  const after = assertQuadLayout(renderer).inputs;
  assert.equal(after[0].props.value, '09:00', 'il campo aggiornato riflette il nuovo valore');
  await submitForm(renderer);
  assert.equal(saved.length, 1, 'la modifica viene salvata');
  assert.equal(saved[0].id, 'ev-1', 'stesso impegno');
  assert.equal(saved[0].startTime, '09:00', 'ora inizio aggiornata');
  assert.equal(saved[0].endTime, '10:15', 'ora fine invariata');
  await act(async () => { renderer.unmount(); });
});

test('3. con "Intera giornata" le celle orarie spariscono senza buchi: la griglia mostra Classe | Materia su una riga', async () => {
  const { renderer } = await renderModal();
  const checkbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked === false && n.props.className?.includes('text-emerald-700'));
  assert.ok(checkbox, 'il checkbox "Intera giornata" esiste');
  assert.equal(quadOf(renderer).cells.length, 4, 'prima: griglia 2x2 completa');
  assertLuogoENoteFullWidth(renderer);
  await act(async () => { checkbox.props.onChange({ target: { checked: true } }); });
  const { cells } = findQuad(renderer);
  assert.equal(cells.length, 2, 'dopo: esattamente 2 celle, nessun buco vuoto nella griglia');
  assert.deepEqual(
    cells.map(cellLabel),
    ['Classe Interessata', 'Materia'],
    'dopo: solo Classe | Materia, una sola riga, nessun buco vuoto',
  );
  const none = renderer.root.findAll((n: any) => n.type === 'input' && n.props.type === 'time');
  assert.equal(none.length, 0, 'dopo: nessun campo orario');
  assertLuogoENoteFullWidth(renderer);
  // Disattivando di nuovo la griglia torna 2x2 (UX inversa preservata).
  await act(async () => { checkbox.props.onChange({ target: { checked: false } }); });
  assert.deepEqual(
    quadOf(renderer).cells.map(cellLabel),
    ['Ora Inizio', 'Classe Interessata', 'Ora Fine', 'Materia'],
    'riattivando gli orari la griglia 2x2 torna identica',
  );
  await act(async () => { renderer.unmount(); });
});

test('4. nessun workaround event-time-duo/appearance reintrodotto; il font mobile 16px resta invariato', () => {
  const componentSource = readFileSync(resolve(here, '../src/components/EventModal.tsx'), 'utf8');
  assert.ok(!css.includes('event-time-duo'), 'nessun residuo CSS di event-time-duo in index.css');
  assert.ok(!css.includes('-webkit-appearance'), 'nessuna regola -webkit-appearance residua in index.css');
  assert.ok(!css.includes('appearance: none'), 'nessuna regola appearance:none residua in index.css');
  assert.ok(!componentSource.includes('event-time-duo'), 'nessun residuo della classe nel componente');
  const fontIdx = css.indexOf('font-size: 16px');
  assert.ok(fontIdx > -1, 'la regola globale del font mobile 16px è ancora presente');
  const fontMedia = css.lastIndexOf('@media (max-width: 767.98px)', fontIdx);
  assert.ok(fontMedia > -1 && css.slice(fontMedia, fontIdx).includes('input,'), 'la regola 16px continua a coprire input, select e textarea');
});
