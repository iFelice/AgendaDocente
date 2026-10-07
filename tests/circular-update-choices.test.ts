import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import { describeEventDifferences, isIdenticalEventUpdate } from '../src/utils/eventMatching';
import type { CalendarEvent, TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;

// Profilo sintetico: nessun documento scolastico reale, nessun dato personale.
const profile: TeacherProfile = {
  id: 'teacher', fullName: 'Docente Test', schoolName: 'Scuola Test', schoolLevel: 'ssig',
  schoolYear: '2026/2027', primarySubjects: ['Matematica'], classes: ['1A'], campuses: [], roles: [],
};

// Agenda sintetica con due impegni che generano conflitti con la circolare:
// - "Collegio Docenti" (ottobre 2026) con orario diverso da quello estratto -> conflitto da decidere;
// - "Consiglio di classe 1A" (gennaio 2027) riprodotto tale e quale -> identico, saltato.
const existingEvents: CalendarEvent[] = [
  {
    id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti',
    date: '2026-10-15', startTime: '17:00', endTime: '18:00', isAllDay: false, sourceType: 'circolare',
  },
  {
    id: 'ev-consiglio', title: 'Consiglio di classe 1A', category: 'consiglio_classe', className: '1A',
    date: '2027-01-20', startTime: '14:00', endTime: '16:00', isAllDay: false, sourceType: 'manuale',
  },
  {
    id: 'ev-dipartimento', title: 'Dipartimento Matematica', category: 'dipartimento',
    date: '2027-01-20', startTime: '14:00', endTime: '16:00', isAllDay: false, sourceType: 'circolare',
  },
];

// A: conflitto non identico (orario diverso), VERDE -> auto-selezionato.
const itemA = {
  title: 'Collegio Docenti', category: 'collegio_docenti',
  date: '2026-10-15', startTime: '15:00', endTime: '16:30',
};
// B: conflitto non identico dello stesso giorno su un ALTRO impegno (l'evento di
// D è occupato una sola volta, da D): VERDE -> auto-selezionato.
const itemB = {
  title: 'Dipartimento Matematica', category: 'dipartimento',
  date: '2027-01-20', startTime: '15:00', endTime: '17:00',
};
// D: conflitto IDENTICO all'impegno in agenda -> saltato in automatico e fuori dall'elenco.
const itemD = {
  title: 'Consiglio di classe 1A', category: 'consiglio_classe', className: '1A',
  date: '2027-01-20', startTime: '14:00', endTime: '16:00',
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

async function renderResults(items: any[]) {
  mockItems = items;
  let importedNew: CalendarEvent[] = [];
  let importedUpdated: CalendarEvent[] = [];
  let importCalled = false;
  let closeCalled = false;
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(CircularAnalyzerModal, {
      isOpen: true,
      onClose: () => { closeCalled = true; },
      profile,
      existingEvents,
      onImportEvents: (newEvents: CalendarEvent[], _docMeta: any, updatedEvents?: CalendarEvent[]) => {
        importCalled = true;
        importedNew = newEvents;
        importedUpdated = updatedEvents || [];
      },
      initialFile: {
        base64: 'QUJD', mimeType: 'image/jpeg', fileName: 'circolare.jpg',
        autoStartToken: `choices-${Math.random()}`,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  return {
    renderer,
    state: {
      get importCalled() { return importCalled; },
      get closeCalled() { return closeCalled; },
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

const footerCounts = (root: any) => {
  const m = textOf(root).match(/(\d+) impegni selezionati su (\d+)/);
  assert.ok(m, 'contatore selezionati non trovato');
  return [m[1], m[2]];
};

const isPressed = (button: any) =>
  /\bbg-(emerald-700|amber-600|stone-700)\b/.test(button?.props?.className || '');

// ---------------------------------------------------------------------------
// UNIT: definizione esatta di "identico"
// ---------------------------------------------------------------------------

test('identico: campo nuovo vuoto conserva il vecchio; testo spostato è una differenza effettiva', () => {
  const existing: CalendarEvent = {
    id: 'ev-1', title: 'Collegio  Docenti', category: 'collegio_docenti',
    date: '2026-10-15', startTime: '17:00', endTime: '18:00', location: 'Modalità Telematica',
    isAllDay: false, sourceType: 'circolare',
  };

  // Titolo con maiuscole e spazi diversi, luogo vuoto nel nuovo: identico.
  assert.equal(isIdenticalEventUpdate(existing, {
    title: 'collegio docenti', category: 'collegio_docenti', date: '2026-10-15',
    startTime: '17:00', endTime: '18:00',
  }), true, 'stesso titolo senza distinzione di maiuscole e spazi; campo vuoto non è differenza');

  // Il nuovo valore note sarebbe scritto davvero nell'evento; il fatto che il testo
  // esista già nel luogo non evita la modifica del campo Note.
  const movedTextCandidate = {
    title: 'Collegio Docenti', category: 'collegio_docenti' as const, date: '2026-10-15',
    startTime: '17:00', endTime: '18:00', notes: 'Modalità Telematica',
  };
  assert.deepEqual(describeEventDifferences(existing, movedTextCandidate).map((difference) => difference.label), ['Note']);
  assert.equal(isIdenticalEventUpdate(existing, movedTextCandidate), false, 'la differenza mostrata e il salto automatico condividono la stessa regola');

  // Un valore davvero diverso (luogo nuovo) non è identico.
  assert.equal(isIdenticalEventUpdate(existing, {
    title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-15',
    startTime: '17:00', endTime: '18:00', location: 'Aula Magna',
  }), false, 'un luogo nuovo è una differenza');

  assert.equal(isIdenticalEventUpdate(existing, {
    title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-15',
    startTime: '15:00', endTime: '18:00',
  }), false, 'orario di inizio diverso');
  assert.equal(isIdenticalEventUpdate(existing, {
    title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-16',
    startTime: '17:00', endTime: '18:00',
  }), false, 'data diversa');
  assert.equal(isIdenticalEventUpdate(existing, {
    title: 'Collegio Docenti', category: 'formazione', date: '2026-10-15',
    startTime: '17:00', endTime: '18:00',
  }), false, 'categoria diversa');
});

// ---------------------------------------------------------------------------
// 1) La scelta implica la selezione (scelta singola)
// ---------------------------------------------------------------------------

test('scelta singola: "Aggiorna"/"Tieni entrambi" selezionano, "Salta" deseleziona, la modifica manuale successiva vale', async () => {
  const { renderer, state } = await renderResults([itemA]);
  const root = renderer.root;
  try {
    // Iniziale: VERDE auto-selezionato.
    assert.deepEqual(footerCounts(root), ['1', '1']);
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, true);

    // "Salta" deseleziona subito (contatore compreso).
    await click(cardChoiceButton(root, 'Collegio Docenti', 'Salta'));
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, false, '"Salta" deve deselezionare');
    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Salta')), true);
    assert.deepEqual(footerCounts(root), ['0', '1']);

    // "Aggiorna" seleziona.
    await click(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna'));
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, true, '"Aggiorna" deve selezionare');
    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna')), true);
    assert.deepEqual(footerCounts(root), ['1', '1']);

    // Deselezione manuale successiva: rispettata, nessun ri-allineamento automatico.
    await act(async () => { cardCheckbox(root, 'Collegio Docenti').props.onChange(); });
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, false, 'la deselezione manuale deve restare');
    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna')), true, 'la scelta resta');
    assert.deepEqual(footerCounts(root), ['0', '1']);

    // Cambiando di nuovo la scelta, la selezione si ri-allinea.
    await click(cardChoiceButton(root, 'Collegio Docenti', 'Tieni entrambi'));
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, true, 'nuova scelta ri-seleziona');
    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Tieni entrambi')), true);
    assert.deepEqual(footerCounts(root), ['1', '1']);
    assert.equal(state.importCalled, false);
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 3) Doppioni identici risolti in automatico
// ---------------------------------------------------------------------------

test('conflitto identico: fuori dall\'elenco, saltato, contato nella riga riassuntiva e non bloccante', async () => {
  const { renderer, state } = await renderResults([itemA, itemD]);
  const root = renderer.root;
  try {
    // Il doppione identico non compare nell'elenco: una sola scheda, quella di A.
    assert.equal(titleInputs(root, 'Consiglio di classe 1A').length, 0, 'identico fuori dall\'elenco');
    assert.equal(titleInputs(root, 'Collegio Docenti').length, 1);
    assert.ok(textOf(root).includes('1 già in agenda, saltati'), 'riga riassuntiva con N');
    assert.deepEqual(footerCounts(root), ['1', '2'], 'l\'identico è deselezionato');
    // Il conteggio dei conflitti non lo include: resta solo il conflitto A.
    assert.ok(textOf(root).includes('1 da decidere'), 'identico escluso dal conteggio N');

    // "Mostra" lo rivela: etichettato, deselezionato e con "Salta" premuto.
    await click(findButton(root, /^Mostra$/));
    assert.equal(titleInputs(root, 'Consiglio di classe 1A').length, 1, '"Mostra" lo rende visibile');
    assert.equal(cardCheckbox(root, 'Consiglio di classe 1A').props.checked, false);
    assert.ok(textOf(root).includes('Già in agenda, identico'), 'etichetta visibile');
    assert.equal(isPressed(cardChoiceButton(root, 'Consiglio di classe 1A', 'Salta')), true, '"Salta" preselezionato');

    // L'identico resta modificabile a mano: lo si può anche riselezionare.
    await act(async () => { cardCheckbox(root, 'Consiglio di classe 1A').props.onChange(); });
    assert.equal(cardCheckbox(root, 'Consiglio di classe 1A').props.checked, true);

    // Risolto A e confermato: l'identico selezionato non blocca l'importazione
    // (saltato come se fosse "Salta") e l'aggiornamento di A passa.
    await click(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna'));
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importCalled, true, 'importazione non bloccata dall\'identico');
    assert.equal(state.importedUpdated.length, 1);
    assert.equal(state.importedUpdated[0].id, 'ev-collegio');
    assert.equal(state.importedUpdated[0].startTime, '15:00');
    assert.equal(state.closeCalled, true);
    assert.ok(!textOf(root).includes('Restano'), 'nessun messaggio di blocco');
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 2) Azione in blocco: solo conflitti visibili non risolti, selezione conseguente, Annulla
// ---------------------------------------------------------------------------

test('azione in blocco: limitata ai conflitti visibili non risolti, con selezione conseguente e Annulla che ripristina', async () => {
  const { renderer, state } = await renderResults([itemA, itemB, itemD]);
  const root = renderer.root;
  try {
    // A e B sono conflitti da decidere; D (identico) è fuori dall'elenco e dal conteggio.
    assert.ok(textOf(root).includes('2 da decidere'));
    assert.deepEqual(footerCounts(root), ['2', '3']);

    // Filtro mese Ott 2026: resta visibile solo A, il conteggio N segue i filtri.
    await click(findButton(root, /^Ott 2026/));
    assert.ok(textOf(root).includes('1 da decidere'));

    // "Salta tutti" in blocco: A deselezionato e con scelta; B (nascosto) e D (identico) intoccati.
    await click(findButtonByLabel(root, /^Salta tutti: conflitti visibili non risolti \(1\)/));
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, false, 'blocco "Salta tutti" deseleziona');
    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Salta')), true);
    assert.deepEqual(footerCounts(root), ['1', '3']);
    assert.ok(textOf(root).includes('Salta tutti applicato a 1 impegno.'), 'annuncio visibile');

    // "Annulla" ripristina scelte E selezioni dei soli elementi toccati.
    await click(findButtonByLabel(root, /^Annulla l'ultima azione in blocco/));
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, true, 'Annulla ripristina la selezione');
    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Salta')), false, 'Annulla ripristina la scelta');
    assert.deepEqual(footerCounts(root), ['2', '3']);

    // Ancora in blocco su Ott 2026: "Aggiorna tutti" seleziona e applica la scelta.
    await click(findButtonByLabel(root, /^Aggiorna tutti: conflitti visibili non risolti \(1\)/));
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, true, 'blocco "Aggiorna tutti" seleziona');
    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna')), true);

    // Tornando a tutti i mesi: B resta non risolto e selezionato, l'identico resta saltato.
    await click(findButton(root, /^Tutti i mesi/));
    assert.equal(cardCheckbox(root, 'Dipartimento Matematica').props.checked, true, 'B (nascosto prima) resta selezionato');
    assert.equal(isPressed(cardChoiceButton(root, 'Dipartimento Matematica', 'Aggiorna')), false, 'B resta senza scelta');
    assert.equal(titleInputs(root, 'Consiglio di classe 1A').length, 0, 'D identico resta fuori dall\'elenco');
    // L'annuncio dell'azione conta i soli elementi toccati (1: A, non B e non D).
    assert.ok(textOf(root).includes('Aggiorna tutti applicato a 1 impegno.'), 'annuncio con conteggio circoscritto ai visibili');
    assert.equal(state.importCalled, false);
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 2) "Tutti risolti" e "Cambia per tutti" (gli identici restano fuori salvo scelta manuale)
// ---------------------------------------------------------------------------

test('"Tutti risolti" con "Cambia per tutti": sovrascrive le scelte esplicite, gli identici solo se toccati', async () => {
  const { renderer } = await renderResults([itemA, itemB, itemD]);
  const root = renderer.root;
  // D (identico) resta l'ultima scheda "Consiglio di classe 1A": per lavorarci
  // anche con il blocco si rivela con "Mostra".
  try {
    await click(findButton(root, /^Mostra$/));
    assert.ok(textOf(root).includes('2 da decidere'), 'l\'identico resta fuori dal conteggio');

    // Risolvo A e B singolarmente.
    await click(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna'));
    await click(cardChoiceButton(root, 'Dipartimento Matematica', 'Tieni entrambi'));
    assert.ok(textOf(root).includes('Tutti risolti'), 'riga con "Tutti risolti"');
    assert.ok(findButton(root, /^Cambia per tutti$/), 'azione "Cambia per tutti" disponibile');

    // "Cambia per tutti" + "Aggiorna tutti": A e B sovrascritti, l'identico D no.
    await click(findButton(root, /^Cambia per tutti$/));
    await click(findButtonByLabel(root, /^Aggiorna tutti: scelte già fatte sui conflitti visibili \(2\)/));
    assert.equal(isPressed(cardChoiceButton(root, 'Dipartimento Matematica', 'Aggiorna')), true, 'B sovrascritto su Aggiorna');
    assert.equal(cardCheckbox(root, 'Dipartimento Matematica').props.checked, true);
    assert.equal(isPressed(cardChoiceButton(root, 'Consiglio di classe 1A', 'Salta')), true, 'l\'identico non toccato resta su "Salta"');
    assert.equal(cardCheckbox(root, 'Consiglio di classe 1A').props.checked, false, 'l\'identico non toccato resta deselezionato');

    // "Annulla" riporta A e B alle scelte precedenti.
    await click(findButtonByLabel(root, /^Annulla l'ultima azione in blocco/));
    assert.equal(isPressed(cardChoiceButton(root, 'Dipartimento Matematica', 'Tieni entrambi')), true, 'B torna su "Tieni entrambi"');

    // Se l'utente cambia a mano la scelta dell'identico, l'identico rientra nel "Cambia per tutti".
    await click(cardChoiceButton(root, 'Consiglio di classe 1A', 'Aggiorna'));
    assert.equal(cardCheckbox(root, 'Consiglio di classe 1A').props.checked, true, 'scelta manuale sull\'identico lo seleziona');
    await click(findButton(root, /^Cambia per tutti$/));
    await click(findButtonByLabel(root, /^Salta tutti: scelte già fatte sui conflitti visibili \(3\)/));
    const checkboxes = root.findAll((n: any) => n.type === 'input' && n.props.type === 'checkbox');
    assert.deepEqual(checkboxes.map((c: any) => c.props.checked), [false, false, false], 'tutti deselezionati dopo il "Cambia per tutti" su Salta tutti');
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 4) Messaggio di blocco all'importazione
// ---------------------------------------------------------------------------

test('blocco importazione: una riga con N, niente elenco di titoli, niente "Seleziona Pertinenti", N si aggiorna e sparisce a zero', async () => {
  const { renderer, state } = await renderResults([itemA, itemB]);
  const root = renderer.root;
  try {
    // Conflitti selezionati senza scelta: l'importazione si ferma.
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importCalled, false);
    assert.ok(textOf(root).includes('Restano 2 impegni da decidere'), 'contatore nel messaggio');
    // Nessun elenco di titoli nel messaggio.
    assert.equal(textOf(root).includes('Collegio Docenti ·'), false, 'nessun elenco dei titoli');
    assert.equal(textOf(root).includes('Consiglio di classe 1A ·'), false, 'nessun elenco dei titoli');
    // Il pulsante "Seleziona Pertinenti" non è pertinente al blocco.
    assert.equal(findButton(root, /Seleziona Pertinenti/), undefined, 'nessun "Seleziona Pertinenti" nel blocco');

    // Scelte singole: il messaggio aggiorna N e sparisce a zero.
    await click(cardChoiceButton(root, 'Collegio Docenti', 'Salta'));
    assert.ok(textOf(root).includes('Restano 1 impegni da decidere'), 'N aggiornato dopo la prima scelta');
    await click(cardChoiceButton(root, 'Dipartimento Matematica', 'Aggiorna'));
    assert.ok(!textOf(root).includes('Restano'), 'messaggio sparito a zero');

    // Riprova: ora importa (B aggiornato, A saltato e deselezionato).
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importCalled, true, 'importazione non più bloccata');
    assert.equal(state.importedUpdated.length, 1);
    assert.equal(state.importedUpdated[0].id, 'ev-dipartimento');
    assert.equal(state.importedUpdated[0].startTime, '15:00');
    assert.equal(state.closeCalled, true);
  } finally {
    renderer.unmount();
  }
});

test('blocco importazione: "Vai al prossimo" cambia i filtri, porta all\'elemento giusto e lo evidenzia', async () => {
  const { renderer, state } = await renderResults([itemA, itemB]);
  const root = renderer.root;
  try {
    // Filtro gennaio: A (ottobre) resta nascosto ma è comunque selezionato e non risolto.
    await click(findButton(root, /^Gen 2027/));
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.ok(textOf(root).includes('Restano 2'), 'il messaggio conta anche i nascosti dai filtri');

    // Primo "Vai al prossimo": porta i filtri sul mese di A e ne evidenzia la scheda.
    await click(root.findByProps({ id: 'btn-go-to-next-unresolved' }));
    assert.equal(findButton(root, /^Ott 2026/).props['aria-pressed'], true, 'filtro mese portato su ottobre');
    const highlighted1 = root.findAll((n: any) => n.props?.['data-conflict-highlight'] === 'true');
    assert.equal(highlighted1.length, 1, 'una sola scheda evidenziata');
    assert.equal(
      highlighted1[0].findAll((n: any) => n.type === 'input' && n.props.type === 'text' && n.props.value === 'Collegio Docenti').length,
      1,
      'evidenziata la scheda giusta'
    );
    assert.ok(textOf(highlighted1[0]).includes('15:00–16:30'), 'la scheda evidenziata è davvero visibile nell\'elenco');

    // Secondo clic: passa al successivo non risolto (B, gennaio).
    await click(root.findByProps({ id: 'btn-go-to-next-unresolved' }));
    assert.equal(findButton(root, /^Gen 2027/).props['aria-pressed'], true, 'filtro mese riportato su gennaio');
    const highlighted2 = root.findAll((n: any) => n.props?.['data-conflict-highlight'] === 'true');
    assert.equal(highlighted2.length, 1);
    assert.equal(
      highlighted2[0].findAll((n: any) => n.type === 'input' && n.props.type === 'text' && n.props.value === 'Dipartimento Matematica').length,
      1,
      'secondo elemento evidenziato'
    );
    assert.equal(state.importCalled, false, 'nessuna importazione automatica');
  } finally {
    renderer.unmount();
  }
});

test('blocco importazione: azioni rapide agiscono anche sugli elementi nascosti, senza avviare l\'importazione', async () => {
  const { renderer, state } = await renderResults([itemA, itemB]);
  const root = renderer.root;
  try {
    // Solo B visibile (gennaio 2027): A è nascosto dal filtro mese ma selezionato.
    await click(findButton(root, /^Gen 2027/));
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.ok(textOf(root).includes('Restano 2'), 'N conta anche i nascosti');

    // Azione rapida "Aggiorna tutti" per tutti gli N: anche A, nascosto dal filtro.
    await click(findButtonByLabel(root, /^Aggiorna tutti: impegni selezionati da decidere, anche se nascosti dai filtri \(2\)/));
    assert.ok(!textOf(root).includes('Restano'), 'messaggio sparito a zero');
    assert.equal(state.importCalled, false, 'nessun avvio automatico dell\'importazione');

    // Anche A (nascosto) ha ricevuto scelta e selezione.
    await click(findButton(root, /^Tutti i mesi/));
    assert.equal(isPressed(cardChoiceButton(root, 'Collegio Docenti', 'Aggiorna')), true, 'A risolto pur essendo stato nascosto');
    assert.equal(cardCheckbox(root, 'Collegio Docenti').props.checked, true);

    // "Annulla": il messaggio di blocco torna attivo con N=2.
    await click(findButtonByLabel(root, /^Annulla l'ultima azione in blocco/));
    assert.ok(textOf(root).includes('Restano 2'), 'blocco ripristinato dopo l\'annullamento');

    // L'utente preme di nuovo il pulsante di importazione: ora va a buon fine.
    await click(findButtonByLabel(root, /^Aggiorna tutti: impegni selezionati da decidere, anche se nascosti dai filtri \(2\)/));
    await click(root.findByProps({ id: 'btn-confirm-circular-import' }));
    assert.equal(state.importCalled, true, 'importazione non più bloccata dopo l\'azione in blocco');
    assert.equal(state.importedUpdated.length, 2, 'entrambi gli impegni aggiornati');
    assert.equal(state.closeCalled, true);
  } finally {
    renderer.unmount();
  }
});

// ---------------------------------------------------------------------------
// 5) + 6) Ritocco estetico e accessibilità
// ---------------------------------------------------------------------------

test('riga dei mesi senza barra di scorrimento; pulsanti con tocco >= 44px; annuncio aria-live dopo il blocco', async () => {
  const { renderer } = await renderResults([itemA, itemB, itemD]);
  const root = renderer.root;
  try {
    // La riga dei mesi nasconde la barra di scorrimento mantenendo lo scorrimento.
    const monthGroup = root.findAll((n: any) => n.props?.['aria-label'] === 'Filtra per mese')[0];
    assert.match(monthGroup.props.className, /no-scrollbar/, 'barra di scorrimento nascosta');
    assert.match(monthGroup.props.className, /overflow-x-auto/, 'lo scorrimento orizzontale resta attivo');

    // Pulsanti di azione in blocco con area di tocco >= 44px su mobile.
    const bulkUpdate = findButtonByLabel(root, /^Aggiorna tutti: conflitti visibili non risolti \(2\)/);
    assert.ok(bulkUpdate, 'pulsante in blocco presente');
    assert.match(bulkUpdate.props.className, /min-h-11/, 'area di tocco 44px');

    // Dopo l'azione: annuncio in regione aria-live e "Annulla" raggiungibile con etichetta esplicita.
    await click(bulkUpdate);
    const undo = findButtonByLabel(root, /^Annulla l'ultima azione in blocco/);
    assert.ok(undo, 'Annulla disponibile dopo l\'azione');
    assert.match(undo.props.className, /min-h-11/, 'area di tocco 44px per Annulla');
    const live = root.findAll((n: any) => n.props?.role === 'status' && n.props?.['aria-live'] === 'polite');
    assert.ok(live.some((n: any) => /applicato a 2 impegni/.test(textOf(n))), 'stato annunciato in aria-live');
    // Fuori dal blocco non esiste alcun "Vai al prossimo".
    assert.equal(findButton(root, /^Vai al prossimo$/), undefined);
  } finally {
    renderer.unmount();
  }
});
