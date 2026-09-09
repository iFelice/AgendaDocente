# Prima beta su Render — guida per Felice

Questa preparazione parte da main `a00fbd3841912469a244423215527869e6b5ffc1`, sul branch `deploy/beta-render`. Non crea servizi, PR o merge. Per distribuire dal futuro **main**, queste modifiche dovranno prima essere revisionate e integrate con un'operazione separata.

## Configurazione scelta

Un **Render Web Service**, runtime **Node**, serve React/Vite/PWA e Express dalla stessa origine. Nessun database o disco persistente Render: eventi, profilo, studenti, note e circolari rimangono nell'IndexedDB del browser. Cambiare dominio/browser non trasferisce i dati: esporta il backup sul vecchio indirizzo e importalo sul nuovo.

Configurazione manuale, senza render.yaml: il nome definitivo, il piano e l'eventuale controllo di accesso sono da scegliere. Un Web Service con URL raggiungibile è pubblico; Firebase qui collega Google, **non protegge l'accesso al sito o all'endpoint AI**. Una beta riservata richiede un controllo d'accesso esterno da valutare separatamente, non implementato da questo branch.

## Passi su Render

1. Accedi a [Render](https://dashboard.render.com/) con il tuo account.
2. Seleziona **New → Web Service**, collega GitHub e autorizza l'accesso al repository necessario.
3. Scegli **iFelice/AgendaDocente**.
4. Scegli un nome del servizio e una regione; conserva l'URL assegnato, senza inserirlo nel codice.
5. Imposta runtime **Node**, branch **main** e directory radice vuota (root del repository). Prima del deploy verifica che main includa questa preparazione.
6. Build command: `npm ci && npm run build`.
7. Start command: `npm start`.
8. Health check path: `/api/health`.
9. Nelle variabili ambiente inserisci `NODE_ENV=production`, `NODE_VERSION=24.12.0`, `NPM_CONFIG_INCLUDE=dev`. Quest'ultima mantiene disponibili TypeScript/esbuild/plugin PWA durante `npm ci`, anche con NODE_ENV production. La versione Node è quella usata nelle verifiche locali.
10. **PORT:** usa il valore fornito da Render; il server ascolta `0.0.0.0` sulla porta assegnata. Non occorre impostarlo manualmente. In produzione assenza/valore non valido ferma l'avvio con un messaggio esplicito; in sviluppo il fallback resta 3000.
11. Per il primo deploy puoi lasciare Gemini e Firebase completamente non configurati. L'agenda e il parser testuale restano utilizzabili.
12. Se vuoi Gemini, aggiungi `GEMINI_API_KEY` come variabile segreta del servizio. Non incollarla nel repository, nei log o in variabili `VITE_*`.
13. Scegli il piano, controlla eventuali costi e avvia **Create Web Service / Deploy**. Questa guida non ha creato o acquistato alcun servizio.
14. Attendi il completamento build e lo stato Live. Apri `https://<dominio-del-servizio>/api/health`: deve rispondere HTTP 200 con **solo** `{"status":"ok"}`. Non verifica Gemini/Google e non ne rivela la configurazione.
15. Apri l'URL principale, completa il profilo e crea un evento di prova. Ricarica e controlla che rimanga. In una seconda scheda verifica l'aggiornamento automatico.
16. Controlla `/manifest.webmanifest`, `/sw.js` e una route come `/planning/week` (deve caricare l'app; non è una nuova vista). `/api/inesistente` deve rispondere 404 JSON, non HTML.

## Variabili: cosa inserire e dove

| Variabile | Dove viene letta | Segreta? | Uso |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Express, runtime | **Sì** | Facoltativa; vuota/assente disabilita l'AI cloud. |
| `PORT` | Express, runtime | No | Fornita da Render; fallback 3000 solo in sviluppo. |
| `NODE_ENV` | Server/toolchain | No | `production` su Render. |
| `NODE_VERSION` | Render | No | `24.12.0`, versione verificata. |
| `NPM_CONFIG_INCLUDE` | npm durante installazione | No | `dev`, necessario per i tool di build. |
| `DISABLE_HMR` | Vite/server sviluppo | No | Opzionale `true`, inutile su Render production. |
| `VITE_FIREBASE_API_KEY` | Client, build Vite | No: configurazione web pubblica | Browser API key della web app Firebase, **non** chiave Gemini. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Client, build Vite | No | Dominio Auth Firebase, normalmente `<project-id>.firebaseapp.com`. |
| `VITE_FIREBASE_PROJECT_ID` | Client, build Vite | No | ID del progetto Firebase scelto. |
| `VITE_FIREBASE_APP_ID` | Client, build Vite | No | App ID della web app Firebase. |

Le quattro variabili Firebase vanno configurate insieme: se incomplete Google è disabilitato e il pulsante restituisce un messaggio controllato; l'app locale parte comunque. Ogni modifica `VITE_*` richiede **una nuova build**, non basta riavviare il processo. Non esiste un client secret nel frontend.

`.env.example` contiene solo valori di sviluppo non sensibili e campi vuoti. `.gitignore` esclude `.env*`, eccetto questo esempio: include .env, .env.local, .env.production e relative varianti. Non usare `git add -f` per eludere l'esclusione.

`APP_URL` era documentata ma non usata: eliminata dall'esempio. Non servono `VITE_API_URL`, `GOOGLE_CLIENT_ID` o `VITE_GEMINI_API_KEY`. Le chiamate AI sono relative (`/api/analyze-circular`); Calendar usa l'endpoint pubblico Google per `primary`, non un callback locale. Nessun URL Render è hardcoded.

Express legge le variabili del processo: copiare `.env.example` non carica automaticamente Gemini nel server. Per sviluppo locale puoi esportare le variabili nella shell prima di `npm run dev`; Vite carica invece le proprie variabili client dai file .env. Su Render usa la sezione Environment.

## Google OAuth: configurazione successiva, nessun login reale eseguito

Il metodo effettivo è **Firebase Auth `GoogleAuthProvider` + `signInWithPopup`**, non Google Identity Services diretto. Il client ID/secret OAuth è configurato nel provider Google della console Firebase/Google Cloud; non è un parametro Vite indipendente. Scegliere le variabili Firebase seleziona il progetto/provider configurato. Non è stato cambiato il flusso popup.

1. Nella console Firebase scegli/crea il tuo progetto e registra una **Web app**. In Project settings → General copia solo apiKey, authDomain, projectId e appId nelle quattro variabili pubbliche sopra. Il vecchio file di configurazione del progetto AI Studio è stato rimosso.
2. Authentication → Sign-in method → Google: abilita il provider e configura email di supporto. Verifica il **Web client ID** nella configurazione Web SDK del provider. L'eventuale client secret resta nella console del provider, mai nel repository o nelle variabili Vite.
3. Authentication → Settings → Authorized domains: aggiungi il **solo hostname** Render definitivo, senza `https://` e senza percorsi; aggiungi anche ogni eventuale dominio personalizzato dell'app. Conserva il dominio Firebase Auth. Per sviluppo locale autorizza esplicitamente `localhost` se necessario.
4. Nel progetto Google Cloud corrispondente, abilita Google Calendar API e apri il client OAuth Web effettivamente associato al provider Firebase. Negli **Authorized JavaScript origins** aggiungi `https://<dominio-del-servizio>` e gli eventuali domini personalizzati effettivi (nessun percorso).
5. Negli **Authorized redirect URIs**, verifica `https://<VITE_FIREBASE_AUTH_DOMAIN>/__/auth/handler`. Con la configurazione consigliata è il dominio Firebase, **non il dominio Render**. Express non ospita l'handler Firebase: non impostare authDomain al dominio Render soltanto per uniformare gli URL.
6. Nella consent screen configura nome applicazione, contatto di supporto, audience e account tester. Richiediamo email, profilo e `https://www.googleapis.com/auth/calendar.events.owned` (scritture sul calendario primario di proprietà). Eventuali restrizioni Workspace e requisiti di verifica dipendono dal progetto/account: vanno verificati prima di estendere la beta.
7. Esegui una nuova build dopo le variabili client; prova popup, consenso Calendar, evento opt-in, sync, disattivazione e logout con un account tester. I token Calendar restano in memoria e una nuova autorizzazione può essere necessaria dopo reload/scadenza.

Non sono richiesti Firebase Admin, service account JSON, Firestore o database Firebase. Le chiavi web Firebase sono pubbliche ma vanno limitate/configurate secondo le indicazioni Firebase; non concedono un controllo accessi all'endpoint Express.

## PWA su Android e offline

Render fornisce HTTPS al dominio del servizio. La configurazione usa `start_url=/`, `scope=/`, icone 192/512/maskable e service worker alla radice. Il servizio deve essere pubblicato alla radice del dominio, non sotto un sottopercorso. Le API sono escluse dal fallback di navigazione del service worker; i chunk locali sono precached.

Su Android apri l'URL HTTPS in Chrome, attendi il caricamento, poi usa **Installa App** se disponibile oppure menu browser → Installa app/Aggiungi a schermata Home. Avvia l'icona, crea un evento, chiudi/riapri e verifica i dati. Dopo un primo caricamento riuscito, prova modalità aereo e reload: agenda, studenti, note, backup e parser testuale devono funzionare. Google e PDF/immagini cloud richiedono rete. L'installazione effettiva va verificata sul dispositivo dopo il deployment, non è certificata da una build locale.

Non cancellare i dati del sito per aggiornare la PWA: perderesti IndexedDB. Esporta un backup prima delle prove. Un'origine nuova crea un archivio distinto.

## Disabilitare Gemini senza rompere l'agenda

Rimuovi o svuota `GEMINI_API_KEY` in Environment, salva e riavvia/ridistribuisci il servizio. Il processo riparte senza AI; non serve cambiare il codice. Il testo viene elaborato dal parser locale/server quando previsto; PDF/immagini ricevono il messaggio controllato di indisponibilità. Health resta identico. Non usare una chiave fittizia per disabilitare: causerebbe tentativi cloud inutili.

L'endpoint conserva limiti payload, rate limiting e errori sanitizzati, senza upload persistente. Il limite per IP usa la connessione socket: dietro Render più utenti possono condividere il budget del proxy (10 richieste/minuto), oltre ai limiti globali. Non abbiamo abilitato fiducia indiscriminata in X-Forwarded-For. È un limite conservativo da misurare nella piccola beta; non è un sistema di autenticazione o protezione completa dei costi AI.

## Verifiche e limiti

Comandi: `npm test`, `npm run lint`, `npm run build`. Smoke production: `NODE_ENV=production PORT=4185 npm start`. PORT diverso da 3000 verifica il binding ambiente.

Il test automatico avvia Express production con fixture statiche su una porta libera e verifica health minimale, asset/SPA, API 404 JSON, blocco server bundle/source map, testo senza Gemini e PDF con errore controllato. Uno smoke separato verifica la build reale. Una chiave sentinella fittizia passata alla build permette di controllare che non finisca in alcun file client; nessuna chiave reale è usata.

Restano manuali: creazione servizio, scelta piano/accessibilità pubblica o riservata, integrazione futura su main, credenziali/progetto/provider Google, consent screen, chiamate Calendar/Gemini reali e installazione Android. I modelli Gemini esistenti non vengono modificati: disponibilità per la chiave scelta va verificata. Il bundle principale resta oltre 500 kB. Un'istanza Render non ha bisogno di conservare dati utente su disco.

Fonti ufficiali consultate: [Render Web Services](https://render.com/docs/web-services), [variabili Render](https://render.com/docs/environment-variables), [health check](https://render.com/docs/health-checks), [Firebase Google sign-in](https://firebase.google.com/docs/auth/web/google-signin), [FAQ configurazione Firebase Auth](https://firebase.google.com/docs/auth/faq-and-troubleshooting).

### Esito della preparazione

- **116 test superati** (112 precedenti + 4 deployment); lint TypeScript e build riusciti.
- Smoke della build reale su `0.0.0.0:4185`: `/`, `/api/health`, manifest, service worker e route SPA HTTP 200; API sconosciuta 404 JSON; bundle server e URL codificato bloccati con 404.
- 13 file JS/CSS raggiungibili e presenti nel precache; icone con dimensioni dichiarate e HTTP 200.
- Build con sentinella Gemini fittizia: nessuna sentinella o `GEMINI_API_KEY` negli asset client. `.env`, `.env.local`, `.env.production`, `.env.production.local` risultano ignorati da Git.
- Bundle iniziale: 591,40 kB (162,94 kB gzip); avviso >500 kB conservato.
- Nessun servizio Render creato, nessuna autenticazione reale tentata, nessuna PR o merge effettuati.
