import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server';
import {
  GROQ_MIN_ATTEMPT_MS,
  GROQ_VISION_MODEL_DEFAULT,
  groqAttemptTimeoutMs,
  groqFallbackDecision,
  groqJsonSchemaFrom,
} from '../server/groqAnalysis';
import { TIMETABLE_ANALYSIS_TIMEOUT_MS } from '../server/timetableAnalysis';
import { SCAN_REQUEST_TIMEOUT_MS } from '../src/services/scanService';
import {
  STRIP_REQUEST_KEYS,
  buildTimetableStripPrompt,
  describeStripFailure,
  buildTimetableStripUserText,
  parseTimetableStripResponse,
  stripRejectionMessage,
  stripSuccessLog,
  timetableStripSchema,
  TIMETABLE_STRIP_DEADLINE_MS,
  TIMETABLE_STRIP_GROQ_FALLBACK_TIMEOUT_MS,
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

// ---------------------------------------------------------------------------
// BUDGET DEDICATO DEL FALLBACK GROQ DELLA STRIP
// ---------------------------------------------------------------------------

/** Risposta di geometria valida (sintetica), per il test di non regressione. */
const GEOMETRY_TEXT = JSON.stringify({
  table: { x: 0.05, y: 0.1, width: 0.9, height: 0.8 },
  subjectColumn: { x: 0.08, width: 0.12 },
  scheduleGrid: { x: 0.25, width: 0.65 },
});

/**
 * Orologio virtuale: avanza SOLO quando lo decide il test.
 *
 * Serve a riprodurre in pochi millisecondi ciò che su Render richiede 42 secondi
 * reali: Gemini che consuma TUTTO il proprio budget prima di fallire. Senza di
 * esso il caso di regressione sarebbe impossibile da scrivere in modo
 * deterministico (o costerebbe 45 s di attesa per ogni esecuzione).
 */
function virtualClock() {
  const realNow = Date.now;
  let virtual = realNow();
  Date.now = () => virtual;
  return {
    advance: (ms: number) => { virtual += ms; },
    elapsed: () => virtual,
    startedAt: virtual,
    restore: () => { Date.now = realNow; },
  };
}

/** Quanto consuma ogni tentativo Gemini simulato (504 = deadline). */
const GEMINI_ATTEMPT_COST_MS = 21_000;

test('budget strip: il residuo di Gemini non basta, il budget dedicato sì', () => {
  // Numeri reali osservati su Render: durataMs=42095, categoria=deadline.
  const observedElapsedMs = 42_095;
  const residual = TIMETABLE_ANALYSIS_TIMEOUT_MS - observedElapsedMs;
  assert.equal(groqAttemptTimeoutMs(residual), 0, 'con il budget residuo il fallback non può partire');
  assert.equal(
    groqFallbackDecision({ geminiOk: false, geminiTransient: true, groqConfigured: true, mimeType: 'image/png', remainingBudgetMs: residual }).reason,
    'budget-esaurito',
    'è esattamente il motivo visto nei log di Render',
  );
  // Con il budget dedicato la stessa situazione cambia esito.
  const attempt = groqAttemptTimeoutMs(TIMETABLE_STRIP_GROQ_FALLBACK_TIMEOUT_MS);
  assert.ok(attempt >= GROQ_MIN_ATTEMPT_MS, `tentativo Groq utile: ${attempt} ms`);
  assert.equal(
    groqFallbackDecision({ geminiOk: false, geminiTransient: true, groqConfigured: true, mimeType: 'image/png', remainingBudgetMs: TIMETABLE_STRIP_GROQ_FALLBACK_TIMEOUT_MS }).proceed,
    true,
  );
  // Gemini non riceve più tempo: il suo budget è la costante di sempre.
  assert.equal(TIMETABLE_ANALYSIS_TIMEOUT_MS, 45_000, 'il budget di Gemini è invariato');
  assert.equal(TIMETABLE_STRIP_DEADLINE_MS, 45_000 + TIMETABLE_STRIP_GROQ_FALLBACK_TIMEOUT_MS);
  assert.ok(
    TIMETABLE_STRIP_GROQ_FALLBACK_TIMEOUT_MS >= 20_000 && TIMETABLE_STRIP_GROQ_FALLBACK_TIMEOUT_MS <= 25_000,
    'budget del fallback nella fascia richiesta (20-25 s)',
  );
});

test('REGRESSIONE: Gemini esaurisce TUTTO il budget -> Groq parte comunque e il validator è invariato', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  const clock = virtualClock();
  stubProviders({
    // 504 = categoria "deadline", la stessa dei log di Render. Ogni tentativo
    // consuma 21 s di orologio virtuale: due tentativi = 42 s, cioè praticamente
    // tutto TIMETABLE_ANALYSIS_TIMEOUT_MS.
    gemini: () => {
      clock.advance(GEMINI_ATTEMPT_COST_MS);
      return { status: 504, body: { error: { code: 504, message: 'Deadline exceeded' } } };
    },
    groq: () => ({ status: 200, body: { choices: [{ message: { content: STRIP_TEXT }, finish_reason: 'stop' }] } }),
  });
  const restoreLogs = captureLogs();
  try {
    const res = await postStrip({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: TARGET_CLASS });
    const elapsedMs = clock.elapsed() - clock.startedAt;
    // La premessa del caso: Gemini ha davvero consumato tutto il suo budget.
    assert.ok(elapsedMs >= 42_000, `budget Gemini consumato: ${elapsedMs} ms`);
    assert.equal(groqAttemptTimeoutMs(TIMETABLE_ANALYSIS_TIMEOUT_MS - elapsedMs), 0, 'il residuo non avrebbe permesso alcun tentativo');

    // PRIMA DEL FIX qui arrivava un 503 con "fallback=groq saltato
    // motivo=budget-esaurito": la strip non raggiungeva mai Groq.
    assert.equal(res.status, 200, 'la strip risponde nonostante il budget Gemini esaurito');
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.source, GROQ_VISION_MODEL_DEFAULT, 'la risposta arriva dal fallback');
    assert.equal(data.outcome, 'unique', 'stesso validator strip: esito invariato');
    assert.deepEqual(data.subjects, ['Matematica']);

    assert.equal(intercepted.filter((h) => h === 'groq').length, 1, 'una sola chiamata Groq');
    const logs = logLines.join('\n');
    assert.match(logs, /provider=gemini esito=fallito categoria=deadline/, 'Gemini ha fallito per deadline');
    assert.match(logs, /fallback=groq motivo=deadline mime=image\/png budgetMs=25000 budget=dedicato/, 'budget dedicato, non residuo');
    assert.match(logs, /esitoStrip=unique numeroMatch=1 scartati=0/);
    for (const secret of ['3D', 'Matematica', 'cellText', 'subject', pngBase64]) {
      assert.ok(!logs.includes(secret), `il log non contiene ${secret}`);
    }
  } finally {
    restoreLogs();
    clock.restore();
  }
});

