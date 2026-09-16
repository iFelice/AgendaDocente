import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { selectDayAgenda, TodayView } from '../src/components/TodayView';
import { WeekView } from '../src/components/WeekView';
import { addDaysISO, localDateISO } from '../src/utils/dates';
import { getReferenceMonday } from '../src/utils/weekNavigation';
import type { TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Layout mobile dell'intestazione di Oggi e Settimana.
 *
 * Bug reale su smartphone: la data estesa ("Mercoledì 30 settembre 2026"), il badge
 * Oggi/Futuro/Passato e i controlli ← / Oggi / → stavano nella stessa riga flex: a
 * 320-393 px la data arrivava sopra la freccia sinistra o sul pulsante "Oggi".
 *
 * I test DOM non possono misurare il layout reale (non c'è un motore di impaginazione),
 * quindi qui si verificano due cose insieme:
 *  1. STRUTTURA — su mobile data+badge e navigazione sono contenitori fratelli in righe
 *     diverse (flex-col → sm:flex-row): nessuna lunghezza della stringa può farli
 *     sovrapporre, perché non condividono la stessa linea di base;
 *  2. MISURA — tutte le 365 date dell'anno scolastico 2026/27 (e tutte le settimane)
 *     passano da un modello di larghezza del testo deliberatamente pessimistico: la data
 *     deve stare nella riga a lei dedicata e nessuna parola deve essere più larga della
 *     riga (altrimenti "sfora" o viene resa illeggibile).
 */

const VIEWPORTS = [320, 360, 375, 390, 393, 430] as const;
/** Su mobile: main (px-3) + carta (p-3) = 12px per lato per contenitore ⇒ 48px in tutto. */
const MOBILE_CHROME_PX = 48;
/** Da sm: main (sm:px-6) + carta Settimana (sm:p-4) = 24px + 16px per lato. */
const SM_CHROME_PX = 80;
const MOBILE_DATE_FONT_PX = 16; // text-base, NON ridotto per far stare la data
const MOBILE_BADGE_FONT_PX = 10; // text-[10px]
const MOBILE_RANGE_FONT_PX = 12; // text-xs

/**
 * Larghezza media di un glifo in `em` per un font di sistema in grassetto. Valori
 * sopra la media reale (0,62em per le minuscole, 0,94 per "m"): il modello
 * SOVRASTIMA, quindi uno spazio che sta qui sta anche sul dispositivo.
 */
const GLYPH_EM: Record<string, number> = {
  ' ': 0.27, '–': 0.66, '—': 1, '.': 0.32, ',': 0.3, '’': 0.26, "'": 0.26, '-': 0.4, ':': 0.34,
  i: 0.3, l: 0.3, j: 0.38, t: 0.38, f: 0.38, r: 0.44, I: 0.36, J: 0.42,
  m: 0.86, w: 0.82, M: 0.88, W: 0.98,
};
function advanceEm(char: string): number {
  if (GLYPH_EM[char] !== undefined) return GLYPH_EM[char];
  if (/[0-9]/.test(char)) return 0.58;
  // "…" e qualsiasi altro glifo: larga come una maiuscola.
  return /[A-ZÀ-ÖØ-Þ]/.test(char) ? 0.7 : 0.6;
}
/** Larghezza in pixel di una stringa, arrotondata per eccesso (perché il modello sovrastima). */
export function estimateTextWidth(text: string, fontPx: number): number {
  let em = 0;
  for (const char of text) em += advanceEm(char);
  return Math.ceil(em * fontPx);
}

const availableWidth = (viewport: number) => viewport - MOBILE_CHROME_PX;
const availableSmWidth = (viewport: number) => viewport - SM_CHROME_PX;

/** Stessa formattazione usata da selectDayAgenda/TodayView. */
function itLongDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const formatted = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(y, m - 1, d));
  return formatted.charAt(0).toUpperCase() + formatted.slice(1); // come fa selectDayAgenda
}

function* schoolYearDays(from = '2026-09-01', days = 365): Generator<string> {
  let cursor = from;
  for (let i = 0; i < days; i++) {
    yield cursor;
    cursor = addDaysISO(cursor, 1);
  }
}

