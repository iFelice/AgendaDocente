import { usePersistenceAction } from "../hooks/usePersistenceAction";
import type { GoogleCalendarListEntry } from "../services/googleCalendarService";
import { eventDateError, isValidDate, localDateISO } from "../utils/dates";
import React, { useState, useEffect } from "react";
import { Clock, MapPin, X, Calendar, BookOpen, AlertCircle, Trash2, ChevronRight } from "lucide-react";
import { CalendarEvent, EventCategory, TeacherProfile } from "../types";

interface EventModalProps {
  isOpen: boolean;
  onClose: () => void;
  eventToEdit: CalendarEvent | null;
  initialDate?: string;
  initialEventData?: Partial<CalendarEvent> | null;
  profile: TeacherProfile;
  onSave: (event: CalendarEvent, expected?: CalendarEvent) => void | false | Promise<void | false>;
  onDelete?: (id: string) => void | false | Promise<void | false>;
  isGoogleConnected?: boolean;
  googleUserEmail?: string;
  googleWritableCalendars?: GoogleCalendarListEntry[];
  googleCalendarsLoaded?: boolean;
  onLoadGoogleCalendars?: () => Promise<GoogleCalendarListEntry[]>;
  onGoogleConnect?: () => Promise<unknown>;
  onSendToGoogle?: (event: CalendarEvent, calendarId: string) => Promise<CalendarEvent | void>;
}

export const EVENT_CATEGORIES: { id: EventCategory; label: string }[] = [
  { id: "glo", label: "G.L.O. (Gruppo Lavoro Operativo)" },
  { id: "pei", label: "P.E.I. / P.D.P. (Scadenza / Stesura)" },
  { id: "dipartimento_sostegno", label: "Dipartimento Sostegno / Inclusione" },
  { id: "consiglio_classe", label: "Consiglio di Classe" },
  { id: "collegio_docenti", label: "Collegio Docenti" },
  { id: "ricevimento_genitori", label: "Ricevimento Genitori / Terapisti" },
  { id: "scadenza", label: "Scadenza Istituzionale" },
  { id: "promemoria", label: "Promemoria Didattico" },
  { id: "formazione", label: "Formazione / Aggiornamento" },
  { id: "uscita_didattica", label: "Uscita didattica" },
  { id: "riunione", label: "Altra Riunione" },
  { id: "personale", label: "Personale" },
];

/**
 * Categoria LEGACY "Dipartimento disciplinare": non è più fra le opzioni
 * normali (EVENT_CATEGORIES) per i nuovi eventi, ma resta selezionabile SOLO
 * mentre si modifica un evento che la possiede già, così una scelta storica
 * non viene mai persa o convertita in silenzio. L'identificatore "dipartimento"
 * resta valido nei tipi e nei formatter/parser (dati salvati e estratti da
 * circolari continuano a caricarsi, vedersi ed esportarsi).
 */
export const LEGACY_DIPARTIMENTO_CATEGORY: { id: EventCategory; label: string } = {
  id: "dipartimento",
  label: "Dipartimento Disciplinare (legacy)",
};

