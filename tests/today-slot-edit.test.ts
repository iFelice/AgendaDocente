import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TodayView, TODAY_LESSON_CELL_SELECTOR } from '../src/components/TodayView';
import { DAY_SWIPE_INTERACTIVE_SELECTOR } from '../src/utils/daySwipe';
import type { TeacherProfile, TimetableSlot } from '../src/types';

/*
 * TAP su una card lezione in Oggi -> apertura DIRETTA della modifica (flusso
 * Planning -> TimetableEditor -> ritorno), senza mai interferire con lo swipe
 * orizzontale fra i giorni:
 *  - la card lezione è un button marcato `data-slot-cell="lesson"`: è l'UNICA
 *    eccezione al guard interattivo dello swipe (come le celle "+" dell'editor);
 *  - lo swipe che inizia sulla card cambia data e NON apre la lezione
 *    (soppressione esplicita del click residuo, senza timer);
 *  - il tipo orario della richiesta arriva da App (`timetableType`), MAI da
 *    `slot.isProvisional`;
 *  - i controlli normali (frecce, picker, pulsanti) restano esclusi dallo swipe.
 *
 * La seconda parte del file verifica il round-trip completo a livello di App:
 * Oggi (data scelta) -> tap lezione -> editor (modale precompilata) ->
 * Annulla -> "Torna al Planning" -> Oggi sulla STESSA data, con sessione
 * consumata (l'accesso manuale a Orario non riapre nulla).
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

/** Martedì fisso (2026-09-15): le lezioni sono su dayOfWeek 2. */
const FIXED_TUESDAY = '2026-09-15';

const lessonA: TimetableSlot = {
  id: 'tt-oggi-a', dayOfWeek: 2, periodNumber: 1, startTime: '07:50', endTime: '08:50',
  subject: 'Matematica', className: '1A',
};
const lessonB: TimetableSlot = {
  id: 'tt-oggi-b', dayOfWeek: 2, periodNumber: 2, startTime: '08:50', endTime: '09:50',
  subject: 'Storia', className: '2E', isProvisional: false, // flag legacy VOLUTAMENTE incoerente nel test 4
};

function todayProps(overrides: Partial<React.ComponentProps<typeof TodayView>> = {}) {
  return {
    profile,
    timetable: [lessonA, lessonB] as TimetableSlot[],
    events: [],
    scheduledAssessments: [],
    isProvisionalTimetable: false,
    isDefinitiveCompiled: true,
    timetableType: 'definitivo' as const,
    onOpenTimetableSlotForEdit: () => {},
    initialDateIso: FIXED_TUESDAY,
    onOpenNewEvent: () => {},
    onOpenCircularModal: () => {},
    onEditEvent: () => {},
    onDeleteEvent: () => {},
    onToggleComplete: () => {},
    ...overrides,
  };
}

async function renderToday(overrides: Partial<React.ComponentProps<typeof TodayView>> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TodayView, todayProps(overrides) as any));
  });
  return renderer;
}

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

function byId(renderer: any, id: string): any[] {
  return renderer.root.findAll((el: any) => el.props?.id === id);
}

/** Le card lezione (button) nell'ordine renderizzato. */
function lessonCards(renderer: any): any[] {
  return renderer.root.findAll((el: any) => el.type === 'button' && el.props?.['data-slot-cell'] === 'lesson');
}

function selectedIsoOf(renderer: any): string {
  const pickers = byId(renderer, 'today-date-picker');
  assert.ok(pickers.length > 0, 'la vista Oggi è montata');
  return pickers[0].props.value;
}

/**
 * Target finti per i pointer event, con la stessa semantica di `closest` usata
 * dai test di swipe dell'editor: il guard trova il controllo interattivo più
 * vicino e ne verifica l'eventuale marker cella/card.
 */
function lessonCardTarget() {
  const control: any = { closest: (sel: string) => (sel === TODAY_LESSON_CELL_SELECTOR ? control : null) };
  return { closest: (sel: string) => (sel === DAY_SWIPE_INTERACTIVE_SELECTOR ? control : null) };
}
function plainButtonTarget() {
  // Un controllo interattivo qualsiasi (es. freccia): nessun marker lezione.
  return { closest: (sel: string) => (sel === DAY_SWIPE_INTERACTIVE_SELECTOR ? { closest: () => null } : null) };
}

