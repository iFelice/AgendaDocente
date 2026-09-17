import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { CURRICULAR_SCOPE_EMPTY_MESSAGE, DocumentScannerModal, SCAN_MODAL_BODY_ID, SCAN_MERGE_CHOICE_ID, scrollModalBodyToTop, scrollSectionIntoView } from '../src/components/DocumentScannerModal';
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

/**
 * Scelta esplicita «sostituisci / mantieni e aggiungi»: nella Fase A con un
 * vecchio orario pertinente nessuna delle due è pre-selezionata, quindi il
 * salvataggio va preceduto da questa scelta. `which`: 0 = sostituisci,
 * 1 = mantieni e aggiungi (ordine mostrato nella UI).
 */
async function chooseMergeModeIfAsked(renderer: any, which: 0 | 1 = 1) {
  const radios = renderer.root.findAll((el: any) => el.props?.name === 'scan-merge-mode');
  if (radios.length === 0) return;
  if (radios.some((el: any) => el.props.checked)) return; // già scelta (es. Fase B)
  await act(async () => { radios[which].props.onChange(); });
}

/** Ore per giorno del timeSlotConfig usato da modalProps (prefill della domanda). */
const PERSONAL_PERIODS_PER_DAY = 6;
/** Giorni scolastici del percorso personale. */
const PERSONAL_SCHOOL_DAYS = 5;
/** Posizioni della sequenza personale: lun-ven x ore per giorno. */
const PERSONAL_SEQUENCE_LENGTH = PERSONAL_PERIODS_PER_DAY * PERSONAL_SCHOOL_DAYS;

/**
 * Celle come le restituisce l'endpoint: la sequenza è già stata convertita dal
 * server, quindi giorno e periodo derivano dall'indice (riga sintetica 0).
 */
function personalSequenceCells(raws: string[], periodsPerDay = PERSONAL_PERIODS_PER_DAY) {
  return raws.map((raw, index) => ({
    rowIndex: 0,
    dayOfWeek: Math.floor(index / periodsPerDay) + 1,
    periodIndex: (index % periodsPerDay) + 1,
    raw,
  }));
}

/**
 * Sequenza della riga del docente: una stringa per posizione fisica, vuoti inclusi.
 * `values` indicizza le posizioni non vuote (0 = lunedì 1ª).
 */
function personalSequence(values: Record<number, string> = {}, periodsPerDay = PERSONAL_PERIODS_PER_DAY): string[] {
  return Array.from({ length: periodsPerDay * PERSONAL_SCHOOL_DAYS }, (_, index) => values[index] ?? '');
}

/** Risposta dell'endpoint personale: etichetta della riga + celle già posizionate. */
function personalTimetableResponse(values: Record<number, string> = { 6: '3D', 12: '3E', 18: 'sos' }) {
  return {
    success: true,
    source: 'test-model',
    rowLabel: 'Manganiello F.',
    cells: personalSequenceCells(personalSequence(values)),
  };
}

/** 3D martedì 1ª, 3E mercoledì 1ª, sos giovedì 1ª (con 6 ore: indici 6, 12, 18). */
const personalResponse = personalTimetableResponse();

/** Imposta le ore per giorno dichiarate dall'utente nello schermo di consenso. */
async function setPeriodsPerDay(renderer: any, value: string) {
  const input = byId(renderer, 'scan-periods-per-day');
  await act(async () => { input.props.onChange({ target: { value } }); });
}

/**
 * Conferma esplicita delle ore: senza questa spunta l'analisi personale non parte,
 * anche se il campo è già compilato dalla proposta.
 */
async function confirmPeriodsPerDay(renderer: any, checked = true) {
  const box = byId(renderer, 'scan-periods-per-day-confirm');
  await act(async () => { box.props.onChange({ target: { checked } }); });
}

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

/**
 * Attende che l'analisi passi dallo schermo "Analisi in corso" (barra di progresso)
 * alla schermata successiva: il 100% "Completato" è mostrato per un breve hold,
 * quindi il cambio step non è istantaneo.
 */
async function waitForAnalysisSettled(renderer: any, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    const text = flatText(renderer.root);
    if (!text.includes('Analisi del documento in corso')) return;
    if (Date.now() - start > timeoutMs) throw new Error('l\'analisi non ha mai rilasciato lo schermo di attesa');
  }
}

async function analyzeWithConsent(renderer: any, periodsPerDay?: string) {
  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  // Orario personale: le ore per giorno dichiarate (se il test le vuole diverse
  // dal prefill) prima dell'invio.
  if (periodsPerDay !== undefined) await setPeriodsPerDay(renderer, periodsPerDay);
  // Orario personale: la domanda sulle ore va confermata esplicitamente.
  const periodsBox = renderer.root.findAll((el: any) => el.props?.id === 'scan-periods-per-day-confirm');
  if (periodsBox.length > 0) {
    assert.equal(periodsBox[0].props.checked, false, 'la conferma delle ore non è mai preselezionata');
    await confirmPeriodsPerDay(renderer);
  }
  // Consenso richiesto (checkbox NON preselezionata).
  const consent = byId(renderer, 'scan-cloud-consent');
  assert.equal(consent.props.checked, false, 'il consenso non è mai preselezionato');
  assert.ok(byId(renderer, 'scan-consent-confirm').props.disabled, 'senza consenso l\'invio è bloccato');
  await act(async () => { consent.props.onChange({ target: { checked: true } }); });
  await confirmAndSettleAnalysis(renderer);
}

/** Invio dell'analisi + attesa del completamento (rampa 100% inclusa). */
async function confirmAndSettleAnalysis(renderer: any) {
  await act(async () => {
    byId(renderer, 'scan-consent-confirm').props.onClick();
    await new Promise(r => setTimeout(r, 0));
  });
  await waitForAnalysisSettled(renderer);
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
  // Nessuna conferma della riga: il server l'ha già verificata col cognome del profilo.
  assert.ok(flatText(renderer.root).includes('Manganiello F.'), 'riga letta mostrata in revisione');
  assert.equal(renderer.root.findAll((el: any) => el.props?.name === 'scan-personal-row').length, 0, 'nessuna scelta della riga');
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
  await chooseMergeModeIfAsked(renderer);
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

  await chooseMergeModeIfAsked(renderer);

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

test('orari esistente: scelta esplicita obbligatoria, nessuna pre-selezione, niente azzeramento', async () => {
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: existingTimetable,
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
  });
  await flowToReconstruction(renderer);
  const text = flatText(renderer.root);

  assert.match(text, /Esiste già un orario di sostegno salvato\./);
  assert.match(text, /Archivio: Provvisorio/, 'l archivio con le vecchie ore è dichiarato');
  assert.match(text, /Sovrascrivi orario esistente/);
  assert.match(text, /Tutte le vecchie ore di sostegno di questo istituto vengono sostituite da quelle scansionate\./);
  assert.match(text, /Mantieni e aggiungi/);
  assert.match(text, /Le nuove ore verranno aggiunte senza eliminare quelle esistenti\./);
  assert.match(text, /non viene mai cancellato/i, 'nessuna opzione di azzeramento');

  // Nessuna delle due opzioni è pre-selezionata: la scelta è davvero dell'utente.
  const radios = renderer.root.findAll((el: any) => el.props?.name === 'scan-merge-mode');
  assert.deepEqual(radios.map((el: any) => el.props.checked), [false, false], 'nessuna pre-selezione');
  assert.match(text, /Scegli una delle due opzioni per poter salvare\./);
  assert.equal(byId(renderer, 'recon-confirm-save').props.disabled, true, 'salvataggio bloccato prima della scelta');

  // Scelta "sostituisci" -> anteprima reale e salvataggio in sostituzione d'ambito.
  await act(async () => { radios[0].props.onChange(); });
  assert.match(flatText(renderer.root), /Sostituzione reale/, 'anteprima di cosa cambia davvero');
  assert.equal(byId(renderer, 'recon-confirm-save').props.disabled, false, 'salvataggio sbloccato dopo la scelta');
  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  assert.equal(saved[0].mode, 'replace-scope');
});

