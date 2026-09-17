import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEOMETRY_ERRORS,
  TimetableGeometryError,
  derivePeriodColumns,
  isValidPeriodsPerDay,
  normalizeTimetableGeometry,
  physicalColumnIndex,
  physicalColumnNumber,
  subjectColumnCropPixels,
  subjectColumnCropSpec,
  toPixelRect,
  totalPeriodColumns,
} from '../src/utils/timetableCrops';
import { PERSONAL_SCHOOL_DAYS } from '../src/utils/timetableAnalysis';

/**
 * Geometria della griglia e specifiche di crop: funzioni PURE, testate senza DOM.
 *
 * Questi test NON dimostrano che un modello vision individui correttamente la
 * geometria della foto reale: verificano solo l'aritmetica e i rifiuti. La
 * verifica sulla foto reale spetta alla preview diagnostica del modale.
 */

/** Geometria sintetica coerente: tabella, MATERIA a sinistra, griglia a destra. */
const GEOMETRY_RAW = {
  table: { x: 0.05, y: 0.1, width: 0.9, height: 0.8 },
  subjectColumn: { x: 0.08, width: 0.12 },
  scheduleGrid: { x: 0.25, width: 0.65 },
};

const geometry = (periodsPerDay = 5) => normalizeTimetableGeometry(GEOMETRY_RAW, periodsPerDay);

// ---------------------------------------------------------------------------
// 1-4. DERIVAZIONE DELLE COLONNE
// ---------------------------------------------------------------------------

test('colonne: 5 giorni x 5 periodi -> 25 colonne orarie', () => {
  assert.equal(totalPeriodColumns(5), 25);
  assert.equal(PERSONAL_SCHOOL_DAYS, 5, 'i giorni scolastici sono quelli dell app');
  const columns = derivePeriodColumns(geometry(5));
  assert.equal(columns.length, 25, 'una colonna per ogni giorno/ora');
  assert.deepEqual(columns.map(c => c.columnNumber), Array.from({ length: 25 }, (_, i) => i + 1), 'numerazione fisica 1..25');
  // Con 6 ore la griglia cambia forma: la derivazione segue periodsPerDay.
  assert.equal(derivePeriodColumns(geometry(6)).length, 30);
  assert.equal(totalPeriodColumns(6), 30);
});

test('colonne: lunedì 2ª -> numero fisico 2', () => {
  assert.equal(physicalColumnNumber(1, 2, 5), 2);
  assert.equal(physicalColumnIndex(1, 2, 5), 1, 'indice 0-based = numero - 1');
  const spec = subjectColumnCropSpec(geometry(5), 1, 2);
  assert.equal(spec.columnNumber, 2);
  assert.equal(spec.dayOfWeek, 1);
  assert.equal(spec.periodIndex, 2);
  // La x è la seconda colonna della griglia.
  const width = 0.65 / 25;
  assert.ok(Math.abs(spec.column.x - (0.25 + width)) < 1e-12, 'x della seconda colonna');
  assert.ok(Math.abs(spec.column.width - width) < 1e-12, 'larghezza = griglia / 25');
});

test('colonne: martedì 1ª -> numero fisico 6', () => {
  assert.equal(physicalColumnNumber(2, 1, 5), 6);
  assert.equal(physicalColumnIndex(2, 1, 5), 5);
  const spec = subjectColumnCropSpec(geometry(5), 2, 1);
  assert.equal(spec.columnNumber, 6);
  const width = 0.65 / 25;
  assert.ok(Math.abs(spec.column.x - (0.25 + 5 * width)) < 1e-12, 'il martedì inizia dopo le 5 colonne del lunedì');
});

test('colonne: venerdì 5ª -> numero fisico 25 (ultima colonna della griglia)', () => {
  assert.equal(physicalColumnNumber(5, 5, 5), 25);
  const spec = subjectColumnCropSpec(geometry(5), 5, 5);
  assert.equal(spec.columnNumber, 25);
  const end = spec.column.x + spec.column.width;
  assert.ok(Math.abs(end - (0.25 + 0.65)) < 1e-12, 'l ultima colonna chiude esattamente la griglia');
  // Con un numero di ore diverso la stessa coordinata cade altrove.
  assert.equal(physicalColumnNumber(5, 5, 6), 29);
});

