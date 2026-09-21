import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { WeekView } from '../src/components/WeekView';
import { database } from '../src/services/db';
import { demoInstallation } from '../src/services/storage';
import type { CalendarEvent, TeacherProfile, TimetableSlot } from '../src/types';

/*
 * SETTIMANA -> tap lezione -> modifica diretta -> ritorno alla STESSA settimana
 * (secondo e ultimo ingresso dal Planning; stesso impianto di Oggi:
 * timetableEditNavigation + TimetableEditor già predisposto, nessuna nuova
 * infrastruttura). In WeekView NON c'è swipe: il tap/click è semplice e passa
 * il `day.iso` DEL GIORNO VISUALIZZATO — è ciò che consente il ritorno alla
 * settimana giusta anche dopo la navigazione fra settimane.
 *
 *  1. card lezione = button accessibile (marker, aria-label, target, focus);
 *  2. il callback riceve lo slot ESATTO per id;
 *  3. type "definitivo" da App;
 *  4. type "provvisorio" anche con `slot.isProvisional` legacy incoerente;
 *  5. il callback riceve ESATTAMENTE il `day.iso` del giorno visualizzato;
 *  6. due lezioni: il tap passa la SECONDA;
 *  7. gli eventi restano come prima (click = onEditEvent, nessun marker);
 *  8. round-trip App sulla settimana corrente;
 *  9. round-trip App da una SETTIMANA NON CORRENTE (+1);
 * 10. sessione consumata: Orario manuale dopo il ritorno è standalone;
 * 11. abbandono via navigazione principale: sessione pulita;
 * 12. l'editor riceve initialSlot/initialSlotType e il ritorno solo nel flusso.
 *
 * (La regressione del flusso Oggi è coperta dai test esistenti di
 * tests/today-slot-edit.test.ts, che restano verdi nella suite completa.)
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

/** Mercoledì della settimana del 14–20 settembre 2026 (data fissata dai test). */
const WEDNESDAY_ISO = '2026-09-16';

const lessonW1: TimetableSlot = {
  id: 'tt-wed-1', dayOfWeek: 3, periodNumber: 1, startTime: '07:50', endTime: '08:50',
  subject: 'Matematica', className: '1A',
};
const lessonW2: TimetableSlot = {
  id: 'tt-wed-2', dayOfWeek: 3, periodNumber: 2, startTime: '08:50', endTime: '09:50',
  subject: 'Storia', className: '2E', isProvisional: false, // flag legacy VOLUTAMENTE incoerente nel test 4
};

const weekEvent: CalendarEvent = {
  id: 'ev-1', title: 'Consiglio di classe', category: 'consiglio_classe',
  date: WEDNESDAY_ISO, startTime: '15:00', endTime: '16:30', isAllDay: false,
  sourceType: 'manuale',
};

function weekProps(overrides: Partial<React.ComponentProps<typeof WeekView>> = {}) {
  return {
    profile,
    timetable: [lessonW1, lessonW2] as TimetableSlot[],
    events: [weekEvent] as CalendarEvent[],
    isProvisionalTimetable: false,
    timetableType: 'definitivo' as const,
    onOpenTimetableSlotForEdit: () => {},
    onOpenNewEvent: () => {},
    onEditEvent: () => {},
    targetDateIso: WEDNESDAY_ISO, // fissa la settimana visualizzata (14–20 set)
    ...overrides,
  };
}

async function renderWeek(overrides: Partial<React.ComponentProps<typeof WeekView>> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(WeekView, weekProps(overrides) as any));
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
function lessonCards(renderer: any): any[] {
  return renderer.root.findAll((el: any) => el.type === 'button' && el.props?.['data-slot-cell'] === 'lesson');
}

// ---------------------------------------------------------------------------
// 1-7. WeekView: callback e card
// ---------------------------------------------------------------------------

