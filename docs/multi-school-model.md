# Modello multi-istituto

Il supporto multi-istituto è **opt-in**. Il profilo mantiene i campi legacy (`schoolName`,
`email`, `campuses`, `schoolYear`, `schoolLevel`) per non rompere l'interfaccia e i backup
esistenti, e aggiunge la proiezione estensibile:

```ts
schools: SchoolProfile[]
// SchoolProfile: id, name, institutionalEmail?, campuses?, schoolLevel?,
// weeklyHours?, isPrimary?, active?
```

La scuola primaria è quella con `isPrimary: true`; il suo id è deterministico (`school-<FNV1a>`)
e stabile per quel profilo. In caso di dati legacy viene creato automaticamente un solo record
primario, anche se alcuni campi sono vuoti. La normalizzazione è idempotente: se `schools[]`
è già presente e valido non viene duplicato. I dati legacy non vengono cancellati.

## Ambito dei dati

`schoolId` è opzionale su lezioni (`TimetableSlot`), eventi di lezione, circolari e record
preparati per estensioni future. I record legacy vengono associati alla primaria quando ha
senso; gli eventi personali/generali restano senza `schoolId`. Studenti continuano a derivare
la scuola dalla classe, evitando una seconda fonte ridondante. Il timetable resta uno solo,
cronologico e globale. `findTimetableConflicts` segnala sovrapposizioni tra scuole diverse.

Identità docente, impostazioni, vista Today, calendario aggregato, scadenze, preferenze e
backup restano globali.

## UI e disattivazione

Nel Profilo, e solo lì, il controllo “Completo il mio orario anche in un altro istituto” è
disattivato per default. Quando è attivo appare la card “Altro istituto”. Disattivarlo non
cancella nulla: l'istituto secondario resta memorizzato come `active: false`.
Non esistono ancora switch agenda, filtri, studenti/classi separati, Calendar o account Google
aggiuntivi.

## IndexedDB, backup e Firestore

La migrazione viene applicata all'avvio, al ripristino e alla lettura dei dati legacy prima
della validazione. Il restore continua a essere atomico. I backup v2/v3 restano accettati;
quelli nuovi includono `schools[]` e i campi `schoolId` presenti. Firestore conserva il wrapper
(schemaVersion 1), accetta sia profili legacy sia nuovi e la validazione resta semantica,
con lo stesso limite payload e senza modifiche alle rules. Il repair dei documenti legacy e
metadata-only non viene alterato.

## Evoluzione prevista

In cicli successivi si potranno introdurre directory `Class` con `schoolId`, filtri UI e
selettore agenda, nonché Google multi-account. Queste estensioni non sono necessarie per
attivare oggi la compatibilità del modello.
