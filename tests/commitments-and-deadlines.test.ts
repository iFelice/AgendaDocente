import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import type { CalendarEvent, ExtractedItem, TeacherProfile } from '../src/types';
import { effectiveDeadlineDate, localDateISO } from '../src/utils/dates';
import { DeadlinesView } from '../src/components/DeadlinesView';
import { TodayView, selectDayAgenda } from '../src/components/TodayView';
import { EventModal } from '../src/components/EventModal';
import { deriveFutureCommitments } from '../src/utils/futureCommitments';
import { convertExtractedItemToEvent } from '../src/services/storage';
import { findPossibleEventUpdate, getEventFieldDiff } from '../src/utils/eventMatching';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import { installSignedInAnalysisClient } from './helpers/analysisClientSession';
installSignedInAnalysisClient();


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: TeacherProfile = {
  id: 'p1',
  fullName: 'Prof. Mario Rossi',
  schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Matematica'],
  classes: ['1A', '2E'],
  campuses: ['Centrale'],
  roles: [],
};

function makeEvent(partial: Partial<CalendarEvent> & { id: string; date: string }): CalendarEvent {
  return {
    title: 'Evento Test',
    category: 'promemoria',
    isAllDay: true,
    sourceType: 'manuale',
    completed: false,
    ...partial,
  };
}

function textOf(node: any): string {
  const parts: string[] = [];
  const target = node?.root ?? node;
  const walk = (n: any) => {
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return; }
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.children)) n.children.forEach(walk);
    else if (typeof n.children === 'string' || typeof n.children === 'number') parts.push(String(n.children));
  };
  walk(target);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 1. promemoria senza deadline → NON Scadenze
// ---------------------------------------------------------------------------
test('1. promemoria senza deadline → NON Scadenze', () => {
  const ev = makeEvent({ id: 'p1', title: 'Promemoria didattico', category: 'promemoria', date: '2026-11-26' });
  assert.equal(effectiveDeadlineDate(ev), undefined);

  let renderer: any;
  act(() => {
    renderer = create(React.createElement(DeadlinesView, {
      events: [ev],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
      onDeleteEvent: () => {},
      onToggleComplete: () => {},
    }));
  });
  const text = textOf(renderer);
  assert.ok(!text.includes('Promemoria didattico'), 'promemoria senza deadline non deve apparire in DeadlinesView');
  assert.ok(text.includes('Nessuna scadenza in questa sezione'));
});

// ---------------------------------------------------------------------------
// 2. promemoria con deadline → Scadenze
// ---------------------------------------------------------------------------
test('2. promemoria con deadline → Scadenze', () => {
  const ev = makeEvent({
    id: 'p2',
    title: 'Promemoria con data limite',
    category: 'promemoria',
    date: '2026-11-26',
    deadlineDate: '2026-10-14',
  });
  assert.equal(effectiveDeadlineDate(ev), '2026-10-14');

  let renderer: any;
  act(() => {
    renderer = create(React.createElement(DeadlinesView, {
      events: [ev],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
      onDeleteEvent: () => {},
      onToggleComplete: () => {},
    }));
  });
  const text = textOf(renderer);
  assert.ok(text.includes('Promemoria con data limite'), 'promemoria con deadline compare in DeadlinesView');
  assert.ok(text.includes('Data limite: 14/10/2026'));
  assert.ok(text.includes('Evento: 26/11/2026'));
});

// ---------------------------------------------------------------------------
// 3. PEI senza deadline → NON Scadenze
// ---------------------------------------------------------------------------
test('3. PEI senza deadline → NON Scadenze', () => {
  const ev = makeEvent({ id: 'pei-1', title: 'Stesura PEI', category: 'pei', date: '2026-10-30' });
  assert.equal(effectiveDeadlineDate(ev), undefined);

  let renderer: any;
  act(() => {
    renderer = create(React.createElement(DeadlinesView, {
      events: [ev],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
      onDeleteEvent: () => {},
      onToggleComplete: () => {},
    }));
  });
  const text = textOf(renderer);
  assert.ok(!text.includes('Stesura PEI'));
});