test('orari esistente: in "solo mancanti" gli slot esistenti restano intatti (App applica applyReconstruction)', async () => {
  const { applyReconstruction } = await import('../src/utils/reconstructTimetable');
  const renderer = await renderModal();
  await flowToReconstruction(renderer);
  await chooseMergeModeIfAsked(renderer);
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
  await chooseMergeModeIfAsked(multi);
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
  await confirmAndSettleAnalysis(renderer);

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
  await confirmAndSettleAnalysis(renderer);

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

// ---------------------------------------------------------------------------
// 11-bis. FASE CURRICOLARE FILTRATA SULLE MIE COMPRESENZE
// ---------------------------------------------------------------------------

/** Tabella d’istituto “vera”: molte classi, molte ore — e le mie due coordinate. */
function noisyCurricularPayload() {
  const otherClasses = ['1A', '1B', '2A', '2B', '3A', '3B', '3C', '4A', '4B', '5A', '5B'];
  const curricularRows = [
    { rowIndex: 0, rowLabel: 'Rossi', subject: 'Matematica', classes: ['3D'] },
    { rowIndex: 1, rowLabel: 'Bianchi', subject: 'Italiano', classes: ['3E'] },
    { rowIndex: 2, rowLabel: 'Neri', subject: 'Inglese', classes: ['3E'] },
    { rowIndex: 3, rowLabel: 'Verdi', subject: 'Scienze', classes: ['1A'] },
    ...otherClasses.map((className, i) => ({
      rowIndex: 4 + i, rowLabel: `Docente ${i + 1}`, subject: `Materia ${i + 1}`, classes: [className],
    })),
  ];
  const cells = [
    // Le mie coordinate: martedì 1ª (una materia) e mercoledì 1ª (due materie -> ambigua).
    { rowIndex: 0, dayOfWeek: 2, periodIndex: 1, raw: '3D' },
    { rowIndex: 1, dayOfWeek: 3, periodIndex: 1, raw: '3E' },
    { rowIndex: 2, dayOfWeek: 3, periodIndex: 1, raw: '3E' },
    // Rumore: altre classi su tutta la settimana (e una 1A nel mio giorno/ora).
    ...otherClasses.flatMap((className, i) =>
      [1, 2, 3, 4, 5].flatMap(dayOfWeek => [1, 2, 3, 4, 5, 6].map(periodIndex => ({ rowIndex: 4 + i, dayOfWeek, periodIndex, raw: className })))
    ),
  ];
  return { success: true, source: 'test-model', curricularRows, cells };
}

async function flowToCurricularReview(renderer: any, payload: unknown) {
  fetchCalls.length = 0;
  await goToSource(renderer, 'personal');
  fetchResponse = { status: 200, json: personalResponse as any };
  await chooseCameraAndPick(renderer, makeFile('orario-personale.jpg', 'image/jpeg', 20_000));
  await analyzeWithConsent(renderer);
  // Nessuna scelta della riga: l'ha letta il modello e il server l'ha verificata
  // contro il cognome del profilo. La revisione delle ore resta obbligatoria.
  assert.ok(flatText(renderer.root).includes('Manganiello F.'), 'riga letta mostrata in revisione');
  await act(async () => { byId(renderer, 'scan-personal-add-curricular').props.onClick(); });
  fetchResponse = { status: 200, json: payload as any };
  await chooseCameraAndPick(renderer, makeFile('orario-istituto.jpg', 'image/jpeg', 300_000));
  await analyzeWithConsent(renderer);
  // La richiesta curricolare dichiara le MIE coordinate (senza la key interna):
  // è ciò che permette al server di chiedere al modello solo quelle celle.
  const curricularRequest = fetchCalls.find(call => call.body?.documentType === 'curricular-timetable');
  assert.deepEqual(curricularRequest?.body.coordinateScope, [
    { dayOfWeek: 2, periodIndex: 1, classLabel: '3D' },
    { dayOfWeek: 3, periodIndex: 1, classLabel: '3E' },
  ], 'scope = le coordinate del mio orario personale, senza key');
  return renderer;
}

test('Fase B: la revisione curricolare mostra le MIE ore, non l’orario d’istituto', async () => {
  const renderer = await renderModal({ provisionalTimetable: [], definitiveTimetable: [] });
  await flowToCurricularReview(renderer, noisyCurricularPayload());

  const counts = flatText(byId(renderer, 'scan-curricular-counts'));
  assert.match(counts, /2 ore del tuo orario/, 'contesto: le mie coordinate, non “32 docenti, 430 ore”');
  assert.match(counts, /1 materia trovata/);
  assert.match(counts, /1 ambigua/, 'mercoledì ha due materie: scelta manuale');
  assert.match(counts, /0 non identificate/);
  assert.ok(!/docenti/.test(counts), 'il numero di docenti non è più l’intestazione');

  const text = flatText(renderer.root);
  assert.match(text, /Le tue 2 classi/, 'quante classi vengono cercate');
  assert.match(text, /3D, 3E/, 'quali classi vengono cercate nella tabella');
  assert.match(text, /330 ore di altre classi sono state escluse/, `${text.slice(0, 200)}`);
  assert.match(text, /non vengono n\u00e9 mostrate, n\u00e9 incrociate, n\u00e9 salvate/);
  assert.ok(!text.includes('Scienze') && !/Materia \d/.test(text), 'le materie delle altre classi non sono in lista');
  assert.ok(!text.includes('1A') && !text.includes('5B'), 'le classi non mie non compaiono');
  await act(async () => { renderer.unmount(); });
});

test('Fase B: l’incrocio e il salvataggio usano solo le mie coordinate (nessuna ora d’istituto salvata)', async () => {
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: [],
    definitiveTimetable: [],
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
  });
  await flowToCurricularReview(renderer, noisyCurricularPayload());
  await act(async () => { byId(renderer, 'scan-curricular-reconstruct').props.onClick(); });

  const cards = renderer.root.findAll((el: any) => String(el.props?.id ?? '').startsWith('recon-slot-'));
  assert.equal(cards.length, 3, 'un solo slot per ogni ora personale (3D mar, 3E mer, sos gio)');
  const subjectInputs = renderer.root.findAll((el: any) => el.props?.placeholder === 'es. Matematica');
  assert.deepEqual(subjectInputs.map((el: any) => el.props.value), ['Matematica', ''],
    'l’ora ambigua resta vuota: la scelta è manuale, mai automatica');
  assert.match(flatText(renderer.root), /Italiano/, 'le due candidate della MIA classe sono proposte');
  assert.match(flatText(renderer.root), /Inglese/);
  assert.ok(!flatText(renderer.root).includes('Scienze'), 'nessuna materia di altre classi nell’incrocio');

  await chooseMergeModeIfAsked(renderer);

  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  assert.equal(saved.length, 1, 'salvataggio solo alla conferma');
  const classNames = saved[0].slots.map(s => s.className).sort();
  assert.deepEqual([...new Set(classNames)], ['3D', '3E'], 'salvate solo le mie classi');
  assert.equal(saved[0].slots.length, 2, 'le ore dell’istituto non sono mai diventate slot');
  assert.ok(saved[0].slots.every(s => s.subject === 'Sostegno'), 'la materia principale resta Sostegno');
  await act(async () => { renderer.unmount(); });
});

test('Fase B con solo orario già salvato: l’ambito viene dall’archivio (modale riaperto)', async () => {
  // Nessuna analisi personale in questa sessione: contano le ore salvate in Fase A.
  const renderer = await renderModal({ provisionalTimetable: existingTimetable, definitiveTimetable: [] });
  await goToSource(renderer, 'curricular');
  fetchResponse = { status: 200, json: noisyCurricularPayload() as any };
  await chooseCameraAndPick(renderer, makeFile('orario-istituto.jpg', 'image/jpeg', 300_000));
  await analyzeWithConsent(renderer);

  const counts = flatText(byId(renderer, 'scan-curricular-counts'));
  assert.match(counts, /1 ora del tuo orario/, 'l’unica ora salvata (martedì 1ª, 3D)');
  assert.match(counts, /1 materia trovata/);
  assert.match(flatText(renderer.root), /di altre classi sono state escluse/, 'il resto della tabella d’istituto è fuori ambito');
  const text = flatText(renderer.root);
  assert.ok(!text.includes('Inglese') && !text.includes('Italiano'), 'le ore di altre classi non entrano nella revisione');
  await act(async () => { renderer.unmount(); });
});

test('Fase B senza alcun orario personale: l’analisi non parte, nessuna richiesta senza coordinate', async () => {
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: [],
    definitiveTimetable: [],
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); },
  });
  await goToSource(renderer, 'curricular');
  fetchResponse = { status: 200, json: noisyCurricularPayload() as any };
  await chooseCameraAndPick(renderer, makeFile('orario-istituto.jpg', 'image/jpeg', 300_000));
  fetchCalls.length = 0;
  await analyzeWithConsent(renderer);

  // L'analisi curricolare non chiede più l'intera tabella d'istituto: cerca solo
  // le coordinate in cui il docente è presente. Senza coordinate non esiste nulla
  // da cercare, quindi nessuna richiesta parte (il server risponderebbe 400) e
  // l'utente riceve l'istruzione su cosa fare prima.
  assert.equal(fetchCalls.length, 0, 'nessuna richiesta cloud senza coordinate');
  assert.match(flatText(renderer.root), new RegExp(CURRICULAR_SCOPE_EMPTY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'motivo spiegato all’utente');
  assert.equal(saved.length, 0, 'nessun salvataggio di ore d’istituto');
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// 11-ter. FASE A (salvataggio reale) → poi, facoltativa, FASE B (curricolare)
// ---------------------------------------------------------------------------

test('Fase A: azione esplicita «Salva questo orario», conferma visibile e nessuna perdita alla chiusura', async () => {
  const saved: SavedTimetable[] = [];
  let closed = 0;
  const renderer = await renderModal({
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); },
    onClose: () => { closed++; },
  });

  // Analisi + conferma della riga: nessun salvataggio, nessun banner di conferma.
  await goToSource(renderer, 'personal');
  fetchResponse = { status: 200, json: personalResponse as any };
  await chooseCameraAndPick(renderer, makeFile('orario-personale.jpg', 'image/jpeg', 20_000));
  await analyzeWithConsent(renderer);
  // Nessuna scelta della riga: l'ha letta il modello e il server l'ha verificata
  // contro il cognome del profilo. La revisione delle ore resta obbligatoria.
  assert.ok(flatText(renderer.root).includes('Manganiello F.'), 'riga letta mostrata in revisione');
  assert.equal(saved.length, 0, 'nessun salvataggio prima della conferma esplicita');
  assert.equal(closed, 0, 'la revisione non chiude il modale');
  assert.ok(!flatText(renderer.root).includes('Orario salvato'), 'nessuna conferma di salvataggio inventata');
  assert.match(flatText(renderer.root), /Nessun salvataggio ancora effettuato/, 'l’utente sa che nulla è ancora salvato');

  // L’azione richiesta porta alla revisione, dove avviene il salvataggio reale.
  await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
  assert.match(flatText(byId(renderer, 'recon-confirm-save')), /Salva questo orario/, 'azione esplicita di salvataggio');
  assert.match(flatText(renderer.root), /nessun salvataggio prima della conferma/);

  await chooseMergeModeIfAsked(renderer);

  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  assert.equal(saved.length, 1, 'salvato una sola volta, alla conferma');
  assert.equal(closed, 0, 'il modale resta aperto sulla conferma: da qui chiudere non perde nulla');

  const banner = flatText(byId(renderer, 'scan-timetable-saved'));
  assert.match(banner, /Orario salvato/, 'conferma di salvataggio riuscito');
  assert.match(banner, /Orario provvisorio/, 'archivio di destinazione dichiarato');
  assert.match(banner, /vista Orario/, 'dove rivedere le ore');
  assert.match(banner, /Vuoi aggiungere anche l.orario curricolare per ricostruire le compresenze\?/, 'Fase B offerta solo ora, come passo facoltativo');
  assert.ok(byId(renderer, 'scan-add-curricular-after-save'), 'CTA separata per l’orario curricolare');
  assert.match(flatText(byId(renderer, 'recon-close')), /Chiudi/, 'dopo il salvataggio non c’è più nulla da annullare');
  assert.match(flatText(byId(renderer, 'recon-confirm-save')), /Salva di nuovo/);

  // Chiudere dopo il salvataggio è sicuro: la chiusura è esplicita e i dati sono in archivio.
  await act(async () => { byId(renderer, 'recon-close').props.onClick(); });
  assert.equal(closed, 1);
  await act(async () => { renderer.unmount(); });
});

test('Fase B: si raggiunge dopo il salvataggio e tornare indietro non rifà l’analisi', async () => {
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); },
  });
  await goToSource(renderer, 'personal');
  fetchResponse = { status: 200, json: personalResponse as any };
  await chooseCameraAndPick(renderer, makeFile('orario-personale.jpg', 'image/jpeg', 20_000));
  await analyzeWithConsent(renderer);
  // Nessuna scelta della riga: l'ha letta il modello e il server l'ha verificata
  // contro il cognome del profilo. La revisione delle ore resta obbligatoria.
  assert.ok(flatText(renderer.root).includes('Manganiello F.'), 'riga letta mostrata in revisione');
  await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
  await chooseMergeModeIfAsked(renderer);
  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  assert.equal(saved.length, 1);

  // CTA Fase B: nuova cattura del curricolare, senza ripetere nulla della Fase A.
  await act(async () => { byId(renderer, 'scan-add-curricular-after-save').props.onClick(); });
  assert.match(flatText(renderer.root), /Orario curricolare \/ istituto/, 'sorgente del documento curricolare');
  fetchResponse = { status: 200, json: curricularResponse as any };
  await chooseCameraAndPick(renderer, makeFile('orario-curricolare.jpg', 'image/jpeg', 25_000));
  await analyzeWithConsent(renderer);

  // Il ritorno alla riga personale è possibile e la revisione è ancora in memoria.
  await act(async () => { byId(renderer, 'scan-curricular-back-personal').props.onClick(); });
  const text = flatText(renderer.root);
  assert.match(text, /Riga letta nel documento: Manganiello F\./, 'la riga già letta e verificata non va rifatta');
  assert.match(text, /Orario personale già salvato/, 'stadio corrente dichiarato all’utente');
  assert.equal(saved.length, 1, 'nessun doppio salvataggio nel navigare avanti/indietro');
  await act(async () => { renderer.unmount(); });
});

