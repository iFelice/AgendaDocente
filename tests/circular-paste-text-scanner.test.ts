import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { DocumentScannerModal, type CircularFileInfo } from '../src/components/DocumentScannerModal';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import type { TeacherProfile } from '../src/types';
import { installSignedInAnalysisClient } from './helpers/analysisClientSession';
installSignedInAnalysisClient();


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; body: any }> = [];

before(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let parsedBody: any = undefined;
    if (init?.body && typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {}
    }
    fetchCalls.push({ url, body: parsedBody });
    return new Response(JSON.stringify({
      success: true,
      source: 'server',
      items: [
        {
          title: 'Consiglio di Classe 1A',
          category: 'consiglio_classe',
          date: '2026-10-05',
          startTime: '16:00',
          endTime: '17:00',
          relevance: 'VERDE',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  fetchCalls.length = 0;
});

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

const profile: TeacherProfile = {
  id: 't-test',
  fullName: 'Professoressa Rossi',
  schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Italiano'],
  classes: ['1A', '2A'],
  campuses: ['Centrale'],
  roles: [],
};

function byId(renderer: any, id: string) {
  return renderer.root.find((el: any) => el.props?.id === id);
}

function findById(renderer: any, id: string) {
  return renderer.root.findAll((el: any) => el.props?.id === id);
}

// ---------------------------------------------------------------------------
// 1. Scanner → Circolare mostra 3 opzioni: Scatta foto, Scegli foto o file, Incolla testo
// ---------------------------------------------------------------------------

test('1. Scanner → Circolare mostra: Scatta foto, Scegli foto o file, Incolla testo', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(DocumentScannerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        students: [],
        timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: 60, customSlots: [] } as any,
        provisionalTimetable: [],
        definitiveTimetable: [],
        onOpenCircularWithFile: () => {},
        onSaveReconstructedTimetable: () => {},
        onImportStudentCommitments: () => {},
      })
    );
  });

  const circularTypeBtn = byId(renderer, 'scan-type-circolare');
  await act(async () => {
    circularTypeBtn.props.onClick();
  });

  const cameraBtn = byId(renderer, 'scan-source-camera');
  const fileBtn = byId(renderer, 'scan-source-file');
  const textBtn = byId(renderer, 'scan-source-text');

  assert.ok(cameraBtn, 'Pulsante Scatta foto presente');
  assert.ok(flatText(cameraBtn).includes('Scatta foto'));

  assert.ok(fileBtn, 'Pulsante Scegli foto o file presente');
  assert.ok(flatText(fileBtn).includes('Scegli foto o file'));

  assert.ok(textBtn, 'Pulsante Incolla testo presente');
  assert.ok(flatText(textBtn).includes('Incolla testo'));
});

// ---------------------------------------------------------------------------
// 2. Incolla testo: non apre camera/picker, non chiama API, produce handoff text
// ---------------------------------------------------------------------------

test('2. Incolla testo: non apre camera, non apre file picker, non chiama API, apre CircularAnalyzerModal in modalità text', async () => {
  let receivedHandoff: CircularFileInfo | null = null;
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(DocumentScannerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        students: [],
        timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: 60, customSlots: [] } as any,
        provisionalTimetable: [],
        definitiveTimetable: [],
        onOpenCircularWithFile: (info) => { receivedHandoff = info; },
        onSaveReconstructedTimetable: () => {},
        onImportStudentCommitments: () => {},
      })
    );
  });

  await act(async () => {
    byId(renderer, 'scan-type-circolare').props.onClick();
  });

  const textBtn = byId(renderer, 'scan-source-text');
  await act(async () => {
    textBtn.props.onClick();
  });

  assert.ok(receivedHandoff, 'Handoff deve essere invocato');
  assert.equal((receivedHandoff as any).mode, 'text');
  assert.equal((receivedHandoff as any).base64, undefined, 'Nessun base64 creato');
  assert.equal((receivedHandoff as any).autoStartToken, undefined, 'Nessun autoStartToken generato');
  assert.equal(fetchCalls.length, 0, 'Nessuna chiamata API scatenata dal click su Incolla testo');
});

// ---------------------------------------------------------------------------
// 3. Textarea disponibile immediatamente e nessun autoStart
// ---------------------------------------------------------------------------

