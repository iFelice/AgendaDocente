import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { create, act, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ProfileModal } from '../src/components/ProfileModal';
import { SchoolDayPeriodsEditor } from '../src/components/SchoolDayPeriodsEditor';
import { periodsByDay } from '../src/utils/schoolDayPeriods';
import { generateDefaultPeriodSlots } from '../src/utils/timeSlots';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * STRUTTURA DELLA GIORNATA SCOLASTICA nel Profilo.
 *
 * Configura QUANTE ore prevede la scuola in ciascun giorno (6/6/6/7/6), non
 * quante ne lavora il docente: weeklyDeclaredHours e weeklyHours non entrano
 * nel valore iniziale, nel riepilogo e nel salvataggio.
 *
 * Il dato vive in profile.schools[].dayPeriods — nella primaria per l'istituto
 * principale, nella secondaria per l'altro istituto — e non in uno state React
 * che si perde alla chiusura della modale.
 */

const PRIMARY = 'istituto principale';
const SECONDARY = 'altro istituto';

const baseProfile: TeacherProfile = {
  id: 'p1',
  fullName: 'Prof. Andrea Conti',
  schoolName: 'IC Leonardo Da Vinci',
  email: 'andrea.conti@scuola.edu.it',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Sostegno'],
  classes: ['1A'],
  campuses: ['Sede Centrale'],
  roles: [],
  isSupportTeacher: true,
  weeklyDeclaredHours: 18,
};

function configWithSlots(count: number): TimeSlotConfig {
  return {
    firstHourStartTime: '07:50',
    periodsPerDay: count,
    standardDurationMinutes: 60,
    customSlots: generateDefaultPeriodSlots('07:50', count, 60),
  };
}

interface Mounted {
  renderer: ReactTestRenderer;
  saved: TeacherProfile[];
  rerender: (profile: TeacherProfile, isOpen?: boolean) => Promise<void>;
}

async function mountModal(profile: TeacherProfile, timeSlotConfig?: TimeSlotConfig): Promise<Mounted> {
  const saved: TeacherProfile[] = [];
  const props = (p: TeacherProfile, isOpen = true) => ({
    isOpen,
    onClose: () => {},
    profile: p,
    timeSlotConfig,
    onSaveProfile: (updated: TeacherProfile) => { saved.push(updated); },
    onDataImported: () => {},
    events: [],
    initialTab: 'profilo' as const,
  });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(ProfileModal, props(profile))); });
  return {
    renderer,
    saved,
    rerender: async (next: TeacherProfile, isOpen = true) => {
      await act(async () => { renderer.update(React.createElement(ProfileModal, props(next, isOpen))); });
    },
  };
}

const byLabel = (root: ReactTestInstance, label: string): ReactTestInstance =>
  root.findAll(n => typeof n.type === 'string' && n.props['aria-label'] === label)[0];

const summaryText = (root: ReactTestInstance, context: string): string => {
  const node = byLabel(root, `Riepilogo ore per giorno (${context})`);
  const collect = (instance: ReactTestInstance): string =>
    instance.children.map(child => (typeof child === 'string' ? child : collect(child))).join(' ');
  return collect(node).replace(/\s+/g, ' ').trim();
};

async function setOrdinary(m: Mounted, context: string, value: string) {
  const input = byLabel(m.renderer.root, `Ore ordinarie al giorno (${context})`);
  await act(async () => { input.props.onChange({ target: { value } }); });
}

async function toggleExtras(m: Mounted, context: string, checked: boolean) {
  const box = byLabel(m.renderer.root, `Ci sono giorni con ore aggiuntive (${context})`);
  await act(async () => { box.props.onChange({ target: { checked } }); });
}

async function setExtra(m: Mounted, context: string, dayLabel: string, extra: number) {
  const button = byLabel(m.renderer.root, `${dayLabel} piu ${extra} ore (${context})`);
  await act(async () => { button.props.onClick(); });
}

async function save(m: Mounted) {
  const form = m.renderer.root.findAll(n => n.type === 'form')[0];
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });
}

const primaryOf = (profile: TeacherProfile): SchoolProfile | undefined =>
  (profile.schools ?? []).find(s => s.isPrimary);