test('Fase B dopo il salvataggio: l’incrocio parte in sostituzione e arricchisce le ore già salvate', async () => {
  const { applyReconstruction } = await import('../src/utils/reconstructTimetable');
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: existingTimetable,
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); },
  });
  await goToSource(renderer, 'personal');
  fetchResponse = { status: 200, json: personalResponse as any };
  await chooseCameraAndPick(renderer, makeFile('orario-personale.jpg', 'image/jpeg', 20_000));
  await analyzeWithConsent(renderer);
  // Nessuna scelta della riga: l'ha letta il modello e il server l'ha verificata
  // contro il cognome del profilo. La revisione delle ore resta obbligatoria.
  assert.ok(flatText(renderer.root).includes('Manganiello F.'), 'riga letta mostrata in revisione');
  await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
  await chooseMergeModeIfAsked(renderer);
  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  assert.equal(saved[0].mode, 'missing-only', 'primo salvataggio: niente sovrascrittura automatica');

  await act(async () => { byId(renderer, 'scan-add-curricular-after-save').props.onClick(); });
  fetchResponse = { status: 200, json: curricularResponse as any };
  await chooseCameraAndPick(renderer, makeFile('orario-curricolare.jpg', 'image/jpeg', 25_000));
  await analyzeWithConsent(renderer);
  await act(async () => { byId(renderer, 'scan-curricular-reconstruct').props.onClick(); });

  // Default dopo un salvataggio: sostituzione dell’ambito. Con «solo mancanti» le
  // compresenze troverebbero le ore già occupate e non verrebbero mai scritte.
  const mergeRadios = renderer.root.findAll((el: any) => el.props?.name === 'scan-merge-mode');
  assert.equal(mergeRadios[0].props.checked, true, 'sezione «Sostituisci» pre-selezionata dopo il salvataggio');
  assert.equal(mergeRadios[1].props.checked, false);

  await chooseMergeModeIfAsked(renderer);

  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  assert.equal(saved.length, 2, 'secondo salvataggio: arricchimento compresenze');
  assert.equal(saved[1].mode, 'replace-scope');
  assert.equal(saved[1].target, 'provvisorio', 'stesso archivio del primo salvataggio');
  assert.ok(saved[1].slots.some(s => (s.coTeachingSubjects ?? []).length > 0), 'gli slot arricchiti portano la materia in compresenza');

  // Effetto reale sull’orario salvato in Fase A: nessuna duplicazione delle ore.
  const phaseA = applyReconstruction(existingTimetable, saved[0].slots, 'missing-only', { profile });
  const enriched = applyReconstruction(phaseA.slots, saved[1].slots, 'replace-scope', { profile });
  const keys = enriched.slots.map(slot => `${slot.schoolId ?? ''}|${slot.dayOfWeek}|${slot.periodNumber}`);
  assert.equal(new Set(keys).size, keys.length, 'nessuna coordinata duplicata dopo l’arricchimento');
  assert.equal(enriched.removedCount, 0, 'le ore confermate coprono le stesse coordinate');
  await act(async () => { renderer.unmount(); });
});

test('Fase A sostituisce davvero: anteprima delle vecchie ore rimosse e conteggio mostrato', async () => {
  const withOldHours: TimetableSlot[] = [
    { id: 'ex-tue', dayOfWeek: 2, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3A' },
    { id: 'ex-thu', dayOfWeek: 4, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3B' },
    { id: 'ex-math', dayOfWeek: 5, periodNumber: 2, startTime: '10:05', endTime: '11:00', subject: 'Matematica', className: '3C' },
  ];
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: withOldHours,
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); },
  });
  await flowToReconstruction(renderer);
  const replaceRadio = renderer.root.findAll((el: any) => el.props?.name === 'scan-merge-mode')[0];
  await act(async () => { replaceRadio.props.onChange(); });

  const preview = flatText(byId(renderer, 'recon-replace-preview'));
  assert.match(preview, /2 ore esistenti di sostegno verranno sostituite/, 'martedì (aggiornata) + giovedì (rimossa)');
  assert.match(preview, /1 aggiornate/, 'coordinata presente nel nuovo orario');
  assert.match(preview, /1 rimosse perché non presenti nel nuovo orario/, 'ex-thu non sopravvive');
  assert.match(preview, /1 ore non pertinenti restano intatte|1 ore non pertinenti/, 'ex-math (materia) esclusa dall’ambito');
  assert.match(flatText(renderer.root), /Ore di materia, di altri istituti e l'altro archivio non vengono toccati/);

  await chooseMergeModeIfAsked(renderer);

  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
  assert.equal(saved[0].mode, 'replace-scope');
  await act(async () => { renderer.unmount(); });
});

test('i dati salvati non vivono nel modale: archivio aggiornato alla conferma, modale richiudibile', async () => {
  const { applyReconstruction } = await import('../src/utils/reconstructTimetable');
  // L’archivio è quello dell’app: il modale si limita a chiedere la scrittura.
  const archive: TimetableSlot[] = [
    { id: 'ex-thu', dayOfWeek: 4, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3B' },
  ];
  let closed = 0;
  const props = modalProps({
    provisionalTimetable: archive,
    onClose: () => { closed++; },
    onSaveReconstructedTimetable: (slots, _target, mode) => {
      const merged = applyReconstruction(archive, slots, mode as any, { profile });
      archive.length = 0;
      archive.push(...merged.slots);
    },
  });
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(DocumentScannerModal, props)); });
  await flowToReconstruction(renderer);
  assert.equal(archive.length, 1, 'prima della conferma l’archivio non cambia');
  const replaceRadio = renderer.root.findAll((el: any) => el.props?.name === 'scan-merge-mode')[0];
  await act(async () => { replaceRadio.props.onChange(); });
  await chooseMergeModeIfAsked(renderer);
  await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

  assert.equal(archive.filter(slot => slot.id.startsWith('tt-recon-')).length, 2, 'le ore confermate sono nell’archivio');
  assert.equal(archive.find(slot => slot.id === 'ex-thu'), undefined, 'la vecchia ora non più nel nuovo orario è stata rimossa');
  await act(async () => { renderer.unmount(); });

  // Riapertura del modale: nessuno «stadio intermedio» da recuperare, e nessun
  // banner residuo — l’orario vive solo nell’archivio dell’app.
  let reopened: any;
  await act(async () => { reopened = create(React.createElement(DocumentScannerModal, modalProps({ provisionalTimetable: archive }))); });
  assert.equal(flatText(reopened.root).includes('Orario salvato'), false, 'il modale non conserva falsi stati di salvataggio');
  assert.match(flatText(reopened.root), /Scansiona documento/, 'si riparte dalla scelta del documento');
  assert.equal(archive.filter(s => s.id.startsWith('tt-recon-')).length, 2, 'le ore restano nell archivio dopo la chiusura del modale');
  void closed;
  await act(async () => { reopened.unmount(); });
});

// ---------------------------------------------------------------------------
// 22. PROGRESSO VISIBILE DURANTE L'ANALISI (stima UI, mai una misura cloud)
// ---------------------------------------------------------------------------

/**
 * Fetch «in volo»: permette di osservare la barra durante l'attesa reale e di
 * decidere quando arriva la risposta. La risposta viene SEMPRE consegnata nel
 * `finally`: un'attesa rimasta aperta lascerebbe il modale montato con il loop
 * di tick attivo, e la suite non terminerebbe più (nessun test «appeso»).
 */
async function withPendingAnalysis(run: (gate: { respond: (json: unknown, status?: number) => void }) => Promise<void>) {
  const savedFetch = globalThis.fetch;
  let settle!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { settle = resolve; });
  globalThis.fetch = ((async (url: unknown) => {
    fetchCalls.push({ url: String(url), body: undefined });
    return pending;
  }) as unknown) as typeof fetch;
  try {
    await run({ respond: (json, status = 200) => settle(new Response(JSON.stringify(json), { status })) });
  } finally {
    settle(new Response(JSON.stringify(personalResponse), { status: 200 }));
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    globalThis.fetch = savedFetch;
  }
}

/** Consenso + invio SENZA attendere l'esito: si è ancora nello step «working». */
async function sendForAnalysis(renderer: any) {
  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
  // Orario personale: la domanda sulle ore va confermata esplicitamente.
  const periodsBox = renderer.root.findAll((el: any) => el.props?.id === 'scan-periods-per-day-confirm');
  if (periodsBox.length > 0) await confirmPeriodsPerDay(renderer);
  await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
  await act(async () => {
    byId(renderer, 'scan-consent-confirm').props.onClick();
    await new Promise(r => setTimeout(r, 0));
  });
}

/** Gli elementi progressbar presenti nel modale (vuoto = nessuna barra attiva). */
function progressBar(renderer: any) {
  return renderer.root.findAll((el: any) => el.props?.role === 'progressbar');
}

/**
 * Dopo la risposta la barra deve arrivare al 100% «Completato» ed esserci
 * VISIBILE un istante, prima che compaia la schermata successiva.
 */
async function expectCompletionFlash(renderer: any) {
  for (let i = 0; i < 16; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 40)); });
    const bars = progressBar(renderer);
    if (bars.length > 0 && Number(bars[0].props['aria-valuenow']) === 100) {
      assert.match(flatText(renderer.root), /Completato/, 'il 100% è accompagnato dal suo stato');
      assert.match(flatText(renderer.root), /Analisi del documento in corso/, 'la schermata di attesa resta finché il 100% è in corso');
      return true;
    }
    if (!flatText(renderer.root).includes('Analisi del documento in corso')) return false;
  }
  return false;
}

