import type { TeacherProfile } from "../types";
import { isSupportTeacherOf } from "./teacherType";

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
// Una congiunzione italiana ("e", "ed", "a") seguita da un altro anno di corso
// (romano, arabo o parola ordinale) è un connettivo di lista ("classi I e III",
// "classe I, II e III"), non la sezione di una classe: il lookahead negativo evita
// di leggere quella "e"/"a" come sigla (es. "1E" inventata da "I e III").
const NOT_GRADE_LIST_CONNECTOR = "(?!(?:e|ed|a)\\b\\s*,?\\s*(?:III|IV|II|I|V|[1-5]|prim[ae]|second[ae]|terz[ae]|quart[ae]|quint[ae])\\b)";

export function extractClassesFromText(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  // 1. Sigle standard arabe (1-5 seguito da A-Z)
  // Escludiamo parole come "1H" in contesti di tempo (es. "ore 1h")
  const arabicRegex = new RegExp(`\\b([1-5])\\s*[\\^°ª]?\\s*${NOT_GRADE_LIST_CONNECTOR}([A-Za-z])\\b`, "g");
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

  // 2. Sigle con numeri romani (I, II, III, IV, V seguito da lettera).
  // L'ordine delle alternative è decrescente per lunghezza: senza di esso "IV" verrebbe
  // letto come romano "I" + sezione "V", inventando la classe "1V" (vedi anno romano).
  const romanRegex = new RegExp(`\\b(III|IV|II|I|V)\\b\\s*[\\^°ª]?\\s*${NOT_GRADE_LIST_CONNECTOR}([A-Za-z])\\b`, "g");
  while ((match = romanRegex.exec(text)) !== null) {
    const roman = match[1].toUpperCase();
    const section = match[2].toUpperCase();
    const grade = ROMAN_TO_NUM[roman];
    if (grade && section.length === 1 && /[A-Z]/.test(section)) {
      found.add(`${grade}${section}`);
    }
  }

  // 3. Pattern espliciti con parola "classe" / "classi" / "sezione"
  // Anche qui i romani sono ordinati dal più lungo al più corto e chiusi da \b:
  // "classi IV" non deve mai diventare "1V" (romano "I" + finta sezione "V").
  const explicitClassRegex = new RegExp(`\\b(?:classe|classi|cl\\.|sez\\.|sezione)\\s+(?:(III|IV|II|I|V)\\b|([1-5]))\\s*[\\^°ª]?\\s*${NOT_GRADE_LIST_CONNECTOR}([A-Za-z])\\b`, "gi");
  while ((match = explicitClassRegex.exec(text)) !== null) {
    let grade = (match[1] || match[2]).toUpperCase();
    if (ROMAN_TO_NUM[grade]) grade = ROMAN_TO_NUM[grade];
    const section = match[3].toUpperCase();
    if (/[1-5]/.test(grade) && /[A-Z]/.test(section)) {
      found.add(`${grade}${section}`);
    }
  }

  return Array.from(found);
}

// Parole ordinali italiane usate per indicare un anno di corso senza sigla di sezione.
// Le forme femminili ("prima/prime"...) accompagnano "classe/classi"; le forme
// maschili ("primo"...) accompagnano "anno" (es. "primo anno", "1° anno").
const GRADE_WORD_TO_NUM: Record<string, number> = {
  prima: 1, prime: 1, primo: 1,
  seconda: 2, seconde: 2, secondo: 2,
  terza: 3, terze: 3, terzo: 3,
  quarta: 4, quarte: 4, quarto: 4,
  quinta: 5, quinte: 5, quinto: 5,
};

/** Un singolo token di anno di corso: romano, arabo (1-5) o parola ordinale. */
const GRADE_TOKEN = "(?:III\\b|IV\\b|II\\b|I\\b|V\\b|[1-5]\\b[\\^°ª]?|prim[ae]\\b|second[ae]\\b|terz[ae]\\b|quart[ae]\\b|quint[ae]\\b|primo\\b|secondo\\b|terzo\\b|quarto\\b|quinto\\b)";
// Separatori ammessi tra più anni elencati: virgola, " e ", trattino (per i range "I-III").
const GRADE_SEP = "(?:\\s*,\\s*|\\s+e\\s+|\\s*-\\s*)";
// Fino a 4 token aggiuntivi: sufficiente per le forme reali delle circolari
// ("classi I, II e III") senza rischiare un pattern catastrofico.
const GRADE_LIST = `${GRADE_TOKEN}(?:${GRADE_SEP}${GRADE_TOKEN}){0,4}`;

