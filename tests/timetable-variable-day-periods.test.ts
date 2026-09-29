import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { TimetableEditor, DAY_SWIPE_CELL_SELECTOR } from '../src/components/TimetableEditor';
import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * GRIGLIA A RIGHE VARIABILI (micro-passo C2).
 *
 * La griglia non ha più tante righe quante sono le fasce orarie: ne ha quante
 * ne servono fra configurazione della scuola (dayPeriods), fasce realmente
 * configurate e lezioni già salvate. Le celle che il giorno non prevede sono
 * inerti; la riga senza fascia oraria è visibile ma rimanda al drawer di C1.
 *
 * Invarianti sorvegliate qui:
 *  - nessun orario viene MAI inventato (niente PeriodSlot finti, niente
 *    periodTimesForIndex): fuori configurazione si conserva ciò che esiste ma
 *    non si crea nulla di nuovo;
 *  - una cella disabilitata non è una cella libera: niente data-slot-cell;
 *  - il numero di righe non dipende dal filtro giorno del mobile;
 *  - la griglia segue la scuola PRIMARIA.
 */

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

/** Scuola con 6 ore ordinarie e 7 il giovedì: 6/6/6/7/6. */
const profileThursday7: TeacherProfile = {
  ...baseProfile,
  schools: [{
    id: 's1', name: 'IC Leonardo Da Vinci', isPrimary: true, active: true,
    dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
  }],
};

/** Scuola con due ore in più il giovedì: fabbisogno 8. */
const profileThursday8: TeacherProfile = {
  ...baseProfile,
  schools: [{
    id: 's1', name: 'IC Leonardo Da Vinci', isPrimary: true, active: true,
    dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 2 } },
  }],
};

/**
 * Due istituti con dayPeriods diversi: la PRIMARIA ha 7 ore il giovedì, la
 * secondaria ne avrebbe 9 il lunedì. La griglia deve seguire la primaria.
 */
const profileTwoSchools: TeacherProfile = {
  ...baseProfile,
  schools: [
    {
      id: 's1', name: 'IC Leonardo Da Vinci', isPrimary: true, active: true,
      dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
    },
    {
      id: 's2', name: 'IC Secondario', isPrimary: false, active: true,
      dayPeriods: { ordinaryPeriodsPerDay: 8, extraPeriodsByDay: { 1: 1 } },
    },
  ],
};

const slotsFor = (count: number, start = 8) =>
  Array.from({ length: count }, (_, i) => ({
    periodNumber: i + 1,
    label: `${i + 1}ª Ora`,
    startTime: `${String(start + i).padStart(2, '0')}:00`,
    endTime: `${String(start + i + 1).padStart(2, '0')}:00`,
  }));

/** Scansione a 6 fasce reali. */
const config6: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60,
  customSlots: slotsFor(6),
};

/** Scansione a 7 fasce reali. */
const config7: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 7, standardDurationMinutes: 60,
  customSlots: slotsFor(7),
};

/** Scansione a 8 fasce reali. */
const config8: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 8, standardDurationMinutes: 60,
  customSlots: slotsFor(8),
};

interface Mounted {
  renderer: ReactTestRenderer;
  savedConfigs: TimeSlotConfig[];
}

async function mountEditor(
  teacher: TeacherProfile,
  timeSlotConfig?: TimeSlotConfig,
  definitiveTimetable: TimetableSlot[] = []
): Promise<Mounted> {
  const savedConfigs: TimeSlotConfig[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, {
      profile: teacher,
      definitiveTimetable,
      provisionalTimetable: [],
      timetableMode: 'auto' as const,
      activeType: 'definitivo' as const,
      isDefinitiveCompiled: true,
      timeSlotConfig,
      onSaveSlot: () => {},
      onDeleteSlot: () => {},
      onSetTimetableMode: () => {},
      onCopyProvisionalToDefinitive: () => {},
      onCopyDefinitiveToProvisional: () => {},
      onClearTimetable: () => {},
      onSaveTimeSlotConfig: (config: TimeSlotConfig) => { savedConfigs.push(config); },
    }));
  });
  return { renderer, savedConfigs };
}

