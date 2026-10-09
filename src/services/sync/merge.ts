import type { CalendarEvent, CircularDocument, StudentAssessment, StudentScheduledAssessment, TeacherProfile, TimetableSlot, TimeSlotConfig } from "../../types";
import type {
  ItemsCollection,
  RemoteItem,
  RemoteSnapshot,
  RemoteStateDoc,
  StateDocName,
  StateTrack,
  SyncStateV1,
  SyncableSnapshot,
} from "./types";
import { ITEMS_COLLECTIONS, STATE_DOC_NAMES } from "./types";
import { isPlaceholderFullName } from "../../utils/names";
import { isValidStudentAssessment, isValidStudentScheduledAssessment } from "../backup";
import { sanitizeRemoteCalendarEvent } from "./remoteSchema";
import {
  hasSensitiveStatePayload,
  mergeLocalSensitiveProfile,
  mergeLocalSensitiveStudents,
  mergeRemoteStateWithLocalSensitive,
  pickSensitiveStudentFields,
  stripSensitiveLegacyDoc,
  stripSensitiveStatePayload,
  stripSensitiveTransportPayload,
  type DecryptedSensitive,
} from "../sensitiveData";

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

/**
 * Payload BASE locale di un documento di stato: privo dei dati sensibili E del
 * blob cifrato `sensitiveEnc` (trasporto, agganciato solo all'ultimo passo).
 *
 * È la forma usata per gli hash di confronto e come base delle scritture remote.
 * Senza cifratura attiva una modifica ai soli dati sensibili NON produce alcuna
 * sincronizzazione; con la cifratura attiva ci pensa l'impronta dei campi in
 * chiaro (vedi `localStateHash`) a segnalare la modifica.
 */
export const statePayload = (snapshot: SyncableSnapshot, name: StateDocName): unknown =>
  stripSensitiveTransportPayload(
    name,
    name === "settings"
      ? {
          timetableMode: snapshot.timetableMode,
          onboardingCompleted: snapshot.onboardingCompleted,
          ...(snapshot.timeSlotConfig ? { timeSlotConfig: snapshot.timeSlotConfig } : {}),
        }
      : snapshot[name],
  );

/**
 * Impronta (solo locale, mai inviata) dei campi riservati IN CHIARO: alunni
 * per `id`, poi `assignedStudents` del profilo. Con la cifratura attiva entra
 * nell'hash di rilevazione, così una modifica ai dati riservati produce una
 * sincronizzazione (che li porterà nel cloud cifrati).
 */
export function sensitiveStudentsFingerprint(students: unknown): string {
  if (!Array.isArray(students)) return contentHash(null);
  const rows = students
    .filter(row => row && typeof row === "object" && !Array.isArray(row))
    .map(row => [typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id : "", pickSensitiveStudentFields(row)] as [string, unknown])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return contentHash(rows);
}

export function sensitiveProfileFingerprint(profile: unknown): string {
  const assigned = profile && typeof profile === "object" && !Array.isArray(profile)
    ? (profile as { assignedStudents?: unknown }).assignedStudents
    : undefined;
  return contentHash(Array.isArray(assigned) ? assigned : null);
}

export function sensitiveStateFingerprint(name: StateDocName, value: unknown): string {
  if (name === "students") return sensitiveStudentsFingerprint(value);
  if (name === "profile") return sensitiveProfileFingerprint(value);
  return "";
}

const fingerprintSource = (name: StateDocName, source: SyncableSnapshot): unknown =>
  name === "students" ? source.students : name === "profile" ? source.profile : undefined;

/**
 * Hash di rilevazione delle modifiche locali. Con la cifratura INATTIVA è
 * esattamente l'hash del payload base (compatibilità con gli stati di sync già
 * salvati). Con la cifratura ATTIVA include anche l'impronta dei campi
 * riservati in chiaro: l'impronta resta sul dispositivo, nel cloud va solo il
 * blob cifrato.
 */
export function localStateHash(name: StateDocName, basePayload: unknown, sensitiveActive: boolean, fingerprint: string): string {
  if (!sensitiveActive || (name !== "students" && name !== "profile")) return contentHash(basePayload);
  return contentHash({ payload: basePayload, sensitive: fingerprint });
}

