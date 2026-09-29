import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { DocumentScannerModal, formatWeekStructureSummary } from '../src/components/DocumentScannerModal';
import {
  applyReconstruction,
  partitionReconstructedSlots,
  reconstructedToTimetableSlots,
  slotOccupancyKey,
} from '../src/utils/reconstructTimetable';
import { derivePersonalScannerPeriodsByDay } from '../src/utils/scannerWeekGeometry';
import { legacyPrimarySchoolId, schoolByIdOrPrimary, normalizeTeacherProfile } from '../src/utils/multiSchool';
import type { ReconstructedSlot } from '../src/utils/timetableCrossref';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/**
 * MICRO-PASSO F5 — SCANSIONE SULLA SCUOLA SELEZIONATA.
 *
 * Lo scanner sapeva già a quale istituto era destinato l'import, ma leggeva il
 * documento con la geometria della PRIMARIA: struttura della settimana proposta
 * (D3) e validazione delle ore (D1) ignoravano la scelta. Per un istituto con
 * giornate più lunghe della primaria il risultato era il peggiore possibile —
 * ore realmente esistenti scartate come "non previste dal giorno", e slot
 * salvati con lo `schoolId` di una scuola diversa da quella con cui erano stati
 * validati.
 *
 * Dopo F5 una sola identità attraversa tutta la catena:
 * prefill -> prompt -> parser -> D1 -> `schoolId` salvato.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SCHOOL_B_ID = 'school-liceo-verdi';

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Felice Manganiello', schoolName: 'IC Rossi',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'], campuses: [], roles: [], isSupportTeacher: true,
};
const PRIMARY_ID = legacyPrimarySchoolId(baseProfile);

/** A (primaria): 6 ore, giovedì 7 -> 6/6/6/7/6. */
const schoolA: SchoolProfile = {
  id: PRIMARY_ID, name: 'IC Rossi', isPrimary: true, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
};
/** B: 8 ore, mercoledì e venerdì 7 -> 8/8/7/8/7. */
const schoolB: SchoolProfile = {
  id: SCHOOL_B_ID, name: 'Liceo Verdi', isPrimary: false, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 8, extraPeriodsByDay: { 3: -1, 5: -1 } as never },
};
/** B senza correzioni: 8 ore tutti i giorni (il modello non sa accorciare). */
const schoolB8: SchoolProfile = {
  id: SCHOOL_B_ID, name: 'Liceo Verdi', isPrimary: false, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 8 },
};

const singleSchoolProfile: TeacherProfile = { ...baseProfile, schools: [schoolA] };
const multiSchoolProfile: TeacherProfile = { ...baseProfile, schools: [schoolA, schoolB8] };

const config = (count: number): TimeSlotConfig => ({
  firstHourStartTime: '08:00', periodsPerDay: count, standardDurationMinutes: 60,
  customSlots: Array.from({ length: count }, (_, i) => ({
    periodNumber: i + 1,
    label: `${i + 1}ª Ora`,
    startTime: `${String(8 + i).padStart(2, '0')}:00`,
    endTime: `${String(9 + i).padStart(2, '0')}:00`,
  })),
});

let seq = 0;
function item(dayOfWeek: number, periodIndex: number, classLabel = '3D'): ReconstructedSlot {
  seq += 1;
  return {
    id: `r-${seq}`, dayOfWeek, periodIndex, classLabel,
    coTeachingSubjects: [], status: 'ok', confidence: 'high', selected: true,
  } as unknown as ReconstructedSlot;
}

// ---------------------------------------------------------------------------
// 1-4. Prefill D3 sulla scuola selezionata (dominio)
// ---------------------------------------------------------------------------

test('F5/1-2. la geometria proposta è quella della scuola scelta, non della primaria', () => {
  const schools = normalizeTeacherProfile(multiSchoolProfile).schools ?? [];
  const forA = derivePersonalScannerPeriodsByDay(schoolByIdOrPrimary(PRIMARY_ID, schools), config(8));
  const forB = derivePersonalScannerPeriodsByDay(schoolByIdOrPrimary(SCHOOL_B_ID, schools), config(8));
  assert.deepEqual(forA, [6, 6, 6, 7, 6], 'A: giovedì lungo');
  assert.deepEqual(forB, [8, 8, 8, 8, 8], 'B: otto ore');
  assert.equal(formatWeekStructureSummary(forB), 'Lun 8 · Mar 8 · Mer 8 · Gio 8 · Ven 8');
});

