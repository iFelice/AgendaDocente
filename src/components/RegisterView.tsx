import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { localDateISO } from "../utils/dates";
import { compareStudentNames, isStudentActive } from "../utils/studentMatcher";
import type { Student, StudentAssessment, StudentAssessmentType, StudentScheduledAssessment, TeacherProfile } from "../types";

interface RegisterViewProps {
  profile: TeacherProfile;
  students: Student[];
  assessments: StudentAssessment[];
  scheduledAssessments?: StudentScheduledAssessment[];
  initialStudentId?: string | null;
  onBackToOrigin?: () => void;
  onSaveAssessment: (assessment: StudentAssessment) => void | false | Promise<void | false>;
  onDeleteAssessment: (id: string) => void | false | Promise<void | false>;
  onSaveScheduledAssessment: (assessment: StudentScheduledAssessment) => void | false | Promise<void | false>;
  onDeleteScheduledAssessment: (id: string) => void | false | Promise<void | false>;
}

export const TYPE_LABELS: Record<StudentAssessmentType, string> = {
  oral: "Interrogazione",
  written: "Scritta",
  practical: "Pratica",
  other: "Altro",
};

const inputClass = "mt-1 min-h-[44px] w-full rounded-xl border border-stone-300 bg-white px-3 text-base text-stone-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100";

export const getActiveRegisterStudents = (students: Student[]) => students.filter(isStudentActive).sort(compareStudentNames);
export const getRegisterClasses = (profile: TeacherProfile, students: Student[]) => {
  const names = new Set<string>();
  (profile.classes ?? []).forEach(name => name.trim() && names.add(name.trim().toUpperCase()));
  getActiveRegisterStudents(students).forEach(student => student.className.trim() && names.add(student.className.trim().toUpperCase()));
  return [...names].sort();
};
export const sortStudentAssessments = (assessments: StudentAssessment[]) => [...assessments].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
export const parseAssessmentNumericInput = (value: string) => Number(value.trim().replace(",", "."));
export const sortScheduledAssessments = (items: StudentScheduledAssessment[]) => [...items].sort((a, b) => (a.status === "scheduled" ? 0 : 1) - (b.status === "scheduled" ? 0 : 1) || a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));

const SCHEDULED_TYPE_LABELS: Record<StudentAssessmentType, string> = { oral: "Interrogazione", written: "Verifica scritta", practical: "Prova pratica", other: "Altro" };