test('1. la card lezione in Settimana è un button accessibile con marker lesson', async () => {
  const renderer = await renderWeek({});
  const cards = lessonCards(renderer);
  assert.equal(cards.length, 2, 'due card lezione tappabili (mercoledì)');
  const card = cards[0];
  assert.equal(card.props.type, 'button');
  assert.equal(card.props['data-slot-cell'], 'lesson');
  assert.ok(String(card.props['aria-label']).startsWith('Modifica la lezione:'));
  assert.ok(String(card.props['aria-label']).includes('Matematica'));
  assert.ok(String(card.props.className).includes('min-h-[44px]'), 'touch target >= 44px');
  assert.ok(String(card.props.className).includes('w-full'));
  assert.ok(String(card.props.className).includes('text-left'));
  assert.ok(String(card.props.className).includes('focus-visible:outline'), 'focus visibile');
});

test('2+5. il tap passa lo slot ESATTO per id e il day.iso DEL GIORNO VISUALIZZATO', async () => {
  const opens: unknown[][] = [];
  const renderer = await renderWeek({ onOpenTimetableSlotForEdit: (slot, type, iso) => opens.push([slot, type, iso]) });
  await act(async () => { lessonCards(renderer)[0].props.onClick(); });

  assert.equal(opens.length, 1);
  assert.equal((opens[0][0] as TimetableSlot).id, 'tt-wed-1', 'slot esatto per id stabile');
  assert.equal(opens[0][2], WEDNESDAY_ISO, 'day.iso del mercoledì visualizzato (non oggi reale, non dedotto)');
});

test('6. due lezioni: il tap sulla SECONDA passa la seconda', async () => {
  const opens: TimetableSlot[] = [];
  const renderer = await renderWeek({ onOpenTimetableSlotForEdit: (slot) => opens.push(slot) });
  await act(async () => { lessonCards(renderer)[1].props.onClick(); });
  assert.equal(opens.length, 1);
  assert.equal(opens[0].id, 'tt-wed-2');
});

test('3. orario definitivo: il callback riceve type "definitivo"', async () => {
  let received: string | undefined;
  const renderer = await renderWeek({ timetableType: 'definitivo', onOpenTimetableSlotForEdit: (_s, t) => { received = t; } });
  await act(async () => { lessonCards(renderer)[0].props.onClick(); });
  assert.equal(received, 'definitivo');
});

test('4. orario provvisorio: type "provvisorio" NONOSTANTE il flag legacy incoerente dello slot', async () => {
  let received: string | undefined;
  const renderer = await renderWeek({
    timetableType: 'provvisorio',
    isProvisionalTimetable: true,
    onOpenTimetableSlotForEdit: (_s, t) => { received = t; },
  });
  // lessonW2 ha isProvisional: false: NON deve inficiare il tipo della richiesta.
  await act(async () => { lessonCards(renderer)[1].props.onClick(); });
  assert.equal(received, 'provvisorio', 'la fonte è activeType da App, non slot.isProvisional');

  let legacy: string | undefined;
  const renderer2 = await renderWeek({
    timetableType: undefined,
    isProvisionalTimetable: true,
    onOpenTimetableSlotForEdit: (_s, t) => { legacy = t; },
  });
  await act(async () => { lessonCards(renderer2)[1].props.onClick(); });
  assert.equal(legacy, 'provvisorio');
});

test('7. gli eventi restano ESATTAMENTE come prima (click = onEditEvent, nessun marker lezione)', async () => {
  let edited: CalendarEvent | undefined;
  const renderer = await renderWeek({ onEditEvent: (ev) => { edited = ev; } });

  const eventCards = renderer.root.findAll((el: any) => el.type === 'div' && String(el.props.className ?? '').includes('cursor-pointer'));
  assert.equal(eventCards.length, 1, 'la card evento è quella di sempre');
  assert.equal(eventCards[0].props['data-slot-cell'], undefined, 'nessun marker lezione sugli eventi');
  await act(async () => { eventCards[0].props.onClick(); });
  assert.equal(edited?.id, 'ev-1', 'il click sull\'evento apre la sua modifica, non toccata dal cambiamento');
  assert.equal(lessonCards(renderer).length, 2, 'le card lezione sono solo quelle marcate');
});

