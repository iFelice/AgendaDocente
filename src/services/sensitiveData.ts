/**
 * DATI SENSIBILI — UN SOLO ELENCO, USATO OVUNQUE.
 *
 * Regola unica dell'app: i dati sotto elencati NON escono MAI dal dispositivo.
 * Restano in IndexedDB (dove l'utente li legge e li modifica) ed entrano nel
 * backup locale, che serve al ripristino; vengono invece rimossi da ogni
 * scrittura verso il cloud (documenti di stato, scritture in blocco, archivi
 * dei conflitti) e da ogni richiesta agli endpoint di analisi.
 *
 * Sono ignorati anche in ingresso: se un documento remoto vecchio li contiene
 * ancora, non vengono MAI applicati in locale (per ogni alunno vale sempre la
 * copia locale, individuata per `id`).
 *
 * Restano invece sincronizzati: nome, classe, scuola, anno, stato, contatti dei
 * genitori, diario note dell'alunno; tutto il profilo docente tranne
 * `assignedStudents`.
 *
 * Le regole Firestore NON cambiano: la privacy è garantita dal client, che è
 * l'unico scrittore di questi documenti.
 */

import type { Student, TeacherProfile } from "../types";
import type { RemoteConflictArchive, StateDocName, SyncedStateDocName } from "./sync/types";
import { isSensitiveEncryptedBlob } from "./sensitiveCrypto";

export type { RemoteConflictArchive };

/** Campi riservati di `Student` (src/types.ts): sostegno, PEI, BES/DSA, équipe. */
export const SENSITIVE_STUDENT_FIELDS = [
  "isSupportStudent",
  "peiType",
  "supportHoursPerWeek",
  "hasBesDsa",
  "pdpApproved",
  "diagnosticSummary",
  "specialists",
  "gloDate",
] as const;

export type SensitiveStudentField = (typeof SENSITIVE_STUDENT_FIELDS)[number];

/**
 * Campi riservati del profilo docente: `assignedStudents` è testo libero e può
 * contenere sigle di alunni, ore e tipo di PEI.
 */
export const SENSITIVE_PROFILE_FIELDS = ["assignedStudents"] as const;

export type SensitiveProfileField = (typeof SENSITIVE_PROFILE_FIELDS)[number];

/** Documenti di stato che possono contenere dati sensibili (pulizia cloud una volta per account). */
export const SENSITIVE_STATE_DOCS: readonly StateDocName[] = ["students", "profile"];

/** Riga mostrata nella scheda alunno accanto ai campi riservati. */
export const LOCAL_ONLY_SENSITIVE_NOTICE =
  "Dati riservati: salvati solo su questo dispositivo, non sincronizzati.";

/** Riga mostrata quando esistono dati riservati cifrati ma il dispositivo non è sbloccato. */
export const LOCKED_SENSITIVE_NOTICE = "Dati riservati cifrati: sblocca per vederli.";

const STUDENT_KEYS: ReadonlySet<string> = new Set<string>(SENSITIVE_STUDENT_FIELDS);
const PROFILE_KEYS: ReadonlySet<string> = new Set<string>(SENSITIVE_PROFILE_FIELDS);

/**
 * Campi "di trasporto" della cifratura: i campi riservati in chiaro PIÙ il
 * blob cifrato `sensitiveEnc`. È la forma usata per il payload base e per gli
 * hash di contenuto: il blob viaggia solo agganciato all'ultimo passo
 * (in uscita), così il suo IV sempre nuovo non fa mai sembrare "modificato"
 * un contenuto che non lo è.
 */
const STUDENT_TRANSPORT_KEYS: ReadonlySet<string> = new Set<string>([...SENSITIVE_STUDENT_FIELDS, "sensitiveEnc"]);
const PROFILE_TRANSPORT_KEYS: ReadonlySet<string> = new Set<string>([...SENSITIVE_PROFILE_FIELDS, "sensitiveEnc"]);

