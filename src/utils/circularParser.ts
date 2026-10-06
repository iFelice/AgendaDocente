import type { ExtractedItem, TeacherProfile, EventCategory } from "../types";
import { evaluateItemRelevance, extractClassesFromText, detectSubjects, isGenericSubject, normalizeRecipientClasses, normalizeRecipientGrades } from "./circularRelevance";
import { isValidDate, isValidTime } from "./dates";

const categories: EventCategory[] = ["lezione", "consiglio_classe", "collegio_docenti", "dipartimento", "dipartimento_sostegno", "glo", "pei", "riunione", "ricevimento_genitori", "formazione", "uscita_didattica", "scadenza", "promemoria", "personale"];
const datePattern = /\b(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{4}|\d{2}))?\b/g;
// Gli orari delle tabelle usano ':' o '.' per i minuti e come separatore
// dell'intervallo il trattino o la BARRA ("15:00/18:15", "17.00/20.15",
// "09.30 - 12.00"), anche con spazi irregolari ("17.00 /20.15"): il primo
// orario è l'inizio, il secondo la fine. "alle"/"a" restano validi.
const timePattern = /\b([01]?\d|2[0-3])[.:]([0-5]\d)(?:\s*(?:[-–—/]|alle|a)\s*([01]?\d|2[0-3])[.:]([0-5]\d))?\b/i;
const months = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

/** Correzione minima e conservativa: attività straordinarie manifestamente non sono lezioni ordinarie. */
export function normalizeCircularCategory(category: unknown, title: string, rawSnippet = ""): EventCategory {
  const normalized = typeof category === "string" && categories.includes(category as EventCategory)
    ? category as EventCategory
    : "riunione";
  if (normalized !== "lezione") return normalized;
  const text = `${title} ${rawSnippet}`.toLocaleLowerCase("it-IT");
  return /\b(giochi matematici|gara didattica|competizione|progetto scolastico|manifestazione)\b/i.test(text)
    ? "promemoria"
    : normalized;
}

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

/**
 * Un impegno estratto da circolare è "senza orario" quando il documento non indica
 * né inizio né fine: in quel caso diventa un evento per l'intera giornata, a
 * prescindere dalla categoria (non serve che sia una scadenza).
 */
export function isUntimedExtractedItem(item: Pick<ExtractedItem, 'startTime' | 'endTime'>): boolean {
  return !item.startTime && !item.endTime;
}

/**
 * Validazione specifica degli elementi estratti da circolare: `eventDateError()`
 * resta invariato per gli altri editor (EventModal, scadenze, ecc.).
 * - nessun orario  -> valido (evento intera giornata);
 * - un solo orario -> errore (intervallo incompleto, mai completato d'ufficio);
 * - entrambi       -> validi solo se HH:MM corretti e fine > inizio.
 */
