import type { CalendarEvent, CircularDocument } from "../../types";
import type {
  ItemsCollection,
  RemoteItem,
  RemoteSnapshot,
  StateDocName,
  StateTrack,
  SyncStateV1,
  SyncableSnapshot,
} from "./types";
import { ITEMS_COLLECTIONS, STATE_DOC_NAMES } from "./types";
import { isPlaceholderFullName } from "../../utils/names";

/** Deterministic key-order-insensitive serialization + FNV-1a hash: content identity only. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(",")}}`;
}
export function contentHash(value: unknown): string {
  const s = canonicalStringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, "0")}-${s.length.toString(36)}`;
}

export const statePayload = (snapshot: SyncableSnapshot, name: StateDocName): unknown =>
  name === "settings"
    ? { timetableMode: snapshot.timetableMode, onboardingCompleted: snapshot.onboardingCompleted }
    : snapshot[name];

export interface PlanContext {
  uid: string;
  snapshot: SyncableSnapshot;
  remote: RemoteSnapshot;
  /** Persisted sync state, or null on first sync for this account. Stale uids are ignored. */
  syncState: SyncStateV1 | null;
  nowIso: string;
  /** Explicit user decision after an unresolved "both changed since install" conflict. */
  resolution?: "local" | "remote" | null;
}

export interface SyncPlan {
  /** New device adopts the cloud copy wholesale (pristine local, or user chose "use cloud"). */
  fullRestore: SyncableSnapshot | null;
  /** Partial local replacements produced by remote-newer rows or mirrored deletions. */
  localEvents?: CalendarEvent[];
  localCirculars?: CircularDocument[];
  localApplyState: Partial<Record<StateDocName, unknown>>;
  remoteWrites: Record<ItemsCollection, Record<string, unknown>>;
  remoteDeletes: Record<ItemsCollection, string[]>;
  stateWrites: Partial<Record<StateDocName, unknown>>;
  /** State docs edited independently on both sides without any shared history: the user must choose. */
  needsResolution: StateDocName[];
  /** Remote copies preserved before a local-wins overwrite. Nothing is ever silently destroyed. */
  archivedOnOverwrite: { kind: string; loser: unknown }[];
  nextState: SyncStateV1;
  changedSomething: boolean;
}

