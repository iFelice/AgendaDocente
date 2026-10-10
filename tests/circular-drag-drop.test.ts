import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import type { TeacherProfile } from '../src/types';
import { installSignedInAnalysisClient } from './helpers/analysisClientSession';
installSignedInAnalysisClient();


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: TeacherProfile = {
  id: 't-1',
  fullName: 'Docente Test',
  schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Matematica'],
  classes: ['1A', '2A'],
  campuses: ['Sede Centrale'],
  roles: [],
};

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
const flatText = (node: any) => nodeText(node).replace(/\s+/g, ' ').trim();

class MockFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(file: any) {
    this.result = `data:${file.type};base64,QUJDREVGR0g=`;
    setTimeout(() => {
      if (this.onload) this.onload();
      if (this.onloadend) this.onloadend();
    }, 0);
  }

  readAsText(file: any) {
    this.result = 'Testo della circolare estratto';
    setTimeout(() => {
      if (this.onload) this.onload();
      if (this.onloadend) this.onloadend();
    }, 0);
  }
}

const originalFileReader = globalThis.FileReader;
beforeEach(() => {
  (globalThis as any).FileReader = MockFileReader;
});

afterEach(() => {
  (globalThis as any).FileReader = originalFileReader;
});

function createMockFile(name: string, type: string, size: number): File {
  return {
    name,
    type,
    size,
    slice: () => ({} as any),
  } as unknown as File;
}

// ---------------------------------------------------------------------------
// 1. click/selezione file continua a funzionare
// ---------------------------------------------------------------------------

test('1. Selezione tramite input file standard continua a funzionare', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: null,
      })
    );
  });

  const input = renderer.root.findByProps({ id: 'circular-file-input' });
  const file = createMockFile('circolare-10.pdf', 'application/pdf', 1024);

  await act(async () => {
    input.props.onChange({ target: { files: [file] } });
    await new Promise((r) => setTimeout(r, 10));
  });

  const text = flatText(renderer.root);
  assert.ok(text.includes('circolare-10.pdf'), 'Il nome del file deve essere visibile');
  assert.ok(text.includes('application/pdf'), 'Il tipo MIME deve essere visibile');
});

// ---------------------------------------------------------------------------
// 2. drop JPEG valido carica il file
// ---------------------------------------------------------------------------

test('2. Drop di un file JPEG valido carica correttamente il file', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: null,
      })
    );
  });

  const dropZone = renderer.root.findByProps({ htmlFor: 'circular-file-input' });
  const file = createMockFile('foto-circolare.jpg', 'image/jpeg', 2048);

  let prevented = false;
  let stopped = false;
  await act(async () => {
    dropZone.props.onDrop({
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
      dataTransfer: { files: [file] },
    });
    await new Promise((r) => setTimeout(r, 10));
  });

  assert.equal(prevented, true, 'onDrop deve chiamare preventDefault');
  assert.equal(stopped, true, 'onDrop deve chiamare stopPropagation');

  const text = flatText(renderer.root);
  assert.ok(text.includes('foto-circolare.jpg'), 'Il file JPEG droppato deve essere visualizzato');
  assert.ok(text.includes('image/jpeg'), 'Il MIME type JPEG deve essere mostrato');
});

// ---------------------------------------------------------------------------
// 3. drop PDF valido carica il file
// ---------------------------------------------------------------------------

test('3. Drop di un file PDF valido carica correttamente il file', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: null,
      })
    );
  });

  const dropZone = renderer.root.findByProps({ htmlFor: 'circular-file-input' });
  const file = createMockFile('documento-circolare.pdf', 'application/pdf', 5000);

  await act(async () => {
    dropZone.props.onDrop({
      preventDefault: () => {},
      stopPropagation: () => {},
      dataTransfer: { files: [file] },
    });
    await new Promise((r) => setTimeout(r, 10));
  });

  const text = flatText(renderer.root);
  assert.ok(text.includes('documento-circolare.pdf'));
  assert.ok(text.includes('application/pdf'));
});

// ---------------------------------------------------------------------------
// 4. drop file non valido mostra lo stesso errore del picker
// ---------------------------------------------------------------------------

test('4. Drop di un file non valido (es. ZIP o troppo grande) mostra il medesimo errore di upload', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: null,
      })
    );
  });

  const dropZone = renderer.root.findByProps({ htmlFor: 'circular-file-input' });
  const invalidFile = createMockFile('archivio.zip', 'application/zip', 100);

  await act(async () => {
    dropZone.props.onDrop({
      preventDefault: () => {},
      stopPropagation: () => {},
      dataTransfer: { files: [invalidFile] },
    });
    await new Promise((r) => setTimeout(r, 10));
  });

  const text = flatText(renderer.root);
  assert.ok(text.includes('Formato non supportato'), 'Deve mostrare errore di formato non supportato');
});

