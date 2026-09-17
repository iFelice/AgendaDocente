import express from 'express';
import { once } from 'node:events';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server';
import { createAnalysisErrorHandler } from '../server/analysisGuards';
import {
  buildTimetableGeometryPrompt,
  describeGeometryFailure,
  geometryRejectionMessage,
  parseTimetableGeometryResponse,
  timetableGeometrySchema,
  TIMETABLE_GEOMETRY_USER_TEXT,
  validateTimetableGeometryPayload,
} from '../server/timetableGeometry';
import { TimetableGeometryError } from '../src/utils/timetableCrops';
import { groqJsonSchemaFrom } from '../server/groqAnalysis';

/**
 * Chiamata di GEOMETRIA della griglia: prompt, schema, validazione, endpoint.
 *
 * Questi test NON dimostrano che un modello vision misuri correttamente la foto
 * reale: verificano il contratto (solo numeri), i rifiuti e la privacy.
 */

const pngBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).toString('base64');
const jpegBase64 = Buffer.from([255, 216, 255, 224, 0, 16]).toString('base64');

const VALID_GEOMETRY = {
  table: { x: 0.05, y: 0.1, width: 0.9, height: 0.8 },
  subjectColumn: { x: 0.08, width: 0.12 },
  scheduleGrid: { x: 0.25, width: 0.65 },
};

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
const previousKey = process.env.GEMINI_API_KEY;

