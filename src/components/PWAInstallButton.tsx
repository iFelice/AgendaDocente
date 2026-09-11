import React, { useState } from "react";
import { Download, Smartphone, Share2, PlusSquare, X, CheckCircle2 } from "lucide-react";
import { usePWAInstall } from "../hooks/usePWAInstall";

/**
 * Install guides sit above every app layer (z-[70]): the "Altro" sheet (z-61)
 * stays open behind them, so opening a guide never unmounts the button that
 * opened it and closing the guide returns to the previous context.
 */

/** iOS/iPadOS manual steps: Safari has no programmable install prompt. */
export const IOSInstallGuideSheet: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div className="app-modal app-modal-scroll fixed inset-0 z-[70] flex items-center justify-center bg-stone-900/50 backdrop-blur-xs p-4">
    <div role="dialog" aria-modal="true" aria-label="Come installare l'app su iPhone o iPad" className="app-modal-panel w-full max-w-sm rounded-2xl bg-white p-4 sm:p-6 shadow-2xl border border-stone-200 text-xs">
      <div className="flex items-center justify-between pb-3 border-b border-stone-100">
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold">
            <Smartphone className="w-4 h-4" />
          </div>
          <h3 className="text-sm font-bold text-stone-900">Installa su iPhone / iPad</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Chiudi guida installazione"
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-stone-400 hover:text-stone-700"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="mt-4 space-y-3 text-stone-700">
        <p className="text-stone-600">
          Per utilizzare <strong>Agenda Docente</strong> come app a schermo intero sul tuo iPhone o iPad:
        </p>

        <div className="p-3 bg-stone-50 rounded-xl space-y-2 border border-stone-100">
          <div className="flex items-start space-x-2.5">
            <span className="w-5 h-5 rounded-full bg-emerald-700 text-white font-bold flex items-center justify-center flex-shrink-0 text-[10px]">
              1
            </span>
            <div className="flex-1">
              Tocca il pulsante <strong className="inline-flex items-center text-stone-900"><Share2 className="w-3 h-3 mx-1 text-blue-600 inline" /> Condividi</strong> nella barra inferiore di Safari.
            </div>
          </div>

          <div className="flex items-start space-x-2.5">
            <span className="w-5 h-5 rounded-full bg-emerald-700 text-white font-bold flex items-center justify-center flex-shrink-0 text-[10px]">
              2
            </span>
            <div className="flex-1">
              Scorri verso il basso e tocca <strong className="inline-flex items-center text-stone-900"><PlusSquare className="w-3 h-3 mx-1 text-stone-700 inline" /> Aggiungi alla schermata Home</strong>.
            </div>
          </div>

          <div className="flex items-start space-x-2.5">
            <span className="w-5 h-5 rounded-full bg-emerald-700 text-white font-bold flex items-center justify-center flex-shrink-0 text-[10px]">
              3
            </span>
            <div className="flex-1">
              Tocca <strong className="text-stone-900">Aggiungi</strong> in alto a destra. L'icona apparirà sulla home del tuo dispositivo!
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="mt-5 w-full rounded-xl bg-emerald-700 py-2.5 min-h-[44px] text-xs font-bold text-white hover:bg-emerald-800 transition-colors shadow-xs"
      >
        Ho Capito
      </button>
    </div>
  </div>
);

/** Generic manual-install explanation (desktop menu entries, Android, Safari Mac). */
export const InstallInfoGuideSheet: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div className="app-modal app-modal-scroll fixed inset-0 z-[70] flex items-center justify-center bg-stone-900/50 backdrop-blur-xs p-4">
    <div role="dialog" aria-modal="true" aria-label="Installazione Web App" className="app-modal-panel w-full max-w-sm rounded-2xl bg-white p-4 sm:p-5 shadow-2xl border border-stone-200 text-xs">
      <div className="flex items-center justify-between pb-3 border-b border-stone-100">
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold">
            <Download className="w-4 h-4" />
          </div>
          <h3 className="text-sm font-bold text-stone-900">Installazione Web App</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Chiudi guida installazione"
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-stone-400 hover:text-stone-700"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="mt-4 space-y-2.5 text-stone-700">
        <p className="text-stone-600">
          Puoi salvare <strong>Agenda Docente</strong> sul tuo dispositivo per usarla anche offline:
        </p>
        <div className="p-3 bg-stone-50 rounded-xl space-y-2 border border-stone-100 text-[11px]">
          <div>
            <strong className="text-stone-900">Computer (Chrome / Edge / Brave):</strong>
            <p className="text-stone-600">Clicca sull'icona di installazione nella barra degli indirizzi del browser oppure dal menu dei tre puntini &gt; <em>Installa Agenda Docente</em>.</p>
          </div>
          <div>
            <strong className="text-stone-900">Mac (Safari):</strong>
            <p className="text-stone-600">Dal menu <em>File &gt; Aggiungi al Dock</em> (disponibile da macOS Sonoma in poi).</p>
          </div>
          <div>
            <strong className="text-stone-900">Dispositivi Android:</strong>
            <p className="text-stone-600">Tocca i tre puntini in alto a destra e seleziona <em>Aggiungi a schermata Home</em> o <em>Installa app</em>.</p>
          </div>
          <div>
            <strong className="text-stone-900">Altri browser:</strong>
            <p className="text-stone-600">Se il tuo browser non offre l'installazione, apri Agenda Docente in Chrome, Edge o Safari per installarla come app.</p>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="mt-5 w-full rounded-xl bg-emerald-700 py-2.5 min-h-[44px] text-xs font-bold text-white hover:bg-emerald-800 transition-colors shadow-xs"
      >
        Chiudi
      </button>
    </div>
  </div>
);

