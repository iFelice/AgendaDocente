import React, { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, LockOpen, Printer, ShieldCheck, TriangleAlert } from "lucide-react";
import { applyLocalDecryption, accountSync, encryptionKeystore, syncGateway } from "../services/sync/accountSync";
import type { EncryptionKeystore } from "../services/encryptionKeys";
import { MIN_PHRASE_LENGTH } from "../services/encryptionKeys";

/**
 * "Cifratura dati riservati" — nelle impostazioni, accanto all'account Google.
 *
 * Tre stati possibili per questo dispositivo:
 *  - non attiva:            nessun documento chiavi per l'account;
 *  - attiva e sbloccata:    la chiave dati è su questo dispositivo;
 *  - attiva, da sbloccare:  le chiavi sono nel cloud ma non su questo dispositivo.
 *
 * Attivazione: frase segreta (≥12 caratteri) + conferma; subito dopo il codice
 * di recupero mostrato UNA sola volta, con copia e stampa. Sblocco su un nuovo
 * dispositivo: la frase OPPURE il codice, nello stesso campo. Cambio frase:
 * richiede la frase attuale o il codice; riprotegge solo la chiave, senza
 * ricifrare gli alunni. Testi semplici, nessun gergo tecnico.
 */

type DeviceState = "loading" | "inactive" | "locked" | "unlocked";
type View = "status" | "activate" | "recovery" | "unlock" | "change";

const buttonPrimary =
  "px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-bold disabled:opacity-50 min-h-[40px]";
const buttonSecondary =
  "px-3 py-2 rounded-lg border border-stone-300 bg-white hover:bg-stone-50 text-stone-700 text-xs font-bold disabled:opacity-50 min-h-[40px]";
const inputClass =
  "w-full px-3 py-2 rounded-lg border border-stone-300 text-sm text-stone-800 focus:outline-none focus:ring-2 focus:ring-blue-500";