/** Valori decifrati dei campi riservati di un alunno (input non fidato: solo campi dell'elenco unico). */
export type DecryptedStudentFields = Partial<Record<SensitiveStudentField, unknown>>;

/** Esito della decifratura dei blob di un documento remoto, per il merge in ingresso. */
export interface DecryptedSensitive {
  /** id alunno -> campi riservati decifrati (assente = blob mancante o non decifrabile). */
  students?: Map<string, DecryptedStudentFields>;
  /** `assignedStudents` del profilo decifrata (null = assente o non decifrabile; [] = svuotata altrove). */
  profile?: { assignedStudents: string[] } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function omitKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (!keys.has(key)) clean[key] = entry;
  return clean;
}

// ---------------------------------------------------------------------------
// USCITA — rimozione prima di ogni scrittura remota / richiesta di analisi
// ---------------------------------------------------------------------------

/**
 * Copia di un alunno senza i campi sensibili E senza il blob cifrato (che non
 * serve a nulla fuori dalla sincronizzazione). Non muta l'originale.
 */
export function withoutSensitiveStudent<T extends Student>(student: T): T {
  if (!isRecord(student)) return student;
  return omitKeys(student as Record<string, unknown>, STUDENT_TRANSPORT_KEYS) as T;
}

/** Copia del profilo docente senza `assignedStudents` e senza blob. Non muta l'originale. */
export function withoutSensitiveProfile<T extends TeacherProfile>(profile: T): T {
  if (!isRecord(profile)) return profile;
  return omitKeys(profile as Record<string, unknown>, PROFILE_TRANSPORT_KEYS) as T;
}

/** Versione "input non fidato": stesso elenco, ma accetta e restituisce `unknown`. */
export function stripSensitiveStudentFields(student: unknown): unknown {
  if (!isRecord(student)) return student;
  return omitKeys(student, STUDENT_KEYS);
}

/** Versione "input non fidato" per il profilo. */
export function stripSensitiveProfileFields(profile: unknown): unknown {
  if (!isRecord(profile)) return profile;
  return omitKeys(profile, PROFILE_KEYS);
}

/**
 * Payload BASE di un alunno: senza campi riservati E senza il blob cifrato.
 * È la forma usata per gli hash di contenuto: il blob (IV sempre nuovo) viene
 * agganciato solo all'ultimo passo dell'uscita.
 */
export function stripSensitiveTransportStudent(student: unknown): unknown {
  if (!isRecord(student)) return student;
  return omitKeys(student, STUDENT_TRANSPORT_KEYS);
}

/** Payload base del profilo: senza `assignedStudents` e senza blob. */
export function stripSensitiveTransportProfile(profile: unknown): unknown {
  if (!isRecord(profile)) return profile;
  return omitKeys(profile, PROFILE_TRANSPORT_KEYS);
}

/** Payload base di un documento di stato (solo `students` e `profile` hanno dati riservati). */
export function stripSensitiveTransportPayload(name: SyncedStateDocName, payload: unknown): unknown {
  if (name === "students") {
    if (!Array.isArray(payload)) return payload;
    return payload.map(stripSensitiveTransportStudent);
  }
  if (name === "profile") return stripSensitiveTransportProfile(payload);
  return payload;
}

/** I soli campi riservati compilati di un alunno: è ciò che finisce nel blob cifrato. */
export function pickSensitiveStudentFields(student: unknown): DecryptedStudentFields {
  if (!isRecord(student)) return {};
  const picked: DecryptedStudentFields = {};
  for (const field of SENSITIVE_STUDENT_FIELDS) {
    const value = student[field];
    if (value !== undefined) picked[field] = value;
  }
  return picked;
}

/** Vero se l'alunno porta un blob cifrato (dati riservati protetti nel cloud). */
export function hasEncryptedSensitiveBlob(row: unknown): boolean {
  return isRecord(row) && isSensitiveEncryptedBlob(row.sensitiveEnc);
}