// ---------------------------------------------------------------------------
// 8-12. Round-trip a livello di App (stessa infrastruttura di Oggi)
// ---------------------------------------------------------------------------

import { default as AgendaApp } from '../src/App';

// Shim minimale di window per gli effetti dell'albero App (già usato per i
// round-trip di Oggi): nessun tocco ai sorgenti.
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
  id: 'tt-app-wed', dayOfWeek: 3, periodNumber: 2, startTime: '08:50', endTime: '09:50',
  subject: 'Storia', className: '1A',
};
const APP_TIME_CONFIG = { firstHourStartTime: '07:50', periodsPerDay: 6, standardDurationMinutes: 60 };

async function flush(renderer: any, ms = 100) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

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
  // database è un singleton condiviso fra i test del file: initialize è un no-op
  // sulle chiamate successive, quindi il reset vero avviene con restore.
  await database.restore(localData as any);
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(AgendaApp, { initialData: localData }));
  });
  await flush(renderer, 150);
  return renderer;
}

/** Apre il flusso dalla Settimana (offset settimane: 0 = corrente, +1 = successiva). */
async function openLessonFromWeek(renderer: any, weeksAhead = 0) {
  await act(async () => { byId(renderer, 'nav-tab-settimana')[0].props.onClick(); });
  await flush(renderer);
  for (let i = 0; i < weeksAhead; i += 1) {
    await act(async () => {
      renderer.root.findAll((el: any) => el.props?.['aria-label'] === 'Settimana successiva')[0].props.onClick();
    });
    await flush(renderer);
  }
  // La settimana visualizzata ORA (testimoniata dall'header della vista).
  const weekRange = flatText(byId(renderer, 'week-range')[0]);
  const card = renderer.root.findAll((el: any) => el.type === 'button' && el.props?.['data-slot-cell'] === 'lesson');
  assert.ok(card.length >= 1, 'la lezione del mercoledì è tappabile in Settimana');
  await act(async () => { card[0].props.onClick(); });
  await flush(renderer, 200); // editor lazy
  return weekRange;
}

