import { database, type LocalData } from "../db";
import type { SyncableSnapshot } from "./types";
import type { LocalApply, SyncStore } from "./engine";
import { liveQuery } from "dexie";

/**
 * Bridges the sync engine to the local-first store. IndexedDB (Dexie) stays the single
 * source of truth for the app; this adapter only commits whole collections atomically.
 */
export function createStoreAdapter(): SyncStore {
  return {
    mode: () => database.mode,
    readSnapshot: () => database.readSnapshot(),
    async readMeta(key: string) {
      const row = await database.table("metadata").get(key);
      return row?.value;
    },
    async writeMeta(key: string, value: unknown) {
      await database.table("metadata").put({ key, value });
    },
    async applyLocal(changes: LocalApply) {
      const full = changes.fullRestore;
      const state = changes.localApplyState ?? {};
      await database.atomic(async () => {
        const write = async <K extends keyof LocalData>(name: K, value: LocalData[K]) => database.write(name, value);
        if (full) {
          await applySnapshot(full);
          return;
        }
        if ("profile" in state) await write("profile", state.profile as LocalData["profile"]);
        if ("students" in state) await write("students", state.students as LocalData["students"]);
        if ("definitiveTimetable" in state) await write("definitiveTimetable", state.definitiveTimetable as LocalData["definitiveTimetable"]);
        if ("provisionalTimetable" in state) await write("provisionalTimetable", state.provisionalTimetable as LocalData["provisionalTimetable"]);
        if ("settings" in state) {
          const settings = state.settings as {
            timetableMode?: LocalData["timetableMode"];
            onboardingCompleted?: boolean;
            timeSlotConfig?: LocalData["timeSlotConfig"];
          };
          if (settings?.timetableMode) await write("timetableMode", settings.timetableMode);
          if (typeof settings?.onboardingCompleted === "boolean") await write("onboardingCompleted", settings.onboardingCompleted);
          if (settings?.timeSlotConfig) await write("timeSlotConfig", settings.timeSlotConfig);
        }
        if (changes.localEvents) await write("events", changes.localEvents);
        if (changes.localCirculars) await write("circulars", changes.localCirculars);
      });
    },
  };
}

async function applySnapshot(snapshot: SyncableSnapshot): Promise<void> {
  await database.restore(snapshot);
}

/**
 * Emits on every committed local change so the engine can schedule a sync cycle.
 *
 * Two independent signals, deliberately redundant:
 *  1. database.onCommit — explicit, deterministic, fired by AgendaDatabase after every
 *     successfully committed outermost write transaction (storage.saveTimetableSlot & co.).
 *     This is the reliable same-tab trigger: liveQuery alone may miss commits depending on
 *     browser/timing.
 *  2. Dexie liveQuery — cross-tab: edits committed by another tab of the same browser fire
 *     here (including the engine's own bookkeeping rows).
 *
 * The engine debounces and its plans are hash-guarded, so its own writes cannot loop:
 * a no-op plan never rewrites anything, and metadata rows that do not change content are
 * not persisted at all.
 */
export function observeLocalCommits(onCommit: () => void): () => void {
  let initial = true;
  const subscription = liveQuery(() => database.readSnapshot()).subscribe({
    next: () => {
      if (initial) { initial = false; return; }
      onCommit();
    },
    error: () => { /* a broken observer must never surface as a data error */ },
  });
  const detachExplicit = database.onCommit(onCommit);
  return () => {
    detachExplicit();
    subscription.unsubscribe();
  };
}