type PointerInit = { pointerId?: number; x: number; y: number; pointerType?: string; target: unknown };

async function swipe(root: any, init: PointerInit & { x2?: number; y2?: number }) {
  const pointerId = init.pointerId ?? 7;
  await act(async () => {
    root.props.onPointerDown({ pointerId, pointerType: init.pointerType ?? 'touch', clientX: init.x, clientY: init.y, target: init.target });
    root.props.onPointerUp({ pointerId, pointerType: init.pointerType ?? 'touch', clientX: init.x + (init.x2 ?? 0), clientY: init.y + (init.y2 ?? 0), target: init.target });
  });
}

// ---------------------------------------------------------------------------
// 1-4. Il callback riceve slot, tipo e data GIUSTI
// ---------------------------------------------------------------------------

test('1. tap sulla card lezione: callback con slot per id, type da App e selectedIso', async () => {
  const opens: unknown[][] = [];
  const renderer = await renderToday({ onOpenTimetableSlotForEdit: (slot, type, iso) => opens.push([slot, type, iso]) });

  const cards = lessonCards(renderer);
  assert.equal(cards.length, 2, 'due card lezione tappabili');
  await act(async () => { cards[0].props.onClick(); });

  assert.equal(opens.length, 1);
  assert.equal((opens[0][0] as TimetableSlot).id, 'tt-oggi-a', 'slot ESATTO per id stabile');
  assert.equal(opens[0][1], 'definitivo', 'tipo passato esplicitamente (fonte App)');
  assert.equal(opens[0][2], FIXED_TUESDAY, 'selectedIso corrente');
});

test('2. due lezioni nello stesso giorno: il tap passa ESATTAMENTE la seconda', async () => {
  const opens: TimetableSlot[] = [];
  const renderer = await renderToday({ onOpenTimetableSlotForEdit: (slot) => opens.push(slot) });

  const cards = lessonCards(renderer);
  await act(async () => { cards[1].props.onClick(); });

  assert.equal(opens.length, 1);
  assert.equal(opens[0].id, 'tt-oggi-b', 'la SECONDA lezione, mai una ricerca per giorno+materia');
});

test('3. orario definitivo: il callback riceve type "definitivo"', async () => {
  let receivedType: string | undefined;
  const renderer = await renderToday({
    timetableType: 'definitivo',
    isProvisionalTimetable: false,
    onOpenTimetableSlotForEdit: (_slot, type) => { receivedType = type; },
  });
  await act(async () => { lessonCards(renderer)[0].props.onClick(); });
  assert.equal(receivedType, 'definitivo');
});

test('4. orario provvisorio: type "provvisorio" anche con flag legacy dello slot incoerente', async () => {
  let receivedType: string | undefined;
  const renderer = await renderToday({
    timetableType: 'provvisorio',
    isProvisionalTimetable: true,
    onOpenTimetableSlotForEdit: (_slot, type) => { receivedType = type; },
  });
  // lessonB ha isProvisional: false: NON deve inficiare il tipo della richiesta.
  await act(async () => { lessonCards(renderer)[1].props.onClick(); });
  assert.equal(receivedType, 'provvisorio', 'la fonte è activeType da App, non slot.isProvisional');

  // Chiamante legacy che passa solo il flag storico (anch'esso da App): stesso esito.
  let legacyType: string | undefined;
  const legacy = await renderToday({
    timetableType: undefined,
    isProvisionalTimetable: true,
    onOpenTimetableSlotForEdit: (_slot, type) => { legacyType = type; },
  });
  await act(async () => { lessonCards(legacy)[1].props.onClick(); });
  assert.equal(legacyType, 'provvisorio');
});

// ---------------------------------------------------------------------------
// 7-13. Tap vs swipe sulla card
// ---------------------------------------------------------------------------

