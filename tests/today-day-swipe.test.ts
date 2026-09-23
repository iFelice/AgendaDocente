import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TodayView } from '../src/components/TodayView';
import { DAY_SWIPE_HORIZONTAL_RATIO, DAY_SWIPE_MIN_DISTANCE_PX, daySwipeDirection } from '../src/utils/daySwipe';
import { addDaysISO, localDateISO } from '../src/utils/dates';
import type { TeacherProfile, TimetableSlot } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Swipe orizzontale nella vista Oggi (scorciatoia mobile sulle superfici non
 * interattive):
 *  - destra -> sinistra: giorno successivo; sinistra -> destra: giorno precedente;
 *  - stessa logica di cambio data delle frecce (±1 giorno con addDaysISO), quindi
 *    attraversa fine settimana, fine mese e fine anno senza casi speciali;
 *  - sotto soglia o prevalentemente verticale: nessun cambio;
 *  - frecce, date picker e pulsante "Oggi" restano intatti;
 *  - il mouse non è una gesture: il desktop non cambia.
 */

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

/** Lunedì con un'ora di sostegno: per verificare che le lezioni seguano il giorno selezionato. */
const mondaySlot: TimetableSlot = {
  id: 's1', dayOfWeek: 1, periodNumber: 1, startTime: '07:50', endTime: '08:50',
  subject: 'Sostegno', className: '2E',
};

