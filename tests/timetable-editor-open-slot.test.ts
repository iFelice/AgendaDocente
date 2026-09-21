import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TimetableEditor } from '../src/components/TimetableEditor';
import type { TeacherProfile, TimetableSlot, TimetableType } from '../src/types';

/*
 * Apertura DIRETTA del modale di modifica di una lezione (tap dal Planning:
 * Oggi/Settimana) + guard-rail provvisorio/definitivo + "Torna al Planning".
 *
 * Copre i requisiti del micro-step 2:
 *  A. initialSlot definitivo: tab giusto, modale "Modifica" precompilato;
 *  B. initialSlot provvisorio con definitivo compilato: "Salva in Provvisorio",
 *     tab bloccati (impossibile salvare nel definitivo);
 *  C/D. id assente nell'orario dichiarato: NESSUN modale, NESSUN fallback
 *       sull'altro orario, NESSUNA scrittura, solo avviso;
 *  E. Save con tipo + baseline (CAS = slot reale dell'array) corretti e dati
 *     opzionali (schoolId, compresenze) preservati;
 *  F. Delete con id + tipo corretti;
 *  G. Annulla/X: zero scritture, modale chiuso, MAI onBackToOrigin;
 *  H. tab disabilitati solo durante la modifica di uno slot esistente;
 *  I. "Torna al Planning" solo con callback, mai a modale aperto;
 *  L. standalone (senza le nuove props): comportamento invariato;
 *  M. richiesta one-shot: dopo Save/Cancel il modale non si riapre.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Leonardo Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

/** Lezione del definitivo, ricca di campi opzionali. */
const defSlot: TimetableSlot = {
  id: 'tt-def-1', dayOfWeek: 2, periodNumber: 3, startTime: '09:50', endTime: '10:50',
  subject: 'Matematica', className: '1A', classroom: 'Aula 12', campus: 'Sede Centrale',
  color: '#34d399', isProvisional: false,
  coTeachingSubjects: ['Scienze'], coSupportTeachers: ['Prof.ssa Rossi'],
  supportTeachers: ['Prof. Bianchi'], schoolId: 'school-00000001',
};

/** Lezione del provvisorio (id diverso: nessuna sovrapposizione fra i due orari). */
const provSlot: TimetableSlot = {
  id: 'tt-prov-1', dayOfWeek: 3, periodNumber: 1, startTime: '07:50', endTime: '08:50',
  subject: 'Italiano', className: '2E', isProvisional: true,
};

const timeSlotConfig = {
  firstHourStartTime: '07:50', periodsPerDay: 3, standardDurationMinutes: 60,
  customSlots: [
    { periodNumber: 1, startTime: '07:50', endTime: '08:50' },
    { periodNumber: 2, startTime: '08:50', endTime: '09:50' },
    { periodNumber: 3, startTime: '09:50', endTime: '10:50' },
  ],
};

function editorProps(overrides: Partial<React.ComponentProps<typeof TimetableEditor>> = {}) {
  return {
    profile,
    definitiveTimetable: [defSlot] as TimetableSlot[],
    provisionalTimetable: [provSlot] as TimetableSlot[],
    timetableMode: 'auto' as const,
    activeType: 'definitivo' as const,
    isDefinitiveCompiled: true,
    timeSlotConfig,
    onSaveSlot: () => {},
    onDeleteSlot: () => {},
    onSetTimetableMode: () => {},
    onCopyProvisionalToDefinitive: () => {},
    onCopyDefinitiveToProvisional: () => {},
    onClearTimetable: () => {},
    ...overrides,
  };
}

async function renderEditor(overrides: Partial<React.ComponentProps<typeof TimetableEditor>> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, editorProps(overrides) as any));
  });
  return renderer;
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
const flatText = (node: any) => nodeText(node).replace(/\s+/g, ' ').trim();
const rootText = (renderer: any) => flatText(renderer.root);

