import {
  CalendarEvent,
  CircularDocument,
  ExtractedItem,
  SchoolLevel,
  Student,
  StudentNote,
  TeacherProfile,
  TimetableMode,
  TimetableSlot,
  TimetableType,
} from "../types";
import { getCurrentSchoolYear } from "../utils/schoolYear";
import { clientSideLocalParser, SAMPLE_CIRCULARS } from "./aiService";

export function getSchoolLevelLabel(level?: SchoolLevel): string {
  switch (level) {
    case "infanzia":
      return "Scuola dell'Infanzia";
    case "primaria":
      return "Scuola Primaria (Primaria)";
    case "ssig":
      return "Secondaria di I Grado (SSIG)";
    case "ssiig":
      return "Secondaria di II Grado (SSIIG)";
    default:
      return "Secondaria di I Grado (SSIG)";
  }
}

const STORAGE_KEYS = {
  PROFILE: "agedoc_teacher_profile_v2",
  TIMETABLE: "agedoc_timetable_v2",
  TIMETABLE_PROVISIONAL: "agedoc_timetable_provvisorio_v2",
  TIMETABLE_MODE: "agedoc_timetable_mode_v2",
  EVENTS: "agedoc_events_v2",
  CIRCULARS: "agedoc_circulars_v2",
  STUDENTS: "agedoc_students_v2",
  ONBOARDING_COMPLETED: "agedoc_onboarding_completed_v2",
};

export const DEFAULT_STUDENTS: Student[] = [
  {
    id: "stu-1",
    fullName: "Rossi Matteo",
    className: "2E",
    birthDate: "2013-05-14",
    isSupportStudent: true,
    peiType: "differenziato",
    supportHoursPerWeek: 9,
    hasBesDsa: false,
    diagnosticSummary: "Disturbo dello spettro autistico (L. 104/92 art. 3 c. 3). Predilige routine scandite e supporti visivi/mappe.",
    specialists: "Dott.ssa Moretti (NPI ASL RM1), Elena V. (Educatrice AEC comunale)",
    gloDate: "2026-10-15",
    contactParents: {
      parentNames: "Marco e Laura Rossi",
      phone: "338 1234567",
      email: "famiglia.rossi@email.it",
      notes: "Disponibili preferibilmente il venerdì mattina ore 10:00-11:00",
    },
    notes: [
      {
        id: "sn-1",
        date: "2026-09-03",
        category: "glo",
        title: "Raccordo iniziale per stesura PEI",
        content: "Incontro con educatrice AEC Elena per concordare gli orari di compresenza e gli adattamenti dei materiali didattici per matematica e scienze.",
        author: "Prof. Conti",
        createdAt: "2026-09-03T09:30:00.000Z",
      },
      {
        id: "sn-2",
        date: "2026-09-04",
        category: "osservazione",
        title: "Accoglienza in classe 2E",
        content: "Matteo ha mostrato serenità nel ritrovare i compagni di banco. Posizionato nella prima fila vicino alla cattedra come concordato nel PEI.",
        author: "Prof. Conti",
        createdAt: "2026-09-04T11:15:00.000Z",
      },
    ],
    updatedAt: "2026-09-04T12:00:00.000Z",
  },
  {
    id: "stu-2",
    fullName: "Bianchi Leonardo",
    className: "1A",
    birthDate: "2014-02-20",
    isSupportStudent: true,
    peiType: "ordinario",
    supportHoursPerWeek: 9,
    hasBesDsa: false,
    diagnosticSummary: "Disabilità intellettiva lieve e disturbo del linguaggio. PEI con programmazione per obiettivi minimi e tempi distesi.",
    specialists: "Dott. Ferri (NPI ASL), Dott.ssa Barbieri (Logopedista privata)",
    gloDate: "2026-10-22",
    contactParents: {
      parentNames: "Giuseppe e Anna Bianchi",
      phone: "347 9876543",
      email: "bianchi.famiglia@libero.it",
      notes: "Preferiscono comunicazioni via email o WhatsApp",
    },
    notes: [
      {
        id: "sn-3",
        date: "2026-09-02",
        category: "terapisti",
        title: "Colloquio con la logopedista",
        content: "La terapista segnala progressi nella produzione verbale e suggerisce l'uso del quaderno a righe larghe e software di sintesi vocale.",
        author: "Prof. Conti",
        createdAt: "2026-09-02T16:00:00.000Z",
      },
      {
        id: "sn-4",
        date: "2026-09-04",
        category: "colloquio_genitori",
        title: "Primo colloquio informativo con la madre",
        content: "La mamma ha illustrato le abitudini di studio pomeridiano e confermato il prosieguo delle terapie bisettimanali.",
        author: "Prof. Conti",
        createdAt: "2026-09-04T10:45:00.000Z",
      },
    ],
    updatedAt: "2026-09-04T12:00:00.000Z",
  },
  {
    id: "stu-3",
    fullName: "Esposito Chiara",
    className: "1A",
    birthDate: "2014-08-11",
    isSupportStudent: false,
    hasBesDsa: true,
    pdpApproved: true,
    diagnosticSummary: "DSA - Dislessia e Disortografia evolutiva (F81.0, F81.1). Previsti strumenti compensativi e misure dispensative (L. 170/2010).",
    contactParents: {
      parentNames: "Valerio Esposito",
      phone: "320 5544332",
      email: "v.esposito@gmail.com",
      notes: "Richiede colloquio per verificare adozione delle misure PDP da parte di tutto il consiglio",
    },
    notes: [
      {
        id: "sn-5",
        date: "2026-09-03",
        category: "colloquio_genitori",
        title: "Richiesta incontro per adozione PDP",
        content: "Il genitore ha chiesto via registro elettronico un appuntamento per concordare i tempi aggiuntivi nelle verifiche scritte.",
        author: "Prof. Conti",
        createdAt: "2026-09-03T17:20:00.000Z",
      },
    ],
    updatedAt: "2026-09-03T17:20:00.000Z",
  },
  {
    id: "stu-4",
    fullName: "Romano Gabriele",
    className: "2E",
    birthDate: "2013-11-03",
    isSupportStudent: false,
    hasBesDsa: false,
    contactParents: {
      parentNames: "Simona Conti",
      phone: "339 7788990",
      email: "simona.conti@pec.it",
    },
    notes: [
      {
        id: "sn-6",
        date: "2026-09-04",
        category: "didattica",
        title: "Verifica prerequisiti di inizio anno",
        content: "Buona partecipazione al lavoro di gruppo. Fornite schede di consolidamento per la comprensione del testo.",
        author: "Prof. Conti",
        createdAt: "2026-09-04T12:30:00.000Z",
      },
    ],
    updatedAt: "2026-09-04T12:30:00.000Z",
  },
];