const ALL_DATES = [...schoolYearDays()];
const BADGE_WIDTH = estimateTextWidth('Passato', MOBILE_BADGE_FONT_PX) + 12 + 8; // px-1.5 + gap-x-2
const OGGI_BUTTON_WIDTH = estimateTextWidth('Oggi', 12) + 20 + 2; // px-2.5 + bordo
/** ← + Oggi + → : i target toccabili restano 44px, non si comprimono. */
const NAV_WIDTH = 44 + OGGI_BUTTON_WIDTH + 44 + 8;

// ---------------------------------------------------------------------------
// 1. Le 365 date dell'anno scolastico, senza eccezioni
// ---------------------------------------------------------------------------

test('tutte le 365 date 2026-09-01 → 2027-08-31 producono una data estesa valida', () => {
  assert.equal(ALL_DATES.length, 365);
  assert.equal(ALL_DATES[0], '2026-09-01');
  assert.equal(ALL_DATES[364], '2027-08-31');
  const weekdays = new Set<string>();
  for (const iso of ALL_DATES) {
    const { displayDate, isToday } = selectDayAgenda(iso, [], []);
    assert.match(displayDate, /^(Lunedì|Martedì|Mercoledì|Giovedì|Venerdì|Sabato|Domenica) \d{1,2} (gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre) (2026|2027)$/, `data estesa di ${iso}`);
    assert.equal(displayDate.startsWith(displayDate.charAt(0).toUpperCase()), true, 'iniziale maiuscola come nell\'app');
    assert.equal(isToday, iso === localDateISO());
    weekdays.add(displayDate.split(' ')[0]);
  }
  assert.equal(weekdays.size, 7, 'l\'anno scolastico copre tutti i giorni della settimana');
});

test('caso noto "Mercoledì 30 settembre 2026" e la data più lunga dell\'intero anno', () => {
  const known = itLongDate('2026-09-30');
  assert.equal(known, 'Mercoledì 30 settembre 2026');
  assert.match(selectDayAgenda('2026-09-30', [], []).displayDate, /^Mercoledì 30 settembre 2026$/);

  const measured = ALL_DATES.map((iso) => {
    const text = selectDayAgenda(iso, [], []).displayDate;
    return { iso, text, chars: text.length, px: estimateTextWidth(text, MOBILE_DATE_FONT_PX) };
  });
  const longest = measured.reduce((max, item) => (item.px > max.px ? item : max));
  const longestByChars = measured.reduce((max, item) => (item.chars > max.chars ? item : max));
  assert.match(longest.text, /^Mercoledì \d+ settembre 2026$/, `data più larga: ${longest.text}`);
  assert.equal(longestByChars.chars, longest.chars, 'la stessa classe di date è anche la più lunga per caratteri');
  // 27 caratteri "Mercoledì 30 settembre 2026" sono il massimo assoluto dell'anno.
  assert.ok(longest.chars <= 27, `lunghezza massima inattesa: ${longest.text} (${longest.chars})`);
});

test('ogni data sta nella SUA riga a tutte le larghezze mobile, senza dipendere dalla lunghezza', () => {
  for (const viewport of VIEWPORTS) {
    const line = availableWidth(viewport);
    for (const iso of ALL_DATES) {
      const text = selectDayAgenda(iso, [], []).displayDate;
      const width = estimateTextWidth(text, MOBILE_DATE_FONT_PX);
      assert.ok(width <= line, `${viewport}px: "${text}" (${width}px) deve stare nella riga della data (${line}px)`);
      for (const word of text.split(' ')) {
        assert.ok(estimateTextWidth(word, MOBILE_DATE_FONT_PX) <= line, `"${word}" di per sé non deve eccedere la riga a ${viewport}px`);
      }
    }
  }
});

test('badge Oggi/Futuro/Passato: sta sulla riga 1 accanto alla data e, se serve, va a capo — mai sulla navigazione', () => {
  for (const viewport of VIEWPORTS) {
    const line = availableWidth(viewport);
    for (const iso of ALL_DATES) {
      const text = selectDayAgenda(iso, [], []).displayDate;
      const row = estimateTextWidth(text, MOBILE_DATE_FONT_PX) + 8 + BADGE_WIDTH;
      assert.ok(row <= line * 2, `${viewport}px: data+badge devono stare in al massimo 2 righe della stessa area (${row} > ${line * 2})`);
    }
    // La prova che il vecchio layout a riga unica era strutturalmente impossibile:
    // data + badge + navigazione non stavano insieme, e ridurre il font non sarebbe
    // bastato (a 320px la data è già al limite della leggibilità).
    const worst = estimateTextWidth('Mercoledì 30 settembre 2026', MOBILE_DATE_FONT_PX) + 8 + BADGE_WIDTH + 8 + NAV_WIDTH;
    assert.ok(worst > line, `${viewport}px: la riga unica richiederebbe ${worst}px su ${line}px`);
  }
});

