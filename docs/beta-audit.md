# Audit beta offline

Base: `4f19e244c953c14ee91d044c9117ec6cac05b8b9`, branch `fix/priority-data-correctness`.
Nessuna modifica a schema, dati demo, endpoint Gemini o configurazione PWA.

## Flussi e copertura

| Flusso | Verifica ed esito |
| --- | --- |
| Primo avvio/onboarding | Revisione del gate di inizializzazione, test migrazione/seed/commit onboarding; primo avvio e chiusura wizard provati nel browser. Stato osservato senza riaprire il wizard a ogni scrittura. |
| Creazione/modifica/eliminazione evento | Test persistenza, conflitti, bozza e fallimento eliminazione; creazione all-day e reload nel browser. I dialoghi attendono la scrittura prima di chiudersi. |
| All-day | Test export e date esclusive preesistenti conservati; evento all-day creato e visto nella seconda scheda senza reload. |
| Orario provvisorio/definitivo | Test persistenza, intervalli e conflitti su entrambe le tabelle. Revisione editor e cambio modalità. |
| Circolare testuale | Analisi e conferma di un evento 15 settembre 2026, 15:00–17:00 nel browser con server arrestato: motore `offline-local`, import riuscito. Test parser e transazioni conservati. |
| PDF/immagini | Revisione UI e servizio; test validazione tipi e limiti prima della lettura (5 MiB binari, 100.000 caratteri testo). Estrazione cloud reale non provata senza credenziali. |
| Conferma estratti/archivio | Revisione collegamenti e cancellazioni asincrone; test atomicità e relazioni conservati. Conferma testuale provata nel browser. |
| Google collegamento/scollegamento | Revisione codice. Corretto scope OAuth mancante per Calendar. Accesso/account reale non provato. |
| Google selettivo | Test opt-in, ID storico, revoca consenso e chiamate concorrenti. Web Locks serializza le sync tra schede compatibili. |
| Studenti/note | Test note concorrenti, conservazione note durante modifica anagrafica e conflitti; pagina caricata nel browser con server arrestato. |
| Backup/export/restore | Test v2/v3, snapshot coerente e restore atomico conservati; test errore aggiornamento vista dopo restore riuscito. Import protetto da operazioni sovrapposte. |
| Offline/reload | Browser su build production, poi server localhost arrestato: reload riuscito, dati conservati, apertura di viste lazy mai visitate e analisi/import testuale riusciti. |

## Bug corretti

- Le viste non ricevevano le scritture di altre schede. `liveQuery` di Dexie osserva snapshot coerenti e usa il suo BroadcastChannel integrato; il canale comunica invalidazioni, non documenti. Una sola sorgente aggiorna lo stato React dopo i commit. L'osservazione viene ripresa al focus in caso di errore e pulita allo smontaggio.
- Le bozze potevano essere azzerate da aggiornamenti del profilo; il profilo riaperto poteva invece mostrare campi vecchi. Inizializzazione dei moduli separata dagli aggiornamenti estranei, riferimenti invariati quando i dati non cambiano.
- Editor aperti in due schede potevano sovrascrivere modifiche o ricreare eventi eliminati. Controllo transazionale del valore originale per evento, profilo, studente e slot; conflitto esplicito, bozza conservata. Le note più recenti vengono preservate durante il salvataggio anagrafico.
- Conferme di cancellazione chiudevano prima dell'esito; ora attendono il risultato. La cancellazione Google avviene dopo il commit locale: un errore locale non distrugge la copia remota. Un errore remoto viene distinto dal salvataggio locale riuscito.
- Il restore poteva essere segnalato fallito dopo un commit riuscito, per un errore di aggiornamento vista. Esiti ora distinti; lettura file/import serializzati nel modulo.
- L'override `close()` impediva la riapertura automatica prevista da Dexie nel ciclo pagehide/BFCache. Conservate le opzioni di riapertura.
- Errori quota/indisponibilità ora hanno messaggi comprensibili e visibili sopra le finestre. Nessuna sostituzione con demo e nessun fallback scrivibile silenzioso.
- Sync simultanee potevano creare due eventi remoti prima del salvataggio dell'ID. Web Locks e rilettura del consenso/ID serializzano le chiamate; fallback in-process per browser senza Web Locks.
- Il provider richiedeva solo profilo/email ma scriveva su Calendar. Aggiunto `calendar.events.owned`, sufficiente per il calendario `primary` utilizzato. Riferimento: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert . Non modificate chiavi o configurazione esterna.

## PWA e bundle

Manifest production, service worker e registrazione verificati. Icone PNG presenti con dimensioni dichiarate; tutti i chunk JavaScript, incluse le viste lazy, risultano nel precache. La prova senza server dimostra il funzionamento della cache locale dopo un primo caricamento riuscito; non simula l'assenza di connessione globale del dispositivo.

Installazione nativa Android/Chrome e hosting HTTPS finale non verificati: nel browser integrato è disponibile la guida di installazione, non una conferma di installazione nativa.

Il bundle iniziale misurava **767,05 kB (198,36 kB gzip)**. Le principali sorgenti nel bundle erano React DOM, Firebase Auth, Dexie e i grandi componenti. Misurazione mediante metadata dei moduli Rollup, senza cambiare la configurazione finale. Sei viste/modali sono ora caricate con React.lazy; il precache le rende comunque disponibili offline. Il totale scaricato per tutte le viste non diminuisce nella stessa misura del bundle iniziale. Rimane l'avviso >500 kB: non sono stati creati chunk artificiali soltanto per nasconderlo.

## Limiti da verificare nella beta

- Configurare/abilitare lo scope Calendar nel consenso OAuth e verificare con account tester reali, nuova autorizzazione, revoca e token scaduto. Nessun test ha effettuato scritture su un calendario reale.
- Provare PDF/immagini reali sul backend configurato; la rete resta necessaria per AI cloud e Google, non per dati e parser locali.
- Senza Web Locks, la serializzazione Google vale per la singola scheda. Non c'è una coda persistente di retry remoto; errori remoti richiedono verifica/sync esplicita.
- Il restore sostituisce intenzionalmente l'intero archivio dopo conferma. Non è introdotto un merge multiutente. Backup esterni restano necessari contro cancellazione dei dati del browser.
- Test IndexedDB con fake-indexeddb e prove browser complementari; non certificano tutti i browser/dispositivi o un esaurimento fisico del disco.

## Esito finale automatico

112 test superati; `npm run lint` (TypeScript) e `npm run build` riusciti. Bundle iniziale finale: **591,39 kB (163,00 kB gzip)**, riduzione rispettivamente **22,9%** e **17,8%**. Precache: 28 risorse, 831,38 KiB. Verificate nuovamente dimensioni delle icone e presenza di tutti i chunk JS nel service worker della build finale. Il renderer React usato solo nei test emette un avviso di deprecazione; non è incluso nel prodotto.
