import type {
  CalendarEvent,
  CircularDocument,
} from "../../types";
import type {
  RemoteItem,
  RemoteSnapshot,
  StateDocName,
  SyncGateway,
  SyncStateV1,
  SyncStatus,
  SyncableSnapshot,
} from "./types";
import { ITEMS_COLLECTIONS, STATE_DOC_NAMES } from "./types";
import { contentHash, isPristineLocal, itemsDigest, planSync } from "./merge";

const META_STATE_KEY = "sync:state";
const META_ENABLED_KEY = "sync:enabled";
const DEBOUNCE_MS = 1500;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;

/** Changes the engine asks the local store to commit (everything the UI reads stays IndexedDB-backed). */
export interface LocalApply {
  fullRestore?: SyncableSnapshot;
  localApplyState?: Partial<Record<StateDocName, unknown>>;
  localEvents?: CalendarEvent[];
  localCirculars?: CircularDocument[];
}

/** Storage adapter so the engine can be tested against a fake IndexedDB + fake cloud. */
export interface SyncStore {
  mode: () => string;
  readSnapshot(): Promise<SyncableSnapshot>;
  applyLocal(changes: LocalApply): Promise<void>;
  readMeta(key: string): Promise<unknown>;
  writeMeta(key: string, value: unknown): Promise<void>;
}

export interface SyncEngineDeps {
  gateway: () => SyncGateway | null;
  uid: () => string | null;
  store: SyncStore;
  /** Optional: fires after every committed local change (Dexie liveQuery in production). */
  observeLocalCommits?: (onCommit: () => void) => () => void;
  /** Scheduler override for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => string;
}

type Listener = (status: SyncStatus) => void;

/**
 * Local-first account sync. IndexedDB remains the only storage the app reads/writes;
 * this engine mirrors committed snapshots to/from Firestore, keyed by the Firebase uid.
 * It never blocks startup, retries with backoff when offline, keeps one active tab as
 * sync leader (Web Locks) and never overwrites newer data with older data (conflict
 * losers are archived under users/{uid}/conflicts before being replaced).
 */
export class SyncEngine {
  private status: SyncStatus = { phase: "disabled", enabled: true, activeUid: null };
  private listeners = new Set<Listener>();
  private stopDebounce: (() => void) | null = null;
  private stopRetry: (() => void) | null = null;
  private errors = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private resolution: "local" | "remote" | null = null;
  private session: string | null = null;
  private detachers: (() => void)[] = [];
  private readonly now: () => string;

  constructor(private deps: SyncEngineDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  getStatus(): SyncStatus { return this.status; }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }
  private publish(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }

  /** Starts mirroring for an authenticated Google user. No-op without a configured Firebase app. */
  startSession(uid: string): void {
    if (!this.deps.gateway()) { this.publish({ phase: "disabled", activeUid: null }); return; }
    if (this.session === uid) { this.scheduleSync(0); return; }
    this.stopSession();
    this.session = uid;
    void this.attach().then(async () => {
      const enabled = await this.isEnabled();
      this.publish({ enabled, activeUid: uid, phase: enabled ? "idle" : "disabled" });
      if (enabled) this.scheduleSync(0);
    });
  }

  stopSession(): void {
    this.session = null;
    this.resolution = null;
    for (const detach of this.detachers) detach();
    this.detachers = [];
    if (this.stopDebounce) { this.stopDebounce(); this.stopDebounce = null; }
    if (this.stopRetry) { this.stopRetry(); this.stopRetry = null; }
    this.publish({ phase: this.deps.gateway() ? "idle" : "disabled", activeUid: null, conflicts: undefined, message: undefined });
  }

  private async attach() {
    if (this.deps.observeLocalCommits) {
      const detach = this.deps.observeLocalCommits(() => this.scheduleSync());
      this.detachers.push(detach);
    }
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const onVisibility = () => { if (document.visibilityState === "visible") this.scheduleSync(0); };
    const onOnline = () => { this.errors = 0; this.scheduleSync(1000); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    this.detachers.push(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    });
  }

  /** Debounced: bursts of local edits (imports, drag edits) converge into one cycle. */
  scheduleSync(delay = DEBOUNCE_MS): void {
    if (!this.session) return;
    if (this.stopDebounce) this.stopDebounce();
    const schedule = this.deps.schedule ?? ((fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });
    this.stopDebounce = schedule(() => { this.stopDebounce = null; void this.runCycle(); }, Math.max(0, delay));
  }

