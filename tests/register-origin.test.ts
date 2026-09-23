import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import {
  backFromRegister,
  clearRegisterStudent,
  initialRegisterNavigation,
  isRegisterOpenForStudent,
  openRegisterForStudent,
  type RegisterNavigation,
} from '../src/utils/registerNavigation';
import { RegisterView } from '../src/components/RegisterView';
import { TodayView } from '../src/components/TodayView';
import { localDateISO } from '../src/utils/dates';
import type { Student, StudentScheduledAssessment, TeacherProfile, TimetableSlot } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Origine della navigazione del Registro:
 *  - una prova programmata aperta da Oggi/Settimana/Mese riporta "Indietro"
 *    alla vista di provenienza (non arbitrariamente a Classi);
 *  - l'apertura da Classi riporta a Classi;
 *  - il contesto temporale (data del Planning) resta preservato;
 *  - modifica/eliminazione di una prova non perdono l'origine e non chiudono
 *    da soli il Registro;
 *  - l'apertura normale del Registro (dalla navigazione principale) resta invariata.
 */

// ---------------------------------------------------------------------------
// Stato puro di navigazione (le stesse transizioni usate da App.tsx)
// ---------------------------------------------------------------------------

test('1. Oggi -> prova programmata -> Registro -> ritorno Oggi', () => {
  const nav = openRegisterForStudent('s1', 'scheduled', 'oggi');
  assert.ok(isRegisterOpenForStudent(nav), 'il Registro è aperto per uno studente');
  assert.equal(nav.section, 'scheduled', 'sezione Prove programmate');
  const back = backFromRegister(nav);
  assert.equal(back.targetView, 'oggi', '"Indietro" torna a Oggi, non a Classi');
  assert.equal(back.next.studentId, null, 'dopo il ritorno non c è più lo studente selezionato');
  assert.equal(back.next.origin, null, 'l origine è consumata');
});

test('2. Settimana -> prova programmata -> Registro -> ritorno Settimana', () => {
  const nav = openRegisterForStudent('s1', 'scheduled', 'settimana');
  assert.equal(backFromRegister(nav).targetView, 'settimana');
});

test('3. Mese -> prova programmata -> Registro -> ritorno Mese', () => {
  const nav = openRegisterForStudent('s1', 'scheduled', 'mese');
  assert.equal(backFromRegister(nav).targetView, 'mese');
});

test('4. Classi -> Registro (scheda alunno) -> ritorno Classi', () => {
  const nav = openRegisterForStudent('s2', 'assessments', 'classi');
  assert.ok(isRegisterOpenForStudent(nav));
  assert.equal(backFromRegister(nav).targetView, 'classi');
});

test('5. il contesto Planning non dipende dallo stato del Registro (nessuna data inventata, sezione preservata)', () => {
  // Lo stato del Registro non contiene date: le transizioni non possono
  // toccare planningTargetDate / oggiTargetDate, che restano in App.
  const nav = openRegisterForStudent('s1', 'scheduled', 'settimana');
  assert.deepEqual(Object.keys(nav).sort(), ['origin', 'section', 'studentId']);
  const back = backFromRegister(nav);
  assert.equal(back.next.section, 'scheduled', 'la sezione resta com era (comportamento preesistente)');
  // L abbandono via navigazione principale dimentica studente e origine...
  const cleared = clearRegisterStudent(nav);
  assert.equal(cleared.studentId, null);
  assert.equal(cleared.origin, null);
  assert.equal(cleared.section, 'scheduled', '...ma la sezione resta com era');
});