test('F5/8-9. id assente o orfano: la scuola resta la primaria', () => {
  const schools = normalizeTeacherProfile(multiSchoolProfile).schools ?? [];
  assert.equal(schoolByIdOrPrimary(undefined, schools)?.id, PRIMARY_ID);
  assert.equal(schoolByIdOrPrimary('school-rimossa', schools)?.id, PRIMARY_ID);
  assert.deepEqual(
    derivePersonalScannerPeriodsByDay(schoolByIdOrPrimary('school-rimossa', schools), config(8)),
    [6, 6, 6, 7, 6],
    'geometria della primaria, non una geometria inventata',
  );
});

test("F5/17. derivePersonalScannerPeriodsByDay resta indifferente a profilo e id", () => {
  // Riceve una SchoolProfile e basta: è il chiamante a scegliere la scuola.
  // Separazione progettata in D3 e che F5 non deve erodere.
  assert.deepEqual(derivePersonalScannerPeriodsByDay(schoolB8, config(8)), [8, 8, 8, 8, 8]);
  assert.deepEqual(derivePersonalScannerPeriodsByDay(undefined, config(5)), [5, 5, 5, 5, 5]);
});

// ---------------------------------------------------------------------------
// 5-9. D1 valida sulla scuola di destinazione
// ---------------------------------------------------------------------------

test('F5/5-6. Lun/8: accettato destinando a B (8 ore), rifiutato destinando ad A (6)', () => {
  const toB = partitionReconstructedSlots([item(1, 8)], {
    profile: multiSchoolProfile, timeSlotConfig: config(8), schoolId: SCHOOL_B_ID,
  });
  assert.equal(toB.rejected.length, 0, 'B ammette l 8ª del lunedì');
  assert.equal(toB.slots.length, 1);
  assert.equal(toB.slots[0].schoolId, SCHOOL_B_ID, 'validata e scritta sulla stessa scuola');
  assert.equal(toB.slots[0].periodNumber, 8);

  const toA = partitionReconstructedSlots([item(1, 8)], {
    profile: multiSchoolProfile, timeSlotConfig: config(8), schoolId: PRIMARY_ID,
  });
  assert.equal(toA.slots.length, 0, 'A si ferma alla 6ª');
  assert.equal(toA.rejected[0].reason, 'day-not-allowed');
});

test('F5/7. B ammette 8 ore ma le fasce globali sono 6: scartata per fascia mancante', () => {
  // `timeSlotConfig` resta GLOBALE: il giorno prevede l'ora, ma non esiste un
  // orario reale a cui agganciarla. Il motivo deve dirlo con precisione.
  const partition = partitionReconstructedSlots([item(1, 8), item(1, 6)], {
    profile: multiSchoolProfile, timeSlotConfig: config(6), schoolId: SCHOOL_B_ID,
  });
  assert.equal(partition.rejected.length, 1);
  assert.equal(partition.rejected[0].reason, 'missing-period-slot', 'non "day-not-allowed": il giorno la prevede');
  assert.equal(partition.slots.length, 1, 'la 6ª, che ha una fascia reale, entra');
});

test('F5/8b-9b. schoolId assente o orfano in D1: geometria e scrittura sulla primaria', () => {
  // Assente: comportamento storico, nessun chiamante legacy rotto.
  const noId = partitionReconstructedSlots([item(4, 7), item(1, 7)], {
    profile: multiSchoolProfile, timeSlotConfig: config(8),
  });
  assert.equal(noId.slots.length, 1, 'Gio/7 ammesso dalla primaria');
  assert.equal(noId.slots[0].schoolId, PRIMARY_ID);
  assert.equal(noId.rejected[0].reason, 'day-not-allowed', 'Lun/7 no: la primaria ne ha 6');

  // Orfano: non crasha, non propaga l'id inesistente, ricade sulla primaria.
  const orphan = partitionReconstructedSlots([item(4, 7)], {
    profile: multiSchoolProfile, timeSlotConfig: config(8), schoolId: 'school-rimossa',
  });
  assert.equal(orphan.slots.length, 1);
  assert.equal(orphan.slots[0].schoolId, PRIMARY_ID, 'mai un id orfano sugli slot salvati');
});

