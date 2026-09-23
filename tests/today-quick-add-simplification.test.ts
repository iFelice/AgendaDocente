import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { MobileNav } from '../src/components/MobileNav';
import { TodayView } from '../src/components/TodayView';
import type { CalendarEvent, TeacherProfile, TimetableSlot, ViewMode } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Minimal browser globals: MobileNav touches `window` (matchMedia) and
 * `document` (keyboard listeners) in effects. Same approach as mobile-nav.test.ts.
 */
const keydownListeners: ((event: { key: string }) => void)[] = [];
(globalThis as any).window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: 'node' },
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as any).document = {
  addEventListener: (type: string, fn: (event: { key: string }) => void) => {
    if (type === 'keydown') keydownListeners.push(fn);
  },
  removeEventListener: (type: string, fn: (event: { key: string }) => void) => {
    if (type !== 'keydown') return;
    const index = keydownListeners.indexOf(fn);
    if (index >= 0) keydownListeners.splice(index, 1);
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../src/index.css'), 'utf8');

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Maria Rossi', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Matematica'],
  classes: ['1A', '2B'], campuses: ['Sede Centrale'], roles: [],
};

/*
 * Test focused on the simplification of the "Oggi" view:
 *  - the "Impegni & Riunioni" header shows the count of the currently selected
 *    day and reacts to every day-selection control (arrows, swipe, picker, Oggi);
 *  - the inline "+ Aggiungi" (section) and "+ Aggiungi scadenza" shortcuts are
 *    gone: the FAB is the only quick-add point of the view;
 *  - the FAB keeps opening the normal creation flow and now uses the lighter,
 *    softer green aligned with the timetable's green cells.
 *
 * Scope: Oggi view + FAB only. No data model, no persistence changes.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const todayIso = new Date().toLocaleDateString('sv-SE');

function event(date: string, id: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    title: `Impegno ${id}`,
    category: 'consiglio_classe',
    date,
    isAllDay: false,
    startTime: '15:00',
    endTime: '16:00',
    sourceType: 'manuale',
    completed: false,
    ...overrides,
  };
}

function todayProps(overrides: Partial<React.ComponentProps<typeof TodayView>> = {}) {
  return {
    profile,
    timetable: [] as TimetableSlot[],
    events: [],
    isProvisionalTimetable: false,
    isDefinitiveCompiled: true,
    onOpenNewEvent: () => {},
    onOpenCircularModal: () => {},
    onEditEvent: () => {},
    onDeleteEvent: () => {},
    onToggleComplete: () => {},
    ...overrides,
  };
}

async function renderToday(overrides: Partial<React.ComponentProps<typeof TodayView>> = {}) {
  const renderer = await act(async () => {
    const r = create(React.createElement(TodayView, todayProps(overrides)));
    await Promise.resolve();
    return r;
  });
  return renderer;
}

function navProps(overrides: Partial<React.ComponentProps<typeof MobileNav>> = {}) {
  return {
    currentView: 'oggi' as ViewMode,
    onViewChange: () => {},
    onOpenNewEvent: () => {},
    onOpenProfileModal: () => {},
    onOpenGoogleTab: () => {},
    onOpenGoogleLogin: async () => null,
    onOpenTutorial: () => {},
    onOpenCircularModal: () => {},
    googleUser: null,
    stats: { todayEventsCount: 1, pendingDeadlinesCount: 0 },
    ...overrides,
  };
}

async function renderNav(overrides: Partial<React.ComponentProps<typeof MobileNav>> = {}) {
  const renderer = await act(async () => {
    const r = create(React.createElement(MobileNav, navProps(overrides)));
    await Promise.resolve();
    return r;
  });
  return renderer;
}

function nodeText(node: any): string {
  const parts: string[] = [];
  const walk = (n: any) => {
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return; }
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.children)) n.children.forEach(walk);
    else if (typeof n.children === 'string' || typeof n.children === 'number') parts.push(String(n.children));
  };
  walk(node);
  return parts.join(' ');
}

function flatText(node: any): string {
  return nodeText(node).replace(/\s+/g, ' ').trim();
}

function byId(scope: any, id: string) {
  const root = scope?.root ?? scope;
  const found = root.findAll((el: any) => el.props?.id === id);
  assert.ok(found.length > 0, `element with id "${id}" must exist`);
  return found[0];
}

function countById(scope: any, id: string): number {
  return scope?.root?.findAll((el: any) => el.props?.id === id).length ?? 0;
}

function buttonsWithText(scope: any, text: string): any[] {
  return scope?.root?.findAll(
    (el: any) => el.type === 'button' && flatText(el) === text,
  ) ?? [];
}

function commitmentsHeader(renderer: any) {
  const h2s = renderer.root.findAll(
    (n: any) => n.type === 'h2' && flatText(n).includes('Impegni & Riunioni'),
  );
  assert.equal(h2s.length, 1, 'exactly one "Impegni & Riunioni" header');
  return h2s[0];
}

function commitmentsCount(renderer: any): number {
  const headerText = flatText(commitmentsHeader(renderer));
  // flatText joins JSX text nodes with spaces: "Impegni & Riunioni ( 0 )".
  const match = /\(\s*(\d+)\s*\)$/.exec(headerText);
  assert.ok(match, `header "${headerText}" ends with the (N) counter`);
  return Number(match[1]);
}

function selectDate(renderer: any, iso: string) {
  const picker = renderer.root.findByProps({
    id: 'today-date-picker',
    type: 'date',
  } as any) as any;
  act(() => {
    (picker.props as any).onChange({ target: { value: iso } });
  });
}

/** Superficie non interattiva: il gesto swipe parte solo da qui (come in today-day-swipe). */
const plainSurface = { closest: () => null };