// ---------------------------------------------------------------------------
// 4. PEI con deadline → Scadenze
// ---------------------------------------------------------------------------
test('4. PEI con deadline → Scadenze', () => {
  const ev = makeEvent({
    id: 'pei-2',
    title: 'Consegna finale PEI',
    category: 'pei',
    date: '2026-10-30',
    deadlineDate: '2026-10-30',
  });
  assert.equal(effectiveDeadlineDate(ev), '2026-10-30');

  let renderer: any;
  act(() => {
    renderer = create(React.createElement(DeadlinesView, {
      events: [ev],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
      onDeleteEvent: () => {},
      onToggleComplete: () => {},
    }));
  });
  const text = textOf(renderer);
  assert.ok(text.includes('Consegna finale PEI'));
  assert.ok(text.includes('Data limite: 30/10/2026'));
});

// ---------------------------------------------------------------------------
// 5. GLO con deadline → Scadenze
// ---------------------------------------------------------------------------
test('5. GLO con deadline → Scadenze', () => {
  const evNoDeadline = makeEvent({ id: 'glo-1', title: 'GLO 1A', category: 'glo', date: '2026-11-05' });
  assert.equal(effectiveDeadlineDate(evNoDeadline), undefined);

  const evWithDeadline = makeEvent({
    id: 'glo-2',
    title: 'GLO 2E con documenti da preparare',
    category: 'glo',
    date: '2026-11-05',
    deadlineDate: '2026-11-03',
  });
  assert.equal(effectiveDeadlineDate(evWithDeadline), '2026-11-03');

  let renderer: any;
  act(() => {
    renderer = create(React.createElement(DeadlinesView, {
      events: [evNoDeadline, evWithDeadline],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
      onDeleteEvent: () => {},
      onToggleComplete: () => {},
    }));
  });
  const text = textOf(renderer);
  assert.ok(!text.includes('GLO 1A'), 'GLO senza deadline non compare');
  assert.ok(text.includes('GLO 2E con documenti da preparare'), 'GLO con deadline compare');
  assert.ok(text.includes('Data limite: 03/11/2026'));
  assert.ok(text.includes('Evento: 05/11/2026'));
});

// ---------------------------------------------------------------------------
// 6. legacy category scadenza senza deadlineDate → fallback event.date
// ---------------------------------------------------------------------------
test('6. legacy category scadenza senza deadlineDate → fallback event.date', () => {
  const legacyEvent = makeEvent({
    id: 'leg-1',
    title: 'Vecchia scadenza salvata',
    category: 'scadenza',
    date: '2026-10-30',
  });
  assert.equal(effectiveDeadlineDate(legacyEvent), '2026-10-30');

  let renderer: any;
  act(() => {
    renderer = create(React.createElement(DeadlinesView, {
      events: [legacyEvent],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
      onDeleteEvent: () => {},
      onToggleComplete: () => {},
    }));
  });
  const text = textOf(renderer);
  assert.ok(text.includes('Vecchia scadenza salvata'));
  assert.ok(text.includes('Data limite: 30/10/2026'));
});

// ---------------------------------------------------------------------------
// 7. Prisma svolgimento → no deadline
// ---------------------------------------------------------------------------
test('7. Prisma svolgimento → no deadline', () => {
  const item: ExtractedItem = {
    tempId: 'prisma-svolgimento',
    title: 'Svolgimento Giochi Matematici di Prisma',
    category: 'promemoria',
    date: '2026-11-26',
    relevance: 'VERDE',
    relevanceReason: 'Attività didattica',
    selectedForImport: true,
  };
  const event = convertExtractedItemToEvent(item, 'Circolare Prisma', 'circ-prisma');
  assert.equal(event.deadlineDate, undefined);
  assert.equal(effectiveDeadlineDate(event), undefined);
});

// ---------------------------------------------------------------------------
// 8. Prisma quota → deadline
// ---------------------------------------------------------------------------
test('8. Prisma quota → deadline', () => {
  const item: ExtractedItem = {
    tempId: 'prisma-quota',
    title: 'Versamento quota iscrizione Prisma',
    category: 'scadenza',
    date: '2026-10-14',
    deadlineDate: '2026-10-14',
    isDeadline: true,
    relevance: 'VERDE',
    relevanceReason: 'Scadenza versamento',
    selectedForImport: true,
  };
  const event = convertExtractedItemToEvent(item, 'Circolare Prisma', 'circ-prisma');
  assert.equal(event.deadlineDate, '2026-10-14');
  assert.equal(effectiveDeadlineDate(event), '2026-10-14');
});