export function extractedItemError(item: Pick<ExtractedItem, 'title' | 'date' | 'startTime' | 'endTime' | 'isDeadline'>): string | null {
  if (!item.title.trim()) return "Inserisci un titolo.";
  if (!isValidDate(item.date)) return "Inserisci una data valida.";
  const hasStart = !!item.startTime;
  const hasEnd = !!item.endTime;
  if (!hasStart && !hasEnd) return null;
  if (hasStart !== hasEnd || !isValidTime(item.startTime) || !isValidTime(item.endTime)) {
    return "Completa l'ora di inizio e di fine oppure lascia entrambi vuoti.";
  }
  if (item.endTime! <= item.startTime!) return "L'ora di fine deve essere successiva all'ora di inizio.";
  return null;
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
    const rawDeadline = str(raw.deadlineDate);
    const deadlineDate = isValidDate(rawDeadline) ? rawDeadline : undefined;
    const item: ExtractedItem = {
      tempId: `extracted-${Date.now()}-${index}`,
      title: str(raw.title),
      category: normalizeCircularCategory(raw.category, str(raw.title), str(raw.rawSnippet)),
      date: isValidDate(raw.date) ? raw.date : '',
      deadlineDate,
      startTime: time(raw.startTime), endTime: time(raw.endTime),
      className: str(raw.className), subject: isGenericSubject(str(raw.subject)) ? "" : str(raw.subject), location: str(raw.location),
      notes: str(raw.notes), rawSnippet: str(raw.rawSnippet),
      // Destinatari strutturati dell'AI: anni 1..5 deduplicati/ordinati e classi
      // complete in formato canonico. I valori non validi vengono scartati.
      recipientGrades: normalizeRecipientGrades(raw.recipientGrades),
      recipientClasses: normalizeRecipientClasses(raw.recipientClasses),
      isDeadline: raw.isDeadline === true || !!deadlineDate || raw.category === 'scadenza',
      relevance: ['VERDE', 'GIALLO', 'ROSSO'].includes(raw.relevance) ? raw.relevance : 'GIALLO',
      relevanceReason: str(raw.relevanceReason), selectedForImport: false,
    };
    // Only an excerpt containing this activity can provide row-local time evidence.
    // Ambiguous or evidence-free excerpts never keep a neighbouring interval by position:
    // a vertically merged ORARI cell shown once is re-attached above only through the
    // row excerpt, so an excerpt without exactly one interval cannot vouch for any time.
    const fold = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (item.rawSnippet) {
      const rowDate = extractDate(item.rawSnippet, profile);
      const excerpt = rowDate ? item.rawSnippet.replace(rowDate.text, '') : item.rawSnippet;
      const intervals = [...excerpt.matchAll(new RegExp(timePattern.source, 'gi'))];
      const snippetVouchesForRow = !!fold(item.title) && fold(item.rawSnippet).includes(fold(item.title));
      if (intervals.length === 1) {
        const interval = intervals[0];
        if (snippetVouchesForRow) {
          item.startTime = `${interval[1].padStart(2, '0')}:${interval[2]}`;
          item.endTime = interval[3] ? `${interval[3].padStart(2, '0')}:${interval[4]}` : undefined;
        } else if (!item.startTime && interval[3]) {
          // Recupero deterministico dopo la risposta del modello: startTime è vuoto
          // (es. orario scritto con la barra o col punto che il modello non ha letto)
          // e il rawSnippet contiene ESATTAMENTE un intervallo completo: lo compila
          // da lì, nella forma HH:MM. Con zero o più intervalli non si inventa nulla.
          item.startTime = `${interval[1].padStart(2, '0')}:${interval[2]}`;
          item.endTime = `${interval[3].padStart(2, '0')}:${interval[4]}`;
        }
      } else if (snippetVouchesForRow) {
        // Zero or multiple candidate intervals: the row cannot support a unique time.
        // Unica eccezione: snippet a riga singola con più intervalli ("15:00/18:15 e
        // 09.45/13.00") in cui il modello ha riportato ESATTAMENTE il primo intervallo
        // (regola del prompt per la riga con due gruppi di destinatari): l'abbinamento
        // è verificabile, l'orario si conserva e gli altri intervalli restano in notes.
        const first = intervals[0];
        const firstStart = first ? `${first[1].padStart(2, '0')}:${first[2]}` : undefined;
        const firstEnd = first?.[3] ? `${first[3].padStart(2, '0')}:${first[4]}` : undefined;
        const keepsModelFirstInterval = intervals.length > 1
          && !item.rawSnippet.includes('\n')
          && !!item.startTime && !!item.endTime
          && item.startTime === firstStart && item.endTime === firstEnd;
        if (!keepsModelFirstInterval) {
          item.startTime = undefined; item.endTime = undefined;
        }
      }
    }
    // Hard invariant: a closed interval with end <= start (e.g. a duplicated 12:30-12:30)
    // is always treated as incomplete evidence, never as a usable — or auto-selectable — time.
    if (item.startTime && item.endTime && item.endTime <= item.startTime) {
      item.startTime = undefined; item.endTime = undefined;
    }
    const evaluation = evaluateItemRelevance(item, profile, location);
    // Sanificazione del className del modello: se il documento contiene già evidenza di
    // classi o di anno di corso, una sigla discordante inventata dall'AI (p.es. "1V"
    // ottenuto da un "IV" del testo) viene scartata invece di essere conservata.
    const sanitizedClassName = evaluation.primaryClass
      || (evaluation.documentClassEvidence ? (evaluation.detectedClasses.includes(item.className || '') ? item.className : '') : item.className);
    Object.assign(item, { relevance: evaluation.relevance, relevanceReason: evaluation.relevanceReason, location: evaluation.location, className: sanitizedClassName });
    item.selectedForImport = evaluation.selectedForImport && !extractedItemError(item);
    return item;
  });
}