test('strip: Gemini 503 rapido -> Groq chiamato con lo stesso prompt, schema e immagine', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'Model is currently experiencing high demand' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: STRIP_TEXT }, finish_reason: 'stop' }] } }),
  });
  const restore = captureLogs();
  try {
    const res = await postStrip({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: TARGET_CLASS });
    assert.equal(res.status, 200);
    assert.equal(intercepted.filter((h) => h === 'groq').length, 1, 'una sola chiamata Groq per richiesta');
    const body = JSON.parse(providerBodies[providerBodies.length - 1]);
    // Prompt IDENTICO a quello della strip, senza alcuna aggiunta.
    assert.equal(body.messages[0].content, buildTimetableStripPrompt(TARGET_CLASS));
    const parts = body.messages[1].content;
    assert.equal(parts.filter((p: any) => p.type === 'text')[0].text, buildTimetableStripUserText(TARGET_CLASS));
    const images = parts.filter((p: any) => p.type === 'image_url');
    assert.equal(images.length, 1, 'una sola immagine');
    assert.equal(images[0].image_url.url, `data:image/png;base64,${pngBase64}`, 'la strip, non la foto originale');
    // Schema IDENTICO a quello derivato dallo schema strip.
    assert.deepEqual(body.response_format.json_schema.schema, groqJsonSchemaFrom(timetableStripSchema));
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.temperature, 0);
    assert.match(logLines.join('\n'), /budget=dedicato/, 'anche sul percorso rapido il budget è dedicato');
  } finally {
    restore();
  }
});