const secondaryOf = (profile: TeacherProfile): SchoolProfile | undefined =>
  (profile.schools ?? []).find(s => !s.isPrimary);

// ---------------------------------------------------------------------------
// 1-3. Valore iniziale: legacy dedotto dalle fasce orarie, mai 6 forzato
// ---------------------------------------------------------------------------

test('ProfileModal accetta e usa timeSlotConfig per il valore legacy iniziale', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  assert.equal(byLabel(m.renderer.root, `Ore ordinarie al giorno (${PRIMARY})`).props.value, '6');
  // App.tsx passa davvero la prop alla modale (il valore legacy verrebbe altrimenti
  // dedotto dalla configurazione di default anche per chi ha 7 fasce).
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const profileModalUsage = appSource.slice(appSource.indexOf('<ProfileModal'), appSource.indexOf('<ProfileModal') + 900);
  assert.match(profileModalUsage, /timeSlotConfig=\{timeSlotConfig\}/);
  m.renderer.unmount();
});

test('profilo legacy con configurazione a 6 fasce: ordinario iniziale 6', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  assert.equal(byLabel(m.renderer.root, `Ore ordinarie al giorno (${PRIMARY})`).props.value, '6');
  assert.equal(summaryText(m.renderer.root, PRIMARY), 'Lun 6 · Mar 6 · Mer 6 · Gio 6 · Ven 6');
  m.renderer.unmount();
});

test('profilo legacy con configurazione a 7 fasce: ordinario iniziale 7, non 6', async () => {
  const m = await mountModal(baseProfile, configWithSlots(7));
  assert.equal(byLabel(m.renderer.root, `Ore ordinarie al giorno (${PRIMARY})`).props.value, '7');
  assert.equal(summaryText(m.renderer.root, PRIMARY), 'Lun 7 · Mar 7 · Mer 7 · Gio 7 · Ven 7');
  m.renderer.unmount();
});

// ---------------------------------------------------------------------------
// 4-6. Salvataggio dentro schools[].dayPeriods della primaria
// ---------------------------------------------------------------------------

test('salvataggio senza deroghe: la primaria riceve ordinary con extraPeriodsByDay assente', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await setOrdinary(m, PRIMARY, '6');
  await save(m);
  const primary = primaryOf(m.saved[0]);
  assert.equal(primary?.dayPeriods?.ordinaryPeriodsPerDay, 6);
  assert.equal(primary?.dayPeriods?.extraPeriodsByDay, undefined);
  // Nessun dayPeriods a livello di TeacherProfile: il dato vive nella scuola.
  assert.equal((m.saved[0] as unknown as Record<string, unknown>).dayPeriods, undefined);
  m.renderer.unmount();
});

test('giovedi +1 salva la struttura 6/6/6/7/6 nella primaria', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'giovedì', 1);
  await save(m);
  const dayPeriods = primaryOf(m.saved[0])?.dayPeriods;
  assert.deepEqual(dayPeriods, { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } });
  assert.deepEqual(periodsByDay([1, 2, 3, 4, 5], { dayPeriods }), [6, 6, 6, 7, 6]);
  m.renderer.unmount();
});

test('mercoledi +2 (ottava ora) salva la struttura corretta', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'mercoledì', 2);
  await save(m);
  const dayPeriods = primaryOf(m.saved[0])?.dayPeriods;
  assert.deepEqual(dayPeriods, { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 3: 2 } });
  assert.deepEqual(periodsByDay([1, 2, 3, 4, 5], { dayPeriods }), [6, 6, 8, 6, 6]);
  m.renderer.unmount();
});

// ---------------------------------------------------------------------------
// 7-8. Riepilogo live
// ---------------------------------------------------------------------------

test('riepilogo live 6/6/6/7/6 mentre l utente sceglie', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'giovedì', 1);
  assert.equal(summaryText(m.renderer.root, PRIMARY), 'Lun 6 · Mar 6 · Mer 6 · Gio 7 · Ven 6');
  m.renderer.unmount();
});

