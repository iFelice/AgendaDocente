import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { MobileNav, MOBILE_NAV_ITEMS, MOBILE_MORE_VIEWS } from '../src/components/MobileNav';
import { Navbar } from '../src/components/Navbar';
import { TodayView } from '../src/components/TodayView';
import { DeadlinesView } from '../src/components/DeadlinesView';
import type { TeacherProfile, TimetableSlot, ViewMode } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Minimal browser globals: these are pure component/structure tests (no jsdom), but a
 * couple of components touch `window`/`document` inside effects (PWA install, the
 * "Altro" sheet keyboard handling). The listeners are captured so the tests can fire
 * a real Escape keypress.
 */
const keydownListeners: ((event: { key: string }) => void)[] = [];
const windowStub = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: 'node' },
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as any).window = windowStub;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../src/index.css'), 'utf8');
const appSource = readFileSync(resolve(here, '../src/App.tsx'), 'utf8');

function classes(instance: any): string[] {
  return String(instance?.props?.className ?? '').split(' ').filter(Boolean);
}

function hasClass(instance: any, token: string): boolean {
  return classes(instance).includes(token);
}

/** Text content of a rendered subtree (react-test-renderer's toString() is shallow). */
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

function byId(scope: any, id: string) {
  const root = scope?.root ?? scope;
  const found = root.findAll((el: any) => el.props?.id === id);
  assert.ok(found.length > 0, `element with id "${id}" must exist`);
  return found[0];
}

/** Flat, whitespace-normalised text of a subtree (JSX splits text across nodes). */
function flatText(node: any): string {
  return nodeText(node).replace(/\s+/g, ' ').trim();
}

function ancestorWithClass(instance: any, ...tokens: string[]) {
  let current = instance.parent;
  while (current) {
    if (tokens.every((token) => hasClass(current, token))) return current;
    current = current.parent;
  }
  return null;
}

/** Body of a CSS rule, e.g. `.bottom-nav-item`. */
function cssRule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `CSS rule "${selector}" is missing`);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

/** Body of a block (media query or nested rule) starting at `opener`. */
function cssBlock(opener: string): string {
  const start = css.indexOf(opener);
  assert.ok(start >= 0, `CSS block "${opener}" is missing`);
  let depth = 0;
  let i = css.indexOf('{', start);
  const bodyStart = i + 1;
  for (; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return css.slice(bodyStart, i);
}

async function render(element: React.ReactElement) {
  let renderer: any;
  await act(async () => {
    renderer = create(element);
  });
  return renderer;
}

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

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
    stats: { todayEventsCount: 2, pendingDeadlinesCount: 3 },
    ...overrides,
  };
}

