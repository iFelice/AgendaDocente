import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TimetableEditor } from '../src/components/TimetableEditor';
import { legacyPrimarySchoolId } from '../src/utils/multiSchool';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/**
 * MICRO-PASSO G2 — FASCE ORARIE CONTESTUALI ALL'ISTITUTO MOSTRATO.
 *
 * G1 ha introdotto `SchoolProfile.timeSlotConfig` e la regola di lettura, ma
 * nessuno la consumava. Qui il TimetableEditor diventa il primo consumatore:
 * la griglia mostra le campane dell'istituto selezionato e il drawer modifica
 * QUELLE, non più il singleton del docente.
 *
 * Due istituti che iniziano a orari diversi — 08:00 e 08:15 — smettono di
 * essere indistinguibili. La configurazione globale resta il default di chi
 * non si è ancora personalizzato e non viene più sovrascritta dal drawer.
 *
 * Fuori da questo passo: viste del Planning e scanner (G3) e il riallineamento
 * delle lezioni già salvate quando le campane cambiano (G4).
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SCHOOL_B_ID = 'school-liceo-verdi';

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Rossi',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: [], roles: [], isSupportTeacher: true,
};
const PRIMARY_ID = legacyPrimarySchoolId(baseProfile);

/** Campane globali del docente: 08:00, ore piene. */
const globalConfig: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60,
  customSlots: Array.from({ length: 6 }, (_, i) => ({
    periodNumber: i + 1, label: `${i + 1}ª Ora`,
    startTime: `${String(8 + i).padStart(2, '0')}:00`,
    endTime: `${String(9 + i).padStart(2, '0')}:00`,
  })),
};

/** Campane proprie di B: 08:15 e ore da 50 minuti. Otto fasce. */
const configB: TimeSlotConfig = {
  firstHourStartTime: '08:15', periodsPerDay: 8, standardDurationMinutes: 50,
  customSlots: [
    { periodNumber: 1, label: '1ª Ora', startTime: '08:15', endTime: '09:10' },
    { periodNumber: 2, label: '2ª Ora', startTime: '09:10', endTime: '10:05' },
    { periodNumber: 3, label: '3ª Ora', startTime: '10:05', endTime: '11:00' },
    { periodNumber: 4, label: '4ª Ora', startTime: '11:00', endTime: '11:55' },
    { periodNumber: 5, label: '5ª Ora', startTime: '11:55', endTime: '12:50' },
    { periodNumber: 6, label: '6ª Ora', startTime: '12:50', endTime: '13:45' },
    { periodNumber: 7, label: '7ª Ora', startTime: '13:45', endTime: '14:40' },
    { periodNumber: 8, label: '8ª Ora', startTime: '14:40', endTime: '15:35' },
  ],
};

const schoolA = (over: Partial<SchoolProfile> = {}): SchoolProfile => ({
  id: PRIMARY_ID, name: 'IC Rossi', isPrimary: true, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 6 }, ...over,
});
const schoolB = (over: Partial<SchoolProfile> = {}): SchoolProfile => ({
  id: SCHOOL_B_ID, name: 'Liceo Verdi', isPrimary: false, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 8 }, ...over,
});

const singleSchoolProfile: TeacherProfile = { ...baseProfile, schools: [schoolA()] };
const bothPlain: TeacherProfile = { ...baseProfile, schools: [schoolA(), schoolB()] };
const bWithOwnConfig: TeacherProfile = {
  ...baseProfile, schools: [schoolA(), schoolB({ timeSlotConfig: configB })],
};

function editorProps(overrides: Record<string, unknown> = {}) {
  return {
    profile: bWithOwnConfig,
    definitiveTimetable: [] as TimetableSlot[],
    provisionalTimetable: [] as TimetableSlot[],
    timetableMode: 'auto' as const,
    activeType: 'definitivo' as const,
    isDefinitiveCompiled: true,
    timeSlotConfig: globalConfig,
    onSaveSlot: () => {},
    onDeleteSlot: () => {},
    onSetTimetableMode: () => {},
    onCopyProvisionalToDefinitive: () => {},
    onCopyDefinitiveToProvisional: () => {},
    onClearTimetable: () => {},
    ...overrides,
  };
}

async function renderEditor(overrides: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, editorProps(overrides) as any));
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
const rootText = (renderer: any) => flatText(renderer.root);

