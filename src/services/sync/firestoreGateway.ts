import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
import type { FirebaseApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import type { ItemsCollection, RemoteItem, RemoteStateDoc, StateDocName, SyncGateway } from "./types";

/** Firestore single-document hard limit is 1 MiB; keep a safety margin for metadata. */
export const CLOUD_DOC_BYTE_LIMIT = 900_000;
const MAX_BATCH_OPS = 450;

export function sanitizeFirestorePayload<T>(value: T): T {
  if (value === undefined) return null as unknown as T;
  return JSON.parse(JSON.stringify(value));
}

export function estimateBytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).length; }
  catch { return Number.POSITIVE_INFINITY; }
}

/**
 * Firestore account gateway. Every path is rooted at the Firebase uid, so user data is
 * physically separated and Security Rules (see firestore.rules) are the only gate needed.
 */
export function createFirestoreGateway(app: FirebaseApp | null, getUid: () => string | null): SyncGateway | null {
  if (!app) return null;
  let db: Firestore | null = null;
  const database = () => (db ??= getFirestore(app!));
  const uid = () => {
    const value = getUid();
    if (!value) throw new Error("Accesso Google richiesto per la sincronizzazione account.");
    return value;
  };

  return {
    async readState(name: StateDocName): Promise<RemoteStateDoc | null> {
      const snapshot = await getDoc(doc(database(), `users/${uid()}/state`, name));
      if (!snapshot.exists()) return null;
      return snapshot.data() as RemoteStateDoc;
    },
    async writeState(name: StateDocName, payload: unknown): Promise<{ updatedAt: string }> {
      const updatedAt = new Date().toISOString();
      const sanitized = sanitizeFirestorePayload(payload);
      if (estimateBytes(sanitized) > CLOUD_DOC_BYTE_LIMIT) throw new Error(`"${name}" supera lo spazio cloud disponibile: resta salvato in locale.`);
      await setDoc(doc(database(), `users/${uid()}/state`, name), { payload: sanitized, updatedAt, schemaVersion: 1 });
      return { updatedAt };
    },
    async listItems(collectionName: ItemsCollection): Promise<RemoteItem[]> {
      const querySnapshot = await getDocs(collection(database(), `users/${uid()}`, collectionName));
      return querySnapshot.docs.map(entry => ({ id: entry.id, ...(entry.data() as Omit<RemoteItem, "id">) }));
    },
    async writeItems(collectionName: ItemsCollection, entries: { id: string; payload: unknown }[]): Promise<void> {
      for (let offset = 0; offset < entries.length; offset += MAX_BATCH_OPS) {
        const chunk = entries.slice(offset, offset + MAX_BATCH_OPS);
        const batch = writeBatch(database());
        for (const { id, payload } of chunk) {
          const sanitized = sanitizeFirestorePayload(payload);
          if (estimateBytes(sanitized) > CLOUD_DOC_BYTE_LIMIT) {
            throw new Error("Un documento è troppo grande per il cloud: è stato conservato solo in locale.");
          }
          batch.set(doc(database(), `users/${uid()}/${collectionName}`, id), { payload: sanitized, updatedAt: new Date().toISOString() });
        }
        await batch.commit();
      }
    },
    async deleteItems(collectionName: ItemsCollection, ids: string[]): Promise<void> {
      for (let offset = 0; offset < ids.length; offset += MAX_BATCH_OPS) {
        const batch = writeBatch(database());
        for (const id of ids.slice(offset, offset + MAX_BATCH_OPS)) batch.delete(doc(database(), `users/${uid()}/${collectionName}`, id));
        await batch.commit();
      }
    },
    async archiveConflict(kind: string, loser: unknown): Promise<void> {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sanitized = sanitizeFirestorePayload(loser);
      await setDoc(doc(database(), `users/${uid()}/conflicts`, id), {
        kind,
        createdAt: new Date().toISOString(),
        payload: sanitized,
      }, { merge: false });
    },
  };
}

/** Path layout used by the gateway and by firestore.rules (kept in sync by tests). */
export const CLOUD_PATH_PATTERN = /^users\/[A-Za-z0-9_-]+\/(state\/[a-zA-Z]+|events\/[^/]+|circulars\/[^/]+|conflicts\/[^/]+)$/;
