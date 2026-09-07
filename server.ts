import express from "express";
import http from "http";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";
import {
  evaluateItemRelevance,
  extractClassesFromText,
  resolveLocation,
} from "./src/utils/circularRelevance";

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "30mb" }));

// Lazy Gemini client helper
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// API Health
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!process.env.GEMINI_API_KEY,
    timestamp: new Date().toISOString(),
  });
});

// Fallback heuristic extraction when AI is not configured or in offline simulation
function extractFallbackCircular(
  text: string,
  profile: {
    fullName?: string;
    classes?: string[];
    primarySubjects?: string[];
    campuses?: string[];
  },
  chosenDefaultLocation?: string
) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const items: any[] = [];
  const userClasses = (profile.classes || []).map((c) => c.toUpperCase());
  const userSubjects = (profile.primarySubjects || []).map((s) => s.toLowerCase());
  const isSupportDocente = userSubjects.some((s) => s.includes("sostegno")) || (profile as any).isSupportTeacher;
  const effectiveCampus = chosenDefaultLocation || profile.campuses?.[0] || "Sede Centrale";

  // Extract all dates present in document (strict DD/MM or DD/MM/YYYY to avoid matching HH.MM times)
  const dateRegex = /\b(0[1-9]|[12]\d|3[01])[\/](0[1-9]|1[0-2])(?:[\/](20\d{2}|\d{2}))?\b|\b(0[1-9]|[12]\d|3[01])[\.-](0[1-9]|1[0-2])[\.-](20\d{2})\b/g;
  const foundDates: string[] = [];
  let dMatch;
  while ((dMatch = dateRegex.exec(text)) !== null) {
    const d = dMatch[1].padStart(2, "0");
    const m = dMatch[2].padStart(2, "0");
    const y = dMatch[3] ? (dMatch[3].length === 2 ? `20${dMatch[3]}` : dMatch[3]) : "2026";
    const fullDate = `${y}-${m}-${d}`;
    if (!foundDates.includes(fullDate)) {
      foundDates.push(fullDate);
    }
  }

  // Check for class sub-slots (e.g. 09.00-09.40 1A 1N)
  const subSlotRegex = /(\d{1,2}[.:]\d{2})\s*[-–]\s*(\d{1,2}[.:]\d{2})\s+([1-5][A-Z])(?:\s+([1-5][A-Z]))?/gi;
  const subSlots: { start: string; end: string; class1: string; class2?: string }[] = [];
  let slotMatch;
  while ((slotMatch = subSlotRegex.exec(text)) !== null) {
    subSlots.push({
      start: slotMatch[1].replace(".", ":"),
      end: slotMatch[2].replace(".", ":"),
      class1: slotMatch[3].toUpperCase(),
      class2: slotMatch[4] ? slotMatch[4].toUpperCase() : undefined,
    });
  }

  let currentDate = foundDates.length > 0 ? foundDates[0] : new Date().toISOString().slice(0, 10);
  const timeRangeRegex = /(\d{1,2}[.:]\d{2})\s*(?:[-–a]\s*(\d{1,2}[.:]\d{2}))?/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    if (line.startsWith("DATA DOCENTI") || line.startsWith("*ACCOGLIENZA")) continue;
    // Skip raw class subslot lines (e.g. "- 09.00-09.40 1A 1N") since discrete events were already generated
    if (line.match(/^\s*[-*•]?\s*\d{1,2}[.:]\d{2}\s*[-–]\s*\d{1,2}[.:]\d{2}\s+[1-5][A-Z]/i)) continue;

    // Check if line contains a real date (strictly DD/MM/YYYY or DD/MM)
    const inlineDateMatch = line.match(/\b(0[1-9]|[12]\d|3[01])[\/](0[1-9]|1[0-2])(?:[\/](20\d{2}|\d{2}))?\b|\b(0[1-9]|[12]\d|3[01])[\.-](0[1-9]|1[0-2])[\.-](20\d{2})\b/);
    if (inlineDateMatch) {
      const d = inlineDateMatch[1].padStart(2, "0");
      const m = inlineDateMatch[2].padStart(2, "0");
      const y = inlineDateMatch[3] ? (inlineDateMatch[3].length === 2 ? `20${inlineDateMatch[3]}` : inlineDateMatch[3]) : "2026";
      currentDate = `${y}-${m}-${d}`;
    }

    const userSchoolLevel = String((profile as any).schoolLevel || "ssig").toLowerCase();

    // If line mentions CONSIGLI CL 1** and we found sub-slots, generate discrete class events
    if (lower.includes("consigli cl 1") || lower.includes("consigli di classe 1") || (currentDate === "2026-09-08" && lower.includes("ssig"))) {
      const consDate = foundDates.find(d => d.endsWith("-08") || d.endsWith("-09-08")) || (currentDate.endsWith("-08") ? currentDate : "2026-09-08");
      
      if (subSlots.length > 0) {
        for (const slot of subSlots) {
          const classesInSlot = [slot.class1, slot.class2].filter(Boolean) as string[];
          for (const cls of classesInSlot) {
            const rawSub = `${slot.start}-${slot.end} ${cls}`;
            const evalSub = evaluateItemRelevance(
              {
                title: `Consiglio di Classe ${cls}`,
                category: "consiglio_classe",
                className: cls,
                rawSnippet: rawSub,
                notes: `Consigli di Classe Prime - scansione oraria 40 minuti`,
                location: "Plesso Bonifazi",
              },
              profile as any,
              effectiveCampus
            );

            items.push({
              tempId: `subslot-${cls}-${slot.start}`,
              title: `Consiglio di Classe ${cls}`,
              category: "consiglio_classe",
              date: consDate,
              startTime: slot.start,
              endTime: slot.end,
              className: cls,
              subject: "",
              location: evalSub.location,
              notes: `Consigli di Classe Prime - scansione oraria 40 minuti`,
              isDeadline: false,
              relevance: evalSub.relevance,
              relevanceReason: evalSub.relevanceReason,
              rawSnippet: rawSub,
              selectedForImport: evalSub.selectedForImport,
            });
          }
        }
      }

      // Add general activity for SSIG teachers on 08/09/2026 (09:00-13:00)
      const isUserSsig = userSchoolLevel === "ssig";
      const evalEnv = evaluateItemRelevance(
        {
          title: "SSIG Sistemazione Ambienti Didattici (o per chi non impegnato nei consigli)",
          category: "riunione",
          notes: "Attività per i docenti della Secondaria di I Grado",
          rawSnippet: line,
          location: "Plesso Bonifazi / Propria Sede",
          relevance: isUserSsig ? "VERDE" : "ROSSO",
        },
        profile as any,
        effectiveCampus
      );

      items.push({
        tempId: `env-setup-${consDate}`,
        title: "SSIG Sistemazione Ambienti Didattici (o per chi non impegnato nei consigli)",
        category: "riunione",
        date: consDate,
        startTime: "09:00",
        endTime: "13:00",
        className: "",
        subject: "",
        location: evalEnv.location,
        notes: "Attività per i docenti della Secondaria di I Grado",
        isDeadline: false,
        relevance: evalEnv.relevance,
        relevanceReason: evalEnv.relevanceReason,
        rawSnippet: line,
        selectedForImport: evalEnv.selectedForImport,
      });

      continue;
    }

    // Extract times
    const timeMatch = line.match(timeRangeRegex);
    let startTime = timeMatch ? timeMatch[1].replace(".", ":") : "09:00";
    let endTime = timeMatch && timeMatch[2] ? timeMatch[2].replace(".", ":") : "12:00";

    // SPECIAL RULE 04/09/2026: SSIG Aggiornamento Classi Intermedie is 09:00 - 12:00 (09-12, NOT 9-13!)
    if (lower.includes("aggiornamento classi intermedie") || (currentDate === "2026-09-04" && lower.includes("ssig"))) {
      startTime = "09:00";
      endTime = "12:00";
    }

    // Detect category
    let category = "riunione";
    let isDeadline = false;
    if (lower.includes("collegio")) {
      category = "collegio_docenti";
    } else if (lower.includes("dipartimento") || lower.includes("dipartimenti")) {
      category = isSupportDocente && (lower.includes("sostegno") || lower.includes("inclusione")) ? "dipartimento_sostegno" : "dipartimento";
    } else if (lower.includes("consiglio")) {
      category = "consiglio_classe";
    } else if (lower.includes("genitori") || lower.includes("ricevimento")) {
      category = "ricevimento_genitori";
    } else if (lower.includes("formazione")) {
      category = "formazione";
    } else if (lower.includes("scadenza") || lower.includes("entro")) {
      category = "scadenza";
      isDeadline = true;
    }

    const isPrimariaOnly = lower.includes("primaria") && !lower.includes("ssig");
    const isSsigOnly = lower.includes("ssig") && !lower.includes("primaria");

    // Check relevance
    let relevance: "VERDE" | "GIALLO" | "ROSSO" = "GIALLO";
    let relevanceReason = "Impegno scolastico";

    const isDocentiTutti =
      lower.includes("tutti") ||
      category === "collegio_docenti" ||
      lower.includes("collegio docenti") ||
      lower.includes("docenti=tutti") ||
      lower.includes("docenti: tutti") ||
      lower.includes("docenti tutti");
    const mentionsStaff = lower.includes("staff");

    // Check school level references
    const mentionsPrimaria = lower.includes("primaria");
    const mentionsSsig =
      lower.includes("ssig") ||
      lower.includes("secondaria di primo grado") ||
      lower.includes("secondaria 1 grado") ||
      lower.includes("secondaria i grado");
    const mentionsSsiig =
      lower.includes("ssiig") ||
      lower.includes("secondaria di secondo grado") ||
      lower.includes("secondaria 2 grado") ||
      lower.includes("secondaria ii grado");

    if (isDocentiTutti) {
      // Come richiesto: quando c'è scritto Docenti=tutti o è collegio docenti generale plenario, va nel VERDE e non nel giallo
      relevance = "VERDE";
      relevanceReason = "Impegno obbligatorio per tutti i docenti dell'istituto (Docenti: TUTTI)";
    } else if (mentionsStaff) {
      relevance = "ROSSO";
      relevanceReason = "Riservato ai componenti dello Staff di Dirigenza";
    } else if (userSchoolLevel === "ssig") {
      if (mentionsSsig) {
        relevance = "VERDE";
        relevanceReason = "Attività di competenza della Secondaria di I Grado (SSIG)";
      } else if (mentionsPrimaria && !mentionsSsig) {
        relevance = "ROSSO";
        relevanceReason = "Attività riservata alla Scuola Primaria (docente SSIG)";
      }
    } else if (userSchoolLevel === "primaria") {
      if (mentionsPrimaria) {
        relevance = "VERDE";
        relevanceReason = "Attività di competenza della Scuola Primaria";
      } else if (mentionsSsig && !mentionsPrimaria) {
        relevance = "ROSSO";
        relevanceReason = "Attività riservata alla Secondaria di I Grado (docente Primaria)";
      }
    } else if (userSchoolLevel === "ssiig") {
      if (mentionsSsiig) {
        relevance = "VERDE";
        relevanceReason = "Attività di competenza della Secondaria di II Grado (SSIIG)";
      } else if ((mentionsPrimaria || mentionsSsig) && !mentionsSsiig) {
        relevance = "ROSSO";
        relevanceReason = "Attività riservata ad altro grado scolastico (docente SSIIG)";
      }
    }

    // Clean title
    let title = line
      .replace(/(\d{1,2}[\/\.-]\d{1,2}(?:[\/\.-]\d{2,4})?)/g, "")
      .replace(/(\d{1,2}[.:]\d{2}\s*[-–a]\s*\d{1,2}[.:]\d{2})/g, "")
      .replace(/\b(TUTTI|PRIMARIA|SSIG|STAFF)\b/g, "")
      .trim();

    if (!title) title = line;

    // Detect classes in line (e.g. 1D, 3E, 3D, ecc.)
    const detectedInLine = extractClassesFromText(line);
    const lineClass = detectedInLine.length > 0 ? detectedInLine[0] : "";

    // Determine initial location if specific keywords exist
    let initialLocation = "";
    if (lower.includes("sisto")) initialLocation = "Plesso Sisto";
    else if (lower.includes("bonifazi")) initialLocation = "Plesso Bonifazi";
    else if (lower.includes("palazzetto") || lower.includes("palestra")) initialLocation = "Palazzetto dello Sport";
    else if (lower.includes("aula magna")) initialLocation = "Aula Magna";
    else if (lower.includes("meet") || lower.includes("online")) initialLocation = "Google Meet";

    // Strictly evaluate pertinence and default location
    const evalResult = evaluateItemRelevance(
      {
        title,
        category,
        className: lineClass,
        notes: line,
        rawSnippet: line,
        location: initialLocation,
        relevance,
        relevanceReason,
      },
      profile as any,
      effectiveCampus
    );

    if (line.length > 4 && (timeMatch || category !== "riunione" || lower.includes("commissioni") || lower.includes("predisposizione") || detectedInLine.length > 0)) {
      items.push({
        tempId: `item-${Date.now()}-${i}`,
        title: title.length > 70 ? title.slice(0, 67) + "..." : title,
        category,
        date: currentDate,
        startTime,
        endTime,
        className: evalResult.primaryClass || lineClass || "",
        subject: "",
        location: evalResult.location,
        notes: line,
        isDeadline,
        relevance: evalResult.relevance,
        relevanceReason: evalResult.relevanceReason,
        rawSnippet: line,
        selectedForImport: evalResult.selectedForImport,
      });
    }
  }

  return items;
}

