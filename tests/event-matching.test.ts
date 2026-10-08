import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import {
  normalizeEventTitle,
  areCategoriesCompatible,
  areClassesCompatible,
  isTitleMatch,
  significantTitleWords,
  getEventFieldDiff,
  findPossibleEventUpdate,
  findEventMatch,
  assignDocumentMatches,
  describeEventDifferences,
  isIdenticalEventUpdate,
  resolveUpdatedField,
} from '../src/utils/eventMatching';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import { deriveFutureCommitments } from '../src/utils/futureCommitments';
import { storage, emptyInstallation } from '../src/services/storage';
import { database } from '../src/services/db';
import type { CalendarEvent, ExtractedItem, TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const legacyStorage = {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const profile: TeacherProfile = {
  id: 't-1',
  fullName: 'Docente Test',
  schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Matematica'],
  classes: ['1A', '2A'],
  campuses: ['Sede Centrale'],
  roles: [],
};

const makeExtractedItem = (overrides: Partial<ExtractedItem> = {}): ExtractedItem => ({
  tempId: 'temp-1',
  title: 'Collegio Docenti',
  category: 'collegio_docenti',
  date: '2026-10-15',
  relevance: 'VERDE',
  relevanceReason: 'Destinato a tutti i docenti.',
  selectedForImport: true,
  ...overrides,
});

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

// ---------------------------------------------------------------------------
// UNIT TEST: MATCHER & NORMALIZATION
// ---------------------------------------------------------------------------

test('1. Collegio Docenti stessa data, orario diverso -> possibile aggiornamento', () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-1',
    title: 'Collegio dei Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    startTime: '17:00',
    endTime: '18:00',
    isAllDay: false,
    sourceType: 'circolare',
  };

  const candidate: ExtractedItem = makeExtractedItem({
    tempId: 'temp-1',
    title: 'Convocazione Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    startTime: '15:00',
    endTime: '16:30',
    location: 'Sede Bonifazi',
    relevance: 'VERDE',
  });

  const match = findPossibleEventUpdate(candidate, [existingEvent]);
  assert.ok(match, 'Deve identificare il possibile aggiornamento');
  assert.equal(match.id, 'ev-1');

  const diff = getEventFieldDiff(existingEvent, candidate);
  assert.equal(diff.startTime, true, 'Orario inizio deve risultare modificato');
  assert.equal(diff.endTime, true, 'Orario fine deve risultare modificato');
  assert.equal(diff.location, true, 'Luogo deve risultare modificato');
  assert.equal(diff.date, false, 'Data è invariata');
});

test('2. Stesso titolo, data diversa -> NON aggiornamento', () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-1',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    isAllDay: false,
    sourceType: 'circolare',
  };

  const candidate: ExtractedItem = makeExtractedItem({
    tempId: 'temp-1',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-11-15',
    relevance: 'VERDE',
  });

  const match = findPossibleEventUpdate(candidate, [existingEvent]);
  assert.equal(match, null, 'Data diversa non deve mai corrispondere a un aggiornamento');
});

test('3. Stesso giorno ma titolo chiaramente diverso -> NON aggiornamento', () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-1',
    title: 'Lezione di Matematica 1A',
    category: 'lezione',
    date: '2026-10-15',
    isAllDay: false,
    sourceType: 'manuale',
  };

  const candidate: ExtractedItem = makeExtractedItem({
    tempId: 'temp-1',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    relevance: 'VERDE',
  });

  const match = findPossibleEventUpdate(candidate, [existingEvent]);
  assert.equal(match, null, 'Titoli e scopi chiaramente differenti non devono essere associati');
});

test('4. Categorie specifiche incompatibili -> NON aggiornamento', () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-1',
    title: 'Attività',
    category: 'lezione',
    date: '2026-10-15',
    isAllDay: false,
    sourceType: 'manuale',
  };

  const candidate: ExtractedItem = makeExtractedItem({
    tempId: 'temp-1',
    title: 'Attività',
    category: 'collegio_docenti',
    date: '2026-10-15',
    relevance: 'VERDE',
  });

  assert.equal(areCategoriesCompatible('lezione', 'collegio_docenti'), false);
  const match = findPossibleEventUpdate(candidate, [existingEvent]);
  assert.equal(match, null);
});

test('5. Consiglio 1A vs Consiglio 2A -> NON aggiornamento', () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-1',
    title: 'Consiglio di classe 1A',
    category: 'consiglio_classe',
    className: '1A',
    date: '2026-10-15',
    isAllDay: false,
    sourceType: 'circolare',
  };

  const candidate: ExtractedItem = makeExtractedItem({
    tempId: 'temp-1',
    title: 'Consiglio di classe 2A',
    category: 'consiglio_classe',
    className: '2A',
    date: '2026-10-15',
    relevance: 'VERDE',
  });

  assert.equal(areClassesCompatible('2A', '1A'), false);
  const match = findPossibleEventUpdate(candidate, [existingEvent]);
  assert.equal(match, null, 'Classi distinte non devono essere considerate lo stesso evento');
});

test('6. Stessa data/titolo ma sourceCircularId differente -> possibile aggiornamento', () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-circ-old123-temp0',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    startTime: '17:00',
    endTime: '18:00',
    isAllDay: false,
    sourceType: 'circolare',
    sourceCircularId: 'circ-old123',
    sourceCircularTitle: 'Circolare n. 10',
  };

  const candidate: ExtractedItem = makeExtractedItem({
    tempId: 'temp-new',
    title: 'Collegio dei Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    startTime: '15:00',
    endTime: '16:30',
    relevance: 'VERDE',
  });

  const match = findPossibleEventUpdate(candidate, [existingEvent]);
  assert.ok(match);
  assert.equal(match.id, 'ev-circ-old123-temp0');
});

test('7. Più candidati plausibili nello stesso giorno -> nessuna associazione automatica', () => {
  const existingEvents: CalendarEvent[] = [
    {
      id: 'ev-1',
      title: 'Consiglio di classe',
      category: 'consiglio_classe',
      date: '2026-10-15',
      isAllDay: false,
      sourceType: 'circolare',
    },
    {
      id: 'ev-2',
      title: 'Consiglio di classe',
      category: 'consiglio_classe',
      date: '2026-10-15',
      isAllDay: false,
      sourceType: 'circolare',
    },
  ];

  const candidate: ExtractedItem = makeExtractedItem({
    tempId: 'temp-1',
    title: 'Consiglio di classe',
    category: 'consiglio_classe',
    date: '2026-10-15',
    relevance: 'VERDE',
  });

  const match = findPossibleEventUpdate(candidate, existingEvents);
  assert.equal(match, null, 'In caso di ambiguità (più match plausibili), non forzare alcuna associazione');
});

// ---------------------------------------------------------------------------
// UI & INTEGRATION TEST IN CIRCULARANALYZERMODAL
// ---------------------------------------------------------------------------