test('8. swipe a sinistra iniziato sulla card: giorno successivo, NESSUNA apertura', async () => {
  const opens: unknown[] = [];
  const renderer = await renderToday({ onOpenTimetableSlotForEdit: () => opens.push(1) });
  const root = byId(renderer, 'today-view')[0];
  // Il click residuo arriva all'elemento che era sotto il dito al rilascio:
  // lo catturiamo PRIMA dello swipe (il ref della soppressione è condiviso
  // fra i render, quindi la semantica è identica al browser reale).
  // catturato PRIMA dello swipe (il ref della soppressione è condiviso fra i
  // render, quindi la semantica è identica al click reale del browser).
  const residualClick = lessonCards(renderer)[0].props.onClick as () => void;

  await swipe(root, { x: 220, y: 300, x2: -120, target: lessonCardTarget() }); // dito verso sinistra
  assert.equal(selectedIsoOf(renderer), '2026-09-16', 'lo swipe cambia giorno');

  // Il click residuo al rilascio è soppresso: non apre la lezione...
  await act(async () => { residualClick(); });
  assert.equal(opens.length, 0, 'il click post-swipe non apre');

  // ...e la soppressione vale una sola volta: un tap vero successivo apre
  // normalmente (il ref torna false dopo il primo consumo).
  await act(async () => { residualClick(); });
  assert.equal(opens.length, 1);
});

test('9. swipe a destra iniziato sulla card: giorno precedente, NESSUNA apertura', async () => {
  const opens: unknown[] = [];
  const renderer = await renderToday({ onOpenTimetableSlotForEdit: () => opens.push(1) });
  const root = byId(renderer, 'today-view')[0];
  const residualClick = lessonCards(renderer)[0].props.onClick as () => void;

  await swipe(root, { x: 100, y: 300, x2: 120, target: lessonCardTarget() }); // dito verso destra
  assert.equal(selectedIsoOf(renderer), '2026-09-14', 'lo swipe cambia giorno');

  await act(async () => { residualClick(); });
  assert.equal(opens.length, 0, 'il click post-swipe non apre');
});

test('10. tap sulla card: esattamente una apertura (nessuna soppressione residua)', async () => {
  const opens: unknown[] = [];
  const renderer = await renderToday({ onOpenTimetableSlotForEdit: () => opens.push(1) });
  await act(async () => { lessonCards(renderer)[0].props.onClick(); });
  assert.equal(opens.length, 1);
});

test('11. gesto verticale sulla card: nessun cambio giorno, nessuna apertura spuria', async () => {
  const opens: unknown[] = [];
  const renderer = await renderToday({ onOpenTimetableSlotForEdit: () => opens.push(1) });
  const root = byId(renderer, 'today-view')[0];

  await swipe(root, { x: 150, y: 250, x2: 10, y2: 140, target: lessonCardTarget() });
  assert.equal(selectedIsoOf(renderer), FIXED_TUESDAY, 'il verticale non cambia giorno');
  assert.equal(opens.length, 0, 'il gesto da solo non apre nulla');

  // Nessuna soppressione appiccicosa: un tap vero dopo il gesto apre.
  await act(async () => { lessonCards(renderer)[0].props.onClick(); });
  assert.equal(opens.length, 1);
});

test('12. i controlli interattivi normali restano esclusi dallo swipe', async () => {
  const opens: unknown[] = [];
  const renderer = await renderToday({ onOpenTimetableSlotForEdit: () => opens.push(1) });
  const root = byId(renderer, 'today-view')[0];

  // Gesto che parte da un pulsante qualsiasi (es. freccia): nessun cambio data...
  await swipe(root, { x: 200, y: 120, x2: -140, target: plainButtonTarget() });
  assert.equal(selectedIsoOf(renderer), FIXED_TUESDAY, 'il guard interattivo esclude i controlli');
  assert.equal(opens.length, 0);

  // ...e nessun click residuo soppresso per controlli non coinvolti nell'eccezione.
  await act(async () => { lessonCards(renderer)[0].props.onClick(); });
  assert.equal(opens.length, 1, 'la card non è stata toccata dal gesto e si apre con il suo tap');
});

test('13. mouse: nessuna swipe-gesture, il click sulla card apre', async () => {
  const opens: TimetableSlot[] = [];
  const renderer = await renderToday({ onOpenTimetableSlotForEdit: (slot) => opens.push(slot) });
  const root = byId(renderer, 'today-view')[0];

  await swipe(root, { x: 220, y: 300, x2: -150, pointerType: 'mouse', target: lessonCardTarget() });
  assert.equal(selectedIsoOf(renderer), FIXED_TUESDAY, 'il mouse non è una gesture');

  await act(async () => { lessonCards(renderer)[0].props.onClick(); });
  assert.equal(opens.length, 1);
  assert.equal(opens[0].id, 'tt-oggi-a');
});

