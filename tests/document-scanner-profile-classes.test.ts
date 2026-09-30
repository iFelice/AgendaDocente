import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { DocumentScannerModal } from '../src/components/DocumentScannerModal';
import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/** H9 — suggerimento post-import per classi presenti nell'orario ma assenti dal Profilo. */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalFetch = globalThis.fetch;

let fetchResponse: { status: number; json: Record<string, unknown> } = { status: 200, json: {} };
globalThis.fetch = (async (_url: unknown, _options?: { body?: string }) =>
  new Response(JSON.stringify(fetchResponse.json), { status: fetchResponse.status })) as typeof fetch;

before(() => {
  URL.createObjectURL = () => 'blob:h9-profile-classes';
  URL.revokeObjectURL = () => {};
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
});

after(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  globalThis.fetch = originalFetch;
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
});

beforeEach(() => {
  fetchResponse = { status: 200, json: {} };
});

const baseProfile: TeacherProfile = {
  id: 't-1',
  fullName: 'Felice Manganiello',
  schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'],
  campuses: ['Sede Centrale'],
  roles: [],
  isSupportTeacher: true,
};

const timeSlotConfig: TimeSlotConfig = {
  firstHourStartTime: '08:00',
  periodsPerDay: 6,
  standardDurationMinutes: 60,
  customSlots: Array.from({ length: 6 }, (_, index) => ({
    periodNumber: index + 1,
    label: `${index + 1}ª Ora`,
    startTime: `${String(8 + index).padStart(2, '0')}:00`,
    endTime: `${String(9 + index).padStart(2, '0')}:00`,
  })),
};

function cells(raws: string[], periodsPerDay = 6) {
  return Array.from({ length: periodsPerDay * 5 }, (_, index) => ({
    rowIndex: 0,
    dayOfWeek: Math.floor(index / periodsPerDay) + 1,
    periodIndex: (index % periodsPerDay) + 1,
    raw: raws[index] ?? '',
  }));
}

function responseFor(raws: string[]) {
  return {
    success: true,
    source: 'test-model',
    rowLabel: 'Manganiello F.',
    cells: cells(raws),
  };
}

function modalProps(overrides: Partial<React.ComponentProps<typeof DocumentScannerModal>> = {}) {
  return {
    isOpen: true,
    onClose: () => {},
    profile: baseProfile,
    students: [],
    timeSlotConfig,
    provisionalTimetable: [] as TimetableSlot[],
    definitiveTimetable: [] as TimetableSlot[],
    onOpenCircularWithFile: () => {},
    onSaveReconstructedTimetable: () => {},
    onSaveProfile: () => {},
    onImportStudentCommitments: () => {},
    ...overrides,
  };
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
  assert.ok(found.length > 0, `elemento con id "${id}" assente`);
  return found[0];
}

function findById(renderer: any, id: string) {
  return renderer.root.findAll((el: any) => el.props?.id === id)[0];
}

async function waitForAnalysisSettled(renderer: any, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    if (!flatText(renderer.root).includes('Analisi del documento in corso')) return;
    if (Date.now() - start > timeoutMs) throw new Error('analisi mai conclusa');
  }
}

async function flowToReconstruction(raws: string[], overrides: Partial<React.ComponentProps<typeof DocumentScannerModal>> = {}) {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(DocumentScannerModal, modalProps(overrides))); });

  await act(async () => { byId(renderer, 'scan-type-personal').props.onClick(); });
  await act(async () => { byId(renderer, 'scan-source-camera').props.onClick(); });

  fetchResponse = { status: 200, json: responseFor(raws) as any };
  const input = renderer.root.findByProps({ 'aria-label': 'Scatta foto del documento' });
  await act(async () => {
    input.props.onChange({ target: { files: [new File([new Uint8Array(2000)], 'orario.jpg', { type: 'image/jpeg' })], value: 'p' } });
    await new Promise(r => setTimeout(r, 0));
  });

  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  await act(async () => { byId(renderer, 'scan-week-structure-confirm').props.onChange({ target: { checked: true } }); });
  await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
  await act(async () => {
    byId(renderer, 'scan-consent-confirm').props.onClick();
    await new Promise(r => setTimeout(r, 0));
  });
  await waitForAnalysisSettled(renderer);
  await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
  return renderer;
}