test('8. UI: nessuna azione preselezionata alla comparsa di un possibile aggiornamento', async () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-exist-1',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    startTime: '17:00',
    endTime: '18:00',
    isAllDay: false,
    sourceType: 'circolare',
  };

  let renderer: any;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      success: true,
      source: 'server',
      items: [
        {
          title: 'Convocazione Collegio Docenti',
          category: 'collegio_docenti',
          date: '2026-10-15',
          startTime: '15:00',
          endTime: '16:30',
          location: 'Aula Magna',
          relevance: 'VERDE',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await act(async () => {
      renderer = create(
        React.createElement(CircularAnalyzerModal, {
          isOpen: true,
          onClose: () => {},
          profile,
          existingEvents: [existingEvent],
          onImportEvents: () => {},
          initialFile: null,
        })
      );
    });

    const textTabBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).toLowerCase().includes('incolla testo'))[0];
    await act(async () => { textTabBtn.props.onClick(); });

    const textarea = renderer.root.findByType('textarea');
    await act(async () => { textarea.props.onChange({ target: { value: '15/10/2026 Collegio Docenti 15:00-16:30' } }); });

    const runBtn = renderer.root.findByProps({ id: 'btn-run-analysis' });
    await act(async () => {
      runBtn.props.onClick();
      await new Promise(r => setTimeout(r, 100));
    });

    const text = flatText(renderer.root);
    // Scheda compatta: una riga di titolo e SOLO le differenze (orario e luogo).
    assert.ok(text.includes('Già in agenda con dati diversi'), 'riga di titolo della scheda');
    assert.equal(text.includes('Esistente in agenda'), false, 'niente riquadro a due colonne');
    assert.equal(text.includes('Dalla nuova circolare'), false, 'niente riquadro a due colonne');
    assert.ok(text.includes('Orario: 17:00–18:00 → 15:00–16:30'), 'differenza dell\'orario');
    assert.ok(text.includes('Luogo: — → Aula Magna'), 'differenza del luogo');

    // Verifica che nessuno dei 3 pulsanti sia evidenziato/preselezionato
    const updateBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Aggiorna')[0];
    const createBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Tieni entrambi')[0];
    const ignoreBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Salta')[0];

    assert.ok(!updateBtn.props.className.includes('bg-emerald-700'), 'Aggiorna non deve essere preselezionato');
    assert.ok(!createBtn.props.className.includes('bg-amber-600'), 'Tieni entrambi non deve essere preselezionato');
    assert.ok(!ignoreBtn.props.className.includes('bg-stone-700'), 'Salta non deve essere preselezionato');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('14. Senza scelta esplicita per un possibile aggiornamento: import bloccato da warning', async () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-exist-1',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    isAllDay: false,
    sourceType: 'circolare',
  };

  let imported = false;
  let renderer: any;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      success: true,
      source: 'server',
      items: [
        {
          title: 'Collegio Docenti',
          category: 'collegio_docenti',
          date: '2026-10-15',
          startTime: '15:00',
          endTime: '16:30',
          relevance: 'VERDE',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await act(async () => {
      renderer = create(
        React.createElement(CircularAnalyzerModal, {
          isOpen: true,
          onClose: () => {},
          profile,
          existingEvents: [existingEvent],
          onImportEvents: () => { imported = true; },
          initialFile: null,
        })
      );
    });

    const textTabBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).toLowerCase().includes('incolla testo'))[0];
    await act(async () => { textTabBtn.props.onClick(); });

    const textarea = renderer.root.findByType('textarea');
    await act(async () => { textarea.props.onChange({ target: { value: '15/10/2026 Collegio' } }); });

    const runBtn = renderer.root.findByProps({ id: 'btn-run-analysis' });
    await act(async () => {
      runBtn.props.onClick();
      await new Promise(r => setTimeout(r, 100));
    });

    // Clicca conferma senza aver scelto (Aggiorna / Nuovo / Ignora)
    const confirmBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).includes("all'Agenda"))[0];
    assert.ok(confirmBtn, 'Pulsante conferma importazione deve essere presente');
    await act(async () => { confirmBtn.props.onClick(); });

    assert.equal(imported, false, 'Non deve importare finché la scelta non è esplicita');
    const warningText = flatText(renderer.root);
    assert.ok(warningText.includes('Restano 1 impegni da decidere'), 'Messaggio di avviso visibile');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('9, 10, 11. "Aggiorna esistente": preserva ID, googleEventId, metadati e aggiorna orari/luogo', async () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-orig-12345',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    startTime: '17:00',
    endTime: '18:00',
    isAllDay: false,
    sourceType: 'circolare',
    sourceCircularId: 'circ-initial-1',
    sourceCircularTitle: 'Circolare n. 1',
    googleEventId: 'google-cal-event-999',
    syncedWithGoogle: true,
    schoolId: 'school-main',
    reminderMinutesBefore: 30,
    completed: true,
  };

  let importedNew: CalendarEvent[] = [];
  let importedUpdated: CalendarEvent[] = [];
  let renderer: any;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      success: true,
      source: 'server',
      items: [
        {
          title: 'Collegio dei Docenti',
          category: 'collegio_docenti',
          date: '2026-10-15',
          startTime: '15:00',
          endTime: '16:30',
          location: 'Nuova Sede Bonifazi',
          notes: 'Ordine del giorno aggiornato',
          relevance: 'VERDE',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await act(async () => {
      renderer = create(
        React.createElement(CircularAnalyzerModal, {
          isOpen: true,
          onClose: () => {},
          profile,
          existingEvents: [existingEvent],
          onImportEvents: (newEvents, _docMeta, updatedEvents) => {
            importedNew = newEvents;
            importedUpdated = updatedEvents || [];
          },
          initialFile: null,
        })
      );
    });

    const textTabBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).toLowerCase().includes('incolla testo'))[0];
    await act(async () => { textTabBtn.props.onClick(); });

    const textarea = renderer.root.findByType('textarea');
    await act(async () => { textarea.props.onChange({ target: { value: '15/10/2026 Collegio' } }); });

    const runBtn = renderer.root.findByProps({ id: 'btn-run-analysis' });
    await act(async () => {
      runBtn.props.onClick();
      await new Promise(r => setTimeout(r, 100));
    });

    // Scegli "Aggiorna"
    const updateBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Aggiorna')[0];
    assert.ok(updateBtn, 'Pulsante Aggiorna presente');
    await act(async () => { updateBtn.props.onClick(); });

    // Conferma importazione
    const confirmBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).includes("all'Agenda"))[0];
    await act(async () => { confirmBtn.props.onClick(); });

    assert.equal(importedNew.length, 0, 'Nessun nuovo evento duplicato creato');
    assert.equal(importedUpdated.length, 1, 'Esattamente un evento aggiornato');

    const updated = importedUpdated[0];
    // 9. Preserva ID originale
    assert.equal(updated.id, 'ev-orig-12345');

    // 10. Preserva googleEventId e metadati tecnici, riattiva completed
    assert.equal(updated.googleEventId, 'google-cal-event-999');
    assert.equal(updated.syncedWithGoogle, true);
    assert.equal(updated.schoolId, 'school-main');
    assert.equal(updated.reminderMinutesBefore, 30);
    assert.equal(updated.completed, false);
    assert.equal(updated.sourceCircularId, 'circ-initial-1', 'Preserva provenienza circolare originaria');

    // 11. Aggiorna orari, luogo e note
    assert.equal(updated.startTime, '15:00');
    assert.equal(updated.endTime, '16:30');
    assert.equal(updated.location, 'Nuova Sede Bonifazi');
    assert.equal(updated.notes, 'Ordine del giorno aggiornato');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('12. "Aggiungi come nuovo": crea un secondo evento distinto', async () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-exist-1',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    startTime: '17:00',
    endTime: '18:00',
    isAllDay: false,
    sourceType: 'circolare',
  };

  let importedNew: CalendarEvent[] = [];
  let importedUpdated: CalendarEvent[] = [];
  let renderer: any;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      success: true,
      source: 'server',
      items: [
        {
          title: 'Collegio Docenti Straordinario',
          category: 'collegio_docenti',
          date: '2026-10-15',
          startTime: '15:00',
          endTime: '16:30',
          relevance: 'VERDE',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await act(async () => {
      renderer = create(
        React.createElement(CircularAnalyzerModal, {
          isOpen: true,
          onClose: () => {},
          profile,
          existingEvents: [existingEvent],
          onImportEvents: (newEvents, _docMeta, updatedEvents) => {
            importedNew = newEvents;
            importedUpdated = updatedEvents || [];
          },
          initialFile: null,
        })
      );
    });

    const textTabBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).toLowerCase().includes('incolla testo'))[0];
    await act(async () => { textTabBtn.props.onClick(); });

    const textarea = renderer.root.findByType('textarea');
    await act(async () => { textarea.props.onChange({ target: { value: '15/10/2026 Collegio' } }); });

    const runBtn = renderer.root.findByProps({ id: 'btn-run-analysis' });
    await act(async () => {
      runBtn.props.onClick();
      await new Promise(r => setTimeout(r, 100));
    });

    // Scegli "Tieni entrambi"
    const createBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Tieni entrambi')[0];
    assert.ok(createBtn, 'Pulsante Tieni entrambi presente');
    await act(async () => { createBtn.props.onClick(); });

    // Conferma importazione
    const confirmBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).includes("all'Agenda"))[0];
    await act(async () => { confirmBtn.props.onClick(); });

    assert.equal(importedUpdated.length, 0, 'Nessun evento esistente modificato');
    assert.equal(importedNew.length, 1, 'Esattamente un nuovo evento creato');
    assert.notEqual(importedNew[0].id, 'ev-exist-1', 'Il nuovo evento ha un ID proprio distinto');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('13. "Salta": non crea né aggiorna nulla, deseleziona l\'impegno (nuova semantica), nessun import', async () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-exist-1',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    startTime: '17:00',
    endTime: '18:00',
    isAllDay: false,
    sourceType: 'circolare',
  };

  let importedNew: CalendarEvent[] = [];
  let importedUpdated: CalendarEvent[] = [];
  let importCalled = false;
  let closeCalled = false;
  let renderer: any;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      success: true,
      source: 'server',
      items: [
        {
          title: 'Collegio Docenti',
          category: 'collegio_docenti',
          date: '2026-10-15',
          startTime: '15:00',
          endTime: '16:30',
          relevance: 'VERDE',
          selectedForImport: true,
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await act(async () => {
      renderer = create(
        React.createElement(CircularAnalyzerModal, {
          isOpen: true,
          onClose: () => { closeCalled = true; },
          profile,
          existingEvents: [existingEvent],
          onImportEvents: (newEvents, _docMeta, updatedEvents) => {
            importCalled = true;
            importedNew = newEvents;
            importedUpdated = updatedEvents || [];
          },
          initialFile: null,
        })
      );
    });

    const textTabBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).toLowerCase().includes('incolla testo'))[0];
    await act(async () => { textTabBtn.props.onClick(); });

    const textarea = renderer.root.findByType('textarea');
    await act(async () => { textarea.props.onChange({ target: { value: '15/10/2026 Collegio 15:00-16:30' } }); });

    const runBtn = renderer.root.findByProps({ id: 'btn-run-analysis' });
    await act(async () => {
      runBtn.props.onClick();
      await new Promise(r => setTimeout(r, 100));
    });

    // Scegli "Salta" (pulsante della scheda: quelli in blocco non hanno aria-pressed)
    const ignoreBtn = renderer.root.findAll(
      (el: any) => el.type === 'button' && flatText(el) === 'Salta' && el.props['aria-pressed'] !== undefined
    )[0];
    assert.ok(ignoreBtn, 'Pulsante Salta presente');
    await act(async () => { ignoreBtn.props.onClick(); });

    // La scelta implica la deselezione: nessun impegno selezionato, pulsante di
    // conferma disabilitato e nessuna importazione possibile.
    const checkbox = renderer.root.findAll((el: any) => el.type === 'input' && el.props.type === 'checkbox')[0];
    assert.equal(checkbox.props.checked, false, '"Ignora" deve deselezionare l\'impegno');
    assert.ok(ignoreBtn.props.className.includes('bg-stone-700'), 'Scelta "Salta" evidenziata sulla scheda');

    const confirmBtn = renderer.root.findByProps({ id: 'btn-confirm-circular-import' });
    assert.ok(confirmBtn, 'Pulsante conferma importazione presente');
    assert.equal(flatText(confirmBtn), "Aggiungi 0 selezionati all'Agenda");
    assert.equal(confirmBtn.props.disabled, true, 'Con zero selezionati la conferma è disabilitata');

    // Nessun evento importato o aggiornato, onImportEvents non chiamato, nessun
    // blocco sui conflitti: la scelta c'è già.
    assert.equal(importCalled, false, 'onImportEvents NON deve essere chiamato');
    assert.equal(importedNew.length, 0);
    assert.equal(importedUpdated.length, 0);
    assert.equal(closeCalled, false);

    const warningText = flatText(renderer.root);
    assert.ok(!warningText.includes('Restano'), 'Nessun messaggio di blocco: la scelta è stata fatta');
    assert.ok(!warningText.includes('Effettua una scelta'), 'Nessun avviso di scelta mancante');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('15. Import misto: nuovo + aggiornato + ignorato persistiti correttamente in storage', async () => {
  database.close();
  await database.delete();
  await database.initialize(emptyInstallation(), legacyStorage);

  const existing1: CalendarEvent = {
    id: 'ev-exist-collegio',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    startTime: '17:00',
    endTime: '18:00',
    isAllDay: false,
    sourceType: 'circolare',
    googleEventId: 'gid-123',
  };

  const existing2: CalendarEvent = {
    id: 'ev-exist-dipartimento',
    title: 'Dipartimento Matematica',
    category: 'dipartimento',
    date: '2026-10-20',
    startTime: '16:00',
    endTime: '17:00',
    isAllDay: false,
    sourceType: 'circolare',
  };

  // Salva eventi iniziali nello storage
  await database.atomic(async () => {
    await storage.saveEvents([existing1, existing2]);
  });

  const toUpdate: CalendarEvent = {
    ...existing1,
    startTime: '15:00',
    endTime: '16:30',
    location: 'Aula Magna',
  };

  const toAdd: CalendarEvent = {
    id: 'ev-brand-new',
    title: 'Consiglio di Classe 3D',
    category: 'consiglio_classe',
    className: '3D',
    date: '2026-10-25',
    startTime: '16:30',
    endTime: '17:30',
    isAllDay: false,
    sourceType: 'circolare',
  };

  const result = await storage.importCircularEvents([toAdd], [toUpdate]);
  assert.equal(result.added, 1, '1 evento aggiunto');
  assert.equal(result.updated, 1, '1 evento aggiornato');

  const allEvents = await storage.getEvents();
  assert.equal(allEvents.length, 3, 'Totale 3 eventi in archivio');

  const collegio = allEvents.find(e => e.id === 'ev-exist-collegio')!;
  assert.equal(collegio.startTime, '15:00');
  assert.equal(collegio.endTime, '16:30');
  assert.equal(collegio.location, 'Aula Magna');
  assert.equal(collegio.googleEventId, 'gid-123');

  const dipartimento = allEvents.find(e => e.id === 'ev-exist-dipartimento')!;
  assert.equal(dipartimento.startTime, '16:00', 'Dipartimento invariato');

  const consiglio = allEvents.find(e => e.id === 'ev-brand-new')!;
  assert.equal(consiglio.className, '3D');
});

