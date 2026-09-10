import { isValidTime } from "../../utils/dates";
import { TEACHER_ROLE_KINDS } from "../../types";
import type { RemoteStateDoc, StateDocName } from "./types";

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
  | { status: "absent"; name: StateDocName }
  | { status: "valid"; name: StateDocName; doc: RemoteStateDoc }
  | { status: "legacy"; name: StateDocName; doc: RemoteStateDoc; raw: unknown; reason: string }
  | { status: "invalid"; name: StateDocName; raw: unknown; reason: string };

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
    optional(v.schoolLevel, l => ["infanzia", "primaria", "ssig", "ssiig"].includes(l as string)) &&
    optional(v.schools, schools => Array.isArray(schools) && schools.every(s => isRecord(s) && requiredText(s.id) && text(s.name) && optional(s.institutionalEmail, text) && optional(s.campuses, strings) && optional(s.schoolLevel, l => ["infanzia", "primaria", "ssig", "ssiig"].includes(l as string)) && optional(s.weeklyHours, n => typeof n === "number" && Number.isFinite(n)) && optional(s.isPrimary, bool) && optional(s.active, bool)))
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
    )
  );
}

export function isValidStudentsPayload(v: unknown): boolean {
  return Array.isArray(v) && v.every(isValidStudentPayload);
}

const payloadValidators: Record<StateDocName, (v: unknown) => boolean> = {
  profile: isValidProfilePayload,
  settings: isValidSettingsPayload,
  definitiveTimetable: isValidTimetablePayload,
  provisionalTimetable: isValidTimetablePayload,
  students: isValidStudentsPayload,
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

export function classifyRemoteStateDoc(name: StateDocName, raw: unknown): RemoteStateVerdict {
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
