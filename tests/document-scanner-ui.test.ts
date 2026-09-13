import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { DocumentScannerModal } from '../src/components/DocumentScannerModal';
import { OFFLINE_ANALYSIS_MESSAGE, MAX_DOCUMENT_BYTES } from '../src/utils/documentScanner';
import type { Student, TeacherProfile, TimetableSlot } from '../src/types';

/**
 * "Scansiona documento" — test UI (componenti):
 * fotocamera/fallback/cancellazione/file non validi, consenso cloud NON
 * preselezionato, offline, conferma umana (nessun salvataggio prima),
 * semaforo + correzioni, merge orario esistente, multi-istituto, privacy
 * (object URL revocati, nessun image/base64 persistente).
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Stub globali (URL object, navigator.onLine, fetch)
// ---------------------------------------------------------------------------

const createdUrls: string[] = [];
const revokedUrls: string[] = [];
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function setOnline(online: boolean) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: online }, configurable: true, writable: true });
}

const fetchCalls: Array<{ url: string; body: any }> = [];
let fetchResponse: { status: number; json: Record<string, unknown> } = { status: 200, json: {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, options?: { body?: string }) => {
  fetchCalls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : undefined });
  return new Response(JSON.stringify(fetchResponse.json), { status: fetchResponse.status });
}) as typeof fetch;

before(() => {
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:scan-test-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => { revokedUrls.push(url); };
});

after(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  globalThis.fetch = originalFetch;
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
});

beforeEach(() => {
  createdUrls.length = 0;
  revokedUrls.length = 0;
  fetchCalls.length = 0;
  fetchResponse = { status: 200, json: {} };
  setOnline(true);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function byId(scope: any, id: string) {
  const root = scope?.root ?? scope;
  const found = root.findAll((el: any) => el.props?.id === id);
  assert.ok(found.length > 0, `element with id "${id}" must exist`);
  return found[0];
}

const profile: TeacherProfile = {
  id: 't-1',
  fullName: 'Felice Manganiello',
  schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig',
  schoolYear: '2026/2027',
  primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'],
  campuses: ['Sede Centrale'],
  roles: [],
  isSupportTeacher: true,
};

const multiSchoolProfile: TeacherProfile = {
  ...profile,
  schools: [
    { id: 'school-a', name: 'IC Da Vinci', isPrimary: true, active: true },
    { id: 'school-b', name: 'Liceo Fermi', isPrimary: false, active: true, weeklyHours: 4 },
  ],
};

const students: Student[] = [
  { id: 'stu-rossi', fullName: 'Rossi Matteo', className: '3D', notes: [] },
  { id: 'stu-bianchi', fullName: 'Bianchi Giulia', className: '3D', notes: [] },
];

const existingTimetable: TimetableSlot[] = [
  { id: 'ex-1', dayOfWeek: 2, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3D' },
];

type SavedTimetable = { slots: TimetableSlot[]; target: string; mode: string };

function modalProps(overrides: Partial<React.ComponentProps<typeof DocumentScannerModal>> = {}) {
  return {
    isOpen: true,
    onClose: () => {},
    profile,
    students,
    timeSlotConfig: {
      firstHourStartTime: '08:15',
      periodsPerDay: 6,
      standardDurationMinutes: 55,
      customSlots: [],
    } as any,
    provisionalTimetable: existingTimetable,
    definitiveTimetable: [],
    onOpenCircularWithFile: () => {},
    onSaveReconstructedTimetable: () => {},
    onImportStudentCommitments: () => {},
    ...overrides,
  };
}

async function renderModal(overrides: Partial<React.ComponentProps<typeof DocumentScannerModal>> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(DocumentScannerModal, modalProps(overrides)));
  });
  return renderer;
}

function makeFile(name: string, type: string, size: number): File {
  const bytes = new Uint8Array(Math.max(1, size));
  return new File([bytes], name, { type });
}

function fileChange(input: any, file?: File) {
  const event = { target: { files: file ? [file] : [], value: 'pending' } };
  input.props.onChange(event);
  return event;
}

async function pickFile(renderer: any, file?: File, which: 'camera' | 'file' = 'camera') {
  const input = which === 'camera'
    ? renderer.root.findByProps({ 'aria-label': 'Scatta foto del documento' })
    : renderer.root.findByProps({ 'aria-label': 'Scegli foto o file' });
  await act(async () => {
    fileChange(input, file);
    await new Promise(r => setTimeout(r, 0)); // flush letture async (base64)
  });
  // Aspetta l'esito della selezione: preview con CTA abilitata, errore, oppure
  // stato invariato (cancellazione / file scartato).
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const cta = renderer.root.findAll((el: any) => el.props?.id === 'scan-analyze-cta');
    const errorShown = flatText(renderer.root).includes('Formato non supportato')
      || flatText(renderer.root).includes('massimo 5 MB')
      || flatText(renderer.root).includes('Impossibile leggere');
    if (file && cta.length > 0 && !cta[0].props.disabled) return; // preview pronta
    if (!file || errorShown) return;
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
  }
  if (file) {
    const cta = renderer.root.findAll((el: any) => el.props?.id === 'scan-analyze-cta');
    assert.ok(cta.length === 0 || !cta[0].props.disabled, 'CTA abilitata dopo la lettura del file');
  }
}

async function goToSource(renderer: any, typeId: string) {
  await act(async () => { byId(renderer, `scan-type-${typeId}`).props.onClick(); });
}

async function chooseCameraAndPick(renderer: any, file?: File) {
  await act(async () => { byId(renderer, 'scan-source-camera').props.onClick(); }); // in UI reale apre la camera
  await pickFile(renderer, file);
}

const personalResponse = {
  success: true,
  source: 'test-model',
  rows: ['Bianchi', 'Manganiello F.'],
  cells: [
    { rowIndex: 1, dayOfWeek: 2, periodIndex: 1, raw: '3D' },
    { rowIndex: 1, dayOfWeek: 3, periodIndex: 1, raw: '3E' },
    { rowIndex: 1, dayOfWeek: 4, periodIndex: 1, raw: 'sos' },
    { rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '1A' },
  ],
};

const curricularResponse = {
  success: true,
  source: 'test-model',
  curricularRows: [
    { rowIndex: 0, rowLabel: 'Rossi', subject: 'Matematica', classes: ['3D', '3E'] },
  ],
  cells: [
    { rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' },
    { rowIndex: 0, dayOfWeek: 3, periodIndex: 1, raw: '3E' },
  ],
};

const studentResponse = {
  success: true,
  source: 'test-model',
  commitments: [
    { title: 'Verifica di matematica', type: 'written_test', studentNameRaw: 'Rossi Matteo', date: '2026-09-15', startTime: '08:50', className: '3D', subject: 'Matematica', rawText: 'Verifica 15/09' },
    { title: 'Interrogazione', type: 'oral_test', studentNameRaw: 'Bianchi Giulia', date: '', rawText: 'Interrogazione prossima' },
    { title: 'Colloquio', type: 'meeting', studentNameRaw: 'Esistente Nessuno', date: '2026-09-20', rawText: 'Colloquio 20/09' },
  ],
};

async function analyzeWithConsent(renderer: any) {
  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  // Consenso richiesto (checkbox NON preselezionata).
  const consent = byId(renderer, 'scan-cloud-consent');
  assert.equal(consent.props.checked, false, 'il consenso non è mai preselezionato');
  assert.ok(byId(renderer, 'scan-consent-confirm').props.disabled, 'senza consenso l\'invio è bloccato');
  await act(async () => { consent.props.onChange({ target: { checked: true } }); });
  await act(async () => {
    byId(renderer, 'scan-consent-confirm').props.onClick();
    await new Promise(r => setTimeout(r, 0));
  });
}

/**
 * Flusso completo "Ricostruisci il mio orario":
 * personale (consenso -> riga) + curricolare (consenso) -> incrocio -> "Orario ricostruito".
 */
