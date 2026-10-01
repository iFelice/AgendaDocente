import React from "react";
import { StickyNote, X } from "lucide-react";
import type { CalendarEvent } from "../types";
import { localDateISO } from "../utils/dates";
import { buildQuickNoteEvent } from "../utils/quickNote";
import { usePersistenceAction } from "../hooks/usePersistenceAction";

/**
 * N2 — creazione rapida di una nota personale.
 *
 * Form volutamente minimo (titolo, data, classe opzionale, dettagli): NON è un
 * secondo editor completo. Il salvataggio produce un normale `CalendarEvent`
 * passato al callback della vista (`App` → `storage.saveEvent`): nessuna
 * scrittura diretta sul database, nessuna nuova persistenza. La modifica
 * completa resta affidata all'`EventModal` esistente.
 */

export interface QuickNoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Persistenza in App: riusa il normale flusso di salvataggio degli eventi. */
  onSave: (event: CalendarEvent) => void | false | Promise<void | false>;
  /** Classi del profilo; nessuna è preselezionata. */
  classes?: string[];
  todayIso?: string;
}

export const QuickNoteModal: React.FC<QuickNoteModalProps> = ({
  isOpen,
  onClose,
  onSave,
  classes = [],
  todayIso = localDateISO(),
}) => {
  const [title, setTitle] = React.useState("");
  const [date, setDate] = React.useState(todayIso);
  const [className, setClassName] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const save = usePersistenceAction();

  React.useEffect(() => {
    if (!isOpen) return;
    // Default: oggi (localDateISO, mai UTC) e NESSUNA classe preselezionata.
    setTitle("");
    setDate(todayIso);
    setClassName("");
    setNotes("");
    setValidationError(null);
  }, [isOpen, todayIso]);

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
    const note = buildQuickNoteEvent({ title, date, className, notes });
    if (!(await save.run(() => onSave(note)))) return;
    onClose();
  };

  return (
    <div
      data-quick-note-modal
      className="app-modal app-modal-scroll fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3 sm:p-4 bg-stone-950/40 backdrop-blur-xs"
    >
      <div className="app-modal-panel bg-white rounded-2xl max-w-md w-full shadow-2xl border border-stone-200 animate-in fade-in zoom-in-95">
        <div className="modal-sticky-header flex items-center justify-between px-4 sm:px-5 pt-4 pb-3 border-b border-stone-100 rounded-t-2xl">
          <h2 className="text-base font-bold text-stone-900 inline-flex items-center gap-2">
            <StickyNote className="w-4 h-4 text-emerald-700" />
            Nuova nota
          </h2>
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
              {classes.map(option => (
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

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
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
              Salva nota
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
