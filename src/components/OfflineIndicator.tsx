import React from "react";
import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "../hooks/useOnlineStatus";

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="app-toast fixed left-3 right-3 md:left-4 md:right-auto md:bottom-4 z-50 flex items-center space-x-2 rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white shadow-lg animate-in fade-in slide-in-from-bottom-2"
    >
      <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
      <WifiOff className="w-3.5 h-3.5" />
      <span>Modalità Offline: i dati salvati sul dispositivo sono attivi</span>
    </div>
  );
};