test('16. Circolare multi-impegno: update + create + ignore -> salva gli altri due, salta ignore e chiude', async () => {
  const existingCollegio: CalendarEvent = {
    id: 'ev-collegio-old',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
    startTime: '17:00',
    endTime: '18:00',
    isAllDay: false,
    sourceType: 'circolare',
  };

  const existingConsiglio: CalendarEvent = {
    id: 'ev-consiglio-old',
    title: 'Consiglio di Classe 1A',
    category: 'consiglio_classe',
    className: '1A',
    date: '2026-10-20',
    startTime: '16:00',
    endTime: '17:00',
    isAllDay: false,
    sourceType: 'circolare',
  };

  let importedNew: CalendarEvent[] = [];
  let importedUpdated: CalendarEvent[] = [];
  let closeCalled = false;
  let renderer: any;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      success: true,
      source: 'server',
      items: [
        {
          title: 'Collegio Docenti',
          category: 'collegio_docenti',
          date: '2026-10-15',
          startTime: '15:00',
          endTime: '16:30',
          relevance: 'VERDE',
        },
        {
          title: 'Formazione Docenti Privacy',
          category: 'formazione',
          date: '2026-10-18',
          startTime: '16:00',
          endTime: '18:00',
          relevance: 'VERDE',
        },
        {
          title: 'Consiglio di Classe 1A',
          category: 'consiglio_classe',
          className: '1A',
          date: '2026-10-20',
          startTime: '16:00',
          endTime: '17:00',
          relevance: 'VERDE',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await act(async () => {
      renderer = create(
        React.createElement(CircularAnalyzerModal, {
          isOpen: true,
          onClose: () => { closeCalled = true; },
          profile,
          existingEvents: [existingCollegio, existingConsiglio],
          onImportEvents: (newEvents, _docMeta, updatedEvents) => {
            importedNew = newEvents;
            importedUpdated = updatedEvents || [];
          },
          initialFile: null,
        })
      );
    });

    const textTabBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).toLowerCase().includes('incolla testo'))[0];
    await act(async () => { textTabBtn.props.onClick(); });

    const textarea = renderer.root.findByType('textarea');
    await act(async () => { textarea.props.onChange({ target: { value: '15/10 Collegio, 18/10 Formazione, 20/10 Consiglio 1A' } }); });

    const runBtn = renderer.root.findByProps({ id: 'btn-run-analysis' });
    await act(async () => {
      runBtn.props.onClick();
      await new Promise(r => setTimeout(r, 100));
    });

    // 1. Collegio -> scegli "Aggiorna" (pulsante della scheda)
    const updateBtns = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Aggiorna');
    assert.ok(updateBtns.length >= 1, 'Pulsante Aggiorna presente per Collegio');
    await act(async () => { updateBtns[0].props.onClick(); });

    // 2. Consiglio 1A è identico all'impegno già in agenda: la nuova gestione lo
    //    salta (deselezionato) e lo toglie dall'elenco, riassumendolo in una riga.
    assert.ok(flatText(renderer.root).includes('1 già in agenda, saltati'), 'riga riassuntiva dell\'identico');
    assert.equal(
      renderer.root.findAll((el: any) => el.type === 'input' && el.props.type === 'text' && el.props.value === 'Consiglio di Classe 1A').length,
      0,
      'Conflitto identico fuori dall\'elenco, senza clic manuale'
    );
    const checkboxes = renderer.root.findAll((el: any) => el.type === 'input' && el.props.type === 'checkbox');
    assert.equal(checkboxes.length, 2, 'in elenco restano Collegio e Formazione');

    // Seleziona tutti (i visibili) per includere anche Formazione
    const selectAllBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Tutti')[0];
    await act(async () => { selectAllBtn.props.onClick(); });

    const confirmBtn = renderer.root.findByProps({ id: 'btn-confirm-circular-import' });
    assert.equal(flatText(confirmBtn), "Aggiungi 2 selezionati all'Agenda");

    // Conferma importazione
    await act(async () => { confirmBtn.props.onClick(); });

    assert.equal(importedUpdated.length, 1, '1 evento aggiornato (Collegio)');
    assert.equal(importedUpdated[0].id, 'ev-collegio-old');
    assert.equal(importedUpdated[0].startTime, '15:00');

    assert.equal(importedNew.length, 1, '1 nuovo evento creato (Formazione)');
    assert.equal(importedNew[0].title, 'Formazione Docenti Privacy');

    assert.equal(closeCalled, true, 'Modale chiusa con successo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('17. Regressione Prisma: evento circolare con completed:true viene riattivato (completed:false) all\'aggiornamento ed incluso in deriveFutureCommitments', async () => {
  const existing: CalendarEvent = {
    id: 'existing-prisma',
    title: 'Svolgimento Giochi Matematici di Prisma',
    category: 'promemoria',
    date: '2026-11-26',
    isAllDay: true,
    sourceType: 'circolare',
    completed: true,
  };

  let importedNew: CalendarEvent[] = [];
  let importedUpdated: CalendarEvent[] = [];
  let renderer: any;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      success: true,
      source: 'server',
      items: [
        {
          title: 'Svolgimento Giochi Matematici di Prisma',
          category: 'promemoria',
          subject: 'Matematica',
          date: '2026-11-26',
          relevance: 'VERDE',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await act(async () => {
      renderer = create(
        React.createElement(CircularAnalyzerModal, {
          isOpen: true,
          onClose: () => {},
          profile,
          existingEvents: [existing],
          onImportEvents: (newEvents, _docMeta, updatedEvents) => {
            importedNew = newEvents;
            importedUpdated = updatedEvents || [];
          },
          initialFile: null,
        })
      );
    });

    const textTabBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).toLowerCase().includes('incolla testo'))[0];
    await act(async () => { textTabBtn.props.onClick(); });

    const textarea = renderer.root.findByType('textarea');
    await act(async () => { textarea.props.onChange({ target: { value: '26/11/2026 Svolgimento Giochi Matematici di Prisma' } }); });

    const runBtn = renderer.root.findByProps({ id: 'btn-run-analysis' });
    await act(async () => {
      runBtn.props.onClick();
      await new Promise(r => setTimeout(r, 100));
    });

    // La materia nuova verrebbe scritta sul CalendarEvent: la differenza è
    // mostrata e la riga non viene saltata come identica.
    assert.doesNotMatch(flatText(renderer.root), /già in agenda, saltati/);
    assert.match(flatText(renderer.root), /Materia: — → Matematica/);
    assert.match(flatText(renderer.root), /Stato: Completato → Da fare/, 'Aggiorna riattiva un evento completato');

    // Scegli "Aggiorna"
    const updateBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Aggiorna')[0];
    assert.ok(updateBtn, 'Pulsante Aggiorna presente');
    await act(async () => { updateBtn.props.onClick(); });

    // Conferma importazione
    const confirmBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).includes("all'Agenda"))[0];
    await act(async () => { confirmBtn.props.onClick(); });

    assert.equal(importedNew.length, 0, 'Nessun nuovo evento duplicato creato');
    assert.equal(importedUpdated.length, 1, 'Esattamente un evento aggiornato');

    const updated = importedUpdated[0];
    assert.equal(updated.id, 'existing-prisma');
    assert.equal(updated.completed, false, 'Stato completed reimpostato a false');
    assert.equal(updated.sourceType, 'circolare');

    // deriveFutureCommitments deve includere l'evento riattivato
    const futureItems = deriveFutureCommitments({
      events: [updated],
      scheduledAssessments: [],
      students: [],
      todayIso: '2026-10-01',
    });
    assert.equal(futureItems.length, 1);
    assert.equal(futureItems[0].id, 'event:existing-prisma');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// RICONOSCIMENTO: DOPPIONE DA CIRCOLARE (singolare/plurale) E CRITERIO DELL'ORARIO
// ---------------------------------------------------------------------------

/** Impegno in agenda riconoscibile: data, orario e categoria confrontabili. */
const makeExisting = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'ev-1',
  title: 'Impegno',
  category: 'riunione',
  date: '2026-10-12',
  startTime: '15:00',
  endTime: '15:45',
  isAllDay: false,
  sourceType: 'manuale',
  ...overrides,
});

