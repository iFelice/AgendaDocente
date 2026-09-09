import { linkLegacyCircularEvents } from '../utils/circularLinks';
import Dexie, { type Table } from 'dexie';
import type { CalendarEvent, CircularDocument, Student, TeacherProfile, TimetableSlot, TimetableMode, TimeSlotConfig } from '../types';
import { validateBackup, recoverBackupRestore } from './backup';

export const LEGACY_KEYS = {
  profile: 'agedoc_teacher_profile_v2', events: 'agedoc_events_v2', circulars: 'agedoc_circulars_v2',
  students: 'agedoc_students_v2', definitiveTimetable: 'agedoc_timetable_v2',
  provisionalTimetable: 'agedoc_timetable_provvisorio_v2', timetableMode: 'agedoc_timetable_mode_v2',
  onboardingCompleted: 'agedoc_onboarding_completed_v2',
  timeSlotConfig: 'agedoc_time_slot_config_v2',
} as const;
export interface LocalData {
  profile: TeacherProfile; events: CalendarEvent[]; circulars: CircularDocument[]; students: Student[];
  definitiveTimetable: TimetableSlot[]; provisionalTimetable: TimetableSlot[];
  timetableMode: TimetableMode; onboardingCompleted: boolean;
  timeSlotConfig?: TimeSlotConfig;
}
const collections = ['events','circulars','students','definitiveTimetable','provisionalTimetable'] as const;
const stores = ['profile', ...collections, 'metadata'];
interface Row { id: string; position: number; value: any }
interface Meta { key: string; value: any }
export type LegacyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** Raw recovery copy, including unrecognised agedoc keys. Never log its contents. */
export function exportLegacyData(legacy: LegacyStorage = localStorage): string {
  const values: Record<string, string | null> = {};
  for (let i = 0; i < legacy.length; i++) {
    const key = legacy.key(i);
    if (key?.startsWith('agedoc_')) values[key] = legacy.getItem(key);
  }
  return JSON.stringify({ format: 'agenda-legacy-recovery', values }, null, 2);
}

export function readLegacyData(legacy: LegacyStorage): LocalData | null {
  const raw = Object.fromEntries(Object.entries(LEGACY_KEYS).map(([name,key]) => [name,legacy.getItem(key)]));
  const known = Object.values(raw).some(v => v !== null);
  if (!known) {
    // Unknown legacy data is not a new installation: do not seed over it.
    if (Object.keys(JSON.parse(exportLegacyData(legacy)).values).length) throw new Error('Dati legacy non riconosciuti: conserva una copia di recupero.');
    return null;
  }
  if (raw.profile === null) throw new Error('Profilo legacy mancante: dati conservati, migrazione sospesa.');
  if (raw.onboardingCompleted !== null && !['true','false'].includes(raw.onboardingCompleted)) throw new Error('Stato configurazione legacy non valido.');
  const data = {
    profile: JSON.parse(raw.profile!),
    ...Object.fromEntries(collections.map(k => [k, raw[k] === null ? [] : JSON.parse(raw[k]!)])),
    timetableMode: raw.timetableMode ?? 'auto', onboardingCompleted: raw.onboardingCompleted === 'true',
    timeSlotConfig: raw.timeSlotConfig ? JSON.parse(raw.timeSlotConfig) : undefined,
  } as LocalData;
  validateBackup({version:3,...data});
  data.events = linkLegacyCircularEvents(data.events, data.circulars);
  return data;
}

export class AgendaDatabase extends Dexie {
  mode: 'indexeddb' | 'legacy-readonly' | 'uninitialized' = 'uninitialized';
  private fallback?: LocalData;
  private initialization?: Promise<void>;
  private commitListeners = new Set<() => void>();
  constructor(name = 'agenda-docente') {
    super(name);
    this.version(1).stores(Object.fromEntries(stores.map(name => [name, name === 'metadata' ? '&key' : '&id,position'])));
  }
  override close(options?: { disableAutoOpen: boolean }): void {
    super.close(options);
    // Dexie temporarily closes connections for the browser back/forward cache.
    if (options?.disableAutoOpen === false) return;
    this.initialization = undefined; this.fallback = undefined; this.mode = 'uninitialized';
  }
  private rows(name: string): Table<Row, string> { return this.table(name); }
  private meta(): Table<Meta, string> { return this.table('metadata'); }

  /**
   * Explicit, same-tab notification fired once after every successfully committed outermost
   * write transaction. It complements Dexie liveQuery (which is cross-tab but commit-timing
   * dependent) so application commits — storage.saveTimetableSlot & co. — reliably reach the
   * account-sync scheduler. Listeners must never throw into the commit path.
   */
  onCommit(listener: () => void): () => void {
    this.commitListeners.add(listener);
    return () => { this.commitListeners.delete(listener); };
  }
  private notifyCommit(): void {
    for (const listener of [...this.commitListeners]) {
      try { listener(); } catch { /* a listener must never break a committed transaction */ }
    }
  }

