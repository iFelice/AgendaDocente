/** Distinguish a committed restore from a failure to refresh its presentation. */
export async function restoreAndRefresh(json: string, restore: (json: string) => Promise<boolean>, refresh: () => void | false | Promise<void | false>): Promise<string> {
  if (!await restore(json)) return 'Ripristino non riuscito: verifica il file e lo spazio disponibile. I dati precedenti sono stati conservati.';
  try {
    if (await refresh() === false) throw new Error('Refresh failed');
  } catch { return 'Backup ripristinato correttamente, ma la vista non è stata aggiornata. Riapri l’app; non ripetere il ripristino.'; }
  return JSON.parse(json).version === 2
    ? 'Backup precedente ripristinato: orario definitivo aggiornato; orario provvisorio, modalità e configurazione conservati.'
    : 'Backup ripristinato: entrambi gli orari, modalità e dati sono stati ricaricati.';
}