/**
 * INGRESSO: un payload remoto che sta per sostituire o unirsi ai dati locali.
 * I campi sensibili in chiaro presenti nel cloud (documenti vecchi) sono sempre
 * ignorati; con il dispositivo sbloccato si applicano invece i valori decifrati
 * dai blob (`decrypted`), con la stessa precedenza del resto della scheda.
 */
const incomingStatePayload = (name: StateDocName, remotePayload: unknown, snapshot: SyncableSnapshot, decrypted?: DecryptedSensitive): unknown =>
  mergeRemoteStateWithLocalSensitive(name, remotePayload, snapshot, decrypted);

export interface PlanContext {
  uid: string;
  snapshot: SyncableSnapshot;
  remote: RemoteSnapshot;
  /** Persisted sync state, or null on first sync for this account. Stale uids are ignored. */
  syncState: SyncStateV1 | null;
  nowIso: string;
  /** Explicit user decision after an unresolved "both changed since install" conflict. */
  resolution?: "local" | "remote" | null;
  /** Original (unvalidated) remote documents, kept for legacy archiving under conflicts/. */
  remoteRaw?: Partial<Record<StateDocName, unknown>>;
  /** State docs whose remote copy is legacy but recoverable (payload extracted and validated). */
  remoteLegacy?: StateDocName[];
  /** State docs whose remote copy is malformed/unrecoverable: they cannot win conflicts. */
  remoteInvalid?: StateDocName[];
  /**
   * Documenti che possono contenere dati sensibili e che il cloud non ha ancora
   * riscritto in forma pulita per QUESTO account (una sola volta, indicatore
   * locale in `sync:sensitive-cleanup`). Vale solo per "students" e "profile".
   */
  sensitiveCleanup?: StateDocName[];
  /**
   * Cifratura dei dati riservati attiva per l'account: gli hash di rilevazione
   * includono l'impronta (locale) dei campi riservati in chiaro.
   */
  sensitiveActive?: boolean;
  /**
   * Blob cifrati già decifrati dal motore (dispositivo sbloccato): in ingresso
   * i valori del cloud si applicano con la stessa precedenza del resto della
   * scheda. Omesso quando il dispositivo non ha la chiave.
   */
  sensitiveDecrypted?: DecryptedSensitive;
}

export interface SyncPlan {
  /** New device adopts the cloud copy wholesale (pristine local, or user chose "use cloud"). */
  fullRestore: SyncableSnapshot | null;
  /** Partial local replacements produced by remote-newer rows or mirrored deletions. */
  localEvents?: CalendarEvent[];
  localCirculars?: CircularDocument[];
  localAssessments?: StudentAssessment[];
  localScheduledAssessments?: StudentScheduledAssessment[];
  localApplyState: Partial<Record<StateDocName, unknown>>;
  remoteWrites: Record<ItemsCollection, Record<string, unknown>>;
  remoteDeletes: Record<ItemsCollection, string[]>;
  stateWrites: Partial<Record<StateDocName, unknown>>;
  /** State docs edited independently on both sides without any shared history: the user must choose. */
  needsResolution: StateDocName[];
  /** Remote copies preserved before a local-wins overwrite. Nothing is ever silently destroyed. */
  archivedOnOverwrite: { kind: string; loser: unknown }[];
  /** Documenti riscritti dal cloud dalla pulizia dei dati sensibili (una volta per account). */
  sensitiveCleanupWritten: StateDocName[];
  /** Remote docs that are malformed AND have no valid local replacement: reported, never fabricated. */
  unrecoverableRemote: StateDocName[];
  nextState: SyncStateV1;
  changedSomething: boolean;
}

