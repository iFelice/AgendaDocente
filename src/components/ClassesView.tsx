import { usePersistenceAction } from "../hooks/usePersistenceAction";
import { localDateISO } from "../utils/dates";
import React, { useState, useMemo, useRef } from "react";
import {
  Users,
  UserPlus,
  Search,
  BookOpen,
  Phone,
  Mail,
  Calendar,
  Clock,
  HeartHandshake,
  FileText,
  Plus,
  Trash2,
  Edit3,
  CheckCircle,
  AlertCircle,
  Printer,
  X,
  Sparkles,
  ChevronRight,
  Filter,
  GraduationCap,
  MessageSquare,
  FileSpreadsheet,
  Stethoscope,
} from "lucide-react";
import {
  Student,
  StudentNote,
  StudentNoteCategory,
  TeacherProfile,
  CalendarEvent,
} from "../types";

interface ClassesViewProps {
  profile: TeacherProfile;
  students: Student[];
  onSaveStudent: (student: Student, expected?: Student) => void | false | Promise<void | false>;
  onDeleteStudent: (studentId: string) => void | false | Promise<void | false>;
  onAddNote: (studentId: string, note: StudentNote) => void | false | Promise<void | false>;
  onDeleteNote: (studentId: string, noteId: string) => void | false | Promise<void | false>;
  onScheduleEvent: (prefill: Partial<CalendarEvent>) => void;
  onDeleteMultipleStudents?: (studentIds: string[]) => void | false | Promise<void | false>;
  onReassignStudentsClass?: (studentIds: string[], targetClass: string) => void;
  onClearAllStudents?: () => void;
}

const CATEGORY_CONFIG: Record<
  StudentNoteCategory,
  { label: string; badgeClass: string; icon: React.ComponentType<{ className?: string }> }
> = {
  glo: {
    label: "G.L.O. / Riunione Équipe",
    badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-300",
    icon: HeartHandshake,
  },
  pei: {
    label: "P.E.I. / P.D.P.",
    badgeClass: "bg-purple-100 text-purple-800 border-purple-300",
    icon: FileText,
  },
  colloquio_genitori: {
    label: "Colloquio Genitori",
    badgeClass: "bg-amber-100 text-amber-800 border-amber-300",
    icon: MessageSquare,
  },
  osservazione: {
    label: "Osservazione Didattica",
    badgeClass: "bg-sky-100 text-sky-800 border-sky-300",
    icon: BookOpen,
  },
  comportamento: {
    label: "Comportamento & Relazioni",
    badgeClass: "bg-orange-100 text-orange-800 border-orange-300",
    icon: AlertCircle,
  },
  didattica: {
    label: "Valutazione / Didattica",
    badgeClass: "bg-indigo-100 text-indigo-800 border-indigo-300",
    icon: GraduationCap,
  },
  terapisti: {
    label: "Specialisti ASL / Terapisti",
    badgeClass: "bg-teal-100 text-teal-800 border-teal-300",
    icon: Stethoscope,
  },
  altro: {
    label: "Altra Nota",
    badgeClass: "bg-stone-100 text-stone-700 border-stone-300",
    icon: FileText,
  },
};