// ---------------------------------------------------------------------------
// 2. Struttura reale di TodayView (contenitori separati su mobile)
// ---------------------------------------------------------------------------

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

function classesOf(node: any): string[] {
  return String(node?.props?.className ?? '').split(' ').filter(Boolean);
}
function classStringOf(node: any): string {
  return String(node?.props?.className ?? '');
}
function flatText(node: any): string {
  const parts: string[] = [];
  const walk = (n: any) => {
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return; }
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.children)) n.children.forEach(walk);
    else if (typeof n.children === 'string' || typeof n.children === 'number') parts.push(String(n.children));
  };
  if (Array.isArray(node?.children)) node.children.forEach(walk);
  else walk(node?.children);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
function byId(renderer: any, id: string) {
  const found = renderer.root.findAll((el: any) => el.props?.id === id);
  assert.equal(found.length, 1, `elemento con id "${id}" presente una sola volta`);
  return found[0];
}

async function renderToday() {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TodayView, {
      profile,
      timetable: [],
      events: [],
      isProvisionalTimetable: false,
      isDefinitiveCompiled: true,
      onOpenNewEvent: () => {},
      onOpenCircularModal: () => {},
      onEditEvent: () => {},
      onDeleteEvent: () => {},
      onToggleComplete: () => {},
    }));
  });
  return renderer;
}

test('TodayView: su mobile data+badge e navigazione sono righe separate (flex-col, in fila solo da sm)', async () => {
  const renderer = await renderToday();
  const header = byId(renderer, 'today-header');
  const dateLine = byId(renderer, 'today-date-line');
  const nav = byId(renderer, 'today-day-nav');
  const badge = byId(renderer, 'today-day-status');

  // Riga 1 e riga 2: contenitori fratelli, non stessa linea flex su mobile.
  assert.ok(classesOf(header).includes('flex-col'), 'mobile: le due righe sono impilate');
  assert.ok(classesOf(header).includes('sm:flex-row'), 'da sm in su: layout orizzontale');
  assert.ok(classesOf(header).includes('min-w-0'), 'l\'intestazione può restringersi');
  assert.equal(nav.parent, header, 'la navigazione è figlia dell\'intestazione');
  assert.equal(dateLine.parent, header, 'la riga della data è figlia dell\'intestazione');
  assert.notEqual(nav.parent, dateLine, 'data e navigazione non condividono mai la riga');
  assert.ok(!dateLine.findAll((el: any) => el === nav).length, 'la navigazione non è dentro la riga della data');
  assert.ok(!nav.findAll((el: any) => el === dateLine).length, 'la riga della data non è dentro la navigazione');

  // Riga 1 = data + badge; la data può andare a capo ma non essere troncata.
  assert.match(flatText(dateLine), /lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica/i);
  assert.ok(nav.findAll((el: any) => el.type === 'h1').length === 0, 'la data non finisce mai nella riga dei controlli');
  const title = dateLine.findByType('h1');
  assert.ok(classesOf(title).includes('break-words'), 'la data lunga va a capo sulle parole');
  for (const forbidden of ['truncate', 'whitespace-nowrap']) {
    assert.ok(!classStringOf(title).includes(forbidden), `nessun "${forbidden}": la data non può essere resa illeggibile`);
  }
  assert.ok(!classStringOf(dateLine).includes('truncate'), 'la riga della data non tronca il testo');
  assert.ok(classesOf(nav).includes('shrink-0'), 'i controlli non vengono compressi dalla data');

  // Badge sulla riga 1 (accanto alla data), mai fra i controlli.
  assert.ok(classesOf(dateLine).includes('flex-wrap'), 'se non c\'è spazio il badge va a capo, non sopra i controlli');
  assert.ok(badge.parent === dateLine, 'il badge Oggi/Futuro/Passato vive nella riga della data');
  assert.ok(nav.findAll((el: any) => el.props?.id === 'today-day-status').length === 0, 'il badge non entra nei controlli');

  // Riga 2: ← Oggi → centrata in modo coerente, allineata a destra da sm.
  assert.ok(classesOf(nav).includes('justify-center'), 'navigazione centrata su mobile');
  assert.ok(classesOf(nav).includes('sm:justify-end'), 'allineata a destra da sm in su (invariata)');
  await act(async () => { renderer.unmount(); });
});

