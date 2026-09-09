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
users/{uid}/state/profile               { payload: TeacherProfile, updatedAt, schemaVersion }
users/{uid}/state/settings              { timetableMode, onboardingCompleted }
users/{uid}/state/definitiveTimetable   { payload: TimetableSlot[] }
users/{uid}/state/provisionalTimetable
users/{uid}/state/students              { payload: Student[] }
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

## Logout

La disconnessione Google ferma solo la sessione di sync (`stopSession`): **nessun dato locale
viene toccato**. Il riavvio del mirror richiede ri-autenticazione.

## Deploy / abilitazione (passo operativo esterno, non eseguibile da questo repo CI)

1. `firebase deploy --only firestore:rules` con `firestore.rules` di questo repo.
2. Indici: non necessari (solo letture per path document/collection sotto l'uid).
3. La configurazione pubblica Firebase è quella già usata per l'auth (`VITE_FIREBASE_*`);
   nessuna secret: **le rules sono il perimetro**.

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
