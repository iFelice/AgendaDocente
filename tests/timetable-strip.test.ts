import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server';
import { groqJsonSchemaFrom, GROQ_VISION_MODEL_DEFAULT } from '../server/groqAnalysis';
import {
  STRIP_REQUEST_KEYS,
  buildTimetableStripPrompt,
  describeStripFailure,
  buildTimetableStripUserText,
  parseTimetableStripResponse,
  stripRejectionMessage,
  stripSuccessLog,
  timetableStripSchema,
  validateTimetableStripPayload,
} from '../server/timetableStrip';
import {
  MAX_STRIP_MATCHES,
  TimetableStripShapeError,
  classifyStripMatches,
  describeStripOutcome,
  stripOutcomeMessage,
} from '../src/utils/timetableStrip';

/**
 * STRIP curricolare: `[MATERIA] | [UNA COLONNA ORARIA]`, UNA sola coordinata.
 *
 * Questi test NON dimostrano che un modello vision legga correttamente la
 * fotografia reale: verificano il contratto (schema, evidenza della cella,
 * esiti), che al provider arrivi SOLO la strip, l'assenza di persistenza e la
 * privacy dei log. Nessuna asserzione dipende dall'accuratezza visiva.
 *
 * Le classi usate qui sono sintetiche.
 */

const TARGET_CLASS = '3D';

/** PNG fittizio: la firma binaria è reale (i guard la verificano), il resto no. */
const pngBase64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('strip-sintetica-non-reale'),
]).toString('base64');

/** Secondo PNG fittizio, diverso dal primo: serve a distinguere strip e originale. */
const otherPngBase64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('foto-originale-sintetica-non-reale'),
]).toString('base64');

const STRIP_TEXT = JSON.stringify({ matches: [{ cellText: '3D', subject: 'Matematica' }] });

const TEST_GEMINI_KEY = 'test-gemini-key-placeholder';
const TEST_GROQ_KEY = 'test-groq-key-placeholder';
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const GROQ_HOST = 'api.groq.com';

// ---------------------------------------------------------------------------
// 1. Schema strict
// ---------------------------------------------------------------------------

test('schema strip: strict, due soli campi, nessun dato di contesto', () => {
  assert.deepEqual(Object.keys(timetableStripSchema.properties), ['matches'], 'solo matches');
  assert.deepEqual([...timetableStripSchema.required], ['matches']);
  const item = timetableStripSchema.properties.matches.items;
  assert.deepEqual(Object.keys(item.properties).sort(), ['cellText', 'subject']);
  assert.deepEqual([...item.required].sort(), ['cellText', 'subject']);
  assert.equal(item.properties.cellText.type, 'STRING');
  assert.equal(item.properties.subject.type, 'STRING');
  // Giorno, periodo e classe NON sono nel payload: la coordinata è già isolata
  // dal crop, quindi il modello non può rispondere su un'altra colonna.
  const flat = JSON.stringify(timetableStripSchema);
  for (const absent of ['dayOfWeek', 'periodIndex', 'classLabel', 'rowLabel']) {
    assert.ok(!flat.includes(absent), `lo schema non chiede ${absent}`);
  }

  // Lo Structured Output di Groq è derivato dallo stesso schema, in strict.
  const converted = groqJsonSchemaFrom(timetableStripSchema) as Record<string, any>;
  assert.equal(converted.type, 'object');
  assert.equal(converted.additionalProperties, false, 'strict: nessun campo extra');
  assert.deepEqual([...converted.required], ['matches']);
  const convertedItem = converted.properties.matches.items;
  assert.equal(convertedItem.additionalProperties, false);
  assert.deepEqual([...convertedItem.required].sort(), ['cellText', 'subject']);
  assert.equal(converted.properties.matches.type, 'array');
});

// ---------------------------------------------------------------------------
// 2-8. Evidenza della cella ed esiti
// ---------------------------------------------------------------------------

