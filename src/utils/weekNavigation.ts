/** Reference teaching week: weekends roll forward unless explicitly disabled. */
export const getReferenceMonday = (refDate: Date, rollWeekend: boolean = true): Date => {
  const d = new Date(refDate);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Domenica, 1 = Lunedì, ..., 5 = Venerdì, 6 = Sabato

  if (rollWeekend && (day === 6 || day === 0)) {
    // Sabato (6) -> +2 giorni (Lunedì successivo)
    // Domenica (0) -> +1 giorno (Lunedì successivo)
    const daysToNextMonday = day === 6 ? 2 : 1;
    d.setDate(d.getDate() + daysToNextMonday);
    return d;
  }

  // Regola sul Lunedì della settimana corrente
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d;
};