// Default seed profile for immediate out-of-the-box experience (Docente di Sostegno)
export const DEFAULT_PROFILE: TeacherProfile = {
  id: "teacher-default-01",
  fullName: "Prof. Andrea Conti",
  email: "andrea.conti@scuola.edu.it",
  schoolName: "Istituto Comprensivo / SSIG",
  schoolLevel: "ssig",
  schoolYear: getCurrentSchoolYear(),
  primarySubjects: ["Attività di Sostegno", "Sostegno Didattico"],
  classes: ["1A", "2E"],
  campuses: ["Sede Centrale"],
  isSupportTeacher: true,
  assignedStudents: [
    "Studente M.R. (Classe 2E, 9 ore - PEI differenziato)",
    "Studente L.B. (Classe 1A, 9 ore - PEI ordinario)",
  ],
  roles: [
    {
      role: "docente_sostegno",
      description: "Docente specializzato per il sostegno didattico",
    },
    {
      role: "membro_gli",
      description: "Membro Gruppo di Lavoro per l'Inclusione (GLI)",
    },
  ],
  googleCalendarLinked: false,
};

// Default timetable matching the teacher's classes & 18 hours weekly quota
export const DEFAULT_TIMETABLE: TimetableSlot[] = [
  // Lunedì (day 1) - 4 ore
  {
    id: "tt-1",
    dayOfWeek: 1,
    periodNumber: 1,
    startTime: "08:15",
    endTime: "09:10",
    subject: "Sostegno (Compresenza Lettere)",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#059669",
  },
  {
    id: "tt-2",
    dayOfWeek: 1,
    periodNumber: 2,
    startTime: "09:10",
    endTime: "10:05",
    subject: "Sostegno (Compresenza Matematica)",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#059669",
  },
  {
    id: "tt-3",
    dayOfWeek: 1,
    periodNumber: 3,
    startTime: "10:15",
    endTime: "11:10",
    subject: "Sostegno (Attività Laboratorio)",
    className: "2E",
    classroom: "Laboratorio Inclusione",
    campus: "Sede Centrale",
    color: "#2563eb",
  },
  {
    id: "tt-4",
    dayOfWeek: 1,
    periodNumber: 4,
    startTime: "11:15",
    endTime: "12:10",
    subject: "Sostegno (Compresenza Scienze)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
  },
  // Martedì (day 2) - 4 ore
  {
    id: "tt-5",
    dayOfWeek: 2,
    periodNumber: 1,
    startTime: "08:15",
    endTime: "09:10",
    subject: "Sostegno (Compresenza Storia)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
  },
  {
    id: "tt-6",
    dayOfWeek: 2,
    periodNumber: 2,
    startTime: "09:10",
    endTime: "10:05",
    subject: "Sostegno (Compresenza Inglese)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
  },
  {
    id: "tt-7",
    dayOfWeek: 2,
    periodNumber: 3,
    startTime: "10:15",
    endTime: "11:10",
    subject: "Sostegno (Attività Individualizzata)",
    className: "1A",
    classroom: "Aula Inclusione",
    campus: "Sede Centrale",
    color: "#059669",
  },
  {
    id: "tt-8",
    dayOfWeek: 2,
    periodNumber: 4,
    startTime: "11:15",
    endTime: "12:10",
    subject: "Sostegno (Compresenza Geografia)",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#059669",
  },
  // Mercoledì (day 3) - 3 ore
  {
    id: "tt-9",
    dayOfWeek: 3,
    periodNumber: 2,
    startTime: "09:10",
    endTime: "10:05",
    subject: "Sostegno (Compresenza Fisica)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
  },
  {
    id: "tt-10",
    dayOfWeek: 3,
    periodNumber: 3,
    startTime: "10:15",
    endTime: "11:10",
    subject: "Sostegno (Compresenza Matematica)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
  },
  {
    id: "tt-11",
    dayOfWeek: 3,
    periodNumber: 5,
    startTime: "12:15",
    endTime: "13:10",
    subject: "Sostegno (Compresenza Lettere)",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#059669",
  },
  // Giovedì (day 4) - 4 ore
  {
    id: "tt-12",
    dayOfWeek: 4,
    periodNumber: 1,
    startTime: "08:15",
    endTime: "09:10",
    subject: "Sostegno (Compresenza Scienze)",
    className: "1A",
    classroom: "Laboratorio Scienze",
    campus: "Sede Centrale",
    color: "#059669",
  },
  {
    id: "tt-13",
    dayOfWeek: 4,
    periodNumber: 2,
    startTime: "09:10",
    endTime: "10:05",
    subject: "Sostegno (Compresenza Arte)",
    className: "1A",
    classroom: "Aula Disegno",
    campus: "Sede Centrale",
    color: "#059669",
  },
  {
    id: "tt-14",
    dayOfWeek: 4,
    periodNumber: 3,
    startTime: "10:15",
    endTime: "11:10",
    subject: "Sostegno (Laboratorio Autonomia)",
    className: "2E",
    classroom: "Laboratorio Inclusione",
    campus: "Sede Centrale",
    color: "#2563eb",
  },
  {
    id: "tt-15",
    dayOfWeek: 4,
    periodNumber: 4,
    startTime: "11:15",
    endTime: "12:10",
    subject: "Sostegno (Compresenza Italiano)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
  },
  // Venerdì (day 5) - 3 ore
  {
    id: "tt-16",
    dayOfWeek: 5,
    periodNumber: 2,
    startTime: "09:10",
    endTime: "10:05",
    subject: "Sostegno (Attività Individualizzata)",
    className: "1A",
    classroom: "Aula Inclusione",
    campus: "Sede Centrale",
    color: "#059669",
  },
  {
    id: "tt-17",
    dayOfWeek: 5,
    periodNumber: 3,
    startTime: "10:15",
    endTime: "11:10",
    subject: "Sostegno (Compresenza Inglese)",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#059669",
  },
  {
    id: "tt-18",
    dayOfWeek: 5,
    periodNumber: 4,
    startTime: "11:15",
    endTime: "12:10",
    subject: "Sostegno (Compresenza Filosofia/Storia)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
  },
];

