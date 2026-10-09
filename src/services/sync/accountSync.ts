import { auth, firebaseApp } from "../googleAuth";
import { createFirestoreGateway } from "./firestoreGateway";
import { createStoreAdapter, observeLocalCommits } from "./localStore";
import { SyncEngine } from "./engine";
import { database } from "../db";
import { EncryptionKeystore, createSensitiveSyncAdapter, decryptLocalProfile, decryptLocalStudents } from "../encryptionKeys";

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

/**
 * Subito dopo lo sblocco: i blob cifrati già presenti nelle righe locali
 * (arrivati col ripristino quando il dispositivo era ancora bloccato) vengono
 * decifrati in locale, senza attendere il prossimo ingresso dal cloud.
 * Restituisce true se qualcosa è stato applicato.
 */
export async function applyLocalDecryption(uid: string): Promise<boolean> {
  const key = await encryptionKeystore.deviceKey(uid);
  if (!key) return false;
  const [students, profile] = await Promise.all([database.read("students"), database.read("profile")]);
  const decryptedStudents = await decryptLocalStudents(students, key);
  const decryptedProfile = await decryptLocalProfile(profile, key);
  if (!decryptedStudents.changed && !decryptedProfile.changed) return false;
  await database.atomic(async () => {
    if (decryptedStudents.changed) await database.write("students", decryptedStudents.students);
    if (decryptedProfile.changed) await database.write("profile", decryptedProfile.profile);
  });
  return true;
}