function formCount(renderer: any): number {
  return renderer.root.findAll((el: any) => el.type === 'form').length;
}

function formOf(renderer: any) {
  const forms = renderer.root.findAll((el: any) => el.type === 'form');
  assert.equal(forms.length, 1, 'il modale di modifica è aperto (un solo form)');
  return forms[0];
}

function tabCard(renderer: any, label: 'Orario Provvisorio' | 'Orario Definitivo') {
  const cards = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).includes(label));
  assert.equal(cards.length, 1, `un solo tab "${label}"`);
  return cards[0];
}

function activeTabOf(renderer: any): TimetableType {
  if (String(tabCard(renderer, 'Orario Provvisorio').props.className ?? '').includes('ring-amber-300')) return 'provvisorio';
  if (String(tabCard(renderer, 'Orario Definitivo').props.className ?? '').includes('ring-emerald-300')) return 'definitivo';
  throw new Error('nessun tab risulta attivo');
}

function buttonByText(renderer: any, text: string) {
  const btns = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === text);
  assert.equal(btns.length, 1, `un solo bottone "${text}"`);
  return btns[0];
}

function byId(renderer: any, id: string): any[] {
  return renderer.root.findAll((el: any) => el.props?.id === id);
}

function noticeOf(renderer: any): string {
  const nodes = byId(renderer, 'slot-edit-notice');
  assert.equal(nodes.length, 1, 'l\'avviso "lezione non disponibile" è mostrato');
  return flatText(nodes[0]);
}

// ---------------------------------------------------------------------------
// A. Apertura diretta: definitivo
// ---------------------------------------------------------------------------

test('A. initialSlot definitivo: tab definitivo, modale "Modifica" precompilato', async () => {
  const renderer = await renderEditor({ initialSlot: defSlot, initialSlotType: 'definitivo' });

  assert.equal(activeTabOf(renderer), 'definitivo', 'il tab è quello DICHIARATO da initialSlotType');
  const form = formOf(renderer);
  assert.ok(rootText(renderer).includes('Modifica Ora di Lezione'), 'titolo di modifica, non di aggiunta');

  // Precompilazione: materia, aula, plesso (input) e giorno/periodo/classe (select).
  const inputValues = renderer.root.findAllByType('input').map((el: any) => el.props.value);
  assert.ok(inputValues.includes('Matematica'), 'materia precompilata');
  assert.ok(inputValues.includes('Aula 12'), 'aula precompilata');
  assert.ok(inputValues.includes('Sede Centrale'), 'plesso precompilato');
  const selectValues = renderer.root.findAllByType('select').map((el: any) => String(el.props.value));
  assert.ok(selectValues.includes('2'), 'giorno (dayOfWeek) precompilato');
  assert.ok(selectValues.includes('3'), 'numero ora precompilato');
  assert.ok(selectValues.includes('1A'), 'classe precompilata');
  assert.ok(form, 'il form del modale è montato');
});

// ---------------------------------------------------------------------------
// B. Apertura diretta: provvisorio (con definitivo compilato)
// ---------------------------------------------------------------------------

test('B. initialSlot provvisorio con definitivo compilato: "Salva in Provvisorio", tab bloccati', async () => {
  const renderer = await renderEditor({
    initialSlot: provSlot,
    initialSlotType: 'provvisorio',
    // isDefinitiveCompiled: true (default dell'helper): il tab di default sarebbe
    // il definitivo, ma initialSlotType deve vincere.
  });

  assert.equal(activeTabOf(renderer), 'provvisorio', 'initialSlotType vince sul default interno');
  assert.ok(rootText(renderer).includes('🕒 Orario Provvisorio'), 'badge del modale sull\'orario giusto');
  assert.ok(rootText(renderer).includes('Salva in Provvisorio'), 'destinazione di salvataggio esplicita');

  // Modale aperto su slot ESISTENTE: entrambi i tab bloccati → impossibile
  // spostare la destinazione di Salva/Elimina sul definitivo.
  assert.equal(tabCard(renderer, 'Orario Definitivo').props.disabled, true, 'tab Definitivo disabilitato');
  assert.equal(tabCard(renderer, 'Orario Provvisorio').props.disabled, true, 'tab Provvisorio disabilitato');
  assert.equal(tabCard(renderer, 'Orario Definitivo').props['aria-disabled'], true);
});