export const EncryptionCard: React.FC<{
  uid?: string | null;
  /** Iniezione per test: keystore e azioni locali al posto dei singleton di produzione. */
  keystore?: EncryptionKeystore;
  applyLocal?: (uid: string) => Promise<boolean>;
  onSyncNow?: () => void;
}> = ({ uid, keystore: keystoreProp, applyLocal, onSyncNow }) => {
  const ks = keystoreProp ?? encryptionKeystore;
  const doApplyLocal = applyLocal ?? applyLocalDecryption;
  const doSyncNow = onSyncNow ?? (() => void accountSync.syncNow());
  const available = Boolean(uid && (keystoreProp || syncGateway));
  const [state, setState] = useState<DeviceState>("loading");
  const [view, setView] = useState<View>("status");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Attivazione
  const [phrase, setPhrase] = useState("");
  const [phraseConfirm, setPhraseConfirm] = useState("");
  // Recupero
  const [recoveryCode, setRecoveryCode] = useState("");
  const [copied, setCopied] = useState(false);
  // Sblocco
  const [secret, setSecret] = useState("");
  // Cambio frase
  const [currentSecret, setCurrentSecret] = useState("");
  const [newPhrase, setNewPhrase] = useState("");
  const [newPhraseConfirm, setNewPhraseConfirm] = useState("");

  const refresh = useCallback(async () => {
    if (!uid) return;
    try {
      setState(await ks.status(uid));
    } catch {
      setState("inactive");
    }
  }, [uid]);

  useEffect(() => {
    setView("status");
    setError(null);
    setNotice(null);
    setPhrase("");
    setPhraseConfirm("");
    setSecret("");
    setCurrentSecret("");
    setNewPhrase("");
    setNewPhraseConfirm("");
    if (uid) void refresh();
  }, [uid, refresh, ks]);

  if (!available) return null;

  const badge =
    state === "unlocked"
      ? { text: "Attiva su questo dispositivo", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" }
      : state === "locked"
        ? { text: "Da sbloccare su questo dispositivo", cls: "bg-amber-50 text-amber-900 border-amber-300" }
        : state === "inactive"
          ? { text: "Non attiva", cls: "bg-stone-100 text-stone-600 border-stone-200" }
          : { text: "…", cls: "bg-stone-100 text-stone-500 border-stone-200" };

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operazione non riuscita. Riprova.");
    } finally {
      setBusy(false);
    }
  };

  const phraseProblem = (value: string, confirm: string): string | null => {
    if (value.trim().length < MIN_PHRASE_LENGTH) return `La frase segreta deve avere almeno ${MIN_PHRASE_LENGTH} caratteri.`;
    if (value !== confirm) return "Le due frasi non coincidono.";
    return null;
  };

  const copyCode = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Senza permessi di copia il codice resta comunque visibile per essere trascritto.
      setError("Copia non riuscita: seleziona il codice e copialo a mano.");
    }
  };

  const printCode = (): void => {
    window.print();
  };

  return (
    <div className="p-4 sm:p-5 rounded-2xl border border-stone-200 bg-white space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center space-x-2 min-w-0">
          <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
          <h4 className="font-bold text-stone-900 text-sm leading-snug">Cifratura dati riservati</h4>
        </div>
        <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded-lg border ${badge.cls}`}>
          {badge.text}
        </span>
      </div>

      <p className="text-xs text-stone-500 leading-relaxed">
        Le informazioni più delicate degli alunni (sostegno, PEI, diagnosi, équipe) arrivano sugli altri tuoi
        dispositivi solo in forma illeggibile: nel cloud non viene mai conservato il testo in chiaro.
      </p>

      {error && (
        <p role="alert" className="text-[11px] text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-2.5 py-1.5">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-2.5 py-1.5">
          {notice}
        </p>
      )}

      {view === "status" && state === "inactive" && (
        <div className="space-y-2">
          <button type="button" className={buttonPrimary} onClick={() => setView("activate")}>
            Attiva la protezione
          </button>
        </div>
      )}

      {view === "status" && state === "locked" && (
        <div className="space-y-2">
          <p className="text-xs text-stone-600">
            Su questo dispositivo i dati riservati non sono ancora leggibili: servono la frase segreta o il codice
            di recupero scelti all'attivazione.
          </p>
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => { setSecret(""); setView("unlock"); }}
          >
            <span className="inline-flex items-center gap-1.5"><LockOpen className="w-3.5 h-3.5" /> Sblocca</span>
          </button>
        </div>
      )}

      {view === "status" && state === "unlocked" && (
        <div className="space-y-2">
          <p className="text-xs text-stone-600">
            I dati riservati di questo account viaggiano e restano nel cloud solo in forma cifrata.
          </p>
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => { setCurrentSecret(""); setNewPhrase(""); setNewPhraseConfirm(""); setView("change"); }}
          >
            <span className="inline-flex items-center gap-1.5"><KeyRound className="w-3.5 h-3.5" /> Cambia frase segreta</span>
          </button>
        </div>
      )}

      {view === "activate" && (
        <form
          className="space-y-2.5"
          onSubmit={event => {
            event.preventDefault();
            const problem = phraseProblem(phrase, phraseConfirm);
            if (problem) { setError(problem); return; }
            void run(async () => {
              const { recoveryCode: code } = await ks.activate(uid!, phrase);
              setRecoveryCode(code);
              setPhrase("");
              setPhraseConfirm("");
              setView("recovery");
              setState("unlocked");
              doSyncNow();
            });
          }}
        >
          <label className="block text-xs font-semibold text-stone-700">
            Frase segreta
            <input
              type="password"
              className={`${inputClass} mt-1`}
              value={phrase}
              onChange={event => setPhrase(event.target.value)}
              autoComplete="new-password"
              placeholder="Almeno 12 caratteri"
            />
          </label>
          <label className="block text-xs font-semibold text-stone-700">
            Ripeti la frase segreta
            <input
              type="password"
              className={`${inputClass} mt-1`}
              value={phraseConfirm}
              onChange={event => setPhraseConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <p className="text-[11px] text-stone-500 leading-relaxed">
            Scegli una frase che ricorderai: senza la frase segreta e senza il codice di recupero che riceverai,
            i dati protetti non potranno essere recuperati.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonPrimary} disabled={busy}>
              {busy ? "Attivazione…" : "Attiva"}
            </button>
            <button type="button" className={buttonSecondary} onClick={() => setView("status")}>
              Annulla
            </button>
          </div>
        </form>
      )}

      {view === "recovery" && (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-amber-50 border-2 border-amber-300 space-y-2">
            <p className="text-xs font-bold text-amber-950 inline-flex items-center gap-1.5">
              <TriangleAlert className="w-4 h-4" /> Codice di recupero: mostrato una sola volta
            </p>
            <p className="text-[11px] text-amber-900 leading-relaxed">
              Conservalo con cura. Senza la frase segreta e senza questo codice i dati riservati nel cloud non
              sono recuperabili.
            </p>
            <p className="font-mono text-base font-bold tracking-widest text-stone-900 bg-white border border-amber-200 rounded-lg px-3 py-2 select-all break-all">
              {recoveryCode}
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonSecondary} onClick={() => void copyCode()}>
                <span className="inline-flex items-center gap-1.5">
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copiato" : "Copia"}
                </span>
              </button>
              <button type="button" className={buttonSecondary} onClick={printCode}>
                <span className="inline-flex items-center gap-1.5"><Printer className="w-3.5 h-3.5" /> Stampa</span>
              </button>
              <button
                type="button"
                className={buttonPrimary}
                onClick={() => { setRecoveryCode(""); setView("status"); setNotice("Protezione attivata."); }}
              >
                Fatto: ho salvato il codice
              </button>
            </div>
          </div>
        </div>
      )}

      {view === "unlock" && (
        <form
          className="space-y-2.5"
          onSubmit={event => {
            event.preventDefault();
            if (!secret.trim()) return;
            void run(async () => {
              await ks.unlockAuto(uid!, secret);
              await doApplyLocal(uid!);
              setSecret("");
              setView("status");
              setState("unlocked");
              setNotice("Dati riservati sbloccati su questo dispositivo.");
              doSyncNow();
            });
          }}
        >
          <label className="block text-xs font-semibold text-stone-700">
            Frase segreta oppure codice di recupero
            <input
              type="password"
              className={`${inputClass} mt-1`}
              value={secret}
              onChange={event => setSecret(event.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonPrimary} disabled={busy || !secret.trim()}>
              {busy ? "Sblocco…" : "Sblocca"}
            </button>
            <button type="button" className={buttonSecondary} onClick={() => setView("status")}>
              Annulla
            </button>
          </div>
        </form>
      )}

      {view === "change" && (
        <form
          className="space-y-2.5"
          onSubmit={event => {
            event.preventDefault();
            const problem = phraseProblem(newPhrase, newPhraseConfirm);
            if (problem) { setError(problem); return; }
            if (!currentSecret.trim()) { setError("Inserisci la frase segreta attuale o il codice di recupero."); return; }
            void run(async () => {
              await ks.changePassphraseAuto(uid!, currentSecret, newPhrase);
              setCurrentSecret("");
              setNewPhrase("");
              setNewPhraseConfirm("");
              setView("status");
              setNotice("Frase segreta aggiornata. Gli alunni già protetti non sono stati ricifrati.");
              doSyncNow();
            });
          }}
        >
          <label className="block text-xs font-semibold text-stone-700">
            Frase segreta attuale (o codice di recupero)
            <input
              type="password"
              className={`${inputClass} mt-1`}
              value={currentSecret}
              onChange={event => setCurrentSecret(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="block text-xs font-semibold text-stone-700">
            Nuova frase segreta
            <input
              type="password"
              className={`${inputClass} mt-1`}
              value={newPhrase}
              onChange={event => setNewPhrase(event.target.value)}
              autoComplete="new-password"
              placeholder={`Almeno ${MIN_PHRASE_LENGTH} caratteri`}
            />
          </label>
          <label className="block text-xs font-semibold text-stone-700">
            Ripeti la nuova frase segreta
            <input
              type="password"
              className={`${inputClass} mt-1`}
              value={newPhraseConfirm}
              onChange={event => setNewPhraseConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <p className="text-[11px] text-stone-500">
            Cambiando la frase non viene ricifrato nulla: viene protetta di nuovo solo la chiave.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonPrimary} disabled={busy}>
              {busy ? "Aggiornamento…" : "Aggiorna frase"}
            </button>
            <button type="button" className={buttonSecondary} onClick={() => setView("status")}>
              Annulla
            </button>
          </div>
        </form>
      )}

      <span aria-live="polite" className="sr-only">
        {notice ?? error ?? ""}
      </span>
    </div>
  );
};
