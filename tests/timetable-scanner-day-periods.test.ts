import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionReconstructedSlots,
  reconstructedToTimetableSlots,
  rejectionReasonLabel,
  applyReconstruction,
  slotsInReplacementScope,
} from '../src/utils/reconstructTimetable';
import type { ReconstructedSlot } from '../src/utils/timetableCrossref';
import type { TeacherProfile, TimeSlotConfig, TimetableSlot } from '../src/types';

/*
 * VALIDAZIONE DEI PERIODI NELL'IMPORT DA SCANNER (micro-passo D1).
 *
 * Lo scanner era l'ultima porta da cui una lezione poteva entrare in archivio
 * senza passare dal modale del TimetableEditor: nessun controllo su dayPeriods
 * e, soprattutto, orari SINTETIZZATI dal ramo generativo di
 * periodTimesForIndex quando il periodo non aveva una fascia reale.
 *
 * Regola imposta qui: si importa solo cio che e riferito a un periodo
 * realmente configurato E ammesso da quel giorno. Tutto il resto viene
 * escluso con un motivo, senza inventare nulla e senza bloccare le altre ore.
 */

const profile: TeacherProfile = {
  id: 't-1', fullName: 'Felice Manganiello', schoolName: 'IC Da Vinci',
  schoolLevel: 'ssig', schoolYear: '2026/2027', primarySubjects: ['Sostegno'],
  classes: ['3D', '3E'], campuses: ['Sede Centrale'], roles: [{ role: 'docente_sostegno' }],
  isSupportTeacher: true,
};

/** Stesso docente, scuola con 6 ore ordinarie e 7 il giovedi. */
const profileThursday7: TeacherProfile = {
  ...profile,
  schools: [{
    id: 's1', name: 'IC Da Vinci', isPrimary: true, active: true,
    dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
  }],
};

/** Primaria a 6/7, secondaria molto piu lunga: D1 deve seguire la primaria. */
const profileTwoSchools: TeacherProfile = {
  ...profile,
  schools: [
    {
      id: 's1', name: 'IC Da Vinci', isPrimary: true, active: true,
      dayPeriods: { ordinaryPeriodsPerDay: 6, extraPeriodsByDay: { 4: 1 } },
    },
    {
      id: 's2', name: 'IC Secondario', isPrimary: false, active: true,
      dayPeriods: { ordinaryPeriodsPerDay: 10 },
    },
  ],
};

const uniformSlots = (count: number, start = 8) =>
  Array.from({ length: count }, (_, i) => ({
    periodNumber: i + 1,
    label: `${i + 1}ª Ora`,
    startTime: `${String(start + i).padStart(2, '0')}:00`,
    endTime: `${String(start + i + 1).padStart(2, '0')}:00`,
  }));

const config6: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60,
  customSlots: uniformSlots(6),
};

const config7: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 7, standardDurationMinutes: 60,
  customSlots: uniformSlots(7),
};

/**
 * Scansione CUSTOM irregolare: ore da 55 minuti, intervalli di lunghezza
 * diversa, 6ª che finisce alle 13:55. Una progressione automatica da 60 minuti
 * produrrebbe orari completamente diversi: e il caso in cui il ramo generativo
 * di periodTimesForIndex si notava di piu.
 */
const customConfig6: TimeSlotConfig = {
  firstHourStartTime: '08:00', periodsPerDay: 6, standardDurationMinutes: 60,
  customSlots: [
    { periodNumber: 1, label: '1ª Ora', startTime: '08:00', endTime: '08:55' },
    { periodNumber: 2, label: '2ª Ora', startTime: '08:55', endTime: '09:50' },
    { periodNumber: 3, label: '3ª Ora', startTime: '10:10', endTime: '11:05' },
    { periodNumber: 4, label: '4ª Ora', startTime: '11:05', endTime: '12:00' },
    { periodNumber: 5, label: '5ª Ora', startTime: '12:15', endTime: '13:00' },
    { periodNumber: 6, label: '6ª Ora', startTime: '13:00', endTime: '13:55' },
  ],
};

let seq = 0;
function item(dayOfWeek: number, periodIndex: number, classLabel = '3D'): ReconstructedSlot & { correctedClass?: string } {
  seq += 1;
  return {
    id: `r-${seq}`,
    dayOfWeek,
    periodIndex,
    classLabel,
    coTeachingSubjects: [],
    status: 'ok' as ReconstructedSlot['status'],
    confidence: 'high',
    selected: true,
  };
}

// ---------------------------------------------------------------------------
// Fascia reale
// ---------------------------------------------------------------------------