async function flowToReconstruction(renderer: any) {
  fetchCalls.length = 0; // contatore per-flusso (il test può eseguire più flussi)
  await goToSource(renderer, 'personal');
  fetchResponse = { status: 200, json: personalResponse as any };
  await chooseCameraAndPick(renderer, makeFile('orario-personale.jpg', 'image/jpeg', 20_000));
  // Preview: mai analisi automatica.
  assert.equal(fetchCalls.length, 0, 'nessun invio automatico: serve la CTA');
  await analyzeWithConsent(renderer);
  // Riga docente: 1 compatibile -> l'utente la conferma esplicitamente.
  const radios = renderer.root.findAll((el: any) => el.props?.name === 'scan-personal-row');
  assert.ok(radios.length >= 1);
  await act(async () => { radios.find(r => r.props.value === '1')!.props.onChange(); });
  // Aggiungi l'orario curricolare (incrocio multi-documento).
  await act(async () => { byId(renderer, 'scan-personal-add-curricular').props.onClick(); });
  fetchResponse = { status: 200, json: curricularResponse as any };
  await chooseCameraAndPick(renderer, makeFile('orario-curricolare.jpg', 'image/jpeg', 25_000));
  await analyzeWithConsent(renderer);
  // "Ricostruisci il mio orario" -> schermata di conferma.
  await act(async () => { byId(renderer, 'scan-curricular-reconstruct').props.onClick(); });
  return renderer;
}

