import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import { CIRCULAR_REQUEST_TIMEOUT_MS } from '../src/services/aiService';
import type { TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const profile: TeacherProfile = {
  id: 'teacher', fullName: 'Docente Test', schoolName: 'Scuola Test', schoolLevel: 'ssig',
  schoolYear: '2026/2027', primarySubjects: ['Matematica'], classes: ['1A'], campuses: ['Centrale'], roles: [],
};

before(() => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, source: 'groq', items: [] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;
});
after(() => { globalThis.fetch = originalFetch; });

function text(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return (node.children ?? []).map(text).join(' ');
}

test('il timeout client circolari lascia margine al deadline PDF da 90 secondi', () => {
  assert.equal(CIRCULAR_REQUEST_TIMEOUT_MS, 100_000);
});

test('il client mostra un messaggio esplicito quando un provider restituisce una lista vuota', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(CircularAnalyzerModal, {
      isOpen: true, onClose: () => {}, profile, onImportEvents: () => {},
      initialFile: {
        base64: 'QUJD', mimeType: 'image/jpeg', fileName: 'circolare.jpg',
        autoStartToken: `empty-${Date.now()}`,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  const visible = text(renderer.root).replace(/\s+/g, ' ');
  assert.match(visible, /Nessun impegno riconosciuto nel documento\. Puoi riprovare o incollare il testo\./);
  assert.doesNotMatch(visible, /Risultati Analisi Circolare/);
});
