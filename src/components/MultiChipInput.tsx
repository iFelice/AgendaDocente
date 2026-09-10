import React, { useId, useMemo, useRef, useState } from "react";
import { Plus, X, CornerDownLeft } from "lucide-react";
import { formatPersonDisplayName } from "../utils/names";

/**
 * Case- and accent-insensitive fold used to compare values/suggestions so that
 * "Matematica", "matematica" or "Prof.ssa rossi" vs "Prof.ssa Rossi" never duplicate.
 */
const foldValue = (value: string): string =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("it")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Reusable mobile-friendly multi-value picker (search + clickable suggestions + removable
 * chips). It replaces the old <datalist> approach: on smartphones the native datalist
 * dropdown is unreliable/not rendered at all, so the suggestions are a real, always visible
 * list rendered by React. The same component serves:
 *  - co-teaching subjects (predefined suggestions + free custom values);
 *  - teacher names (suggestions from names already used + free new names).
 *
 * Keyboard (desktop): ArrowDown/ArrowUp move the active suggestion, Enter adds it (or the
 * typed free value), Backspace on an empty field removes the last chip, Escape closes the
 * list. Touch (mobile): tap a suggestion to add it, tap the ✕ on a chip to remove it.
 * No native browser menu is involved.
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
  /** Compact variant: smaller chips/paddings, still touch-friendly. */
  compact?: boolean;
}> = ({ id, values, onChange, suggestions = [], placeholder, addLabel = "Aggiungi", normalize, emptyHint, disabled, compact }) => {
  const reactId = useId();
  const rootId = id ?? `multi-chip-${reactId}`;
  const listboxId = `${rootId}-listbox`;
  const inputId = `${rootId}-input`;
  const [draft, setDraft] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const normalizeValue = normalize ?? formatPersonDisplayName;

  // Suggestions not already selected, filtered by the typed text (case/accent-insensitive).
  const matches = useMemo(() => {
    const selected = new Set(values.map(foldValue));
    const needle = foldValue(draft);
    return suggestions.filter((s) => {
      const folded = foldValue(s);
      return !selected.has(folded) && (!needle || folded.includes(needle));
    });
  }, [draft, suggestions, values]);

  // A free value can be added only when it is not just a differently-typed copy of an
  // existing suggestion/value (no duplicates, canonical spelling wins).
  const foldedDraft = foldValue(draft);
  const isKnown = suggestions.some((s) => foldValue(s) === foldedDraft);
  const canAddCustom = draft.trim().length > 0 && !isKnown;
  const hasContent = matches.length > 0 || canAddCustom;
  const showList = isOpen && hasContent && !disabled;

  const commit = (raw: string, suggestion?: string) => {
    // Prefer the canonical suggestion spelling when the typed text matches one.
    const canonical =
      suggestion ??
      suggestions.find((s) => foldValue(s) === foldValue(raw));
    const clean = (canonical ?? normalizeValue(raw)).trim();
    if (!clean) {
      setDraft("");
      return;
    }
    if (!values.some((v) => foldValue(v) === foldValue(clean))) {
      onChange([...values, clean]);
    }
    setDraft("");
    setActiveIndex(-1);
    setIsOpen(true);
    inputRef.current?.focus();
  };

  const removeValue = (value: string) => {
    onChange(values.filter((v) => v !== value));
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (matches.length > 0 && activeIndex >= 0) {
        commit(matches[activeIndex]);
      } else if (matches.length === 1 && draft && foldValue(matches[0]).startsWith(foldValue(draft))) {
        // Unambiguous unique suggestion for the typed prefix: commit the canonical value.
        commit(matches[0]);
      } else {
        commit(draft);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen) { setIsOpen(true); setActiveIndex(-1); return; }
      if (matches.length > 0) setActiveIndex((i) => (i + 1) % matches.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (matches.length > 0) setActiveIndex((i) => (i <= 0 ? matches.length - 1 : i - 1));
      return;
    }
    if (e.key === "Escape") {
      setIsOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (e.key === "Backspace" && !draft && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  const openList = () => {
    if (blurTimer.current) { clearTimeout(blurTimer.current); blurTimer.current = null; }
    setIsOpen(true);
  };

  const scheduleClose = () => {
    blurTimer.current = setTimeout(() => {
      setIsOpen(false);
      setActiveIndex(-1);
    }, 120);
  };

  const chipCls = compact
    ? "pl-2 pr-0.5 py-0.5 text-[11px]"
    : "pl-2.5 pr-1 py-1 text-xs";
  const optionCls = compact
    ? "px-2.5 py-2 text-[11px]"
    : "px-3 py-2.5 text-xs";

  return (
    <div className="space-y-1.5">
      {/* Selected values as removable chips (above the input: adding a chip never shifts the
          suggestion list while typing). */}
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Valori selezionati">
          {values.map((value) => (
            <span
              key={value}
              className={`inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-900 font-semibold ${chipCls}`}
            >
              <span className="max-w-[40vw] truncate">{value}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeValue(value)}
                className="p-1 rounded-full text-emerald-700 hover:bg-emerald-200/70 hover:text-emerald-950 disabled:opacity-40 transition-colors"
                title={`Rimuovi ${value}`}
                aria-label={`Rimuovi ${value}`}
              >
                <X className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search row: text input + explicit add button. No datalist anywhere. */}
      <div className="flex items-stretch gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={draft}
            disabled={disabled}
            role="combobox"
            aria-expanded={showList}
            aria-controls={showList ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              showList && activeIndex >= 0 && matches[activeIndex]
                ? `${listboxId}-option-${activeIndex}`
                : undefined
            }
            aria-label={placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              setActiveIndex(-1);
              setIsOpen(true);
            }}
            onFocus={openList}
            onBlur={scheduleClose}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="w-full p-2.5 border border-stone-300 rounded-lg bg-white text-stone-900 min-h-[44px] focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 outline-none placeholder:text-stone-400 disabled:bg-stone-50"
          />
        </div>
        <button
          type="button"
          disabled={disabled || !draft.trim()}
          onClick={() => commit(draft)}
          className="px-3 py-2 bg-stone-100 hover:bg-stone-200 active:bg-stone-300 disabled:opacity-40 disabled:hover:bg-stone-100 text-stone-700 rounded-lg font-semibold whitespace-nowrap min-h-[44px] flex items-center gap-1 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span className={compact ? "hidden" : undefined}>{addLabel}</span>
        </button>
      </div>

      {/* Suggestion listbox — always rendered by React, never the native browser menu.
          In normal document flow so it cannot be clipped by modal overflow. */}
      {showList && (
        <div
          id={listboxId}
          role="listbox"
          aria-multiselectable="true"
          className="border border-stone-200 rounded-xl bg-white shadow-md overflow-hidden"
        >
          <ul className="max-h-56 overflow-y-auto overscroll-contain divide-y divide-stone-100" role="presentation">
            {matches.map((suggestion, index) => {
              const isActive = index === activeIndex;
              return (
                <li key={suggestion} role="presentation">
                  <button
                    type="button"
                    role="option"
                    id={`${listboxId}-option-${index}`}
                    aria-selected={values.some((v) => foldValue(v) === foldValue(suggestion))}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commit(suggestion)}
                    className={`w-full text-left flex items-center justify-between gap-2 transition-colors min-h-[44px] ${optionCls} ${
                      isActive
                        ? "bg-emerald-50 text-emerald-950"
                        : "text-stone-700 hover:bg-stone-50 active:bg-stone-100"
                    }`}
                  >
                    <span className="truncate">{suggestion}</span>
                    {isActive && <CornerDownLeft className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden />}
                  </button>
                </li>
              );
            })}

            {canAddCustom && (
              <li role="presentation">
                <button
                  type="button"
                  role="option"
                  id={`${listboxId}-option-custom`}
                  aria-selected={false}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(draft)}
                  className={`w-full text-left flex items-center gap-1.5 transition-colors min-h-[44px] ${optionCls} ${
                    activeIndex >= matches.length ? "bg-emerald-50 text-emerald-950" : "text-emerald-800 hover:bg-emerald-50/60 active:bg-emerald-50"
                  }`}
                >
                  <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden />
                  <span className="truncate">
                    Aggiungi “{draft.trim()}”
                  </span>
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      {values.length === 0 && !showList && emptyHint && (
        <p className="text-[11px] text-stone-400">{emptyHint}</p>
      )}
    </div>
  );
};
