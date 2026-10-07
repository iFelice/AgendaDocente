import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import type { CalendarEvent, TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;

// Profilo sintetico: nessun documento scolastico reale, nessun dato personale.
const profile: TeacherProfile = {
  id: 'teacher', fullName: 'Docente Test', schoolName: 'Scuola Test', schoolLevel: 'ssig',
  schoolYear: '2026/2027', primarySubjects: ['Matematica'], classes: ['1A'], campuses: [], roles: [],
};

// Impegno in agenda con un nome diverso da quello usato dalla circolare:
// il riconoscimento per titolo non scatta, quello per orario sì.
const existingIncontro: CalendarEvent = {
  id: 'ev-dirigente', title: 'Incontro con il Dirigente', category: 'riunione',
  date: '2026-10-12', startTime: '15:00', endTime: '15:45', isAllDay: false, sourceType: 'manuale',
};

// Dalla circolare: stesso giorno, orario in parte sovrapposto, titolo diverso.
const itemColloquio = {
  title: 'Colloquio col Dirigente', category: 'riunione',
  date: '2026-10-12', startTime: '15:15', endTime: '15:40',
};

let mockItems: any[] = [];
let existingEvents: CalendarEvent[] = [];

before(() => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, source: 'server', items: mockItems }), {
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

async function renderResults(items: any[], events: CalendarEvent[]) {
  mockItems = items;
  existingEvents = events;
  let importedNew: CalendarEvent[] = [];
  let importedUpdated: CalendarEvent[] = [];
  let importCalled = false;
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(CircularAnalyzerModal, {
      isOpen: true,
      onClose: () => {},
      profile,
      existingEvents,
      onImportEvents: (newEvents: CalendarEvent[], _docMeta: any, updatedEvents?: CalendarEvent[]) => {
        importCalled = true;
        importedNew = newEvents;
        importedUpdated = updatedEvents || [];
      },
      initialFile: {
        base64: 'QUJD', mimeType: 'image/jpeg', fileName: 'circolare.jpg',
        autoStartToken: `same-time-${Math.random()}`,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  // La pertinenza dipende dalla valutazione del documento: qui interessa il
  // conflitto, quindi si parte da tutti gli impegni selezionati.
  const selectAll = renderer.root.findAll((n: any) => n.type === 'button' && textOf(n) === 'Tutti')[0];
  await act(async () => { selectAll.props.onClick(); });
  return {
    renderer,
    state: {
      get importCalled() { return importCalled; },
      get importedNew() { return importedNew; },
      get importedUpdated() { return importedUpdated; },
    },
  };
}

const findButton = (root: any, re: RegExp) =>
  root.findAll((n: any) => n.type === 'button' && re.test(textOf(n)))[0];

const findButtonByLabel = (root: any, re: RegExp) =>
  root.findAll((n: any) => n.type === 'button' && n.props['aria-label'] && re.test(n.props['aria-label']))[0];

async function click(button: any) {
  assert.ok(button, 'pulsante non trovato');
  await act(async () => { button.props.onClick(); });
}

/** Sottoalbero della scheda di un impegno: il primo antenato dell'input titolo con una sola checkbox. */
const scopeFromTitleInput = (titleInput: any) => {
  let node = titleInput.parent;
  while (node) {
    const cbs = node.findAll ? node.findAll((n: any) => n.type === 'input' && n.props.type === 'checkbox') : [];
    if (cbs.length === 1) return node;
    node = node.parent;
  }
  return null;
};

const titleInputs = (root: any, title: string) =>
  root.findAll((n: any) => n.type === 'input' && n.props.type === 'text' && n.props.value === title);

const scopeOfTitle = (root: any, title: string) => {
  const inputs = titleInputs(root, title);
  assert.ok(inputs.length >= 1, `input del titolo non trovato: ${title}`);
  const scope = scopeFromTitleInput(inputs[0]);
  assert.ok(scope, `scheda non trovata per il titolo: ${title}`);
  return scope;
};

const cardCheckbox = (root: any, title: string, occurrence = 0) =>
  scopeFromTitleInput(titleInputs(root, title)[occurrence])!
    .findAll((n: any) => n.type === 'input' && n.props.type === 'checkbox')[0];

/** Pulsante di scelta della scheda (si distingue da quelli in blocco per via di aria-pressed). */
const cardChoiceButton = (root: any, title: string, label: string, occurrence = 0) =>
  scopeFromTitleInput(titleInputs(root, title)[occurrence])!
    .findAll((n: any) => n.type === 'button' && textOf(n) === label && n.props['aria-pressed'] !== undefined)[0];

const isPressed = (button: any) =>
  /\bbg-(emerald-700|amber-600|stone-700)\b/.test(button?.props?.className || '');

// ---------------------------------------------------------------------------
// 1) Riquadro "Stesso orario di un impegno già in agenda"
// ---------------------------------------------------------------------------

test('stesso orario: riquadro con le tre scelte, nessuna preselezionata, riga di spiegazione', async () => {
  const { renderer } = await renderResults([itemColloquio], [existingIncontro]);
  const root = renderer.root;
  try {
    const text = textOf(root);
    assert.ok(text.includes('Stesso orario di un impegno già in agenda'), 'titolo del riquadro');
    assert.ok(
      text.includes('potrebbe essere lo stesso della circolare'),
      'riga che spiega il possibile doppione con un nome diverso'
    );
    assert.ok(text.includes('Esistente in agenda'), 'confronto con l\'esistente');
    assert.ok(text.includes('Dalla nuova circolare'), 'confronto con il nuovo');
    assert.ok(text.includes('15:00 - 15:45'), 'orario dell\'impegno esistente');
    assert.ok(text.includes('15:15 - 15:40'), 'orario estratto dalla circolare');

    // Le tre scelte ci sono tutte, nessuna preselezionata.
    const scope = scopeOfTitle(root, 'Colloquio col Dirigente');
    const choices = scope.findAll((n: any) => n.type === 'button' && n.props['aria-pressed'] !== undefined);
    const labels = choices.map((n: any) => textOf(n));
    assert.deepEqual(labels, ['Aggiorna esistente', 'Aggiungi come nuovo', 'Ignora']);
    for (const choice of choices) {
      assert.equal(isPressed(choice), false, `nessuna scelta preselezionata: ${textOf(choice)}`);
    }
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 2) L'importazione resta bloccata finché manca la scelta
// ---------------------------------------------------------------------------

test('stesso orario: importazione bloccata senza scelta, poi "Aggiorna esistente" aggiorna (nessun doppione)', async () => {
  const { renderer, state } = await renderResults([itemColloquio], [existingIncontro]);
  const root = renderer.root;
  try {
    // 1. Conferma senza scelta: non importa e avvisa.
    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, false, 'senza scelta l\'importazione resta bloccata');
    assert.ok(
      textOf(root).includes('Restano 1 impegni selezionati da risolvere prima di importare.'),
      'messaggio di blocco con il conteggio'
    );

    // 2. Scelta "Aggiorna esistente": aggiorna l'impegno in agenda, non ne crea uno nuovo.
    await click(cardChoiceButton(root, 'Colloquio col Dirigente', 'Aggiorna esistente'));
    assert.equal(isPressed(cardChoiceButton(root, 'Colloquio col Dirigente', 'Aggiorna esistente')), true);
    assert.equal(cardCheckbox(root, 'Colloquio col Dirigente').props.checked, true, 'la scelta seleziona');

    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, true, 'dopo la scelta l\'importazione parte');
    assert.equal(state.importedNew.length, 0, 'nessun doppione creato');
    assert.equal(state.importedUpdated.length, 1);
    assert.equal(state.importedUpdated[0].id, 'ev-dirigente');
    assert.equal(state.importedUpdated[0].title, 'Colloquio col Dirigente');
    assert.equal(state.importedUpdated[0].startTime, '15:15');
    assert.equal(state.importedUpdated[0].endTime, '15:40');
  } finally {
    renderer.unmount();
  }
});

test('stesso orario: "Ignora" deseleziona (la scelta comanda sulla selezione)', async () => {
  const { renderer, state } = await renderResults([itemColloquio], [existingIncontro]);
  const root = renderer.root;
  try {
    await click(cardChoiceButton(root, 'Colloquio col Dirigente', 'Ignora'));
    assert.equal(cardCheckbox(root, 'Colloquio col Dirigente').props.checked, false, '"Ignora" deseleziona');
    assert.equal(isPressed(cardChoiceButton(root, 'Colloquio col Dirigente', 'Ignora')), true);

    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, false, 'nessun impegno selezionato: nessuna importazione');
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 3) "Identico ⇒ Ignora preimpostato" vale solo per il criterio del titolo
// ---------------------------------------------------------------------------

test('identico ⇒ Ignora preimpostato: solo per il titolo, non per il solo orario', async () => {
  // Due impegni identici in agenda: il titolo resta ambiguo (nessuno spareggio
  // possibile), subentra il criterio dell'orario. Pur essendo i dati identici a
  // quelli estratti, la scelta NON è preimpostata: va chiesta.
  const doppio: CalendarEvent[] = [
    {
      id: 'ev-doppio-1', title: 'Colloquio col Dirigente', category: 'riunione',
      date: '2026-10-12', startTime: '15:15', endTime: '15:40', isAllDay: false, sourceType: 'manuale',
    },
    {
      id: 'ev-doppio-2', title: 'Colloquio col Dirigente', category: 'riunione',
      date: '2026-10-12', startTime: '15:15', endTime: '15:40', isAllDay: false, sourceType: 'manuale',
    },
  ];

  const { renderer, state } = await renderResults([itemColloquio], doppio);
  const root = renderer.root;
  try {
    const text = textOf(root);
    assert.ok(text.includes('Stesso orario di un impegno già in agenda'));
    assert.equal(text.includes('Già in agenda, identico'), false, 'etichetta riservata al criterio del titolo');
    assert.equal(cardCheckbox(root, 'Colloquio col Dirigente').props.checked, true, 'resta selezionato');

    // Senza scelta l'importazione è bloccata: il preimpostato "Ignora" non scatta.
    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, false, 'la scelta resta obbligatoria');

    // Con la scelta esplicita si procede.
    await click(cardChoiceButton(root, 'Colloquio col Dirigente', 'Ignora'));
    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, false, 'ignorato: nessuna modifica da salvare');
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 4) Riga in blocco: conteggi distinti per tipo, azione valida su entrambi
// ---------------------------------------------------------------------------

test('riga in blocco: il conteggio distingue "possibili aggiornamenti" e "stesso orario"', async () => {
  const existingCollegio: CalendarEvent = {
    id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti',
    date: '2026-10-15', startTime: '17:00', endTime: '18:00', isAllDay: false, sourceType: 'circolare',
  };

  const { renderer } = await renderResults(
    [
      // Possibile aggiornamento (criterio del titolo).
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-15', startTime: '15:00', endTime: '16:30' },
      // Solo stesso orario (titolo diverso).
      itemColloquio,
    ],
    [existingCollegio, existingIncontro]
  );
  const root = renderer.root;
  try {
    const text = textOf(root);
    assert.ok(
      text.includes('1 possibili aggiornamenti · 1 stesso orario'),
      'conteggio distinto per tipo nella riga in blocco'
    );
    assert.ok(text.includes('Possibile aggiornamento di un impegno esistente'), 'riquadro per titolo');
    assert.ok(text.includes('Stesso orario di un impegno già in agenda'), 'riquadro per orario');
  } finally {
    renderer.unmount();
  }
});

test('riga in blocco: l\'azione vale su entrambi i tipi di conflitto', async () => {
  const existingCollegio: CalendarEvent = {
    id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti',
    date: '2026-10-15', startTime: '17:00', endTime: '18:00', isAllDay: false, sourceType: 'circolare',
  };

  const { renderer, state } = await renderResults(
    [
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-15', startTime: '15:00', endTime: '16:30' },
      itemColloquio,
    ],
    [existingCollegio, existingIncontro]
  );
  const root = renderer.root;
  try {
    // Azione in blocco sui 2 conflitti visibili non risolti (titolo + orario).
    await click(findButtonByLabel(root, /^Aggiorna esistenti: conflitti visibili non risolti \(2\)/));

    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna esistente')), true);
    assert.equal(isPressed(cardChoiceButton(root, 'Colloquio col Dirigente', 'Aggiorna esistente')), true);

    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, true);
    assert.equal(state.importedNew.length, 0, 'nessun doppione');
    assert.equal(state.importedUpdated.length, 2, 'aggiornati entrambi gli impegni riconosciuti');
    const ids = state.importedUpdated.map((e) => e.id).sort();
    assert.deepEqual(ids, ['ev-collegio', 'ev-dirigente']);
  } finally {
    renderer.unmount();
  }
});

test('riga in blocco: con i soli conflitti di orario il conteggio li nomina per quello che sono', async () => {
  const { renderer } = await renderResults([itemColloquio], [existingIncontro]);
  const root = renderer.root;
  try {
    assert.ok(
      textOf(root).includes('1 impegni allo stesso orario'),
      'conteggio del solo criterio dell\'orario'
    );
    assert.equal(
      textOf(root).includes('possibili aggiornamenti'),
      false,
      'nessun conflitto per titolo: il conteggio non li cita'
    );
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 5) Più impegni sovrapposti: l'avviso dice quanti altri ce ne sono
// ---------------------------------------------------------------------------

test('più impegni sovrapposti: la scheda segnala gli altri alla stessa ora', async () => {
  const events: CalendarEvent[] = [
    {
      id: 'ev-uguale', title: 'Incontro uguale', category: 'riunione',
      date: '2026-10-12', startTime: '15:15', endTime: '15:40', isAllDay: false, sourceType: 'manuale',
    },
    {
      id: 'ev-lungo', title: 'Incontro lungo', category: 'riunione',
      date: '2026-10-12', startTime: '15:00', endTime: '16:00', isAllDay: false, sourceType: 'manuale',
    },
    {
      id: 'ev-parziale', title: 'Incontro parziale', category: 'riunione',
      date: '2026-10-12', startTime: '15:30', endTime: '16:30', isAllDay: false, sourceType: 'manuale',
    },
  ];

  const { renderer } = await renderResults([itemColloquio], events);
  const root = renderer.root;
  try {
    const scope = scopeOfTitle(root, 'Colloquio col Dirigente');
    const text = textOf(scope);
    assert.ok(text.includes('Stesso orario di un impegno già in agenda'));
    assert.ok(text.includes('E altri 2 alla stessa ora.'), 'avviso con il conteggio degli altri');
    assert.ok(text.includes('Incontro uguale'), 'viene mostrato il migliore: stesso inizio+fine');
  } finally {
    renderer.unmount();
  }
});