test('periodi 1..6 con 6 fasce: import invariato', () => {
  const items = [1, 2, 3, 4, 5, 6].map(p => item(1, p));
  const { slots, rejected } = partitionReconstructedSlots(items, { profile, timeSlotConfig: config6 });

  assert.equal(rejected.length, 0);
  assert.equal(slots.length, 6);
  assert.deepEqual(slots.map(s => s.periodNumber), [1, 2, 3, 4, 5, 6]);
  // Orari presi dalle fasce reali, uno per uno.
  for (const slot of slots) {
    const real = uniformSlots(6)[slot.periodNumber - 1];
    assert.equal(slot.startTime, real.startTime);
    assert.equal(slot.endTime, real.endTime);
  }
});

test('periodo 7 senza 7ª fascia: escluso, nessuno slot creato', () => {
  // Giovedi ammette 7 ore, ma la fascia non esiste: il limite giornaliero non basta.
  const { slots, rejected } = partitionReconstructedSlots(
    [item(4, 7)],
    { profile: profileThursday7, timeSlotConfig: config6 }
  );

  assert.equal(slots.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'missing-period-slot');
  assert.equal(rejectionReasonLabel(rejected[0].reason), 'Fascia oraria non configurata');
});

test('nessun orario sintetizzato: gli orari esistono tutti fra le fasce configurate', () => {
  const items = [item(1, 1), item(4, 7), item(2, 6)];
  const { slots } = partitionReconstructedSlots(items, { profile: profileThursday7, timeSlotConfig: config6 });

  const realTimes = new Set(uniformSlots(6).map(p => `${p.startTime}-${p.endTime}`));
  for (const slot of slots) {
    assert.ok(
      realTimes.has(`${slot.startTime}-${slot.endTime}`),
      `orario ${slot.startTime}-${slot.endTime} non appartiene alle fasce configurate`
    );
  }
  // In particolare, l'orario che la vecchia generazione avrebbe inventato (14:00-15:00).
  assert.equal(slots.some(s => s.startTime === '14:00'), false);
});

// ---------------------------------------------------------------------------
// dayPeriods
// ---------------------------------------------------------------------------

test('Lunedi ammette 6 e il documento porta Lun/7: escluso per giorno', () => {
  // La 7ª fascia ESISTE: a escluderlo e solo dayPeriods.
  const { slots, rejected } = partitionReconstructedSlots(
    [item(1, 7)],
    { profile: profileThursday7, timeSlotConfig: config7 }
  );

  assert.equal(slots.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'day-not-allowed');
  assert.equal(rejectionReasonLabel(rejected[0].reason), 'Ora non prevista per questo giorno');
});

test('Giovedi ammette 7 e la 7ª fascia esiste: importato', () => {
  const { slots, rejected } = partitionReconstructedSlots(
    [item(4, 7)],
    { profile: profileThursday7, timeSlotConfig: config7 }
  );

  assert.equal(rejected.length, 0);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].dayOfWeek, 4);
  assert.equal(slots[0].periodNumber, 7);
  assert.equal(slots[0].startTime, '14:00');
  assert.equal(slots[0].endTime, '15:00');
});

test('Giovedi ammette 7 ma la fascia 7 manca: escluso per fascia, non per giorno', () => {
  const { rejected } = partitionReconstructedSlots(
    [item(4, 7)],
    { profile: profileThursday7, timeSlotConfig: config6 }
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'missing-period-slot', 'il motivo deve distinguere i due casi');
});

test('dayPeriods assente: periodi entro le fasce importati come prima (non-regressione)', () => {
  const items = [1, 2, 3, 4, 5, 6].map(p => item(3, p));
  const { slots, rejected } = partitionReconstructedSlots(items, { profile, timeSlotConfig: config6 });

  assert.equal(rejected.length, 0, 'nessuna esclusione senza dayPeriods');
  assert.equal(slots.length, 6);
});

test('dayPeriods assente e config assente: il default a 6 fasce resta importabile', () => {
  const items = [1, 2, 3, 4, 5, 6].map(p => item(2, p));
  const { slots, rejected } = partitionReconstructedSlots(items, { profile, timeSlotConfig: undefined });
  assert.equal(rejected.length, 0);
  assert.equal(slots.length, 6);
});

test('dayPeriods assente: un periodo 7 senza fascia NON viene piu inventato', () => {
  // Unica differenza voluta rispetto al comportamento storico.
  const { slots, rejected } = partitionReconstructedSlots(
    [item(2, 7)],
    { profile, timeSlotConfig: config6 }
  );
  assert.equal(slots.length, 0);
  assert.equal(rejected.length, 1);
});