test('18. Caso riprodotto: "Consigli di Classe" riconosce "Consiglio di Classe 3D" per titolo', () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-consiglio-3d',
    title: 'Consiglio di Classe 3D',
    category: 'consiglio_classe',
    className: '3D',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '15:45',
    isAllDay: false,
    sourceType: 'circolare',
  };

  const candidate: ExtractedItem = makeExtractedItem({
    tempId: 'temp-consigli',
    title: 'Consigli di Classe',
    category: 'consiglio_classe',
    className: '3D',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '15:45',
  });

  // La sigla di classe non entra nel confronto dei titoli e le parole vanno alla radice.
  assert.deepEqual(significantTitleWords(existingEvent.title), ['consigl', 'class']);
  assert.deepEqual(significantTitleWords(candidate.title), ['consigl', 'class']);
  assert.equal(isTitleMatch(candidate.title, existingEvent.title), true, 'singolare/plurale devono coincidere');

  const match = findEventMatch(candidate, [existingEvent]);
  assert.ok(match, 'Deve riconoscere l\'impegno già in agenda');
  assert.equal(match.kind, 'titolo', 'Riconoscimento per titolo (possibile aggiornamento)');
  assert.equal(match.event.id, 'ev-consiglio-3d');
  assert.equal(findPossibleEventUpdate(candidate, [existingEvent])?.id, 'ev-consiglio-3d');
});

