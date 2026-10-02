import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { EventModal } from '../src/components/EventModal';
import type { TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../src/index.css'), 'utf8');
const componentSource = readFileSync(resolve(here, '../src/components/EventModal.tsx'), 'utf8');

const profile: TeacherProfile = {
  id: 'p1',
  fullName: 'Prof. Andrea Conti',
  schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Matematica'],
  classes: ['2E'],
  campuses: ['Sede Centrale'],
  roles: [],
  isSupportTeacher: true,
};

function blockStartingAt(source: string, start: number): string {
  assert.ok(start >= 0, 'blocco CSS presente');
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, 'blocco CSS aperto');
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail('blocco CSS non chiuso');
}

function cssRule(selector: string, source = css): string {
  return blockStartingAt(source, source.indexOf(`${selector} {`));
}

function classTokens(node: any): string[] {
  return String(node?.props?.className ?? '').split(/\s+/).filter(Boolean);
}

const modalProps: React.ComponentProps<typeof EventModal> = {
  isOpen: true,
  onClose: () => {},
  eventToEdit: null,
  profile,
  onSave: () => {},
};

test('il pannello scrollabile ha un limite viewport-safe e contiene lo scroll a ogni larghezza', () => {
  const selector = '.app-modal-scroll > .app-modal-panel';
  const ruleStart = css.indexOf(`${selector} {`);
  const mobileStart = css.indexOf('@media (max-width: 639.98px)');
  const rule = cssRule(selector);

  assert.ok(ruleStart >= 0 && ruleStart < mobileStart,
    'la regola di scroll è generale, non confinata al breakpoint mobile');
  assert.equal(css.match(/\.app-modal-scroll\s*>\s*\.app-modal-panel\s*\{/g)?.length, 1,
    'la regola non è duplicata nella media query mobile');
  assert.match(rule, /max-height:\s*calc\(100dvh - 2rem\);/,
    'altezza massima basata sulla viewport dinamica');
  assert.match(rule, /overflow-y:\s*auto;/, 'overflow verticale interno abilitato');
  assert.match(rule, /overscroll-behavior:\s*contain;/, 'overscroll non propagato alla pagina');
  assert.match(rule, /-webkit-overflow-scrolling:\s*touch;/, 'momentum scrolling touch mantenuto');
});

test('telefono resta bottom-sheet, mentre tablet landscape e desktop restano dialog centrati', async () => {
  const media = blockStartingAt(css, css.indexOf('@media (max-width: 639.98px)'));
  const sheet = cssRule('.app-modal', media);
  const mobilePanel = cssRule('.app-modal > .app-modal-panel', media);

  assert.match(sheet, /align-items:\s*flex-end\s*!important;/, 'bottom-sheet allineato in basso su telefono');
  assert.match(sheet, /padding:\s*0\s*!important;/, 'bottom-sheet senza padding esterno su telefono');
  assert.match(mobilePanel, /max-width:\s*100%\s*!important;/, 'pannello a tutta larghezza su telefono');
  assert.match(mobilePanel,
    /max-height:\s*calc\(100dvh - env\(safe-area-inset-top, 0px\) - 0\.5rem\);/,
    'altezza mobile safe-area invariata');
  assert.match(mobilePanel, /border-radius:\s*1\.25rem 1\.25rem 0 0\s*!important;/,
    'forma bottom-sheet mobile invariata');
  assert.equal(css.match(/\.app-modal\s*\{/g)?.length, 1,
    'nessuna regola fuori dal breakpoint forza il backdrop a bottom-sheet');

  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(EventModal, modalProps));
  });
  const backdrop = renderer.root.find((node: any) =>
    node.type === 'div' && classTokens(node).includes('app-modal-scroll'));
  const panel = backdrop.children.find((node: any) =>
    typeof node === 'object' && classTokens(node).includes('app-modal-panel'));
  assert.ok(classTokens(backdrop).includes('items-center'),
    'il layout di base resta centrato per viewport da 640px in su, incluso tablet landscape');
  assert.ok(classTokens(backdrop).includes('justify-center'));
  assert.ok(panel, 'il pannello è figlio diretto dello scroll backdrop');
  assert.ok(classTokens(panel).includes('max-w-lg'), 'larghezza massima EventModal invariata');
  await act(async () => { renderer.unmount(); });
});

test('header e footer restano sticky rispetto al pannello scrollabile', () => {
  const header = cssRule('.modal-sticky-header');
  const footer = cssRule('.modal-sticky-footer');

  assert.match(header, /position:\s*sticky;/);
  assert.match(header, /top:\s*0;/);
  assert.match(footer, /position:\s*sticky;/);
  assert.match(footer, /bottom:\s*0;/);

  const panelIndex = componentSource.indexOf('className="app-modal-panel');
  const headerIndex = componentSource.indexOf('className="modal-sticky-header');
  const footerIndex = componentSource.indexOf('className="modal-sticky-footer');
  assert.ok(panelIndex >= 0 && headerIndex > panelIndex && footerIndex > headerIndex,
    'entrambi gli elementi sticky restano dentro il pannello che fa da scroll container');
});

test('EventModal blocca il body solo mentre è aperta e ripristina il valore precedente', async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const style = { overflow: 'scroll' };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { body: { style } },
  });

  let renderer: any;
  try {
    await act(async () => {
      renderer = create(React.createElement(EventModal, { ...modalProps, isOpen: false }));
    });
    assert.equal(style.overflow, 'scroll', 'modale chiusa: body invariato');

    await act(async () => {
      renderer.update(React.createElement(EventModal, { ...modalProps, isOpen: true }));
    });
    assert.equal(style.overflow, 'hidden', 'modale aperta: scroll pagina bloccato');

    await act(async () => {
      renderer.update(React.createElement(EventModal, { ...modalProps, isOpen: false }));
    });
    assert.equal(style.overflow, 'scroll', 'chiusura: overflow precedente ripristinato');

    await act(async () => {
      renderer.update(React.createElement(EventModal, { ...modalProps, isOpen: true }));
    });
    assert.equal(style.overflow, 'hidden');

    await act(async () => { renderer.unmount(); });
    assert.equal(style.overflow, 'scroll', 'unmount: overflow precedente ripristinato');
  } finally {
    if (renderer) {
      try { await act(async () => { renderer.unmount(); }); } catch { /* già smontato */ }
    }
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as any).document;
  }
});