test('8. round-trip App: Settimana corrente -> tap lezione -> ANNULLA -> RITORNO AUTOMATICO alla STESSA settimana', async () => {
  const renderer = await bootApp();
  try {
    const weekRangeBefore = await openLessonFromWeek(renderer, 0);

    assert.ok(flatText(renderer.root).includes('Modifica Ora di Lezione'), 'il modale si apre da solo');
    // Annulla: NON resta nell'editor (evidenza iPhone): torna da solo alla
    // Settimana visualizzata prima del tap.
    await act(async () => { renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Annulla')[0].props.onClick(); });
    await flush(renderer);

    assert.ok(byId(renderer, 'week-range').length > 0, 'ritorno AUTOMATICO alla vista Settimana');
    assert.equal(flatText(byId(renderer, 'week-range')[0]), weekRangeBefore, 'stessa settimana visualizzata, non quella corrente dell\'app');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('E. Settimana -> SAVE riuscito -> ritorno AUTOMATICO alla stessa settimana', async () => {
  const renderer = await bootApp();
  try {
    const weekRangeBefore = await openLessonFromWeek(renderer, 1);
    const subjectInput = renderer.root.findAllByType('input').find((el: any) => el.props.value === 'Storia');
    await act(async () => { subjectInput.props.onChange({ target: { value: 'Geografia' } }); });
    await act(async () => { await renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }); });
    await flush(renderer);

    assert.ok(byId(renderer, 'week-range').length > 0, 'ritorno AUTOMATICO alla Settimana dopo il salvataggio');
    assert.equal(flatText(byId(renderer, 'week-range')[0]), weekRangeBefore, 'stessa settimana (quella navigata, +1)');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F. Settimana -> X/Chiudi -> ritorno AUTOMATICO alla stessa settimana', async () => {
  const renderer = await bootApp();
  try {
    const weekRangeBefore = await openLessonFromWeek(renderer, 0);
    const close = renderer.root.findAll((el: any) => el.props?.['aria-label'] === 'Chiudi');
    assert.equal(close.length, 1);
    await act(async () => { close[0].props.onClick(); });
    await flush(renderer);
    assert.ok(byId(renderer, 'week-range').length > 0);
    assert.equal(flatText(byId(renderer, 'week-range')[0]), weekRangeBefore, 'stessa settimana dopo X');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G. Settimana -> DELETE riuscito -> ritorno AUTOMATICO alla stessa settimana', async () => {
  const renderer = await bootApp();
  try {
    const weekRangeBefore = await openLessonFromWeek(renderer, 0);
    await act(async () => {
      renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Elimina ora')[0].props.onClick();
    });
    await flush(renderer);

    assert.ok(byId(renderer, 'week-range').length > 0, 'ritorno AUTOMATICO alla Settimana dopo l\'eliminazione');
    assert.equal(flatText(byId(renderer, 'week-range')[0]), weekRangeBefore, 'stessa settimana');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('9. round-trip da SETTIMANA NON CORRENTE (+1): il ritorno riapre ESATTAMENTE quella settimana', async () => {
  const renderer = await bootApp();
  try {
    const currentWeekRange = await currentWeekRangeText(renderer);
    const weekRangeBefore = await openLessonFromWeek(renderer, 1);
    assert.notEqual(weekRangeBefore, currentWeekRange, 'siamo davvero su una settimana diversa da quella corrente');

    await act(async () => { renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Annulla')[0].props.onClick(); });
    await flush(renderer);

    assert.ok(byId(renderer, 'week-range').length > 0);
    assert.equal(flatText(byId(renderer, 'week-range')[0]), weekRangeBefore, 'ritorno AUTOMATICO alla settimana NAVIGATA (day.iso), non a quella corrente');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

/** Testo del range della settimana corrente (stringa: l'elemento si smonta navigando via). */
async function currentWeekRangeText(renderer: any): Promise<string> {
  await act(async () => { byId(renderer, 'nav-tab-settimana')[0].props.onClick(); });
  await flush(renderer);
  const text = flatText(byId(renderer, 'week-range')[0]);
  // Torna a Oggi per non inquinare il flusso successivo.
  await act(async () => { byId(renderer, 'nav-tab-oggi')[0].props.onClick(); });
  await flush(renderer);
  return text;
}

test('10. sessione consumata: dopo il ritorno, Orario aperto MANUALMENTE è standalone', async () => {
  const renderer = await bootApp();
  try {
    await openLessonFromWeek(renderer, 0);
    await act(async () => { renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Annulla')[0].props.onClick(); });
    await flush(renderer);
    assert.ok(byId(renderer, 'week-range').length > 0, 'ritorno automatico alla Settimana');

    await act(async () => { byId(renderer, 'nav-tab-orario')[0].props.onClick(); });
    await flush(renderer, 200);

    assert.ok(byId(renderer, 'nav-tab-orario')[0].props['aria-current'] === 'page');
    assert.equal(renderer.root.findAll((el: any) => el.type === 'form').length, 0, 'nessuna riapertura automatica');
    assert.ok(!flatText(renderer.root).includes('Torna al Planning'), 'nessuna UI di ritorno fuori dal flusso');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('11. abbandono via navigazione principale: la sessione viene pulita', async () => {
  const renderer = await bootApp();
  try {
    await openLessonFromWeek(renderer, 0);
    // Abbandono del flusso col modale ancora aperto, via navigazione principale.
    await act(async () => { byId(renderer, 'nav-tab-oggi')[0].props.onClick(); });
    await flush(renderer);
    await act(async () => { byId(renderer, 'nav-tab-orario')[0].props.onClick(); });
    await flush(renderer, 200);

    assert.equal(renderer.root.findAll((el: any) => el.type === 'form').length, 0);
    assert.ok(!flatText(renderer.root).includes('Torna al Planning'), 'sessione chiusa dall\'uscita volontaria');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('12. l\'editor riceve la sessione: slot giusto precompilato, tipo giusto, ritorno nascosto a modale aperto', async () => {
  const renderer = await bootApp();
  try {
    await openLessonFromWeek(renderer, 1);

    assert.ok(flatText(renderer.root).includes('Modifica Ora di Lezione'));
    const inputs = renderer.root.findAllByType('input').map((el: any) => el.props.value);
    assert.ok(inputs.includes('Storia'), 'materia precompilata dallo slot della sessione');
    const selects = renderer.root.findAllByType('select').map((el: any) => String(el.props.value));
    assert.ok(selects.includes('3'), 'giorno precompilato (dayOfWeek 3)');
    assert.ok(selects.includes('2'), 'numero ora precompilato (periodNumber 2)');
    assert.ok(selects.includes('1A'), 'classe precompilata');
    assert.ok(flatText(renderer.root).includes('Salva in Provvisorio'), 'tipo = orario attivo al tap (provvisorio)');
    assert.ok(!flatText(renderer.root).includes('Torna al Planning'), 'il ritorno e\' automatico: nessun bottone dedicato');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// Selezione arancione "SELEZIONATO": solo per navigazione INTENZIONALE
// ---------------------------------------------------------------------------

/** Nessun resto dell'evidenza "SELEZIONATO" nell'albero renderizzato. */
function selezionatoCount(renderer: any): number {
  const badge = flatText(renderer.root).includes('SELEZIONATO') ? 1 : 0;
  const orangeCards = renderer.root.findAll((el: any) =>
    String(el.props?.className ?? '').includes('border-amber-500') ||
    String(el.props?.className ?? '').includes('ring-amber-500')).length;
  return badge + orangeCards;
}

test('M. ritorno dalla modifica lezione: settimana ripristinata SENZA giorno "SELEZIONATO" permanente', async () => {
  const renderer = await bootApp();
  try {
    const weekRangeBefore = await openLessonFromWeek(renderer, 1);
    await act(async () => { renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Annulla')[0].props.onClick(); });
    await flush(renderer);

    assert.ok(byId(renderer, 'week-range').length > 0, 'si torna alla Settimana');
    assert.equal(flatText(byId(renderer, 'week-range')[0]), weekRangeBefore, 'la settimana e\' quella giusta (anchor rispettato)');
    assert.equal(selezionatoCount(renderer), 0, 'nessun giorno marcato SELEZIONATO: la data era solo un anchor di ripristino');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('N. navigazione INTENZIONALE ("Visualizza la Settimana" da Oggi): l\'evidenza SELEZIONATO resta', async () => {
  const renderer = await bootApp();
  try {
    // Giovedi' 17/09 (giorno senza lezioni): la card di oggi mostra la CTA per la settimana.
    await act(async () => { byId(renderer, 'today-date-picker')[0].props.onChange({ target: { value: '2026-09-17' } }); });
    await flush(renderer);
    const cta = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Visualizza la Settimana');
    assert.equal(cta.length, 1, 'la CTA di navigazione intenzionale e\' presente');
    await act(async () => { cta[0].props.onClick(); });
    await flush(renderer);

    assert.ok(byId(renderer, 'week-range').length > 0);
    assert.ok(flatText(byId(renderer, 'week-range')[0]).includes('14'), 'settimana del 14-20 settembre aperta');
    assert.ok(selezionatoCount(renderer) > 0, 'navigazione intenzionale: il giorno scelto e\' evidenziato come prima');
    assert.ok(flatText(renderer.root).includes('SELEZIONATO'));

    // E il round-trip successivo NON deve lasciare l'evidenza: tap lezione -> Annulla.
    await openLessonFromWeek(renderer, 0);
    await act(async () => { renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Annulla')[0].props.onClick(); });
    await flush(renderer);
    assert.ok(byId(renderer, 'week-range').length > 0);
    assert.equal(selezionatoCount(renderer), 0, 'dopo il round-trip dalla modifica, nessuna selezione permanente');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});