function ScheduledAssessmentForm({ student, initial, onClose, onSave, onDelete }: { student: Student; initial: StudentScheduledAssessment | null; onClose: () => void; onSave: (item: StudentScheduledAssessment) => Promise<void | false>; onDelete: (id: string) => Promise<void | false> }) {
  const [date, setDate] = useState(initial?.date ?? localDateISO());
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [assessmentType, setAssessmentType] = useState<StudentAssessmentType>(initial?.assessmentType ?? "oral");
  const [topic, setTopic] = useState(initial?.topic ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!date) return setError("Inserisci una data."); setSaving(true); setError(null);
    const result = await onSave({ ...initial, id: initial?.id ?? `scheduled-${crypto.randomUUID()}`, studentId: student.id, className: initial?.className ?? student.className, ...(student.schoolId ? { schoolId: initial?.schoolId ?? student.schoolId } : {}), ...(student.schoolYear ? { schoolYear: initial?.schoolYear ?? student.schoolYear } : {}), date, ...(subject.trim() ? { subject: subject.trim() } : {}), assessmentType, ...(topic.trim() ? { topic: topic.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}), status: initial?.status ?? "scheduled", createdAt: initial?.createdAt ?? new Date().toISOString(), updatedAt: initial?.updatedAt ?? "" });
    setSaving(false); if (result === false) setError("Salvataggio non riuscito.");
  };
  const statusAction = async (status: "completed" | "cancelled") => { if (!initial) return; setSaving(true); await onSave({ ...initial, status }); setSaving(false); };
  const remove = async () => { if (!initial || !window.confirm("Eliminare definitivamente questa prova programmata?")) return; setSaving(true); const result = await onDelete(initial.id); setSaving(false); if (result === false) setError("Eliminazione non riuscita."); };
  return <div className="fixed inset-0 z-[80] flex items-end justify-center bg-stone-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="scheduled-form-title"><form onSubmit={submit} className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:p-6"><div className="mb-4 flex items-center justify-between"><h2 id="scheduled-form-title" className="text-lg font-bold">{initial ? "Modifica prova programmata" : "Nuova prova programmata"}</h2><button type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-xl" aria-label="Chiudi form"><X /></button></div><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-semibold">Data<input aria-label="Data" type="date" required value={date} onChange={e => setDate(e.target.value)} className={inputClass} /></label><label className="text-sm font-semibold">Materia <span className="font-normal text-stone-400">(opzionale)</span><input aria-label="Materia" value={subject} onChange={e => setSubject(e.target.value)} className={inputClass} /></label></div><label className="mt-4 block text-sm font-semibold">Tipo prova<select aria-label="Tipo prova" value={assessmentType} onChange={e => setAssessmentType(e.target.value as StudentAssessmentType)} className={inputClass}>{Object.entries(SCHEDULED_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="mt-4 block text-sm font-semibold">Argomento <span className="font-normal text-stone-400">(opzionale)</span><textarea aria-label="Argomento" placeholder="Es. equazioni di primo grado" rows={3} maxLength={500} value={topic} onChange={e => setTopic(e.target.value)} className={`${inputClass} py-2`} /></label><label className="mt-4 block text-sm font-semibold">Note <span className="font-normal text-stone-400">(opzionale)</span><textarea aria-label="Note" rows={2} value={note} onChange={e => setNote(e.target.value)} className={`${inputClass} py-2`} /></label>{error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}{initial && <div className="mt-4 grid gap-2 sm:grid-cols-2"><button type="button" disabled={saving} onClick={() => void statusAction("completed")} className="min-h-[44px] rounded-xl border border-emerald-300 px-3 font-semibold text-emerald-800">Segna come completata</button><button type="button" disabled={saving} onClick={() => void statusAction("cancelled")} className="min-h-[44px] rounded-xl border border-amber-300 px-3 font-semibold text-amber-800">Annulla prova</button></div>}<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">{initial ? <button type="button" disabled={saving} onClick={() => void remove()} className="min-h-[44px] px-2 font-semibold text-rose-700">Elimina</button> : <span />}{<div className="flex gap-2"><button type="button" onClick={onClose} className="min-h-[44px] rounded-xl border px-4">Chiudi</button><button type="submit" disabled={saving} className="min-h-[44px] rounded-xl bg-emerald-700 px-5 font-semibold text-white">Salva</button></div>}</div></form></div>;
}

function AssessmentForm({
  student,
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  student: Student;
  initial: StudentAssessment | null;
  onClose: () => void;
  onSave: (assessment: StudentAssessment) => Promise<void | false>;
  onDelete: (id: string) => Promise<void | false>;
}) {
  const [date, setDate] = useState(initial?.date ?? localDateISO());
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [assessmentType, setAssessmentType] = useState<StudentAssessmentType>(initial?.assessmentType ?? "oral");
  const [valueKind, setValueKind] = useState<"numeric" | "judgement">(initial?.valueKind ?? "numeric");
  const [numericDraft, setNumericDraft] = useState(initial?.numericValue === undefined ? "" : String(initial.numericValue));
  const [judgementValue, setJudgementValue] = useState(initial?.judgementValue ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const normalized = numericDraft.trim().replace(",", ".");
    const numericValue = parseAssessmentNumericInput(numericDraft);
    if (!date) return setError("Inserisci una data.");
    if (valueKind === "numeric" && (!normalized || !Number.isFinite(numericValue))) return setError("Inserisci un valore numerico valido.");
    if (valueKind === "judgement" && !judgementValue.trim()) return setError("Inserisci un giudizio.");
    setSaving(true);
    const result = await onSave({
      id: initial?.id ?? "",
      studentId: initial?.studentId ?? student.id,
      schoolId: initial?.schoolId ?? student.schoolId,
      schoolYear: initial?.schoolYear ?? student.schoolYear,
      className: initial?.className ?? student.className,
      date,
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      assessmentType,
      valueKind,
      ...(valueKind === "numeric" ? { numericValue } : { judgementValue: judgementValue.trim() }),
      ...(note.trim() ? { note: note.trim() } : {}),
      createdAt: initial?.createdAt ?? "",
      updatedAt: initial?.updatedAt ?? "",
    });
    setSaving(false);
    if (result === false) setError("Salvataggio non riuscito. I dati inseriti sono stati mantenuti.");
  };

  const remove = async () => {
    if (!initial || !window.confirm("Eliminare questa valutazione?")) return;
    setError(null);
    setSaving(true);
    const result = await onDelete(initial.id);
    setSaving(false);
    if (result === false) setError("Eliminazione non riuscita. La valutazione è ancora presente.");
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-stone-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="assessment-form-title">
      <form onSubmit={submit} className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="assessment-form-title" className="text-lg font-bold text-stone-900">{initial ? "Modifica valutazione" : "Nuova valutazione"}</h2>
          <button type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-xl text-stone-500 hover:bg-stone-100" aria-label="Chiudi form"><X className="h-5 w-5" /></button>
        </div>
        <p className="mb-4 text-sm text-stone-600">{student.fullName}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-semibold">Data<input aria-label="Data" type="date" value={date} onChange={e => setDate(e.target.value)} className={inputClass} /></label>
          <label className="text-sm font-semibold">Materia <span className="font-normal text-stone-400">(opzionale)</span><input aria-label="Materia" value={subject} onChange={e => setSubject(e.target.value)} className={inputClass} /></label>
          <label className="text-sm font-semibold">Tipo prova<select aria-label="Tipo prova" value={assessmentType} onChange={e => setAssessmentType(e.target.value as StudentAssessmentType)} className={inputClass}>{Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="text-sm font-semibold">Tipo valutazione<select aria-label="Tipo valutazione" value={valueKind} onChange={e => setValueKind(e.target.value as "numeric" | "judgement")} className={inputClass}><option value="numeric">Numerica</option><option value="judgement">Giudizio</option></select></label>
        </div>
        {valueKind === "numeric" ? (
          <label className="mt-4 block text-sm font-semibold">Valore numerico<input aria-label="Valore numerico" inputMode="decimal" type="text" value={numericDraft} onChange={e => setNumericDraft(e.target.value)} className={inputClass} placeholder="es. 7,5" /></label>
        ) : (
          <label className="mt-4 block text-sm font-semibold">Giudizio<input aria-label="Giudizio" value={judgementValue} onChange={e => setJudgementValue(e.target.value)} className={inputClass} /></label>
        )}
        <label className="mt-4 block text-sm font-semibold">Nota <span className="font-normal text-stone-400">(opzionale)</span><textarea aria-label="Nota" rows={3} value={note} onChange={e => setNote(e.target.value)} className={`${inputClass} py-2`} /></label>
        {error && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</p>}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          {initial ? <button type="button" disabled={saving} onClick={() => void remove()} className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 font-semibold text-rose-700 hover:bg-rose-50"><Trash2 className="h-4 w-4" />Elimina valutazione</button> : <span />}
          <div className="flex gap-2"><button type="button" onClick={onClose} className="min-h-[44px] rounded-xl border border-stone-300 px-4 font-semibold text-stone-700">Annulla</button><button type="submit" disabled={saving} className="min-h-[44px] rounded-xl bg-emerald-700 px-5 font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">{saving ? "Salvataggio…" : "Salva"}</button></div>
        </div>
      </form>
    </div>
  );
}

export const RegisterView: React.FC<RegisterViewProps> = ({ profile, students, assessments, scheduledAssessments = [], initialStudentId, onBackToOrigin, onSaveAssessment, onDeleteAssessment, onSaveScheduledAssessment, onDeleteScheduledAssessment }) => {
  const activeStudents = useMemo(() => getActiveRegisterStudents(students), [students]);
  const initialStudent = initialStudentId ? activeStudents.find(student => student.id === initialStudentId) ?? null : null;
  const classOptions = useMemo(() => getRegisterClasses(profile, students), [profile, students]);
  const [selectedClass, setSelectedClass] = useState(initialStudent?.className.trim().toUpperCase() ?? "");
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(initialStudent?.id ?? null);
  const [editing, setEditing] = useState<StudentAssessment | null | undefined>(undefined);
  const [editingScheduled, setEditingScheduled] = useState<StudentScheduledAssessment | null | undefined>(undefined);
  const [section, setSection] = useState<"assessments" | "scheduled">("assessments");
  useEffect(() => {
    if (initialStudentId === undefined) return;
    const direct = activeStudents.find(student => student.id === initialStudentId) ?? null;
    setSelectedStudentId(direct?.id ?? null);
    setSelectedClass(direct?.className.trim().toUpperCase() ?? "");
  }, [initialStudentId, activeStudents]);
  const visibleStudents = activeStudents.filter(student => !selectedClass || student.className.trim().toUpperCase() === selectedClass);
  const selectedStudent = activeStudents.find(student => student.id === selectedStudentId) ?? null;
  const studentAssessments = selectedStudent ? sortStudentAssessments(assessments.filter(item => item.studentId === selectedStudent.id)) : [];
  const studentScheduled = selectedStudent ? sortScheduledAssessments(scheduledAssessments.filter(item => item.studentId === selectedStudent.id)) : [];

  const save = async (assessment: StudentAssessment) => {
    const now = new Date().toISOString();
    const result = await onSaveAssessment({ ...assessment, id: assessment.id || `assessment-${crypto.randomUUID()}`, studentId: selectedStudent!.id, className: selectedStudent!.className, createdAt: assessment.createdAt || now, updatedAt: assessment.updatedAt || now });
    if (result !== false) setEditing(undefined);
    return result;
  };
  const remove = async (id: string) => {
    const result = await onDeleteAssessment(id);
    if (result !== false) setEditing(undefined);
    return result;
  };

  if (selectedStudent) return <main aria-label="Scheda studente Registro" className="mx-auto max-w-3xl pb-28"><button type="button" onClick={() => onBackToOrigin ? onBackToOrigin() : setSelectedStudentId(null)} className="mb-4 flex min-h-[44px] items-center gap-2 rounded-xl px-2 font-semibold text-emerald-800 hover:bg-emerald-50"><ArrowLeft className="h-5 w-5" />Indietro</button><section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm sm:p-6"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Scheda studente</p><h1 className="mt-1 text-2xl font-bold">{selectedStudent.fullName}</h1><p className="mt-1 text-sm text-stone-500">Classe {selectedStudent.className}</p></div><BookOpen className="h-7 w-7 text-emerald-700" /></div><div className="mt-6 grid grid-cols-2 gap-2 rounded-xl bg-stone-100 p-1" role="tablist"><button type="button" role="tab" aria-selected={section === "assessments"} onClick={() => setSection("assessments")} className={`min-h-[44px] rounded-lg px-2 text-sm font-bold ${section === "assessments" ? "bg-white text-emerald-800 shadow" : "text-stone-600"}`}>Valutazioni</button><button type="button" role="tab" aria-selected={section === "scheduled"} onClick={() => setSection("scheduled")} className={`min-h-[44px] rounded-lg px-2 text-sm font-bold ${section === "scheduled" ? "bg-white text-emerald-800 shadow" : "text-stone-600"}`}>Prove programmate</button></div>{section === "assessments" ? <><div className="mt-6 flex items-center justify-between gap-3"><h2 className="text-lg font-bold">Valutazioni</h2><button type="button" onClick={() => setEditing(null)} className="flex min-h-[44px] items-center gap-2 rounded-xl bg-emerald-700 px-4 font-semibold text-white"><Plus className="h-5 w-5" />Valutazione</button></div>{studentAssessments.length === 0 ? <div className="mt-5 rounded-xl bg-stone-50 p-5 text-sm text-stone-600">Nessuna valutazione registrata.</div> : <ul className="mt-4 divide-y divide-stone-100">{studentAssessments.map(item => <li key={item.id}><button type="button" onClick={() => setEditing(item)} className="flex min-h-[64px] w-full items-center justify-between gap-3 py-3 text-left"><span><span className="block text-sm font-semibold">{item.date}{item.subject ? ` · ${item.subject}` : ""}</span><span className="block text-xs text-stone-500">{TYPE_LABELS[item.assessmentType]}</span></span><span className="font-bold text-emerald-800">{item.valueKind === "numeric" ? item.numericValue : item.judgementValue}</span></button></li>)}</ul>}</> : <><div className="mt-6 flex items-center justify-between gap-3"><h2 className="text-lg font-bold">Prove programmate</h2><button type="button" onClick={() => setEditingScheduled(null)} className="flex min-h-[44px] items-center gap-2 rounded-xl bg-emerald-700 px-4 font-semibold text-white"><Plus className="h-5 w-5" />Prova</button></div>{studentScheduled.length === 0 ? <div className="mt-5 rounded-xl bg-stone-50 p-5 text-sm text-stone-600">Nessuna prova programmata.</div> : <ul className="mt-4 divide-y divide-stone-100">{studentScheduled.map(item => <li key={item.id}><button type="button" onClick={() => setEditingScheduled(item)} className={`w-full py-4 text-left ${item.status !== "scheduled" ? "opacity-70" : ""}`}><div className="flex gap-3"><span className="min-w-[58px] text-center text-sm font-bold uppercase text-emerald-800">{item.date.slice(8, 10)} {item.date.slice(5, 7)}</span><span className="min-w-0"><span className="block font-semibold">{item.subject || "Materia non indicata"}</span><span className="block text-sm text-stone-700">{SCHEDULED_TYPE_LABELS[item.assessmentType]}</span>{item.topic && <span className="mt-1 block break-words font-semibold text-stone-900">{item.topic}</span>}<span className="mt-1 block text-xs font-semibold text-stone-500">{item.status === "scheduled" ? "Programmata" : item.status === "completed" ? "Completata" : "Annullata"}{item.status === "scheduled" && item.date < localDateISO() ? " · Data passata" : ""}</span></span></div></button></li>)}</ul>}</>}{editing !== undefined && <AssessmentForm student={selectedStudent} initial={editing} onClose={() => setEditing(undefined)} onSave={save} onDelete={remove} />}{editingScheduled !== undefined && <ScheduledAssessmentForm student={selectedStudent} initial={editingScheduled} onClose={() => setEditingScheduled(undefined)} onSave={async item => { const result = await onSaveScheduledAssessment(item); if (result !== false) setEditingScheduled(undefined); return result; }} onDelete={async id => { const result = await onDeleteScheduledAssessment(id); if (result !== false) setEditingScheduled(undefined); return result; }} />}</section></main>;

  return <main aria-label="Registro" className="mx-auto max-w-3xl pb-28"><div className="mb-5"><p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Registro</p><h1 className="mt-1 text-2xl font-bold">Valutazioni</h1><p className="mt-1 text-sm text-stone-500">Scegli una classe per visualizzare gli studenti.</p></div><label className="block text-sm font-semibold">Classe<select aria-label="Seleziona classe" value={selectedClass} onChange={e => setSelectedClass(e.target.value)} className={inputClass}><option value="">Tutte le classi</option>{classOptions.map(name => <option key={name} value={name}>{name}</option>)}</select></label>{visibleStudents.length === 0 ? <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white p-6 text-center text-stone-600">{activeStudents.length === 0 ? "Nessuno studente attivo disponibile." : "Nessuno studente nella classe selezionata."}</div> : <ul className="mt-5 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">{visibleStudents.map(student => { const count = assessments.filter(item => item.studentId === student.id).length; return <li key={student.id}><button type="button" onClick={() => setSelectedStudentId(student.id)} className="flex min-h-[64px] w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-emerald-50"><span><span className="block font-semibold">{student.fullName}</span><span className="block text-xs text-stone-500">{student.className} · {count} valutazioni</span></span><ChevronRight className="h-5 w-5 shrink-0 text-stone-400" /></button></li>; })}</ul>}</main>;
};
