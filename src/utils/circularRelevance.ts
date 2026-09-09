import type { TeacherProfile } from "../types";

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
  const explicitClassRegex = /\b(?:classe|classi|cl\.|sez\.|sezione)\s+(III|II|IV|V|I|[1-5])\s*[\^°ª]?\s*([A-Za-z])\b/gi;
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
const SUBJECT_ALIASES: Record<string, string[]> = {
  "scienze motorie": ["scienze motorie", "educazione fisica", "educazione motoria"],
  "matematica": ["matematica"], "italiano": ["italiano", "lingua italiana"],
  "scienze": ["scienze naturali", "scienze"], "inglese": ["inglese", "lingua inglese"],
  "francese": ["francese"], "spagnolo": ["spagnolo"], "tedesco": ["tedesco"],
  "storia": ["storia"], "geografia": ["geografia"], "tecnologia": ["tecnologia"],
  "arte": ["arte e immagine", "arte"], "musica": ["musica"],
  "religione": ["religione", "irc"], "sostegno": ["sostegno", "inclusione"],
  "fisica": ["fisica"], "chimica": ["chimica"], "informatica": ["informatica"],
  "latino": ["latino"], "greco": ["greco"], "filosofia": ["filosofia"],
};
const normalizeSubject = (s: string) => {
  const lower = s.trim().toLowerCase();
  return Object.keys(SUBJECT_ALIASES).find(key => SUBJECT_ALIASES[key].includes(lower)) || lower;
};

// Generic organizational wording is not an explicit subject restriction.
export const isGenericSubject = (value: string): boolean => /^(?:tutt[ei](?: le| i)? (?:materie|discipline|docenti)|(?:programmazione )?(?:generale )?per materia|generale|materie|discipline|nessuna|non specificat[oa])$/i.test(value.trim());

export function detectSubjects(text: string, profile?: TeacherProfile): string[] {
  let remaining = text.toLowerCase();
  const result = new Set<string>();
  const aliases = Object.entries(SUBJECT_ALIASES).flatMap(([key, values]) => values.map(alias => ({ key, alias })));
  for (const subject of profile?.primarySubjects || []) aliases.push({ key: normalizeSubject(subject), alias: subject.toLowerCase() });
  // Consume longer phrases first: "scienze motorie" must not also match "scienze".
  for (const { key, alias } of aliases.sort((a, b) => b.alias.length - a.alias.length)) {
    if (!alias.trim()) continue;
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    if (regex.test(remaining)) { result.add(key); remaining = remaining.replace(regex, ' '); }
  }
  return [...result];
}

export function evaluateItemRelevance(
  item: { title: string; category?: string; className?: string; subject?: string; notes?: string;
    rawSnippet?: string; location?: string; relevance?: "VERDE" | "GIALLO" | "ROSSO"; relevanceReason?: string },
  profile: TeacherProfile, chosenLocation?: string
): RelevanceEvaluation {
  const text = `${item.title || ''} ${item.className || ''} ${item.subject || ''} ${item.notes || ''} ${item.rawSnippet || ''}`;
  const lower = text.toLowerCase();
  const detected = extractClassesFromText(text);
  const userClasses = (profile.classes || []).flatMap(c => extractClassesFromText(c));
  const matched = detected.filter(c => userClasses.includes(c));
  const result = (relevance: "VERDE" | "GIALLO" | "ROSSO", reason: string): RelevanceEvaluation => ({
    relevance, relevanceReason: reason, detectedClasses: detected,
    primaryClass: matched[0] || detected[0],
    location: (item.location || chosenLocation || '').trim(),
    selectedForImport: relevance === 'VERDE',
  });
  const levels = [
    /\binfanzia\b/.test(lower) ? 'infanzia' : '',
    /\bprimaria\b/.test(lower) ? 'primaria' : '',
    /\bssig\b|secondaria di (?:primo|i|1[°º]?) grado/.test(lower) ? 'ssig' : '',
    /\bssiig\b|secondaria di (?:secondo|ii|2[°º]?) grado/.test(lower) ? 'ssiig' : '',
  ].filter(Boolean);
  if (levels.length && profile.schoolLevel && !levels.includes(profile.schoolLevel)) return result('ROSSO', "Destinato a un altro ordine scolastico.");
  if (/staff|collaboratori del dirigente/.test(lower) && !(profile.roles || []).some(r => /staff/i.test(r.description || ''))) return result('ROSSO', "Riservato allo staff di dirigenza.");
  if (/riservat[oaie].*coordinator|soli coordinatori/.test(lower) && !(profile.roles || []).some(r => r.role === 'coordinatore' && (!r.targetClass || matched.includes(r.targetClass)))) return result('ROSSO', "Riservato ai coordinatori delle classi indicate.");
  if (detected.length && !matched.length) return result('ROSSO', `Destinato alle classi ${detected.join(', ')}, non assegnate al docente.`);
  const grades = extractGradesFromText(text);
  if (grades.length && !userClasses.some(c => grades.includes(Number(c[0])))) return result('ROSSO', "Destinato a un altro anno di corso.");

  const subjects = detectSubjects(text, profile);
  const explicitSubjects = (item.subject || '').split(/[,;]/).map(s => s.trim()).filter(s => s && !isGenericSubject(s)).map(normalizeSubject);
  const targetedSubjects = explicitSubjects.length ? explicitSubjects : subjects;
  const ownSubjects = (profile.primarySubjects || []).flatMap(s => { const detected = detectSubjects(s); return detected.length ? detected : [normalizeSubject(s)]; });
  if (profile.isSupportTeacher) ownSubjects.push('sostegno');
  if (targetedSubjects.length && !targetedSubjects.some(s => ownSubjects.includes(s))) return result('ROSSO', `Destinato ad altra materia: ${targetedSubjects.join(', ')}.`);
  if (/facoltativ|chi non impegnato/.test(lower)) return result('GIALLO', "Partecipazione facoltativa o subordinata ad altri impegni.");
  if (matched.length) return result('VERDE', `Pertinente per ${matched.join(', ')}${targetedSubjects.length ? ' e per la materia del docente' : ''}.`);
  if (targetedSubjects.some(s => ownSubjects.includes(s))) return result('VERDE', "Pertinente per la materia del docente.");
  if (item.category === 'collegio_docenti' || /tutti i docenti|docenti\s*[:=]?\s*tutti|collegio docenti/.test(lower)) return result('VERDE', "Destinato a tutti i docenti.");
  // A school level alone does not prove membership of a department or commission.
  if (/dipartiment|commission/.test(lower)) return result('GIALLO', "Verifica materia o appartenenza al gruppo prima di importare.");
  if (levels.length) return result('GIALLO', "Ordine scolastico pertinente: verifica i destinatari dell'attività.");
  return result('GIALLO', "Destinatari non sufficientemente specificati: verifica la pertinenza.");
}