// ---------------------------------------------------------------------------
// 5-6. COMPOSIZIONE MATERIA + COLONNA
// ---------------------------------------------------------------------------

test('composizione: MATERIA e colonna target usano identici y e height', () => {
  for (const [day, period] of [[1, 2], [2, 1], [3, 4], [5, 5]] as const) {
    const spec = subjectColumnCropSpec(geometry(5), day, period);
    assert.equal(spec.sourceY, GEOMETRY_RAW.table.y, `giorno ${day} ora ${period}: stessa origine verticale`);
    assert.equal(spec.sourceHeight, GEOMETRY_RAW.table.height, `giorno ${day} ora ${period}: stessa altezza`);
    const pixels = subjectColumnCropPixels(spec, 1000, 800);
    assert.equal(pixels.subject.y, pixels.column.y, 'stessa y in pixel: le righe restano allineate');
    assert.equal(pixels.subject.height, pixels.column.height, 'stessa altezza in pixel');
    assert.equal(pixels.subject.y, 80);
    assert.equal(pixels.subject.height, 640);
  }
});

test('composizione: il crop target non include le colonne adiacenti', () => {
  const g = geometry(5);
  const columns = derivePeriodColumns(g);
  const target = columns[physicalColumnIndex(1, 2, 5)]; // lunedì 2ª
  const before = columns[0]; // lunedì 1ª
  const after = columns[2];  // lunedì 3ª
  // La fascia del target non contiene né l inizio né la fine dei vicini.
  const targetStart = target.span.x;
  const targetEnd = target.span.x + target.span.width;
  assert.ok(before.span.x < targetStart, 'la colonna precedente sta a sinistra');
  assert.ok(before.span.x + before.span.width <= targetStart + 1e-12, 'nessuna sovrapposizione col vicino sinistro');
  assert.ok(after.span.x >= targetEnd - 1e-12, 'nessuna sovrapposizione col vicino destro');
  assert.ok(after.span.x > targetEnd - 1e-12, 'la colonna successiva sta a destra');
  // La larghezza è esattamente UNA colonna, non due.
  assert.ok(Math.abs(target.span.width - 0.65 / 25) < 1e-12, 'una sola colonna di larghezza');

  // In pixel: i tre rettangoli sono disgiunti.
  const spec = subjectColumnCropSpec(g, 1, 2);
  const pixels = subjectColumnCropPixels(spec, 1000, 800);
  const neighbour = toPixelRect(after.span, spec.sourceY, spec.sourceHeight, 1000, 800);
  assert.ok(pixels.column.x + pixels.column.width <= neighbour.x, 'il crop si ferma prima della colonna successiva');
  assert.ok(pixels.subject.x + pixels.subject.width < pixels.column.x, 'MATERIA sta a sinistra della colonna target');
  // La colonna MATERIA non è la griglia: nessuna sovrapposizione fra le due fasce.
  assert.ok(pixels.subject.x + pixels.subject.width <= 250, 'MATERIA resta fuori dalla griglia (che parte a 250)');
});

// ---------------------------------------------------------------------------
// 7-9. RIFIUTI: NESSUNA COORDINATA INVENTATA
// ---------------------------------------------------------------------------

