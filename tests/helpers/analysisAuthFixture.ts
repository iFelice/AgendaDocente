import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  setAnalysisKeyFetcherForTests,
  type AnalysisKeyFetcher,
} from '../../server/analysisAuth';

export const TEST_PROJECT_ID = 'agenda-docente-test';
export const TEST_EMAIL = 'docente@example.com';
export const TEST_KID = 'test-key-1';

export interface TestIdTokenClaims {
  uid?: string;
  email?: string;
  emailVerified?: boolean;
  projectId?: string;
  exp?: number;
  iat?: number;
  authTime?: number;
  omitEmail?: boolean;
  omitEmailVerified?: boolean;
  alg?: string;
  kid?: string;
  /** Firma con un'altra chiave: la verifica della firma deve fallire. */
  privateKey?: KeyObject;
}

export interface AnalysisAuthFixture {
  projectId: string;
  email: string;
  kid: string;
  publicPem: string;
  certsJson: string;
  privateKey: KeyObject;
  sign: (claims?: TestIdTokenClaims) => string;
  headers: (claims?: TestIdTokenClaims) => Record<string, string>;
}

let current: AnalysisAuthFixture | null = null;
let sequence = 0;

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

export function signTestJwt(header: object, payload: object, key: KeyObject): string {
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const signature = createSign('RSA-SHA256').update(`${encodedHeader}.${encodedPayload}`).sign(key);
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

export function createAnalysisAuthFixture(options: { projectId?: string; email?: string; kid?: string } = {}): AnalysisAuthFixture {
  const projectId = options.projectId ?? TEST_PROJECT_ID;
  const email = options.email ?? TEST_EMAIL;
  const kid = options.kid ?? TEST_KID;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const certsJson = JSON.stringify({ [kid]: publicPem });
  const sign = (claims: TestIdTokenClaims = {}): string => {
    const now = Math.floor(Date.now() / 1000);
    const tokenProject = claims.projectId ?? projectId;
    const uid = claims.uid ?? `uid${++sequence}${now.toString(36)}`;
    const header = { alg: claims.alg ?? 'RS256', kid: claims.kid ?? kid, typ: 'JWT' };
    const payload: Record<string, unknown> = {
      iss: `https://securetoken.google.com/${tokenProject}`,
      aud: tokenProject,
      sub: uid,
      user_id: uid,
      iat: claims.iat ?? now - 30,
      exp: claims.exp ?? now + 3600,
      auth_time: claims.authTime ?? now - 30,
    };
    if (!claims.omitEmail) payload.email = claims.email ?? email;
    if (!claims.omitEmailVerified) payload.email_verified = claims.emailVerified ?? true;
    return signTestJwt(header, payload, claims.privateKey ?? privateKey);
  };
  return {
    projectId,
    email,
    kid,
    publicPem,
    certsJson,
    privateKey,
    sign,
    headers: (claims) => ({ Authorization: `Bearer ${sign(claims)}` }),
  };
}

export function installAnalysisAuthFixture(
  fixture: AnalysisAuthFixture = createAnalysisAuthFixture(),
  fetcher?: AnalysisKeyFetcher,
): AnalysisAuthFixture {
  process.env.ANALYSIS_AUTH_TEST_HOOK = '1';
  process.env.FIREBASE_PROJECT_ID = fixture.projectId;
  process.env.ANALYSIS_ALLOWED_EMAILS = fixture.email;
  setAnalysisKeyFetcherForTests(fetcher ?? (async () => ({
    status: 200,
    body: fixture.certsJson,
    cacheControl: 'public, max-age=3600',
    age: null,
  })));
  current = fixture;
  return fixture;
}

export function analysisAuthHeaders(claims?: TestIdTokenClaims): Record<string, string> {
  if (!current) throw new Error('analysis auth fixture not installed');
  return current.headers(claims);
}

export function currentAnalysisAuthFixture(): AnalysisAuthFixture {
  if (!current) throw new Error('analysis auth fixture not installed');
  return current;
}
