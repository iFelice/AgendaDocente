import { auth, firebaseApp } from "../googleAuth";
import { createFirestoreGateway } from "./firestoreGateway";
import { createStoreAdapter, observeLocalCommits } from "./localStore";
import { SyncEngine } from "./engine";

/**
 * Multi-device account sync singleton.
 *
 * IndexedDB remains the local/offline database; Cloud Firestore (already configured for
 * Firebase Auth, same public web config — no server secret involved) acts as the account
 * mirror keyed by the Firebase uid: users/{uid}/state/{profile|settings|…} plus
 * users/{uid}/events/{id} and users/{uid}/circulars/{id}. Google Calendar is NOT used as
 * an application datastore; it stays dedicated to calendar entries.
 *
 * Without the public Firebase configuration (no firebaseApp) everything degrades to a
 * no-op: the app keeps working fully local-first.
 */
const gateway = createFirestoreGateway(firebaseApp, () => auth?.currentUser?.uid ?? null);
export const accountSync = new SyncEngine({
  gateway: () => gateway,
  uid: () => auth?.currentUser?.uid ?? null,
  store: createStoreAdapter(),
  observeLocalCommits,
});