test('strip: cellText="3D" accettato, esito unique', () => {
  const result = classifyStripMatches(TARGET_CLASS, [{ cellText: '3D', subject: 'Matematica' }]);
  assert.equal(result.outcome, 'unique');
  assert.deepEqual(result.subjects, ['Matematica']);
  assert.equal(result.acceptedMatches, 1);
  assert.equal(result.rejectedMatches, 0);
});

test('strip: cellText="3D 3E" accettato per target 3D (cella condivisa)', () => {
  const result = classifyStripMatches(TARGET_CLASS, [{ cellText: '3D 3E', subject: 'Italiano' }]);
  assert.equal(result.outcome, 'unique');
  assert.deepEqual(result.subjects, ['Italiano']);
  assert.equal(result.acceptedMatches, 1);
});

test('strip: cellText="3E" scartato (altra classe, nessuna prova)', () => {
  const result = classifyStripMatches(TARGET_CLASS, [{ cellText: '3E', subject: 'Italiano' }]);
  assert.equal(result.outcome, 'none', 'nessuna materia senza la cella che la giustifica');
  assert.deepEqual(result.subjects, []);
  assert.equal(result.acceptedMatches, 0);
  assert.equal(result.rejectedMatches, 1);
});

test('strip: cella vuota scartata, cella assente o malformata rifiutata', () => {
  const empty = classifyStripMatches(TARGET_CLASS, [{ cellText: '', subject: 'Matematica' }]);
  assert.equal(empty.outcome, 'none', 'una cella vuota non è prova');
  assert.equal(empty.rejectedMatches, 1);
  for (const bad of [
    { subject: 'Matematica' },                       // cellText mancante
    { cellText: 42, subject: 'Matematica' },         // cellText non stringa
    { cellText: '3D' },                              // subject mancante
    { cellText: '3D', subject: '   ' },              // subject vuoto
  ]) {
    assert.throws(
      () => classifyStripMatches(TARGET_CLASS, [bad]),
      TimetableStripShapeError,
      `fuori contratto: ${JSON.stringify(bad)}`,
    );
  }
  // Tetto strutturale: troppe celle dichiarate è una risposta fuori contratto.
  const tooMany = Array.from({ length: MAX_STRIP_MATCHES + 1 }, (_, i) => ({ cellText: '3D', subject: `M${i}` }));
  assert.throws(() => classifyStripMatches(TARGET_CLASS, tooMany), TimetableStripShapeError);
  assert.throws(() => classifyStripMatches(TARGET_CLASS, 'non-un-array'), TimetableStripShapeError);
});

test('strip: zero match -> none, un match -> unique', () => {
  const none = classifyStripMatches(TARGET_CLASS, []);
  assert.equal(none.outcome, 'none');
  assert.deepEqual(none.subjects, []);
  assert.equal(stripOutcomeMessage(TARGET_CLASS, none), '3D non presente nella colonna richiesta');

  const unique = classifyStripMatches(TARGET_CLASS, [{ cellText: '3D', subject: 'Scienze' }]);
  assert.equal(unique.outcome, 'unique');
  assert.equal(stripOutcomeMessage(TARGET_CLASS, unique), '3D → Scienze');
});

test('strip: due match validi -> ambiguous, con le due materie', () => {
  const ambiguous = classifyStripMatches(TARGET_CLASS, [
    { cellText: '3D', subject: 'Matematica' },
    { cellText: '3D', subject: 'Italiano' },
  ]);
  assert.equal(ambiguous.outcome, 'ambiguous');
  assert.deepEqual(ambiguous.subjects, ['Matematica', 'Italiano']);
  assert.equal(stripOutcomeMessage(TARGET_CLASS, ambiguous), '3D → Matematica, Italiano');

  // Due righe che riportano la STESSA materia non sono un'ambiguità.
  const sameSubjectTwice = classifyStripMatches(TARGET_CLASS, [
    { cellText: '3D', subject: 'Matematica' },
    { cellText: '3D 3E', subject: 'matematica' },
  ]);
  assert.equal(sameSubjectTwice.outcome, 'unique');
  assert.deepEqual(sameSubjectTwice.subjects, ['Matematica']);

  // Dicitura generica ("Materie", "Generale"): non è una disciplina.
  for (const genericSubject of ['Materie', 'Generale', 'Tutte le materie']) {
    const generic = classifyStripMatches(TARGET_CLASS, [{ cellText: '3D', subject: genericSubject }]);
    assert.equal(generic.outcome, 'none', `dicitura generica scartata: ${genericSubject}`);
  }
});

