/** Calendar days are civil dates, not UTC instants. */
export function localDateISO(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Build a local Date at civil noon: DST-safe, never UTC (see "Non usare UTC per le date civili"). */
export function parseCivilDate(iso: string): Date {
  if (!isValidDate(iso)) throw new Error("Data non valida");
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

/** Shift a civil date by whole days. Crossing months and years stays in local time. */
export function addDaysISO(iso: string, days: number): string {
  const d = parseCivilDate(iso);
  d.setDate(d.getDate() + days);
  return localDateISO(d);
}

/** 0 = Sunday … 6 = Saturday, evaluated on the civil date itself (not on a UTC instant). */
export function civilDayOfWeek(iso: string): number {
  return parseCivilDate(iso).getDay();
}

/** Timetable weekday key used by AgendaDocente (1 = Monday … 6 = Saturday); Sunday has no lessons. */
export function civilTimetableDay(iso: string): 1 | 2 | 3 | 4 | 5 | 6 | null {
  const day = civilDayOfWeek(iso);
  if (day === 0) return null;
  return day as 1 | 2 | 3 | 4 | 5 | 6;
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function nextDateISO(value: string): string {
  if (!isValidDate(value)) throw new Error("Data non valida");
  const [y, m, d] = value.split("-").map(Number);
  return localDateISO(new Date(y, m - 1, d + 1, 12));
}

export function isValidTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function eventDateError(event: { date: string; isAllDay?: boolean; startTime?: string; endTime?: string }): string | null {
  if (!isValidDate(event.date)) return "Inserisci una data valida.";
  if (event.isAllDay) return null;
  if (!isValidTime(event.startTime) || !isValidTime(event.endTime)) return "Completa l'ora di inizio e di fine prima di aggiungere l'impegno.";
  if (event.endTime <= event.startTime) return "L'ora di fine deve essere successiva all'ora di inizio.";
  return null;
}
