import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { TimetableEditor, resizePeriodSlotsDraft } from '../src/components/TimetableEditor';
import { getEffectivePeriodSlots } from '../src/utils/timeSlots';
import { MAX_PERIODS_PER_DAY } from '../src/utils/schoolDayPeriods';
import type { PeriodSlot, TeacherProfile, TimeSlotConfig } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * FASCE ORARIE SUFFICIENTI (micro-passo C1).
 *
 * Se l'istituto prevede 7 ore il giovedì ma la scansione oraria del docente ne
 * descrive 6, manca la fascia della 7ª ora. Qui si copre SOLO la creazione di
 * quella fascia: fabbisogno, avviso nel drawer, estensione del draft e
 * salvataggio esplicito. La griglia (righe, celle abilitate) resta invariata:
 * è il micro-passo C2.
 *
 * Invariante trasversale: nulla viene persistito prima di "Salva", e con
 * dayPeriods assente il comportamento e identico a prima.
 */

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

/** Stesso docente, ma la scuola ha 7 ore il giovedì (6 ordinarie + 1). */
const profileWithThursdayExtra: TeacherProfile = {
  ...profile,
  schools: [{
    id: 's1', name: 'IC Leonardo Da Vinci', isPrimary: true, active: true,
    dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
  }],
};

/** Scansione AUTOMATICA a 6 fasce (coincide con la generazione standard). */
const autoConfig6: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60,
  customSlots: [
    { periodNumber: 1, label: '1ª Ora', startTime: '08:00', endTime: '09:00' },
    { periodNumber: 2, label: '2ª Ora', startTime: '09:00', endTime: '10:00' },
    { periodNumber: 3, label: '3ª Ora', startTime: '10:00', endTime: '11:00' },
    { periodNumber: 4, label: '4ª Ora', startTime: '11:00', endTime: '12:00' },
    { periodNumber: 5, label: '5ª Ora', startTime: '12:00', endTime: '13:00' },
    { periodNumber: 6, label: '6ª Ora', startTime: '13:00', endTime: '14:00' },
  ],
};

/** Scansione PERSONALIZZATA a 6 fasce: ore da 55 minuti e un intervallo lungo. */
const customConfig6: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60,
  customSlots: [
    { periodNumber: 1, label: '1ª Ora', startTime: '08:00', endTime: '08:55' },
    { periodNumber: 2, label: '2ª Ora', startTime: '08:55', endTime: '09:50' },
    { periodNumber: 3, label: '3ª Ora', startTime: '10:10', endTime: '11:05' },
    { periodNumber: 4, label: '4ª Ora', startTime: '11:05', endTime: '12:00' },
    { periodNumber: 5, label: '5ª Ora', startTime: '12:10', endTime: '13:05' },
    { periodNumber: 6, label: '6ª Ora', startTime: '13:05', endTime: '14:00' },
  ],
};

interface Mounted {
  renderer: ReactTestRenderer;
  savedConfigs: TimeSlotConfig[];
}