// ---------------------------------------------------------------------------
// Prompt e validazione della richiesta
// ---------------------------------------------------------------------------

test('prompt strip: minimale, vincolante, senza profilo docente', () => {
  const prompt = buildTimetableStripPrompt(TARGET_CLASS);
  assert.match(prompt, /La prima colonna contiene la MATERIA\./);
  assert.match(prompt, /Cerca ESCLUSIVAMENTE la classe richiesta: 3D\./);
  assert.match(prompt, /subject: la materia della STESSA RIGA nella colonna sinistra/);
  assert.match(prompt, /restituisci matches: \[\]/);
  assert.match(prompt, /un match per ciascuna riga/);
  for (const forbidden of ['NON cercare altre classi.', 'NON inferire una materia.', 'NON usare conoscenze esterne.', 'NON compensare celle vuote.', 'NON spostarti alla riga sopra o sotto.']) {
    assert.ok(prompt.includes(forbidden), `il prompt vieta: ${forbidden}`);
  }
  assert.ok(!/profile|fullName|school|docente/i.test(prompt), 'nessun dato del docente nel prompt');
  assert.ok(!/profile|fullName|school/i.test(buildTimetableStripUserText(TARGET_CLASS)));
});

test('request strip: allow-list chiusa, classe normalizzata, un solo campo immagine', () => {
  assert.deepEqual(STRIP_REQUEST_KEYS, ['imageBase64', 'mimeType', 'classLabel']);
  const parsed = validateTimetableStripPayload({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: '3 d' });
  assert.equal(parsed.classLabel, '3D', 'la classe è normalizzata');
  assert.equal(parsed.imageBase64, pngBase64);
  // Un secondo campo immagine non è ammesso: il provider non può ricevere anche
  // la fotografia originale.
  assert.throws(
    () => validateTimetableStripPayload({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: '3D', originalImageBase64: otherPngBase64 }),
    /non valida/,
  );
  assert.throws(() => validateTimetableStripPayload({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: 'Matematica' }), /classe/);
  assert.throws(() => validateTimetableStripPayload({ imageBase64: pngBase64, mimeType: 'image/png' }), /classe/);
});

// ---------------------------------------------------------------------------
// Harness d'endpoint (nessuna chiamata reale: fetch sostituito)
// ---------------------------------------------------------------------------

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
const realFetch = globalThis.fetch;
const previousGeminiKey = process.env.GEMINI_API_KEY;
const previousGroqKey = process.env.GROQ_API_KEY;
/** Host chiamati e corpi inviati ai provider durante un test d'endpoint. */
let intercepted: string[] = [];
let providerBodies: string[] = [];
let logLines: string[] = [];

before(async () => {
  process.env.GEMINI_API_KEY = TEST_GEMINI_KEY;
  delete process.env.GROQ_API_KEY;
  server = app.listen(0, '127.0.0.1');
  // Il guard concede 10 richieste/min per IP: ogni connessione presenta un
  // indirizzo sorgente distinto (gancio solo sul server DI TEST).
  let sourceIndex = 0;
  server.on('connection', (socket) => {
    sourceIndex += 1;
    Object.defineProperty(socket, 'remoteAddress', { value: `10.0.${Math.floor(sourceIndex / 250)}.${(sourceIndex % 250) + 1}`, configurable: true });
  });
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = previousGeminiKey;
  if (previousGroqKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = previousGroqKey;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const geminiJsonResponse = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
});

function stubProviders(handlers: {
  gemini: () => { status: number; body: unknown };
  groq?: () => { status: number; body: unknown };
}) {
  intercepted = [];
  providerBodies = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith(baseUrl)) return realFetch(input, init);
    if (url.includes(GEMINI_HOST) || url.includes(GROQ_HOST)) {
      intercepted.push(url.includes(GEMINI_HOST) ? 'gemini' : 'groq');
      providerBodies.push(String(init?.body ?? ''));
      const outcome = url.includes(GEMINI_HOST)
        ? handlers.gemini()
        : handlers.groq?.() ?? { status: 503, body: {} };
      return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`chiamata di rete inattesa: ${url}`);
  }) as unknown as typeof fetch;
}