test('strip: errore Gemini NON transitorio -> Groq non viene chiamato', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({ gemini: () => ({ status: 404, body: { error: { code: 404, message: 'models/xyz is not found' } } }) });
  const restore = captureLogs();
  try {
    const res = await postStrip({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: TARGET_CLASS });
    assert.equal(res.status, 503, 'risposta controllata');
    const data = await res.json();
    assert.equal(data.success, false);
    assert.deepEqual(intercepted.filter((h) => h === 'groq'), [], 'nessuna chiamata Groq su errore deterministico');
    assert.match(logLines.join('\n'), /fallback=groq saltato motivo=errore-non-transitorio/);
  } finally {
    restore();
  }
});

test('strip: GROQ_API_KEY assente -> nessun crash, risposta controllata', async () => {
  delete process.env.GROQ_API_KEY;
  stubProviders({ gemini: () => ({ status: 503, body: { error: { code: 503, message: 'Model is currently experiencing high demand' } } }) });
  const restore = captureLogs();
  try {
    const res = await postStrip({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: TARGET_CLASS });
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.outcome, undefined, 'nessun esito inventato');
    assert.deepEqual(intercepted.filter((h) => h === 'groq'), [], 'nessuna chiamata Groq senza chiave');
    assert.match(logLines.join('\n'), /fallback=groq saltato motivo=non-configurato/);
  } finally {
    restore();
  }
});

test('strip: fallback Groq in timeout -> 503 controllato, un solo tentativo, nessun retry', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'Model is currently experiencing high demand' } } }),
    // Un fetch che abortisce è esattamente ciò che produce il timeout del tentativo.
    groq: () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); },
  });
  const restore = captureLogs();
  try {
    const res = await postStrip({ imageBase64: pngBase64, mimeType: 'image/png', classLabel: TARGET_CLASS });
    assert.equal(res.status, 503, 'risposta controllata, nessun crash');
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.outcome, undefined);
    assert.equal(intercepted.filter((h) => h === 'groq').length, 1, 'un solo tentativo Groq: nessun retry del provider');
    const logs = logLines.join('\n');
    assert.match(logs, /provider=groq .*esito=fallito categoria=deadline/, 'il timeout del fallback è classificato');
    assert.equal((logs.match(/provider=groq/g) ?? []).length, 1, 'una sola riga di esito Groq');
    assert.ok(!logs.includes(pngBase64) && !logs.includes('Matematica'));
  } finally {
    restore();
  }
});

