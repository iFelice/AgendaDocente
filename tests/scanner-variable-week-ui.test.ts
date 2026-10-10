import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { DocumentScannerModal } from '../src/components/DocumentScannerModal';
import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';
import { installSignedInAnalysisClient } from './helpers/analysisClientSession';
installSignedInAnalysisClient();


/**
 * MICRO-PASSO D3 — UI E INTEGRAZIONE DELLA SETTIMANA NON RETTANGOLARE.
 *
 * La domanda scalare «Quante ore ci sono in ogni giornata scolastica?» non può
 * descrivere un giovedì da 7 ore in una settimana da 6: costringeva l'utente a
 * mentire su almeno un giorno. Qui si verifica la UI che la sostituisce
 * (struttura della settimana derivata dal Profilo, modificabile, confermata) e
 * che la geometria dichiarata arrivi intatta fino all'import.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalFetch = globalThis.fetch;

let fetchResponse: { status: number; json: Record<string, unknown> } = { status: 200, json: {} };
let fetchBodies: Array<Record<string, unknown>> = [];
globalThis.fetch = (async (_url: unknown, options?: { body?: string }) => {
  if (options?.body) fetchBodies.push(JSON.parse(options.body));
  return new Response(JSON.stringify(fetchResponse.json), { status: fetchResponse.status });
}) as typeof fetch;

before(() => {
  URL.createObjectURL = () => 'blob:scan-week-test';
  URL.revokeObjectURL = () => {};
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
});

after(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  globalThis.fetch = originalFetch;
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
});

beforeEach(() => { fetchResponse = { status: 200, json: {} }; fetchBodies = []; });

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Scuola con 6 ore ordinarie e 7 il giovedì: la settimana 6/6/6/7/6. */
const profile: TeacherProfile = {
  id: 't-1', fullName: 'Felice Manganiello', schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'], campuses: [], roles: [], isSupportTeacher: true,
  schools: [{
    id: 's1', name: 'IC Da Vinci', isPrimary: true, active: true,
    dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
  }],
} as unknown as TeacherProfile;

/** Profilo "vecchio": nessuna struttura dichiarata, settimana rettangolare. */
const legacyProfile = {
  ...profile,
  schools: [{ id: 's1', name: 'IC Da Vinci', isPrimary: true, active: true }],
} as unknown as TeacherProfile;

const config = (count: number): TimeSlotConfig => ({
  firstHourStartTime: '08:00', periodsPerDay: count, standardDurationMinutes: 60,
  customSlots: Array.from({ length: count }, (_, i) => ({
    periodNumber: i + 1, label: `${i + 1}ª Ora`,
    startTime: `${String(8 + i).padStart(2, '0')}:00`,
    endTime: `${String(9 + i).padStart(2, '0')}:00`,
  })),
});

const WEEK = [6, 6, 6, 7, 6];

/**
 * Celle come le produce l'endpoint per la settimana 6/6/6/7/6: la coordinata è
 * già derivata dalla posizione, e la 7ª del giovedì esiste davvero.
 */
function weekCells(values: Record<string, string> = {}) {
  const cells: Array<{ rowIndex: number; dayOfWeek: number; periodIndex: number; raw: string }> = [];
  WEEK.forEach((periods, day) => {
    for (let period = 1; period <= periods; period += 1) {
      cells.push({ rowIndex: 0, dayOfWeek: day + 1, periodIndex: period, raw: values[`${day + 1}|${period}`] ?? '' });
    }
  });
  return cells;
}

function modalProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true, onClose: () => {}, profile, students: [],
    timeSlotConfig: config(7),
    provisionalTimetable: [] as TimetableSlot[], definitiveTimetable: [] as TimetableSlot[],
    onOpenCircularWithFile: () => {},
    onSaveReconstructedTimetable: () => {},
    onImportStudentCommitments: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers (stesso flusso degli altri test dello scanner)
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

function byId(renderer: any, id: string) {
  const found = renderer.root.findAll((el: any) => el.props?.id === id);
  assert.ok(found.length > 0, `elemento con id "${id}" assente`);
  return found[0];
}
const hasId = (renderer: any, id: string) => renderer.root.findAll((el: any) => el.props?.id === id).length > 0;

async function waitForAnalysisSettled(renderer: any, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    if (!flatText(renderer.root).includes('Analisi del documento in corso')) return;
    if (Date.now() - start > timeoutMs) throw new Error('analisi mai conclusa');
  }
}

/** Apre lo scanner sull'orario personale e arriva allo schermo di consenso. */
async function toConsentScreen(overrides: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(DocumentScannerModal, modalProps(overrides) as any)); });
  await act(async () => { byId(renderer, 'scan-type-personal').props.onClick(); });
  await act(async () => { byId(renderer, 'scan-source-camera').props.onClick(); });
  const input = renderer.root.findByProps({ 'aria-label': 'Scatta foto del documento' });
  await act(async () => {
    input.props.onChange({ target: { files: [new File([new Uint8Array(2000)], 'orario.jpg', { type: 'image/jpeg' })], value: 'p' } });
    await new Promise(r => setTimeout(r, 0));
  });
  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  return renderer;
}

