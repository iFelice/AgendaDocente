import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import {
  ANALYSIS_NOT_AUTHORIZED_MESSAGE,
  ANALYSIS_NOT_CONFIGURED_CLIENT_MESSAGE,
  ANALYSIS_NOT_CONFIGURED_SERVER_MESSAGE,
  ANALYSIS_SESSION_EXPIRED_MESSAGE,
  ANALYSIS_SIGN_IN_REQUIRED_MESSAGE,
  setAnalysisTokenProviderForTests,
} from '../src/services/analysisSession';
import { analyzeCircular } from '../src/services/aiService';
import {
  ANALYSIS_UNAUTHORIZED_MESSAGE,
  ANALYSIS_UNAUTHENTICATED_MESSAGE,
} from '../server/analysisAuth';
import { setCachedUserForTests } from '../src/services/googleAuth';
import { analyzeStudentDocument, analyzeTimetableDocument } from '../src/services/scanService';
import type { TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: TeacherProfile = {
  id: 't-1', fullName: 'Docente', schoolName: 'Scuola', schoolYear: '2026/2027',
  primarySubjects: [], classes: ['1A'], campuses: [], roles: [],
};
const TEXT = '14/09/2027 Collegio docenti 15:00-17:00';

after(() => {
  setAnalysisTokenProviderForTests(null);
  setCachedUserForTests(null);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('i messaggi 401/403 del server coincidono con quelli mostrati dal client', () => {
  assert.equal(ANALYSIS_UNAUTHENTICATED_MESSAGE, ANALYSIS_SESSION_EXPIRED_MESSAGE);
  assert.equal(ANALYSIS_UNAUTHORIZED_MESSAGE, ANALYSIS_NOT_AUTHORIZED_MESSAGE);
});

test('client senza accesso: nessuna richiesta e messaggio mostrato', async () => {
  setAnalysisTokenProviderForTests(null);
  setCachedUserForTests(null);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { success: true, items: [] });
  };
  const circular = await analyzeCircular({ text: TEXT, profile }, { fetchImpl });
  assert.equal(calls, 0);
  assert.equal(circular.success, false);
  assert.deepEqual(circular.items, []);
  assert.equal(circular.error, ANALYSIS_SIGN_IN_REQUIRED_MESSAGE);

  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(200, { success: true, cells: [] });
  }) as typeof fetch;
  try {
    const timetable = await analyzeTimetableDocument({
      imageBase64: 'AAAA', mimeType: 'image/png', documentType: 'personal-support-timetable',
      periodsByDay: [5, 5, 5, 5, 5], profile,
    }).then(() => null, (error: Error) => error);
    const student = await analyzeStudentDocument({
      imageBase64: 'AAAA', mimeType: 'image/png', profile,
    }).then(() => null, (error: Error) => error);
    assert.equal(calls, 0);
    assert.equal(timetable?.message, ANALYSIS_SIGN_IN_REQUIRED_MESSAGE);
    assert.equal(student?.message, ANALYSIS_SIGN_IN_REQUIRED_MESSAGE);
  } finally {
    globalThis.fetch = original;
  }

  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(CircularAnalyzerModal, {
      isOpen: true,
      onClose: () => undefined,
      profile,
      onImportEvents: () => undefined,
      initialFile: { mode: 'text' },
      initialInputMode: 'text',
    }));
  });
  const textarea = renderer.root.findByType('textarea');
  await act(async () => {
    textarea.props.onChange({ target: { value: TEXT } });
  });
  await act(async () => {
    renderer.root.findByProps({ id: 'btn-run-analysis' }).props.onClick();
  });
  const shown = JSON.stringify(renderer.toJSON());
  assert.equal(shown.includes(ANALYSIS_SIGN_IN_REQUIRED_MESSAGE), true);
  assert.equal(calls, 0);
});

test('utente collegato: getIdToken finisce in Authorization e 401/403/503 di configurazione non usano il parser locale', async () => {
  let tokenCalls = 0;
  setAnalysisTokenProviderForTests(null);
  setCachedUserForTests({
    getIdToken: async () => {
      tokenCalls += 1;
      return 'firebase-id-token';
    },
  });
  let header = '';
  const ok = await analyzeCircular({ text: TEXT, profile }, {
    fetchImpl: async (_url, init) => {
      header = String(new Headers(init?.headers).get('authorization'));
      return jsonResponse(200, { success: true, source: 'server', items: [] });
    },
  });
  assert.equal(tokenCalls, 1);
  assert.equal(header, 'Bearer firebase-id-token');
  assert.equal(ok.success, true);

  const expired = await analyzeCircular({ text: TEXT, profile }, {
    fetchImpl: async () => jsonResponse(401, { success: false, error: 'token' }),
  });
  assert.equal(expired.success, false);
  assert.deepEqual(expired.items, []);
  assert.equal(expired.error, ANALYSIS_SESSION_EXPIRED_MESSAGE);
  assert.notEqual(expired.source, 'offline-local');

  const forbidden = await analyzeCircular({ text: TEXT, profile }, {
    fetchImpl: async () => jsonResponse(403, { success: false }),
  });
  assert.equal(forbidden.error, ANALYSIS_NOT_AUTHORIZED_MESSAGE);
  assert.deepEqual(forbidden.items, []);

  const unconfigured = await analyzeCircular({ text: TEXT, profile }, {
    fetchImpl: async () => jsonResponse(503, { success: false, error: ANALYSIS_NOT_CONFIGURED_SERVER_MESSAGE, errorCode: 'ANALYSIS_NOT_CONFIGURED' }),
  });
  assert.equal(unconfigured.error, ANALYSIS_NOT_CONFIGURED_CLIENT_MESSAGE);
  assert.notEqual(unconfigured.source, 'offline-local');

  const original = globalThis.fetch;
  let scanHeader = '';
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    scanHeader = String(new Headers(init?.headers).get('authorization'));
    return jsonResponse(401, { success: false });
  }) as typeof fetch;
  try {
    const error = await analyzeTimetableDocument({
      imageBase64: 'AAAA', mimeType: 'image/png', documentType: 'personal-support-timetable',
      periodsByDay: [5, 5, 5, 5, 5], profile,
    }).then(() => null, (caught: Error) => caught);
    assert.equal(scanHeader, 'Bearer firebase-id-token');
    assert.equal(error?.message, ANALYSIS_SESSION_EXPIRED_MESSAGE);
    globalThis.fetch = (async () => jsonResponse(403, { success: false })) as typeof fetch;
    const denied = await analyzeStudentDocument({ imageBase64: 'AAAA', mimeType: 'image/png', profile })
      .then(() => null, (caught: Error) => caught);
    assert.equal(denied?.message, ANALYSIS_NOT_AUTHORIZED_MESSAGE);
    globalThis.fetch = (async () => jsonResponse(503, { success: false, error: ANALYSIS_NOT_CONFIGURED_SERVER_MESSAGE })) as typeof fetch;
    const missing = await analyzeStudentDocument({ imageBase64: 'AAAA', mimeType: 'image/png', profile })
      .then(() => null, (caught: Error) => caught);
    assert.equal(missing?.message, ANALYSIS_NOT_CONFIGURED_CLIENT_MESSAGE);
  } finally {
    globalThis.fetch = original;
    setCachedUserForTests(null);
  }
});