test('F5/11. nessun disallineamento fra geometria di validazione e schoolId scritto', () => {
  const schools = normalizeTeacherProfile(multiSchoolProfile).schools ?? [];
  for (const requested of [PRIMARY_ID, SCHOOL_B_ID, 'school-rimossa', undefined]) {
    const expected = schoolByIdOrPrimary(requested, schools)!;
    // Ora ammessa solo da B: dice da sola quale geometria è stata applicata.
    const partition = partitionReconstructedSlots([item(1, 8)], {
      profile: multiSchoolProfile, timeSlotConfig: config(8), schoolId: requested,
    });
    const accepted = partition.slots.length === 1;
    assert.equal(accepted, expected.id === SCHOOL_B_ID, `geometria di ${expected.name}`);
    if (accepted) {
      assert.equal(partition.slots[0].schoolId, expected.id, 'lo slot porta la scuola con cui è stato validato');
    }
  }
});

// ---------------------------------------------------------------------------
// 12-14. Merge (invariato, ma verificato school-aware)
// ---------------------------------------------------------------------------

test('F5/12-13. A/Lun1 esistente + B/Lun1 importato: entrambi sopravvivono (missing-only)', () => {
  const existing: TimetableSlot[] = [{
    id: 'ex-a', dayOfWeek: 1, periodNumber: 1, startTime: '08:00', endTime: '09:00',
    subject: 'Sostegno', className: '3D', schoolId: PRIMARY_ID,
  }];
  const incoming = reconstructedToTimetableSlots([item(1, 1, '3E')], {
    profile: multiSchoolProfile, timeSlotConfig: config(8), schoolId: SCHOOL_B_ID,
  });
  assert.equal(incoming[0].schoolId, SCHOOL_B_ID);

  const merged = applyReconstruction(existing, incoming, 'missing-only', { profile: multiSchoolProfile });
  assert.equal(merged.slots.length, 2, 'stessa coordinata, istituti diversi: nessun overwrite');
  assert.equal(merged.addedCount, 1);
  assert.equal(merged.replacedCount, 0);
  assert.ok(merged.slots.some(s => s.id === 'ex-a'), 'la lezione della primaria resta');
  // Le due chiavi di occupazione sono diverse: è questo che le tiene separate.
  assert.notEqual(
    slotOccupancyKey(existing[0], multiSchoolProfile),
    slotOccupancyKey(incoming[0], multiSchoolProfile),
  );
});

test('F5/14. replace-scope resta circoscritto all istituto importato', () => {
  const existing: TimetableSlot[] = [
    { id: 'ex-a', dayOfWeek: 1, periodNumber: 1, startTime: '08:00', endTime: '09:00', subject: 'Sostegno', className: '3D', schoolId: PRIMARY_ID },
    { id: 'ex-b', dayOfWeek: 2, periodNumber: 1, startTime: '08:00', endTime: '09:00', subject: 'Sostegno', className: '3E', schoolId: SCHOOL_B_ID },
  ];
  const incoming = reconstructedToTimetableSlots([item(1, 1, '3E')], {
    profile: multiSchoolProfile, timeSlotConfig: config(8), schoolId: SCHOOL_B_ID,
  });
  const merged = applyReconstruction(existing, incoming, 'replace-scope', { profile: multiSchoolProfile });
  assert.ok(merged.slots.some(s => s.id === 'ex-a'), 'le ore della primaria non sono in ambito');
  assert.equal(merged.slots.some(s => s.id === 'ex-b'), false, 'le vecchie ore di B sono sostituite');
  assert.equal(merged.slots.filter(s => s.schoolId === SCHOOL_B_ID).length, 1);
});

// ---------------------------------------------------------------------------
// UI: scelta pre-scan, reset della conferma, congelamento
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
const findById = (renderer: any, id: string) => renderer.root.findAll((el: any) => el.props?.id === id);
function byId(renderer: any, id: string) {
  const found = findById(renderer, id);
  assert.ok(found.length > 0, `elemento con id "${id}" assente`);
  return found[0];
}

