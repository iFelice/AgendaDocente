import React, { useState, useEffect } from "react";
import { Clock, MapPin, X, Calendar, BookOpen, AlertCircle, Trash2 } from "lucide-react";
import { CalendarEvent, EventCategory, TeacherProfile } from "../types";

interface EventModalProps {
  isOpen: boolean;
  onClose: () => void;
  eventToEdit: CalendarEvent | null;
  initialDate?: string;
  initialEventData?: Partial<CalendarEvent> | null;
  profile: TeacherProfile;
  onSave: (event: CalendarEvent) => void;
  onDelete?: (id: string) => void;
  isGoogleConnected?: boolean;
  googleUserEmail?: string;
}

const CATEGORIES: { id: EventCategory; label: string }[] = [
  { id: "glo", label: "G.L.O. (Gruppo Lavoro Operativo)" },
  { id: "pei", label: "P.E.I. / P.D.P. (Scadenza / Stesura)" },
  { id: "dipartimento_sostegno", label: "Dipartimento Sostegno / Inclusione" },
  { id: "consiglio_classe", label: "Consiglio di Classe" },
  { id: "collegio_docenti", label: "Collegio Docenti" },
  { id: "dipartimento", label: "Dipartimento Disciplinare" },
  { id: "ricevimento_genitori", label: "Ricevimento Genitori / Terapisti" },
  { id: "scadenza", label: "Scadenza Istituzionale" },
  { id: "promemoria", label: "Promemoria Didattico" },
  { id: "formazione", label: "Formazione / Aggiornamento" },
  { id: "riunione", label: "Altra Riunione" },
  { id: "personale", label: "Personale" },
];

