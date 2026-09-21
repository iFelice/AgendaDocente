import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { isSupportTeacherOf } from '../src/utils/teacherType';
import { isSupportTeacherProfile, personalTimetableNature } from '../src/utils/reconstructTimetable';
import { evaluateItemRelevance } from '../src/utils/circularRelevance';
import { isValidProfilePayload } from '../src/services/sync/remoteSchema';
import { ProfileModal } from '../src/components/ProfileModal';
import { Navbar } from '../src/components/Navbar';
import { TimetableEditor } from '../src/components/TimetableEditor';
import type { TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Coerenza del tipo docente (curricolare | sostegno) sull'intero profilo:
 *  - isSupportTeacherOf è l'unica fonte di verità: un valore esplicito (anche
 *    false) VINCE sull'euristica "sostegno" su primarySubjects, che resta
 *    fallback SOLO per i profili legacy senza flag;
 *  - ProfileModal usa un selettore segmentato (niente più checkbox "Attivo") e
 *    salva SEMPRE un valore esplicito;
 *  - la compresenza mostra la UI del ruolo corretto (regressione: legacy
 *    sostegno vs false esplicito con materia "Sostegno");
 *  - scanner, Navbar, rilevanza circolari e ClassesView usano la stessa
 *    interpretazione; backup/Firestore restano compatibili con flag opzionale.
 * Nessuna migrazione: il fallback avviene in lettura, i dati restano intatti.
 */

// Stub minimo di localStorage (nessun hook del profilo tocca l'IndexedDB qui).
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size; },
    key: (i: number) => [...memory.keys()][i] ?? null,
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => { memory.set(k, String(v)); },
    removeItem: (k: string) => { memory.delete(k); },
  },
});

const text = (node: any): string => {
  if (!node) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(text).join(' ');
};
const flatText = (node: any) => text(node).replace(/\s+/g, ' ').trim();