// Orario provvisorio per i primi giorni di scuola (orario ridotto mattutino con attività di accoglienza e raccordo)
export const DEFAULT_PROVISIONAL_TIMETABLE: TimetableSlot[] = [
  // Lunedì (day 1) - 3 ore ridotte primi giorni
  {
    id: "tt-prov-1",
    dayOfWeek: 1,
    periodNumber: 1,
    startTime: "08:15",
    endTime: "09:10",
    subject: "Sostegno (Accoglienza e primo giorno)",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#059669",
    isProvisional: true,
  },
  {
    id: "tt-prov-2",
    dayOfWeek: 1,
    periodNumber: 2,
    startTime: "09:10",
    endTime: "10:05",
    subject: "Sostegno (Compresenza Lettere - Accoglienza)",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#059669",
    isProvisional: true,
  },
  {
    id: "tt-prov-3",
    dayOfWeek: 1,
    periodNumber: 3,
    startTime: "10:15",
    endTime: "11:10",
    subject: "Sostegno (Accoglienza e raccordo)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
    isProvisional: true,
  },
  // Martedì (day 2) - 3 ore
  {
    id: "tt-prov-4",
    dayOfWeek: 2,
    periodNumber: 1,
    startTime: "08:15",
    endTime: "09:10",
    subject: "Sostegno (Attività di rientro scolastico)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
    isProvisional: true,
  },
  {
    id: "tt-prov-5",
    dayOfWeek: 2,
    periodNumber: 2,
    startTime: "09:10",
    endTime: "10:05",
    subject: "Sostegno (Compresenza)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
    isProvisional: true,
  },
  {
    id: "tt-prov-6",
    dayOfWeek: 2,
    periodNumber: 3,
    startTime: "10:15",
    endTime: "11:10",
    subject: "Sostegno (Laboratorio Inclusione e Accoglienza)",
    className: "1A",
    classroom: "Aula Inclusione",
    campus: "Sede Centrale",
    color: "#059669",
    isProvisional: true,
  },
  // Mercoledì (day 3) - 3 ore
  {
    id: "tt-prov-7",
    dayOfWeek: 3,
    periodNumber: 2,
    startTime: "09:10",
    endTime: "10:05",
    subject: "Sostegno (Compresenza Matematica)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
    isProvisional: true,
  },
  {
    id: "tt-prov-8",
    dayOfWeek: 3,
    periodNumber: 3,
    startTime: "10:15",
    endTime: "11:10",
    subject: "Sostegno (Attività di supporto)",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#059669",
    isProvisional: true,
  },
  {
    id: "tt-prov-9",
    dayOfWeek: 3,
    periodNumber: 4,
    startTime: "11:15",
    endTime: "12:10",
    subject: "Sostegno (Orientamento e spazi scolastici)",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#059669",
    isProvisional: true,
  },
  // Giovedì (day 4) - 3 ore
  {
    id: "tt-prov-10",
    dayOfWeek: 4,
    periodNumber: 1,
    startTime: "08:15",
    endTime: "09:10",
    subject: "Sostegno (Compresenza Scienze)",
    className: "1A",
    classroom: "Laboratorio Scienze",
    campus: "Sede Centrale",
    color: "#059669",
    isProvisional: true,
  },
  {
    id: "tt-prov-11",
    dayOfWeek: 4,
    periodNumber: 2,
    startTime: "09:10",
    endTime: "10:05",
    subject: "Sostegno (Compresenza Arte)",
    className: "1A",
    classroom: "Aula Disegno",
    campus: "Sede Centrale",
    color: "#059669",
    isProvisional: true,
  },
  {
    id: "tt-prov-12",
    dayOfWeek: 4,
    periodNumber: 3,
    startTime: "10:15",
    endTime: "11:10",
    subject: "Sostegno (Laboratorio Autonomia iniziale)",
    className: "2E",
    classroom: "Laboratorio Inclusione",
    campus: "Sede Centrale",
    color: "#2563eb",
    isProvisional: true,
  },
  // Venerdì (day 5) - 3 ore
  {
    id: "tt-prov-13",
    dayOfWeek: 5,
    periodNumber: 2,
    startTime: "09:10",
    endTime: "10:05",
    subject: "Sostegno (Riepilogo didattico prima settimana)",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#059669",
    isProvisional: true,
  },
  {
    id: "tt-prov-14",
    dayOfWeek: 5,
    periodNumber: 3,
    startTime: "10:15",
    endTime: "11:10",
    subject: "Sostegno (Attività di socializzazione)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
    isProvisional: true,
  },
  {
    id: "tt-prov-15",
    dayOfWeek: 5,
    periodNumber: 4,
    startTime: "11:15",
    endTime: "12:10",
    subject: "Sostegno (Compresenza Italiano)",
    className: "2E",
    classroom: "Aula 24",
    campus: "Sede Centrale",
    color: "#2563eb",
    isProvisional: true,
  },
];