async function gesture(renderer: any, dx: number, dy = 0) {
  const surface = byId(renderer, 'today-view');
  const props = surface.props as any;
  await act(async () => {
    props.onPointerDown({ pointerType: 'touch', pointerId: 9, clientX: 320, clientY: 400, target: plainSurface });
  });
  await act(async () => {
    props.onPointerUp({ pointerType: 'touch', pointerId: 9, clientX: 320 + dx, clientY: 400 + dy, target: plainSurface });
  });
}

// ---------------------------------------------------------------------------
// 1. Empty selected day -> "(0)"
// ---------------------------------------------------------------------------

test('the "Impegni & Riunioni" header shows "(0)" for an empty selected day', async () => {
  const renderer = await renderToday({ events: [] });
  assert.match(flatText(commitmentsHeader(renderer)), /^Impegni & Riunioni \( ?0 ?\)$/);
  assert.equal(commitmentsCount(renderer), 0);

  // The compact empty row survives, minus the old inline add shortcut.
  assert.match(flatText(renderer.root), /Nessun impegno oggi/);
  assert.equal(countById(renderer, 'today-empty-add-event'), 0);
});

test('the "(0)" counter also applies to a non-today empty day', async () => {
  const other = '2026-07-01';
  const renderer = await renderToday({ events: [event('2026-07-02', 'e1')] });
  selectDate(renderer, other);
  assert.equal(commitmentsCount(renderer), 0);
  assert.match(flatText(commitmentsHeader(renderer)), /^Impegni & Riunioni del giorno selezionato \( ?0 ?\)$/);
});

// ---------------------------------------------------------------------------
// 2. Correct count with events
// ---------------------------------------------------------------------------

test('the counter reflects the number of events of the selected day', async () => {
  const dayA = '2026-09-15';
  const dayB = '2026-09-16';
  const renderer = await renderToday({
    events: [
      event(dayA, 'a1'),
      // completed events are hidden by the view and must not be counted:
      event(dayA, 'a2', { completed: true }),
      event(dayB, 'b1'),
      event(dayB, 'b2'),
      event(dayB, 'b3'),
    ],
  });

  selectDate(renderer, dayA);
  assert.equal(commitmentsCount(renderer), 1, '1 event (+1 completed, excluded) on day A');

  selectDate(renderer, dayB);
  assert.equal(commitmentsCount(renderer), 3, '3 events on day B');
});

// ---------------------------------------------------------------------------
// 3. The counter reacts to every day-selection control
// ---------------------------------------------------------------------------

test('the counter follows arrows, swipe, date picker and "torna a Oggi"', async () => {
  const dayA = '2026-09-15';
  const dayB = '2026-09-16';
  const renderer = await renderToday({
    events: [event(dayA, 'a1'), event(dayB, 'b1'), event(dayB, 'b2')],
  });

  // Date picker.
  selectDate(renderer, dayA);
  assert.equal(commitmentsCount(renderer), 1);

  // Arrow "giorno successivo".
  await act(async () => {
    (byId(renderer, 'today-next-day').props as any).onClick();
  });
  assert.equal(commitmentsCount(renderer), 2, 'arrow moved to day B');

  // Arrow "giorno precedente".
  await act(async () => {
    (byId(renderer, 'today-previous-day').props as any).onClick();
  });
  assert.equal(commitmentsCount(renderer), 1, 'arrow back to day A');

  // Swipe left (next day, same logic as the forward arrow) and swipe right
  // (previous day, same logic as the back arrow) — see the swipe test suite.
  await gesture(renderer, -160, 0);
  assert.equal(commitmentsCount(renderer), 2, 'swipe left -> day B');
  await gesture(renderer, 160, 0);
  assert.equal(commitmentsCount(renderer), 1, 'swipe right -> day A');

  // "Torna a Oggi": today has no events in this fixture.
  await act(async () => {
    (byId(renderer, 'today-back-to-today').props as any).onClick();
  });
  assert.equal(commitmentsCount(renderer), 0, 'back to today -> empty count');

  // The picker still lands where the user pointed, and the counter agrees.
  selectDate(renderer, dayB);
  assert.equal(commitmentsCount(renderer), 2);
});

