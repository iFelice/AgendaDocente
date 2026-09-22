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
const componentSource = readFileSync(resolve(here, '../src/components/EventModal.tsx'), 'utf8');

/*
 * Orari del form Nuovo/Modifica Impegno su smartphone (dal test reale su
 * iPhone: il controllo nativo type="time" deborda dalla propria colonna
 * anche a ~199px, quindi NON si tenta piu di comprimerlo visivamente).
 *
 * Presentazione: DUE RIGHE COMPATTE tappabili — label a sinistra, valore
 * HH:MM e chevron a destra, altezza minima 44px. Il VERO input
 * type="time" e l unico target del tap: absolute inset-0 sopra l intera
 * riga con opacity-0 (MAI display:none / visibility:hidden /
 * pointer-events:none, MAI showPicker, MAI picker custom): il picker
 * nativo iOS si apre direttamente sul controllo e il rendering WebKit non
 * puo piu influire sul layout.
 *
 * Il resto del form: Classe | Materia affiancati in grid grid-cols-2 gap-3
 * (celle min-w-0, controlli w-full/min-w-0/min-h-[44px]); Luogo/Modalita e
 * Note a tutta larghezza. Con "Intera giornata" le due righe orario
 * spariscono senza buchi. Valori, onChange, validazione, create/edit,
 * all-day e salvataggio restano identici: gli input nativi sono l unica
 * source of truth (il valore visibile e un aria-hidden span di sola
 * lettura; il nome accessibile arriva dalla label via htmlFor).
 */

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Matematica'],
  classes: ['2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

const classTokens = (node: any): string[] => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean);

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

/**
 * Le due righe orario compatte: per ciascuna verifica struttura (wrapper
 * >= 44px, input nativo trasparente sovrapposto a tutta riga), assenza di
 * qualunque trucco di occultamento, label associata e valore visibile
 * coerente. Ritorna righe e input nell'ordine (inizio, fine).
 */
function assertTimeRows(renderer: any) {
  const inputs = renderer.root.findAll((n: any) => n.type === 'input' && n.props.type === 'time');
  assert.equal(inputs.length, 2, 'esattamente due veri input type="time"');
  const rows = [inputs[0].parent, inputs[1].parent];
  assert.ok(rows[0] !== rows[1], 'i due orari stanno in due righe distinte');
  assert.ok(rows[0].parent === rows[1].parent, 'le due righe sono sorelle (lista compatta)');

  const expectedIds = ['event-start-time', 'event-end-time'];
  const expectedLabels = ['Ora Inizio', 'Ora Fine'];
  for (let i = 0; i < 2; i++) {
    const input = inputs[i];
    const row = rows[i];

    // Input = target trasparente a tutta riga, senza occultamenti.
    const it = classTokens(input);
    for (const tok of ['absolute', 'inset-0', 'w-full', 'h-full', 'opacity-0', 'cursor-pointer']) {
      assert.ok(it.includes(tok), `input ${expectedLabels[i]}: token "${tok}" presente`);
    }
    for (const bad of ['hidden', 'invisible', 'pointer-events-none']) {
      assert.ok(!it.includes(bad), `input ${expectedLabels[i]}: niente "${bad}"`);
    }
    const style = input.props.style ?? {};
    assert.ok(!style.display && !style.visibility && !style.pointerEvents,
      `${expectedLabels[i]}: nessun occultamento via style inline`);

    // Wrapper = riga compatta >= 44px, label a sinistra, valore a destra.
    const rt = classTokens(row);
    for (const tok of ['relative', 'min-h-[44px]', 'flex', 'items-center', 'cursor-pointer']) {
      assert.ok(rt.includes(tok), `riga ${expectedLabels[i]}: token "${tok}" presente`);
    }
    assert.equal(row.findAll((n: any) => n.type === 'input').length, 1,
      `${expectedLabels[i]}: la riga contiene un solo input (quello nativo)`);

    // Label associata all'input (nome accessibile senza duplicazioni).
    const label = row.children.find((n: any) => n.type === 'label');
    assert.ok(label, `${expectedLabels[i]}: label presente nella riga`);
    assert.equal(label.props.htmlFor, expectedIds[i], `${expectedLabels[i]}: label collegata via htmlFor`);
    assert.equal(input.props.id, expectedIds[i], `${expectedLabels[i]}: id dell'input corretto`);
    assert.equal(flatText(label), expectedLabels[i], `${expectedLabels[i]}: etichetta visibile`);

    // Valore visibile (aria-hidden) = valore dell'input, in HH:MM.
    const spans = row.children.filter((n: any) => n.type === 'span');
    assert.equal(spans.length, 1, `${expectedLabels[i]}: uno span di valore`);
    assert.equal(spans[0].props['aria-hidden'], 'true', `${expectedLabels[i]}: span aria-hidden (niente valore duplicato all'accessibilita)`);
    assert.ok(/^\d{2}:\d{2}/.test(flatText(spans[0])), `${expectedLabels[i]}: valore visibile in formato HH:MM`);
    assert.ok(flatText(spans[0]).startsWith(String(input.props.value)),
      `${expectedLabels[i]}: il valore visibile riflette startTime/endTime`);
    assert.ok(classTokens(spans[0]).includes('font-mono'), `${expectedLabels[i]}: valore in font mono`);
  }
  return { rows, inputs };
}

