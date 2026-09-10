/**
 * Parsing/validation for the per-student "ore settimanali di sostegno" numeric field.
 *
 * The edit form keeps the raw draft string while the user types (so Backspace to an empty
 * field stays empty instead of snapping back to the previous/default value — see the
 * ClassesView support-hours input). Conversion to the model's `number | undefined` happens
 * only on blur/save, through this pure helper:
 *
 *   ""            -> { kind: "empty"  }  commit undefined (never re-insert the old value)
 *   "10" / "9,5"  -> { kind: "valid", hours }  commit the number
 *   "abc", "-3", "-" -> { kind: "invalid" }  not a valid amount: keep the stored value
 */
export type SupportHoursParse =
  | { kind: "empty" }
  | { kind: "valid"; hours: number }
  | { kind: "invalid" };

export function parseSupportHoursDraft(raw: string): SupportHoursParse {
  const text = (raw ?? "").trim();
  if (text === "") return { kind: "empty" };
  // Only plain (possibly negative) integer/decimal numbers with . or , separator are
  // candidates; anything else ("abc", "1e", "-", "+") cannot be a weekly amount.
  if (!/^-?\d+(?:[.,]\d+)?$/.test(text)) return { kind: "invalid" };
  const hours = Number(text.replace(",", "."));
  if (!Number.isFinite(hours) || hours < 0) return { kind: "invalid" };
  return { kind: "valid", hours };
}