export const ClassesView: React.FC<ClassesViewProps> = ({
  profile,
  students,
  onSaveStudent,
  onDeleteStudent,
  onAddNote,
  onDeleteNote,
  onScheduleEvent,
  onDeleteMultipleStudents,
  onReassignStudentsClass,
  onClearAllStudents,
}) => {
  const save = usePersistenceAction();
  const editBaseline = useRef<Student | undefined>(undefined);
  // Filters
  const [selectedClass, setSelectedClass] = useState<string>("TUTTE");
  const [filterType, setFilterType] = useState<"tutti" | "sostegno" | "dsa_bes" | "con_note">("tutti");
  const [searchQuery, setSearchQuery] = useState("");
  const [onlyMyClasses, setOnlyMyClasses] = useState<boolean>(true);
  const [studentIdConfirmingDelete, setStudentIdConfirmingDelete] = useState<string | null>(null);

  // Modals / Drawer state
  const [selectedStudentForDetail, setSelectedStudentForDetail] = useState<Student | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [studentToEdit, setStudentToEdit] = useState<Student | null>(null);

  // In-App Deletion confirmation states (prevents iframe confirm() blocking)
  const [studentToDelete, setStudentToDelete] = useState<Student | null>(null);
  const [noteToDelete, setNoteToDelete] = useState<{ studentId: string; noteId: string; title: string } | null>(null);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);

  // New Note Form inside Student Detail
  const [newNoteDate, setNewNoteDate] = useState(() => localDateISO());
  const [newNoteCategory, setNewNoteCategory] = useState<StudentNoteCategory>("osservazione");
  const [newNoteTitle, setNewNoteTitle] = useState("");
  const [newNoteContent, setNewNoteContent] = useState("");

  // Official teacher classes from profile
  const teacherClasses = useMemo(() => {
    return (profile.classes || [])
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
  }, [profile.classes]);

  // Students whose class is not in profile
  const unassignedStudents = useMemo(() => {
    if (teacherClasses.length === 0) return [];
    return students.filter(
      (s) => !teacherClasses.includes(s.className.trim().toUpperCase())
    );
  }, [students, teacherClasses]);

  const alienClassNames = useMemo(() => {
    const set = new Set<string>();
    unassignedStudents.forEach((s) => set.add(s.className.trim().toUpperCase()));
    return Array.from(set).sort();
  }, [unassignedStudents]);

  // Display classes for filter buttons: strictly teacher's classes (or fallback if profile empty)
  const displayClasses = useMemo(() => {
    if (teacherClasses.length > 0) return teacherClasses;
    const set = new Set<string>();
    students.forEach((s) => s.className && set.add(s.className.trim().toUpperCase()));
    return Array.from(set).sort();
  }, [teacherClasses, students]);

  // Filtered students
  const filteredStudents = useMemo(() => {
    return students.filter((s) => {
      // Class filter
      const sClass = s.className.trim().toUpperCase();

      // If user wants to see only their assigned classes
      if (onlyMyClasses && teacherClasses.length > 0 && selectedClass !== "ALTRE") {
        if (!teacherClasses.includes(sClass)) return false;
      }

      if (selectedClass === "ALTRE") {
        if (teacherClasses.includes(sClass)) {
          return false;
        }
      } else if (selectedClass !== "TUTTE") {
        if (sClass !== selectedClass.trim().toUpperCase()) {
          return false;
        }
      }
      // Tag filter
      if (filterType === "sostegno" && !s.isSupportStudent) {
        return false;
      }
      if (filterType === "dsa_bes" && !s.hasBesDsa) {
        return false;
      }
      if (filterType === "con_note" && (!s.notes || s.notes.length === 0)) {
        return false;
      }
      // Search filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = s.fullName.toLowerCase().includes(q);
        const matchesClass = s.className.toLowerCase().includes(q);
        const matchesDiagnosis = (s.diagnosticSummary || "").toLowerCase().includes(q);
        const matchesSpecialists = (s.specialists || "").toLowerCase().includes(q);
        const matchesParents = (s.contactParents?.parentNames || "").toLowerCase().includes(q);
        const matchesNotes = s.notes?.some(
          (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
        );
        return (
          matchesName ||
          matchesClass ||
          matchesDiagnosis ||
          matchesSpecialists ||
          matchesParents ||
          matchesNotes
        );
      }
      return true;
    });
  }, [students, selectedClass, filterType, searchQuery]);

  // Overall Statistics
  const totalStudentsCount = students.length;
  const supportStudentsCount = students.filter((s) => s.isSupportStudent).length;
  const totalSupportHours = students.reduce(
    (acc, s) => acc + (s.isSupportStudent ? s.supportHoursPerWeek || 0 : 0),
    0
  );
  const besDsaCount = students.filter((s) => s.hasBesDsa).length;
  const totalNotesCount = students.reduce((acc, s) => acc + (s.notes?.length || 0), 0);

  // Synchronize open detail modal when students list updates
  const activeDetailStudent = useMemo(() => {
    if (!selectedStudentForDetail) return null;
    return students.find((s) => s.id === selectedStudentForDetail.id) || null;
  }, [students, selectedStudentForDetail]);

  // Handlers for Add/Edit
  const handleOpenAddStudent = () => {
    editBaseline.current = undefined;
    setStudentToEdit({
      id: `stu-${Date.now()}`,
      fullName: "",
      className: selectedClass !== "TUTTE" && selectedClass !== "ALTRE" ? selectedClass : teacherClasses[0] || "1A",
      birthDate: "",
      isSupportStudent: profile.isSupportTeacher || false,
      peiType: "ordinario",
      supportHoursPerWeek: 9,
      hasBesDsa: false,
      pdpApproved: false,
      diagnosticSummary: "",
      specialists: "",
      gloDate: "",
      contactParents: {
        parentNames: "",
        phone: "",
        email: "",
        notes: "",
      },
      notes: [],
    });
    setIsEditModalOpen(true);
  };

  const handleOpenEditStudent = (student: Student) => {
    editBaseline.current = student;
    setStudentToEdit({ ...student });
    setIsEditModalOpen(true);
  };

  const handleSaveStudentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!studentToEdit || !studentToEdit.fullName.trim()) return;

    if (!await save.run(() => onSaveStudent(studentToEdit, editBaseline.current))) return;
    setIsEditModalOpen(false);

    // If currently open in detail drawer, update state
    if (selectedStudentForDetail && selectedStudentForDetail.id === studentToEdit.id) {
      setSelectedStudentForDetail(studentToEdit);
    }
  };

  // Add note handler
  const handleAddNoteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDetailStudent || !newNoteContent.trim()) return;

    const note: StudentNote = {
      id: `sn-${Date.now()}`,
      date: newNoteDate,
      category: newNoteCategory,
      title: newNoteTitle.trim() || CATEGORY_CONFIG[newNoteCategory].label,
      content: newNoteContent.trim(),
      author: profile.fullName,
      createdAt: new Date().toISOString(),
    };

    if (!await save.run(() => onAddNote(activeDetailStudent.id, note))) return;
    setNewNoteTitle("");
    setNewNoteContent("");
  };

  // Quick schedule for GLO
  const handleScheduleGlo = (student: Student) => {
    onScheduleEvent({
      title: `G.L.O. - ${student.fullName} (Classe ${student.className})`,
      category: "glo",
      className: student.className,
      date: student.gloDate || localDateISO(),
      startTime: "15:00",
      endTime: "16:30",
      notes: `Convocazione Gruppo di Lavoro Operativo per ${student.fullName}. Équipe specialistica: ${student.specialists || "ASL/Educatore"}.`,
      location: "Aula Riunioni / Online",
    });
  };

  // Quick schedule for Parent Meeting
  const handleScheduleParentMeeting = (student: Student) => {
    const parent = student.contactParents?.parentNames || "Genitori";
    onScheduleEvent({
      title: `Colloquio con ${parent} (${student.fullName} - ${student.className})`,
      category: "ricevimento_genitori",
      className: student.className,
      date: localDateISO(),
      startTime: "11:15",
      endTime: "12:00",
      notes: `Ricevimento genitori per ${student.fullName}. Recapito: ${student.contactParents?.phone || "N/D"}. Note genitore: ${student.contactParents?.notes || ""}`,
      location: "Plesso scolastico / Ricevimento",
    });
  };

  // Print student sheet
  const handlePrintStudentSheet = () => {
    window.print();
  };

  return (
    <div className="space-y-6 pb-12">
      {save.error && <p role="alert" className="p-3 text-sm text-rose-700">{save.error}</p>}
        {/* Header Banner */}
      <div className="bg-white rounded-2xl p-5 sm:p-6 border border-stone-200 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-purple-100 text-purple-800 flex items-center justify-center font-bold">
                <Users className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-stone-900 tracking-tight">
                  Classi & Elenco Alunni
                </h1>
                <p className="text-xs sm:text-sm text-stone-500">
                  Diario note personalizzate per alunno, monitoraggio GLO / PEI per il sostegno e gestione colloqui genitori.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2.5">
            {onClearAllStudents && students.length > 0 && (
              <button
                type="button"
                onClick={() => setShowClearAllConfirm(true)}
                className="inline-flex items-center px-3 py-2.5 rounded-xl text-xs font-semibold text-stone-600 hover:text-rose-700 bg-stone-100 hover:bg-rose-50 border border-stone-200 transition-colors"
                title="Svuota l'elenco di tutti gli alunni"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Svuota elenco
              </button>
            )}
            <button
              id="btn-add-student"
              onClick={handleOpenAddStudent}
              className="inline-flex items-center px-4 py-2.5 rounded-xl text-sm font-semibold bg-emerald-700 hover:bg-emerald-800 text-white shadow-xs transition-colors"
            >
              <UserPlus className="w-4 h-4 mr-2" />
              Nuovo Alunno
            </button>
          </div>
        </div>

        {/* Metric Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-5 border-t border-stone-100">
          <div className="p-3 bg-stone-50 rounded-xl border border-stone-200/60">
            <p className="text-xs font-medium text-stone-500">Alunni Totali</p>
            <p className="text-xl font-bold text-stone-900 mt-0.5">{totalStudentsCount}</p>
          </div>
          <div className="p-3 bg-emerald-50/70 rounded-xl border border-emerald-200/60">
            <p className="text-xs font-semibold text-emerald-800 flex items-center">
              <HeartHandshake className="w-3.5 h-3.5 mr-1 text-emerald-700" />
              Sostegno (L.104)
            </p>
            <p className="text-xl font-bold text-emerald-900 mt-0.5">
              {supportStudentsCount} <span className="text-xs font-normal text-emerald-700">({totalSupportHours}h tot)</span>
            </p>
          </div>
          <div className="p-3 bg-purple-50/70 rounded-xl border border-purple-200/60">
            <p className="text-xs font-semibold text-purple-800">DSA & BES (PDP)</p>
            <p className="text-xl font-bold text-purple-900 mt-0.5">{besDsaCount}</p>
          </div>
          <div className="p-3 bg-amber-50/70 rounded-xl border border-amber-200/60">
            <p className="text-xs font-semibold text-amber-800">Note & Colloqui</p>
            <p className="text-xl font-bold text-amber-900 mt-0.5">{totalNotesCount}</p>
          </div>
        </div>
      </div>

      {/* Alert banner for students with alien classes */}
      {unassignedStudents.length > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-2xs">
          <div className="flex items-start space-x-3 text-amber-900">
            <div className="w-8 h-8 rounded-xl bg-amber-200/90 text-amber-800 flex items-center justify-center flex-shrink-0 mt-0.5">
              <AlertCircle className="w-4 h-4" />
            </div>
            <div>
              <p className="font-bold text-xs sm:text-sm text-stone-900">
                Presenti {unassignedStudents.length} alunni con classi non tue ({alienClassNames.join(", ")})
              </p>
              <p className="text-xs text-stone-600 mt-0.5">
                Le tue classi di cattedra sono: <strong className="text-stone-900">{teacherClasses.join(", ") || "nessuna configurata"}</strong>.
                Puoi allineare questi alunni a una tua classe oppure rimuoverli con un clic.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
            {teacherClasses[0] && onReassignStudentsClass && (
              <button
                type="button"
                onClick={() => onReassignStudentsClass(unassignedStudents.map((s) => s.id), teacherClasses[0])}
                className="px-3 py-1.5 bg-white hover:bg-stone-50 border border-amber-300 text-stone-800 text-xs font-semibold rounded-xl shadow-2xs transition-colors"
              >
                Sposta tutti in {teacherClasses[0]}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (onDeleteMultipleStudents) {
                  onDeleteMultipleStudents(unassignedStudents.map((s) => s.id));
                } else {
                  unassignedStudents.forEach((s) => onDeleteStudent(s.id));
                }
              }}
              className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-colors"
            >
              Rimuovi alunni estranei ({unassignedStudents.length})
            </button>
          </div>
        </div>
      )}

      {/* Class Selector & Filters */}
      <div className="bg-white rounded-2xl p-4 border border-stone-200 shadow-xs space-y-4">
        {/* Class Pills & My Classes Toggle */}
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-stone-500 mr-1 flex items-center">
              <GraduationCap className="w-3.5 h-3.5 mr-1" />
              Classi:
            </span>
            <button
              onClick={() => setSelectedClass("TUTTE")}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                selectedClass === "TUTTE"
                  ? "bg-stone-900 text-white"
                  : "bg-stone-100 text-stone-600 hover:bg-stone-200"
              }`}
            >
              {onlyMyClasses && teacherClasses.length > 0
                ? `Le mie classi (${students.filter((s) => teacherClasses.includes(s.className.trim().toUpperCase())).length})`
                : `Tutte le classi (${students.length})`}
            </button>
            {displayClasses.map((cls) => {
              const count = students.filter((s) => s.className.trim().toUpperCase() === cls).length;
              return (
                <button
                  key={cls}
                  onClick={() => setSelectedClass(cls)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    selectedClass === cls
                      ? "bg-purple-700 text-white"
                      : "bg-purple-50 text-purple-800 border border-purple-200 hover:bg-purple-100"
                  }`}
                >
                  Classe {cls} ({count})
                </button>
              );
            })}
            {unassignedStudents.length > 0 && (
              <button
                onClick={() => {
                  setSelectedClass("ALTRE");
                  setOnlyMyClasses(false);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  selectedClass === "ALTRE"
                    ? "bg-amber-600 text-white"
                    : "bg-amber-50 text-amber-800 border border-amber-300 hover:bg-amber-100"
                }`}
                title="Alunni con classi non presenti nel tuo profilo"
              >
                Altre classi non tue ({unassignedStudents.length})
              </button>
            )}
          </div>

          {teacherClasses.length > 0 && unassignedStudents.length > 0 && (
            <label className="flex items-center space-x-2 text-xs text-stone-700 bg-stone-50 border border-stone-200 hover:bg-stone-100 px-3 py-1.5 rounded-xl cursor-pointer select-none transition-colors">
              <input
                type="checkbox"
                checked={onlyMyClasses}
                onChange={(e) => setOnlyMyClasses(e.target.checked)}
                className="w-3.5 h-3.5 rounded text-purple-600 focus:ring-purple-500"
              />
              <span className="font-medium text-stone-700">
                Nascondi classi estranee
              </span>
            </label>
          )}
        </div>

        {/* Search & Tag Filters */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-3 border-t border-stone-100">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cerca alunno per nome, diagnosi, note, genitori..."
              className="w-full pl-9 pr-4 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:bg-white"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="flex items-center space-x-1.5 overflow-x-auto pb-1 sm:pb-0">
            <button
              onClick={() => setFilterType("tutti")}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                filterType === "tutti"
                  ? "bg-stone-200 text-stone-900 font-semibold"
                  : "text-stone-600 hover:bg-stone-100"
              }`}
            >
              Tutti
            </button>
            <button
              onClick={() => setFilterType("sostegno")}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                filterType === "sostegno"
                  ? "bg-emerald-100 text-emerald-900 font-semibold border border-emerald-300"
                  : "text-emerald-800 bg-emerald-50 hover:bg-emerald-100"
              }`}
            >
              Sostegno & GLO
            </button>
            <button
              onClick={() => setFilterType("dsa_bes")}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                filterType === "dsa_bes"
                  ? "bg-purple-100 text-purple-900 font-semibold border border-purple-300"
                  : "text-purple-800 bg-purple-50 hover:bg-purple-100"
              }`}
            >
              DSA / BES
            </button>
            <button
              onClick={() => setFilterType("con_note")}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                filterType === "con_note"
                  ? "bg-amber-100 text-amber-900 font-semibold border border-amber-300"
                  : "text-amber-800 bg-amber-50 hover:bg-amber-100"
              }`}
            >
              Con Note
            </button>
          </div>
        </div>
      </div>

      {/* Students List / Grid */}
      {filteredStudents.length === 0 ? (
        <div className="bg-white rounded-2xl p-10 border border-stone-200 text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-stone-100 text-stone-400 mx-auto flex items-center justify-center">
            <Users className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-stone-800">Nessun alunno trovato</h3>
          <p className="text-xs sm:text-sm text-stone-500 max-w-sm mx-auto">
            Non ci sono alunni corrispondenti ai filtri impostati. Prova a modificare la ricerca o aggiungi un nuovo alunno.
          </p>
          <button
            onClick={handleOpenAddStudent}
            className="inline-flex items-center px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-700 text-white hover:bg-emerald-800 transition-colors shadow-xs"
          >
            <UserPlus className="w-4 h-4 mr-1.5" />
            Aggiungi Alunno
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredStudents.map((student) => {
            const noteCount = student.notes?.length || 0;
            const lastNote = noteCount > 0 ? student.notes[0] : null;

            return (
              <div
                key={student.id}
                className="bg-white rounded-2xl p-5 border border-stone-200 shadow-xs hover:shadow-md transition-shadow flex flex-col justify-between"
              >
                <div>
                  {/* Card Header: Name & Class */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center space-x-2">
                        <h3 className="text-base font-bold text-stone-900 tracking-tight">
                          {student.fullName}
                        </h3>
                        <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-stone-100 text-stone-700 border border-stone-200">
                          {student.className}
                        </span>
                      </div>
                      {student.birthDate && (
                        <p className="text-xs text-stone-400 mt-0.5">
                          Nato il {new Date(student.birthDate).toLocaleDateString("it-IT")}
                        </p>
                      )}
                    </div>

                    {studentIdConfirmingDelete === student.id ? (
                      <div className="flex items-center space-x-1.5 bg-rose-50 border border-rose-300 px-2 py-1 rounded-lg text-xs animate-in fade-in duration-100">
                        <span className="text-[11px] font-bold text-rose-800">Elimina?</span>
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!await save.run(() => onDeleteStudent(student.id))) return;
                            if (selectedStudentForDetail?.id === student.id) {
                              setSelectedStudentForDetail(null);
                            }
                            setStudentIdConfirmingDelete(null);
                          }}
                          className="px-2 py-0.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-md shadow-2xs text-[11px] transition-colors"
                        >
                          Sì
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setStudentIdConfirmingDelete(null);
                          }}
                          className="px-1.5 py-0.5 text-stone-600 hover:text-stone-900 font-semibold text-[11px] transition-colors"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center space-x-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenEditStudent(student);
                          }}
                          className="p-1.5 text-stone-400 hover:text-stone-700 rounded-lg hover:bg-stone-100 transition-colors"
                          title="Modifica dati alunno"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setStudentIdConfirmingDelete(student.id);
                          }}
                          className="p-1.5 text-stone-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-colors"
                          title="Elimina alunno"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Special Badges (Support, DSA, GLO) */}
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {student.isSupportStudent && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
                        <HeartHandshake className="w-3 h-3 mr-1 text-emerald-700" />
                        Sostegno ({student.supportHoursPerWeek || 9}h - PEI {student.peiType || "ord."})
                      </span>
                    )}
                    {student.hasBesDsa && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-purple-100 text-purple-900 border border-purple-300">
                        DSA / BES (PDP)
                      </span>
                    )}
                    {student.gloDate && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-300">
                        <Calendar className="w-3 h-3 mr-1 text-amber-700" />
                        GLO: {student.gloDate}
                      </span>
                    )}
                  </div>

                  {/* Diagnostic / Educational note preview */}
                  {student.diagnosticSummary && (
                    <div className="mt-3 p-2.5 bg-stone-50 rounded-xl border border-stone-200/70 text-xs text-stone-700 line-clamp-2">
                      <span className="font-semibold text-stone-900">Sintesi: </span>
                      {student.diagnosticSummary}
                    </div>
                  )}

                  {/* Parent Contact Info Preview */}
                  {student.contactParents && (student.contactParents.phone || student.contactParents.parentNames) && (
                    <div className="mt-2.5 flex items-center space-x-3 text-xs text-stone-600">
                      {student.contactParents.parentNames && (
                        <span className="truncate">Fam: {student.contactParents.parentNames}</span>
                      )}
                      {student.contactParents.phone && (
                        <a
                          href={`tel:${student.contactParents.phone}`}
                          className="inline-flex items-center text-emerald-700 font-medium hover:underline flex-shrink-0"
                        >
                          <Phone className="w-3 h-3 mr-1" />
                          {student.contactParents.phone}
                        </a>
                      )}
                    </div>
                  )}

                  {/* Recent Note Preview */}
                  {lastNote && (
                    <div className="mt-3 pt-3 border-t border-stone-100">
                      <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
                        <span className="font-medium text-stone-600 flex items-center">
                          <MessageSquare className="w-3 h-3 mr-1 text-stone-400" />
                          Ultima nota ({noteCount} totali)
                        </span>
                        <span>{lastNote.date}</span>
                      </div>
                      <p className="text-xs text-stone-600 font-medium line-clamp-1">
                        {lastNote.title}
                      </p>
                      <p className="text-xs text-stone-500 line-clamp-1 italic mt-0.5">
                        "{lastNote.content}"
                      </p>
                    </div>
                  )}
                </div>

                {/* Card Actions */}
                <div className="mt-4 pt-3 border-t border-stone-100 flex items-center justify-between gap-2">
                  <button
                    onClick={() => setSelectedStudentForDetail(student)}
                    className="inline-flex items-center text-xs font-bold text-purple-700 hover:text-purple-900 transition-colors"
                  >
                    <span>Apri Scheda & Diario</span>
                    <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
                  </button>

                  <div className="flex items-center space-x-1.5">
                    {student.isSupportStudent && (
                      <button
                        onClick={() => handleScheduleGlo(student)}
                        className="px-2 py-1 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 transition-colors"
                        title="Fissa riunione GLO nel calendario"
                      >
                        + GLO
                      </button>
                    )}
                    <button
                      onClick={() => handleScheduleParentMeeting(student)}
                      className="px-2 py-1 rounded-lg text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 transition-colors"
                      title="Fissa colloquio con i genitori nel calendario"
                    >
                      + Colloquio
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* STUDENT DETAIL & NOTES MODAL / DRAWER */}
      {activeDetailStudent && (
        <div className="app-modal fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-150">
          <div className="app-modal-panel bg-white w-full max-w-3xl rounded-2xl shadow-2xl border border-stone-200 overflow-hidden flex flex-col max-h-[92vh]">
            {/* Modal Header */}
            <div className="px-4 py-3 sm:px-6 sm:py-4 bg-stone-900 text-white flex items-center justify-between gap-2">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-purple-600 text-white flex items-center justify-center font-bold">
                  {activeDetailStudent.fullName.charAt(0)}
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <h2 className="text-lg font-bold tracking-tight">
                      {activeDetailStudent.fullName}
                    </h2>
                    <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-white/20 text-white">
                      Classe {activeDetailStudent.className}
                    </span>
                  </div>
                  <p className="text-xs text-stone-300">
                    Scheda alunno & diario note riservate
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={handlePrintStudentSheet}
                  className="p-2 text-stone-300 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
                  title="Stampa scheda alunno e note"
                >
                  <Printer className="w-5 h-5" />
                </button>
                {studentIdConfirmingDelete === activeDetailStudent.id ? (
                  <div className="flex items-center space-x-2 bg-rose-950/90 border border-rose-600 px-3 py-1 rounded-xl text-xs">
                    <span className="text-white text-xs font-bold">Eliminare definitivamente?</span>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!await save.run(() => onDeleteStudent(activeDetailStudent.id))) return;
                        setSelectedStudentForDetail(null);
                        setStudentIdConfirmingDelete(null);
                      }}
                      className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg text-xs transition-colors"
                    >
                      Sì, Elimina
                    </button>
                    <button
                      type="button"
                      onClick={() => setStudentIdConfirmingDelete(null)}
                      className="px-2 py-1 text-stone-300 hover:text-white font-medium text-xs transition-colors"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setStudentIdConfirmingDelete(activeDetailStudent.id)}
                    className="p-2 text-rose-300 hover:text-white rounded-lg hover:bg-rose-500/20 transition-colors"
                    title="Elimina scheda alunno"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedStudentForDetail(null)}
                  className="p-2 text-stone-300 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body: Scrollable */}
            <div className="p-4 sm:p-6 overflow-y-auto space-y-6 momentum-scroll">
              {/* Quick Profile Summary Box */}
              <div className="bg-stone-50 rounded-2xl p-4 border border-stone-200/80 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-2">
                    {activeDetailStudent.isSupportStudent && (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
                        <HeartHandshake className="w-3.5 h-3.5 mr-1 text-emerald-700" />
                        Sostegno L. 104/92: {activeDetailStudent.supportHoursPerWeek || 9} ore settimanali (PEI {activeDetailStudent.peiType})
                      </span>
                    )}
                    {activeDetailStudent.hasBesDsa && (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-purple-100 text-purple-900 border border-purple-300">
                        DSA / BES (PDP approvato)
                      </span>
                    )}
                    {activeDetailStudent.gloDate && (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-300">
                        <Calendar className="w-3.5 h-3.5 mr-1 text-amber-700" />
                        Data GLO: {activeDetailStudent.gloDate}
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => handleOpenEditStudent(activeDetailStudent)}
                    className="inline-flex items-center text-xs font-semibold text-stone-600 hover:text-stone-900 underline"
                  >
                    <Edit3 className="w-3.5 h-3.5 mr-1" />
                    Modifica dati
                  </button>
                </div>

                {/* Diagnostic Details & Specialists */}
                {activeDetailStudent.diagnosticSummary && (
                  <div className="text-xs text-stone-700">
                    <p className="font-semibold text-stone-900 mb-0.5">Sintesi Diagnostica / Funzionamento:</p>
                    <p className="bg-white p-2.5 rounded-xl border border-stone-200 leading-relaxed">
                      {activeDetailStudent.diagnosticSummary}
                    </p>
                  </div>
                )}

                {activeDetailStudent.specialists && (
                  <div className="text-xs text-stone-700">
                    <span className="font-semibold text-stone-900">Équipe & Terapisti di riferimento: </span>
                    <span>{activeDetailStudent.specialists}</span>
                  </div>
                )}

                {/* Parent Contacts Details */}
                {activeDetailStudent.contactParents && (
                  <div className="pt-2 border-t border-stone-200/60 flex flex-wrap items-center gap-4 text-xs text-stone-700">
                    {activeDetailStudent.contactParents.parentNames && (
                      <span>
                        <strong className="text-stone-900">Genitori:</strong> {activeDetailStudent.contactParents.parentNames}
                      </span>
                    )}
                    {activeDetailStudent.contactParents.phone && (
                      <a
                        href={`tel:${activeDetailStudent.contactParents.phone}`}
                        className="inline-flex items-center text-emerald-700 font-semibold hover:underline"
                      >
                        <Phone className="w-3 h-3 mr-1" />
                        {activeDetailStudent.contactParents.phone}
                      </a>
                    )}
                    {activeDetailStudent.contactParents.email && (
                      <a
                        href={`mailto:${activeDetailStudent.contactParents.email}`}
                        className="inline-flex items-center text-purple-700 font-semibold hover:underline"
                      >
                        <Mail className="w-3 h-3 mr-1" />
                        {activeDetailStudent.contactParents.email}
                      </a>
                    )}
                    {activeDetailStudent.contactParents.notes && (
                      <span className="text-stone-500 italic">
                        ({activeDetailStudent.contactParents.notes})
                      </span>
                    )}
                  </div>
                )}

                {/* Quick Calendar Schedulers */}
                <div className="pt-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => handleScheduleGlo(activeDetailStudent)}
                    className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-700 text-white hover:bg-emerald-800 transition-colors shadow-xs"
                  >
                    <Calendar className="w-3.5 h-3.5 mr-1.5" />
                    Pianifica GLO in Agenda
                  </button>
                  <button
                    onClick={() => handleScheduleParentMeeting(activeDetailStudent)}
                    className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 transition-colors shadow-xs"
                  >
                    <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
                    Fissa Colloquio Famiglia
                  </button>
                </div>
              </div>

              {/* DIARY / NOTES SECTION */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-stone-900 flex items-center">
                    <FileText className="w-4 h-4 mr-2 text-purple-700" />
                    Diario Note & Colloqui ({activeDetailStudent.notes?.length || 0})
                  </h3>
                  <span className="text-xs text-stone-400">
                    Cronologia annotazioni riservate
                  </span>
                </div>

                {/* Add New Note Box */}
                <form
                  onSubmit={handleAddNoteSubmit}
                  className="bg-purple-50/50 rounded-2xl p-4 border border-purple-200/80 space-y-3"
                >
              {save.error && <p role="alert" className="text-sm text-rose-700">{save.error}</p>}
                  <div className="flex items-center space-x-2">
                    <Plus className="w-4 h-4 text-purple-700 font-bold" />
                    <span className="text-xs font-bold text-purple-900 uppercase tracking-wide">
                      Aggiungi nuova annotazione
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-stone-600 mb-1">
                        Data
                      </label>
                      <input
                        type="date"
                        value={newNoteDate}
                        onChange={(e) => setNewNoteDate(e.target.value)}
                        className="w-full px-3 py-1.5 bg-white border border-stone-200 rounded-lg text-xs focus:ring-2 focus:ring-purple-500 focus:outline-none"
                        required
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-stone-600 mb-1">
                        Categoria
                      </label>
                      <select
                        value={newNoteCategory}
                        onChange={(e) => setNewNoteCategory(e.target.value as StudentNoteCategory)}
                        className="w-full px-3 py-1.5 bg-white border border-stone-200 rounded-lg text-xs focus:ring-2 focus:ring-purple-500 focus:outline-none"
                      >
                        {Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => (
                          <option key={key} value={key}>
                            {cfg.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-stone-600 mb-1">
                        Titolo / Oggetto
                      </label>
                      <input
                        type="text"
                        value={newNoteTitle}
                        onChange={(e) => setNewNoteTitle(e.target.value)}
                        placeholder="Es: Raccordo con terapista, Colloquio madre..."
                        className="w-full px-3 py-1.5 bg-white border border-stone-200 rounded-lg text-xs focus:ring-2 focus:ring-purple-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-stone-600 mb-1">
                      Contenuto nota
                    </label>
                    <textarea
                      rows={3}
                      value={newNoteContent}
                      onChange={(e) => setNewNoteContent(e.target.value)}
                      placeholder="Descrivi quanto emerso dall'incontro, accordi con la famiglia, osservazioni sul comportamento o sull'apprendimento..."
                      className="w-full px-3 py-2 bg-white border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-purple-500 focus:outline-none resize-y"
                      required
                    />
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="submit" disabled={save.pending}
                      className="px-4 py-2 bg-purple-700 hover:bg-purple-800 text-white rounded-xl text-xs font-semibold transition-colors shadow-xs"
                    >
                      Salva Nota nel Diario
                    </button>
                  </div>
                </form>

                {/* Notes List */}
                <div className="space-y-3 pt-2">
                  {!activeDetailStudent.notes || activeDetailStudent.notes.length === 0 ? (
                    <div className="text-center py-6 bg-stone-50 rounded-xl border border-stone-200 text-stone-400 text-xs">
                      Nessuna nota registrata per questo alunno. Usa il modulo sopra per inserire la prima osservazione.
                    </div>
                  ) : (
                    activeDetailStudent.notes.map((note) => {
                      const cfg = CATEGORY_CONFIG[note.category] || CATEGORY_CONFIG.altro;
                      const Icon = cfg.icon;

                      return (
                        <div
                          key={note.id}
                          className="p-4 bg-white rounded-xl border border-stone-200 hover:border-stone-300 transition-colors space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-2">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold border ${cfg.badgeClass}`}
                              >
                                <Icon className="w-3 h-3 mr-1" />
                                {cfg.label}
                              </span>
                              <span className="text-xs font-bold text-stone-800">
                                {note.title}
                              </span>
                            </div>

                            <div className="flex items-center space-x-2">
                              <span className="text-[11px] text-stone-400 flex items-center">
                                <Clock className="w-3 h-3 mr-1" />
                                {note.date}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setNoteToDelete({
                                    studentId: activeDetailStudent.id,
                                    noteId: note.id,
                                    title: note.title,
                                  })
                                }
                                className="text-stone-300 hover:text-rose-600 p-1 rounded-md transition-colors"
                                title="Elimina nota"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          <p className="text-xs text-stone-700 whitespace-pre-wrap leading-relaxed">
                            {note.content}
                          </p>

                          {note.author && (
                            <p className="text-[10px] text-stone-400 pt-1">
                              Registrato da: {note.author}
                            </p>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 bg-stone-50 border-t border-stone-200 flex justify-end">
              <button
                onClick={() => setSelectedStudentForDetail(null)}
                className="px-4 py-2 bg-stone-200 hover:bg-stone-300 text-stone-800 text-xs font-semibold rounded-xl transition-colors"
              >
                Chiudi Scheda
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD / EDIT STUDENT MODAL */}
      {isEditModalOpen && studentToEdit && (
        <div className="app-modal fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-150">
          <div className="app-modal-panel bg-white w-full max-w-xl rounded-2xl shadow-2xl border border-stone-200 overflow-hidden">
            <div className="px-4 py-3 sm:px-6 sm:py-4 bg-stone-900 text-white flex items-center justify-between">
              <h2 className="text-base sm:text-lg font-bold">
                {students.some((s) => s.id === studentToEdit.id)
                  ? `Modifica Alunno: ${studentToEdit.fullName}`
                  : "Nuovo Alunno"}
              </h2>
              <button
                onClick={() => setIsEditModalOpen(false)}
                className="p-1 text-stone-400 hover:text-white rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveStudentSubmit} className="p-4 sm:p-6 space-y-4 max-h-[80vh] overflow-y-auto momentum-scroll">
              {save.error && <p role="alert" className="text-sm text-rose-700">{save.error}</p>}
              {/* Dati Anagrafici */}
              <div className="space-y-3">
                <h3 className="text-xs font-bold text-stone-400 uppercase tracking-wider">
                  Dati Anagrafici
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Cognome e Nome *
                    </label>
                    <input
                      type="text"
                      value={studentToEdit.fullName}
                      onChange={(e) =>
                        setStudentToEdit({ ...studentToEdit, fullName: e.target.value })
                      }
                      placeholder="Es: Rossi Matteo"
                      className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-purple-500 focus:bg-white focus:outline-none"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Classe *
                    </label>
                    {teacherClasses.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {teacherClasses.map((cls) => (
                          <button
                            key={cls}
                            type="button"
                            onClick={() =>
                              setStudentToEdit({ ...studentToEdit, className: cls })
                            }
                            className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${
                              studentToEdit.className.trim().toUpperCase() === cls
                                ? "bg-purple-700 text-white shadow-2xs"
                                : "bg-purple-50 text-purple-800 border border-purple-200 hover:bg-purple-100"
                            }`}
                          >
                            {cls}
                          </button>
                        ))}
                      </div>
                    )}
                    <input
                      type="text"
                      value={studentToEdit.className}
                      onChange={(e) =>
                        setStudentToEdit({ ...studentToEdit, className: e.target.value.toUpperCase() })
                      }
                      placeholder="Es: 1A, 2E..."
                      className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-purple-500 focus:bg-white focus:outline-none font-semibold uppercase"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Data di Nascita (opzionale)
                  </label>
                  <input
                    type="date"
                    value={studentToEdit.birthDate || ""}
                    onChange={(e) =>
                      setStudentToEdit({ ...studentToEdit, birthDate: e.target.value })
                    }
                    className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-purple-500 focus:bg-white focus:outline-none"
                  />
                </div>
              </div>

              {/* Sostegno & Inclusione */}
              <div className="pt-3 border-t border-stone-100 space-y-3">
                <h3 className="text-xs font-bold text-stone-400 uppercase tracking-wider">
                  Inclusione & Bisogni Educativi
                </h3>

                {/* Sostegno Checkbox */}
                <div className="p-3 bg-emerald-50/50 rounded-xl border border-emerald-200 space-y-3">
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!studentToEdit.isSupportStudent}
                      onChange={(e) =>
                        setStudentToEdit({
                          ...studentToEdit,
                          isSupportStudent: e.target.checked,
                        })
                      }
                      className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 border-stone-300"
                    />
                    <span className="text-xs font-bold text-emerald-950">
                      Alunno con Sostegno Didattico (L. 104/92)
                    </span>
                  </label>

                  {studentToEdit.isSupportStudent && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Tipo PEI
                        </label>
                        <select
                          value={studentToEdit.peiType || "ordinario"}
                          onChange={(e) =>
                            setStudentToEdit({
                              ...studentToEdit,
                              peiType: e.target.value as any,
                            })
                          }
                          className="w-full px-3 py-1.5 bg-white border border-stone-200 rounded-lg text-xs"
                        >
                          <option value="ordinario">PEI Ordinario (Obiettivi minimi/riconducibili)</option>
                          <option value="differenziato">PEI Differenziato</option>
                          <option value="personalizzato">PEI Personalizzato</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Ore settimanali sostegno
                        </label>
                        <input
                          type="number"
                          min="1"
                          max="25"
                          value={studentToEdit.supportHoursPerWeek || 9}
                          onChange={(e) =>
                            setStudentToEdit({
                              ...studentToEdit,
                              supportHoursPerWeek: Number(e.target.value),
                            })
                          }
                          className="w-full px-3 py-1.5 bg-white border border-stone-200 rounded-lg text-xs"
                        />
                      </div>

                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
                          Data Programmata G.L.O.
                        </label>
                        <input
                          type="date"
                          value={studentToEdit.gloDate || ""}
                          onChange={(e) =>
                            setStudentToEdit({ ...studentToEdit, gloDate: e.target.value })
                          }
                          className="w-full px-3 py-1.5 bg-white border border-stone-200 rounded-lg text-xs"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* DSA / BES Checkbox */}
                <div className="p-3 bg-purple-50/50 rounded-xl border border-purple-200">
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!studentToEdit.hasBesDsa}
                      onChange={(e) =>
                        setStudentToEdit({
                          ...studentToEdit,
                          hasBesDsa: e.target.checked,
                        })
                      }
                      className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 border-stone-300"
                    />
                    <span className="text-xs font-bold text-purple-950">
                      Alunno DSA / BES (con Piano Didattico Personalizzato - PDP)
                    </span>
                  </label>
                </div>

                {/* Sintesi Diagnostica / Note Funzionali */}
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Sintesi Diagnostica / Profilo di Funzionamento (Riservato)
                  </label>
                  <textarea
                    rows={2}
                    value={studentToEdit.diagnosticSummary || ""}
                    onChange={(e) =>
                      setStudentToEdit({
                        ...studentToEdit,
                        diagnosticSummary: e.target.value,
                      })
                    }
                    placeholder="Es: Disturbo spettro autistico, dislessia evolutiva, strategie suggerite..."
                    className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-purple-500 focus:bg-white focus:outline-none"
                  />
                </div>

                {/* Specialisti */}
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Équipe specialistica / Educatore AEC
                  </label>
                  <input
                    type="text"
                    value={studentToEdit.specialists || ""}
                    onChange={(e) =>
                      setStudentToEdit({ ...studentToEdit, specialists: e.target.value })
                    }
                    placeholder="Es: NPI Dott.ssa Rossi (ASL RM1), Educatrice Elena"
                    className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-purple-500 focus:bg-white focus:outline-none"
                  />
                </div>
              </div>

              {/* Contatti Famiglia */}
              <div className="pt-3 border-t border-stone-100 space-y-3">
                <h3 className="text-xs font-bold text-stone-400 uppercase tracking-wider">
                  Contatti Famiglia per Colloqui
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Nomi Genitori
                    </label>
                    <input
                      type="text"
                      value={studentToEdit.contactParents?.parentNames || ""}
                      onChange={(e) =>
                        setStudentToEdit({
                          ...studentToEdit,
                          contactParents: {
                            ...studentToEdit.contactParents,
                            parentNames: e.target.value,
                          },
                        })
                      }
                      placeholder="Es: Marco e Laura Rossi"
                      className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-purple-500 focus:bg-white focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Telefono Recapito
                    </label>
                    <input
                      type="tel"
                      value={studentToEdit.contactParents?.phone || ""}
                      onChange={(e) =>
                        setStudentToEdit({
                          ...studentToEdit,
                          contactParents: {
                            ...studentToEdit.contactParents,
                            phone: e.target.value,
                          },
                        })
                      }
                      placeholder="Es: 338 1234567"
                      className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-purple-500 focus:bg-white focus:outline-none"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Email o Note di reperibilità
                    </label>
                    <input
                      type="text"
                      value={studentToEdit.contactParents?.email || ""}
                      onChange={(e) =>
                        setStudentToEdit({
                          ...studentToEdit,
                          contactParents: {
                            ...studentToEdit.contactParents,
                            email: e.target.value,
                          },
                        })
                      }
                      placeholder="Es: famiglia.rossi@email.it - Ricevimento preferito il venerdì"
                      className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:ring-2 focus:ring-purple-500 focus:bg-white focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Submit / Cancel buttons */}
              <div className="pt-4 border-t border-stone-100 flex items-center justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setIsEditModalOpen(false)}
                  className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold rounded-xl transition-colors"
                >
                  Annulla
                </button>
                <button
                  type="submit" disabled={save.pending}
                  className="px-5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold rounded-xl transition-colors shadow-xs"
                >
                  Salva Scheda Alunno
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Student Confirmation Modal */}
      {studentToDelete && (
        <div className="fixed inset-0 z-[9999] bg-stone-900/70 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-stone-200 space-y-4 animate-in zoom-in-95 duration-100">
            <div className="w-12 h-12 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
              <Trash2 className="w-6 h-6" />
            </div>
            <div className="text-center space-y-1.5">
              <h3 className="text-base font-bold text-stone-900">
                Eliminare la scheda di {studentToDelete.fullName}?
              </h3>
              <p className="text-xs text-stone-500 leading-relaxed">
                Verranno eliminati la scheda anagrafica, i recapiti e tutte le annotazioni o verbali riservati associati all'alunno (Classe {studentToDelete.className}). L'operazione non può essere annullata.
              </p>
            </div>
            <div className="flex items-center space-x-2 pt-2">
              <button
                type="button"
                onClick={() => setStudentToDelete(null)}
                className="flex-1 py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl transition-colors"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={async () => {
                  const idToDelete = studentToDelete.id;
                  if (!await save.run(() => onDeleteStudent(idToDelete))) return;
                  if (selectedStudentForDetail?.id === idToDelete) {
                    setSelectedStudentForDetail(null);
                  }
                  setStudentToDelete(null);
                }}
                className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs rounded-xl shadow-xs transition-colors"
              >
                Elimina Alunno
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Note Confirmation Modal */}
      {noteToDelete && (
        <div className="fixed inset-0 z-[9999] bg-stone-900/70 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-stone-200 space-y-4 animate-in zoom-in-95 duration-100">
            <div className="w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center mx-auto">
              <Trash2 className="w-6 h-6" />
            </div>
            <div className="text-center space-y-1.5">
              <h3 className="text-base font-bold text-stone-900">
                Eliminare questa annotazione?
              </h3>
              <p className="text-xs text-stone-500 leading-relaxed">
                "{noteToDelete.title}" verrà rimossa dal diario dell'alunno.
              </p>
            </div>
            <div className="flex items-center space-x-2 pt-2">
              <button
                type="button"
                onClick={() => setNoteToDelete(null)}
                className="flex-1 py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl transition-colors"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!await save.run(() => onDeleteNote(noteToDelete.studentId, noteToDelete.noteId))) return;
                  setNoteToDelete(null);
                }}
                className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs rounded-xl shadow-xs transition-colors"
              >
                Elimina Nota
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear All Students Confirmation Modal */}
      {showClearAllConfirm && (
        <div className="fixed inset-0 z-50 bg-stone-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-stone-200 space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div className="text-center space-y-1.5">
              <h3 className="text-base font-bold text-stone-900">
                Svuotare l'elenco alunni?
              </h3>
              <p className="text-xs text-stone-500 leading-relaxed">
                Tutti i {students.length} alunni (inclusi dati di sostegno, verbali e note) verranno rimossi. Potrai reinserire i tuoi studenti in qualsiasi momento.
              </p>
            </div>
            <div className="flex items-center space-x-2 pt-2">
              <button
                type="button"
                onClick={() => setShowClearAllConfirm(false)}
                className="flex-1 py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl transition-colors"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={() => {
                  if (onClearAllStudents) {
                    onClearAllStudents();
                  } else {
                    students.forEach((s) => onDeleteStudent(s.id));
                  }
                  setSelectedStudentForDetail(null);
                  setShowClearAllConfirm(false);
                }}
                className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs rounded-xl shadow-xs transition-colors"
              >
                Svuota Tutto
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
