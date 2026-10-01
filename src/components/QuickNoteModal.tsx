import React from "react";
import { StickyNote, Trash2, X } from "lucide-react";
import type { CalendarEvent } from "../types";
import { localDateISO } from "../utils/dates";
import { buildQuickNoteEvent } from "../utils/quickNote";
import { usePersistenceAction } from "../hooks/usePersistenceAction";

/**
 * Editor rapido per una nota personale.
 *
 * Il form resta intenzionalmente minimo (titolo, data, classe opzionale,
 * dettagli), sia in creazione sia in modifica. Tutte le scritture restano in
 * App: questa UI produce sempre un normale `CalendarEvent`, senza archivi o
 * persistenze dedicate.
 */

export interface QuickNoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Se presente, il modal modifica la stessa nota senza cambiare la sua identità. */
  noteToEdit?: CalendarEvent | null;
  /** Persistenza in App: riusa il normale flusso di salvataggio degli eventi. */
  onSave: (event: CalendarEvent, expectedOriginal?: CalendarEvent) => void | false | Promise<void | false>;
  /** Riusa la cancellazione normale degli eventi (con conferma nella UI). */
  onDelete?: (id: string) => void | false | Promise<void | false>;
  /** Classi del profilo; nessuna è preselezionata in creazione. */
  classes?: string[];
  todayIso?: string;
}

export const QuickNoteModal: React.FC<QuickNoteModalProps> = ({
  isOpen,
  onClose,
  noteToEdit = null,
  onSave,
  onDelete,
  classes = [],
  todayIso = localDateISO(),
}) => {
  const [title, setTitle] = React.useState("");
  const [date, setDate] = React.useState(todayIso);
  const [className, setClassName] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [isConfirmingDelete, setIsConfirmingDelete] = React.useState(false);
  const save = usePersistenceAction();

  React.useEffect(() => {
    if (!isOpen) return;
    if (noteToEdit) {
      setTitle(noteToEdit.title);
      setDate(noteToEdit.date);
      setClassName(noteToEdit.className || "");
      setNotes(noteToEdit.notes || "");
    } else {
      // Default: oggi (localDateISO, mai UTC) e NESSUNA classe preselezionata.
      setTitle("");
      setDate(todayIso);
      setClassName("");
      setNotes("");
    }
    setValidationError(null);
    setIsConfirmingDelete(false);
  }, [isOpen, noteToEdit, todayIso]);

  if (!isOpen) return null;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!title.trim()) {
      setValidationError("Il titolo della nota è obbligatorio.");
      return;
    }
    if (!date) {
      setValidationError("La data della nota è obbligatoria.");
      return;
    }
    setValidationError(null);

    // In modifica si parte dall'originale: id, sourceType, category,
    // completed e tutti i metadati non esposti dal form sono preservati.
    const updatedNote: CalendarEvent = noteToEdit
      ? {
          ...noteToEdit,
          title: title.trim(),
          date,
          className: className.trim() || undefined,
          notes: notes.trim() || undefined,
        }
      : buildQuickNoteEvent({ title, date, className, notes });

    if (!(await save.run(() => onSave(updatedNote, noteToEdit ?? undefined)))) return;
    onClose();
  };

  const classOptions = Array.from(new Set([...(className ? [className] : []), ...classes]));
  const isEditing = !!noteToEdit;

  return (
    <div
      data-quick-note-modal
      className="app-modal app-modal-scroll fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3 sm:p-4 bg-stone-950/40 backdrop-blur-xs"
    >
      <div className="app-modal-panel bg-white rounded-2xl max-w-md w-full shadow-2xl border border-stone-200 animate-in fade-in zoom-in-95">
        <div className="modal-sticky-header flex items-center justify-between px-4 sm:px-5 pt-4 pb-3 border-b border-stone-100 rounded-t-2xl">
          <h2 className="text-base font-bold text-stone-900 inline-flex items-center gap-2">
            <StickyNote className="w-4 h-4 text-emerald-700" />
            {isEditing ? "Modifica nota" : "Nuova nota"}
          </h2>
          <div className="flex items-center gap-1">
            {isEditing && onDelete && (
              <button
                type="button"
                data-quick-note-delete-icon
                onClick={() => setIsConfirmingDelete(true)}
                className="p-2 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                title="Elimina nota"
                aria-label="Elimina nota"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              data-quick-note-close
              onClick={onClose}
              className="p-2 rounded-md text-stone-400 hover:text-stone-700 transition-colors"
              aria-label="Chiudi"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 px-4 sm:px-5 py-4 text-sm">
          {(validationError || save.error) && (
            <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {validationError || save.error}
            </p>
          )}

          <div>
            <label htmlFor="quick-note-title" className="block text-xs font-semibold text-stone-700 mb-1">
              Titolo *
            </label>
            <input
              id="quick-note-title"
              data-quick-note-title
              type="text"
              required
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="Ricordare di..."
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-stone-300 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 outline-none"
            />
          </div>

          <div>
            <label htmlFor="quick-note-date" className="block text-xs font-semibold text-stone-700 mb-1">
              Data
            </label>
            <input
              id="quick-note-date"
              data-quick-note-date
              type="date"
              required
              value={date}
              onChange={event => setDate(event.target.value)}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-stone-300 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 outline-none"
            />
          </div>

          <div>
            <label htmlFor="quick-note-class" className="block text-xs font-semibold text-stone-700 mb-1">
              Classe (opzionale)
            </label>
            <select
              id="quick-note-class"
              data-quick-note-class
              value={className}
              onChange={event => setClassName(event.target.value)}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-stone-300 bg-white focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 outline-none"
            >
              <option value="">Nessuna classe</option>
              {classOptions.map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="quick-note-details" className="block text-xs font-semibold text-stone-700 mb-1">
              Dettagli
            </label>
            <textarea
              id="quick-note-details"
              data-quick-note-details
              rows={3}
              value={notes}
              onChange={event => setNotes(event.target.value)}
              placeholder="Dettagli facoltativi"
              className="w-full px-3 py-2 rounded-lg border border-stone-300 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 outline-none resize-y"
            />
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-2 pt-1">
            <div>
              {isEditing && onDelete && !isConfirmingDelete && (
                <button
                  type="button"
                  data-quick-note-delete
                  onClick={() => setIsConfirmingDelete(true)}
                  className="min-h-[44px] px-4 rounded-lg text-sm font-semibold text-rose-700 border border-rose-200 bg-rose-50 hover:bg-rose-100 transition-colors"
                >
                  Elimina nota
                </button>
              )}
              {isEditing && onDelete && isConfirmingDelete && (
                <div data-quick-note-delete-confirm className="flex items-center gap-2 rounded-xl border border-rose-300 bg-rose-50 p-1.5">
                  <span className="text-xs font-bold text-rose-900 pl-1">Eliminare davvero?</span>
                  <button
                    type="button"
                    data-quick-note-delete-confirm-yes
                    onClick={async () => {
                      if (!(await save.run(() => onDelete(noteToEdit.id)))) return;
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
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <button
                type="button"
                data-quick-note-cancel
                onClick={onClose}
                className="min-h-[44px] px-4 rounded-lg text-sm font-medium text-stone-700 border border-stone-300 hover:bg-stone-50 transition-colors"
              >
                Annulla
              </button>
              <button
                type="button"
                data-quick-note-save
                disabled={save.pending}
                onClick={() => handleSubmit()}
                className="min-h-[44px] px-4 rounded-lg text-sm font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white transition-colors"
              >
                {isEditing ? "Salva modifiche" : "Salva nota"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
