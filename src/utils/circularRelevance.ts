import { ExtractedItem, TeacherProfile } from "../types";

/**
 * Utility per l'estrazione delle classi e la valutazione rigorosa della pertinenza
 * tra il profilo del docente (classi assegnate, grado, materie) e le circolari scolastiche.
 */

// Mappa numeri romani per ordini scolastici italiani (es. "III D" -> "3D")
const ROMAN_TO_NUM: Record<string, string> = {
  I: "1",
  II: "2",
  III: "3",
  IV: "4",
  V: "5",
};

/**
 * Estrae tutte le sigle delle classi menzionate in un testo o snippet.
 * Gestisce:
 * - Formato standard: "1D", "3E", "2A", "4B", "5C"
 * - Con grado o apice: "1^D", "1°D", "1ªD", "3^E"
 * - Spaziati: "1 D", "3 E", "classe 1D", "cl. 1D", "sezione 1D"
 * - Numeri romani: "I D", "III E", "classe III D"
 */
export function extractClassesFromText(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  // 1. Sigle standard arabe (1-5 seguito da A-Z)
  // Escludiamo parole come "1H" in contesti di tempo (es. "ore 1h")
  const arabicRegex = /\b([1-5])\s*[\^°ª]?\s*([A-Za-z])\b/g;
  let match: RegExpExecArray | null;
  while ((match = arabicRegex.exec(text)) !== null) {
    const grade = match[1];
    const section = match[2].toUpperCase();
    // Evitiamo false positive con unità orarie come "1h" o "2h"
    const prevChar = match.index > 0 ? text[match.index - 1] : "";
    const isHourUnit = section === "H" && /\b(ore|durata|tempo)\b/i.test(text.slice(Math.max(0, match.index - 10), match.index));
    if (!isHourUnit && section.length === 1 && /[A-Z]/.test(section)) {
      found.add(`${grade}${section}`);
    }
  }

  // 2. Sigle con numeri romani (I, II, III, IV, V seguito da lettera)
  const romanRegex = /\b(I|II|III|IV|V)\s*[\^°ª]?\s*([A-Za-z])\b/g;
  while ((match = romanRegex.exec(text)) !== null) {
    const roman = match[1].toUpperCase();
    const section = match[2].toUpperCase();
    const grade = ROMAN_TO_NUM[roman];
    if (grade && section.length === 1 && /[A-Z]/.test(section)) {
      found.add(`${grade}${section}`);
    }
  }

  // 3. Pattern espliciti con parola "classe" / "classi" / "sezione"
  const explicitClassRegex = /\b(?:classe|classi|cl\.|sez\.|sezione)\s+([1-5I|II|III|IV|V])\s*[\^°ª]?\s*([A-Za-z])\b/gi;
  while ((match = explicitClassRegex.exec(text)) !== null) {
    let grade = match[1].toUpperCase();
    if (ROMAN_TO_NUM[grade]) grade = ROMAN_TO_NUM[grade];
    const section = match[2].toUpperCase();
    if (/[1-5]/.test(grade) && /[A-Z]/.test(section)) {
      found.add(`${grade}${section}`);
    }
  }

  return Array.from(found);
}

/**
 * Rileva riferimenti all'anno di corso (es. "classi prime", "classi terze")
 */
export function extractGradesFromText(text: string): number[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const grades = new Set<number>();

  if (lower.includes("classi prime") || lower.includes("classe prima") || lower.includes("prime classi") || lower.includes("cl 1**") || lower.includes("classi 1")) {
    grades.add(1);
  }
  if (lower.includes("classi seconde") || lower.includes("classe seconda") || lower.includes("seconde classi") || lower.includes("classi 2")) {
    grades.add(2);
  }
  if (lower.includes("classi terze") || lower.includes("classe terza") || lower.includes("terze classi") || lower.includes("classi 3")) {
    grades.add(3);
  }
  if (lower.includes("classi quarte") || lower.includes("classe quarta") || lower.includes("quarte classi") || lower.includes("classi 4")) {
    grades.add(4);
  }
  if (lower.includes("classi quinte") || lower.includes("classe quinta") || lower.includes("quinte classi") || lower.includes("classi 5")) {
    grades.add(5);
  }

  return Array.from(grades);
}

