import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { DocumentScannerModal, type CircularFileInfo } from '../src/components/DocumentScannerModal';
import { CircularAnalyzerModal } from '../src/components/CircularAnalyzerModal';
import type { TeacherProfile } from '../src/types';
import { installSignedInAnalysisClient } from './helpers/analysisClientSession';
installSignedInAnalysisClient();


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalFetch = globalThis.fetch;

const createdUrls: string[] = [];
const revokedUrls: string[] = [];
const fetchCalls: Array<{ url: string; body: any }> = [];

let fetchHandler: (url: string, init?: RequestInit) => Promise<Response> = async () => {
  return new Response(JSON.stringify({
    success: true,
    source: 'server',
    items: [
      {
        title: 'Collegio docenti',
        category: 'collegio_docenti',
        date: '2026-10-01',
        startTime: '15:00',
        endTime: '17:00',
        relevance: 'VERDE',
      },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

before(() => {
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:test-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let parsedBody: any = undefined;
    if (init?.body && typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {}
    }
    fetchCalls.push({ url, body: parsedBody });
    return fetchHandler(url, init);
  }) as typeof fetch;
});

after(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  createdUrls.length = 0;
  revokedUrls.length = 0;
  fetchCalls.length = 0;
  fetchHandler = async () => {
    return new Response(JSON.stringify({
      success: true,
      source: 'server',
      items: [
        {
          title: 'Collegio docenti',
          category: 'collegio_docenti',
          date: '2026-10-01',
          startTime: '15:00',
          endTime: '17:00',
          relevance: 'VERDE',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});

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

// ---------------------------------------------------------------------------
// A. SCANNER & PREVIEW CIRCOLARE
// ---------------------------------------------------------------------------

test('1. Scanner: selezione file e visualizzazione preview NON avviano alcuna analisi', async () => {
  let handoff: CircularFileInfo | null = null;
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(DocumentScannerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        students: [],
        timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: 60, customSlots: [] } as any,
        provisionalTimetable: [],
        definitiveTimetable: [],
        onOpenCircularWithFile: (info) => { handoff = info; },
        onSaveReconstructedTimetable: () => {},
        onImportStudentCommitments: () => {},
      })
    );
  });

  // Seleziona tipo documento "circolare"
  const circularTypeBtn = renderer.root.findByProps({ id: 'scan-type-circolare' });
  await act(async () => { circularTypeBtn.props.onClick(); });

  // Seleziona fotocamera/file
  const cameraInput = renderer.root.findByProps({ 'aria-label': 'Scatta foto del documento' });
  const file = new File([new Uint8Array([1, 2, 3])], 'circolare_test.jpg', { type: 'image/jpeg' });
  await act(async () => {
    cameraInput.props.onChange({ target: { files: [file], value: 'pending' } });
    await new Promise(r => setTimeout(r, 10));
  });

  // Preview visibile
  const ctaBtn = renderer.root.findByProps({ id: 'scan-analyze-cta' });
  assert.ok(ctaBtn, 'Il pulsante CTA preview deve essere presente');
  assert.equal(fetchCalls.length, 0, 'Nessuna chiamata di analisi durante selezione e preview');
  assert.equal(handoff, null, 'Nessun handoff avvenuto prima del click');
});

test('2. Scanner preview circolare: testo pulsante è "Analizza nel cloud"', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(DocumentScannerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        students: [],
        timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: 60, customSlots: [] } as any,
        provisionalTimetable: [],
        definitiveTimetable: [],
        onOpenCircularWithFile: () => {},
        onSaveReconstructedTimetable: () => {},
        onImportStudentCommitments: () => {},
      })
    );
  });

  await act(async () => {
    renderer.root.findByProps({ id: 'scan-type-circolare' }).props.onClick();
  });

  const file = new File([new Uint8Array([1, 2, 3])], 'circolare_doc.pdf', { type: 'application/pdf' });
  const fileInput = renderer.root.findByProps({ 'aria-label': 'Scegli foto o file' });
  await act(async () => {
    fileInput.props.onChange({ target: { files: [file], value: 'pending' } });
    await new Promise(r => setTimeout(r, 10));
  });

  const ctaBtn = renderer.root.findByProps({ id: 'scan-analyze-cta' });
  assert.equal(flatText(ctaBtn), 'Analizza nel cloud', 'Il testo del pulsante CTA per le circolari deve essere "Analizza nel cloud"');
});

