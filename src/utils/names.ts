/**
 * Display-name normalization for teacher identity fields (e.g. Google `displayName`).
 *
 * Rules:
 * - Each name component starts with an uppercase letter: "felice manganiello" -> "Felice Manganiello".
 * - Internal boundaries (hyphen, apostrophe) are capitalized too: "anna maria d'angelo" -> "Anna Maria D'Angelo".
 * - Already formatted mixed-case names are not rewritten: "De Rossi" stays "De Rossi", "McDonald" stays "McDonald".
 * - Short all-caps initials/acronyms ("J.", "JR", "M.") are preserved.
 * - Emails and tokens without letters are returned untouched.
 */

const hasLetter = (token: string) => /\p{L}/u.test(token);

function formatWord(word: string): string {
  if (!hasLetter(word)) return word;
  const lettersOnly = (word.match(/\p{L}/gu) ?? []).join("");
  // Initials and short acronyms ("J", "JR.", "M.") are intentional formatting, keep them.
  if (lettersOnly.length <= 3 && lettersOnly === lettersOnly.toLocaleUpperCase("it-IT")) return word;
  const alreadyFormatted = /^\p{Lu}/u.test(word) && /\p{Ll}/u.test(word);
  const base = alreadyFormatted ? word : word.toLocaleLowerCase("it-IT");
  return base.replace(/(^\p{L})|([-'])\p{L}/gu, (match) => {
    const letter = match.slice(-1);
    return match.slice(0, -1) + letter.toLocaleUpperCase("it-IT");
  });
}

/** Normalize a person's display name to title case. Never touches e-mail addresses. */
export function formatPersonDisplayName(raw: unknown): string {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!text || text.includes("@")) return text;
  return text.split(" ").map(formatWord).join(" ");
}

/** Placeholder names shipped with old installs or demo seeds: safe to replace with a real account name. */
const SEED_NAMES = new Set(["prof. mario rossi", "prof. andrea conti", "prof.ssa laura bianchi", "dott. mario rossi", "docente"]);
export function isPlaceholderFullName(value: unknown): boolean {
  const name = String(value ?? "").trim().toLowerCase();
  return name === "" || SEED_NAMES.has(name);
}
