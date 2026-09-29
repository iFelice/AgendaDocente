import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { TimetableEditor } from '../src/components/TimetableEditor';
import { legacyPrimarySchoolId } from '../src/utils/multiSchool';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/**
 * MICRO-PASSO F2 — GRIGLIA DELL'ORARIO FILTRATA PER ISTITUTO.
 *
 * Il difetto risolto qui: la griglia cercava la lezione di una cella con
 * `currentSlots.find(dayOfWeek === d && periodNumber === p)` sull'array
 * AGGREGATO di tutti gli istituti. Con due lezioni sulla stessa coordinata in
 * scuole diverse ne compariva UNA SOLA — la prima inserita — e l'altra
 * diventava irraggiungibile: non apribile, non modificabile, non eliminabile,
 * pur restando salvata e visibile in Oggi/Settimana.
 *
 * F2 introduce un selettore d'istituto e filtra la griglia. L'identità usata è
 * quella canonica (`slotSchoolKey`), quindi gli slot legacy senza `schoolId`
 * restano nella primaria. Nessun dato viene migrato o riscritto.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SCHOOL_B_ID = 'school-liceo-verdi';

/** Scuola A (primaria): 6 ore ordinarie. Scuola B: 8 ore ordinarie. */
const schoolA = (id: string): SchoolProfile => ({
  id, name: 'IC Rossi', isPrimary: true, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 6 },
});
const schoolB: SchoolProfile = {
  id: SCHOOL_B_ID, name: 'Liceo Verdi', isPrimary: false, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 8 },
};

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Rossi',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: [], roles: [], isSupportTeacher: true,
};

/**
 * Id della primaria: `normalizeTeacherProfile` lo deriva dal profilo, quindi i
 * test non possono inventarlo — lo chiedono alla stessa funzione del prodotto.
 */
const PRIMARY_ID = legacyPrimarySchoolId(baseProfile);

/** Profilo con un solo istituto (la primaria sintetizzata dalla normalizzazione). */
const singleSchoolProfile: TeacherProfile = baseProfile;

/** Profilo con due istituti: A primaria (6 ore) e B secondaria (8 ore). */
const multiSchoolProfile: TeacherProfile = {
  ...baseProfile,
  schools: [schoolA(PRIMARY_ID), schoolB],
};

const timeSlotConfig: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 8, standardDurationMinutes: 60,
  customSlots: Array.from({ length: 8 }, (_, i) => ({
    periodNumber: i + 1,
    label: `${i + 1}ª Ora`,
    startTime: `${String(8 + i).padStart(2, '0')}:00`,
    endTime: `${String(9 + i).padStart(2, '0')}:00`,
  })),
};

function slot(over: Partial<TimetableSlot> & { id: string }): TimetableSlot {
  return {
    dayOfWeek: 1, periodNumber: 1, startTime: '08:00', endTime: '09:00',
    subject: 'Sostegno', className: '1A', isProvisional: false,
    ...over,
  };
}

/** LA coordinata contesa: lunedì 1ª ora in entrambe le scuole. */
const slotA = slot({ id: 'tt-a', className: 'A-UNO', schoolId: PRIMARY_ID });
const slotB = slot({ id: 'tt-b', className: 'B-UNO', schoolId: SCHOOL_B_ID });
/** Lezione salvata prima del modello multi-istituto: nessun `schoolId`. */
const slotLegacy = slot({ id: 'tt-legacy', dayOfWeek: 2, className: 'LEGACY-DUE' });
/** 8ª ora del lunedì: valida per B, fuori configurazione per A. */
const slotB8 = slot({ id: 'tt-b8', periodNumber: 8, startTime: '15:00', endTime: '16:00', className: 'B-OTTO', schoolId: SCHOOL_B_ID });

function editorProps(overrides: Record<string, unknown> = {}) {
  return {
    profile: multiSchoolProfile,
    definitiveTimetable: [] as TimetableSlot[],
    provisionalTimetable: [] as TimetableSlot[],
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

async function renderEditor(overrides: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(React.createElement(TimetableEditor, editorProps(overrides) as any));
  });
  return renderer;
}

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
const rootText = (renderer: any) => flatText(renderer.root);

