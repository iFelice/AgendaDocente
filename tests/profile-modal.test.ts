import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { useEffect, useState } from 'react';
import { create, act } from 'react-test-renderer';
import type { User as FirebaseUser } from 'firebase/auth';
import { ProfileModal } from '../src/components/ProfileModal';
import { SyncEngine, type LocalApply, type SyncStore } from '../src/services/sync/engine';
import type {
  ItemsCollection,
  RemoteItem,
  RemoteStateDoc,
  StateDocName,
  SyncGateway,
  SyncStatus,
  SyncableSnapshot,
} from '../src/services/sync/types';
import type { CalendarEvent, TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ProfileModal responsive layout + header quick-sync:
 *   - header title never pushes the actions out; close is always visible (44px);
 *   - tabs fit one row on phones (short labels) and keep full labels on sm+;
 *   - no horizontal-scroll strip, no clipped tab, single vertical scroll area;
 *   - the header quick-sync icon drives the SAME shared pipeline as the
 *     CloudSync card button (same controller, same engine cycle, one
 *     double-trigger guard, mirrored transient feedback).
 */

const tick = () => new Promise((resolve) => setImmediate(resolve));

function emptySnapshot(): SyncableSnapshot {
  return {
    profile: {
      id: 'p1', fullName: '', schoolName: '', schoolLevel: 'ssig', schoolYear: '2026/2027',
      primarySubjects: [], classes: [], campuses: [], roles: [],
    },
    events: [], circulars: [], students: [], definitiveTimetable: [], provisionalTimetable: [],
    timetableMode: 'auto', onboardingCompleted: false,
  };
}

function event(id: string, title: string, date = '2026-09-15'): CalendarEvent {
  return {
    id, title, date, startTime: '09:00', endTime: '10:00', type: 'lezioni',
    createdAt: '2026-09-09T10:00:00.000Z', updatedAt: '2026-09-09T10:00:00.000Z',
  } as unknown as CalendarEvent;
}

/** In-memory SyncStore mirroring createStoreAdapter semantics (settings doc -> 3 fields). */
function memoryStore(overrides: Partial<SyncableSnapshot> = {}): SyncStore & { snapshot: SyncableSnapshot; meta: Map<string, unknown> } {
  const snapshot: SyncableSnapshot = { ...emptySnapshot(), ...overrides };
  const meta = new Map<string, unknown>();
  return {
    snapshot, meta,
    mode: () => 'indexeddb',
    async readSnapshot() { return structuredClone(snapshot); },
    async applyLocal(changes: LocalApply) {
      if (changes.fullRestore) { Object.assign(snapshot, structuredClone(changes.fullRestore)); return; }
      const state = changes.localApplyState ?? {};
      if ('profile' in state) snapshot.profile = structuredClone(state.profile) as SyncableSnapshot['profile'];
      if ('students' in state) snapshot.students = structuredClone(state.students) as SyncableSnapshot['students'];
      if ('definitiveTimetable' in state) snapshot.definitiveTimetable = structuredClone(state.definitiveTimetable) as SyncableSnapshot['definitiveTimetable'];
      if ('provisionalTimetable' in state) snapshot.provisionalTimetable = structuredClone(state.provisionalTimetable) as SyncableSnapshot['provisionalTimetable'];
      if ('settings' in state) {
        const settings = state.settings as { timetableMode?: SyncableSnapshot['timetableMode']; onboardingCompleted?: boolean; timeSlotConfig?: SyncableSnapshot['timeSlotConfig'] };
        if (settings?.timetableMode) snapshot.timetableMode = settings.timetableMode;
        if (typeof settings?.onboardingCompleted === 'boolean') snapshot.onboardingCompleted = settings.onboardingCompleted;
        if (settings?.timeSlotConfig) snapshot.timeSlotConfig = settings.timeSlotConfig;
      }
      if (changes.localEvents) snapshot.events = structuredClone(changes.localEvents);
      if (changes.localCirculars) snapshot.circulars = structuredClone(changes.localCirculars);
    },
    async readMeta(key: string) { return meta.get(key); },
    async writeMeta(key: string, value: unknown) { meta.set(key, structuredClone(value)); },
  };
}

/** Fake cloud with read/write counters and concurrency instrumentation. */
function makeFakeCloud(clock: { now: string }, failReads = false) {
  const cloud = {
    state: {} as Record<string, RemoteStateDoc>,
    items: { events: new Map<string, RemoteItem>(), circulars: new Map<string, RemoteItem>() } as Record<ItemsCollection, Map<string, RemoteItem>>,
    conflicts: [] as { kind: string; loser: unknown }[],
    reads: 0, writes: 0,
    writeInFlight: 0, maxWriteInFlight: 0,
  };
  const trackWrite = async <T,>(op: () => Promise<T>): Promise<T> => {
    cloud.writeInFlight++; cloud.maxWriteInFlight = Math.max(cloud.maxWriteInFlight, cloud.writeInFlight);
    try { return await op(); } finally { cloud.writeInFlight--; }
  };
  const gateway: SyncGateway = {
    async readState(name: StateDocName) {
      if (failReads) throw new Error('Failed to fetch');
      cloud.reads++;
      return cloud.state[name] ? structuredClone(cloud.state[name]) : null;
    },
    async writeState(name: StateDocName, payload: unknown) {
      return trackWrite(async () => {
        if (failReads) throw new Error('Failed to fetch');
        cloud.writes++;
        cloud.state[name] = { payload: JSON.parse(JSON.stringify(payload ?? null)), updatedAt: clock.now, schemaVersion: 1 };
        return { updatedAt: clock.now };
      });
    },
    async listItems(coll: ItemsCollection) {
      if (failReads) throw new Error('Failed to fetch');
      cloud.reads++;
      return [...cloud.items[coll].values()].map((item) => structuredClone(item));
    },
    async writeItems(coll: ItemsCollection, entries: { id: string; payload: unknown }[]) {
      return trackWrite(async () => {
        if (failReads) throw new Error('Failed to fetch');
        cloud.writes++;
        for (const { id, payload } of entries) cloud.items[coll].set(id, { id, payload: structuredClone(payload), updatedAt: clock.now });
      });
    },
    async deleteItems(coll: ItemsCollection, ids: string[]) {
      return trackWrite(async () => {
        if (failReads) throw new Error('Failed to fetch');
        cloud.writes++;
        for (const id of ids) cloud.items[coll].delete(id);
      });
    },
    async archiveConflict(kind: string, loser: unknown) { cloud.conflicts.push({ kind, loser: structuredClone(loser) }); },
  };
  return { cloud, gateway: () => gateway };
}

/** Engine with an observable scheduler queue (no real timers), plus a bounded drainer. */
function makeEngine(store: SyncStore, gateway: () => SyncGateway, clock: { now: string }) {
  const queue: { fn: () => void }[] = [];
  const cancelled = new Set<{ fn: () => void }>();
  const engine = new SyncEngine({
    gateway,
    uid: () => 'uid-manual',
    store,
    now: () => clock.now,
    schedule: (fn) => {
      const call = { fn };
      queue.push(call);
      return () => { cancelled.add(call); };
    },
  });
  const drain = async (maxRounds = 12) => {
    for (let round = 0; round < maxRounds; round++) {
      const pending = queue.splice(0).filter((call) => !cancelled.has(call));
      for (const call of pending) call.fn();
      await tick();
    }
  };
  return { engine, queue, drain };
}

async function loggedInDevice(clock: { now: string }, overrides: Partial<SyncableSnapshot> = {}, failReads = false) {
  const store = memoryStore(overrides);
  const fake = makeFakeCloud(clock, failReads);
  const device = makeEngine(store, fake.gateway, clock);
  device.engine.startSession('uid-manual');
  await act(async () => { await device.drain(); });
  return { store, ...fake, ...device };
}

// ---------- modal harness wired exactly like App.tsx ----------

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

const googleUser = {
  uid: 'uid-manual', email: 'docente@scuola.edu.it',
  displayName: 'Andrea Conti', photoURL: null,
} as unknown as FirebaseUser;

function Harness({ engine, online, initialTab, syncSpy }: {
  engine: SyncEngine;
  online?: boolean;
  initialTab?: 'profilo' | 'backup' | 'google';
  syncSpy?: () => void;
}) {
  const [status, setStatus] = useState<SyncStatus>(engine.getStatus());
  useEffect(() => engine.subscribe(setStatus), [engine]);
  return React.createElement(ProfileModal, {
    isOpen: true,
    onClose: () => {},
    profile,
    onSaveProfile: () => {},
    onDataImported: () => {},
    onOpenTutorial: () => {},
    googleUser,
    googleAccessToken: 'token',
    onGoogleLogin: async () => {},
    onGoogleLogout: async () => {},
    events: [],
    onSyncAllToGoogle: async () => ({ syncedCount: 0, errorCount: 0 }),
    accountSyncStatus: status,
    onSyncNow: () => { syncSpy?.(); void engine.syncNow(); },
    onSyncToggle: () => {},
    onSyncResolve: () => {},
    online,
    initialTab: initialTab ?? 'google',
  });
}

async function mountModal(props: Partial<React.ComponentProps<typeof ProfileModal>> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(ProfileModal, {
      isOpen: true,
      onClose: () => {},
      profile,
      onSaveProfile: () => {},
      onDataImported: () => {},
      googleUser,
      googleAccessToken: 'token',
      events: [],
      initialTab: 'google',
      ...props,
    }));
  });
  return renderer;
}