/**
 * Risolve la sede / luogo per un impegno.
 * Regola:
 * - Se un luogo è esplicitato nella circolare (es. "Aula Magna", "Plesso Bonifazi", "Google Meet", "Palestra"): lo mantiene.
 * - Se il luogo non è specificato (vuoto, "Sede", "Propria Sede", "Da definire", "Non specificato"):
 *   inserisce il luogo scelto dall'utente nella sede impostata (defaultCampus o campuses[0]).
 */
export function resolveLocation(
  itemLocation: string | undefined | null,
  userDefaultCampus: string | undefined
): string {
  const loc = (itemLocation || "").trim();
  const fallback = (userDefaultCampus || "Sede Centrale").trim();

  if (!loc) {
    return fallback;
  }

  const locLower = loc.toLowerCase();
  const isGeneric =
    locLower === "sede" ||
    locLower === "propria sede" ||
    locLower === "plesso" ||
    locLower === "in sede" ||
    locLower === "da definire" ||
    locLower === "non specificato" ||
    locLower === "n/d" ||
    locLower === "-";

  if (isGeneric) {
    return fallback;
  }

  return loc;
}

export interface RelevanceEvaluation {
  relevance: "VERDE" | "GIALLO" | "ROSSO";
  relevanceReason: string;
  detectedClasses: string[];
  primaryClass?: string;
  location: string;
  selectedForImport: boolean;
}

/**
 * Valuta rigorosamente la pertinenza di un impegno estratto da una circolare
 * rispetto al profilo del docente e alle sue classi di appartenenza.
 * 
 * CASO CRITICO:
 * Se il docente ha impostato ad esempio 3E e 3D, e l'avviso o impegno riguarda 1D:
 * 1D NON appartiene alle classi del docente, quindi l'avviso DEVE ESSERE CLASSIFICATO IN 'ROSSO'
 * e NON deve essere selezionato per l'importazione.
 */
