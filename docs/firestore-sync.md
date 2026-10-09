# Sincronizzazione multi-dispositivo (Google account)

> Base architetturale implementata e testata (`tests/sync.test.ts`). Questo documento descrive
> anche i limiti volutamente lasciati aperti per la beta.

## Modello

L'app resta **local-first**: IndexedDB (Dexie, `src/services/db.ts`) è l'unico archivio che l'UI
legge e scrive. Il motore di sync (`src/services/sync/engine.ts`) è un *mirror* asincrono verso
Firestore, attivato solo quando:

1. l'utente è autenticato con Google (Firebase Auth già usata per il login — stesso `firebaseApp`);
2. il database locale è in modalità `indexeddb` (mai during legacy-readonly recovery);
3. l'opzione "Sincronizza automaticamente" non è disattivata (default: attiva).

L'avvio dell'app **non dipende mai** dalla rete o dal cloud: senza Firebase configurato,
senza rete o con il cloud irraggiungibile l'app funziona come sempre e l'engine riprova
con backoff esponenziale (30s → max 15min).

## Layout cloud

Tutto è radicato nell'uid Firebase — le regole (`firestore.rules`) autorizzano solo
`request.auth.uid == uid`.

```
users/{uid}/state/profile               { payload: TeacherProfile (senza assignedStudents), updatedAt, schemaVersion }
users/{uid}/state/settings              { timetableMode, onboardingCompleted }
users/{uid}/state/definitiveTimetable   { payload: TimetableSlot[] }
users/{uid}/state/provisionalTimetable
users/{uid}/state/students              { payload: Student[] (senza i dati riservati, vedi sotto) }
users/{uid}/events/{eventId}            { payload: CalendarEvent, updatedAt }
users/{uid}/circulars/{circularId}      { payload: CircularDocument, updatedAt }
users/{uid}/conflicts/{ts-random}       copia archiviata del perdente di un conflitto (mai persa)
```

Google Calendar **non** è l'archivio applicativo: resta destinato ai soli eventi di calendario.

## Riconciliazione (`src/services/sync/merge.ts`, pura e testata)

Stato locale dell'ultimo sync: riga `sync:state` nella tabella IndexedDB `metadata`
(`SyncStateV1`: hash dei contenuti per collezione + `updatedAt` remoti + timestamp dell'ultima
modifica locale rilevata). Per ogni collezione:

- cloud vuoto + dati locali → **caricamento iniziale**;
- dispositivo nuovo (installazione vuilla/mai toccata) + cloud pieno → **ripristino completo**;
- modificate solo locali → push; solo remote → pull;
- modificate su **entrambi** i lati → vince l'orologio più recente; la copia perdente viene prima
  **archiviata** in `users/{uid}/conflicts`; senza storia comune (mai sincronizzato, dati reali su
  entrambe le parti) **non si decide in automatico**: l'UI mostra "Mantieni dati di questo
  dispositivo" / "Usa i dati del cloud" (`SyncStatus.phase = 'awaiting-resolution'`);
- eventi/circolari si uniscono per id; una cancellazione si propaga solo se l'altro lato non ha
  toccato la riga dall'ultimo sync, altrimenti la riga modificata altrove "risorge" (mai persa);
- gli id usati dal flusso circolare sono stabili tra i dispositivi perché condivisi tramite cloud.

Anti-loop: ogni piano è hash-guardato (contenuto identico = nessun write) e un solo tab alla
volta sincronizza (`navigator.locks`, chiave `agenda-docente-cloud-sync`).

## Dati sensibili: NON escono mai dal dispositivo

Elenco unico, definito in `src/services/sensitiveData.ts` e usato da sync, servizi di
analisi e interfaccia. Sono **sempre locali** (IndexedDB) e restano modificabili qui:

- `Student`: `isSupportStudent`, `peiType`, `supportHoursPerWeek`, `hasBesDsa`,
  `pdpApproved`, `diagnosticSummary`, `specialists`, `gloDate`;
- `TeacherProfile`: `assignedStudents` (testo libero: può contenere sigle di alunni, ore
  e tipo di PEI).

Restano sincronizzati: nome, classe, scuola, anno, stato, contatti dei genitori, diario
note dell'alunno e tutto il resto del profilo docente.

### Uscita (una sola funzione: `stripSensitiveStatePayload` / `stripSensitiveConflictArchive`)

Il punto di passaggio obbligato per i payload locali è `statePayload()` in
`src/services/sync/merge.ts` (usato anche per gli hash di confronto, quindi una modifica
ai SOLI dati sensibili non genera alcuna sincronizzazione). La stessa ripulitura è
riapplicata nel gateway Firestore, così nessun percorso di scrittura può aggirarla:

1. **documenti di stato** — `gateway.writeState(name, payload)` su
   `users/{uid}/state/{profile|students}`: caricamento iniziale, push per modifica
   locale, push forzato dopo la scelta «mantieni i dati di questo dispositivo»,
   riscrittura di riparazione di un documento legacy/invalido, riscrittura di pulizia;