// ---------------------------------------------------------------------------
// 14-15. Accessibilità della card + comportamento legacy
// ---------------------------------------------------------------------------

test('14. la card lezione è un button accessibile: aria-label, touch target, focus visibile, marker', async () => {
  const renderer = await renderToday({});
  const card = lessonCards(renderer)[0];

  assert.equal(card.type, 'button');
  assert.equal(card.props.type, 'button');
  assert.ok(String(card.props['aria-label']).includes('Modifica la lezione'), 'aria-label descrittivo');
  assert.ok(String(card.props['aria-label']).includes('Matematica'));
  assert.ok(String(card.props.className).includes('min-h-[44px]'), 'touch target >= 44px');
  assert.ok(String(card.props.className).includes('w-full'), 'larghezza completa');
  assert.ok(String(card.props.className).includes('text-left'), 'allineamento testo coerente');
  assert.ok(String(card.props.className).includes('focus-visible:outline'), 'focus visibile da tastiera');
  assert.equal(card.props['data-slot-cell'], 'lesson', 'marker semantico per l\'eccezione swipe');
});

test('15. senza callback la card resta come prima (div, nessun marker): standalone invariato', async () => {
  const renderer = await renderToday({ onOpenTimetableSlotForEdit: undefined });
  assert.equal(lessonCards(renderer).length, 0, 'nessun button lezione');
  const divs = renderer.root.findAll((el: any) => el.type === 'div' && String(el.props.className ?? '').includes('p-3 rounded-xl border'));
  assert.ok(divs.length >= 2, 'le card restano div non interattive');
});

// ---------------------------------------------------------------------------
// Round-trip completo a livello di App (il flusso reale end-to-end):
// Oggi -> tap lezione -> editor (modale precompilata) -> Annulla ->
// "Torna al Planning" -> Oggi sulla STESSA data, sessione consumata.
// ---------------------------------------------------------------------------

import { database } from '../src/services/db';
import { demoInstallation } from '../src/services/storage';
import { default as AgendaApp } from '../src/App';

// Shim minimale di window per gli effetti dell'albero App (useOnlineStatus,
// usePWAInstall): nessun listener reale in node, nessun tocco ai sorgenti.
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
const APP_LESSON: TimetableSlot = {
  id: 'tt-app-1', dayOfWeek: 2, periodNumber: 2, startTime: '08:50', endTime: '09:50',
  subject: 'Storia', className: '1A',
};
/** Scansione oraria configurata (senza di essa l'editor mostra il wizard "Primo Accesso"). */
const APP_TIME_CONFIG = {
  firstHourStartTime: '07:50', periodsPerDay: 6, standardDurationMinutes: 60,
};