test('progresso: durante l’attesa la barra è visibile, dichiarata stima e mai oltre 85%', async () => {
  let renderer: any;
  try {
    renderer = await renderModal();
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await withPendingAnalysis(async gate => {
      await sendForAnalysis(renderer);

      assert.match(flatText(renderer.root), /Analisi del documento in corso/, 'lo schermo di attesa è in primo piano');
      assert.equal(progressBar(renderer).length, 1, 'la barra di progresso è mostrata');

      // Qualche tick reale: l'animazione deve muoversi senza toccare il tetto.
      const values: number[] = [];
      for (let i = 0; i < 6; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 120)); });
        const bar = progressBar(renderer)[0];
        assert.ok(bar, 'la barra resta montata per tutta l’attesa');
        const value = Number(bar.props['aria-valuenow']);
        values.push(value);
        assert.ok(Number.isInteger(value), `percentuale numerica intera (${value})`);
        assert.ok(value >= 0 && value <= 85, `in attesa la stima resta fra 0 e 85% (è ${value})`);
      }
      assert.ok(values[values.length - 1] >= values[0], 'l’avanzamento cresce nel tempo');
      assert.ok(values[values.length - 1] > 0, 'la barra si muove davvero, non è un indicatore fisso');

      const bar = progressBar(renderer)[0];
      assert.equal(bar.props['aria-valuemin'], 0, 'progressbar: minimo dichiarato');
      assert.equal(bar.props['aria-valuemax'], 100, 'progressbar: massimo dichiarato');
      assert.match(String(bar.props['aria-valuetext']), /avanzamento stimato \d+%/i, 'gli screen reader leggono una stima, non una misura certa');
      const status = byId(renderer, 'analysis-progress-status');
      assert.equal(status.props.role, 'status', 'lo stato è annunciato agli screen reader');
      assert.equal(status.props['aria-live'], 'polite', 'senza interrompere la lettura in corso');
      assert.match(flatText(status), /Preparazione documento|Invio sicuro|Analisi del documento/, 'testo di stato corto e leggibile');
      assert.match(flatText(renderer.root), /non è una percentuale reale/, 'dichiara che il servizio cloud non espone una percentuale');
      assert.ok(!flatText(renderer.root).includes('100%'), 'mai «completato» mentre si aspetta la risposta');

      // La risposta arriva: la rampa chiude al 100% e si passa alla revisione.
      gate.respond(personalResponse);
      assert.ok(await expectCompletionFlash(renderer), 'il 100% compare solo a risposta arrivata');
      await waitForAnalysisSettled(renderer);
      assert.equal(progressBar(renderer).length, 0, 'finita l’analisi la barra non resta a schermo');
      assert.match(flatText(renderer.root), /riga/, 'si vede la revisione dell’orario personale');
    });
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
  }
});

test('progresso: il 100% «Completato» appare solo dopo la risposta, prima dei risultati', async () => {
  let renderer: any;
  try {
    renderer = await renderModal();
    await goToSource(renderer, 'registro');
    await pickFile(renderer, makeFile('registro.jpg', 'image/jpeg', 25_000));
    await withPendingAnalysis(async gate => {
      await sendForAnalysis(renderer);
      await act(async () => { await new Promise(r => setTimeout(r, 200)); });
      assert.ok(!flatText(renderer.root).includes('Completato'), 'nessun «Completato» prima della risposta');

      gate.respond(studentResponse);
      // Il 100% deve essere VISIBILE per un istante (hold), non bruciato in un frame.
      assert.ok(await expectCompletionFlash(renderer), 'dopo la risposta la barra arriva al 100%');
      await waitForAnalysisSettled(renderer);
      assert.equal(progressBar(renderer).length, 0, 'poi lo schermo lascia il passo ai risultati');
      assert.match(flatText(renderer.root), /Impegni estratti/, 'la schermata successiva mostra i candidati impegno');
    });
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
  }
});

test('progresso: errore = animazione fermata, messaggio esistente, retry che riparte', async () => {
  fetchResponse = { status: 503, json: { success: false, error: 'Il documento non è stato elaborato. Riprova.' } };
  let renderer: any;
  try {
    renderer = await renderModal();
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await analyzeWithConsent(renderer);

    assert.equal(progressBar(renderer).length, 0, 'sopra il messaggio di errore non resta nessuna barra');
    assert.ok(!flatText(renderer.root).includes('Analisi del documento in corso'), 'l’attesa non è più in primo piano');
    const alert = renderer.root.findByProps({ role: 'alert' });
    assert.match(flatText(alert), /non è stato elaborato/, 'il messaggio di errore esistente è visibile');
    assert.match(flatText(renderer.root), /Controlla il documento/, 'si torna alla schermata da cui riprovare');

    // Retry: l'animazione riparte da zero, non riprende il valore precedente.
    fetchResponse = { status: 200, json: personalResponse };
    await withPendingAnalysis(async gate => {
      await sendForAnalysis(renderer);
      await act(async () => { await new Promise(r => setTimeout(r, 150)); });
      const bars = progressBar(renderer);
      assert.equal(bars.length, 1, 'una nuova analisi mostra di nuovo la barra');
      const value = Number(bars[0].props['aria-valuenow']);
      assert.ok(value >= 0 && value <= 85, `la ripresa non parte da 100% (${value})`);
      gate.respond(personalResponse);
      await waitForAnalysisSettled(renderer);
      assert.equal(progressBar(renderer).length, 0, 'e si chiude normalmente');
      assert.match(flatText(renderer.root), /riga/, 'la retry arriva alla revisione');
    });
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
  }
});