// ---------------------------------------------------------------------------
// 9. badge navbar conta solo deadline pendenti
// ---------------------------------------------------------------------------
test('9. badge navbar conta solo deadline pendenti', () => {
  const events: CalendarEvent[] = [
    makeEvent({ id: '1', title: 'Scadenza attiva', category: 'scadenza', date: '2026-10-20', completed: false }),
    makeEvent({ id: '2', title: 'Scadenza completata', category: 'scadenza', date: '2026-10-15', completed: true }),
    makeEvent({ id: '3', title: 'Promemoria con deadline', category: 'promemoria', date: '2026-11-01', deadlineDate: '2026-10-25', completed: false }),
    makeEvent({ id: '4', title: 'Promemoria semplice', category: 'promemoria', date: '2026-10-20', completed: false }),
    makeEvent({ id: '5', title: 'GLO semplice', category: 'glo', date: '2026-10-20', completed: false }),
    makeEvent({ id: '6', title: 'GLO con deadline completato', category: 'glo', date: '2026-10-20', deadlineDate: '2026-10-18', completed: true }),
  ];

  const pendingDeadlinesCount = events.filter(
    (e) => !!effectiveDeadlineDate(e) && !e.completed
  ).length;

  assert.equal(pendingDeadlinesCount, 2); // '1' and '3'
});

// ---------------------------------------------------------------------------
// 10. Home mostra solo deadline
// ---------------------------------------------------------------------------
test('10. Home (TodayView) mostra solo deadline', () => {
  const todayIso = '2026-10-14';
  const events: CalendarEvent[] = [
    makeEvent({ id: 'd-today', title: 'Versamento quota Prisma', category: 'promemoria', date: '2026-10-14', deadlineDate: '2026-10-14' }),
    makeEvent({ id: 'p-today', title: 'Svolgimento Giochi Matematici', category: 'promemoria', date: '2026-10-14' }),
    makeEvent({ id: 'glo-future', title: 'Preparare documenti GLO', category: 'glo', date: '2026-11-05', deadlineDate: '2026-10-20' }),
    makeEvent({ id: 'glo-simple', title: 'GLO 3E', category: 'glo', date: '2026-11-05' }),
  ];

  const agenda = selectDayAgenda(todayIso, [], events);
  assert.deepEqual(agenda.dayDeadlines.map(d => d.id), ['d-today']);
  assert.deepEqual(agenda.nextDeadlines.map(d => d.id), ['glo-future']);
});

// ---------------------------------------------------------------------------
// 11. completed deadline → tab completate
// ---------------------------------------------------------------------------
test('11. completed deadline → tab completate', () => {
  const pendingEv = makeEvent({ id: 'pend-1', title: 'Scadenza da fare', category: 'scadenza', date: '2026-10-20', completed: false });
  const completedEv = makeEvent({ id: 'comp-1', title: 'Scadenza fatta', category: 'scadenza', date: '2026-10-10', completed: true });

  let renderer: any;
  act(() => {
    renderer = create(React.createElement(DeadlinesView, {
      events: [pendingEv, completedEv],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
      onDeleteEvent: () => {},
      onToggleComplete: () => {},
    }));
  });

  // Default filter: "pending"
  let text = textOf(renderer);
  assert.ok(text.includes('Scadenza da fare'));
  assert.ok(!text.includes('Scadenza fatta'));

  // Switch to "completed"
  const buttons = renderer.root.findAll((n: any) => n.type === 'button');
  const completedTab = buttons.find((b: any) => textOf(b).includes('Completate'));
  assert.ok(completedTab, 'tab Completate esiste');

  act(() => {
    completedTab.props.onClick();
  });

  text = textOf(renderer);
  assert.ok(!text.includes('Scadenza da fare'));
  assert.ok(text.includes('Scadenza fatta'));
});

// ---------------------------------------------------------------------------
// 12. Note e impegni continua a includere evento con deadline
// ---------------------------------------------------------------------------
test('12. Note e impegni continua a includere evento con deadline', () => {
  const events: CalendarEvent[] = [
    makeEvent({ id: 'ev-1', title: 'GLO con data limite', category: 'glo', date: '2026-10-20', deadlineDate: '2026-10-18' }),
    makeEvent({ id: 'ev-2', title: 'Consiglio di Classe', category: 'consiglio_classe', date: '2026-10-21' }),
  ];

  const future = deriveFutureCommitments({
    events,
    scheduledAssessments: [],
    students: [],
    todayIso: '2026-10-15',
  });

  assert.equal(future.length, 2);
  assert.deepEqual(future.map(f => f.title), ['GLO con data limite', 'Consiglio di Classe']);
});