test('riepilogo live 6/6/8/6/7 con mercoledi +2 e venerdi +1', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'mercoledì', 2);
  await setExtra(m, PRIMARY, 'venerdì', 1);
  assert.equal(summaryText(m.renderer.root, PRIMARY), 'Lun 6 · Mar 6 · Mer 8 · Gio 6 · Ven 7');
  m.renderer.unmount();
});

test('il riepilogo segue anche il cambio di ore ordinarie', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'giovedì', 1);
  await setOrdinary(m, PRIMARY, '5');
  assert.equal(summaryText(m.renderer.root, PRIMARY), 'Lun 5 · Mar 5 · Mer 5 · Gio 6 · Ven 5');
  m.renderer.unmount();
});

test('i giorni con ore aggiuntive sono evidenziati in ambra, gli altri restano neutri', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'giovedì', 1);
  const summary = byLabel(m.renderer.root, `Riepilogo ore per giorno (${PRIMARY})`);
  const chips = summary.findAll(n => typeof n.type === 'string' && typeof n.props.className === 'string'
    && (n.props.className.includes('amber') || n.props.className.includes('text-stone-600')));
  const amber = chips.filter(c => c.props.className.includes('amber'));
  assert.equal(amber.length, 1, 'solo il giovedi e evidenziato');
  const classes = chips.map(c => c.props.className).join(' ');
  assert.ok(!/red-|green-|emerald-/.test(classes), 'nessun rosso e nessun verde decorativo nel riepilogo');
  m.renderer.unmount();
});

// ---------------------------------------------------------------------------
// 9-10. Toggle OFF e preservazione degli altri campi
// ---------------------------------------------------------------------------

test('toggle OFF: nessuna deroga salvata e i controlli giornalieri spariscono', async () => {
  const withExtras: TeacherProfile = {
    ...baseProfile,
    schools: [{ id: 's1', name: 'IC Leonardo Da Vinci', isPrimary: true, active: true, dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } } }],
  };
  const m = await mountModal(withExtras, configWithSlots(6));
  assert.ok(byLabel(m.renderer.root, `giovedì piu 1 ore (${PRIMARY})`), 'con deroghe salvate il pannello parte aperto');
  await toggleExtras(m, PRIMARY, false);
  assert.equal(byLabel(m.renderer.root, `giovedì piu 1 ore (${PRIMARY})`), undefined, 'i controlli giornalieri sono nascosti');
  assert.equal(summaryText(m.renderer.root, PRIMARY), 'Lun 6 · Mar 6 · Mer 6 · Gio 6 · Ven 6');
  await save(m);
  const dayPeriods = primaryOf(m.saved[0])?.dayPeriods;
  assert.equal(dayPeriods?.extraPeriodsByDay, undefined);
  assert.equal(dayPeriods?.ordinaryPeriodsPerDay, 6, 'spegnere le deroghe non tocca l ordinario');
  m.renderer.unmount();
});

test('il salvataggio preserva tutti gli altri campi della primaria', async () => {
  const rich: TeacherProfile = {
    ...baseProfile,
    schools: [{
      id: 's-primary', name: 'IC Leonardo Da Vinci', institutionalEmail: 'segreteria@scuola.edu.it',
      campuses: ['Sede Centrale'], schoolLevel: 'ssig', weeklyHours: 12,
      isPrimary: true, active: true,
    }],
  };
  const m = await mountModal(rich, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'giovedì', 1);
  await save(m);
  const primary = primaryOf(m.saved[0])!;
  assert.equal(primary.id, 's-primary');
  assert.equal(primary.weeklyHours, 12, 'le ore del docente restano intatte e non sono usate nel calcolo');
  // Le sedi della primaria restano la proiezione del campo legacy del profilo
  // (comportamento gia esistente di normalizeTeacherProfile, non toccato qui).
  assert.deepEqual(primary.campuses, baseProfile.campuses);
  assert.equal(primary.isPrimary, true);
  assert.equal(primary.active, true);
  assert.equal(primary.dayPeriods?.extraPeriodsByDay?.[4], 1);
  assert.equal(m.saved[0].weeklyDeclaredHours, 18, 'il monte ore dichiarato non viene toccato');
  m.renderer.unmount();
});