test('geometria fuori bounds -> rifiutata, nessun fallback', () => {
  const bad = [
    { ...GEOMETRY_RAW, table: { x: -0.1, y: 0.1, width: 0.9, height: 0.8 } },          // x negativa
    { ...GEOMETRY_RAW, table: { x: 0.5, y: 0.1, width: 0.9, height: 0.8 } },           // esce a destra
    { ...GEOMETRY_RAW, table: { x: 0.05, y: 0.5, width: 0.9, height: 0.8 } },          // esce in basso
    { ...GEOMETRY_RAW, subjectColumn: { x: 0.0, width: 0.12 } },                       // fuori da table
    { ...GEOMETRY_RAW, subjectColumn: { x: 0.5, width: 0.6 } },                        // fuori da table
    { ...GEOMETRY_RAW, scheduleGrid: { x: 0.25, width: 0.9 } },                        // esce da table
    { ...GEOMETRY_RAW, subjectColumn: { x: 0.20, width: 0.20 } },                      // sovrapposta alla griglia
    { ...GEOMETRY_RAW, subjectColumn: { x: 0.25, width: 0.12 } },                      // tocca la griglia
  ];
  for (const payload of bad) {
    assert.throws(
      () => normalizeTimetableGeometry(payload, 5),
      TimetableGeometryError,
      `rifiutata: ${JSON.stringify(payload)}`,
    );
  }
  // Il motivo è distinto e stabile: overlap non è un generico "fuori bounds".
  assert.throws(
    () => normalizeTimetableGeometry({ ...GEOMETRY_RAW, subjectColumn: { x: 0.25, width: 0.12 } }, 5),
    (error: unknown) => error instanceof TimetableGeometryError && error.code === GEOMETRY_ERRORS.overlap,
    'sovrapposizione MATERIA/griglia riconosciuta come tale',
  );
  assert.throws(
    () => normalizeTimetableGeometry({ ...GEOMETRY_RAW, table: { x: -0.1, y: 0.1, width: 0.9, height: 0.8 } }, 5),
    (error: unknown) => error instanceof TimetableGeometryError && error.code === GEOMETRY_ERRORS.bounds,
    'valori fuori intervallo riconosciuti come tali',
  );
});

test('geometria: width/height e campi mancanti o non numerici -> rifiutati', () => {
  const bad = [
    { ...GEOMETRY_RAW, table: { x: 0.05, y: 0.1, width: 0, height: 0.8 } },            // larghezza nulla
    { ...GEOMETRY_RAW, table: { x: 0.05, y: 0.1, width: 0.9, height: 0 } },            // altezza nulla
    { ...GEOMETRY_RAW, table: { x: 0.05, y: 0.1, width: -0.9, height: 0.8 } },         // negativa
    { ...GEOMETRY_RAW, subjectColumn: { x: 0.08, width: 0 } },                         // MATERIA larga zero
    { ...GEOMETRY_RAW, scheduleGrid: { x: 0.25, width: -0.65 } },                      // griglia negativa
    { ...GEOMETRY_RAW, table: { x: 0.05, y: 0.1, width: NaN, height: 0.8 } },          // non finito
    { ...GEOMETRY_RAW, table: { x: 0.05, y: 0.1, width: Infinity, height: 0.8 } },     // non finito
    { ...GEOMETRY_RAW, subjectColumn: { x: '0.08', width: 0.12 } },                    // stringa
    { ...GEOMETRY_RAW, scheduleGrid: { x: 0.25 } },                                    // campo mancante
    { ...GEOMETRY_RAW, table: { x: 0.05, y: 0.1, height: 0.8 } },                      // campo mancante
    { table: GEOMETRY_RAW.table, subjectColumn: GEOMETRY_RAW.subjectColumn },          // scheduleGrid assente
    { subjectColumn: GEOMETRY_RAW.subjectColumn, scheduleGrid: GEOMETRY_RAW.scheduleGrid }, // table assente
    null,
    undefined,
    'geometria',
    [],
  ];
  for (const payload of bad) {
    assert.throws(
      () => normalizeTimetableGeometry(payload, 5),
      TimetableGeometryError,
      `rifiutata: ${JSON.stringify(payload)}`,
    );
  }
});