/**
 * L'UNICA funzione di uscita per i documenti di stato: rimuove i dati sensibili
 * dal payload locale di `students` e `profile` prima che diventi una scrittura
 * remota (documento di stato, riscrittura di riparazione, archivio conflitti).
 * Gli altri documenti (orari, impostazioni) non ne contengono e passano invariati.
 */
export function stripSensitiveStatePayload(name: SyncedStateDocName, payload: unknown): unknown {
  if (name === "students") {
    if (!Array.isArray(payload)) return payload;
    return payload.map(stripSensitiveStudentFields);
  }
  if (name === "profile") return stripSensitiveProfileFields(payload);
  return payload;
}

/**
 * Archivio dei conflitti: il `loser` di un documento `legacy-state:<name>` è il
 * documento grezzo ({ payload, updatedAt, schemaVersion }), non il payload. In
 * caso di doppio wrapper il payload è a sua volta un documento: si scende finché
 * non si trova il contenuto reale, così nessun livello sfugge alla ripulitura.
 */
export function stripSensitiveLegacyDoc(name: SyncedStateDocName, raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "payload") { clean[key] = value; continue; }
    // Un payload che è a sua volta un documento (doppio wrapper) si ripulisce
    // scendendo di un livello; altrimenti è il contenuto reale (array di alunni
    // o oggetto profilo, che non ha chiavi "payload").
    clean[key] = isRecord(value) && "payload" in value
      ? stripSensitiveLegacyDoc(name, value)
      : stripSensitiveStatePayload(name, value);
  }
  return clean;
}

// ---------------------------------------------------------------------------
// INGRESSO — i dati locali vincono sempre; quelli remoti sono ignorati
// ---------------------------------------------------------------------------

/**
 * Ricompone un alunno ricevuto dal cloud, con tre comportamenti:
 *  1. dispositivo SBLOCCATO e blob decifrato (`decrypted`): i valori del cloud
 *     si applicano con la stessa regola di precedenza del resto della scheda
 *     (qui il remoto ha vinto) e il blob non viene conservato in locale;
 *  2. senza chiave o decifratura fallita: i campi sensibili locali restano
 *     come oggi e il blob cifrato NON viene scartato (segnala i dati protetti
 *     e sopravvive a una riscrittura);
 *  3. i campi sensibili in chiaro eventualmente ancora nel cloud (documenti
 *     precedenti alla cifratura) sono sempre ignorati.
 */
export function mergeLocalSensitiveStudent(
  remoteStudent: unknown,
  localStudent: Student | undefined,
  decrypted?: DecryptedStudentFields | null,
): unknown {
  if (!isRecord(remoteStudent)) return remoteStudent;
  const clean = omitKeys(remoteStudent, STUDENT_TRANSPORT_KEYS) as Record<string, unknown>;
  const blob = isSensitiveEncryptedBlob(remoteStudent.sensitiveEnc) ? remoteStudent.sensitiveEnc : undefined;
  if (decrypted) {
    for (const field of SENSITIVE_STUDENT_FIELDS) {
      const value = decrypted[field];
      if (value !== undefined) clean[field] = value;
    }
    return clean;
  }
  if (localStudent) {
    for (const field of SENSITIVE_STUDENT_FIELDS) {
      const value = localStudent[field];
      if (value !== undefined) clean[field] = value;
    }
  }
  if (blob) clean.sensitiveEnc = blob;
  return clean;
}

/** Come sopra, per l'intero elenco alunni: l'aggancio è l'`id`. */
export function mergeLocalSensitiveStudents(
  remoteStudents: unknown,
  localStudents: Student[],
  decrypted?: Map<string, DecryptedStudentFields>,
): unknown {
  if (!Array.isArray(remoteStudents)) return remoteStudents;
  const byId = new Map(localStudents.map(student => [student.id, student]));
  return remoteStudents.map(row => {
    if (!isRecord(row)) return row;
    const id = typeof row.id === "string" ? row.id : "";
    return mergeLocalSensitiveStudent(row, byId.get(id), decrypted?.get(id) ?? null);
  });
}

