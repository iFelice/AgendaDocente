import type { FirebaseOptions } from 'firebase/app';

/** Public build-time Firebase web configuration, never credentials for server APIs. */
export function firebaseOptions(env: Record<string, string | undefined>): FirebaseOptions | null {
  const apiKey = env.VITE_FIREBASE_API_KEY?.trim();
  const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN?.trim();
  const projectId = env.VITE_FIREBASE_PROJECT_ID?.trim();
  const appId = env.VITE_FIREBASE_APP_ID?.trim();
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return { apiKey, authDomain, projectId, appId };
}