const findById = (renderer: any, id: string) => renderer.root.findAll((el: any) => el.props?.id === id);
function byId(renderer: any, id: string) {
  const found = findById(renderer, id);
  assert.ok(found.length > 0, `elemento con id "${id}" assente`);
  return found[0];
}
const schoolSelect = (renderer: any) => byId(renderer, 'timetable-school-select');
const hasSchoolSelect = (renderer: any) => findById(renderer, 'timetable-school-select').length > 0;

async function selectSchool(renderer: any, schoolId: string) {
  await act(async () => { schoolSelect(renderer).props.onChange({ target: { value: schoolId } }); });
}

/** Le celle occupate della griglia (le card cliccabili delle lezioni). */
const lessonCells = (renderer: any) =>
  renderer.root.findAll((el: any) => el.type === 'div' && String(el.props?.className ?? '').includes('cursor-pointer'));

/** Il modale di modifica è aperto? */
const formCount = (renderer: any) => renderer.root.findAll((el: any) => el.type === 'form').length;
function formOf(renderer: any) {
  const forms = renderer.root.findAll((el: any) => el.type === 'form');
  assert.equal(forms.length, 1, 'il modale di modifica è aperto');
  return forms[0];
}

/** Il <select> "Numero dell'ora" del modale, con le sue opzioni. */
function periodOptions(renderer: any): number[] {
  const selects = formOf(renderer).findAllByType('select');
  // 0 = giorno, 1 = numero dell'ora (stesso ordine del JSX).
  return selects[1].props.children.map((opt: any) => Number(opt.props.value));
}
const daySelect = (renderer: any) => formOf(renderer).findAllByType('select')[0];
const periodSelect = (renderer: any) => formOf(renderer).findAllByType('select')[1];

/** Le celle "fuori configurazione" hanno il bordo ambrato tratteggiato di C2. */
const outOfConfigCells = (renderer: any) =>
  renderer.root.findAll((el: any) =>
    typeof el.props?.className === 'string' && el.props.className.includes('border-dashed') && el.props.className.includes('border-amber-400'));

/** Celle vuote AGGIUNGIBILI ("+"): il titolo è "Aggiungi lezione <Giorno> <Nª Ora>". */
const addTitles = (renderer: any): string[] =>
  renderer.root
    .findAll((el: any) => el.type === 'button' && String(el.props?.title ?? '').startsWith('Aggiungi lezione'))
    .map((el: any) => String(el.props.title));

/** Apre il drawer delle fasce orarie (dove vive il banner sul fabbisogno). */
async function openSlotConfig(renderer: any) {
  const button = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).includes('Fasce Orarie'))[0];
  assert.ok(button, 'il bottone "Fasce Orarie" esiste');
  await act(async () => { button.props.onClick(); });
}

// ---------------------------------------------------------------------------
// 1-4. Selettore
// ---------------------------------------------------------------------------