/**
 * Profilo: con i valori decifrati si applica la precedenza del remoto; senza
 * chiave `assignedStudents` resta quella locale e il blob non viene scartato.
 */
export function mergeLocalSensitiveProfile(
  remoteProfile: unknown,
  localProfile?: TeacherProfile,
  decrypted?: { assignedStudents: string[] } | null,
): unknown {
  if (!isRecord(remoteProfile)) return remoteProfile;
  const clean = omitKeys(remoteProfile, PROFILE_TRANSPORT_KEYS) as Record<string, unknown>;
  const blob = isSensitiveEncryptedBlob(remoteProfile.sensitiveEnc) ? remoteProfile.sensitiveEnc : undefined;
  if (decrypted) {
    clean.assignedStudents = decrypted.assignedStudents ?? [];
    return clean;
  }
  if (localProfile?.assignedStudents !== undefined) clean.assignedStudents = localProfile.assignedStudents;
  if (blob) clean.sensitiveEnc = blob;
  return clean;
}

/**
 * L'UNICA funzione di ingresso: applicata a ogni payload remoto che va a
 * sostituire o unirsi ai dati locali (ripristino completo o aggiornamento di un
 * singolo documento di stato). `decrypted` porta i blob già decifrati dal
 * motore (dispositivo sbloccato); senza chiave è omesso.
 */
export function mergeRemoteStateWithLocalSensitive(
  name: SyncedStateDocName,
  remotePayload: unknown,
  local: { students: Student[]; profile?: TeacherProfile },
  decrypted?: DecryptedSensitive,
): unknown {
  if (name === "students") return mergeLocalSensitiveStudents(remotePayload, local.students ?? [], decrypted?.students);
  if (name === "profile") return mergeLocalSensitiveProfile(remotePayload, local.profile, decrypted?.profile);
  return remotePayload;
}

// ---------------------------------------------------------------------------
// USCITA da dispositivo SENZA chiave: i blob del cloud tornano invariati
// ---------------------------------------------------------------------------

/**
 * Un dispositivo senza chiave non cifra, ma non deve mai cancellare i dati
 * cifrati scritti da un altro dispositivo: per ogni alunno il blob presente
 * nel cloud (o, in subordine, quello già noto in locale) viene riportato
 * invariato nella scrittura.
 */
export function preserveSensitiveEncStudents(baseRows: unknown, remotePayload: unknown, localStudents: Student[]): unknown {
  if (!Array.isArray(baseRows)) return baseRows;
  const remoteById = new Map<string, unknown>();
  if (Array.isArray(remotePayload)) {
    for (const row of remotePayload) {
      if (isRecord(row) && typeof row.id === "string") remoteById.set(row.id, row);
    }
  }
  const localById = new Map(localStudents.map(student => [student.id, student]));
  return baseRows.map(row => {
    if (!isRecord(row) || typeof row.id !== "string") return row;
    const remoteRow = remoteById.get(row.id);
    const blob = (isRecord(remoteRow) && isSensitiveEncryptedBlob(remoteRow.sensitiveEnc) ? remoteRow.sensitiveEnc : undefined)
      ?? (localById.get(row.id)?.sensitiveEnc && isSensitiveEncryptedBlob(localById.get(row.id)!.sensitiveEnc) ? localById.get(row.id)!.sensitiveEnc : undefined);
    if (!blob) return stripSensitiveTransportStudent(row);
    return { ...(stripSensitiveTransportStudent(row) as Record<string, unknown>), sensitiveEnc: blob };
  });
}

/** Profilo senza chiave: il blob del cloud (o locale) torna invariato. */
export function preserveSensitiveEncProfile(baseProfile: unknown, remotePayload: unknown, localProfile?: TeacherProfile): unknown {
  if (!isRecord(baseProfile)) return baseProfile;
  const blob = (isRecord(remotePayload) && isSensitiveEncryptedBlob(remotePayload.sensitiveEnc) ? remotePayload.sensitiveEnc : undefined)
    ?? (localProfile?.sensitiveEnc && isSensitiveEncryptedBlob(localProfile.sensitiveEnc) ? localProfile.sensitiveEnc : undefined);
  const clean = stripSensitiveTransportProfile(baseProfile) as Record<string, unknown>;
  if (blob) clean.sensitiveEnc = blob;
  return clean;
}