// Helper to get formatted relative dates
function getIsoDateOffset(daysOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

// Initial calendar events for Docente di Sostegno (inizio anno scolastico)
export const DEFAULT_EVENTS: CalendarEvent[] = [
  {
    id: "ev-seed-1",
    title: "Incontro G.L.O. Iniziale 2E (con Neuropsichiatra ASL e Genitori)",
    category: "glo",
    date: getIsoDateOffset(1),
    startTime: "15:00",
    endTime: "16:30",
    isAllDay: false,
    className: "2E",
    subject: "Sostegno",
    location: "Aula Inclusione / Google Meet",
    notes: "Condivisione profilo di funzionamento su base ICF e approvazione bozza PEI con equipe multidisciplinare.",
    sourceType: "manuale",
  },
  {
    id: "ev-seed-2",
    title: "Dipartimento Sostegno e Inclusione Scolastica",
    category: "dipartimento_sostegno",
    date: getIsoDateOffset(3),
    startTime: "14:30",
    endTime: "16:30",
    isAllDay: false,
    location: "Aula Magna - Sede Centrale",
    notes: "Coordinamento orario definitivo, protocollo accoglienza alunni DVA/BES e modulistica ministeriale PEI.",
    sourceType: "manuale",
  },
  {
    id: "ev-seed-3",
    title: "Scadenza Redazione e Caricamento PEI definitivo su SIDI",
    category: "pei",
    date: getIsoDateOffset(7),
    startTime: "23:59",
    endTime: "23:59",
    isAllDay: true,
    location: "Portale Ministeriale SIDI",
    notes: "Finalizzazione delle quattro dimensioni ICF per alunno M.R. (2E) e alunno L.B. (1A) con firma congiunta Consiglio di Classe.",
    sourceType: "circolare",
    sourceCircularTitle: "Circolare n. 14 - Adempimenti inizio anno e GLO",
    completed: false,
  },
  {
    id: "ev-seed-4",
    title: "Consiglio di Classe 1A (Programmazione e PEI)",
    category: "consiglio_classe",
    date: getIsoDateOffset(2),
    startTime: "16:00",
    endTime: "17:00",
    isAllDay: false,
    className: "1A",
    subject: "Sostegno",
    location: "Aula 12",
    notes: "Concordamento con i docenti curricolari di misure compensative e criteri di valutazione personalizzati.",
    sourceType: "manuale",
  },
  {
    id: "ev-seed-5",
    title: "Colloquio iniziale con Famiglia e Terapista (1A)",
    category: "ricevimento_genitori",
    date: getIsoDateOffset(4),
    startTime: "11:15",
    endTime: "12:00",
    isAllDay: false,
    className: "1A",
    location: "Ufficio Inclusione",
    notes: "Aggiornamento sulla fase di osservazione iniziale in aula.",
    sourceType: "manuale",
  },
];

export const storage = {
  // PROFILE
  getProfile(): TeacherProfile {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PROFILE);
      if (!raw) {
        this.saveProfile(DEFAULT_PROFILE);
        return DEFAULT_PROFILE;
      }
      const parsed: TeacherProfile = JSON.parse(raw);
      // Se l'anno scolastico non è impostato o corrisponde al vecchio default fisso "2025/2026",
      // aggiorna con l'anno scolastico corrente calcolato (es. 2026/2027 a partire dal 1° agosto)
      if (!parsed.schoolYear || parsed.schoolYear === "2025/2026") {
        parsed.schoolYear = getCurrentSchoolYear();
        this.saveProfile(parsed);
      }
      return parsed;
    } catch {
      return DEFAULT_PROFILE;
    }
  },

  saveProfile(profile: TeacherProfile): void {
    localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
  },

  // TIMETABLE - DEFINITIVE & PROVISIONAL MANAGEMENT
  getDefinitiveTimetable(): TimetableSlot[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.TIMETABLE);
      if (raw === null) {
        // Not yet compiled: return empty array so that provisional is shown by default
        return [];
      }
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  saveDefinitiveTimetable(slots: TimetableSlot[]): void {
    localStorage.setItem(STORAGE_KEYS.TIMETABLE, JSON.stringify(slots));
  },

  getProvisionalTimetable(): TimetableSlot[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.TIMETABLE_PROVISIONAL);
      if (!raw) {
        this.saveProvisionalTimetable(DEFAULT_PROVISIONAL_TIMETABLE);
        return DEFAULT_PROVISIONAL_TIMETABLE;
      }
      return JSON.parse(raw);
    } catch {
      return DEFAULT_PROVISIONAL_TIMETABLE;
    }
  },

  saveProvisionalTimetable(slots: TimetableSlot[]): void {
    localStorage.setItem(STORAGE_KEYS.TIMETABLE_PROVISIONAL, JSON.stringify(slots));
  },

  getTimetableMode(): TimetableMode {
    try {
      const mode = localStorage.getItem(STORAGE_KEYS.TIMETABLE_MODE) as TimetableMode;
      return mode === "definitivo" || mode === "provvisorio" ? mode : "auto";
    } catch {
      return "auto";
    }
  },

  setTimetableMode(mode: TimetableMode): void {
    localStorage.setItem(STORAGE_KEYS.TIMETABLE_MODE, mode);
  },

  getActiveTimetableInfo(): {
    slots: TimetableSlot[];
    activeType: "definitivo" | "provvisorio";
    isDefinitiveCompiled: boolean;
    isFallbackToProvisional: boolean;
  } {
    const definitive = this.getDefinitiveTimetable();
    const provisional = this.getProvisionalTimetable();
    const mode = this.getTimetableMode();
    const isDefinitiveCompiled = Array.isArray(definitive) && definitive.length > 0;

    let activeType: "definitivo" | "provvisorio" = "provvisorio";
    let isFallbackToProvisional = false;

    if (mode === "provvisorio") {
      activeType = "provvisorio";
    } else if (mode === "definitivo") {
      if (isDefinitiveCompiled) {
        activeType = "definitivo";
      } else {
        // Fallback: definitivo not yet compiled, use provvisorio
        activeType = "provvisorio";
        isFallbackToProvisional = true;
      }
    } else {
      // "auto" mode: default to provisional when definitive is not compiled
      if (!isDefinitiveCompiled) {
        activeType = "provvisorio";
        isFallbackToProvisional = true;
      } else {
        activeType = "definitivo";
      }
    }

    return {
      slots: activeType === "definitivo" ? definitive : provisional,
      activeType,
      isDefinitiveCompiled,
      isFallbackToProvisional,
    };
  },

  getTimetable(): TimetableSlot[] {
    return this.getActiveTimetableInfo().slots;
  },

  saveTimetable(slots: TimetableSlot[], targetType: "definitivo" | "provvisorio" = "definitivo"): void {
    if (targetType === "provvisorio") {
      this.saveProvisionalTimetable(slots);
    } else {
      this.saveDefinitiveTimetable(slots);
    }
  },

  saveTimetableSlot(slot: TimetableSlot, targetType: "definitivo" | "provvisorio" = "definitivo"): void {
    if (targetType === "provvisorio") {
      const list = this.getProvisionalTimetable();
      const index = list.findIndex((s) => s.id === slot.id);
      if (index >= 0) {
        list[index] = { ...slot, isProvisional: true };
      } else {
        list.push({ ...slot, isProvisional: true });
      }
      this.saveProvisionalTimetable(list);
    } else {
      const list = this.getDefinitiveTimetable();
      const index = list.findIndex((s) => s.id === slot.id);
      if (index >= 0) {
        list[index] = { ...slot, isProvisional: false };
      } else {
        list.push({ ...slot, isProvisional: false });
      }
      this.saveDefinitiveTimetable(list);
    }
  },

  deleteTimetableSlot(id: string, targetType: "definitivo" | "provvisorio" = "definitivo"): void {
    if (targetType === "provvisorio") {
      const list = this.getProvisionalTimetable().filter((s) => s.id !== id);
      this.saveProvisionalTimetable(list);
    } else {
      const list = this.getDefinitiveTimetable().filter((s) => s.id !== id);
      this.saveDefinitiveTimetable(list);
    }
  },

  copyProvisionalToDefinitive(): void {
    const prov = this.getProvisionalTimetable();
    const cloned = prov.map((s, idx) => ({
      ...s,
      id: `tt-def-${Date.now()}-${idx}`,
      isProvisional: false,
    }));
    this.saveDefinitiveTimetable(cloned);
  },

  copyDefinitiveToProvisional(): void {
    const def = this.getDefinitiveTimetable();
    const cloned = def.map((s, idx) => ({
      ...s,
      id: `tt-prov-${Date.now()}-${idx}`,
      isProvisional: true,
    }));
    this.saveProvisionalTimetable(cloned);
  },

  clearTimetable(type: "definitivo" | "provvisorio"): void {
    if (type === "provvisorio") {
      this.saveProvisionalTimetable([]);
    } else {
      this.saveDefinitiveTimetable([]);
    }
  },

  resetProvisionalTimetable(): void {
    this.saveProvisionalTimetable(DEFAULT_PROVISIONAL_TIMETABLE);
  },

  resetDefinitiveTimetable(): void {
    this.saveDefinitiveTimetable(DEFAULT_TIMETABLE);
  },

  // EVENTS
  getEvents(): CalendarEvent[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.EVENTS);
      if (!raw) {
        this.saveEvents(DEFAULT_EVENTS);
        return DEFAULT_EVENTS;
      }
      return JSON.parse(raw);
    } catch {
      return DEFAULT_EVENTS;
    }
  },

  saveEvents(events: CalendarEvent[]): void {
    localStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(events));
  },

  saveEvent(event: CalendarEvent): void {
    const list = this.getEvents();
    const index = list.findIndex((e) => e.id === event.id);
    if (index >= 0) {
      list[index] = event;
    } else {
      list.push(event);
    }
    this.saveEvents(list);
  },

  deleteEvent(id: string): void {
    const list = this.getEvents().filter((e) => e.id !== id);
    this.saveEvents(list);
  },

  toggleEventCompleted(id: string): void {
    const list = this.getEvents();
    const target = list.find((e) => e.id === id);
    if (target) {
      target.completed = !target.completed;
      this.saveEvents(list);
    }
  },

  bulkAddEvents(newEvents: CalendarEvent[]): number {
    const list = this.getEvents();
    let addedCount = 0;
    for (const ev of newEvents) {
      // Avoid duplicate matching same title and date and time
      const duplicate = list.find(
        (existing) =>
          existing.title === ev.title &&
          existing.date === ev.date &&
          existing.startTime === ev.startTime
      );
      if (!duplicate) {
        list.push(ev);
        addedCount++;
      }
    }
    this.saveEvents(list);
    return addedCount;
  },

  // CIRCULARS
  getCirculars(): CircularDocument[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.CIRCULARS);
      let list: CircularDocument[] = raw ? JSON.parse(raw) : [];

      // Auto-heal / backfill extractedItems for circulars that didn't save them previously
      let updated = false;
      const profile = this.getProfile();
      for (const circ of list) {
        if (!circ.extractedItems || circ.extractedItems.length === 0) {
          const matchSample = SAMPLE_CIRCULARS.find(
            (s) => s.title === circ.title || s.title.includes(circ.title) || circ.title.includes(s.title)
          );
          const textToParse = matchSample ? matchSample.text : (circ.rawText || "");
          if (textToParse && textToParse.trim().length > 10) {
            const parsed = clientSideLocalParser(textToParse, profile);
            if (parsed && parsed.length > 0) {
              circ.extractedItems = parsed;
              circ.extractedCount = parsed.length;
              circ.relevantCount = parsed.filter((i) => i.relevance === "VERDE" || i.relevance === "GIALLO").length;
              updated = true;
            }
          }
        }
      }
      if (updated) {
        localStorage.setItem(STORAGE_KEYS.CIRCULARS, JSON.stringify(list));
      }

      return list;
    } catch {
      return [];
    }
  },

  saveCircular(doc: CircularDocument): void {
    const list = this.getCirculars();
    // Prevent exact duplicate id
    const existingIndex = list.findIndex((c) => c.id === doc.id);
    if (existingIndex >= 0) {
      list[existingIndex] = doc;
    } else {
      list.unshift(doc);
    }
    localStorage.setItem(STORAGE_KEYS.CIRCULARS, JSON.stringify(list));
  },

  updateCircular(doc: CircularDocument): void {
    const list = this.getCirculars();
    const idx = list.findIndex((c) => c.id === doc.id);
    if (idx >= 0) {
      list[idx] = doc;
    } else {
      list.unshift(doc);
    }
    localStorage.setItem(STORAGE_KEYS.CIRCULARS, JSON.stringify(list));
  },

  deleteCircular(id: string): void {
    const list = this.getCirculars().filter((c) => c.id !== id);
    localStorage.setItem(STORAGE_KEYS.CIRCULARS, JSON.stringify(list));
  },

  deleteExtractedItemFromCircular(circularId: string, tempId: string): void {
    const list = this.getCirculars();
    const circ = list.find((c) => c.id === circularId);
    if (circ && circ.extractedItems) {
      circ.extractedItems = circ.extractedItems.filter((it) => it.tempId !== tempId);
      circ.extractedCount = circ.extractedItems.length;
      circ.relevantCount = circ.extractedItems.filter((i) => i.relevance === "VERDE" || i.relevance === "GIALLO").length;
      this.updateCircular(circ);
    }
  },

  deleteEventMatchingExtractedItem(item: ExtractedItem): boolean {
    const events = this.getEvents();
    const idx = events.findIndex(
      (e) =>
        e.date === item.date &&
        (e.title.trim().toLowerCase() === item.title.trim().toLowerCase() ||
          (e.startTime === item.startTime && e.date === item.date && Math.abs(e.title.length - item.title.length) < 15))
    );
    if (idx >= 0) {
      events.splice(idx, 1);
      this.saveEvents(events);
      return true;
    }
    return false;
  },

  /**
   * Syncs commitments from a circular into the calendar planning
   */
  syncCircularCommitments(circularId: string, onlyRelevant: boolean = false): number {
    const circulars = this.getCirculars();
    const target = circulars.find((c) => c.id === circularId);
    if (!target || !target.extractedItems || target.extractedItems.length === 0) {
      return 0;
    }

    const itemsToImport = target.extractedItems.filter((item) => {
      if (onlyRelevant) {
        return item.relevance === "VERDE" || item.relevance === "GIALLO";
      }
      return true;
    });

    const newEvents: CalendarEvent[] = itemsToImport.map((it) =>
      convertExtractedItemToEvent(it, target.title)
    );

    const added = this.bulkAddEvents(newEvents);
    return added;
  },

  // CLASSI & ALUNNI
  getStudents(): Student[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.STUDENTS);
      if (!raw) {
        localStorage.setItem(STORAGE_KEYS.STUDENTS, JSON.stringify(DEFAULT_STUDENTS));
        return DEFAULT_STUDENTS;
      }
      return JSON.parse(raw);
    } catch (e) {
      console.warn("Failed to parse students:", e);
      return DEFAULT_STUDENTS;
    }
  },

  saveStudents(students: Student[]): void {
    try {
      localStorage.setItem(STORAGE_KEYS.STUDENTS, JSON.stringify(students));
    } catch (e) {
      console.warn("Failed to save students:", e);
    }
  },

  saveStudent(student: Student): void {
    const list = this.getStudents();
    const idx = list.findIndex((s) => s.id === student.id);
    const updatedStudent = {
      ...student,
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) {
      list[idx] = updatedStudent;
    } else {
      list.push(updatedStudent);
    }
    this.saveStudents(list);
  },

  deleteStudent(id: string): void {
    const list = this.getStudents().filter((s) => s.id !== id);
    this.saveStudents(list);
  },

  addStudentNote(studentId: string, note: StudentNote): void {
    const list = this.getStudents();
    const student = list.find((s) => s.id === studentId);
    if (!student) return;
    student.notes = [note, ...(student.notes || [])];
    student.updatedAt = new Date().toISOString();
    this.saveStudents(list);
  },

  deleteStudentNote(studentId: string, noteId: string): void {
    const list = this.getStudents();
    const student = list.find((s) => s.id === studentId);
    if (!student) return;
    student.notes = (student.notes || []).filter((n) => n.id !== noteId);
    student.updatedAt = new Date().toISOString();
    this.saveStudents(list);
  },

  // BACKUP & RESTORE
  exportDataBackup(): string {
    const data = {
      version: 2,
      exportedAt: new Date().toISOString(),
      profile: this.getProfile(),
      timetable: this.getTimetable(),
      events: this.getEvents(),
      circulars: this.getCirculars(),
      students: this.getStudents(),
    };
    return JSON.stringify(data, null, 2);
  },

  importDataBackup(jsonString: string): boolean {
    try {
      const data = JSON.parse(jsonString);
      if (data.profile) this.saveProfile(data.profile);
      if (data.timetable) this.saveTimetable(data.timetable);
      if (data.events) this.saveEvents(data.events);
      if (data.students) this.saveStudents(data.students);
      if (data.circulars) {
        localStorage.setItem(STORAGE_KEYS.CIRCULARS, JSON.stringify(data.circulars));
      }
      return true;
    } catch (e) {
      console.warn("Failed to restore backup:", e);
      return false;
    }
  },

  // ONBOARDING STATUS
  hasCompletedOnboarding(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEYS.ONBOARDING_COMPLETED) === "true";
    } catch {
      return false;
    }
  },

  setOnboardingCompleted(completed: boolean): void {
    try {
      if (completed) {
        localStorage.setItem(STORAGE_KEYS.ONBOARDING_COMPLETED, "true");
      } else {
        localStorage.removeItem(STORAGE_KEYS.ONBOARDING_COMPLETED);
      }
    } catch (e) {
      console.warn("Failed to set onboarding status:", e);
    }
  },

  resetOnboarding(): void {
    this.setOnboardingCompleted(false);
  },
};