export function itemsDigest(rows: { id: string }[]): string {
  return contentHash([...rows.map(row => [row.id, contentHash(row)] as [string, string])].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

const emptyState = (uid: string): SyncStateV1 => ({
  uid,
  state: {},
  items: { events: { docs: {} }, circulars: { docs: {} } },
});

const isNonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** A local database is "pristine" when only the empty-install placeholder exists: safe to restore. */
export function isPristineLocal(snapshot: SyncableSnapshot): boolean {
  return (
    snapshot.events.length === 0 &&
    snapshot.circulars.length === 0 &&
    snapshot.students.length === 0 &&
    snapshot.definitiveTimetable.length === 0 &&
    snapshot.provisionalTimetable.length === 0 &&
    (isPlaceholderFullName(snapshot.profile.fullName) || !snapshot.profile.schoolName.trim())
  );
}

const remoteHasData = (remote: RemoteSnapshot): boolean =>
  STATE_DOC_NAMES.some(n => remote.state[n]) || ITEMS_COLLECTIONS.some(c => (remote.items[c] || []).length > 0);

/** Re-derive a full local snapshot from remote copies, tolerating partial remote trees. */
export function snapshotFromRemote(remote: RemoteSnapshot): Partial<Record<StateDocName, unknown>> & { events?: CalendarEvent[]; circulars?: CircularDocument[] } {
  const out: any = {};
  for (const name of STATE_DOC_NAMES) {
    const doc = remote.state[name];
    if (!doc) continue;
    if (name === "settings") {
      if (doc.payload && typeof doc.payload === "object") Object.assign(out, doc.payload);
    } else out[name] = doc.payload;
  }
  if (remote.items.events.length) out.events = remote.items.events.map(i => i.payload);
  if (remote.items.circulars.length) out.circulars = remote.items.circulars.map(i => i.payload);
  return out;
}

/**
 * Pure three-way merge planner (IndexedDB snapshot vs cloud vs last-synced state).
 * Rules — never overwrite newer data with older, never fabricate, never lose silently:
 *  1. remote empty + local has data                    -> initial upload;
 *  2. remote present + pristine local                  -> restore everything down;
 *  3. both present, per state doc:
 *       only local changed  -> push;
 *       only remote changed -> pull;
 *       both changed        -> newer wall-clock wins, the loser copy is archived under
 *                              users/{uid}/conflicts first; without shared history the
 *                              user is asked to resolve instead of guessing.
 *  4. item rows merge by id (union); a deletion propagates to the other side only when
 *     the other side has not touched the row since the last sync; otherwise it resurrects.
 */
export function planSync(ctx: PlanContext): SyncPlan {
  const { uid, snapshot, remote, nowIso, resolution } = ctx;
  const syncState = ctx.syncState && ctx.syncState.uid === uid ? ctx.syncState : null;
  const nextState: SyncStateV1 = syncState ? structuredClone(syncState) : emptyState(uid);
  const plan: SyncPlan = {
    fullRestore: null,
    localApplyState: {},
    remoteWrites: { events: {}, circulars: {} },
    remoteDeletes: { events: [], circulars: [] },
    stateWrites: {},
    needsResolution: [],
    archivedOnOverwrite: [],
    nextState,
    changedSomething: false,
  };

  const remoteKnown = remoteHasData(remote);
  if (!syncState && !resolution && isPristineLocal(snapshot) && remoteKnown) {
    // New device (or cleared local data): adopt the cloud snapshot wholesale.
    plan.fullRestore = buildFullRestore(snapshot, remote);
    syncAllTracks(nextState, snapshot, remote, nowIso);
    plan.changedSomething = true;
    return plan;
  }
  if (!syncState && resolution === "remote" && remoteKnown) {
    plan.fullRestore = buildFullRestore(snapshot, remote);
    syncAllTracks(nextState, snapshot, remote, nowIso);
    plan.changedSomething = true;
    return plan;
  }

  const forcePush = resolution === "local";

  // --- state documents ---
  for (const name of STATE_DOC_NAMES) {
    const localPayload = statePayload(snapshot, name);
    const hL = contentHash(localPayload);
    const remoteDoc = remote.state[name] ?? null;
    const track: StateTrack | undefined = nextState.state[name];
    const localChanged = !track || track.lastSyncedLocalHash !== hL;
    const remoteChanged = remoteDoc ? !track || remoteDoc.updatedAt !== track.remoteUpdatedAt : Boolean(track?.remoteUpdatedAt);

    if (forcePush) {
      if (remoteDoc) plan.archivedOnOverwrite.push({ kind: `state:${name}`, loser: remoteDoc.payload });
      plan.stateWrites[name] = localPayload;
      nextState.state[name] = { lastSyncedLocalHash: hL, remoteUpdatedAt: nowIso };
      plan.changedSomething = true;
      continue;
    }

    if (!remoteDoc && !track) {
      // Never synced and no remote copy: initial upload (also when local is pristine-but-empty: harmless, cheap).
      plan.stateWrites[name] = localPayload;
      nextState.state[name] = { lastSyncedLocalHash: hL, remoteUpdatedAt: null };
      plan.changedSomething = true;
      continue;
    }
    if (remoteDoc && !track) {
      // Remote exists but this device has no history: only a pristine local may silently adopt it.
      if (isPristineLocal(snapshot) || localCollectionEmpty(snapshot, name)) {
        plan.localApplyState[name] = remoteDoc.payload;
        nextState.state[name] = { lastSyncedLocalHash: contentHash(remoteDoc.payload), remoteUpdatedAt: remoteDoc.updatedAt };
        plan.changedSomething = true;
      } else {
        plan.needsResolution.push(name);
      }
      continue;
    }
    if (!remoteDoc && track) {
      // Remote copy disappeared (account data cleared elsewhere): re-push local truth.
      plan.stateWrites[name] = localPayload;
      nextState.state[name] = { ...track, remoteUpdatedAt: null };
      plan.changedSomething = true;
      continue;
    }
    if (!remoteDoc || !track) continue;
    if (!localChanged && !remoteChanged) continue;
    if (localChanged && !remoteChanged) {
      plan.stateWrites[name] = localPayload;
      nextState.state[name] = { ...track, lastSyncedLocalHash: hL };
      delete nextState.state[name]!.localChangedAt;
      plan.changedSomething = true;
      continue;
    }
    if (!localChanged && remoteChanged) {
      plan.localApplyState[name] = remoteDoc.payload;
      nextState.state[name] = { lastSyncedLocalHash: contentHash(remoteDoc.payload), remoteUpdatedAt: remoteDoc.updatedAt };
      plan.changedSomething = true;
      continue;
    }
    // Both changed -> explicit comparison; unknown local time asks the user instead of guessing.
    const localAt = track.localChangedAt;
    if (!localAt) { plan.needsResolution.push(name); continue; }
    if (localAt > remoteDoc.updatedAt) {
      plan.archivedOnOverwrite.push({ kind: `state:${name}`, loser: remoteDoc.payload });
      plan.stateWrites[name] = localPayload;
      nextState.state[name] = { ...track, lastSyncedLocalHash: hL, remoteUpdatedAt: nowIso };
      delete nextState.state[name]!.localChangedAt;
    } else {
      plan.localApplyState[name] = remoteDoc.payload;
      nextState.state[name] = { lastSyncedLocalHash: contentHash(remoteDoc.payload), remoteUpdatedAt: remoteDoc.updatedAt };
    }
    plan.changedSomething = true;
  }

  // --- item collections (events / circulars): id-level three-way merge (union + LWW + mirrored deletions) ---
  for (const coll of ITEMS_COLLECTIONS) {
    const track = nextState.items[coll];
    const localRows = new Map<string, { row: CalendarEvent | CircularDocument; hash: string }>(
      (coll === "events" ? snapshot.events : snapshot.circulars).map(row => [row.id, { row, hash: contentHash(row) }] as [string, { row: CalendarEvent | CircularDocument; hash: string }])
    );
    const remoteRows = new Map<string, RemoteItem>(remote.items[coll].map(item => [item.id, item] as [string, RemoteItem]));

    const ensureLocalList = () => {
      if (coll === "events") plan.localEvents ??= [...snapshot.events];
      else plan.localCirculars ??= [...snapshot.circulars];
    };
    const recordSync = (id: string, hash: string, updatedAt: string) => {
      track.docs[id] = { hash, updatedAt };
    };

    for (const [id, local] of localRows) {
      const remoteItem = remoteRows.get(id);
      const synced = track.docs[id];
      const localChanged = !synced || synced.hash !== local.hash;

      if (!remoteItem) {
        if (synced && !localChanged) {
          // Row was deleted on the other side while we left it untouched: mirror the deletion locally.
          ensureLocalList();
          removeLocalRow(plan, coll, id);
          delete track.docs[id];
          plan.changedSomething = true;
          continue;
        }
        // New here (or edited here after a remote deletion): push.
        plan.remoteWrites[coll][id] = local.row;
        recordSync(id, local.hash, nowIso);
        plan.changedSomething = true;
        continue;
      }

      const remoteChanged = !synced || remoteItem.updatedAt !== synced.updatedAt;
      if (!localChanged && !remoteChanged) {
        // Already in agreement.
        continue;
      }
      if (forcePush) {
        if (synced && remoteItem.updatedAt !== synced.updatedAt) {
          plan.archivedOnOverwrite.push({ kind: `item:${coll}:${id}`, loser: remoteItem.payload });
        }
        plan.remoteWrites[coll][id] = local.row;
        recordSync(id, local.hash, nowIso);
        plan.changedSomething = true;
        continue;
      }
      if (localChanged && !remoteChanged) {
        plan.remoteWrites[coll][id] = local.row;
        recordSync(id, local.hash, nowIso);
        plan.changedSomething = true;
        continue;
      }
      if (!localChanged && remoteChanged) {
        ensureLocalList();
        applyRemoteRow(plan, coll, remoteItem.payload as CalendarEvent & CircularDocument);
        recordSync(id, contentHash(remoteItem.payload), remoteItem.updatedAt);
        plan.changedSomething = true;
        continue;
      }
      // Both sides edited the same row. Without shared history (never synced) the active device wins
      // and the remote copy is archived; otherwise the newer wall-clock wins, loser archived.
      const remoteIsNewer = Boolean(synced) && Boolean(track.changedAt) && remoteItem.updatedAt > (track.changedAt as string);
      if (remoteIsNewer) {
        ensureLocalList();
        applyRemoteRow(plan, coll, remoteItem.payload as CalendarEvent & CircularDocument);
        recordSync(id, contentHash(remoteItem.payload), remoteItem.updatedAt);
      } else {
        plan.archivedOnOverwrite.push({ kind: `item:${coll}:${id}`, loser: remoteItem.payload });
        plan.remoteWrites[coll][id] = local.row;
        recordSync(id, local.hash, nowIso);
      }
      plan.changedSomething = true;
    }

    for (const [id, remoteItem] of remoteRows) {
      if (localRows.has(id)) continue;
      const synced = track.docs[id];
      if (!synced) {
        // Created on another device: bring it down.
        ensureLocalList();
        applyRemoteRow(plan, coll, remoteItem.payload as CalendarEvent & CircularDocument);
        recordSync(id, contentHash(remoteItem.payload), remoteItem.updatedAt);
        plan.changedSomething = true;
        continue;
      }
      // Known on both sides, gone from local: assume a local deletion. Propagate it only when
      // the other side has not touched the row since the last sync; otherwise it resurrects here.
      if (remoteItem.updatedAt === synced.updatedAt) {
        plan.remoteDeletes[coll].push(id);
        delete track.docs[id];
        plan.changedSomething = true;
        continue;
      }
      if (forcePush) {
        plan.remoteDeletes[coll].push(id);
        delete track.docs[id];
        plan.changedSomething = true;
        continue;
      }
      ensureLocalList();
      applyRemoteRow(plan, coll, remoteItem.payload as CalendarEvent & CircularDocument);
      recordSync(id, contentHash(remoteItem.payload), remoteItem.updatedAt);
      plan.changedSomething = true;
    }

    // Forget sync records for rows that no longer exist anywhere (deleted on both sides).
    for (const id of Object.keys(track.docs)) {
      if (!localRows.has(id) && !remoteRows.has(id)) delete track.docs[id];
    }
    // After this cycle commits, local content for this collection equals the merged list:
    // keep the digest in sync so the engine's local-change detector does not false-positive
    // on rows we just pulled (prevents push/pull ping-pong loops).
    track.lastSyncedHash = itemsDigest(coll === "events" ? (plan.localEvents ?? snapshot.events) : (plan.localCirculars ?? snapshot.circulars));
    track.lastDetectedHash = undefined;
    if (Object.keys(plan.remoteWrites[coll]).length === 0) delete track.changedAt;
  }

  return plan;
}

function localCollectionEmpty(snapshot: SyncableSnapshot, name: StateDocName): boolean {
  switch (name) {
    case "students": return snapshot.students.length === 0;
    case "definitiveTimetable": return snapshot.definitiveTimetable.length === 0;
    case "provisionalTimetable": return snapshot.provisionalTimetable.length === 0;
    case "profile": return isPlaceholderFullName(snapshot.profile.fullName);
    case "settings": return !snapshot.onboardingCompleted;
  }
}

function applyRemoteRow(plan: SyncPlan, coll: ItemsCollection, row: CalendarEvent & CircularDocument) {
  if (coll === "events") {
    const list = plan.localEvents!;
    const idx = list.findIndex(e => e.id === row.id);
    const patched = { ...(row as CalendarEvent) };
    if (idx >= 0) list[idx] = patched; else list.push(patched);
  } else {
    const list = plan.localCirculars!;
    const idx = list.findIndex(c => c.id === row.id);
    const incoming = row as CircularDocument;
    if (idx >= 0) list[idx] = { ...incoming, rawText: incoming.rawText ?? list[idx]?.rawText };
    else list.push(incoming);
  }
}

function removeLocalRow(plan: SyncPlan, coll: ItemsCollection, id: string) {
  if (coll === "events") plan.localEvents = plan.localEvents!.filter(e => e.id !== id);
  else plan.localCirculars = plan.localCirculars!.filter(c => c.id !== id);
}

function buildFullRestore(snapshot: SyncableSnapshot, remote: RemoteSnapshot): SyncableSnapshot {
  const fromRemote = snapshotFromRemote(remote);
  const merged = { ...snapshot, ...fromRemote } as SyncableSnapshot;
  // Missing remote collections on a partial cloud snapshot stay as the (empty) local values.
  return merged;
}

function syncAllTracks(nextState: SyncStateV1, snapshot: SyncableSnapshot, remote: RemoteSnapshot, nowIso: string) {
  for (const name of STATE_DOC_NAMES) {
    const remoteDoc = remote.state[name];
    if (remoteDoc) {
      nextState.state[name] = { lastSyncedLocalHash: contentHash(remoteDoc.payload), remoteUpdatedAt: remoteDoc.updatedAt };
    } else {
      nextState.state[name] = { lastSyncedLocalHash: contentHash(statePayload(snapshot, name)), remoteUpdatedAt: null };
    }
  }
  for (const coll of ITEMS_COLLECTIONS) {
    const docs: Record<string, { hash: string; updatedAt: string }> = {};
    for (const item of remote.items[coll]) docs[item.id] = { hash: contentHash(item.payload), updatedAt: item.updatedAt };
    nextState.items[coll] = { docs };
  }
  nextState.lastCompletedAt = nowIso;
}
