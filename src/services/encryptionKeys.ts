/**
 * CHIAVI DELLA CIFRATURA DEI DATI RISERVATI — keystore dell'account.
 *
 * Un solo documento di stato dedicato, `users/{uid}/state/encryptionKeys`,
 * con la stessa forma {payload, updatedAt, schemaVersion} degli altri
 * documenti di stato. Contiene ESCLUSIVAMENTE:
 *  - il sale casuale dell'account (non è un segreto);
 *  - la chiave dati protetta DUE volte: con la frase segreta e con il codice
 *    di recupero (involucri AES-GCM, testo illeggibile);
 *  - un piccolo valore di verifica cifrato per dire "frase errata" senza
 *    tentare di decifrare i dati.
 * La frase segreta e il codice di recupero non vengono mai salvati né inviati.
 *
 * Sul dispositivo la chiave dati sbloccata è conservata come CryptoKey NON
 * estraibile (riga metadata di IndexedDB): nessun byte grezzo resta su disco.
 *
 * Cambiare la frase segreta RI-Protegge solo la chiave dati (nuovo involucro):
 * gli alunni e il profilo non vengono ricifrati.
 */

import {
  VERIFY_CONSTANT,
  decryptJson,
  deriveWrappingKey,
  encryptJson,
  generateDataKey,
  generateRecoveryCode,
  generateSalt,
  importDataKey,
  isSensitiveEncryptedBlob,
  isWrappedKey,
  normalizeRecoveryCode,
  unwrapRawKey,
  wrapRawKey,
  type WrappedKey,
} from "./sensitiveCrypto";
import { classifyRemoteStateDoc } from "./sync/remoteSchema";
import {
  SENSITIVE_STUDENT_FIELDS,
  pickSensitiveStudentFields,
  stripSensitiveTransportProfile,
  stripSensitiveTransportStudent,
  type DecryptedSensitive,
  type DecryptedStudentFields,
} from "./sensitiveData";
import type { SyncableSnapshot } from "./sync/types";
import type { Student, TeacherProfile } from "../types";

/** Lunghezza minima della frase segreta: abbastanza lunga da non indovinarsi. */
export const MIN_PHRASE_LENGTH = 12;

/** Payload del documento di stato `encryptionKeys`: solo metadati protetti. */
export interface EncryptionKeysPayload {
  v: 1;
  salt: string;
  wrappedPhrase: WrappedKey;
  wrappedRecovery: WrappedKey;
  verify: { v: 1; iv: string; ct: string };
}

/** Stato della cifratura visto da QUESTO dispositivo. */
export type EncryptionDeviceState = "inactive" | "locked" | "unlocked";

export type SecretKind = "phrase" | "recovery";

/** Frase o codice sbagliati: messaggio già pronto per l'interfaccia. */
export class WrongSecretError extends Error {
  constructor() {
    super("Frase segreta o codice di recupero non corretti.");
    this.name = "WrongSecretError";
  }
}

/** La cifratura è già stata attivata per questo account. */
export class AlreadyActiveError extends Error {
  constructor() {
    super("La protezione dei dati riservati risulta già attiva per questo account.");
    this.name = "AlreadyActiveError";
  }
}

/** Accesso ridotto per il keystore: lettura/scrittura del solo documento chiavi. */
export interface KeysGateway {
  readState(name: "encryptionKeys"): Promise<unknown>;
  writeState(name: "encryptionKeys", payload: unknown): Promise<{ updatedAt: string }>;
}

/** Lettura/scrittura delle righe metadata del dispositivo (IndexedDB). */
export interface KeysMetaStore {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
}

export interface EncryptionKeystoreDeps {
  gateway: () => KeysGateway | null;
  meta: KeysMetaStore;
}

const deviceKeyMetaKey = (uid: string): string => `encryption:device-key:${uid}`;

function isEncryptionKeysPayload(value: unknown): value is EncryptionKeysPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.salt === "string" && v.salt.length >= 16 &&
    isWrappedKey(v.wrappedPhrase) &&
    isWrappedKey(v.wrappedRecovery) &&
    isSensitiveEncryptedBlob(v.verify)
  );
}

export function validatePhrase(phrase: string): string | null {
  if (typeof phrase !== "string" || phrase.trim().length < MIN_PHRASE_LENGTH) {
    return `La frase segreta deve avere almeno ${MIN_PHRASE_LENGTH} caratteri.`;
  }
  return null;
}

export class EncryptionKeystore {
  /** Copia in memoria del documento chiavi per l'ultima lettura (una per sessione). */
  private cache = new Map<string, EncryptionKeysPayload | null>();

  constructor(private deps: EncryptionKeystoreDeps) {}