function navbarProps(overrides: Partial<React.ComponentProps<typeof Navbar>> = {}) {
  return {
    currentView: 'oggi' as ViewMode,
    onViewChange: () => {},
    profile,
    onOpenCircularModal: () => {},
    onOpenNewEventModal: () => {},
    onOpenProfileModal: () => {},
    onOpenTutorial: () => {},
    googleUser: null,
    onOpenGoogleLogin: async () => null,
    onOpenGoogleTab: () => {},
    stats: { todayEventsCount: 2, pendingDeadlinesCount: 3 },
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

// ---------------------------------------------------------------------------
// 1. Bottom navigation: mobile only, 5 destinations, safe-area aware
// ---------------------------------------------------------------------------

test('bottom navigation exists only below 1280px (phones and tablets) and lists the five main destinations', async () => {
  const renderer = await render(React.createElement(MobileNav, navProps()));

  // The whole component (bar + FAB + sheet) is hidden from desktop (1280px) up;
  // phones AND tablets — portrait AND landscape — get the bottom bar with the
  // floating "+".
  const wrapper = renderer.root.findAll((el: any) => el.type === 'div' && hasClass(el, 'xl:hidden'));
  assert.ok(wrapper.length >= 1, 'the bottom navigation is wrapped in a xl:hidden container');
  assert.ok(!hasClass(wrapper[0], 'lg:hidden'), 'tablet landscape (1024-1279px) is NOT desktop: no lg cut');
  assert.ok(!hasClass(wrapper[0], 'md:hidden'), 'the mobile experience is no longer cut at 768px: tablets are included');

  const nav = renderer.root.findByType('nav');
  assert.ok(hasClass(nav, 'bottom-nav'), 'the bar uses the fixed .bottom-nav layout');
  assert.equal(nav.props['aria-label'], 'Navigazione principale');

  const items = renderer.root.findAll((el: any) => hasClass(el, 'bottom-nav-item'));
  assert.equal(items.length, 5, 'exactly five destinations');
  assert.deepEqual(
    MOBILE_NAV_ITEMS.map((item) => item.id),
    ['oggi', 'settimana', 'mese', 'scadenze', 'altro'],
  );

  const labels = items.map((item: any) =>
    item.findAll((el: any) => hasClass(el, 'bottom-nav-label')).map((l: any) => nodeText(l)).join('')
  );
  assert.deepEqual(labels, ['Oggi', 'Settimana', 'Mese', 'Scadenze', 'Altro']);

  // No horizontal overflow: equal flexible items whose labels truncate.
  const navRule = cssRule('.bottom-nav-item');
  assert.match(navRule, /min-width: 0;/, 'items can shrink below their content width');
  const labelRule = cssRule('.bottom-nav-label');
  assert.match(labelRule, /overflow: hidden;/);
  assert.match(labelRule, /text-overflow: ellipsis;/);
});

test('bottom navigation is fixed, safe-area aware and uses >= 44px touch targets', () => {
  const bar = cssRule('.bottom-nav');
  assert.match(bar, /position: fixed;/);
  assert.match(bar, /bottom: 0;/);
  assert.match(bar, /env\(safe-area-inset-bottom, 0px\)/, 'the bar clears the home indicator');

  const item = cssRule('.bottom-nav-item');
  const minHeight = Number(/min-height: (\d+)px;/.exec(item)?.[1]);
  assert.ok(minHeight >= 44, `touch targets are at least 44px (found ${minHeight}px)`);
});

test('the active destination is unambiguous and follows the current view', async () => {
  const renderer = await render(React.createElement(MobileNav, navProps({ currentView: 'scadenze' })));
  const active = renderer.root.findAll((el: any) => hasClass(el, 'bottom-nav-item') && el.props['aria-current'] === 'page');
  assert.equal(active.length, 1, 'exactly one active destination');
  assert.equal(active[0].props.id, 'mobile-nav-scadenze');
  assert.match(cssRule('.bottom-nav-item[aria-current="page"]'), /background: #047857;/, 'filled emerald pill');

  // Pending deadlines are visible on the "Scadenze" entry.
  assert.match(nodeText(byId(renderer, 'mobile-nav-scadenze')), /3/);
});

test('tapping a destination switches the view', async () => {
  const calls: ViewMode[] = [];
  const renderer = await render(React.createElement(MobileNav, navProps({ onViewChange: (view: ViewMode) => calls.push(view) })));
  await act(async () => { byId(renderer, 'mobile-nav-mese').props.onClick(); });
  await act(async () => { byId(renderer, 'mobile-nav-settimana').props.onClick(); });
  assert.deepEqual(calls, ['mese', 'settimana']);
});

test('the primary "+" action is a floating button that opens the quick-actions sheet', async () => {
  let newEvent = 0;
  let scanner = 0;
  const renderer = await render(React.createElement(MobileNav, navProps({
    onOpenNewEvent: () => { newEvent += 1; },
    onOpenScanner: () => { scanner += 1; },
  })));
  const fab = byId(renderer, 'mobile-fab-actions');
  assert.ok(hasClass(fab, 'app-fab'));
  assert.equal(fab.props['aria-label'], 'Azioni rapide');
  assert.equal(fab.props['aria-haspopup'], 'menu');
  assert.equal(fab.props['aria-expanded'], false);

  // Closed by default: no quick-actions menu rendered.
  assert.equal(renderer.root.findAll((el: any) => el.props?.role === 'menu').length, 0);

  await act(async () => { fab.props.onClick(); });
  assert.equal(byId(renderer, 'mobile-fab-actions').props['aria-expanded'], true);
  const menu = renderer.root.findByProps({ role: 'menu' });
  assert.equal(menu.props['aria-label'], 'Azioni rapide');
  // The two quick actions are reachable: new commitment AND document scan.
  const menuText = flatText(menu);
  assert.ok(menuText.includes('Nuovo impegno'), 'quick action "Nuovo impegno"');
  assert.ok(menuText.includes('Scansiona documento'), 'quick action "Scansiona documento"');

  await act(async () => { byId(renderer, 'mobile-fab-scan-document').props.onClick(); });
  assert.equal(scanner, 1, 'tapping "Scansiona documento" opens the unified flow');
  assert.equal(renderer.root.findAll((el: any) => el.props?.role === 'menu').length, 0, 'the menu closes after a choice');

  await act(async () => { byId(renderer, 'mobile-fab-actions').props.onClick(); });
  await act(async () => { byId(renderer, 'mobile-fab-new-event').props.onClick(); });
  assert.equal(newEvent, 1, 'tapping "Nuovo impegno" still opens the event form');

  const fabRule = cssRule('.app-fab');
  assert.match(fabRule, /position: fixed;/);
  assert.match(fabRule, /bottom: calc\(5rem \+ env\(safe-area-inset-bottom, 0px\)\)/, 'parked above the bottom bar');
  assert.match(fabRule, /height: 56px;/);

  // The quick-actions sheet is anchored above the FAB and keeps >= 44px targets.
  const sheetRule = cssRule('.quick-actions-sheet');
  assert.match(sheetRule, /position: fixed;/);
  assert.match(sheetRule, /bottom: calc\(9rem \+ env\(safe-area-inset-bottom, 0px\)\)/, 'anchored above the floating button');
  const itemRule = cssRule('.quick-actions-item');
  const minHeight = Number(/min-height: (\d+)px;/.exec(itemRule)?.[1]);
  assert.ok(minHeight >= 44, `quick actions keep >= 44px touch targets (found ${minHeight}px)`);
});

// ---------------------------------------------------------------------------
// 2. The "Altro" sheet
// ---------------------------------------------------------------------------

test('"Altro" opens an accessible sheet with the secondary destinations', async () => {
  const calls: ViewMode[] = [];
  const renderer = await render(React.createElement(MobileNav, navProps({ onViewChange: (view: ViewMode) => calls.push(view) })));

  const altro = byId(renderer, 'mobile-nav-altro');
  assert.equal(altro.props['aria-haspopup'], 'dialog');
  assert.equal(altro.props['aria-expanded'], false);
  assert.equal(renderer.root.findAll((el: any) => el.props?.role === 'dialog').length, 0, 'closed by default');

  await act(async () => { altro.props.onClick(); });

  const dialog = renderer.root.findByProps({ role: 'dialog' });
  assert.equal(dialog.props['aria-modal'], 'true');
  assert.equal(dialog.props['aria-label'], 'Altre funzioni');
  assert.ok(hasClass(dialog, 'more-sheet'));
  assert.match(cssRule('.more-sheet'), /env\(safe-area-inset-bottom, 0px\)/, 'the sheet respects the safe area');
  assert.equal(byId(renderer, 'mobile-nav-altro').props['aria-expanded'], true);

  const sheetText = flatText(dialog);
  for (const label of ['Orario Lezioni', 'Classi & Alunni', 'Archivio Circolari', 'Analizza Circolare', 'Profilo / Impostazioni', 'Accedi con Google', 'Guida rapida', 'Installa App']) {
    assert.ok(sheetText.includes(label), `"${label}" must be reachable from Altro`);
  }
  assert.deepEqual(MOBILE_MORE_VIEWS.map((item) => item.id), ['orario', 'classi', 'registro', 'circolari']);

  // Choosing a destination closes the sheet and navigates.
  await act(async () => { byId(renderer, 'mobile-more-orario').props.onClick(); });
  assert.deepEqual(calls, ['orario']);
  assert.equal(renderer.root.findAll((el: any) => el.props?.role === 'dialog').length, 0, 'the sheet closes after a choice');
});

test('"Altro" closes with Escape and is the active destination while its sections are open', async () => {
  keydownListeners.length = 0;
  const renderer = await render(React.createElement(MobileNav, navProps({ currentView: 'classi' })));

  const altro = byId(renderer, 'mobile-nav-altro');
  assert.equal(altro.props['aria-current'], 'page', '"Altro" is marked active while a secondary section is open');
  assert.ok(!byId(renderer, 'mobile-nav-oggi').props['aria-current'], 'no primary destination is active');

  await act(async () => { altro.props.onClick(); });
  assert.ok(keydownListeners.length > 0, 'the sheet listens for Escape');
  await act(async () => { keydownListeners.forEach((listener) => listener({ key: 'Escape' })); });
  assert.equal(renderer.root.findAll((el: any) => el.props?.role === 'dialog').length, 0, 'Escape closes the sheet');
  assert.equal(keydownListeners.length, 0, 'the listener is released when the sheet closes');
});

test('"Altro" exposes profile, Google account and the circular analyzer', async () => {
  let profileOpened = 0;
  let googleOpened = 0;
  let circularOpened = 0;
  const renderer = await render(React.createElement(MobileNav, navProps({
    googleUser: { email: 'docente@icdavinci.edu.it' },
    onOpenProfileModal: () => { profileOpened += 1; },
    onOpenGoogleTab: () => { googleOpened += 1; },
    onOpenCircularModal: () => { circularOpened += 1; },
  })));

  await act(async () => { byId(renderer, 'mobile-nav-altro').props.onClick(); });
  assert.match(nodeText(byId(renderer, 'mobile-more-google')), /docente@icdavinci\.edu\.it/);

  await act(async () => { byId(renderer, 'mobile-more-profile').props.onClick(); });
  await act(async () => { byId(renderer, 'mobile-nav-altro').props.onClick(); });
  await act(async () => { byId(renderer, 'mobile-more-google').props.onClick(); });
  await act(async () => { byId(renderer, 'mobile-nav-altro').props.onClick(); });
  await act(async () => { byId(renderer, 'mobile-more-circular-analyzer').props.onClick(); });

  assert.deepEqual([profileOpened, googleOpened, circularOpened], [1, 1, 1]);
});

// ---------------------------------------------------------------------------
// 3. Phone header: brand + profile only (no second tab bar, no secondary actions)
// ---------------------------------------------------------------------------

test('on phones the header keeps only brand and profile', async () => {
  const renderer = await render(React.createElement(Navbar, navbarProps()));

  // The old second bar (horizontal tab strip) is not rendered below 768px.
  const tabNav = renderer.root.findByProps({ 'aria-label': "Sezioni dell'agenda" });
  const hiddenWrapper = ancestorWithClass(tabNav, 'hidden', 'md:block');
  assert.ok(hiddenWrapper, 'the header tab strip is desktop/tablet only');

  // Secondary actions: PWA install, circolare AI and Google stay tablet/desktop
  // only (from 768px, unchanged).
  for (const id of ['btn-scan-circular', 'btn-google-login-nav']) {
    const button = byId(renderer, id);
    assert.ok(hasClass(button, 'hidden') && hasClass(button, 'md:inline-flex'), `${id} is hidden on phones`);
  }
  // The two creation CTAs moved to the desktop-only tier (from 1280px): on
  // phones AND tablets the primary action is the MobileNav FAB.
  const withScanner = await render(React.createElement(Navbar, navbarProps({ onOpenScanner: () => {} })));
  for (const id of ['btn-new-event', 'btn-scan-document']) {
    const button = byId(withScanner, id);
    assert.ok(hasClass(button, 'hidden') && hasClass(button, 'xl:inline-flex'), `${id} is hidden on phones and tablets`);
    assert.ok(!hasClass(button, 'md:inline-flex') && !hasClass(button, 'lg:inline-flex'), `${id} no longer appears on tablets (md nor lg)`);
  }
  // Google status chip (rendered when an account is connected) is desktop only too.
  const connected = await render(React.createElement(Navbar, navbarProps({
    googleUser: { email: 'docente@icdavinci.edu.it', uid: 'u1', displayName: 'Andrea Conti' } as any,
  })));
  assert.ok(hasClass(byId(connected, 'btn-google-status'), 'hidden'));

  // PWA install moved to "Altro": hidden on phones.
  const pwaWrapper = renderer.root.findAll((el: any) => el.type === 'span' && hasClass(el, 'hidden') && hasClass(el, 'md:inline-flex'));
  assert.ok(pwaWrapper.length >= 1, 'the PWA install button is desktop only');

  // Still reachable on phones: brand and the profile action (>= 44px).
  assert.match(flatText(renderer.root), /Agenda Docente/);
  const profileButton = byId(renderer, 'btn-open-profile');
  assert.ok(!hasClass(profileButton, 'hidden'));
  assert.ok(classes(profileButton).includes('w-[44px]') && classes(profileButton).includes('h-[44px]'));
});

test('PWA bell is always present, exposes the correct state and keeps Account independent', async () => {
  let checked = 0;
  const absent = await render(React.createElement(Navbar, navbarProps({ updateAvailable: false, onCheckUpdates: () => { checked++; } })));
  const noUpdateBell = byId(absent, 'btn-pwa-update');
  assert.equal(noUpdateBell.props['aria-label'], 'Controlla aggiornamenti');
  assert.equal(noUpdateBell.findAll((el: any) => el.type === 'span' && el.props?.className?.includes('bg-amber-500')).length, 0);
  assert.ok(noUpdateBell.props.className.includes('w-[44px]') && noUpdateBell.props.className.includes('h-[44px]'));
  await act(async () => { noUpdateBell.props.onClick(); });
  assert.equal(checked, 1);

  let opened = 0;
  const available = await render(React.createElement(Navbar, navbarProps({ updateAvailable: true, onOpenUpdatePrompt: () => { opened++; } })));
  const bell = byId(available, 'btn-pwa-update');
  assert.equal(bell.props['aria-label'], 'Aggiornamento disponibile');
  assert.equal(bell.findAll((el: any) => el.type === 'span' && el.props?.className?.includes('bg-amber-500')).length, 1);
  await act(async () => { bell.props.onClick(); });
  assert.equal(opened, 1);
  assert.equal(available.root.findAll((el: any) => el.type === 'button' && el.props['aria-label'] === 'Profilo e Impostazioni').length, 1);
});

test('desktop navigation is unchanged: every section stays in the header tabs', async () => {
  const renderer = await render(React.createElement(Navbar, navbarProps({ currentView: 'orario', onOpenScanner: () => {} })));
  const expected: [string, string][] = [
    ['nav-tab-oggi', 'Oggi'],
    ['nav-tab-settimana', 'Settimana'],
    ['nav-tab-mese', 'Mese'],
    ['nav-tab-scadenze', 'Scadenze & PEI'],
    ['nav-tab-classi', 'Classi & Alunni'],
    ['nav-tab-registro', 'Registro'],
    ['nav-tab-orario', 'Orario Lezioni'],
    ['nav-tab-circolari', 'Archivio Circolari'],
  ];
  for (const [id, label] of expected) {
    const tab = byId(renderer, id);
    assert.ok(nodeText(tab).includes(label), `${id} keeps its label`);
  }
  assert.equal(byId(renderer, 'nav-tab-orario').props['aria-current'], 'page');
  // The desktop action row is intact (creation CTAs visible from 1280px up).
  assert.ok(hasClass(byId(renderer, 'btn-new-event'), 'xl:inline-flex'));
  const circularCta = byId(renderer, 'btn-scan-circular');
  assert.ok(hasClass(circularCta, 'md:inline-flex'));
  assert.ok(!String(circularCta.props.className).includes('bg-amber-500'), 'circular action is not a temporal warning surface');
  assert.ok(!String(circularCta.props.className).includes('bg-emerald-700'), 'circular action remains neutral');
  assert.ok(circularCta.findAll((el: any) => el.type === 'svg' && String(el.props.className).includes('text-orange-500')).length >= 1, 'circular action keeps its orange icon accent');

  const scannerCta = byId(renderer, 'btn-scan-document');
  assert.ok(!String(scannerCta.props.className).includes('bg-emerald-700'), 'scanner action is not a green status surface');
  assert.ok(String(scannerCta.props.className).includes('bg-white'));
  assert.ok(scannerCta.findAll((el: any) => el.type === 'svg' && String(el.props.className).includes('text-sky-600')).length >= 1);

  const newEventCta = byId(renderer, 'btn-new-event');
  assert.ok(!String(newEventCta.props.className).includes('bg-emerald-700'), 'new event action is not a green status surface');
  assert.ok(String(newEventCta.props.className).includes('bg-white'));
  assert.ok(newEventCta.findAll((el: any) => el.type === 'svg' && String(el.props.className).includes('text-sky-600')).length >= 1);
});

// ---------------------------------------------------------------------------
// 4. Space for the bottom navigation (views, toast, modals)
// ---------------------------------------------------------------------------

test('main views and fixed overlays reserve space for the bottom navigation', () => {
  // The app shell mounts the mobile navigation and pads the main container.
  assert.match(appSource, /<MobileNav/);
  assert.match(appSource, /<main className="app-main /);

  const mainRule = cssRule('.app-main');
  assert.match(mainRule, /padding-bottom: 1\.5rem;/, 'desktop keeps the previous bottom padding');

  const mobileBlock = cssBlock('@media (max-width: 767.98px) {\n  .app-main');
  // 8rem clears the 68px bar plus the floating "+" parked above it.
  assert.match(mobileBlock, /padding-bottom: calc\(8rem \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(mobileBlock, /\.app-toast/, 'toasts clear the bottom bar on phones');
  assert.match(mobileBlock, /\.app-update-banner/);
  // Overlays sit above the floating "+" (bottom 5rem + 56px tall).
  assert.match(mobileBlock, /bottom: calc\(9rem \+ env\(safe-area-inset-bottom, 0px\)\)/);

  // Modal sheets already account for the safe area (no regression).
  assert.match(cssRule('.modal-sticky-footer'), /env\(safe-area-inset-bottom, 0px\)/);
  const sheetBlock = cssBlock('@media (max-width: 639.98px)');
  assert.match(sheetBlock, /env\(safe-area-inset-top, 0px\)/);
});

// ---------------------------------------------------------------------------
// 5. Oggi: lessons immediately, no duplicated CTAs, compact empty states
// ---------------------------------------------------------------------------

test('the day overview is compact on phones so lessons appear immediately', async () => {
  const renderer = await render(React.createElement(TodayView, todayProps()));

  // Compact card + 44px day navigation (previous / today / next).
  const dayNav = renderer.root.findByProps({ role: 'group', 'aria-label': 'Navigazione del giorno' });
  const buttons = dayNav.findAll((el: any) => el.type === 'button');
  assert.equal(buttons.length, 3);
  for (const button of buttons) assert.ok(hasClass(button, 'min-h-[44px]'));
  assert.ok(renderer.root.findAll((el: any) => el.type === 'div' && hasClass(el, 'p-3') && hasClass(el, 'sm:p-5')).length >= 1,
    'the overview card uses reduced phone padding');

  // The inline quick-add is gone (the FAB is the only quick-add point in the view;
  // on desktop the global "Nuovo Impegno" in the navbar covers it). Only the
  // circular-import shortcut remains, and it is desktop-only.
  assert.equal(renderer.root.findAll((el: any) => el.props?.id === 'today-quick-add').length, 0,
    'the inline "Aggiungi" quick action is removed');
  assert.ok(ancestorWithClass(byId(renderer, 'today-quick-scan'), 'hidden', 'md:flex'),
    'the circular-import shortcut is hidden on phones');
});

test('empty mobile sections are compact rows, not big empty cards', async () => {
  const renderer = await render(React.createElement(TodayView, todayProps()));
  const text = flatText(renderer.root);

  // "Impegni & Riunioni" keeps a compact empty row, WITHOUT the old inline add action:
  // the section header now carries the count and the FAB is the only quick-add point.
  assert.match(text, /Nessun impegno oggi/);
  assert.match(text, /Impegni & Riunioni \( ?0 ?\)/, 'the header shows the empty count');
  assert.equal(renderer.root.findAll((el: any) => el.props?.id === 'today-empty-add-event').length, 0,
    'the inline "+ Aggiungi" of the section is removed');

  // Same for "Scadenze": compact row, no inline add shortcut.
  assert.match(text, /Nessuna scadenza oggi/);
  assert.equal(renderer.root.findAll((el: any) => el.props?.id === 'today-empty-add-deadline').length, 0,
    'the "Aggiungi scadenza" shortcut is removed');
  assert.ok(!text.includes('Nessuna scadenza in sospeso per questa data. Ottimo lavoro!'));

  // The standalone Scadenze view behaves the same way.
  const deadlines = await render(React.createElement(DeadlinesView, {
    events: [],
    onOpenNewEvent: () => {},
    onEditEvent: () => {},
    onDeleteEvent: () => {},
    onToggleComplete: () => {},
  }));
  const deadlinesText = nodeText(deadlines.root);
  assert.match(deadlinesText, /Nessuna scadenza in questa sezione/);
  assert.ok(!deadlinesText.includes('Nessuna scadenza trovata in questa sezione.'));
});

test('the provisional timetable notice is a compact row with a completion link', async () => {
  let timetableOpened = 0;
  const renderer = await render(React.createElement(TodayView, todayProps({
    timetable: [{ id: 's1', dayOfWeek: 1, periodNumber: 1, startTime: '07:50', endTime: '08:50', subject: 'Sostegno', className: '2E' }],
    isProvisionalTimetable: true,
    isDefinitiveCompiled: false,
    onNavigateToTimetable: () => { timetableOpened += 1; },
  })));
  const text = flatText(renderer.root);

  assert.match(text, /Orario provvisorio attivo/, 'short label on phones');
  assert.ok(byId(renderer, 'today-complete-timetable'), 'the link to complete the timetable stays reachable');
  assert.match(nodeText(byId(renderer, 'today-complete-timetable')), /Completa orario/);
  // The badge next to the section title is condensed too.
  assert.match(text, /Provvisorio/);

  await act(async () => { byId(renderer, 'today-complete-timetable').props.onClick(); });
  assert.equal(timetableOpened, 1, 'the link opens the timetable editor');
});
// ---------------------------------------------------------------------------
// 5. FAB "+" su smartphone E tablet (< 1024px); le due CTA di creazione solo desktop
// ---------------------------------------------------------------------------

test('FAB tablet: un solo FAB "+" (xl:hidden), CTA di creazione solo da xl, nessuna duplicazione dei flussi', async () => {
  // Statico: esiste UN SOLO FAB nell'app e sta in MobileNav; nessun secondo
  // FAB (ne' in Navbar ne' nei modal, che questo micro-step non tocca).
  const srcOf = (rel: string) => readFileSync(resolve(here, rel), 'utf8');
  const mobileNavSource = srcOf('../src/components/MobileNav.tsx');
  assert.equal((mobileNavSource.match(/className="app-fab"/g) ?? []).length, 1, 'una sola occorrenza di className="app-fab" in MobileNav');
  for (const other of ['../src/components/Navbar.tsx', '../src/components/EventModal.tsx', '../src/components/TimetableEditor.tsx', '../src/components/TodayView.tsx', '../src/App.tsx']) {
    assert.ok(!srcOf(other).includes('app-fab'), `nessun FAB duplicato in ${other}`);
  }

  // Renderizzato: un solo bottone FAB, wrapper lg:hidden (non piu md:hidden):
  // la stessa esperienza smartphone copre anche i tablet.
  const nav = await render(React.createElement(MobileNav, navProps()));
  const fabs = nav.root.findAll((el: any) => el.type === 'button' && hasClass(el, 'app-fab'));
  assert.equal(fabs.length, 1, 'un solo bottone FAB');
  assert.equal(byId(nav, 'mobile-fab-actions').props.id, 'mobile-fab-actions');
  const wrapper = nav.root.findAll((el: any) => el.type === 'div' && hasClass(el, 'xl:hidden'));
  assert.equal(wrapper.length, 1);
  assert.ok(!hasClass(wrapper[0], 'lg:hidden') && !hasClass(wrapper[0], 'md:hidden'), 'nessuna classe lg/md residua sul wrapper (combinazione contraddittoria assente)');

  // Il tap sul FAB apre le STESSHE azioni di sempre, ciascuna una sola volta.
  let newEventFromFab = 0;
  let scanFromFab = 0;
  const navWithSpies = await render(React.createElement(MobileNav, navProps({
    onOpenNewEvent: () => { newEventFromFab += 1; },
    onOpenScanner: () => { scanFromFab += 1; },
  })));
  await act(async () => { byId(navWithSpies, 'mobile-fab-actions').props.onClick(); });
  assert.equal(navWithSpies.root.findAll((el: any) => el.type === 'button' && el.props.id === 'mobile-fab-new-event').length, 1, 'azione "Nuovo impegno" non duplicata nel menu FAB');
  assert.equal(navWithSpies.root.findAll((el: any) => el.type === 'button' && el.props.id === 'mobile-fab-scan-document').length, 1, 'azione "Scansiona documento" non duplicata nel menu FAB');
  // Ogni azione chiude il menu: si riapre il FAB fra le due verifiche.
  await act(async () => { byId(navWithSpies, 'mobile-fab-scan-document').props.onClick(); });
  assert.equal(scanFromFab, 1, 'il FAB continua ad aprire il flusso Scansiona Documento');
  await act(async () => { byId(navWithSpies, 'mobile-fab-actions').props.onClick(); });
  await act(async () => { byId(navWithSpies, 'mobile-fab-new-event').props.onClick(); });
  assert.equal(newEventFromFab, 1, 'il FAB continua ad aprire il flusso Nuovo Impegno');

  // Navbar: le due CTA di creazione compaiono solo da lg (desktop), una volta
  // ciascuna, e continuano ad aprire gli stessi flussi del FAB.
  let newEventFromCta = 0;
  let scanFromCta = 0;
  const bar = await render(React.createElement(Navbar, navbarProps({
    onOpenNewEventModal: () => { newEventFromCta += 1; },
    onOpenScanner: () => { scanFromCta += 1; },
  })));
  for (const id of ['btn-new-event', 'btn-scan-document']) {
    const button = byId(bar, id);
    assert.ok(hasClass(button, 'hidden') && hasClass(button, 'xl:inline-flex'), `${id} visibile solo da xl (1280px)`);
    assert.ok(!hasClass(button, 'md:inline-flex') && !hasClass(button, 'lg:inline-flex'), `${id} non compare su smartphone ne tablet (md/lg)`);
  }
  assert.equal(bar.root.findAll((el: any) => el.type === 'button' && el.props.id === 'btn-new-event').length, 1, 'CTA Nuovo Impegno non duplicata');
  assert.equal(bar.root.findAll((el: any) => el.type === 'button' && el.props.id === 'btn-scan-document').length, 1, 'CTA Scansiona Documento non duplicata');
  await act(async () => { byId(bar, 'btn-new-event').props.onClick(); });
  await act(async () => { byId(bar, 'btn-scan-document').props.onClick(); });
  assert.equal(newEventFromCta, 1, '"Nuovo Impegno" continua ad aprire lo stesso flusso');
  assert.equal(scanFromCta, 1, '"Scansiona Documento" continua ad aprire lo stesso flusso');

  // EventModal e TimetableEditor restano fuori da questo micro-step: nessuna
  // classe responsive di visibilita FAB/CTA introdotta nei due modal.
  assert.ok(!srcOf('../src/components/EventModal.tsx').includes('lg:inline-flex'), 'EventModal non toccato');
  assert.ok(!srcOf('../src/components/TimetableEditor.tsx').includes('lg:inline-flex'), 'TimetableEditor non toccato');
});

// ---------------------------------------------------------------------------
// 6. Tabella breakpoint: esperienza mobile (FAB) fino a 1279px, desktop da 1280px
// ---------------------------------------------------------------------------

test('tabella breakpoint: FAB e bottom nav sotto 1280px (767/820/834/1024/1194/1279), CTA solo da 1280px', async () => {
  // Semantica Tailwind usata: `xl:hidden` = display:none SOLO da 1280px;
  // `hidden` + `xl:inline-flex` = nascosto di default, visibile SOLO da 1280px.
  // Tabella dei viewport reali verificati sul device (portrait e landscape):
  //   767px (smartphone)     -> MobileNav/FAB SI, CTA NO
  //   820px (iPad Air p.)    -> MobileNav/FAB SI, CTA NO
  //   834px (iPad Pro p.)    -> MobileNav/FAB SI, CTA NO
  //  1024px (iPad 9.7 l.)    -> MobileNav/FAB SI, CTA NO
  //  1194px (iPad Pro 11 l.) -> MobileNav/FAB SI, CTA NO
  //  1279px (limite)         -> MobileNav/FAB SI, CTA NO
  //  1280px (desktop)        -> MobileNav/FAB NO, CTA SI
  const viewportTable: [number, boolean][] = [
    [767, true], [820, true], [834, true], [1024, true], [1194, true], [1279, true], [1280, false],
  ];
  for (const [vw, expectMobileExperience] of viewportTable) {
    assert.equal(expectMobileExperience, vw < 1280, `soglia coerente a ${vw}px: mobile sotto 1280, desktop da 1280`);
  }

  // Il codice implementa ESATTAMENTE quella tabella: un solo interruttore per
  // l'esperienza mobile (xl:hidden, nessun residuo md/lg) e CTA che nascono
  // nascoste e riappaiono solo con xl (1280px).
  const nav = await render(React.createElement(MobileNav, navProps()));
  const wrapper = nav.root.find((el: any) => el.type === 'div' && hasClass(el, 'xl:hidden'));
  assert.ok(wrapper, 'MobileNav avvolto in xl:hidden');
  assert.ok(!hasClass(wrapper, 'lg:hidden') && !hasClass(wrapper, 'md:hidden'),
    'nessun residuo md/lg: nessuna finestra 768-1279px senza FAB/bottom nav (UI ibrida assente)');

  const bar = await render(React.createElement(Navbar, navbarProps({ onOpenScanner: () => {} })));
  for (const id of ['btn-new-event', 'btn-scan-document']) {
    const button = byId(bar, id);
    assert.ok(hasClass(button, 'hidden') && hasClass(button, 'xl:inline-flex'), `${id}: nascosto di default, visibile solo da 1280px`);
    assert.ok(!hasClass(button, 'lg:inline-flex') && !hasClass(button, 'md:inline-flex'),
      `${id}: nessuna ri-comparsa fra 768 e 1279px => mai FAB+CTA contemporaneamente`);
  }

  // Geometria/colore/safe-area del FAB: nessuna modifica (regole CSS intatte).
  const fabCss = css.slice(css.indexOf('.app-fab {'), css.indexOf('}', css.indexOf('.app-fab {')));
  for (const decl of ['position: fixed', 'width: 56px', 'height: 56px', 'bottom: calc(5rem + env(safe-area-inset-bottom, 0px))']) {
    assert.ok(fabCss.includes(decl), `regola .app-fab invariata: ${decl}`);
  }
  assert.ok(!css.includes('@media') || !fabCss.includes('@media'), '.app-fab non e dentro media query: nessun breakpoint ne cambia geometria');
});
