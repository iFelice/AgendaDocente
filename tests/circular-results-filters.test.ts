import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import type { TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;

// Synthetic profile and items: no school document, no personal data.
const profile: TeacherProfile = {
  id: 'teacher', fullName: 'Docente Test', schoolName: 'Scuola Test', schoolLevel: 'ssig',
  schoolYear: '2026/2027', primarySubjects: ['Matematica'], classes: ['1A'], campuses: [], roles: [],
};

// Items designed for deterministic relevance after normalization:
// - "... 1A" -> VERDE (assigned class), auto-selected when the date is valid;
// - generic title -> GIALLO; className 2B -> ROSSO; empty date -> "Senza data".
const defaultItems = [
  { title: 'Consiglio classe 1A', date: '2026-12-10' },            // VERDE, Dic 2026
  { title: 'Scrutinio 1A', date: '2027-01-15' },                   // VERDE, Gen 2027
  { title: 'Riunione generica', date: '2026-12-20' },              // GIALLO, Dic 2026
  { title: 'Riunione', className: '2B', date: '2027-01-20' },      // ROSSO, Gen 2027
  { title: 'Incontro 1A', date: '' },                              // VERDE ma senza data valida
];
let mockItems: any[] = defaultItems;

before(() => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, source: 'groq', items: mockItems }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;
});
after(() => { globalThis.fetch = originalFetch; });

function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return (node.children ?? []).map(textOf).join(' ').replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

