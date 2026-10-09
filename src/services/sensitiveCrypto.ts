/**
 * CIFRATURA A BUSTA DEI DATI RISERVATI — primitive crittografiche pure.
 *
 * Solo Web Crypto API del browser (`crypto.subtle`): nessuna dipendenza nuova.
 * In Node (test) usa la stessa identica API esposta come globale.
 *
 * Modello delle chiavi:
 *  - una chiave dati casuale AES-GCM 256 bit, generata una volta per account,
 *    cifra i dati riservati (alunni e `assignedStudents` del profilo);
 *  - la chiave dati è protetta DUE volte, e nel cloud finisce solo protetta:
 *      1. con una chiave derivata dalla frase segreta dell'utente;
 *      2. con una chiave derivata da un codice di recupero mostrato una volta;
 *  - derivazione: PBKDF2-HMAC-SHA256, 600.000 iterazioni, sale casuale di
 *    16 byte per account (il sale è salvato nel cloud: non è un segreto);
 *  - ogni cifratura usa un IV casuale di 12 byte, mai riutilizzato;
 *  - un piccolo valore di verifica cifrato consente di dire "frase errata"
 *    senza tentare di decifrare i dati;
 *  - la frase segreta e il codice di recupero non vengono MAI salvati né
 *    inviati: viaggiano solo i loro effetti (chiavi derivate e involucro).
 *
 * I secret sono separati per dominio dentro PBKDF2 (prefisso distinto per
 * frase e codice di recupero), così lo stesso sale non produce mai la stessa
 * chiave derivata da due sorgenti diverse.
 */

import type { SensitiveEncryptedBlob } from "../types";

export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
const AES_KEY_BITS = 256;
const RAW_DATA_KEY_BYTES = 32;

/** Valore noto cifrato con la chiave dati: rivela "frase errata" senza toccare i dati. */
export const VERIFY_CONSTANT = "agenda-docente/verifica-dati-riservati/v1";

const PHRASE_DOMAIN = "agenda-docente/v1/frase:";
const RECOVERY_DOMAIN = "agenda-docente/v1/recupero:";

/** Involucro AES-GCM della chiave dati (base64, solo testo illeggibile nel cloud). */
export interface WrappedKey {
  iv: string;
  ct: string;
}

/** Alfabeto del codice di recupero: niente caratteri ambigui (0/O, 1/I). */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_CHARS = 24; // 15 byte casuali = 120 bit di entropia
const RECOVERY_GROUP = 4;

function webcrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.subtle && typeof c.getRandomValues === "function") return c;
  throw new Error("Web Crypto API non disponibile su questo dispositivo.");
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  webcrypto().getRandomValues(bytes);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(bytes).toString("base64"); // Node (test)
}

export function fromBase64(value: string): Uint8Array {
  const binary = typeof atob === "function" ? atob(value) : Buffer.from(value, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isNonEmptyBase64(value: unknown, max = 262_144): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

/** Forma valida del blob cifrato che accompagna alunni e profilo nel cloud. */
export function isSensitiveEncryptedBlob(value: unknown): value is SensitiveEncryptedBlob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.v === 1 && isNonEmptyBase64(v.iv, 64) && isNonEmptyBase64(v.ct);
}

/** Forma valida dell'involucro che protegge la chiave dati nel documento chiavi. */
export function isWrappedKey(value: unknown): value is WrappedKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return isNonEmptyBase64(v.iv, 64) && isNonEmptyBase64(v.ct, 256);
}

// ---------------------------------------------------------------------------
// Generazione e derivazione delle chiavi
// ---------------------------------------------------------------------------

/** Sale casuale dell'account (16 byte, base64): non è un segreto, finisce nel cloud. */
export function generateSalt(): string {
  return toBase64(randomBytes(SALT_BYTES));
}

/**
 * Chiave dati AES-GCM 256 casuale, una volta per account. Restituisce anche i
 * byte grezzi (servono SOLO al momento dell'attivazione per creare i due
 * involucri; dopo vanno scartati — il dispositivo conserva solo una copia
 * CryptoKey NON estraibile).
 */
