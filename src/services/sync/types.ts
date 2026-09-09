import type {
  CalendarEvent,
  CircularDocument,
  Student,
  TeacherProfile,
  TimeSlotConfig,
  TimetableMode,
  TimetableSlot,
} from "../../types";

/** Collections synced as one Firestore document each under users/{uid}/state/{name}. */
export type StateDocName = "profile" | "settings" | "definitiveTimetable" | "provisionalTimetable" | "students";
/** Collections synced as one Firestore document per entity under users/{uid}/{events|circulars}/{id}. */
export type ItemsCollection = "events" | "circulars";

export const STATE_DOC_NAMES: StateDocName[] = ["profile", "settings", "definitiveTimetable", "provisionalTimetable", "students"];
export const ITEMS_COLLECTIONS: ItemsCollection[] = ["events", "circulars"];

/** Snapshot of the IndexedDB local state (the app's source of truth). */
export interface SyncableSnapshot {
  profile: TeacherProfile;
  events: CalendarEvent[];
  circulars: CircularDocument[];
  students: Student[];
  definitiveTimetable: TimetableSlot[];
  provisionalTimetable: TimetableSlot[];
  timetableMode: TimetableMode;
  onboardingCompleted: boolean;
  timeSlotConfig?: TimeSlotConfig;
}

export interface RemoteStateDoc {
  payload: unknown;
  updatedAt: string;
  schemaVersion: 1;
}

export interface RemoteItem {
  id: string;
  payload: unknown;
  updatedAt: string;
}

export interface RemoteSnapshot {
  state: Partial<Record<StateDocName, RemoteStateDoc | null>>;
  items: Record<ItemsCollection, RemoteItem[]>;
}

/** Persisted under the IndexedDB metadata row "sync:state". Keys are content hashes. */
export interface StateTrack {
  /** Local content hash at the last fully completed sync of this collection. */
  lastSyncedLocalHash: string;
  /** Hash observed at the last cycle; a change since then marks a *new* local edit time. */
  lastDetectedHash?: string;
  /** Wall-clock time of the last detected local edit not yet confirmed by the cloud. */
  localChangedAt?: string;
  /** updatedAt of the last confirmed remote copy (null: remote document absent). */
  remoteUpdatedAt: string | null;
}
export interface ItemsTrack {
  changedAt?: string;
  lastDetectedHash?: string;
  lastSyncedHash?: string;
  docs: Record<string, { hash: string; updatedAt: string }>;
}
export interface SyncStateV1 {
  uid: string;
  lastCompletedAt?: string;
  state: Partial<Record<StateDocName, StateTrack>>;
  items: Record<ItemsCollection, ItemsTrack>;
}

export type SyncPhase = "disabled" | "idle" | "syncing" | "offline" | "error" | "awaiting-resolution";

export interface SyncStatus {
  phase: SyncPhase;
  enabled: boolean;
  activeUid: string | null;
  message?: string;
  lastSyncedAt?: string;
  /** Collections where this device and the cloud changed independently. */
  conflicts?: string[];
}

export interface SyncGateway {
  readState(name: StateDocName): Promise<RemoteStateDoc | null>;
  writeState(name: StateDocName, payload: unknown): Promise<{ updatedAt: string }>;
  listItems(collectionName: ItemsCollection): Promise<RemoteItem[]>;
  writeItems(collectionName: ItemsCollection, entries: { id: string; payload: unknown }[]): Promise<void>;
  deleteItems(collectionName: ItemsCollection, ids: string[]): Promise<void>;
  /** Preserves the losing copy of any conflict before it is replaced. Never silently destructive. */
  archiveConflict(kind: string, loser: unknown): Promise<void>;
}