async function openWeekStructure(renderer: any) {
  if (hasId(renderer, 'scan-week-periods-0')) return;
  await act(async () => { byId(renderer, 'scan-week-structure-edit').props.onClick(); });
}

async function setDayPeriods(renderer: any, dayIndex: number, value: string) {
  await openWeekStructure(renderer);
  await act(async () => { byId(renderer, `scan-week-periods-${dayIndex}`).props.onChange({ target: { value } }); });
}

const readWeek = async (renderer: any) => {
  await openWeekStructure(renderer);
  return [0, 1, 2, 3, 4].map(day => byId(renderer, `scan-week-periods-${day}`).props.value);
};

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

test('D3/UI-1. prefill dal Profilo: la settimana 6/6/6/7/6 è proposta, non chiesta di nuovo', async () => {
  const renderer = await toConsentScreen();
  try {
    assert.match(flatText(renderer.root), /Struttura della settimana/);
    assert.match(flatText(byId(renderer, 'scan-week-structure-summary')), /Lun 6 · Mar 6 · Mer 6 · Gio 7 · Ven 6/);
    assert.deepEqual(await readWeek(renderer), ['6', '6', '6', '7', '6']);
    // Il totale mostrato è la SOMMA dei giorni: 31, non 6 x 5 né 7 x 5.
    assert.match(flatText(byId(renderer, 'scan-week-structure-help')), /31 posizioni/);
    assert.match(flatText(renderer.root), /\(31 posizioni complessive\)/);
    // La vecchia domanda scalare non esiste più in questo percorso.
    assert.equal(hasId(renderer, 'scan-periods-per-day'), false, 'nessun campo «Nº ore al giorno» residuo');
    assert.equal(flatText(renderer.root).includes('Quante ore ci sono in ogni giornata scolastica'), false);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('D3/UI-2. profilo legacy senza dayPeriods: settimana rettangolare 6x5, comportamento invariato', async () => {
  const renderer = await toConsentScreen({ profile: legacyProfile, timeSlotConfig: config(6) });
  try {
    assert.deepEqual(await readWeek(renderer), ['6', '6', '6', '6', '6']);
    assert.match(flatText(byId(renderer, 'scan-week-structure-help')), /30 posizioni/);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('D3/UI-3. 5 e 8 fasce senza dayPeriods: il prefill segue la configurazione esistente', async () => {
  for (const [count, total] of [[5, 25], [8, 40]] as const) {
    const renderer = await toConsentScreen({ profile: legacyProfile, timeSlotConfig: config(count) });
    try {
      assert.deepEqual(await readWeek(renderer), Array.from({ length: 5 }, () => String(count)));
      assert.match(flatText(byId(renderer, 'scan-week-structure-help')), new RegExp(`${total} posizioni`));
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  }
});

test('D3/UI-4. modifica di UN solo giorno: gli altri restano, la conferma si azzera', async () => {
  const renderer = await toConsentScreen();
  try {
    await act(async () => { byId(renderer, 'scan-week-structure-confirm').props.onChange({ target: { checked: true } }); });
    assert.equal(byId(renderer, 'scan-week-structure-confirm').props.checked, true);
    // L'utente corregge solo il martedì.
    await setDayPeriods(renderer, 1, '5');
    assert.deepEqual(await readWeek(renderer), ['6', '5', '6', '7', '6'], 'cambia solo il giorno toccato');
    assert.match(flatText(byId(renderer, 'scan-week-structure-summary')), /Lun 6 · Mar 5 · Mer 6 · Gio 7 · Ven 6/);
    assert.match(flatText(byId(renderer, 'scan-week-structure-help')), /30 posizioni/, 'il totale si aggiorna');
    // La conferma precedente non vale più: riguarda una struttura diversa.
    assert.equal(byId(renderer, 'scan-week-structure-confirm').props.checked, false, 'conferma azzerata dalla modifica');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('D3/UI-5. la conferma è obbligatoria e un valore non valido blocca l invio', async () => {
  const renderer = await toConsentScreen();
  try {
    await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
    assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, true, 'senza conferma l invio è bloccato');
    // Valori non utilizzabili su un solo giorno: niente invio, nessuna correzione silenziosa.
    for (const bad of ['', '0', '-2', '2,5', 'abc', '13']) {
      await setDayPeriods(renderer, 3, bad);
      assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, true, `invio bloccato con "${bad}"`);
      assert.equal(byId(renderer, 'scan-week-structure-confirm').props.disabled, true, 'non si può nemmeno confermare');
    }
    assert.equal(fetchBodies.length, 0, 'nessuna analisi partita');
    await setDayPeriods(renderer, 3, '7');
    await act(async () => { byId(renderer, 'scan-week-structure-confirm').props.onChange({ target: { checked: true } }); });
    assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, false, 'struttura confermata + consenso: si parte');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('D3/UI-6. fasce mancanti: avviso non bloccante, la scansione resta possibile', async () => {
  // Struttura fino alla 7ª ora ma solo 6 fasce orarie configurate.
  const renderer = await toConsentScreen({ timeSlotConfig: config(6) });
  try {
    const warning = flatText(byId(renderer, 'scan-week-structure-slots-warning'));
    assert.match(warning, /prevede fino alla 7ª ora/);
    assert.match(warning, /solo 6 fasce orarie/);
    assert.match(warning, /non potranno essere importate/);
    // Non blocca: si può confermare e inviare comunque.
    await act(async () => { byId(renderer, 'scan-week-structure-confirm').props.onChange({ target: { checked: true } }); });
    await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
    assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, false, 'l avviso non blocca la scansione');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('D3/UI-7. nessun avviso quando le fasce coprono il giorno più lungo', async () => {
  const renderer = await toConsentScreen({ timeSlotConfig: config(7) });
  try {
    assert.equal(hasId(renderer, 'scan-week-structure-slots-warning'), false);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// INTEGRAZIONE
// ---------------------------------------------------------------------------

test('D3/INT-1. scansione 6/6/6/7/6: la request porta la struttura e la review mostra 31 posizioni', async () => {
  fetchResponse = {
    status: 200,
    json: { success: true, source: 'test-model', rowLabel: 'Manganiello F.', cells: weekCells({ '4|7': '3D', '5|1': '3E' }) } as any,
  };
  const renderer = await toConsentScreen();
  try {
    await act(async () => { byId(renderer, 'scan-week-structure-confirm').props.onChange({ target: { checked: true } }); });
    await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
    await act(async () => {
      byId(renderer, 'scan-consent-confirm').props.onClick();
      await new Promise(r => setTimeout(r, 0));
    });
    await waitForAnalysisSettled(renderer);

    assert.equal(fetchBodies.length, 1, 'una sola chiamata');
    assert.deepEqual(fetchBodies[0].periodsByDay, [6, 6, 6, 7, 6], 'la struttura viaggia nella request');
    assert.equal('periodsPerDay' in fetchBodies[0], false, 'nessuna geometria scalare: una sola fonte di verità');

    const summary = flatText(byId(renderer, 'scan-personal-sequence-count'));
    assert.match(summary, /31 posizioni/, 'la review conta 31 posizioni, non 30 né 35');
    assert.match(summary, /Lun 6 · Mar 6 · Mer 6 · Gio 7 · Ven 6/, 'la struttura usata è mostrata all utente');
    assert.match(summary, /2 occupate/);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('D3/INT-2. la 7ª del giovedì si importa; senza la fascia solo lei viene scartata', async () => {
  const run = async (slots: number) => {
    fetchResponse = {
      status: 200,
      json: { success: true, source: 'test-model', rowLabel: 'Manganiello F.', cells: weekCells({ '4|7': '3D', '4|6': '3D', '5|1': '3E' }) } as any,
    };
    const saved: TimetableSlot[][] = [];
    const renderer = await toConsentScreen({
      timeSlotConfig: config(slots),
      onSaveReconstructedTimetable: (s: TimetableSlot[]) => { saved.push(s); },
    });
    await act(async () => { byId(renderer, 'scan-week-structure-confirm').props.onChange({ target: { checked: true } }); });
    await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
    await act(async () => {
      byId(renderer, 'scan-consent-confirm').props.onClick();
      await new Promise(r => setTimeout(r, 0));
    });
    await waitForAnalysisSettled(renderer);
    await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
    const text = flatText(renderer.root);
    await act(async () => { renderer.unmount(); });
    return text;
  };

  // Con 7 fasce la 7ª del giovedì è una riga importabile come le altre.
  const withSeven = await run(7);
  assert.equal(withSeven.includes('Ora non prevista per questo giorno'), false, 'il giovedì ammette davvero la 7ª ora');
  assert.equal(withSeven.includes('Fascia oraria non configurata'), false, 'la 7ª fascia esiste');

  // Con 6 fasce la coordinata resta corretta (nessuno shift), ma la 7ª ora non
  // ha un orario reale: D1 la esclude in preview spiegando il motivo. D3
  // previene a monte, D1 resta la rete di sicurezza finale.
  const withSix = await run(6);
  assert.match(withSix, /Fascia oraria non configurata/, 'motivo dell esclusione mostrato');
  assert.equal(
    withSix.includes('Ora non prevista per questo giorno'), false,
    'il giovedì AMMETTE la 7ª ora: il problema è la fascia mancante, non il giorno',
  );
});