test('3. CircularAnalyzerModal aperto con handoff text: textarea disponibile immediatamente e nessun autoStart', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: { mode: 'text' },
        initialInputMode: 'text',
      })
    );
    await new Promise((r) => setTimeout(r, 50));
  });

  assert.equal(fetchCalls.length, 0, 'Nessun autoStart all\'apertura in modalità testo');

  // Textarea deve essere subito presente
  const textareas = renderer.root.findAllByType('textarea');
  assert.equal(textareas.length, 1, 'Textarea presente immediatamente');
  assert.equal(textareas[0].props.value, '', 'Textarea inizialmente vuota');

  // L\'utente incolla il testo ed esegue l\'analisi esplicita
  await act(async () => {
    textareas[0].props.onChange({ target: { value: '05/10/2026 Consiglio di classe 1A ore 16:00' } });
  });

  const runBtn = byId(renderer, 'btn-run-analysis');
  assert.ok(runBtn, 'Pulsante Avvia Analisi & Filtraggio presente');

  await act(async () => {
    runBtn.props.onClick();
    await new Promise((r) => setTimeout(r, 50));
  });

  assert.equal(fetchCalls.length, 1, 'Analisi chiamata solo dopo click esplicito dell\'utente');
  assert.equal(fetchCalls[0].url, '/api/analyze-circular');
  assert.equal(fetchCalls[0].body.text, '05/10/2026 Consiglio di classe 1A ore 16:00');
});

// ---------------------------------------------------------------------------
// 4. Foto/file mantengono il comportamento attuale con autoStart
// ---------------------------------------------------------------------------

test('4. Flusso foto/file: preview -> Analizza nel cloud mantiene autoStart e modalità file', async () => {
  let receivedHandoff: CircularFileInfo | null = null;
  let scannerRenderer: any;
  await act(async () => {
    scannerRenderer = create(
      React.createElement(DocumentScannerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        students: [],
        timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: 60, customSlots: [] } as any,
        provisionalTimetable: [],
        definitiveTimetable: [],
        onOpenCircularWithFile: (info) => { receivedHandoff = info; },
        onSaveReconstructedTimetable: () => {},
        onImportStudentCommitments: () => {},
      })
    );
  });

  await act(async () => {
    byId(scannerRenderer, 'scan-type-circolare').props.onClick();
  });

  const fileInput = scannerRenderer.root.findByProps({ 'aria-label': 'Scegli foto o file' });
  const testFile = new File([new Uint8Array([1, 2, 3])], 'circolare_test.pdf', { type: 'application/pdf' });
  await act(async () => {
    fileInput.props.onChange({ target: { files: [testFile], value: 'pending' } });
    await new Promise((r) => setTimeout(r, 10));
  });

  const ctaBtn = byId(scannerRenderer, 'scan-analyze-cta');
  assert.equal(flatText(ctaBtn), 'Analizza nel cloud');

  await act(async () => {
    ctaBtn.props.onClick();
  });

  assert.ok(receivedHandoff);
  assert.equal((receivedHandoff as any).fileName, 'circolare_test.pdf');
  assert.ok((receivedHandoff as any).autoStartToken?.startsWith('circ-auto-'));

  // Apertura di CircularAnalyzerModal con l\'handoff file
  let analyzerRenderer: any;
  await act(async () => {
    analyzerRenderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: receivedHandoff,
      })
    );
    await new Promise((r) => setTimeout(r, 50));
  });

  assert.equal(fetchCalls.length, 1, 'Auto-start eseguito per il file');
  assert.equal(fetchCalls[0].body.mimeType, 'application/pdf');
});

// ---------------------------------------------------------------------------
// 5. Altri tipi scanner: personal e registro NON mostrano "Incolla testo"
// ---------------------------------------------------------------------------

test('5. Altri tipi scanner (Orario personale e Registro) NON mostrano il pulsante "Incolla testo"', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(DocumentScannerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        students: [],
        timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: 60, customSlots: [] } as any,
        provisionalTimetable: [],
        definitiveTimetable: [],
        onOpenCircularWithFile: () => {},
        onSaveReconstructedTimetable: () => {},
        onImportStudentCommitments: () => {},
      })
    );
  });

  // 1. Orario personale
  await act(async () => {
    byId(renderer, 'scan-type-personal').props.onClick();
  });
  assert.ok(byId(renderer, 'scan-source-camera'), 'Camera presente');
  assert.ok(byId(renderer, 'scan-source-file'), 'File presente');
  assert.equal(findById(renderer, 'scan-source-text').length, 0, 'Incolla testo NON deve comparire per Orario personale');

  // Torna indietro
  const backBtn = renderer.root.findByProps({ 'aria-label': 'Torna al tipo documento' });
  await act(async () => {
    backBtn.props.onClick();
  });

  // 2. Registro / appunti
  await act(async () => {
    byId(renderer, 'scan-type-registro').props.onClick();
  });
  assert.ok(byId(renderer, 'scan-source-camera'), 'Camera presente');
  assert.ok(byId(renderer, 'scan-source-file'), 'File presente');
  assert.equal(findById(renderer, 'scan-source-text').length, 0, 'Incolla testo NON deve comparire per Registro');
});