async function bootApp() {
  const localData = {
    ...demoInstallation(),
    provisionalTimetable: [{ ...APP_LESSON }],
    definitiveTimetable: [] as TimetableSlot[],
    timetableMode: 'auto' as const,
    timeSlotConfig: { ...APP_TIME_CONFIG },
    onboardingCompleted: true,
  };
  await database.initialize(localData as any, legacyStorage);
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

async function openLessonFromOggi(renderer: any) {
  // Naviga Oggi sul martedì fisso e tocca la card della lezione.
  const picker = byId(renderer, 'today-date-picker')[0];
  assert.ok(picker, 'la vista Oggi è montata');
  await act(async () => { picker.props.onChange({ target: { value: FIXED_TUESDAY } }); });
  await flush(renderer);
  assert.equal(byId(renderer, 'today-date-picker')[0].props.value, FIXED_TUESDAY);
  const card = renderer.root.findAll((el: any) => el.type === 'button' && el.props?.['data-slot-cell'] === 'lesson');
  assert.equal(card.length, 1, 'la card lezione del giorno scelto è tappabile');
  await act(async () => { card[0].props.onClick(); });
  // L'editor è lazy: si attende la risoluzione dell'import dinamico.
  await flush(renderer, 200);
}

test('5. round-trip App: Oggi su data diversa -> apertura lezione -> Annulla -> Torna al Planning -> stessa data', async () => {
  const renderer = await bootApp();
  try {
    await openLessonFromOggi(renderer);

    // L'editor è aperto con la lezione GIUSTA già in modifica (test 16 per i dettagli).
    assert.ok(flatText(renderer.root).includes('Modifica Ora di Lezione'), 'il modale di modifica si apre da solo');
    assert.ok(flatText(renderer.root).includes('Salva in Provvisorio'), 'orario attivo = provvisorio (definitivo vuoto)');

    // Annulla: il modale si chiude, l'editor resta e compare il ritorno.
    await act(async () => { renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Annulla')[0].props.onClick(); });
    await flush(renderer);
    assert.equal(renderer.root.findAll((el: any) => el.type === 'form').length, 0);
    const back = byId(renderer, 'back-to-planning');
    assert.equal(back.length, 1, '"Torna al Planning" è visibile dopo la chiusura del modale');

    // Ritorno: Oggi sulla STESSA data selezionata prima del tap.
    await act(async () => { back[0].props.onClick(); });
    await flush(renderer);
    assert.ok(byId(renderer, 'today-date-picker').length > 0, 'si torna alla vista Oggi');
    assert.equal(byId(renderer, 'today-date-picker')[0].props.value, FIXED_TUESDAY, 'stessa data, non il reale oggi');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('6. la sessione è consumata: dopo il ritorno, Orario aperto MANUALMENTE è standalone', async () => {
  const renderer = await bootApp();
  try {
    await openLessonFromOggi(renderer);
    await act(async () => { renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Annulla')[0].props.onClick(); });
    await act(async () => { byId(renderer, 'back-to-planning')[0].props.onClick(); });
    await flush(renderer);

    // Accesso manuale alla vista Orario dalla navigazione principale.
    await act(async () => { byId(renderer, 'nav-tab-orario')[0].props.onClick(); });
    await flush(renderer, 200);

    assert.ok(byId(renderer, 'nav-tab-orario')[0].props['aria-current'] === 'page', 'Orario è la vista corrente');
    assert.equal(renderer.root.findAll((el: any) => el.type === 'form').length, 0, 'nessun modale riaperto automaticamente');
    assert.equal(byId(renderer, 'back-to-planning').length, 0, 'nessun bottone di ritorno fuori dal flusso');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('7. abbandono con la navigazione principale: la sessione viene pulita', async () => {
  const renderer = await bootApp();
  try {
    await openLessonFromOggi(renderer);
    // Chiude il modale (sessione ancora aperta: c'è il ritorno) ...
    await act(async () => { renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Annulla')[0].props.onClick(); });
    await flush(renderer);
    assert.equal(byId(renderer, 'back-to-planning').length, 1);
    // ... e lascia il flusso con la navigazione principale.
    await act(async () => { byId(renderer, 'nav-tab-oggi')[0].props.onClick(); });
    await flush(renderer);
    await act(async () => { byId(renderer, 'nav-tab-orario')[0].props.onClick(); });
    await flush(renderer, 200);

    assert.equal(renderer.root.findAll((el: any) => el.type === 'form').length, 0, 'nessuna riapertura della lezione');
    assert.equal(byId(renderer, 'back-to-planning').length, 0, 'sessione chiusa: nessun ritorno al Planning');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('16. l\'editor riceve la sessione: slot giusto precompilato, tipo giusto, ritorno solo nel flusso', async () => {
  const renderer = await bootApp();
  try {
    await openLessonFromOggi(renderer);

    assert.ok(flatText(renderer.root).includes('Modifica Ora di Lezione'));
    // initialSlot: i campi sono precompilati con la lezione toccata.
    const inputs = renderer.root.findAllByType('input').map((el: any) => el.props.value);
    assert.ok(inputs.includes('Storia'), 'materia precompilata dallo slot della sessione');
    const selects = renderer.root.findAllByType('select').map((el: any) => String(el.props.value));
    assert.ok(selects.includes('2'), 'giorno precompilato (dayOfWeek 2)');
    assert.ok(selects.includes('2'), 'numero ora precompilato (periodNumber 2)');
    assert.ok(selects.includes('1A'), 'classe precompilata');
    // initialSlotType: destinazione di salvataggio = orario attivo al tap.
    assert.ok(flatText(renderer.root).includes('Salva in Provvisorio'));
    // onBackToOrigin esiste ma il bottone è nascosto mentre il modale è aperto.
    assert.equal(byId(renderer, 'back-to-planning').length, 0, 'niente ritorno a modale aperto');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});
