import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { DocumentScannerModal } from '../src/components/DocumentScannerModal';
import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/**
 * ANTEPRIMA DEGLI ELEMENTI ESCLUSI DALL'IMPORT (micro-passo D1).
 *
 * La validazione dei periodi e coperta a fondo, in isolamento, da
 * tests/timetable-scanner-day-periods.test.ts. Qui si verifica l'altra meta del
 * requisito: l'utente DEVE vedere quali righe non verranno importate e perche,
 * e le righe valide devono restare importabili insieme a quelle escluse.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalFetch = globalThis.fetch;

let fetchResponse: { status: number; json: Record<string, unknown> } = { status: 200, json: {} };
globalThis.fetch = (async (_url: unknown, _options?: { body?: string }) =>
  new Response(JSON.stringify(fetchResponse.json), { status: fetchResponse.status })) as typeof fetch;

before(() => {
  URL.createObjectURL = () => 'blob:scan-rejected-test';
  URL.revokeObjectURL = () => {};
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
});

after(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  globalThis.fetch = originalFetch;
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
});

beforeEach(() => { fetchResponse = { status: 200, json: {} }; });

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Scuola con 6 ore ordinarie e 7 il giovedi. */
const profile: TeacherProfile = {
  id: 't-1', fullName: 'Felice Manganiello', schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
  schools: [{
    id: 's1', name: 'IC Da Vinci', isPrimary: true, active: true,
    dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
  }],
};

const slotsFor = (count: number): TimeSlotConfig['customSlots'] =>
  Array.from({ length: count }, (_, i) => ({
    periodNumber: i + 1,
    label: `${i + 1}ª Ora`,
    startTime: `${String(8 + i).padStart(2, '0')}:00`,
    endTime: `${String(9 + i).padStart(2, '0')}:00`,
  }));

const config = (count: number): TimeSlotConfig => ({
  firstHourStartTime: '08:00', periodsPerDay: count, standardDurationMinutes: 60,
  customSlots: slotsFor(count),
});

const PERIODS = 7;
const DAYS = 5;

/** Celle gia posizionate dall'endpoint: indice → giorno/periodo. */
function cells(values: Record<number, string>) {
  return Array.from({ length: PERIODS * DAYS }, (_, index) => ({
    rowIndex: 0,
    dayOfWeek: Math.floor(index / PERIODS) + 1,
    periodIndex: (index % PERIODS) + 1,
    raw: values[index] ?? '',
  }));
}

/**
 * Documento con: Lun/1 (valida), Lun/7 (il lunedi ammette 6) e Gio/7 (il
 * giovedi ne ammette 7). Indici: Lun/1=0, Lun/7=6, Gio/7=27.
 */
const response = {
  success: true,
  source: 'test-model',
  rowLabel: 'Manganiello F.',
  cells: cells({ 0: '3D', 6: '3E', 27: '3D' }),
};

function modalProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    onClose: () => {},
    profile,
    students: [],
    timeSlotConfig: config(7),
    provisionalTimetable: [] as TimetableSlot[],
    definitiveTimetable: [] as TimetableSlot[],
    onOpenCircularWithFile: () => {},
    onSaveReconstructedTimetable: () => {},
    onImportStudentCommitments: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers di navigazione (stesso flusso di document-scanner-ui.test.ts)
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

async function waitForAnalysisSettled(renderer: any, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    if (!flatText(renderer.root).includes('Analisi del documento in corso')) return;
    if (Date.now() - start > timeoutMs) throw new Error('analisi mai conclusa');
  }
}

/** Percorre lo scanner fino alla schermata di revisione dell'orario. */
async function flowToReview(overrides: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(DocumentScannerModal, modalProps(overrides) as any)); });

  await act(async () => { byId(renderer, 'scan-type-personal').props.onClick(); });
  await act(async () => { byId(renderer, 'scan-source-camera').props.onClick(); });

  fetchResponse = { status: 200, json: response as any };
  const input = renderer.root.findByProps({ 'aria-label': 'Scatta foto del documento' });
  await act(async () => {
    input.props.onChange({ target: { files: [new File([new Uint8Array(2000)], 'orario.jpg', { type: 'image/jpeg' })], value: 'p' } });
    await new Promise(r => setTimeout(r, 0));
  });

  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  await act(async () => { byId(renderer, 'scan-periods-per-day').props.onChange({ target: { value: String(PERIODS) } }); });
  await act(async () => { byId(renderer, 'scan-periods-per-day-confirm').props.onChange({ target: { checked: true } }); });
  await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
  await act(async () => {
    byId(renderer, 'scan-consent-confirm').props.onClick();
    await new Promise(r => setTimeout(r, 0));
  });
  await waitForAnalysisSettled(renderer);
  await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
  return renderer;
}

