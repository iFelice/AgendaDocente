export type CollapseGroup = "timetable" | "scheduledAssessments" | "commitments";
export type CollapseState = Record<CollapseGroup, boolean>;

const DAILY_KEY = "agenda-docente:daily-collapse:v1";
const WEEKLY_KEY = "agenda-docente:weekly-collapse:v1";
const DEFAULTS: CollapseState = { timetable: false, scheduledAssessments: false, commitments: false };

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch { return fallback; }
};

export function readDailyCollapse(date: string): CollapseState {
  try {
    const all = JSON.parse(localStorage.getItem(DAILY_KEY) || "{}");
    const entries = Object.entries(all).filter(([key]) => key >= new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10));
    localStorage.setItem(DAILY_KEY, JSON.stringify(Object.fromEntries(entries)));
    return { ...DEFAULTS, ...(all[date] || {}) };
  } catch { return { ...DEFAULTS }; }
}
export function writeDailyCollapse(date: string, state: CollapseState): void {
  try {
    const all = JSON.parse(localStorage.getItem(DAILY_KEY) || "{}");
    all[date] = state;
    const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    localStorage.setItem(DAILY_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).filter(([key]) => key >= cutoff))));
  } catch { /* presentation preference only */ }
}
export function readWeeklyCollapse(): CollapseState { return read(WEEKLY_KEY, { ...DEFAULTS }); }
export function writeWeeklyCollapse(state: CollapseState): void { try { localStorage.setItem(WEEKLY_KEY, JSON.stringify(state)); } catch { /* presentation preference only */ } }
export const defaultCollapseState = (): CollapseState => ({ ...DEFAULTS });
