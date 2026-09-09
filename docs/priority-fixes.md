# Correzioni prioritarie — settembre 2026

Questa modifica consolida agenda, circolari e backup senza cambiare tecnologia di persistenza né attivare nuove integrazioni cloud.

## Comportamento aggiornato

- Le date civili del calendario usano il giorno locale, senza conversione a UTC. Gli eventi tutto il giorno hanno una fine esclusiva corretta nell'export Google/ICS.
- Gli eventi manuali richiedono una fascia valida; modificare un evento conserva anche i riferimenti alla circolare e gli altri metadati.
- Un unico parser testuale serve browser e server. Sono state rimosse le regole che aggiungevano attività di settembre 2026 o imponevano gli orari di una scuola specifica.
- Le date senza anno usano l'anno scolastico del profilo (agosto-dicembre: primo anno; gennaio-luglio: secondo anno). Senza data riconoscibile il campo rimane vuoto. Le righe successive possono ereditare la data dell'intestazione del blocco.
- I campi mancanti non ricevono orari fittizi. Le proposte incomplete non sono preselezionate e richiedono correzione prima di essere importate. Una sede di fallback viene applicata solo se inserita dall'utente nell'apposito campo.
- Classe e materia vengono controllate insieme ai destinatari; un dipartimento estraneo non diventa pertinente solo perché appartiene allo stesso ordine scolastico. Le attività ambigue restano gialle.
- Foto/PDF non elaborabili dal servizio online producono un errore esplicito. Il fallback offline funziona sul testo, non è OCR.
- Ogni nuovo evento da circolare conserva ID documento e ID proposta. Reimportare la stessa proposta dall'archivio è idempotente. Eliminare una proposta non cancella eventi manuali con nomi o orari simili.
- I collegamenti legacy sono ricostruiti soltanto in presenza di un unico documento e una corrispondenza esatta di titolo, data, orari e classe. I casi ambigui restano scollegati e non vengono cancellati automaticamente.
- Il backup v3 include orario definitivo, provvisorio, modalità e stato onboarding. Prima di scrivere, valida l'intero documento. Un journal locale consente rollback in caso di errore e recupero di un ripristino interrotto al successivo avvio.
- I backup v2 rimangono importabili: l'unico orario contenuto viene caricato come definitivo, mantenendo provvisorio e modalità già presenti. Il messaggio di ripristino spiega questa limitazione del formato precedente.
- La lettura dell'archivio non ricrea più estratti da documenti demo individuati per somiglianza del titolo.

## Verifica

Con Node.js 24 e dipendenze installate:

```sh
npm test
npm run lint
npm run build
```

La suite usa il test runner Node con `tsx`, senza nuovi pacchetti di test. Esegue le prove sulle date in `Europe/Rome`, sui parser/filtro, sull'import offline, sui riferimenti di provenienza e sui backup con simulazione di un errore di scrittura. Usa soltanto dati sintetici e non chiama Google/Gemini.

Per avviare la build di produzione:

```sh
NODE_ENV=production npm start
```

## Limiti e prossimi interventi

- Le correzioni non spostano automaticamente gli eventi già salvati con date sbagliate e non rimuovono vecchi risultati inventati: non è possibile distinguerli in sicurezza da correzioni manuali.
- Il parser regex è un fallback conservativo per testo semplice. Tabelle complesse, anni ambigui, destinatari articolati, sedi e materie non riconosciute richiedono revisione. Va ampliato con un corpus anonimizzato multi-scuola.
- Il caricamento dello stesso documento come nuova circolare non è deduplicato per hash del file; l'idempotenza copre le proposte dello stesso documento nell'archivio.
- localStorage resta la persistenza corrente. Il rollback non sostituisce un database transazionale né un backup esterno; più schede che scrivono contemporaneamente non sono coordinate. Prossimo passo: IndexedDB e migrazione.
- OCR locale, ricorrenze, protezione dell'endpoint cloud e consenso/sincronizzazione Google Calendar sono interventi separati. Le credenziali OAuth e le chiamate Gemini reali non sono state collaudate in questa modifica.
- L'installazione npm segue gli intervalli del package.json; il progetto mantiene il bun.lock originale. La standardizzazione del package manager e i tre avvisi moderati rilevati da npm vanno trattati in un intervento dedicato, senza aggiornamenti indiscriminati.