/** Defaults are only suggestions for a new manual event, never replacements for source data. */
export function getEventModalTimeFields(source?: Partial<CalendarEvent> | null) {
  return source
    ? { startTime: source.startTime ?? "", endTime: source.endTime ?? "", location: source.location ?? "" }
    : { startTime: "15:00", endTime: "16:30", location: "Sede Centrale" };
}

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
  googleWritableCalendars = [],
  googleCalendarsLoaded = false,
  onLoadGoogleCalendars,
  onGoogleConnect,
  onSendToGoogle,
}) => {
  const save = usePersistenceAction();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<EventCategory>("consiglio_classe");
  const [date, setDate] = useState(localDateISO());
  const [hasDeadline, setHasDeadline] = useState(false);
  const [deadlineDate, setDeadlineDate] = useState("");
  const initialTimeFields = getEventModalTimeFields(eventToEdit ?? initialEventData);
  const [startTime, setStartTime] = useState(initialTimeFields.startTime);
  const [endTime, setEndTime] = useState(initialTimeFields.endTime);
  const [isAllDay, setIsAllDay] = useState(false);
  const [className, setClassName] = useState("");
  const [subject, setSubject] = useState("");
  const [location, setLocation] = useState(initialTimeFields.location);
  const [notes, setNotes] = useState("");
  const [selectedGoogleCalendarId, setSelectedGoogleCalendarId] = useState("");
  const [isSendingToGoogle, setIsSendingToGoogle] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [linkedEvent, setLinkedEvent] = useState<CalendarEvent | null>(null);
  /** G1.2: a Google-imported event (primary or shared) is read-only towards Google. */
  const isGoogleSourcedEvent = eventToEdit?.sourceType === "google_calendar";
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  // L'evento in modifica (o precompilato dallo scanner) possiede gia' la
  // categoria legacy? Allora l'opzione resta disponibile per tutta la sessione
  // di modifica: si puo' anche tornare indietro dopo un cambio di idea. Per un
  // evento nuovo senza quella categoria, l'opzione non esiste.
  const editingLegacyDipartimento =
    eventToEdit?.category === "dipartimento" ||
    initialEventData?.category === "dipartimento";

  useEffect(() => {
    const timeFields = getEventModalTimeFields(eventToEdit ?? initialEventData);
    setStartTime(timeFields.startTime);
    setEndTime(timeFields.endTime);
    setLocation(timeFields.location);
    setValidationError(null);
    setIsConfirmingDelete(false);
    if (eventToEdit) {
      setTitle(eventToEdit.title);
      setCategory(eventToEdit.category);
      setDate(eventToEdit.date);
      const initialDeadline = eventToEdit.deadlineDate ?? (eventToEdit.category === "scadenza" ? eventToEdit.date : undefined);
      if (initialDeadline) {
        setHasDeadline(true);
        setDeadlineDate(initialDeadline);
      } else {
        setHasDeadline(false);
        setDeadlineDate(eventToEdit.date || localDateISO());
      }
      setIsAllDay(!!eventToEdit.isAllDay);
      setClassName(eventToEdit.className || "");
      setSubject(eventToEdit.subject || "");
      setNotes(eventToEdit.notes || "");
      setLinkedEvent(eventToEdit);
    } else if (initialEventData) {
      setTitle(initialEventData.title || "");
      setCategory(initialEventData.category || "glo");
      const evDate = initialEventData.date || initialDate || localDateISO();
      setDate(evDate);
      const initialDeadline = initialEventData.deadlineDate ?? (initialEventData.category === "scadenza" ? evDate : undefined);
      if (initialDeadline) {
        setHasDeadline(true);
        setDeadlineDate(initialDeadline);
      } else {
        setHasDeadline(false);
        setDeadlineDate(evDate);
      }
      setIsAllDay(!!initialEventData.isAllDay);
      setClassName(initialEventData.className || profile.classes[0] || "1A");
      setSubject(initialEventData.subject || profile.primarySubjects[0] || "");
      setNotes(initialEventData.notes || "");
      setLinkedEvent(null);
    } else {
      const defaultDate = initialDate || localDateISO();
      setTitle("");
      setCategory("consiglio_classe");
      setDate(defaultDate);
      setHasDeadline(false);
      setDeadlineDate(defaultDate);
      setIsAllDay(false);
      setClassName(profile.classes[0] || "1A");
      setSubject(profile.primarySubjects[0] || "");
      setNotes("");
      setLinkedEvent(null);
    }
  }, [eventToEdit, initialDate, initialEventData, isOpen]);

  useEffect(() => {
    if (!isOpen || isGoogleSourcedEvent || !isGoogleConnected || googleCalendarsLoaded || !onLoadGoogleCalendars) return;
    // Token exists: load once on demand. This performs no login/popup.
    void onLoadGoogleCalendars().catch(error => setGoogleError(error instanceof Error ? error.message : "Elenco calendari non disponibile."));
  }, [isOpen, isGoogleSourcedEvent, isGoogleConnected, googleCalendarsLoaded, onLoadGoogleCalendars]);

  useEffect(() => {
    if (selectedGoogleCalendarId && googleWritableCalendars.some(c => c.id === selectedGoogleCalendarId)) return;
    const primary = googleWritableCalendars.find(c => c.primary);
    setSelectedGoogleCalendarId(primary?.id || googleWritableCalendars[0]?.id || "");
  }, [googleWritableCalendars, selectedGoogleCalendarId]);

  useEffect(() => {
    if (!isOpen || typeof document === "undefined") return;

    const { style } = document.body;
    const previousOverflow = style.overflow;
    style.overflow = "hidden";

    return () => {
      style.overflow = previousOverflow;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSelectCategory = (catId: EventCategory) => {
    setCategory(catId);
    if (catId === "scadenza") {
      setHasDeadline(true);
      if (!deadlineDate) {
        setDeadlineDate(date || localDateISO());
      }
    }
  };

  const buildCurrentEvent = (): CalendarEvent => {
    const isDeadlined = category === "scadenza" || hasDeadline;
    const effectiveDeadline = isDeadlined && deadlineDate ? deadlineDate : (category === "scadenza" ? date : undefined);
    return {
      ...eventToEdit,
      ...linkedEvent,
      id: eventToEdit ? eventToEdit.id : linkedEvent?.id || `ev-${Date.now()}`,
      title: title.trim(),
      category,
      date,
      deadlineDate: effectiveDeadline,
      startTime: isAllDay ? undefined : startTime,
      endTime: isAllDay ? undefined : endTime,
      isAllDay,
      className: className.trim() || undefined,
      subject: subject.trim() || undefined,
      location: location.trim() || undefined,
      notes: notes.trim() || undefined,
      sourceType: eventToEdit?.sourceType || "manuale",
      completed: eventToEdit?.completed || false,
      syncedWithGoogle: isGoogleSourcedEvent ? false : (linkedEvent?.syncedWithGoogle ?? eventToEdit?.syncedWithGoogle ?? false),
    };
  };

  const validateCurrentEvent = () => {
    if (!title.trim()) { setValidationError("Inserisci un titolo."); return false; }
    const error = eventDateError({ date, startTime, endTime, isAllDay });
    if (error) { setValidationError(error); return false; }
    const isDeadlined = category === "scadenza" || hasDeadline;
    if (isDeadlined && (!deadlineDate || !isValidDate(deadlineDate))) {
      setValidationError("Inserisci una data limite valida per la scadenza.");
      return false;
    }
    setValidationError(null);
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateCurrentEvent()) return;
    if (!await save.run(() => onSave(buildCurrentEvent(), eventToEdit ?? undefined))) return;
    onClose();
  };

  const handleGoogleAction = async () => {
    if (!onSendToGoogle || isSendingToGoogle || !validateCurrentEvent()) return;
    const event = buildCurrentEvent();
    const destination = event.googleEventId ? (event.googleCalendarId || "primary") : selectedGoogleCalendarId;
    if (!destination) { setGoogleError("Nessun calendario Google scrivibile disponibile."); return; }
    setIsSendingToGoogle(true); setGoogleError(null);
    try {
      const result = await onSendToGoogle(event, destination);
      if (result) setLinkedEvent(result);
    } catch (error) {
      setGoogleError(error instanceof Error ? error.message : "Invio a Google Calendar non riuscito.");
    } finally { setIsSendingToGoogle(false); }
  };

  const handleConnect = async () => {
    if (!onGoogleConnect) return;
    setIsSendingToGoogle(true); setGoogleError(null);
    try { await onGoogleConnect(); await onLoadGoogleCalendars?.(); }
    catch (error) { setGoogleError(error instanceof Error ? error.message : "Collegamento Google non riuscito."); }
    finally { setIsSendingToGoogle(false); }
  };

  return (
    <div className="app-modal app-modal-scroll fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/40 backdrop-blur-xs">
      <div className="app-modal-panel bg-white rounded-2xl max-w-lg w-full shadow-2xl border border-stone-200 animate-in fade-in zoom-in-95">
        <div className="modal-sticky-header flex items-center justify-between px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-stone-100 rounded-t-2xl">
          <div className="flex items-center space-x-2 min-w-0">
            <h2 className="text-base font-bold text-stone-900">
              {eventToEdit ? "Modifica Impegno" : "Nuovo Impegno in Agenda"}
            </h2>
            {eventToEdit?.sourceType === "circolare" && (
              <span className="text-[10px] font-semibold bg-amber-100 text-amber-900 px-2 py-0.5 rounded-md border border-amber-200 whitespace-nowrap">
                Da Circolare
              </span>
            )}
          </div>
          <div className="flex items-center space-x-1 flex-shrink-0">
            {eventToEdit && onDelete && (
              <button
                type="button"
                onClick={() => setIsConfirmingDelete(true)}
                className="p-2 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                title="Elimina impegno"
                aria-label="Elimina impegno"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-md text-stone-400 hover:text-stone-700 transition-colors"
              aria-label="Chiudi"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 mt-4 px-4 sm:px-6 text-xs">
          {save.error && <p role="alert" className="p-3 text-sm text-rose-700">{save.error}</p>}
        {/* Category Chips */}
          <div>
            <label className="block font-semibold text-stone-700 mb-1.5">Tipologia Impegno</label>
            <div className="flex flex-wrap gap-1.5">
              {(editingLegacyDipartimento ? [...EVENT_CATEGORIES, LEGACY_DIPARTIMENTO_CATEGORY] : EVENT_CATEGORIES).map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => handleSelectCategory(cat.id)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
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
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="sm:flex-1 min-w-0">
              <label className="block font-semibold text-stone-700 mb-1">Data *</label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => {
                  const newDate = e.target.value;
                  setDate(newDate);
                  if (hasDeadline && !deadlineDate) {
                    setDeadlineDate(newDate);
                  }
                }}
                className="w-full p-2.5 border border-stone-300 rounded-lg text-xs bg-white"
              />
            </div>

            <div className="flex items-center min-h-[44px]">
              <label className="flex items-center space-x-2 text-stone-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isAllDay}
                  onChange={(e) => setIsAllDay(e.target.checked)}
                  className="rounded-sm text-emerald-700 focus:ring-emerald-500 w-4 h-4"
                />
                <span className="font-medium">Intera giornata</span>
              </label>
            </div>
          </div>

          {/* Deadline Section */}
          <div className="p-3 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
            <div className="flex items-center min-h-[32px]">
              <label className={`flex items-center space-x-2 text-stone-700 ${category === "scadenza" ? "cursor-not-allowed opacity-90" : "cursor-pointer"}`}>
                <input
                  type="checkbox"
                  checked={category === "scadenza" ? true : hasDeadline}
                  disabled={category === "scadenza"}
                  onChange={(e) => {
                    if (category === "scadenza") return;
                    const checked = e.target.checked;
                    setHasDeadline(checked);
                    if (checked && !deadlineDate) {
                      setDeadlineDate(date || localDateISO());
                    }
                  }}
                  className="rounded-sm text-rose-700 focus:ring-rose-500 w-4 h-4"
                />
                <span className="font-semibold text-stone-800">Ha una scadenza</span>
              </label>
            </div>
            {category === "scadenza" && (
              <p className="text-[11px] text-stone-500">
                La tipologia “Scadenza Istituzionale” richiede una data limite.
              </p>
            )}

            {(category === "scadenza" || hasDeadline) && (
              <div className="pt-1">
                <label className="block font-semibold text-stone-700 mb-1">Data limite *</label>
                <input
                  type="date"
                  required={category === "scadenza" || hasDeadline}
                  value={deadlineDate}
                  onChange={(e) => setDeadlineDate(e.target.value)}
                  className="w-full sm:w-auto p-2 border border-stone-300 rounded-lg text-xs bg-white focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                />
              </div>
            )}
          </div>

          {validationError && <p role="alert" className="text-sm text-rose-700">{validationError}</p>}
          {/*
            Orari — DUE RIGHE COMPATTE tappabili (label a sinistra, valore
            HH:MM e chevron a destra), non grandi box time. Dal test reale
            iPhone il controllo nativo type="time" deborda dalla propria
            colonna anche a ~199px: non si tenta piu di comprimerlo.
            Il VERO input type="time" resta l unico target del tap: absolute
            inset-0 sopra l intera riga, opacity-0, a piena dimensione — cosi
            il picker nativo iOS si apre direttamente sul controllo (nessuna
            invocazione programmatica, nessun picker custom, niente
            display:none / visibility:hidden / pointer-events:none) e il
            rendering WebKit del
            controllo non puo piu influire sul layout. Il valore visibile e un
            span aria-hidden (il valore accessibile resta quello dell input,
            collegato alla label via htmlFor); focus-within evidenzia la riga
            quando l input riceve il focus da tastiera. Presentazione unica a
            ogni larghezza: stessi startTime/endTime e stessi onChange come
            unica source of truth, nessuna duplicazione di stato.
          */}
          {!isAllDay && (
            <div className="space-y-2">
              <div className="relative min-h-[44px] flex items-center justify-between gap-3 px-3 py-2 bg-white border border-stone-300 rounded-lg cursor-pointer transition-colors focus-within:border-emerald-600 focus-within:ring-2 focus-within:ring-emerald-600/30">
                <label htmlFor="event-start-time" className="text-xs font-semibold text-stone-700">
                  Ora Inizio
                </label>
                <span aria-hidden="true" className="flex items-center gap-1 text-xs font-mono text-stone-900">
                  {startTime || "--:--"}
                  <ChevronRight className="w-4 h-4 text-stone-400" />
                </span>
                <input
                  id="event-start-time"
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>

              <div className="relative min-h-[44px] flex items-center justify-between gap-3 px-3 py-2 bg-white border border-stone-300 rounded-lg cursor-pointer transition-colors focus-within:border-emerald-600 focus-within:ring-2 focus-within:ring-emerald-600/30">
                <label htmlFor="event-end-time" className="text-xs font-semibold text-stone-700">
                  Ora Fine
                </label>
                <span aria-hidden="true" className="flex items-center gap-1 text-xs font-mono text-stone-900">
                  {endTime || "--:--"}
                  <ChevronRight className="w-4 h-4 text-stone-400" />
                </span>
                <input
                  id="event-end-time"
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>
          )}

          {/* Class & Subject */}
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <label className="block font-semibold text-stone-700 mb-1">Classe Interessata</label>
              <input
                type="text"
                value={className}
                onChange={(e) => setClassName(e.target.value.toUpperCase())}
                placeholder="es. 2E o Tutte"
                className="w-full min-w-0 p-2 min-h-[44px] border border-stone-300 rounded-lg text-xs"
              />
            </div>

            <div className="min-w-0">
              <label className="block font-semibold text-stone-700 mb-1">Materia</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="es. Scienze motorie"
                className="w-full min-w-0 p-2 min-h-[44px] border border-stone-300 rounded-lg text-xs"
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

          {!isGoogleSourcedEvent && (
            <div className="p-4 rounded-xl bg-blue-50/70 border border-blue-200 space-y-3" data-google-outbound>
              <div className="font-bold text-blue-950">Google Calendar</div>
              {(linkedEvent?.googleEventId || eventToEdit?.googleEventId) ? (
                <>
                  <p className="font-semibold text-emerald-800">✓ Presente su Google Calendar</p>
                  <p className="text-stone-700">Calendario: {googleWritableCalendars.find(c => c.id === (linkedEvent?.googleCalendarId || eventToEdit?.googleCalendarId))?.summary || ((linkedEvent?.googleCalendarId || eventToEdit?.googleCalendarId) ? "Calendario Google collegato" : (googleWritableCalendars.find(c => c.primary)?.summary || "Calendario Google collegato"))}</p>
                  {googleError && <p role="alert" className="text-rose-700">{googleError}</p>}
                  <button type="button" disabled={isSendingToGoogle || !onSendToGoogle} onClick={handleGoogleAction} className="px-4 py-2 rounded-lg bg-blue-700 text-white font-bold disabled:bg-stone-300">
                    {isSendingToGoogle ? "Aggiornamento…" : "Aggiorna su Google Calendar"}
                  </button>
                </>
              ) : !isGoogleConnected ? (
                <>
                  <p className="text-stone-700">Per scegliere il calendario di destinazione devi {googleUserEmail ? "ricollegare" : "collegare"} Google.</p>
                  {googleError && <p role="alert" className="text-rose-700">{googleError}</p>}
                  <button type="button" disabled={isSendingToGoogle || !onGoogleConnect} onClick={handleConnect} className="px-4 py-2 rounded-lg bg-blue-700 text-white font-bold disabled:bg-stone-300">
                    {googleUserEmail ? "Ricollega Google" : "Collega Google"}
                  </button>
                </>
              ) : (
                <>
                  <label htmlFor="google-destination" className="block font-semibold text-stone-700">Calendario di destinazione</label>
                  <select id="google-destination" value={selectedGoogleCalendarId} onChange={e => setSelectedGoogleCalendarId(e.target.value)} className="w-full p-2.5 border border-blue-200 rounded-lg bg-white">
                    {googleWritableCalendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.summary}</option>)}
                  </select>
                  <p className="text-stone-600">Invia questo impegno al calendario Google selezionato.</p>
                  {googleError && <p role="alert" className="text-rose-700">{googleError}</p>}
                  <button type="button" disabled={isSendingToGoogle || !selectedGoogleCalendarId || !onSendToGoogle} onClick={handleGoogleAction} className="px-4 py-2 rounded-lg bg-blue-700 text-white font-bold disabled:bg-stone-300">
                    {isSendingToGoogle ? "Invio…" : "Invia a Google Calendar"}
                  </button>
                </>
              )}
            </div>
          )}

          {/* Actions (sticky on mobile: Salva sempre raggiungibile anche con tastiera aperta) */}
          <div className="modal-sticky-footer flex flex-wrap items-center justify-between gap-2 pt-3 pb-2 border-t border-stone-100 bg-white">
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
                    onClick={async () => {
                      if (!await save.run(() => onDelete(eventToEdit.id))) return;
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
                type="submit" disabled={save.pending}
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
