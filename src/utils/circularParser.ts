import type { ExtractedItem, TeacherProfile, EventCategory } from "../types";
import { evaluateItemRelevance, extractClassesFromText, detectSubjects, isGenericSubject, normalizeRecipientClasses, normalizeRecipientGrades } from "./circularRelevance";
import { isValidDate, isValidTime } from "./dates";

const categories: EventCategory[] = ["lezione", "consiglio_classe", "collegio_docenti", "dipartimento", "dipartimento_sostegno", "glo", "pei", "riunione", "ricevimento_genitori", "formazione", "uscita_didattica", "scadenza", "promemoria", "personale"];
const datePattern = /\b(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{4}|\d{2}))?\b/g;
const timePattern = /\b([01]?\d|2[0-3])[.:]([0-5]\d)(?:\s*(?:[-–—]|alle|a)\s*([01]?\d|2[0-3])[.:]([0-5]\d))?\b/i;
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

export function extractDate(line: string, profile: TeacherProfile): { date: string; text: string } | null {
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

export function normalizeDateISO(val: unknown, profile?: TeacherProfile, fallbackText?: string): string {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (isValidDate(trimmed)) return trimmed;

    // Check YYYY/MM/DD or YYYY.MM.DD
    const isoSlashMatch = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(trimmed);
    if (isoSlashMatch) {
      const candidate = `${isoSlashMatch[1]}-${isoSlashMatch[2].padStart(2, '0')}-${isoSlashMatch[3].padStart(2, '0')}`;
      if (isValidDate(candidate)) return candidate;
    }

    // Check DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
    const itMatch = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})$/.exec(trimmed);
    if (itMatch) {
      const day = itMatch[1].padStart(2, '0');
      const month = itMatch[2].padStart(2, '0');
      const year = itMatch[3].length === 2 ? `20${itMatch[3]}` : itMatch[3];
      const candidate = `${year}-${month}-${day}`;
      if (isValidDate(candidate)) return candidate;
    }

    // Check textual Italian date e.g. "15 settembre 2026" or "15 settembre"
    if (profile) {
      const parsedFromVal = extractDate(trimmed, profile);
      if (parsedFromVal && isValidDate(parsedFromVal.date)) {
        return parsedFromVal.date;
      }
    }
  }

  // Fallback: extract date from fallbackText (e.g. rawSnippet or title)
  if (fallbackText && typeof fallbackText === 'string' && profile) {
    const parsed = extractDate(fallbackText, profile);
    if (parsed && isValidDate(parsed.date)) {
      return parsed.date;
    }
  }

  return '';
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
  return input.map((rawInput, index) => {
    if (!rawInput || typeof rawInput !== 'object') throw new Error("Impegno estratto non valido.");
    const raw = rawInput as Record<string, any>;
    const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
    const title = str(raw.title || raw.titolo || raw.evento || raw.attivita || raw.impegno);
    if (!title) throw new Error("Impegno estratto non valido.");

    const time = (v: unknown) => {
      const normalized = str(v).replace('.', ':').replace(/^(\d):/, '0$1:');
      return isValidTime(normalized) ? normalized : undefined;
    };

    let rawStart = raw.startTime ?? raw.oraInizio ?? raw.orario_inizio;
    let rawEnd = raw.endTime ?? raw.oraFine ?? raw.orario_fine;
    if (!rawStart && (raw.orario || raw.ora)) {
      const timeStr = str(raw.orario || raw.ora);
      const m = timePattern.exec(timeStr);
      if (m) {
        rawStart = `${m[1].padStart(2, '0')}:${m[2]}`;
        if (m[3]) rawEnd = `${m[3].padStart(2, '0')}:${m[4]}`;
      }
    }

    const rawDeadline = str(raw.deadlineDate || raw.scadenza || raw.dataScadenza || raw.data_limite);
    const deadlineCandidate = rawDeadline ? normalizeDateISO(rawDeadline, profile) : '';
    const deadlineDate = isValidDate(deadlineCandidate) ? deadlineCandidate : undefined;

    const rawDateVal = raw.date ?? raw.data ?? raw.giorno;
    const rawSnippet = str(raw.rawSnippet);
    const notes = str(raw.notes || raw.note || raw.ordineDelGiorno || raw.odg);
    const rawDateCandidate = normalizeDateISO(rawDateVal, profile, `${rawSnippet} ${title} ${notes}`);
    const date = rawDateCandidate || deadlineDate || '';

    const className = str(raw.className || raw.classe || raw.classi);
    const subject = isGenericSubject(str(raw.subject || raw.materia || raw.disciplina)) ? "" : str(raw.subject || raw.materia || raw.disciplina);
    const itemLocation = str(raw.location || raw.luogo || raw.sede || raw.aula);

    const item: ExtractedItem = {
      tempId: `extracted-${Date.now()}-${index}`,
      title,
      category: normalizeCircularCategory(raw.category || raw.categoria, title, rawSnippet),
      date,
      deadlineDate,
      startTime: time(rawStart),
      endTime: time(rawEnd),
      className,
      subject,
      location: itemLocation,
      notes,
      rawSnippet,
      // Destinatari strutturati dell'AI: anni 1..5 deduplicati/ordinati e classi
      // complete in formato canonico. I valori non validi vengono scartati.
      recipientGrades: normalizeRecipientGrades(raw.recipientGrades),
      recipientClasses: normalizeRecipientClasses(raw.recipientClasses),
      isDeadline: raw.isDeadline === true || !!deadlineDate || raw.category === 'scadenza' || raw.categoria === 'scadenza',
      relevance: ['VERDE', 'GIALLO', 'ROSSO'].includes(raw.relevance) ? raw.relevance : 'GIALLO',
      relevanceReason: str(raw.relevanceReason || raw.motivo),
      selectedForImport: false,
    };
    // Only an excerpt containing this activity can provide row-local time evidence.
    // Ambiguous or evidence-free excerpts never keep a neighbouring interval by position:
    // a vertically merged ORARI cell shown once is re-attached above only through the
    // row excerpt, so an excerpt without exactly one interval cannot vouch for any time.
    const fold = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (item.rawSnippet && fold(item.title) && fold(item.rawSnippet).includes(fold(item.title))) {
      const rowDate = extractDate(item.rawSnippet, profile);
      const excerpt = rowDate ? item.rawSnippet.replace(rowDate.text, '') : item.rawSnippet;
      const intervals = [...excerpt.matchAll(new RegExp(timePattern.source, 'gi'))];
      if (intervals.length === 1) {
        const interval = intervals[0];
        item.startTime = `${interval[1].padStart(2, '0')}:${interval[2]}`;
        item.endTime = interval[3] ? `${interval[3].padStart(2, '0')}:${interval[4]}` : undefined;
      } else if (intervals.length > 1) {
        // Multiple candidate intervals: ambiguous excerpt cannot support a unique time.
        item.startTime = undefined;
        item.endTime = undefined;
      }
    }
    // Hard invariant: a closed interval with end <= start (e.g. a duplicated 12:30-12:30)
    // is always treated as incomplete evidence, never as a usable — or auto-selectable — time.
    if (item.startTime && item.endTime && item.endTime <= item.startTime) {
      item.startTime = undefined;
      item.endTime = undefined;
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