/** La griglia Classe | Materia: unica grid-cols-2 del form, due celle. */
function assertClassesGrid(renderer: any) {
  const grids = renderer.root.findAll((n: any) => n.type === 'div' && classTokens(n).includes('grid-cols-2'));
  assert.equal(grids.length, 1, 'una sola griglia grid-cols-2 nel form (Classe | Materia)');
  const grid = grids[0];
  assert.ok(classTokens(grid).includes('gap-3'), 'gap adeguato fra le colonne');
  const cells = grid.findAll((n: any) => n.type === 'div' && n.parent === grid);
  assert.equal(cells.length, 2, 'esattamente due celle');
  const labels = cells.map((c: any) => flatText(c.children.find((n: any) => n.type === 'label')));
  assert.deepEqual(labels, ['Classe Interessata', 'Materia'], 'ordine: Classe Interessata | Materia');
  for (const cell of cells) {
    assert.ok(classTokens(cell).includes('min-w-0'), 'cella min-w-0');
  }
  const inputs = grid.findAll((n: any) => n.type === 'input');
  assert.equal(inputs.length, 2, 'due input testuali');
  for (const input of inputs) {
    const it = classTokens(input);
    for (const tok of ['w-full', 'min-w-0', 'min-h-[44px]']) {
      assert.ok(it.includes(tok), `input Classe/Materia: token "${tok}" presente`);
    }
  }
  // Le righe orario NON stanno nella griglia: sono un blocco separato sopra
  // (la griglia contiene solo i due input testuali verificati sopra).
  return grid;
}

