import { isValidTime } from "../../utils/dates";
import { isHttpsMeetingUrl } from "../../utils/meetingLinks";
import { TEACHER_ROLE_KINDS } from "../../types";
import { isValidStudentAssessment } from "../backup";
import type { RemoteStateDoc, StateDocName, SyncedStateDocName } from "./types";

/**
 * RUNTIME schema validation for remote state documents (users/{uid}/state/{name}).
 *
 * Firestore documents are untrusted input: a TypeScript cast like `snapshot.data()
 * as RemoteStateDoc` proves nothing at runtime. Older app versions wrote documents
 * with an incompatible shape — most notably the one observed in production:
 *
 *   users/{uid}/state/provisionalTimetable = {
 *     payload: { schemaVersion: 1, updatedAt: "2026-09-09T17:47:36.312Z" },  // NO timetable
 *     updatedAt: "...",
 *     schemaVersion: 1,
 *   }
 *
 * That payload carries metadata only and must NEVER be treated as a valid timetable.
 * Every state document is classified as one of:
 *  - "valid":  current format { payload: <semantically valid payload>, updatedAt, schemaVersion: 1 };
 *  - "legacy": wrapper/malformed but the real payload is recoverable and semantically valid
 *              (e.g. missing wrapper fields, double wrapping, or the document being the raw
 *              payload itself). The normalized document is returned so the merge can use it
 *              and the cloud copy can be rewritten in the correct format;
 *  - "invalid": unrecoverable (including the legacy metadata-only payload above). It must not
 *              be applied locally, must not win conflicts, and is preserved by the engine
 *              under users/{uid}/conflicts (kind "legacy-state:<name>") before any repair.
 *
 * Validation is semantic and per collection: wrapper shape alone is never enough.
 */

/** Unknown/missing remote timestamps normalize to the epoch so a legacy copy never wins LWW by accident. */
export const REMOTE_EPOCH = "1970-01-01T00:00:00.000Z";

export type RemoteStateVerdict =
  | { status: "absent"; name: SyncedStateDocName }
  | { status: "valid"; name: SyncedStateDocName; doc: RemoteStateDoc }
  | { status: "legacy"; name: SyncedStateDocName; doc: RemoteStateDoc; raw: unknown; reason: string }
  | { status: "invalid"; name: SyncedStateDocName; raw: unknown; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): boolean => typeof v === "string";
const requiredText = (v: unknown): boolean => text(v) && (v as string).trim().length > 0;
const bool = (v: unknown): boolean => typeof v === "boolean";
const intWithin = (v: unknown, min: number, max: number): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const strings = (v: unknown): boolean => Array.isArray(v) && v.every(x => typeof x === "string");
const optional = (v: unknown, fn: (v: unknown) => boolean): boolean => v === undefined || fn(v);
const isIsoTimestamp = (v: unknown): boolean =>
  typeof v === "string" && v.length >= 10 && !Number.isNaN(Date.parse(v));
const boundedText = (max: number) => (v: unknown): boolean => text(v) && (v as string).length <= max;

// ---------------------------------------------------------------------------
// Dati riservati cifrati (cifratura a busta): forme accettate nel cloud
// ---------------------------------------------------------------------------

/**
 * Blob cifrato di un alunno o del profilo: { v: 1, iv, ct } in base64.
 * Nel cloud NON esiste altra forma per i dati riservati: o questo testo
 * illeggibile, o niente.
 */
export function isValidSensitiveEncBlob(v: unknown): boolean {
  return (
    isRecord(v) &&
    v.v === 1 &&
    text(v.iv) && (v.iv as string).length > 0 && (v.iv as string).length <= 64 &&
    text(v.ct) && (v.ct as string).length > 0 && (v.ct as string).length <= 262_144
  );
}

/** Involucro AES-GCM della chiave dati dentro il documento `encryptionKeys`. */
function isValidWrappedKey(v: unknown): boolean {
  return (
    isRecord(v) &&
    text(v.iv) && (v.iv as string).length > 0 && (v.iv as string).length <= 64 &&
    text(v.ct) && (v.ct as string).length > 0 && (v.ct as string).length <= 512
  );
}