function profileFixture(patch: Partial<TeacherProfile> = {}): TeacherProfile {
  return {
    id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
    schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Matematica'],
    classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [],
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// 1. Helper canonico
// ---------------------------------------------------------------------------

test('helper: A) isSupportTeacher true -> sostegno', () => {
  assert.equal(isSupportTeacherOf({ isSupportTeacher: true, primarySubjects: ['Matematica'] }), true);
});
test('helper: B) isSupportTeacher false -> curricolare', () => {
  assert.equal(isSupportTeacherOf({ isSupportTeacher: false, primarySubjects: ['Matematica'] }), false);
});
test('helper: C) flag assente + ["Sostegno"] -> sostegno (fallback legacy)', () => {
  const legacy: TeacherProfile = { ...profileFixture(), primarySubjects: ['Sostegno'] };
  delete legacy.isSupportTeacher;
  assert.equal(isSupportTeacherOf(legacy), true);
});
test('helper: D) flag assente + ["Matematica"] -> curricolare', () => {
  const legacy: TeacherProfile = { ...profileFixture() };
  delete legacy.isSupportTeacher;
  assert.equal(isSupportTeacherOf(legacy), false);
});
test('helper: E) false esplicito + ["Sostegno"] -> CURRICOLARE (l esplicito vince)', () => {
  assert.equal(isSupportTeacherOf({ isSupportTeacher: false, primarySubjects: ['Sostegno'] }), false);
});
test('helper: F) true esplicito + ["Matematica"] -> sostegno', () => {
  assert.equal(isSupportTeacherOf({ isSupportTeacher: true, primarySubjects: ['Matematica'] }), true);
});
test('helper: profilo null/undefined e materia con varianti sono gestiti in sicurezza', () => {
  assert.equal(isSupportTeacherOf(undefined), false);
  assert.equal(isSupportTeacherOf(null), false);
  assert.equal(isSupportTeacherOf({ primarySubjects: ['Attività di Sostegno', 'Matematica'] }), true, 'varianti "sostegno" nel fallback');
  assert.equal(isSupportTeacherOf({ primarySubjects: [] }), false);
});
test('delega: isSupportTeacherProfile(ruote) non diverge mai dall helper canonico', () => {
  for (const p of [
    { isSupportTeacher: true, primarySubjects: ['Matematica'] },
    { isSupportTeacher: false, primarySubjects: ['Sostegno'] },
    { primarySubjects: ['Sostegno'] },
    { primarySubjects: ['Matematica'] },
    null,
  ] as Array<Partial<TeacherProfile> | null>) {
    assert.equal(isSupportTeacherProfile(p as any), isSupportTeacherOf(p as any), `coerenza per ${JSON.stringify(p)}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Natura dell orario (scanner) e rilevanza circolari: stessa interpretazione
// ---------------------------------------------------------------------------

test('scanner: personalTimetableNature distingue support/subject con la regola canonica', () => {
  const legacy: TeacherProfile = { ...profileFixture(), primarySubjects: ['Sostegno'] };
  delete legacy.isSupportTeacher;
  assert.equal(personalTimetableNature(legacy), 'support', 'legacy senza flag + Sostegno = sostegno');
  assert.equal(personalTimetableNature(profileFixture({ isSupportTeacher: false, primarySubjects: ['Sostegno'] })), 'subject', 'false esplicito vince anche per lo scanner');
  assert.equal(personalTimetableNature(profileFixture({ isSupportTeacher: true, primarySubjects: ['Matematica'] })), 'support');
  assert.equal(personalTimetableNature(profileFixture({ isSupportTeacher: false, primarySubjects: ['Matematica'] })), 'subject');
});

test('circolari: il sostegno rileva "Sostegno" come propria materia; il curricolare esplicito no', () => {
  const item = { title: 'Riunione', className: '1A', subject: 'Sostegno' };
  const support = profileFixture({ isSupportTeacher: true, primarySubjects: ['Matematica'] });
  const legacy: TeacherProfile = { ...profileFixture(), primarySubjects: ['Sostegno'] };
  delete legacy.isSupportTeacher;
  const curricular = profileFixture({ isSupportTeacher: false, primarySubjects: ['Matematica'] });

  assert.equal(evaluateItemRelevance(item, support).relevance, 'VERDE', 'sostegno (flag): la riunione di sostegno è pertinente');
  assert.equal(evaluateItemRelevance(item, legacy).relevance, 'VERDE', 'legacy senza flag: fallback corretto');
  const curricularVerdict = evaluateItemRelevance(item, curricular);
  assert.equal(curricularVerdict.relevance, 'ROSSO', 'curricolare esplicito: non è la sua materia');
  assert.match(curricularVerdict.relevanceReason ?? '', /altra materia/i);
});

// ---------------------------------------------------------------------------
// 3. Navbar: badge "Sostegno" coerente con l helper
// ---------------------------------------------------------------------------

async function renderNavbar(profile: TeacherProfile) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(Navbar, {
      currentView: 'oggi',
      onViewChange: () => {},
      profile,
      onOpenCircularModal: () => {},
      onOpenNewEventModal: () => {},
      onOpenProfileModal: () => {},
      stats: { todayEventsCount: 0, pendingDeadlinesCount: 0 },
    }));
  });
  return renderer;
}

test('Navbar: badge sostegno per profilo legacy e con flag; assente con false esplicito', async () => {
  const legacy: TeacherProfile = { ...profileFixture(), primarySubjects: ['Sostegno'] };
  delete legacy.isSupportTeacher;
  const withFlag = profileFixture({ isSupportTeacher: true, primarySubjects: ['Matematica'] });
  const curricular = profileFixture({ isSupportTeacher: false, primarySubjects: ['Sostegno'] });

  let renderer = await renderNavbar(legacy);
  assert.ok(renderer.root.findAll((n: any) => n.type === 'span' && flatText(n) === 'Sostegno').length > 0, 'legacy: badge presente');
  await act(async () => { renderer.unmount(); });

  renderer = await renderNavbar(withFlag);
  assert.ok(renderer.root.findAll((n: any) => n.type === 'span' && flatText(n) === 'Sostegno').length > 0, 'flag: badge presente');
  await act(async () => { renderer.unmount(); });

  renderer = await renderNavbar(curricular);
  assert.equal(renderer.root.findAll((n: any) => n.type === 'span' && flatText(n) === 'Sostegno').length, 0, 'false esplicito: nessun badge');
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// 4. ProfileModal: selettore "Tipo docente", salvataggio esplicito, no ratchet
// ---------------------------------------------------------------------------

async function renderProfileModal(profile: TeacherProfile, onSaved: (p: TeacherProfile) => void) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(ProfileModal, {
      isOpen: true,
      onClose: () => {},
      profile,
      onSaveProfile: (p: TeacherProfile) => { onSaved(p); },
      onDataImported: () => {},
      googleUser: null,
      googleAccessToken: null,
    }));
  });
  return renderer;
}

function typeRadio(renderer: any, label: string) {
  const found = renderer.root.findAll((n: any) => n.type === 'button' && n.props.role === 'radio' && flatText(n).includes(label));
  assert.equal(found.length, 1, `opzione "${label}" unica nel radiogroup`);
  return found[0];
}

async function submitProfileForm(renderer: any) {
  const form = renderer.root.findAll((n: any) => n.type === 'form').find((f: any) => flatText(f).includes('Tipo docente'));
  assert.ok(form, 'il form del profilo contiene il selettore Tipo docente');
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });
}

test('ProfileModal: mostra le due opzioni, niente più checkbox "Attivo" del vecchio banner', async () => {
  const renderer = await renderProfileModal(profileFixture({ isSupportTeacher: true }), () => {});
  const group = renderer.root.findAll((n: any) => n.props.role === 'radiogroup' && n.props['aria-label'] === 'Tipo docente');
  assert.equal(group.length, 1, 'radiogroup "Tipo docente" presente');
  typeRadio(renderer, 'Docente curricolare');
  typeRadio(renderer, 'Docente di sostegno');
  assert.equal(flatText(renderer.root).includes('Profilo Docente di Sostegno'), false, 'vecchio banner rimosso');
  assert.equal(renderer.root.findAll((n: any) => n.type === 'label' && flatText(n) === 'Attivo').length, 0, 'vecchia checkbox "Attivo" rimossa');
  await act(async () => { renderer.unmount(); });
});

test('ProfileModal: profilo legacy senza flag + materia Sostegno compare inizialmente come sostegno', async () => {
  const legacy: TeacherProfile = { ...profileFixture(), primarySubjects: ['Sostegno'] };
  delete legacy.isSupportTeacher;
  const renderer = await renderProfileModal(legacy, () => {});
  assert.equal(typeRadio(renderer, 'Docente di sostegno').props['aria-checked'], true, 'sostegno pre-selezionato (fallback legacy)');
  assert.equal(typeRadio(renderer, 'Docente curricolare').props['aria-checked'], false);
  await act(async () => { renderer.unmount(); });
});

test('ProfileModal: false esplicito + materia Sostegno compare come curricolare (regola fondamentale)', async () => {
  const renderer = await renderProfileModal(profileFixture({ isSupportTeacher: false, primarySubjects: ['Sostegno'] }), () => {});
  assert.equal(typeRadio(renderer, 'Docente curricolare').props['aria-checked'], true);
  assert.equal(typeRadio(renderer, 'Docente di sostegno').props['aria-checked'], false);
  await act(async () => { renderer.unmount(); });
});

test('ProfileModal: selezione "Docente di sostegno" salva isSupportTeacher true (esplicito)', async () => {
  const saved: TeacherProfile[] = [];
  const renderer = await renderProfileModal(profileFixture({ isSupportTeacher: false, primarySubjects: ['Matematica'] }), (p) => { saved.push(p); });
  await act(async () => { typeRadio(renderer, 'Docente di sostegno').props.onClick(); });
  assert.equal(typeRadio(renderer, 'Docente di sostegno').props['aria-checked'], true, 'stato selezionato visibile');
  await submitProfileForm(renderer);
  assert.equal(saved.length, 1, 'salvataggio eseguito');
  assert.equal(saved[0].isSupportTeacher, true, 'true esplicito persistito');
  await act(async () => { renderer.unmount(); });
});

test('ProfileModal: selezione "Docente curricolare" salva isSupportTeacher false', async () => {
  const saved: TeacherProfile[] = [];
  const legacy: TeacherProfile = { ...profileFixture(), primarySubjects: ['Sostegno'] };
  delete legacy.isSupportTeacher;
  const renderer = await renderProfileModal(legacy, (p) => { saved.push(p); });
  await act(async () => { typeRadio(renderer, 'Docente curricolare').props.onClick(); });
  await submitProfileForm(renderer);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].isSupportTeacher, false, 'false esplicito persistito (anche partendo da legacy sostegno)');
  await act(async () => { renderer.unmount(); });
});

test('ProfileModal: CASO CRITICO — false esplicito + Sostegno resta false dopo apertura/salvataggio/riapertura', async () => {
  let savedProfile: TeacherProfile | undefined;
  const profile = profileFixture({ isSupportTeacher: false, primarySubjects: ['Sostegno'] });
  // Apertura 1 + salvataggio senza toccare il selettore: nessun ratchet.
  let renderer = await renderProfileModal(profile, (p) => { savedProfile = p; });
  await submitProfileForm(renderer);
  assert.equal(savedProfile?.isSupportTeacher, false, 'save senza interazione: false resta false');
  await act(async () => { renderer.unmount(); });
  // Riapertura con il profilo appena salvato: ancora curricolare.
  renderer = await renderProfileModal(savedProfile!, () => {});
  assert.equal(typeRadio(renderer, 'Docente curricolare').props['aria-checked'], true, 'riapertura: sempre curricolare');
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// 5. Compresenza: la UI dell editor segue il ruolo canonico (regressione chiave)
// ---------------------------------------------------------------------------

type EditorProps = React.ComponentProps<typeof TimetableEditor>;

function editorProps(patch: Partial<EditorProps> = {}): EditorProps {
  return {
    profile: profileFixture({ isSupportTeacher: true }),
    definitiveTimetable: [],
    provisionalTimetable: [],
    timetableMode: 'auto',
    activeType: 'provvisorio',
    isDefinitiveCompiled: false,
    timeSlotConfig: {
      firstHourStartTime: '07:50', periodsPerDay: 6, standardDurationMinutes: 60,
      customSlots: [
        { periodNumber: 1, label: '1ª Ora', startTime: '07:50', endTime: '08:50' },
        { periodNumber: 2, label: '2ª Ora', startTime: '08:50', endTime: '09:50' },
        { periodNumber: 3, label: '3ª Ora', startTime: '09:50', endTime: '10:50' },
      ],
    },
    onSaveSlot: () => {},
    onDeleteSlot: () => {},
    onSetTimetableMode: () => {},
    onCopyProvisionalToDefinitive: () => {},
    onCopyDefinitiveToProvisional: () => {},
    onClearTimetable: () => {},
    onSaveProfile: () => {},
    onSaveTimeSlotConfig: () => {},
    ...patch,
  };
}

async function renderEditor(props: EditorProps) {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(TimetableEditor, props)); });
  return renderer;
}

async function openSlotForm(renderer: any) {
  const plus = renderer.root.findAll((el: any) => el.type === 'button' && String(el.props.title ?? '').includes('Lunedì'));
  assert.ok(plus.length > 0, 'cella libera del lunedì presente');
  await act(async () => { plus[0].props.onClick(); });
}

test('compresenza: profilo LEGACY (flag assente + Sostegno) mostra l UI del docente di sostegno', async () => {
  const legacy: TeacherProfile = { ...profileFixture(), primarySubjects: ['Sostegno'] };
  delete legacy.isSupportTeacher;
  const renderer = await renderEditor(editorProps({ profile: legacy }));
  await openSlotForm(renderer);
  const all = flatText(renderer.root);
  assert.ok(all.includes('Materia/e in compresenza'), 'campo materie in compresenza presente');
  assert.ok(all.includes('Altri docenti di sostegno presenti'), 'campo altri docenti di sostegno presente');
  assert.ok(!all.includes('Docente/i di sostegno in compresenza'), 'nessun campo curricolare (concetto non invertito)');
  await act(async () => { renderer.unmount(); });
});

test('compresenza: false esplicito + Sostegno mostra l UI DEL DOCENTE CURRICOLARE (test di regressione principale)', async () => {
  const renderer = await renderEditor(editorProps({ profile: profileFixture({ isSupportTeacher: false, primarySubjects: ['Sostegno'] }) }));
  await openSlotForm(renderer);
  const all = flatText(renderer.root);
  assert.ok(all.includes('Docente/i di sostegno in compresenza'), 'campo docenti di sostegno presente');
  assert.ok(!all.includes('Materia/e in compresenza'), 'nessun campo materie (non è un docente di sostegno)');
  assert.ok(!all.includes('Altri docenti di sostegno presenti'));
  await act(async () => { renderer.unmount(); });
});

test('compresenza: flag true con materia curricolare mostra comunque l UI del sostegno', async () => {
  const renderer = await renderEditor(editorProps({ profile: profileFixture({ isSupportTeacher: true, primarySubjects: ['Matematica'] }) }));
  await openSlotForm(renderer);
  const all = flatText(renderer.root);
  assert.ok(all.includes('Materia/e in compresenza'));
  assert.ok(!all.includes('Docente/i di sostegno in compresenza'));
  await act(async () => { renderer.unmount(); });
});

// ---------------------------------------------------------------------------
// 6. Backup/Firestore: il flag resta opzionale (nessuna migrazione)
// ---------------------------------------------------------------------------

test('validazione payload: profilo senza flag resta valido (backup e Firestore legacy)', () => {
  const legacy: TeacherProfile = { ...profileFixture() };
  delete legacy.isSupportTeacher;
  assert.equal(isValidProfilePayload(legacy), true, 'profilo legacy senza flag valido');
  assert.equal(isValidProfilePayload(profileFixture({ isSupportTeacher: false })), true);
  assert.equal(isValidProfilePayload(profileFixture({ isSupportTeacher: true })), true);
});
