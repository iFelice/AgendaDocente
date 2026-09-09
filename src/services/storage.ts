import { assertUnchanged } from "./persistenceErrors";
import { linkLegacyCircularEvents } from "../utils/circularLinks";
import { localDateISO } from "../utils/dates";
import { CalendarEvent, CircularDocument, ExtractedItem, SchoolLevel, Student, StudentNote, TeacherProfile, TimetableMode, TimetableSlot, TimetableType, } from "../types";
import { getCurrentSchoolYear } from "../utils/schoolYear";
import { validateBackup } from "./backup";
import { database, type LocalData, type LegacyStorage } from "./db";
import { extractedItemError } from "../utils/circularParser";
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
  return localDateISO(d);
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

export function demoInstallation(): LocalData {
 return {profile:structuredClone(DEFAULT_PROFILE),events:structuredClone(DEFAULT_EVENTS),circulars:[],students:structuredClone(DEFAULT_STUDENTS),
 definitiveTimetable:[],provisionalTimetable:structuredClone(DEFAULT_PROVISIONAL_TIMETABLE),timetableMode:'auto',onboardingCompleted:false};
}
export async function initializeStorage(legacy?: LegacyStorage): Promise<LocalData> {
 await database.initialize(demoInstallation(),legacy);
 return database.readSnapshot();
}
export const storage = {
  // PROFILE
  async getProfile(): Promise<TeacherProfile> { return database.read("profile"); },
  async saveProfile(profile: TeacherProfile, expected?: TeacherProfile): Promise<void> {
    return database.atomic(async () => { assertUnchanged(await this.getProfile(), expected); return database.write("profile", profile); });
  },
  // TIMETABLE - DEFINITIVE & PROVISIONAL MANAGEMENT
  async getDefinitiveTimetable(): Promise<TimetableSlot[]> { return database.read("definitiveTimetable"); },
  async saveDefinitiveTimetable(slots: TimetableSlot[]): Promise<void> {
    return database.atomic(async () => { return database.write("definitiveTimetable", slots); });
  },
  async getProvisionalTimetable(): Promise<TimetableSlot[]> { return database.read("provisionalTimetable"); },
  async saveProvisionalTimetable(slots: TimetableSlot[]): Promise<void> {
    return database.atomic(async () => { return database.write("provisionalTimetable", slots); });
  },
  async getTimetableMode(): Promise<TimetableMode> { return database.read("timetableMode"); },
  async setTimetableMode(mode: TimetableMode): Promise<void> {
    return database.atomic(async () => { return database.write("timetableMode", mode); });
  },
  async getActiveTimetableInfo(): Promise<{
    slots: TimetableSlot[];
    activeType: "definitivo" | "provvisorio";
    isDefinitiveCompiled: boolean;
    isFallbackToProvisional: boolean;
  }> {
    const definitive = (await this.getDefinitiveTimetable());
    const provisional = (await this.getProvisionalTimetable());
    const mode = (await this.getTimetableMode());
    const isDefinitiveCompiled = Array.isArray(definitive) && definitive.length > 0;
    let activeType: "definitivo" | "provvisorio" = "provvisorio";
    let isFallbackToProvisional = false;
    if (mode === "provvisorio") {
      activeType = "provvisorio";
    }
    else if (mode === "definitivo") {
      if (isDefinitiveCompiled) {
        activeType = "definitivo";
      }
      else {
        // Fallback: definitivo not yet compiled, use provvisorio
        activeType = "provvisorio";
        isFallbackToProvisional = true;
      }
    }
    else {
      // "auto" mode: default to provisional when definitive is not compiled
      if (!isDefinitiveCompiled) {
        activeType = "provvisorio";
        isFallbackToProvisional = true;
      }
      else {
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
  async getTimetable(): Promise<TimetableSlot[]> {
    return (await this.getActiveTimetableInfo()).slots;
  },
  async saveTimetable(slots: TimetableSlot[], targetType: "definitivo" | "provvisorio" = "definitivo"): Promise<void> {
    return database.atomic(async () => {
      if (targetType === "provvisorio") {
        await this.saveProvisionalTimetable(slots);
      }
      else {
        await this.saveDefinitiveTimetable(slots);
      }
    });
  },
  async saveTimetableSlot(slot: TimetableSlot, targetType: "definitivo" | "provvisorio" = "definitivo", expected?: TimetableSlot): Promise<void> {
    return database.atomic(async () => {
      if (targetType === "provvisorio") {
        const list = (await this.getProvisionalTimetable());
        const index = list.findIndex((s) => s.id === slot.id);
        assertUnchanged(list[index], expected);
        if (index >= 0) {
          list[index] = { ...slot, isProvisional: true };
        }
        else {
          list.push({ ...slot, isProvisional: true });
        }
        await this.saveProvisionalTimetable(list);
      }
      else {
        const list = (await this.getDefinitiveTimetable());
        const index = list.findIndex((s) => s.id === slot.id);
        assertUnchanged(list[index], expected);
        if (index >= 0) {
          list[index] = { ...slot, isProvisional: false };
        }
        else {
          list.push({ ...slot, isProvisional: false });
        }
        await this.saveDefinitiveTimetable(list);
      }
    });
  },
  async deleteTimetableSlot(id: string, targetType: "definitivo" | "provvisorio" = "definitivo"): Promise<void> {
    return database.atomic(async () => {
      if (targetType === "provvisorio") {
        const list = (await this.getProvisionalTimetable()).filter((s) => s.id !== id);
        await this.saveProvisionalTimetable(list);
      }
      else {
        const list = (await this.getDefinitiveTimetable()).filter((s) => s.id !== id);
        await this.saveDefinitiveTimetable(list);
      }
    });
  },
  async copyProvisionalToDefinitive(): Promise<void> {
    return database.atomic(async () => {
      const prov = (await this.getProvisionalTimetable());
      const cloned = prov.map((s, idx) => ({
        ...s,
        id: `tt-def-${Date.now()}-${idx}`,
        isProvisional: false,
      }));
      await this.saveDefinitiveTimetable(cloned);
    });
  },
  async copyDefinitiveToProvisional(): Promise<void> {
    return database.atomic(async () => {
      const def = (await this.getDefinitiveTimetable());
      const cloned = def.map((s, idx) => ({
        ...s,
        id: `tt-prov-${Date.now()}-${idx}`,
        isProvisional: true,
      }));
      await this.saveProvisionalTimetable(cloned);
    });
  },
  async clearTimetable(type: "definitivo" | "provvisorio"): Promise<void> {
    return database.atomic(async () => {
      if (type === "provvisorio") {
        await this.saveProvisionalTimetable([]);
      }
      else {
        await this.saveDefinitiveTimetable([]);
      }
    });
  },
  async resetProvisionalTimetable(): Promise<void> {
    return database.atomic(async () => {
      await this.saveProvisionalTimetable(DEFAULT_PROVISIONAL_TIMETABLE);
    });
  },
  async resetDefinitiveTimetable(): Promise<void> {
    return database.atomic(async () => {
      await this.saveDefinitiveTimetable(DEFAULT_TIMETABLE);
    });
  },
  // EVENTS
  async getEvents(): Promise<CalendarEvent[]> { return database.read("events"); },
  async saveEvents(events: CalendarEvent[]): Promise<void> {
    return database.atomic(async () => { return database.write("events", events); });
  },
  async saveEvent(event: CalendarEvent, expected?: CalendarEvent): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getEvents());
      const index = list.findIndex((e) => e.id === event.id);
      assertUnchanged(list[index], expected);
      if (index >= 0) {
        list[index] = event;
      }
      else {
        list.push(event);
      }
      await this.saveEvents(list);
    });
  },
  async deleteEvent(id: string): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getEvents()).filter((e) => e.id !== id);
      await this.saveEvents(list);
    });
  },
  async toggleEventCompleted(id: string): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getEvents());
      const target = list.find((e) => e.id === id);
      if (target) {
        target.completed = !target.completed;
        await this.saveEvents(list);
      }
    });
  },
  async bulkAddEvents(newEvents: CalendarEvent[]): Promise<number> {
    return database.atomic(async () => {
      const list = (await this.getEvents());
      let addedCount = 0;
      for (const ev of newEvents) {
        // Avoid duplicate matching same title and date and time
        const duplicate = list.find((existing) => existing.id === ev.id ||
          (ev.sourceCircularId && existing.sourceCircularId === ev.sourceCircularId && existing.sourceItemId === ev.sourceItemId) ||
          (!ev.sourceCircularId && !existing.sourceCircularId && existing.sourceType === ev.sourceType &&
            existing.title === ev.title && existing.date === ev.date && existing.startTime === ev.startTime && existing.className === ev.className));
        if (!duplicate) {
          list.push(ev);
          addedCount++;
        }
      }
      await this.saveEvents(list);
      return addedCount;
    });
  },
  // CIRCULARS
  async getCirculars(): Promise<CircularDocument[]> { return database.read("circulars"); },
  async saveCircular(doc: CircularDocument): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getCirculars());
      // Prevent exact duplicate id
      const existingIndex = list.findIndex((c) => c.id === doc.id);
      if (existingIndex >= 0) {
        list[existingIndex] = doc;
      }
      else {
        list.unshift(doc);
      }
      await database.write("circulars", list);
    });
  },
  async updateCircular(doc: CircularDocument): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getCirculars());
      const idx = list.findIndex((c) => c.id === doc.id);
      if (idx >= 0) {
        list[idx] = doc;
      }
      else {
        list.unshift(doc);
      }
      await database.write("circulars", list);
    });
  },
  async deleteCircular(id: string): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getCirculars()).filter((c) => c.id !== id);
      await database.write("circulars", list);
    });
  },
  async deleteExtractedItemFromCircular(circularId: string, tempId: string): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getCirculars());
      const circ = list.find((c) => c.id === circularId);
      if (circ && circ.extractedItems) {
        circ.extractedItems = circ.extractedItems.filter((it) => it.tempId !== tempId);
        circ.extractedCount = circ.extractedItems.length;
        circ.relevantCount = circ.extractedItems.filter((i) => i.relevance === "VERDE" || i.relevance === "GIALLO").length;
        await this.updateCircular(circ);
      }
    });
  },
  async deleteEventMatchingExtractedItem(item: ExtractedItem, circularId: string): Promise<boolean> {
    return database.atomic(async () => {
      const events = (await this.getEvents());
      const remaining = events.filter(e => !(e.sourceType === 'circolare' && e.sourceCircularId === circularId && e.sourceItemId === item.tempId));
      if (remaining.length === events.length)
        return false;
      await this.saveEvents(remaining);
      return true;
    });
  },
  /**
  * Syncs commitments from a circular into the calendar planning
  */
  async syncCircularCommitments(circularId: string, onlyRelevant: boolean = true): Promise<number> {
    return database.atomic(async () => {
      const circulars = (await this.getCirculars());
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
      const newEvents: CalendarEvent[] = itemsToImport.filter(it => !extractedItemError(it)).map((it) => convertExtractedItemToEvent(it, target.title, target.id));
      const added = (await this.bulkAddEvents(newEvents));
      return added;
    });
  },
  // CLASSI & ALUNNI
  async getStudents(): Promise<Student[]> { return database.read("students"); },
  async saveStudents(students: Student[]): Promise<void> {
    return database.atomic(async () => { return database.write("students", students); });
  },
  async saveStudent(student: Student, expected?: Student): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getStudents());
      const idx = list.findIndex((s) => s.id === student.id);
      if (expected) {
        const withoutNotes = (value?: Student) => value && {...value, notes:[], updatedAt:undefined};
        assertUnchanged(withoutNotes(list[idx]), withoutNotes(expected));
      }
      const updatedStudent = {
        ...student,
        notes: idx >= 0 ? list[idx].notes : student.notes,
        updatedAt: new Date().toISOString(),
      };
      if (idx >= 0) {
        list[idx] = updatedStudent;
      }
      else {
        list.push(updatedStudent);
      }
      await this.saveStudents(list);
    });
  },
  async deleteStudent(id: string): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getStudents()).filter((s) => s.id !== id);
      await this.saveStudents(list);
    });
  },
  async addStudentNote(studentId: string, note: StudentNote): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getStudents());
      const student = list.find((s) => s.id === studentId);
      if (!student)
        return;
      student.notes = [note, ...(student.notes || [])];
      student.updatedAt = new Date().toISOString();
      await this.saveStudents(list);
    });
  },
  async deleteStudentNote(studentId: string, noteId: string): Promise<void> {
    return database.atomic(async () => {
      const list = (await this.getStudents());
      const student = list.find((s) => s.id === studentId);
      if (!student)
        return;
      student.notes = (student.notes || []).filter((n) => n.id !== noteId);
      student.updatedAt = new Date().toISOString();
      await this.saveStudents(list);
    });
  },
  // BACKUP & RESTORE
  async exportDataBackup(): Promise<string> { return JSON.stringify({ version: 3, exportedAt: new Date().toISOString(), ...await database.readSnapshot() }, null, 2); },
  async importDataBackup(jsonString: string): Promise<boolean> {
    try {
      const data: unknown = JSON.parse(jsonString);
      validateBackup(data);
      await database.atomic(async () => {
        const current = await database.readSnapshot();
        await database.restore({ profile: data.profile, events: linkLegacyCircularEvents(data.events, data.circulars), circulars: data.circulars, students: data.students,
          definitiveTimetable: data.version === 3 ? data.definitiveTimetable : data.timetable,
          provisionalTimetable: data.version === 3 ? data.provisionalTimetable : current.provisionalTimetable,
          timetableMode: data.version === 3 ? data.timetableMode : current.timetableMode,
          onboardingCompleted: data.version === 3 ? data.onboardingCompleted : current.onboardingCompleted });
      });
      return true;
    }
    catch {
      return false;
    }
  },
  // ONBOARDING STATUS
  async hasCompletedOnboarding(): Promise<boolean> { return database.read("onboardingCompleted"); },
  async setOnboardingCompleted(completed: boolean): Promise<void> {
    return database.atomic(async () => { return database.write("onboardingCompleted", completed); });
  },
  async resetOnboarding(): Promise<void> {
    return database.atomic(async () => {
      await this.setOnboardingCompleted(false);
    });
  },
};
export function convertExtractedItemToEvent(
  it: ExtractedItem, sourceCircularTitle: string, sourceCircularId: string
): CalendarEvent {
  const error = extractedItemError(it);
  if (error) throw new Error(error);
  return {
    id: `ev-circ-${sourceCircularId}-${it.tempId}`,
    title: it.title, category: it.category, date: it.date,
    startTime: it.startTime || undefined, endTime: it.endTime || undefined,
    isAllDay: !!it.isDeadline && !it.startTime,
    className: it.className || undefined, subject: it.subject || undefined,
    location: it.location || undefined, notes: it.notes || it.relevanceReason,
    sourceType: 'circolare', sourceCircularTitle, sourceCircularId, sourceItemId: it.tempId,
    completed: false,
  };
}

export function isCommitmentInEvents(item: ExtractedItem, events: CalendarEvent[], circularId: string): boolean {
  return events.some(ev => ev.sourceType === 'circolare' && ev.sourceCircularId === circularId && ev.sourceItemId === item.tempId);
}
