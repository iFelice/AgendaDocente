export function persistenceErrorMessage(error: unknown): string {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause ?? current.inner) {
    if (current.name === 'QuotaExceededError') return 'Spazio del dispositivo esaurito: la modifica non è stata salvata. Libera spazio senza cancellare i dati di Agenda Docente e riprova. Puoi esportare un backup.';
    if (['DatabaseClosedError','OpenFailedError','SecurityError','InvalidStateError'].includes(current.name)) return 'Archivio locale non disponibile. I dati non sono stati sostituiti: chiudi le altre schede dell’app e riprova l’apertura senza cancellare i dati del sito.';
    if (current.name === 'EditConflictError') return current.message;
  }
  return 'Operazione locale non completata. I dati non sono stati sostituiti. Conserva la bozza e riprova; se il problema persiste, esporta un backup.';
}

export class EditConflictError extends Error {
  name = 'EditConflictError';
  constructor() { super('Questo elemento è stato modificato o eliminato in un’altra scheda. La bozza resta aperta: copia le modifiche e riapri l’elemento aggiornato.'); }
}
export function assertUnchanged(current: unknown, expected: unknown) {
  if (expected !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) throw new EditConflictError();
}