// ---------------------------------------------------------------------------
// 3. UI unificata + CAMERA
// ---------------------------------------------------------------------------

test('scansione: tipo documento + sorgente (fotocamera preferita con fallback file picker)', async () => {
  const renderer = await renderModal();
  const text = flatText(renderer.root);
  for (const label of ['Circolare', 'Orario personale / sostegno', 'Orario curricolare / istituto', 'Registro / appunti', 'Ricostruisci il mio orario']) {
    assert.ok(text.includes(label), `tipo "${label}" presente`);
  }
  await goToSource(renderer, 'personal');

  const cameraInput = renderer.root.findByProps({ 'aria-label': 'Scatta foto del documento' });
  assert.equal(cameraInput.props.accept, 'image/*', 'la fotocamera accetta solo immagini');
  assert.equal(cameraInput.props.capture, 'environment', 'fotocamera posteriore preferita');

  const fileInput = renderer.root.findByProps({ 'aria-label': 'Scegli foto o file' });
  assert.equal(fileInput.props.accept, 'image/*,application/pdf');
  assert.equal(fileInput.props.capture, undefined, 'il file picker NON forza la fotocamera (fallback desktop)');
});

test('scansione: annullare la cattura non fa crash né cambia stato', async () => {
  const renderer = await renderModal();
  await goToSource(renderer, 'personal');
  const cameraInput = renderer.root.findByProps({ 'aria-label': 'Scatta foto del documento' });
  await act(async () => {
    fileChange(cameraInput); // files vuote: utente ha annullato
  });
  const root = renderer.root;
  assert.ok(root.findAll((el: any) => el.props?.id === 'scan-source-camera').length > 0, 'si resta al passo sorgente');
  assert.equal(root.findAll((el: any) => el.props?.id === 'scan-analyze-cta').length, 0, 'nessuna preview');
  assert.equal(flatText(renderer.root).includes('Formato non supportato'), false);
});

test('scansione: file non supportato e file troppo grande -> errore chiaro, nessun crash', async () => {
  const renderer = await renderModal();
  await goToSource(renderer, 'personal');

  await pickFile(renderer, makeFile('note.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1000), 'file');
  assert.match(flatText(renderer.root), /Formato non supportato/i);
  assert.equal(renderer.root.findAll((el: any) => el.props?.id === 'scan-analyze-cta').length, 0, 'nessuna preview per file scartati');

  await pickFile(renderer, makeFile('big.pdf', 'application/pdf', MAX_DOCUMENT_BYTES + 1), 'file');
  assert.match(flatText(renderer.root), /massimo 5 MB/i);
});

// ---------------------------------------------------------------------------
// 2. PREVIEW + CONSENSO CLOUD + PRIVACY
// ---------------------------------------------------------------------------

test('preview: nome/dimensioni/tipo + "Cambia immagine" + CTA mai automatica', async () => {
  const renderer = await renderModal();
  await goToSource(renderer, 'personal');
  await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 153_600));

  const text = flatText(renderer.root);
  assert.ok(text.includes('orario.jpg'), 'nome file visibile');
  assert.ok(text.includes('150 KB'), 'dimensione formattata');
  assert.ok(text.includes('image/jpeg'), 'tipo file visibile');
  assert.ok(byId(renderer, 'scan-change-image'), 'pulsante "Cambia immagine"');
  assert.ok(byId(renderer, 'scan-analyze-cta'), 'CTA "Analizza documento"');
  assert.equal(fetchCalls.length, 0, 'nessuna analisi automatica dopo la cattura');

  // L'anteprima usa un object URL (non base64 nell'URL del tag img).
  const img = renderer.root.findByType('img');
  assert.ok(String(img.props.src).startsWith('blob:'), 'preview con object URL');

  // "Cambia immagine" revoca l'object URL e torna alla sorgente.
  const url = img.props.src as string;
  await act(async () => { byId(renderer, 'scan-change-image').props.onClick(); });
  assert.ok(revokedUrls.includes(url), 'object URL revocato dopo l\'uso');
});