// ---------------------------------------------------------------------------
// 13. EventModal salva deadlineDate
// ---------------------------------------------------------------------------
test('13. EventModal salva deadlineDate', async () => {
  let savedEvent: CalendarEvent | null = null;
  let renderer: any;

  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true,
      onClose: () => {},
      eventToEdit: null,
      profile,
      onSave: (event) => { savedEvent = event; },
    }));
  });

  // Type title
  const titleInput = renderer.root.find((n: any) => n.type === 'input' && n.props.placeholder?.includes('Consiglio di Classe'));
  await act(async () => { titleInput.props.onChange({ target: { value: 'Consegna relazioni' } }); });

  // Toggle deadline checkbox
  const deadlineCheckbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.className?.includes('text-rose-700'));
  assert.ok(deadlineCheckbox, 'checkbox Ha una scadenza esiste');
  await act(async () => { deadlineCheckbox.props.onChange({ target: { checked: true } }); });

  // Set deadline date
  const dateInputs = renderer.root.findAll((n: any) => n.type === 'input' && n.props.type === 'date');
  assert.equal(dateInputs.length, 2, 'date input e deadline date input');
  const deadlineInput = dateInputs[1];
  await act(async () => { deadlineInput.props.onChange({ target: { value: '2026-10-18' } }); });

  // Submit form
  const form = renderer.root.find((n: any) => n.type === 'form');
  await act(async () => { form.props.onSubmit({ preventDefault: () => {} }); });

  assert.ok(savedEvent, 'evento salvato');
  assert.equal((savedEvent as any).title, 'Consegna relazioni');
  assert.equal((savedEvent as any).deadlineDate, '2026-10-18');
});

// ---------------------------------------------------------------------------
// 14. checkbox intera giornata separata dalla deadline
// ---------------------------------------------------------------------------
test('14. checkbox intera giornata separata dalla deadline', async () => {
  let savedEvent: CalendarEvent | null = null;
  let renderer: any;

  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true,
      onClose: () => {},
      eventToEdit: null,
      profile,
      onSave: (event) => { savedEvent = event; },
    }));
  });

  const allDayCheckbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.className?.includes('text-emerald-700'));
  const deadlineCheckbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.className?.includes('text-rose-700'));

  assert.equal(allDayCheckbox.props.checked, false);
  assert.equal(deadlineCheckbox.props.checked, false);

  // Check allDay only
  await act(async () => { allDayCheckbox.props.onChange({ target: { checked: true } }); });
  assert.equal(allDayCheckbox.props.checked, true);
  assert.equal(deadlineCheckbox.props.checked, false);

  const titleInput = renderer.root.find((n: any) => n.type === 'input' && n.props.placeholder?.includes('Consiglio di Classe'));
  await act(async () => { titleInput.props.onChange({ target: { value: 'Intera giornata senza scadenza' } }); });

  const form = renderer.root.find((n: any) => n.type === 'form');
  await act(async () => { form.props.onSubmit({ preventDefault: () => {} }); });

  assert.ok(savedEvent);
  assert.equal((savedEvent as any).isAllDay, true);
  assert.equal((savedEvent as any).deadlineDate, undefined);
});

// ---------------------------------------------------------------------------
// 15. category scadenza auto-attiva deadline
// ---------------------------------------------------------------------------
test('15. category scadenza auto-attiva deadline', async () => {
  let savedEvent: CalendarEvent | null = null;
  let renderer: any;

  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true,
      onClose: () => {},
      eventToEdit: null,
      profile,
      onSave: (event) => { savedEvent = event; },
    }));
  });

  // Seleziona "Scadenza Istituzionale" dal menu Tipologia Impegno
  const categorySelect = renderer.root.find((n: any) => n.type === 'select' && n.props.id === 'event-category');
  await act(async () => { categorySelect.props.onChange({ target: { value: 'scadenza' } }); });

  const deadlineCheckbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.className?.includes('text-rose-700'));
  assert.equal(deadlineCheckbox.props.checked, true, 'selezionare category scadenza abilita automaticamente deadline');

  const titleInput = renderer.root.find((n: any) => n.type === 'input' && n.props.placeholder?.includes('Consiglio di Classe'));
  await act(async () => { titleInput.props.onChange({ target: { value: 'Adempimento' } }); });

  const form = renderer.root.find((n: any) => n.type === 'form');
  await act(async () => { form.props.onSubmit({ preventDefault: () => {} }); });

  assert.ok(savedEvent);
  assert.equal((savedEvent as any).category, 'scadenza');
  assert.ok((savedEvent as any).deadlineDate, 'deadlineDate è valorizzata');
});

