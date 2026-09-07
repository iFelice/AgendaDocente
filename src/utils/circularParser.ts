import type { ExtractedItem, TeacherProfile, EventCategory } from "../types";
import { evaluateItemRelevance, extractClassesFromText, detectSubjects } from "./circularRelevance";
import { eventDateError, isValidDate, isValidTime } from "./dates";

const categories: EventCategory[] = ["lezione", "consiglio_classe", "collegio_docenti", "dipartimento", "dipartimento_sostegno", "glo", "pei", "riunione", "ricevimento_genitori", "formazione", "scadenza", "promemoria", "personale"];
const datePattern = /\b(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{4}|\d{2}))?\b/g;
const timePattern = /\b([01]?\d|2[0-3])[.:]([0-5]\d)(?:\s*(?:[-–—]|alle|a)\s*([01]?\d|2[0-3])[.:]([0-5]\d))?\b/i;
const months = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

function yearForMonth(month: number, profile: TeacherProfile): number {
  const year = /^(\d{4})\/(\d{4})$/.exec(profile.schoolYear || "");
  return year ? Number(year[month >= 8 ? 1 : 2]) : new Date().getFullYear();
}

function extractDate(line: string, profile: TeacherProfile): { date: string; text: string } | null {
  // Remove clock times first: 09.00 must never be interpreted as a date.
  // Explicit dotted dates are protected before removing times.
  const explicit = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(line)
    || /\b(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})\b/.exec(line);
  const withoutTimes = explicit ? line : line.replace(new RegExp(timePattern.source, 'gi'), '');
  datePattern.lastIndex = 0;
  const numeric = explicit || datePattern.exec(withoutTimes);
  const named = new RegExp(`\\b(\\d{1,2})\\s+(${months.join('|')})(?:\\s+(\\d{4}))?\\b`, 'i').exec(line);
  const match = numeric || named;
  if (!match) return null;
  const day = Number(match[1]);
  const month = numeric ? Number(match[2]) : months.indexOf(match[2].toLowerCase()) + 1;
  const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : yearForMonth(month, profile);
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { date: isValidDate(iso) ? iso : '', text: match[0] };
}

export function extractedItemError(item: Pick<ExtractedItem, 'title' | 'date' | 'startTime' | 'endTime' | 'isDeadline'>): string | null {
  if (!item.title.trim()) return "Inserisci un titolo.";
  return eventDateError({ ...item, isAllDay: !!item.isDeadline });
}

export function normalizeExtractedItems(input: unknown, profile: TeacherProfile, location?: string): ExtractedItem[] {
  if (!Array.isArray(input)) throw new Error("Risposta analisi non valida.");
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string') throw new Error("Impegno estratto non valido.");
    const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
    const time = (v: unknown) => {
      const normalized = str(v).replace('.', ':').replace(/^(\d):/, '0$1:');
      return isValidTime(normalized) ? normalized : undefined;
    };
    const item: ExtractedItem = {
      tempId: `extracted-${Date.now()}-${index}`,
      title: str(raw.title),
      category: categories.includes(raw.category) ? raw.category : 'riunione',
      date: isValidDate(raw.date) ? raw.date : '',
      startTime: time(raw.startTime), endTime: time(raw.endTime),
      className: str(raw.className), subject: str(raw.subject), location: str(raw.location),
      notes: str(raw.notes), rawSnippet: str(raw.rawSnippet),
      isDeadline: raw.isDeadline === true || raw.category === 'scadenza',
      relevance: ['VERDE', 'GIALLO', 'ROSSO'].includes(raw.relevance) ? raw.relevance : 'GIALLO',
      relevanceReason: str(raw.relevanceReason), selectedForImport: false,
    };
    const evaluation = evaluateItemRelevance(item, profile, location);
    Object.assign(item, { relevance: evaluation.relevance, relevanceReason: evaluation.relevanceReason, location: evaluation.location, className: evaluation.primaryClass || item.className });
    item.selectedForImport = evaluation.selectedForImport && !extractedItemError(item);
    return item;
  });
}

/** Conservative text fallback. Complex table layout is left for human/cloud review. */
export function parseCircularText(text: string, profile: TeacherProfile, location?: string): ExtractedItem[] {
  const items: Partial<ExtractedItem>[] = [];
  let currentDate = '';
  for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
    const foundDate = extractDate(line, profile);
    if (foundDate) currentDate = foundDate.date;
    const content = foundDate ? line.replace(foundDate.text, '').trim() : line;
    const time = timePattern.exec(content);
    const lower = content.toLowerCase();
    const classes = extractClassesFromText(content);
    const activity = /collegio|consigl[io]|dipartiment|riunion|formazion|scadenz|\bentro\b|consegn|ricevimento|\bglo\b|\bpei\b|\bpdp\b|aggiornamento classi|sistemazione ambienti|predisposizione|commission|lezion|verific[ah]|interrogazion/i.test(content);
    if (!activity && !(time && classes.length)) continue;
    // An explicit cancellation is never proposed as a new event by this fallback.
    if (/annullat[oaie]|revocat[oaie]/i.test(content)) continue;
    const category: EventCategory = /scadenz|\bentro\b|consegn/.test(lower) ? 'scadenza'
      : /collegio/.test(lower) ? 'collegio_docenti'
      : /consigl/.test(lower) ? 'consiglio_classe'
      : /dipartiment/.test(lower) ? 'dipartimento'
      : /\bglo\b/.test(lower) ? 'glo'
      : /\bpei\b|\bpdp\b/.test(lower) ? 'pei'
      : /formazion/.test(lower) ? 'formazione'
      : /ricevimento|genitori/.test(lower) ? 'ricevimento_genitori' : 'riunione';
    const title = (time ? content.replace(time[0], '') : content).replace(/^\s*[-–:|]+|[|]+\s*$/g, '').trim();
    items.push({ title: title || content, category, date: currentDate,
      startTime: time ? `${time[1].padStart(2,'0')}:${time[2]}` : undefined,
      endTime: time?.[3] ? `${time[3].padStart(2,'0')}:${time[4]}` : undefined,
      className: classes.join(', '), subject: detectSubjects(content, profile).join(', '),
      rawSnippet: line, notes: line, isDeadline: category === 'scadenza', relevance: 'GIALLO',
    });
  }
  return normalizeExtractedItems(items, profile, location);
}
