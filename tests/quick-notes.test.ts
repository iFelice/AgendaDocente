import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { FutureCommitmentsView } from '../src/components/FutureCommitmentsView';
import { QuickNoteModal } from '../src/components/QuickNoteModal';
import { buildQuickNoteEvent } from '../src/utils/quickNote';
import {
  deriveFutureCommitments,
  derivePastCommitments,
  deriveArchiveCommitments,
  groupFutureCommitments,
  isQuickNoteEvent,
  FUTURE_COMMITMENT_SOURCE_LABELS,
} from '../src/utils/futureCommitments';
import type { CalendarEvent, Student, StudentScheduledAssessment } from '../src/types';
import { addDaysISO, localDateISO } from '../src/utils/dates';

/**
 * N2 — note/promemoria personali rapidi da "Note e impegni".
 *
 * Contratto: nessuna nuova persistenza. Una nota è un normale CalendarEvent
 * manuale con category "promemoria", salvato dal flusso già esistente.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(here, '../src/App.tsx'), 'utf8');
const viewSource = readFileSync(resolve(here, '../src/components/FutureCommitmentsView.tsx'), 'utf8');
const modalSource = readFileSync(resolve(here, '../src/components/QuickNoteModal.tsx'), 'utf8');
const quickNoteSource = readFileSync(resolve(here, '../src/utils/quickNote.ts'), 'utf8');
const dbSource = readFileSync(resolve(here, '../src/services/db.ts'), 'utf8');
const storageSource = readFileSync(resolve(here, '../src/services/storage.ts'), 'utf8');
const backupSource = readFileSync(resolve(here, '../src/services/backup.ts'), 'utf8');
const typesSource = readFileSync(resolve(here, '../src/types.ts'), 'utf8');
const eventModalSource = readFileSync(resolve(here, '../src/components/EventModal.tsx'), 'utf8');
const deadlinesSource = readFileSync(resolve(here, '../src/components/DeadlinesView.tsx'), 'utf8');

// Mercoledì 2026-04-15 come "oggi" di riferimento.
const TODAY = '2026-04-15';
const PROFILE_CLASSES = ['3D', '2E', '3E'];

const students: Student[] = [
  { id: 'stu-1', fullName: 'Mario Rossi', className: '3E', notes: [] } as unknown as Student,
];

function event(partial: Partial<CalendarEvent> & { id: string; date: string }): CalendarEvent {
  return {
    title: 'Impegno',
    category: 'riunione',
    isAllDay: false,
    sourceType: 'manuale',
    ...partial,
  } as CalendarEvent;
}

function note(partial: Partial<CalendarEvent> & { id: string; date: string }): CalendarEvent {
  return {
    title: 'Ricordare di chiamare la famiglia Rossi',
    category: 'promemoria',
    isAllDay: true,
    sourceType: 'manuale',
    completed: false,
    ...partial,
  } as CalendarEvent;
}

function derive(events: CalendarEvent[], assessments: StudentScheduledAssessment[] = []) {
  return deriveFutureCommitments({ events, scheduledAssessments: assessments, students, todayIso: TODAY });
}

function derivePast(events: CalendarEvent[], assessments: StudentScheduledAssessment[] = []) {
  return derivePastCommitments({ events, scheduledAssessments: assessments, students, todayIso: TODAY });
}

async function renderView(props: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(FutureCommitmentsView, {
        events: [],
        scheduledAssessments: [],
        students,
        todayIso: TODAY,
        classes: PROFILE_CLASSES,
        onCreateNote: () => {},
        ...props,
      } as any),
    );
  });
  return renderer;
}

async function renderModal(props: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(QuickNoteModal, {
        isOpen: true,
        onClose: () => {},
        onSave: () => {},
        classes: PROFILE_CLASSES,
        todayIso: TODAY,
        ...props,
      } as any),
    );
  });
  return renderer;
}

// --- 1..3: pulsante e apertura modal ---------------------------------------

test('1. il pulsante "Nuova nota" è visibile nell\'header di Note e impegni', async () => {
  const renderer = await renderView();
  const button = renderer.root.findByProps({ 'data-new-note-button': true });
  assert.ok(button);
  assert.match(JSON.stringify(renderer.toJSON()), /Nuova nota/);
  await act(async () => renderer.unmount());
});

test('2. la vista mantiene soltanto la UI lista: il QuickNoteModal è unico e gestito da App', async () => {
  const renderer = await renderView();
  assert.equal(renderer.root.findAllByProps({ 'data-quick-note-modal': true }).length, 0);
  assert.ok(!viewSource.includes('<QuickNoteModal'), 'FutureCommitmentsView non monta un secondo modal');
  assert.match(appSource, /<QuickNoteModal/);
  await act(async () => renderer.unmount());
});

test('3. il click su "Nuova nota" delega l\'apertura al QuickNoteModal globale', async () => {
  let opened = 0;
  const renderer = await renderView({ onCreateNote: () => { opened += 1; } });
  await act(async () => renderer.root.findByProps({ 'data-new-note-button': true }).props.onClick());
  assert.equal(opened, 1);
  await act(async () => renderer.unmount());
});

// --- 4..6: form ------------------------------------------------------------

test('4. il titolo è obbligatorio: senza titolo non viene salvato nulla', async () => {
  const saved: CalendarEvent[] = [];
  let closed = 0;
  const renderer = await renderModal({ onSave: (e: CalendarEvent) => { saved.push(e); }, onClose: () => { closed += 1; } });
  await act(async () => renderer.root.findByProps({ 'data-quick-note-save': true }).props.onClick());
  assert.equal(saved.length, 0);
  assert.equal(closed, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /obbligatorio/);
  assert.equal(renderer.root.findByProps({ 'data-quick-note-title': true }).props.required, true);
  await act(async () => renderer.unmount());
});

test('5. la data ha come default oggi (localDateISO, nessuna regressione timezone)', async () => {
  const renderer = await renderModal();
  assert.equal(renderer.root.findByProps({ 'data-quick-note-date': true }).props.value, TODAY);
  await act(async () => renderer.unmount());

  // Il default reale della vista usa localDateISO, mai toISOString.
  assert.match(viewSource, /localDateISO\(\)/);
  assert.ok(!/toISOString\(\)\s*\.slice/.test(viewSource));
  assert.ok(!/toISOString\(\)\s*\.slice/.test(modalSource));
  assert.ok(!/toISOString\(\)\s*\.slice/.test(quickNoteSource));
  assert.match(modalSource, /localDateISO/);
  assert.equal(buildQuickNoteEvent({ title: 'x', date: '' }).date, localDateISO());
});

test('6. la classe ha come default "Nessuna classe"', async () => {
  const renderer = await renderModal();
  const select = renderer.root.findByProps({ 'data-quick-note-class': true });
  assert.equal(select.props.value, '');
  assert.match(JSON.stringify(renderer.toJSON()), /Nessuna classe/);
  for (const className of PROFILE_CLASSES) {
    assert.ok(JSON.stringify(renderer.toJSON()).includes(className));
  }
  await act(async () => renderer.unmount());
});

// --- 7..13: forma del CalendarEvent salvato --------------------------------

async function saveNote(fields: { title: string; date?: string; className?: string; notes?: string }) {
  const saved: CalendarEvent[] = [];
  let closed = 0;
  const renderer = await renderModal({ onSave: (e: CalendarEvent) => { saved.push(e); }, onClose: () => { closed += 1; } });
  const titleInput = renderer.root.findByProps({ 'data-quick-note-title': true });
  await act(async () => titleInput.props.onChange({ target: { value: fields.title } }));
  if (fields.date) {
    await act(async () => renderer.root.findByProps({ 'data-quick-note-date': true }).props.onChange({ target: { value: fields.date } }));
  }
  if (fields.className !== undefined) {
    await act(async () => renderer.root.findByProps({ 'data-quick-note-class': true }).props.onChange({ target: { value: fields.className } }));
  }
  if (fields.notes !== undefined) {
    await act(async () => renderer.root.findByProps({ 'data-quick-note-details': true }).props.onChange({ target: { value: fields.notes } }));
  }
  await act(async () => renderer.root.findByProps({ 'data-quick-note-save': true }).props.onClick());
  await act(async () => renderer.unmount());
  return { saved, closed };
}

test('7. il salvataggio produce un normale CalendarEvent e chiude il modal', async () => {
  const { saved, closed } = await saveNote({ title: '  Portare autorizzazioni uscita 3E  ', date: TODAY });
  assert.equal(saved.length, 1);
  assert.equal(closed, 1);
  const [created] = saved;
  assert.equal(created.title, 'Portare autorizzazioni uscita 3E');
  assert.equal(created.date, TODAY);
  assert.equal(typeof created.id, 'string');
  assert.match(created.id, /^ev-/);
});

test('8. la nota ha category "promemoria"', async () => {
  const { saved } = await saveNote({ title: 'Controllare PDP 2D' });
  assert.equal(saved[0].category, 'promemoria');
});

test('9. la nota ha sourceType "manuale"', async () => {
  const { saved } = await saveNote({ title: 'Controllare PDP 2D' });
  assert.equal(saved[0].sourceType, 'manuale');
});

test('10. la nota è isAllDay true e senza orario obbligatorio', async () => {
  const { saved } = await saveNote({ title: 'Chiedere alla segreteria il verbale' });
  assert.equal(saved[0].isAllDay, true);
  assert.equal(saved[0].startTime, undefined);
  assert.equal(saved[0].endTime, undefined);
});

test('11. la nota nasce con completed false', async () => {
  const { saved } = await saveNote({ title: 'Chiamare la segreteria' });
  assert.equal(saved[0].completed, false);
});

test('12. nessuno schoolId inventato', async () => {
  const { saved } = await saveNote({ title: 'Chiamare la segreteria' });
  assert.equal(saved[0].schoolId, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(saved[0], 'schoolId'));
  assert.ok(!/schoolId/.test(quickNoteSource.replace(/NON inventato|Nessuno `schoolId` inventato\./g, '')));
});

test('13. nessuna sincronizzazione Google automatica', async () => {
  const { saved } = await saveNote({ title: 'Chiamare la segreteria' });
  assert.equal(saved[0].syncedWithGoogle, false);
  assert.equal(saved[0].googleEventId, undefined);
  assert.ok(!/googleEventId|syncOptedIn|googleCalendarService/.test(quickNoteSource));
  assert.ok(!/googleCalendarService|syncOptedIn/.test(modalSource));
});

// --- 14..17: visualizzazione nella lista -----------------------------------

test('14. una nota di oggi finisce nel gruppo Oggi', () => {
  const items = derive([note({ id: 'n1', date: TODAY })]);
  const groups = groupFutureCommitments(items, TODAY);
  assert.deepEqual(groups.map(group => group.id), ['oggi']);
  assert.equal(groups[0].items[0].source, 'nota');
});

test('15. una nota di domani finisce nel gruppo Domani', () => {
  const items = derive([note({ id: 'n1', date: addDaysISO(TODAY, 1) })]);
  const groups = groupFutureCommitments(items, TODAY);
  assert.deepEqual(groups.map(group => group.id), ['domani']);
});

test('16. la nota mostra il badge "Nota"', async () => {
  assert.equal(FUTURE_COMMITMENT_SOURCE_LABELS.nota, 'Nota');
  const renderer = await renderView({ events: [note({ id: 'n1', date: TODAY, className: '2E' })] });
  const json = JSON.stringify(renderer.toJSON());
  assert.match(json, /Ricordare di chiamare la famiglia Rossi/);
  assert.match(json, /"Nota"/);
  assert.match(json, /2E/);
  await act(async () => renderer.unmount());
});

test('17. un normale impegno manuale (Consiglio) resta badge Agenda', async () => {
  const items = derive([
    event({ id: 'cc', date: TODAY, category: 'consiglio_classe', title: 'Consiglio di classe 2E' }),
    event({ id: 'cd', date: TODAY, category: 'collegio_docenti', title: 'Collegio docenti' }),
    note({ id: 'n1', date: TODAY }),
  ]);
  const bySource = Object.fromEntries(items.map(item => [item.id, item.source]));
  assert.equal(bySource['event:cc'], 'agenda');
  assert.equal(bySource['event:cd'], 'agenda');
  assert.equal(bySource['event:n1'], 'nota');
  assert.equal(isQuickNoteEvent(event({ id: 'cc', date: TODAY, category: 'consiglio_classe' })), false);
  assert.equal(isQuickNoteEvent(note({ id: 'n1', date: TODAY })), true);
  // Un promemoria arrivato da circolare non è una nota personale.
  assert.equal(
    derive([event({ id: 'circ', date: TODAY, category: 'promemoria', sourceType: 'circolare' })])[0].source,
    'circolare',
  );

  const renderer = await renderView({ events: [event({ id: 'cc', date: TODAY, category: 'consiglio_classe', title: 'Consiglio di classe 2E' })] });
  assert.match(JSON.stringify(renderer.toJSON()), /"Agenda"/);
  await act(async () => renderer.unmount());
});

// --- 18..20: modifica e completamento --------------------------------------

test('18. il click su una nota futura apre il QuickNoteModal globale', async () => {
  const target = note({ id: 'n1', date: TODAY });
  const opened: CalendarEvent[] = [];
  const renderer = await renderView({ events: [target], onEditNote: (e: CalendarEvent) => opened.push(e) });
  const row = renderer.root.findByProps({ 'data-commitment-id': 'event:n1' });
  await act(async () => row.props.onClick());
  assert.deepEqual(opened, [target]);
  await act(async () => renderer.unmount());
  assert.match(appSource, /onEditNote=\{handleEditQuickNote\}/);
  assert.match(appSource, /noteToEdit=\{quickNoteState\.mode === "editing"/);
});

test('19. il completamento riusa il callback esistente (storage.toggleEventCompleted)', async () => {
  const toggled: string[] = [];
  const renderer = await renderView({
    events: [note({ id: 'n1', date: TODAY })],
    onToggleComplete: (id: string) => toggled.push(id),
  });
  const toggle = renderer.root.findByProps({ 'data-commitment-toggle': 'event:n1' });
  assert.equal(toggle.props['aria-pressed'], false);
  await act(async () => toggle.props.onClick());
  assert.deepEqual(toggled, ['n1']);
  await act(async () => renderer.unmount());

  // Il flusso di persistenza resta in App e usa l'handler già esistente.
  assert.match(appSource, /onToggleComplete=\{handleToggleComplete\}/);
  assert.match(appSource, /storage\.toggleEventCompleted\(id\)/);
  assert.ok(!/from "\.\.\/services/.test(viewSource));
  assert.ok(!/from "\.\.\/services/.test(modalSource));
});

test('19b. gli impegni non-nota e le verifiche non espongono il cerchio di completamento', async () => {
  const renderer = await renderView({
    events: [event({ id: 'cc', date: TODAY, category: 'consiglio_classe' })],
    scheduledAssessments: [
      { id: 'as-1', studentId: 'stu-1', date: TODAY, assessmentType: 'written', status: 'scheduled' } as unknown as StudentScheduledAssessment,
    ],
    onToggleComplete: () => {},
  });
  assert.equal(renderer.root.findAllByProps({ 'data-commitment-toggle': 'event:cc' }).length, 0);
  assert.equal(renderer.root.findAllByProps({ 'data-commitment-toggle': 'assessment:as-1' }).length, 0);
  await act(async () => renderer.unmount());
});

test('20. una nota completata sparisce dalla parte futura e compare subito nell\'Archivio', async () => {
  const completed = note({ id: 'n1', date: TODAY, completed: true });
  assert.equal(derive([completed]).length, 0);
  assert.deepEqual(deriveArchiveCommitments({ events: [completed], scheduledAssessments: [], students, todayIso: TODAY }).map(item => item.id), ['event:n1']);
  const renderer = await renderView({ events: [completed], onToggleComplete: () => {} });
  assert.match(JSON.stringify(renderer.toJSON()), /Archivio note e impegni/);
  assert.equal(renderer.root.findByProps({ 'data-archive-commitments-toggle': true }).props['aria-expanded'], false);
  await act(async () => renderer.unmount());
  assert.ok(!/deleteEvent/.test(viewSource));
});

// --- 21..22: storico -------------------------------------------------------

test('21. una nota passata compare nello storico con badge Nota', async () => {
  const past = note({ id: 'n-past', date: addDaysISO(TODAY, -2), title: 'Chiedere alla segreteria il verbale' });
  const items = derivePast([past]);
  assert.deepEqual(items.map(item => [item.id, item.source]), [['event:n-past', 'nota']]);

  const renderer = await renderView({ events: [past] });
  await act(async () => renderer.root.findByProps({ 'data-past-commitments-toggle': true }).props.onClick());
  const json = JSON.stringify(renderer.toJSON());
  assert.match(json, /Chiedere alla segreteria il verbale/);
  assert.match(json, /"Nota"/);
  await act(async () => renderer.unmount());
});

test('22. una nota passata e completata compare comunque nello storico', () => {
  const items = derivePast([
    note({ id: 'done', date: addDaysISO(TODAY, -1), completed: true }),
    note({ id: 'open', date: addDaysISO(TODAY, -3), completed: false }),
  ]);
  assert.deepEqual(items.map(item => [item.id, item.completed]), [['event:done', true], ['event:open', false]]);
  assert.ok(items.every(item => item.source === 'nota'));
});

// --- 23..24: classe opzionale ----------------------------------------------

test('23. la classe selezionata viene salvata su className', async () => {
  const { saved } = await saveNote({ title: 'Portare autorizzazioni uscita 3E', className: '3E', notes: '  Firme mancanti  ' });
  assert.equal(saved[0].className, '3E');
  assert.equal(saved[0].notes, 'Firme mancanti');
});

test('24. senza classe la nota NON eredita la prima classe del profilo', async () => {
  const { saved } = await saveNote({ title: 'Chiamare la segreteria' });
  assert.equal(saved[0].className, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(saved[0], 'className'));
  assert.ok(!saved.some(created => PROFILE_CLASSES.includes(created.className ?? '')));
  // Nessun fallback sul profilo nel percorso della nota rapida.
  assert.ok(!/profile\.classes\[0\]/.test(modalSource));
  assert.ok(!/classes\[0\]/.test(quickNoteSource));
});

// --- 25: nessuna nuova persistenza -----------------------------------------

test('25. nessuna nuova tabella/collection/migrazione per le note', () => {
  assert.ok(!/['"]notes['"]/.test(dbSource), 'nessuna tabella notes nello schema Dexie');
  assert.ok(!/version\(4\)/.test(dbSource), 'nessuna nuova versione dello schema');
  assert.ok(!/\bnotes\b\s*:/.test(backupSource.split('export')[0] ?? ''), 'nessuna nuova sezione di backup');
  assert.ok(!/saveNote|deleteNote|getNotes|noteStore/.test(storageSource));
  assert.ok(!/interface\s+(Quick)?Note\b/.test(typesSource), 'nessun nuovo modello Note nei types');
  // Il modal e la vista non scrivono mai direttamente sul database.
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const source of [viewSource, modalSource, quickNoteSource]) {
    const code = stripComments(source);
    assert.ok(!/from "\.\.?\/services/.test(code), 'nessun import di services');
    assert.ok(!/services\/db|indexedDB|storage\.|db\.table|dexie/i.test(code));
  }
  // La nota è un CalendarEvent: stessa tabella `events` del resto dell'agenda.
  const created = buildQuickNoteEvent({ title: 'Nota', date: TODAY });
  const allowedKeys = ['id', 'title', 'category', 'date', 'isAllDay', 'className', 'notes', 'sourceType', 'completed', 'syncedWithGoogle'];
  assert.ok(Object.keys(created).every(key => allowedKeys.includes(key)), Object.keys(created).join(','));
});

// --- 26..28: non-regressione -----------------------------------------------

test('26. nessuna regressione N1/N1.1: esclusioni, gruppi e storico invariati', () => {
  const items = derive([
    event({ id: 'past', date: addDaysISO(TODAY, -1) }),
    event({ id: 'today', date: TODAY }),
    event({ id: 'done', date: addDaysISO(TODAY, 1), completed: true }),
    event({ id: 'lesson', date: addDaysISO(TODAY, 1), category: 'lezione' }),
    note({ id: 'nota-domani', date: addDaysISO(TODAY, 1) }),
  ]);
  assert.deepEqual(items.map(item => item.id), ['event:today', 'event:nota-domani']);
  const past = derivePast([event({ id: 'old', date: addDaysISO(TODAY, -1) })]);
  assert.deepEqual(past.map(item => item.id), ['event:old']);
  assert.match(appSource, /currentView === "impegni"/);
  assert.match(appSource, /<FutureCommitmentsView/);
});

test('26b. empty state: sparisce appena esiste una nota futura', async () => {
  const emptyRenderer = await renderView({ events: [] });
  assert.match(JSON.stringify(emptyRenderer.toJSON()), /Nessun impegno in programma/);
  await act(async () => emptyRenderer.unmount());

  const withNote = await renderView({ events: [note({ id: 'n1', date: TODAY })] });
  const json = JSON.stringify(withNote.toJSON());
  assert.ok(!json.includes('Nessun impegno in programma'));
  assert.match(json, /Ricordare di chiamare la famiglia Rossi/);
  await act(async () => withNote.unmount());
});

test('27. nessuna regressione DeadlinesView: i promemoria restano nello scadenziario', () => {
  assert.match(deadlinesSource, /e\.category === "scadenza" \|\| e\.category === "promemoria" \|\| e\.category === "pei"/);
  assert.match(appSource, /<DeadlinesView/);
  assert.match(appSource, /currentView === "scadenze"/);
});

test('28. EventModal resta l\'editor degli impegni normali e QuickNoteModal usa gli handler esistenti', () => {
  // G1.3: la costruzione dell'evento è centralizzata in buildCurrentEvent con un
  // draft id stabile (stesso impegno locale per "Salva" e "Invia a Google").
  assert.match(eventModalSource, /id: baseline \? baseline\.id : draftIdRef\.current/);
  assert.match(eventModalSource, /sourceType: baseline \? baseline\.sourceType : "manuale"/);
  assert.match(appSource, /<EventModal/);
  assert.match(appSource, /onSave=\{handleSaveEvent\}/);
  assert.match(appSource, /onDelete=\{handleDeleteEvent\}/);
  assert.match(appSource, /onCreateNote=\{handleOpenNewQuickNote\}/);
});

// --- N2.1: Archivio e modifica rapida --------------------------------------

test('N2.1 Archivio: include nota future completed, nota completed oggi, note passate una volta e i soli eventi normali passati', () => {
  const futureCompleted = note({ id: 'future-done', date: addDaysISO(TODAY, 2), completed: true });
  const todayCompleted = note({ id: 'today-done', date: TODAY, completed: true });
  const pastCompleted = note({ id: 'past-done', date: addDaysISO(TODAY, -1), completed: true });
  const pastEvent = event({ id: 'past-event', date: addDaysISO(TODAY, -2), title: 'Consiglio passato' });
  const futureEvent = event({ id: 'future-event', date: addDaysISO(TODAY, 1), title: 'Consiglio futuro' });
  const archive = deriveArchiveCommitments({
    events: [futureCompleted, todayCompleted, pastCompleted, pastCompleted, pastEvent, futureEvent],
    scheduledAssessments: [],
    students,
    todayIso: TODAY,
  });
  assert.deepEqual(archive.map(item => item.id), ['event:today-done', 'event:future-done', 'event:past-done', 'event:past-event']);
  assert.equal(archive.filter(item => item.id === 'event:past-done').length, 1, 'dedupe per identità evento');
  assert.ok(!archive.some(item => item.id === 'event:future-event'), 'un evento normale futuro non è in Archivio');
  assert.equal(derive([futureCompleted]).length, 0, 'nota completed futura non resta nella lista futura');
});

test('N2.1 Archivio: una nota completed si riapre nel QuickNoteModal, un Consiglio nel normale EventModal', async () => {
  const archivedNote = note({ id: 'done', date: addDaysISO(TODAY, 1), completed: true });
  const council = event({ id: 'council', date: TODAY, category: 'consiglio_classe', title: 'Consiglio 2E' });
  const quickOpened: CalendarEvent[] = [];
  const eventOpened: CalendarEvent[] = [];
  const renderer = await renderView({
    events: [archivedNote, council],
    onEditNote: (item: CalendarEvent) => quickOpened.push(item),
    onEditEvent: (item: CalendarEvent) => eventOpened.push(item),
  });
  await act(async () => renderer.root.findByProps({ 'data-commitment-id': 'event:council' }).props.onClick());
  await act(async () => renderer.root.findByProps({ 'data-archive-commitments-toggle': true }).props.onClick());
  await act(async () => renderer.root.findByProps({ 'data-commitment-id': 'event:done' }).props.onClick());
  assert.deepEqual(quickOpened, [archivedNote]);
  assert.deepEqual(eventOpened, [council]);
  await act(async () => renderer.unmount());
});

test('N2.1 QuickNoteModal edit precompila titolo, data, classe e dettagli', async () => {
  const existing = note({
    id: 'edit-1',
    title: 'Titolo esistente',
    date: addDaysISO(TODAY, 3),
    className: '2E',
    notes: 'Dettagli esistenti',
    completed: true,
  });
  const renderer = await renderModal({ noteToEdit: existing });
  assert.equal(renderer.root.findByProps({ 'data-quick-note-title': true }).props.value, 'Titolo esistente');
  assert.equal(renderer.root.findByProps({ 'data-quick-note-date': true }).props.value, addDaysISO(TODAY, 3));
  assert.equal(renderer.root.findByProps({ 'data-quick-note-class': true }).props.value, '2E');
  assert.equal(renderer.root.findByProps({ 'data-quick-note-details': true }).props.value, 'Dettagli esistenti');
  assert.match(JSON.stringify(renderer.toJSON()), /Modifica nota/);
  await act(async () => renderer.unmount());
});

test('N2.1 QuickNoteModal edit salva con l\'originale e preserva id, sourceType, category e completed', async () => {
  const existing = note({
    id: 'edit-2',
    title: 'Prima',
    date: addDaysISO(TODAY, 2),
    className: '3D',
    notes: 'Vecchi dettagli',
    completed: true,
    syncedWithGoogle: false,
  });
  const calls: Array<[CalendarEvent, CalendarEvent | undefined]> = [];
  const renderer = await renderModal({
    noteToEdit: existing,
    onSave: (updated: CalendarEvent, expected?: CalendarEvent) => { calls.push([updated, expected]); },
  });
  await act(async () => renderer.root.findByProps({ 'data-quick-note-title': true }).props.onChange({ target: { value: 'Dopo' } }));
  await act(async () => renderer.root.findByProps({ 'data-quick-note-save': true }).props.onClick());
  assert.equal(calls.length, 1);
  const [updated, expected] = calls[0];
  assert.equal(updated.id, 'edit-2');
  assert.equal(updated.sourceType, 'manuale');
  assert.equal(updated.category, 'promemoria');
  assert.equal(updated.completed, true);
  assert.equal(updated.title, 'Dopo');
  assert.equal(expected, existing, 'handleSaveEvent riceve l\'originale per il controllo concorrenza');
  await act(async () => renderer.unmount());
});

test('N2.1 QuickNoteModal edit elimina con il callback evento esistente e conferma coerente', async () => {
  const existing = note({ id: 'delete-1', date: TODAY });
  const deleted: string[] = [];
  const renderer = await renderModal({ noteToEdit: existing, onDelete: (id: string) => { deleted.push(id); } });
  assert.ok(renderer.root.findByProps({ 'data-quick-note-delete': true }));
  await act(async () => renderer.root.findByProps({ 'data-quick-note-delete': true }).props.onClick());
  assert.ok(renderer.root.findByProps({ 'data-quick-note-delete-confirm': true }));
  await act(async () => renderer.root.findByProps({ 'data-quick-note-delete-confirm-yes': true }).props.onClick());
  assert.deepEqual(deleted, ['delete-1']);
  await act(async () => renderer.unmount());
});

test('N2.1 non introduce nuova persistenza e conserva DeadlinesView', () => {
  assert.ok(!/notes\s*:|version\(4\)|completedAt/.test(dbSource));
  assert.ok(!/completedAt/.test(typesSource));
  assert.match(deadlinesSource, /e\.category === "scadenza" \|\| e\.category === "promemoria" \|\| e\.category === "pei"/);
  assert.ok(!/from "\.\.\/services/.test(viewSource));
  assert.ok(!/from "\.\.\/services/.test(modalSource));
});