const textOf = (instance: ReactTestInstance): string =>
  instance.children.map(c => (typeof c === 'string' ? c : textOf(c))).join(' ').replace(/\s+/g, ' ').trim();

/** Righe <tr> del corpo della griglia (una per ora). */
function gridRows(m: Mounted): ReactTestInstance[] {
  const tbody = m.renderer.root.findAll(n => n.type === 'tbody')[0];
  return tbody.findAll(n => n.type === 'tr', { deep: false });
}

/** Celle <td> dei giorni di una riga (esclusa la colonna campana). */
function dayCells(row: ReactTestInstance): ReactTestInstance[] {
  return row.findAll(n => n.type === 'td', { deep: false }).slice(1);
}

/** Bottone "+" (cella libera aggiungibile) dentro una cella, se presente. */
function addButton(cell: ReactTestInstance): ReactTestInstance | undefined {
  return cell.findAll(n => n.type === 'button' && n.props['data-slot-cell'] === 'empty')[0];
}

/** Elemento marcato aria-disabled dentro una cella, se presente. */
function disabledCell(cell: ReactTestInstance): ReactTestInstance | undefined {
  return cell.findAll(n => n.props && n.props['aria-disabled'] === 'true')[0];
}

/** Il modale lezione è aperto? */
const modalOpen = (m: Mounted): boolean =>
  m.renderer.root.findAll(n => n.type === 'h3'
    && /Ora di Lezione/.test(textOf(n))).length > 0;