async function mountWithEngine(engine: SyncEngine, opts: { online?: boolean; initialTab?: 'profilo' | 'backup' | 'google'; syncSpy?: () => void } = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(Harness, { engine, ...opts }));
  });
  return renderer;
}

const CARD_SYNC_LABELS = ['Sincronizza ora', 'Sincronizzazione…', 'Aggiornato ora', 'Sincronizzazione non riuscita'];

/** Header quick sync: constant aria-label + always a title (the card button has no title). */
function quickSyncButton(renderer: any) {
  const matches = renderer.root.findAllByType('button')
    .filter((b: any) => b.props['aria-label'] === 'Sincronizza ora' && typeof b.props.title === 'string');
  assert.equal(matches.length, 1, 'exactly one header quick-sync button with aria-label "Sincronizza ora"');
  return matches[0];
}

function cardSyncButton(renderer: any) {
  const button = renderer.root.findAllByType('button')
    .find((b: any) => CARD_SYNC_LABELS.includes(b.props['aria-label']) && b.props.title === undefined);
  assert.ok(button, 'the CloudSync card button is rendered');
  return button;
}

function closeButton(renderer: any) {
  const matches = renderer.root.findAllByType('button')
    .filter((b: any) => b.props['aria-label'] === 'Chiudi');
  assert.equal(matches.length, 1, 'exactly one close button with aria-label "Chiudi"');
  return matches[0];
}