const findById = (renderer: any, id: string) => renderer.root.findAll((el: any) => el.props?.id === id);
function byId(renderer: any, id: string) {
  const found = findById(renderer, id);
  assert.ok(found.length > 0, `elemento con id "${id}" assente`);
  return found[0];
}
const schoolSelect = (renderer: any) => byId(renderer, 'timetable-school-select');
async function selectSchool(renderer: any, schoolId: string) {
  await act(async () => { schoolSelect(renderer).props.onChange({ target: { value: schoolId } }); });
}
function buttonWithText(renderer: any, text: string) {
  return renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).includes(text))[0];
}
async function openDrawer(renderer: any) {
  await act(async () => { buttonWithText(renderer, 'Fasce Orarie').props.onClick(); });
}
async function saveDrawer(renderer: any) {
  await act(async () => { buttonWithText(renderer, 'Salva Fasce Orarie').props.onClick(); });
}
const drawerOpen = (renderer: any) => rootText(renderer).includes('Configurazione Fasce Orarie');

/** Gli orari mostrati nella colonna "Campana" della griglia. */
const bellTimes = (renderer: any): string[] => {
  const matches = rootText(renderer).match(/\d{2}:\d{2}\s*–\s*\d{2}:\d{2}/g) ?? [];
  return matches.map(m => m.replace(/\s/g, ''));
};
const lessonCells = (renderer: any) =>
  renderer.root.findAll((el: any) => el.type === 'div' && String(el.props?.className ?? '').includes('cursor-pointer'));
const addTitles = (renderer: any): string[] =>
  renderer.root
    .findAll((el: any) => el.type === 'button' && String(el.props?.title ?? '').startsWith('Aggiungi lezione'))
    .map((el: any) => String(el.props.title));
async function clickAdd(renderer: any, dayLabel: string, periodLabel: string) {
  const button = renderer.root.findAll(
    (el: any) => el.type === 'button' && String(el.props?.title ?? '') === `Aggiungi lezione ${dayLabel} ${periodLabel}`,
  )[0];
  assert.ok(button, `cella "+" ${dayLabel} ${periodLabel} assente`);
  await act(async () => { button.props.onClick(); });
}
function formOf(renderer: any) {
  const forms = renderer.root.findAll((el: any) => el.type === 'form');
  assert.equal(forms.length, 1, 'il modale della lezione è aperto');
  return forms[0];
}
const daySelect = (renderer: any) => byId(renderer, 'slot-day');
const periodSelect = (renderer: any) => byId(renderer, 'slot-period');
const timeInputs = (renderer: any) => formOf(renderer).findAll((el: any) => el.props?.type === 'time');

// ---------------------------------------------------------------------------
// 1-2. Risoluzione della config attiva
// ---------------------------------------------------------------------------