/**
 * Documento di stato `encryptionKeys` (stessa forma {payload, updatedAt,
 * schemaVersion} degli altri): sale dell'account, due involucri della chiave
 * dati (frase segreta e codice di recupero) e valore di verifica cifrato.
 * Nessuna informazione in chiaro: il sale non è un segreto.
 */
export function isValidEncryptionKeysPayload(v: unknown): boolean {
  return (
    isRecord(v) &&
    v.v === 1 &&
    text(v.salt) && (v.salt as string).length >= 16 && (v.salt as string).length <= 64 &&
    isValidWrappedKey(v.wrappedPhrase) &&
    isValidWrappedKey(v.wrappedRecovery) &&
    isValidSensitiveEncBlob(v.verify)
  );
}

/** Shared runtime validator for item-level assessment documents. */
export { isValidStudentAssessment };

// ---------------------------------------------------------------------------
// CalendarEvent link di videochiamata (collezione items `events`)
// ---------------------------------------------------------------------------

/**
 * `CalendarEvent.meetingUrl` deve essere un URL https o non esserci. Stesso contratto
 * del validatore di backup (`src/services/backup.ts`): le due porte di ingresso dei dati
 * — file di backup e righe del cloud — accettano e rifiutano le stesse cose, così un
 * evento scritto da questo dispositivo è sempre ri-sincronizzabile e ripristinabile.
 */
export function isValidCalendarEventMeetingUrl(value: unknown): boolean {
  return value === undefined || isHttpsMeetingUrl(value);
}

/**
 * Una riga evento remota è input non fidato, ma qui NON si rifiuta nulla: un evento con
 * un solo campo malformato verrebbe perso dall'utente. Il link non https viene ripulito
 * (campo rimosso) e tutto il resto passa invariato. La pulizia è richiesta anche per un
 * motivo tecnico: gli eventi applicati dal cloud vengono committati in IndexedDB, dove
 * `validateBackup` rifiuterebbe l'intero commit — un solo campo velenoso bloccerebbe la
 * sincronizzazione di tutta la collezione.
 *
 * Ritorna la stessa reference quando non c'è nulla da pulire, così gli hash di
 * contenuto del merge restano identici e non si genera nessun write inutile.
 */
export function sanitizeRemoteCalendarEvent<T>(payload: T): T {
  if (!isRecord(payload)) return payload;
  if (isValidCalendarEventMeetingUrl(payload.meetingUrl)) return payload;
  const { meetingUrl: _dropped, ...clean } = payload;
  return clean as T;
}

// ---------------------------------------------------------------------------
// Semantic payload validators (per state document type)
// ---------------------------------------------------------------------------

/** A TimetableSlot is valid with or without the optional co-teaching fields (retrocompatible). */
export function isValidTimetableSlot(v: unknown): boolean {
  return (
    isRecord(v) &&
    requiredText(v.id) &&
    intWithin(v.dayOfWeek, 1, 6) &&
    intWithin(v.periodNumber, 1, 24) &&
    isValidTime(v.startTime) &&
    isValidTime(v.endTime) &&
    (v.endTime as string) > (v.startTime as string) &&
    text(v.subject) &&
    text(v.className) &&
    optional(v.classroom, text) &&
    optional(v.campus, text) &&
    optional(v.color, text) &&
    optional(v.isProvisional, bool) &&
    optional(v.coTeachingSubjects, strings) &&
    optional(v.coSupportTeachers, strings) &&
    optional(v.supportTeachers, strings) &&
    optional(v.schoolId, requiredText)
  );
}

export function isValidTimetablePayload(v: unknown): boolean {
  return Array.isArray(v) && v.every(isValidTimetableSlot);
}

function isValidPeriodSlot(v: unknown): boolean {
  return (
    isRecord(v) &&
    intWithin(v.periodNumber, 1, 24) &&
    isValidTime(v.startTime) &&
    isValidTime(v.endTime) &&
    (v.endTime as string) > (v.startTime as string) &&
    optional(v.label, text)
  );
}

/**
 * SchoolProfile.dayPeriods: struttura della giornata scolastica dell'istituto.
 * Additivo e opzionale — un profilo remoto scritto prima di questo campo resta valido.
 */
function isValidSchoolDayPeriods(v: unknown): boolean {
  return (
    isRecord(v) &&
    optional(v.ordinaryPeriodsPerDay, n => intWithin(n, 1, 12)) &&
    optional(v.extraPeriodsByDay, map =>
      isRecord(map) && Object.entries(map).every(([day, extra]) => /^[1-6]$/.test(day) && intWithin(extra, 0, 11)))
  );
}