function parseGradeToken(raw: string): number | null {
  const token = raw.trim().replace(/[\^°ª]/g, "");
  if (!token) return null;
  if (ROMAN_TO_NUM[token.toUpperCase()]) return Number(ROMAN_TO_NUM[token.toUpperCase()]);
  if (/^[1-5]$/.test(token)) return Number(token);
  const word = GRADE_WORD_TO_NUM[token.toLowerCase()];
  return word ?? null;
}

/** Interpreta una lista di anni ("I e III", "I, II e III", "I-III") in numeri di anno. */
function parseGradeList(listText: string): number[] {
  const grades: number[] = [];
  const parts = listText.split(/\s*,\s*|\s+e\s+/i).map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const rangeMatch = /^(.+?)\s*-\s*(.+)$/.exec(part);
    if (rangeMatch) {
      const a = parseGradeToken(rangeMatch[1]);
      const b = parseGradeToken(rangeMatch[2]);
      if (a !== null && b !== null) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        for (let g = lo; g <= hi; g++) grades.push(g);
        continue;
      }
    }
    const g = parseGradeToken(part);
    if (g !== null) grades.push(g);
  }
  return grades;
}

/**
 * Rileva riferimenti all'anno di corso: numeri romani ("classi IV"), parole ordinali
 * ("classi prime", "classi prime e terze"), liste ("classi I e III", "classi I, II e III",
 * "classi I-III") e la forma "N° anno" / "primo e terzo anno".
 */
export function extractGradesFromText(text: string): number[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const grades = new Set<number>();

  // Liste di anni dopo "classi/classe/cl.": "classi IV", "classi I e III",
  // "classi I, II e III", "classi I-III", "classi prime e terze"...
  // Il lookahead negativo lascia le sigle complete ("classe III E") a extractClassesFromText:
  // se il token/lista è immediatamente seguito da una lettera di sezione, non è un anno isolato.
  const gradeListRegex = new RegExp(`\\b(?:classi|classe|cl\\.)\\s+(${GRADE_LIST})(?!\\s*[\\^°ª]?\\s*[A-Za-z]\\b)`, "gi");
  let listMatch: RegExpExecArray | null;
  while ((listMatch = gradeListRegex.exec(text)) !== null) {
    for (const g of parseGradeList(listMatch[1])) grades.add(g);
  }

  // Forma "1° e 3° anno" / "primo e terzo anno" (senza la parola "classi").
  const annoListRegex = new RegExp(`\\b(${GRADE_LIST})\\s+anno\\b`, "gi");
  let annoMatch: RegExpExecArray | null;
  while ((annoMatch = annoListRegex.exec(text)) !== null) {
    for (const g of parseGradeList(annoMatch[1])) grades.add(g);
  }

  // Fallback testuale per forme sparse (ordine inverso, "cl 1**", sigla senza "classi").
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
 * Normalizza il campo strutturato `recipientGrades` prodotto dall'AI: accetta solo
 * interi 1..5, deduplicati e ordinati. Qualunque altro valore (stringhe, 0, 8,
 * decimali, non-array) viene scartato senza invalidare gli altri.
 */
export function normalizeRecipientGrades(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const grades = new Set<number>();
  for (const raw of input) {
    const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^[1-5]$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
    if (Number.isInteger(value) && value >= 1 && value <= 5) grades.add(value);
  }
  return Array.from(grades).sort((a, b) => a - b);
}

/**
 * Normalizza il campo strutturato `recipientClasses`: solo classi COMPLETE
 * anno+sezione, riportate in formato canonico ("III E" -> "3E") tramite la stessa
 * utility usata per il testo. Un anno isolato ("IV", "I", "III") non è una classe e
 * viene scartato: un "IV" del documento resta un anno di corso e non diventa la
 * finta sigla "1V". Le sezioni reali con lettera V ("1V", "3V") restano valide.
 */
export function normalizeRecipientClasses(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const classes = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    // Un token puramente romano è un anno di corso, non una classe.
    // (lo spazio non viene rimosso: "III V" è una classe, non un anno isolato)
    if (/^[IVX]+$/i.test(value.replace(/[\^°ª]/g, '').trim())) continue;
    // Una sezione "V" è legittima ("1V", "3V"): l'artefatto "IV" -> "1V" è già
    // escluso dal filtro sui romani isolati e dalla distinzione anno/classe.
    for (const candidate of extractClassesFromText(value)) classes.add(candidate);
  }
  return Array.from(classes);
}

/**
 * Incrocia gli anni di corso rilevati nel documento con le classi assegnate al docente:
 * un anno è "pertinente" se il docente ha almeno una classe appartenente a quell'anno
 * (es. anno 3 è pertinente se il docente ha "3E").
 */
export function matchGradesToClasses(grades: number[], userClasses: string[]): number[] {
  return grades.filter(grade => userClasses.some(c => Number(c[0]) === grade));
}

const ORDINAL_GRADE_LABEL: Record<number, string> = { 1: '1°', 2: '2°', 3: '3°', 4: '4°', 5: '5°' };

