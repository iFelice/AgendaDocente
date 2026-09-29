import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act, type ReactTestInstance } from 'react-test-renderer';
import { TodayView } from '../src/components/TodayView';
import { WeekView } from '../src/components/WeekView';
import { effectiveSchoolForSlot, legacyPrimarySchoolId, normalizeTeacherProfile } from '../src/utils/multiSchool';
import { OUT_OF_CONFIG_SLOT_BADGE, OUT_OF_CONFIG_SLOT_TITLE } from '../src/utils/schoolDayPeriods';
import type { SchoolProfile, TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/**
 * MICRO-PASSO F4 — CONTESTO D'ISTITUTO IN OGGI E SETTIMANA.
 *
 * Due difetti, la stessa causa: le viste aggregate non sapevano di quale
 * scuola fosse una lezione.
 *
 *  1. Due lezioni nella stessa ora in istituti diversi erano indistinguibili:
 *     stesse informazioni, nessun modo di capire dove bisognava andare.
 *  2. La marcatura "Ora non prevista" era calcolata SEMPRE sulla primaria, e
 *     quindi mentiva in entrambe le direzioni: marcava come irregolare l'8ª ora
 *     di un istituto che arriva all'8ª, e taceva su un'ora davvero fuori
 *     configurazione di un istituto più corto.
 *
 * Con un istituto solo nulla deve cambiare: nessun badge, nessuna complessità.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SCHOOL_B_ID = 'school-liceo-verdi';

const baseProfile: TeacherProfile = {
  id: 'p1', fullName: 'Prof. Andrea Conti', schoolName: 'IC Rossi',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['1A', '2E'], campuses: ['Sede Centrale'], roles: [], isSupportTeacher: true,
};

/** Id della primaria: lo deriva la normalizzazione, non il test. */
const PRIMARY_ID = legacyPrimarySchoolId(baseProfile);

/** A (primaria): 6 ore al giorno. B: 8 ore al giorno. */
const schoolA: SchoolProfile = {
  id: PRIMARY_ID, name: 'IC Rossi', isPrimary: true, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 6 },
};
const schoolB: SchoolProfile = {
  id: SCHOOL_B_ID, name: 'Liceo Verdi', isPrimary: false, active: true,
  dayPeriods: { ordinaryPeriodsPerDay: 8 },
};

/** Un istituto solo: la primaria sintetizzata dalla normalizzazione. */
const singleSchoolProfile: TeacherProfile = baseProfile;
/** Due istituti con geometrie diverse. */
const multiSchoolProfile: TeacherProfile = { ...baseProfile, schools: [schoolA, schoolB] };

const config = (count: number): TimeSlotConfig => ({
  firstHourStartTime: '08:00', periodsPerDay: count, standardDurationMinutes: 60,
  customSlots: Array.from({ length: count }, (_, i) => ({
    periodNumber: i + 1,
    label: `${i + 1}ª Ora`,
    startTime: `${String(8 + i).padStart(2, '0')}:00`,
    endTime: `${String(9 + i).padStart(2, '0')}:00`,
  })),
});

/** Lunedì 2026-09-14: la settimana di riferimento dei test Planning. */
const MONDAY_ISO = '2026-09-14';

function lesson(over: Partial<TimetableSlot> & { id: string }): TimetableSlot {
  return {
    dayOfWeek: 1, periodNumber: 1, startTime: '08:00', endTime: '09:00',
    subject: 'Matematica', className: '1A', isProvisional: false,
    ...over,
  };
}

/** LA coppia contesa: stessa ora, istituti diversi. */
const lessonA1 = lesson({ id: 'tt-a1', subject: 'Matematica', className: '1A', schoolId: PRIMARY_ID });
const lessonB1 = lesson({ id: 'tt-b1', subject: 'Latino', className: '2E', schoolId: SCHOOL_B_ID });
/** 8ª ora del lunedì: valida per B (8 ore), impossibile per A (6). */
const lessonB8 = lesson({ id: 'tt-b8', periodNumber: 8, startTime: '15:00', endTime: '16:00', subject: 'Greco', className: '2E', schoolId: SCHOOL_B_ID });
/** 9ª ora: fuori configurazione perfino per B. */
const lessonB9 = lesson({ id: 'tt-b9', periodNumber: 9, startTime: '16:00', endTime: '17:00', subject: 'Filosofia', className: '2E', schoolId: SCHOOL_B_ID });
/** Lezione salvata prima del modello multi-istituto: nessun `schoolId`. */
const lessonLegacy7 = lesson({ id: 'tt-legacy-7', periodNumber: 7, startTime: '14:00', endTime: '15:00', subject: 'Storia', className: '1A' });
/** `schoolId` che non corrisponde a nessun istituto del profilo. */
const lessonOrphan7 = lesson({ id: 'tt-orphan-7', periodNumber: 7, startTime: '14:00', endTime: '15:00', subject: 'Geografia', className: '1A', schoolId: 'school-rimossa' });

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