  /**
   * Documento chiavi dell'account dal cloud (validato come input non fidato).
   * null = cifratura mai attivata per questo account (o documento non valido).
   */
  async loadKeys(uid: string, refresh = false): Promise<EncryptionKeysPayload | null> {
    if (!refresh && this.cache.has(uid)) return this.cache.get(uid) ?? null;
    const gateway = this.deps.gateway();
    if (!gateway) return null;
    const raw = await gateway.readState("encryptionKeys");
    const verdict = classifyRemoteStateDoc("encryptionKeys", raw);
    const payload = verdict.status === "valid" || verdict.status === "legacy" ? verdict.doc.payload : null;
    const valid = payload !== null && isEncryptionKeysPayload(payload) ? payload : null;
    this.cache.set(uid, valid);
    return valid;
  }

  async status(uid: string): Promise<EncryptionDeviceState> {
    const payload = await this.loadKeys(uid);
    if (!payload) return "inactive";
    return (await this.deviceKey(uid)) ? "unlocked" : "locked";
  }

  /**
   * Chiave dati sbloccata su questo dispositivo: CryptoKey NON estraibile
   * conservata nelle righe metadata di IndexedDB. null = dispositivo da sbloccare.
   */
  async deviceKey(uid: string): Promise<CryptoKey | null> {
    try {
      const stored = await this.deps.meta.read(deviceKeyMetaKey(uid));
      if (stored instanceof CryptoKey && stored.type === "secret") return stored;
      return null;
    } catch {
      return null;
    }
  }

  private async storeDeviceKey(uid: string, raw: Uint8Array): Promise<CryptoKey> {
    const key = await importDataKey(raw, false); // non estraibile: è ciò che resta sul dispositivo
    await this.deps.meta.write(deviceKeyMetaKey(uid), key);
    return key;
  }

  /**
   * ATTIVAZIONE (una volta per account): genera sale, chiave dati e codice di
   * recupero; protegge la chiave dati con la frase e con il codice; scrive il
   * documento chiavi; conserva la chiave dati sul dispositivo.
   * Restituisce il codice di recupero da mostrare UNA sola volta.
   */
  async activate(uid: string, passphrase: string): Promise<{ recoveryCode: string }> {
    const gateway = this.deps.gateway();
    if (!gateway) throw new Error("Accesso Google richiesto per proteggere i dati riservati.");
    const phraseError = validatePhrase(passphrase);
    if (phraseError) throw new Error(phraseError);
    if (await this.loadKeys(uid, true)) throw new AlreadyActiveError();

    const salt = generateSalt();
    const { key, raw } = await generateDataKey();
    const recoveryCode = generateRecoveryCode();
    const payload: EncryptionKeysPayload = {
      v: 1,
      salt,
      wrappedPhrase: await wrapRawKey(raw, await deriveWrappingKey(passphrase, salt, "phrase")),
      wrappedRecovery: await wrapRawKey(raw, await deriveWrappingKey(normalizeRecoveryCode(recoveryCode)!, salt, "recovery")),
      verify: await encryptJson(key, VERIFY_CONSTANT),
    };
    await gateway.writeState("encryptionKeys", payload);
    this.cache.set(uid, payload);
    await this.storeDeviceKey(uid, raw);
    return { recoveryCode };
  }

  /**
   * SBLOCCO su questo dispositivo: apre l'involucro con la frase o con il
   * codice di recupero, controlla il valore di verifica (rifiuto esplicito di
   * "frase errata") e conserva la chiave dati come CryptoKey non estraibile.
   */
  async unlock(uid: string, secret: string, kind: SecretKind): Promise<void> {
    const payload = await this.loadKeys(uid, true);
    if (!payload) throw new Error("La protezione dei dati riservati non risulta attiva per questo account.");
    const raw = await this.unwrapWithSecret(payload, secret, kind);
    await this.storeDeviceKey(uid, raw);
  }

  /**
   * Sblocco "prova tu": accetta la frase segreta oppure il codice di recupero
   * nello stesso campo, senza chiedere all'utente di quale dei due si tratta.
   */
  async unlockAuto(uid: string, secret: string): Promise<void> {
    const payload = await this.loadKeys(uid, true);
    if (!payload) throw new Error("La protezione dei dati riservati non risulta attiva per questo account.");
    const trimmed = secret.trim();
    const asRecovery = normalizeRecoveryCode(trimmed);
    if (asRecovery) {
      try {
        await this.unlock(uid, asRecovery, "recovery");
        return;
      } catch (error) {
        if (!(error instanceof WrongSecretError)) throw error;
        // La forma è quella di un codice ma non apre: si prova comunque come frase.
      }
    }
    try {
      await this.unlock(uid, trimmed, "phrase");
      return;
    } catch (error) {
      if (!(error instanceof WrongSecretError)) throw error;
    }
    throw new WrongSecretError();
  }

