import React, { useId, useState } from "react";
import { Plus, X } from "lucide-react";
import { formatPersonDisplayName } from "../utils/names";

/**
 * Compact multi-value chip input used for co-teaching subjects and teacher names.
 * Free text entry (Enter or button) plus <datalist> suggestions from values already used
 * elsewhere (the future school directory can feed the same `suggestions` prop).
 */
export const MultiChipInput: React.FC<{
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  addLabel?: string;
  /** Normalize each entered value (defaults to person-name normalization). */
  normalize?: (raw: string) => string;
  emptyHint?: string;
  disabled?: boolean;
}> = ({ id, values, onChange, suggestions = [], placeholder, addLabel = "Aggiungi", normalize, emptyHint, disabled }) => {
  const reactId = useId();
  const listId = id ?? `multi-chip-${reactId}`;
  const [draft, setDraft] = useState("");

  const normalizeValue = normalize ?? formatPersonDisplayName;

  const commit = () => {
    const normalized = normalizeValue(draft);
    if (!normalized) { setDraft(""); return; }
    if (!values.some(v => v.toLocaleLowerCase("it") === normalized.toLocaleLowerCase("it"))) {
      onChange([...values, normalized]);
    }
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          list={listId}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
          }}
          placeholder={placeholder}
          className="flex-1 p-2 border border-stone-300 rounded-lg text-xs bg-white min-h-[38px]"
        />
        <button
          type="button"
          disabled={disabled || !draft.trim()}
          onClick={commit}
          className="px-2.5 py-2 bg-stone-100 hover:bg-stone-200 disabled:opacity-40 text-stone-700 rounded-lg text-xs font-semibold whitespace-nowrap min-h-[38px]"
        >
          <Plus className="w-3.5 h-3.5 inline mr-1" />
          {addLabel}
        </button>
      </div>

      <datalist id={listId}>
        {suggestions
          .filter(s => !values.some(v => v.toLocaleLowerCase("it") === s.toLocaleLowerCase("it")))
          .map(s => <option key={s} value={s} />)}
      </datalist>

      {values.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <span
              key={value}
              className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-900 text-[11px] font-semibold"
            >
              {value}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(values.filter(v => v !== value))}
                className="p-0.5 rounded-full text-emerald-700 hover:bg-emerald-100"
                title={`Rimuovi ${value}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        emptyHint && <p className="text-[11px] text-stone-400">{emptyHint}</p>
      )}
    </div>
  );
};