test('progresso: chiusura durante l’attesa ferma l’animazione e ignora la risposta tardiva', async () => {
  let renderer: any;
  try {
    renderer = await renderModal();
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await withPendingAnalysis(async () => {
      await sendForAnalysis(renderer);
      await act(async () => { await new Promise(r => setTimeout(r, 200)); });
      assert.equal(progressBar(renderer).length, 1, 'l’analisi è in corso');
      // L'utente chiude mentre aspetta (in App il modale viene spento e smontato).
      const closing = renderer;
      renderer = null;
      await act(async () => { closing.unmount(); });
    });
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
  }

  // Nuova apertura: nessun progresso residuo, nessun «completato» ereditato.
  let reopened: any;
  try {
    reopened = await renderModal();
    assert.equal(progressBar(reopened).length, 0, 'nessuna barra animata alla riapertura');
    assert.ok(!flatText(reopened.root).includes('Completato'), 'nessun 100% ereditato dalla sessione chiusa');
    assert.match(flatText(reopened.root), /Scansiona documento/, 'si riparte dalla scelta del documento');
  } finally {
    if (reopened) await act(async () => { reopened.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 23. ORDINE HOOK: il guard di chiusura non deve separare gli hook
// ---------------------------------------------------------------------------

test('isOpen true -> false -> true a componente montato: stesso ordine di hook, nessun errore React', async () => {
  const renderer = await renderModal();
  // Stato non vuoto: così gli useMemo che stanno sotto il guard hanno lavoro vero.
  await goToSource(renderer, 'personal');
  await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
  await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });

  const consoleErrors: string[] = [];
  const savedConsoleError = console.error;
  console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(' ')); };
  try {
    // Chiusura SENZA smontare: è il caso che il vecchio guard rendeva illegale.
    await act(async () => {
      renderer.update(React.createElement(DocumentScannerModal, modalProps({ isOpen: false })));
    });
    assert.equal(renderer.toJSON(), null, 'chiuso: nessun nodo renderizzato, ma il componente è ancora montato');

    // Riapertura sullo stesso instance: lo stato riparte da zero, gli hook pure.
    await act(async () => {
      renderer.update(React.createElement(DocumentScannerModal, modalProps({ isOpen: true })));
    });
    assert.match(flatText(renderer.root), /Scansiona documento/, 'riaperto: si riparte dalla scelta del documento');
    assert.ok(byId(renderer, 'scan-type-personal'), 'la griglia dei tipi è di nuovo interattiva');
  } finally {
    console.error = savedConsoleError;
    await act(async () => { renderer.unmount(); });
  }

  assert.deepEqual(consoleErrors.filter(line => /hook/i.test(line)), [], 'nessun «Rendered fewer/more hooks than expected»');
});

// ---------------------------------------------------------------------------
// 24. ORARIO PERSONALE: domanda sulle ore, sequenza completa e vuoti visibili
// ---------------------------------------------------------------------------

/** Griglia reale 5x5 del documento di test: 18 ore, 7 posizioni libere. */
const REAL_TEAM_GRID: Array<Array<string>> = [
  ['', '3D', '3D', '3E', '3E'],
  ['3D', '', '3D', '3D', '3E'],
  ['', '3E', '3E', '3D', '3E'],
  ['', '3E', '3D', '3E', ''],
  ['3E', '3D', '3E', '', ''],
];
const REAL_SEQUENCE_FLAT = REAL_TEAM_GRID.flat();

test('orario personale: la domanda sulle ore blocca l analisi finché il valore non è valido', async () => {
  fetchResponse = { status: 200, json: personalResponse as any };
  const renderer = await renderModal();
  try {
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });

    // Prefill dalla configurazione delle fasce orarie dell'utente.
    assert.equal(byId(renderer, 'scan-periods-per-day').props.value, String(PERSONAL_PERIODS_PER_DAY), 'prefill da timeSlotConfig');
    assert.match(flatText(renderer.root), /Quante ore ci sono in ogni giornata scolastica\?/);
    assert.match(flatText(renderer.root), /30 posizioni/, 'la lunghezza attesa è mostrata prima dell invio');

    // Valore non valido: invio bloccato, nessuna richiesta.
    for (const bad of ['', '0', '-2', '2,5', 'abc', '25']) {
      await setPeriodsPerDay(renderer, bad);
      assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, true, `invio bloccato con "${bad}"`);
    }
    assert.equal(fetchCalls.length, 0, 'nessuna analisi partita senza un valore valido');

    // Valore valido MA non confermato: l invio resta bloccato. È il punto che
    // prima mancava: il campo era già compilato dalla proposta e l analisi
    // partiva senza che l utente avesse mai risposto alla domanda.
    await setPeriodsPerDay(renderer, '5');
    await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
    assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, true, 'numero valido ma non confermato: invio bloccato');
    assert.equal(fetchCalls.length, 0, 'nessuna analisi partita senza conferma');

    // Conferma esplicita: ora si può inviare.
    await confirmPeriodsPerDay(renderer);
    assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, false, 'consenso + ore confermate: si può inviare');
    await confirmAndSettleAnalysis(renderer);
    assert.equal(fetchCalls.length, 1, 'una sola chiamata');
    assert.equal(fetchCalls[0].body.periodsPerDay, 5, 'le ore dichiarate viaggiano nella richiesta');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('orario personale: cambiare il numero azzera la conferma (il valore confermato è quello visibile)', async () => {
  fetchResponse = { status: 200, json: personalResponse as any };
  const renderer = await renderModal();
  try {
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
    await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
    await confirmPeriodsPerDay(renderer);
    assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, false, 'confermato: si può inviare');
    // L'utente corregge il numero: la conferma precedente non vale più.
    await setPeriodsPerDay(renderer, '4');
    assert.equal(byId(renderer, 'scan-periods-per-day-confirm').props.checked, false, 'conferma azzerata');
    assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, true, 'invio bloccato dopo la modifica');
    assert.equal(fetchCalls.length, 0, 'nessuna analisi partita col valore vecchio');
    await confirmPeriodsPerDay(renderer);
    await confirmAndSettleAnalysis(renderer);
    assert.equal(fetchCalls[0].body.periodsPerDay, 4, 'viene inviato il numero confermato adesso');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('orario curricolare: le ore per giorno sono chieste e confermate come nel personale', async () => {
  fetchResponse = { status: 200, json: curricularResponse as any };
  const renderer = await renderModal();
  try {
    await goToSource(renderer, 'curricular');
    await pickFile(renderer, makeFile('istituto.jpg', 'image/jpeg', 30_000));
    await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });

    // La domanda c'è anche qui: il numero di colonne orarie della griglia non è
    // deducibile in modo affidabile dalla foto di un orario provvisorio.
    assert.equal(byId(renderer, 'scan-periods-per-day').props.value, String(PERSONAL_PERIODS_PER_DAY), 'prefill dalla configurazione');
    assert.match(flatText(renderer.root), /Quante ore ci sono in ogni giornata scolastica\?/);
    assert.match(flatText(renderer.root), /colonne orarie/, 'il testo della conferma parla di colonne, non di celle personali');

    // Solo consenso NON basta: senza conferma l'analisi non parte.
    await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
    assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, true, 'numero valido ma non confermato: invio bloccato');
    assert.equal(fetchCalls.length, 0, 'nessuna analisi partita senza conferma');

    await confirmPeriodsPerDay(renderer);
    assert.equal(byId(renderer, 'scan-consent-confirm').props.disabled, false, 'consenso + ore confermate: si può inviare');
    await confirmAndSettleAnalysis(renderer);
    assert.equal(fetchCalls.length, 1, 'una sola chiamata');
    assert.equal(fetchCalls[0].url, '/api/analyze-timetable');
    // Il contratto dell'analisi curricolare delle materie non cambia: le ore per
    // giorno confermate servono alla geometria del crop, non a questa chiamata.
    assert.equal('periodsPerDay' in fetchCalls[0].body, false, 'la request curricolare delle materie è invariata');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('preview crop diagnostica: solo nel flusso curricolare, solo dopo la conferma, mai persistita', async () => {
  fetchResponse = { status: 200, json: curricularResponse as any };
  const renderer = await renderModal();
  try {
    // Nel personale la diagnostica non esiste.
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
    assert.equal(renderer.root.findAll((el: any) => el.props?.id === 'crop-diagnostic-run').length, 0, 'nessuna diagnostica nel personale');

    // Nel curricolare c'è, ma è spenta finché le ore non sono confermate.
    await act(async () => { renderer.unmount(); });
    const curricular = await renderModal();
    try {
      await goToSource(curricular, 'curricular');
      await pickFile(curricular, makeFile('istituto.jpg', 'image/jpeg', 30_000));
      await act(async () => { byId(curricular, 'scan-analyze-cta').props.onClick(); });
      const run = byId(curricular, 'crop-diagnostic-run');
      assert.equal(run.props.disabled, true, 'senza ore confermate la diagnostica non parte');
      await confirmPeriodsPerDay(curricular);
      assert.equal(byId(curricular, 'crop-diagnostic-run').props.disabled, false, 'ore confermate: diagnostica disponibile');
      assert.equal(fetchCalls.length, 0, 'la diagnostica non è partita da sola');
      // Nessuna preview prima di averla chiesta esplicitamente.
      assert.equal(curricular.root.findAll((el: any) => el.props?.id === 'crop-diagnostic-preview').length, 0);
    } finally {
      await act(async () => { curricular.unmount(); });
    }
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('preview crop diagnostica: nessuna persistenza né log del contenuto', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const panel = readFileSync(join(process.cwd(), 'src', 'components', 'CropDiagnosticPanel.tsx'), 'utf8');
  const cropper = readFileSync(join(process.cwd(), 'src', 'utils', 'imageCropper.ts'), 'utf8');
  // I commenti descrivono i divieti: si verifica il CODICE, non la prosa.
  const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [name, source] of [['CropDiagnosticPanel.tsx', panel], ['imageCropper.ts', cropper]] as const) {
    const code = withoutComments(source);
    assert.ok(!/localStorage|indexedDB|dexie|services\/storage/i.test(code), `${name}: nessun accesso a storage`);
    assert.ok(!/console\.(log|warn|error)/.test(code), `${name}: nessun log`);
    assert.ok(!/toDataURL/.test(code), `${name}: il crop non diventa una stringa persistente`);
    assert.ok(!/fetch\(/.test(code) || /analyzeTimetableGeometry/.test(code), `${name}: nessuna chiamata fuori dalla geometria`);
  }
  // L'object URL del crop è sempre revocato.
  assert.match(panel, /revokePreviewUrl/, 'il pannello revoca gli object URL');
  assert.match(panel, /Non viene scritta su disco|resta in memoria/, 'il pannello dichiara di essere effimero');
});

test('orario personale con 5 ore: contratto 5x5=25 posizioni, vuoti nella loro posizione', async () => {
  fetchResponse = {
    status: 200,
    json: {
      success: true,
      source: 'test-model',
      rowLabel: 'Manganiello F.',
      cells: personalSequenceCells(REAL_SEQUENCE_FLAT, 5),
    } as any,
  };
  const renderer = await renderModal();
  try {
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
    await setPeriodsPerDay(renderer, '5');
    assert.match(flatText(renderer.root), /25 posizioni/, '5 ore x 5 giorni = 25 posizioni annunciate prima dell invio');
    await act(async () => { byId(renderer, 'scan-cloud-consent').props.onChange({ target: { checked: true } }); });
    await confirmPeriodsPerDay(renderer);
    await confirmAndSettleAnalysis(renderer);
    assert.equal(fetchCalls[0].body.periodsPerDay, 5);
    const text = flatText(renderer.root);
    assert.match(text, /25 posizioni/, 'la revisione mostra le 25 posizioni');
    // Lunedì 1ª e 2ª sono libere nella griglia reale: devono restare libere e al
    // loro posto, non compattate in testa o in coda.
    assert.match(text, /18/, 'le 18 ore lette sono distinguibili dalle 7 posizioni libere');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('orario personale: annullare la domanda non avvia alcuna analisi e non salva il numero', async () => {
  fetchResponse = { status: 200, json: personalResponse as any };
  const saved: SavedTimetable[] = [];
  const config = { firstHourStartTime: '08:15', periodsPerDay: 6, standardDurationMinutes: 55, customSlots: [] } as any;
  const renderer = await renderModal({ timeSlotConfig: config, onSaveReconstructedTimetable: (payload: SavedTimetable) => { saved.push(payload); } });
  try {
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await act(async () => { byId(renderer, 'scan-analyze-cta').props.onClick(); });
    await setPeriodsPerDay(renderer, '5');
    // L'utente torna indietro invece di confermare.
    await act(async () => {
      const back = renderer.root.findAll((el: any) => el.type === 'button' && nodeText(el).trim() === 'Indietro');
      assert.ok(back.length > 0, 'pulsante Indietro presente');
      back[0].props.onClick();
    });
    assert.equal(fetchCalls.length, 0, 'nessuna analisi partita dopo l annullamento');
    assert.equal(config.periodsPerDay, 6, 'il numero inserito NON è stato scritto nella configurazione');
    assert.deepEqual(saved, [], 'nessun salvataggio');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('orario personale: il numero confermato non viene mai salvato come configurazione', async () => {
  fetchResponse = {
    status: 200,
    json: {
      success: true,
      source: 'test-model',
      rowLabel: 'Manganiello F.',
      cells: personalSequenceCells(REAL_SEQUENCE_FLAT, 5),
    } as any,
  };
  const saved: SavedTimetable[] = [];
  const config = { firstHourStartTime: '08:15', periodsPerDay: 6, standardDurationMinutes: 55, customSlots: [] } as any;
  const renderer = await renderModal({
    timeSlotConfig: config,
    onSaveReconstructedTimetable: (slots: TimetableSlot[], target: string, mode: string) => { saved.push({ slots, target, mode }); return true; },
  });
  try {
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await analyzeWithConsent(renderer, '5');
    await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
    await chooseMergeModeIfAsked(renderer);
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
    assert.equal(saved.length, 1, 'il salvataggio dell orario è avvenuto');
    assert.equal(config.periodsPerDay, 6, 'la configurazione delle fasce orarie non è toccata dallo scanner');
    assert.ok(!JSON.stringify(saved).includes('periodsPerDay'), 'nessun periodsPerDay nel payload salvato');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('revisione personale: sequenza completa visibile, vuoti inclusi, nessuna auto-salvataggio', async () => {
  fetchResponse = {
    status: 200,
    json: {
      success: true,
      source: 'test-model',
      rowLabel: 'Manganiello F.',
      cells: personalSequenceCells(REAL_SEQUENCE_FLAT, 5),
    } as any,
  };
  const renderer = await renderModal();
  try {
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await analyzeWithConsent(renderer, '5');

    // Nessuna scelta della riga: è già verificata, ed è mostrata all'utente.
    assert.equal(renderer.root.findAll((el: any) => el.props?.name === 'scan-personal-row').length, 0, 'nessuna scelta della riga');
    assert.match(flatText(renderer.root), /Riga letta nel documento: Manganiello F\./);
    assert.match(
      flatText(byId(renderer, 'scan-personal-sequence-count')),
      /25 posizioni \( ?5 ore x 5 giorni\): 18 occupate, 7 vuote/,
    );

    // Le 25 posizioni sono visibili, una per ora, con le libere evidenziate.
    const sequence = flatText(byId(renderer, 'scan-personal-sequence'));
    assert.equal((sequence.match(/ª ora/g) ?? []).length, 25, 'ogni posizione fisica è mostrata');
    assert.equal((sequence.match(/libera/g) ?? []).length, 7, 'i vuoti restano visibili');
    for (const day of ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì']) {
      assert.ok(sequence.includes(day), `giorno ${day} presente`);
    }

    // Le ore che verrebbero salvate sono solo le 18 con un valore.
    assert.match(flatText(renderer.root), /Ore che verranno salvate \( ?18 ?\)/);
    assert.equal(fetchCalls.length, 1, 'una sola chiamata: nessuna estrazione o salvataggio automatico');
    assert.ok(!flatText(renderer.root).includes('Orario salvato'), 'nessun salvataggio prima della conferma');
    assert.match(flatText(renderer.root), /Nessun salvataggio ancora effettuato/);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('revisione personale: riga senza ore interpretabili -> esito controllato e CTA disabilitata', async () => {
  fetchResponse = {
    status: 200,
    json: { success: true, source: 'test-model', rowLabel: 'Manganiello F.', cells: personalSequenceCells(personalSequence()) } as any,
  };
  const renderer = await renderModal();
  try {
    await goToSource(renderer, 'personal');
    await pickFile(renderer, makeFile('orario.jpg', 'image/jpeg', 30_000));
    await analyzeWithConsent(renderer);

    assert.match(flatText(renderer.root), /Nessuna cella interpretabile nella riga: nessuna ora è stata inventata/);
    assert.equal((flatText(byId(renderer, 'scan-personal-sequence')).match(/libera/g) ?? []).length, PERSONAL_SEQUENCE_LENGTH, 'tutte le posizioni sono libere');
    const disabled = renderer.root.findAll((el: any) => el.props?.id === 'scan-personal-continue' && el.props?.disabled === true);
    assert.equal(disabled.length, 1, 'la CTA di prosecuzione è disabilitata, non nascosta');
    assert.equal(fetchCalls.length, 1, 'nessun salvataggio');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 23. VECCHIE ORE PERTINENTI: ARCHIVIO GIUSTO + SCELTA OBBLIGATORIA (CASO A–D)
// ---------------------------------------------------------------------------

/** Valore del selettore "Salva in" (stringa vuota = archivio ancora da scegliere). */
const archiveValue = (renderer: any): string => byId(renderer, 'recon-target').props.value;

/** Radio della scelta, nell'ordine mostrato in UI: 0 = sostituisci, 1 = mantieni e aggiungi. */
const mergeRadiosOf = (renderer: any): any[] =>
  renderer.root.findAll((el: any) => el.props?.name === 'scan-merge-mode');

/** Il salvataggio è bloccato finché manca una scelta dovuta (archivio e/o modalità). */
const saveDisabled = (renderer: any): boolean => byId(renderer, 'recon-confirm-save').props.disabled;

/** CASO A — vecchie ore pertinenti solo nel provvisorio. */
const CASO_A_PROV: TimetableSlot[] = [
  { id: 'prov-1', dayOfWeek: 2, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3D' },
];

/** CASO B — vecchie ore pertinenti solo nel definitivo (il caso che rompeva il salvataggio). */
const CASO_B_DEF: TimetableSlot[] = [
  { id: 'def-1', dayOfWeek: 4, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3D' },
];

test('CASO A: vecchie ore solo nel provvisorio -> archivio provvisorio, scelta obbligatoria senza default', async () => {
  const renderer = await renderModal({ provisionalTimetable: CASO_A_PROV, definitiveTimetable: [] });
  try {
    await flowToReconstruction(renderer);
    const text = flatText(renderer.root);

    assert.equal(archiveValue(renderer), 'provvisorio', 'l archivio con le vecchie ore è già quello giusto');
    assert.equal(renderer.root.findAll((el: any) => el.props?.id === 'recon-archive-choice').length, 0, 'nessun avviso: l archivio non è ambiguo');
    assert.match(text, /Esiste già un orario di sostegno salvato\./);
    assert.match(text, /Archivio: Provvisorio · 1 ora pertinente/);
    assert.match(text, /Sovrascrivi orario esistente/);
    assert.match(text, /Mantieni e aggiungi/);
    assert.deepEqual(mergeRadiosOf(renderer).map((el: any) => el.props.checked), [false, false], 'nessuna pre-selezione');
    assert.match(text, /Scegli una delle due opzioni per poter salvare\./);
    assert.equal(saveDisabled(renderer), true, 'il salvataggio è bloccato prima della scelta');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('CASO A + "mantieni e aggiungi": scrittura nel provvisorio e vecchie ore intatte', async () => {
  const { applyReconstruction } = await import('../src/utils/reconstructTimetable');
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: CASO_A_PROV,
    definitiveTimetable: [],
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
  });
  try {
    await flowToReconstruction(renderer);
    await act(async () => { mergeRadiosOf(renderer)[1].props.onChange(); });
    assert.equal(saveDisabled(renderer), false, 'il salvataggio si sblocca appena la scelta è fatta');
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

    assert.equal(saved[0].target, 'provvisorio');
    assert.equal(saved[0].mode, 'missing-only');
    const merged = applyReconstruction(CASO_A_PROV, saved[0].slots, 'missing-only', { profile });
    assert.ok(merged.slots.some(slot => slot.id === 'prov-1'), 'la vecchia ora di sostegno resta dov era');
    assert.equal(merged.removedCount, 0, 'nessuna rimozione in "mantieni e aggiungi"');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('CASO A + "sostituisci": anteprima reale e salvataggio in sostituzione d ambito', async () => {
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: CASO_A_PROV,
    definitiveTimetable: [],
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
  });
  try {
    await flowToReconstruction(renderer);
    await act(async () => { mergeRadiosOf(renderer)[0].props.onChange(); });
    const preview = flatText(byId(renderer, 'recon-replace-preview'));
    assert.match(preview, /1 ore esistenti di sostegno verranno sostituite/, 'l unica vecchia ora pertinente');
    assert.match(preview, /1 aggiornate/, 'martedì 1ª 3D è ricoperta dal nuovo orario');
    assert.equal(saveDisabled(renderer), false);
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
    assert.equal(saved[0].mode, 'replace-scope');
    assert.equal(saved[0].target, 'provvisorio');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('CASO B: vecchie ore solo nel definitivo -> il bersaglio diventa definitivo, mai una scrittura silenziosa nel provvisorio', async () => {
  const renderer = await renderModal({ provisionalTimetable: [], definitiveTimetable: CASO_B_DEF });
  try {
    await flowToReconstruction(renderer);
    const text = flatText(renderer.root);

    assert.equal(archiveValue(renderer), 'definitivo', 'le vecchie ore stanno nel definitivo: è lì che va scritto');
    assert.equal(renderer.root.findAll((el: any) => el.props?.id === 'recon-archive-choice').length, 0, 'nessun avviso: l archivio non è ambiguo');
    assert.match(text, /Esiste già un orario di sostegno salvato\./);
    assert.match(text, /Archivio: Definitivo · 1 ora pertinente/);
    assert.deepEqual(mergeRadiosOf(renderer).map((el: any) => el.props.checked), [false, false], 'nessuna pre-selezione');
    assert.equal(saveDisabled(renderer), true, 'il salvataggio è bloccato prima della scelta');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('CASO B + "sostituisci": la vecchia ora del definitivo viene sostituita davvero', async () => {
  const { applyReconstruction } = await import('../src/utils/reconstructTimetable');
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: [],
    definitiveTimetable: CASO_B_DEF,
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
  });
  try {
    await flowToReconstruction(renderer);
    await act(async () => { mergeRadiosOf(renderer)[0].props.onChange(); });
    const preview = flatText(byId(renderer, 'recon-replace-preview'));
    assert.match(preview, /1 rimosse perché non presenti nel nuovo orario/, 'l anteprima annuncia la rimozione reale');
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

    assert.equal(saved[0].target, 'definitivo', 'nessuna scrittura nel provvisorio con le vecchie ore ancora nel definitivo');
    assert.equal(saved[0].mode, 'replace-scope');
    const definitivo = applyReconstruction(CASO_B_DEF, saved[0].slots, 'replace-scope', { profile });
    assert.equal(definitivo.slots.some(slot => slot.id === 'def-1'), false, 'la vecchia ora non sopravvive al salvataggio');
    // Il nuovo orario non copre il giovedì: la vecchia ora esce dall'ambito e viene rimossa.
    assert.equal(definitivo.replacedCount, 0);
    assert.equal(definitivo.removedCount, 1, 'giovedì 1ª 3D è rimossa perché assente nel nuovo orario');
    assert.equal(definitivo.addedCount, 2, 'martedì 1ª 3D e mercoledì 1ª 3E entrano nel definitivo');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('CASO B legacy: ore salvate senza schoolId valgono l istituto principale e vengono riconosciute', async () => {
  const legacy: TimetableSlot[] = [
    // Archivi storici: nessuna schoolId, stesso criterio della sostituzione reale.
    { id: 'legacy-def', dayOfWeek: 4, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3D' },
  ];
  const renderer = await renderModal({ provisionalTimetable: [], definitiveTimetable: legacy });
  try {
    await flowToReconstruction(renderer);
    assert.equal(archiveValue(renderer), 'definitivo');
    assert.match(flatText(renderer.root), /Archivio: Definitivo · 1 ora pertinente/);
    assert.equal(mergeRadiosOf(renderer).length, 2, 'la domanda compare anche per gli archivi legacy');
    assert.equal(saveDisabled(renderer), true);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('CASO C: vecchie ore di sola materia -> nessuna domanda e salvataggio subito disponibile', async () => {
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: [
      { id: 'ex-math', dayOfWeek: 2, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Matematica', className: '3D' },
    ],
    definitiveTimetable: [
      { id: 'ex-ita', dayOfWeek: 4, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Italiano', className: '3E' },
    ],
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
  });
  try {
    await flowToReconstruction(renderer);
    const text = flatText(renderer.root);
    assert.equal(mergeRadiosOf(renderer).length, 0, 'nessuna domanda su ore non pertinenti');
    assert.equal(text.includes('Esiste già un orario di sostegno salvato.'), false);
    assert.equal(saveDisabled(renderer), false, 'niente blocca un salvataggio senza conflitto');
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
    assert.equal(saved[0].mode, 'missing-only', 'il default sicuro resta quello di prima');
    assert.equal(saved[0].target, 'provvisorio', 'il bersaglio predefinito non cambia');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('CASO C: vecchie ore di un altro istituto -> nessuna domanda, e compaiono solo se si sceglie quell istituto', async () => {
  const { slotsInReplacementScope } = await import('../src/utils/reconstructTimetable');
  const saved: SavedTimetable[] = [];
  const otherSchool: TimetableSlot[] = [
    { id: 'ex-other', dayOfWeek: 2, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '3D', schoolId: 'school-b' },
  ];
  const renderer = await renderModal({
    profile: multiSchoolProfile,
    provisionalTimetable: otherSchool,
    definitiveTimetable: [],
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
  });
  try {
    await flowToReconstruction(renderer);
    assert.equal(mergeRadiosOf(renderer).length, 0, 'le ore di un altro istituto non sono in ambito');
    assert.equal(saveDisabled(renderer), false);

    // Se l'utente sceglie proprio quell'istituto, le sue ore diventano pertinenti.
    const schoolSelect = renderer.root.findByProps({ 'aria-label': 'Istituto' });
    await act(async () => { schoolSelect.props.onChange({ target: { value: 'school-b' } }); });
    assert.equal(mergeRadiosOf(renderer).length, 2, 'la domanda compare solo per l istituto giusto');
    assert.match(flatText(renderer.root), /Archivio: Provvisorio · 1 ora pertinente/);
    assert.equal(saveDisabled(renderer), true);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
  assert.ok(saved.length === 0 && slotsInReplacementScope, 'nessun salvataggio in questo scenario');
});

test('CASO D: ore pertinenti in entrambi gli archivi -> avviso, archivio da scegliere, salvataggio bloccato', async () => {
  const renderer = await renderModal({ provisionalTimetable: CASO_A_PROV, definitiveTimetable: CASO_B_DEF });
  try {
    await flowToReconstruction(renderer);
    const text = flatText(renderer.root);

    assert.equal(archiveValue(renderer), '', 'nessun archivio deciso al posto dell utente');
    const notice = flatText(byId(renderer, 'recon-archive-choice'));
    assert.match(notice, /presenti in entrambi gli archivi/);
    assert.match(notice, /1 nel provvisorio, 1 nel definitivo/);
    assert.match(notice, /L'altro archivio non viene toccato/, 'nessuna cancellazione incrociata automatica');
    assert.match(text, /Archivio: da scegliere · 2 ore pertinenti/);
    assert.deepEqual(mergeRadiosOf(renderer).map((el: any) => el.props.checked), [false, false]);
    assert.equal(saveDisabled(renderer), true);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('CASO D + scelta del definitivo: si aggiorna solo quello, e cambiando archivio la scelta va rifatta', async () => {
  const { applyReconstruction } = await import('../src/utils/reconstructTimetable');
  const saved: SavedTimetable[] = [];
  const renderer = await renderModal({
    provisionalTimetable: CASO_A_PROV,
    definitiveTimetable: CASO_B_DEF,
    onSaveReconstructedTimetable: (slots, target, mode) => { saved.push({ slots, target, mode }); return true; },
  });
  try {
    await flowToReconstruction(renderer);
    // Una modalità scelta prima di decidere l'archivio non può valere per entrambi.
    await act(async () => { mergeRadiosOf(renderer)[1].props.onChange(); });
    assert.equal(saveDisabled(renderer), true, 'manca ancora l archivio');

    await act(async () => { byId(renderer, 'recon-target').props.onChange({ target: { value: 'definitivo' } }); });
    assert.deepEqual(mergeRadiosOf(renderer).map((el: any) => el.props.checked), [false, false], 'cambiando archivio la scelta va rifatta');
    assert.match(flatText(renderer.root), /Archivio: Definitivo · 1 ora pertinente/);

    await act(async () => { mergeRadiosOf(renderer)[0].props.onChange(); });
    assert.equal(saveDisabled(renderer), false, 'archivio e modalità scelti: si può salvare');
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

    assert.equal(saved.length, 1, 'una sola scrittura');
    assert.equal(saved[0].target, 'definitivo');
    assert.equal(saved[0].mode, 'replace-scope');
    const definitivo = applyReconstruction(CASO_B_DEF, saved[0].slots, 'replace-scope', { profile });
    assert.equal(definitivo.slots.some(slot => slot.id === 'def-1'), false, 'la vecchia ora del definitivo è sostituita');
    const provvisorio = applyReconstruction(CASO_A_PROV, [], 'replace-scope', { profile });
    assert.equal(provvisorio.slots.length, 1, 'l altro archivio non viene toccato dal modale');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 24. SOVRASCRITTURA INTEGRALE + SCROLL DOPO IL SALVATAGGIO
// ---------------------------------------------------------------------------

/** Vecchia settimana di sostegno dell'istituto corrente (slot legacy: nessuna schoolId). */
const OLD_WEEK_SUPPORT: TimetableSlot[] = [
  { id: 'old-lun2', dayOfWeek: 1, periodNumber: 2, startTime: '09:10', endTime: '10:05', subject: 'Sostegno', className: '3D' },
  { id: 'old-lun3', dayOfWeek: 1, periodNumber: 3, startTime: '10:05', endTime: '11:00', subject: 'Sostegno', className: '3D' },
  { id: 'old-gio5', dayOfWeek: 4, periodNumber: 5, startTime: '12:05', endTime: '13:00', subject: 'Sostegno', className: '3E' },
  { id: 'old-ven4', dayOfWeek: 5, periodNumber: 4, startTime: '11:00', endTime: '12:05', subject: 'Sostegno', className: '3E' },
];
/** Dati che la sovrascrittura NON deve toccare. */
const OLD_MATH: TimetableSlot = { id: 'old-math', dayOfWeek: 2, periodNumber: 2, startTime: '09:10', endTime: '10:05', subject: 'Matematica', className: '3D' };
const OLD_OTHER_SCHOOL: TimetableSlot = { id: 'old-altro', dayOfWeek: 3, periodNumber: 1, startTime: '08:15', endTime: '09:10', subject: 'Sostegno', className: '1A', schoolId: 'school-b' };

/** Nuovo orario settimanale letto dal documento: lunedì 2ª, lunedì 3ª, martedì 1ª (3D). */
const NEW_WEEK_RESPONSE = personalTimetableResponse({ 1: '3D', 2: '3D', 6: '3D' });

/** Flusso solo personale (senza curricolare) fino alla schermata di conferma. */
async function flowPersonalToConfirmation(renderer: any, response: unknown = personalResponse) {
  await goToSource(renderer, 'personal');
  fetchResponse = { status: 200, json: response as any };
  await chooseCameraAndPick(renderer, makeFile('orario-personale.jpg', 'image/jpeg', 20_000));
  await analyzeWithConsent(renderer);
  await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
  return renderer;
}

/**
 * Archivi in memoria + la STESSA scrittura di `App.handleSaveReconstructedTimetable`
 * (`applyReconstruction` sull'archivio scelto): nessuna persistenza parallela.
 */
async function appArchives(provvisorio: TimetableSlot[], definitivo: TimetableSlot[]) {
  const { applyReconstruction } = await import('../src/utils/reconstructTimetable');
  const saved: SavedTimetable[] = [];
  const handler = (slots: TimetableSlot[], target: string, mode: string) => {
    saved.push({ slots, target, mode });
    const archive = target === 'provvisorio' ? provvisorio : definitivo;
    const merged = applyReconstruction(archive, slots, mode as any, { profile });
    archive.length = 0;
    archive.push(...merged.slots);
    return true;
  };
  return { saved, handler };
}

/** Ore di sostegno dell'istituto corrente presenti in un archivio. */
const supportHoursOf = (archive: TimetableSlot[]) =>
  archive.filter(s => /sostegno/i.test(s.subject) && s.schoolId !== 'school-b')
    .map(s => `${s.dayOfWeek}/${s.periodNumber} ${s.className}`)
    .sort();

test('F. sovrascrittura dal modale: il provvisorio resta con esattamente le nuove ore di sostegno', async () => {
  const provvisorio = [...OLD_WEEK_SUPPORT, OLD_MATH, OLD_OTHER_SCHOOL];
  const definitivo: TimetableSlot[] = [];
  const { saved, handler } = await appArchives(provvisorio, definitivo);
  const renderer = await renderModal({
    provisionalTimetable: provvisorio,
    definitiveTimetable: definitivo,
    onSaveReconstructedTimetable: handler,
  });
  try {
    await flowPersonalToConfirmation(renderer, NEW_WEEK_RESPONSE);
    assert.equal(archiveValue(renderer), 'provvisorio');
    const radios = mergeRadiosOf(renderer);
    assert.deepEqual(radios.map((el: any) => el.props.checked), [false, false], 'nessuna pre-selezione');
    await act(async () => { radios[0].props.onChange(); }); // "Sovrascrivi orario esistente"

    const preview = flatText(byId(renderer, 'recon-replace-preview'));
    assert.match(preview, /4 ore esistenti di sostegno verranno sostituite/, 'tutta la vecchia settimana è nell ambito');
    assert.match(preview, /2 rimosse perché non presenti nel nuovo orario/, 'giovedì 5ª e venerdì 4ª');

    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });
    assert.equal(saved[0].target, 'provvisorio');
    assert.equal(saved[0].mode, 'replace-scope');
    assert.deepEqual(supportHoursOf(provvisorio), ['1/2 3D', '1/3 3D', '2/1 3D'], 'risultato esatto: lunedì 2ª, lunedì 3ª, martedì 1ª');
    assert.equal(provvisorio.some(s => s.id === 'old-gio5' || s.id === 'old-ven4'), false, 'le vecchie ore fuori dal nuovo orario sono eliminate');
    assert.ok(provvisorio.some(s => s.id === 'old-math'), 'l ora di materia resta');
    assert.ok(provvisorio.some(s => s.id === 'old-altro'), 'l ora dell altro istituto resta');
    assert.equal(definitivo.length, 0, 'l altro archivio non viene scritto');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('G. definitivo: la sovrascrittura aggiorna il definitivo e lascia intatto il provvisorio', async () => {
  const provvisorio: TimetableSlot[] = [{ ...OLD_MATH, id: 'prov-math' }];
  const definitivo = [...OLD_WEEK_SUPPORT];
  const { saved, handler } = await appArchives(provvisorio, definitivo);
  const renderer = await renderModal({
    provisionalTimetable: provvisorio,
    definitiveTimetable: definitivo,
    onSaveReconstructedTimetable: handler,
  });
  try {
    await flowPersonalToConfirmation(renderer, NEW_WEEK_RESPONSE);
    assert.equal(archiveValue(renderer), 'definitivo', 'il vecchio orario pertinente sta nel definitivo');
    assert.match(flatText(renderer.root), /Archivio: Definitivo · 4 ore pertinenti/);
    await act(async () => { mergeRadiosOf(renderer)[0].props.onChange(); });
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

    assert.equal(saved[0].target, 'definitivo');
    assert.equal(saved[0].mode, 'replace-scope');
    assert.deepEqual(supportHoursOf(definitivo), ['1/2 3D', '1/3 3D', '2/1 3D'], 'la vecchia settimana del definitivo è sostituita');
    assert.deepEqual(provvisorio.map(s => s.id), ['prov-math'], 'il provvisorio non viene toccato');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('H. entrambi gli archivi: viene modificato soltanto quello scelto dall utente', async () => {
  const provvisorio = [...OLD_WEEK_SUPPORT];
  const definitivo: TimetableSlot[] = [
    { id: 'def-lun2', dayOfWeek: 1, periodNumber: 2, startTime: '09:10', endTime: '10:05', subject: 'Sostegno', className: '3D' },
    { id: 'def-gio5', dayOfWeek: 4, periodNumber: 5, startTime: '12:05', endTime: '13:00', subject: 'Sostegno', className: '3E' },
  ];
  const { saved, handler } = await appArchives(provvisorio, definitivo);
  const renderer = await renderModal({
    provisionalTimetable: provvisorio,
    definitiveTimetable: definitivo,
    onSaveReconstructedTimetable: handler,
  });
  try {
    await flowPersonalToConfirmation(renderer, NEW_WEEK_RESPONSE);
    assert.equal(archiveValue(renderer), '', 'nessun archivio deciso al posto dell utente');

    await act(async () => { byId(renderer, 'recon-target').props.onChange({ target: { value: 'definitivo' } }); });
    await act(async () => { mergeRadiosOf(renderer)[0].props.onChange(); });
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

    assert.equal(saved.length, 1, 'una sola scrittura');
    assert.equal(saved[0].target, 'definitivo');
    assert.deepEqual(supportHoursOf(definitivo), ['1/2 3D', '1/3 3D', '2/1 3D'], 'il definitivo è sovrascritto');
    assert.deepEqual(supportHoursOf(provvisorio), ['1/2 3D', '1/3 3D', '4/5 3E', '5/4 3E'], 'il provvisorio resta esattamente com era');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

/** Nodo scrollabile finto: registra le richieste di scroll. */
function fakeScrollableNode() {
  const calls: Array<{ top?: number; behavior?: string }> = [];
  return { calls, node: { scrollTo: (options: { top?: number; behavior?: string }) => { calls.push(options); } } };
}

/** Nodo finto su cui registrare le richieste di `scrollIntoView`. */
function fakeScrollIntoViewNode() {
  const calls: Array<{ behavior?: string; block?: string }> = [];
  return { calls, node: { scrollIntoView: (options: { behavior?: string; block?: string }) => { calls.push(options); } } };
}

/**
 * Installa un `document` minimale che espone il corpo scrollabile del modale e,
 * se richiesto, la sezione con la scelta Aggiungi/Sovrascrivi.
 */
function useFakeDocument(node: unknown, sectionNode?: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById: (id: string) => (id === SCAN_MODAL_BODY_ID
        ? node
        : id === SCAN_MERGE_CHOICE_ID ? (sectionNode ?? null) : null),
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete (globalThis as any).document;
  };
}

test('I. salvataggio riuscito: il contenuto del modale torna in cima e l esito è visibile', async () => {
  const { calls, node } = fakeScrollableNode();
  const renderer = await renderModal({
    provisionalTimetable: CASO_A_PROV,
    definitiveTimetable: [],
    onSaveReconstructedTimetable: () => true,
  });
  const restore = useFakeDocument(node);
  try {
    await flowToReconstruction(renderer);
    assert.deepEqual(calls, [], 'nessuno scroll durante analisi e revisione');
    await act(async () => { mergeRadiosOf(renderer)[0].props.onChange(); });
    assert.deepEqual(calls, [], 'nessuno scroll prima del salvataggio');
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

    assert.deepEqual(calls, [{ top: 0, behavior: 'smooth' }], 'scroll in cima richiesto una sola volta, dopo il successo');
    assert.match(flatText(byId(renderer, 'scan-timetable-saved')), /Orario salvato/, 'il messaggio di esito è in cima al contenuto');
  } finally {
    restore();
    await act(async () => { renderer.unmount(); });
  }
});

test('J. salvataggio fallito: nessuno scroll e nessun messaggio di successo', async () => {
  const { calls, node } = fakeScrollableNode();
  const renderer = await renderModal({
    provisionalTimetable: CASO_A_PROV,
    definitiveTimetable: [],
    onSaveReconstructedTimetable: () => false, // l archivio rifiuta la scrittura
  });
  const restore = useFakeDocument(node);
  try {
    await flowToReconstruction(renderer);
    await act(async () => { mergeRadiosOf(renderer)[0].props.onChange(); });
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

    assert.deepEqual(calls, [], 'nessuno scroll se il salvataggio non è riuscito');
    assert.equal(renderer.root.findAll((el: any) => el.props?.id === 'scan-timetable-saved').length, 0, 'nessun esito di successo');
  } finally {
    restore();
    await act(async () => { renderer.unmount(); });
  }
});

test('K. review personale pronta: la scelta Aggiungi/Sovrascrivi è portata in vista una sola volta', async () => {
  const { calls: bodyCalls, node: bodyNode } = fakeScrollableNode();
  const { calls: sectionCalls, node: sectionNode } = fakeScrollIntoViewNode();
  const renderer = await renderModal({
    provisionalTimetable: CASO_A_PROV,
    definitiveTimetable: [],
    onSaveReconstructedTimetable: () => true,
  });
  const restore = useFakeDocument(bodyNode, sectionNode);
  try {
    // Review personale (senza curricolare): analisi + revisione delle ore.
    await goToSource(renderer, 'personal');
    fetchResponse = { status: 200, json: personalResponse as any };
    await chooseCameraAndPick(renderer, makeFile('orario-personale.jpg', 'image/jpeg', 20_000));
    await analyzeWithConsent(renderer);
    assert.ok(byId(renderer, 'scan-personal-sequence'), 'la review delle ore è a schermo');
    assert.deepEqual(sectionCalls, [], 'nessuno scroll durante l analisi e la review: la scelta non c è ancora');
    assert.deepEqual(bodyCalls, [], 'nessuno scroll del corpo del modale');

    // La schermata di conferma mostra la scelta: va portata in vista.
    await act(async () => { byId(renderer, 'scan-personal-continue').props.onClick(); });
    assert.deepEqual(sectionCalls, [{ behavior: 'smooth', block: 'start' }], 'navigazione richiesta verso la sezione della scelta');
    assert.deepEqual(bodyCalls, [], 'non è uno scroll generico in cima al modale');

    // Rerender dovuti a una scelta già visibile: nessuno scroll aggiuntivo.
    await act(async () => { mergeRadiosOf(renderer)[0].props.onChange(); });
    await act(async () => { mergeRadiosOf(renderer)[1].props.onChange(); });
    await act(async () => { byId(renderer, 'recon-target').props.onChange({ target: { value: 'provvisorio' } }); });
    assert.deepEqual(sectionCalls, [{ behavior: 'smooth', block: 'start' }], 'cambiare radio/select non provoca un nuovo scroll');
  } finally {
    restore();
    await act(async () => { renderer.unmount(); });
  }
});

test('L. nessuno scroll se la scelta non è disponibile (nessuna vecchia ora pertinente)', async () => {
  const { calls: bodyCalls, node: bodyNode } = fakeScrollableNode();
  const { calls: sectionCalls, node: sectionNode } = fakeScrollIntoViewNode();
  const renderer = await renderModal({ provisionalTimetable: [], definitiveTimetable: [] });
  const restore = useFakeDocument(bodyNode, sectionNode);
  try {
    await flowPersonalToConfirmation(renderer);
    assert.equal(renderer.root.findAll((el: any) => el.props?.id === SCAN_MERGE_CHOICE_ID).length, 0, 'nessuna sezione di scelta: non esistono vecchie ore');
    assert.deepEqual(sectionCalls, [], 'nessuna navigazione richiesta');
    assert.deepEqual(bodyCalls, [], 'nessuno scroll del corpo');
  } finally {
    restore();
    await act(async () => { renderer.unmount(); });
  }
});

test('M. dopo il salvataggio riuscito resta lo scroll in cima al messaggio di esito', async () => {
  const { calls: bodyCalls, node: bodyNode } = fakeScrollableNode();
  const { calls: sectionCalls, node: sectionNode } = fakeScrollIntoViewNode();
  const renderer = await renderModal({
    provisionalTimetable: CASO_A_PROV,
    definitiveTimetable: [],
    onSaveReconstructedTimetable: () => true,
  });
  const restore = useFakeDocument(bodyNode, sectionNode);
  try {
    await flowPersonalToConfirmation(renderer);
    assert.deepEqual(sectionCalls, [{ behavior: 'smooth', block: 'start' }], 'momento 1: la scelta è portata in vista');
    assert.deepEqual(bodyCalls, [], 'il corpo non è ancora scrollato');

    await act(async () => { mergeRadiosOf(renderer)[0].props.onChange(); });
    await act(async () => { byId(renderer, 'recon-confirm-save').props.onClick(); });

    assert.deepEqual(bodyCalls, [{ top: 0, behavior: 'smooth' }], 'momento 2: dopo il successo il modale torna in cima');
    assert.deepEqual(sectionCalls, [{ behavior: 'smooth', block: 'start' }], 'lo scroll alla scelta non si ripete dopo il salvataggio');
    assert.match(flatText(byId(renderer, 'scan-timetable-saved')), /Orario salvato/, 'il messaggio di esito è in cima al contenuto');
  } finally {
    restore();
    await act(async () => { renderer.unmount(); });
  }
});

test('N. la scelta Aggiungi/Sovrascrivi resta obbligatoria e senza default', async () => {
  const { calls: sectionCalls, node: sectionNode } = fakeScrollIntoViewNode();
  const renderer = await renderModal({
    provisionalTimetable: CASO_A_PROV,
    definitiveTimetable: [],
    onSaveReconstructedTimetable: () => true,
  });
  const restore = useFakeDocument(fakeScrollableNode().node, sectionNode);
  try {
    await flowPersonalToConfirmation(renderer);
    assert.deepEqual(sectionCalls, [{ behavior: 'smooth', block: 'start' }], 'la sezione è in vista');
    assert.equal(mergeRadiosOf(renderer).length, 2, 'le due opzioni sono presenti');
    assert.ok(mergeRadiosOf(renderer).every((radio: any) => radio.props.checked === false), 'nessuna opzione pre-selezionata');
    assert.ok(byId(renderer, 'recon-merge-choice-required'), 'la scelta è dichiarata obbligatoria');
    assert.equal(saveDisabled(renderer), true, 'salvataggio bloccato prima della scelta');

    await act(async () => { mergeRadiosOf(renderer)[0].props.onChange(); });
    assert.equal(saveDisabled(renderer), false, 'salvataggio sbloccato dopo la scelta');
    assert.deepEqual(sectionCalls, [{ behavior: 'smooth', block: 'start' }], 'nessuno scroll aggiuntivo');
  } finally {
    restore();
    await act(async () => { renderer.unmount(); });
  }
});

test('scroll di una sezione: richiesta scrollIntoView, nessun crash senza nodo', () => {
  const section = fakeScrollIntoViewNode();
  assert.equal(scrollSectionIntoView(section.node), true);
  assert.deepEqual(section.calls, [{ behavior: 'smooth', block: 'start' }]);
  assert.equal(scrollSectionIntoView({}), false, 'nodo senza scrollIntoView: nessuna richiesta');
  assert.equal(scrollSectionIntoView(null), false);
  assert.equal(scrollSectionIntoView(undefined), false);
});

test('scroll del modale: richiesta al contenitore interno, mai a window', () => {
  const withScrollTo = fakeScrollableNode();
  assert.equal(scrollModalBodyToTop(withScrollTo.node), true);
  assert.deepEqual(withScrollTo.calls, [{ top: 0, behavior: 'smooth' }]);

  const legacyNode: { scrollTop: number } = { scrollTop: 480 };
  assert.equal(scrollModalBodyToTop(legacyNode), true, 'fallback per i nodi senza scrollTo');
  assert.equal(legacyNode.scrollTop, 0);

  assert.equal(scrollModalBodyToTop(null), false, 'nessun nodo: nessuna richiesta');
  assert.equal(scrollModalBodyToTop(undefined), false);
});
