export type EventCategory =
  | "lezione"
  | "consiglio_classe"
  | "collegio_docenti"
  | "dipartimento"
  | "dipartimento_sostegno"
  | "glo"
  | "pei"
  | "riunione"
  | "ricevimento_genitori"
  | "formazione"
  | "scadenza"
  | "promemoria"
  | "personale";

export type SchoolLevel = "infanzia" | "primaria" | "ssig" | "ssiig";

export interface TeacherRole {
  role: "coordinatore" | "segretario" | "tutor" | "referente" | "docente_sostegno" | "referente_inclusione" | "membro_gli";
  targetClass?: string;
  description?: string;
}

export interface TeacherProfile {
  id: string;
  fullName: string;
  email?: string;
  schoolName: string;
  schoolLevel?: SchoolLevel;
  schoolYear: string;
  primarySubjects: string[];
  classes: string[];
  campuses: string[];
  roles: TeacherRole[];
  isSupportTeacher?: boolean;
  assignedStudents?: string[];
  googleCalendarLinked?: boolean;
  googleCalendarAccount?: string;
}

export type TimetableType = "definitivo" | "provvisorio";
export type TimetableMode = "auto" | "provvisorio" | "definitivo";

export interface TimetableSlot {
  id: string;
  dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6; // 1 = Lunedì, 6 = Sabato
  periodNumber: number;             // 1, 2, 3, 4, 5, 6
  startTime: string;                // "08:10"
  endTime: string;                  // "09:05"
  subject: string;
  className: string;
  classroom?: string;
  campus?: string;
  color?: string;
  isProvisional?: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  category: EventCategory;
  date: string;                     // "YYYY-MM-DD"
  startTime?: string;               // "15:00"
  endTime?: string;                 // "16:30"
  isAllDay: boolean;
  className?: string;
  subject?: string;
  location?: string;
  notes?: string;
  sourceType: "manuale" | "circolare" | "orario" | "google_calendar";
  sourceCircularTitle?: string;
  completed?: boolean;
  reminderMinutesBefore?: number;
  googleEventId?: string;
  syncedWithGoogle?: boolean;
}

export type RelevanceLevel = "VERDE" | "GIALLO" | "ROSSO";

export interface ExtractedItem {
  tempId: string;
  title: string;
  category: EventCategory;
  date: string;                     // "YYYY-MM-DD"
  startTime?: string;
  endTime?: string;
  className?: string;
  subject?: string;
  location?: string;
  notes?: string;
  isDeadline?: boolean;
  relevance: RelevanceLevel;
  relevanceReason: string;
  rawSnippet?: string;
  selectedForImport: boolean;
}

export interface CircularDocument {
  id: string;
  title: string;
  uploadDate: string;
  fileType: "pdf" | "image" | "text";
  fileName: string;
  rawText?: string;
  extractedCount: number;
  relevantCount: number;
  extractedItems?: ExtractedItem[];
}

export type StudentNoteCategory =
  | "glo"
  | "pei"
  | "colloquio_genitori"
  | "osservazione"
  | "comportamento"
  | "didattica"
  | "terapisti"
  | "altro";

export interface StudentNote {
  id: string;
  date: string; // "YYYY-MM-DD"
  category: StudentNoteCategory;
  title: string;
  content: string;
  author?: string;
  createdAt: string;
}

export interface StudentParentContact {
  parentNames?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export interface Student {
  id: string;
  fullName: string;
  className: string;
  birthDate?: string;
  // Sostegno & Inclusione
  isSupportStudent?: boolean; // L. 104/92
  peiType?: "ordinario" | "differenziato" | "personalizzato";
  supportHoursPerWeek?: number;
  hasBesDsa?: boolean; // DSA / BES con PDP
  pdpApproved?: boolean;
  diagnosticSummary?: string; // Sintesi profilo / note riservate
  specialists?: string; // NPI, logopedista, psicomotricista, AEC/Educatore
  gloDate?: string; // Data programmata o svolta GLO
  // Contatti Famiglia
  contactParents?: StudentParentContact;
  // Diario Note
  notes: StudentNote[];
  updatedAt?: string;
}

export type ViewMode =
  | "oggi"
  | "settimana"
  | "mese"
  | "scadenze"
  | "orario"
  | "classi"
  | "circolari";