export const EventModal: React.FC<EventModalProps> = ({
  isOpen,
  onClose,
  eventToEdit,
  initialDate,
  initialEventData,
  profile,
  onSave,
  onDelete,
  isGoogleConnected = false,
  googleUserEmail,
}) => {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<EventCategory>("consiglio_classe");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState("15:00");
  const [endTime, setEndTime] = useState("16:30");
  const [isAllDay, setIsAllDay] = useState(false);
  const [className, setClassName] = useState("");
  const [subject, setSubject] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [syncWithGoogle, setSyncWithGoogle] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  useEffect(() => {
    setIsConfirmingDelete(false);
    if (eventToEdit) {
      setTitle(eventToEdit.title);
      setCategory(eventToEdit.category);
      setDate(eventToEdit.date);
      setStartTime(eventToEdit.startTime || "15:00");
      setEndTime(eventToEdit.endTime || "16:30");
      setIsAllDay(!!eventToEdit.isAllDay);
      setClassName(eventToEdit.className || "");
      setSubject(eventToEdit.subject || "");
      setLocation(eventToEdit.location || "");
      setNotes(eventToEdit.notes || "");
      setSyncWithGoogle(!!eventToEdit.googleEventId || !!eventToEdit.syncedWithGoogle);
    } else if (initialEventData) {
      setTitle(initialEventData.title || "");
      setCategory(initialEventData.category || "glo");
      setDate(initialEventData.date || initialDate || new Date().toISOString().slice(0, 10));
      setStartTime(initialEventData.startTime || "15:00");
      setEndTime(initialEventData.endTime || "16:30");
      setIsAllDay(!!initialEventData.isAllDay);
      setClassName(initialEventData.className || profile.classes[0] || "1A");
      setSubject(initialEventData.subject || profile.primarySubjects[0] || "");
      setLocation(initialEventData.location || "Sede Centrale");
      setNotes(initialEventData.notes || "");
      setSyncWithGoogle(isGoogleConnected);
    } else {
      setTitle("");
      setCategory("consiglio_classe");
      setDate(initialDate || new Date().toISOString().slice(0, 10));
      setStartTime("15:00");
      setEndTime("16:30");
      setIsAllDay(false);
      setClassName(profile.classes[0] || "1A");
      setSubject(profile.primarySubjects[0] || "");
      setLocation("Sede Centrale");
      setNotes("");
      setSyncWithGoogle(isGoogleConnected);
    }
  }, [eventToEdit, initialDate, initialEventData, profile, isOpen, isGoogleConnected]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const newEvent: CalendarEvent = {
      id: eventToEdit ? eventToEdit.id : `ev-${Date.now()}`,
      title: title.trim(),
      category,
      date,
      startTime: isAllDay ? undefined : startTime,
      endTime: isAllDay ? undefined : endTime,
      isAllDay,
      className: className.trim() || undefined,
      subject: subject.trim() || undefined,
      location: location.trim() || undefined,
      notes: notes.trim() || undefined,
      sourceType: eventToEdit ? eventToEdit.sourceType : "manuale",
      completed: eventToEdit ? eventToEdit.completed : false,
      googleEventId: eventToEdit?.googleEventId,
      syncedWithGoogle: syncWithGoogle,
    };

    onSave(newEvent);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-950/40 backdrop-blur-xs">
      <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-stone-200 animate-in fade-in zoom-in-95">
        <div className="flex items-center justify-between pb-3 border-b border-stone-100">
          <div className="flex items-center space-x-2">
            <h2 className="text-base font-bold text-stone-900">
              {eventToEdit ? "Modifica Impegno" : "Nuovo Impegno in Agenda"}
            </h2>
            {eventToEdit?.sourceType === "circolare" && (
              <span className="text-[10px] font-semibold bg-amber-100 text-amber-900 px-2 py-0.5 rounded-md border border-amber-200">
                Da Circolare
              </span>
            )}
          </div>
          <div className="flex items-center space-x-1">
            {eventToEdit && onDelete && (
              <button
                type="button"
                onClick={() => setIsConfirmingDelete(true)}
                className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                title="Elimina impegno"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded-md text-stone-400 hover:text-stone-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 mt-4 text-xs">
          {/* Category Chips */}
          <div>
            <label className="block font-semibold text-stone-700 mb-1.5">Tipologia Impegno</label>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setCategory(cat.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border ${
                    category === cat.id
                      ? "bg-emerald-700 text-white border-emerald-700 shadow-2xs"
                      : "bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100"
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="block font-semibold text-stone-700 mb-1">Titolo dell'Impegno *</label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="es. Consiglio di Classe 2E, Consegna programmazione, Dipartimento..."
              className="w-full p-2.5 border border-stone-300 rounded-xl text-xs focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
            />
          </div>

          {/* Date & All Day */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-stone-700 mb-1">Data *</label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full p-2 border border-stone-300 rounded-lg text-xs"
              />
            </div>

            <div className="flex items-center pt-5">
              <label className="flex items-center space-x-2 text-stone-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isAllDay}
                  onChange={(e) => setIsAllDay(e.target.checked)}
                  className="rounded-sm text-emerald-700 focus:ring-emerald-500"
                />
                <span className="font-medium">Intera giornata / Scadenza</span>
              </label>
            </div>
          </div>

          {/* Times */}
          {!isAllDay && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Ora Inizio</label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full p-2 border border-stone-300 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Ora Fine</label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full p-2 border border-stone-300 rounded-lg text-xs"
                />
              </div>
            </div>
          )}

          {/* Class & Subject */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-stone-700 mb-1">Classe Interessata</label>
              <input
                type="text"
                value={className}
                onChange={(e) => setClassName(e.target.value.toUpperCase())}
                placeholder="es. 2E o Tutte"
                className="w-full p-2 border border-stone-300 rounded-lg text-xs"
              />
            </div>

            <div>
              <label className="block font-semibold text-stone-700 mb-1">Materia</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="es. Scienze motorie"
                className="w-full p-2 border border-stone-300 rounded-lg text-xs"
              />
            </div>
          </div>

          {/* Location */}
          <div>
            <label className="block font-semibold text-stone-700 mb-1">Luogo / Modalità</label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="es. Aula Magna, Google Meet, Sede Centrale..."
              className="w-full p-2 border border-stone-300 rounded-lg text-xs"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block font-semibold text-stone-700 mb-1">Note & Ordine del Giorno</label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Punti all'ordine del giorno, materiali da preparare..."
              className="w-full p-2 border border-stone-300 rounded-lg text-xs"
            />
          </div>

          {/* Google Calendar Sync Option */}
          {isGoogleConnected && (
            <div className="p-3 rounded-xl bg-blue-50/70 border border-blue-200 flex items-center justify-between">
              <div className="flex items-center space-x-2.5">
                <div className="w-5 h-5 flex-shrink-0">
                  <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="w-full h-full block">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                    <path fill="none" d="M0 0h48v48H0z" />
                  </svg>
                </div>
                <div>
                  <div className="text-xs font-bold text-blue-950">Sincronizza su Google Calendar</div>
                  <div className="text-[10px] text-blue-800">
                    {googleUserEmail ? `Account: ${googleUserEmail}` : "Account istituzionale"}
                    {eventToEdit?.googleEventId && " • Già sincronizzato"}
                  </div>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={syncWithGoogle}
                  onChange={(e) => setSyncWithGoogle(e.target.checked)}
                  className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                />
              </label>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-stone-100">
            <div>
              {eventToEdit && onDelete && !isConfirmingDelete && (
                <button
                  type="button"
                  onClick={() => setIsConfirmingDelete(true)}
                  className="flex items-center space-x-1.5 px-3 py-2 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5 text-rose-600" />
                  <span>Elimina impegno</span>
                </button>
              )}
              {eventToEdit && onDelete && isConfirmingDelete && (
                <div className="flex items-center space-x-2 bg-rose-50 border border-rose-300 p-1.5 rounded-xl animate-in fade-in">
                  <span className="text-xs font-bold text-rose-900 pl-1">Eliminare davvero?</span>
                  <button
                    type="button"
                    onClick={() => {
                      onDelete(eventToEdit.id);
                      setIsConfirmingDelete(false);
                      onClose();
                    }}
                    className="px-2.5 py-1 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg shadow-2xs transition-colors"
                  >
                    Sì, elimina
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsConfirmingDelete(false)}
                    className="px-2 py-1 text-xs font-semibold text-stone-600 hover:text-stone-800 rounded-md transition-colors"
                  >
                    Annulla
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center space-x-2 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg transition-colors"
              >
                Annulla
              </button>
              <button
                type="submit"
                className="px-5 py-2 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-xs transition-colors"
              >
                Salva Impegno
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
