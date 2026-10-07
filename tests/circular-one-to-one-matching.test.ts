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

let mockItems: any[] = [];

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
  let importedNew: CalendarEvent[] = [];
  let importedUpdated: CalendarEvent[] = [];
  let importCalled = false;
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(CircularAnalyzerModal, {
      isOpen: true,
      onClose: () => {},
      profile,
      existingEvents: events,
      onImportEvents: (newEvents: CalendarEvent[], _docMeta: any, updatedEvents?: CalendarEvent[]) => {
        importCalled = true;
        importedNew = newEvents;
        importedUpdated = updatedEvents || [];
      },
      initialFile: {
        base64: 'QUJD', mimeType: 'image/jpeg', fileName: 'circolare.jpg',
        autoStartToken: `one-to-one-${Math.random()}`,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  // La pertinenza dipende dalla valutazione del documento: qui interessa
  // l'abbinamento, quindi si parte da tutti gli impegni visibili selezionati.
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

const scopeOfTitle = (root: any, title: string, occurrence = 0) => {
  const inputs = titleInputs(root, title);
  assert.ok(inputs.length > occurrence, `input del titolo non trovato: ${title}`);
  const scope = scopeFromTitleInput(inputs[occurrence]);
  assert.ok(scope, `scheda non trovata per il titolo: ${title}`);
  return scope;
};

const cardCheckbox = (root: any, title: string, occurrence = 0) =>
  scopeOfTitle(root, title, occurrence)
    .findAll((n: any) => n.type === 'input' && n.props.type === 'checkbox')[0];

/** Pulsante di scelta della scheda (si distingue da quelli in blocco per via di aria-pressed). */
const cardChoiceButtons = (root: any, title: string, occurrence = 0) =>
  scopeOfTitle(root, title, occurrence)
    .findAll((n: any) => n.type === 'button' && n.props['aria-pressed'] !== undefined);

/** Righe di differenza della scheda compatta: "Orario: 16:00–18:30 → 17:00–18:30", … */
const differenceLines = (scope: any) => scope.findAll((n: any) => n.type === 'li').map((n: any) => textOf(n));

const cardChoiceButton = (root: any, title: string, label: string, occurrence = 0) =>
  cardChoiceButtons(root, title, occurrence).find((b: any) => textOf(b) === label);

const isPressed = (button: any) =>
  /\bbg-(emerald-700|amber-600|stone-700)\b/.test(button?.props?.className || '');

const footerCounts = (root: any) => {
  const m = textOf(root).match(/(\d+) impegni selezionati su (\d+)/);
  assert.ok(m, 'contatore selezionati non trovato');
  return [m[1], m[2]];
};

const EXISTING_COLLEGIO: CalendarEvent = {
  id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti',
  date: '2027-05-25', startTime: '17:00', endTime: '18:30', isAllDay: false, sourceType: 'circolare',
};

// ---------------------------------------------------------------------------
// 1) CASO RIPRODOTTO: due righe, un solo impegno in agenda
// ---------------------------------------------------------------------------

test('caso riprodotto: la riga 17:00-18:30 è identica (saltata), la 16:00-17:00 è nuova e senza conflitto', async () => {
  const { renderer, state } = await renderResults(
    [
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25', startTime: '16:00', endTime: '17:00', relevance: 'VERDE' },
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25', startTime: '17:00', endTime: '18:30', relevance: 'VERDE' },
    ],
    [EXISTING_COLLEGIO]
  );
  const root = renderer.root;
  try {
    // Una sola riga nell'elenco: la 16:00-17:00. La riga identica è saltata e
    // riassunta in una riga sola dell'intestazione.
    assert.equal(titleInputs(root, 'Collegio Docenti').length, 1, 'la riga identica non compare nell\'elenco');
    assert.ok(textOf(root).includes('1 già in agenda, saltati'), 'riga riassuntiva con N');
    assert.ok(findButton(root, /^Mostra$/), '"Mostra" disponibile');
    assert.ok(!textOf(root).includes('da decidere'), 'nessuna riga da decidere');
    assert.ok(!textOf(root).includes('Già in agenda con dati diversi'), 'nessuna scheda di confronto');
    assert.ok(!textOf(root).includes('Si sovrappone a:'), 'la riga 16:00-17:00 non si sovrappone a nulla');

    // Selezione: resta selezionata solo la riga nuova (la 16:00-17:00).
    assert.deepEqual(footerCounts(root), ['1', '2']);
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, true);

    // Importazione: l'evento esistente non viene toccato, nasce il nuovo 16:00-17:00.
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importCalled, true, 'importazione non bloccata');
    assert.equal(state.importedUpdated.length, 0, 'nessun aggiornamento dell\'impegno esistente');
    assert.equal(state.importedNew.length, 1, 'un solo nuovo impegno');
    assert.equal(state.importedNew[0].title, 'Collegio Docenti');
    assert.equal(state.importedNew[0].startTime, '16:00');
    assert.equal(state.importedNew[0].endTime, '17:00');

    // In agenda restano entrambi gli orari: l'esistente 17:00-18:30 e il nuovo 16:00-17:00.
    assert.equal(EXISTING_COLLEGIO.startTime, '17:00');
    assert.equal(EXISTING_COLLEGIO.endTime, '18:30');
    const agendaTimes = [EXISTING_COLLEGIO, ...state.importedNew].map((e) => `${e.startTime}-${e.endTime}`);
    assert.deepEqual(agendaTimes.sort(), ['16:00-17:00', '17:00-18:30']);
  } finally {
    renderer.unmount();
  }
});

test('caso riprodotto: "Mostra" rivela la riga identica, deselezionata e con "Salta" premuto', async () => {
  const { renderer } = await renderResults(
    [
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25', startTime: '16:00', endTime: '17:00', relevance: 'VERDE' },
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25', startTime: '17:00', endTime: '18:30', relevance: 'VERDE' },
    ],
    [EXISTING_COLLEGIO]
  );
  const root = renderer.root;
  try {
    await click(findButton(root, /^Mostra$/));
    assert.equal(titleInputs(root, 'Collegio Docenti').length, 2, '"Mostra" rende visibile la riga identica');
    assert.ok(textOf(root).includes('Già in agenda, identico'), 'etichetta dell\'identico');
    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Salta', 1)), true, '"Salta" preimpostato');

    // Il comando si può richiudere: torna la riga riassuntiva.
    await click(findButton(root, /^Nascondi$/));
    assert.equal(titleInputs(root, 'Collegio Docenti').length, 1);
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 2) EVENTO CONTESO: una sola riga lo occupa, l'altra è nuova
// ---------------------------------------------------------------------------

test('evento conteso da due righe con orari diversi: una sola è abbinata, l\'altra è nuova', async () => {
  const { renderer, state } = await renderResults(
    [
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25', startTime: '15:00', endTime: '16:30', relevance: 'VERDE' },
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25', startTime: '16:00', endTime: '17:00', relevance: 'VERDE' },
    ],
    [EXISTING_COLLEGIO]
  );
  const root = renderer.root;
  try {
    // Una sola scheda di confronto: vince la prima riga del documento.
    assert.ok(textOf(root).includes('Già in agenda con dati diversi'));
    assert.ok(textOf(root).includes('Orario: 17:00–18:30 → 15:00–16:30'), 'la riga abbinata è la 15:00-16:30');
    assert.equal(textOf(root).includes('→ 16:00–17:00'), false, 'la seconda riga non è abbinata a nulla');
    assert.ok(textOf(root).includes('1 da decidere'));
    assert.equal(root.findAll((n: any) => n.type === 'button' && textOf(n) === 'Aggiorna').length, 1, 'una sola scheda da decidere');

    // "Aggiorna": l'impegno esistente prende l'orario della riga abbinata.
    await click(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna'));
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importCalled, true, 'importazione completata');
    assert.equal(state.importedUpdated.length, 1);
    assert.equal(state.importedUpdated[0].id, 'ev-collegio');
    assert.equal(state.importedUpdated[0].startTime, '15:00');
    assert.equal(state.importedUpdated[0].endTime, '16:30');
    // La riga che ha perso la contesa è un impegno nuovo, senza conflitto.
    assert.equal(state.importedNew.length, 1);
    assert.equal(state.importedNew[0].startTime, '16:00');
    assert.equal(state.importedNew[0].endTime, '17:00');
  } finally {
    renderer.unmount();
  }
});

test('evento conteso: la riga con stesso inizio+fine vince anche se arriva dopo nel documento', async () => {
  const { renderer, state } = await renderResults(
    [
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25', startTime: '15:00', endTime: '16:30', relevance: 'VERDE' },
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25', startTime: '17:00', endTime: '18:30', relevance: 'VERDE' },
    ],
    [EXISTING_COLLEGIO]
  );
  const root = renderer.root;
  try {
    // La seconda riga è identica all'evento: è lei a occuparlo (e a essere saltata),
    // quindi la prima riga resta un impegno nuovo senza alcuna scelta da fare.
    assert.ok(textOf(root).includes('1 già in agenda, saltati'));
    assert.ok(!textOf(root).includes('da decidere'), 'nessuna scelta richiesta');
    assert.equal(titleInputs(root, 'Collegio Docenti').length, 1, 'resta visibile solo la riga nuova');

    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importedUpdated.length, 0, 'l\'impegno identico non viene aggiornato');
    assert.equal(state.importedNew.length, 1);
    assert.equal(state.importedNew[0].startTime, '15:00');
    assert.equal(state.importedNew[0].endTime, '16:30');
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 3) IDENTICI: fuori dall'elenco, contati nella riga riassuntiva
// ---------------------------------------------------------------------------

test('identici: fuori dall\'elenco, contati nella riga riassuntiva e rivelabili con "Mostra"', async () => {
  const existingDipartimento: CalendarEvent = {
    id: 'ev-dipartimento', title: 'Dipartimento Matematica', category: 'dipartimento',
    date: '2027-05-26', startTime: '15:00', endTime: '16:00', isAllDay: false, sourceType: 'circolare',
  };
  const { renderer, state } = await renderResults(
    [
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25', startTime: '17:00', endTime: '18:30', relevance: 'VERDE' },
      { title: 'Dipartimento Matematica', category: 'dipartimento', date: '2027-05-26', startTime: '15:00', endTime: '16:00', relevance: 'VERDE' },
      { title: 'Formazione Privacy', category: 'formazione', date: '2027-05-27', startTime: '15:00', endTime: '17:00', relevance: 'VERDE' },
    ],
    [EXISTING_COLLEGIO, existingDipartimento]
  );
  const root = renderer.root;
  try {
    assert.equal(titleInputs(root, 'Collegio Docenti').length, 0, 'identico 1 fuori dall\'elenco');
    assert.equal(titleInputs(root, 'Dipartimento Matematica').length, 0, 'identico 2 fuori dall\'elenco');
    assert.ok(textOf(root).includes('2 già in agenda, saltati'), 'riga riassuntiva con N=2');
    assert.deepEqual(footerCounts(root), ['1', '3'], 'gli identici sono saltati, resta selezionato il nuovo');

    await click(findButton(root, /^Mostra$/));
    assert.equal(titleInputs(root, 'Collegio Docenti').length, 1);
    assert.equal(titleInputs(root, 'Dipartimento Matematica').length, 1);
    assert.ok(textOf(root).includes('2 già in agenda, saltati'), 'la riga riassuntiva resta');
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, false, 'identico deselezionato');
    assert.equal(cardCheckbox(root, 'Dipartimento Matematica').props.checked, false, 'identico deselezionato');

    // Nessuna scelta richiesta e nessun blocco: si importa il solo impegno nuovo.
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importCalled, true);
    assert.equal(state.importedNew.length, 1);
    assert.equal(state.importedNew[0].title, 'Formazione Privacy');
    assert.equal(state.importedUpdated.length, 0);
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 4) SOVRAPPOSIZIONE: etichetta compatta, nessun blocco
// ---------------------------------------------------------------------------

test('sovrapposizione: etichetta "Si sovrappone a", nessuna scelta e importazione non bloccata', async () => {
  const existingConsiglio: CalendarEvent = {
    id: 'ev-consiglio', title: 'Consiglio di Classe 1A', category: 'consiglio_classe', className: '1A',
    date: '2027-05-25', startTime: '15:00', endTime: '15:45', isAllDay: false, sourceType: 'manuale',
  };
  const { renderer, state } = await renderResults(
    [{ title: 'GLO alunno', category: 'glo', className: '1A', date: '2027-05-25', startTime: '15:00', endTime: '16:00', relevance: 'VERDE' }],
    [existingConsiglio]
  );
  const root = renderer.root;
  try {
    const scope = scopeOfTitle(root, 'GLO alunno');
    assert.ok(
      textOf(scope).includes('Si sovrappone a: Consiglio di Classe 1A 15:00–15:45'),
      'etichetta compatta con titolo e orario dell\'impegno in agenda'
    );
    assert.equal(cardChoiceButtons(root, 'GLO alunno').length, 0, 'nessuna scelta da fare');
    assert.ok(!textOf(root).includes('da decidere'), 'la sovrapposizione non entra nel conteggio');
    assert.equal(cardCheckbox(root, 'GLO alunno').props.checked, true, 'la sovrapposizione segue la normale selezione');

    // L'importazione non è bloccata: l'impegno entra come nuovo.
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importCalled, true, 'importazione non bloccata');
    assert.ok(!textOf(root).includes('Restano'), 'nessun messaggio di blocco');
    assert.equal(state.importedNew.length, 1);
    assert.equal(state.importedNew[0].title, 'GLO alunno');
    assert.equal(state.importedUpdated.length, 0);
  } finally {
    renderer.unmount();
  }
});

test('sovrapposizione: con più impegni alla stessa ora l\'etichetta aggiunge "+N"', async () => {
  // Categorie specifiche diverse da quella della riga: nessun abbinamento, solo
  // sovrapposizioni (impegni distinti alla stessa ora).
  const events: CalendarEvent[] = [
    {
      id: 'ev-lungo', title: 'Consiglio di Classe 1A', category: 'consiglio_classe', className: '1A',
      date: '2027-05-25', startTime: '15:00', endTime: '16:00', isAllDay: false, sourceType: 'manuale',
    },
    {
      id: 'ev-breve', title: 'Collegio Docenti', category: 'collegio_docenti',
      date: '2027-05-25', startTime: '15:30', endTime: '15:40', isAllDay: false, sourceType: 'manuale',
    },
  ];
  const { renderer } = await renderResults(
    [{ title: 'GLO alunno', category: 'glo', className: '1A', date: '2027-05-25', startTime: '15:15', endTime: '16:00', relevance: 'VERDE' }],
    events
  );
  const root = renderer.root;
  try {
    const text = textOf(scopeOfTitle(root, 'GLO alunno'));
    assert.ok(text.includes('Si sovrappone a: Consiglio di Classe 1A 15:00–16:00 +1'), 'primo impegno e conteggio degli altri');
    assert.equal(cardChoiceButtons(root, 'GLO alunno').length, 0);
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 5) SCHEDA COMPATTA: solo le differenze, tre pulsanti, blocco senza scelta
// ---------------------------------------------------------------------------

test('scheda compatta: solo i campi diversi, tre pulsanti brevi, significato esteso in title/aria-label', async () => {
  const { renderer, state } = await renderResults(
    [
      {
        title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25',
        startTime: '15:00', endTime: '16:30', location: 'Telematica', relevance: 'VERDE',
      },
    ],
    [EXISTING_COLLEGIO]
  );
  const root = renderer.root;
  try {
    const scope = scopeOfTitle(root, 'Collegio Docenti');
    assert.ok(textOf(scope).includes('Già in agenda con dati diversi'), 'riga di titolo per il criterio del titolo');
    // Solo le differenze: orario e luogo, una per riga. Data, categoria e titolo
    // sono uguali e non compaiono: l'elenco è esattamente questo.
    assert.deepEqual(differenceLines(scope), [
      'Orario: 17:00–18:30 → 15:00–16:30',
      'Luogo: — → Telematica',
    ]);

    // Tre pulsanti brevi, nessuna scelta preselezionata.
    const choices = cardChoiceButtons(root, 'Collegio Docenti');
    assert.deepEqual(choices.map((b: any) => textOf(b)), ['Aggiorna', 'Tieni entrambi', 'Salta']);
    for (const button of choices) {
      assert.equal(isPressed(button), false, `nessuna scelta preselezionata: ${textOf(button)}`);
      assert.match(button.props.title, /^(Aggiorna|Tieni entrambi|Salta): /, 'significato esteso nel title');
      assert.equal(button.props['aria-label'], button.props.title, 'significato esteso anche in aria-label');
    }

    // Blocco finché manca la scelta, poi si procede.
    assert.ok(textOf(root).includes('1 da decidere'));
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importCalled, false, 'senza scelta l\'importazione resta bloccata');
    assert.ok(textOf(root).includes('Restano 1 impegni da decidere'), 'messaggio di blocco in una riga');

    await click(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna'));
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importCalled, true);
    assert.equal(state.importedUpdated.length, 1);
    assert.equal(state.importedUpdated[0].id, 'ev-collegio');
    assert.equal(state.importedUpdated[0].startTime, '15:00');
    assert.equal(state.importedUpdated[0].location, 'Telematica');
  } finally {
    renderer.unmount();
  }
});

test('scheda compatta: per il criterio dell\'orario la riga di titolo è "Forse è lo stesso impegno"', async () => {
  const existingIncontro: CalendarEvent = {
    id: 'ev-dirigente', title: 'Incontro con il Dirigente', category: 'riunione',
    date: '2027-05-25', startTime: '15:00', endTime: '15:45', isAllDay: false, sourceType: 'manuale',
  };
  const { renderer } = await renderResults(
    [{ title: 'Colloquio col Dirigente', category: 'riunione', date: '2027-05-25', startTime: '15:15', endTime: '15:40', relevance: 'VERDE' }],
    [existingIncontro]
  );
  const root = renderer.root;
  try {
    const scope = scopeOfTitle(root, 'Colloquio col Dirigente');
    assert.ok(textOf(scope).includes('Forse è lo stesso impegno'), 'riga di titolo per il criterio dell\'orario');
    // Il titolo diverso è la differenza che spiega il confronto; l'orario segue.
    assert.deepEqual(differenceLines(scope), [
      'Orario: 15:00–15:45 → 15:15–15:40',
      'Titolo: Incontro con il Dirigente → Colloquio col Dirigente',
    ]);
  } finally {
    renderer.unmount();
  }
});

test('blocco importazione: una riga sola con N, "Vai al prossimo" e le tre azioni rapide', async () => {
  const existingDipartimento: CalendarEvent = {
    id: 'ev-dipartimento', title: 'Dipartimento Matematica', category: 'dipartimento',
    date: '2027-05-25', startTime: '16:00', endTime: '17:00', isAllDay: false, sourceType: 'circolare',
  };
  const { renderer } = await renderResults(
    [
      { title: 'Collegio Docenti', category: 'collegio_docenti', date: '2027-05-25', startTime: '15:00', endTime: '16:30', relevance: 'VERDE' },
      { title: 'Dipartimento Matematica', category: 'dipartimento', date: '2027-05-25', startTime: '14:00', endTime: '15:00', relevance: 'VERDE' },
    ],
    [EXISTING_COLLEGIO, existingDipartimento]
  );
  const root = renderer.root;
  try {
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.ok(textOf(root).includes('Restano 2 impegni da decidere'), 'una riga sola con N');
    assert.equal(textOf(root).includes('Collegio Docenti ·'), false, 'nessun elenco di titoli');
    assert.ok(root.findByProps({ id: 'btn-go-to-next-unresolved' }), '"Vai al prossimo" presente');
    assert.ok(findButtonByLabel(root, /^Aggiorna tutti: impegni selezionati da decidere, anche se nascosti dai filtri \(2\)$/));
    assert.ok(findButtonByLabel(root, /^Tieni tutti: impegni selezionati da decidere, anche se nascosti dai filtri \(2\)$/));
    assert.ok(findButtonByLabel(root, /^Salta tutti: impegni selezionati da decidere, anche se nascosti dai filtri \(2\)$/));
  } finally {
    renderer.unmount();
  }
});