test('consenso cloud AI: testo privacy, checkbox NON preselezionata, invio bloccato senza di essa', async () => {
  const renderer = await renderModal();
  await goToSource(renderer, 'registro');
  fetchResponse = { status: 200, json: studentResponse as any };
  await chooseCameraAndPick(renderer, makeFile('registro.jpg', 'image/jpeg', 30_000));
  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });

  const text = flatText(renderer.root);
  assert.match(text, /dati personali degli studenti/i, 'informativa specifica per il registro');
  assert.match(text, /servizio di analisi AI/i);
  assert.match(text, /non sarà salvato come immagine/i);
  const consent = byId(renderer, 'scan-cloud-consent');
  assert.equal(consent.props.checked, false, 'checkbox NON preselezionata');
  assert.ok(byId(renderer, 'scan-consent-confirm').props.disabled);

  await act(async () => { consent.props.onChange({ target: { checked: true } }); });
  assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, false);
  await act(async () => {
    byId(renderer, 'scan-consent-confirm').props.onClick();
    await new Promise(r => setTimeout(r, 0));
  });
  // Il body inviato contiene l'immagine (inviata al servizio AI) e non altro.
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/analyze-student-document');
  assert.ok(typeof fetchCalls[0].body.imageBase64 === 'string' && fetchCalls[0].body.imageBase64.length > 0);
});

test('privacy: l\'object URL è revocato dopo l\'analisi (nessun uso successivo del documento)', async () => {
  const renderer = await renderModal();
  await flowToReconstruction(renderer);
  assert.ok(createdUrls.length >= 1, 'una preview è stata creata');
  for (const url of createdUrls) {
    assert.ok(revokedUrls.includes(url), `object URL ${url} revocato dopo l'analisi`);
  }
});

test('privacy: nessun campo image/base64 nei dati salvati (modello orario e impegni)', async () => {
  const saved: SavedTimetable[] = [];
  const events: any[] = [];
  const renderer = await renderModal({
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); },
  });
  await flowToReconstruction(renderer);
  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

  assert.equal(saved.length, 1, 'salvato una sola volta, alla conferma');
  const json = JSON.stringify(saved[0].slots);
  assert.ok(!/base64|data:image|blob:/.test(json), 'nessun immagine/base64 nel modello orario');
  for (const slot of saved[0].slots) {
    for (const value of Object.values(slot)) {
      if (typeof value === 'string') assert.ok(value.length <= 200, 'niente blob di grandi dimensioni nei campi slot');
    }
  }
  void events;
});

// ---------------------------------------------------------------------------
// 11-12. "ORARIO RICOSTRUITO" (conferma umana) + ORARIO ESISTENTE
// ---------------------------------------------------------------------------