test('profilo legacy senza schools: dayPeriods finisce nella primaria creata dalla normalizzazione', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  assert.equal(baseProfile.schools, undefined);
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'giovedì', 1);
  await save(m);
  const schools = m.saved[0].schools ?? [];
  assert.equal(schools.length, 1);
  assert.equal(schools[0].isPrimary, true);
  assert.equal(schools[0].name, 'IC Leonardo Da Vinci');
  assert.deepEqual(schools[0].dayPeriods, { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } });
  m.renderer.unmount();
});

// ---------------------------------------------------------------------------
// 11-12. Secondo istituto
// ---------------------------------------------------------------------------

test('il secondo istituto ha una struttura giornaliera indipendente dalla principale', async () => {
  const multi: TeacherProfile = {
    ...baseProfile,
    schools: [
      { id: 's1', name: 'IC Leonardo Da Vinci', isPrimary: true, active: true },
      { id: 's2', name: 'Istituto B', isPrimary: false, active: true },
    ],
  };
  const m = await mountModal(multi, configWithSlots(6));
  // Principale: 6/6/6/7/6
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'giovedì', 1);
  // Secondario: 5/7/5/5/5
  await setOrdinary(m, SECONDARY, '5');
  await toggleExtras(m, SECONDARY, true);
  await setExtra(m, SECONDARY, 'martedì', 2);
  assert.equal(summaryText(m.renderer.root, PRIMARY), 'Lun 6 · Mar 6 · Mer 6 · Gio 7 · Ven 6');
  assert.equal(summaryText(m.renderer.root, SECONDARY), 'Lun 5 · Mar 7 · Mer 5 · Gio 5 · Ven 5');
  await save(m);
  assert.deepEqual(primaryOf(m.saved[0])?.dayPeriods, { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } });
  assert.deepEqual(secondaryOf(m.saved[0])?.dayPeriods, { ordinaryPeriodsPerDay: 5, extraPeriodsByDay: { 2: 2 } });
  m.renderer.unmount();
});

test('disattivare il secondo istituto ne conserva i dayPeriods (solo active: false)', async () => {
  const multi: TeacherProfile = {
    ...baseProfile,
    schools: [
      { id: 's1', name: 'IC Leonardo Da Vinci', isPrimary: true, active: true },
      { id: 's2', name: 'Istituto B', isPrimary: false, active: true, weeklyHours: 6, dayPeriods: { ordinaryPeriodsPerDay: 5, extraPeriodsByDay: { 2: 2 } } },
    ],
  };
  const m = await mountModal(multi, configWithSlots(6));
  const toggle = m.renderer.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox'
    && n.props.className === 'accent-emerald-700')[0];
  await act(async () => { toggle.props.onChange({ target: { checked: false } }); });
  await save(m);
  const secondary = secondaryOf(m.saved[0])!;
  assert.equal(secondary.active, false);
  assert.deepEqual(secondary.dayPeriods, { ordinaryPeriodsPerDay: 5, extraPeriodsByDay: { 2: 2 } });
  assert.equal(secondary.weeklyHours, 6);
  m.renderer.unmount();
});

// ---------------------------------------------------------------------------
// 13-14. Riapertura e profilo aggiornato dall'esterno
// ---------------------------------------------------------------------------

test('riapertura della modale: la configurazione salvata e ancora mostrata', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'giovedì', 1);
  await save(m);
  const persisted = m.saved[0];
  // Chiusura e riapertura con il profilo salvato, come fa App.tsx.
  await m.rerender(persisted, false);
  await m.rerender(persisted, true);
  assert.equal(byLabel(m.renderer.root, `Ore ordinarie al giorno (${PRIMARY})`).props.value, '6');
  assert.equal(summaryText(m.renderer.root, PRIMARY), 'Lun 6 · Mar 6 · Mer 6 · Gio 7 · Ven 6');
  assert.equal(byLabel(m.renderer.root, `giovedì piu 1 ore (${PRIMARY})`).props['aria-pressed'], true);
  m.renderer.unmount();
});