/** Marcature di esclusione presenti nella revisione, per motivo. */
const rejectedMarkers = (renderer: any): string[] =>
  renderer.root
    .findAll((el: any) => el.props?.['data-recon-rejected'] !== undefined)
    .map((el: any) => el.props['data-recon-rejected']);

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('preview: l\'ora non prevista dal giorno e segnalata con il motivo corretto', async () => {
  // 7 fasce reali configurate: a escludere Lun/7 e solo dayPeriods.
  const renderer = await flowToReview({ timeSlotConfig: config(7) });
  const text = flatText(renderer.root);

  assert.deepEqual(rejectedMarkers(renderer), ['day-not-allowed'], 'una sola esclusione, per giorno');
  assert.ok(text.includes('Ora non prevista per questo giorno'), 'motivo mostrato');
  assert.ok(text.includes('Non verra importata'), 'esclusione dichiarata esplicitamente');
  assert.ok(/Luned.\s*\u00b7\s*7\u00aa ora/.test(text), 'giorno e periodo indicati');
  assert.ok(text.includes('1 ora non verra importata'), 'riepilogo presente');
  await act(async () => { renderer.unmount(); });
});

test('preview: la fascia non configurata e segnalata con motivo distinto', async () => {
  // Solo 6 fasce reali: Gio/7 e ammesso dal giorno ma non ha orario.
  const renderer = await flowToReview({ timeSlotConfig: config(6) });
  const text = flatText(renderer.root);

  const markers = rejectedMarkers(renderer);
  assert.equal(markers.length, 2, 'Lun/7 e Gio/7 esclusi');
  assert.ok(markers.includes('missing-period-slot'), 'Gio/7 escluso per fascia mancante');
  assert.ok(text.includes('Fascia oraria non configurata'), 'motivo mostrato');
  assert.ok(text.includes('Orario non configurato'), 'nessun orario sintetizzato al posto della fascia');
  // Nessun orario inventato dalla progressione automatica.
  assert.equal(text.includes('14:00'), false, 'nessun 14:00 generato per la 7ª');
  await act(async () => { renderer.unmount(); });
});

test('preview: le righe valide restano importabili insieme a quelle escluse', async () => {
  const saved: Array<{ slots: TimetableSlot[] }> = [];
  const renderer = await flowToReview({
    timeSlotConfig: config(7),
    onSaveReconstructedTimetable: (slots: TimetableSlot[]) => { saved.push({ slots }); },
  });

  assert.equal(rejectedMarkers(renderer).length, 1, 'una riga esclusa');
  const confirm = byId(renderer, 'recon-confirm-save');
  assert.notEqual(confirm.props.disabled, true, 'l\'import non e bloccato da una riga esclusa');

  await act(async () => { confirm.props.onClick(); });

  assert.equal(saved.length, 1, 'salvataggio avvenuto');
  const slots = saved[0].slots;
  assert.equal(slots.length, 2, 'Lun/1 e Gio/7 importate, Lun/7 no');
  assert.equal(slots.some(s => s.dayOfWeek === 1 && s.periodNumber === 7), false, 'la riga esclusa non e in archivio');
  assert.ok(slots.some(s => s.dayOfWeek === 4 && s.periodNumber === 7), 'Gio/7 importata');
  // Tutti gli orari salvati appartengono alle fasce reali.
  for (const slot of slots) {
    const real = slotsFor(7)[slot.periodNumber - 1];
    assert.equal(slot.startTime, real.startTime);
    assert.equal(slot.endTime, real.endTime);
  }
  await act(async () => { renderer.unmount(); });
});