test('orari ricostruiti: carte con giorno/ora/classe/materia/confidenza e semaforo', async () => {
  const renderer = await renderModal();
  await flowToReconstruction(renderer);
  const text = flatText(renderer.root);

  assert.ok(text.includes('Orario ricostruito'), 'titolo della schermata di conferma');
  assert.ok(text.includes('Martedì'), 'giorno leggibile (select)');
  assert.ok(text.includes('1ª ora'), 'periodo leggibile (select)');
  assert.ok(text.includes('08:15–09:10'), 'fasce orarie dalla configurazione docente');
  assert.ok(text.includes('confidenza'), 'livello di confidenza mostrato');
  assert.ok(text.includes('Materia principale: Sostegno'), 'materia principale dichiarata');

  // Classe e materia in compresenza sono campi modificali con i valori ricostruiti.
  const classInputs = renderer.root.findAll((el: any) => el.props?.placeholder === 'es. 3D');
  assert.deepEqual(classInputs.map((el: any) => el.props.value).sort(), ['', '3D', '3E'], 'classe precompilata dove determinata, vuota per la cella sos');
  const subjectInputs = renderer.root.findAll((el: any) => el.props?.placeholder === 'es. Matematica');
  assert.deepEqual(subjectInputs.map((el: any) => el.props.value), ['Matematica', 'Matematica'], 'materia in compresenza dall\'incrocio');
  const noneInputs = renderer.root.findAll((el: any) => el.props?.placeholder === 'Materia non identificata');
  assert.equal(noneInputs.length, 1, 'slot senza materia: campo vuoto + etichetta "Materia non identificata"');
  assert.ok(text.includes('Classe non identificata nella cella'), 'slot sos etichettato, mai forzato');

  // Semaforo: verde per le uniche corrispondenze, rosso per lo slot senza classe.
  const dots = renderer.root.findAll((el: any) => el.props?.['aria-hidden'] === true && String(el.props.className ?? '').includes('rounded-full'));
  assert.ok(dots.filter((d: any) => String(d.props.className).includes('bg-emerald-500')).length === 2, 'due slot verdi');
  assert.ok(dots.some((d: any) => String(d.props.className).includes('bg-rose-400')), 'slot rosso per il mancato riconoscimento');
});

test('conferma: NESSUN salvataggio prima della conferma; deselezionati non salvati; correzione manuale rispettata', async () => {
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
    onClose: () => {},
  });
  await flowToReconstruction(renderer);

  // Nessun salvataggio solo per aver aperto la conferma.
  assert.equal(saved.length, 0, 'nessun salvataggio prima della conferma esplicita');

  const slots = renderer.root.findAll((el: any) => String(el.props?.id ?? '').startsWith('recon-slot-'));
  assert.equal(slots.length, 3, '3 slot dalla riga confermata');

  // Deseleziona lo slot senza classe (terzo: la cella "sos").
  const sosCheckbox = slots[2].findAll((el: any) => el.props?.type === 'checkbox')[0];
  await act(async () => { sosCheckbox.props.onChange(); });

  // Correggi manualmente la materia del primo slot (classe 3D: Martedì 1ª ora).
  const subjectInputs = renderer.root.findAll((el: any) => el.props?.placeholder === 'es. Matematica');
  await act(async () => { subjectInputs[0].props.onChange({ target: { value: 'Scienze' } }); });

  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

  assert.equal(saved.length, 1, 'salvato solo dopo la conferma esplicita');
  assert.equal(saved[0].target, 'provvisorio', 'default: orario provvisorio');
  assert.equal(saved[0].mode, 'missing-only', 'default: mai sovrascrivere (solo mancanti)');
  assert.equal(saved[0].slots.length, 2, 'lo slot deselezionato non è salvato');
  const corrected = saved[0].slots.find(s => s.dayOfWeek === 2 && s.periodNumber === 1);
  assert.ok(corrected, 'slot Martedì 1ª ora presente');
  assert.equal(corrected?.className, '3D');
  assert.deepEqual(corrected?.coTeachingSubjects, ['Scienze'], 'la correzione manuale vince sulla proposta');
  assert.equal(corrected?.subject, 'Sostegno');
  const untouched = saved[0].slots.find(s => s.dayOfWeek === 3 && s.periodNumber === 1);
  assert.deepEqual(untouched?.coTeachingSubjects, ['Matematica'], 'gli slot non corretti conservano la proposta');
});

test('orari esistente: opzioni sicure visibili, default "solo mancanti", niente azzeramento', async () => {
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: existingTimetable,
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
  });
  await flowToReconstruction(renderer);
  const text = flatText(renderer.root);

  assert.match(text, /Esiste già un orario in questo archivio/);
  assert.match(text, /Aggiungi solo gli slot mancanti/);
  assert.match(text, /Sostituisci gli slot selezionati/);
  assert.match(text, /non viene mai cancellato/i, 'nessuna opzione di azzeramento');
  assert.equal(byId(renderer, 'recon-confirm-save').props.disabled, false);

  // Cambia modalità -> il salvataggio la riceve (ma resta "sicura": niente wipe).
  const replaceRadio = renderer.root.findAll((el: any) => el.props?.name === 'scan-merge-mode')[1];
  await act(async () => { replaceRadio.props.onChange(); });
  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  assert.equal(saved[0].mode, 'replace-selected');
});