test('profilo aggiornato dall esterno (account sync): la riapertura non mostra stato stale', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  await setExtra(m, PRIMARY, 'giovedì', 2);
  assert.equal(summaryText(m.renderer.root, PRIMARY), 'Lun 6 · Mar 6 · Mer 6 · Gio 8 · Ven 6');
  const fromSync: TeacherProfile = {
    ...baseProfile,
    schools: [{ id: 's1', name: 'IC Leonardo Da Vinci', isPrimary: true, active: true, dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 3: 1 } } }],
  };
  await m.rerender(fromSync, false);
  await m.rerender(fromSync, true);
  assert.equal(summaryText(m.renderer.root, PRIMARY), 'Lun 6 · Mar 6 · Mer 7 · Gio 6 · Ven 6');
  await save(m);
  assert.deepEqual(primaryOf(m.saved[0])?.dayPeriods, { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 3: 1 } });
  m.renderer.unmount();
});

// ---------------------------------------------------------------------------
// 15-17. Confini del passo: niente ore docente, niente +3, target touch
// ---------------------------------------------------------------------------

test('il calcolo della struttura giornaliera non legge le ore del docente', async () => {
  const source = readFileSync(new URL('../src/components/SchoolDayPeriodsEditor.tsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!code.includes('weeklyHours'), 'weeklyHours non deve comparire nell editor');
  assert.ok(!code.includes('weeklyDeclaredHours'), 'weeklyDeclaredHours non deve comparire nell editor');
  // Stesso profilo, carichi diversi: struttura identica.
  const heavy: TeacherProfile = { ...baseProfile, weeklyDeclaredHours: 24, schools: [{ id: 's1', name: 'A', isPrimary: true, active: true, weeklyHours: 24 }] };
  const light: TeacherProfile = { ...baseProfile, weeklyDeclaredHours: 4, schools: [{ id: 's1', name: 'A', isPrimary: true, active: true, weeklyHours: 4 }] };
  const a = await mountModal(heavy, configWithSlots(6));
  const b = await mountModal(light, configWithSlots(6));
  assert.equal(summaryText(a.renderer.root, PRIMARY), summaryText(b.renderer.root, PRIMARY));
  a.renderer.unmount();
  b.renderer.unmount();
});

test('la UI non permette di scegliere piu di +2 in questo passo', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  for (const extra of [0, 1, 2]) {
    assert.ok(byLabel(m.renderer.root, `giovedì piu ${extra} ore (${PRIMARY})`), `+${extra} disponibile`);
  }
  assert.equal(byLabel(m.renderer.root, `giovedì piu 3 ore (${PRIMARY})`), undefined, 'nessun +3 nella UI');
  // Il campo delle ore ordinarie resta entro il tetto dell app.
  const input = byLabel(m.renderer.root, `Ore ordinarie al giorno (${PRIMARY})`);
  assert.equal(input.props.min, 1);
  assert.equal(input.props.max, 12);
  m.renderer.unmount();
});

test('i controlli sono tappabili su smartphone (min-height 44px)', async () => {
  const m = await mountModal(baseProfile, configWithSlots(6));
  await toggleExtras(m, PRIMARY, true);
  const input = byLabel(m.renderer.root, `Ore ordinarie al giorno (${PRIMARY})`);
  assert.match(input.props.className, /min-h-\[44px\]/);
  const choices = m.renderer.root.findAll(n => n.type === 'button' && typeof n.props['aria-pressed'] === 'boolean');
  assert.equal(choices.length, 15, '5 giorni x 3 scelte');
  for (const choice of choices) {
    assert.match(choice.props.className, /min-h-\[44px\]/);
    assert.match(choice.props.className, /min-w-\[44px\]/);
  }
  m.renderer.unmount();
});

test('l editor e un componente riutilizzabile, montabile da solo', async () => {
  const changes: unknown[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(SchoolDayPeriodsEditor, {
      context: 'test',
      value: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
      onChange: (next: unknown) => changes.push(next),
    }));
  });
  assert.equal(summaryText(renderer.root, 'test'), 'Lun 6 · Mar 6 · Mer 6 · Gio 7 · Ven 6');
  await act(async () => { byLabel(renderer.root, 'giovedì piu 0 ore (test)').props.onClick(); });
  assert.deepEqual(changes, [{ ordinaryPeriodsPerDay: 6 }]);
  renderer.unmount();
});
