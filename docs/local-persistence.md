# Audit e migrazione della persistenza locale

Base: 5e76ecf9f7906f5b7e4f691159598af0ee74e6bf, branch fix/priority-data-correctness.

## Audit prima delle modifiche

`storage.ts` era sincrono. `App.tsx` leggeva nel render e negli inizializzatori React e scriveva dagli handler; `ProfileModal.tsx` chiamava export/import. Nessun componente leggeva direttamente localStorage. OAuth conserva i token soltanto in memoria e non viene migrato.

| Chiave legacy | Contenuto | Destinazione IndexedDB |
| --- | --- | --- |
| agedoc_teacher_profile_v2 | Profilo, preferenze docente e riferimento account | profile |
| agedoc_events_v2 | Eventi, completamento, consenso Google e ID collegati | events |
| agedoc_circulars_v2 | Archivio, testo originale, elementi estratti e relativi ID | circulars |
| agedoc_students_v2 | Studenti, contatti, note e informazioni didattiche | students |
| agedoc_timetable_v2 | Orario definitivo | definitiveTimetable |
| agedoc_timetable_provvisorio_v2 | Orario provvisorio | provisionalTimetable |
| agedoc_timetable_mode_v2 | Modalità attiva | metadata |
| agedoc_onboarding_completed_v2 | Stato configurazione | metadata |
| agedoc_restore_journal_v1 | Rollback di un precedente restore interrotto | Recuperato prima della migrazione |

Le note restano annidate nello studente e gli estratti nella circolare: si mantengono le relazioni attuali. Ogni entità è un record separato, con posizione esplicita per conservare l'ordine. Non si cambiano dati demo, OAuth, API circolari o service worker.

## Strategia implementata

Dexie 4, schema IndexedDB versione 1. L'avvio attende la migrazione e una lettura completa prima di montare `App`: nessun getter sincrono o cache che simuli un database sincrono. Le viste ricevono lo stato React caricato; i salvataggi attendono il commit. I moduli conservano la bozza se il salvataggio fallisce.

La prima apertura usa una transazione su tutti gli store. Se esiste il flag `metadata/migration=1`, IndexedDB è autorevole e localStorage non viene letto. Anche un database già popolato, completo e valido, senza flag viene adottato senza importare dati più vecchi. Uno stato parziale non viene riempito con demo.

Solo con database vuoto si recupera l'eventuale journal del vecchio restore, si rilevano le chiavi legacy, si valida l'intero snapshot con il validatore v3 e si copia. Il contenuto riletto viene confrontato con lo snapshot prima di scrivere il flag, nella stessa transazione. Abort, quota o refresh annullano tutte le scritture, compreso il flag. I collegamenti legacy alle circolari vengono ricostruiti solo quando la corrispondenza è esatta e univoca, come già previsto dal progetto.

Le chiavi originali non vengono cancellate né aggiornate dopo la migrazione: sono una copia storica, non una seconda persistenza attiva. Un journal preesistente viene invece completato con il rollback già previsto dalla versione precedente. Non si fanno scritture doppie tra due database privi di transazione comune.

In presenza di dati legacy, collezioni assenti diventano vuote; profilo o contenuto malformato fermano la migrazione. I demo si usano solo quando non c'è alcun dato IndexedDB o chiave `agedoc_*`. Non si correggono silenziosamente anni scolastici, intervalli o altri dati utente.

Se l'apertura/migrazione fallisce e la copia legacy è valida, è consultabile ed esportabile in sola lettura, con avviso esplicito che potrebbe essere vecchia. Nessuna modifica della copia viene riversata automaticamente nel DB. Se anche il legacy è corrotto, la schermata di recupero permette di scaricare le stringhe originali delle chiavi senza interpretarle. Questo file di recupero non è un backup v3: richiede verifica/riparazione prima dell'import. Una lettura che fallisce durante l'uso segnala l'errore e non restituisce demo.

## Transazioni e backup

Le operazioni di lettura-modifica-scrittura sono transazionali, comprese note concorrenti, collegamenti circolare/eventi, onboarding e importazione di circolare con eventi. L'export legge uno snapshot coerente da IndexedDB; il restore valida prima di scrivere e sostituisce tutte le collezioni in un'unica transazione. Il formato esportato resta v3: nessun v4 necessario. I v2 restano importabili e conservano orario provvisorio, modalità e onboarding già presenti, poiché il vecchio formato non li conteneva.

La sincronizzazione Google conserva le regole e le chiamate precedenti. L'unico adattamento del servizio riguarda l'attesa dei callback di persistenza ora asincroni; la modalità di recupero in sola lettura sospende la sincronizzazione. Nessuna modifica a OAuth, API Gemini o PWA.

## Verifiche e limiti

Test Node con fake-indexeddb: migrazione completa, idempotenza, connessioni concorrenti, abort prima del flag, quota, errore lettura, dati vecchi, relazioni, note, orari, metadati, v2/v3, restore atomico e rete indisponibile. Conservata la copertura precedente. Prova browser: creazione di evento dall'interfaccia e presenza dopo reload.

La copia legacy è intenzionalmente congelata: un ritorno alla vecchia versione dell'app non mostrerebbe le ultime modifiche IndexedDB. Esportare un backup v3 prima di un rollback. La modalità di recupero richiede riapertura/ricaricamento per ritentare la migrazione. I dati legacy non validi richiedono una riparazione esplicita; non vengono scartati per forzare il passaggio.

Le transazioni serializzano le modifiche, ma le viste di altre schede non si aggiornano automaticamente: occorre ricaricarle. Modifiche simultanee allo stesso record da moduli già aperti seguono l'ultimo salvataggio; non è stato introdotto un sistema di conflitti. Per conservare l'interfaccia logica, alcuni aggiornamenti riscrivono la collezione interessata, in record separati e dentro una transazione; indici aggiuntivi e aggiornamenti più granulari potranno essere ottimizzati con archivi molto grandi.

IndexedDB resta soggetto alle quote e alla cancellazione dei dati del browser. Non sostituisce un backup esterno. Nessun database cloud o invio di dati è richiesto dalle operazioni locali. Il bundle continua a generare l'avviso Vite oltre 500 kB; l'aggiunta di Dexie ne aumenta la dimensione.

Esito finale: 94 test superati; `npm run lint` e `npm run build` riusciti. Il controllo automatico finale ha confermato che le dichiarazioni dei dati demo sono identiche al commit di partenza. Dipendenze aggiunte: Dexie 4.4.5 e fake-indexeddb 6.2.5 (solo sviluppo). Lockfile npm aggiunto e lockfile Bun aggiornato.
