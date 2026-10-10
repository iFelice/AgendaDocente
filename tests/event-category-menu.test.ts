import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_CATEGORIES,
  EVENT_CATEGORY_GROUPS,
  LEGACY_DIPARTIMENTO_CATEGORY,
} from '../src/components/EventModal';
import { buildCategoryOptions, type EventCategoryOption } from '../src/utils/eventCategoryMenu';

/*
 * Menu "Tipologia Impegno" a tendina nel modale evento.
 * - ogni categoria standard compare in esattamente un gruppo;
 * - la funzione pura costruisce le opzioni extra (legacy / sconosciute) senza
 *   mai cambiare la categoria corrente.
 */

const build = (overrides: Partial<Parameters<typeof buildCategoryOptions>[0]> = {}) =>
  buildCategoryOptions({
    currentCategory: 'consiglio_classe',
    editingLegacyDipartimento: false,
    categories: EVENT_CATEGORIES,
    groups: EVENT_CATEGORY_GROUPS,
    legacyOption: LEGACY_DIPARTIMENTO_CATEGORY,
    ...overrides,
  });

const allGroupedIds = () => EVENT_CATEGORY_GROUPS.flatMap(g => g.ids);

test('copertura gruppi: ogni id di EVENT_CATEGORIES compare in esattamente un gruppo', () => {
  const ids = EVENT_CATEGORIES.map(c => c.id);
  for (const id of ids) {
    const count = allGroupedIds().filter(g => g === id).length;
    assert.equal(count, 1, `"${id}" deve comparire in esattamente un gruppo (trovato ${count})`);
  }
});

test('copertura gruppi: nessun id nei gruppi che non sia una categoria standard', () => {
  const ids = new Set(EVENT_CATEGORIES.map(c => c.id));
  for (const id of allGroupedIds()) {
    assert.ok(ids.has(id), `"${id}" nei gruppi ma non in EVENT_CATEGORIES`);
  }
});

test('gruppi: etichette e ordine attesi', () => {
  assert.deepEqual(EVENT_CATEGORY_GROUPS.map(g => g.label), [
    'Riunioni', 'Scadenze e documenti', 'Rapporti e attività', 'Altro',
  ]);
  assert.deepEqual(EVENT_CATEGORY_GROUPS[0].ids, [
    'consiglio_classe', 'collegio_docenti', 'dipartimento_sostegno', 'glo', 'riunione',
  ]);
});

test('menu: categoria standard → nessuna opzione extra, gruppi completi nell\'ordine', () => {
  const menu = build({ currentCategory: 'glo' });
  assert.deepEqual(menu.extra, []);
  assert.deepEqual(menu.groups.map(g => g.label), ['Riunioni', 'Scadenze e documenti', 'Rapporti e attività', 'Altro']);
  const shown = menu.groups.flatMap(g => g.options.map(o => o.id));
  assert.deepEqual(shown, allGroupedIds(), 'tutte le categorie standard, nell\'ordine dei gruppi');
  const riunioni = menu.groups[0].options.map(o => o.label);
  assert.equal(riunioni[0], 'Consiglio di Classe');
});

test('menu: "dipartimento" in modifica → opzione legacy in cima, selezionabile', () => {
  const menu = build({ currentCategory: 'dipartimento', editingLegacyDipartimento: true });
  assert.deepEqual(menu.extra, [LEGACY_DIPARTIMENTO_CATEGORY]);
  assert.equal(menu.extra[0].id, 'dipartimento');
  assert.equal(menu.extra[0].label, 'Dipartimento Disciplinare (legacy)');
  assert.ok(!menu.groups.flatMap(g => g.options).some(o => o.id === 'dipartimento'), 'non duplicata nei gruppi');
});

test('menu: modifica legacy ma l\'utente ha cambiato categoria → legacy resta disponibile', () => {
  const menu = build({ currentCategory: 'glo', editingLegacyDipartimento: true });
  assert.deepEqual(menu.extra, [LEGACY_DIPARTIMENTO_CATEGORY]);
});

test('menu: evento nuovo (nessun legacy) → nessuna opzione legacy', () => {
  const menu = build({ currentCategory: 'consiglio_classe', editingLegacyDipartimento: false });
  assert.equal(menu.extra.some(o => o.id === 'dipartimento'), false);
  assert.equal(menu.groups.flatMap(g => g.options).some(o => o.id === 'dipartimento'), false);
});

test('menu: categoria sconosciuta ("lezione") → opzione extra selezionata con l\'id come etichetta', () => {
  const menu = build({ currentCategory: 'lezione' });
  assert.deepEqual(menu.extra, [{ id: 'lezione', label: 'lezione' }]);
  assert.equal(menu.groups.flatMap(g => g.options).some(o => o.id === 'lezione'), false);
});

test('menu: categoria standard non presente in nessun gruppo → finisce nel gruppo di riserva', () => {
  // Simula una categoria "personale" non più presente in nessun gruppo.
  const categories: EventCategoryOption[] = [...EVENT_CATEGORIES];
  const menu = build({
    currentCategory: 'glo',
    categories,
    groups: EVENT_CATEGORY_GROUPS.map(g => ({ ...g, ids: g.ids.filter(id => id !== 'personale') })),
  });
  const last = menu.groups[menu.groups.length - 1];
  assert.equal(last.label, 'Altre');
  assert.deepEqual(last.options.map(o => o.id), ['personale']);
});

test('menu: nessuna categoria corrente → nessuna opzione extra', () => {
  const menu = build({ currentCategory: undefined });
  assert.deepEqual(menu.extra, []);
});