test('F2/1. una sola scuola: nessun selettore, nessuna intestazione "Istituto"', async () => {
  const renderer = await renderEditor({ profile: singleSchoolProfile, definitiveTimetable: [slotA, slotLegacy] });
  try {
    assert.equal(hasSchoolSelect(renderer), false, 'nessun selettore con un istituto solo');
    assert.equal(rootText(renderer).includes('Istituto'), false, 'nessuna etichetta "Istituto" nel DOM');
    // La griglia resta quella di sempre: entrambe le lezioni visibili.
    const text = rootText(renderer);
    assert.match(text, /A-UNO/);
    assert.match(text, /LEGACY-DUE/, 'gli slot legacy restano visibili');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/2-3. due scuole: selettore visibile, opzioni dal profilo, default = primaria', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [slotA, slotB] });
  try {
    const select = schoolSelect(renderer);
    assert.equal(select.props['aria-label'], 'Istituto');
    assert.deepEqual(
      select.props.children.map((opt: any) => [opt.props.value, opt.props.children]),
      [[PRIMARY_ID, 'IC Rossi'], [SCHOOL_B_ID, 'Liceo Verdi']],
      'un\'opzione per istituto, col nome dal profilo normalizzato',
    );
    assert.equal(select.props.value, PRIMARY_ID, 'default: istituto principale');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/4. il cambio del selettore cambia la scuola attiva', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [slotA, slotB] });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.equal(schoolSelect(renderer).props.value, SCHOOL_B_ID);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 5. Caso A — stessa coordinata in due istituti (il bug)
// ---------------------------------------------------------------------------

test('F2/5. A:Lun/1 e B:Lun/1 — entrambe raggiungibili, una per griglia', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [slotA, slotB] });
  try {
    // Scuola A: si vede SOLO la lezione di A.
    assert.match(rootText(renderer), /A-UNO/);
    assert.equal(rootText(renderer).includes('B-UNO'), false, 'la lezione di B non compare nella griglia di A');
    assert.equal(lessonCells(renderer).length, 1, 'una sola lezione nella griglia di A');
    // ...ed è apribile.
    await act(async () => { lessonCells(renderer)[0].props.onClick(); });
    assert.equal(formCount(renderer), 1);
    assert.match(flatText(formOf(renderer)), /A-UNO/);
    await act(async () => { renderer.root.findAll((el: any) => el.props?.['aria-label'] === 'Chiudi')[0].props.onClick(); });

    // Scuola B: si vede SOLO la lezione di B — prima era irraggiungibile.
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.match(rootText(renderer), /B-UNO/);
    assert.equal(rootText(renderer).includes('A-UNO'), false, 'la lezione di A non compare nella griglia di B');
    assert.equal(lessonCells(renderer).length, 1);
    await act(async () => { lessonCells(renderer)[0].props.onClick(); });
    assert.equal(formCount(renderer), 1);
    assert.match(flatText(formOf(renderer)), /B-UNO/, 'la seconda lezione è finalmente apribile');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/5b. il filtro è una VISTA: nessuna cancellazione, nessun riordino, nessuna scrittura', async () => {
  const timetable = [slotA, slotB, slotB8];
  const saves: unknown[] = [];
  const deletes: unknown[] = [];
  const renderer = await renderEditor({
    definitiveTimetable: timetable,
    onSaveSlot: (...args: unknown[]) => { saves.push(args); },
    onDeleteSlot: (...args: unknown[]) => { deletes.push(args); },
  });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    await selectSchool(renderer, PRIMARY_ID);
    assert.deepEqual(timetable, [slotA, slotB, slotB8], 'l array in ingresso non viene toccato');
    assert.equal(saves.length, 0, 'cambiare istituto non salva nulla');
    assert.equal(deletes.length, 0, 'cambiare istituto non cancella nulla');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/5c. il conteggio delle ore in barra segue la griglia mostrata', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [slotA, slotB, slotB8] });
  try {
    assert.match(rootText(renderer), /1 ora/, 'A ha una lezione');
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.match(rootText(renderer), /2 ore/, 'B ne ha due');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 6-7. Caso B — geometrie diverse
// ---------------------------------------------------------------------------

test('F2/6. A max 6 / B max 8: la 7ª e 8ª sono fuori configurazione solo per A', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [slotB8] });
  try {
    // Scuola A (6 ore): la riga 8 esiste perché ci sono 8 fasce configurate,
    // ma per A è fuori configurazione e non ci si può aggiungere nulla.
    const addA = addTitles(renderer);
    assert.equal(addA.some(t => /Lunedì 7/i.test(t)), false, 'A non abilita la 7ª');
    assert.equal(addA.some(t => /Lunedì 8/i.test(t)), false, 'A non abilita l 8ª');
    assert.ok(addA.some(t => /Lunedì 6/i.test(t)), 'A abilita la 6ª');

    // Scuola B (8 ore): 7ª e 8ª sono celle normali.
    await selectSchool(renderer, SCHOOL_B_ID);
    const addB = addTitles(renderer);
    assert.ok(addB.some(t => /Lunedì 7/i.test(t)), 'B abilita la 7ª');
    assert.ok(addB.some(t => /Martedì 8/i.test(t)), 'B abilita l 8ª');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/6b. la lezione B/8 non è marcata "fuori configurazione" nella griglia di B', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [slotB8] });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.match(rootText(renderer), /B-OTTO/, 'la lezione è mostrata');
    assert.equal(outOfConfigCells(renderer).length, 0, 'l 8ª ora è prevista da B: nessun avviso');
    assert.equal(rootText(renderer).includes('Ora non prevista'), false);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/7. rowCount di A non è gonfiato dalle lezioni di B', async () => {
  // Fasce configurate: 6. Unica lezione oltre la 6ª: B/8.
  const sixSlots: TimeSlotConfig = {
    ...timeSlotConfig, periodsPerDay: 6, customSlots: timeSlotConfig.customSlots!.slice(0, 6),
  };
  const renderer = await renderEditor({ definitiveTimetable: [slotA, slotB8], timeSlotConfig: sixSlots });
  try {
    const rowsOf = (r: any) => r.root.findAll((el: any) => el.type === 'tr').length;
    // Scuola A: 6 ore ordinarie, 6 fasce, nessuna sua lezione oltre la 6ª.
    const rowsA = rowsOf(renderer);
    // Scuola B: 8 ore ordinarie -> il fabbisogno porta la griglia a 8 righe.
    await selectSchool(renderer, SCHOOL_B_ID);
    const rowsB = rowsOf(renderer);
    assert.ok(rowsB > rowsA, `B deve avere più righe di A (A=${rowsA}, B=${rowsB})`);
    // La prova diretta: tornando su A la riga 8 sparisce di nuovo.
    await selectSchool(renderer, PRIMARY_ID);
    assert.equal(rowsOf(renderer), rowsA, 'l 8ª ora di B non lascia una riga vuota nella griglia di A');
    assert.equal(rootText(renderer).includes('B-OTTO'), false);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 8. Caso C — slot legacy
// ---------------------------------------------------------------------------

test('F2/8. slot senza schoolId: visibile nella primaria, assente nella secondaria', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [slotLegacy] });
  try {
    assert.match(rootText(renderer), /LEGACY-DUE/, 'la lezione legacy sta nella primaria');
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.equal(rootText(renderer).includes('LEGACY-DUE'), false, 'non compare nella secondaria');
    await selectSchool(renderer, PRIMARY_ID);
    assert.match(rootText(renderer), /LEGACY-DUE/, 'e torna al suo posto');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/8b. schoolId ORFANO: la lezione resta raggiungibile dalla primaria', async () => {
  // Istituto che non esiste (più) nel profilo: senza rete la lezione
  // sparirebbe da OGNI griglia, cioè il difetto che F2 deve eliminare.
  const orphan = slot({ id: 'tt-orphan', dayOfWeek: 3, className: 'ORFANA', schoolId: 'school-sparita' });
  const renderer = await renderEditor({ definitiveTimetable: [orphan] });
  try {
    assert.match(rootText(renderer), /ORFANA/, 'nessuna lezione invisibile');
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.equal(rootText(renderer).includes('ORFANA'), false, 'e non finisce in un istituto a caso');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 9-11. Modale
// ---------------------------------------------------------------------------

test('F2/9. lezione di B aperta dalla griglia di B: ore selezionabili secondo B', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [slotB] });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    await act(async () => { lessonCells(renderer)[0].props.onClick(); });
    assert.deepEqual(periodOptions(renderer), [1, 2, 3, 4, 5, 6, 7, 8], 'B arriva all 8ª');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/9b. lezione della primaria: le ore restano quelle di A', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [slotA] });
  try {
    await act(async () => { lessonCells(renderer)[0].props.onClick(); });
    assert.deepEqual(periodOptions(renderer), [1, 2, 3, 4, 5, 6], 'A si ferma alla 6ª');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/10. cambio giorno di una lezione di B: clamp secondo B, non secondo la primaria', async () => {
  // Geometrie deliberatamente DIVERSE, così il numero su cui avviene il clamp
  // dice da solo quale scuola è stata consultata:
  //   A (primaria): 4 ore tutti i giorni;
  //   B: 6 ore, ma il lunedì 8 (6 + 2 extra).
  // Una lezione di B il lunedì all'8ª, spostata al venerdì, deve scendere a 6
  // (geometria di B). Se il clamp usasse la primaria scenderebbe a 4.
  const longMonday: SchoolProfile = {
    ...schoolB, dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 1: 2 } },
  };
  const shortPrimary: SchoolProfile = { ...schoolA(PRIMARY_ID), dayPeriods: { ordinaryPeriodsPerDay: 4 } };
  const profile: TeacherProfile = { ...baseProfile, schools: [shortPrimary, longMonday] };
  const renderer = await renderEditor({ profile, definitiveTimetable: [slotB8] });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    await act(async () => { lessonCells(renderer)[0].props.onClick(); });
    assert.equal(periodSelect(renderer).props.value, 8, 'si parte dall 8ª ora del lunedì');
    // Sposta al venerdì: B ne prevede 6, quindi l ora scende alla 6ª.
    await act(async () => { daySelect(renderer).props.onChange({ target: { value: '5' } }); });
    assert.equal(periodSelect(renderer).props.value, 6, 'clamp alla 6ª: la geometria di B');
    assert.notEqual(periodSelect(renderer).props.value, 4, 'NON alla 4ª della primaria');
    assert.match(flatText(formOf(renderer)), /prevede 6 ore/, 'avviso di clamp esplicito');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/11. lezione di B aperta da Oggi/Settimana: la griglia passa a B e il modale usa B', async () => {
  const renderer = await renderEditor({
    definitiveTimetable: [slotA, slotB8],
    initialSlot: slotB8,
    initialSlotType: 'definitivo' as const,
  });
  try {
    assert.equal(formCount(renderer), 1, 'il modale si apre');
    assert.match(flatText(formOf(renderer)), /B-OTTO/, 'ed è la lezione giusta');
    // La griglia si è allineata all istituto REALE della lezione.
    assert.equal(schoolSelect(renderer).props.value, SCHOOL_B_ID, 'la griglia passa a B');
    // Nessun falso clamp sulla primaria: l 8ª ora resta l 8ª.
    assert.equal(periodSelect(renderer).props.value, 8, 'l ora non è stata riportata alla 6ª di A');
    assert.deepEqual(periodOptions(renderer), [1, 2, 3, 4, 5, 6, 7, 8], 'le ore sono quelle di B');
    assert.equal(rootText(renderer).includes('A-UNO'), false, 'la griglia sotto il modale è quella di B');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 12-14. Indipendenza delle dimensioni di stato
// ---------------------------------------------------------------------------

test('F2/12-13. istituto e provvisorio/definitivo sono indipendenti', async () => {
  const provB = slot({ id: 'tt-prov-b', dayOfWeek: 4, className: 'PROV-B', schoolId: SCHOOL_B_ID, isProvisional: true });
  const renderer = await renderEditor({ definitiveTimetable: [slotB], provisionalTimetable: [provB] });
  try {
    const tabCard = (label: string) =>
      renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).includes(label))[0];

    // Definitivo + scuola B -> cambio scuola -> resto su Definitivo.
    await selectSchool(renderer, SCHOOL_B_ID);
    assert.match(rootText(renderer), /Griglia Definitivo/);
    await selectSchool(renderer, PRIMARY_ID);
    assert.match(rootText(renderer), /Griglia Definitivo/, 'cambiare istituto non cambia il tipo di orario');

    // Scuola B -> cambio a Provvisorio -> resto sulla scuola B.
    await selectSchool(renderer, SCHOOL_B_ID);
    await act(async () => { tabCard('Orario Provvisorio').props.onClick(); });
    assert.match(rootText(renderer), /Griglia Provvisorio/);
    assert.equal(schoolSelect(renderer).props.value, SCHOOL_B_ID, 'cambiare orario non cambia istituto');
    assert.match(rootText(renderer), /PROV-B/, 'e mostra il provvisorio di B');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/14. cambiare istituto non cambia il giorno selezionato su mobile', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [slotA, slotB] });
  try {
    const dayChip = (label: string) =>
      renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === label)[0];
    const chip = dayChip('Mer');
    assert.ok(chip, 'i chip giorno del mobile esistono');
    await act(async () => { chip.props.onClick(); });
    const selectedBefore = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Mer')[0].props.className;
    await selectSchool(renderer, SCHOOL_B_ID);
    const selectedAfter = renderer.root.findAll((el: any) => el.type === 'button' && flatText(el) === 'Mer')[0].props.className;
    assert.equal(selectedAfter, selectedBefore, 'il chip "Mer" resta selezionato dopo il cambio istituto');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 15-16. Coerenza con C1 (banner fasce) e C2 (celle)
// ---------------------------------------------------------------------------

test('F2/15. il banner sul fabbisogno di fasce segue l istituto mostrato', async () => {
  // 6 fasce configurate: bastano ad A (6 ore), non a B (8 ore).
  const sixSlots: TimeSlotConfig = {
    ...timeSlotConfig, periodsPerDay: 6, customSlots: timeSlotConfig.customSlots!.slice(0, 6),
  };
  const renderer = await renderEditor({ timeSlotConfig: sixSlots });
  try {
    // Scuola A (6 ore): le 6 fasce bastano, nessuna proposta e nessun avviso.
    await openSlotConfig(renderer);
    const textA = rootText(renderer);
    assert.equal(/fasce in più|mancano \d+ fasce orarie|manca 1 fascia oraria/.test(textA), false, 'per A le 6 fasce bastano');

    // Scuola B (8 ore): lo STESSO drawer ora dichiara il fabbisogno di B.
    await selectSchool(renderer, SCHOOL_B_ID);
    await openSlotConfig(renderer);
    const textB = rootText(renderer);
    assert.match(textB, /8 ore previste dalla tua scuola/, 'il fabbisogno è quello di B');
    assert.match(textB, /2 fasce in più/, 'mancano due fasce rispetto alle 8 ore di B');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F2/16. celle disabilitate e righe virtuali seguono l istituto mostrato', async () => {
  const renderer = await renderEditor({ definitiveTimetable: [] });
  try {
    // A (6 ore) con 8 fasce configurate: 7ª e 8ª sono righe fuori configurazione
    // in tutti i giorni, quindi senza "+".
    const addA = addTitles(renderer);
    assert.equal(addA.filter(t => /7ª|8ª/.test(t)).length, 0, 'per A nessun "+" oltre la 6ª');
    assert.ok(addA.length > 0, 'ma le celle previste restano aggiungibili');

    await selectSchool(renderer, SCHOOL_B_ID);
    const addB = addTitles(renderer);
    assert.ok(addB.filter(t => /7ª|8ª/.test(t)).length > 0, 'per B la 7ª e l 8ª sono aggiungibili');
    assert.ok(addB.length > addA.length, 'B ha più celle utilizzabili di A');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 17. Guard-rail anti-regressione sul lookup
// ---------------------------------------------------------------------------

test('F2/17. il rendering della griglia NON torna sull array aggregato', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(process.cwd(), 'src', 'components', 'TimetableEditor.tsx'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  // Il lookup della cella e il conteggio delle righe devono lavorare
  // sull'array filtrato per istituto: su `currentSlots` due lezioni di scuole
  // diverse tornerebbero a nascondersi a vicenda.
  assert.ok(!/currentSlots\.find\s*\(/.test(code), 'nessun lookup di cella su currentSlots');
  assert.ok(/schoolSlots\.find\s*\(/.test(code), 'il lookup usa schoolSlots');
  assert.ok(!/currentSlots\.reduce\s*\(/.test(code), 'rowCount non si calcola sull array aggregato');

  // L'identità dell'istituto passa SEMPRE dalla funzione canonica: un confronto
  // diretto su `slot.schoolId` farebbe sparire gli slot legacy.
  assert.ok(/slotSchoolKey\(/.test(code), 'la griglia usa slotSchoolKey');
  assert.ok(!/\.schoolId\s*===\s*activeSchoolId/.test(code), 'mai il confronto grezzo su slot.schoolId');

  // F3/F4/F5 restano fuori da questo passo.
  assert.ok(!/schoolId:\s*activeSchoolId/.test(code), 'la creazione manuale non assegna ancora schoolId (F3)');
});


// ---------------------------------------------------------------------------
// F3 — CREAZIONE MANUALE CON ISTITUTO IMPLICITO
//
// Ultima porta interattiva che generava lezioni senza `schoolId`: il "+" della
// griglia. Da qui in poi la scuola è quella della griglia da cui si è premuto,
// catturata all'APERTURA del modale. Nessun backfill sugli slot già salvati.
// ---------------------------------------------------------------------------

/** Premi il "+" della cella `giorno`/`ora` (la cella deve essere aggiungibile). */
async function clickAdd(renderer: any, dayLabel: string, periodLabel: string) {
  const button = renderer.root.findAll(
    (el: any) => el.type === 'button' && String(el.props?.title ?? '') === `Aggiungi lezione ${dayLabel} ${periodLabel}`,
  )[0];
  assert.ok(button, `cella "+" ${dayLabel} ${periodLabel} assente`);
  await act(async () => { button.props.onClick(); });
  assert.equal(formCount(renderer), 1, 'il modale di creazione è aperto');
}

/** Compila la classe e invia il form: restituisce lo slot passato a onSaveSlot. */
async function submitNewSlot(renderer: any, className = '1A') {
  const form = formOf(renderer);
  const classSelect = form.findAllByType('select')[2];
  await act(async () => { classSelect.props.onChange({ target: { value: className } }); });
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
}

/** Lo slot del draft attualmente in composizione, letto dai campi del modale. */
const draftPeriod = (renderer: any) => periodSelect(renderer).props.value;

test('F3/1-6. creazione sulla secondaria: schoolId = B, visibile solo nella griglia B', async () => {
  const saved: Array<{ slot: TimetableSlot; type: string }> = [];
  let timetable: TimetableSlot[] = [];
  const renderer = await renderEditor({
    definitiveTimetable: timetable,
    onSaveSlot: (slot: TimetableSlot, type: string) => { saved.push({ slot, type }); },
  });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    await clickAdd(renderer, 'Mercoledì', '2ª Ora');
    await submitNewSlot(renderer, '2E');

    assert.equal(saved.length, 1, 'una sola lezione salvata');
    assert.equal(saved[0].slot.schoolId, SCHOOL_B_ID, 'la nuova lezione nasce nella scuola mostrata');
    assert.equal(saved[0].type, 'definitivo');
    assert.equal(saved[0].slot.dayOfWeek, 3);
    assert.equal(saved[0].slot.periodNumber, 2);
  } finally {
    await act(async () => { renderer.unmount(); });
  }

  // Lo slot salvato, rimesso nell'orario, compare SOLO nella griglia di B.
  timetable = [saved[0].slot];
  const reopened = await renderEditor({ definitiveTimetable: timetable });
  try {
    assert.equal(rootText(reopened).includes('2E'), false, 'non compare nella primaria');
    await selectSchool(reopened, SCHOOL_B_ID);
    assert.match(rootText(reopened), /2E/, 'compare nella griglia di B');
  } finally {
    await act(async () => { reopened.unmount(); });
  }
});

test('F3/7. creazione sulla primaria: schoolId = id della primaria', async () => {
  const saved: TimetableSlot[] = [];
  const renderer = await renderEditor({ onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); } });
  try {
    await clickAdd(renderer, 'Lunedì', '1ª Ora');
    await submitNewSlot(renderer);
    assert.equal(saved[0].schoolId, PRIMARY_ID);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F3/9-10. una sola scuola: nessun selettore, ma schoolId comunque esplicito', async () => {
  const saved: TimetableSlot[] = [];
  const renderer = await renderEditor({
    profile: singleSchoolProfile,
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    assert.equal(hasSchoolSelect(renderer), false, 'UX invariata: nessun selettore');
    await clickAdd(renderer, 'Lunedì', '1ª Ora');
    await submitNewSlot(renderer);
    assert.equal(saved[0].schoolId, PRIMARY_ID, 'i nuovi dati non dipendono più dal fallback legacy');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F3/11-12. istituto e tipo di orario sono indipendenti anche in creazione', async () => {
  const saved: Array<{ slot: TimetableSlot; type: string }> = [];
  const renderer = await renderEditor({
    onSaveSlot: (slot: TimetableSlot, type: string) => { saved.push({ slot, type }); },
  });
  try {
    const tabCard = (label: string) =>
      renderer.root.findAll((el: any) => el.type === 'button' && flatText(el).includes(label))[0];

    // Definitivo + scuola B.
    await selectSchool(renderer, SCHOOL_B_ID);
    await clickAdd(renderer, 'Lunedì', '1ª Ora');
    await submitNewSlot(renderer);

    // Provvisorio + scuola B: l'istituto non dipende dal tipo di orario.
    await act(async () => { tabCard('Orario Provvisorio').props.onClick(); });
    assert.equal(schoolSelect(renderer).props.value, SCHOOL_B_ID, 'la scuola resta B');
    await clickAdd(renderer, 'Lunedì', '1ª Ora');
    await submitNewSlot(renderer);

    assert.deepEqual(saved.map(s => s.type), ['definitivo', 'provvisorio']);
    assert.deepEqual(saved.map(s => s.slot.schoolId), [SCHOOL_B_ID, SCHOOL_B_ID]);
    assert.deepEqual(saved.map(s => s.slot.isProvisional), [false, true]);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F3/13-14. il draft cattura l istituto all APERTURA e non lo rilegge al salvataggio', async () => {
  const saved: TimetableSlot[] = [];
  const renderer = await renderEditor({ onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); } });
  try {
    // "+" premuto dalla griglia di B: da questo momento il draft è di B.
    await selectSchool(renderer, SCHOOL_B_ID);
    await clickAdd(renderer, 'Lunedì', '7ª Ora');

    // Lo stato del selettore cambia mentre il modale è ancora aperto: una
    // lezione già in composizione non deve cambiare istituto sotto le mani.
    await selectSchool(renderer, PRIMARY_ID);
    assert.equal(formCount(renderer), 1, 'il modale resta aperto');
    assert.equal(draftPeriod(renderer), 7, 'la 7ª ora del draft non viene toccata');

    await submitNewSlot(renderer);
    assert.equal(saved[0].schoolId, SCHOOL_B_ID, 'salvata in B: l istituto era stato catturato all apertura');
    assert.equal(saved[0].periodNumber, 7, 'e la 7ª ora, valida per B, non è stata clampata');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F3/15-16. modifica: B resta B, e uno slot legacy NON viene convertito da F3', async () => {
  const saved: TimetableSlot[] = [];
  const renderer = await renderEditor({
    definitiveTimetable: [slotB, slotLegacy],
    onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); },
  });
  try {
    // Slot della secondaria: modificato, resta della secondaria.
    await selectSchool(renderer, SCHOOL_B_ID);
    await act(async () => { lessonCells(renderer)[0].props.onClick(); });
    await submitNewSlot(renderer, '2E');
    assert.equal(saved[0].id, slotB.id, 'stesso slot, non uno nuovo');
    assert.equal(saved[0].schoolId, SCHOOL_B_ID, 'schoolId preservato dalla modifica');

    // Slot legacy: F3 riguarda la CREAZIONE, non la normalizzazione
    // opportunistica in modifica. Il campo resta assente.
    await selectSchool(renderer, PRIMARY_ID);
    await act(async () => { lessonCells(renderer)[0].props.onClick(); });
    await submitNewSlot(renderer, '1A');
    assert.equal(saved[1].id, slotLegacy.id);
    assert.equal('schoolId' in saved[1], false, 'nessuna conversione opportunistica dello slot legacy');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

test('F3/17-18. nuova lezione di B: nessun falso clamp, e il cambio giorno usa B', async () => {
  // B: 6 ore, ma il lunedì 8 (6 + 2). La primaria ne ha 4: se la creazione
  // guardasse lei, la 7ª non sarebbe nemmeno aggiungibile.
  const longMonday: SchoolProfile = {
    ...schoolB, dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 1: 2 } },
  };
  const shortPrimary: SchoolProfile = { ...schoolA(PRIMARY_ID), dayPeriods: { ordinaryPeriodsPerDay: 4 } };
  const profile: TeacherProfile = { ...baseProfile, schools: [shortPrimary, longMonday] };
  const saved: TimetableSlot[] = [];
  const renderer = await renderEditor({ profile, onSaveSlot: (slot: TimetableSlot) => { saved.push(slot); } });
  try {
    await selectSchool(renderer, SCHOOL_B_ID);
    // 8ª ora del lunedì: valida per B, impensabile per la primaria (4 ore).
    await clickAdd(renderer, 'Lunedì', '8ª Ora');
    assert.equal(draftPeriod(renderer), 8, 'nessun falso clamp alla creazione');
    assert.deepEqual(periodOptions(renderer), [1, 2, 3, 4, 5, 6, 7, 8], 'le ore offerte sono quelle di B');

    // Cambio giorno: il martedì di B ne prevede 6, quindi si scende a 6 — non a
    // 4, che sarebbe la geometria della primaria.
    await act(async () => { daySelect(renderer).props.onChange({ target: { value: '2' } }); });
    assert.equal(draftPeriod(renderer), 6, 'clamp secondo B');
    assert.notEqual(draftPeriod(renderer), 4, 'NON secondo la primaria');

    await submitNewSlot(renderer);
    assert.equal(saved[0].schoolId, SCHOOL_B_ID);
    assert.equal(saved[0].periodNumber, 6);
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});