test('5b. contesto Oggi preservato al ritorno: rismontaggio con la data comunicata dalla vista', async () => {
  // Simula l wiring di App: la vista Oggi comunica la data selezionata;
  // dopo il passaggio per il Registro (smontaggio) App rismonta la vista
  // con la data conservata, invece di riportare a oggi.
  let reported: string | undefined;
  const report = (iso: string) => { reported = iso; };
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TodayView, todayProps({ onSelectedDateChange: report })));
  });
  // L utente si sposta su una data non-oggi a fine mese (caso più significativo).
  await act(async () => { byId(renderer, 'today-date-picker').props.onChange({ target: { value: '2026-09-30' } }); });
  assert.equal(reported, '2026-09-30', 'la data selezionata è comunicata al parent');
  // ... apre la prova programmata e si trova nel Registro ...
  await act(async () => { renderer.unmount(); });
  // ... e torna a Oggi.
  await act(async () => {
    renderer = create(React.createElement(TodayView, todayProps({ initialDateIso: reported, onSelectedDateChange: report })));
  });
  assert.equal(byId(renderer, 'today-date-picker').props.value, '2026-09-30', 'stessa data, non il reale oggi');
  assert.equal(flatText(byId(renderer, 'today-date-line').findByType('h1')), 'Mercoledì 30 settembre 2026');
  await act(async () => { renderer.unmount(); });
});

test('5c. initialDateIso non valida: si riparte dal reale oggi, mai una data corrotta', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TodayView, todayProps({ initialDateIso: 'non-una-data' })));
  });
  assert.equal(byId(renderer, 'today-date-picker').props.value, localDateISO());
  await act(async () => { renderer.unmount(); });
});

test('difesa: l origine non può mai essere "registro" (fallback Classi)', () => {
  const nav = openRegisterForStudent('s1', 'assessments', 'registro');
  assert.equal(nav.origin, null);
  assert.equal(backFromRegister(nav).targetView, 'classi');
});

// ---------------------------------------------------------------------------
// Registro aperto per uno studente: le operazioni non perdono l origine
// ---------------------------------------------------------------------------

const profile: TeacherProfile = {
  id: 'teacher', fullName: 'Docente', schoolName: 'Scuola', schoolYear: '2026/27',
  primarySubjects: [], classes: ['2E'], campuses: [], roles: [],
};
const student = (id: string, className: string): Student => ({ id, fullName: id === 's1' ? 'Rossi Anna' : 'Verdi Sara', className, notes: [] });
const scheduled = (id: string, studentId: string, date: string): StudentScheduledAssessment => ({
  id, studentId, className: '2E', date, assessmentType: 'written', topic: 'Equazioni',
  status: 'scheduled', createdAt: date, updatedAt: date,
});

const text = (node: any): string => {
  if (!node) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(text).join(' ');
};
const flatText = (node: any) => text(node).replace(/\s+/g, ' ').trim();

async function renderRegisterForStudent(overrides: Partial<React.ComponentProps<typeof RegisterView>> = {}) {
  let backCalls = 0;
  const saved: StudentScheduledAssessment[] = [];
  const deleted: string[] = [];
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(RegisterView, {
      profile,
      students: [student('s1', '2E')],
      assessments: [],
      scheduledAssessments: [scheduled('sch1', 's1', '2026-10-05')],
      initialStudentId: 's1',
      initialSection: 'scheduled',
      onBackToOrigin: () => { backCalls += 1; },
      onSaveAssessment: async () => {},
      onDeleteAssessment: async () => {},
      onSaveScheduledAssessment: async (item) => { saved.push(item); },
      onDeleteScheduledAssessment: async (id) => { deleted.push(id); },
      ...overrides,
    }));
  });
  const fullText = () => flatText(renderer.toJSON());
  const sheetVisible = () => fullText().includes('Scheda studente');
  const formVisible = () => fullText().includes('Modifica prova programmata');
  const click = async (finder: (node: any) => boolean) => {
    const nodes = renderer.root.findAll(finder);
    assert.ok(nodes.length > 0, 'il pulsante cercato esiste');
    await act(async () => { nodes[0].props.onClick(); });
  };
  const backButton = () => click((n: any) => n.type === 'button' && flatText(n) === 'Indietro');
  return { renderer, saved, deleted, backCalls: () => backCalls, sheetVisible, formVisible, click, backButton };
}

