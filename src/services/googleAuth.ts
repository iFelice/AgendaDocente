import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  signInWithPopup,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
} from "firebase/auth";
import firebaseConfig from "../../firebase-applet-config.json";

// Initialize Firebase only once
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

// Only standard, non-sensitive identity scopes for sign in
// (Sensitive scopes like calendar.events trigger "Accesso bloccato: verifica Google non completata")
export const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const provider = new GoogleAuthProvider();
SCOPES.forEach((scope) => provider.addScope(scope));
// Allow selecting institutional account (@scuola.edu.it)
provider.setCustomParameters({
  prompt: "select_account",
});

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

export const signInWithGoogle = async (): Promise<{
  user: User;
  accessToken: string;
} | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
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
  return cachedUser || auth.currentUser;
};

export const signOutFromGoogle = async (): Promise<void> => {
  try {
    await firebaseSignOut(auth);
  } finally {
    cachedAccessToken = null;
    cachedUser = null;
  }
};
