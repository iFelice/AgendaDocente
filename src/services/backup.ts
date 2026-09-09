import { isValidDate, isValidTime, eventDateError } from '../utils/dates';
import { TEACHER_ROLE_KINDS } from '../types';

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');
const text = (v: unknown) => typeof v === 'string';
const required = (v: unknown) => text(v) && (v as string).trim().length > 0;
const optional = (v: unknown, fn: (v: unknown) => boolean) => v === undefined || fn(v);
const bool = (v: unknown) => typeof v === 'boolean';
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const categories = ['lezione','consiglio_classe','collegio_docenti','dipartimento','dipartimento_sostegno','glo','pei','riunione','ricevimento_genitori','formazione','scadenza','promemoria','personale'];
function list(value: unknown, validate: (v: Record<string, any>) => boolean): boolean {
  return Array.isArray(value) && value.every(v => record(v) && required(v.id) && validate(v)) && new Set(value.map(v => v.id)).size === value.length;
}
function item(v: unknown): boolean {
  return record(v) && required(v.tempId) && required(v.title) && categories.includes(v.category) && text(v.date) && (v.date === '' || isValidDate(v.date))
    && optional(v.startTime, text) && optional(v.endTime, text) && ['VERDE','GIALLO','ROSSO'].includes(v.relevance)
    && text(v.relevanceReason) && bool(v.selectedForImport) && optional(v.isDeadline, bool)
    && ['className','subject','location','notes','rawSnippet'].every(k => optional(v[k], text));
}
function timetable(v: unknown): boolean {
  return list(v, s => Number.isInteger(s.dayOfWeek) && s.dayOfWeek >= 1 && s.dayOfWeek <= 6 && Number.isInteger(s.periodNumber)
    && s.periodNumber > 0 && isValidTime(s.startTime) && isValidTime(s.endTime) && s.endTime > s.startTime && text(s.subject) && text(s.className)
    && ['classroom','campus','color'].every(k => optional(s[k], text)) && optional(s.isProvisional, bool));
}
function periodSlotValidator(v: unknown): boolean {
  return record(v) && Number.isInteger(v.periodNumber) && v.periodNumber > 0
    && isValidTime(v.startTime) && isValidTime(v.endTime) && v.endTime > v.startTime
    && optional(v.label, text);
}
function timeSlotConfigValidator(v: unknown): boolean {
  return record(v) && isValidTime(v.firstHourStartTime)
    && Number.isInteger(v.periodsPerDay) && v.periodsPerDay > 0
    && Number.isInteger(v.standardDurationMinutes) && v.standardDurationMinutes > 0
    && optional(v.customSlots, slots => Array.isArray(slots) && slots.every(periodSlotValidator));
}

/** Validate the entire document before touching live storage, including nested arrays used by views. */
export function validateBackup(data: unknown): asserts data is Record<string, any> {
  if (!record(data) || ![2,3].includes(data.version)) throw new Error('Versione backup non supportata.');
  const p = data.profile;
  if (!record(p) || !required(p.id) || !text(p.fullName) || !text(p.schoolName) || !/^\d{4}\/\d{4}$/.test(p.schoolYear)
    || !['primarySubjects','classes','campuses'].every(k => strings(p[k])) || !Array.isArray(p.roles)
    || !p.roles.every(r => record(r) && TEACHER_ROLE_KINDS.includes(r.role) && optional(r.targetClass,text) && optional(r.description,text) && optional(r.label,text))
    || !optional(p.assignedStudents,strings) || !optional(p.isSupportTeacher,bool)
    || !optional(p.googleCalendarLinked,bool) || !optional(p.email,text) || !optional(p.googleCalendarAccount,text)
    || !optional(p.schoolLevel,v => ['infanzia','primaria','ssig','ssiig'].includes(v as string))) throw new Error('Profilo nel backup non valido.');
  if (!list(data.events, e => required(e.title) && isValidDate(e.date) && bool(e.isAllDay) && eventDateError({ date: e.date, isAllDay: e.isAllDay, startTime: e.startTime, endTime: e.endTime }) === null && categories.includes(e.category)
    && ['manuale','circolare','orario','google_calendar'].includes(e.sourceType)
    && ['startTime','endTime','className','subject','location','notes','sourceCircularTitle','sourceCircularId','sourceItemId','googleEventId','updatedAt'].every(k => optional(e[k],text))
    && optional(e.completed,bool) && optional(e.syncedWithGoogle,bool) && optional(e.reminderMinutesBefore,number))) throw new Error('Eventi nel backup non validi.');
  if (!list(data.circulars, c => text(c.title) && isValidDate(c.uploadDate) && ['pdf','image','text'].includes(c.fileType) && text(c.fileName)
    && number(c.extractedCount) && number(c.relevantCount) && optional(c.rawText,text) && optional(c.updatedAt,text)
    && optional(c.extractedItems,v => Array.isArray(v) && v.every(item)))) throw new Error('Circolari nel backup non valide.');
  if (!list(data.students, s => text(s.fullName) && text(s.className) && Array.isArray(s.notes)
    && s.notes.every(n => record(n) && required(n.id) && isValidDate(n.date) && text(n.category) && text(n.title) && text(n.content) && text(n.createdAt))
    && ['birthDate','peiType','diagnosticSummary','specialists','gloDate','updatedAt'].every(k => optional(s[k],text))
    && ['isSupportStudent','hasBesDsa','pdpApproved'].every(k => optional(s[k],bool)) && optional(s.supportHoursPerWeek,number)
    && optional(s.contactParents,v => record(v) && ['parentNames','phone','email','notes'].every(k => optional(v[k],text))))) throw new Error('Alunni nel backup non validi.');
  if (data.version === 2) {
    if (!timetable(data.timetable)) throw new Error('Orario nel backup non valido.');
  } else if (!timetable(data.definitiveTimetable) || !timetable(data.provisionalTimetable)
    || !['auto','provvisorio','definitivo'].includes(data.timetableMode) || !bool(data.onboardingCompleted)
    || !optional(data.timeSlotConfig, timeSlotConfigValidator)) throw new Error('Orari o impostazioni nel backup non validi.');
}

const JOURNAL = 'agedoc_restore_journal_v1';
/** An interrupted multi-key restore rolls back at the next application startup. */
export function recoverBackupRestore(legacy: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage): void {
  const raw = legacy.getItem(JOURNAL);
  if (!raw) return;
  const previous: Record<string, string | null> = JSON.parse(raw);
  for (const [key, value] of Object.entries(previous)) {
    if (!key.startsWith('agedoc_') || key === JOURNAL || !(value === null || typeof value === 'string')) throw new Error('Registro ripristino non valido.');
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value === null) legacy.removeItem(key); else legacy.setItem(key, value);
  }
  legacy.removeItem(JOURNAL);
}

export function restoreBackupValues(values: Record<string, string>): void {
  recoverBackupRestore();
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, localStorage.getItem(k)]));
  // If there is insufficient room for the journal, nothing has changed yet.
  localStorage.setItem(JOURNAL, JSON.stringify(previous));
  try {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    localStorage.removeItem(JOURNAL);
  } catch (error) {
    // Release replacement values first so quota pressure cannot prevent rollback.
    for (const key of Object.keys(values)) localStorage.removeItem(key);
    recoverBackupRestore();
    throw error;
  }
}
