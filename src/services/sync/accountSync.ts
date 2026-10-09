import { auth, firebaseApp } from "../googleAuth";
import { createFirestoreGateway } from "./firestoreGateway";
import { createStoreAdapter, observeLocalCommits } from "./localStore";
import { SyncEngine } from "./engine";
import { database } from "../db";
import { EncryptionKeystore, createSensitiveSyncAdapter } from "../encryptionKeys";

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
export const syncGateway = createFirestoreGateway(firebaseApp, () => auth?.currentUser?.uid ?? null);

/**
 * Keystore della cifratura dei dati riservati: documento chiavi nel cloud e
 * chiave dati sbloccata conservata in IndexedDB come CryptoKey non estraibile.
 */
export const encryptionKeystore = new EncryptionKeystore({
  gateway: () => syncGateway,
  meta: {
    async read(key: string) {
      const row = await database.table("metadata").get(key);
      return row?.value;
    },
    async write(key: string, value: unknown) {
      await database.table("metadata").put({ key, value });
    },
  },
});

export const accountSync = new SyncEngine({
  gateway: () => syncGateway,
  uid: () => auth?.currentUser?.uid ?? null,
  store: createStoreAdapter(),
  observeLocalCommits,
  sensitiveEncryption: createSensitiveSyncAdapter(encryptionKeystore),
});
