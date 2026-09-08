import { useRef, useState } from 'react';

/** Keep form drafts open until a durable write succeeds, and reject duplicate submits. */
export function usePersistenceAction() {
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = async (operation: () => void | false | Promise<void | false>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true; setPending(true); setError(null);
    try {
      if (await operation() === false) throw new Error('Save failed');
      return true;
    } catch {
      setError('Salvataggio non completato. I dati inseriti restano qui: riprova dopo aver verificato l’archivio locale.');
      return false;
    } finally { busy.current = false; setPending(false); }
  };
  return {run, error, pending};
}