test('G2/1. istituto senza campane proprie: la griglia usa quelle globali', async () => {
  const renderer = await renderEditor({ profile: bothPlain });
  try {
    assert.ok(bellTimes(renderer).includes('08:00–09:00'), 'A eredita la globale');
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.ok(bellTimes(renderer).includes('08:00–09:00'), 'anche B, finché non si personalizza');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G2/2-3. istituto con campane proprie: cambiando selettore cambia la colonna Campana', async () => {
  const renderer = await renderEditor();
  try {
    const timesA = bellTimes(renderer);
    assert.ok(timesA.includes('08:00–09:00'), 'A: globale ereditata');
    assert.equal(timesA.includes('08:15–09:10'), false, 'nessuna contaminazione da B');

    await selectSchool(renderer, SCHOOL_B_ID);
    const timesB = bellTimes(renderer);
    assert.ok(timesB.includes('08:15–09:10'), 'B: campane proprie');
    assert.ok(timesB.includes('14:40–15:35'), 'fino all 8ª di B');
    assert.equal(timesB.includes('08:00–09:00'), false, 'la globale non compare più');

    // Ritorno ad A: nessuna contaminazione residua.
    await selectSchool(renderer, PRIMARY_ID);
    assert.deepEqual(bellTimes(renderer), timesA, 'A torna esattamente com era');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G2/4-5. customSlots diversi e rowCount secondo la config attiva', async () => {
  const renderer = await renderEditor();
  try {
    const rowsOf = (r: any) => r.root.findAll((el: any) => el.type === 'tr').length;
    const rowsA = rowsOf(renderer);
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.ok(rowsOf(renderer) > rowsA, 'B ha 8 fasce proprie: più righe di A');
    await selectSchool(renderer, PRIMARY_ID);
    assert.equal(rowsOf(renderer), rowsA, 'e tornando ad A le righe tornano 6');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G2/24. alternare A → B → A → B non contamina griglia né stato', async () => {
  const renderer = await renderEditor();
  try {
    const snapshots: string[][] = [];
    for (const id of [PRIMARY_ID, SCHOOL_B_ID, PRIMARY_ID, SCHOOL_B_ID]) {
      await selectSchool(renderer, id);
      snapshots.push(bellTimes(renderer));
    }
    assert.deepEqual(snapshots[0], snapshots[2], 'A identica alla seconda visita');
    assert.deepEqual(snapshots[1], snapshots[3], 'B identica alla seconda visita');
    assert.notDeepEqual(snapshots[0], snapshots[1], 'e le due restano distinte');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 6-7. C1 banner e righe virtuali C2
// ---------------------------------------------------------------------------

test('G2/6-7. banner C1 e riga virtuale seguono dayPeriods E config dell istituto attivo', async () => {
  // B: 8 ore al giorno ma solo 7 fasce proprie -> manca 1 fascia.
  const sevenSlots: TimeSlotConfig = {
    ...configB, periodsPerDay: 7, customSlots: configB.customSlots!.slice(0, 7),
  };
  const profile: TeacherProfile = {
    ...baseProfile, schools: [schoolA(), schoolB({ timeSlotConfig: sevenSlots })],
  };
  const renderer = await renderEditor({ profile });
  try {
    // A: 6 ore e 6 fasce globali -> nessun avviso, nessuna riga virtuale.
    await openDrawer(renderer);
    assert.equal(/manca 1 fascia oraria|mancano \d+ fasce orarie|fasce in più/.test(rootText(renderer)), false, 'A è a posto');
    await act(async () => { buttonWithText(renderer, 'Annulla').props.onClick(); });
    assert.equal(rootText(renderer).includes('Orario da configurare'), false, 'A: nessuna riga virtuale');

    // B: l 8ª ora esiste per dayPeriods ma non ha una fascia -> riga virtuale.
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.match(rootText(renderer), /Orario da configurare/, 'B: riga 8 virtuale');
    await openDrawer(renderer);
    assert.match(rootText(renderer), /8 ore previste dalla tua scuola|prevede 8 ore in almeno un giorno/, 'il fabbisogno è quello di B');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 8-11. Creazione e modifica lezioni
// ---------------------------------------------------------------------------

test('G2/8. la nuova lezione di B nasce con gli orari di B', async () => {
  const saved: TimetableSlot[] = [];
  const renderer = await renderEditor({ onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); } });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    await clickAdd(renderer, 'Lunedì', '3ª Ora');
    const [start, end] = timeInputs(renderer);
    assert.equal(start.props.value, '10:05', 'orario di inizio dalla 3ª di B');
    assert.equal(end.props.value, '11:00', 'orario di fine dalla 3ª di B');

    const classSelect = formOf(renderer).findAllByType('select')[2];
    await act(async () => { classSelect.props.onChange({ target: { value: '1A' } }); });
    await act(async () => { await formOf(renderer).props.onSubmit({ preventDefault() {} }); });
    assert.equal(saved[0].schoolId, SCHOOL_B_ID);
    assert.equal(saved[0].startTime, '10:05', 'gli orari salvati sono quelli di B');
    assert.equal(saved[0].endTime, '11:00');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G2/8b. la nuova lezione della primaria resta sugli orari globali', async () => {
  const saved: TimetableSlot[] = [];
  const renderer = await renderEditor({ onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); } });
  try {
    await clickAdd(renderer, 'Lunedì', '3ª Ora');
    const [start] = timeInputs(renderer);
    assert.equal(start.props.value, '10:00', 'A eredita ancora la globale');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G2/9-10. cambio ora e cambio giorno di una lezione di B usano le fasce di B', async () => {
  const slotB: TimetableSlot = {
    id: 'tt-b', dayOfWeek: 1, periodNumber: 1, startTime: '08:15', endTime: '09:10',
    subject: 'Latino', className: '2E', schoolId: SCHOOL_B_ID,
  };
  const renderer = await renderEditor({ definitiveTimetable: [slotB] });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    await act(async () => { lessonCells(renderer)[0].props.onClick(); });

    // Cambio ora: gli orari si riallineano alla fascia di B, non della globale.
    await act(async () => { periodSelect(renderer).props.onChange({ target: { value: '4' } }); });
    let [start, end] = timeInputs(renderer);
    assert.equal(start.props.value, '11:00', '4ª di B');
    assert.equal(end.props.value, '11:55');

    // Le ore selezionabili sono le otto di B.
    assert.deepEqual(
      periodSelect(renderer).props.children.map((o: any) => Number(o.props.value)),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );

    // Cambio giorno: nessun clamp (B ammette 8 ore ogni giorno) e orari di B.
    await act(async () => { daySelect(renderer).props.onChange({ target: { value: '5' } }); });
    [start, end] = timeInputs(renderer);
    assert.equal(periodSelect(renderer).props.value, 4, 'ora invariata');
    assert.equal(start.props.value, '11:00', 'orari sempre di B');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G2/11. lezione di B aperta da Oggi/Settimana: fasce di B anche partendo da A', async () => {
  const slotB8: TimetableSlot = {
    id: 'tt-b8', dayOfWeek: 1, periodNumber: 8, startTime: '14:40', endTime: '15:35',
    subject: 'Greco', className: '2E', schoolId: SCHOOL_B_ID,
  };
  const renderer = await renderEditor({
    definitiveTimetable: [slotB8],
    initialSlot: slotB8,
    initialSlotType: 'definitivo' as const,
  });
  try {
    assert.equal(schoolSelect(renderer).props.value, SCHOOL_B_ID, 'la griglia è passata a B (F2)');
    assert.equal(periodSelect(renderer).props.value, 8, 'nessun falso clamp sulle 6 ore della globale');
    assert.deepEqual(
      periodSelect(renderer).props.children.map((o: any) => Number(o.props.value)),
      [1, 2, 3, 4, 5, 6, 7, 8],
      'le ore offerte sono le otto di B',
    );
    // Riallineando l ora si usano comunque le campane di B.
    await act(async () => { periodSelect(renderer).props.onChange({ target: { value: '7' } }); });
    assert.equal(timeInputs(renderer)[0].props.value, '13:45', '7ª di B');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 12-21. Drawer
// ---------------------------------------------------------------------------

test('G2/12-13. il drawer apre la config della scuola attiva (propria o globale)', async () => {
  const renderer = await renderEditor();
  try {
    // A non ha config propria: parte dalla globale.
    await openDrawer(renderer);
    assert.match(rootText(renderer), /08:00 – 09:00/, 'A: punto di partenza globale');
    await act(async () => { buttonWithText(renderer, 'Annulla').props.onClick(); });

    // B ha le sue: il drawer le mostra.
    await selectSchool(renderer, SCHOOL_B_ID);
    await openDrawer(renderer);
    assert.match(rootText(renderer), /08:15 – 09:10/, 'B: campane proprie nel draft');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G2/19. il nome dell istituto compare nel drawer solo con più scuole', async () => {
  const multi = await renderEditor();
  try {
    await selectSchool(multi, SCHOOL_B_ID);
    await openDrawer(multi);
    assert.equal(flatText(byId(multi, 'slot-config-school')), 'Liceo Verdi');
  } finally {
    await act(async () => { multi.unmount(); });
  }

  const single = await renderEditor({ profile: singleSchoolProfile });
  try {
    await openDrawer(single);
    assert.equal(findById(single, 'slot-config-school').length, 0, 'una sola scuola: nessun testo ridondante');
  } finally {
    await act(async () => { single.unmount(); });
  }
});

test('G2/20-21. il selettore istituto è bloccato mentre il drawer è aperto', async () => {
  const renderer = await renderEditor();
  try {
    assert.equal(schoolSelect(renderer).props.disabled, false, 'libero a drawer chiuso');
    await selectSchool(renderer, SCHOOL_B_ID);
    await openDrawer(renderer);
    assert.equal(schoolSelect(renderer).props.disabled, true, 'bloccato: il draft appartiene a B');
    assert.ok(drawerOpen(renderer), 'il drawer NON viene chiuso');
    await act(async () => { buttonWithText(renderer, 'Annulla').props.onClick(); });
    assert.equal(schoolSelect(renderer).props.disabled, false, 'chiuso il drawer, si può cambiare');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G2/14-16. salvare il drawer scrive sulla scuola, non sulla globale', async () => {
  const savedSchoolConfigs: Array<{ schoolId: string; config: TimeSlotConfig }> = [];
  const savedGlobal: TimeSlotConfig[] = [];
  const renderer = await renderEditor({
    profile: bothPlain,
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig) => { savedSchoolConfigs.push({ schoolId, config }); },
    onSaveTimeSlotConfig: (config: TimeSlotConfig) => { savedGlobal.push(config); },
  });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    await openDrawer(renderer);
    // Modifica dell'ora di inizio nel draft.
    const startInput = renderer.root.findAll((el: any) => el.props?.type === 'time')[0];
    await act(async () => { startInput.props.onChange({ target: { value: '08:15' } }); });
    await saveDrawer(renderer);

    assert.equal(savedSchoolConfigs.length, 1, 'salvata una config di istituto');
    assert.equal(savedSchoolConfigs[0].schoolId, SCHOOL_B_ID, 'proprio B');
    assert.equal(savedSchoolConfigs[0].config.firstHourStartTime, '08:15');
    assert.equal(savedGlobal.length, 0, 'la configurazione GLOBALE non viene toccata');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G2/8c. la scuola del drawer è catturata all APERTURA, non riletta al salvataggio', async () => {
  const saved: Array<{ schoolId: string; config: TimeSlotConfig }> = [];
  const renderer = await renderEditor({
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig) => { saved.push({ schoolId, config }); },
  });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    await openDrawer(renderer);
    // Il selettore è bloccato: anche forzando l'evento, il draft resta di B.
    await act(async () => { schoolSelect(renderer).props.onChange({ target: { value: PRIMARY_ID } }); });
    await saveDrawer(renderer);
    assert.equal(saved[0].schoolId, SCHOOL_B_ID, 'salvata su B, la scuola con cui il drawer era stato aperto');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G2/17-18. riaprendo il drawer si vede la config appena salvata, custom inclusa', async () => {
  // Simula il giro completo: il profilo torna aggiornato come farebbe l'App.
  let profile: TeacherProfile = bothPlain;
  let renderer = await renderEditor({
    profile,
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig) => {
      profile = {
        ...profile,
        schools: (profile.schools ?? []).map(s => (s.id === schoolId ? { ...s, timeSlotConfig: config } : s)),
      };
    },
  });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    await openDrawer(renderer);
    const startInput = renderer.root.findAll((el: any) => el.props?.type === 'time')[0];
    await act(async () => { startInput.props.onChange({ target: { value: '08:15' } }); });
    await saveDrawer(renderer);
  } finally {
    await act(async () => { renderer.unmount(); });
  }

  const b = (profile.schools ?? []).find(s => s.id === SCHOOL_B_ID);
  const a = (profile.schools ?? []).find(s => s.id === PRIMARY_ID);
  assert.equal(b?.timeSlotConfig?.firstHourStartTime, '08:15', 'B personalizzata');
  assert.ok((b?.timeSlotConfig?.customSlots?.length ?? 0) > 0, 'le fasce sono materializzate');
  assert.equal(a?.timeSlotConfig, undefined, 'A resta senza config propria');

  // Riapertura con il profilo aggiornato: il drawer mostra la config salvata.
  renderer = await renderEditor({ profile });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.ok(bellTimes(renderer).includes('08:15–09:15'), 'la griglia usa le nuove campane di B');
    await openDrawer(renderer);
    assert.match(rootText(renderer), /08:15/, 'il drawer riparte da quelle');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 22-23. Personalizzazione progressiva
// ---------------------------------------------------------------------------

test('G2/22-23. personalizzare B lascia A sulla globale, e viceversa', async () => {
  const onlyB: TeacherProfile = {
    ...baseProfile, schools: [schoolA(), schoolB({ timeSlotConfig: configB })],
  };
  let renderer = await renderEditor({ profile: onlyB });
  try {
    assert.ok(bellTimes(renderer).includes('08:00–09:00'), 'A: ancora globale');
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.ok(bellTimes(renderer).includes('08:15–09:10'), 'B: la sua');
  } finally {
    await act(async () => { renderer.unmount(); });
  }

  // Ora anche A ha la sua, diversa da entrambe.
  const configA: TimeSlotConfig = {
    firstHourStartTime: '07:45', periodsPerDay: 6, standardDurationMinutes: 55,
    customSlots: [{ periodNumber: 1, label: '1ª Ora', startTime: '07:45', endTime: '08:40' }],
  };
  const bothOwn: TeacherProfile = {
    ...baseProfile, schools: [schoolA({ timeSlotConfig: configA }), schoolB({ timeSlotConfig: configB })],
  };
  renderer = await renderEditor({ profile: bothOwn });
  try {
    assert.ok(bellTimes(renderer).includes('07:45–08:40'), 'A: la sua');
    assert.equal(bellTimes(renderer).includes('08:15–09:10'), false, 'niente B in A');
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.ok(bellTimes(renderer).includes('08:15–09:10'), 'B invariata');
    assert.equal(bellTimes(renderer).includes('07:45–08:40'), false, 'niente A in B');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 24-27. Una sola scuola
// ---------------------------------------------------------------------------

test('G2/24-27. una sola scuola: UI invariata, drawer dalla globale, salvataggio sulla primaria', async () => {
  const savedSchoolConfigs: Array<{ schoolId: string; config: TimeSlotConfig }> = [];
  const savedGlobal: TimeSlotConfig[] = [];
  const renderer = await renderEditor({
    profile: singleSchoolProfile,
    onSaveSchoolTimeSlotConfig: (schoolId: string, config: TimeSlotConfig) => { savedSchoolConfigs.push({ schoolId, config }); },
    onSaveTimeSlotConfig: (config: TimeSlotConfig) => { savedGlobal.push(config); },
  });
  try {
    assert.equal(findById(renderer, 'timetable-school-select').length, 0, 'nessun selettore');
    assert.ok(bellTimes(renderer).includes('08:00–09:00'), 'griglia identica a prima');

    await openDrawer(renderer);
    assert.equal(findById(renderer, 'slot-config-school').length, 0, 'nessun nome istituto');
    assert.match(rootText(renderer), /08:00 – 09:00/, 'il drawer parte dalla globale');

    const startInput = renderer.root.findAll((el: any) => el.props?.type === 'time')[0];
    await act(async () => { startInput.props.onChange({ target: { value: '08:10' } }); });
    await saveDrawer(renderer);

    // Comportamento NUOVO e voluto: la modifica diventa la config della
    // primaria; la globale resta il default legacy e non viene riscritta.
    assert.equal(savedSchoolConfigs.length, 1);
    assert.equal(savedSchoolConfigs[0].schoolId, PRIMARY_ID, 'salvata sulla primaria');
    assert.equal(savedSchoolConfigs[0].config.firstHourStartTime, '08:10');
    assert.equal(savedGlobal.length, 0, 'la globale non viene più toccata dal drawer');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 28. G4 non anticipato
// ---------------------------------------------------------------------------

test('G2/28. cambiare le campane NON tocca le lezioni già salvate (spetta a G4)', async () => {
  const slotB: TimetableSlot = {
    id: 'tt-b3', dayOfWeek: 1, periodNumber: 3, startTime: '10:05', endTime: '11:00',
    subject: 'Latino', className: '2E', schoolId: SCHOOL_B_ID,
  };
  const timetable = [slotB];
  const savedSlots: TimetableSlot[] = [];
  const renderer = await renderEditor({
    definitiveTimetable: timetable,
    onSaveSlot: (slot: TimetableSlot) => { savedSlots.push(slot); },
    onSaveSchoolTimeSlotConfig: () => {},
  });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    await openDrawer(renderer);
    const startInput = renderer.root.findAll((el: any) => el.props?.type === 'time')[0];
    await act(async () => { startInput.props.onChange({ target: { value: '08:30' } }); });
    await saveDrawer(renderer);

    assert.equal(savedSlots.length, 0, 'nessuna lezione riscritta');
    assert.equal(timetable[0].startTime, '10:05', 'la lezione conserva i suoi orari storici');
    assert.deepEqual(timetable, [slotB], 'array in ingresso intatto');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});