const InstallSuccessToast: React.FC = () => (
  <div role="status" className="fixed bottom-5 left-5 z-[70] bg-emerald-800 text-white px-4 py-2 rounded-lg text-xs flex items-center space-x-2 shadow-lg">
    <CheckCircle2 className="w-4 h-4" />
    <span>App installata con successo!</span>
  </div>
);

/** Compact install button for the desktop header (Navbar). */
export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [showInfoGuide, setShowInfoGuide] = useState(false);
  const [installSuccess, setInstallSuccess] = useState(false);

  // If already running as an installed standalone PWA, suppress the button —
  // but still surface the transient success toast of a just-accepted install.
  if (isInstalled) {
    return installSuccess ? <InstallSuccessToast /> : null;
  }

  const handleInstallClick = async () => {
    const result = await install();
    if (result === "accepted") {
      setInstallSuccess(true);
      setTimeout(() => setInstallSuccess(false), 4000);
    } else if (result === "unavailable") {
      // No usable prompt (e.g. spent by another instance): still give feedback.
      setShowInfoGuide(true);
    }
    // "dismissed" stays silent: the user said no, the button remains for later.
  };

  // Android / Chrome / Edge / Desktop installation prompt
  if (isInstallable) {
    return (
      <>
        <button
          id="btn-pwa-install"
          type="button"
          onClick={() => void handleInstallClick()}
          aria-label="Installa App"
          className="inline-flex items-center justify-center gap-1.5 px-2 sm:px-3 min-h-[44px] min-w-[44px] rounded-lg text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white shadow-xs transition-all animate-pulse"
          title="Installa Agenda Docente sullo smartphone o sul computer"
        >
          <Smartphone className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Installa App</span>
        </button>

        {installSuccess && <InstallSuccessToast />}
      </>
    );
  }

  // iOS Safari flow (WebKit uses manual Share -> Add to Home Screen)
  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          aria-label="Come installare l'app"
          className="inline-flex items-center justify-center gap-1.5 px-2 sm:px-3 min-h-[44px] min-w-[44px] rounded-lg text-xs font-semibold border border-stone-300 hover:bg-stone-100 text-stone-700 transition-colors"
          title="Istruzioni per installare su iPhone o iPad"
        >
          <Smartphone className="w-3.5 h-3.5 text-stone-600" />
          <span className="hidden sm:inline">Installa su iPhone</span>
        </button>

        {showIOSGuide && <IOSInstallGuideSheet onClose={() => setShowIOSGuide(false)} />}
      </>
    );
  }

  // Generic fallback if browser has not yet fired beforeinstallprompt
  return (
    <>
      <button
        type="button"
        onClick={() => setShowInfoGuide(true)}
        aria-label="Installa App"
        className="inline-flex items-center justify-center gap-1.5 px-2 sm:px-3 min-h-[44px] min-w-[44px] rounded-lg text-xs font-semibold border border-stone-200 hover:bg-stone-50 text-stone-600 transition-colors"
        title="Installa Agenda Docente"
      >
        <Download className="w-3.5 h-3.5 text-stone-500" />
        <span className="hidden sm:inline">Installa PWA</span>
      </button>

      {showInfoGuide && <InstallInfoGuideSheet onClose={() => setShowInfoGuide(false)} />}
    </>
  );
};

/**
 * Full-width install row for the mobile "Altro" sheet. The WHOLE row is the
 * action — a tap always produces feedback (real prompt, guide, or installed
 * state), never a dead label. States:
 *   installed   → static "App già installata" row (not a button);
 *   installable → "Installa App" → real beforeinstallprompt;
 *   iOS         → "Come installare l'app" → iOS guide;
 *   unsupported → "Installazione non disponibile in questo browser" → info guide;
 *   manual      → "Installa App" → info guide.
 */
export const PWAInstallRow: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, unsupportedBrowser, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [showInfoGuide, setShowInfoGuide] = useState(false);
  const [installSuccess, setInstallSuccess] = useState(false);

  if (isInstalled) {
    return (
      <>
        <div
          className="more-sheet-item text-sm font-semibold text-stone-500"
          aria-label="App già installata"
          data-install-state="installed"
        >
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
          <span className="truncate">App già installata</span>
        </div>
        {installSuccess && <InstallSuccessToast />}
      </>
    );
  }

  const unsupported = unsupportedBrowser && !isInstallable;
  const label = isIOS
    ? "Come installare l'app"
    : unsupported
      ? "Installazione non disponibile in questo browser"
      : "Installa App";
  const installState = isInstallable ? "installable" : isIOS ? "ios" : unsupported ? "unsupported" : "manual";

  const handleRowClick = async () => {
    if (isInstallable) {
      const result = await install();
      if (result === "accepted") {
        setInstallSuccess(true);
        setTimeout(() => setInstallSuccess(false), 4000);
      } else if (result === "unavailable") {
        setShowInfoGuide(true);
      }
      // "dismissed" stays silent: the user said no, the row remains for later.
      return;
    }
    if (isIOS) setShowIOSGuide(true);
    else setShowInfoGuide(true);
  };

  return (
    <>
      <button
        type="button"
        id="mobile-more-install"
        onClick={() => void handleRowClick()}
        aria-label={label}
        data-install-state={installState}
        className="more-sheet-item text-sm font-semibold text-stone-800 active:bg-stone-100"
      >
        <Smartphone className="h-5 w-5 shrink-0 text-stone-400" />
        <span className="truncate">{label}</span>
      </button>

      {showIOSGuide && <IOSInstallGuideSheet onClose={() => setShowIOSGuide(false)} />}
      {showInfoGuide && <InstallInfoGuideSheet onClose={() => setShowInfoGuide(false)} />}
      {installSuccess && <InstallSuccessToast />}
    </>
  );
};