// ---------------------------------------------------------------------------
// 16. Test update circolare: aggiunta deadline e diff
// ---------------------------------------------------------------------------
test('16. update circolare: rilevamento e aggiunta deadline via matching diff', () => {
  const existing = makeEvent({
    id: 'ev-prisma',
    title: 'Versamento quota Prisma',
    category: 'promemoria',
    date: '2026-10-14',
    deadlineDate: undefined,
  });

  const candidate: Parameters<typeof getEventFieldDiff>[1] = {
    title: 'Versamento quota Prisma',
    date: '2026-10-14',
    category: 'promemoria',
    deadlineDate: '2026-10-14',
    isDeadline: true,
  };

  const diff = getEventFieldDiff(existing, candidate);
  assert.equal(diff.deadlineDate, true, 'diff.deadlineDate deve essere true quando il candidato introduce una deadline');
  assert.equal(diff.title, false);
  assert.equal(diff.date, false);

  const updatedDeadlineDate = candidate.deadlineDate || (candidate.isDeadline === true ? candidate.date : undefined);
  const updatedEvent: CalendarEvent = {
    ...existing,
    deadlineDate: updatedDeadlineDate,
  };
  assert.equal(updatedEvent.deadlineDate, '2026-10-14');
  assert.equal(effectiveDeadlineDate(updatedEvent), '2026-10-14');
});

// ---------------------------------------------------------------------------
// 17. Test update circolare: rimozione deadline obsoleta
// ---------------------------------------------------------------------------
test('17. update circolare: rimozione deadline obsoleta quando circolare non ha deadline', () => {
  const existing = makeEvent({
    id: 'ev-prisma',
    title: 'Versamento quota Prisma',
    category: 'promemoria',
    date: '2026-10-14',
    deadlineDate: '2026-10-14',
  });

  const candidate: Parameters<typeof getEventFieldDiff>[1] = {
    title: 'Versamento quota Prisma',
    date: '2026-10-14',
    category: 'promemoria',
    deadlineDate: undefined,
    isDeadline: false,
  };

  const diff = getEventFieldDiff(existing, candidate);
  assert.equal(diff.deadlineDate, true, 'diff.deadlineDate deve essere true quando il candidato non ha più deadline');

  const updatedDeadlineDate = candidate.deadlineDate || (candidate.isDeadline === true ? candidate.date : undefined);
  const updatedEvent: CalendarEvent = {
    ...existing,
    deadlineDate: updatedDeadlineDate,
  };
  assert.equal(updatedEvent.deadlineDate, undefined, 'deadlineDate deve essere rimossa (undefined)');
  assert.equal(effectiveDeadlineDate(updatedEvent), undefined);
});

// ---------------------------------------------------------------------------
// 18. EventModal: category=scadenza disabilita la checkbox e la mantiene checked
// ---------------------------------------------------------------------------
test('18. EventModal: category=scadenza mantiene la checkbox checked e disabilitata', async () => {
  let renderer: any;

  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true,
      onClose: () => {},
      eventToEdit: null,
      profile,
      onSave: () => {},
    }));
  });

  const categorySelect = renderer.root.find((n: any) => n.type === 'select' && n.props.id === 'event-category');
  assert.ok(categorySelect, 'menu Tipologia Impegno trovato');

  await act(async () => { categorySelect.props.onChange({ target: { value: 'scadenza' } }); });

  const deadlineCheckbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.className?.includes('text-rose-700'));
  assert.equal(deadlineCheckbox.props.checked, true);
  assert.equal(deadlineCheckbox.props.disabled, true, 'la checkbox deve essere disabled quando category === "scadenza"');

  const text = textOf(renderer);
  assert.ok(text.includes('richiede una data limite'), 'mostra la nota esplicativa');
});