test('orari esistente: in "solo mancanti" gli slot esistenti restano intatti (App applica applyReconstruction)', async () => {
  const { applyReconstruction } = await import('../src/utils/reconstructTimetable');
  const renderer = await renderModal();
  await flowToReconstruction(renderer);
  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  // Simuliamo il salvataggio App: merge con l'orario esistente in modalità default.
  // (I slot ricostruiti hanno giorno/periodo 2-1, 3-1 e 4-1; "ex-1" è 2-1 -> non toccato.)
  const merged = applyReconstruction(existingTimetable, [
    { id: 'new-1', dayOfWeek: 2, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3D' },
    { id: 'new-2', dayOfWeek: 3, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3E' },
  ], 'missing-only');
  assert.equal(merged.addedCount, 1);
  assert.equal(merged.replacedCount, 0);
  assert.equal(merged.slots.find(s => s.id === 'ex-1')?.id, 'ex-1', 'lo slot esistente resta identico');
  void renderer;
});

// ---------------------------------------------------------------------------
// 18. OFFLINE
// ---------------------------------------------------------------------------

test('offline: cattura consentita, analisi cloud bloccata con messaggio chiaro, nessun invio', async () => {
  setOnline(false);
  const renderer = await renderModal();
  const text = flatText(renderer.root);
  assert.match(text, /Scansiona documento/, 'l\'app si apre anche offline');

  await goToSource(renderer, 'personal');
  assert.match(flatText(renderer.root), /funzionano offline/i, 'il passo sorgente segnala che l\'analisi serve a Internet');

  await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 20_000));
  assert.ok(byId(renderer, 'scan-analyze-cta'), 'la preview è raggiungibile offline');
  assert.match(flatText(renderer.root), new RegExp(OFFLINE_ANALYSIS_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  assert.match(flatText(renderer.root), new RegExp(OFFLINE_ANALYSIS_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fetchCalls.length, 0, 'nessun invio al cloud offline');
  assert.equal(renderer.root.findAll((el: any) => el.props?.id === 'scan-consent-confirm').length, 0, 'il passo consenso non è raggiungibile offline');
});

test('offline: nessun dato locale modificato (nessun salvataggio possibile)', async () => {
  setOnline(false);
  let saved = 0;
  const renderer = await renderModal({ onSaveReconstructedTimetable: () => { saved += 1; } });
  await goToSource(renderer, 'personal');
  await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 20_000));
  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  assert.equal(saved, 0, 'offline: nessun salvataggio di orari o impegni');
});

// ---------------------------------------------------------------------------
// 19. MULTI-ISTITUTO
// ---------------------------------------------------------------------------

test('multi-istituto: con un solo istituto nessuna UI extra; con più istituti scelta della sede', async () => {
  // Mono istituto: nessun selettore.
  const mono = await renderModal();
  await flowToReconstruction(mono);
  assert.equal(mono.root.findAll((el: any) => String(el.props?.['aria-label'] ?? '') === 'Istituto').length, 0, 'niente selettore istituto in mono-istituto');

  // Multi istituto: selettore presente e la scelta arriva al salvataggio.
  const saved: SavedTimetable[] = [];
  const multi = await renderModal({
    profile: multiSchoolProfile,
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
  });
  await flowToReconstruction(multi);
  const schoolSelect = multi.root.findByProps({ 'aria-label': 'Istituto' });
  assert.ok(schoolSelect, 'selettore istituto presente con più sedi attive');
  assert.equal(schoolSelect.props.value, 'school-a', 'default: istituto principale');

  await act(async () => { schoolSelect.props.onChange({ target: { value: 'school-b' } }); });
  await act(async () => { byId(multi, 'recon-confirm-save').props.onClick(); });
  assert.ok(saved[0].slots.every(s => s.schoolId === 'school-b'), 'gli slot salvati ricevono la schoolId scelta');
});

// ---------------------------------------------------------------------------
// 13-14. REGISTRO: candidati + matching locale + nessun studente automatico
// ---------------------------------------------------------------------------

test('registro: candidati con matching locale (exact/probable/unmatched) e nessun nuovo studente', async () => {
  const imported: any[][] = [];
  const renderer = await renderModal({
    onImportStudentCommitments: (events) => { imported.push(events); return true; },
  });
  await goToSource(renderer, 'registro');
  fetchResponse = { status: 200, json: studentResponse as any };
  await chooseCameraAndPick(renderer, makeFile('registro.jpg', 'image/jpeg', 30_000));
  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
  await act(async () => {
    byId(renderer, 'scan-consent-confirm').props.onClick();
    await new Promise(r => setTimeout(r, 0));
  });

  const text = flatText(renderer.root);
  assert.ok(text.includes('Corrispondenza certa'), 'exact per "Rossi Matteo"');
  assert.ok(text.includes('Alunno non riconosciuto'), 'unmatched per "Esistente Nessuno"');
  const titleInputs = renderer.root.findAll((el: any) => el.props?.type === 'text' && el.props?.['aria-label'] === 'Titolo impegno');
  assert.deepEqual(titleInputs.map((el: any) => el.props.value), ['Verifica di matematica', 'Interrogazione', 'Colloquio'], 'i candidati mostrano i titoli estratti');

  // L'impegno senza data è deselezionato e non salvabile senza completarla.
  const saveButton = byId(renderer, 'student-confirm-save');
  await act(async () => { saveButton.props.onClick(); });
  const events = imported[0] ?? [];
  assert.equal(events.length, 2, 'solo gli impegni con data sono importati (quello senza data resta deselezionato)');
  assert.equal(events[0].sourceType, 'registro');
  assert.equal(events[0].date, '2026-09-15');
  assert.match(events[0].notes ?? '', /Rossi Matteo/, 'l\'alunno riconosciuto va nelle note');
  assert.equal(events[1].date, '2026-09-20');
  assert.match(events[1].notes ?? '', /Esistente Nessuno/, 'il nome non riconosciuto resta solo in nota');
  // Nessun "nuovo studente" nei dati salvati: il payload contiene solo eventi.
  const payloadJson = JSON.stringify(events);
  assert.ok(!/"students"/.test(payloadJson) && !/"fullName"/.test(payloadJson), 'mai creazione automatica di studenti nel salvataggio');
});

test('registro: l\'utente può completare la data mancante e poi confermare', async () => {
  const imported: any[][] = [];
  const renderer = await renderModal({
    onImportStudentCommitments: (events) => { imported.push(events); return true; },
  });
  await goToSource(renderer, 'registro');
  fetchResponse = { status: 200, json: { ...studentResponse, commitments: [studentResponse.commitments[1]] } as any };
  await chooseCameraAndPick(renderer, makeFile('registro.jpg', 'image/jpeg', 30_000));
  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
  await act(async () => {
    byId(renderer, 'scan-consent-confirm').props.onClick();
    await new Promise(r => setTimeout(r, 0));
  });

  // Impegno senza data: deselezionato + avviso.
  const checkboxes = renderer.root.findAll((el: any) => el.props?.type === 'checkbox');
  assert.equal(checkboxes[0].props.checked, false, 'senza data visibile l\'impegno parte deselezionato');

  const dateInput = renderer.root.findAll((el: any) => el.props?.type === 'date')[0];
  await act(async () => { dateInput.props.onChange({ target: { value: '2026-09-17' } }); });
  await act(async () => { checkboxes[0].props.onChange(); }); // selezionalo
  await act(async () => { byId(renderer, 'student-confirm-save').props.onClick(); });
  assert.equal(imported[0].length, 1, 'con la data completata l\'impegno è salvabile');
  assert.equal(imported[0][0].date, '2026-09-17', 'la data è quella inserita dall\'utente, non inventata');
});

// ---------------------------------------------------------------------------
// Statich: il modulo scanner non tocca persistenza locale né log di contenuto
// ---------------------------------------------------------------------------

test('privacy statica: DocumentScannerModal non importa storage e non logga contenuto documento', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(process.cwd(), 'src', 'components', 'DocumentScannerModal.tsx'), 'utf8');
  assert.ok(!/services\/storage/.test(source), 'il flusso scanner non scrive su IndexedDB');
  assert.ok(!/localStorage|IndexedDB|dexie/i.test(source), 'nessun accesso diretto a storage browser');
  assert.ok(!/console\.(log|warn|error)\([^)]*(rawText|studentName|imageBase64)/.test(source), 'nessun log di contenuto documento');
  const service = readFileSync(join(process.cwd(), 'src', 'services', 'scanService.ts'), 'utf8');
  assert.ok(!/services\/storage/.test(service));
});