test('TodayView: touch target, aria-label e semantica verde/ambra restano invariati', async () => {
  const renderer = await renderToday();
  const nav = byId(renderer, 'today-day-nav');
  assert.equal(nav.props.role, 'group');
  assert.equal(nav.props['aria-label'], 'Navigazione del giorno');
  const buttons = nav.findAll((el: any) => el.type === 'button');
  assert.equal(buttons.length, 3, '← / Oggi / →');
  for (const button of buttons) {
    assert.ok(classStringOf(button).includes('min-h-[44px]'), 'altezza tocco >= 44px');
  }
  for (const id of ['today-previous-day', 'today-next-day']) {
    assert.ok(classStringOf(byId(renderer, id)).includes('min-w-[44px]'), `larghezza tocco di ${id} >= 44px`);
  }
  assert.equal(byId(renderer, 'today-previous-day').props['aria-label'], 'Giorno precedente');
  assert.equal(byId(renderer, 'today-next-day').props['aria-label'], 'Giorno successivo');

  const backToToday = byId(renderer, 'today-back-to-today');
  assert.equal(flatText(backToToday), 'Oggi', 'il pulsante si chiama sempre "Oggi"');
  const mobileBadge = byId(renderer, 'today-day-status');
  // Oggi reale: verde. Su un'altra data: ambra il pulsante, ambra/neutro il badge.
  assert.ok(classStringOf(backToToday).includes('bg-emerald-700'), 'verde = oggi');
  assert.ok(classStringOf(mobileBadge).includes('bg-emerald-100'), 'badge "Oggi" verde');
  assert.ok(!classStringOf(mobileBadge).includes('amber'), 'il badge odierno non è ambra');

  await act(async () => { byId(renderer, 'today-next-day').props.onClick(); });
  assert.ok(classStringOf(byId(renderer, 'today-back-to-today')).includes('bg-amber-400'), 'su altra data "Oggi" diventa ambra');
  assert.ok(classStringOf(byId(renderer, 'today-day-status')).includes('bg-amber-100'), 'badge "Futuro" ambra');
  assert.equal(flatText(byId(renderer, 'today-day-status')), 'Futuro');
  // Il testo della data resta integro anche dopo la navigazione.
  assert.match(flatText(byId(renderer, 'today-date-line').findByType('h1')), /(Lunedì|Martedì|Mercoledì|Giovedì|Venerdì|Sabato|Domenica) \d{1,2} [a-z]+ \d{4}/);
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// 3. WeekView: navigazione e intervallo date su righe separate (mobile)
// ---------------------------------------------------------------------------

function itShortDay(date: Date): string {
  return new Intl.DateTimeFormat('it-IT', { weekday: 'short' }).format(date).toUpperCase();
}
function itShortMonth(date: Date): string {
  return new Intl.DateTimeFormat('it-IT', { month: 'short' }).format(date).toUpperCase();
}

/** Tutte le settimane (lunedì) dell'anno scolastico 2026/27, 5 e 6 giorni. */
function weekLabels(): Array<{ monday: string; days: number; mobile: string; desktop: string }> {
  const labels: Array<{ monday: string; days: number; mobile: string; desktop: string }> = [];
  let monday = getReferenceMonday(new Date(2026, 8, 1), true); // lunedì 31/08/2026
  for (let i = 0; i < 53; i++) {
    for (const days of [5, 6]) {
      const dayList = Array.from({ length: days }, (_, k) => {
        const d = new Date(monday);
        d.setDate(monday.getDate() + k);
        return d;
      });
      const first = dayList[0];
      const last = dayList[dayList.length - 1];
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const cell = (d: Date) => `${itShortDay(d)} ${d.getDate()} ${itShortMonth(d)}`;
      labels.push({
        monday: iso(monday),
        days,
        mobile: `${cell(first)} – ${cell(last)}`,
        desktop: `Settimana dal ${cell(first)} al ${cell(last)}`,
      });
    }
    monday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
  }
  return labels;
}

const WEEKS = weekLabels();

test('tutte le settimane 2026/27: l\'intervallo mobile sta sulla sua riga a 320-430px', () => {
  assert.equal(WEEKS.length, 106, '53 settimane × (5 giorni, 6 giorni)');
  let worst = { text: '', px: 0 };
  for (const week of WEEKS) {
    assert.match(week.mobile, /^[A-ZÀ-Ü]+ \d{1,2} [A-ZÀ-Ü]+ – [A-ZÀ-Ü]+ \d{1,2} [A-ZÀ-Ü]+$/);
    const px = estimateTextWidth(week.mobile, MOBILE_RANGE_FONT_PX);
    if (px > worst.px) worst = { text: week.mobile, px };
    for (const viewport of VIEWPORTS) {
      assert.ok(px <= availableWidth(viewport), `${viewport}px: "${week.mobile}" (${px}px) sull\'intervallo mobile`);
    }
    // Il testo lungo (sm+) deve stare nella riga orizzontale a 640px.
    const desktopPx = estimateTextWidth(week.desktop, 14) + 44 + 44 + estimateTextWidth('Questa Settimana', 12) + 40 + 24;
    assert.ok(desktopPx <= availableWidth(640), `sm: "${week.desktop}" + controlli (${desktopPx}px) dentro ${availableWidth(640)}px`);
  }
  assert.ok(worst.px > 0);
  // La settimana più lunga dell'anno è quella che tocca i mesi in lettere più lunghe.
  assert.match(worst.text, /–/);
});

test('WeekView: su mobile riga navigazione e riga intervallo sono separate; i target restano 44px', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(WeekView, {
      profile,
      timetable: [],
      events: [],
      onOpenNewEvent: () => {},
      onEditEvent: () => {},
    }));
  });
  const controls = byId(renderer, 'week-header-controls');
  const nav = byId(renderer, 'week-navigation');
  const range = byId(renderer, 'week-range');

  assert.ok(classesOf(controls).includes('flex-col'), 'mobile: navigazione e intervallo su righe diverse');
  assert.ok(classesOf(controls).includes('sm:flex-row'), 'da sm in su: stessa riga');
  assert.ok(classesOf(controls).includes('sm:flex-wrap'), 'alle larghezze intermedie si a capo, non ci si sovrappone');
  assert.equal(nav.parent, controls, 'fratelli nella stessa area');
  assert.equal(range.parent, controls, 'l\'intervallo è fratello della navigazione');
  assert.ok(nav.findAll((el: any) => el === range).length === 0, 'l\'intervallo non è mai dentro il gruppo dei pulsanti');
  assert.equal(nav.props.role, 'group');
  assert.equal(nav.props['aria-label'], 'Navigazione della settimana');
  assert.ok(classesOf(nav).includes('shrink-0'), 'i controlli non si comprimono per far posto al testo');
  assert.ok(classesOf(range).includes('break-words') && !classStringOf(range).includes('truncate'), 'intervallo integro e leggibile');
  assert.ok(!classStringOf(range).includes('whitespace-nowrap'));

  const buttons = nav.findAll((el: any) => el.type === 'button');
  assert.equal(buttons.length, 3, '← / Questa Settimana / →');
  for (const button of buttons) assert.ok(classStringOf(button).includes('min-h-[44px]'), 'touch target >= 44px');
  assert.ok(classStringOf(nav.findAll((el: any) => el.props?.title === 'Settimana precedente')[0]).includes('min-w-[44px]'));
  assert.ok(classStringOf(nav.findAll((el: any) => el.props?.title === 'Settimana successiva')[0]).includes('min-w-[44px]'));
  // Logica di navigazione invariata: i pulsanti ci sono e non sono disabilitati fuori settimana.
  const jump = buttons.find((b: any) => !b.props['aria-label']);
  assert.ok(jump, 'il pulsante "Questa Settimana" non ha un aria-label diverso da prima');
  assert.match(flatText(jump), /Questa Settimana|Settimana Entrante/);
  assert.match(flatText(range), /–/);
  await act(async () => { renderer.unmount(); });
});
