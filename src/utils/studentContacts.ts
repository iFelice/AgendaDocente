/**
 * Normalizzazione e validazione dei contatti extra (tutor, terapisti, ecc.).
 *
 * Funzioni pure: nessun effetto collaterale, accettano input non fidati
 * (utente, backup, cloud cifrato) e scartano senza errori ciò che non è
 * conforme ai contratti.
 */

import type { StudentContact, StudentContactRole } from "../types";

export const MAX_EXTRA_CONTACTS = 20;
export const CONTACT_STRING_MAX = 200;
export const CONTACT_NOTES_MAX = 500;

const VALID_ROLES: ReadonlySet<StudentContactRole> = new Set<StudentContactRole>([
  "tutore_legale",
  "tutor",
  "terapista",
  "educatore",
  "medico",
  "altro",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const boundedString = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
};

/**
 * Valida un'email: vuota è ammessa (il campo è facoltativo); se compilata
 * deve contenere '@' e un dominio (formato basilare, non RFC 5322 completo).
 */
export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true; // vuoto = ok (facoltativo)
  // Deve esserci una @ con qualcosa prima e un punto dopo, nel dominio.
  const at = trimmed.indexOf("@");
  if (at <= 0) return false;
  const domain = trimmed.slice(at + 1);
  if (!domain || !domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  // Nessuno spazio interno
  if (/\s/.test(trimmed)) return false;
  return true;
}

/**
 * Valida UN singolo contatto (input non fidato).
 * Restituisce undefined se il record non è un contatto valido o è completamente vuoto.
 */
function sanitizeOne(raw: unknown): StudentContact | undefined {
  if (!isRecord(raw)) return undefined;
  const role = raw.role;
  if (typeof role !== "string" || !VALID_ROLES.has(role as StudentContactRole)) {
    return undefined;
  }
  const name = boundedString(raw.name, CONTACT_STRING_MAX);
  const phone = boundedString(raw.phone, CONTACT_STRING_MAX);
  const email = boundedString(raw.email, CONTACT_STRING_MAX);
  const roleDetail = boundedString(raw.roleDetail, CONTACT_STRING_MAX);
  const notes = boundedString(raw.notes, CONTACT_NOTES_MAX);
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : `sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Contatto completamente vuoto: scartato
  if (!name && !phone && !email && !roleDetail && !notes) return undefined;

  const out: StudentContact = { id, role: role as StudentContactRole };
  if (name) out.name = name;
  if (phone) out.phone = phone;
  if (email) out.email = email;
  if (roleDetail) out.roleDetail = roleDetail;
  if (notes) out.notes = notes;
  return out;
}

/**
 * Normalizza un array di contatti da input non fidato (decifratura, backup,
 * UI non validata). Scarta elementi non validi, impone il limite di 20,
 * elimina i completamente vuoti e normalizza trim/lunghezze.
 *
 * Restituisce undefined se non ci sono contatti validi (non []), così
 * l'assenza del campo coincide con "nessun contatto" e non fa scattare
 * la logica "ha dati riservati".
 */
export function normalizeStudentContacts(value: unknown): StudentContact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: StudentContact[] = [];
  for (const raw of value) {
    if (out.length >= MAX_EXTRA_CONTACTS) break;
    const cleaned = sanitizeOne(raw);
    if (cleaned) out.push(cleaned);
  }
  return out.length ? out : undefined;
}

/**
 * Genera un id client-side per un nuovo contatto vuoto (usato dal modulo UI
 * quando l'utente clicca "+ Aggiungi contatto").
 */
export function newEmptyContact(): StudentContact {
  return {
    id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "tutor",
  };
}

/**
 * Verifica se un contatto del modulo è "completamente vuoto" e può essere
 * scartato al salvataggio (senza chiedere conferma).
 */
export function isContactCompletelyEmpty(c: Partial<StudentContact>): boolean {
  return !(c.name?.trim() || c.phone?.trim() || c.email?.trim() || c.roleDetail?.trim() || c.notes?.trim());
}