export async function generateDataKey(): Promise<{ key: CryptoKey; raw: Uint8Array }> {
  const subtle = webcrypto().subtle;
  const key = await subtle.generateKey({ name: "AES-GCM", length: AES_KEY_BITS }, true, ["encrypt", "decrypt"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", key));
  return { key, raw };
}

/** Importa i byte grezzi come chiave dati AES-GCM. `extractable: false` è la norma sul dispositivo. */
export async function importDataKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== RAW_DATA_KEY_BYTES) throw new Error("Chiave dati non valida.");
  return webcrypto().subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, extractable, ["encrypt", "decrypt"]);
}

/**
 * Deriva la chiave di protezione dalla frase segreta o dal codice di recupero:
 * PBKDF2-HMAC-SHA256, 600.000 iterazioni, sale dell'account, dominio distinto.
 */
export async function deriveWrappingKey(
  secret: string,
  saltBase64: string,
  kind: "phrase" | "recovery",
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  if (!secret) throw new Error("Frase o codice mancante.");
  const subtle = webcrypto().subtle;
  const material = new TextEncoder().encode((kind === "phrase" ? PHRASE_DOMAIN : RECOVERY_DOMAIN) + secret);
  const base = await subtle.importKey("raw", material as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromBase64(saltBase64) as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: AES_KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Protegge i byte grezzi della chiave dati con una chiave derivata (AES-GCM, IV fresco). */
export async function wrapRawKey(raw: Uint8Array, wrappingKey: CryptoKey): Promise<WrappedKey> {
  const iv = randomBytes(IV_BYTES);
  const ct = await webcrypto().subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, wrappingKey, raw as BufferSource);
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Apre l'involucro: fallisce (eccezione) se la chiave derivata non è quella giusta. */
export async function unwrapRawKey(wrapped: WrappedKey, wrappingKey: CryptoKey): Promise<Uint8Array> {
  const raw = await webcrypto().subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(wrapped.iv) as BufferSource },
    wrappingKey,
    fromBase64(wrapped.ct) as BufferSource,
  );
  return new Uint8Array(raw);
}

// ---------------------------------------------------------------------------
// Cifratura dei dati (un blob per alunno / per il profilo)
// ---------------------------------------------------------------------------

/**
 * Cifra un valore JSON con la chiave dati. Ogni chiamata genera un IV casuale
 * di 12 byte: due cifrature dello stesso valore producono sempre blob diversi.
 */
export async function encryptJson(key: CryptoKey, value: unknown): Promise<SensitiveEncryptedBlob> {
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(value ?? null));
  const ct = await webcrypto().subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource);
  return { v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Decifra un blob prodotto da `encryptJson`. Fallisce con chiave o blob sbagliati. */
export async function decryptJson<T = unknown>(key: CryptoKey, blob: SensitiveEncryptedBlob): Promise<T> {
  const plaintext = await webcrypto().subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(blob.iv) as BufferSource },
    key,
    fromBase64(blob.ct) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

// ---------------------------------------------------------------------------
// Codice di recupero
// ---------------------------------------------------------------------------

/**
 * Codice di recupero: 15 byte casuali (120 bit) in base32 senza ambiguità,
 * a gruppi di 4. Mostrato UNA sola volta: non viene salvato da nessuna parte.
 */
export function generateRecoveryCode(): string {
  const raw = randomBytes(15);
  // 15 byte = 120 bit -> esattamente 24 caratteri base32, senza padding.
  let bits = 0;
  let value = 0;
  const chars: string[] = [];
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars.push(RECOVERY_ALPHABET[(value >>> bits) & 31]);
    }
  }
  const code = chars.join("");
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += RECOVERY_GROUP) groups.push(code.slice(i, i + RECOVERY_GROUP));
  return groups.join("-");
}

/**
 * Normalizza un codice digitato dall'utente (maiuscole, spazi e trattini
 * irrilevanti). Restituisce null se non ha la forma di un codice di recupero.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== RECOVERY_CODE_CHARS) return null;
  for (const char of cleaned) if (!RECOVERY_ALPHABET.includes(char)) return null;
  return cleaned;
}