// ---------------------------------------------------------------------------
// 4. The old "+ Aggiungi" of the section is gone
// ---------------------------------------------------------------------------

test('the old inline "+ Aggiungi" of the Impegni & Riunioni section is gone', async () => {
  // With events (header rendered) AND with an empty day (old empty-row button):
  // neither variant may offer an add action anymore.
  const dayA = '2026-09-15';
  const renderer = await renderToday({ events: [event(dayA, 'a1')] });

  assert.equal(countById(renderer, 'today-empty-add-event'), 0, 'no empty-row add shortcut');
  assert.equal(buttonsWithText(renderer, 'Aggiungi').length, 0, 'no "+ Aggiungi" button in the view');

  selectDate(renderer, '2026-09-30'); // empty day: the old empty-row button used to appear here
  assert.equal(countById(renderer, 'today-empty-add-event'), 0);
  assert.equal(buttonsWithText(renderer, 'Aggiungi').length, 0);
  assert.match(flatText(renderer.root), /Nessun impegno/, 'the compact empty row is still shown');

  // The header is still the collapsible control, just without the add button.
  // (h2 -> inner flex div -> role="button" header row)
  const clickable = commitmentsHeader(renderer).parent.parent;
  assert.equal(clickable.props?.role, 'button', 'the header remains a collapse control');
  assert.equal(typeof clickable.props?.['aria-expanded'], 'boolean', 'the collapse state is exposed');
  assert.equal(typeof clickable.props?.onClick, 'function', 'the header is still clickable');
});

// ---------------------------------------------------------------------------
// 5. "+ Aggiungi scadenza" is gone
// ---------------------------------------------------------------------------

test('"+ Aggiungi scadenza" is no longer offered in the Oggi view', async () => {
  const renderer = await renderToday({ events: [] });
  assert.equal(countById(renderer, 'today-empty-add-deadline'), 0, 'no deadlines add shortcut');
  assert.match(flatText(renderer.root), /Nessuna scadenza oggi/, 'the compact empty row is still shown');
  assert.equal(buttonsWithText(renderer, 'Aggiungi').length, 0);
});

// ---------------------------------------------------------------------------
// 6. + 7. The FAB survives and opens the normal creation flow
// ---------------------------------------------------------------------------

test('the circular FAB is still present in the mobile bar', async () => {
  const renderer = await renderNav();
  const fab = byId(renderer, 'mobile-fab-actions');
  assert.ok(fab.props.className.includes('app-fab'), 'FAB keeps the .app-fab styling');
  assert.equal(fab.props['aria-label'], 'Azioni rapide');
});

test('the FAB opens the normal event-creation flow (callback unchanged)', async () => {
  let created = 0;
  const renderer = await renderNav({
    onOpenNewEvent: () => {
      created += 1;
    },
  });

  // Tapping the FAB opens its action sheet (no creation yet).
  await act(async () => {
    (byId(renderer, 'mobile-fab-actions').props as any).onClick();
  });
  assert.equal(created, 0, 'the FAB itself does not create events');
  assert.ok(byId(renderer, 'mobile-fab-new-event'), 'the sheet offers the normal "Nuovo Impegno"');

  // Choosing it invokes the same callback App wires to the EventModal creation.
  await act(async () => {
    (byId(renderer, 'mobile-fab-new-event').props as any).onClick();
  });
  assert.equal(created, 1, 'the FAB flow still opens the normal creation');
});

// ---------------------------------------------------------------------------
// 8. FAB color: lighter, softer green aligned with the timetable
// ---------------------------------------------------------------------------

function cssRule(selector: string): string {
  const index = css.indexOf(`${selector} {`);
  assert.ok(index >= 0, `CSS rule for "${selector}" must exist`);
  return css.slice(index, css.indexOf('}', index));
}

test('the FAB uses the lighter emerald tone of the timetable (no amber/orange)', () => {
  const rule = cssRule('.app-fab');
  assert.match(rule, /background: #059669;/, 'base tone is emerald-600, one step lighter than the old emerald-700');
  assert.match(rule, /color: #fff;/, 'the "+" stays white');
  assert.doesNotMatch(rule, /amber|orange|#f59e0b/i, 'no amber/orange tone');

  const active = cssRule('.app-fab:active');
  assert.match(active, /background: #047857;/, 'pressed state is emerald-700');

  // Size/position/safe-area contract is untouched (regression guard).
  for (const declaration of [
    'width: 56px',
    'height: 56px',
    'right: 1rem',
    'bottom: calc(5rem + env(safe-area-inset-bottom, 0px))',
    'z-index: 45',
  ]) {
    assert.ok(rule.includes(declaration), `FAB keeps ${declaration}`);
  }
});
