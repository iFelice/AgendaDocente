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
  // conflitto, quindi si parte da tutti gli impegni visibili selezionati.
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

/** Righe di differenza della scheda compatta: "Orario: 15:00–15:45 → 15:15–15:40", … */
const differenceLines = (scope: any) => scope.findAll((n: any) => n.type === 'li').map((n: any) => textOf(n));

const isPressed = (button: any) =>
  /\bbg-(emerald-700|amber-600|stone-700)\b/.test(button?.props?.className || '');

// ---------------------------------------------------------------------------
// 1) Riconoscimento per ORARIO: scheda compatta "Forse è lo stesso impegno"
// ---------------------------------------------------------------------------

test('stesso orario: scheda compatta con le sole differenze e tre scelte, nessuna preselezionata', async () => {
  const { renderer } = await renderResults([itemColloquio], [existingIncontro]);
  const root = renderer.root;
  try {
    const scope = scopeOfTitle(root, 'Colloquio col Dirigente');
    const text = textOf(scope);
    assert.ok(text.includes('Forse è lo stesso impegno'), 'riga di titolo della scheda');
    // Niente più riquadro a due colonne: solo le differenze, una per riga.
    assert.equal(text.includes('Esistente in agenda'), false, 'niente colonna "Esistente in agenda"');
    assert.equal(text.includes('Dalla nuova circolare'), false, 'niente colonna "Dalla nuova circolare"');
    assert.deepEqual(differenceLines(scope), [
      'Orario: 15:00–15:45 → 15:15–15:40',
      'Titolo: Incontro con il Dirigente → Colloquio col Dirigente',
    ]);

    // Le tre scelte ci sono tutte, nessuna preselezionata.
    const choices = scope.findAll((n: any) => n.type === 'button' && n.props['aria-pressed'] !== undefined);
    const labels = choices.map((n: any) => textOf(n));
    assert.deepEqual(labels, ['Aggiorna', 'Tieni entrambi', 'Salta']);
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

test('stesso orario: importazione bloccata senza scelta, poi "Aggiorna" aggiorna (nessun doppione)', async () => {
  const { renderer, state } = await renderResults([itemColloquio], [existingIncontro]);
  const root = renderer.root;
  try {
    // 1. Conferma senza scelta: non importa e avvisa con una riga sola.
    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, false, 'senza scelta l\'importazione resta bloccata');
    assert.ok(
      textOf(root).includes('Restano 1 impegni da decidere'),
      'messaggio di blocco in una riga con il conteggio'
    );

    // 2. Scelta "Aggiorna": aggiorna l'impegno in agenda, non ne crea uno nuovo.
    await click(cardChoiceButton(root, 'Colloquio col Dirigente', 'Aggiorna'));
    assert.equal(isPressed(cardChoiceButton(root, 'Colloquio col Dirigente', 'Aggiorna')), true);
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

test('stesso orario: "Salta" deseleziona (la scelta comanda sulla selezione)', async () => {
  const { renderer, state } = await renderResults([itemColloquio], [existingIncontro]);
  const root = renderer.root;
  try {
    await click(cardChoiceButton(root, 'Colloquio col Dirigente', 'Salta'));
    assert.equal(cardCheckbox(root, 'Colloquio col Dirigente').props.checked, false, '"Salta" deseleziona');
    assert.equal(isPressed(cardChoiceButton(root, 'Colloquio col Dirigente', 'Salta')), true);

    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, false, 'nessun impegno selezionato: nessuna importazione');
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 3) "Identico ⇒ saltato in automatico" vale solo per il criterio del titolo
// ---------------------------------------------------------------------------

test('identico ⇒ saltato in automatico: solo per il titolo, non per il solo orario', async () => {
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
    assert.ok(text.includes('Forse è lo stesso impegno'));
    assert.equal(text.includes('Già in agenda, identico'), false, 'etichetta riservata al criterio del titolo');
    assert.equal(text.includes('già in agenda, saltati'), false, 'nessun saltato in automatico per il solo orario');
    assert.equal(cardCheckbox(root, 'Colloquio col Dirigente').props.checked, true, 'resta selezionato');

    // Senza scelta l'importazione è bloccata: il preimpostato "Salta" non scatta.
    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, false, 'la scelta resta obbligatoria');

    // Con la scelta esplicita si procede.
    await click(cardChoiceButton(root, 'Colloquio col Dirigente', 'Salta'));
    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, false, 'saltato: nessuna modifica da salvare');
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 4) Riga in blocco: un solo conteggio, azione valida su entrambi i criteri
// ---------------------------------------------------------------------------

test('riga in blocco: un solo conteggio "N da decidere", senza conteggi per tipo', async () => {
  const existingCollegio: CalendarEvent = {
    id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti',
    date: '2026-10-15', startTime: '17:00', endTime: '18:00', isAllDay: false, sourceType: 'circolare',
  };

  const { renderer } = await renderResults(
    [
      // Riconosciuta per titolo (possibile aggiornamento).
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-15', startTime: '15:00', endTime: '16:30' },
      // Riconosciuta per il solo orario (titolo diverso).
      itemColloquio,
    ],
    [existingCollegio, existingIncontro]
  );
  const root = renderer.root;
  try {
    const text = textOf(root);
    assert.ok(text.includes('2 da decidere'), 'un solo conteggio nella riga in blocco');
    assert.equal(text.includes('possibili aggiornamenti'), false, 'niente conteggi per tipo');
    assert.equal(text.includes('sovrapposizioni'), false, 'niente conteggi per tipo');
    assert.ok(text.includes('Già in agenda con dati diversi'), 'scheda per il titolo');
    assert.ok(text.includes('Forse è lo stesso impegno'), 'scheda per l\'orario');
  } finally {
    renderer.unmount();
  }
});

test('riga in blocco: le tre azioni rapide valgono su entrambi i criteri di conflitto', async () => {
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
    await click(findButtonByLabel(root, /^Aggiorna tutti: conflitti visibili non risolti \(2\)/));

    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna')), true);
    assert.equal(isPressed(cardChoiceButton(root, 'Colloquio col Dirigente', 'Aggiorna')), true);

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

test('riga in blocco: con la sola riconoscizione per orario resta un solo "da decidere"', async () => {
  const { renderer } = await renderResults([itemColloquio], [existingIncontro]);
  const root = renderer.root;
  try {
    assert.ok(textOf(root).includes('1 da decidere'), 'conteggio del solo criterio dell\'orario');
    assert.equal(textOf(root).includes('possibili aggiornamenti'), false, 'il conteggio non nomina i criteri');
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 5) Più impegni alla stessa ora: la riga si abbina al migliore
// ---------------------------------------------------------------------------

test('più impegni alla stessa ora: la riga si abbina a quello con stesso inizio+fine', async () => {
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

  const { renderer, state } = await renderResults([itemColloquio], events);
  const root = renderer.root;
  try {
    const scope = scopeOfTitle(root, 'Colloquio col Dirigente');
    assert.ok(textOf(scope).includes('Forse è lo stesso impegno'));
    assert.deepEqual(differenceLines(scope), [
      'Titolo: Incontro uguale → Colloquio col Dirigente',
    ], 'lo spareggio sceglie l\'impegno con stesso inizio+fine (l\'orario non differisce)');

    // Un livello per riga: la scheda del conflitto non lascia anche l'etichetta
    // di sovrapposizione, che è riservata agli impegni diversi senza conflitto.
    assert.equal(textOf(scope).includes('Si sovrappone a:'), false);

    await click(cardChoiceButton(root, 'Colloquio col Dirigente', 'Aggiorna'));
    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importedUpdated.length, 1);
    assert.equal(state.importedUpdated[0].id, 'ev-uguale', 'aggiornato l\'impegno giusto');
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 6) "Vai al prossimo" vale anche per i conflitti di orario
// ---------------------------------------------------------------------------

test('"Vai al prossimo" raggiunge ed evidenzia anche un conflitto di orario', async () => {
  const { renderer } = await renderResults([itemColloquio], [existingIncontro]);
  const root = renderer.root;
  try {
    // Blocco attivo: fra i selezionati resta un conflitto senza scelta.
    await click(findButton(root, /all'Agenda/));
    assert.ok(textOf(root).includes('Restano 1 impegni da decidere'));

    const goNext = root.findAll((n: any) => n.props?.id === 'btn-go-to-next-unresolved')[0];
    assert.ok(goNext, 'pulsante "Vai al prossimo" presente');
    await click(goNext);

    const highlighted = root.findAll(
      (n: any) => n.type === 'div' && n.props['data-conflict-highlight'] === 'true'
    );
    assert.equal(highlighted.length, 1, 'una sola scheda evidenziata');
    assert.ok(
      textOf(highlighted[0]).includes('Colloquio col Dirigente'),
      'la scheda evidenziata è quella del conflitto di orario'
    );

    // Risolto il conflitto, il messaggio di blocco sparisce.
    await click(cardChoiceButton(root, 'Colloquio col Dirigente', 'Tieni entrambi'));
    assert.equal(
      textOf(root).includes('Restano 1 impegni da decidere'),
      false,
      'dopo la scelta il messaggio di blocco non serve più'
    );
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 7) Sovrapposizione: etichetta compatta, nessuna scelta, nessun blocco
// ---------------------------------------------------------------------------

const overlapItem = { title: 'GLO alunno', category: 'glo', className: '1A', date: '2026-10-12', startTime: '15:00', endTime: '16:00' };
const overlapExisting: CalendarEvent = { ...existingIncontro, id: 'cdc', title: 'Consiglio di Classe 1A', category: 'consiglio_classe', className: '1A' };

test('sovrapposizione: etichetta compatta, nessuna scelta e nessun blocco all\'importazione', async () => {
  const { renderer, state } = await renderResults([overlapItem], [overlapExisting]);
  const root = renderer.root;
  try {
    const scope = scopeOfTitle(root, overlapItem.title);
    assert.ok(
      textOf(scope).includes('Si sovrappone a: Consiglio di Classe 1A 15:00–15:45'),
      'etichetta compatta con titolo e orario dell\'impegno in agenda'
    );
    assert.equal(
      scope.findAll((n: any) => n.type === 'button' && n.props['aria-pressed'] !== undefined).length,
      0,
      'la sovrapposizione non chiede alcuna scelta'
    );
    assert.ok(!textOf(root).includes('da decidere'), 'fuori dal conteggio dei conflitti');

    // L'impegno segue la normale selezione e viene aggiunto senza fermarsi.
    assert.equal(cardCheckbox(root, overlapItem.title).props.checked, true);
    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, true, 'importazione non bloccata');
    assert.ok(!textOf(root).includes('Restano'), 'nessun messaggio di blocco');
    assert.equal(state.importedNew.length, 1);
    assert.equal(state.importedUpdated.length, 0);
    assert.equal(overlapExisting.title, 'Consiglio di Classe 1A', 'l\'impegno in agenda non viene toccato');
  } finally { renderer.unmount(); }
});

test('riga in blocco: "Aggiorna tutti" non tocca le sovrapposizioni; Annulla, "Tieni tutti" e "Salta tutti"', async () => {
  const titleExisting: CalendarEvent = { ...existingIncontro, id: 'title', title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-15' };
  const titleItem = { ...titleExisting, startTime: '17:00', endTime: '18:00' };
  const timeItem = { ...itemColloquio, date: '2026-10-16' };
  const { renderer, state } = await renderResults([overlapItem, titleItem, timeItem], [overlapExisting, titleExisting, { ...existingIncontro, date: '2026-10-16' }]);
  const root = renderer.root;
  try {
    // La sovrapposizione non entra nel conteggio: restano i due conflitti veri.
    assert.ok(textOf(root).includes('2 da decidere'));
    await click(findButtonByLabel(root, /^Aggiorna tutti: conflitti visibili non risolti \(2\)/));
    assert.equal(isPressed(cardChoiceButton(root, titleItem.title, 'Aggiorna')), true);
    assert.equal(isPressed(cardChoiceButton(root, timeItem.title, 'Aggiorna')), true);
    assert.equal(
      scopeOfTitle(root, overlapItem.title).findAll((n: any) => n.type === 'button' && n.props['aria-pressed'] !== undefined).length,
      0,
      'la sovrapposizione non ha scelte da sovrascrivere'
    );

    await click(findButton(root, /all'Agenda/));
    assert.equal(state.importCalled, true, 'importazione completata');
    assert.equal(state.importedUpdated.length, 2);
    assert.equal(state.importedNew.length, 1, 'solo la sovrapposizione nasce come nuovo impegno');
    assert.equal(state.importedNew[0].title, overlapItem.title);
    assert.equal(state.importedUpdated.map((e) => e.id).sort().join(','), 'ev-dirigente,title');

    // "Annulla" riporta le scelte allo stato precedente.
    await click(findButtonByLabel(root, /^Annulla l'ultima azione in blocco/));
    assert.equal(isPressed(cardChoiceButton(root, titleItem.title, 'Aggiorna')), false);
    assert.ok(textOf(root).includes('2 da decidere'));

    // "Salta tutti": restano solo le sovrapposizioni da importare.
    await click(findButtonByLabel(root, /^Salta tutti: conflitti visibili non risolti \(2\)/));
    assert.equal(cardCheckbox(root, titleItem.title).props.checked, false);
    assert.equal(cardCheckbox(root, overlapItem.title).props.checked, true);
    assert.ok(textOf(root).includes("Aggiungi 1 selezionati all'Agenda"), 'resta selezionata la sola sovrapposizione');
  } finally { renderer.unmount(); }
});