2. **scritture in blocco** — `gateway.writeItems(coll, entries)` su `events`,
   `circulars`, `assessments`, `scheduledAssessments` (per id; nessuna di queste
   collezioni contiene campi riservati: la verifica è nel test dedicato);
3. **archivi dei conflitti** — `gateway.archiveConflict(kind, loser)` su
   `users/{uid}/conflicts`, per i kind `state:<name>`, `legacy-state:<name>` (documento
   grezzo, doppio wrapper compreso), `item:<coll>:<id>` e `invalid-item:<coll>:<id>`;
4. **endpoint di analisi** — `analyzeCircular` (`/api/analyze-circular`),
   `analyzeTimetableDocument` (`/api/analyze-timetable`) e `analyzeStudentDocument`
   (`/api/analyze-student-document`): il profilo parte senza `assignedStudents`
   (`withoutSensitiveProfile`). Il server continua ad accettare il campo come opzionale:
   nessuna modifica lato server.

`deleteItems` non scrive dati (solo id) e `listConflicts` è una lettura.

### Ingresso (`mergeRemoteStateWithLocalSensitive`)

Ogni payload remoto che sostituisce o si unisce ai dati locali — ripristino completo
(`buildFullRestore`), aggiornamento del singolo documento (`localApplyState`) — passa
dalla stessa funzione:

- per ogni alunno con lo stesso `id` valgono i campi riservati **locali**;
- i campi riservati presenti nel cloud (documenti scritti da versioni precedenti) sono
  **ignorati**, mai applicati;
- un alunno che esiste solo nel cloud arriva **senza** campi riservati.

### Pulizia dei dati già caricati (una sola volta per account)

Al primo ciclo utile dopo l'aggiornamento, `students` e `profile` nel cloud vengono
riscritti puliti **anche se null'altro è cambiato**: la scrittura usa `setDoc` senza
merge, quindi sostituisce l'intero documento (non è un merge parziale). L'indicatore
locale `sync:sensitive-cleanup` (tabella `metadata`, per uid) evita di ripeterla a ogni
ciclo; se il documento è in attesa di una scelta dell'utente la riscrittura resta in
sospeso invece di decidere al suo posto.

Gli archivi `users/{uid}/conflicts` NON si toccano: le regole Firestore li rendono
immutabili. Se ne conta soltanto, senza contenuti, quanti custodiscono ancora dati
riservati (`countSensitiveArchives`): una riga di log con il solo numero
(es. `Archivi conflitti con dati riservati: 3 (alunni: 2, profilo: 1)`), una volta per
account, se le regole ne consentono la lettura.

### Interfaccia e backup

La scheda alunno (`ClassesView`) mostra, accanto ai campi riservati, la riga
«Dati riservati: salvati solo su questo dispositivo, non sincronizzati.» Nessun
interruttore: la regola non è opzionale.

Il **backup locale resta completo**, dati riservati inclusi: serve al ripristino e non
esce dal dispositivo.

## Validazione runtime e riparazione dei documenti legacy (`src/services/sync/remoteSchema.ts`)

I documenti Firestore sono **input non fidato**: un cast TypeScript (`data() as RemoteStateDoc`)
non è una validazione. Una versione precedente dell'app ha scritto documenti `state/*` con una
forma incompatibile — quella osservata davvero in produzione (2026-09-09):

```
users/{uid}/state/provisionalTimetable = {
  payload: { schemaVersion: 1, updatedAt: "2026-09-09T17:47:36.312Z" },   // nessun orario!
  updatedAt: "...",
  schemaVersion: 1,
}
```

Ogni documento remoto viene quindi classificato a runtime (mai con un cast), con validazione
**semantica per tipo** (payload = array di `TimetableSlot` validi per gli orari — inclusi i
nuovi campi di compresenza —, profilo plausibile, impostazioni coerenti, array per gli alunni):

- **valido** — formato attuale `{ payload, updatedAt, schemaVersion: 1 }` con payload valido;
- **legacy recuperabile** — wrapper malformato (schemaVersion/updatedAt mancanti, doppio
  wrapping, documento-payload diretto) ma con payload reale estraibile e valido: entra nel
  merge normalmente e il documento cloud viene **riscritto nel formato attuale** anche se il
  contenuto non cambia (timestamp mancanti → epoca, così non vincono mai un LWW);
- **invalido/irrecuperabile** — payload inutilizzabile (incluso il "payload di soli metadati"
  sopra, che NON è un orario: un orario vuoto è `[]`): viene trattato come **assente**.

