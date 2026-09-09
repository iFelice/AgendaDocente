import type { ExtractedItem, TeacherProfile } from "../types";
import { parseCircularText, normalizeExtractedItems } from "../utils/circularParser";
export { parseCircularText as clientSideLocalParser } from "../utils/circularParser";

export interface AnalyzeRequest {
  text?: string; imageBase64?: string; mimeType?: string;
  profile: TeacherProfile; defaultLocation?: string;
}
export interface AnalyzeResult {
  success: boolean; source: string; items: ExtractedItem[]; error?: string;
}
export async function analyzeCircular(req: AnalyzeRequest): Promise<AnalyzeResult> {
  try {
    const response = await fetch("/api/analyze-circular", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req), signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) throw new Error(data.error || "Analisi non riuscita.");
    return { success: true, source: data.source || 'server', items: normalizeExtractedItems(data.items, req.profile, req.defaultLocation) };
  } catch (error) {
    if (req.imageBase64 || !req.text?.trim()) return {
      success: false, source: 'unavailable', items: [],
      error: "Foto e PDF richiedono il servizio di analisi online. Riprova con la connessione oppure incolla il testo del documento.",
    };
    return { success: true, source: 'offline-local', items: parseCircularText(req.text, req.profile, req.defaultLocation) };
  }
}

