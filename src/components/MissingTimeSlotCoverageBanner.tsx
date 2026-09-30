import React from "react";
import { AlertCircle } from "lucide-react";
import type { MissingTimeSlotCoverage } from "../utils/timeSlotCoverage";

interface MissingTimeSlotCoverageBannerProps {
  missing: MissingTimeSlotCoverage[];
  onConfigure: (schoolId: string) => void;
}

/** Persistent follow-up shown after Profile saves dayPeriods without matching bells. */
export const MissingTimeSlotCoverageBanner: React.FC<MissingTimeSlotCoverageBannerProps> = ({
  missing,
  onConfigure,
}) => {
  if (missing.length === 0) return null;

  return (
    <div className="max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 pt-3 space-y-2" data-testid="missing-time-slot-coverage">
      {missing.map(item => (
        <div key={item.schoolId} role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 shadow-sm flex flex-col sm:flex-row sm:items-center gap-3">
          <AlertCircle className="w-5 h-5 text-amber-700 shrink-0 hidden sm:block" />
          <p className="text-xs leading-relaxed flex-1">
            Hai configurato un giorno con {item.requiredPeriods} ore{missing.length > 1 ? ` per ${item.schoolName}` : ""}, ma l’orario delle campanelle arriva ancora alla {item.effectivePeriods}ª ora. Configura la {item.requiredPeriods}ª fascia per poter usare e importare lezioni in quell’ora.
          </p>
          <button
            type="button"
            data-school-id={item.schoolId}
            onClick={() => onConfigure(item.schoolId)}
            className="min-h-[44px] rounded-xl bg-amber-800 px-4 py-2 text-xs font-bold text-white hover:bg-amber-900 shrink-0"
          >
            Configura {item.requiredPeriods}ª fascia
          </button>
        </div>
      ))}
    </div>
  );
};