test('geometria: periodsPerDay non valido -> rifiutato', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, '5', null, undefined, 13, 100, {}]) {
    assert.equal(isValidPeriodsPerDay(value), false, `${String(value)} non è un numero di ore valido`);
    assert.throws(() => normalizeTimetableGeometry(GEOMETRY_RAW, value), TimetableGeometryError, `rifiutato: ${String(value)}`);
  }
  for (const value of [1, 5, 12]) {
    assert.equal(isValidPeriodsPerDay(value), true, `${value} è valido`);
    assert.equal(normalizeTimetableGeometry(GEOMETRY_RAW, value).periodsPerDay, value);
  }
  // Il motivo del rifiuto è dedicato, non confuso con la forma della geometria.
  assert.throws(
    () => normalizeTimetableGeometry(GEOMETRY_RAW, 0),
    (error: unknown) => error instanceof TimetableGeometryError && error.code === GEOMETRY_ERRORS.periodsPerDay,
  );
});

// ---------------------------------------------------------------------------
// COORDINATE E PIXEL
// ---------------------------------------------------------------------------

test('coordinate fuori dalla griglia dichiarata -> rifiutate, nessun crop vuoto', () => {
  const g = geometry(5);
  for (const [day, period] of [[0, 1], [6, 1], [1, 0], [1, 6], [1.5, 1], [1, 1.5], [-1, 2]] as const) {
    assert.throws(() => subjectColumnCropSpec(g, day, period), TimetableGeometryError, `rifiutata: ${day}/${period}`);
  }
  // Con 4 ore al giorno la 5ª ora non esiste.
  assert.throws(() => subjectColumnCropSpec(geometry(4), 1, 5), TimetableGeometryError);
  assert.equal(subjectColumnCropSpec(geometry(4), 1, 4).columnNumber, 4);
});

test('normalizzato -> pixel: arrotondamento e rifiuto dei crop fuori immagine', () => {
  const spec = subjectColumnCropSpec(geometry(5), 1, 2);
  const pixels = subjectColumnCropPixels(spec, 1000, 800);
  assert.deepEqual(pixels.subject, { x: 80, y: 80, width: 120, height: 640 });
  assert.deepEqual(pixels.column, { x: 276, y: 80, width: 26, height: 640 });

  // Un rettangolo che uscirebbe dalla foto è un errore, non un ritaglio parziale.
  assert.throws(
    () => toPixelRect({ x: 0.99, width: 0.05 }, 0, 1, 1000, 800),
    (error: unknown) => error instanceof TimetableGeometryError && error.code === GEOMETRY_ERRORS.pixels,
    'crop oltre il bordo destro',
  );
  assert.throws(
    () => toPixelRect({ x: 0, width: 0.5 }, 0.9, 0.5, 1000, 800),
    TimetableGeometryError,
    'crop oltre il bordo inferiore',
  );
  assert.throws(() => toPixelRect({ x: 0, width: 0.0004 }, 0, 1, 1000, 800), TimetableGeometryError, 'crop di larghezza nulla in pixel');
  for (const [w, h] of [[0, 800], [1000, 0], [-1, 800], [NaN, 800]] as const) {
    assert.throws(() => toPixelRect({ x: 0, width: 0.5 }, 0, 1, w, h), TimetableGeometryError, `dimensioni immagine invalide ${w}x${h}`);
  }
});

test('nessuna persistenza: le specifiche sono solo numeri, nessun contenuto del documento', () => {
  const spec = subjectColumnCropSpec(geometry(5), 1, 2);
  // La specifica è dati puri: serializzabile, senza blob, url o testo del documento.
  const json = JSON.stringify(spec);
  assert.deepEqual(JSON.parse(json), spec);
  assert.ok(!/data:|blob:|base64/i.test(json), 'nessun dato immagine nella specifica');
  assert.deepEqual(Object.keys(spec).sort(), ['column', 'columnNumber', 'dayOfWeek', 'periodIndex', 'sourceHeight', 'sourceY', 'subject']);
  // I messaggi di errore sono stringhe fisse nostre: nessun numero del payload.
  const error = (() => { try { normalizeTimetableGeometry({ ...GEOMETRY_RAW, scheduleGrid: { x: 0.25, width: 5 } }, 5); return null; } catch (e) { return e as TimetableGeometryError; } })();
  assert.ok(error instanceof TimetableGeometryError);
  assert.ok(!error.message.includes('0.25') && !error.message.includes('5'), 'il messaggio non riporta i valori ricevuti');
});
