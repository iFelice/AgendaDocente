import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import {
  DAY_SWIPE_CELL_SELECTOR,
  DAY_SWIPE_HORIZONTAL_RATIO,
  DAY_SWIPE_INTERACTIVE_SELECTOR,
  DAY_SWIPE_MIN_DISTANCE_PX,
  TimetableEditor,
  daySwipeDirection,
  isInteractiveSwipeTarget,
  swipeTargetDay,
} from '../src/components/TimetableEditor';
import { WeekView } from '../src/components/WeekView';
import type { TeacherProfile, TimetableSlot } from '../src/types';

/*
 * Swipe orizzontale fra i giorni nella vista Orario (scorciatoia mobile).
 * I chip dei giorni restano il controllo principale: qui si verifica che lo
 * swipe cambi giorno solo quando il gesto è chiaramente orizzontale, che non
 * esca mai dalla settimana mostrata e che non tocchi i controlli interattivi.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DAY_AREA_ID = 'timetable-day-area';
const CHIP_LABELS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven'];
/** Settimana lunga (profilo non SSIG): c'è anche il chip del sabato. */
const ALL_CHIP_LABELS = [...CHIP_LABELS, 'Sab'];

/** Profilo SSIG: settimana corta, quindi i bordi dello swipe sono Lun e Ven. */
const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

const mondaySlot: TimetableSlot = {
  id: 's1', dayOfWeek: 1, periodNumber: 1, startTime: '07:50', endTime: '08:50',
  subject: 'Sostegno', className: '2E',
};

function editorProps(overrides: Partial<React.ComponentProps<typeof TimetableEditor>> = {}) {
  return {
    profile,
    definitiveTimetable: [] as TimetableSlot[],
    provisionalTimetable: [mondaySlot],
    timetableMode: 'auto' as const,
    activeType: 'provvisorio' as const,
    isDefinitiveCompiled: false,
    timeSlotConfig: {
      firstHourStartTime: '07:50', periodsPerDay: 3, standardDurationMinutes: 60,
      customSlots: [
        { periodNumber: 1, startTime: '07:50', endTime: '08:50' },
        { periodNumber: 2, startTime: '08:50', endTime: '09:50' },
        { periodNumber: 3, startTime: '09:50', endTime: '10:50' },
      ],
    },
    onSaveSlot: () => {},
    onDeleteSlot: () => {},
    onSetTimetableMode: () => {},
    onCopyProvisionalToDefinitive: () => {},
    onCopyDefinitiveToProvisional: () => {},
    onClearTimetable: () => {},
    onSaveProfile: () => {},
    onSaveTimeSlotConfig: () => {},
    ...overrides,
  };
}

async function renderEditor(overrides: Partial<React.ComponentProps<typeof TimetableEditor>> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, editorProps(overrides) as any));
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

function dayChip(renderer: any, short: string) {
  const chips = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === short);
  assert.ok(chips.length > 0, `il chip "${short}" deve esistere`);
  return chips[0];
}

/** Giorno attualmente selezionato, letto dallo STESSO stato che colora i chip. */
function activeChip(renderer: any): string {
  const active = renderer.root.findAll((el: any) => el.type === 'button'
    && String(el.props?.className ?? '').includes('bg-emerald-700')
    && ['Tutti i giorni', ...ALL_CHIP_LABELS].includes(flatText(el)));
  assert.equal(active.length, 1, 'un solo chip attivo');
  return flatText(active[0]);
}

/** Colonne giorno nella griglia (esclusa la colonna "Campana"). */
function dayColumnsOf(renderer: any): number {
  return renderer.root.findAll((el: any) => el.type === 'th').length - 1;
}

/** Superficie non interattiva dell'area del giorno (es. la colonna delle ore). */
const plainSurface = { closest: () => null };
/** Un controllo: chip, pulsante, input, link (il gesto non deve partire da qui). */
const interactiveControl = { closest: (selector: string) => ({ selector }) };

/** Un gesto completo: pointerdown + pointerup sull'area del giorno. */
async function gesture(
  renderer: any,
  deltaX: number,
  deltaY = 0,
  options: { pointerType?: string; target?: unknown; releaseWithoutStart?: boolean; pointerId?: number } = {},
) {
  const area = byId(renderer, DAY_AREA_ID);
  const pointerType = options.pointerType ?? 'touch';
  const target = options.target ?? plainSurface;
  const pointerId = options.pointerId ?? 7;
  if (!options.releaseWithoutStart) {
    await act(async () => {
      area.props.onPointerDown({ pointerType, pointerId, clientX: 320, clientY: 400, target });
    });
  }
  await act(async () => {
    area.props.onPointerUp({ pointerType, pointerId, clientX: 320 + deltaX, clientY: 400 + deltaY, target });
  });
}

