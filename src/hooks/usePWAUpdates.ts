import { useEffect, useRef, useState } from "react";

const UPDATE_CHECK_MS = 30 * 60 * 1000;

/**
 * Keeps the installed PWA current without ever touching user data.
 *
 * The Workbox service worker (registerType 'autoUpdate' in vite.config) precaches the shell
 * and skips waiting, so a new deployment takes control on the next fetch. This hook adds:
 * - a periodic + on-focus registration.update() check, so an app left open for days is not
 *   stuck on an old bundle indefinitely;
 * - an explicit, user-confirmed reload when a fresh version has been installed (never a
 *   surprise reload mid-typing);
 * - the automatic reload only while the tab is hidden (a safe moment chosen by the OS).
 *
 * IndexedDB and localStorage are service-worker-agnostic: updating the app shell can never
 * wipe them, and offline support keeps working from the precached assets.
 */
export function usePWAUpdates() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [failed, setFailed] = useState(false);
  const reloadQueued = useRef(false);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !import.meta.env.PROD) return;
    let disposed = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const onVisibility = () => {
      if (disposed || document.visibilityState !== "visible") return;
      void registration?.update().catch(() => undefined);
      // A safe automatic moment: nobody can be typing in a hidden tab.
      if (updateAvailableRef.current && !reloadQueued.current) {
        reloadQueued.current = true;
        window.location.reload();
      }
    };
    let registration: ServiceWorkerRegistration | null = null;
    const updateAvailableRef = { current: false };

    void navigator.serviceWorker.getRegistration().then(reg => {
      if (disposed || !reg) return;
      registration = reg;
      const checkInstalled = () => {
        const worker = reg.installing ?? reg.waiting;
        if (!worker) return;
        const onChange = () => {
          if (worker.state === "installed" && reg.active) {
            updateAvailableRef.current = true;
            setUpdateAvailable(true);
          }
          if (worker.state === "redundant") setFailed(true);
        };
        worker.addEventListener("statechange", onChange);
      };
      checkInstalled();
      reg.addEventListener("updatefound", checkInstalled);
      if (reg.waiting) { updateAvailableRef.current = true; setUpdateAvailable(true); }
      // If the new worker takes control while nobody is interacting, refresh the shell once.
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (disposed || reloadQueued.current) return;
        if (document.visibilityState === "hidden") {
          reloadQueued.current = true;
          window.location.reload();
        }
      });
      interval = setInterval(() => { void reg.update().catch(() => undefined); }, UPDATE_CHECK_MS);
      document.addEventListener("visibilitychange", onVisibility);
    }).catch(() => setFailed(true));

    return () => {
      disposed = true;
      if (interval) clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return {
    updateAvailable,
    failed,
    applyUpdate: () => {
      if (reloadQueued.current) return;
      reloadQueued.current = true;
      window.location.reload();
    },
  };
}