async function mountEditor(
  teacher: TeacherProfile,
  timeSlotConfig?: TimeSlotConfig
): Promise<Mounted> {
  const savedConfigs: TimeSlotConfig[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, {
      profile: teacher,
      definitiveTimetable: [],
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

/** Apre il drawer "Fasce orarie" cliccando il bottone che lo controlla. */
async function openDrawer(m: Mounted) {
  const trigger = m.renderer.root.findAll(n => n.type === 'button'
    && typeof n.props.title === 'string' && /fasce|scansione/i.test(n.props.title))[0]
    ?? m.renderer.root.findAll(n => n.type === 'button' && /Fasce/i.test(textOf(n)))[0];
  await act(async () => { trigger.props.onClick(); });
}

/** Righe editabili del pannello "Personalizzazione avanzata" (una per fascia). */
function draftRows(m: Mounted): ReactTestInstance[] {
  return m.renderer.root.findAll(n => typeof n.type === 'string'
    && typeof n.props.className === 'string'
    && n.props.className.includes('flex items-center gap-2 p-2')
    && n.findAll(c => c.type === 'input' && c.props.type === 'time').length === 2);
}

function draftTimes(m: Mounted): Array<{ startTime: string; endTime: string }> {
  return draftRows(m).map(row => {
    const inputs = row.findAll(c => c.type === 'input' && c.props.type === 'time');
    return { startTime: inputs[0].props.value, endTime: inputs[1].props.value };
  });
}

const countInput = (m: Mounted): ReactTestInstance =>
  m.renderer.root.findAll(n => n.type === 'input' && n.props.type === 'number'
    && n.props.max === MAX_PERIODS_PER_DAY && n.props.min === '1')[0];

async function setCount(m: Mounted, value: number) {
  await act(async () => { countInput(m).props.onChange({ target: { value: String(value) } }); });
}

async function showAdvanced(m: Mounted) {
  const toggle = m.renderer.root.findAll(n => n.type === 'button'
    && /Personalizzazione avanzata/i.test(textOf(n)))[0];
  if (draftRows(m).length === 0) await act(async () => { toggle.props.onClick(); });
}

const warningText = (m: Mounted): string | undefined => {
  const node = m.renderer.root.findAll(n => typeof n.type === 'string' && n.props.role === 'status')[0];
  return node ? textOf(node) : undefined;
};

async function saveDrawer(m: Mounted) {
  const saveButton = m.renderer.root.findAll(n => n.type === 'button' && textOf(n) === 'Salva Fasce Orarie')[0];
  await act(async () => { await saveButton.props.onClick(); });
}

// ---------------------------------------------------------------------------
// resizePeriodSlotsDraft: la regola di estensione, isolata
// ---------------------------------------------------------------------------

test('resizePeriodSlotsDraft estende continuando dall endTime precedente', () => {
  const slots: PeriodSlot[] = [
    { periodNumber: 1, label: '1ª Ora', startTime: '08:00', endTime: '08:55' },
    { periodNumber: 2, label: '2ª Ora', startTime: '08:55', endTime: '09:50' },
  ];
  const extended = resizePeriodSlotsDraft(slots, 4, 55);
  assert.equal(extended.length, 4);
  assert.deepEqual(extended[2], { periodNumber: 3, label: '3ª Ora', startTime: '09:50', endTime: '10:45' });
  assert.deepEqual(extended[3], { periodNumber: 4, label: '4ª Ora', startTime: '10:45', endTime: '11:40' });
  // Le fasce preesistenti non vengono toccate.
  assert.deepEqual(extended.slice(0, 2), slots);
});

test('resizePeriodSlotsDraft tronca in coda e rispetta il tetto di 12', () => {
  const slots = resizePeriodSlotsDraft([{ periodNumber: 1, startTime: '08:00', endTime: '09:00' }], 7, 60);
  assert.equal(slots.length, 7);
  assert.equal(resizePeriodSlotsDraft(slots, 6, 60).length, 6);
  assert.deepEqual(resizePeriodSlotsDraft(slots, 6, 60), slots.slice(0, 6));
  assert.equal(resizePeriodSlotsDraft(slots, 40, 60).length, MAX_PERIODS_PER_DAY);
  assert.equal(resizePeriodSlotsDraft(slots, 0, 60).length, 1);
});

// ---------------------------------------------------------------------------
// 1. AUTO: fabbisogno 7 con 6 fasce -> 7ª proposta
// ---------------------------------------------------------------------------

test('AUTO: con 7 ore il giovedi e 6 fasce, la 7ª viene pre-proposta come continuazione', async () => {
  const m = await mountEditor(profileWithThursdayExtra, autoConfig6);
  await openDrawer(m);
  await showAdvanced(m);
  const times = draftTimes(m);
  assert.equal(times.length, 7, 'il draft mostra 7 fasce');
  assert.deepEqual(times[6], { startTime: '14:00', endTime: '15:00' }, 'la 7ª continua dalla 6ª con la durata standard');
  assert.match(warningText(m) ?? '', /7 ore/);
  assert.match(warningText(m) ?? '', /proposto/i);
  m.renderer.unmount();
});

// ---------------------------------------------------------------------------
// 2-4. CUSTOM: il campo "Nº fasce orarie" agisce davvero sul draft
// ---------------------------------------------------------------------------

test('CUSTOM: portare il numero da 6 a 7 estende davvero customSlotsDraft', async () => {
  const m = await mountEditor(profile, customConfig6);
  await openDrawer(m);
  await showAdvanced(m);
  assert.equal(draftRows(m).length, 6);
  await setCount(m, 7);
  assert.equal(draftRows(m).length, 7, 'il campo non e piu inerte in modalita personalizzata');
  m.renderer.unmount();
});

test('CUSTOM: la fascia aggiunta continua dall endTime della precedente, non da una scala automatica', async () => {
  const m = await mountEditor(profile, customConfig6);
  await openDrawer(m);
  await showAdvanced(m);
  await setCount(m, 7);
  const times = draftTimes(m);
  assert.deepEqual(times[5], { startTime: '13:05', endTime: '14:00' }, 'la 6ª resta invariata');
  assert.deepEqual(times[6], { startTime: '14:00', endTime: '15:00' }, 'la 7ª parte dalla fine della 6ª');
  // Le fasce personalizzate precedenti non vengono ricalcolate.
  assert.deepEqual(times.slice(0, 6).map(t => t.startTime), ['08:00', '08:55', '10:10', '11:05', '12:10', '13:05']);
  m.renderer.unmount();
});

test('CUSTOM: tornare da 7 a 6 tronca il draft', async () => {
  const m = await mountEditor(profile, customConfig6);
  await openDrawer(m);
  await showAdvanced(m);
  await setCount(m, 7);
  assert.equal(draftRows(m).length, 7);
  await setCount(m, 6);
  assert.equal(draftRows(m).length, 6);
  assert.deepEqual(draftTimes(m)[5], { startTime: '13:05', endTime: '14:00' }, 'la 6ª originale sopravvive alla troncatura');
  m.renderer.unmount();
});

test('CUSTOM: l avviso segnala la fascia mancante e l azione la aggiunge come bozza da verificare', async () => {
  const m = await mountEditor(profileWithThursdayExtra, customConfig6);
  await openDrawer(m);
  assert.match(warningText(m) ?? '', /La tua scuola prevede 7 ore in almeno un giorno/);
  assert.match(warningText(m) ?? '', /manca 1 fascia oraria/);
  // In CUSTOM nulla viene pre-proposto: il draft resta a 6 finche l utente non agisce.
  await showAdvanced(m);
  assert.equal(draftRows(m).length, 6);

  const action = m.renderer.root.findAll(n => n.type === 'button' && /Completa la fascia mancante/i.test(textOf(n)))[0];
  await act(async () => { action.props.onClick(); });

  const rows = draftRows(m);
  assert.equal(rows.length, 7);
  assert.deepEqual(draftTimes(m)[6], { startTime: '14:00', endTime: '15:00' });
  assert.match(textOf(rows[6]), /Da verificare/, 'la nuova fascia e marcata come da verificare');
  assert.ok(!/Da verificare/.test(textOf(rows[5])), 'le fasce gia confermate non sono marcate');
  // Campi orari immediatamente modificabili.
  const inputs = rows[6].findAll(c => c.type === 'input' && c.props.type === 'time');
  assert.equal(inputs.length, 2);
  await act(async () => { inputs[1].props.onChange({ target: { value: '14:55' } }); });
  assert.deepEqual(draftTimes(m)[6], { startTime: '14:00', endTime: '14:55' });
  assert.equal(warningText(m), undefined, 'coperto il fabbisogno, l avviso sparisce');
  m.renderer.unmount();
});

// ---------------------------------------------------------------------------
// 5-6. Persistenza solo su "Salva"
// ---------------------------------------------------------------------------

test('nessuna fascia viene persistita prima di Salva', async () => {
  const m = await mountEditor(profileWithThursdayExtra, customConfig6);
  await openDrawer(m);
  await showAdvanced(m);
  await setCount(m, 7);
  assert.deepEqual(m.savedConfigs, [], 'estendere il draft non salva');

  const auto = await mountEditor(profileWithThursdayExtra, autoConfig6);
  await openDrawer(auto);
  assert.deepEqual(auto.savedConfigs, [], 'nemmeno la pre-proposta automatica salva');
  m.renderer.unmount();
  auto.renderer.unmount();
});

test('dopo Salva la configurazione contiene davvero 7 fasce', async () => {
  const m = await mountEditor(profileWithThursdayExtra, customConfig6);
  await openDrawer(m);
  await showAdvanced(m);
  await setCount(m, 7);
  await saveDrawer(m);
  assert.equal(m.savedConfigs.length, 1);
  const saved = m.savedConfigs[0];
  assert.equal(saved.periodsPerDay, 7);
  assert.equal(getEffectivePeriodSlots(saved).length, 7);
  assert.deepEqual(getEffectivePeriodSlots(saved)[6], {
    periodNumber: 7, label: '7ª Ora', startTime: '14:00', endTime: '15:00',
  });
  // Le fasce personalizzate preesistenti sopravvivono al salvataggio.
  assert.equal(getEffectivePeriodSlots(saved)[2].startTime, '10:10');
  m.renderer.unmount();
});

test('AUTO: dopo Salva la scansione automatica estesa vale 7 fasce', async () => {
  const m = await mountEditor(profileWithThursdayExtra, autoConfig6);
  await openDrawer(m);
  await saveDrawer(m);
  assert.equal(m.savedConfigs.length, 1);
  assert.equal(getEffectivePeriodSlots(m.savedConfigs[0]).length, 7);
  m.renderer.unmount();
});

// ---------------------------------------------------------------------------
// 7. First-use wizard
// ---------------------------------------------------------------------------

test('il wizard di primo accesso parla di fasce orarie e arriva a 12', async () => {
  const m = await mountEditor(profile, undefined);
  const labels = m.renderer.root.findAll(n => n.type === 'label').map(textOf);
  assert.ok(labels.includes('Nº fasce orarie'), `atteso "Nº fasce orarie", trovati: ${labels.join(' | ')}`);
  assert.ok(!labels.includes('Nº Ore Giornaliere'), 'la vecchia etichetta non deve piu comparire');

  const field = m.renderer.root.findAll(n => n.type === 'input' && n.props.type === 'number'
    && n.props.max === MAX_PERIODS_PER_DAY)[0];
  assert.equal(field.props.max, 12);
  assert.equal(field.props.min, '1');
  // Il clamp accetta 12 e rifiuta 13.
  await act(async () => { field.props.onChange({ target: { value: '12' } }); });
  assert.equal(countInput(m).props.value, 12);
  await act(async () => { countInput(m).props.onChange({ target: { value: '13' } }); });
  assert.equal(countInput(m).props.value, 12);

  const page = textOf(m.renderer.root.findAll(n => n.type === 'div')[0]);
  assert.match(page, /Quante fasce orarie prevede la scansione della tua scuola/);
  assert.match(page, /lo imposti nel Profilo dell'istituto/);
  m.renderer.unmount();
});

// ---------------------------------------------------------------------------
// 8. Non-regressione: senza dayPeriods tutto come prima
// ---------------------------------------------------------------------------

test('senza dayPeriods non c e alcun fabbisogno extra: nessun avviso, nessuna proposta', async () => {
  for (const config of [autoConfig6, customConfig6]) {
    const m = await mountEditor(profile, config);
    await openDrawer(m);
    assert.equal(warningText(m), undefined, 'nessun avviso di fasce mancanti');
    await showAdvanced(m);
    assert.equal(draftRows(m).length, 6, 'il draft resta quello configurato');
    assert.ok(!draftRows(m).some(r => /Da verificare/.test(textOf(r))), 'nessuna fascia marcata');
    await saveDrawer(m);
    assert.equal(m.savedConfigs[0].periodsPerDay, 6, 'il salvataggio non cambia il numero di fasce');
    assert.equal(getEffectivePeriodSlots(m.savedConfigs[0]).length, 6);
    m.renderer.unmount();
  }
});

test('la griglia non viene toccata da C1: le righe restano quelle delle fasce configurate', async () => {
  // Il fabbisogno e 7, ma finche non si salva la 7ª fascia la griglia mostra 6 righe
  // esattamente come prima: il rendering variabile e il micro-passo C2.
  const m = await mountEditor(profileWithThursdayExtra, autoConfig6);
  const rows = m.renderer.root.findAll(n => n.type === 'tr');
  assert.equal(rows.length - 1, 6, 'intestazione esclusa: 6 righe come la configurazione oraria');
  m.renderer.unmount();
});