async function selectDay(renderer: any, short: string) {
  await act(async () => { dayChip(renderer, short).props.onClick(); });
  assert.equal(activeChip(renderer), short, `chip ${short} selezionato`);
}

// ---------------------------------------------------------------------------
// Regole pure della gesture
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
  assert.equal(daySwipeDirection(-60, 40), 'next', 'oltre il rapporto richiesto');
});

test('bordi della settimana: nessun wrap-around e nessun cambio settimana', () => {
  const days = [1, 2, 3, 4, 5];
  assert.equal(swipeTargetDay(1, 'next', days), 2);
  assert.equal(swipeTargetDay(2, 'previous', days), 1);
  assert.equal(swipeTargetDay(1, 'previous', days), 1, 'da lunedì verso destra si resta a lunedì');
  assert.equal(swipeTargetDay(5, 'next', days), 5, 'da venerdì verso sinistra si resta a venerdì');
  // Sabato incluso (settimana lunga): il bordo diventa il sabato, sempre in-settimana.
  assert.equal(swipeTargetDay(5, 'next', [1, 2, 3, 4, 5, 6]), 6);
  assert.equal(swipeTargetDay(6, 'next', [1, 2, 3, 4, 5, 6]), 6);
  // Vista "tutti i giorni" e giorno non presente: nessuna modifica.
  assert.equal(swipeTargetDay('all', 'next', days), 'all');
  assert.equal(swipeTargetDay(3, null, days), 3);
  assert.equal(swipeTargetDay(9, 'next', days), 9);
});

test('controlli interattivi esclusi dal gesto', () => {
  assert.equal(isInteractiveSwipeTarget(interactiveControl), true);
  assert.equal(isInteractiveSwipeTarget(plainSurface), false);
  assert.equal(isInteractiveSwipeTarget(null), false);
  assert.equal(isInteractiveSwipeTarget(undefined), false);
  assert.equal(isInteractiveSwipeTarget({}), false, 'nodo senza closest: prudenza, nessun gesto');
  assert.match(DAY_SWIPE_INTERACTIVE_SELECTOR, /button/);
  for (const control of ['input', 'select', 'textarea', 'a', 'label', '[role="button"]']) {
    assert.ok(DAY_SWIPE_INTERACTIVE_SELECTOR.includes(control), `${control} è escluso`);
  }
});

// ---------------------------------------------------------------------------
// Gesture nella vista reale
// ---------------------------------------------------------------------------

test('1. swipe verso sinistra da Lunedì porta a Martedì', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Lun');
  await gesture(renderer, -200);
  assert.equal(activeChip(renderer), 'Mar', 'giorno successivo selezionato');
  assert.equal(dayColumnsOf(renderer), 1, 'la vista mobile resta a un giorno per schermata');
  await act(async () => { renderer.unmount(); });
});

test('2. swipe verso destra da Martedì torna a Lunedì', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Mar');
  await gesture(renderer, 200);
  assert.equal(activeChip(renderer), 'Lun', 'giorno precedente selezionato');
  await act(async () => { renderer.unmount(); });
});

test('3. swipe verso destra da Lunedì non cambia giorno (nessun wrap-around)', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Lun');
  await gesture(renderer, 260);
  assert.equal(activeChip(renderer), 'Lun', 'nessuna settimana precedente');
  await act(async () => { renderer.unmount(); });
});

test('4. swipe verso sinistra da Venerdì non cambia giorno (nessun wrap-around)', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Ven');
  await gesture(renderer, -260);
  assert.equal(activeChip(renderer), 'Ven', 'nessuna settimana successiva');
  await act(async () => { renderer.unmount(); });
});

test('5. movimento sotto soglia: nessun cambio di giorno', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Mer');
  await gesture(renderer, -(DAY_SWIPE_MIN_DISTANCE_PX - 8));
  assert.equal(activeChip(renderer), 'Mer', 'sotto la soglia orizzontale');
  await gesture(renderer, 20);
  assert.equal(activeChip(renderer), 'Mer', 'anche un tocco breve non cambia giorno');
  await act(async () => { renderer.unmount(); });
});

