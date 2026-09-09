import React, { useEffect, useState } from 'react';
import { initializeStorage } from '../services/storage';
import { database, exportLegacyData, type LocalData } from '../services/db';

export function PersistenceGate({ children }: { children: (data: LocalData) => React.ReactNode }) {
  const [data, setData] = useState<LocalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    initializeStorage().then(value => { if (active) setData(value); })
      .catch(() => { if (active) setError('Impossibile aprire l’archivio locale. I dati originali sono stati conservati; non sono stati caricati dati demo.'); });
    return () => { active = false; };
  }, []);
  const downloadLegacy = () => {
    try {
      const url = URL.createObjectURL(new Blob([exportLegacyData()], {type:'application/json'}));
      const link = document.createElement('a'); link.href = url; link.download = 'agenda-copia-legacy-recupero.json'; link.click(); URL.revokeObjectURL(url);
    } catch { setError('Il browser non consente di leggere la copia legacy. Riprova senza cancellare i dati del sito.'); }
  };
  const recovery = error || database.mode === 'legacy-readonly';
  return <>
    {recovery && <div role="alert" className="p-4 bg-amber-50 text-amber-950 border-b border-amber-300">
      <p>{error || 'Archivio IndexedDB non disponibile: stai consultando la copia legacy in sola lettura. Potrebbe non contenere le modifiche più recenti. I salvataggi sono disabilitati.'}</p>
      <button className="underline mr-4" onClick={downloadLegacy}>Scarica copia legacy di recupero</button>
      <button className="underline" onClick={() => window.location.reload()}>Riprova apertura archivio</button>
    </div>}
    {data ? children(data) : !error && <p role="status" className="p-6">Caricamento dell’archivio locale…</p>}
  </>;
}