function todayProps(overrides: Partial<React.ComponentProps<typeof TodayView>> = {}) {
  return {
    profile,
    timetable: [mondaySlot],
    events: [],
    isProvisionalTimetable: false,
    isDefinitiveCompiled: true,
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
    renderer = create(React.createElement(TodayView, todayProps(overrides)));
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

function byId(renderer: any, id: string) {
  const found = renderer.root.findAll((el: any) => el.props?.id === id);
  assert.ok(found.length > 0, `l'elemento con id "${id}" deve esistere`);
  return found[0];
}

/** Data selezionata: la legge dallo stesso input che il date picker usa per impostarla. */
function selectedIsoOf(renderer: any): string {
  return byId(renderer, 'today-date-picker').props.value;
}

/** Imposta la data selezionata passando per il date picker esistente. */
async function selectDate(renderer: any, iso: string) {
  const picker = byId(renderer, 'today-date-picker');
  await act(async () => { picker.props.onChange({ target: { value: iso } }); });
  assert.equal(selectedIsoOf(renderer), iso, `data impostata a ${iso}`);
}

/** Intestazione del giorno selezionato (h1 della riga data). */
function headingDate(renderer: any): string {
  return flatText(byId(renderer, 'today-date-line').findByType('h1'));
}

/** Superficie non interattiva (sfondo delle card). */
const plainSurface = { closest: () => null };
/** Un controllo interattivo (pulsante, input, link...): il gesto non deve partire da qui. */
const interactiveControl = { closest: (selector: string) => ({ selector }) };

/** Un gesto completo sulla radice della vista Oggi. */
async function gesture(
  renderer: any,
  deltaX: number,
  deltaY = 0,
  options: { pointerType?: string; target?: unknown; releaseWithoutStart?: boolean; pointerId?: number } = {},
) {
  const surface = byId(renderer, 'today-view');
  assert.equal(typeof surface.props.onPointerDown, 'function', 'la radice riceve i pointer event');
  assert.equal(typeof surface.props.onPointerUp, 'function', 'la radice riceve i pointer event');
  const pointerType = options.pointerType ?? 'touch';
  const target = options.target ?? plainSurface;
  const pointerId = options.pointerId ?? 7;
  if (!options.releaseWithoutStart) {
    await act(async () => {
      surface.props.onPointerDown({ pointerType, pointerId, clientX: 320, clientY: 400, target });
    });
  }
  await act(async () => {
    surface.props.onPointerUp({ pointerType, pointerId, clientX: 320 + deltaX, clientY: 400 + deltaY, target });
  });
}

// ---------------------------------------------------------------------------
// Regole pure della gesture (fonte condivisa con la vista Orario)
// ---------------------------------------------------------------------------

test('regole della gesture: soglia, prevalenza orizzontale, direzione', () => {
  assert.equal(DAY_SWIPE_MIN_DISTANCE_PX, 48, 'soglia orizzontale dichiarata');
  assert.ok(DAY_SWIPE_HORIZONTAL_RATIO > 1, 'il gesto deve essere nettamente orizzontale');
  // Sotto soglia: mai un cambio di giorno.
  assert.equal(daySwipeDirection(-(DAY_SWIPE_MIN_DISTANCE_PX - 1), 0), null);
  assert.equal(daySwipeDirection(0, 0), null);
  assert.equal(daySwipeDirection(12, 4), null, 'micro-movimenti ignorati');
  // Orizzontale deciso: sinistra = successivo, destra = precedente.
  assert.equal(daySwipeDirection(-120, 10), 'next');
  assert.equal(daySwipeDirection(120, -10), 'previous');
  // Verticale e diagonali: nessun cambio.
  assert.equal(daySwipeDirection(10, 240), null, 'scroll verticale');
  assert.equal(daySwipeDirection(-60, 50), null, 'diagonale non abbastanza orizzontale');
});

// ---------------------------------------------------------------------------
// Gesture nella vista reale
// ---------------------------------------------------------------------------

test('1. swipe verso sinistra: +1 giorno (stessa logica della freccia avanti)', async () => {
  let opened = 0;
  const renderer = await renderToday({ onOpenNewEvent: () => { opened += 1; } });
  await selectDate(renderer, '2026-09-15'); // Martedì 15 settembre 2026
  await gesture(renderer, -120);
  assert.equal(selectedIsoOf(renderer), addDaysISO('2026-09-15', 1), 'giorno successivo selezionato');
  assert.equal(headingDate(renderer), 'Mercoledì 16 settembre 2026', 'l intestazione segue la data');
  assert.equal(opened, 0, 'lo swipe non apre modali né aggiunge impegni');
  await act(async () => { renderer.unmount(); });
});

test('2. swipe verso destra: -1 giorno (stessa logica della freccia indietro)', async () => {
  const renderer = await renderToday();
  await selectDate(renderer, '2026-09-15'); // Martedì
  await gesture(renderer, 140);
  assert.equal(selectedIsoOf(renderer), addDaysISO('2026-09-15', -1), 'giorno precedente selezionato');
  assert.equal(headingDate(renderer), 'Lunedì 14 settembre 2026');
  // Le lezioni seguono il giorno selezionato: il lunedì c è l ora di sostegno.
  assert.ok(flatText(byId(renderer, 'today-timetable-content')).includes('Sostegno'), 'la lezione del lunedì è in elenco');
  await act(async () => { renderer.unmount(); });
});

test('3. movimento sotto soglia: nessun cambio di giorno', async () => {
  const renderer = await renderToday();
  await selectDate(renderer, '2026-09-15');
  await gesture(renderer, -(DAY_SWIPE_MIN_DISTANCE_PX - 1));
  assert.equal(selectedIsoOf(renderer), '2026-09-15', 'sotto la soglia orizzontale');
  await gesture(renderer, 20, 4);
  assert.equal(selectedIsoOf(renderer), '2026-09-15', 'un tocco breve non cambia giorno');
  await act(async () => { renderer.unmount(); });
});

test('4. movimento prevalentemente verticale: nessun cambio (scroll libero)', async () => {
  const renderer = await renderToday();
  await selectDate(renderer, '2026-09-15');
  const surface = byId(renderer, 'today-view');
  assert.equal(surface.props.style?.touchAction, 'pan-y', 'lo scroll verticale resta nativo al browser');
  await gesture(renderer, 10, 260);
  assert.equal(selectedIsoOf(renderer), '2026-09-15', 'lo scroll verso il basso non cambia giorno');
  await gesture(renderer, -14, -320);
  assert.equal(selectedIsoOf(renderer), '2026-09-15', 'nemmeno verso l alto');
  await gesture(renderer, -60, 50);
  assert.equal(selectedIsoOf(renderer), '2026-09-15', 'diagonale ambigua ignorata');
  await act(async () => { renderer.unmount(); });
});

test('5. confini di mese e anno: il giorno avanza/indietro sempre di uno', async () => {
  const renderer = await renderToday();
  // Fine mese: mercoledì 30 settembre -> giovedì 1 ottobre.
  await selectDate(renderer, '2026-09-30');
  await gesture(renderer, -160);
  assert.equal(selectedIsoOf(renderer), '2026-10-01', 'settembre -> ottobre');
  assert.equal(headingDate(renderer), 'Giovedì 1 ottobre 2026');
  // Fine anno: giovedì 31 dicembre 2026 -> venerdì 1 gennaio 2027.
  await selectDate(renderer, '2026-12-31');
  await gesture(renderer, -160);
  assert.equal(selectedIsoOf(renderer), '2027-01-01', 'dicembre 2026 -> gennaio 2027');
  assert.equal(headingDate(renderer), 'Venerdì 1 gennaio 2027');
  // E il verso opposto torna indietro attraverso lo stesso confine.
  await gesture(renderer, 160);
  assert.equal(selectedIsoOf(renderer), '2026-12-31', 'gennaio 2027 -> dicembre 2026');
  await act(async () => { renderer.unmount(); });
});

test('5b. fine settimana e giorni senza lezioni: lo swipe non si ferma', async () => {
  const renderer = await renderToday();
  // Domenica 27 dicembre 2026: fine settimana, nessuna lezione.
  await selectDate(renderer, '2026-12-27');
  assert.ok(flatText(byId(renderer, 'today-date-line')).includes('Nessuna lezione'), 'domenica: nessuna lezione');
  await gesture(renderer, -160);
  assert.equal(selectedIsoOf(renderer), '2026-12-28', 'domenica -> lunedì attraversando l anno');
  assert.equal(headingDate(renderer), 'Lunedì 28 dicembre 2026');
  assert.ok(flatText(byId(renderer, 'today-timetable-content')).includes('Sostegno'), 'il lunedì porta le sue lezioni');
  await act(async () => { renderer.unmount(); });
});

test('6. frecce, date picker e pulsante "Oggi" continuano a funzionare (anche insieme allo swipe)', async () => {
  const renderer = await renderToday();
  const start = localDateISO();
  assert.equal(selectedIsoOf(renderer), start, 'si parte dal reale oggi');
  // Frecce: ±1 giorno esattamente come prima.
  await act(async () => { byId(renderer, 'today-next-day').props.onClick(); });
  assert.equal(selectedIsoOf(renderer), addDaysISO(start, 1), 'freccia avanti: +1 giorno');
  await act(async () => { byId(renderer, 'today-previous-day').props.onClick(); });
  assert.equal(selectedIsoOf(renderer), start, 'freccia indietro: -1 giorno');
  // Date picker: imposta una data arbitraria.
  await act(async () => { byId(renderer, 'today-date-picker').props.onChange({ target: { value: '2027-06-01' } }); });
  assert.equal(selectedIsoOf(renderer), '2027-06-01', 'date picker rispettato');
  // Pulsante ambra "Oggi": torna al reale oggi.
  await act(async () => { byId(renderer, 'today-back-to-today').props.onClick(); });
  assert.equal(selectedIsoOf(renderer), start, 'ritorno a oggi');
  // Swipe e frecce si compongono sulla stessa data.
  await gesture(renderer, -160);
  await act(async () => { byId(renderer, 'today-previous-day').props.onClick(); });
  assert.equal(selectedIsoOf(renderer), start, 'swipe +1 poi freccia -1: si torna al punto di partenza');
  await act(async () => { renderer.unmount(); });
});

test('7. desktop: il mouse non è una gesture e non cambia nulla', async () => {
  const renderer = await renderToday();
  await selectDate(renderer, '2026-09-15');
  await gesture(renderer, -260, 0, { pointerType: 'mouse' });
  assert.equal(selectedIsoOf(renderer), '2026-09-15', 'trascina col mouse: nessun cambio');
  await gesture(renderer, 260, 0, { pointerType: 'mouse' });
  assert.equal(selectedIsoOf(renderer), '2026-09-15', 'nemmeno nel verso opposto');
  await act(async () => { renderer.unmount(); });
});

test('8. gesto iniziato su un controllo interattivo: nessun cambio, il controllo resta utilizzabile', async () => {
  const renderer = await renderToday();
  await selectDate(renderer, '2026-09-15');
  await gesture(renderer, -220, 0, { target: interactiveControl });
  assert.equal(selectedIsoOf(renderer), '2026-09-15', 'nessuna interpretazione sopra pulsanti/campi');
  // Il controllo resta utilizzabile normalmente.
  await act(async () => { byId(renderer, 'today-next-day').props.onClick(); });
  assert.equal(selectedIsoOf(renderer), '2026-09-16', 'la freccia continua a rispondere');
  await act(async () => { renderer.unmount(); });
});

test('9. gesto interrotto dallo scroll (pointercancel): nessun cambio', async () => {
  const renderer = await renderToday();
  await selectDate(renderer, '2026-09-15');
  const surface = byId(renderer, 'today-view');
  await act(async () => {
    surface.props.onPointerDown({ pointerType: 'touch', pointerId: 9, clientX: 320, clientY: 400, target: plainSurface });
  });
  await act(async () => { surface.props.onPointerCancel({ pointerType: 'touch', pointerId: 9 }); });
  await act(async () => {
    surface.props.onPointerUp({ pointerType: 'touch', pointerId: 9, clientX: 20, clientY: 400, target: plainSurface });
  });
  assert.equal(selectedIsoOf(renderer), '2026-09-15', 'gesto annullato dal browser: nessun cambio');
  await act(async () => { renderer.unmount(); });
});

test('10. una gesture produce al massimo UN cambio di giorno', async () => {
  const renderer = await renderToday();
  await selectDate(renderer, '2026-09-15');
  await gesture(renderer, -900);
  assert.equal(selectedIsoOf(renderer), '2026-09-16', 'uno swipe lunghissimo avanza di un solo giorno');
  // Un rilascio senza una nuova pressione non è una gesture.
  await gesture(renderer, -900, 0, { releaseWithoutStart: true });
  assert.equal(selectedIsoOf(renderer), '2026-09-16', 'nessun secondo cambio senza pointerdown');
  // Un rilascio con pointerId diverso da quello del pointerdown non eredita il gesto.
  const surface = byId(renderer, 'today-view');
  await act(async () => {
    surface.props.onPointerDown({ pointerType: 'touch', pointerId: 8, clientX: 320, clientY: 400, target: plainSurface });
  });
  await act(async () => {
    surface.props.onPointerUp({ pointerType: 'touch', pointerId: 99, clientX: 20, clientY: 400, target: plainSurface });
  });
  assert.equal(selectedIsoOf(renderer), '2026-09-16', 'pointerId non corrispondente: nessun cambio');
  await act(async () => { surface.props.onPointerCancel({ pointerType: 'touch', pointerId: 8 }); });
  await act(async () => { renderer.unmount(); });
});
