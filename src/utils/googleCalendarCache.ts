import type { CachedGoogleCalendar } from "../types";
import { PRIMARY_CALENDAR_ID, type GoogleCalendarListEntry } from "../services/googleCalendarService";

/**
 * G1.2.4 — persistent cache of the Google CalendarList.
 *
 * SECURITY: the cache is metadata only. The four fields below are the ONLY keys that
 * may ever be written to the profile; access tokens, refresh tokens, cookies,
 * credentials and events are never persisted (`toCachedGoogleCalendar` rebuilds the
 * object field by field, so an enriched CalendarList entry cannot leak anything new).
 */
export const CACHED_GOOGLE_CALENDAR_FIELDS = ["id", "summary", "primary", "accessRole"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Element-level validation: non-empty id, string summary, optional boolean/string extras. */
export function isValidCachedGoogleCalendar(value: unknown): value is CachedGoogleCalendar {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (typeof value.summary !== "string") return false;
  if (value.primary !== undefined && typeof value.primary !== "boolean") return false;
  if (value.accessRole !== undefined && typeof value.accessRole !== "string") return false;
  return true;
}

/** Rebuilds a cache entry from scratch, dropping every non-whitelisted (possibly sensitive) field. */
export function toCachedGoogleCalendar(
  entry: Pick<GoogleCalendarListEntry, "id" | "summary" | "primary" | "accessRole">,
): CachedGoogleCalendar {
  const cached: CachedGoogleCalendar = { id: entry.id, summary: entry.summary ?? entry.id };
  // `undefined` is omitted on purpose: Firestore rejects undefined values.
  if (typeof entry.primary === "boolean") cached.primary = entry.primary;
  if (typeof entry.accessRole === "string") cached.accessRole = entry.accessRole;
  return cached;
}

/**
 * Deduplicates by id and keeps the primary alias normalization of G1.2 intact:
 * when a real primary calendar is present, a literal `"primary"` row is dropped so
 * the cache never holds both `"primary"` and the real primary id for the same calendar.
 */
function dedupeCachedGoogleCalendars(entries: CachedGoogleCalendar[]): CachedGoogleCalendar[] {
  const byId = new Map<string, CachedGoogleCalendar>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    byId.set(entry.id, existing ? { ...existing, ...entry } : entry);
  }
  const unique = [...byId.values()];
  const realPrimary = unique.find(entry => entry.primary === true && entry.id !== PRIMARY_CALENDAR_ID);
  return realPrimary ? unique.filter(entry => entry.id !== PRIMARY_CALENDAR_ID) : unique;
}

/** CalendarList (runtime) → persistable cache. */
export function toCachedGoogleCalendarList(entries: GoogleCalendarListEntry[]): CachedGoogleCalendar[] {
  return dedupeCachedGoogleCalendars(
    entries.filter(entry => isValidCachedGoogleCalendar(toCachedGoogleCalendar(entry))).map(toCachedGoogleCalendar),
  );
}

/**
 * Untrusted stored value → usable cache. A malformed element is DISCARDED;
 * it never invalidates the whole profile (G1.2.4 §3).
 */
export function normalizeCachedGoogleCalendars(value: unknown): CachedGoogleCalendar[] {
  if (!Array.isArray(value)) return [];
  return dedupeCachedGoogleCalendars(
    value.filter(isValidCachedGoogleCalendar).map(toCachedGoogleCalendar),
  );
}

/** Cache → runtime CalendarList entries (identical shape, no `selected`/`hidden` info). */
export function cachedGoogleCalendarsToEntries(value: unknown): GoogleCalendarListEntry[] {
  return normalizeCachedGoogleCalendars(value).map(entry => ({ ...entry }));
}

/** Cheap structural comparison used to avoid pointless profile writes on every refresh. */
export function sameCachedGoogleCalendarList(
  a: CachedGoogleCalendar[] | undefined,
  b: CachedGoogleCalendar[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return entry.id === other.id
      && entry.summary === other.summary
      && (entry.primary ?? false) === (other.primary ?? false)
      && (entry.accessRole ?? "") === (other.accessRole ?? "");
  });
}

/**
 * Every identity a calendar can be selected under, including the `"primary"` alias.
 * Used to audit a persisted selection against a fresh (live) CalendarList.
 */
export function googleCalendarSelectableIds(
  entries: Pick<GoogleCalendarListEntry, "id" | "primary">[],
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(entry.id);
    if (entry.primary) ids.add(PRIMARY_CALENDAR_ID);
  }
  return ids;
}