// Pre-built realistic sample circulars for 1-click testing
export const SAMPLE_CIRCULARS = [
  {
    title: "Circolare n. 28 – Avvisi e Consigli Classi (Verifica pertinenza 1D, 3E, 3D e Luogo Sede)",
    description: "Ideale per testare la pertinenza rigorosa delle classi (1D non assegnata vs 3E e 3D assegnate) e l'attribuzione della sede impostata se non specificata.",
    text: `CIRCOLARE N. 28
Oggetto: Calendario Consigli Straordinari e Avvisi per le Classi 1D, 3E, 3D

Si comunicano i seguenti impegni per il giorno 15 Ottobre 2026:

1. Ore 14:30 - 15:30: Avviso straordinario e verifica andamento didattico per la classe 1D
(Destinato esclusivamente ai docenti del consiglio della classe 1D).

2. Ore 15:30 - 16:30: Consiglio di classe per la sezione 3E
(Convocati tutti i docenti della classe 3E per l'approvazione del piano didattico personalizzato).

3. Ore 16:30 - 17:30: Consiglio di classe per la sezione 3D presso Aula Magna
(Convocati i docenti della classe 3D per programmazione uscite didattiche).

4. Ore 17:30 - 18:30: TUTTI I DOCENTI – Riunione informativa sulla sicurezza e piano di evacuazione.

F.to La Dirigenza Scolastica`,
  },
  {
    title: "Piano Annuale Inizio Anno – Tabella Attività, Commissioni e Consigli Prime (Bonifazi / Sisto)",
    description: "Tabella orari con Collegio, Commissioni, Dipartimenti SSIG, Consigli Classi Prime (1A, 1B, 1C, 1D, 1F, ecc.) e Scadenze Settembre.",
    text: `DATA DOCENTI ATTIVITA’ ORARI
01/09/2026 TUTTI COLLEGIO DOCENTI 10.45-12.45
02/09/2026 SSIG/PRIMARIA COMMISSIONI* 09.00-12.00
02/09/2026 STAFF RIUNIONE 12.30 - 13.30
03/09/2026 PRIMARIA PREDISPOSIZIONE AMBIENTI DIDATTICI SISTO 09.00 - 12.00
03/09/2026 SSIG PREDISPOSIZIONE AMBIENTI DIDATTICI PROPRIA SEDE 09.00-10.00
03/09/2026 SSIG DIPARTIMENTI SSIG 10.30 - 12.00
04/09/2026 PRIMARIA FORMAZIONE CLASSI PREDISPOSIZIONE AMBIENTI DIDATTICI SISTO 09.00-12.00
04/09/2026 SSIG AGGIORNAMENTO CLASSI INTERMEDIE (nuovi ingressi, nulla osta, acquisizione nuova documentazione) composizione spontanea BONIFAZI 09.00-12.00
07/09/2026 PRIMARIA PROGRAMMAZIONE ANNUALE BONIFAZI 09.00 - 11.00
07/09/2026 PRIMARIA INTERCLASSE 11.00-13.00
07/09/2026 SSIG PREDISPOSIZIONE AMBIENTI DIDATTICI, PROGRAMMAZIONE GENERALE PER MATERIA 09.00-12.00
08/09/2026 PRIMARIA PREDISPOSIZIONE AMBIENTI DIDATTICI SISTO 09.00-12.00
08/09/2026 SSIG CONSIGLI CL 1** (Bonifazi) (CHI NON IMPEGNATO SISTEMAZIONE AMBIENTI DIDATTICI) 09.00-13.00
09/09/2026 TUTTI COLLEGIO DOCENTI 10.00 - 12.00
24/09/2026 TUTTI COLLEGIO DOCENTI 17.00 - 18.00
28/09/2026 DOCENTI CLASSI 1 PRIM RIUNIONE GENITORI SISTO 17.00 - 18.00

*COMMISSIONI (02/09/2026 ore 09.00-12.00):
- INCLUSIONE (DOC SOS E COORDINATORI)
- TEMPO SCUOLA
- USCITE DIDATTICHE
- TEAM DIGITALE
- FORMAZIONE CLASSI
- CONTINUITA - OPEN DAY

**CONSIGLI CLASSI PRIME (08/09/2026 Plesso Bonifazi):
- 09.00-09.40 1A 1N
- 09.40-10.20 1C 1M
- 10.20-11.00 1D 1I
- 11.10-11.50 1B 1L
- 11.50-12.30 1F`,
  },
  {
    title: "Circolare n. 14 – Convocazione GLO Iniziali, Redazione PEI e Dipartimento Sostegno",
    description: "Inizio anno scolastico: calendario GLO con specialisti ASL e famiglie, scadenza PEI e riunione dipartimento inclusione.",
    text: `CIRCOLARE N. 14
Oggetto: Convocazione GLO Iniziali a.s. 2026/2027, adempimenti PEI e riunione Dipartimento Inclusione

Ai Docenti di Sostegno, ai Consigli di Classe interessati, agli Operatori ASL/UONPIA e ai Genitori:

1. CALENDARIO INCONTRI G.L.O. (Gruppi di Lavoro Operativo per l'Inclusione):
Gli incontri si terranno in modalità mista (presenza in Aula Inclusione / collegamento Meet) per la condivisione e approvazione del Piano Educativo Individualizzato:
- Lunedì 20 Ottobre 2026 ore 14:30 - 15:30: GLO Classe 1A (Alunno con PEI, presenza Neuropsichiatra ASL e Genitori)
- Lunedì 20 Ottobre 2026 ore 15:30 - 16:30: GLO Classe 1C (Alunno con PEI)
- Martedì 21 Ottobre 2026 ore 15:00 - 16:00: GLO Classe 2E (Alunno con PEI differenziato, presenza Equipe Territoriale ed Educatore)
- Martedì 21 Ottobre 2026 ore 16:00 - 17:00: GLO Classe 3C (Alunno con PEI)
- Mercoledì 22 Ottobre 2026 ore 14:30 - 15:30: GLO Classe 4D (Alunno con PEI)

2. RIUNIONE DIPARTIMENTO SOSTEGNO E INCLUSIONE:
Tutti i docenti di sostegno e le figure di supporto sono convocati giovedì 23 Ottobre 2026 dalle ore 15:00 alle ore 17:00 per il coordinamento delle ore in deroga, la revisione dei modelli ministeriali PEI su base ICF e l'assegnazione degli assistenti all'autonomia e comunicazione.

3. SCADENZA CARICAMENTO BOZZA PEI SU PIATTAFORMA SIDI:
Si ricorda che entro e non oltre il 31 Ottobre 2026 ore 23:59 i docenti di sostegno, in stretta collaborazione con i docenti curricolari del Consiglio di Classe, dovranno completare e caricare la bozza del PEI sul portale ministeriale SIDI.

F.to La Dirigente Scolastica e la Referente Inclusione`,
  },
  {
    title: "Circolare n. 32 – Calendario Consigli di Classe di Ottobre",
    description: "Contiene la tabella completa dei consigli di classe con orari per tutte le sezioni.",
    text: `CIRCOLARE N. 32
Oggetto: Convocazione dei Consigli di Classe – Mese di Ottobre 2026

Si comunica il calendario dei Consigli di Classe per l'andamento didattico-disciplinare e la programmazione coordinata.
I consigli si svolgeranno secondo il seguente prospetto:

Lunedì 13 Ottobre 2026:
- Ore 14:30 - 15:30: Consiglio di Classe 1A (Aula Magna)
- Ore 15:30 - 16:30: Consiglio di Classe 1B (Aula 12)
- Ore 16:30 - 17:30: Consiglio di Classe 1C (Aula 14)

Martedì 14 Ottobre 2026:
- Ore 14:30 - 15:30: Consiglio di Classe 2D (Aula 15)
- Ore 15:30 - 16:30: Consiglio di Classe 2E (Aula Magna) – Presiede il Coordinatore Prof.ssa Bianchi
- Ore 16:30 - 17:30: Consiglio di Classe 2F (Aula 18)

Mercoledì 15 Ottobre 2026:
- Ore 14:30 - 15:30: Consiglio di Classe 3A (Aula Magna)
- Ore 15:30 - 16:30: Consiglio di Classe 3B (Aula 22)
- Ore 16:30 - 17:30: Consiglio di Classe 3C (Aula 24)

Giovedì 16 Ottobre 2026:
- Ore 15:00 - 17:00: Riunione per dipartimenti disciplinari. Dipartimento Scienze Motorie presso Palazzetto dello Sport.

Il Dirigente Scolastico`,
  },
  {
    title: "Circolare n. 45 – Piano Annuale Attività, Collegio e Scadenze",
    description: "Impegni generali, collegio docenti e scadenze burocratiche per tutti i docenti.",
    text: `CIRCOLARE N. 45
Oggetto: Piano Annuale Attività – Collegio Docenti e Adempimenti

A tutto il Personale Docente:

1. COLLEGIO DOCENTI:
È convocato il Collegio dei Docenti in seduta ordinaria per il giorno 20 Ottobre 2026 dalle ore 16:00 alle ore 18:30 presso l'Aula Magna della Sede Centrale.

2. SCADENZA PROGRAMMAZIONI:
Si rammenta che entro il 28 Ottobre 2026 ore 23:59 tutti i docenti devono provvedere al caricamento delle programmazioni didattiche individuali sul Registro Elettronico.

3. CORSO FORMAZIONE SICUREZZA:
Corso obbligatorio di aggiornamento sulla sicurezza per i docenti delle classi prime:
Venerdì 24 Ottobre 2026 ore 15:00 - 17:00 in modalità Google Meet.

4. ELEZIONI RAPPRESENTANTI GENITORI:
Le assemblee con i genitori per l'elezione dei rappresentanti si terranno giovedì 30 Ottobre 2026 dalle ore 16:30 alle ore 18:30 nelle rispettive aule.

F.to Il Dirigente Scolastico`,
  },
  {
    title: "Circolare n. 58 – Progetto Centro Sportivo Scolastico & Gare",
    description: "Specifico per dipartimento di scienze motorie e classi coinvolte.",
    text: `CIRCOLARE N. 58
Oggetto: Avvio Centro Sportivo Scolastico (CSS) e Tornei d'Autunno

Si comunica ai docenti di Scienze motorie e agli studenti interessati:

- Mercoledì 22 Ottobre 2026, ore 14:30 - 16:30: Riunione organizzativa Centro Sportivo Scolastico presso la Palestra della Sede Centrale.
- Venerdì 31 Ottobre 2026: Fase d'istituto di Corsa Campestre per le classi 1A, 2E e 3B dalle ore 09:00 alle ore 12:30 presso il Parco Comunale.
- Scadenza consegna certificati medici non agonistici degli alunni: entro il 25 Ottobre 2026 presso la segreteria didattica.

Referente CSS: Prof.ssa Elena Bianchi`,
  },
];