function tablist(renderer: any) {
  const matches = renderer.root.findAll((el: any) => el.props?.role === 'tablist');
  assert.equal(matches.length, 1, 'a single tablist is rendered');
  return matches[0];
}

function tabButtons(renderer: any) {
  const matches = renderer.root.findAll((el: any) => el.type === 'button' && el.props?.role === 'tab');
  assert.equal(matches.length, 3, 'three tabs are rendered');
  return matches;
}

async function click(button: any) {
  await act(async () => { button.props.onClick(); });
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

function hasClass(node: any, token: string): boolean {
  return typeof node?.props?.className === 'string' && String(node.props.className).split(' ').includes(token);
}

function svgIcon(button: any) {
  const svgs = button.findAll((el: any) => el.type === 'svg');
  assert.equal(svgs.length, 1, 'the button shows exactly one icon');
  return svgs[0];
}

// ---------------------------------------------------------------------------
// 1. Responsive tab navigation
// ---------------------------------------------------------------------------

test('tabs are an accessible tablist with short mobile labels and full sm+ labels', async () => {
  const clock = { now: '2026-09-09T18:00:00.000Z' };
  const device = await loggedInDevice(clock);
  const renderer = await mountWithEngine(device.engine, { initialTab: 'profilo' });

  const list = tablist(renderer);
  assert.equal(list.props['aria-label'], 'Sezioni profilo');

  const tabs = tabButtons(renderer);
  assert.equal(tabs[0].props['aria-selected'], true);
  assert.equal(tabs[1].props['aria-selected'], false);
  assert.equal(tabs[2].props['aria-selected'], false);

  // Mobile-first short labels (visible below sm)…
  const shortLabels = renderer.root
    .findAll((el: any) => el.type === 'span' && el.props.className === 'sm:hidden')
    .map(nodeText);
  assert.deepEqual(shortLabels, ['Backup', 'Google & Sync']);
  // …and fuller desktop labels (visible from sm up).
  const fullLabels = renderer.root
    .findAll((el: any) => el.type === 'span' && el.props.className === 'hidden sm:inline')
    .map(nodeText);
  assert.deepEqual(fullLabels, ['Backup & Ripristino', 'Account Istituzionale & Google']);
  assert.match(nodeText(tabs[0]), /Profilo & Classi/);

  await act(async () => { renderer.unmount(); });
});

test('tab navigation switches panels (aria-selected) and close stays available on every tab', async () => {
  const clock = { now: '2026-09-09T18:05:00.000Z' };
  const device = await loggedInDevice(clock);
  const renderer = await mountWithEngine(device.engine, { initialTab: 'profilo' });

  const markers: [number, RegExp][] = [
    [0, /Nome e Cognome/],
    [1, /Esporta Backup/],
    [2, /Sincronizzazione account/],
  ];
  for (const [index, marker] of markers) {
    await click(tabButtons(renderer)[index]);
    const tabs = tabButtons(renderer);
    tabs.forEach((tab: any, i: number) => assert.equal(tab.props['aria-selected'], i === index));
    assert.match(nodeText(renderer.root), marker, `panel ${index} content is shown`);
    closeButton(renderer); // never pushed out, on any tab
  }

  await act(async () => { renderer.unmount(); });
});

test('no clipped tabs: single-row grid, no horizontal scroll strip, 44px tab targets', async () => {
  const clock = { now: '2026-09-09T18:10:00.000Z' };
  const device = await loggedInDevice(clock);
  const renderer = await mountWithEngine(device.engine);

  const list = tablist(renderer);
  assert.ok(hasClass(list, 'grid-cols-3'), 'the three tabs share one row on phones');
  assert.ok(!hasClass(list, 'overflow-x-auto'), 'no horizontal scroll strip can clip a tab');
  assert.ok(hasClass(list, 'shrink-0'), 'the tab bar never shrinks away');

  for (const tab of tabButtons(renderer)) {
    assert.ok(hasClass(tab, 'min-h-[44px]'), 'each tab is a 44px touch target');
    assert.ok(hasClass(tab, 'min-w-0'), 'each tab can shrink inside the row');
    assert.ok(tab.findAll((el: any) => hasClass(el, 'truncate')).length > 0, 'long labels truncate instead of overflowing');
  }

  await act(async () => { renderer.unmount(); });
});

test('header never clips: title truncates, actions keep their size, close is 44px', async () => {
  const clock = { now: '2026-09-09T18:15:00.000Z' };
  const device = await loggedInDevice(clock);
  const renderer = await mountWithEngine(device.engine);

  const title = renderer.root.findByType('h2');
  assert.ok(hasClass(title, 'truncate'), 'the title truncates instead of pushing actions out');
  assert.ok(hasClass(title.parent, 'min-w-0'), 'the title block can shrink');

  const actions = quickSyncButton(renderer).parent;
  assert.ok(hasClass(actions, 'shrink-0'), 'header actions never shrink');
  const header = actions.parent;
  for (const token of ['shrink-0', 'relative', 'z-10']) {
    assert.ok(hasClass(header, token), `header is a fixed block above scrolled content (${token})`);
  }

  const close = closeButton(renderer);
  assert.ok(hasClass(close, 'min-w-[44px]') && hasClass(close, 'min-h-[44px]'), 'close is a 44px touch target');
  assert.equal(close.props.title, 'Chiudi');

  await act(async () => { renderer.unmount(); });
});

test('single vertical scroll area with safe-area padding; dialog clips horizontal overflow', async () => {
  const clock = { now: '2026-09-09T18:20:00.000Z' };
  const device = await loggedInDevice(clock);
  const renderer = await mountWithEngine(device.engine);

  const dialog = renderer.root.find((el: any) => el.props?.role === 'dialog');
  assert.equal(dialog.props['aria-modal'], true);
  for (const token of ['flex-col', 'overflow-hidden']) {
    assert.ok(hasClass(dialog, token), `dialog panel (${token})`);
  }

  const content = renderer.root
    .findAll((el: any) => el.type === 'div' && hasClass(el, 'flex-1'))
    .find((el: any) => hasClass(el, 'overflow-y-auto'));
  assert.ok(content, 'one vertical scroll container exists');
  assert.ok(hasClass(content, 'min-h-0'), 'the scroll container shrinks correctly inside the flex column');
  assert.match(String(content.props.className), /safe-area-inset-bottom/, 'bottom safe area respected');

  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// 2. Header quick sync: placement, target, icon
// ---------------------------------------------------------------------------

test('quick sync is visible in the header before the close button, 44px target, ~20px icon', async () => {
  const clock = { now: '2026-09-09T18:25:00.000Z' };
  const device = await loggedInDevice(clock);
  const renderer = await mountWithEngine(device.engine);

  const quick = quickSyncButton(renderer);
  assert.ok(typeof quick.props.title === 'string' && quick.props.title.length > 0, 'an appropriate title is present');
  assert.ok(hasClass(quick, 'min-w-[44px]') && hasClass(quick, 'min-h-[44px]'), '44px touch target');
  assert.ok(!String(quick.props.className).includes('hidden'), 'visible on both mobile and desktop');

  const icon = svgIcon(quick);
  assert.ok(hasClass(icon, 'w-5') && hasClass(icon, 'h-5'), 'visual icon is ~20px');

  const ordered = quick.parent.findAll((el: any) => el.type === 'button');
  const close = closeButton(renderer);
  assert.ok(ordered.indexOf(quick) !== -1 && ordered.indexOf(quick) < ordered.indexOf(close), 'quick sync sits before the close button');
  assert.equal(ordered[ordered.length - 1], close, 'close stays the last header action');

  await act(async () => { renderer.unmount(); });
});

test('quick sync is disabled (but visible) when no sync pipeline is available', async () => {
  const renderer = await mountModal({
    accountSyncStatus: { phase: 'disabled', enabled: true, activeUid: null },
  });
  const quick = quickSyncButton(renderer);
  assert.equal(quick.props.disabled, true, 'disabled without a session/handler');
  assert.equal(quick.props.title, 'Sincronizza ora');
  assert.equal(cardSyncButton(renderer).props.disabled, true, 'the card agrees (shared controller)');
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// 3. Shared pipeline: header icon and card button are the same action
// ---------------------------------------------------------------------------

test('quick sync runs the real engine and header + card share the success feedback', async () => {
  const clock = { now: '2026-09-09T18:30:00.000Z' };
  const device = await loggedInDevice(clock);
  device.store.snapshot.events = [event('e1', 'Consiglio di classe')];

  let calls = 0;
  const renderer = await mountWithEngine(device.engine, { syncSpy: () => { calls++; } });
  assert.equal(quickSyncButton(renderer).props.title, 'Sincronizza ora');

  await click(quickSyncButton(renderer));
  await act(async () => { await device.drain(); });

  assert.equal(calls, 1, 'the shared onSyncNow pipeline was invoked once');
  assert.equal(device.cloud.items.events.size, 1, 'the event reached the cloud through the real engine');
  assert.equal(device.engine.getStatus().phase, 'idle');

  // Same controller: one run updates BOTH triggers.
  assert.equal(quickSyncButton(renderer).props.title, 'Sincronizzazione completata');
  assert.ok(hasClass(svgIcon(quickSyncButton(renderer)), 'text-emerald-600'), 'header shows the success Check');
  assert.equal(cardSyncButton(renderer).props['aria-label'], 'Aggiornato ora', 'the card mirrors the same outcome');

  const live = renderer.root.findAll((el: any) => el.type === 'span' && el.props['aria-live'] === 'polite').map(nodeText);
  assert.ok(live.some((text: string) => text.includes('Sincronizzazione completata')), 'success is announced to assistive tech');

  await act(async () => { renderer.unmount(); });
});

test('a card-triggered run is mirrored by the header (shared controller, both directions)', async () => {
  const clock = { now: '2026-09-09T18:35:00.000Z' };
  const device = await loggedInDevice(clock);
  device.store.snapshot.events = [event('e1', 'Collegio docenti')];

  const renderer = await mountWithEngine(device.engine);
  await click(cardSyncButton(renderer));
  await act(async () => { await device.drain(); });

  assert.equal(device.cloud.items.events.size, 1, 'uploaded through the real engine');
  assert.equal(cardSyncButton(renderer).props['aria-label'], 'Aggiornato ora');
  assert.equal(quickSyncButton(renderer).props.title, 'Sincronizzazione completata', 'header mirrors the card-triggered run');

  await act(async () => { renderer.unmount(); });
});

test('rapid triggers on header + card never create concurrent sync cycles', async () => {
  const clock = { now: '2026-09-09T18:40:00.000Z' };
  const device = await loggedInDevice(clock);
  device.store.snapshot.events = [event('e1', 'Doppio trigger')];

  let calls = 0;
  const renderer = await mountWithEngine(device.engine, { syncSpy: () => { calls++; } });
  // Both taps inside one act(): a true rapid double-tap, before any engine
  // feedback can be flushed — the shared guard must coalesce them synchronously.
  await act(async () => {
    quickSyncButton(renderer).props.onClick();
    cardSyncButton(renderer).props.onClick();
  });
  await act(async () => { await device.drain(); });

  assert.equal(calls, 1, 'one shared guard: a single pipeline invocation');
  assert.ok(device.cloud.maxWriteInFlight <= 1, `writes never overlap (max=${device.cloud.maxWriteInFlight})`);
  assert.equal(device.cloud.items.events.size, 1, 'data uploaded exactly once');
  assert.equal(device.engine.getStatus().phase, 'idle');

  await act(async () => { renderer.unmount(); });
});

test('syncing state: animated icon in the header, card label agrees, triggers locked', async () => {
  const renderer = await mountModal({
    accountSyncStatus: { phase: 'syncing', enabled: true, activeUid: 'uid-manual' },
    onSyncNow: () => {},
  });

  const quick = quickSyncButton(renderer);
  assert.equal(quick.props.disabled, true, 'no second run while syncing');
  assert.equal(quick.props.title, 'Sincronizzazione in corso…');
  assert.ok(hasClass(svgIcon(quick), 'animate-spin'), 'the header icon spins while syncing');
  assert.equal(cardSyncButton(renderer).props['aria-label'], 'Sincronizzazione…');

  await act(async () => { renderer.unmount(); });
});

test('success feedback is transient on both triggers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { now: '2026-09-09T18:45:00.000Z' };
  const device = await loggedInDevice(clock);
  device.store.snapshot.events = [event('e1', 'GLO')];

  const renderer = await mountWithEngine(device.engine);
  await click(quickSyncButton(renderer));
  await act(async () => { await device.drain(); });

  assert.equal(quickSyncButton(renderer).props.title, 'Sincronizzazione completata');
  assert.equal(cardSyncButton(renderer).props['aria-label'], 'Aggiornato ora');

  await act(async () => { t.mock.timers.tick(4100); });
  assert.equal(quickSyncButton(renderer).props.title, 'Sincronizza ora', 'header back to neutral');
  assert.equal(cardSyncButton(renderer).props['aria-label'], 'Sincronizza ora', 'card back to neutral');

  await act(async () => { renderer.unmount(); });
});

test('error state: header alert + accessible feedback, card agrees, local data untouched', async () => {
  const clock = { now: '2026-09-09T19:00:00.000Z' };
  const device = await loggedInDevice(clock, { events: [event('e1', 'Row')] }, true);

  const renderer = await mountWithEngine(device.engine);
  await click(quickSyncButton(renderer));
  await act(async () => { await device.drain(3); }); // bounded: the engine schedules retries

  assert.equal(device.engine.getStatus().phase, 'error');
  const quick = quickSyncButton(renderer);
  assert.match(quick.props.title, /Sincronizzazione non riuscita/);
  assert.ok(hasClass(svgIcon(quick), 'text-rose-600'), 'header shows the error alert icon');
  assert.equal(cardSyncButton(renderer).props['aria-label'], 'Sincronizzazione non riuscita');

  const live = renderer.root.findAll((el: any) => el.type === 'span' && el.props['aria-live'] === 'polite').map(nodeText);
  assert.ok(live.some((text: string) => text.includes('Sincronizzazione non riuscita')), 'the error is announced to assistive tech');

  assert.deepEqual(device.store.snapshot.events.map((e) => e.id), ['e1'], 'local events untouched');
  assert.equal(device.cloud.writes, 0, 'nothing was written to the cloud');

  await act(async () => { renderer.unmount(); });
});

test('offline run: clear feedback, no data loss, triggers available again', async () => {
  const clock = { now: '2026-09-09T19:15:00.000Z' };
  const previousOnLine = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  try {
    const device = await loggedInDevice(clock, { events: [event('e1', 'Row')] }, true);
    const renderer = await mountWithEngine(device.engine);

    await click(quickSyncButton(renderer));
    await act(async () => { await device.drain(3); });

    assert.equal(device.engine.getStatus().phase, 'offline');
    assert.equal(quickSyncButton(renderer).props.title, 'Sei offline. I dati locali restano disponibili.');
    assert.match(nodeText(renderer.root), /Sei offline\. I dati locali restano disponibili\./);
    assert.deepEqual(device.store.snapshot.events.map((e) => e.id), ['e1'], 'local events intact');
    await act(async () => { renderer.unmount(); });
  } finally {
    if (previousOnLine) Object.defineProperty(globalThis.navigator, 'onLine', previousOnLine);
    else delete (globalThis.navigator as any).onLine;
  }

  // Pure UI: with the offline prop the header shows the offline state and stays available.
  const clock2 = { now: '2026-09-09T19:20:00.000Z' };
  const device2 = await loggedInDevice(clock2);
  const renderer2 = await mountWithEngine(device2.engine, { online: false });
  assert.equal(quickSyncButton(renderer2).props.title, 'Sei offline. I dati locali restano disponibili.');
  assert.equal(quickSyncButton(renderer2).props.disabled, false, 'the quick sync stays available offline');
  assert.match(nodeText(renderer2.root), /Sei offline\. I dati locali restano disponibili\./);
  await act(async () => { renderer2.unmount(); });
});

// ---------------------------------------------------------------------------
// 4. Structural guards: one shared controller, no second engine, no reload
// ---------------------------------------------------------------------------

test('quick sync and card share one controller; no duplicated sync logic, no reload', async () => {
  const modalSource = readFileSync(new URL('../src/components/ProfileModal.tsx', import.meta.url), 'utf8');
  assert.match(modalSource, /useManualSync\(\{\s*status: accountSyncStatus, onSyncNow\s*\}\)/, 'the modal owns one shared controller');
  assert.match(modalSource, /onClick=\{manualSync\.runSync\}/, 'the header triggers the shared controller');
  assert.match(modalSource, /controller=\{manualSync\}/, 'the card receives the same controller instance');

  const cardSource = readFileSync(new URL('../src/components/CloudSyncCard.tsx', import.meta.url), 'utf8');
  assert.match(cardSource, /controller \?\? internal/, 'the card prefers the shared controller');

  for (const file of ['src/hooks/useManualSync.ts', 'src/components/CloudSyncCard.tsx', 'src/components/ProfileModal.tsx']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /location\.reload/, `${file} never reloads the page`);
    assert.doesNotMatch(source, /new SyncEngine/, `${file} creates no second sync engine`);
  }

  // The production wiring still goes through accountSync.syncNow().
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /onSyncNow=\{\(\) => void accountSync\.syncNow\(\)\}/);
});