// ---------------------------------------------------------------------------
// 19. EventModal: passaggio da Scadenza a GLO riabilita la checkbox e preserva deadline
// ---------------------------------------------------------------------------
test('19. EventModal: cambio da scadenza a GLO riabilita la checkbox e mantiene la deadline', async () => {
  let renderer: any;

  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true,
      onClose: () => {},
      eventToEdit: null,
      profile,
      onSave: () => {},
    }));
  });

  const categorySelect = renderer.root.find((n: any) => n.type === 'select' && n.props.id === 'event-category');
  assert.ok(categorySelect, 'menu Tipologia Impegno trovato');
  assert.ok(categorySelect, 'menu Tipologia Impegno trovato');

  // Seleziona prima Scadenza
  await act(async () => { categorySelect.props.onChange({ target: { value: 'scadenza' } }); });

  let deadlineCheckbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.className?.includes('text-rose-700'));
  assert.equal(deadlineCheckbox.props.checked, true);
  assert.equal(deadlineCheckbox.props.disabled, true);

  // Passa a GLO
  await act(async () => { categorySelect.props.onChange({ target: { value: 'glo' } }); });

  deadlineCheckbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.className?.includes('text-rose-700'));
  assert.equal(deadlineCheckbox.props.checked, true, 'la deadline rimane attiva al passaggio a GLO');
  assert.equal(deadlineCheckbox.props.disabled, false, 'la checkbox ora è riabilitata e modificabile');
});

// ---------------------------------------------------------------------------
// 20. EventModal: GLO può disattivare la deadline e salvare senza deadlineDate
// ---------------------------------------------------------------------------
test('20. EventModal: GLO può disattivare la deadline e salvare senza deadlineDate', async () => {
  let savedEvent: CalendarEvent | null = null;
  let renderer: any;

  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true,
      onClose: () => {},
      eventToEdit: null,
      profile,
      onSave: (ev) => { savedEvent = ev; },
    }));
  });

  const categorySelect = renderer.root.find((n: any) => n.type === 'select' && n.props.id === 'event-category');

  // Scadenza -> poi GLO
  await act(async () => { categorySelect.props.onChange({ target: { value: 'scadenza' } }); });
  await act(async () => { categorySelect.props.onChange({ target: { value: 'glo' } }); });

  const deadlineCheckbox = renderer.root.find((n: any) => n.type === 'input' && n.props.type === 'checkbox' && n.props.className?.includes('text-rose-700'));
  assert.equal(deadlineCheckbox.props.checked, true);

  // Disattiva la spunta
  await act(async () => { deadlineCheckbox.props.onChange({ target: { checked: false } }); });

  const titleInput = renderer.root.find((n: any) => n.type === 'input' && n.props.placeholder?.includes('Consiglio di Classe'));
  await act(async () => { titleInput.props.onChange({ target: { value: 'Incontro GLO finale' } }); });

  const form = renderer.root.find((n: any) => n.type === 'form');
  await act(async () => { form.props.onSubmit({ preventDefault: () => {} }); });

  assert.ok(savedEvent);
  assert.equal((savedEvent as any).category, 'glo');
  assert.equal((savedEvent as any).deadlineDate, undefined, 'deadlineDate deve essere undefined');
});

// ---------------------------------------------------------------------------
// 21. EventModal: salvataggio category=scadenza produce sempre deadlineDate valida
// ---------------------------------------------------------------------------
test('21. EventModal: salvataggio category=scadenza produce sempre deadlineDate valida', async () => {
  let savedEvent: CalendarEvent | null = null;
  let renderer: any;

  await act(async () => {
    renderer = create(React.createElement(EventModal, {
      isOpen: true,
      onClose: () => {},
      eventToEdit: null,
      profile,
      onSave: (ev) => { savedEvent = ev; },
    }));
  });

  const categorySelect = renderer.root.find((n: any) => n.type === 'select' && n.props.id === 'event-category');
  await act(async () => { categorySelect.props.onChange({ target: { value: 'scadenza' } }); });

  const titleInput = renderer.root.find((n: any) => n.type === 'input' && n.props.placeholder?.includes('Consiglio di Classe'));
  await act(async () => { titleInput.props.onChange({ target: { value: 'Invio Relazione Finale' } }); });

  const form = renderer.root.find((n: any) => n.type === 'form');
  await act(async () => { form.props.onSubmit({ preventDefault: () => {} }); });

  assert.ok(savedEvent);
  assert.equal((savedEvent as any).category, 'scadenza');
  assert.ok((savedEvent as any).deadlineDate, 'deadlineDate deve essere impostata');
  assert.equal((savedEvent as any).deadlineDate, (savedEvent as any).date);
});