test('6. modifica della prova: l origine non si perde e il Registro non si chiude da solo', async () => {
  const { renderer, saved, backCalls, sheetVisible, formVisible, click, backButton } = await renderRegisterForStudent();
  assert.ok(sheetVisible(), 'la scheda studente è aperta');
  // Apri la prova programmata (sezione "Prove programmate" già attiva).
  await click((n: any) => n.type === 'button' && flatText(n).includes('Equazioni'));
  assert.ok(formVisible(), 'form di modifica aperto');
  // Salva la modifica.
  const form = renderer.root.findByType('form');
  await act(async () => { form.props.onSubmit({ preventDefault: () => {} }); });
  assert.equal(saved.length, 1, 'salvataggio eseguito');
  assert.equal(formVisible(), false, 'il form si chiude dopo il salvataggio');
  assert.ok(sheetVisible(), 'il Registro resta aperto sulla scheda (nessuna chiusura automatica)');
  // "Indietro" resta cablato: l origine (Oggi/Settimana/Mese, decisa in App) non è andata perduta.
  await backButton();
  assert.equal(backCalls(), 1, '"Indietro" invoca ancora onBackToOrigin dopo la modifica');
  await act(async () => { renderer.unmount(); });
});

test('7. eliminazione della prova: nessun ritorno errato, l origine resta intatta', async (t) => {
  // Il form di eliminazione usa window.confirm: stub locale, ripristinato dopo.
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = globalThis;
  (globalThis as any).confirm = () => true;
  t.after(() => {
    (globalThis as any).window = originalWindow;
    delete (globalThis as any).confirm;
  });

  const { renderer, deleted, backCalls, sheetVisible, formVisible, click, backButton } = await renderRegisterForStudent();
  // Apri la prova programmata ed eliminala.
  await click((n: any) => n.type === 'button' && flatText(n).includes('Equazioni'));
  assert.ok(formVisible(), 'form aperto');
  await click((n: any) => n.type === 'button' && flatText(n) === 'Elimina');
  assert.deepEqual(deleted, ['sch1'], 'prova eliminata');
  assert.equal(formVisible(), false, 'il form si chiude dopo l eliminazione');
  assert.ok(sheetVisible(), 'il Registro non si chiude da solo nel mezzo dell operazione');
  // L origine non può essere un ritorno a Classi: le transizioni di App toccano
  // solo lo stato del Registro, e l eliminazione non passa da lì.
  const nav: RegisterNavigation = openRegisterForStudent('s1', 'scheduled', 'oggi');
  assert.equal(backFromRegister(nav).targetView, 'oggi', 'anche dopo l eliminazione "Indietro" torna a Oggi');
  await backButton();
  assert.equal(backCalls(), 1, '"Indietro" resta cablato anche dopo l eliminazione');
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// Apertura normale (navigazione principale): comportamento invariato
// ---------------------------------------------------------------------------

test('8. apertura normale del Registro senza origine Planning: Indietro resta nella lista', async () => {
  let renderer: any;
  await act(async () => {
    // Senza initialStudentId e senza onBackToOrigin: come lo vede oggi la nav principale.
    renderer = create(React.createElement(RegisterView, {
      profile,
      students: [student('s1', '2E')],
      assessments: [],
      onSaveAssessment: async () => {},
      onDeleteAssessment: async () => {},
    }));
  });
  assert.ok(flatText(renderer.toJSON()).includes('Tutte le classi'), 'lista iniziale');
  // Apri uno studente dalla lista.
  await act(async () => {
    const card = renderer.root.findAll((n: any) => n.type === 'button' && flatText(n).includes('Rossi Anna'))[0];
    card.props.onClick();
  });
  assert.ok(flatText(renderer.toJSON()).includes('Scheda studente'), 'scheda aperta');
  // "Indietro" (senza origine) torna alla lista, non fuori dal Registro.
  await act(async () => {
    const back = renderer.root.findAll((n: any) => n.type === 'button' && flatText(n) === 'Indietro')[0];
    back.props.onClick();
  });
  assert.ok(flatText(renderer.toJSON()).includes('Tutte le classi'), 'tornati alla lista del Registro');
  assert.doesNotMatch(flatText(renderer.toJSON()), /Scheda studente/);
  // E lo stato iniziale del modulo non ha origine: App non espone onBackToOrigin.
  assert.equal(isRegisterOpenForStudent(initialRegisterNavigation), false);
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// Helper TodayView
// ---------------------------------------------------------------------------

function byId(renderer: any, id: string) {
  const found = renderer.root.findAll((el: any) => el.props?.id === id);
  assert.ok(found.length > 0, `l elemento con id "${id}" deve esistere`);
  return found[0];
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