/**
 * Regroups flattened PDF table lines:
 * - a recipient line (PRIMARIA/SSIG/…) absorbs its continuation lines until the next
 *   recipient, a date anchor or a standalone time line;
 * - a standalone time line (an ORARI cell without its own row text) is treated as a
 *   vertically merged cell: it applies to *every* row currently waiting for an interval
 *   inside the same date band, and to no other row. Rows that already carry an inline
 *   interval are visually outside that merged cell and never receive it; a new date
 *   anchor closes the band, so times are never inherited across dates.
 */
function tableLines(text: string): string[] {
  const lines = text.split('\n').map(l => l.trim().replace(/^[-•]\s+/, '')).filter(Boolean);
  const rows: string[] = [];
  const waiters: number[] = [];
  const recipient = /^(?:(?:docenti|destinatari)\s*[:|]?\s*)?(?:PRIMARIA|SSIG|SSIIG|INFANZIA)(?:\s*[/,|]\s*(?:PRIMARIA|SSIG|SSIIG|INFANZIA|DOCENTI))*$/i;
  const standaloneTime = new RegExp(`^(?:ore\\s+)?${timePattern.source}$`, 'i');
  const dateLike = /\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b|\b\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/i;
  const hasOwnInterval = (s: string) => new RegExp(timePattern.source, 'i').test(s);
  let current: string[] | null = null;
  const closeCurrent = () => {
    if (!current) return;
    const row = current.join(' ');
    current = null;
    rows.push(row);
    if (!hasOwnInterval(row)) waiters.push(rows.length - 1);
  };
  for (const line of lines) {
    const isTimeLine = standaloneTime.test(line);
    // Only neutral description lines extend the recipient row. Any line that starts a new
    // visual row (recipient prefix, table separator, own interval or date) closes it instead.
    const isRowStart = recipient.test(line) || /PRIMARIA|SSIG|SSIIG|INFANZIA/i.test(line)
      || line.includes('|') || (hasOwnInterval(line) && !isTimeLine) || dateLike.test(line);
    if (current && !isRowStart) { current.push(line); continue; }
    closeCurrent();
    if (recipient.test(line)) { current = [line]; continue; }
    if (isTimeLine) {
      // One merged ORARI cell serves all rows visually contained in it.
      if (waiters.length) {
        for (const index of waiters) rows[index] = `${rows[index]} | ${line}`;
        waiters.length = 0;
      } else rows.push(line);
      continue;
    }
    if (dateLike.test(line)) { waiters.length = 0; rows.push(line); continue; }
    rows.push(line);
    if (hasOwnInterval(line)) waiters.length = 0;
  }
  closeCurrent();
  return rows;
}

/** Conservative text fallback. Complex table layout is left for human/cloud review. */
export function parseCircularText(text: string, profile: TeacherProfile, location?: string): ExtractedItem[] {
  const items: Partial<ExtractedItem>[] = [];
  let currentDate = '';
  for (const line of tableLines(text)) {
    const foundDate = extractDate(line, profile);
    if (foundDate) currentDate = foundDate.date;
    const content = foundDate ? line.replace(foundDate.text, '').trim() : line;
    const time = timePattern.exec(content);
    const lower = content.toLowerCase();
    const classes = extractClassesFromText(content);
    const activity = /collegio|consigl[io]|dipartiment|riunion|formazion|scadenz|\bentro\b|consegn|ricevimento|\bglo\b|\bpei\b|\bpdp\b|aggiornamento classi|sistemazione ambienti|predisposizione|programmazione|interclasse|commission|lezion|verific[ah]|interrogazion/i.test(content);
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
    const isDeadline = category === 'scadenza';
    const deadlineDate = isDeadline && isValidDate(currentDate) ? currentDate : undefined;
    items.push({ title: title || content, category, date: currentDate,
      deadlineDate,
      startTime: time ? `${time[1].padStart(2,'0')}:${time[2]}` : undefined,
      endTime: time?.[3] ? `${time[3].padStart(2,'0')}:${time[4]}` : undefined,
      className: classes.join(', '), subject: detectSubjects(content, profile).join(', '),
      rawSnippet: line, notes: line, isDeadline, relevance: 'GIALLO',
    });
  }
  return normalizeExtractedItems(items, profile, location);
}