let fetchResponse: { status: number; json: Record<string, unknown> } = { status: 200, json: {} };
let fetchBodies: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function installEnv() {
  URL.createObjectURL = () => 'blob:f5';
  URL.revokeObjectURL = () => {};
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
  globalThis.fetch = (async (_url: unknown, options?: { body?: string }) => {
    if (options?.body) fetchBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify(fetchResponse.json), { status: fetchResponse.status });
  }) as typeof fetch;
}
function restoreEnv() {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  globalThis.fetch = originalFetch;
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
}

function modalProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true, onClose: () => {}, profile: multiSchoolProfile, students: [],
    timeSlotConfig: config(8),
    provisionalTimetable: [] as TimetableSlot[], definitiveTimetable: [] as TimetableSlot[],
    onOpenCircularWithFile: () => {},
    onSaveReconstructedTimetable: () => {},
    onImportStudentCommitments: () => {},
    ...overrides,
  };
}

/** Porta lo scanner personale fino allo schermo di consenso (pre-scan). */
async function toConsent(overrides: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(DocumentScannerModal, modalProps(overrides) as any)); });
  await act(async () => { byId(renderer, 'scan-type-personal').props.onClick(); });
  await act(async () => { byId(renderer, 'scan-source-camera').props.onClick(); });
  const input = renderer.root.findByProps({ 'aria-label': 'Scatta foto del documento' });
  await act(async () => {
    input.props.onChange({ target: { files: [new File([new Uint8Array(2000)], 'o.jpg', { type: 'image/jpeg' })], value: 'p' } });
    await new Promise(r => setTimeout(r, 0));
  });
  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  return renderer;
}

const summaryText = (renderer: any) => flatText(byId(renderer, 'scan-week-structure-summary'));
const confirmBox = (renderer: any) => byId(renderer, 'scan-week-structure-confirm');
async function pickSchool(renderer: any, schoolId: string) {
  await act(async () => { byId(renderer, 'scan-school-select').props.onChange({ target: { value: schoolId } }); });
}

test('F5/1b. il prefill mostrato segue l istituto scelto PRIMA della scansione', async () => {
  installEnv();
  const renderer = await toConsent();
  try {
    assert.match(summaryText(renderer), /Lun 6 · Mar 6 · Mer 6 · Gio 7 · Ven 6/, 'default: la primaria');
    await pickSchool(renderer, SCHOOL_B_ID);
    assert.match(summaryText(renderer), /Lun 8 · Mar 8 · Mer 8 · Gio 8 · Ven 8/, 'scelto B: geometria di B');
    assert.match(flatText(renderer.root), /40 posizioni/, 'e il totale segue');
  } finally {
    await act(async () => { renderer.unmount(); });
    restoreEnv();
  }
});

test('F5/3+19. cambiare istituto ricalcola la struttura, scarta le modifiche manuali e azzera la conferma', async () => {
  installEnv();
  const renderer = await toConsent();
  try {
    // L'utente ritocca a mano la geometria di A e la conferma.
    await act(async () => { byId(renderer, 'scan-week-structure-edit').props.onClick(); });
    await act(async () => { byId(renderer, 'scan-week-periods-0').props.onChange({ target: { value: '3' } }); });
    await act(async () => { confirmBox(renderer).props.onChange({ target: { checked: true } }); });
    assert.equal(confirmBox(renderer).props.checked, true);
    assert.match(summaryText(renderer), /Lun 3/, 'modifica manuale applicata');

    // Cambia istituto: la conferma riguardava un'altra scuola e un'altra
    // geometria, quindi decade insieme alle modifiche manuali.
    await pickSchool(renderer, SCHOOL_B_ID);
    assert.equal(confirmBox(renderer).props.checked, false, 'conferma azzerata');
    assert.match(summaryText(renderer), /Lun 8 · Mar 8 · Mer 8 · Gio 8 · Ven 8/, 'prefill pulito della nuova scuola');
    assert.equal(summaryText(renderer).includes('Lun 3'), false, 'nessun residuo della geometria precedente');
    assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, true, 'serve una nuova conferma');
  } finally {
    await act(async () => { renderer.unmount(); });
    restoreEnv();
  }
});