// ---------------------------------------------------------------------------
// C/D. Guard-rail: l'id non c'è nell'orario dichiarato
// ---------------------------------------------------------------------------

test('C. tipo definitivo ma id solo nel provvisorio: nessun modale, nessun fallback, nessuna scrittura', async () => {
  let writes = 0;
  const renderer = await renderEditor({
    initialSlot: provSlot, // l'id esiste SOLO nel provvisorio
    initialSlotType: 'definitivo', // ma la richiesta dichiara il definitivo
    onSaveSlot: () => { writes += 1; },
    onDeleteSlot: () => { writes += 1; },
  });

  assert.equal(formCount(renderer), 0, 'il modale NON si apre');
  assert.ok(noticeOf(renderer).includes("La lezione non è più disponibile nell'orario selezionato."), 'avviso chiaro');
  assert.equal(writes, 0, 'zero scritture');
  assert.equal(activeTabOf(renderer), 'definitivo', 'nessun fallback: né tab né dati vengono toccati');
});

test('D. tipo provvisorio ma id solo nel definitivo: stesso comportamento sicuro', async () => {
  let writes = 0;
  const renderer = await renderEditor({
    initialSlot: defSlot, // l'id esiste SOLO nel definitivo
    initialSlotType: 'provvisorio', // la richiesta dichiara il provvisorio
    onSaveSlot: () => { writes += 1; },
    onDeleteSlot: () => { writes += 1; },
  });

  assert.equal(formCount(renderer), 0, 'il modale NON si apre');
  assert.ok(noticeOf(renderer).includes("La lezione non è più disponibile nell'orario selezionato."));
  assert.equal(writes, 0, 'zero scritture');
  assert.equal(activeTabOf(renderer), 'definitivo', 'nessun fallback sull\'altro orario');
});

// ---------------------------------------------------------------------------
// E. Save: tipo + baseline corretti, dati opzionali preservati
// ---------------------------------------------------------------------------

test('E. Save via apertura diretta: tipo giusto, baseline = slot reale dell\'array, compresenze e schoolId preservati', async () => {
  let savedSlot: TimetableSlot | undefined;
  let savedType: TimetableType | undefined;
  let savedBaseline: TimetableSlot | TimetableSlot[] | undefined;
  const renderer = await renderEditor({
    initialSlot: defSlot,
    initialSlotType: 'definitivo',
    onSaveSlot: (slot: TimetableSlot, type: TimetableType, expected?: TimetableSlot) => {
      savedSlot = slot; savedType = type; savedBaseline = expected;
    },
  });

  const form = formOf(renderer);
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });

  assert.equal(savedType, 'definitivo', 'onSaveSlot riceve il tipo DICHIARATO');
  assert.equal(savedBaseline, defSlot, 'la baseline CAS è lo slot REALE presente nell\'array, non una copia');
  assert.ok(savedSlot);
  assert.equal(savedSlot!.id, 'tt-def-1');
  assert.equal(savedSlot!.schoolId, 'school-00000001', 'schoolId preservato');
  assert.deepEqual(savedSlot!.coTeachingSubjects, ['Scienze'], 'materie in compresenza preservate');
  assert.deepEqual(savedSlot!.coSupportTeachers, ['Prof.ssa Rossi'], 'docenti in compresenza preservati');
  assert.deepEqual(savedSlot!.supportTeachers, ['Prof. Bianchi'], 'sostegno preservato');
  assert.equal(savedSlot!.classroom, 'Aula 12', 'aula preservata');
  assert.equal(savedSlot!.campus, 'Sede Centrale', 'plesso preservato');
  assert.equal(formCount(renderer), 0, 'dopo il salvataggio il modale si chiude');
});

