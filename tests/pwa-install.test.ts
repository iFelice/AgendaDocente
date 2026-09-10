import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { PWAInstallButton, PWAInstallRow } from '../src/components/PWAInstallButton';
import { MobileNav } from '../src/components/MobileNav';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * "Installa App" from the mobile "Altro" menu:
 *   - the whole row is the action (never a dead label): a tap always gives
 *     feedback — real install prompt, iOS/manual guide, or installed state;
 *   - beforeinstallprompt accepted/dismissed are handled without reload and
 *     the spent event is never reused (even across co-mounted instances);
 *   - iOS without a programmable prompt gets the 3-step guide;
 *   - standalone shows "App già installata", never an installable-looking button;
 *   - unsupported browsers get a visible explanation instead of silence.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';
const SAFARI_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

interface FakeWindowOpts {
  userAgent: string;
  standalone?: boolean;
  navigatorStandalone?: boolean;
  platform?: string;
  maxTouchPoints?: number;
}

function installFakeWindow(opts: FakeWindowOpts): any {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const fake: any = {
    navigator: {
      userAgent: opts.userAgent,
      platform: opts.platform ?? '',
      maxTouchPoints: opts.maxTouchPoints ?? 0,
      ...(opts.navigatorStandalone === undefined ? {} : { standalone: opts.navigatorStandalone }),
    },
    matchMedia: (query: string) => ({
      matches: query.includes('standalone') ? !!opts.standalone : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
    addEventListener: (type: string, fn: (e: any) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: any) => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event: any) => {
      listeners.get(event.type)?.forEach((fn) => fn(event));
      return true;
    },
  };
  (globalThis as any).window = fake;
  return fake;
}

function useFakeWindow(t: any, opts: FakeWindowOpts): any {
  const fake = installFakeWindow(opts);
  t.after(() => { delete (globalThis as any).window; });
  return fake;
}

function fakePromptEvent(outcome: 'accepted' | 'dismissed', spy: { calls: number }) {
  return {
    type: 'beforeinstallprompt',
    defaultPrevented: false,
    preventDefault(this: any) { this.defaultPrevented = true; },
    prompt: async () => { spy.calls++; },
    userChoice: Promise.resolve({ outcome, platform: 'test' }),
  };
}

async function mount(element: React.ReactElement) {
  let renderer: any;
  await act(async () => {
    renderer = create(element);
  });
  return renderer;
}

async function fireBIP(fake: any, event: any) {
  await act(async () => { fake.dispatchEvent(event); });
}

/** Click + flush the short fake-promise chains (prompt()/userChoice). */
async function click(button: any) {
  await act(async () => {
    button.props.onClick();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
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

function byId(renderer: any, id: string) {
  const found = renderer.root.findAll((el: any) => el.props?.id === id);
  assert.ok(found.length > 0, `element with id "${id}" must exist`);
  return found[0];
}

function buttonByText(renderer: any, text: string) {
  const found = renderer.root.findAllByType('button').find((b: any) => flatText(b) === text);
  assert.ok(found, `button "${text}" must exist`);
  return found;
}

function altroDialog(renderer: any) {
  return renderer.root.findAll((el: any) => el.props?.role === 'dialog' && el.props?.['aria-label'] === 'Altre funzioni');
}

// ---------------------------------------------------------------------------
// beforeinstallprompt: prompt() called, accepted / dismissed
// ---------------------------------------------------------------------------

test('installable row: tap calls the real prompt(), accepted shows success + installed state', async (t) => {
  const fake = useFakeWindow(t, { userAgent: CHROME_UA });
  const spy = { calls: 0 };
  const renderer = await mount(React.createElement(PWAInstallRow));

  await fireBIP(fake, fakePromptEvent('accepted', spy));
  const row = byId(renderer, 'mobile-more-install');
  assert.equal(row.type, 'button', 'the row itself is the action');
  assert.equal(row.props['aria-label'], 'Installa App');
  assert.equal(row.props['data-install-state'], 'installable');

  await click(row);
  assert.equal(spy.calls, 1, 'the real prompt() was called exactly once');
  assert.match(flatText(renderer.root), /App installata con successo!/, 'accepted shows the success toast');
  assert.match(flatText(renderer.root), /App già installata/, 'the row flips to the installed state');

  await act(async () => { renderer.unmount(); });
});

test('dismissed: no success, the spent event is cleared and never re-prompted', async (t) => {
  const fake = useFakeWindow(t, { userAgent: CHROME_UA });
  const spy = { calls: 0 };
  const renderer = await mount(React.createElement(PWAInstallRow));

  await fireBIP(fake, fakePromptEvent('dismissed', spy));
  await click(byId(renderer, 'mobile-more-install'));
  assert.equal(spy.calls, 1, 'prompt() called once');
  assert.doesNotMatch(flatText(renderer.root), /App installata con successo!/, 'no success toast on dismiss');

  // The spent event was cleared: the row falls back to the manual guide…
  const row = byId(renderer, 'mobile-more-install');
  assert.equal(row.props['data-install-state'], 'manual');

  // …and a second tap opens the guide instead of reusing the dead event.
  await click(row);
  assert.equal(spy.calls, 1, 'prompt() is never called twice with the same event');
  assert.match(flatText(renderer.root), /Installazione Web App/, 'the tap still gives visible feedback');

  await act(async () => { renderer.unmount(); });
});

test('compact header button drives the same prompt flow (desktop with BIP)', async (t) => {
  const fake = useFakeWindow(t, { userAgent: CHROME_UA });
  const spy = { calls: 0 };
  const renderer = await mount(React.createElement(PWAInstallButton));

  await fireBIP(fake, fakePromptEvent('accepted', spy));
  await click(byId(renderer, 'btn-pwa-install'));
  assert.equal(spy.calls, 1, 'desktop prompt() called');
  assert.match(flatText(renderer.root), /App installata con successo!/);

  await act(async () => { renderer.unmount(); });
});

test('two co-mounted instances never double-consume the event; the stale tap opens the guide', async (t) => {
  const fake = useFakeWindow(t, { userAgent: CHROME_UA });
  const spy = { calls: 0 };
  // Navbar (hidden on phones) + "Altro" row both hold the same event.
  const first = await mount(React.createElement(PWAInstallRow));
  const second = await mount(React.createElement(PWAInstallRow));
  await fireBIP(fake, fakePromptEvent('dismissed', spy));

  await click(byId(first, 'mobile-more-install'));
  assert.equal(spy.calls, 1);

  // The second instance holds the now-spent event: its tap must not re-prompt
  // and must not stay silent either.
  await click(byId(second, 'mobile-more-install'));
  assert.equal(spy.calls, 1, 'the spent event is never prompted twice');
  assert.match(flatText(second.root), /Installazione Web App/, 'stale tap falls back to the visible guide');

  await act(async () => { first.unmount(); second.unmount(); });
});

// ---------------------------------------------------------------------------
// iOS / iPad without a programmable prompt
// ---------------------------------------------------------------------------

test('iOS without prompt: row offers the 3-step guide, mobile-friendly and closable', async (t) => {
  useFakeWindow(t, { userAgent: IPHONE_UA });
  const renderer = await mount(React.createElement(PWAInstallRow));

  const row = byId(renderer, 'mobile-more-install');
  assert.equal(row.props['aria-label'], "Come installare l'app");
  assert.equal(row.props['data-install-state'], 'ios');

  await click(row);
  const text = flatText(renderer.root);
  assert.match(text, /Installa su iPhone \/ iPad/);
  assert.match(text, /Condividi/);
  assert.match(text, /Aggiungi alla schermata Home/);
  assert.match(text, /Aggiungi/);

  await click(buttonByText(renderer, 'Ho Capito'));
  assert.doesNotMatch(flatText(renderer.root), /Installa su iPhone \/ iPad/, 'the guide closes');

  await act(async () => { renderer.unmount(); });
});

test('iPad in desktop mode (Mac UA + touch) is detected as iOS', async (t) => {
  useFakeWindow(t, { userAgent: IPAD_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 5 });
  const renderer = await mount(React.createElement(PWAInstallRow));

  const row = byId(renderer, 'mobile-more-install');
  assert.equal(row.props['data-install-state'], 'ios', 'desktop-mode iPad gets the iOS guide');
  await click(row);
  assert.match(flatText(renderer.root), /Aggiungi alla schermata Home/);

  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// Already installed / unsupported / desktop fallback
// ---------------------------------------------------------------------------

test('standalone via matchMedia: "App già installata", no install action offered', async (t) => {
  const fake = useFakeWindow(t, { userAgent: CHROME_UA, standalone: true });
  const spy = { calls: 0 };
  const renderer = await mount(React.createElement(PWAInstallRow));

  const installed = renderer.root.findAll((el: any) => el.props?.['aria-label'] === 'App già installata');
  assert.equal(installed.length, 1);
  assert.equal(installed[0].type, 'div', 'installed state is not a button');
  assert.equal(installed[0].props['data-install-state'], 'installed');

  // Even if the browser fires the event, no install action appears.
  await fireBIP(fake, fakePromptEvent('accepted', spy));
  assert.equal(renderer.root.findAllByType('button').length, 0, 'no prompt is offered when installed');
  assert.equal(spy.calls, 0);

  await act(async () => { renderer.unmount(); });
});

test('standalone via navigator.standalone (iOS): same installed state', async (t) => {
  useFakeWindow(t, { userAgent: IPHONE_UA, navigatorStandalone: true });
  const renderer = await mount(React.createElement(PWAInstallRow));

  assert.match(flatText(renderer.root), /App già installata/);
  assert.equal(renderer.root.findAllByType('button').length, 0, 'no install action when installed');

  await act(async () => { renderer.unmount(); });
});

test('unsupported browser: visible explanation instead of silence, closable', async (t) => {
  useFakeWindow(t, { userAgent: FIREFOX_UA });
  const renderer = await mount(React.createElement(PWAInstallRow));

  const row = byId(renderer, 'mobile-more-install');
  assert.equal(row.props['aria-label'], 'Installazione non disponibile in questo browser');
  assert.equal(row.props['data-install-state'], 'unsupported');

  await click(row);
  assert.match(flatText(renderer.root), /Installazione Web App/);
  assert.match(flatText(renderer.root), /Altri browser/);

  const close = renderer.root.findAllByType('button').find((b: any) => b.props['aria-label'] === 'Chiudi guida installazione');
  assert.ok(close, 'the guide has an accessible close button');
  await click(close);
  assert.doesNotMatch(flatText(renderer.root), /Installazione Web App/, 'the guide closes');

  await act(async () => { renderer.unmount(); });
});

test('desktop Safari without BIP: brief explanation with the Add to Dock steps', async (t) => {
  useFakeWindow(t, { userAgent: SAFARI_MAC_UA });
  const renderer = await mount(React.createElement(PWAInstallButton));

  const fallback = renderer.root.findAllByType('button').find((b: any) => b.props['aria-label'] === 'Installa App');
  assert.ok(fallback, 'a fallback action exists instead of nothing');
  await click(fallback);
  assert.match(flatText(renderer.root), /Aggiungi al Dock/, 'Mac Safari steps are explained');

  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// End to end from the "Altro" menu (the reported bug)
// ---------------------------------------------------------------------------

test('"Altro" → install row is a real button that invokes the install flow', async (t) => {
  const fake = useFakeWindow(t, { userAgent: CHROME_UA });
  const spy = { calls: 0 };
  const renderer = await mount(React.createElement(MobileNav, {
    currentView: 'oggi',
    onViewChange: () => {},
    onOpenNewEvent: () => {},
    onOpenProfileModal: () => {},
  }));

  await click(byId(renderer, 'mobile-nav-altro'));
  assert.equal(altroDialog(renderer).length, 1, 'the Altro sheet opens');

  await fireBIP(fake, fakePromptEvent('accepted', spy));
  const row = byId(renderer, 'mobile-more-install');
  assert.equal(row.type, 'button', 'REGRESSION: the row itself must be tappable, not a dead label');
  assert.match(flatText(row), /Installa App/);

  await click(row);
  assert.equal(spy.calls, 1, 'the menu tap invokes the real install flow');
  assert.match(flatText(renderer.root), /App installata con successo!/);

  await act(async () => { renderer.unmount(); });
});

test('"Altro" → iOS row opens the guide above the sheet (sheet stays as context)', async (t) => {
  useFakeWindow(t, { userAgent: IPHONE_UA });
  const renderer = await mount(React.createElement(MobileNav, {
    currentView: 'oggi',
    onViewChange: () => {},
    onOpenNewEvent: () => {},
    onOpenProfileModal: () => {},
  }));

  await click(byId(renderer, 'mobile-nav-altro'));
  await click(byId(renderer, 'mobile-more-install'));

  assert.match(flatText(renderer.root), /Aggiungi alla schermata Home/, 'the guide opens from the menu');
  assert.equal(altroDialog(renderer).length, 1, 'the sheet stays open behind the guide');

  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

test('install flow never reloads and touches no service-worker plumbing', async () => {
  for (const file of ['src/hooks/usePWAInstall.ts', 'src/components/PWAInstallButton.tsx', 'src/components/MobileNav.tsx']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /location\.reload/, `${file} never reloads the page`);
    assert.doesNotMatch(source, /serviceWorker/, `${file} does not touch the service worker`);
  }
});