async function renderResults(items: any[] = defaultItems) {
  mockItems = items;
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(CircularAnalyzerModal, {
      isOpen: true, onClose: () => {}, profile, onImportEvents: () => {},
      initialFile: {
        base64: 'QUJD', mimeType: 'image/jpeg', fileName: 'circolare.jpg',
        autoStartToken: `filters-${Math.random()}`,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  return renderer;
}

const findGroup = (root: any, label: string) =>
  root.findAll((n: any) => n.props?.['aria-label'] === label)[0];

const groupButtons = (root: any, label: string) =>
  findGroup(root, label).findAll((n: any) => n.type === 'button');

const findButton = (root: any, re: RegExp) =>
  root.findAll((n: any) => n.type === 'button' && re.test(textOf(n)))[0];

async function click(button: any) {
  assert.ok(button, 'pulsante non trovato');
  await act(async () => { button.props.onClick(); });
}

const listCheckboxes = (root: any) =>
  root.findAll((n: any) => n.type === 'input' && n.props.type === 'checkbox');

const scrollContainer = (root: any) =>
  root.findAll((n: any) => n.type === 'div' && typeof n.props.onScroll === 'function')[0];

// Titoli delle schede visibili: l'input di titolo è l'unico text input senza placeholder.
const visibleTitles = (root: any) =>
  scrollContainer(root)
    .findAll((n: any) => n.type === 'input' && n.props.type === 'text' && !n.props.placeholder)
    .map((n: any) => n.props.value);

test('i mesi sono generati dai dati, in ordine cronologico, con anno e conteggi', async () => {
  const renderer = await renderResults();
  const buttons = groupButtons(renderer.root, 'Filtra per mese');
  // Default filter is "Pertinenti" (VERDE+GIALLO = 4 of 5 items).
  assert.deepEqual(buttons.map((b: any) => textOf(b)), [
    'Tutti i mesi (4)', 'Dic 2026 (2)', 'Gen 2027 (1)', 'Senza data (1)',
  ]);
  assert.equal(buttons[0].props['aria-pressed'], true);
  for (const b of buttons.slice(1)) assert.equal(b.props['aria-pressed'], false);
  // Every filter button exposes its state and a mobile-friendly touch target.
  for (const b of [...buttons, ...groupButtons(renderer.root, 'Filtra per pertinenza')]) {
    assert.notEqual(b.props['aria-pressed'], undefined);
    assert.match(b.props.className, /min-h-11/);
  }
});

test('il pulsante "Senza data" appare solo quando esistono impegni senza data valida', async () => {
  const renderer = await renderResults(defaultItems.filter((i) => i.date !== ''));
  const labels = groupButtons(renderer.root, 'Filtra per mese').map((b: any) => textOf(b));
  assert.ok(!labels.some((l: string) => /Senza data/.test(l)), `trovato Senza data in ${labels}`);
  assert.deepEqual(labels, ['Tutti i mesi (3)', 'Dic 2026 (2)', 'Gen 2027 (1)']);
});

test('il filtro mese si combina con la pertinenza e i conteggi si riflettono a vicenda', async () => {
  const renderer = await renderResults();
  const root = renderer.root;

  // Pertinenti + Dic 2026 -> Consiglio 1A (VERDE) + Riunione generica (GIALLO).
  await click(findButton(root, /^Dic 2026/));
  assert.equal(listCheckboxes(root).length, 2);
  const relevanceLabels = () => groupButtons(root, 'Filtra per pertinenza').map((b: any) => textOf(b));
  assert.deepEqual(relevanceLabels(), ['Pertinenti (2)', '🟢 Certo (1)', '🟡 Generale (1)', '🔴 Esclusi (0)']);
  assert.equal(findButton(root, /^Dic 2026/).props['aria-pressed'], true);

  // Certo (VERDE) -> i conteggi dei mesi riflettono il nuovo filtro di pertinenza.
  await click(findButton(root, /^🟢 Certo/));
  assert.deepEqual(groupButtons(root, 'Filtra per mese').map((b: any) => textOf(b)), [
    'Tutti i mesi (3)', 'Dic 2026 (1)', 'Gen 2027 (1)', 'Senza data (1)',
  ]);
  // Combinazione VERDE + Dic 2026 -> un solo impegno visibile.
  assert.deepEqual(visibleTitles(root), ['Consiglio classe 1A']);

  // Senza data + Certo -> solo l'impegno privo di data valida.
  await click(findButton(root, /^Senza data/));
  assert.deepEqual(visibleTitles(root), ['Incontro 1A']);

  // Tutti i mesi -> si torna all'elenco completo del filtro di pertinenza.
  await click(findButton(root, /^Tutti i mesi/));
  assert.equal(listCheckboxes(root).length, 3);
});

test('Seleziona Pertinenti/Tutti/Nessuno agisce solo sui visibili; il contatore resta sul totale', async () => {
  const renderer = await renderResults();
  const root = renderer.root;
  const footer = () => textOf(root).match(/(\d+) impegni selezionati su (\d+)/)!;

  // Auto-selezione iniziale: i due VERDE con data valida.
  assert.deepEqual(footer().slice(1), ['2', '5']);

  // Pertinenti + Dic 2026, "Nessuno": deseleziona solo Consiglio 1A; Scrutinio 1A (Gen) resta selezionato.
  await click(findButton(root, /^Dic 2026/));
  await click(findButton(root, /^Nessuno$/));
  assert.deepEqual(footer().slice(1), ['1', '5']);

  // "Tutti" sui visibili di dicembre: +2 -> 3 selezionati, totale sempre 5.
  await click(findButton(root, /^Tutti$/));
  assert.deepEqual(footer().slice(1), ['3', '5']);

  // "Pertinenti" con mese Gen 2027: agisce solo su Scrutinio 1A (il ROSSO di gennaio non è visibile
  // col filtro Pertinenti) e non tocca le selezioni di dicembre.
  await click(findButton(root, /^Gen 2027/));
  await click(findButton(root, /^Pertinenti$/));
  assert.deepEqual(footer().slice(1), ['3', '5']);

  // Il ROSSO non è mai stato toccato: con Esclusi + Tutti i mesi il suo checkbox è deselezionato.
  await click(findButton(root, /^Tutti i mesi/));
  await click(findButton(root, /^🔴 Esclusi/));
  const [rosso] = listCheckboxes(root);
  assert.equal(rosso.props.checked, false);
  assert.deepEqual(footer().slice(1), ['3', '5']);
});

test("dopo lo scroll l'intestazione resta presente e il riquadro del titolo si comprime", async () => {
  const renderer = await renderResults();
  const root = renderer.root;
  const list = scrollContainer(root);
  assert.ok(list, 'contenitore scorrevole non trovato');
  assert.match(textOf(root), /Trovati 5 impegni complessivi nel documento/);

  await act(async () => { list.props.onScroll({ currentTarget: { scrollTop: 200 } }); });
  // Filtri e titolo restano visibili sopra l'elenco...
  assert.ok(findGroup(root, 'Filtra per pertinenza'));
  assert.ok(findGroup(root, 'Filtra per mese'));
  assert.match(textOf(root), /Risultati Analisi Circolare/);
  // ...ma il riquadro del titolo è compresso (niente descrizione estesa né pulsanti secondari).
  assert.doesNotMatch(textOf(root), /Trovati 5 impegni complessivi nel documento/);
  assert.equal(findButton(root, /Altra circolare/), undefined);

  // Tornando in cima il riquadro completo riappare.
  await act(async () => { scrollContainer(root).props.onScroll({ currentTarget: { scrollTop: 0 } }); });
  assert.match(textOf(root), /Trovati 5 impegni complessivi nel documento/);
  assert.ok(findButton(root, /Altra circolare/));
});