test('3. Scanner preview click: produce handoff con file e autoStartToken monouso', async () => {
  let receivedHandoff: CircularFileInfo | null = null;
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(DocumentScannerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        students: [],
        timeSlotConfig: { firstHourStartTime: '08:00', periodsPerDay: 5, standardDurationMinutes: 60, customSlots: [] } as any,
        provisionalTimetable: [],
        definitiveTimetable: [],
        onOpenCircularWithFile: (info) => { receivedHandoff = info; },
        onSaveReconstructedTimetable: () => {},
        onImportStudentCommitments: () => {},
      })
    );
  });

  await act(async () => {
    renderer.root.findByProps({ id: 'scan-type-circolare' }).props.onClick();
  });

  const file = new File([new Uint8Array([65, 66, 67])], 'circolare_scuola.png', { type: 'image/png' });
  const fileInput = renderer.root.findByProps({ 'aria-label': 'Scegli foto o file' });
  await act(async () => {
    fileInput.props.onChange({ target: { files: [file], value: 'pending' } });
    await new Promise(r => setTimeout(r, 10));
  });

  const ctaBtn = renderer.root.findByProps({ id: 'scan-analyze-cta' });
  await act(async () => {
    ctaBtn.props.onClick();
  });

  assert.ok(receivedHandoff, 'L\'handoff deve essere stato chiamato');
  assert.equal((receivedHandoff as any).fileName, 'circolare_scuola.png');
  assert.equal((receivedHandoff as any).mimeType, 'image/png');
  assert.ok((receivedHandoff as any).base64, 'Base64 deve essere presente');
  assert.ok(typeof (receivedHandoff as any).autoStartToken === 'string' && (receivedHandoff as any).autoStartToken.startsWith('circ-auto-'), 'autoStartToken valido generato');
});

// ---------------------------------------------------------------------------
// B. APERTURA NORMALE DI CIRCULARANALYZERMODAL (NESSUN TOKEN)
// ---------------------------------------------------------------------------

test('4. Apertura normale senza token: nessuna analisi automatica, flusso manuale invariato', async () => {
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

  assert.equal(fetchCalls.length, 0, 'Nessuna chiamata automatica all\'apertura normale');
  assert.ok(flatText(renderer.root).includes('Analizzatore Intelligente di Circolari'));

  // Passa alla modalità "Incolla Testo Circolare"
  const allButtons = renderer.root.findAll((el: any) => el.type === 'button');
  const textTabBtn = allButtons.find((el: any) => flatText(el).toLowerCase().includes('incolla testo'));
  assert.ok(textTabBtn, 'Pulsante tab Incolla Testo deve essere presente');

  await act(async () => {
    textTabBtn.props.onClick();
  });

  const textarea = renderer.root.findByType('textarea');
  await act(async () => {
    textarea.props.onChange({ target: { value: '15/10/2026 Riunione dipartimento ore 16:00-18:00' } });
  });

  const runBtn = renderer.root.findByProps({ id: 'btn-run-analysis' });
  await act(async () => {
    runBtn.props.onClick();
    await new Promise(r => setTimeout(r, 50));
  });

  assert.equal(fetchCalls.length, 1, 'Analisi manuale eseguita');
  assert.equal(fetchCalls[0].url, '/api/analyze-circular');
});

// ---------------------------------------------------------------------------
// C. AUTOSTART CON TOKEN
// ---------------------------------------------------------------------------