before(async () => {
  delete process.env.GEMINI_API_KEY; // senza chiave: 503 generico, nessuna analisi
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (previousKey !== undefined) process.env.GEMINI_API_KEY = previousKey;
  await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

async function post(body: unknown) {
  return fetch(`${baseUrl}/api/analyze-timetable-geometry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Raccoglie ricorsivamente tutti i `type` dichiarati in uno schema. */
function collectTypes(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== 'object') return found;
  const value = node as Record<string, any>;
  if (typeof value.type === 'string') found.push(value.type);
  for (const key of ['properties', 'items']) {
    const child = value[key];
    if (child && typeof child === 'object') {
      for (const nested of Object.values(child)) collectTypes(nested, found);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// SCHEMA: SOLO NUMERI, NESSUN CANALE PER IL TESTO DEL DOCUMENTO
// ---------------------------------------------------------------------------

test('schema geometry: solo numeri, nessun campo testuale', () => {
  const types = collectTypes(timetableGeometrySchema);
  assert.ok(types.length > 0, 'lo schema dichiara dei tipi');
  for (const type of types) {
    assert.ok(['OBJECT', 'NUMBER'].includes(type), `tipo ammesso: ${type}`);
  }
  assert.ok(!types.includes('STRING'), 'nessuna stringa: il modello non può restituire testo del documento');
  assert.deepEqual(Object.keys(timetableGeometrySchema.properties).sort(), ['scheduleGrid', 'subjectColumn', 'table']);
  assert.deepEqual([...timetableGeometrySchema.required].sort(), ['scheduleGrid', 'subjectColumn', 'table']);
  // Ogni sotto-oggetto dichiara i propri campi obbligatori (necessario anche allo
  // Structured Output strict di Groq).
  assert.deepEqual([...timetableGeometrySchema.properties.table.required].sort(), ['height', 'width', 'x', 'y']);
  assert.deepEqual([...timetableGeometrySchema.properties.subjectColumn.required].sort(), ['width', 'x']);
  assert.deepEqual([...timetableGeometrySchema.properties.scheduleGrid.required].sort(), ['width', 'x']);
});

test('schema geometry: Gemini e Groq condividono lo stesso contratto', () => {
  const converted = groqJsonSchemaFrom(timetableGeometrySchema) as Record<string, any>;
  assert.equal(converted.type, 'object');
  assert.equal(converted.additionalProperties, false, 'strict: nessun campo extra');
  assert.deepEqual([...converted.required].sort(), ['scheduleGrid', 'subjectColumn', 'table']);
  assert.deepEqual(Object.keys(converted.properties.subjectColumn.properties).sort(), ['width', 'x']);
  assert.equal(converted.properties.subjectColumn.properties.x.type, 'number');
  assert.deepEqual([...converted.properties.table.required].sort(), ['height', 'width', 'x', 'y'], 'strict: ogni campo richiesto');
  assert.match(JSON.stringify(converted), /normalizzate|bordo|0 e 1/i, 'le description sopravvivono alla conversione');
});

// ---------------------------------------------------------------------------
// PROMPT
// ---------------------------------------------------------------------------

test('prompt geometry: chiede solo misure e dichiara le colonne derivate dal codice', () => {
  const prompt = buildTimetableGeometryPrompt(5);
  assert.match(prompt, /Restituisci SOLO numeri/);
  assert.match(prompt, /NON leggere il contenuto della tabella/, 'divieto esplicito di leggere il contenuto');
  for (const forbidden of ['classi, materie, nomi di docenti', 'testi di celle', 'alcuna stringa']) {
    assert.ok(prompt.includes(forbidden), `nomina ciò che è vietato restituire: ${forbidden}`);
  }
  // Lo schema non ha comunque alcun campo testuale: il divieto è anche strutturale.
  assert.ok(!prompt.includes('"matches"') && !prompt.includes('"subjects"'), 'nessun riferimento al contratto delle materie');
  // Il numero di ore è quello dichiarato dall'utente, e le colonne totali pure.
  assert.match(prompt, /ogni blocco contiene 5 colonne orarie/);
  assert.match(prompt, /in tutto 25 colonne orarie/);
  assert.match(prompt, /5 blocchi giornalieri/, 'i giorni scolastici dell app');
  // Le colonne NON sono chieste una per una: sono derivate dal codice.
  assert.ok(!prompt.includes('bounding box'), 'nessuna richiesta di box per colonna');
  // Il resto del contratto è nominato.
  for (const field of ['"table"', '"subjectColumn"', '"scheduleGrid"']) {
    assert.ok(prompt.includes(field), `campo nominato: ${field}`);
  }
  assert.match(prompt, /NON devono sovrapporsi/, 'il vincolo di non sovrapposizione è dichiarato');

  // Un numero di ore diverso cambia il prompt, senza toccare altro.
  const six = buildTimetableGeometryPrompt(6);
  assert.match(six, /ogni blocco contiene 6 colonne orarie/);
  assert.match(six, /in tutto 30 colonne orarie/);
  assert.ok(!six.includes('in tutto 25 colonne'), 'nessuna geometria residua');
  // Il testo utente non contiene dati del docente.
  assert.ok(TIMETABLE_GEOMETRY_USER_TEXT.length < 160);
  assert.ok(!/profile|fullName|school/i.test(TIMETABLE_GEOMETRY_USER_TEXT));
});

// ---------------------------------------------------------------------------
// VALIDAZIONE DELLA RISPOSTA (stesse regole del client)
// ---------------------------------------------------------------------------

test('parse geometry: geometria valida accettata, invalida rifiutata', () => {
  const geometry = parseTimetableGeometryResponse(VALID_GEOMETRY, 5);
  assert.equal(geometry.periodsPerDay, 5);
  assert.deepEqual(geometry.scheduleGrid, { x: 0.25, width: 0.65 });

  const bad = [
    { ...VALID_GEOMETRY, scheduleGrid: { x: 0.25, width: 5 } },        // fuori immagine
    { ...VALID_GEOMETRY, subjectColumn: { x: 0.25, width: 0.12 } },    // sovrapposta
    { ...VALID_GEOMETRY, table: { x: 0.05, y: 0.1, width: 0, height: 0.8 } },
    { ...VALID_GEOMETRY, subjectColumn: { x: 0.08, width: '0.12' } },  // non numerico
    { table: VALID_GEOMETRY.table },                                    // campi mancanti
    null,
    'geometria',
  ];
  for (const payload of bad) {
    assert.throws(() => parseTimetableGeometryResponse(payload, 5), TimetableGeometryError, `rifiutata: ${JSON.stringify(payload)}`);
  }
  assert.throws(() => parseTimetableGeometryResponse(VALID_GEOMETRY, 0), TimetableGeometryError, 'ore per giorno non valide');
});

test('diagnostica geometry: solo il codice dell errore, nessun numero del payload', () => {
  let failure: unknown = null;
  try { parseTimetableGeometryResponse({ ...VALID_GEOMETRY, scheduleGrid: { x: 0.25, width: 5 } }, 5); }
  catch (error) { failure = error; }
  const line = describeGeometryFailure(failure);
  assert.match(line, /fase=geometria esito=fallito/);
  assert.match(line, /motivo=geometry-valori-fuori-intervallo/);
  for (const secret of ['0.25', '0.65', 'scheduleGrid', 'subjectColumn', '0.08']) {
    assert.ok(!line.includes(secret), `il log non contiene ${secret}`);
  }
  // Un errore inatteso non fa trapelare il suo messaggio.
  assert.match(describeGeometryFailure(new TypeError('payload con 3D e Matematica')), /motivo=errore-interno/);
  assert.ok(!describeGeometryFailure(new TypeError('payload con 3D e Matematica')).includes('Matematica'));
  // Messaggio utente generico, senza dettagli tecnici.
  assert.match(geometryRejectionMessage(failure), /foto/i);
  assert.ok(!geometryRejectionMessage(failure).includes('geometry-'), 'nessun codice interno nel messaggio utente');
});

// ---------------------------------------------------------------------------
// RICHIESTA
// ---------------------------------------------------------------------------

test('request geometry: allow-list chiusa e ore per giorno obbligatorie', () => {
  const ok = validateTimetableGeometryPayload({ imageBase64: pngBase64, mimeType: 'image/png', periodsPerDay: 5 });
  assert.deepEqual(ok, { imageBase64: pngBase64, mimeType: 'image/png', periodsPerDay: 5 });

  for (const body of [
    { imageBase64: pngBase64, mimeType: 'image/png' },                                   // ore mancanti
    { imageBase64: pngBase64, mimeType: 'image/png', periodsPerDay: 0 },
    { imageBase64: pngBase64, mimeType: 'image/png', periodsPerDay: '5' },
    { imageBase64: pngBase64, mimeType: 'image/png', periodsPerDay: 13 },
    { mimeType: 'image/png', periodsPerDay: 5 },                                         // immagine mancante
    { imageBase64: pngBase64, mimeType: 'image/png', periodsPerDay: 5, profile: { id: 'x' } }, // chiave extra
    { imageBase64: pngBase64, mimeType: 'image/png', periodsPerDay: 5, coordinateScope: [] },  // chiave extra
    { imageBase64: 'non-base64!', mimeType: 'image/png', periodsPerDay: 5 },
    { imageBase64: jpegBase64, mimeType: 'image/png', periodsPerDay: 5 },                // firma incoerente
    null,
  ]) {
    assert.throws(() => validateTimetableGeometryPayload(body), /non valida|ore|foto|Formato/i, `rifiutata: ${JSON.stringify(body)}`);
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT
// ---------------------------------------------------------------------------

test('endpoint geometry: senza chiave AI -> 503 generico, no-store', async () => {
  const res = await post({ imageBase64: pngBase64, mimeType: 'image/png', periodsPerDay: 5 });
  assert.equal(res.status, 503);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const data = await res.json();
  assert.equal(data.success, false);
  assert.equal('geometry' in data, false, 'nessuna geometria in caso di fallimento');
  assert.doesNotMatch(JSON.stringify(data), /stack|Error:|PNG/i, 'nessun dettaglio tecnico né contenuto nel corpo');
});

test('endpoint geometry: richiesta incompleta o firma incoerente -> 400, nessuna chiamata AI', async () => {
  const missing = await post({ imageBase64: pngBase64, mimeType: 'image/png' });
  assert.equal(missing.status, 400);
  const wrongSignature = await post({ imageBase64: jpegBase64, mimeType: 'image/png', periodsPerDay: 5 });
  assert.equal(wrongSignature.status, 400);
  const unsupported = await post({ imageBase64: Buffer.from('%PDF-1.7').toString('base64'), mimeType: 'application/pdf', periodsPerDay: 5 });
  // Il PDF è un formato ammesso dall'infrastruttura condivisa: qui arriva al 503
  // (nessuna chiave), NON a un 400, perché la validazione immagine è quella esistente.
  assert.equal(unsupported.status, 503);
});

test('endpoint geometry: handler di errore dedicato, mai dettagli tecnici', async () => {
  // Lo stesso error handler degli altri endpoint di analisi, senza `items`.
  const probe = express();
  probe.post('/probe', (req, res) => { throw new Error('payload con 3D e Matematica'); });
  probe.use('/probe', createAnalysisErrorHandler(false));
  const local = probe.listen(0, '127.0.0.1');
  await once(local, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${(local.address() as { port: number }).port}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(!JSON.stringify(data).includes('Matematica'), 'nessun contenuto del documento nella risposta');
    assert.equal('items' in data, false);
  } finally {
    await new Promise<void>((resolve, reject) => local.close(e => (e ? reject(e) : resolve())));
  }
});