export function evaluateItemRelevance(
  item: {
    title: string;
    category?: string;
    className?: string;
    notes?: string;
    rawSnippet?: string;
    location?: string;
    relevance?: "VERDE" | "GIALLO" | "ROSSO";
    relevanceReason?: string;
  },
  profile: TeacherProfile,
  chosenLocation?: string
): RelevanceEvaluation {
  const combinedText = `${item.title || ""} ${item.className || ""} ${item.notes || ""} ${item.rawSnippet || ""}`.trim();
  const lower = combinedText.toLowerCase();

  // 1. Normalizzazione delle classi del docente
  const userClasses = (profile.classes || []).map((c) => c.trim().toUpperCase()).filter(Boolean);
  const userGrades = userClasses.map((c) => parseInt(c[0], 10)).filter((n) => !isNaN(n));

  // 2. Risoluzione della Sede / Luogo impostato dall'utente
  const effectiveCampus = chosenLocation || profile.campuses?.[0] || "Sede Centrale";
  const resolvedLoc = resolveLocation(item.location, effectiveCampus);

  // 3. Estrazione delle classi menzionate nell'impegno
  const detected = extractClassesFromText(combinedText);
  if (item.className && !detected.includes(item.className.toUpperCase())) {
    detected.unshift(item.className.toUpperCase());
  }

  // 4. Estrazione di gradi (es. "classi prime", "classi terze")
  const mentionedGrades = extractGradesFromText(combinedText);

  const userSchoolLevel = (profile.schoolLevel || "ssig").toLowerCase();
  const userSubjects = (profile.primarySubjects || []).map((s) => s.toLowerCase());
  const isSupportDocente = userSubjects.some((s) => s.includes("sostegno")) || Boolean(profile.isSupportTeacher);

  // REGOLA 1: PERTINENZA DIRETTA SU CLASSI SPECIFICHE (PRIORITÀ ASSOLUTA)
  // Se l'impegno o l'avviso menziona una o più classi specifiche:
  if (detected.length > 0) {
    const matchedClasses = detected.filter((c) => userClasses.includes(c));
    const foreignClasses = detected.filter((c) => !userClasses.includes(c));

    if (matchedClasses.length > 0) {
      // Almeno una classe appartiene al docente!
      return {
        relevance: "VERDE",
        relevanceReason: `Attività pertinente per la tua classe ${matchedClasses.join(", ")}`,
        detectedClasses: detected,
        primaryClass: matchedClasses[0],
        location: resolvedLoc,
        selectedForImport: true,
      };
    } else {
      // L'avviso riguarda classi specifiche MA NESSUNA appartiene al docente! (Es. 1D con docente 3E, 3D)
      const classesListStr = userClasses.length > 0 ? userClasses.join(", ") : "Nessuna";
      return {
        relevance: "ROSSO",
        relevanceReason: `Avviso/impegno per ${foreignClasses.join(", ")} (non presente tra le tue classi: ${classesListStr})`,
        detectedClasses: detected,
        primaryClass: foreignClasses[0],
        location: resolvedLoc,
        selectedForImport: false,
      };
    }
  }

  // REGOLA 2: PERTINENZA SU ANNO DI CORSO (es. "Classi Prime", "Classi Seconde", "Classi Terze")
  if (mentionedGrades.length > 0 && userGrades.length > 0) {
    const hasMatchingGrade = mentionedGrades.some((g) => userGrades.includes(g));
    if (!hasMatchingGrade) {
      const gradeLabels = mentionedGrades.map((g) => (g === 1 ? "prime" : g === 2 ? "seconde" : g === 3 ? "terze" : `${g}°`)).join(", ");
      const userGradesLabels = Array.from(new Set(userGrades)).map((g) => (g === 1 ? "prime" : g === 2 ? "seconde" : g === 3 ? "terze" : `${g}°`)).join(", ");
      return {
        relevance: "ROSSO",
        relevanceReason: `Attività riservata alle classi ${gradeLabels} (le tue classi sono in: ${userGradesLabels})`,
        detectedClasses: [],
        location: resolvedLoc,
        selectedForImport: false,
      };
    }
  }

  // REGOLA 3: STAFF DI DIRIGENZA
  if (lower.includes("staff") || lower.includes("dirigenza") || lower.includes("collaboratori del dirigente")) {
    const isUserInStaff = (profile.roles || []).some(
      (r) => r.role === "coordinatore" && r.description?.toLowerCase().includes("staff")
    );
    if (!isUserInStaff) {
      return {
        relevance: "ROSSO",
        relevanceReason: "Riservato ai componenti dello Staff di Dirigenza",
        detectedClasses: [],
        location: resolvedLoc,
        selectedForImport: false,
      };
    }
  }

  // REGOLA 4: GRADO SCOLASTICO (INFANZIA, PRIMARIA, SSIG, SSIIG)
  const isPrimariaOnly = lower.includes("primaria") && !lower.includes("ssig");
  const isSsigOnly =
    (lower.includes("ssig") || lower.includes("secondaria di primo grado") || lower.includes("secondaria 1 grado")) &&
    !lower.includes("primaria");
  const isSsiigOnly =
    lower.includes("ssiig") || lower.includes("secondaria di secondo grado") || lower.includes("secondaria 2 grado");

  if (userSchoolLevel === "ssig") {
    if (isPrimariaOnly) {
      return {
        relevance: "ROSSO",
        relevanceReason: "Attività riservata alla Scuola Primaria (tu insegni in SSIG)",
        detectedClasses: [],
        location: resolvedLoc,
        selectedForImport: false,
      };
    }
    if (isSsiigOnly) {
      return {
        relevance: "ROSSO",
        relevanceReason: "Attività riservata alla Secondaria di II Grado (tu insegni in SSIG)",
        detectedClasses: [],
        location: resolvedLoc,
        selectedForImport: false,
      };
    }
  } else if (userSchoolLevel === "primaria") {
    if (isSsigOnly) {
      return {
        relevance: "ROSSO",
        relevanceReason: "Attività riservata alla Secondaria di I Grado (tu insegni in Primaria)",
        detectedClasses: [],
        location: resolvedLoc,
        selectedForImport: false,
      };
    }
    if (isSsiigOnly) {
      return {
        relevance: "ROSSO",
        relevanceReason: "Attività riservata alla Secondaria di II Grado (tu insegni in Primaria)",
        detectedClasses: [],
        location: resolvedLoc,
        selectedForImport: false,
      };
    }
  }

  // REGOLA 5: DOCENTI TUTTI / COLLEGIO PLENARIO
  const isDocentiTutti =
    item.category === "collegio_docenti" ||
    lower.includes("collegio docenti") ||
    lower.includes("docenti=tutti") ||
    lower.includes("docenti: tutti") ||
    lower.includes("docenti tutti") ||
    lower.includes("tutti i docenti") ||
    lower.includes("a tutto il personale docente");

  if (isDocentiTutti) {
    return {
      relevance: "VERDE",
      relevanceReason: "Impegno obbligatorio per tutti i docenti dell'istituto (Docenti: TUTTI)",
      detectedClasses: [],
      location: resolvedLoc,
      selectedForImport: true,
    };
  }

  // REGOLA 6: DIPARTIMENTI DISCIPLINARI / SOSTEGNO
  if (lower.includes("dipartimento") || item.category === "dipartimento" || item.category === "dipartimento_sostegno") {
    const mentionsSostegno = lower.includes("sostegno") || lower.includes("inclusione");
    if (isSupportDocente && mentionsSostegno) {
      return {
        relevance: "VERDE",
        relevanceReason: "Dipartimento Sostegno e Inclusione (pertinente per il tuo profilo)",
        detectedClasses: [],
        location: resolvedLoc,
        selectedForImport: true,
      };
    }
    // Verifica materie curricolari
    const mentionsMySubject = userSubjects.some((s) => s.length > 3 && lower.includes(s));
    if (mentionsMySubject) {
      return {
        relevance: "VERDE",
        relevanceReason: "Dipartimento disciplinare della tua materia",
        detectedClasses: [],
        location: resolvedLoc,
        selectedForImport: true,
      };
    }
  }

  // REGOLA 7: ATTIVITÀ DEL PROPRIO GRADO (SENZA CLASSI ESPLICITE)
  if (userSchoolLevel === "ssig" && isSsigOnly) {
    return {
      relevance: "VERDE",
      relevanceReason: "Attività di competenza della Secondaria di I Grado (SSIG)",
      detectedClasses: [],
      location: resolvedLoc,
      selectedForImport: true,
    };
  }
  if (userSchoolLevel === "primaria" && isPrimariaOnly) {
    return {
      relevance: "VERDE",
      relevanceReason: "Attività di competenza della Scuola Primaria",
      detectedClasses: [],
      location: resolvedLoc,
      selectedForImport: true,
    };
  }

  // DEFAULT: Se era già contrassegnato con un valore specifico manteniamo ma con location risolta
  const baseRelevance = item.relevance || "GIALLO";
  return {
    relevance: baseRelevance,
    relevanceReason: item.relevanceReason || "Impegno generale d'istituto",
    detectedClasses: [],
    location: resolvedLoc,
    selectedForImport: baseRelevance === "VERDE",
  };
}