/** Il select "Numero dell'ora" del modale. */
function periodSelect(m: Mounted): ReactTestInstance {
  const labels = m.renderer.root.findAll(n => n.type === 'label' && /Numero dell'ora/.test(textOf(n)));
  assert.equal(labels.length, 1, 'atteso un solo campo "Numero dell\'ora"');
  const container = m.renderer.root.findAll(n => n.type === 'div'
    && n.findAll(c => c.type === 'label' && /Numero dell'ora/.test(textOf(c))).length === 1
    && n.findAll(c => c.type === 'select').length === 1)[0];
  return container.findAll(n => n.type === 'select')[0];
}

/** Il select "Giorno della settimana" del modale. */
function daySelect(m: Mounted): ReactTestInstance {
  const container = m.renderer.root.findAll(n => n.type === 'div'
    && n.findAll(c => c.type === 'label' && /Giorno della settimana/.test(textOf(c))).length === 1
    && n.findAll(c => c.type === 'select').length === 1)[0];
  return container.findAll(n => n.type === 'select')[0];
}

const periodOptions = (m: Mounted): number[] =>
  periodSelect(m).findAll(n => n.type === 'option').map(o => Number(o.props.value));

/** Testo dell'avviso inline di clamp, se presente. */
function clampNotice(m: Mounted): string | null {
  const node = m.renderer.root.findAll(n => n.props && n.props.role === 'status'
    && /prevede \d+ ore/.test(textOf(n)) && /spostata/.test(textOf(n)))[0];
  return node ? textOf(node) : null;
}

const drawerOpen = (m: Mounted): boolean =>
  m.renderer.root.findAll(n => n.type === 'button' && textOf(n) === 'Salva Fasce Orarie').length > 0;

/** Chip del filtro giorno mobile con l'etichetta indicata. */
function dayChip(m: Mounted, short: string): ReactTestInstance {
  return m.renderer.root.findAll(n => n.type === 'button' && textOf(n) === short)[0];
}

// ---------------------------------------------------------------------------
// Griglia variabile
// ---------------------------------------------------------------------------

test('6/6/6/7/6 con 7 fasce reali: la griglia ha 7 righe', async () => {
  const m = await mountEditor(profileThursday7, config7);
  assert.equal(gridRows(m).length, 7);
});

test('riga 7: disabilitata Lun/Mar/Mer/Ven, aggiungibile solo il Giovedì', async () => {
  const m = await mountEditor(profileThursday7, config7);
  const cells = dayCells(gridRows(m)[6]);
  // Settimana SSIG: lunedì-venerdì, il giovedì è la quarta colonna (indice 3).
  assert.equal(cells.length, 5);
  cells.forEach((cell, index) => {
    if (index === 3) {
      assert.ok(addButton(cell), 'la 7ª ora del giovedì deve essere aggiungibile');
      assert.equal(disabledCell(cell), undefined);
    } else {
      assert.equal(addButton(cell), undefined, `colonna ${index} non deve essere aggiungibile`);
      assert.ok(disabledCell(cell), `colonna ${index} deve essere inerte`);
    }
  });
});

test('celle disabilitate: nessun "+", nessun onClick, nessun data-slot-cell="empty"', async () => {
  const m = await mountEditor(profileThursday7, config7);
  const lunedi = dayCells(gridRows(m)[6])[0];
  const inert = disabledCell(lunedi)!;

  assert.equal(inert.props.onClick, undefined, 'la cella inerte non deve avere handler');
  assert.equal(inert.props['data-slot-cell'], undefined);
  assert.equal(
    lunedi.findAll(n => n.props && n.props['data-slot-cell'] === 'empty').length,
    0,
    'la cella disabilitata non deve entrare nel selettore di swipe'
  );
  assert.match(String(inert.props.title), /prevede 6 ore/);
  // Il selettore usato dallo swipe resta quello e nessuno lo soddisfa qui.
  assert.equal(DAY_SWIPE_CELL_SELECTOR, '[data-slot-cell="empty"]');
});

test('configurazione con +2 il giovedì e 8 fasce reali: 8 righe', async () => {
  const m = await mountEditor(profileThursday8, config8);
  assert.equal(gridRows(m).length, 8);
  const cells = dayCells(gridRows(m)[7]);
  assert.ok(addButton(cells[3]), 'la 8ª ora del giovedì è aggiungibile');
  assert.ok(disabledCell(cells[0]), 'la 8ª ora del lunedì è inerte');
});

test('dayPeriods assente: rendering equivalente al comportamento precedente', async () => {
  const m = await mountEditor(baseProfile, config6);
  const rows = gridRows(m);
  assert.equal(rows.length, 6, 'tante righe quante le fasce configurate');
  for (const row of rows) {
    for (const cell of dayCells(row)) {
      assert.ok(addButton(cell), 'ogni cella libera resta aggiungibile');
      assert.equal(disabledCell(cell), undefined);
    }
  }
});

test('più fasce configurate del fabbisogno: nessuna riga sparisce', async () => {
  // Scuola a 6 ore ovunque, ma il docente ha 8 fasce configurate.
  const m = await mountEditor(baseProfile, config8);
  assert.equal(gridRows(m).length, 8);
});

// ---------------------------------------------------------------------------
// Riga prevista ma fascia oraria mancante
// ---------------------------------------------------------------------------

test('fabbisogno 7 con 6 fasce: riga 7 visibile, "Orario da configurare", nessuna cella aggiungibile', async () => {
  const m = await mountEditor(profileThursday7, config6);
  const rows = gridRows(m);
  assert.equal(rows.length, 7, 'la riga 7 deve esistere anche senza la sua fascia');

  const bell = rows[6].findAll(n => n.type === 'td', { deep: false })[0];
  const bellText = textOf(bell);
  assert.match(bellText, /7ª Ora/);
  assert.match(bellText, /Orario da configurare/);
  assert.match(bellText, /Configura 7ª ora/);

  // Nemmeno il giovedì, che ammetterebbe 7 ore, può ricevere una lezione:
  // non esiste ancora una fascia oraria reale.
  for (const cell of dayCells(rows[6])) {
    assert.equal(addButton(cell), undefined);
    assert.ok(disabledCell(cell));
  }
});

test('"Configura 7ª ora" apre il drawer delle fasce orarie', async () => {
  const m = await mountEditor(profileThursday7, config6);
  assert.equal(drawerOpen(m), false);

  const action = m.renderer.root.findAll(n => n.type === 'button'
    && textOf(n) === 'Configura 7ª ora')[0];
  assert.ok(action, 'azione "Configura 7ª ora" presente');
  await act(async () => { action.props.onClick(); });

  assert.equal(drawerOpen(m), true);
  assert.equal(m.savedConfigs.length, 0, 'aprire il drawer non persiste nulla');
});

// ---------------------------------------------------------------------------
// Slot legacy fuori configurazione
// ---------------------------------------------------------------------------

test('slot legacy Lunedì/7 con lunedì a 6 ore: visibile, apribile, marcato fuori configurazione', async () => {
  const legacy: TimetableSlot = {
    id: 'legacy-1', dayOfWeek: 1, periodNumber: 7,
    startTime: '14:00', endTime: '15:00',
    subject: 'Matematica', className: '1A', classroom: 'Aula 3',
  };
  const m = await mountEditor(profileThursday7, config7, [legacy]);

  const rows = gridRows(m);
  assert.equal(rows.length, 7);

  const lunedi = dayCells(rows[6])[0];
  assert.match(textOf(lunedi), /Matematica/, 'la lezione legacy resta leggibile');

  const card = lunedi.findAll(n => n.type === 'div' && typeof n.props.onClick === 'function')[0];
  assert.ok(card, 'la lezione legacy resta interattiva');
  assert.equal(card.props.title, 'Ora non prevista dalla configurazione della scuola');
  assert.match(String(card.props.className), /amber/, 'marcatura visiva ambra');

  await act(async () => { card.props.onClick(); });
  assert.equal(modalOpen(m), true, 'la lezione legacy si apre normalmente');
});

test('cella legacy VUOTA torna non aggiungibile: si conserva, non si crea', async () => {
  // Stessa coordinata del test precedente ma senza lezione salvata.
  const m = await mountEditor(profileThursday7, config7);
  const lunedi7 = dayCells(gridRows(m)[6])[0];
  assert.equal(addButton(lunedi7), undefined);
  assert.ok(disabledCell(lunedi7));
});

// ---------------------------------------------------------------------------
// Modale: opzioni ora per giorno e clamp
// ---------------------------------------------------------------------------

/** Apre il modale sulla coordinata indicata usando il "+" della griglia. */
async function openAddAt(m: Mounted, rowIndex: number, dayIndex: number) {
  const cell = dayCells(gridRows(m)[rowIndex])[dayIndex];
  const button = addButton(cell);
  assert.ok(button, `cella riga ${rowIndex + 1} colonna ${dayIndex} non aggiungibile`);
  await act(async () => { button!.props.onClick(); });
  assert.equal(modalOpen(m), true);
}

test('modale sul Lunedì: opzioni ora 1..6', async () => {
  const m = await mountEditor(profileThursday7, config7);
  await openAddAt(m, 0, 0);
  assert.deepEqual(periodOptions(m), [1, 2, 3, 4, 5, 6]);
});

test('modale sul Giovedì: opzioni ora 1..7', async () => {
  const m = await mountEditor(profileThursday7, config7);
  await openAddAt(m, 0, 3);
  assert.deepEqual(periodOptions(m), [1, 2, 3, 4, 5, 6, 7]);
});

test('Gio/7 → Lun: clamp alla 6ª, orari riallineati, avviso inline', async () => {
  const m = await mountEditor(profileThursday7, config7);
  await openAddAt(m, 6, 3); // giovedì, 7ª ora
  assert.equal(Number(periodSelect(m).props.value), 7);
  assert.equal(clampNotice(m), null, 'nessun avviso prima del cambio giorno');

  await act(async () => { daySelect(m).props.onChange({ target: { value: '1' } }); });

  assert.equal(Number(daySelect(m).props.value), 1, 'il cambio giorno non viene bloccato');
  assert.equal(Number(periodSelect(m).props.value), 6, 'clamp alla 6ª ora');

  const notice = clampNotice(m);
  assert.ok(notice, 'avviso inline visibile');
  assert.match(notice!, /lunedì prevede 6 ore/);
  assert.match(notice!, /6ª/);

  // Orari riallineati alla 6ª fascia REALE (13:00–14:00), non inventati.
  const sixth = slotsFor(7)[5];
  const times = m.renderer.root.findAll(n => n.type === 'input' && n.props.type === 'time');
  const values = times.map(t => t.props.value);
  assert.ok(values.includes(sixth.startTime), `atteso start ${sixth.startTime}, trovati ${values.join(',')}`);
  assert.ok(values.includes(sixth.endTime), `atteso end ${sixth.endTime}, trovati ${values.join(',')}`);

  // Le opzioni si sono ristrette al nuovo giorno.
  assert.deepEqual(periodOptions(m), [1, 2, 3, 4, 5, 6]);
});

test('Gio/5 → Lun: il periodo resta 5 e non compare alcun avviso', async () => {
  const m = await mountEditor(profileThursday7, config7);
  await openAddAt(m, 4, 3); // giovedì, 5ª ora
  assert.equal(Number(periodSelect(m).props.value), 5);

  await act(async () => { daySelect(m).props.onChange({ target: { value: '1' } }); });

  assert.equal(Number(daySelect(m).props.value), 1);
  assert.equal(Number(periodSelect(m).props.value), 5, 'periodo valido: nessuno spostamento');
  assert.equal(clampNotice(m), null, 'nessun avviso di clamp');
});

test('avviso di clamp: sparisce quando non è più pertinente', async () => {
  const m = await mountEditor(profileThursday7, config7);
  await openAddAt(m, 6, 3);
  await act(async () => { daySelect(m).props.onChange({ target: { value: '1' } }); });
  assert.ok(clampNotice(m), 'avviso presente dopo il clamp');

  // Scelta esplicita dell'utente sul numero dell'ora: l'avviso non serve più.
  await act(async () => { periodSelect(m).props.onChange({ target: { value: '3' } }); });
  assert.equal(clampNotice(m), null);
});

// ---------------------------------------------------------------------------
// Mobile / swipe
// ---------------------------------------------------------------------------

test('le celle disabilitate non sono celle libere per le gesture di swipe', async () => {
  const m = await mountEditor(profileThursday7, config7);
  const allEmptyMarkers = m.renderer.root.findAll(n => n.props && n.props['data-slot-cell'] === 'empty');
  // 6 righe piene × 5 giorni + la sola 7ª del giovedì.
  assert.equal(allEmptyMarkers.length, 6 * 5 + 1);
  for (const marker of allEmptyMarkers) {
    assert.notEqual(marker.props['aria-disabled'], 'true');
  }
});

test('il numero di righe non cambia passando da un giorno all\'altro nel filtro mobile', async () => {
  const m = await mountEditor(profileThursday7, config6);
  assert.equal(gridRows(m).length, 7);

  for (const short of ['Lun', 'Mar', 'Gio', 'Ven']) {
    const chip = dayChip(m, short);
    if (!chip) continue;
    await act(async () => { chip.props.onClick(); });
    assert.equal(gridRows(m).length, 7, `righe invariate sul filtro ${short}`);
  }
});

// ---------------------------------------------------------------------------
// Multi-istituto
// ---------------------------------------------------------------------------

test('con due istituti la griglia segue la scuola PRIMARIA', async () => {
  const m = await mountEditor(profileTwoSchools, config7);
  // Primaria: 6/6/6/7/6 → 7 righe. La secondaria (8+1) non deve influire.
  assert.equal(gridRows(m).length, 7);
  const cells = dayCells(gridRows(m)[6]);
  assert.ok(addButton(cells[3]), 'il giovedì della primaria ammette la 7ª');
  assert.ok(disabledCell(cells[0]), 'il lunedì resta a 6 ore: la secondaria non conta');
});