// ---------------------------------------------------------------------------
// F. Delete: id + tipo corretti
// ---------------------------------------------------------------------------

test('F. Delete via apertura diretta: onDeleteSlot riceve id e tipo dell\'orario dichiarato', async () => {
  let deletedId: string | undefined;
  let deletedType: TimetableType | undefined;
  const renderer = await renderEditor({
    initialSlot: defSlot,
    initialSlotType: 'definitivo',
    onDeleteSlot: (id: string, type: TimetableType) => { deletedId = id; deletedType = type; },
  });

  await act(async () => { await buttonByText(renderer, 'Elimina ora').props.onClick(); });

  assert.equal(deletedId, 'tt-def-1', 'id corretto');
  assert.equal(deletedType, 'definitivo', 'tipo corretto: mai eliminare dall\'altro orario');
  assert.equal(formCount(renderer), 0, 'il modale si chiude dopo l\'eliminazione');
});

// ---------------------------------------------------------------------------
// G. Annulla / X: zero scritture, chiusura, MAI onBackToOrigin
// ---------------------------------------------------------------------------

test('G. Annulla e X: zero scritture e RITORNO AUTOMATICO al Planning (chiamano onBackToOrigin)', async () => {
  let saves = 0; let deletes = 0; let backs = 0;
  const base = {
    initialSlot: defSlot as TimetableSlot,
    initialSlotType: 'definitivo' as TimetableType,
    onBackToOrigin: () => { backs += 1; },
    onSaveSlot: () => { saves += 1; },
    onDeleteSlot: () => { deletes += 1; },
  };

  // Annulla: non scrive nulla e torna al Planning di origine (dall'iPhone reale:
  // l'utente si aspetta di tornare da dove è venuto, non di restare nell'editor).
  const renderer = await renderEditor(base);
  await act(async () => { buttonByText(renderer, 'Annulla').props.onClick(); });
  assert.equal(saves, 0); assert.equal(deletes, 0);
  assert.equal(backs, 1, 'Annulla torna al Planning di origine');

  // X: identico (contatore dedicato: il contatore di Annulla era gia' a 1).
  let backsX = 0;
  const renderer2 = await renderEditor({ ...base, onBackToOrigin: () => { backsX += 1; } });
  const closeButtons = renderer2.root.findAll((el: any) => el.props?.['aria-label'] === 'Chiudi');
  assert.equal(closeButtons.length, 1, 'il bottone X del modale è accessibile');
  await act(async () => { closeButtons[0].props.onClick(); });
  assert.equal(saves, 0); assert.equal(deletes, 0);
  assert.equal(backsX, 1, 'X torna al Planning di origine');
});

test('G2. standalone (nessuna sessione): Annulla/X chiudono il modale e NON chiamano nessun callback', async () => {
  let backs = 0;
  // onBackToOrigin assente: apertura dalla navigazione "Orario".
  const renderer = await renderEditor({ onBackToOrigin: undefined });
  await act(async () => {
    renderer.root.findAll((el: any) => el.type === 'div' && String(el.props.className ?? '').includes('cursor-pointer'))[0].props.onClick();
  });
  assert.equal(formCount(renderer), 1);
  await act(async () => { buttonByText(renderer, 'Annulla').props.onClick(); });
  assert.equal(formCount(renderer), 0, 'Annulla chiude il modale e resta nell\'editor');
  assert.equal(backs, 0);

  const renderer2 = await renderEditor({ onBackToOrigin: () => { backs += 1; } });
  // senza initialSlot non c'e' sessione in App: qui si verifica solo che il
  // bottone "Torna al Planning" non esista piu' in nessun caso (rimosso).
  assert.equal(byId(renderer2, 'back-to-planning').length, 0, 'nessuna UI morta: il bottone dedicato e stato rimosso');
});