test('6. movimento prevalentemente verticale: nessun cambio (scroll libero)', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Mer');
  await gesture(renderer, 10, 260);
  assert.equal(activeChip(renderer), 'Mer', 'lo scroll verticale non cambia giorno');
  await gesture(renderer, -14, -320);
  assert.equal(activeChip(renderer), 'Mer', 'nemmeno verso l alto');
  await act(async () => { renderer.unmount(); });
});

test('7. diagonale non sufficientemente orizzontale: nessun cambio', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Gio');
  await gesture(renderer, -60, 50);
  assert.equal(activeChip(renderer), 'Gio', 'diagonale ambigua ignorata');
  await gesture(renderer, 70, 60);
  assert.equal(activeChip(renderer), 'Gio', 'anche nell altro verso');
  await act(async () => { renderer.unmount(); });
});

test('8. una gesture produce al massimo UN cambio di giorno', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Lun');
  await gesture(renderer, -900, 0);
  assert.equal(activeChip(renderer), 'Mar', 'uno swipe lunghissimo avanza di un solo giorno');
  // Un rilascio senza una nuova pressione non è una gesture.
  await gesture(renderer, -900, 0, { releaseWithoutStart: true });
  assert.equal(activeChip(renderer), 'Mar', 'nessun secondo cambio senza pointerdown');
  // E un pointercancel (il browser ha preso lo scroll) scarta il gesto.
  const area = byId(renderer, DAY_AREA_ID);
  await act(async () => {
    area.props.onPointerDown({ pointerType: 'touch', pointerId: 9, clientX: 320, clientY: 400, target: plainSurface });
  });
  await act(async () => { area.props.onPointerCancel({ pointerType: 'touch', pointerId: 9 }); });
  await act(async () => {
    area.props.onPointerUp({ pointerType: 'touch', pointerId: 9, clientX: 40, clientY: 400, target: plainSurface });
  });
  assert.equal(activeChip(renderer), 'Mar', 'gesto annullato dallo scroll: nessun cambio');
  await act(async () => { renderer.unmount(); });
});

test('9. gesto iniziato su un controllo interattivo: nessun cambio di giorno', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Mar');
  await gesture(renderer, -220, 0, { target: interactiveControl });
  assert.equal(activeChip(renderer), 'Mar', 'nessuna interpretazione sopra chip/pulsanti/input');
  // Il controllo resta utilizzabile: il suo onClick continua a funzionare.
  await act(async () => { dayChip(renderer, 'Mer').props.onClick(); });
  assert.equal(activeChip(renderer), 'Mer', 'i chip continuano a rispondere al tocco');
  await act(async () => { renderer.unmount(); });
});

test('10. la selezione tramite chip continua a funzionare (anche "Tutti i giorni")', async () => {
  const renderer = await renderEditor();
  for (const short of CHIP_LABELS) {
    await selectDay(renderer, short);
    assert.equal(dayColumnsOf(renderer), 1, `${short}: una sola colonna giorno`);
  }
  await act(async () => { dayChip(renderer, 'Tutti i giorni').props.onClick(); });
  assert.equal(activeChip(renderer), 'Tutti i giorni');
  assert.equal(dayColumnsOf(renderer), 5, 'la settimana intera torna a schermo');
  // Con "tutti i giorni" lo swipe non sposta nulla: la settimana è già visibile.
  await gesture(renderer, -240);
  assert.equal(activeChip(renderer), 'Tutti i giorni', 'nessun cambio in vista settimanale');
  await act(async () => { renderer.unmount(); });
});

test('11. la navigazione settimana precedente/successiva continua a funzionare', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(WeekView, {
      profile,
      timetable: [mondaySlot],
      events: [],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
    }));
  });
  const byLabel = (label: string) => {
    const found = renderer.root.findAll((el: any) => el.type === 'button' && el.props?.['aria-label'] === label);
    assert.equal(found.length, 1, `pulsante "${label}" presente`);
    return found[0];
  };
  const thisWeek = () => renderer.root.findAll((el: any) => el.type === 'button'
    && /Settimana/.test(flatText(el)) && el.props?.['aria-pressed'] !== undefined)[0];

  assert.equal(thisWeek().props.disabled, true, 'si parte dalla settimana corrente');
  await act(async () => { byLabel('Settimana successiva').props.onClick(); });
  assert.equal(thisWeek().props.disabled, false, 'settimana successiva raggiunta');
  await act(async () => { byLabel('Settimana precedente').props.onClick(); });
  await act(async () => { byLabel('Settimana precedente').props.onClick(); });
  assert.equal(thisWeek().props.disabled, false, 'settimana precedente raggiunta');
  await act(async () => { thisWeek().props.onClick(); });
  assert.equal(thisWeek().props.disabled, true, 'ritorno alla settimana corrente');
  await act(async () => { renderer.unmount(); });
});

