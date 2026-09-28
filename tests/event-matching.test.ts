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
  getEventFieldDiff,
  findPossibleEventUpdate,
} from '../src/utils/eventMatching';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
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

    // 10. Preserva googleEventId e metadati tecnici
    assert.equal(updated.googleEventId, 'google-cal-event-999');
    assert.equal(updated.syncedWithGoogle, true);
    assert.equal(updated.schoolId, 'school-main');
    assert.equal(updated.reminderMinutesBefore, 30);
    assert.equal(updated.completed, true);
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

test('13. "Ignora": non crea né aggiorna nulla', async () => {
  const existingEvent: CalendarEvent = {
    id: 'ev-exist-1',
    title: 'Collegio Docenti',
    category: 'collegio_docenti',
    date: '2026-10-15',
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
          title: 'Collegio Docenti',
          category: 'collegio_docenti',
          date: '2026-10-15',
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

    // Scegli "Ignora"
    const ignoreBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Ignora')[0];
    assert.ok(ignoreBtn, 'Pulsante Ignora presente');
    await act(async () => { ignoreBtn.props.onClick(); });

    // Conferma importazione
    const confirmBtn = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).includes("all'Agenda"))[0];
    await act(async () => { confirmBtn.props.onClick(); });

    // Nessun evento importato o aggiornato
    assert.equal(importedNew.length, 0);
    assert.equal(importedUpdated.length, 0);
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
