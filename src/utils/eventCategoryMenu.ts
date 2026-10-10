import type { EventCategory } from "../types";

/**
 * Costruzione PURA delle opzioni del menu "Tipologia Impegno" (EventModal).
 *
 * Nessuna dipendenza da React: la logica di quali opzioni mostrare (categorie
 * standard, legacy "dipartimento", categorie fuori elenco) è testabile da sola.
 */

export interface EventCategoryOption {
  id: EventCategory;
  label: string;
}

export interface EventCategoryGroup {
  label: string;
  ids: EventCategory[];
}

export interface EventCategoryMenuGroup {
  label: string;
  options: EventCategoryOption[];
}

export interface EventCategoryMenu {
  /**
   * Opzioni fuori elenco (legacy o sconosciute): vanno in cima al menu e sono
   * selezionabili come le altre. Vuoto per le categorie standard.
   */
  extra: EventCategoryOption[];
  /** Gruppi nell'ordine dato, con le sole categorie standard presenti. */
  groups: EventCategoryMenuGroup[];
}

export interface BuildCategoryOptionsInput {
  /** Categoria corrente del form (può essere anche un valore fuori elenco). */
  currentCategory: string | null | undefined;
  /** L'evento in modifica (o precompilato) possiede la categoria legacy. */
  editingLegacyDipartimento: boolean;
  /** Elenco delle categorie standard (EVENT_CATEGORIES). */
  categories: readonly EventCategoryOption[];
  /** Gruppi del menu (EVENT_CATEGORY_GROUPS). */
  groups: readonly EventCategoryGroup[];
  /** Opzione legacy "dipartimento" (LEGACY_DIPARTIMENTO_CATEGORY). */
  legacyOption: EventCategoryOption;
  /** Etichetta del gruppo di riserva per categorie standard non raggruppate. */
  ungroupedLabel?: string;
}

export function buildCategoryOptions(input: BuildCategoryOptionsInput): EventCategoryMenu {
  const { currentCategory, editingLegacyDipartimento, categories, groups, legacyOption } = input;
  const knownIds = new Set<string>(categories.map(c => c.id));
  const byId = new Map<string, EventCategoryOption>(categories.map(c => [c.id, c]));

  // Opzioni fuori elenco, in cima.
  const extra: EventCategoryOption[] = [];
  const legacyIsCurrent = currentCategory === legacyOption.id;
  if (editingLegacyDipartimento || legacyIsCurrent) {
    extra.push(legacyOption);
  }
  if (currentCategory && !knownIds.has(currentCategory) && currentCategory !== legacyOption.id) {
    // Nessun formatter di etichette condiviso: per le categorie sconosciute si mostra l'id.
    extra.push({ id: currentCategory as EventCategory, label: currentCategory });
  }

  // Gruppi con le sole categorie standard, nell'ordine dei gruppi.
  const used = new Set<string>();
  const menuGroups: EventCategoryMenuGroup[] = [];
  for (const group of groups) {
    const options: EventCategoryOption[] = [];
    for (const id of group.ids) {
      const option = byId.get(id);
      if (option && !used.has(id)) {
        used.add(id);
        options.push(option);
      }
    }
    if (options.length > 0) menuGroups.push({ label: group.label, options });
  }

  // Categorie standard non presenti in nessun gruppo: non devono sparire dal menu.
  const ungrouped = categories.filter(c => !used.has(c.id));
  if (ungrouped.length > 0) {
    menuGroups.push({ label: input.ungroupedLabel ?? "Altre", options: [...ungrouped] });
  }

  return { extra, groups: menuGroups };
}