test('19. Classi diverse (3D in agenda, 1C dalla circolare): solo sovrapposizione', () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-consiglio-3d',
    title: 'Consiglio di Classe 3D',
    category: 'consiglio_classe',
    className: '3D',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '15:45',
    isAllDay: false,
    sourceType: 'circolare',
  };

  const candidate: ExtractedItem = makeExtractedItem({
    tempId: 'temp-consigli-1c',
    title: 'Consigli di Classe 1C',
    category: 'consiglio_classe',
    className: '1C',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '15:45',
  });

  assert.equal(findPossibleEventUpdate(candidate, [existingEvent]), null, 'Nessun aggiornamento per titolo');
  assert.deepEqual(findEventMatch(candidate, [existingEvent]), { event: existingEvent, kind: 'sovrapposizione', others: 0 }, 'Classe diversa: avviso, non possibile aggiornamento');
});

test('20. "Consiglio di Classe" vs "Consiglio di Istituto": nessuna corrispondenza per titolo', () => {
  assert.equal(isTitleMatch('Consiglio di Classe', 'Consiglio di Istituto'), false);
  assert.equal(isTitleMatch('Consiglio di Istituto', 'Consiglio di Classe'), false);

  // Senza orari (nessuna sovrapposizione possibile) non resta alcun riconoscimento.
  const existingEvent: CalendarEvent = {
    id: 'ev-istituto',
    title: 'Consiglio di Istituto',
    category: 'consiglio_classe',
    date: '2026-10-12',
    isAllDay: false,
    sourceType: 'manuale',
  };
  const candidate: ExtractedItem = makeExtractedItem({
    tempId: 'temp-classe',
    title: 'Consiglio di Classe',
    category: 'consiglio_classe',
    date: '2026-10-12',
  });

  assert.equal(findPossibleEventUpdate(candidate, [existingEvent]), null);
  assert.equal(findEventMatch(candidate, [existingEvent]), null);
});

