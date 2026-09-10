import { useEffect, useState } from "react";

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/** Result of an install() call: accepted / dismissed by the user, or no usable prompt. */
export type InstallResult = "accepted" | "dismissed" | "unavailable";

/**
 * A captured beforeinstallprompt can only be used ONCE: after prompt() settles,
 * the event is spent and a second prompt() call would reject. Several hook
 * instances can hold the same event (Navbar + the "Altro" sheet both render
 * install UI), so consumption is tracked at module level.
 */
const consumedPrompts = new WeakSet<Event>();

/** Best-effort check for browsers without any PWA install path (not even manual). */
export function isBrowserWithoutInstallSupport(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  // Desktop Firefox: no PWA installation at all (Android Firefox and iOS Firefox
  // keep their own menu entries, so they are NOT treated as unsupported).
  if (ua.includes("firefox") && !ua.includes("android") && !ua.includes("mobile") && !ua.includes("fxios")) {
    return true;
  }
  return false;
}

/** iOS/iPadOS detection, including iPadOS in desktop mode (Mac UA + touch). */
export function isIOSDevice(userAgent: string, platform?: string, maxTouchPoints?: number): boolean {
  if (/iphone|ipad|ipod/.test(userAgent.toLowerCase())) return true;
  if (platform === "MacIntel" && (maxTouchPoints ?? 0) > 1) return true;
  return false;
}

/** True when the app already runs as an installed standalone PWA. */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [unsupportedBrowser, setUnsupportedBrowser] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsInstalled(isStandaloneDisplay());
    const nav = window.navigator;
    const ua = nav.userAgent ?? "";
    setIsIOS(isIOSDevice(ua, nav.platform, nav.maxTouchPoints));
    setUnsupportedBrowser(isBrowserWithoutInstallSupport(ua));

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      // Keep the event until it is really used; ignore it only if already spent.
      if (!consumedPrompts.has(e)) setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const install = async (): Promise<InstallResult> => {
    const promptEvent = deferredPrompt;
    // No event, or an event already spent by another instance: the caller must
    // still give visible feedback (e.g. open the manual guide), never stay silent.
    if (!promptEvent || consumedPrompts.has(promptEvent)) {
      if (promptEvent) setDeferredPrompt(null);
      return "unavailable";
    }
    consumedPrompts.add(promptEvent);
    setDeferredPrompt(null);
    try {
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === "accepted") {
        setIsInstalled(true);
        return "accepted";
      }
      // Dismissed: the spent event is already cleared; the browser may fire a
      // fresh beforeinstallprompt later. No reload, no error, nothing lost.
      return "dismissed";
    } catch {
      return "unavailable";
    }
  };

  return {
    isInstallable: !!deferredPrompt && !consumedPrompts.has(deferredPrompt),
    isInstalled,
    isIOS,
    unsupportedBrowser,
    install,
  };
}