function isValidTimeSlotConfig(v: unknown): boolean {
  return (
    isRecord(v) &&
    isValidTime(v.firstHourStartTime) &&
    intWithin(v.periodsPerDay, 1, 12) &&
    intWithin(v.standardDurationMinutes, 1, 240) &&
    optional(v.customSlots, slots => Array.isArray(slots) && slots.every(isValidPeriodSlot))
  );
}

export function isValidSettingsPayload(v: unknown): boolean {
  return (
    isRecord(v) &&
    optional(v.timetableMode, m => m === "auto" || m === "provvisorio" || m === "definitivo") &&
    optional(v.onboardingCompleted, bool) &&
    optional(v.timeSlotConfig, isValidTimeSlotConfig)
  );
}

/**
 * G1.2.4 — persisted Google CalendarList cache (metadata only).
 *
 * Deliberately TOLERANT at document level: the array must be an array, but a single
 * malformed entry must never invalidate the whole profile document (which would make
 * the remote profile unusable for a cosmetic cache). Element-level validation lives in
 * `isValidCachedGoogleCalendar` and is applied by `normalizeCachedGoogleCalendars`
 * every time the cache is read, so malformed entries are simply discarded.
 */
export function isValidGoogleCalendarListCache(v: unknown): boolean {
  return Array.isArray(v) && v.length <= 500;
}

export function isValidProfilePayload(v: unknown): boolean {
  return (
    isRecord(v) &&
    requiredText(v.id) &&
    text(v.fullName) &&
    text(v.schoolName) &&
    text(v.schoolYear) &&
    strings(v.primarySubjects) &&
    strings(v.classes) &&
    strings(v.campuses) &&
    Array.isArray(v.roles) &&
    v.roles.every(
      r =>
        isRecord(r) &&
        TEACHER_ROLE_KINDS.includes(r.role as (typeof TEACHER_ROLE_KINDS)[number]) &&
        optional(r.targetClass, text) &&
        optional(r.description, text) &&
        optional(r.label, text)
    ) &&
    optional(v.assignedStudents, strings) &&
    optional(v.isSupportTeacher, bool) &&
    optional(v.googleCalendarLinked, bool) &&
    optional(v.email, text) &&
    optional(v.googleCalendarAccount, text) &&
    optional(v.googleCalendarImportIds, strings) &&
    optional(v.googleCalendarListCache, isValidGoogleCalendarListCache) &&
    optional(v.schoolLevel, l => ["infanzia", "primaria", "ssig", "ssiig"].includes(l as string)) &&
    optional(v.schools, schools => Array.isArray(schools) && schools.every(s => isRecord(s) && requiredText(s.id) && text(s.name) && optional(s.institutionalEmail, text) && optional(s.campuses, strings) && optional(s.schoolLevel, l => ["infanzia", "primaria", "ssig", "ssiig"].includes(l as string)) && optional(s.weeklyHours, n => typeof n === "number" && Number.isFinite(n)) && optional(s.isPrimary, bool) && optional(s.active, bool) && optional(s.dayPeriods, isValidSchoolDayPeriods) && optional(s.timeSlotConfig, isValidTimeSlotConfig))) &&
    // Dati riservati cifrati: `assignedStudents` in chiaro non viaggia più; al suo
    // posto (o accanto, nei documenti precedenti all'attivazione) può esserci il blob.
    optional(v.sensitiveEnc, isValidSensitiveEncBlob)
  );
}

export function isValidStudentPayload(v: unknown): boolean {
  return (
    isRecord(v) &&
    requiredText(v.id) &&
    text(v.fullName) &&
    text(v.className) &&
    Array.isArray(v.notes) &&
    v.notes.every(
      n =>
        isRecord(n) &&
        requiredText(n.id) &&
        text(n.date) &&
        text(n.category) &&
        text(n.title) &&
        text(n.content) &&
        text(n.createdAt)
    ) &&
    optional(v.schoolId, requiredText) &&
    optional(v.schoolYear, requiredText) &&
    optional(v.status, status => status === "active" || status === "archived") &&
    optional(v.archivedAt, isIsoTimestamp) &&
    optional(v.archivedReason, boundedText(500)) &&
    // Dati riservati cifrati (sostegno, PEI, BES/DSA, équipe…): solo il blob può
    // comparire nel cloud, mai i campi in chiaro.
    optional(v.sensitiveEnc, isValidSensitiveEncBlob)
  );
}