/**
 * Motivo breve e comprensibile quando un docente di sostegno è pertinente a un'attività
 * grazie all'anno di corso (e non a una sigla di classe completa): mai "altra materia".
 */
function supportGradeReason(matchedGrades: number[]): string {
  const sorted = Array.from(new Set(matchedGrades)).sort((a, b) => a - b);
  if (sorted.length === 1) {
    return `Pertinente per il ${ORDINAL_GRADE_LABEL[sorted[0]] ?? `${sorted[0]}°`} anno, in cui il docente ha una classe assegnata.`;
  }
  const labels = sorted.map(g => ORDINAL_GRADE_LABEL[g] ?? `${g}°`);
  const joined = labels.length === 2
    ? `${labels[0]} e ${labels[1]}`
    : `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`;
  return `Pertinente per le classi del ${joined} anno assegnate al docente di sostegno.`;
}

export interface RelevanceEvaluation {
  relevance: "VERDE" | "GIALLO" | "ROSSO";
  relevanceReason: string;
  detectedClasses: string[];
  primaryClass?: string;
  location: string;
  selectedForImport: boolean;
  /**
   * true quando il documento stesso (titolo/note/snippet) contiene evidenza di classi o
   * di anno di corso: in quel caso il campo `className` prodotto dal modello non è
   * autorevole e non deve essere usato come fallback né conservato se discordante.
   */
  documentClassEvidence: boolean;
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
    rawSnippet?: string; location?: string; relevance?: "VERDE" | "GIALLO" | "ROSSO"; relevanceReason?: string;
    recipientGrades?: number[]; recipientClasses?: string[] },
  profile: TeacherProfile, chosenLocation?: string
): RelevanceEvaluation {
  // Evidenza documentale (titolo, materia, note, snippet) e metadata del modello
  // restano separati: una classe allucinata in `className` (p.es. "1V" da un "IV" del
  // documento) non deve contaminare la rilevazione quando il testo è già esplicito.
  const documentEvidence = `${item.title || ''} ${item.subject || ''} ${item.notes || ''} ${item.rawSnippet || ''}`;
  const modelClassEvidence = item.className || '';
  const text = `${documentEvidence} ${modelClassEvidence}`;
  const lower = text.toLowerCase();
  // Gerarchia delle evidenze sui destinatari:
  //   1. campi strutturati recipientClasses / recipientGrades (l'AI li ricava anche da
  //      intestazioni o paragrafi collegati, non ripetuti nella riga dell'evento);
  //   2. classi/anni ricavati deterministicamente da title/subject/notes/rawSnippet;
  //   3. className del modello, solo come ultimo fallback.
  const structuredClasses = normalizeRecipientClasses(item.recipientClasses);
  const structuredGrades = normalizeRecipientGrades(item.recipientGrades);
  const structuredEvidence = structuredClasses.length > 0 || structuredGrades.length > 0;
  const textClasses = extractClassesFromText(documentEvidence);
  const textGrades = extractGradesFromText(documentEvidence);
  // Il documento parla (sigla completa o solo anno di corso): il modello non aggiunge nulla.
  const documentClassEvidence = structuredEvidence || textClasses.length > 0 || textGrades.length > 0;
  // Unione senza duplicati fra evidenza strutturata e testuale: recipientGrades [1,3]
  // con un rawSnippet che cita "classi III" resta [1,3].
  const documentClasses = Array.from(new Set([...structuredClasses, ...textClasses]));
  const documentGrades = Array.from(new Set([...structuredGrades, ...textGrades])).sort((a, b) => a - b);
  const detected = documentClassEvidence ? documentClasses : extractClassesFromText(modelClassEvidence);
  const grades = documentClassEvidence ? documentGrades : extractGradesFromText(modelClassEvidence);
  const userClasses = (profile.classes || []).flatMap(c => extractClassesFromText(c));
  const matched = detected.filter(c => userClasses.includes(c));
  // Anni di corso rilevati nel documento per cui il docente ha almeno una classe assegnata
  // (es. documento "classi I e III" + docente con una 3E -> anno 3 pertinente).
  const matchedGrades = matchGradesToClasses(grades, userClasses);
  const result = (relevance: "VERDE" | "GIALLO" | "ROSSO", reason: string): RelevanceEvaluation => ({
    relevance, relevanceReason: reason, detectedClasses: detected,
    primaryClass: matched[0] || detected[0],
    location: (item.location || chosenLocation || '').trim(),
    selectedForImport: relevance === 'VERDE',
    documentClassEvidence,
  });
  const levels = [
    /\binfanzia\b/.test(lower) ? 'infanzia' : '',
    /\bprimaria\b/.test(lower) ? 'primaria' : '',
    /\bssig\b|secondaria di (?:primo|i|1[°º]?) grado/.test(lower) ? 'ssig' : '',
    /\bssiig\b|secondaria di (?:secondo|ii|2[°º]?) grado/.test(lower) ? 'ssiig' : '',
  ].filter(Boolean);
  if (levels.length && profile.schoolLevel && !levels.includes(profile.schoolLevel)) return result('ROSSO', "Destinato a un altro ordine scolastico.");
  if (/staff|collaboratori del dirigente/.test(lower) && !(profile.roles || []).some(r => r.role === 'collaboratore_dirigente' || /staff|dirigent/i.test(`${r.description || ''} ${r.label || ''}`))) return result('ROSSO', "Riservato allo staff di dirigenza.");
  if (/riservat[oaie].*coordinator|soli coordinatori/.test(lower) && !(profile.roles || []).some(r => r.role === 'coordinatore' && (!r.targetClass || matched.includes(r.targetClass)))) return result('ROSSO', "Riservato ai coordinatori delle classi indicate.");
  if (detected.length && !matched.length) return result('ROSSO', `Destinato alle classi ${detected.join(', ')}, non assegnate al docente.`);
  if (grades.length && !matchedGrades.length) return result('ROSSO', "Destinato a un altro anno di corso.");

  const subjects = detectSubjects(text, profile);
  const explicitSubjects = (item.subject || '').split(/[,;]/).map(s => s.trim()).filter(s => s && !isGenericSubject(s)).map(normalizeSubject);
  const targetedSubjects = explicitSubjects.length ? explicitSubjects : subjects;
  const ownSubjects = (profile.primarySubjects || []).flatMap(s => { const detected = detectSubjects(s); return detected.length ? detected : [normalizeSubject(s)]; });
  if (isSupportTeacherOf(profile)) ownSubjects.push('sostegno');
  if (targetedSubjects.length && !targetedSubjects.some(s => ownSubjects.includes(s))) {
    // Per un docente di sostegno, una classe o un anno di corso già riconosciuti come
    // pertinenti (vedi i due controlli sopra) restano pertinenti anche quando l'attività
    // appartiene a una materia curricolare diversa dal sostegno: la materia resta solo
    // informativa e non deve trasformare l'impegno in ROSSO (non vale per i docenti
    // curricolari, il cui filtro materia non cambia).
    const supportRelevantByClassOrGrade = isSupportTeacherOf(profile) && (matched.length > 0 || matchedGrades.length > 0);
    if (supportRelevantByClassOrGrade) {
      const reason = matched.length
        ? `Pertinente per ${matched.join(', ')}; docente di sostegno della classe.`
        : supportGradeReason(matchedGrades);
      return result('VERDE', reason);
    }
    return result('ROSSO', `Destinato ad altra materia: ${targetedSubjects.join(', ')}.`);
  }
  if (/facoltativ|chi non impegnato/.test(lower)) return result('GIALLO', "Partecipazione facoltativa o subordinata ad altri impegni.");
  if (matched.length) return result('VERDE', `Pertinente per ${matched.join(', ')}${targetedSubjects.length ? ' e per la materia del docente' : ''}.`);
  if (targetedSubjects.some(s => ownSubjects.includes(s))) return result('VERDE', "Pertinente per la materia del docente.");
  if (item.category === 'collegio_docenti' || /tutti i docenti|docenti\s*[:=]?\s*tutti|collegio docenti/.test(lower)) return result('VERDE', "Destinato a tutti i docenti.");
  // A school level alone does not prove membership of a department or commission.
  if (/dipartiment|commission/.test(lower)) return result('GIALLO', "Verifica materia o appartenenza al gruppo prima di importare.");
  if (levels.length) return result('GIALLO', "Ordine scolastico pertinente: verifica i destinatari dell'attività.");
  return result('GIALLO', "Destinatari non sufficientemente specificati: verifica la pertinenza.");
}

const GRADE_TO_ROMAN: Record<number, string> = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' };

/**
 * Etichetta breve dei destinatari strutturati per la card di analisi
 * ("Destinatari rilevati: classi I e III" oppure "Destinatari rilevati: 3E, 1C").
 * Restituisce null quando il modello non ha riportato alcun destinatario.
 */
export function formatRecipientsLabel(item: { recipientGrades?: number[]; recipientClasses?: string[] }): string | null {
  const classes = normalizeRecipientClasses(item.recipientClasses);
  const grades = normalizeRecipientGrades(item.recipientGrades);
  const parts: string[] = [];
  if (classes.length) parts.push(classes.join(', '));
  if (grades.length) {
    const labels = grades.map(g => GRADE_TO_ROMAN[g]);
    const joined = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`;
    parts.push(`classi ${joined}`);
  }
  return parts.length ? parts.join(' · ') : null;
}