/** Variante per documento di stato (solo `students` e `profile`). */
export function preserveSensitiveEncPayload(
  name: SyncedStateDocName,
  base: unknown,
  remotePayload: unknown,
  local: { students: Student[]; profile?: TeacherProfile },
): unknown {
  if (name === "students") return preserveSensitiveEncStudents(base, remotePayload, local.students ?? []);
  if (name === "profile") return preserveSensitiveEncProfile(base, remotePayload, local.profile);
  return base;
}

// ---------------------------------------------------------------------------
// Rilevazione (interfaccia e conteggio archivi): mai contenuti, solo presenza
// ---------------------------------------------------------------------------

/** Vero se l'alunno ha almeno un campo sensibile compilato. */
export function hasSensitiveStudentData(student: unknown): boolean {
  if (!isRecord(student)) return false;
  return SENSITIVE_STUDENT_FIELDS.some(field => student[field] !== undefined);
}

/** Vero se il profilo ha `assignedStudents` compilato. */
export function hasSensitiveProfileData(profile: unknown): boolean {
  return isRecord(profile) && profile.assignedStudents !== undefined;
}

/** Vero se il payload remoto di un documento contiene ancora dati sensibili. */
export function hasSensitiveStatePayload(name: SyncedStateDocName, payload: unknown): boolean {
  if (name === "students") return Array.isArray(payload) && payload.some(hasSensitiveStudentData);
  if (name === "profile") return hasSensitiveProfileData(payload);
  return false;
}

export interface SensitiveArchiveCount {
  total: number;
  students: number;
  profile: number;
}

/**
 * USCITA verso un archivio conflitti: il `loser` viene ripulito in base al
 * kind (`state:<name>` = payload nudo, `legacy-state:<name>` = documento grezzo).
 * È la stessa funzione usata dal piano di merge e dal gateway Firestore.
 */
export function stripSensitiveConflictArchive(kind: string, loser: unknown): unknown {
  const { name } = classifyConflictArchive({ id: "", kind, payload: loser });
  if (!name) return loser;
  return kind.startsWith("legacy-state:") ? stripSensitiveLegacyDoc(name, loser) : stripSensitiveStatePayload(name, loser);
}

/**
 * Archivio conflitti -> (nome documento, payload da ispezionare). Gli archivi
 * legacy custodiscono il documento grezzo, gli altri il payload nudo.
 */
export function classifyConflictArchive(archive: RemoteConflictArchive): { name: StateDocName | null; payload: unknown } {
  const legacy = /^legacy-state:(.+)$/.exec(archive.kind);
  if (legacy) {
    const name = legacy[1] as StateDocName;
    const raw = archive.payload;
    return { name, payload: isRecord(raw) && "payload" in raw ? raw.payload : undefined };
  }
  const state = /^state:(.+)$/.exec(archive.kind);
  if (state) return { name: state[1] as StateDocName, payload: archive.payload };
  return { name: null, payload: undefined };
}

/**
 * Conta gli archivi conflitti che contengono ancora dati sensibili. NON tocca
 * nulla: le regole Firestore rendono `users/{uid}/conflicts` immutabili, quindi
 * degli archivi già scritti si può solo riportare il numero, senza contenuti.
 */
export function countSensitiveArchives(archives: RemoteConflictArchive[]): SensitiveArchiveCount {
  const count: SensitiveArchiveCount = { total: 0, students: 0, profile: 0 };
  for (const archive of archives) {
    const { name, payload } = classifyConflictArchive(archive);
    if (!name || !hasSensitiveStatePayload(name, payload)) continue;
    count.total++;
    if (name === "students") count.students++;
    if (name === "profile") count.profile++;
  }
  return count;
}