export function isValidStudentsPayload(v: unknown): boolean {
  return Array.isArray(v) && v.every(isValidStudentPayload);
}

const payloadValidators: Record<SyncedStateDocName, (v: unknown) => boolean> = {
  profile: isValidProfilePayload,
  settings: isValidSettingsPayload,
  definitiveTimetable: isValidTimetablePayload,
  provisionalTimetable: isValidTimetablePayload,
  students: isValidStudentsPayload,
  // Documento chiavi della cifratura dei dati riservati: solo metadati protetti.
  encryptionKeys: isValidEncryptionKeysPayload,
};

/**
 * The exact legacy shape observed in production: the "payload" is just a metadata
 * object ({schemaVersion, updatedAt}) with no application data inside. This is NOT
 * a valid timetable/profile/settings/students payload — an empty timetable is `[]`.
 */
export function isLegacyMetadataOnlyPayload(v: unknown): boolean {
  if (!isRecord(v) || Object.keys(v).length === 0) return false;
  const keys = Object.keys(v);
  return (
    keys.every(k => k === "schemaVersion" || k === "updatedAt") &&
    (v.schemaVersion !== undefined || v.updatedAt !== undefined)
  );
}

// ---------------------------------------------------------------------------
// Document classification
// ---------------------------------------------------------------------------

export function classifyRemoteStateDoc(name: SyncedStateDocName, raw: unknown): RemoteStateVerdict {
  if (raw === null || raw === undefined) return { status: "absent", name };
  const validate = payloadValidators[name];

  // Very old writer: the document itself is the payload (no {payload, updatedAt} wrapper).
  if (Array.isArray(raw)) {
    if (validate(raw)) {
      return { status: "legacy", name, doc: { payload: raw, updatedAt: REMOTE_EPOCH, schemaVersion: 1 }, raw, reason: "documento senza wrapper (payload direttamente nel documento)" };
    }
    return { status: "invalid", name, raw, reason: "documento senza wrapper e payload non valido" };
  }
  if (!isRecord(raw)) {
    return { status: "invalid", name, raw, reason: "il documento non è un oggetto" };
  }
  if (!("payload" in raw)) {
    return { status: "invalid", name, raw, reason: "documento senza campo \"payload\"" };
  }

  const payload = raw.payload;

  // The observed production legacy document: metadata-only payload, no real data to recover.
  if (isLegacyMetadataOnlyPayload(payload)) {
    return { status: "invalid", name, raw, reason: "documento legacy con payload di soli metadati (nessun dato applicativo)" };
  }

  if (validate(payload)) {
    const hasValidUpdatedAt = isIsoTimestamp(raw.updatedAt);
    if (raw.schemaVersion === 1 && hasValidUpdatedAt) {
      return { status: "valid", name, doc: { payload, updatedAt: raw.updatedAt as string, schemaVersion: 1 } };
    }
    // Real data, malformed wrapper (missing schemaVersion / updatedAt): recoverable.
    return {
      status: "legacy",
      name,
      doc: { payload, updatedAt: hasValidUpdatedAt ? (raw.updatedAt as string) : REMOTE_EPOCH, schemaVersion: 1 },
      raw,
      reason: "wrapper incompleto (schemaVersion/updatedAt mancanti o errati)",
    };
  }

  // Double wrapping: { payload: { payload: <real data>, updatedAt, schemaVersion }, ... }.
  if (isRecord(payload) && "payload" in payload && validate(payload.payload)) {
    const inner = payload as { payload: unknown; updatedAt?: unknown };
    return {
      status: "legacy",
      name,
      doc: { payload: inner.payload, updatedAt: isIsoTimestamp(inner.updatedAt) ? (inner.updatedAt as string) : REMOTE_EPOCH, schemaVersion: 1 },
      raw,
      reason: "payload annidato due volte (doppio wrapper)",
    };
  }

  return { status: "invalid", name, raw, reason: `payload non valido per la sezione "${name}"` };
}