test('12. tablet/desktop: nessuna gesture e nessuna regressione della griglia', async () => {
  // Desktop/tablet parte con la settimana intera e il mouse non è una gesture.
  const renderer = await renderEditor();
  assert.equal(activeChip(renderer), 'Tutti i giorni', 'nessun giorno imposto senza il breakpoint mobile');
  assert.equal(dayColumnsOf(renderer), 5, 'la vista larga mostra tutti i giorni');
  const table = renderer.root.find((el: any) => el.type === 'table');
  assert.ok(String(table.props.className).includes('min-w-[620px]'), 'lo scroll orizzontale della settimana resta disponibile');
  await gesture(renderer, -260, 0, { pointerType: 'mouse' });
  assert.equal(activeChip(renderer), 'Tutti i giorni', 'il mouse non cambia la visualizzazione');
  await gesture(renderer, 260, 0, { pointerType: 'mouse' });
  assert.equal(activeChip(renderer), 'Tutti i giorni');
  // Anche un tocco, in vista settimanale, non cambia arbitrariamente la vista.
  await gesture(renderer, -260, 0, { pointerType: 'touch' });
  assert.equal(activeChip(renderer), 'Tutti i giorni', 'nessuna gesture in vista settimanale');
  assert.equal(dayColumnsOf(renderer), 5, 'griglia desktop invariata');
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// Celle libere ("+"): tap = aggiungi lezione, swipe = cambia giorno
// ---------------------------------------------------------------------------

/**
 * Button "+" di una cella libera: è un controllo, ma porta il marcatore
 * semantico della cella, quindi può iniziare uno swipe.
 */
function emptyCellButtonTarget() {
  const self: any = { name: 'empty-cell-button' };
  self.closest = (selector: string) => {
    if (selector === DAY_SWIPE_CELL_SELECTOR) return self;
    if (/button/.test(selector)) return self;
    return null;
  };
  return self;
}

/** Icona dentro il "+": risale al pulsante della cella. */
function emptyCellIconTarget(cellButton: unknown) {
  return { closest: (selector: string) => (selector === DAY_SWIPE_CELL_SELECTOR || /button/.test(selector) ? cellButton : null) };
}

/** Pulsanti "+" renderizzati nella griglia del giorno selezionato. */
function emptyCellButtons(renderer: any) {
  const cells = renderer.root.findAll((el: any) => el.type === 'button' && el.props?.['data-slot-cell'] === 'empty');
  assert.ok(cells.length > 0, 'le celle libere della griglia sono pulsanti "+" marcati');
  return cells;
}

const addLessonModalOpen = (renderer: any) => flatText(renderer.root).includes('Aggiungi Ora di Lezione');

test('13. tap sul "+" della cella libera apre ancora «Aggiungi lezione»', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Mar'); // giorno senza ore: tutte celle libere
  const cells = emptyCellButtons(renderer);
  assert.equal(addLessonModalOpen(renderer), false, 'nessun modale prima del tap');
  await act(async () => { cells[0].props.onClick(); });
  assert.equal(addLessonModalOpen(renderer), true, 'il tap apre il modale di aggiunta');
  await act(async () => { renderer.unmount(); });
});

test('14. swipe sul "+" cambia giorno e il click residuo NON apre «Aggiungi lezione»', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Lun');
  const target = emptyCellButtonTarget();
  await gesture(renderer, -200, 0, { target });
  assert.equal(activeChip(renderer), 'Mar', 'swipe sinistra iniziato sul "+" -> giorno successivo');
  assert.equal(addLessonModalOpen(renderer), false, 'nessun modale dopo lo swipe');
  // Il click che un browser può comunque consegnare al rilascio viene ignorato...
  await act(async () => { emptyCellButtons(renderer)[0].props.onClick(); });
  assert.equal(addLessonModalOpen(renderer), false, 'click residuo soppresso: nessuna apertura');
  // ...e il tap successivo funziona di nuovo (nessuna soppressione permanente).
  await act(async () => { emptyCellButtons(renderer)[0].props.onClick(); });
  assert.equal(addLessonModalOpen(renderer), true, 'il tap seguente apre il modale');
  await act(async () => { renderer.unmount(); });
});