  /**
   * CAMBIO DELLA FRASE SEGRETA: richiede la frase attuale o il codice di
   * recupero. Riprotegge SOLO la chiave dati (nuovo involucro per la frase):
   * l'involucro del codice di recupero, il sale, la verifica e soprattutto gli
   * alunni cifrati non vengono toccati.
   */
  async changePassphrase(uid: string, current: { secret: string; kind: SecretKind }, newPassphrase: string): Promise<void> {
    const gateway = this.deps.gateway();
    if (!gateway) throw new Error("Accesso Google richiesto per proteggere i dati riservati.");
    const payload = await this.loadKeys(uid, true);
    if (!payload) throw new Error("La protezione dei dati riservati non risulta attiva per questo account.");
    const phraseError = validatePhrase(newPassphrase);
    if (phraseError) throw new Error(phraseError);
    const raw = await this.unwrapWithSecret(payload, current.secret, current.kind);
    const updated: EncryptionKeysPayload = {
      ...payload,
      wrappedPhrase: await wrapRawKey(raw, await deriveWrappingKey(newPassphrase, payload.salt, "phrase")),
    };
    await gateway.writeState("encryptionKeys", updated);
    this.cache.set(uid, updated);
    await this.storeDeviceKey(uid, raw);
  }

  /** Apre l'involucro giusto con il secret giusto; altrimenti WrongSecretError. */
  private async unwrapWithSecret(payload: EncryptionKeysPayload, secret: string, kind: SecretKind): Promise<Uint8Array> {
    const normalized = kind === "recovery" ? normalizeRecoveryCode(secret) : secret;
    if (!normalized) throw new WrongSecretError();
    try {
      const wrapping = await deriveWrappingKey(normalized, payload.salt, kind);
      const wrapped = kind === "recovery" ? payload.wrappedRecovery : payload.wrappedPhrase;
      const raw = await unwrapRawKey(wrapped, wrapping);
      // Verifica esplicita: "frase errata" senza provare a decifrare i dati.
      const check = await decryptJson<string>(await importDataKey(raw), payload.verify);
      if (check !== VERIFY_CONSTANT) throw new WrongSecretError();
      return raw;
    } catch (error) {
      if (error instanceof WrongSecretError) throw error;
      throw new WrongSecretError();
    }
  }
}

// ---------------------------------------------------------------------------
// Sblocco dei dati già presenti in locale (blob arrivati da un ripristino)
// ---------------------------------------------------------------------------

/**
 * Dopo lo sblocco, i blob eventualmente conservati nelle righe locali (arrivati
 * col ripristino quando il dispositivo era ancora bloccato) vengono decifrati
 * subito, in locale: i valori prendono il posto del blob. Righe senza blob o
 * con un blob illeggibile restano invariate.
 */
export async function decryptLocalStudents(students: Student[], key: CryptoKey): Promise<{ students: Student[]; changed: boolean }> {
  let changed = false;
  const out: Student[] = [];
  for (const row of students) {
    const blob = row?.sensitiveEnc;
    if (!blob || !isSensitiveEncryptedBlob(blob)) { out.push(row); continue; }
    try {
      const fields = sanitizeDecryptedStudentFields(await decryptJson(key, blob));
      const { sensitiveEnc: _dropped, ...rest } = row;
      out.push({ ...rest, ...fields } as Student);
      changed = true;
    } catch {
      out.push(row); // blob illeggibile: si conserva, riproverà al prossimo ingresso
    }
  }
  return { students: out, changed };
}

/** Come sopra per `assignedStudents` del profilo. */
export async function decryptLocalProfile(profile: TeacherProfile, key: CryptoKey): Promise<{ profile: TeacherProfile; changed: boolean }> {
  const blob = profile?.sensitiveEnc;
  if (!blob || !isSensitiveEncryptedBlob(blob)) return { profile, changed: false };
  try {
    const value = await decryptJson(key, blob);
    const assigned = isRecord(value) && Array.isArray(value.assignedStudents)
      ? value.assignedStudents.filter(item => typeof item === "string")
      : null;
    if (assigned === null) return { profile, changed: false };
    const { sensitiveEnc: _dropped, ...rest } = profile;
    return { profile: { ...rest, assignedStudents: assigned }, changed: true };
  } catch {
    return { profile, changed: false };
  }
}

// ---------------------------------------------------------------------------
// Adattatore per il motore di sincronizzazione
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Il motore di sync non conosce la cifratura: parla con questo adattatore.
 * Senza documento chiavi (cifratura mai attivata) `cycleState` restituisce
 * null e tutto si comporta esattamente come prima (campi riservati solo locali).
 */
