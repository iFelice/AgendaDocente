import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareDeclaredClassTotals,
  MAX_DECLARED_CLASS_TOTALS,
  TIMETABLE_CLASS_TOTALS_MISMATCH,
  TimetableShapeError,
  validateDeclaredClassTotals,
  validatePersonalSequencePayload,
  type DeclaredClassTotal,
  type TimetableRawCell,
} from '../src/utils/timetableAnalysis';
import {
  buildPersonalTimetablePrompt,
  isTimetableClassTotalsMismatch,
  personalTimetableSchema,
  timetableRejectionMessage,
} from '../server/timetableAnalysis';

const declared: DeclaredClassTotal[] = [
  { classLabel: '3D', hours: 10 },
  { classLabel: '3E', hours: 6 },
  { classLabel: '1C', hours: 2 },
];

const cells = (values: string[]): TimetableRawCell[] => values.map((raw, index) => ({
  rowIndex: 0,
  dayOfWeek: Math.floor(index / 7) + 1,
  periodIndex: (index % 7) + 1,
  raw,
}));

const counts = (d: number, e: number, c: number, extra: string[] = []) => cells([
  ...Array.from({ length: d }, () => '3D'),
  ...Array.from({ length: e }, () => '3E'),
  ...Array.from({ length: c }, () => '1C'),
  ...extra,
]);

test('H4: riepilogo 10/6/2 e celle 10/6/2 sono consistent', () => {
  assert.deepEqual(compareDeclaredClassTotals(declared, counts(10, 6, 2)), {
    status: 'consistent', declaredClassCount: 3, readClassCount: 3,
  });
});

test('H4 caso reale: declared 10/6/2 e celle 11/6/2 sono inconsistent', () => {
  assert.equal(compareDeclaredClassTotals(declared, counts(11, 6, 2)).status, 'inconsistent');
});

test('H4 confronta la distribuzione per classe, non il solo totale complessivo', () => {
  assert.equal(compareDeclaredClassTotals(declared, counts(9, 7, 2)).status, 'inconsistent');
});

test('H4 riepilogo assente o vuoto è not-available e non blocca', () => {
  assert.equal(compareDeclaredClassTotals([], counts(11, 6, 2)).status, 'not-available');
  const week = [1, 1, 1, 1, 1];
  const base = { rowLabel: 'Manganiello', days: week.map(() => ({ cells: ['3D'] })) };
  assert.equal(validatePersonalSequencePayload(base, 'Felice Manganiello', week).cells.length, 5, 'campo assente accettato');
  assert.equal(validatePersonalSequencePayload({ ...base, declaredClassTotals: [] }, 'Felice Manganiello', week).cells.length, 5, 'array vuoto accettato');
});

test('H4 rifiuta classi mancanti o aggiunte anche quando le altre coincidono', () => {
  assert.equal(compareDeclaredClassTotals(declared, counts(10, 6, 0)).status, 'inconsistent', 'classe dichiarata assente nelle celle');
  assert.equal(compareDeclaredClassTotals(declared, counts(10, 6, 2, ['2A'])).status, 'inconsistent', 'classe letta non dichiarata');
});

test('H4 una cella "3D 3E" conta entrambe; sos, D, P, Co e testo non contano', () => {
  const result = compareDeclaredClassTotals(
    [{ classLabel: '3D', hours: 1 }, { classLabel: '3E', hours: 1 }],
    cells(['3D 3E', 'sos', 'D', 'P', 'Co', '', 'Matematica']),
  );
  assert.deepEqual(result, { status: 'consistent', declaredClassCount: 2, readClassCount: 2 });
});

test('validator del riepilogo normalizza senza fuzzy e rifiuta duplicate e valori non rigorosi', () => {
  assert.deepEqual(validateDeclaredClassTotals([{ classLabel: '3 d', hours: 10 }], 31), [{ classLabel: '3D', hours: 10 }]);
  for (const invalid of [
    null,
    '3D10',
    [{ classLabel: '3D', hours: 0 }],
    [{ classLabel: '3D', hours: 32 }],
    [{ classLabel: '3D', hours: 1.5 }],
    [{ classLabel: 'Mangianello', hours: 1 }],
    [{ classLabel: '3D', hours: 1, confidence: 1 }],
    [{ classLabel: '3D', hours: 1 }, { classLabel: '3 D', hours: 2 }],
    Array.from({ length: MAX_DECLARED_CLASS_TOTALS + 1 }, () => ({ classLabel: '3D', hours: 1 })),
  ]) {
    assert.throws(() => validateDeclaredClassTotals(invalid, 31), TimetableShapeError);
  }
});

test('H4 integrata: il campo separato incongruente produce il codice stabile, senza autocorrezione', () => {
  const week = [6, 6, 6, 7, 6];
  const flat = [...counts(11, 6, 2).map(cell => cell.raw), ...Array.from({ length: 12 }, () => '')];
  const days = week.map(periods => ({ cells: flat.splice(0, periods) }));
  const payload = { rowLabel: 'Manganiello', declaredClassTotals: declared, days };
  assert.throws(
    () => validatePersonalSequencePayload(payload, 'Felice Manganiello', week),
    (error: unknown) => {
      assert.ok(error instanceof TimetableShapeError);
      assert.equal(error.code, TIMETABLE_CLASS_TOTALS_MISMATCH);
      assert.equal(isTimetableClassTotalsMismatch(error), true);
      assert.match(timetableRejectionMessage(error), /non coincide|Riprova|manualmente/i);
      return true;
    },
  );
  assert.equal(payload.days.flatMap(day => day.cells).filter(value => value === '3D').length, 11, 'nessuna cella viene rimossa o corretta');
});

test('H4 non trasforma un errore geometrico in totals mismatch', () => {
  const week = [6, 6, 6, 7, 6];
  const days = week.map((periods, day) => ({ cells: Array.from({ length: day === 3 ? periods - 1 : periods }, () => '3D') }));
  assert.throws(
    () => validatePersonalSequencePayload({ rowLabel: 'Manganiello', declaredClassTotals: [{ classLabel: '3D', hours: 1 }], days }, 'Felice Manganiello', week),
    (error: unknown) => error instanceof TimetableShapeError && error.code !== TIMETABLE_CLASS_TOTALS_MISMATCH,
  );
});

test('prompt e schema impongono una fonte separata dalla griglia e array vuoto se illeggibile', () => {
  const prompt = buildPersonalTimetablePrompt('manganiello felice', [6, 6, 6, 7, 6]);
  assert.match(prompt, /fonte SEPARATA dalla griglia/);
  assert.match(prompt, /NON calcolare, NON dedurre e NON ricostruire MAI "declaredClassTotals" dalle celle/);
  assert.match(prompt, /non esiste, è vuota o non è leggibile/);
  assert.ok((personalTimetableSchema.required as string[]).includes('declaredClassTotals'));
  assert.deepEqual(Object.keys((personalTimetableSchema.properties as any).declaredClassTotals.items.properties), ['classLabel', 'hours']);
});