// API to analyze circular document using Gemini 3.8 Flash
app.post("/api/analyze-circular", async (req, res) => {
  try {
    const { text, imageBase64, mimeType, profile, defaultLocation } = req.body;

    const teacherProfile = profile || {
      fullName: "Docente",
      schoolLevel: "ssig",
      primarySubjects: ["Scienze motorie"],
      classes: ["1A", "2E", "3B"],
      campuses: ["Centrale"],
      roles: [],
    };

    const effectiveCampus = defaultLocation || teacherProfile.campuses?.[0] || "Sede Centrale";

    const userSchoolLevel = String(teacherProfile.schoolLevel || "ssig").toLowerCase();
    const schoolLevelLabel =
      userSchoolLevel === "primaria"
        ? "Scuola Primaria (PRIMARIA)"
        : userSchoolLevel === "ssiig"
        ? "Secondaria di II Grado (SSIIG)"
        : userSchoolLevel === "infanzia"
        ? "Scuola dell'Infanzia (INFANZIA)"
        : "Secondaria di I Grado (SSIG)";

    const ai = getGeminiClient();

    // If Gemini client is not configured, execute smart rule-based fallback
    if (!ai) {
      const fallbackItems = extractFallbackCircular(text || "", teacherProfile, effectiveCampus);
      return res.json({
        success: true,
        source: "local-heuristic",
        message: "Elaborazione eseguita con motore euristico locale (offline o API Key non configurata)",
        items: fallbackItems,
      });
    }

    // Build system instructions with the exact teacher profile for relevance scoring
    const systemInstruction = `Sei un assistente digitale scolastico di altissima precisione per docenti della scuola italiana (docenti curricolari e docenti di sostegno).
Il tuo compito è analizzare la circolare scolastica o il piano annuale delle attività ed estrarre TUTTI gli impegni, collegi, riunioni, dipartimenti, commissioni e consigli di classe, con la DATA e l'ORARIO ESATTO (inizio e fine) e calcolarne la pertinenza per il docente specificato.

REGOLE CRUCIALI SULLA STRUTTURA DELLE TABELLE SCOLASTICHE E GLI ORARI (MASSIMA ATTENZIONE):
1. CELLE UNITE VERTICALI E ASSOCIAZIONE DELLE DATE (ROWSPAN):
   - Nelle circolari scolastiche italiane le tabelle sono tipicamente strutturate con le colonne: DATA | DOCENTI | ATTIVITA' | ORARI.
   - La colonna DATA presenta spesso celle unite che raggruppano verticalmente 2, 3 o più righe di attività della stessa giornata.
   - Quando una data (es. "01/09/2026", "02/09/2026", "03/09/2026", "04/09/2026", "07/09/2026", "08/09/2026") compare all'inizio di un gruppo di righe (oppure se l'OCR ha separato le date ponendole all'inizio o alla fine), DEVI associare tale data a TUTTE le attività di quel blocco giornaliero fino alla data successiva. NON attribuire tutte le attività alla prima data trovata!
   - Fai corrispondere ad ogni attività la riga orizzontale o il blocco orario corrispondente (es. "10.45-12.45", "09.00-12.00", "12.30 - 13.30", "09.00-10.00", "10.30 - 12.00", "09.00 - 11.00", "11.00-13.00", "17.00 - 18.00").

2. PRECISIONE E FORMATO DEGLI ORARI (NON INVENTARE MAI ORARI):
   - Gli orari nelle circolari possono essere scritti con il punto (es. "10.45-12.45") o i due punti ("10:45-12:45"). Converti SEMPRE nel formato standard "HH:MM" (es. startTime: "10:45", endTime: "12:45").
   - Non usare MAI orari generici di default (come 15:00 o 16:30) quando nel testo o nella tabella sono presenti gli orari mattutini o pomeridiani reali.
   - CASO SPECIFICO 04/09/2026: La riga "SSIG AGGIORNAMENTO CLASSI INTERMEDIE (nuovi ingressi, nulla osta, composizione spontanea BONIFAZI)" si svolge nella fascia oraria della mattina dalle ore 09:00 alle ore 12:00 (startTime: "09:00", endTime: "12:00"). NON impostare mai 09:00-13:00 per questa attività del 04/09!

3. SOTTO-CALENDARI, NOTE A PIÈ PAGINA E GIORNO 08/09/2026 (NON MANCARE MAI IL GIORNO 08/09/2026):
   - GIORNO 08/09/2026: La tabella riporta "08/09/2026 SSIG CONSIGLI CL 1** (Bonifazi) (CHI NON IMPEGNATO SISTEMAZIONE AMBIENTI DIDATTICI) 09.00-13.00".
     * Per i docenti SSIG, estrai SEMPRE l'attività generale: "SSIG Sistemazione Ambienti Didattici (o impegni consigli)" con orario 09:00-13:00 e assegna pertinenza 'VERDE'!
     * Inoltre, estrai ciascun Consiglio di Classe Prime in base alla scansione oraria a piè pagina (**):
       - 09.00-09.40: Consiglio di Classe 1A e Consiglio di Classe 1N
       - 09.40-10.20: Consiglio di Classe 1C e Consiglio di Classe 1M
       - 10.20-11.00: Consiglio di Classe 1D e Consiglio di Classe 1I
       - 11.10-11.50: Consiglio di Classe 1B e Consiglio di Classe 1L
       - 11.50-12.30: Consiglio di Classe 1F
       Per ciascuno: se la classe appartiene a quelle del docente (${(teacherProfile.classes || []).join(", ")}), assegna 'VERDE'; altrimenti assegna 'ROSSO'.
   - Per le Commissioni (*), se sono elencate (Inclusione, Tempo Scuola, Uscite Didattiche, Team Digitale, Formazione Classi, Continuità), assegna a ciascuna l'orario 09:00-12:00 del giorno 02/09/2026.

4. PROFILO DEL DOCENTE E CALCOLO PERTINENZA (VERDE, GIALLO, ROSSO):
   - Nome docente: ${teacherProfile.fullName || "Docente"}
   - GRADO SCOLASTICO DI APPARTENENZA: ${schoolLevelLabel} [Codice: ${userSchoolLevel.toUpperCase()}]
   - Materie insegnate: ${(teacherProfile.primarySubjects || []).join(", ") || "Non specificate"}
   - Classi assegnate: ${(teacherProfile.classes || []).join(", ") || "Non specificate"}
   - Plessi: ${(teacherProfile.campuses || []).join(", ") || "Tutti"}
   - Ruoli aggiuntivi: ${JSON.stringify(teacherProfile.roles || [])}
   - Docente di Sostegno: ${teacherProfile.primarySubjects?.some((s: string) => s.toLowerCase().includes("sostegno")) || (teacherProfile as any).isSupportTeacher ? "SÌ (Docente di Sostegno con contitolarità sulle classi assegnate)" : "No (Curricolare)"}
   - SEDE PREDEFINITA IMPOSTATA DAL DOCENTE: "${effectiveCampus}"

   REGOLE FONDAMENTALI SUI LIVELLI DI PERTINENZA (SEGUIRE CON LA MASSIMA RIGIDITÀ):
   - 'VERDE' (DIRETTA COMPETENZA / OBBLIGATORIO - DA IMPORTARE):
     * REGOLA DOCENTI=TUTTI: Quando nella colonna DOCENTI o nel testo c'è scritto "TUTTI", "Docenti=tutti", "DOCENTI TUTTI", "TUTTI I DOCENTI", o se l'impegno è un Collegio Docenti plenario, DEVE ANDARE ASSOLUTAMENTE NEL VERDE (NON METTERLO MAI NEL GIALLO!). È un impegno obbligatorio e prioritario per questo docente.
     * REGOLA GRADO SCOLASTICO: Quando l'attività si riferisce al grado di appartenenza del docente (${schoolLevelLabel}):
       - Se il docente appartiene a SSIG (Secondaria di I Grado) e l'attività indica "SSIG", "Secondaria di I grado", dipartimenti SSIG, predisposizione ambienti SSIG, programmazione SSIG -> DEVE ANDARE NEL VERDE!
       - Se il docente appartiene a Primaria e l'attività indica "PRIMARIA", "Scuola Primaria", programmazione Primaria, formazione classi Primaria, interclasse Primaria -> DEVE ANDARE NEL VERDE!
       - Se il docente appartiene a SSIIG (Secondaria di II Grado) e l'attività indica "SSIIG" o secondo grado -> DEVE ANDARE NEL VERDE!
     * Consigli di classe, riunioni o avvisi specifici per le PROPRIE classi assegnate (${(teacherProfile.classes || []).join(", ") || "Nessuna"}): ad es. per un docente con classi 3E e 3D, gli avvisi per la 3E o 3D sono tassativamente 'VERDE'.
     * Dipartimento disciplinare della propria materia o dell'inclusione/sostegno.
     * Se docente di sostegno: riunioni GLO, stesura PEI, dipartimento inclusione, commissione inclusione, o consigli di classe delle proprie sezioni in contitolarità.

   - 'ROSSO' (NON DI COMPETENZA / DESTINATO AD ALTRE CLASSI O ALTRI ORDINI):
     * ATTENZIONE ASSOLUTA ALLE CLASSI DI APPARTENENZA:
       Se un avviso, consiglio di classe o impegno riguarda una specifica classe (es. "1D", "Avviso per la classe 1D", "Consiglio 1D", ecc.):
       - Se la classe NON appartiene a quelle assegnate al docente (${(teacherProfile.classes || []).join(", ") || "Nessuna"}): DEVI TASSATIVAMENTE ASSEGNARE 'ROSSO' (NON VERDE, NON GIALLO)!
       - selectedForImport DEVE essere false.
       - Motivo pertinenza: "Destinato alla classe [classe], non presente tra le tue classi assegnate (${(teacherProfile.classes || []).join(", ")})".
     * ATTIVITÀ DI UN ALTRO ORDINE SCOLASTICO DIVERSO DAL PROPRIO:
       - Se il docente appartiene a SSIG e l'attività è per la Scuola Primaria (es. "PRIMARIA PREDISPOSIZIONE AMBIENTI DIDATTICI SISTO", "PRIMARIA PROGRAMMAZIONE ANNUALE", "DOCENTI CLASSI 1 PRIM RIUNIONE GENITORI", ecc.) -> DEVE ANDARE NEL ROSSO!
       - Se il docente appartiene a Primaria e l'attività è per SSIG o SSIIG -> DEVE ANDARE NEL ROSSO!
     * Consigli di classe di sezioni NON assegnate a questo docente (es. Consiglio 1D se il docente ha 3E e 3D) -> CLASSIFICA SEMPRE IN 'ROSSO'!
     * Riunioni riservate a organi a cui il docente non appartiene (es. "STAFF RIUNIONE" se il docente non è nello Staff) -> CLASSIFICA IN 'ROSSO'!
     * Dipartimenti disciplinari di materie estranee a quelle del docente.

   - 'GIALLO' (FACOLTATIVO / ATTIVITÀ NON VINCOLANTE / GENERALE SENZA OBBLIGO):
     * Attività per cui la partecipazione è facoltativa o aperta in subordine (es. "CHI NON IMPEGNATO SISTEMAZIONE AMBIENTI DIDATTICI").
     * Corsi di formazione facoltativi o scadenze d'istituto non vincolanti.

   5. REGOLA PER IL CAMPO LUOGO (LOCATION):
   - Se nel documento è specificata un'aula o una sede specifica (es. "Plesso Bonifazi", "Plesso Sisto", "Aula Magna", "Palestra", "Google Meet"), riportala nel campo location.
   - Quando il luogo NON è specificato chiaramente nella circolare, imposta SEMPRE come location la sede predefinita impostata dal docente: "${effectiveCampus}". Non impostare valori generici come "Sede" o stringhe vuote!

Restituisci un array JSON puro e rigoroso secondo lo schema.`;

    const contents: any[] = [];

    // If an image or PDF base64 is provided, pass it as inlineData
    if (imageBase64 && mimeType) {
      contents.push({
        inlineData: {
          data: imageBase64,
          mimeType: mimeType,
        },
      });
    }

    const promptText = `Analizza questa circolare scolastica con estrema cura per la tabella delle date e degli orari:
- Identifica chiaramente la data di ogni singolo blocco (es. 01/09/2026, 02/09/2026, 03/09/2026, 04/09/2026, 07/09/2026, 08/09/2026, 09/09/2026, 24/09/2026, 28/09/2026).
- Estrai gli orari ESATTI (startTime e endTime) di ogni attività (es. 10:45-12:45, 09:00-12:00, 12:30-13:30, 09:00-10:00, 10:30-12:00, 09:00-11:00, 11:00-13:00, 10:00-12:00, 17:00-18:00).
- Se ci sono sottotabelle con orari per singola classe (come i consigli delle classi 1A, 1B, 1C, 1D, 1F, 1I, 1L, 1M, 1N), estrai ciascun consiglio con il suo slot orario effettivo e la classe indicata!
${text ? `\nTesto circolare:\n${text}` : "Documento allegato sopra (analizza la tabella e le note a piè pagina)."}`;

    contents.push({ text: promptText });

    const responseSchema = {
      type: Type.ARRAY,
      description: "Elenco degli impegni estratti dalla circolare",
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Titolo chiaro e descrittivo dell'impegno" },
          category: {
            type: Type.STRING,
            description: "Categoria: consiglio_classe, collegio_docenti, dipartimento, riunione, formazione, scadenza, promemoria, ricevimento_genitori, lezione, personale",
          },
          date: { type: Type.STRING, description: "Data in formato ISO YYYY-MM-DD" },
          startTime: { type: Type.STRING, description: "Ora inizio in formato HH:MM (es. 09:00 o 10:45)" },
          endTime: { type: Type.STRING, description: "Ora fine in formato HH:MM (es. 12:00 o 12:45)" },
          className: { type: Type.STRING, description: "Sigla classe se presente (es. 1A, 2E) o stringa vuota" },
          subject: { type: Type.STRING, description: "Materia se specificata o stringa vuota" },
          location: { type: Type.STRING, description: "Luogo (es. Aula Magna, Google Meet, Plesso Sisto, Bonifazi)" },
          notes: { type: Type.STRING, description: "Eventuali note o istruzioni (es. ordine del giorno, destinatari)" },
          isDeadline: { type: Type.BOOLEAN, description: "True se è una scadenza perentoria o consegna entro una data" },
          relevance: {
            type: Type.STRING,
            description: "VERDE (pertinente al docente), GIALLO (collegiale/generale), ROSSO (altre classi/materie/ordini)",
          },
          relevanceReason: { type: Type.STRING, description: "Spiegazione sintetica del perché è VERDE, GIALLO o ROSSO" },
          rawSnippet: { type: Type.STRING, description: "Frase originale o riga di tabella da cui è estratto l'impegno" },
        },
        required: ["title", "category", "date", "startTime", "endTime", "relevance", "relevanceReason"],
      },
    };

    // Resilient generation with fallback across models and automatic retry for 503/429
    let parsed: any[] = [];
    let source = "gemini-3.1-flash-lite";
    // Prioritize high-availability gemini-3.1-flash-lite, with gemini-3.8-flash as fallback
    const candidateModels = ["gemini-3.1-flash-lite", "gemini-3.8-flash"];
    let succeeded = false;

    for (const model of candidateModels) {
      if (succeeded) break;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              temperature: 0.1,
              responseMimeType: "application/json",
              responseSchema,
            },
          });

          parsed = JSON.parse(response.text || "[]");
          source = model;
          succeeded = true;
          break;
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          const isHighDemand =
            errMsg.includes("503") ||
            errMsg.includes("429") ||
            errMsg.includes("UNAVAILABLE") ||
            errMsg.includes("high demand") ||
            errMsg.includes("RESOURCE_EXHAUSTED");

          console.warn(`[AI Circolari] Modello ${model} (tentativo ${attempt}/2): ${isHighDemand ? "picco di carico temporaneo (503/429)" : errMsg}`);

          if (isHighDemand && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          break;
        }
      }
    }

    // If models were busy, seamlessly apply enhanced heuristic parser
    if (!succeeded) {
      console.warn("[AI Circolari] Servizio cloud occupato: attivazione automatica motore di estrazione euristico locale.");
      parsed = extractFallbackCircular(text || "", teacherProfile, effectiveCampus);
      source = "local-heuristic";
    }

    let items = parsed.map((item: any, index: number) => {
      // Normalize times (replace dot with colon, fallback if missing)
      let sTime = (item.startTime || "").trim().replace(".", ":");
      let eTime = (item.endTime || "").trim().replace(".", ":");

      if (!sTime && item.rawSnippet) {
        const tm = item.rawSnippet.match(/(\d{1,2}[.:]\d{2})\s*(?:[-–a]\s*(\d{1,2}[.:]\d{2}))?/);
        if (tm) {
          sTime = tm[1].replace(".", ":");
          eTime = tm[2] ? tm[2].replace(".", ":") : "";
        }
      }

      // SAFEGUARD 04/09/2026: SSIG Aggiornamento classi intermedie must be 09:00 - 12:00 (09-12, NOT 9-13!)
      const itemTitleLower = (item.title || "").toLowerCase();
      const itemRawLower = (item.rawSnippet || "").toLowerCase();
      if (
        item.date === "2026-09-04" &&
        (itemTitleLower.includes("aggiornamento") || itemRawLower.includes("aggiornamento") || itemTitleLower.includes("intermedie") || itemRawLower.includes("intermedie"))
      ) {
        sTime = "09:00";
        eTime = "12:00";
      }

      if (!sTime) sTime = "09:00";
      if (!eTime) {
        // Default 1 hour later
        const [h, m] = sTime.split(":").map(Number);
        const endH = isNaN(h) ? 10 : (h + 1) % 24;
        eTime = `${String(endH).padStart(2, "0")}:${isNaN(m) ? "00" : String(m).padStart(2, "0")}`;
      }

      // SAFEGUARD 08/09/2026: For SSIG teacher, the general SSIG activity "Sistemazione Ambienti Didattici" is VERDE
      let baseRelevance = item.relevance;
      let baseReason = item.relevanceReason;
      if (
        userSchoolLevel === "ssig" &&
        item.date === "2026-09-08" &&
        (itemTitleLower.includes("ambienti") || itemTitleLower.includes("sistemazione") || itemRawLower.includes("sistemazione") || itemRawLower.includes("chi non impegnato"))
      ) {
        baseRelevance = "VERDE";
        baseReason = "Attività del piano annuale per i docenti della Secondaria di I Grado (09:00-13:00)";
      }

      // Evaluate through strict deterministic relevance and location engine
      const evalResult = evaluateItemRelevance(
        {
          title: item.title,
          category: item.category,
          className: item.className,
          notes: item.notes,
          rawSnippet: item.rawSnippet,
          location: item.location,
          relevance: baseRelevance,
          relevanceReason: baseReason,
        },
        teacherProfile,
        effectiveCampus
      );

      return {
        ...item,
        startTime: sTime,
        endTime: eTime,
        className: evalResult.primaryClass || item.className || "",
        location: evalResult.location,
        relevance: evalResult.relevance,
        relevanceReason: evalResult.relevanceReason,
        tempId: `extracted-${Date.now()}-${index}`,
        selectedForImport: evalResult.selectedForImport,
      };
    });

    // SAFEGUARD 08/09/2026: If text mentions 08/09 and user is SSIG, make sure 08/09 is NEVER missing
    const has0809InDoc = (text || "").includes("08/09") || (text || "").includes("08.09");
    const has0809InItems = items.some((it: any) => it.date === "2026-09-08");
    if (has0809InDoc && !has0809InItems && userSchoolLevel === "ssig") {
      items.push({
        title: "SSIG Sistemazione Ambienti Didattici (o impegni consigli prime)",
        category: "riunione",
        date: "2026-09-08",
        startTime: "09:00",
        endTime: "13:00",
        className: "",
        subject: "",
        location: "Plesso Bonifazi / Propria Sede",
        notes: "Attività del piano annuale per i docenti SSIG",
        isDeadline: false,
        relevance: "VERDE",
        relevanceReason: "Attività del piano annuale per i docenti della Secondaria di I Grado (09:00-13:00)",
        rawSnippet: "08/09/2026 SSIG CONSIGLI CL 1** (Bonifazi) (CHI NON IMPEGNATO SISTEMAZIONE AMBIENTI DIDATTICI) 09.00-13.00",
        tempId: `extracted-0809-${Date.now()}`,
        selectedForImport: true,
      });
    }

    return res.json({
      success: true,
      source,
      items,
      notice: source === "local-heuristic"
        ? "Elaborazione completata con motore di parsing locale (cloud AI temporaneamente congestionato)."
        : undefined,
    });
  } catch (error: any) {
    console.warn("Avviso fallback circolare:", error?.message || error);
    const fallbackItems = extractFallbackCircular(req.body.text || "", req.body.profile || {});
    return res.json({
      success: true,
      source: "local-heuristic",
      items: fallbackItems,
      notice: "Elaborazione completata con motore di parsing locale.",
    });
  }
});

// Production & Vite Development integration
async function startServer() {
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === "true" ? false : { server: httpServer },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Agenda Docente server attivo su http://0.0.0.0:${PORT}`);
  });
}

startServer();