// ---------------------------------------------------------------------------
// H. Tab bloccati SOLO durante la modifica di uno slot esistente
// ---------------------------------------------------------------------------

test('H. tab normali fuori dalla modifica, disabilitati mentre il modale edita uno slot esistente', async () => {
  const renderer = await renderEditor({}); // flusso interno standard

  assert.ok(!tabCard(renderer, 'Orario Provvisorio').props.disabled, 'tab liberi a modale chiuso');
  assert.ok(!tabCard(renderer, 'Orario Definitivo').props.disabled, 'tab liberi a modale chiuso');

  // Apre la modifica di uno slot ESISTENTE con il normale tap sulla cella.
  const cells = renderer.root.findAll((el: any) => el.type === 'div' && String(el.props.className ?? '').includes('cursor-pointer'));
  assert.ok(cells.length > 0, 'la cella occupata è cliccabile');
  await act(async () => { cells[0].props.onClick(); });
  assert.equal(formCount(renderer), 1);

  assert.equal(tabCard(renderer, 'Orario Provvisorio').props.disabled, true, 'tab bloccati durante la modifica');
  assert.equal(tabCard(renderer, 'Orario Definitivo').props.disabled, true, 'tab bloccati durante la modifica');

  await act(async () => { buttonByText(renderer, 'Annulla').props.onClick(); });
  assert.ok(!tabCard(renderer, 'Orario Provvisorio').props.disabled, 'tab di nuovo liberi dopo la chiusura');
  assert.ok(!tabCard(renderer, 'Orario Definitivo').props.disabled, 'tab di nuovo liberi dopo la chiusura');
});

// ---------------------------------------------------------------------------
// I. "Torna al Planning"
// ---------------------------------------------------------------------------

test('I. il bottone "Torna al Planning" è stato RIMOSSO (il ritorno è automatico a ogni chiusura)', async () => {
  // Nessun caso, con o senza sessione, a modale aperto o chiuso: nessuna UI morta.
  const solo = await renderEditor({});
  assert.equal(byId(solo, 'back-to-planning').length, 0, 'standalone: nessun bottone di ritorno');
  assert.ok(!rootText(solo).includes('Torna al Planning'), 'nessuna traccia del bottone rimosso');

  let backs = 0;
  const session = await renderEditor({ onBackToOrigin: () => { backs += 1; } });
  assert.equal(byId(session, 'back-to-planning').length, 0, 'nemmeno con sessione aperta: il ritorno e\' automatico');
  assert.ok(!rootText(session).includes('Torna al Planning'));
  assert.equal(backs, 0, 'il callback non viene chiamato senza una chiusura del modale');
});

test('H. save FALLITO (CAS/persistenza): NESSUN ritorno automatico, errore visibile, si resta nell\'editor', async () => {
  let backs = 0; let saves = 0;
  const renderer = await renderEditor({
    initialSlot: defSlot,
    initialSlotType: 'definitivo',
    onBackToOrigin: () => { backs += 1; },
    onSaveSlot: () => { saves += 1; return false; }, // save.run -> false = fallimento
  });
  const form = formOf(renderer);
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });
  assert.equal(saves, 1, 'onSaveSlot e\' stato tentato');
  assert.equal(backs, 0, 'nessun ritorno automatico su fallimento');
  assert.equal(formCount(renderer), 1, 'il modale resta aperto per correggere/riprovare');
  assert.ok(renderer.root.findAll((el: any) => el.props?.role === 'alert').length >= 1, 'messaggio di errore visibile');
});

test('I2. delete FALLITO: NESSUN ritorno automatico, errore visibile, si resta nell\'editor', async () => {
  let backs = 0; let deletes = 0;
  const renderer = await renderEditor({
    initialSlot: defSlot,
    initialSlotType: 'definitivo',
    onBackToOrigin: () => { backs += 1; },
    onDeleteSlot: () => { deletes += 1; return false; },
  });
  await act(async () => { await buttonByText(renderer, 'Elimina ora').props.onClick(); });
  assert.equal(deletes, 1);
  assert.equal(backs, 0, 'nessun ritorno automatico su fallimento');
  assert.equal(formCount(renderer), 1, 'il modale resta aperto');
  assert.ok(renderer.root.findAll((el: any) => el.props?.role === 'alert').length >= 1, 'messaggio di errore visibile');
});

