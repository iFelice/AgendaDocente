import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TimetableEditor } from '../src/components/TimetableEditor';
import type { TeacherProfile, TimetableSlot, TimetableType } from '../src/types';

/*
 * Modal slot-edit (apertura diretta dal Planning): i 4 campi Ora Inizio,
 * Aula / Spazio, Ora Fine, Plesso / Sede vivono in UNA SOLA griglia 2 righe x
 * 2 colonne anche su smartphone. Il vecchio layout li disponeva su 3 righe
 * (orari affiancati nella riga 1 — dove su iPhone i controlli nativi
 * type="time" si sovrapponevano — e aula/plesso impilati a tutta larghezza
 * nelle righe 2 e 3).
 *
 * Requisito di layout su smartphone: ESATTAMENTE 2 righe totali.
 *  RIGA 1: Ora Inizio      | Aula / Spazio
 *  RIGA 2: Ora Fine        | Plesso / Sede
 *
 * Verifica strutturale:
 *  - una sola griglia quad, colonne minmax(0,1.15fr) / minmax(0,0.85fr):
 *    entrambe realmente restringibili, quella degli orari piu larga;
 *  - ordine DOM esatto delle 4 celle (la grid riempie riga per riga);
 *  - tutte le celle min-w-0; input w-full + min-w-0 + min-h-[44px];
 *  - i due orari restano input nativi type="time" con i loro valori;
 *  - aula e plesso conservano value/placeholder;
 *  - nessun residuo della vecchia griglia fissa grid-cols-2 nel modal;
 *  - la logica di salvataggio e invariata (round-trip onChange + submit).
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

const defSlot: TimetableSlot = {
  id: 'tt-def-1', dayOfWeek: 2, periodNumber: 3, startTime: '09:50', endTime: '10:50',
  subject: 'Matematica', className: '1A', classroom: 'Aula 12', campus: 'Sede Centrale',
  color: '#34d399', isProvisional: false,
};

const provSlot: TimetableSlot = {
  id: 'tt-prov-1', dayOfWeek: 3, periodNumber: 1, startTime: '07:50', endTime: '08:50',
  subject: 'Italiano', className: '2E', isProvisional: true,
};

const timeSlotConfig = {
  firstHourStartTime: '07:50', periodsPerDay: 3, standardDurationMinutes: 60,
  customSlots: [
    { periodNumber: 1, startTime: '07:50', endTime: '08:50' },
    { periodNumber: 2, startTime: '08:50', endTime: '09:50' },
    { periodNumber: 3, startTime: '09:50', endTime: '10:50' },
  ],
};

const QUAD = 'grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]';

const tokens = (node: any): string[] => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean);

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

function editorProps(overrides: Partial<React.ComponentProps<typeof TimetableEditor>> = {}) {
  return {
    profile,
    definitiveTimetable: [defSlot] as TimetableSlot[],
    provisionalTimetable: [provSlot] as TimetableSlot[],
    timetableMode: 'auto' as const,
    activeType: 'definitivo' as const,
    isDefinitiveCompiled: true,
    timeSlotConfig,
    onSaveSlot: () => {},
    onDeleteSlot: () => {},
    onSetTimetableMode: () => {},
    onCopyProvisionalToDefinitive: () => {},
    onCopyDefinitiveToProvisional: () => {},
    onClearTimetable: () => {},
    ...overrides,
  };
}

async function renderEditor(overrides: Partial<React.ComponentProps<typeof TimetableEditor>> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, editorProps(overrides) as any));
  });
  return renderer;
}

function formOf(renderer: any) {
  const forms = renderer.root.findAll((el: any) => el.type === 'form');
  assert.equal(forms.length, 1, 'il modale di modifica slot e aperto (un solo form)');
  return forms[0];
}

function quadGridOf(renderer: any) {
  const grids = renderer.root.findAll((n: any) => n.type === 'div' && tokens(n).includes(QUAD));
  assert.equal(grids.length, 1, 'una sola griglia quad 2 righe x 2 colonne nel modal');
  return grids[0];
}

test('1. layout: una sola griglia 2x2 con ordine Ora Inizio | Aula-Spazio // Ora Fine | Plesso-Sede', async () => {
  const renderer = await renderEditor({ initialSlot: defSlot, initialSlotType: 'definitivo' });
  const form = formOf(renderer);
  const quad = quadGridOf(renderer);

  assert.ok(tokens(quad).includes('gap-3'), 'gap adeguato fra le colonne');
  assert.ok(!tokens(quad).includes('grid-cols-1'), 'nessuna variante mobile impilata sulla quad');
  assert.ok(!tokens(quad).includes('grid-cols-2'), 'nessuna grid-cols-2 fissa sulla quad');

  // Le 4 celle dirette della quad, nell ordine DOM richiesto.
  const cells = quad.findAll((n: any) => n.type === 'div' && n.parent === quad);
  assert.equal(cells.length, 4, 'esattamente 4 celle dirette');
  const labels = cells.map((c: any) => {
    const label = c.children.find((n: any) => n.type === 'label');
    return flatText(label);
  });
  assert.deepEqual(
    labels,
    ['Ora Inizio', 'Aula / Spazio', 'Ora Fine', 'Plesso / Sede'],
    'ordine esatto: riga 1 = Ora Inizio + Aula/Spazio, riga 2 = Ora Fine + Plesso/Sede',
  );

  const cellInputs = cells.map((c: any) => c.findAll((n: any) => n.type === 'input'));
  assert.deepEqual(
    cellInputs.map((pair: any[]) => pair.map((i: any) => i.props.type)),
    [['time'], ['text'], ['time'], ['text']],
    'tipi per cella: time, text, time, text',
  );

  const allInputs = quad.findAll((n: any) => n.type === 'input');
  assert.equal(allInputs.length, 4, 'la quad contiene tutti e 4 i campi');
  for (const input of allInputs) {
    const it = tokens(input);
    assert.ok(it.includes('w-full'), 'input w-full');
    assert.ok(it.includes('min-w-0'), 'input min-w-0');
    assert.ok(it.includes('min-h-[44px]'), 'touch target >= 44px');
  }
  const [inizio, aula, fine, plesso] = allInputs;
  assert.equal(inizio.props.value, '09:50', 'ora inizio precompilata');
  assert.equal(fine.props.value, '10:50', 'ora fine precompilata');
  assert.equal(inizio.props.required, true, 'ora inizio resta required');
  assert.equal(fine.props.required, true, 'ora fine resta required');
  assert.equal(aula.props.value, 'Aula 12', 'aula precompilata');
  assert.equal(aula.props.placeholder, 'es. Palestra A, Aula 12');
  assert.equal(plesso.props.value, 'Sede Centrale', 'plesso precompilato');
  assert.equal(plesso.props.placeholder, 'es. Centrale, Succursale');

  // I due input time del modal sono SOLO quelli della quad: nessun altro blocco orari.
  const formTimes = form.findAll((n: any) => n.type === 'input' && n.props.type === 'time');
  assert.equal(formTimes.length, 2, 'esattamente due input time nel modal');
  assert.ok(formTimes[0] === inizio && formTimes[1] === fine, 'gli unici input time stanno nella quad');

  // Nessun residuo della vecchia griglia fissa a 2 colonne nel modal.
  const fixedTwoCols = form.findAll((n: any) => tokens(n).includes('grid-cols-2'));
  assert.equal(fixedTwoCols.length, 0, 'nessuna grid-cols-2 fissa nel modal (vecchio layout rimosso)');

  // Nessuna delle altre griglie impilate del form contiene piu gli orari.
  const stackedGrids = form.findAll((n: any) => tokens(n).includes('grid-cols-1'));
  for (const g of stackedGrids) {
    const times = g.findAll((n: any) => n.type === 'input' && n.props.type === 'time');
    assert.equal(times.length, 0, 'gli orari non stanno in una griglia impilata');
  }

  await act(async () => { renderer.unmount(); });
});

test('2. logica invariata: onChange di aula/plesso/orari finiscono nel salvataggio dello slot', async () => {
  let savedSlot: TimetableSlot | undefined;
  let savedType: TimetableType | undefined;
  const renderer = await renderEditor({
    initialSlot: defSlot,
    initialSlotType: 'definitivo',
    onSaveSlot: (slot: TimetableSlot, type: TimetableType) => { savedSlot = slot; savedType = type; },
  });
  const inputs = quadGridOf(renderer).findAll((n: any) => n.type === 'input');
  const [inizio, aula, fine, plesso] = inputs;

  await act(async () => { aula.props.onChange({ target: { value: 'Aula 13' } }); });
  await act(async () => { plesso.props.onChange({ target: { value: 'Sede Nord' } }); });
  await act(async () => { inizio.props.onChange({ target: { value: '08:50' } }); });

  const form = formOf(renderer);
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });

  assert.equal(savedType, 'definitivo', 'tipo invariato');
  assert.equal(savedSlot!.classroom, 'Aula 13', 'aula aggiornata via onChange');
  assert.equal(savedSlot!.campus, 'Sede Nord', 'plesso aggiornato via onChange');
  assert.equal(savedSlot!.startTime, '08:50', 'ora inizio modificata');
  assert.equal(savedSlot!.endTime, '10:50', 'ora fine invariata');
  assert.equal(savedSlot!.subject, 'Matematica', 'resto dello slot preservato');

  await act(async () => { renderer.unmount(); });
});
