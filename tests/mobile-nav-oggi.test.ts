import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { database } from '../src/services/db';
import { demoInstallation } from '../src/services/storage';
import { default as AgendaApp } from '../src/App';
import { localDateISO, addDaysISO } from '../src/utils/dates';

/*
 * End-to-end (livello App) del comportamento ibrido del pulsante "Oggi" della
 * navigazione mobile:
 *  a. fuori dalla "giornata corrente" (altra sezione, Settimana/Mese, o vista
 *     Oggi spostata su un altro giorno) -> il tap riporta a Oggi/oggi;
 *  b. già sulla "giornata corrente" -> il tap apre il foglio "Viste calendario";
 *  c. "Oggi" resta attivo (aria-current) anche da Settimana/Mese;
 *  d. l'affordance (chevron + aria-haspopup/aria-expanded) compare SOLO nel
 *     caso (b).
 *
 * Stesso bootstrap di tests/today-slot-edit.test.ts (App reale, storage
 * fake-indexeddb, nessun mock di MobileNav/TodayView).
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function installWindowShim() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  (globalThis as any).window = new Proxy(globalThis, {
    get(t: any, p) {
      if (p === 'addEventListener') return (type: string, fn: any) => { (listeners[type] ||= []).push(fn); };
      if (p === 'removeEventListener') return (type: string, fn: any) => { listeners[type] = (listeners[type] || []).filter((f: any) => f !== fn); };
      if (p === 'matchMedia') return () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} });
      return t[p];
    },
  });
}
installWindowShim();

const legacyStorage = { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} };

async function bootApp() {
  const localData = {
    ...demoInstallation(),
    onboardingCompleted: true,
  };
  await database.initialize(localData as any, legacyStorage);
  await database.restore(localData as any);
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(AgendaApp, { initialData: localData }));
  });
  await flush(renderer, 150);
  return renderer;
}

async function flush(renderer: any, ms = 100) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

function byId(renderer: any, id: string): any[] {
  return renderer.root.findAll((el: any) => el.props?.id === id);
}

const todayIso = localDateISO();
const otherDayIso = addDaysISO(todayIso, -3);

test('App: si parte già su Oggi/oggi — "Oggi" è attivo, nessuna affordance popup finché non si tocca', async () => {
  const renderer = await bootApp();
  try {
    const oggi = byId(renderer, 'mobile-nav-oggi')[0];
    assert.ok(oggi, 'il pulsante "Oggi" della barra mobile è montato');
    assert.equal(oggi.props['aria-current'], 'page');
    assert.equal(byId(renderer, 'today-date-picker')[0].props.value, todayIso, 'la vista Oggi mostra il giorno reale');
    // Si è sulla "giornata corrente": condizione (b), l'affordance è presente.
    assert.equal(oggi.props['aria-haspopup'], 'dialog');
    assert.equal(oggi.props['aria-expanded'], false);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('3b. già sulla giornata corrente: il tap su "Oggi" apre il foglio "Viste calendario", non naviga', async () => {
  const renderer = await bootApp();
  try {
    const oggi = byId(renderer, 'mobile-nav-oggi')[0];
    await act(async () => { oggi.props.onClick(); });
    const dialog = renderer.root.findByProps({ 'aria-label': 'Viste calendario' });
    assert.ok(dialog, 'il foglio "Viste calendario" si apre');
    assert.equal(byId(renderer, 'today-date-picker')[0].props.value, todayIso, 'la vista resta su Oggi/oggi (nessuna navigazione)');
    assert.equal(byId(renderer, 'mobile-nav-oggi')[0].props['aria-expanded'], true);

    // Scegliere "Settimana" chiude il foglio e naviga davvero.
    const settimana = byId(renderer, 'mobile-calendar-settimana')[0];
    await act(async () => { settimana.props.onClick(); });
    assert.equal(renderer.root.findAll((el: any) => el.props?.role === 'dialog').length, 0, 'il foglio si chiude dopo la scelta');
    assert.ok(byId(renderer, 'nav-tab-settimana')[0].props['aria-current'] === 'page', 'la navigazione verso Settimana è reale');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('3a (i): da un\'altra sezione, il tap su "Oggi" porta alla vista Oggi sul giorno odierno', async () => {
  const renderer = await bootApp();
  try {
    // Entra in "Classi" dal foglio "Altro".
    await act(async () => { byId(renderer, 'mobile-nav-altro')[0].props.onClick(); });
    await act(async () => { byId(renderer, 'mobile-more-classi')[0].props.onClick(); });
    await flush(renderer);
    assert.equal(byId(renderer, 'today-date-picker').length, 0, 'Oggi non è più montata');

    const oggi = byId(renderer, 'mobile-nav-oggi')[0];
    assert.equal(oggi.props['aria-current'], undefined, '"Oggi" non è attivo mentre si è su unaltra sezione');
    await act(async () => { oggi.props.onClick(); });
    await flush(renderer);

    assert.equal(byId(renderer, 'today-date-picker')[0].props.value, todayIso, 'si torna su Oggi, giorno reale');
    assert.equal(renderer.root.findAll((el: any) => el.props?.role === 'dialog').length, 0, 'nessun foglio si apre');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('3a (ii) / vista Oggi su un altro giorno: il tap su "Oggi" riporta la data a oggi SENZA aprire alcun foglio', async () => {
  const renderer = await bootApp();
  try {
    // Sposta la vista Oggi su un altro giorno con le frecce (equivalente allo swipe).
    const prev = byId(renderer, 'today-previous-day')[0];
    await act(async () => { prev.props.onClick(); });
    await act(async () => { prev.props.onClick(); });
    await act(async () => { prev.props.onClick(); });
    await flush(renderer);
    assert.equal(byId(renderer, 'today-date-picker')[0].props.value, otherDayIso, 'la vista Oggi è su un altro giorno');

    const oggiMoved = byId(renderer, 'mobile-nav-oggi')[0];
    // Si resta nel gruppo calendario (attivo), ma NON sulla "giornata corrente":
    // nessuna affordance popup.
    assert.equal(oggiMoved.props['aria-current'], 'page');
    assert.equal(oggiMoved.props['aria-haspopup'], undefined, 'nessun chevron/affordance fuori dalla giornata corrente');

    await act(async () => { oggiMoved.props.onClick(); });
    await flush(renderer);

    assert.equal(byId(renderer, 'today-date-picker')[0].props.value, todayIso, 'un solo tap basta a tornare sul giorno odierno');
    assert.equal(renderer.root.findAll((el: any) => el.props?.role === 'dialog').length, 0, 'nessun foglio si apre: il tap ha solo spostato la data');

    // Da qui, essendo di nuovo sulla "giornata corrente", il secondo tap apre il foglio.
    const oggiAgain = byId(renderer, 'mobile-nav-oggi')[0];
    assert.equal(oggiAgain.props['aria-haspopup'], 'dialog');
    await act(async () => { oggiAgain.props.onClick(); });
    assert.ok(renderer.root.findByProps({ 'aria-label': 'Viste calendario' }));
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('3c/3d. da Settimana: il primo tap applica (a) (nessun chevron), il secondo applica (b) (chevron + foglio)', async () => {
  const renderer = await bootApp();
  try {
    await act(async () => { byId(renderer, 'mobile-nav-oggi')[0].props.onClick(); }); // (già su oggi/oggi) apre il foglio...
    await act(async () => { byId(renderer, 'mobile-calendar-settimana')[0].props.onClick(); }); // ...e sceglie Settimana
    await flush(renderer);
    assert.ok(byId(renderer, 'nav-tab-settimana')[0].props['aria-current'] === 'page');

    const oggiFromWeek = byId(renderer, 'mobile-nav-oggi')[0];
    assert.equal(oggiFromWeek.props['aria-current'], 'page', '"Oggi" resta il punto d\'accesso del gruppo calendario');
    assert.equal(oggiFromWeek.props['aria-haspopup'], undefined, 'da Settimana nessuna affordance popup: il tap naviga');

    // Primo tap da Settimana: applica (a), porta a Oggi/oggi.
    await act(async () => { oggiFromWeek.props.onClick(); });
    await flush(renderer);
    assert.equal(byId(renderer, 'today-date-picker')[0].props.value, todayIso, 'primo tap: Oggi sul giorno odierno');
    assert.equal(renderer.root.findAll((el: any) => el.props?.role === 'dialog').length, 0);

    // Secondo tap, ora sulla giornata corrente: applica (b), apre il foglio.
    const oggiOnToday = byId(renderer, 'mobile-nav-oggi')[0];
    assert.equal(oggiOnToday.props['aria-haspopup'], 'dialog');
    await act(async () => { oggiOnToday.props.onClick(); });
    assert.ok(renderer.root.findByProps({ 'aria-label': 'Viste calendario' }), 'secondo tap: foglio "Viste calendario"');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('i due fogli ("Altro" e "Viste calendario") restano mutuamente esclusivi anche a livello di App', async () => {
  const renderer = await bootApp();
  try {
    await act(async () => { byId(renderer, 'mobile-nav-oggi')[0].props.onClick(); });
    assert.ok(renderer.root.findByProps({ 'aria-label': 'Viste calendario' }));

    await act(async () => { byId(renderer, 'mobile-nav-altro')[0].props.onClick(); });
    assert.equal(renderer.root.findAll((el: any) => el.props?.['aria-label'] === 'Viste calendario').length, 0);
    assert.ok(renderer.root.findByProps({ 'aria-label': 'Altre funzioni' }));
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});
