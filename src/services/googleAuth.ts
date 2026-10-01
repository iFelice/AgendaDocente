import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  signInWithPopup,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
} from "firebase/auth";
import { firebaseOptions } from "./firebaseConfig";

// Initialize Firebase only once
const config = firebaseOptions(import.meta.env || {});
export const firebaseApp = config ? (getApps().length === 0 ? initializeApp(config) : getApp()) : null;
export const auth = firebaseApp ? getAuth(firebaseApp) : null;

// Calendar writes use the primary (owned) calendar; identity scopes alone cannot authorize them.
// G1.2 adds two least-privilege READ-ONLY scopes so shared calendars can be listed and imported.
// The owned write scope is intentionally unchanged: outbound stays primary-only and never widens.
// The OAuth consent screen must allow these scopes for the configured beta testers.
export const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

// G1.2.1 — the provider is built fresh for every sign-in attempt: a shared
// mutable provider could keep prompt=consent alive and force re-consent on
// every later normal login. Normal logins use "select_account" only; the
// explicit "Ricollega Google" CTA adds "consent" so Google re-shows the scope
// screen and grants the new read-only CalendarList scopes.
export function createGoogleProvider(forceConsent = false): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  SCOPES.forEach((scope) => provider.addScope(scope));
  // Allow selecting institutional account (@scuola.edu.it)
  provider.setCustomParameters({
    prompt: forceConsent ? "consent select_account" : "select_account",
  });
  return provider;
}

export interface SignInWithGoogleOptions {
  /**
   * Forces the Google consent screen (prompt="consent select_account").
   * Used ONLY by explicit user gestures such as the "Ricollega Google" CTA
   * when the CalendarList reports insufficient authentication scopes.
   */
  forceConsent?: boolean;
}

// Flag to track ongoing sign in flow
let isSigningIn = false;
// In-memory token cache (NEVER in localStorage/sessionStorage)
let cachedAccessToken: string | null = null;
let cachedUser: User | null = null;

export const isUserCancellationError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: string; message?: string };
  const code = err.code || "";
  const msg = err.message || "";
  return (
    code === "auth/popup-closed-by-user" ||
    code === "auth/cancelled-popup-request" ||
    code === "auth/user-cancelled" ||
    msg.includes("popup-closed-by-user") ||
    msg.includes("cancelled-popup-request")
  );
};

export const initAuth = (
  onAuthSuccess?: (user: User, token: string | null) => void,
  onAuthFailure?: () => void
) => {
  if (!auth) { onAuthFailure?.(); return () => {}; }
  return onAuthStateChanged(auth, async (user: User | null) => {
    cachedUser = user;
    if (user) {
      if (onAuthSuccess) {
        onAuthSuccess(user, cachedAccessToken);
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) {
        onAuthFailure();
      }
    }
  });
};

export const signInWithGoogle = async (options?: SignInWithGoogleOptions): Promise<{
  user: User;
  accessToken: string;
} | null> => {
  if (!auth) throw new Error("Accesso Google non configurato. Puoi continuare a usare l’agenda locale.");
  try {
    isSigningIn = true;
    // Per-call provider: forceConsent never leaks into subsequent logins.
    const result = await signInWithPopup(auth, createGoogleProvider(options?.forceConsent === true));
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error("Impossibile recuperare il token di accesso Google.");
    }
    cachedAccessToken = credential.accessToken;
    cachedUser = result.user;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: unknown) {
    if (isUserCancellationError(error)) {
      // User closed the popup or cancelled the request - safe graceful return
      return null;
    }
    const err = error as { code?: string; message?: string };
    if (err?.code === "auth/popup-blocked") {
      throw new Error(
        "La finestra popup di accesso è stata bloccata dal browser. Abilita i popup per questo sito o apri l'applicazione in una nuova scheda."
      );
    }
    console.warn("Avviso accesso Google:", err?.message || error);
    throw new Error(err?.message || "Accesso con Google non riuscito.");
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const setAccessToken = (token: string | null) => {
  cachedAccessToken = token;
};

export const getCachedUser = (): User | null => {
  return cachedUser || auth?.currentUser || null;
};

export const signOutFromGoogle = async (): Promise<void> => {
  try {
    if (auth) await firebaseSignOut(auth);
  } finally {
    cachedAccessToken = null;
    cachedUser = null;
  }
};