Per un documento invalido: mai applicato in locale, mai vincente nei conflitti, mai sovrascritto
dai dati inventati. L'originale viene conservato in `users/{uid}/conflicts` con kind
`legacy-state:<name>` (una sola volta per dispositivo, per hash in `archivedLegacyHash`); se il
locale ha dati validi il documento remoto viene riscritto nel formato corretto; se anche il
locale è vuoto la sezione viene **segnalata** in `SyncStatus.notices` senza inventare nulla.
I test di regressione del caso reale sono in `tests/legacy-firestore-repair.test.ts`.

## Diagnostica utente

La card di sincronizzazione (`CloudSyncCard`) mostra: ultima sincronizzazione riuscita, stato
(sincronizzato / in corso / offline / errore / conflitto / disattivata), pulsante
"Sincronizza ora", messaggi d'errore comprensibili e — senza mai esporre token o contenuti dei
documenti — ultimo tentativo, sezioni sincronizzate nell'ultimo ciclo e note di riparazione
legacy. Un minimo di diagnostica (timestamp di successo, sezioni, note) persiste in IndexedDB
(`sync:diagnostics`) per sopravvivere al riavvio.

## Logout

La disconnessione Google ferma solo la sessione di sync (`stopSession`): **nessun dato locale
viene toccato**. Il riavvio del mirror richiede ri-autenticazione.

## Deploy / abilitazione (passo operativo esterno, NON automatico al merge)

**Il merge di questo codice non rende operativa la sincronizzazione.** Dopo il merge, nel
progetto Firebase `agenda-docente-3d33e` occorre:

1. **creare/abilitare Cloud Firestore** nella console Firebase del progetto, se non esiste già;
2. **scegliere la region** (consigliata `europe-west` per dati scolastici italiani; la scelta è
   irreversibile per il database, valutare `nam5`/`eur3` solo se già usati da altri prodotti);
3. **distribuire le regole**: `firebase deploy --only firestore:rules` dal repo (usa
   `firestore.rules`, che limita tutto a `users/{uid}/...`);
4. **mantenere Firebase Auth con provider Google** abilitato (è già la sessione usata dal
   login: la sincronizzazione riusa la stessa `firebaseApp`, non serve un secondo progetto);
5. **nessuna nuova variabile `VITE_*`** è necessaria salvo effettiva necessità tecnica: la
   configurazione pubblica Firebase (`VITE_FIREBASE_*`) è già quella del login e non contiene
   secret. Solo se in futuro si usasse un progetto separato per il sync andrebbero aggiunti
   endpoint dedicati (valutandolo esplicitamente).

Indici Firestore: non necessari (solo letture puntuali per path sotto l'uid).

### Se Firestore NON è configurato o non è raggiungibile

- l'app resta **local-first**: IndexedDB funziona normalmente;
- il **login Google continua a funzionare** (Auth è indipendente dal sync);
- Google Calendar, Gemini/Render, backup/import ed export restano invariati;
- **la sincronizzazione Mac ↔ iPhone NON funziona**: l'engine resta in fase `disabled`/retry
  senza mai bloccare l'UI e senza toccare i dati locali.

## Note aggiuntive

## Gap noti e scelte documentate (per la beta)

- **LWW si basa sugli orologi dei client**: clock skew > ~minuti può invertire un vincitore; la
  copia perdente è comunque archiviata, quindi recuperabile manualmente.
- **Conflitti per singolo evento/circolare** risolvono "dispositivo attivo vince + archivia";
  nessuna UI di *merge* per riga (solo per gli stati documento). Gli archivi `conflicts/` sono
  consultabili solo dal cloud console — UI di recupero non implementata.
- **Delete di intere collezioni**: svuotare gli eventi sul cloud da un dispositivo li rimuove
  dagli altri (comportamento atteso); non esiste "primo sync: scarica ignoring locale" esplicito
  oltre alla scelta `Usa i dati del cloud`.
- Firestore SDK gira in modalità memoria: le modifiche non confermate **non** vengono accodate
  offline dal SDK; è l'engine che riprova (push locale immediato e garantito, cloud differito).
- Nessun realtime `onSnapshot` (pull su: avvio, focus tab, `online`, commit locali): più
  semplice, niente loop, convergenza comunque < 2s dal focus della pagina.
- Documenti > ~900 KB vengono rifiutati e restano solo locali (backup JSON resta l'export completo).
- **Trigger del sync dopo un commit IndexedDB**: oltre al `liveQuery` Dexie (cross-tab),
  `AgendaDatabase.onCommit` notifica esplicitamente ogni transazione applicativa commit-ta
  (vedi `src/services/db.ts` e `tests/sync-trigger.test.ts`): il percorso
  `storage.saveTimetableSlot → commit → observeLocalCommits → scheduleSync → engine →
  gateway.writeState` è coperto da test end-to-end senza chiamate artificiali a `syncNow`.
  Le scritture bookkeeping del sync stesso (righe `metadata`) non passano da `atomic()` e non
  generano notifiche esplicite; i piani hash-guardati impediscono i ping-pong.