test('5. initialFile con autoStartToken: esegue automaticamente UNA SOLA analisi', async () => {
  const token = `test-token-${Date.now()}-1`;
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'QUJD',
          mimeType: 'image/jpeg',
          fileName: 'circolare_auto.jpg',
          autoStartToken: token,
        },
      })
    );
    await new Promise(r => setTimeout(r, 100));
  });

  assert.equal(fetchCalls.length, 1, 'Esattamente una richiesta inviata automaticamente');
  assert.equal(fetchCalls[0].url, '/api/analyze-circular');
  assert.equal(fetchCalls[0].body.imageBase64, 'QUJD');

  // Risultati mostrati: cerca input titolo o badge di pertinenza
  const titleInputs = renderer.root.findAll((el: any) => el.type === 'input' && el.props?.value === 'Collegio docenti');
  assert.ok(titleInputs.length > 0, 'I risultati estratti devono essere mostrati');
});

test('6. Re-render e simulazione React StrictMode con lo STESSO token: nessuna seconda analisi', async () => {
  const token = `test-strict-token-${Date.now()}`;
  let renderer: any;

  // Primo montaggio
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'QUJD',
          mimeType: 'application/pdf',
          fileName: 'doc.pdf',
          autoStartToken: token,
        },
      })
    );
    await new Promise(r => setTimeout(r, 100));
  });

  assert.equal(fetchCalls.length, 1, 'Prima analisi partita');

  // Rerender con le stesse props
  await act(async () => {
    renderer.update(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'QUJD',
          mimeType: 'application/pdf',
          fileName: 'doc.pdf',
          autoStartToken: token,
        },
      })
    );
    await new Promise(r => setTimeout(r, 50));
  });

  assert.equal(fetchCalls.length, 1, 'Il re-render non deve scatenare una seconda analisi');

  // Simulazione rimontaggio StrictMode con nuova istanza per lo stesso token già consumato
  let rendererStrictMode: any;
  await act(async () => {
    rendererStrictMode = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'QUJD',
          mimeType: 'application/pdf',
          fileName: 'doc.pdf',
          autoStartToken: token,
        },
      })
    );
    await new Promise(r => setTimeout(r, 50));
  });

  assert.equal(fetchCalls.length, 1, 'La nuova istanza riconosce il token monouso già consumato e non rilancia');
});

test('7. Chiusura e riapertura con lo stesso token non rilanciano l\'analisi', async () => {
  const token = `test-reopen-token-${Date.now()}`;
  let renderer: any;

  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'QUJD',
          mimeType: 'image/jpeg',
          fileName: 'doc.jpg',
          autoStartToken: token,
        },
      })
    );
    await new Promise(r => setTimeout(r, 100));
  });

  assert.equal(fetchCalls.length, 1);

  // Chiusura
  await act(async () => {
    renderer.update(
      React.createElement(CircularAnalyzerModal, {
        isOpen: false,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'QUJD',
          mimeType: 'image/jpeg',
          fileName: 'doc.jpg',
          autoStartToken: token,
        },
      })
    );
  });

  // Riapertura con stesso initialFile
  await act(async () => {
    renderer.update(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'QUJD',
          mimeType: 'image/jpeg',
          fileName: 'doc.jpg',
          autoStartToken: token,
        },
      })
    );
    await new Promise(r => setTimeout(r, 50));
  });

  assert.equal(fetchCalls.length, 1, 'Nessuna analisi ripetuta alla riapertura con token già consumato');
});

test('8. Nuovo handoff con NUOVO token: esegue una nuova singola analisi', async () => {
  const token1 = `test-handoff-1-${Date.now()}`;
  const token2 = `test-handoff-2-${Date.now()}`;
  let renderer: any;

  // Primo handoff
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'QUJD',
          mimeType: 'image/png',
          fileName: 'doc1.png',
          autoStartToken: token1,
        },
      })
    );
    await new Promise(r => setTimeout(r, 100));
  });

  assert.equal(fetchCalls.length, 1, 'Primo handoff eseguito');

  // Secondo handoff successivo con nuovo token
  await act(async () => {
    renderer.update(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'WFla',
          mimeType: 'application/pdf',
          fileName: 'doc2.pdf',
          autoStartToken: token2,
        },
      })
    );
    await new Promise(r => setTimeout(r, 100));
  });

  assert.equal(fetchCalls.length, 2, 'Secondo handoff con nuovo token eseguito esattamente una volta');
  assert.equal(fetchCalls[1].body.imageBase64, 'WFla');
});

