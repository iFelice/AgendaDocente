import express from 'express';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server';
import { createAnalysisGuards } from '../server/analysisGuards';
import {
  ANALYSIS_NOT_CONFIGURED_CODE,
  ANALYSIS_NOT_CONFIGURED_MESSAGE,
  ANALYSIS_UNAUTHORIZED_MESSAGE,
  ANALYSIS_UNAUTHENTICATED_MESSAGE,
  SECURETOKEN_CERTS_URL,
  analysisKeySourceKind,
  remainingFreshnessMs,
  setAnalysisAuthNowForTests,
  setAnalysisKeyFetcherForTests,
  truncateUid,
} from '../server/analysisAuth';
import {
  analysisAuthHeaders,
  createAnalysisAuthFixture,
  currentAnalysisAuthFixture,
  installAnalysisAuthFixture,
  type AnalysisAuthFixture,
} from './helpers/analysisAuthFixture';

/**
 * Autenticazione degli endpoint di analisi. Chiavi e token sono generati qui:
 * nessuna chiamata a Google.
 */

let fixture: AnalysisAuthFixture;
let fetches = 0;
const originalFetch = globalThis.fetch;

before(() => {
  fixture = installAnalysisAuthFixture(createAnalysisAuthFixture(), async (url) => {
    fetches += 1;
    assert.equal(url, SECURETOKEN_CERTS_URL);
    return {
      status: 200,
      body: currentAnalysisAuthFixture().certsJson,
      cacheControl: 'public, max-age=3600',
      age: null,
    };
  });
});

after(() => {
  setAnalysisAuthNowForTests(null);
  globalThis.fetch = originalFetch;
});

function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const warn = console.warn;
  const info = console.info;
  console.warn = (line?: unknown) => { lines.push(String(line)); };
  console.info = (line?: unknown) => { lines.push(String(line)); };
  return {
    lines,
    restore: () => {
      console.warn = warn;
      console.info = info;
    },
  };
}