/** Badge istituto presenti nell'albero (marcatore dedicato, non il testo). */
const schoolBadges = (renderer: any): ReactTestInstance[] =>
  renderer.root.findAll((el: any) => el.props?.['data-slot-school'] !== undefined);
const badgeNames = (renderer: any): string[] => schoolBadges(renderer).map((b: any) => flatText(b));

/** Marcature "fuori configurazione". */
const marks = (renderer: any): ReactTestInstance[] =>
  renderer.root.findAll((el: any) => el.props?.['data-slot-out-of-config'] === 'true');

/** Card lezione tappabile. */
const lessonCards = (renderer: any): ReactTestInstance[] =>
  renderer.root.findAll((el: any) => el.props?.['data-slot-cell'] === 'lesson');
const cardFor = (renderer: any, text: string) =>
  lessonCards(renderer).find((c: any) => flatText(c).includes(text));

/** La card della lezione `subject` è marcata fuori configurazione? */
function isMarked(renderer: any, subject: string): boolean {
  const card = cardFor(renderer, subject);
  assert.ok(card, `card di "${subject}" assente`);
  return card!.findAll((el: any) => el.props?.['data-slot-out-of-config'] === 'true').length > 0;
}

function todayProps(overrides: Record<string, unknown> = {}) {
  return {
    profile: multiSchoolProfile,
    timeSlotConfig: config(9),
    timetable: [] as TimetableSlot[],
    events: [],
    scheduledAssessments: [],
    isProvisionalTimetable: false,
    isDefinitiveCompiled: true,
    timetableType: 'definitivo' as const,
    onOpenTimetableSlotForEdit: () => {},
    initialDateIso: MONDAY_ISO,
    onOpenNewEvent: () => {},
    onOpenCircularModal: () => {},
    onEditEvent: () => {},
    onDeleteEvent: () => {},
    onToggleComplete: () => {},
    ...overrides,
  };
}

function weekProps(overrides: Record<string, unknown> = {}) {
  return {
    profile: multiSchoolProfile,
    timeSlotConfig: config(9),
    timetable: [] as TimetableSlot[],
    events: [],
    isProvisionalTimetable: false,
    timetableType: 'definitivo' as const,
    onOpenTimetableSlotForEdit: () => {},
    onOpenNewEvent: () => {},
    onEditEvent: () => {},
    targetDateIso: MONDAY_ISO,
    ...overrides,
  };
}

async function renderToday(overrides: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(TodayView, todayProps(overrides) as any)); });
  return renderer;
}
async function renderWeek(overrides: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => { renderer = create(React.createElement(WeekView, weekProps(overrides) as any)); });
  return renderer;
}

/** Ogni caso vale per Oggi E per Settimana: le due viste non possono divergere. */
const BOTH_VIEWS: Array<[string, (o?: Record<string, unknown>) => Promise<any>]> = [
  ['Oggi', renderToday],
  ['Settimana', renderWeek],
];

// ---------------------------------------------------------------------------
// Risoluzione dell'istituto effettivo (dominio)
// ---------------------------------------------------------------------------

test('F4/0. effectiveSchoolForSlot: esplicito, legacy e orfano', () => {
  const schools = normalizeTeacherProfile(multiSchoolProfile).schools ?? [];
  assert.equal(effectiveSchoolForSlot(lessonB1, schools)?.id, SCHOOL_B_ID, 'schoolId valido');
  assert.equal(effectiveSchoolForSlot(lessonA1, schools)?.id, PRIMARY_ID, 'primaria esplicita');
  assert.equal(effectiveSchoolForSlot(lessonLegacy7, schools)?.id, PRIMARY_ID, 'legacy -> primaria');
  assert.equal(effectiveSchoolForSlot(lessonOrphan7, schools)?.id, PRIMARY_ID, 'orfano -> primaria');
  assert.equal(effectiveSchoolForSlot({ schoolId: '   ' }, schools)?.id, PRIMARY_ID, 'stringa vuota -> primaria');
  // Nessuna scuola: nessuna invenzione, e nessuna eccezione.
  assert.equal(effectiveSchoolForSlot(lessonB1, []), undefined);
  assert.equal(effectiveSchoolForSlot(lessonB1, undefined), undefined);
});

// ---------------------------------------------------------------------------
// 1-5 / 6. Badge — stessi casi in Oggi e Settimana
// ---------------------------------------------------------------------------