// ---------------------------------------------------------------------------
// D. ERRORI & NESSUN RETRY AUTOMATICO
// ---------------------------------------------------------------------------

test('9. Analisi fallita: mostra errore, nessun retry automatico', async () => {
  fetchHandler = async () => {
    return new Response(JSON.stringify({
      success: false,
      error: 'Il documento non è stato elaborato dal servizio AI. Riprova tra poco.',
      errorCode: 'AI_UNAVAILABLE',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  };

  const token = `test-fail-token-${Date.now()}`;
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => {},
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'QUJD',
          mimeType: 'image/jpeg',
          fileName: 'fallita.jpg',
          autoStartToken: token,
        },
      })
    );
    await new Promise(r => setTimeout(r, 100));
  });

  assert.equal(fetchCalls.length, 1, 'La richiesta deve essere stata effettuata esattamente una volta');
  const text = flatText(renderer.root);
  assert.ok(text.includes('servizio AI') || text.includes('Riprova tra poco'), 'L\'errore deve essere mostrato nella UI');

  // Attendi per verificare che nessun timer/retry nascosto esegua altre chiamate
  await act(async () => {
    await new Promise(r => setTimeout(r, 100));
  });
  assert.equal(fetchCalls.length, 1, 'Nessun retry automatico scatenato');
});

// ---------------------------------------------------------------------------
// E. RISPOSTA ASINCRONA TARDIVA DOPO CHIUSURA / CAMBIO INPUT
// ---------------------------------------------------------------------------

test('10. Risposta asincrona arrivata dopo chiusura del modal: non aggiorna lo stato', async () => {
  let resolvePromise: ((value: Response) => void) | null = null;
  fetchHandler = () => new Promise<Response>((resolve) => {
    resolvePromise = resolve;
  });

  const token = `test-deferred-token-${Date.now()}`;
  let renderer: any;
  let closed = false;

  await act(async () => {
    renderer = create(
      React.createElement(CircularAnalyzerModal, {
        isOpen: true,
        onClose: () => { closed = true; },
        profile,
        onImportEvents: () => {},
        initialFile: {
          base64: 'QUJD',
          mimeType: 'image/jpeg',
          fileName: 'tardiva.jpg',
          autoStartToken: token,
        },
      })
    );
    await new Promise(r => setTimeout(r, 10));
  });

  assert.equal(fetchCalls.length, 1, 'Richiesta partita');

  // Utente chiude il modal prima che arrivi la risposta
  const buttons = renderer.root.findAll((el: any) => el.type === 'button');
  const closeBtn = buttons.find((el: any) => el.props?.className?.includes('text-stone-400') || el.children?.some((c: any) => c?.props?.className?.includes('w-5 h-5')));
  assert.ok(closeBtn, 'Pulsante chiudi deve essere presente');
  await act(async () => {
    closeBtn.props.onClick();
  });
  assert.equal(closed, true, 'Callback onClose invocata');

  // Simula risposta arrivata dopo la chiusura
  await act(async () => {
    if (resolvePromise) {
      resolvePromise(new Response(JSON.stringify({
        success: true,
        source: 'server',
        items: [{ title: 'Impegno Tardivo', category: 'riunione', date: '2026-10-01', startTime: '10:00', endTime: '11:00', relevance: 'VERDE' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    await new Promise(r => setTimeout(r, 50));
  });

  // Verifica che il modal non sia passato a step 'results' con gli impegni tardivi
  const titleInputs = renderer.root.findAll((el: any) => el.type === 'input' && el.props?.value === 'Impegno Tardivo');
  assert.equal(titleInputs.length, 0, 'Lo stato non deve contenere i risultati elaborati dopo la chiusura');
});