test('H9 UI: dopo import segnala solo la classe nuova e il salvataggio orario riesce', async () => {
  const saved: TimetableSlot[][] = [];
  const renderer = await flowToReconstruction(['3D', '3E', '1C'], {
    onSaveReconstructedTimetable: (slots: TimetableSlot[]) => { saved.push(slots); },
  });

  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

  assert.equal(saved.length, 1, 'orario importato');
  assert.deepEqual(saved[0].map(s => s.className), ['3D', '3E', '1C']);
  const bannerText = flatText(byId(renderer, 'scan-profile-class-suggestion'));
  assert.ok(bannerText.includes("Nuova classe rilevata nell'orario"));
  assert.ok(bannerText.includes('1C'));
  assert.equal(bannerText.includes('3D'), false, 'le classi già nel Profilo non sono suggerite');
  await act(async () => { renderer.unmount(); });
});

test('H9 UI: click Aggiungi aggiorna profile.classes tramite onSaveProfile', async () => {
  let savedProfile: TeacherProfile | null = null;
  let expectedProfile: TeacherProfile | undefined;
  const renderer = await flowToReconstruction(['3D', '3E', '1C'], {
    onSaveProfile: (updated: TeacherProfile, expected?: TeacherProfile) => {
      savedProfile = updated;
      expectedProfile = expected;
    },
  });

  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  await act(async () => { byId(renderer, 'scan-profile-classes-add').props.onClick(); });

  assert.ok(savedProfile, 'il normale callback di salvataggio Profilo e usato');
  assert.deepEqual(savedProfile!.classes, ['3D', '3E', '1C']);
  assert.equal(expectedProfile, baseProfile, 'il Profilo atteso viene passato al flusso di persistenza');
  assert.equal(findById(renderer, 'scan-profile-class-suggestion'), undefined, 'banner chiuso dopo aggiunta');
  await act(async () => { renderer.unmount(); });
});

test('H9 UI: Non ora non modifica il Profilo e non perde l\'orario importato', async () => {
  const saved: TimetableSlot[][] = [];
  let profileSaves = 0;
  const renderer = await flowToReconstruction(['1C'], {
    onSaveReconstructedTimetable: (slots: TimetableSlot[]) => { saved.push(slots); },
    onSaveProfile: () => { profileSaves += 1; },
  });

  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  await act(async () => { byId(renderer, 'scan-profile-classes-dismiss').props.onClick(); });

  assert.equal(profileSaves, 0);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].map(s => s.className), ['1C']);
  assert.equal(findById(renderer, 'scan-profile-class-suggestion'), undefined);
  await act(async () => { renderer.unmount(); });
});

test('H9 UI: piu classi nuove sono mostrate insieme e deduplicate', async () => {
  const renderer = await flowToReconstruction(['1C', '2B', '1C']);

  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

  const bannerText = flatText(byId(renderer, 'scan-profile-class-suggestion'));
  assert.ok(bannerText.includes("Nuove classi rilevate nell'orario"));
  assert.ok(bannerText.includes('1C · 2B'));
  assert.ok(bannerText.includes('Aggiungi alle mie classi'));
  await act(async () => { renderer.unmount(); });
});

test('H9 UI: classe gia presente con altra capitalizzazione non mostra warning', async () => {
  const renderer = await flowToReconstruction(['1C'], {
    profile: { ...baseProfile, classes: [' 1c ', '3D'] },
  });

  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

  assert.equal(findById(renderer, 'scan-profile-class-suggestion'), undefined);
  await act(async () => { renderer.unmount(); });
});