export function itemsDigest(rows: { id: string }[]): string {
  return contentHash([...rows.map(row => [row.id, contentHash(row)] as [string, string])].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

const emptyState = (uid: string): SyncStateV1 => ({
  uid,
  state: {},
  items: { events: { docs: {} }, circulars: { docs: {} }, assessments: { docs: {} }, scheduledAssessments: { docs: {} } },
});

const isNonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** A local database is "pristine" when only the empty-install placeholder exists: safe to restore. */
export function isPristineLocal(snapshot: SyncableSnapshot): boolean {
  return (
    snapshot.events.length === 0 &&
    snapshot.circulars.length === 0 &&
    (snapshot.assessments ?? []).length === 0 &&
    (snapshot.scheduledAssessments ?? []).length === 0 &&
    snapshot.students.length === 0 &&
    snapshot.definitiveTimetable.length === 0 &&
    snapshot.provisionalTimetable.length === 0 &&
    (isPlaceholderFullName(snapshot.profile.fullName) || !snapshot.profile.schoolName.trim())
  );
}

const remoteHasData = (remote: RemoteSnapshot): boolean =>
  STATE_DOC_NAMES.some(n => remote.state[n]) || ITEMS_COLLECTIONS.some(c => (remote.items[c] || []).length > 0);

/** Re-derive a full local snapshot from remote copies, tolerating partial remote trees. */
export function snapshotFromRemote(remote: RemoteSnapshot): Partial<Record<StateDocName, unknown>> & {
  events?: CalendarEvent[];
  circulars?: CircularDocument[];
  timetableMode?: "auto" | "provvisorio" | "definitivo";
  onboardingCompleted?: boolean;
  timeSlotConfig?: TimeSlotConfig;
} {
  const out: any = {};
  for (const name of STATE_DOC_NAMES) {
    const doc = remote.state[name];
    if (!doc) continue;
    if (name === "settings") {
      if (doc.payload && typeof doc.payload === "object") Object.assign(out, doc.payload);
    } else out[name] = doc.payload;
  }
  if (remote.items.events.length) out.events = remote.items.events.map(i => sanitizeRemoteCalendarEvent(i.payload));
  if (remote.items.circulars.length) out.circulars = remote.items.circulars.map(i => i.payload);
  if (remote.items.assessments?.length) out.assessments = remote.items.assessments.map(i => i.payload);
  if (remote.items.scheduledAssessments?.length) out.scheduledAssessments = remote.items.scheduledAssessments.map(i => i.payload);
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
    remoteWrites: { events: {}, circulars: {}, assessments: {}, scheduledAssessments: {} },
    remoteDeletes: { events: [], circulars: [], assessments: [], scheduledAssessments: [] },
    stateWrites: {},
    needsResolution: [],
    archivedOnOverwrite: [],
    sensitiveCleanupWritten: [],
    unrecoverableRemote: [],
    nextState,
    changedSomething: false,
  };

  // Item-level assessment payloads are untrusted input. Invalid remote rows are never
  // included in a full restore; they are archived and deleted by the normal cloud side.
  const validAssessments: RemoteItem[] = [];
  for (const item of remote.items.assessments ?? []) {
    if (isValidStudentAssessment(item.payload)) validAssessments.push(item);
    else {
      plan.archivedOnOverwrite.push({ kind: `invalid-item:assessments:${item.id}`, loser: item.payload });
      plan.remoteDeletes.assessments.push(item.id);
      plan.changedSomething = true;
    }
  }
  remote.items.assessments = validAssessments;
  const validScheduledAssessments: RemoteItem[] = [];
  for (const item of remote.items.scheduledAssessments ?? []) {
    if (isValidStudentScheduledAssessment(item.payload)) validScheduledAssessments.push(item);
    else {
      plan.archivedOnOverwrite.push({ kind: `invalid-item:scheduledAssessments:${item.id}`, loser: item.payload });
      plan.remoteDeletes.scheduledAssessments.push(item.id);
      plan.changedSomething = true;
    }
  }
  remote.items.scheduledAssessments = validScheduledAssessments;

  // Eventi: mai rifiutati (sarebbe perdita di dati), solo ripuliti. Un meetingUrl non
  // https committato in IndexedDB farebbe fallire la validazione di `validateBackup`
  // sull'intera scrittura atomica, congelando la sync di questo dispositivo.
  remote.items.events = (remote.items.events ?? []).map(item => ({ ...item, payload: sanitizeRemoteCalendarEvent(item.payload) }));

  const sensitiveActive = Boolean(ctx.sensitiveActive);
  const sensitiveDecrypted = ctx.sensitiveDecrypted;
  /** Hash di rilevazione del contenuto locale (con impronta dei dati riservati se la cifratura è attiva). */
  const hashOf = (name: StateDocName, base: unknown, source: unknown): string =>
    localStateHash(name, base, sensitiveActive, sensitiveStateFingerprint(name, source));

  const remoteKnown = remoteHasData(remote);
  if (!syncState && !resolution && isPristineLocal(snapshot) && remoteKnown) {
    // New device (or cleared local data): adopt the cloud snapshot wholesale.
    plan.fullRestore = buildFullRestore(snapshot, remote, sensitiveDecrypted);
    syncAllTracks(nextState, snapshot, remote, nowIso, plan.fullRestore, sensitiveActive);
    repairLegacyStateDocs(plan, ctx, nextState, snapshot);
    planSensitiveCleanup(plan, ctx, nextState, snapshot, remote, true);
    plan.changedSomething = true;
    return plan;
  }
  if (!syncState && resolution === "remote" && remoteKnown) {
    plan.fullRestore = buildFullRestore(snapshot, remote, sensitiveDecrypted);
    syncAllTracks(nextState, snapshot, remote, nowIso, plan.fullRestore, sensitiveActive);
    repairLegacyStateDocs(plan, ctx, nextState, snapshot);
    planSensitiveCleanup(plan, ctx, nextState, snapshot, remote, true);
    plan.changedSomething = true;
    return plan;
  }

  const forcePush = resolution === "local";

  /**
   * INGRESSO di un documento di stato: il payload remoto viene applicato in
   * locale. Senza chiave: i dati sensibili locali si conservano e il blob
   * cifrato non viene scartato. Con la chiave: si applicano i valori decifrati
   * dal cloud con la stessa precedenza del resto della scheda.
   */
  const pullState = (name: StateDocName, doc: RemoteStateDoc) => {
    const merged = incomingStatePayload(name, doc.payload, snapshot, sensitiveDecrypted);
    plan.localApplyState[name] = merged;
    // Il track segue il contenuto che finirà in locale (base senza trasporto +
    // impronta di ciò che ora è salvato qui).
    nextState.state[name] = {
      lastSyncedLocalHash: hashOf(name, stripSensitiveTransportPayload(name, doc.payload), merged),
      remoteUpdatedAt: doc.updatedAt,
    };
    plan.changedSomething = true;
  };

  // --- state documents ---
  for (const name of STATE_DOC_NAMES) {
    const localPayload = statePayload(snapshot, name);
    const hL = hashOf(name, localPayload, fingerprintSource(name, snapshot));
    const remoteDoc = remote.state[name] ?? null;
    const track: StateTrack | undefined = nextState.state[name];
    const localChanged = !track || track.lastSyncedLocalHash !== hL;
    const remoteChanged = remoteDoc ? !track || remoteDoc.updatedAt !== track.remoteUpdatedAt : Boolean(track?.remoteUpdatedAt);

    if (forcePush) {
      if (remoteDoc) plan.archivedOnOverwrite.push({ kind: `state:${name}`, loser: stripSensitiveStatePayload(name, remoteDoc.payload) });
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
        pullState(name, remoteDoc);
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
      pullState(name, remoteDoc);
      continue;
    }
    // Both changed -> explicit comparison; unknown local time asks the user instead of guessing.
    const localAt = track.localChangedAt;
    if (!localAt) { plan.needsResolution.push(name); continue; }
    if (localAt > remoteDoc.updatedAt) {
      plan.archivedOnOverwrite.push({ kind: `state:${name}`, loser: stripSensitiveStatePayload(name, remoteDoc.payload) });
      plan.stateWrites[name] = localPayload;
      nextState.state[name] = { ...track, lastSyncedLocalHash: hL, remoteUpdatedAt: nowIso };
      delete nextState.state[name]!.localChangedAt;
    } else {
      pullState(name, remoteDoc);
    }
    plan.changedSomething = true;
  }

  // --- legacy / malformed remote state documents (classified by remoteSchema.ts) ---
  repairLegacyStateDocs(plan, ctx, nextState, snapshot);

  // --- pulizia una volta per account dei dati sensibili già finiti nel cloud ---
  planSensitiveCleanup(plan, ctx, nextState, snapshot, remote);

  // --- item collections: id-level three-way merge (union + conflict archive + assessment tombstones) ---
  for (const coll of ITEMS_COLLECTIONS) {
    const track = (nextState.items[coll] ??= { docs: {} });
    const rows = coll === "events" ? snapshot.events : coll === "circulars" ? snapshot.circulars : coll === "assessments" ? snapshot.assessments ?? [] : snapshot.scheduledAssessments ?? [];
    const localRows = new Map<string, { row: CalendarEvent | CircularDocument | StudentAssessment | StudentScheduledAssessment; hash: string }>(
      rows.map(row => [row.id, { row, hash: contentHash(row) }] as [string, { row: CalendarEvent | CircularDocument | StudentAssessment | StudentScheduledAssessment; hash: string }])
    );
    const rawRemoteRows = remote.items[coll] ?? [];
    const remoteRows = new Map<string, RemoteItem>();
    for (const item of rawRemoteRows) {
      if ((coll === "assessments" && !isValidStudentAssessment(item.payload))
        || (coll === "scheduledAssessments" && !isValidStudentScheduledAssessment(item.payload))) {
        plan.archivedOnOverwrite.push({ kind: `invalid-item:${coll}:${item.id}`, loser: item.payload });
        plan.remoteDeletes[coll].push(item.id);
        plan.changedSomething = true;
        continue;
      }
      remoteRows.set(item.id, item);
    }

    const ensureLocalList = () => {
      if (coll === "events") plan.localEvents ??= [...snapshot.events];
      else if (coll === "circulars") plan.localCirculars ??= [...snapshot.circulars];
      else if (coll === "assessments") plan.localAssessments ??= [...(snapshot.assessments ?? [])];
      else plan.localScheduledAssessments ??= [...(snapshot.scheduledAssessments ?? [])];
    };
    const localList = () => coll === "events" ? plan.localEvents ?? snapshot.events : coll === "circulars" ? plan.localCirculars ?? snapshot.circulars : coll === "assessments" ? plan.localAssessments ?? (snapshot.assessments ?? []) : plan.localScheduledAssessments ?? (snapshot.scheduledAssessments ?? []);
    const recordSync = (id: string, hash: string, updatedAt: string) => {
      track.docs[id] = { hash, updatedAt };
      if (track.deleted) delete track.deleted[id];
    };
    const remove = (id: string) => {
      ensureLocalList();
      if (coll === "events") plan.localEvents = plan.localEvents!.filter(row => row.id !== id);
      else if (coll === "circulars") plan.localCirculars = plan.localCirculars!.filter(row => row.id !== id);
      else if (coll === "assessments") plan.localAssessments = plan.localAssessments!.filter(row => row.id !== id);
      else plan.localScheduledAssessments = plan.localScheduledAssessments!.filter(row => row.id !== id);
    };
    const apply = (payload: unknown) => {
      ensureLocalList();
      const incoming = payload as CalendarEvent | CircularDocument | StudentAssessment | StudentScheduledAssessment;
      const list = localList() as Array<CalendarEvent | CircularDocument | StudentAssessment | StudentScheduledAssessment>;
      const index = list.findIndex(row => row.id === incoming.id);
      if (index >= 0) list[index] = incoming;
      else list.push(incoming);
    };

    for (const [id, local] of localRows) {
      if (track.deleted?.[id]) delete track.deleted[id]; // the user recreated the same id
      const remoteItem = remoteRows.get(id);
      const synced = track.docs[id];
      const localChanged = !synced || synced.hash !== local.hash;
      if (!remoteItem) {
        if (synced && !localChanged) {
          remove(id);
          delete track.docs[id];
          plan.changedSomething = true;
          continue;
        }
        plan.remoteWrites[coll][id] = local.row;
        recordSync(id, local.hash, nowIso);
        plan.changedSomething = true;
        continue;
      }
      const remoteChanged = !synced || remoteItem.updatedAt !== synced.updatedAt;
      if (!localChanged && !remoteChanged) continue;
      if (forcePush) {
        if (synced && remoteChanged) plan.archivedOnOverwrite.push({ kind: `item:${coll}:${id}`, loser: remoteItem.payload });
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
        apply(remoteItem.payload);
        recordSync(id, contentHash(remoteItem.payload), remoteItem.updatedAt);
        plan.changedSomething = true;
        continue;
      }
      const remoteIsNewer = Boolean(synced) && Boolean(track.changedAt) && remoteItem.updatedAt > (track.changedAt as string);
      if (remoteIsNewer) {
        apply(remoteItem.payload);
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
      const tombstone = (coll === "assessments" || coll === "scheduledAssessments") ? track.deleted?.[id] : undefined;
      if (tombstone) {
        // A local assessment deletion wins over a stale or concurrently surviving remote copy.
        if (remoteItem.updatedAt !== tombstone.updatedAt) plan.archivedOnOverwrite.push({ kind: `item:${coll}:${id}`, loser: remoteItem.payload });
        plan.remoteDeletes[coll].push(id);
        delete track.docs[id];
        plan.changedSomething = true;
        continue;
      }
      if (!synced) {
        ensureLocalList();
        apply(remoteItem.payload);
        recordSync(id, contentHash(remoteItem.payload), remoteItem.updatedAt);
        plan.changedSomething = true;
        continue;
      }
      // A missing local item is a deletion. Assessments retain a tombstone so they cannot resurrect.
      if (coll === "assessments" || coll === "scheduledAssessments") {
        (track.deleted ??= {})[id] = { deletedAt: nowIso, updatedAt: synced.updatedAt };
        if (remoteItem.updatedAt !== synced.updatedAt) plan.archivedOnOverwrite.push({ kind: `item:${coll}:${id}`, loser: remoteItem.payload });
        plan.remoteDeletes[coll].push(id);
        delete track.docs[id];
        plan.changedSomething = true;
        continue;
      }
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
      apply(remoteItem.payload);
      recordSync(id, contentHash(remoteItem.payload), remoteItem.updatedAt);
      plan.changedSomething = true;
    }

    track.lastSyncedHash = itemsDigest(localList());
    track.lastDetectedHash = undefined;
    if (Object.keys(plan.remoteWrites[coll]).length === 0) delete track.changedAt;
  }

  return plan;
}

/**
 * C. PULIZIA DEI DATI GIÀ CARICATI NEL CLOUD.
 *
 * Il documento `state/students` e il profilo possono contenere dati sensibili
 * scritti da una versione precedente dell'app. Al primo ciclo utile dopo
 * l'aggiornamento vengono riscritti puliti ANCHE SE null'altro è cambiato: una
 * sola volta per account (indicatore locale `sync:sensitive-cleanup`, gestito
 * dall'engine). La scrittura sostituisce l'intero documento — `setDoc` senza
 * merge, vedi `firestoreGateway.writeState` — quindi nel cloud resta solo la
 * copia ripulita e completa, non un merge parziale.
 *
 * Gli archivi `users/{uid}/conflicts` NON si toccano: le regole Firestore li
 * rendono immutabili. Di quelli l'engine conta, senza contenuti, quanti
 * custodiscono ancora dati riservati.
 */
function planSensitiveCleanup(
  plan: SyncPlan,
  ctx: PlanContext,
  nextState: SyncStateV1,
  snapshot: SyncableSnapshot,
  remote: RemoteSnapshot,
  localAdoptsRemote = false,
): void {
  const sensitiveActive = Boolean(ctx.sensitiveActive);
  for (const name of ctx.sensitiveCleanup ?? []) {
    if (name !== "students" && name !== "profile") continue;
    // Questo ciclo riscrive già il documento (push, riparazione, forzatura):
    // ciò che arriva nel cloud è comunque già privo di dati sensibili.
    if (plan.stateWrites[name] !== undefined) continue;
    // Una divergenza non si decide qui: la scelta resta all'utente.
    if (plan.needsResolution.includes(name)) continue;
    const remoteDoc = remote.state[name] ?? null;
    // Nulla da pulire: il documento nel cloud non custodisce dati riservati
    // (già pulito, assente o irrecuperabile). Nessuna scrittura inutile.
    if (!remoteDoc || !hasSensitiveStatePayload(name, remoteDoc.payload)) continue;
    const localPayload = statePayload(snapshot, name);
    const localHasContent = name === "students"
      ? snapshot.students.length > 0
      : Boolean(snapshot.profile?.fullName?.trim());
    const cleaned = stripSensitiveStatePayload(name, localHasContent ? localPayload : remoteDoc.payload);
    plan.stateWrites[name] = cleaned;
    if (!plan.sensitiveCleanupWritten.includes(name)) plan.sensitiveCleanupWritten.push(name);
    // Con dati locali (o con un ripristino in corso) il contenuto scritto è
    // quello che il dispositivo considera sincronizzato; senza dati locali il
    // cloud resta il solo contenuto valido e NON deve essere scambiato per una
    // cancellazione locale. L'hash segue lo stesso contenuto, con l'impronta
    // dei dati riservati quando la cifratura è attiva.
    const hashBase = localHasContent || localAdoptsRemote ? cleaned : localPayload;
    const fingerprintSourceValue = localAdoptsRemote ? hashBase : fingerprintSource(name, snapshot);
    nextState.state[name] = {
      lastSyncedLocalHash: localStateHash(name, stripSensitiveTransportPayload(name, hashBase), sensitiveActive, sensitiveStateFingerprint(name, fingerprintSourceValue)),
      remoteUpdatedAt: remoteDoc?.updatedAt ?? nextState.state[name]?.remoteUpdatedAt ?? null,
    };
    delete nextState.state[name]!.localChangedAt;
    delete nextState.state[name]!.lastDetectedHash;
    plan.changedSomething = true;
  }
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

/**
 * Repairs legacy/malformed remote state documents (users/{uid}/state/*), never destructively:
 *  - the original cloud copy is preserved under users/{uid}/conflicts (kind "legacy-state:<name>"),
 *    once per device (hash-guarded through StateTrack.archivedLegacyHash);
 *  - a malformed document is treated as absent by the merge (it can never win a conflict or be
 *    applied locally); if the local side holds valid data the remote document is rewritten in the
 *    current format; if the local side is empty too, nothing is fabricated — the section is
 *    reported through plan.unrecoverableRemote instead;
 *  - a legacy-but-recoverable document (payload extracted and validated) takes part in the merge
 *    normally, and the cloud copy is rewritten in the correct format even when the content is
 *    unchanged, so the malformed shape disappears from the account.
 */
function repairLegacyStateDocs(plan: SyncPlan, ctx: PlanContext, nextState: SyncStateV1, snapshot: SyncableSnapshot): void {
  const invalid = new Set(ctx.remoteInvalid ?? []);
  const legacy = new Set(ctx.remoteLegacy ?? []);
  if (invalid.size === 0 && legacy.size === 0) return;
  for (const name of STATE_DOC_NAMES) {
    const raw = ctx.remoteRaw?.[name];
    if (raw === undefined || raw === null) continue;
    const track = (nextState.state[name] ??= {
      lastSyncedLocalHash: localStateHash(name, statePayload(snapshot, name), Boolean(ctx.sensitiveActive), sensitiveStateFingerprint(name, fingerprintSource(name, snapshot))),
      remoteUpdatedAt: null,
    });
    const rawHash = contentHash(raw);
    if (track.archivedLegacyHash !== rawHash) {
      // Anche l'archivio viene ripulito: la copia originale nel cloud non deve
      // contenere dati sensibili (le regole lo rendono immutabile, quindi gli
      // archivi già scritti restano: per quelli si conta, non si riscrive).
      plan.archivedOnOverwrite.push({ kind: `legacy-state:${name}`, loser: stripSensitiveLegacyDoc(name, raw) });
      track.archivedLegacyHash = rawHash;
      plan.changedSomething = true;
    }
    if (invalid.has(name)) {
      if (localCollectionEmpty(snapshot, name)) {
        // No valid local replacement: do not invent data and do not touch the remote document.
        if (plan.stateWrites[name] !== undefined) delete plan.stateWrites[name];
        if (!plan.unrecoverableRemote.includes(name)) plan.unrecoverableRemote.push(name);
      } else if (plan.stateWrites[name] === undefined) {
        // Local data is valid: rewrite the malformed remote document in the current format.
        plan.stateWrites[name] = statePayload(snapshot, name);
        plan.changedSomething = true;
      }
    } else if (legacy.has(name) && plan.stateWrites[name] === undefined && !plan.needsResolution.includes(name)) {
      const recovered = ctx.remote.state[name]?.payload;
      if (recovered !== undefined) {
        // Il contenuto recuperato torna nel cloud: mai con i dati sensibili di
        // un documento scritto da una versione precedente dell'app.
        plan.stateWrites[name] = stripSensitiveStatePayload(name, recovered);
        plan.changedSomething = true;
      }
    }
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

function buildFullRestore(snapshot: SyncableSnapshot, remote: RemoteSnapshot, decrypted?: DecryptedSensitive): SyncableSnapshot {
  const fromRemote = snapshotFromRemote(remote);
  /**
   * L'elenco alunni e il profilo arrivano dal cloud come sempre: senza chiave,
   * con i dati sensibili LOCALI conservati per ogni alunno con lo stesso id e
   * con quelli (eventuali, vecchi) del cloud ignorati; con la chiave, con i
   * valori decifrati dai blob applicati al posto di quelli locali.
   */
  const students = Array.isArray(fromRemote.students)
    ? (mergeLocalSensitiveStudents(fromRemote.students, snapshot.students, decrypted?.students) as SyncableSnapshot["students"])
    : snapshot.students;
  const profile = fromRemote.profile
    ? (mergeLocalSensitiveProfile(fromRemote.profile, snapshot.profile, decrypted?.profile) as TeacherProfile)
    : snapshot.profile;
  const merged = {
    ...snapshot,
    ...fromRemote,
    definitiveTimetable: Array.isArray(fromRemote.definitiveTimetable) ? fromRemote.definitiveTimetable : snapshot.definitiveTimetable,
    provisionalTimetable: Array.isArray(fromRemote.provisionalTimetable) ? fromRemote.provisionalTimetable : snapshot.provisionalTimetable,
    students,
    profile,
    timetableMode: fromRemote.timetableMode ?? snapshot.timetableMode ?? "auto",
    onboardingCompleted: typeof fromRemote.onboardingCompleted === "boolean" ? fromRemote.onboardingCompleted : snapshot.onboardingCompleted,
    timeSlotConfig: fromRemote.timeSlotConfig ?? snapshot.timeSlotConfig,
  } as SyncableSnapshot;
  // Missing remote collections on a partial cloud snapshot stay as the (empty) local values.
  return merged;
}

function syncAllTracks(
  nextState: SyncStateV1,
  snapshot: SyncableSnapshot,
  remote: RemoteSnapshot,
  nowIso: string,
  restored?: SyncableSnapshot | null,
  sensitiveActive = false,
) {
  for (const name of STATE_DOC_NAMES) {
    const remoteDoc = remote.state[name];
    if (remoteDoc) {
      // Il contenuto locale dopo il ripristino è quello restaurato (se avvenuto).
      const source = restored ? fingerprintSource(name, restored) : fingerprintSource(name, snapshot);
      nextState.state[name] = {
        lastSyncedLocalHash: localStateHash(name, stripSensitiveTransportPayload(name, remoteDoc.payload), sensitiveActive, sensitiveStateFingerprint(name, source)),
        remoteUpdatedAt: remoteDoc.updatedAt,
      };
    } else {
      nextState.state[name] = {
        lastSyncedLocalHash: localStateHash(name, statePayload(snapshot, name), sensitiveActive, sensitiveStateFingerprint(name, fingerprintSource(name, snapshot))),
        remoteUpdatedAt: null,
      };
    }
  }
  for (const coll of ITEMS_COLLECTIONS) {
    const docs: Record<string, { hash: string; updatedAt: string }> = {};
    for (const item of (remote.items[coll] ?? [])) docs[item.id] = { hash: contentHash(item.payload), updatedAt: item.updatedAt };
    nextState.items[coll] = { docs };
  }
  nextState.lastCompletedAt = nowIso;
}