function captureLogs() {
  logLines = [];
  const warn = console.warn;
  const info = console.log;
  console.warn = (line: unknown) => { logLines.push(String(line)); };
  console.log = (line: unknown) => { logLines.push(String(line)); };
  return () => { console.warn = warn; console.log = info; };
}

async function postStrip(body: unknown) {
  return realFetch(`${baseUrl}/api/analyze-timetable-strip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 9. Al provider arriva SOLO la strip
// ---------------------------------------------------------------------------

test('strip: il provider riceve SOLO la strip, mai la foto originale', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({ gemini: () => ({ status: 200, body: geminiJsonResponse(STRIP_TEXT) }) });
  const restore = captureLogs();
  try {
    const res = await postStrip({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: TARGET_CLASS });
    assert.equal(res.status, 200);
    // UNA sola chiamata al provider, con UNA sola immagine: quella POSTata.
    assert.equal(intercepted.length, 1, 'una sola chiamata al provider');
    assert.equal(providerBodies.length, 1);
    const sent = JSON.parse(providerBodies[0]);
    const parts = sent.contents.flatMap((content: any) => content.parts ?? []);
    const inline = parts.filter((part: any) => part.inlineData);
    assert.equal(inline.length, 1, 'una sola immagine nella richiesta');
    assert.equal(inline[0].inlineData.data, pngBase64, 'l immagine inviata è la strip POSTata');
    assert.equal(inline[0].inlineData.mimeType, 'image/png');
    assert.equal(parts.filter((part: any) => part.text).length, 1, 'un solo testo utente');
    assert.equal(providerBodies[0].split(pngBase64).length - 1, 1, 'il base64 della strip compare una volta sola');
    assert.ok(!providerBodies[0].includes(otherPngBase64), 'la foto originale non viaggia');
  } finally {
    restore();
  }

  // Il client compone la strip e invia QUELLA: l'imageBase64 del file originale
  // non arriva mai alla funzione di analisi strip.
  const panel = withoutComments(readFileSync(join(process.cwd(), 'src', 'components', 'CropDiagnosticPanel.tsx'), 'utf8'));
  const call = panel.slice(panel.indexOf('analyzeTimetableStrip({'));
  assert.match(call.slice(0, 300), /imageBase64:\s*stripBase64,/, 'il client invia il base64 della strip');
  assert.match(call.slice(0, 300), /mimeType:\s*COMPOSED_CROP_MIME_TYPE,/, 'la strip è un PNG composto');
  assert.ok(panel.includes('stripBase64Ref.current = composed.base64;'), 'la strip inviata è quella composta dal crop');
  assert.ok(!/analyzeTimetableStrip\(\{[^}]*imageBase64,\s*\n?\s*mimeType,\s*\n?\s*periodsPerDay/.test(panel), 'mai il payload della foto originale');
});

/** Rimuove i commenti: le parole vietate possono stare nella documentazione. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------------------
// 10. Nessuna persistenza
// ---------------------------------------------------------------------------

test('strip: nessuna persistenza della strip né del risultato', async () => {
  const files = {
    panel: readFileSync(join(process.cwd(), 'src', 'components', 'CropDiagnosticPanel.tsx'), 'utf8'),
    cropper: readFileSync(join(process.cwd(), 'src', 'utils', 'imageCropper.ts'), 'utf8'),
    stripUtils: readFileSync(join(process.cwd(), 'src', 'utils', 'timetableStrip.ts'), 'utf8'),
    stripServer: readFileSync(join(process.cwd(), 'server', 'timetableStrip.ts'), 'utf8'),
    service: readFileSync(join(process.cwd(), 'src', 'services', 'scanService.ts'), 'utf8'),
  };
  for (const [name, raw] of Object.entries(files)) {
    // I commenti descrivono cosa NON accade: vanno tolti prima del controllo.
    const source = withoutComments(raw);
    assert.ok(!/services\/storage/.test(source), `${name}: nessuna importazione dello storage`);
    assert.ok(!/localStorage|sessionStorage|IndexedDB|dexie|firestore|firebase/i.test(source), `${name}: nessun accesso a storage o DB`);
  }
  // La strip resta effimera: object URL revocato e base64 azzerato.
  const panel = withoutComments(files.panel);
  assert.match(panel, /revokePreviewUrl\(objectUrlRef\.current\)/, 'object URL revocato');
  assert.equal((panel.match(/stripBase64Ref\.current = null;/g) ?? []).length, 2, 'base64 azzerato allo smontaggio e a ogni nuova esecuzione');
  assert.ok(!/toBlob\([^)]*\)[\s\S]{0,200}(download|createObjectURL[\s\S]{0,40}href)/.test(files.cropper), 'il cropper non scarica nulla');
  // Il risultato non alimenta alcun salvataggio: la UI mostra e basta.
  assert.ok(!/Ricostruisci|reconstruct|onConfirm|onSave|onImport/.test(panel), 'nessun salvataggio collegato alla strip');
});

// ---------------------------------------------------------------------------
// 11. Privacy dei log
// ---------------------------------------------------------------------------

test('strip: nessun contenuto sensibile nei log (classe, cella, materia, base64)', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({ gemini: () => ({ status: 200, body: geminiJsonResponse(STRIP_TEXT) }) });
  const restore = captureLogs();
  let body: any;
  try {
    const res = await postStrip({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: TARGET_CLASS });
    body = await res.json();
  } finally {
    restore();
  }
  assert.equal(body.outcome, 'unique');
  const logs = logLines.join('\n');
  assert.ok(logs.length > 0, 'l endpoint logga qualcosa');
  for (const secret of ['3D', 'Matematica', 'cellText', 'subject', 'matches', 'classLabel', pngBase64, 'data:image']) {
    assert.ok(!logs.includes(secret), `il log non contiene ${secret}`);
  }
  // Ciò che PUÒ uscire: provider, modello, esito, durata, numero di match.
  assert.match(logs, /provider=gemini esito=ok/);
  assert.match(logs, /esitoStrip=unique numeroMatch=1 scartati=0/);
  assert.match(logs, /durataMs=\d+/);
});

test('strip: la diagnosi di un rifiuto è privacy-safe', () => {
  let failure: unknown = null;
  try { parseTimetableStripResponse({ matches: [{ cellText: '3D' }] }, TARGET_CLASS); } catch (error) { failure = error; }
  const line = describeStripFailure(failure);
  assert.match(line, /fase=strip esito=fallito motivo=strip-forma-non-valida tipo=TimetableStripShapeError/);
  for (const secret of ['3D', 'Matematica', 'cellText', 'subject']) {
    assert.ok(!line.includes(secret), `il log non contiene ${secret}`);
  }
  assert.match(describeStripFailure(new TypeError('payload con 3D e Matematica')), /motivo=errore-interno/);
  assert.ok(!describeStripFailure(new TypeError('payload con 3D e Matematica')).includes('Matematica'));
  // Messaggio utente generico, senza dettagli tecnici.
  assert.match(stripRejectionMessage(), /colonna ritagliata/i);
  assert.ok(!stripRejectionMessage().includes('strip-'), 'nessun codice interno nel messaggio utente');
  // Log di successo: solo conteggi.
  const success = stripSuccessLog({ provider: 'groq', source: 'modello', durationMs: 12, classification: classifyStripMatches(TARGET_CLASS, [{ cellText: '3D', subject: 'Matematica' }]) });
  assert.match(success, /provider=groq modello=modello esito=ok durataMs=12 esitoStrip=unique numeroMatch=1 scartati=0/);
  assert.ok(!success.includes('Matematica'));
  assert.match(describeStripOutcome(classifyStripMatches(TARGET_CLASS, [{ cellText: '3E', subject: 'Italiano' }])), /esitoStrip=none numeroMatch=0 scartati=1/);
});

// ---------------------------------------------------------------------------
// 12-13. Provider e fallback
// ---------------------------------------------------------------------------

test('strip: Gemini transitorio -> Groq risponde con lo stesso schema', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'Model is currently experiencing high demand' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: STRIP_TEXT }, finish_reason: 'stop' }] } }),
  });
  const restore = captureLogs();
  try {
    const res = await postStrip({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: TARGET_CLASS });
    assert.equal(res.status, 200, 'il fallback salva l analisi');
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.source, GROQ_VISION_MODEL_DEFAULT, 'la risposta dichiara il provider di fallback');
    assert.equal(data.outcome, 'unique', 'il JSON di Groq passa nello stesso validator');
    assert.deepEqual(data.subjects, ['Matematica']);
    assert.ok(intercepted.filter((h) => h === 'gemini').length >= 2, 'Gemini ha esaurito i suoi tentativi');
    assert.equal(intercepted.filter((h) => h === 'groq').length, 1, 'un solo tentativo Groq');
    // Anche Groq riceve SOLO la strip.
    const groqBody = JSON.parse(providerBodies[providerBodies.length - 1]);
    const images = groqBody.messages[1].content.filter((part: any) => part.type === 'image_url');
    assert.equal(images.length, 1, 'una sola immagine anche per Groq');
    assert.equal(images[0].image_url.url, `data:image/png;base64,${pngBase64}`);
    // Lo schema strict viaggia identico.
    assert.equal(groqBody.response_format.json_schema.strict, true);
    assert.deepEqual(Object.keys(groqBody.response_format.json_schema.schema.properties.matches.items.properties).sort(), ['cellText', 'subject']);
    const logs = logLines.join('\n');
    assert.match(logs, /fallback=groq motivo=sovraccarico/);
    assert.ok(!logs.includes('Matematica') && !logs.includes(pngBase64), 'nessun contenuto nei log del fallback');
  } finally {
    restore();
  }
});

test('strip: Gemini a buon fine -> Groq NON viene chiamato', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({ gemini: () => ({ status: 200, body: geminiJsonResponse(STRIP_TEXT) }) });
  const restore = captureLogs();
  try {
    const res = await postStrip({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: TARGET_CLASS });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.outcome, 'unique');
    assert.deepEqual(intercepted.filter((host) => host === 'groq'), [], 'nessuna chiamata a Groq');
    assert.ok(intercepted.includes('gemini'), 'Gemini è stato chiamato');
    const logs = logLines.join('\n');
    assert.match(logs, /provider=gemini esito=ok/);
    assert.doesNotMatch(logs, /fallback=groq/, 'nessun log di fallback');
  } finally {
    restore();
  }
});

test('strip: risposta fuori contratto -> 422, nessun esito inventato', async () => {
  delete process.env.GROQ_API_KEY;
  stubProviders({ gemini: () => ({ status: 200, body: geminiJsonResponse(JSON.stringify({ matches: [{ cellText: '3D' }] })) }) });
  const restore = captureLogs();
  try {
    const res = await postStrip({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: TARGET_CLASS });
    assert.equal(res.status, 422, 'una materia senza cella è un rifiuto, non un none');
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.outcome, undefined, 'nessun esito inventato');
    const logs = logLines.join('\n');
    assert.match(logs, /motivo=strip-forma-non-valida/);
    assert.ok(!logs.includes('3D'), 'la classe cercata non finisce nel log');
  } finally {
    restore();
  }
});