export interface SensitiveSyncAdapter {
  /** Stato chiavi dell'account per il ciclo: null = cifratura mai attivata. */
  cycleState(uid: string): Promise<{ dataKey: CryptoKey | null } | null>;
  /** INGRESSO: decifra i blob di un payload remoto (miglior sforzo). */
  decryptRemote(name: "students" | "profile", payload: unknown, key: CryptoKey): Promise<DecryptedSensitive>;
  /** USCITA: aggancia i blob cifrati (con la chiave) al payload in partenza. */
  attachOutgoing(
    name: "students" | "profile",
    base: unknown,
    ctx: { snapshot: SyncableSnapshot; remotePayload: unknown; key: CryptoKey },
  ): Promise<unknown>;
}

export function createSensitiveSyncAdapter(keystore: EncryptionKeystore): SensitiveSyncAdapter {
  return {
    async cycleState(uid) {
      const payload = await keystore.loadKeys(uid);
      if (!payload) return null;
      const dataKey = await keystore.deviceKey(uid);
      return { dataKey };
    },

    async decryptRemote(name, payload, key) {
      const out: DecryptedSensitive = {};
      if (name === "students") {
        const map = new Map<string, DecryptedStudentFields>();
        if (Array.isArray(payload)) {
          for (const row of payload) {
            if (!isRecord(row) || typeof row.id !== "string") continue;
            const blob = row.sensitiveEnc;
            if (!isSensitiveEncryptedBlob(blob)) continue;
            try {
              map.set(row.id, sanitizeDecryptedStudentFields(await decryptJson(key, blob)));
            } catch {
              // Blob illeggibile: per questo alunno si tiene il valore locale.
            }
          }
        }
        if (map.size) out.students = map;
      } else if (isRecord(payload) && isSensitiveEncryptedBlob(payload.sensitiveEnc)) {
        try {
          const value = await decryptJson(key, payload.sensitiveEnc);
          const assigned = isRecord(value) && Array.isArray(value.assignedStudents)
            ? value.assignedStudents.filter(item => typeof item === "string")
            : null;
          out.profile = assigned !== null ? { assignedStudents: assigned } : null;
        } catch {
          out.profile = null;
        }
      }
      return out;
    },

    async attachOutgoing(name, base, { snapshot, remotePayload, key }) {
      if (name === "students") {
        if (!Array.isArray(base)) return base;
        const localById = new Map(snapshot.students.map(student => [student.id, student]));
        const remoteById = new Map<string, unknown>();
        if (Array.isArray(remotePayload)) {
          for (const row of remotePayload) {
            if (isRecord(row) && typeof row.id === "string") remoteById.set(row.id, row);
          }
        }
        const out: unknown[] = [];
        for (const row of base) {
          if (!isRecord(row) || typeof row.id !== "string") { out.push(row); continue; }
          const local = localById.get(row.id);
          const fields = pickSensitiveStudentFields(local);
          const hasLocal = Object.keys(fields).length > 0;
          const remoteRow = remoteById.get(row.id);
          const hadBlob =
            (isRecord(remoteRow) && isSensitiveEncryptedBlob(remoteRow.sensitiveEnc)) ||
            Boolean(local && isSensitiveEncryptedBlob(local.sensitiveEnc));
          const clean = stripSensitiveTransportStudent(row);
          // Nessuna informazione riservata (né ora, né prima): niente blob.
          if (!hasLocal && !hadBlob) { out.push(clean); continue; }
          out.push({ ...(clean as Record<string, unknown>), sensitiveEnc: await encryptJson(key, fields) });
        }
        return out;
      }
      if (!isRecord(base)) return base;
      const localProfile = snapshot.profile;
      const assigned = localProfile?.assignedStudents;
      const hasLocal = assigned !== undefined;
      const hadBlob =
        (isRecord(remotePayload) && isSensitiveEncryptedBlob(remotePayload.sensitiveEnc)) ||
        Boolean(localProfile && isSensitiveEncryptedBlob(localProfile.sensitiveEnc));
      const clean = stripSensitiveTransportProfile(base) as Record<string, unknown>;
      if (!hasLocal && !hadBlob) return clean;
      return { ...clean, sensitiveEnc: await encryptJson(key, { assignedStudents: assigned ?? [] }) };
    },
  };
}

/** Input non fidato: dal blob decifrato si tengono SOLO i campi dell'elenco unico. */
function sanitizeDecryptedStudentFields(value: unknown): DecryptedStudentFields {
  const out: DecryptedStudentFields = {};
  if (!isRecord(value)) return out;
  for (const field of SENSITIVE_STUDENT_FIELDS) {
    const entry = value[field];
    if (entry !== undefined) out[field] = entry;
  }
  return out;
}