test('15. swipe verso destra sul "+" torna al giorno precedente', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Mer');
  await gesture(renderer, 200, 0, { target: emptyCellButtonTarget() });
  assert.equal(activeChip(renderer), 'Mar', 'swipe destra iniziato sul "+" -> giorno precedente');
  assert.equal(addLessonModalOpen(renderer), false, 'nessun modale dopo lo swipe');
  await act(async () => { renderer.unmount(); });
});

test('16. piccolo movimento sul "+" resta un tap normale', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Lun');
  const target = emptyCellButtonTarget();
  await gesture(renderer, -(DAY_SWIPE_MIN_DISTANCE_PX - 8), 0, { target });
  assert.equal(activeChip(renderer), 'Lun', 'sotto soglia: nessun cambio giorno');
  await act(async () => { emptyCellButtons(renderer)[0].props.onClick(); });
  assert.equal(addLessonModalOpen(renderer), true, 'il tocco breve apre ancora «Aggiungi lezione»');
  await act(async () => { renderer.unmount(); });
});

test('17. scroll verticale iniziato sul "+" non cambia giorno', async () => {
  const renderer = await renderEditor();
  await selectDay(renderer, 'Lun');
  await gesture(renderer, -12, 280, { target: emptyCellButtonTarget() });
  assert.equal(activeChip(renderer), 'Lun', 'lo scroll verticale non è uno swipe');
  await gesture(renderer, 14, -300, { target: emptyCellIconTarget(emptyCellButtonTarget()) });
  assert.equal(activeChip(renderer), 'Lun', 'nemmeno verso l alto, partendo dall icona');
  await act(async () => { renderer.unmount(); });
});

test('18. solo la cella libera è superficie swippabile: gli altri controlli restano esclusi', () => {
  // Il riconoscimento è semantico: attributo della cella, non testo o icona.
  assert.equal(DAY_SWIPE_CELL_SELECTOR, '[data-slot-cell="empty"]');
  assert.ok(!DAY_SWIPE_CELL_SELECTOR.includes('+'), 'nessuna dipendenza dal testo "+"');
  const cellButton = emptyCellButtonTarget();
  assert.equal(isInteractiveSwipeTarget(cellButton), false, 'il "+" può iniziare uno swipe');
  assert.equal(isInteractiveSwipeTarget(emptyCellIconTarget(cellButton)), false, 'anche toccando l icona dentro il "+"');
  assert.equal(isInteractiveSwipeTarget(interactiveControl), true, 'gli altri controlli restano esclusi');
  // Un button generico (chip dei giorni, navigazione, azioni) resta escluso.
  const plainButton = { closest: (selector: string) => (/button/.test(selector) ? { name: 'plain-button' } : null) };
  assert.equal(isInteractiveSwipeTarget(plainButton), true, 'button senza marcatore di cella: escluso');
  for (const control of ['input', 'select', 'textarea', 'a', 'label']) {
    const fake = { closest: (selector: string) => (selector.includes(control) ? { name: control } : null) };
    assert.equal(isInteractiveSwipeTarget(fake), true, `${control} resta escluso`);
  }
});

test('12b. settimana lunga: lo swipe raggiunge il sabato senza uscire dalla settimana', async () => {
  const renderer = await renderEditor({ profile: { ...profile, schoolLevel: 'ssiig' } as TeacherProfile });
  const chips = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Sab');
  assert.equal(chips.length, 1, 'il sabato è disponibile nella settimana lunga');
  await selectDay(renderer, 'Ven');
  await gesture(renderer, -200);
  assert.equal(activeChip(renderer), 'Sab', 'ven -> sab');
  await gesture(renderer, -200);
  assert.equal(activeChip(renderer), 'Sab', 'oltre il sabato non si va');
  await gesture(renderer, 200);
  assert.equal(activeChip(renderer), 'Ven', 'sab -> ven');
  await act(async () => { renderer.unmount(); });
});