function assertLuogoENoteFullWidth(renderer: any) {
  const grids = renderer.root.findAll((n: any) => n.type === 'div' && classTokens(n).includes('grid-cols-2'));
  const grid = grids[0];
  const luogo = renderer.root.findAll((n: any) => n.type === 'input' && String(n.props.placeholder ?? '').includes('Aula Magna'));
  assert.equal(luogo.length, 1, 'il campo Luogo / Modalita esiste');
  assert.ok(!grid.findAll((n: any) => n === luogo[0]).length, 'Luogo / Modalita fuori dalla griglia');
  assert.ok(classTokens(luogo[0]).includes('w-full'), 'Luogo / Modalita a tutta larghezza');
  const notes = renderer.root.findAll((n: any) => n.type === 'textarea');
  assert.equal(notes.length, 1, 'il campo Note esiste');
  assert.ok(!grid.findAll((n: any) => n === notes[0]).length, 'Note fuori dalla griglia');
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

function classesInputsOf(renderer: any) {
  const grid = assertClassesGrid(renderer);
  const [classe, materia] = grid.findAll((n: any) => n.type === 'input');
  return { classe, materia };
}

test('1. creazione: due righe compatte con i valori di default, Classe|Materia affiancate, salvataggio invariato', async () => {
  const { renderer, saved } = await renderModal();
  const { inputs } = assertTimeRows(renderer);
  assertLuogoENoteFullWidth(renderer);
  const defaults = getEventModalTimeFields(null);
  assert.equal(inputs[0].props.value, defaults.startTime, 'default ora inizio per un nuovo impegno');
  assert.equal(inputs[1].props.value, defaults.endTime, 'default ora fine per un nuovo impegno');

  // onChange dello stesso input aggiorna valore nativo E valore visibile.
  await act(async () => { inputs[0].props.onChange({ target: { value: '09:15' } }); });
  const after = assertTimeRows(renderer);
  assert.equal(after.inputs[0].props.value, '09:15', 'il valore nativo riflette onChange');
  const span = after.rows[0].children.find((n: any) => n.type === 'span');
  assert.ok(flatText(span).startsWith('09:15'), 'il valore visibile riflette il nuovo orario');

  const { classe, materia } = classesInputsOf(renderer);
  assert.equal(classe.props.value, '2E', 'precompilazione classe invariata');
  assert.equal(materia.props.value, 'Matematica', 'precompilazione materia invariata');
  const title = renderer.root.findAll((n: any) => n.type === 'input' && n.props.type === 'text' && n.props.required)[0];
  await act(async () => { title.props.onChange({ target: { value: 'Consiglio 2E' } }); });
  await submitForm(renderer);
  assert.equal(saved.length, 1, 'l impegno viene salvato');
  assert.equal(saved[0].startTime, '09:15', 'ora inizio salvata');
  assert.equal(saved[0].endTime, defaults.endTime, 'ora fine salvata');
  assert.equal(saved[0].className, '2E', 'classe salvata');
  assert.equal(saved[0].subject, 'Matematica', 'materia salvata');
  await act(async () => { renderer.unmount(); });
});

test('2. modifica: stessi campi, valori esistenti, layout identico e salvataggio coerente', async () => {
  const existing: CalendarEvent = {
    id: 'ev-1', title: 'Dipartimento', category: 'dipartimento', date: '2026-09-25',
    startTime: '08:30', endTime: '10:15', isAllDay: false,
    className: '2E', subject: 'Matematica', location: 'Sala Docenti',
    sourceType: 'manuale', completed: false,
  };
  const { renderer, saved } = await renderModal({ eventToEdit: existing });
  const { inputs } = assertTimeRows(renderer);
  assertLuogoENoteFullWidth(renderer);
  assert.equal(inputs[0].props.value, '08:30', 'modifica: valore esistente di ora inizio');
  assert.equal(inputs[1].props.value, '10:15', 'modifica: valore esistente di ora fine');
  await act(async () => { inputs[0].props.onChange({ target: { value: '09:00' } }); });
  const after = assertTimeRows(renderer);
  assert.equal(after.inputs[0].props.value, '09:00', 'il campo aggiornato riflette il nuovo valore');
  await submitForm(renderer);
  assert.equal(saved.length, 1, 'la modifica viene salvata');
  assert.equal(saved[0].id, 'ev-1', 'stesso impegno');
  assert.equal(saved[0].startTime, '09:00', 'ora inizio aggiornata');
  assert.equal(saved[0].endTime, '10:15', 'ora fine invariata');
  await act(async () => { renderer.unmount(); });
});

test('3. con "Intera giornata" le due righe orario spariscono senza buchi; Classe|Materia restano affiancate', async () => {
  const { renderer } = await renderModal();
  const checkbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked === false && n.props.className?.includes('text-emerald-700'));
  assert.ok(checkbox, 'il checkbox "Intera giornata" esiste');
  assertTimeRows(renderer);
  assertClassesGrid(renderer);
  assertLuogoENoteFullWidth(renderer);
  await act(async () => { checkbox.props.onChange({ target: { checked: true } }); });
  const times = renderer.root.findAll((n: any) => n.type === 'input' && n.props.type === 'time');
  assert.equal(times.length, 0, 'dopo: nessuna riga orario, nessun buco');
  const grid = assertClassesGrid(renderer);
  const labels = grid.findAll((n: any) => n.type === 'div' && n.parent === grid)
    .map((c: any) => flatText(c.children.find((n: any) => n.type === 'label')));
  assert.deepEqual(labels, ['Classe Interessata', 'Materia'], 'Classe | Materia restano affiancate');
  assertLuogoENoteFullWidth(renderer);
  // Riattivando gli orari le due righe tornano identiche (UX inversa).
  await act(async () => { checkbox.props.onChange({ target: { checked: false } }); });
  const again = assertTimeRows(renderer);
  assert.equal(again.inputs[0].props.value, '15:00', 'riattivando: ora inizio al default');
  assert.equal(again.inputs[1].props.value, '16:30', 'riattivando: ora fine al default');
  await act(async () => { renderer.unmount(); });
});

test('4. nessun trucco: niente showPicker, niente picker custom, niente event-time-duo; font mobile 16px invariato', () => {
  assert.ok(!componentSource.includes('showPicker'), 'niente showPicker nel componente');
  assert.ok(!componentSource.includes('event-time-duo'), 'niente event-time-duo nel componente');
  assert.ok(!css.includes('event-time-duo'), 'nessun residuo CSS di event-time-duo');
  assert.ok(!css.includes('appearance: none') && !css.includes('-webkit-appearance'), 'nessuna regola appearance residua in index.css');
  assert.ok(!componentSource.includes("type=\"text\"\n                  value={startTime}"), 'gli orari non sono input testuali');
  // Il font mobile 16px anti auto-zoom resta invariato.
  const fontIdx = css.indexOf('font-size: 16px');
  assert.ok(fontIdx > -1, 'la regola globale del font mobile 16px è ancora presente');
  const fontMedia = css.lastIndexOf('@media (max-width: 767.98px)', fontIdx);
  assert.ok(fontMedia > -1 && css.slice(fontMedia, fontIdx).includes('input,'), 'la regola 16px continua a coprire input, select e textarea');
});