test('E2. save riuscito con sessione: chiamata onBackToOrigin (ritorno automatico)', async () => {
  let backs = 0;
  const renderer = await renderEditor({
    initialSlot: defSlot,
    initialSlotType: 'definitivo',
    onBackToOrigin: () => { backs += 1; },
  });
  await act(async () => { await formOf(renderer).props.onSubmit({ preventDefault: () => {} }); });
  assert.equal(backs, 1, 'salvataggio riuscito -> ritorno automatico al Planning');
});

test('F2. delete riuscito con sessione: chiamata onBackToOrigin (ritorno automatico)', async () => {
  let backs = 0;
  const renderer = await renderEditor({
    initialSlot: defSlot,
    initialSlotType: 'definitivo',
    onBackToOrigin: () => { backs += 1; },
  });
  await act(async () => { await buttonByText(renderer, 'Elimina ora').props.onClick(); });
  assert.equal(backs, 1, 'eliminazione riuscita -> ritorno automatico al Planning');
});

// ---------------------------------------------------------------------------
// L. Standalone: comportamento legacy invariato
// ---------------------------------------------------------------------------

test('L. senza le nuove props l\'editor resta identico: nessuna apertura, nessun avviso, default tab legacy', async () => {
  const renderer = await renderEditor({});
  assert.equal(formCount(renderer), 0, 'nessun modale aperto automaticamente');
  assert.equal(byId(renderer, 'slot-edit-notice').length, 0, 'nessun avviso');
  assert.equal(byId(renderer, 'back-to-planning').length, 0, 'nessun bottone di ritorno');
  assert.equal(activeTabOf(renderer), 'definitivo', 'default legacy: definitivo quando isDefinitiveCompiled');

  const uncompiled = await renderEditor({ isDefinitiveCompiled: false });
  assert.equal(formCount(uncompiled), 0);
  assert.equal(byId(uncompiled, 'back-to-planning').length, 0);
  assert.equal(activeTabOf(uncompiled), 'provvisorio', 'default legacy: provvisorio quando il definitivo non è compilato');
});

// ---------------------------------------------------------------------------
// M. One-shot: nessuna riapertura dopo Save/Cancel
// ---------------------------------------------------------------------------

test('M. la richiesta iniziale è consumata una sola volta: dopo Save/Cancel il modale non si riapre', async () => {
  let saves = 0;
  const overrides = {
    initialSlot: defSlot as TimetableSlot,
    initialSlotType: 'definitivo' as TimetableType,
    onSaveSlot: () => { saves += 1; },
  };

  // Dopo il SAVE.
  const renderer = await renderEditor(overrides);
  await act(async () => { await formOf(renderer).props.onSubmit({ preventDefault: () => {} }); });
  assert.equal(formCount(renderer), 0);
  assert.equal(saves, 1);
  await act(async () => { renderer.update(React.createElement(TimetableEditor, editorProps(overrides) as any)); });
  assert.equal(formCount(renderer), 0, 'nessuna riapertura dopo il save');
  assert.equal(saves, 1, 'nessun doppio salvataggio');

  // Dopo il CANCEL.
  const renderer2 = await renderEditor(overrides);
  await act(async () => { buttonByText(renderer2, 'Annulla').props.onClick(); });
  assert.equal(formCount(renderer2), 0);
  await act(async () => { renderer2.update(React.createElement(TimetableEditor, editorProps(overrides) as any)); });
  assert.equal(formCount(renderer2), 0, 'nessuna riapertura dopo il cancel');
  assert.equal(saves, 1);
});