// ---------------------------------------------------------------------------
// CUSTOM: il caso critico
// ---------------------------------------------------------------------------

test('scansione CUSTOM irregolare + periodo extra: nessun orario inventato', () => {
  const items = [item(1, 6), item(4, 7)];
  const { slots, rejected } = partitionReconstructedSlots(
    items,
    { profile: profileThursday7, timeSlotConfig: customConfig6 }
  );

  // La 6ª entra con i SUOI orari reali e irregolari.
  assert.equal(slots.length, 1);
  assert.equal(slots[0].periodNumber, 6);
  assert.equal(slots[0].startTime, '13:00');
  assert.equal(slots[0].endTime, '13:55');

  // La 7ª non esiste: esclusa, non sintetizzata.
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'missing-period-slot');
  assert.equal(rejectionReasonLabel(rejected[0].reason), 'Fascia oraria non configurata');

  // Nessuno slot con l'orario che la progressione automatica da 60' avrebbe prodotto.
  assert.equal(slots.some(s => s.startTime === '14:00' && s.endTime === '15:00'), false);
  assert.equal(slots.some(s => s.startTime === '13:55'), false);
});

// ---------------------------------------------------------------------------
// Import parziale
// ---------------------------------------------------------------------------

test('import parziale: gli elementi validi passano anche se altri sono esclusi', () => {
  const items = [
    item(1, 1, '3D'),   // valido
    item(1, 7, '3E'),   // lunedi non ammette la 7ª
    item(4, 7, '3D'),   // giovedi ammette la 7ª e la fascia esiste -> valido
    item(2, 3, '3E'),   // valido
  ];
  const { slots, rejected } = partitionReconstructedSlots(
    items,
    { profile: profileThursday7, timeSlotConfig: config7 }
  );

  assert.equal(slots.length, 3, 'le ore valide restano importabili');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].item.classLabel, '3E');
  assert.equal(rejected[0].reason, 'day-not-allowed');
});

test('gli esclusi conservano l\'elemento originale, per poterlo spiegare in anteprima', () => {
  const source = item(1, 7, '3E');
  const { rejected } = partitionReconstructedSlots([source], { profile: profileThursday7, timeSlotConfig: config7 });
  assert.equal(rejected[0].item.id, source.id);
  assert.equal(rejected[0].item.dayOfWeek, 1);
  assert.equal(rejected[0].item.periodIndex, 7);
});

test('deselezionati e senza classe restano fuori SENZA diventare esclusi', () => {
  const deselected = { ...item(1, 7), selected: false };
  const noClass = { ...item(1, 7), classLabel: '  ' };
  const { slots, rejected } = partitionReconstructedSlots(
    [deselected, noClass],
    { profile: profileThursday7, timeSlotConfig: config7 }
  );
  assert.equal(slots.length, 0);
  assert.equal(rejected.length, 0, 'non sono esclusioni da spiegare: sono scelte dell\'utente');
});

test('reconstructedToTimetableSlots resta compatibile: solo gli slot validi', () => {
  const items = [item(1, 1), item(1, 7)];
  const slots = reconstructedToTimetableSlots(items, { profile: profileThursday7, timeSlotConfig: config7 });
  assert.equal(Array.isArray(slots), true);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].periodNumber, 1);
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const existingSlot = (id: string, dayOfWeek: number, periodNumber: number): TimetableSlot => ({
  id, dayOfWeek: dayOfWeek as TimetableSlot['dayOfWeek'], periodNumber,
  startTime: '08:00', endTime: '09:00',
  subject: 'Sostegno', className: '3D', schoolId: 's1',
});

test('missing-only: gli elementi esclusi non entrano nel merge', () => {
  const existing = [existingSlot('old-1', 1, 1)];
  const { slots: incoming } = partitionReconstructedSlots(
    [item(1, 1), item(1, 7), item(2, 2)],
    { profile: profileThursday7, timeSlotConfig: config7 }
  );

  const result = applyReconstruction(existing, incoming, 'missing-only', { profile: profileThursday7 });

  // Lun/1 esiste gia -> non toccato; Mar/2 aggiunto; Lun/7 escluso a monte.
  assert.equal(result.addedCount, 1);
  assert.equal(result.slots.length, 2);
  assert.equal(result.slots.some(s => s.periodNumber === 7), false, 'nessuno slot alla 7ª');
  assert.equal(result.removedCount, 0);
});