export function convertExtractedItemToEvent(
  it: ExtractedItem,
  sourceCircularTitle: string
): CalendarEvent {
  return {
    id: `ev-circ-${it.tempId || Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    title: it.title,
    category: it.category,
    date: it.date,
    startTime: it.startTime || "15:00",
    endTime: it.endTime || "16:30",
    isAllDay: it.isDeadline ? true : false,
    className: it.className || undefined,
    subject: it.subject || undefined,
    location: it.location || undefined,
    notes: it.notes || it.relevanceReason,
    sourceType: "circolare",
    sourceCircularTitle: sourceCircularTitle,
    completed: false,
  };
}

export function isCommitmentInEvents(item: ExtractedItem, events: CalendarEvent[]): boolean {
  return events.some((ev) => {
    // Exact date match
    if (ev.date !== item.date) return false;

    // Matching title (cleaned)
    const normEv = ev.title.trim().toLowerCase();
    const normIt = item.title.trim().toLowerCase();
    if (normEv === normIt) return true;
    if (normEv.includes(normIt) || normIt.includes(normEv)) {
      if (item.startTime && ev.startTime) {
        return item.startTime.slice(0, 2) === ev.startTime.slice(0, 2);
      }
      return true;
    }

    // Matching class and start time
    if (item.className && ev.className && item.className.toUpperCase() === ev.className.toUpperCase()) {
      if (item.startTime && ev.startTime && item.startTime === ev.startTime) return true;
    }

    return false;
  });
}