test('21. Spareggio per titolo fra più candidati: stesso inizio+fine, poi stesso inizio', () => {
  const e1 = makeExisting({ id: 'ev-17', title: 'Collegio Docenti', category: 'collegio_docenti', startTime: '17:00', endTime: '18:00' });
  const e2 = makeExisting({ id: 'ev-15', title: 'Collegio Docenti', category: 'collegio_docenti', startTime: '15:00', endTime: '16:30' });
  const e3 = makeExisting({ id: 'ev-1530', title: 'Collegio Docenti', category: 'collegio_docenti', startTime: '15:30', endTime: '16:00' });

  // Stesso inizio+fine del nuovo.
  assert.equal(
    findPossibleEventUpdate(
      makeExtractedItem({ tempId: 't1', title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-12', startTime: '15:00', endTime: '16:30' }),
      [e1, e2]
    )?.id,
    'ev-15'
  );

  // Nessuno con inizio+fine identici: vince lo stesso inizio.
  assert.equal(
    findPossibleEventUpdate(
      makeExtractedItem({ tempId: 't2', title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-12', startTime: '15:00', endTime: '16:00' }),
      [e1, e2, e3]
    )?.id,
    'ev-15'
  );

  // Nessuno con lo stesso inizio: resta l'ambiguità, nessuna associazione.
  assert.equal(
    findPossibleEventUpdate(
      makeExtractedItem({ tempId: 't3', title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-12', startTime: '14:00', endTime: '15:00' }),
      [e1, e2, e3]
    ),
    null
  );

  // Senza orario nel nuovo non c'è spareggio: resta l'ambiguità.
  assert.equal(
    findPossibleEventUpdate(
      makeExtractedItem({ tempId: 't4', title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-12' }),
      [e1, e2]
    ),
    null
  );
});

test('22. Titoli diversi ma stesso giorno e orario sovrapposto: riconoscimento per orario', () => {
  const existingEvent = makeExisting({
    id: 'ev-dirigente',
    title: 'Incontro con il Dirigente',
    category: 'riunione',
    startTime: '15:00',
    endTime: '15:45',
  });

  const candidate = makeExtractedItem({
    tempId: 'temp-colloquio',
    title: 'Colloquio col Dirigente',
    category: 'riunione',
    date: '2026-10-12',
    startTime: '15:15',
    endTime: '15:40',
  });

  assert.equal(findPossibleEventUpdate(candidate, [existingEvent]), null, 'Il titolo non corrisponde');

  const match = findEventMatch(candidate, [existingEvent]);
  assert.ok(match, 'Deve segnalare l\'impegno già in agenda alla stessa ora');
  assert.equal(match.kind, 'orario');
  assert.equal(match.event.id, 'ev-dirigente');
  assert.equal(match.others, 0);
});

test('23. Orari contigui (15:00-15:45 e 15:45-16:30): nessun riconoscimento per orario', () => {
  const events = [
    makeExisting({ id: 'ev-prima', title: 'Incontro con il Dirigente', startTime: '15:00', endTime: '15:45' }),
    makeExisting({ id: 'ev-dopo', title: 'Altro impegno', startTime: '16:30', endTime: '17:30' }),
  ];

  // 15:45-16:30 è contiguo al primo e non tocca il secondo.
  const inMezzo = makeExtractedItem({
    tempId: 'temp-mezzo',
    title: 'Colloquio col Dirigente',
    category: 'riunione',
    date: '2026-10-12',
    startTime: '15:45',
    endTime: '16:30',
  });
  assert.equal(findEventMatch(inMezzo, events), null);

  // 16:20-17:00 si sovrappone solo al secondo.
  const sulSecondo = makeExtractedItem({
    tempId: 'temp-secondo',
    title: 'Colloquio col Dirigente',
    category: 'riunione',
    date: '2026-10-12',
    startTime: '16:20',
    endTime: '17:00',
  });
  const match = findEventMatch(sulSecondo, events);
  assert.equal(match?.kind, 'orario');
  assert.equal(match?.event.id, 'ev-dopo');
});

test('24. Nuovo con il solo orario di inizio: uguaglianza o inizio compreso nell\'intervallo', () => {
  const existingEvent = makeExisting({ id: 'ev-dirigente', title: 'Incontro con il Dirigente', startTime: '15:00', endTime: '15:45' });

  const dentro = makeExtractedItem({
    tempId: 't1', title: 'Colloquio col Dirigente', category: 'riunione', date: '2026-10-12', startTime: '15:10',
  });
  assert.equal(findEventMatch(dentro, [existingEvent])?.kind, 'orario', 'inizio compreso nell\'intervallo esistente');

  const uguale = makeExtractedItem({
    tempId: 't2', title: 'Colloquio col Dirigente', category: 'riunione', date: '2026-10-12', startTime: '15:00',
  });
  assert.equal(findEventMatch(uguale, [existingEvent])?.kind, 'orario', 'stessa ora di inizio');

  const fuori = makeExtractedItem({
    tempId: 't3', title: 'Colloquio col Dirigente', category: 'riunione', date: '2026-10-12', startTime: '15:50',
  });
  assert.equal(findEventMatch(fuori, [existingEvent]), null, 'dopo la fine non c\'è sovrapposizione');
});

test('25. Lezioni, scadenze, tutto il giorno e senza orario restano fuori dal confronto', () => {
  const candidate = makeExtractedItem({
    tempId: 'temp-x', title: 'Colloquio col Dirigente', category: 'riunione', date: '2026-10-12',
    startTime: '15:15', endTime: '15:40',
  });

  // Lezione dell'orario (CalendarEvent con categoria "lezione"): esclusa.
  const lezione = makeExisting({ id: 'ev-lezione', title: 'Matematica 3D', category: 'lezione', startTime: '15:00', endTime: '15:45' });
  assert.equal(findEventMatch(candidate, [lezione]), null, 'la lezione non entra nel confronto');

  // Impegno tutto il giorno: escluso.
  const allDay = makeExisting({ id: 'ev-allday', title: 'Altro', isAllDay: true, startTime: undefined, endTime: undefined });
  assert.equal(findEventMatch(candidate, [allDay]), null);

  // Impegno senza orario: escluso.
  const senzaOrario = makeExisting({ id: 'ev-senza', title: 'Altro', startTime: undefined, endTime: undefined });
  assert.equal(findEventMatch(candidate, [senzaOrario]), null);

  // Scadenza: esclusa.
  const scadenza = makeExisting({ id: 'ev-scadenza', title: 'Consegna documenti', category: 'scadenza', startTime: '15:00', endTime: '15:45' });
  assert.equal(findEventMatch(candidate, [scadenza]), null);

  // Nuovo senza orario: nessun confronto possibile.
  const senzaOrarioCandidate = makeExtractedItem({
    tempId: 'temp-y', title: 'Colloquio col Dirigente', category: 'riunione', date: '2026-10-12',
  });
  assert.equal(findEventMatch(senzaOrarioCandidate, [makeExisting({ id: 'ev-dirigente', title: 'Incontro con il Dirigente' })]), null);

  // Nuovo che è una scadenza: nessun confronto sugli orari.
  const scadenzaCandidate = makeExtractedItem({
    tempId: 'temp-z', title: 'Consegna registro', category: 'riunione', date: '2026-10-12',
    startTime: '15:15', endTime: '15:40', isDeadline: true,
  });
  assert.equal(findEventMatch(scadenzaCandidate, [makeExisting({ id: 'ev-dirigente', title: 'Incontro con il Dirigente' })]), null);
});

test('26. Più impegni sovrapposti: scelto il migliore e contati gli altri', () => {
  const events = [
    makeExisting({ id: 'ev-parziale', title: 'Incontro parziale', startTime: '15:30', endTime: '16:30' }),
    makeExisting({ id: 'ev-uguale', title: 'Incontro uguale', startTime: '15:15', endTime: '15:40' }),
    makeExisting({ id: 'ev-lungo', title: 'Incontro lungo', startTime: '15:00', endTime: '16:00' }),
  ];

  const candidate = makeExtractedItem({
    tempId: 'temp-overlap', title: 'Colloquio col Dirigente', category: 'riunione', date: '2026-10-12',
    startTime: '15:15', endTime: '15:40',
  });

  const match = findEventMatch(candidate, events);
  assert.ok(match);
  assert.equal(match.kind, 'orario');
  assert.equal(match.event.id, 'ev-uguale', 'vince lo stesso inizio+fine');
  assert.equal(match.others, 2, 'gli altri due restano segnalati nel conteggio');

  // Senza corrispondenza esatta di inizio+fine vince lo stesso inizio.
  const candidate2 = makeExtractedItem({
    tempId: 'temp-overlap-2', title: 'Colloquio col Dirigente', category: 'riunione', date: '2026-10-12',
    startTime: '15:00', endTime: '15:45',
  });
  const match2 = findEventMatch(candidate2, [
    makeExisting({ id: 'ev-a', title: 'A', startTime: '15:00', endTime: '18:00' }),
    makeExisting({ id: 'ev-b', title: 'B', startTime: '15:20', endTime: '15:30' }),
  ]);
  assert.equal(match2?.event.id, 'ev-a', 'stesso inizio batte la sovrapposizione più corta');
  assert.equal(match2?.others, 1);

  // A parità di inizio e fine diversa vince la sovrapposizione più lunga.
  const match3 = findEventMatch(
    makeExtractedItem({
      tempId: 'temp-overlap-3', title: 'Colloquio col Dirigente', category: 'riunione', date: '2026-10-12',
      startTime: '15:20', endTime: '16:00',
    }),
    [
      makeExisting({ id: 'ev-breve', title: 'Breve', startTime: '15:30', endTime: '15:35' }),
      makeExisting({ id: 'ev-ampio', title: 'Ampio', startTime: '15:40', endTime: '17:00' }),
    ]
  );
  assert.equal(match3?.event.id, 'ev-ampio', 'sovrapposizione più lunga (20 min contro 5)');
  assert.equal(match3?.others, 1);
});

test('27. Il criterio del titolo ha la precedenza su quello dell\'orario', () => {
  const events = [
    makeExisting({ id: 'ev-altro', title: 'Incontro con il Dirigente', startTime: '15:00', endTime: '15:45' }),
    makeExisting({ id: 'ev-titolo', title: 'Colloquio col Dirigente', startTime: '15:10', endTime: '15:20' }),
  ];

  const candidate = makeExtractedItem({
    tempId: 'temp-prec', title: 'Colloquio col Dirigente', category: 'riunione', date: '2026-10-12',
    startTime: '15:05', endTime: '15:50',
  });

  const match = findEventMatch(candidate, events);
  assert.ok(match);
  assert.equal(match.kind, 'titolo');
  assert.equal(match.event.id, 'ev-titolo', 'anche se l\'altro si sovrappone di più');
});

test('sovrapposizione: tre casi riprodotti e classi diverse', () => {
  const events = [
    makeExisting({ id: 'cdc', title: 'Consiglio di Classe 3D', category: 'consiglio_classe', className: '3D', startTime: '15:00', endTime: '15:45' }),
    makeExisting({ id: 'pei', title: 'meet pei', category: 'pei', className: '3E', startTime: '17:30', endTime: '18:30' }),
  ];
  for (const [title, category, className, startTime, endTime, id] of [
    ['GLO alunno', 'glo', '3D', '15:00', '16:00', 'cdc'],
    ['Consigli di Classe', 'consiglio_classe', '3E', '17:30', '18:15', 'pei'],
    ['Collegio Docenti', 'collegio_docenti', undefined, '15:00', '17:00', 'cdc'],
    ['Consiglio di Classe 1C', 'consiglio_classe', '1C', '15:00', '16:00', 'cdc'],
  ] as const) {
    const match = findEventMatch({ title, category, className, date: '2026-10-12', startTime, endTime }, events);
    assert.equal(match?.kind, 'sovrapposizione');
    assert.equal(match?.event.id, id);
    assert.equal(match?.others, 0);
  }
});

test('precedenza titolo > orario > sovrapposizione e spareggio', () => {
  const candidate = { title: 'GLO alunno', category: 'glo' as const, date: '2026-10-12', startTime: '15:00', endTime: '16:00' };
  const overlap = makeExisting({ id: 'overlap', title: 'Altro', category: 'pei', startTime: '15:00', endTime: '16:00' });
  const time = makeExisting({ id: 'time', title: 'Riunione diversa', category: 'glo', startTime: '15:30', endTime: '16:30' });
  const title = makeExisting({ id: 'title', ...candidate, startTime: '18:00', endTime: '19:00' });
  assert.equal(findEventMatch(candidate, [overlap, time, title])?.kind, 'titolo');
  assert.equal(findEventMatch(candidate, [overlap, time])?.kind, 'orario');
  const partial = { ...overlap, id: 'partial', startTime: '15:30' };
  assert.deepEqual(findEventMatch(candidate, [partial, overlap]), { event: overlap, kind: 'sovrapposizione', others: 1 });
  assert.equal(findEventMatch({ ...candidate, startTime: '16:00', endTime: '17:00' }, [overlap]), null);
  for (const excluded of [ { category: 'lezione' as const }, { category: 'scadenza' as const }, { isAllDay: true }, { startTime: undefined, endTime: undefined } ]) {
    assert.equal(findEventMatch({ ...candidate, ...excluded }, [overlap]), null);
    assert.equal(findEventMatch(candidate, [{ ...overlap, ...excluded }]), null);
  }
});

// ---------------------------------------------------------------------------
// ABBINAMENTO UNO A UNO SULL'INTERO DOCUMENTO
// ---------------------------------------------------------------------------

const makeRow = (overrides: Partial<ExtractedItem> = {}) =>
  makeExtractedItem({ tempId: `row-${Math.random()}`, title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-12', ...overrides });

test('28. abbinamento uno a uno: la riga con stesso inizio+fine occupa l\'impegno, l\'altra è nuova', () => {
  const existing = makeExisting({
    id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti',
    startTime: '17:00', endTime: '18:30',
  });
  const rows = [
    makeRow({ tempId: 'r1', startTime: '16:00', endTime: '17:00' }),
    makeRow({ tempId: 'r2', startTime: '17:00', endTime: '18:30' }),
  ];

  const entries = assignDocumentMatches(rows, [existing]);
  assert.equal(entries[0].match, null, 'la prima riga non occupa l\'impegno: lo perde nella contesa');
  assert.deepEqual(entries[0].overlaps, [], 'orari contigui: nemmeno una sovrapposizione');
  assert.equal(entries[1].match?.event.id, 'ev-collegio', 'vince la riga con stesso inizio+fine');
  assert.equal(entries[1].match?.kind, 'titolo');
  assert.equal(entries[1].overlaps.length, 0);

  // La stessa riga, da sola, avrebbe occupato l'impegno: la differenza la fa l'assegnazione globale.
  assert.equal(assignDocumentMatches([rows[0]], [existing])[0].match?.event.id, 'ev-collegio');
});

test('29. abbinamento uno a uno: stesso inizio, poi sovrapposizione più lunga, poi ordine nel documento', () => {
  const existing = makeExisting({
    id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti',
    startTime: '15:00', endTime: '16:30',
  });

  // Stesso inizio: batte la riga che pure si sovrappone di più ed è più avanti nel documento.
  const bySameStart = assignDocumentMatches(
    [makeRow({ tempId: 'r1', startTime: '15:15', endTime: '16:00' }), makeRow({ tempId: 'r2', startTime: '15:00', endTime: '16:00' })],
    [existing]
  );
  assert.equal(bySameStart[0].match, null, 'perde chi non ha lo stesso inizio');
  assert.equal(bySameStart[1].match?.event.id, 'ev-collegio');

  // Nessuno stesso inizio: vince la sovrapposizione più lunga (50 contro 30 minuti),
  // anche se è la seconda riga del documento.
  const byOverlap = assignDocumentMatches(
    [makeRow({ tempId: 'r1', startTime: '16:00', endTime: '16:30' }), makeRow({ tempId: 'r2', startTime: '15:40', endTime: '17:00' })],
    [existing]
  );
  assert.equal(byOverlap[1].match?.event.id, 'ev-collegio', 'vince la sovrapposizione più lunga');
  assert.equal(byOverlap[0].match, null);

  // Stessa sovrapposizione: vince l'ordine nel documento (nessuna sovrapposizione, stesso giorno e titolo).
  const byOrder = assignDocumentMatches(
    [makeRow({ tempId: 'r1', startTime: '08:00', endTime: '09:00' }), makeRow({ tempId: 'r2', startTime: '08:00', endTime: '09:00' })],
    [existing]
  );
  assert.equal(byOrder[0].match?.event.id, 'ev-collegio', 'a parità vince la prima riga del documento');
  assert.equal(byOrder[1].match, null);
});

test('30. abbinamento uno a uno: la riga che perde la contesa viene rivalutata sugli impegni liberi', () => {
  const events = [
    makeExisting({ id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti', startTime: '15:00', endTime: '16:30' }),
    makeExisting({ id: 'ev-riunione', title: 'Riunione Organizzativa', category: 'riunione', startTime: '16:00', endTime: '17:00' }),
  ];
  const rows = [
    makeRow({ tempId: 'r1', startTime: '16:00', endTime: '17:00' }),
    makeRow({ tempId: 'r2', startTime: '15:00', endTime: '16:30' }),
  ];

  const entries = assignDocumentMatches(rows, events);
  assert.equal(entries[1].match?.event.id, 'ev-collegio', 'la riga con stesso inizio+fine occupa il collegio');
  // La riga che ha perso la contesa ripiega sull'altro impegno ancora libero.
  assert.equal(entries[0].match?.event.id, 'ev-riunione');
  assert.equal(entries[0].match?.kind, 'orario');
});

test('31. sovrapposizioni: non occupano l\'impegno e valgono per tutte le righe', () => {
  const existing = makeExisting({
    id: 'ev-cdc', title: 'Consiglio di Classe 1A', category: 'consiglio_classe', className: '1A',
    startTime: '15:00', endTime: '15:45',
  });
  const rows = [
    makeExtractedItem({ tempId: 'glo', title: 'GLO alunno', category: 'glo', className: '1A', date: '2026-10-12', startTime: '15:00', endTime: '16:00' }),
    makeExtractedItem({ tempId: 'pei', title: 'PEI alunno', category: 'pei', className: '1A', date: '2026-10-12', startTime: '15:15', endTime: '16:00' }),
    // Questa riga riproduce l'impegno: lo occupa, ma non toglie la sovrapposizione alle altre.
    makeExtractedItem({ tempId: 'cdc', title: 'Consiglio di Classe 1A', category: 'consiglio_classe', className: '1A', date: '2026-10-12', startTime: '15:00', endTime: '15:45' }),
  ];

  const entries = assignDocumentMatches(rows, [existing]);
  assert.equal(entries[0].match, null);
  assert.deepEqual(entries[0].overlaps.map((e) => e.id), ['ev-cdc']);
  assert.equal(entries[1].match, null);
  assert.deepEqual(entries[1].overlaps.map((e) => e.id), ['ev-cdc']);
  assert.equal(entries[2].match?.event.id, 'ev-cdc', 'la riga identica occupa l\'impegno');
  assert.deepEqual(entries[2].overlaps, [], 'l\'impegno abbinato non è anche una sovrapposizione');
});

test('32. describeEventDifferences: solo le differenze, una riga per campo e "—" per i valori assenti', () => {
  const existing = makeExisting({
    id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti',
    date: '2026-10-12', startTime: '17:00', endTime: '18:00',
  });

  assert.deepEqual(
    describeEventDifferences(existing, {
      title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-12',
      startTime: '15:00', endTime: '16:30', location: 'Telematica',
    }),
    [
      { field: 'time', label: 'Orario', from: '17:00–18:00', to: '15:00–16:30' },
      { field: 'location', label: 'Luogo', from: '—', to: 'Telematica' },
    ],
    'i campi uguali non compaiono; il campo vuoto da un lato è una differenza'
  );

  // Un impegno riprodotto tale e quale non ha differenze da mostrare.
  assert.deepEqual(
    describeEventDifferences(existing, {
      title: 'Collegio Docenti', category: 'collegio_docenti', date: '2026-10-12',
      startTime: '17:00', endTime: '18:00',
    }),
    []
  );

  // Titoli equivalenti per isTitleMatch non compaiono; gli altri campi diversi restano elencati.
  assert.deepEqual(
    describeEventDifferences(existing, {
      title: 'Collegio dei Docenti Straordinario', category: 'formazione', date: '2026-10-13',
      deadlineDate: '2026-10-20', className: '1A', notes: 'Ordine del giorno nuovo',
      startTime: '17:00', endTime: '18:00', isDeadline: true,
    }).map((difference) => difference.label),
    ['Data', 'Classe', 'Categoria', 'Scadenza', 'Note']
  );
});

test('32a. differenze allineate ad Aggiorna: vuoti preservati, categorie generiche ignorate, specifiche mostrate', () => {
  const existing = makeExisting({
    title: 'Impegno organizzativo', category: 'personale',
    location: 'Sede Centrale', className: '1A', subject: 'Matematica', notes: 'Nota esistente',
  });
  const emptyNewFields = {
    title: 'Impegno organizzativo', category: 'promemoria' as const, date: existing.date,
    startTime: existing.startTime, endTime: existing.endTime,
  };

  assert.deepEqual(describeEventDifferences(existing, emptyNewFields), [], 'i campi testuali vuoti non cancellano quelli esistenti; due categorie generiche non differiscono');
  assert.equal(isIdenticalEventUpdate(existing, emptyNewFields), true, 'elenco vuoto significa identico e saltato');

  assert.deepEqual(
    describeEventDifferences({ ...existing, category: 'glo' }, { ...emptyNewFields, category: 'pei' })
      .map((difference) => difference.label),
    ['Categoria'],
    'due categorie specifiche diverse sono una differenza',
  );

  assert.deepEqual(
    describeEventDifferences(existing, { ...emptyNewFields, subject: 'Inglese' })
      .map((difference) => difference.label),
    ['Materia'],
    'una materia non vuota verrebbe aggiornata ed è mostrata',
  );
});

// ---------------------------------------------------------------------------
// isIdenticalEventUpdate: equivalenza titoli e confronto case-insensitive
// ---------------------------------------------------------------------------

test('33. isIdenticalEventUpdate: caso riprodotto "Consiglio di Classe 3D" ≈ "Consigli di Classe" → identico', () => {
  const existing: CalendarEvent = {
    id: 'ev-consiglio-3d',
    title: 'Consiglio di Classe 3D',
    category: 'consiglio_classe',
    className: '3D',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '15:45',
    isAllDay: false,
    sourceType: 'circolare',
  };

  assert.equal(isIdenticalEventUpdate(existing, {
    title: 'Consigli di Classe',
    category: 'consiglio_classe',
    className: '3D',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '15:45',
  }), true, 'titoli equivalenti per isTitleMatch → identico');
});

test('34. isIdenticalEventUpdate: "Mod TELEMATICA" vs "Telematica" → NON identico (testi diversi)', () => {
  const existing: CalendarEvent = {
    id: 'ev-telematica',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '16:00',
    location: 'Mod TELEMATICA',
    isAllDay: false,
    sourceType: 'circolare',
  };

  assert.equal(isIdenticalEventUpdate(existing, {
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '16:00',
    location: 'Telematica',
  }), false, 'Mod TELEMATICA e Telematica sono testi diversi');
});

test('35. isIdenticalEventUpdate: luogo uguale salvo maiuscole → identico', () => {
  const existing: CalendarEvent = {
    id: 'ev-luogo',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '16:00',
    location: 'Aula Magna',
    isAllDay: false,
    sourceType: 'circolare',
  };

  assert.equal(isIdenticalEventUpdate(existing, {
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '16:00',
    location: 'AULA MAGNA',
  }), true, 'luogo uguale salvo maiuscole è identico');
});

test('36. isIdenticalEventUpdate: orario diverso → non identico', () => {
  const existing: CalendarEvent = {
    id: 'ev-consiglio-3d',
    title: 'Consiglio di Classe 3D',
    category: 'consiglio_classe',
    className: '3D',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '15:45',
    isAllDay: false,
    sourceType: 'circolare',
  };

  assert.equal(isIdenticalEventUpdate(existing, {
    title: 'Consigli di Classe',
    category: 'consiglio_classe',
    className: '3D',
    date: '2026-10-12',
    startTime: '16:00',
    endTime: '16:45',
  }), false, 'orario diverso non è identico');
});

test('37. isIdenticalEventUpdate: titoli non equivalenti → non identico', () => {
  const existing: CalendarEvent = {
    id: 'ev-consiglio-3d',
    title: 'Consiglio di Classe 3D',
    category: 'consiglio_classe',
    className: '3D',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '15:45',
    isAllDay: false,
    sourceType: 'circolare',
  };

  assert.equal(isIdenticalEventUpdate(existing, {
    title: 'Consiglio di Istituto',
    category: 'consiglio_classe',
    className: '3D',
    date: '2026-10-12',
    startTime: '15:00',
    endTime: '15:45',
  }), false, 'titoli non equivalenti non è identico');
});

// ---------------------------------------------------------------------------
// Regola A: testo già presente in un altro campo (luogo/note/classe)
// ---------------------------------------------------------------------------

test('38. Regola A: testo già presente in un altro campo non viene scritto né mostrato', () => {
  const existing = makeExisting({
    id: 'ev-dipartimenti', title: 'Dipartimenti', category: 'dipartimento',
    startTime: '15:00', endTime: '16:00', location: 'Modalità Telematica', sourceType: 'circolare',
  });

  // CASO RIPRODOTTO 1: le note nuove ripetono il luogo esistente → identico.
  assert.deepEqual(
    describeEventDifferences(existing, {
      title: 'Dipartimenti', category: 'dipartimento', date: '2026-10-12',
      startTime: '15:00', endTime: '16:00', notes: 'Modalità Telematica',
    }),
    [],
  );

  // Confronto senza maiuscole e spazi ripetuti, per tutti e tre i campi.
  const base = { title: 'Dipartimenti', category: 'dipartimento' as const, date: '2026-10-12', startTime: '15:00', endTime: '16:00' };
  assert.equal(getEventFieldDiff(existing, { ...base, notes: 'modalità   TELEMATICA' }).notes, false);
  assert.equal(getEventFieldDiff(existing, { ...base, className: 'Modalità Telematica' }).className, false, 'anche la classe partecipa alla regola');
  assert.equal(getEventFieldDiff({ ...existing, location: '', className: '3D' }, { ...base, location: '3d' }).location, false, 'testo già nella classe non riscrive il luogo');

  // Un testo davvero nuovo resta una differenza e viene scritto.
  assert.equal(getEventFieldDiff(existing, { ...base, notes: 'Portare il registro' }).notes, true);
  assert.equal(resolveUpdatedField(existing, 'notes', 'Portare il registro'), 'Portare il registro');

  // Applicazione: stessa regola delle differenze, una sola definizione.
  assert.equal(resolveUpdatedField(existing, 'notes', 'Modalità Telematica'), existing.notes, 'valore già nel luogo: non scritto');
  assert.equal(resolveUpdatedField(existing, 'location', ''), 'Modalità Telematica', 'campo nuovo vuoto: il valore esistente resta');
  assert.equal(resolveUpdatedField(existing, 'location', 'Aula Magna'), 'Aula Magna', 'valore nuovo scritto');

  // La materia non fa parte dei tre campi della regola A: lo stesso testo nel
  // luogo esistente non trattiene una materia nuova.
  const conMateria = makeExisting({ location: 'Matematica' });
  assert.equal(getEventFieldDiff(conMateria, { ...base, subject: 'Matematica' }).subject, true, 'la materia resta fuori dalla regola A');
  assert.equal(getEventFieldDiff(conMateria, { ...base, subject: 'Matematica' }).location, false, 'luogo nuovo vuoto: nessuna differenza');
});

// ---------------------------------------------------------------------------
// Regola B: motivo di pertinenza nelle note di un impegno da circolare
// ---------------------------------------------------------------------------

test('39. Regola B: note da circolare riconosciute come motivo di pertinenza valgono come vuote', () => {
  const motivo = 'Destinato a tutti i docenti.';
  const base = { title: 'Collegio Docenti', category: 'collegio_docenti' as const, date: '2026-10-12', startTime: '15:00', endTime: '15:45' };
  const daCircolare = makeExisting({ id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti', notes: motivo, sourceType: 'circolare' });

  // CASO RIPRODOTTO 2: note nuove "TUTTI" sul motivo di pertinenza → identico.
  assert.deepEqual(describeEventDifferences(daCircolare, { ...base, notes: 'TUTTI' }), []);
  assert.equal(isIdenticalEventUpdate(daCircolare, { ...base, notes: 'TUTTI' }), true);

  // Con un orario diverso l'unica differenza è l'orario.
  assert.deepEqual(
    describeEventDifferences(daCircolare, { ...base, startTime: '16:00', notes: 'TUTTI' }).map((d) => d.label),
    ['Orario'],
  );

  // Applicazione: note nuove sostituiscono il motivo; note vuote lo conservano.
  assert.equal(resolveUpdatedField(daCircolare, 'notes', 'TUTTI'), 'TUTTI');
  assert.equal(resolveUpdatedField(daCircolare, 'notes', undefined), motivo);

  // Il motivo vale come vuoto anche per la regola A: non blocca un luogo nuovo uguale.
  assert.equal(getEventFieldDiff(daCircolare, { ...base, location: motivo }).location, true);

  // Note utente (non un motivo) su impegno da circolare: differenza normale.
  const noteUtente = makeExisting({ id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti', notes: 'Portare il registro', sourceType: 'circolare' });
  assert.deepEqual(
    describeEventDifferences(noteUtente, { ...base, notes: 'TUTTI' }),
    [{ field: 'notes', label: 'Note', from: 'Portare il registro', to: 'TUTTI' }],
  );

  // Impegno MANUALE con note uguali a un motivo: trattate come note normali.
  const manuale = makeExisting({ id: 'ev-collegio', title: 'Collegio Docenti', category: 'collegio_docenti', notes: motivo, sourceType: 'manuale' });
  assert.deepEqual(
    describeEventDifferences(manuale, { ...base, notes: 'TUTTI' }).map((d) => d.label),
    ['Note'],
  );
  assert.equal(isIdenticalEventUpdate(manuale, { ...base, notes: motivo }), true, 'note identiche restano identiche');
});