test('F5/4+11b. una sola scuola: nessun selettore e geometria identica a D3', async () => {
  installEnv();
  const renderer = await toConsent({ profile: singleSchoolProfile });
  try {
    assert.equal(findById(renderer, 'scan-school-select').length, 0, 'nessun passaggio in più');
    assert.match(summaryText(renderer), /Lun 6 · Mar 6 · Mer 6 · Gio 7 · Ven 6/);
  } finally {
    await act(async () => { renderer.unmount(); });
    restoreEnv();
  }
});

test('F5/10+18. catena completa: geometria di B nella request e istituto congelato fino al salvataggio', async () => {
  installEnv();
  // Risposta AI con la geometria di B: 8 celle al giorno, 40 posizioni.
  const cells: Array<{ rowIndex: number; dayOfWeek: number; periodIndex: number; raw: string }> = [];
  for (let day = 1; day <= 5; day += 1) {
    for (let period = 1; period <= 8; period += 1) {
      cells.push({ rowIndex: 0, dayOfWeek: day, periodIndex: period, raw: day === 1 && period === 8 ? '3D' : '' });
    }
  }
  fetchBodies = [];
  fetchResponse = { status: 200, json: { success: true, source: 'test', rowLabel: 'Manganiello F.', cells } as any };

  const saved: TimetableSlot[][] = [];
  const renderer = await toConsent({
    onSaveReconstructedTimetable: (slots: TimetableSlot[]) => { saved.push(slots); return true; },
  });
  try {
    await pickSchool(renderer, SCHOOL_B_ID);
    await act(async () => { confirmBox(renderer).props.onChange({ target: { checked: true } }); });
    await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
    await act(async () => {
      byId(renderer, 'scan-consent-confirm').props.onClick();
      await new Promise(r => setTimeout(r, 0));
    });
    for (let i = 0; i < 40; i += 1) {
      await act(async () => { await new Promise(r => setTimeout(r, 20)); });
      if (!flatText(renderer.root).includes('Analisi del documento in corso')) break;
    }

    // 1. La request porta la geometria di B.
    assert.equal(fetchBodies.length, 1);
    assert.deepEqual(fetchBodies[0].periodsByDay, [8, 8, 8, 8, 8], 'il prompt chiederà 8 celle al giorno');

    // 2. Dopo l'analisi l'istituto non è più modificabile.
    await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
    assert.equal(findById(renderer, 'scan-school-select').length, 0, 'nessun selettore in preview');
    assert.equal(flatText(byId(renderer, 'recon-school')), 'Istituto: Liceo Verdi', 'destinazione congelata e visibile');

    // 3. La 8ª del lunedì NON è scartata: per B è regolare.
    const preview = flatText(renderer.root);
    assert.equal(preview.includes('Ora non prevista per questo giorno'), false, 'nessun falso scarto con la geometria di B');

    // 4. Gli slot salvati portano l'istituto con cui sono stati validati.
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
    assert.equal(saved.length, 1, 'salvataggio avvenuto');
    assert.ok(saved[0].length > 0);
    assert.ok(saved[0].every(s => s.schoolId === SCHOOL_B_ID), 'tutti gli slot sono di B');
    assert.ok(saved[0].some(s => s.dayOfWeek === 1 && s.periodNumber === 8), 'l 8ª del lunedì è stata importata');
  } finally {
    await act(async () => { renderer.unmount(); });
    restoreEnv();
  }
});

test('F5/15-16. preview: Lun/8 valido per B, scartato per A con il motivo giusto', () => {
  // La preview mostra ciò che D1 partiziona: stessa ora, due destinazioni.
  const forB = partitionReconstructedSlots([item(1, 8)], {
    profile: multiSchoolProfile, timeSlotConfig: config(8), schoolId: SCHOOL_B_ID,
  });
  assert.equal(forB.rejected.length, 0, 'nessun avviso da mostrare');

  const forA = partitionReconstructedSlots([item(1, 8)], {
    profile: multiSchoolProfile, timeSlotConfig: config(8), schoolId: PRIMARY_ID,
  });
  assert.equal(forA.rejected.length, 1);
  assert.equal(forA.rejected[0].reason, 'day-not-allowed', 'il giorno non prevede quell ora in A');
  assert.equal(forA.rejected[0].item.periodIndex, 8);
  void schoolB; // geometria alternativa non usata: il modello non accorcia i giorni
});