  async syncNow(): Promise<void> { await this.runCycle(); }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.deps.store.writeMeta(META_ENABLED_KEY, enabled);
    this.publish({ enabled });
    if (enabled && this.session) this.scheduleSync(0);
  }
  async isEnabled(): Promise<boolean> {
    return (await this.deps.store.readMeta(META_ENABLED_KEY)) !== false; // default ON once authenticated
  }

  /** Explicit answer to "both sides changed since install" — never resolved silently. */
  async resolveConflict(choice: "local" | "remote"): Promise<void> {
    this.resolution = choice;
    await this.runCycle();
  }

  private async runCycle(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        await this.withSingleRunnerLock(() => this.cycle());
        this.errors = 0;
        // A cycle that ended asking the user keeps its phase; otherwise a successful pass is idle.
        const keep = this.status.phase === "awaiting-resolution" ? "awaiting-resolution" : "idle";
        this.publish({ phase: keep, lastSyncedAt: this.now(), ...(keep === "idle" ? { message: undefined } : {}) });
        if (this.again) { this.again = false; this.scheduleSync(0); }
      } catch (error) {
        this.errors++;
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        this.publish({
          phase: offline ? "offline" : "error",
          message: error instanceof Error ? sanitizeError(error) : "Sincronizzazione non riuscita. Riprova più tardi.",
        });
        const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(this.errors, 9), RETRY_MAX_MS);
        const schedule = this.deps.schedule ?? ((fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });
        if (this.stopRetry) this.stopRetry();
        this.stopRetry = schedule(() => { this.stopRetry = null; void this.runCycle(); }, delay);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Web Locks keep at most one tab actively syncing; other browsers serialize per tab. */
  private async withSingleRunnerLock(fn: () => Promise<void>): Promise<void> {
    const locks = typeof navigator !== "undefined"
      ? (navigator as unknown as { locks?: { request: (name: string, opts: unknown, cb: (lock: unknown) => Promise<unknown>) => Promise<unknown> } }).locks
      : undefined;
    if (!locks) return fn();
    // "exclusive" is the only non-shared mode of the Web Locks API (there is no "exact");
    // ifAvailable keeps this tab from queueing behind another tab's cycle: the loser of the
    // race simply reschedules instead of blocking.
    const result = await locks.request("agenda-docente-cloud-sync", { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) return "busy";
      await fn();
      return "done";
    });
    if (result === "busy") this.scheduleSync(DEBOUNCE_MS);
  }

  private async cycle(): Promise<void> {
    const uid = this.deps.uid();
    if (!uid) return;
    // An explicit syncNow/resolve may run before startSession completes; scheduled cycles never do.
    if (this.session && this.session !== uid) return;
    if (this.deps.store.mode() !== "indexeddb") return;
    const gateway = this.deps.gateway();
    if (!gateway) return;
    if (!(await this.isEnabled())) return;

    const rawState = (await this.deps.store.readMeta(META_STATE_KEY)) as SyncStateV1 | null;
    const previous: SyncStateV1 | null = rawState && rawState.uid === uid ? rawState : null;
    const snapshot = await this.deps.store.readSnapshot();
    const nowIso = this.now();

    // 1. Detect *new* local edits (hash moved since the last detection) and stamp their time.
    const detection: SyncStateV1 = previous ? structuredClone(previous) : { uid, state: {}, items: { events: { docs: {} }, circulars: { docs: {} } } };
    detection.uid = uid;
    for (const name of STATE_DOC_NAMES) {
      const track = detection.state[name];
      const hash = contentHash(localPayload(snapshot, name));
      if (track) {
        if (track.lastSyncedLocalHash !== hash) {
          if (track.lastDetectedHash !== hash || !track.localChangedAt) {
            track.localChangedAt = nowIso;
            track.lastDetectedHash = hash;
          }
        } else {
          delete track.localChangedAt;
          delete track.lastDetectedHash;
        }
      }
    }
    for (const coll of ITEMS_COLLECTIONS) {
      const track = (detection.items[coll] ??= { docs: {} });
      const rows = coll === "events" ? snapshot.events : snapshot.circulars;
      const digest = itemsDigest(rows);
      if (track.lastSyncedHash !== digest && track.lastDetectedHash !== digest) {
        track.changedAt = nowIso;
        track.lastDetectedHash = digest;
      }
    }
    // Bookkeeping persists (only when it actually changed) even if the cloud phase later fails,
    // so "when did I edit" stays stable across retries and a failing device never permanently
    // looks "newest" in LWW comparisons. Skipping identical writes is also what keeps the
    // Dexie-commit observer from ping-ponging against this engine.
    const previousJson = previous ? JSON.stringify(previous) : null;
    const detectionJson = JSON.stringify(detection);
    if (detectionJson !== previousJson) await this.deps.store.writeMeta(META_STATE_KEY, detection);

    // 2. Fetch the remote tree. Any failure aborts the cycle before the first write.
    this.publish({ phase: "syncing" });
    const [stateResults, events, circulars] = await Promise.all([
      Promise.all(STATE_DOC_NAMES.map(name => gateway.readState(name))),
      gateway.listItems("events"),
      gateway.listItems("circulars"),
    ]);
    const remote: RemoteSnapshot = {
      state: Object.fromEntries(STATE_DOC_NAMES.map((name, i) => [name, stateResults[i] ?? null])),
      items: { events, circulars },
    };

    // 3. Plan locally (pure), then execute both sides.
    const plan = planSync({ uid, snapshot, remote, syncState: detection, nowIso, resolution: this.resolution });

    if (plan.fullRestore) {
      await this.deps.store.applyLocal({ fullRestore: plan.fullRestore });
      await this.persistState(detectionJson, plan.nextState);
      this.resolution = null;
      this.publish({ phase: "idle", conflicts: undefined, message: undefined });
      return;
    }

    const localApplyState = { ...plan.localApplyState };
    for (const name of plan.needsResolution) delete localApplyState[name];
    const localApplied = Boolean(Object.keys(localApplyState).length || plan.localEvents || plan.localCirculars);
    if (localApplied) {
      await this.deps.store.applyLocal({ localApplyState, localEvents: plan.localEvents, localCirculars: plan.localCirculars });
    }

    // Archive losing copies first: a conflict never destroys data silently.
    for (const item of plan.archivedOnOverwrite) await gateway.archiveConflict(item.kind, item.loser);

    for (const coll of ITEMS_COLLECTIONS) {
      const entries = Object.entries(plan.remoteWrites[coll]);
      if (entries.length) await gateway.writeItems(coll, entries.map(([id, payload]) => ({ id, payload })));
      if (plan.remoteDeletes[coll].length) await gateway.deleteItems(coll, plan.remoteDeletes[coll]);
    }
    const stateWrites = Object.entries(plan.stateWrites).filter(([name]) => !plan.needsResolution.includes(name as StateDocName))
      .filter((([name, payload]) => !(name === "profile" && !String((payload as { fullName?: string })?.fullName ?? "").trim() && !remote.state.profile)));
    for (const [name, payload] of stateWrites) {
      const res = await gateway.writeState(name as StateDocName, payload);
      const track = plan.nextState.state[name as StateDocName];
      if (track) track.remoteUpdatedAt = res?.updatedAt || nowIso;
    }

    await this.persistState(detectionJson, plan.nextState);
    const hadResolution = this.resolution;
    this.resolution = null;
    if (plan.needsResolution.length && !hadResolution) {
      this.publish({ phase: "awaiting-resolution", conflicts: plan.needsResolution, message: "Questo dispositivo e il cloud contengono modifiche indipendenti. Scegli quali dati conservare." });
    } else {
      this.publish({ phase: "idle", conflicts: undefined, message: undefined });
    }
  }

  /** Persist the post-cycle state, but only if it differs from what was just written mid-cycle. */
  private async persistState(detectionJson: string, next: SyncStateV1): Promise<void> {
    const nextJson = JSON.stringify(next);
    if (nextJson !== detectionJson) await this.deps.store.writeMeta(META_STATE_KEY, next);
  }
}

function localPayload(snapshot: SyncableSnapshot, name: StateDocName): unknown {
  if (name === "settings") {
    return {
      timetableMode: snapshot.timetableMode,
      onboardingCompleted: snapshot.onboardingCompleted,
      ...(snapshot.timeSlotConfig ? { timeSlotConfig: snapshot.timeSlotConfig } : {}),
    };
  }
  return (snapshot as unknown as Record<string, unknown>)[name];
}

/** Never leak document contents, tokens or raw SDK errors into user-visible messages. */
export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/network|offline|Failed to fetch|unavailable|UNAVAILABLE/i.test(message)) return "Connessione non disponibile: la sincronizzazione riproverà automaticamente.";
  if (/permission|unauthenticated|unauthorized|denied|PERMISSION_DENIED/i.test(message)) return "Il cloud ha rifiutato la sincronizzazione. Verifica l'accesso Google.";
  if (/too grande|byte limit|SIZE/i.test(message)) return "Dati troppo grandi per il cloud: restano salvati in locale ed esportabili come backup.";
  return "Sincronizzazione non riuscita: i dati locali restano salvi. Nuovo tentativo pianificato.";
}

export type { RemoteItem };
