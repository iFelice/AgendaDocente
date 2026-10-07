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
    assert.ok(text.includes('Possibile aggiornamento di un impegno esistente'));
    assert.ok(text.includes('Esistente in agenda'));
    assert.ok(text.includes('Dalla nuova circolare'));
    assert.ok(text.includes('17:00 - 18:00'));
    assert.ok(text.includes('15:00 - 16:30'));

    // Verifica che nessuno dei 3 pulsanti sia evidenziato/preselezionato
    const updateBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Aggiorna esistente')[0];
    const createBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Aggiungi come nuovo')[0];
    const ignoreBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Ignora')[0];

    assert.ok(!updateBtn.props.className.includes('bg-emerald-700'), 'Aggiorna non deve essere preselezionato');
    assert.ok(!createBtn.props.className.includes('bg-amber-600'), 'Crea non deve essere preselezionato');
    assert.ok(!ignoreBtn.props.className.includes('bg-stone-700'), 'Ignora non deve essere preselezionato');
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
    assert.ok(warningText.includes('Effettua una scelta') || warningText.includes('Possibile aggiornamento'), 'Messaggio di avviso visibile');
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

    // Scegli "Aggiorna esistente"
    const updateBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Aggiorna esistente')[0];
    assert.ok(updateBtn, 'Pulsante Aggiorna esistente presente');
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

    // Scegli "Aggiungi come nuovo"
    const createBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Aggiungi come nuovo')[0];
    assert.ok(createBtn, 'Pulsante Aggiungi come nuovo presente');
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

test('13. "Ignora": non crea né aggiorna nulla, deseleziona l\'impegno (nuova semantica), nessun import', async () => {
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

    // Scegli "Ignora" (pulsante della scheda: quelli in blocco non hanno aria-pressed)
    const ignoreBtn = renderer.root.findAll(
      (el: any) => el.type === 'button' && flatText(el) === 'Ignora' && el.props['aria-pressed'] !== undefined
    )[0];
    assert.ok(ignoreBtn, 'Pulsante Ignora presente');
    await act(async () => { ignoreBtn.props.onClick(); });

    // La scelta implica la deselezione: nessun impegno selezionato, pulsante di
    // conferma disabilitato e nessuna importazione possibile.
    const checkbox = renderer.root.findAll((el: any) => el.type === 'input' && el.props.type === 'checkbox')[0];
    assert.equal(checkbox.props.checked, false, '"Ignora" deve deselezionare l\'impegno');
    assert.ok(ignoreBtn.props.className.includes('bg-stone-700'), 'Scelta "Ignora" evidenziata sulla scheda');

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

    // 1. Collegio -> scegli "Aggiorna esistente" (pulsante della scheda)
    const updateBtns = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Aggiorna esistente');
    assert.ok(updateBtns.length >= 1, 'Pulsante Aggiorna presente per Collegio');
    await act(async () => { updateBtns[0].props.onClick(); });

    // 2. Consiglio 1A è identico all'impegno già in agenda: la nuova gestione lo
    //    preseleziona su "Ignora", lo deseleziona e lo etichetta. Non serve clic manuale.
    assert.ok(flatText(renderer.root).includes('Già in agenda, identico'), 'Etichetta conflitto identico visibile');
    const checkboxes = renderer.root.findAll((el: any) => el.type === 'input' && el.props.type === 'checkbox');
    // Ordine delle schede: Collegio, Formazione, Consiglio (l'identico è il terzo).
    assert.equal(checkboxes[2].props.checked, false, 'Conflitto identico deselezionato in automatico');

    // Seleziona tutti per includere anche Formazione
    const selectAllBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Tutti')[0];
    await act(async () => { selectAllBtn.props.onClick(); });

    const confirmBtn = renderer.root.findByProps({ id: 'btn-confirm-circular-import' });
    assert.equal(flatText(confirmBtn), "Aggiungi 3 selezionati all'Agenda");

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

    // Scegli "Aggiorna esistente"
    const updateBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Aggiorna esistente')[0];
    assert.ok(updateBtn, 'Pulsante Aggiorna esistente presente');
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

test('19. Classi diverse (3D in agenda, 1C dalla circolare): nessun riconoscimento', () => {
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
  assert.equal(findEventMatch(candidate, [existingEvent]), null, 'La stessa ora non basta: la classe è diversa');
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