for (const [viewName, render] of BOTH_VIEWS) {
  test(`F4/1+6. ${viewName}: con due istituti ogni lezione dichiara il suo`, async () => {
    const renderer = await render({ timetable: [lessonA1, lessonB1] });
    try {
      assert.deepEqual(badgeNames(renderer).sort(), ['IC Rossi', 'Liceo Verdi']);
      // Il badge mostra il NOME, mai l'id o una stringa tecnica.
      const text = flatText(renderer.root);
      assert.equal(text.includes(SCHOOL_B_ID), false, 'nessun id tecnico a schermo');
      assert.equal(/Istituto school-|Istituto \w+-\w{8}/.test(text), false, 'nessuna etichetta "Istituto <id>"');
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });

  test(`F4/2+6. ${viewName}: con un istituto solo nessun badge`, async () => {
    const renderer = await render({ profile: singleSchoolProfile, timetable: [lessonA1] });
    try {
      assert.equal(schoolBadges(renderer).length, 0, 'nessun badge istituto');
      assert.equal(flatText(renderer.root).includes('IC Rossi'), false, 'nemmeno il nome della scuola');
      assert.match(flatText(renderer.root), /Matematica/, 'la lezione resta al suo posto');
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });

  test(`F4/3+6. ${viewName}: due lezioni nella stessa ora restano entrambe, ora distinguibili`, async () => {
    const renderer = await render({ timetable: [lessonA1, lessonB1] });
    try {
      const text = flatText(renderer.root);
      assert.match(text, /Matematica/, 'la lezione di A resta visibile');
      assert.match(text, /Latino/, 'e anche quella di B: nessun filtro, nessun raggruppamento');
      assert.equal(lessonCards(renderer).length, 2, 'due card distinte');
      // Ogni card porta il suo istituto: è questo che le rende leggibili.
      assert.match(flatText(cardFor(renderer, 'Matematica')!), /IC Rossi/);
      assert.match(flatText(cardFor(renderer, 'Latino')!), /Liceo Verdi/);
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });

  test(`F4/4+6. ${viewName}: lezione legacy senza schoolId -> badge della primaria`, async () => {
    const renderer = await render({ timetable: [lessonLegacy7] });
    try {
      assert.deepEqual(badgeNames(renderer), ['IC Rossi']);
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });

  test(`F4/5+6. ${viewName}: schoolId orfano -> badge della primaria, mai vuoto`, async () => {
    const renderer = await render({ timetable: [lessonOrphan7] });
    try {
      assert.match(flatText(renderer.root), /Geografia/, 'la lezione non sparisce');
      assert.deepEqual(badgeNames(renderer), ['IC Rossi'], 'badge risolto, non vuoto');
      assert.equal(flatText(renderer.root).includes('school-rimossa'), false, 'nessun id orfano a schermo');
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });
}

test('F4/7. Settimana: ordine per periodo invariato dall introduzione del badge', async () => {
  const renderer = await renderWeek({ timetable: [lessonB8, lessonA1, lessonB1] });
  try {
    const order = lessonCards(renderer).map((c: any) => flatText(c));
    const positions = ['Matematica', 'Latino', 'Greco'].map(s => order.findIndex(t => t.includes(s)));
    assert.ok(positions.every(i => i >= 0), 'tutte e tre le lezioni sono nella colonna del lunedì');
    // 1ª, 1ª, 8ª: le due della 1ª precedono quella dell 8ª.
    assert.ok(positions[2] > positions[0] && positions[2] > positions[1], 'l 8ª resta in fondo');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

// ---------------------------------------------------------------------------
// 8-11. dayPeriods sulla scuola EFFETTIVA
// ---------------------------------------------------------------------------

for (const [viewName, render] of BOTH_VIEWS) {
  test(`F4/8. ${viewName}: B/Lun/8 con A a 6 ore -> NON fuori configurazione`, async () => {
    const renderer = await render({ timetable: [lessonB8] });
    try {
      assert.match(flatText(renderer.root), /Greco/, 'la lezione è mostrata');
      assert.equal(marks(renderer).length, 0, 'l 8ª ora è prevista da B: nessuna marcatura');
      assert.equal(flatText(renderer.root).includes(OUT_OF_CONFIG_SLOT_BADGE), false);
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });

  test(`F4/9. ${viewName}: B/Lun/9 -> fuori configurazione anche per B`, async () => {
    const renderer = await render({ timetable: [lessonB9] });
    try {
      assert.match(flatText(renderer.root), /Filosofia/, 'visibile: la marcatura informa, non filtra');
      const marked = marks(renderer);
      assert.equal(marked.length, 1);
      assert.equal(marked[0].props.title, OUT_OF_CONFIG_SLOT_TITLE);
      assert.match(flatText(renderer.root), new RegExp(OUT_OF_CONFIG_SLOT_BADGE));
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });

  test(`F4/10. ${viewName}: legacy A/7 con A a 6 ore -> marcata rispetto ad A`, async () => {
    const renderer = await render({ timetable: [lessonLegacy7] });
    try {
      assert.equal(isMarked(renderer, 'Storia'), true, 'la 7ª non è prevista dalla primaria');
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });

  test(`F4/11. ${viewName}: orfano /7 -> valutato sulla primaria`, async () => {
    const renderer = await render({ timetable: [lessonOrphan7] });
    try {
      assert.equal(isMarked(renderer, 'Geografia'), true, 'fallback primaria: 7 > 6');
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });

  test(`F4/8b. ${viewName}: la stessa ora è regolare per B e irregolare per A`, async () => {
    // La prova che la scuola usata è quella DELLA LEZIONE: stessa ora, stesso
    // giorno, due esiti diversi perché gli istituti sono diversi.
    const sameHourInA = lesson({ id: 'tt-a8', periodNumber: 8, startTime: '15:00', endTime: '16:00', subject: 'Arte', className: '1A', schoolId: PRIMARY_ID });
    const renderer = await render({ timetable: [lessonB8, sameHourInA] });
    try {
      assert.equal(isMarked(renderer, 'Greco'), false, '8ª in B: regolare');
      assert.equal(isMarked(renderer, 'Arte'), true, '8ª in A: fuori configurazione');
      assert.equal(marks(renderer).length, 1, 'una sola marcatura, quella giusta');
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });
}

// ---------------------------------------------------------------------------
// 12-14. UX
// ---------------------------------------------------------------------------

test('F4/12. Oggi: il plesso resta un dato distinto dal badge istituto', async () => {
  // Stesso nome di plesso in due istituti diversi: il campus non è identità.
  const aWithCampus = lesson({ id: 'tt-a-c', subject: 'Matematica', schoolId: PRIMARY_ID, campus: 'Sede Centrale' });
  const bWithCampus = lesson({ id: 'tt-b-c', subject: 'Latino', schoolId: SCHOOL_B_ID, campus: 'Sede Centrale' });
  const renderer = await renderToday({ timetable: [aWithCampus, bWithCampus] });
  try {
    const text = flatText(renderer.root);
    assert.ok(text.includes('Sede Centrale'), 'il plesso continua a essere mostrato');
    assert.deepEqual(badgeNames(renderer).sort(), ['IC Rossi', 'Liceo Verdi'], 'e l istituto è un badge a parte');
    // Il badge NON contiene il plesso e viceversa.
    for (const badge of schoolBadges(renderer)) {
      assert.equal(flatText(badge).includes('Sede Centrale'), false, 'il badge istituto non è il plesso');
    }
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

for (const [viewName, render] of BOTH_VIEWS) {
  test(`F4/13. ${viewName}: il tap apre ancora la lezione giusta per id`, async () => {
    const opened: TimetableSlot[] = [];
    const renderer = await render({
      timetable: [lessonA1, lessonB1],
      onOpenTimetableSlotForEdit: (slot: TimetableSlot) => { opened.push(slot); },
    });
    try {
      await act(async () => { cardFor(renderer, 'Latino')!.props.onClick(); });
      assert.equal(opened.length, 1);
      assert.equal(opened[0].id, 'tt-b1', 'apre la lezione di B, non quella di A');
      assert.equal(opened[0].schoolId, SCHOOL_B_ID, 'lo slot passato conserva il suo istituto');
    } finally {
      await act(async () => { renderer.unmount(); });
    }
  });

  test(`F4/14. ${viewName}: con un istituto solo nessuna complessità aggiunta`, async () => {
    const withBadge = await render({ timetable: [lessonA1] });
    const withoutBadge = await render({ profile: singleSchoolProfile, timetable: [lessonA1] });
    try {
      // Il badge è l'UNICA differenza fra i due alberi.
      assert.equal(schoolBadges(withBadge).length, 1);
      assert.equal(schoolBadges(withoutBadge).length, 0);
      assert.equal(lessonCards(withoutBadge).length, lessonCards(withBadge).length, 'stesse card');
      // Nessun filtro, nessun selettore, nessun raggruppamento in nessuno dei due.
      const controls = (r: any) => r.root.findAll((el: any) => el.type === 'select').length;
      assert.equal(controls(withoutBadge), controls(withBadge), 'nessun controllo nuovo');
    } finally {
      await act(async () => { withBadge.unmount(); });
      await act(async () => { withoutBadge.unmount(); });
    }
  });
}