async function withGuards(
  run: (post: (init?: { body?: string; headers?: Record<string, string> }) => Promise<Response>) => Promise<void>,
  options: { perUid?: number; perIp?: number; now?: () => number } = {},
) {
  const isolated = express();
  isolated.post('/api/analyze-circular', ...createAnalysisGuards(() => undefined, options), (_req, res) => {
    res.json({ success: true });
  });
  const server = isolated.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/analyze-circular`;
  try {
    await run((init = {}) => fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...init.headers },
      body: init.body ?? '{}',
    }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

function assertNoSecrets(text: string, secrets: string[]) {
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `segreto inatteso: ${secret.slice(0, 12)}`);
  }
  assert.doesNotMatch(text, /bearer\s|eyJ/i);
}

test('Cache-Control: max-age, s-maxage, Age, no-store e no-cache', () => {
  assert.equal(remainingFreshnessMs('public, max-age=3600', null), 3_600_000);
  assert.equal(remainingFreshnessMs('public, max-age=10, s-maxage=4', null), 4_000);
  assert.equal(remainingFreshnessMs('public, max-age=100', '40'), 60_000);
  assert.equal(remainingFreshnessMs('public, max-age=10', '10'), null);
  assert.equal(remainingFreshnessMs('no-store, max-age=3600', null), null);
  assert.equal(remainingFreshnessMs('public, no-cache, max-age=3600', null), null);
  assert.equal(remainingFreshnessMs('public, max-age=0', null), null);
  assert.equal(remainingFreshnessMs(null, null), null);
  assert.equal(truncateUid('abcdefghijklmnopqrstuvwxyz'), 'abcdefgh');
  assert.equal(truncateUid('abc'), 'abc');
});

test('il gancio di test non si installa senza ANALYSIS_AUTH_TEST_HOOK e il file non sostituisce Google', () => {
  const previousHook = process.env.ANALYSIS_AUTH_TEST_HOOK;
  const previousFile = process.env.ANALYSIS_AUTH_TEST_CERTS_FILE;
  delete process.env.ANALYSIS_AUTH_TEST_HOOK;
  process.env.ANALYSIS_AUTH_TEST_CERTS_FILE = '/tmp/certs-non-usati.json';
  try {
    assert.equal(analysisKeySourceKind(), 'google');
    assert.throws(() => setAnalysisKeyFetcherForTests(async () => {
      throw new Error('non deve essere installato');
    }), /disabled/);
  } finally {
    process.env.ANALYSIS_AUTH_TEST_HOOK = previousHook;
    if (previousFile === undefined) delete process.env.ANALYSIS_AUTH_TEST_CERTS_FILE;
    else process.env.ANALYSIS_AUTH_TEST_CERTS_FILE = previousFile;
  }
});

test('senza intestazione → 401, e il corpo malformato non viene letto', async () => {
  const logs = captureWarn();
  try {
    await withGuards(async post => {
      const missing = await post({ headers: {} });
      assert.equal(missing.status, 401);
      assert.match(missing.headers.get('cache-control') ?? '', /no-store/);
      const body = await missing.json() as { success: boolean; error: string };
      assert.equal(body.success, false);
      assert.equal(body.error, ANALYSIS_UNAUTHENTICATED_MESSAGE);

      const malformed = await post({ body: '{"incomplete"', headers: {} });
      assert.equal(malformed.status, 401, 'l\'auth precede il parser JSON: non è un 400');
      assert.equal((await malformed.json()).error, ANALYSIS_UNAUTHENTICATED_MESSAGE);

      const wrongScheme = await post({ headers: { Authorization: 'Basic abc.def.ghi' } });
      assert.equal(wrongScheme.status, 401);
    });
  } finally {
    logs.restore();
  }
  assert.ok(logs.lines.some(line => line.includes('motivo=token-assente')));
  assert.ok(logs.lines.every(line => !line.includes('@') && !/eyJ/i.test(line)));
});

test('firma non valida, token scaduto e progetto diverso → 401, senza token né email nei log', async () => {
  const now = Math.floor(Date.now() / 1000);
  const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const email = 'segreto.docente@scuola.edu.it';
  const uid = 'abcdefghijklmnopqrstuvwxyz012345';
  const logs = captureWarn();
  try {
    await withGuards(async post => {
      const badSig = fixture.sign({ privateKey: foreign, email, uid });
      const expired = fixture.sign({ exp: now - 120, email, uid });
      const otherProject = fixture.sign({ projectId: 'altro-progetto', email, uid });
      for (const token of [badSig, expired, otherProject]) {
        const res = await post({ headers: { Authorization: `Bearer ${token}` } });
        assert.equal(res.status, 401);
        const text = await res.text();
        assert.equal(JSON.parse(text).error, ANALYSIS_UNAUTHENTICATED_MESSAGE);
        assertNoSecrets(text, [token, email, uid]);
      }
      const hs = fixture.sign({ alg: 'HS256', email, uid });
      assert.equal((await post({ headers: { Authorization: `Bearer ${hs}` } })).status, 401);
    });
  } finally {
    logs.restore();
  }
  const joined = logs.lines.join('\n');
  assert.match(joined, /motivo=firma-non-valida/);
  assert.match(joined, /motivo=token-scaduto/);
  assert.match(joined, /motivo=progetto-diverso/);
  assert.match(joined, /uid=abcdefgh/);
  assert.equal(joined.includes(uid.slice(8)), false, 'uid troncato');
  assertNoSecrets(joined, [email, 'segreto.docente']);
});

test('email non verificata e email fuori elenco → 403; maiuscole diverse → passa', async () => {
  const previous = process.env.ANALYSIS_ALLOWED_EMAILS;
  const logs = captureWarn();
  try {
    process.env.ANALYSIS_ALLOWED_EMAILS = ' Docente@Example.COM ';
    await withGuards(async post => {
      const unverified = await post({ headers: fixture.headers({ email: 'docente@example.com', emailVerified: false, uid: 'unverified1' }) });
      assert.equal(unverified.status, 403);
      assert.equal((await unverified.json()).error, ANALYSIS_UNAUTHORIZED_MESSAGE);

      const missingFlag = await post({ headers: fixture.headers({ email: 'docente@example.com', omitEmailVerified: true, uid: 'noflag0001' }) });
      assert.equal(missingFlag.status, 403);

      const outsider = await post({ headers: fixture.headers({ email: 'altro@example.com', uid: 'outsider01' }) });
      assert.equal(outsider.status, 403);
      const outsiderText = await outsider.text();
      assert.doesNotMatch(outsiderText, /altro@example.com|docente/i);

      const mixed = await post({ headers: fixture.headers({ email: 'docente@example.com', uid: 'mixedcase1' }) });
      assert.equal(mixed.status, 200, 'allowlist con maiuscole diverse accetta l\'email verificata');
      const upper = await post({ headers: fixture.headers({ email: 'DOCENTE@EXAMPLE.COM', uid: 'uppercase1' }) });
      assert.equal(upper.status, 200);
    });
  } finally {
    process.env.ANALYSIS_ALLOWED_EMAILS = previous;
    logs.restore();
  }
  const joined = logs.lines.join('\n');
  assert.match(joined, /motivo=email-non-verificata/);
  assert.match(joined, /motivo=email-non-autorizzata/);
  assert.doesNotMatch(joined, /docente@example\.com|altro@example|DOCENTE@/i);
});

test('elenco vuoto o project id assente → 503 Analisi non configurata, anche con token valido', async () => {
  const previousEmails = process.env.ANALYSIS_ALLOWED_EMAILS;
  const previousProject = process.env.FIREBASE_PROJECT_ID;
  const previousVite = process.env.VITE_FIREBASE_PROJECT_ID;
  try {
    for (const empty of ['', '  ', ' , , ']) {
      process.env.ANALYSIS_ALLOWED_EMAILS = empty;
      process.env.FIREBASE_PROJECT_ID = fixture.projectId;
      await withGuards(async post => {
        const res = await post({ headers: fixture.headers({ uid: 'configured1' }) });
        assert.equal(res.status, 503, `allowlist ${JSON.stringify(empty)}`);
        const body = await res.json() as { error: string; errorCode: string };
        assert.equal(body.error, ANALYSIS_NOT_CONFIGURED_MESSAGE);
        assert.equal(body.errorCode, ANALYSIS_NOT_CONFIGURED_CODE);
      });
    }
    delete process.env.ANALYSIS_ALLOWED_EMAILS;
    await withGuards(async post => {
      const res = await post({ headers: fixture.headers() });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, ANALYSIS_NOT_CONFIGURED_MESSAGE);
    });
    process.env.ANALYSIS_ALLOWED_EMAILS = fixture.email;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.VITE_FIREBASE_PROJECT_ID;
    await withGuards(async post => {
      const res = await post({ headers: fixture.headers() });
      assert.equal(res.status, 503, 'senza project id non si accetta nessun progetto');
    });
    process.env.VITE_FIREBASE_PROJECT_ID = fixture.projectId;
    await withGuards(async post => {
      const res = await post({ headers: fixture.headers() });
      assert.equal(res.status, 200, 'VITE_FIREBASE_PROJECT_ID è il fallback se FIREBASE_PROJECT_ID manca');
    });
    process.env.FIREBASE_PROJECT_ID = 'progetto-server';
    process.env.VITE_FIREBASE_PROJECT_ID = fixture.projectId;
    await withGuards(async post => {
      const viteToken = await post({ headers: fixture.headers({ projectId: fixture.projectId }) });
      assert.equal(viteToken.status, 401, 'FIREBASE_PROJECT_ID prevale sul valore Vite');
      const serverToken = await post({ headers: fixture.headers({ projectId: 'progetto-server' }) });
      assert.equal(serverToken.status, 200);
    });
  } finally {
    process.env.ANALYSIS_ALLOWED_EMAILS = previousEmails;
    if (previousProject === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = previousProject;
    if (previousVite === undefined) delete process.env.VITE_FIREBASE_PROJECT_ID;
    else process.env.VITE_FIREBASE_PROJECT_ID = previousVite;
  }
});

test('rate limit per uid: uid diversi non condividono il bucket, l\'header forgiato non lo sposta', async () => {
  let now = 0;
  const alice = analysisAuthHeaders({ uid: 'aliceuid1' });
  const bob = analysisAuthHeaders({ uid: 'bobuid001' });
  await withGuards(async post => {
    assert.equal((await post({ headers: alice })).status, 200);
    const blocked = await post({ headers: { ...alice, 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('Retry-After'), '60');
    assert.equal((await post({ headers: { ...bob, 'X-Forwarded-For': '9.9.9.9' } })).status, 200, 'altro uid, stesso IP: budget proprio');
    assert.equal((await post({ headers: bob })).status, 429);
    now = 60_001;
    assert.equal((await post({ headers: alice })).status, 200, 'la finestra si rinnova per uid');
  }, { perUid: 1, now: () => now });
});

test('la cache delle chiavi segue Cache-Control e non chiama Google', async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('googleapis.com') || url.includes('securetoken')) {
      throw new Error(`chiamata Google inattesa: ${url}`);
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    let cachedFetches = 0;
    setAnalysisKeyFetcherForTests(async () => {
      cachedFetches += 1;
      return { status: 200, body: fixture.certsJson, cacheControl: 'public, max-age=3600', age: null };
    });
    await withGuards(async post => {
      assert.equal((await post({ headers: fixture.headers({ uid: 'cacheuser1' }) })).status, 200);
      assert.equal((await post({ headers: fixture.headers({ uid: 'cacheuser2' }) })).status, 200);
    });
    assert.equal(cachedFetches, 1, 'max-age riusa le chiavi');

    let noStoreFetches = 0;
    setAnalysisKeyFetcherForTests(async () => {
      noStoreFetches += 1;
      return { status: 200, body: fixture.certsJson, cacheControl: 'no-store', age: null };
    });
    await withGuards(async post => {
      assert.equal((await post({ headers: fixture.headers({ uid: 'nostore001' }) })).status, 200);
      assert.equal((await post({ headers: fixture.headers({ uid: 'nostore002' }) })).status, 200);
    });
    assert.equal(noStoreFetches, 2, 'no-store non riusa le chiavi');

    let clock = Date.now();
    let agedFetches = 0;
    setAnalysisAuthNowForTests(() => clock);
    setAnalysisKeyFetcherForTests(async () => {
      agedFetches += 1;
      return { status: 200, body: fixture.certsJson, cacheControl: 'public, max-age=10', age: '0' };
    });
    await withGuards(async post => {
      assert.equal((await post({ headers: fixture.headers({ uid: 'ageduser01' }) })).status, 200);
      clock += 9_000;
      assert.equal((await post({ headers: fixture.headers({ uid: 'ageduser02' }) })).status, 200);
      clock += 2_000;
      assert.equal((await post({ headers: fixture.headers({ uid: 'ageduser03' }) })).status, 200);
    });
    assert.equal(agedFetches, 2, 'entro max-age una sola fetch, oltre si rinnova');
  } finally {
    globalThis.fetch = originalFetch;
    setAnalysisAuthNowForTests(null);
    installAnalysisAuthFixture(fixture, async () => {
      fetches += 1;
      return { status: 200, body: fixture.certsJson, cacheControl: 'public, max-age=3600', age: null };
    });
  }
});

test('i tre endpoint reali senza token rispondono 401 e non aprono l\'analisi', async () => {
  process.env.FIREBASE_PROJECT_ID = fixture.projectId;
  process.env.ANALYSIS_ALLOWED_EMAILS = fixture.email;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const path of ['/api/analyze-circular', '/api/analyze-timetable', '/api/analyze-student-document']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"text":"segreto-circolare"',
      });
      assert.equal(res.status, 401, path);
      const text = await res.text();
      assert.equal(JSON.parse(text).error, ANALYSIS_UNAUTHENTICATED_MESSAGE);
      assert.doesNotMatch(text, /segreto-circolare/);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});