test('non regressione: geometry continua a usare il budget RESIDUO, non quello dedicato', async () => {
  process.env.GROQ_API_KEY = TEST_GROQ_KEY;
  stubProviders({
    gemini: () => ({ status: 503, body: { error: { code: 503, message: 'Model is currently experiencing high demand' } } }),
    groq: () => ({ status: 200, body: { choices: [{ message: { content: GEOMETRY_TEXT }, finish_reason: 'stop' }] } }),
  });
  const restore = captureLogs();
  try {
    const res = await realFetch(`${baseUrl}/api/analyze-timetable-geometry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: pngBase64, mimeType: 'image/png', periodsPerDay: 5 }),
    });
    assert.equal(res.status, 200);
    const logs = logLines.join('\n');
    assert.match(logs, /\[AI Geometria\] fallback=groq motivo=sovraccarico mime=image\/png budgetMs=\d+ budget=residuo/, 'geometry: budget residuo, come prima');
    assert.doesNotMatch(logs, /\[AI Geometria\].*budget=dedicato/, 'geometry non ha ricevuto il budget della strip');
  } finally {
    restore();
  }
});

test('budget: solo la strip passa un budget dedicato agli altri endpoint', async () => {
  const source = withoutComments(readFileSync(join(process.cwd(), 'server.ts'), 'utf8'));
  // Tre call site di fallback oltre alla strip: nessuno passa fallbackBudgetMs.
  const callSites = source.split('await runGroqTimetableFallback({').slice(1);
  assert.equal(callSites.length, 3, 'timetable, geometry e strip');
  const withDedicated = callSites.filter((chunk) => chunk.slice(0, 700).includes('fallbackBudgetMs'));
  assert.equal(withDedicated.length, 1, 'un solo endpoint usa il budget dedicato');
  assert.ok(withDedicated[0].slice(0, 700).includes('label: "AI Strip"'), 'ed è la strip');
  // Il deadline dedicato esiste solo nell'endpoint strip (una sola occorrenza nel
  // codice, oltre all'import).
  const usages = source.match(/setTimeout\(\(\) => controller\.abort\(\), TIMETABLE_STRIP_DEADLINE_MS\)/g) ?? [];
  assert.equal(usages.length, 1, 'un solo endpoint con il deadline dedicato');
  assert.equal(
    (source.match(/setTimeout\(\(\) => controller\.abort\(\), TIMETABLE_ANALYSIS_TIMEOUT_MS\)/g) ?? []).length,
    2,
    'orario e geometria hanno il deadline di sempre',
  );
  assert.match(source, /setTimeout\(\(\) => controller\.abort\(\), CIRCULAR_ANALYSIS_TIMEOUT_MS\)/, 'circular invariato');
  assert.match(source, /setTimeout\(\(\) => controller\.abort\(\), STUDENT_DOCUMENT_TIMEOUT_MS\)/, 'student invariato');
  // Il budget di Gemini nella strip è ancora la costante condivisa.
  const stripEndpoint = source.slice(source.indexOf('/api/analyze-timetable-strip'));
  assert.match(stripEndpoint, /budgetMs: TIMETABLE_ANALYSIS_TIMEOUT_MS,/, 'Gemini non riceve più tempo');
  assert.ok(!/TIMETABLE_ANALYSIS_TIMEOUT_MS\s*=/.test(source), 'la costante globale non è ridefinita');
});

test('client: il timeout della strip copre Gemini + Groq senza toccare gli altri endpoint', async () => {
  // Peggio caso server: tutto il budget Gemini più tutto il budget Groq.
  assert.ok(
    SCAN_REQUEST_TIMEOUT_MS > TIMETABLE_STRIP_DEADLINE_MS,
    `il client attende ${SCAN_REQUEST_TIMEOUT_MS} ms, il server al più ${TIMETABLE_STRIP_DEADLINE_MS} ms`,
  );
  assert.ok(SCAN_REQUEST_TIMEOUT_MS - TIMETABLE_STRIP_DEADLINE_MS >= 10_000, 'almeno 10 s di margine');
  // Non è stato introdotto un timeout client specifico: non serviva.
  const service = withoutComments(readFileSync(join(process.cwd(), 'src', 'services', 'scanService.ts'), 'utf8'));
  assert.ok(!/STRIP.*TIMEOUT_MS|TIMEOUT_MS.*STRIP/i.test(service), 'nessuna costante di timeout specifica della strip');
  // Una sola CHIAMATA del helper, con la costante condivisa: nessun override.
  assert.equal((service.match(/createScanTimeout\(SCAN_REQUEST_TIMEOUT_MS\)/g) ?? []).length, 1, 'un solo punto di timeout client, condiviso');
});