// ---------------------------------------------------------------------------
// 5. drop NON avvia automaticamente analyzeCircular
// ---------------------------------------------------------------------------

test('5. Drop del file NON avvia automaticamente l\'analisi (rimane in attesa del click)', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ success: true, items: [] }));
  }) as typeof fetch;

  try {
    let renderer: any;
    await act(async () => {
      renderer = create(
        React.createElement(CircularAnalyzerModal, {
          isOpen: true,
          onClose: () => {},
          profile,
          onImportEvents: () => {},
          initialFile: null,
        })
      );
    });

    const dropZone = renderer.root.findByProps({ htmlFor: 'circular-file-input' });
    const file = createMockFile('circolare.pdf', 'application/pdf', 1024);

    await act(async () => {
      dropZone.props.onDrop({
        preventDefault: () => {},
        stopPropagation: () => {},
        dataTransfer: { files: [file] },
      });
      await new Promise((r) => setTimeout(r, 50));
    });

    assert.equal(fetchCalled, false, 'Nessuna chiamata fetch deve partire in automatico dopo il drop');
    const text = flatText(renderer.root);
    assert.ok(text.includes('Analizza documento nel cloud'), 'Il pulsante di analisi manuale deve essere visibile e pronto');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 6. più file -> viene processato solo il primo
// ---------------------------------------------------------------------------

test('6. Se vengono trascinati più file contemporaneamente, viene processato solo il primo', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: null,
      })
    );
  });

  const dropZone = renderer.root.findByProps({ htmlFor: 'circular-file-input' });
  const file1 = createMockFile('primo-file.pdf', 'application/pdf', 1024);
  const file2 = createMockFile('secondo-file.pdf', 'application/pdf', 2048);

  await act(async () => {
    dropZone.props.onDrop({
      preventDefault: () => {},
      stopPropagation: () => {},
      dataTransfer: { files: [file1, file2] },
    });
    await new Promise((r) => setTimeout(r, 10));
  });

  const text = flatText(renderer.root);
  assert.ok(text.includes('primo-file.pdf'), 'Il primo file deve essere caricato');
  assert.ok(!text.includes('secondo-file.pdf'), 'Il secondo file non deve sovrascrivere o essere caricato');
});

// ---------------------------------------------------------------------------
// 7. dragOver esegue preventDefault e attiva il feedback visivo
// ---------------------------------------------------------------------------

test('7. onDragOver esegue preventDefault e attiva lo stile visivo di drag-over', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: null,
      })
    );
  });

  let dropZone = renderer.root.findByProps({ htmlFor: 'circular-file-input' });
  assert.ok(!dropZone.props.className.includes('ring-amber-400'), 'Inizialmente non ha lo stile di drag-over');

  let prevented = false;
  let stopped = false;
  await act(async () => {
    dropZone.props.onDragOver({
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    });
  });

  assert.equal(prevented, true, 'onDragOver deve chiamare preventDefault');
  assert.equal(stopped, true, 'onDragOver deve chiamare stopPropagation');

  dropZone = renderer.root.findByProps({ htmlFor: 'circular-file-input' });
  assert.ok(dropZone.props.className.includes('ring-amber-400'), 'Dopo onDragOver deve applicare lo stile evidenziato');

  // onDragLeave ripristina lo stile normale
  await act(async () => {
    dropZone.props.onDragLeave({
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  });

  dropZone = renderer.root.findByProps({ htmlFor: 'circular-file-input' });
  assert.ok(!dropZone.props.className.includes('ring-amber-400'), 'Dopo onDragLeave lo stile torna normale');
});

// ---------------------------------------------------------------------------
// 8. nessun file -> nessun crash
// ---------------------------------------------------------------------------

test('8. Drop senza file (dataTransfer.files vuoto) non causa crash né altera lo stato', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: null,
      })
    );
  });

  const dropZone = renderer.root.findByProps({ htmlFor: 'circular-file-input' });

  await act(async () => {
    dropZone.props.onDrop({
      preventDefault: () => {},
      stopPropagation: () => {},
      dataTransfer: { files: [] },
    });
    await new Promise((r) => setTimeout(r, 10));
  });

  const text = flatText(renderer.root);
  assert.ok(text.includes('Trascina o seleziona il PDF'), 'La drop zone resta nello stato iniziale pronto');
});