  async initialize(seed: LocalData, legacy?: LegacyStorage): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeOnce(seed, legacy).catch(error => { this.initialization = undefined; throw error; });
    return this.initialization;
  }
  private async initializeOnce(seed: LocalData, legacy?: LegacyStorage): Promise<void> {
    try {
      await this.open();
      await this.transaction('rw', stores, async () => {
        const marker = await this.meta().get('migration');
        if (marker) {
          if (marker.value !== 1) throw new Error('Versione della persistenza non supportata.');
          // Never read old localStorage once the atomic migration has committed.
          validateBackup({version:3,...await this.readSnapshot()});
          return;
        }
        const occupied = (await Promise.all(stores.map(name => this.table(name).count()))).some(n => n > 0);
        if (occupied) {
          // A valid populated database wins even without a migration marker.
          validateBackup({version:3,...await this.readSnapshot()});
          await this.meta().put({key:'migration',value:1});
          return;
        }
        const source = legacy ?? localStorage;
        recoverBackupRestore(source);
        const previous = readLegacyData(source);
        const data = previous ?? seed;
        validateBackup({version:3,...data});
        await this.writeSnapshot(data);
        const copied = await this.readSnapshot();
        if (JSON.stringify(copied) !== JSON.stringify(this.ordered(data))) throw new Error('Verifica migrazione non riuscita.');
        await this.meta().put({key:'migration',value:1});
      });
      this.fallback = undefined;
      this.mode = 'indexeddb';
      this.notifyCommit();
    } catch (error) {
      // Explicit read-only recovery, never write an old snapshot back into IndexedDB.
      // It may be older than the last DB changes; the UI says so and offers export.
      try {
        const source = legacy ?? localStorage;
        recoverBackupRestore(source);
        const previous = readLegacyData(source);
        if (previous) { this.fallback = previous; this.mode = 'legacy-readonly'; return; }
      } catch { /* Corrupt originals are available through raw recovery export. */ }
      throw new Error('Archivio locale non disponibile o non valido. I dati originali non sono stati sostituiti.', { cause: error });
    }
  }
  private ordered(data: LocalData): LocalData {
    return {profile:data.profile,events:data.events,circulars:data.circulars,students:data.students,
      definitiveTimetable:data.definitiveTimetable,provisionalTimetable:data.provisionalTimetable,
      timetableMode:data.timetableMode,onboardingCompleted:data.onboardingCompleted,
      timeSlotConfig:data.timeSlotConfig};
  }
  async readSnapshot(): Promise<LocalData> {
    if (this.fallback) return structuredClone(this.fallback);
    return this.transaction('r', stores, async () => {
      const profile = (await this.rows('profile').toArray());
      if (profile.length !== 1) throw new Error('Profilo locale mancante o ambiguo.');
      return this.ordered({ profile: profile[0].value,
        ...Object.fromEntries(await Promise.all(collections.map(async name => [name, (await this.rows(name).orderBy('position').toArray()).map(row => row.value)]))),
        timetableMode: (await this.meta().get('timetableMode'))?.value,
        onboardingCompleted: (await this.meta().get('onboardingCompleted'))?.value,
        timeSlotConfig: (await this.meta().get('timeSlotConfig'))?.value,
      } as LocalData);
    });
  }
  async read<K extends keyof LocalData>(name: K): Promise<LocalData[K]> {
    this.requireReady();
    if (this.fallback) return structuredClone(this.fallback[name]);
    if (name === 'profile') {
      const rows = await this.rows(name).toArray();
      if (rows.length !== 1) throw new Error('Profilo locale mancante.');
      return rows[0].value;
    }
    if (name === 'timetableMode' || name === 'onboardingCompleted' || name === 'timeSlotConfig') {
      const row = await this.meta().get(name);
      if (name === 'timeSlotConfig') return row?.value as LocalData[K];
      if (!row) throw new Error('Impostazioni locali mancanti.');
      return row.value;
    }
    return (await this.rows(name).orderBy('position').toArray()).map(row => row.value) as LocalData[K];
  }
  private requireReady() { if (this.mode === 'uninitialized') throw new Error('Attendere il caricamento dell’archivio locale.'); }
  async write<K extends keyof LocalData>(name: K, value: LocalData[K]): Promise<void> {
    this.requireReady();
    await this.atomic(async () => { await this.writeValue(name, value); });
  }
  private async writeValue(name: keyof LocalData, value: any): Promise<void> {
    if (name === 'timetableMode' || name === 'onboardingCompleted' || name === 'timeSlotConfig') {
      await this.meta().put({key:name,value}); return;
    }
    const values = name === 'profile' ? [value] : value;
    if (new Set(values.map((v:any) => v.id)).size !== values.length) throw new Error('ID duplicati nell’archivio.');
    await this.rows(name).clear();
    await this.rows(name).bulkAdd(values.map((value:any,position:number) => ({id:value.id,position,value})));
  }
  private async writeSnapshot(data: LocalData): Promise<void> {
    for (const name of Object.keys(LEGACY_KEYS) as (keyof LocalData)[]) await this.writeValue(name,data[name]);
  }
  async atomic<T>(operation: () => Promise<T>): Promise<T> {
    this.requireReady();
    if (this.fallback) throw new Error('Copia legacy in sola lettura: ripristina l’accesso a IndexedDB prima di modificare i dati.');
    const nested = Dexie.currentTransaction?.db === this;
    const result = await this.transaction('rw', stores, async () => {
      const result = await operation();
      // Validate once at the outer commit boundary, so a bad edit cannot make the next startup unreadable.
      if (!nested) validateBackup({version:3,...await this.readSnapshot()});
      return result;
    });
    // Only the outermost, actually committed transaction notifies (never nested/aborted ones).
    if (!nested) this.notifyCommit();
    return result;
  }
  async restore(data: LocalData): Promise<void> {
    validateBackup({version:3,...data});
    await this.atomic(async () => { await this.writeSnapshot(data); });
  }
}
export const database = new AgendaDatabase();