test('replace-scope: un elemento escluso non cancella lezioni valide esistenti', () => {
  const existing = [existingSlot('old-1', 1, 1), existingSlot('old-2', 2, 2)];
  const { slots: incoming } = partitionReconstructedSlots(
    [item(1, 1), item(1, 7), item(2, 2)],
    { profile: profileThursday7, timeSlotConfig: config7 }
  );

  const result = applyReconstruction(existing, incoming, 'replace-scope', { profile: profileThursday7 });

  // Le due coordinate esistenti sono entrambe coperte da slot in arrivo validi:
  // sostituite, non perse. L'escluso non aggiunge ne toglie nulla.
  assert.equal(result.replacedCount, 2);
  assert.equal(result.removedCount, 0);
  assert.equal(result.slots.length, 2);
  assert.equal(result.slots.some(s => s.id === 'old-1'), false, 'sostituito dal nuovo');
  assert.equal(result.slots.some(s => s.periodNumber === 7), false);
});

test('replace-scope con TUTTI gli elementi esclusi: nessuna cancellazione', () => {
  const existing = [existingSlot('old-1', 1, 1), existingSlot('old-2', 2, 2)];
  const { slots: incoming, rejected } = partitionReconstructedSlots(
    [item(1, 7), item(2, 7)],
    { profile: profileThursday7, timeSlotConfig: config7 }
  );
  assert.equal(rejected.length, 2);
  assert.equal(incoming.length, 0);

  // Ambito vuoto: slotsInReplacementScope non tocca nulla con incoming vuoto.
  assert.deepEqual(slotsInReplacementScope(existing, incoming, { profile: profileThursday7 }), []);
  const result = applyReconstruction(existing, incoming, 'replace-scope', { profile: profileThursday7 });
  assert.equal(result.slots.length, 2, 'le lezioni esistenti sopravvivono');
  assert.equal(result.removedCount, 0);
});

test('gli esclusi non entrano nel dedupe delle coordinate', () => {
  // Due elementi sulla stessa coordinata esclusa: nessuno dei due deve
  // comparire, e non devono influenzare il conteggio degli importati.
  const { slots } = partitionReconstructedSlots(
    [item(1, 7, '3D'), item(1, 7, '3E'), item(1, 2, '3D')],
    { profile: profileThursday7, timeSlotConfig: config7 }
  );
  assert.equal(slots.length, 1);
  assert.equal(slots[0].periodNumber, 2);
});

// ---------------------------------------------------------------------------
// Multi-istituto
// ---------------------------------------------------------------------------

test('D1 interpreta dayPeriods con la scuola PRIMARIA, come C1/C2', () => {
  // La secondaria ammetterebbe 10 ore il lunedi: non deve contare.
  const { slots, rejected } = partitionReconstructedSlots(
    [item(1, 7), item(4, 7)],
    { profile: profileTwoSchools, timeSlotConfig: config7 }
  );

  assert.equal(rejected.length, 1, 'Lun/7 escluso secondo la primaria');
  assert.equal(rejected[0].reason, 'day-not-allowed');
  assert.equal(slots.length, 1, 'Gio/7 ammesso dalla primaria');
  assert.equal(slots[0].dayOfWeek, 4);
});

test('lo schoolId di destinazione DECIDE la validazione (F5)', () => {
  // La secondaria ammette 10 ore il lunedì: destinando lì, Lun/7 è regolare.
  // Prima di F5 veniva rifiutata con le ore della primaria pur essendo salvata
  // con lo schoolId della secondaria: validata su una scuola, scritta in
  // un'altra.
  const toSecondary = partitionReconstructedSlots(
    [item(1, 7)],
    { profile: profileTwoSchools, timeSlotConfig: config7, schoolId: 's2' }
  );
  assert.equal(toSecondary.rejected.length, 0, 's2 ammette la 7ª del lunedì');
  assert.equal(toSecondary.slots.length, 1);
  assert.equal(toSecondary.slots[0].schoolId, 's2', 'validata e scritta sulla STESSA scuola');

  // Stessa ora destinata alla primaria (6 ore il lunedì): rifiutata.
  const toPrimary = partitionReconstructedSlots(
    [item(1, 7)],
    { profile: profileTwoSchools, timeSlotConfig: config7, schoolId: 's1' }
  );
  assert.equal(toPrimary.slots.length, 0);
  assert.equal(toPrimary.rejected[0].reason, 'day-not-allowed');
});

test('gli slot validi conservano lo schoolId di destinazione', () => {
  const { slots } = partitionReconstructedSlots(
    [item(4, 7)],
    { profile: profileTwoSchools, timeSlotConfig: config7, schoolId: 's2' }
  );
  assert.equal(slots.length, 1);
  assert.equal(slots[0].schoolId, 's2');
});
