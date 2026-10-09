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
