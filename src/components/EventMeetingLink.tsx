import React from "react";
import { Video } from "lucide-react";
import { getEventMeetingUrl, type MeetingUrlCarrier } from "../utils/meetingLinks";

/**
 * "Partecipa": il pulsante compatto che apre la videochiamata dell'impegno.
 *
 * Un solo componente per tutte le viste (riga di "Note e impegni", vista Oggi, scheda
 * dell'impegno) così il link viene ricavato SEMPRE dalla stessa funzione
 * (`getEventMeetingUrl`: campo dedicato, poi luogo, poi note) e non esiste nessuna
 * variante locale di elencazione o normalizzazione da tenere allineate.
 *
 * Tre proprietà non negoziabili, verificate da tests/meeting-link-ui.test.ts:
 *  - rende `null` quando il link non c'è: nessun pulsante vuoto o disabilitato;
 *  - `<a target="_blank" rel="noopener noreferrer">`: la riunione si apre in una nuova
 *    scheda e la nuova pagina non può né leggere né riscrivere l'app (window.opener);
 *  - 44px di area di tocco su mobile (min-h/min-w), anche dentro righe compatte.
 *
 * È un `<a>`, non un `<button>` con `window.open`: tasto centrale, "apri in nuovo tab",
 * copia dell'indirizzo e annunci dello screen reader funzionano come per ogni link.
 */
export interface EventMeetingLinkProps {
  /** Basta l'oggetto dell'impegno (o i suoi tre campi): la derivazione è unica. */
  event: MeetingUrlCarrier | null | undefined;
  /** Titolo dell'impegno: rende l'etichetta accessibile quando ci sono più righe. */
  label?: string;
  /** Utili margini/ordine nel layout del genitore; non tocca il target di tocco. */
  className?: string;
  /** Testo del pulsante, per contesti strettissimi. */
  text?: string;
}

export const EventMeetingLink: React.FC<EventMeetingLinkProps> = ({ event, label, className = "", text = "Partecipa" }) => {
  const url = getEventMeetingUrl(event);
  if (!url) return null;
  const suffix = label ? ` — ${label}` : "";
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-meeting-link={url}
      title="Apri la videochiamata in una nuova scheda"
      aria-label={`Partecipa alla videochiamata${suffix} (si apre in una nuova scheda)`}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 min-h-[44px] min-w-[44px] px-3 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-xs font-semibold text-emerald-800 whitespace-nowrap hover:bg-emerald-100 active:bg-emerald-200 transition-colors ${className}`}
    >
      <Video className="h-4 w-4 shrink-0" aria-hidden="true" />
      {text}
    </a>
  );
};
