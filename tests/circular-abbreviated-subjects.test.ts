import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { detectSubjects, detectSubjectSigle, evaluateItemRelevance } from '../src/utils/circularRelevance';
import { normalizeExtractedItems } from '../src/utils/circularParser';
import { app } from '../server';
import type { TeacherProfile } from '../src/types';
import { analysisAuthHeaders, installAnalysisAuthFixture } from './helpers/analysisAuthFixture';

installAnalysisAuthFixture();

process.env.TEST_RATE_LIMIT = 'relaxed';

/*
 * Caso reale (piano annuale delle attività, tabella DATA | DOCENTI | ATTIVITÀ | ORARI):
 *   14/12/2026 | SSIG ITA-L2-ARTE-IRC-SOS            | COLLOQUI | 15:00/18:15
 *   15/12/2026 | SSIG MAT-TEC- MUS-SM / STRUMENTO MUSICALE | COLLOQUI | 15:00/18:15 e 09.45/13.00
 *   02/12/2026 | PRIMARIA                             | COLLOQUI 1A-2A-3A-4A-5A | 17.00/20.15
 * Difetti osservati: (a) "SOS" non riconosciuto per un docente di sostegno;
 * (b) orari scritti con la barra o col punto non letti (coperti nei test sugli orari).
 */

const supportProfile: TeacherProfile = {
  id: 'support', fullName: 'Prof. Sostegno', schoolName: 'Test', schoolYear: '2026/2027',
  schoolLevel: 'ssig', isSupportTeacher: true, primarySubjects: ['Sostegno Didattico'],
  classes: ['3E', '3D', '1C'], campuses: [], roles: [],
};

const mathProfile: TeacherProfile = {
  id: 'math', fullName: 'Prof. Matematica', schoolName: 'Test', schoolYear: '2026/2027',
  schoolLevel: 'ssig', isSupportTeacher: false, primarySubjects: ['Matematica'],
  classes: ['3E', '3D', '1C'], campuses: [], roles: [],
};

const ROW_14_12 = '14/12/2026 | SSIG ITA-L2-ARTE-IRC-SOS | COLLOQUI | 15:00/18:15';
const ROW_15_12 = '15/12/2026 | SSIG MAT-TEC- MUS-SM / STRUMENTO MUSICALE | COLLOQUI | 15:00/18:15 e 09.45/13.00';
const ROW_02_12 = '02/12/2026 | PRIMARIA | COLLOQUI 1A-2A-3A-4A-5A | 17.00/20.15';

// ---------------------------------------------------------------------------
// Sigle delle materie: riconosciute SOLO in maiuscolo, isolate o in elenco
// ---------------------------------------------------------------------------

test('sigle maiuscole isolate o in elenco diventano materie (ITA-L2-ARTE-IRC-SOS, MAT-TEC- MUS-SM)', () => {
  assert.deepEqual(
    [...detectSubjects('SSIG ITA-L2-ARTE-IRC-SOS')].sort(),
    ['arte', 'francese', 'inglese', 'italiano', 'lingue straniere', 'religione', 'sostegno', 'spagnolo', 'tedesco'],
  );
  // Spazi irregolari attorno ai separatori: "MAT-TEC- MUS-SM" resta un elenco.
  assert.deepEqual(
    [...detectSubjects('MAT-TEC- MUS-SM')].sort(),
    ['matematica', 'musica', 'scienze motorie', 'tecnologia'],
  );
  assert.deepEqual(detectSubjects('STRUMENTO MUSICALE'), ['strumento musicale']);
  assert.deepEqual(detectSubjects('STRUM e IRC').sort(), ['religione', 'strumento musicale']);
});

test('sigle minuscole o dentro parole NON vengono riconosciute; "arte" resta valida come parola intera', () => {
  assert.deepEqual(detectSubjects('sos'), []);
  assert.deepEqual(detectSubjects('progetto sos'), []);
  assert.deepEqual(detectSubjects('La sospensione delle lezioni'), []);
  assert.deepEqual(detectSubjects('gita in italia'), []);
  assert.deepEqual(detectSubjects('ITALIA'), []);
  assert.deepEqual(detectSubjects('MUSICA e SCIENZE').sort(), ['musica', 'scienze']);
  // "arte" come parola intera resta riconosciuta, in qualsiasi casing.
  assert.deepEqual(detectSubjects('laboratorio di arte'), ['arte']);
  assert.deepEqual(detectSubjects('ARTE'), ['arte']);
});

test('detectSubjectSigle riporta sigla, etichetta e materie di espansione (L2 -> lingue straniere)', () => {
  const sigle = detectSubjectSigle('MAT-TEC- MUS-SM / STRUMENTO MUSICALE');
  assert.deepEqual(sigle.map(s => s.sigla), ['MAT', 'TEC', 'MUS', 'SM']);
  const l2 = detectSubjectSigle('SSIG ITA-L2')[1];
  assert.equal(l2.sigla, 'L2');
  assert.equal(l2.label, 'lingue straniere');
  assert.ok(l2.subjects.includes('inglese') && l2.subjects.includes('tedesco'));
  assert.equal(detectSubjectSigle('sospensione').length, 0);
  assert.equal(detectSubjectSigle('').length, 0);
});

test('la materia del docente prevale sul campo subject scritto a sigle', () => {
  // Il modello può riportare l'elenco di sigle della colonna DOCENTI in subject.
  const evaluation = evaluateItemRelevance({ title: 'Colloqui', subject: 'ITA-L2-ARTE-IRC-SOS' }, supportProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.match(evaluation.relevanceReason, /SOS \(sostegno\)/);
});

test('un docente di lingua è pertinente a una riga L2 (lingue straniere)', () => {
  const englishProfile: TeacherProfile = { ...mathProfile, primarySubjects: ['Inglese'] };
  const evaluation = evaluateItemRelevance({ title: 'Colloqui', rawSnippet: 'SSIG ITA-L2 | COLLOQUI' }, englishProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.match(evaluation.relevanceReason, /L2 \(lingue straniere\)/);
  const notRelevant = evaluateItemRelevance({ title: 'Colloqui', rawSnippet: 'SSIG MAT-SM | COLLOQUI' }, englishProfile);
  assert.equal(notRelevant.relevance, 'ROSSO');
});

// ---------------------------------------------------------------------------
// Le tre righe del caso reale: pertinenza per il profilo (orari nei test dedicati)
// ---------------------------------------------------------------------------

test('caso reale, profilo sostegno SSIG 3E/3D/1C: 14/12 pertinente, 15/12 altra materia, 02/12 altro ordine', () => {
  const r14 = evaluateItemRelevance({ title: 'COLLOQUI', rawSnippet: ROW_14_12 }, supportProfile);
  assert.equal(r14.relevance, 'VERDE');
  assert.equal(r14.selectedForImport, true);
  assert.match(r14.relevanceReason, /SOS \(sostegno\)/);
  assert.doesNotMatch(r14.relevanceReason, /altra materia/i);

  const r15 = evaluateItemRelevance({ title: 'COLLOQUI', notes: 'Altro intervallo: 09.45/13.00.', rawSnippet: ROW_15_12 }, supportProfile);
  assert.equal(r15.relevance, 'ROSSO');
  assert.equal(r15.selectedForImport, false);
  assert.match(r15.relevanceReason, /altra materia/i);
  assert.match(r15.relevanceReason, /MAT \(matematica\)/);
  assert.match(r15.relevanceReason, /SM \(scienze motorie\)/);

  const r02 = evaluateItemRelevance({ title: 'COLLOQUI 1A-2A-3A-4A-5A', rawSnippet: ROW_02_12 }, supportProfile);
  assert.equal(r02.relevance, 'ROSSO');
  assert.equal(r02.relevanceReason, 'Destinato a un altro ordine scolastico.');
});

test('caso reale, profilo matematica: 15/12 pertinente (MAT), 14/12 non pertinente', () => {
  const r15 = evaluateItemRelevance({ title: 'COLLOQUI', rawSnippet: ROW_15_12 }, mathProfile);
  assert.equal(r15.relevance, 'VERDE');
  assert.equal(r15.selectedForImport, true);
  assert.match(r15.relevanceReason, /MAT \(matematica\)/);

  const r14 = evaluateItemRelevance({ title: 'COLLOQUI', rawSnippet: ROW_14_12 }, mathProfile);
  assert.equal(r14.relevance, 'ROSSO');
  assert.equal(r14.selectedForImport, false);
  assert.match(r14.relevanceReason, /altra materia/i);
  assert.match(r14.relevanceReason, /ITA \(italiano\)/);
});

test('DOCENTI finita nel campo location del modello: ordine di scuola e materia restano letti', () => {
  // Il modello può smistare la colonna DOCENTI in location (unico campo testivo
  // fuori dall'evidenza): il riconoscimento la include senza per questo leggere
  // classi da un luogo ("Aula Magna" non genera classi né materie).
  const evaluation = evaluateItemRelevance({ title: 'Colloqui', location: 'SSIG ITA-SOS' }, supportProfile);
  assert.equal(evaluation.relevance, 'VERDE');
  assert.match(evaluation.relevanceReason, /SOS \(sostegno\)/);
  const primaria = evaluateItemRelevance({ title: 'Colloqui', location: 'PRIMARIA' }, supportProfile);
  assert.equal(primaria.relevance, 'ROSSO');
  assert.equal(primaria.relevanceReason, 'Destinato a un altro ordine scolastico.');
  const aula = evaluateItemRelevance({ title: 'Colloqui 3E', location: 'Aula Magna' }, supportProfile);
  assert.equal(aula.relevance, 'VERDE');
  assert.deepEqual(aula.detectedClasses, ['3E']);
});

// ---------------------------------------------------------------------------
// Orari scritti con la barra o col punto + recupero deterministico dal rawSnippet
// ---------------------------------------------------------------------------

test('orari "17.00/20.15", "15:00/18:15", "17.00 /20.15" diventano HH:MM-HH:MM', () => {
  const cases: [string, string, string][] = [
    ['17.00/20.15', '17:00', '20:15'],
    ['15:00/18:15', '15:00', '18:15'],
    ['17.00 /20.15', '17:00', '20:15'],
    ['09.30 - 12.00', '09:30', '12:00'],
    ['09.30- 12.00', '09:30', '12:00'],
  ];
  for (const [orari, start, end] of cases) {
    // Riga locale: il titolo è nello snippet e l'intervallo è unico.
    const [rowLocal] = normalizeExtractedItems([{
      title: 'COLLOQUI', date: '2026-12-14', startTime: '', endTime: '',
      rawSnippet: `14/12/2026 | SSIG ITA-SOS | COLLOQUI | ${orari}`,
    }], supportProfile);
    assert.deepEqual([rowLocal.startTime, rowLocal.endTime], [start, end], orari);
    // Recupero deterministico: il modello ha lasciato startTime vuoto e ha
    // parafrasato il titolo, ma nel rawSnippet c'è ESATTAMENTE un intervallo.
    const [paraphrased] = normalizeExtractedItems([{
      title: 'Colloqui generali dei docenti', date: '2026-12-14', startTime: '', endTime: '',
      rawSnippet: `SSIG ITA-SOS | COLLOQUI | ${orari}`,
    }], supportProfile);
    assert.deepEqual([paraphrased.startTime, paraphrased.endTime], [start, end], orari);
  }
});

test('recupero dal rawSnippet con un solo intervallo; nessun recupero con due intervalli', () => {
  // Un solo intervallo riconoscibile: startTime/endTime compilati da lì.
  const [single] = normalizeExtractedItems([{
    title: 'COLLOQUI', date: '2026-12-14', startTime: '', endTime: '',
    rawSnippet: '14/12/2026 | SSIG ITA-SOS | COLLOQUI | 15:00/18:15',
  }], supportProfile);
  assert.deepEqual([single.startTime, single.endTime], ['15:00', '18:15']);
  // Due intervalli e startTime vuoto: non si inventa nulla, resta senza orario.
  const [double] = normalizeExtractedItems([{
    title: 'COLLOQUI', date: '2026-12-15', startTime: '', endTime: '',
    rawSnippet: ROW_15_12,
  }], supportProfile);
  assert.equal(double.startTime, undefined);
  assert.equal(double.endTime, undefined);
  // Resta valida la regola esistente: fine non successiva all'inizio -> entrambi vuoti.
  const [reversed] = normalizeExtractedItems([{
    title: 'COLLOQUI', date: '2026-12-14', startTime: '', endTime: '',
    rawSnippet: '14/12/2026 | SSIG ITA-SOS | COLLOQUI | 20.15/17.00',
  }], supportProfile);
  assert.equal(reversed.startTime, undefined);
  assert.equal(reversed.endTime, undefined);
});

test('riga con due intervalli: due impegni distinti quando l\'abbinamento è riportato, altrimenti il primo con gli altri in notes', () => {
  // Il modello ha dedotto l'abbinamento gruppo↔orario: due impegni, ciascuno con
  // il proprio rawSnippet e un solo intervallo.
  const [gruppoUno, gruppoDue] = normalizeExtractedItems([
    { title: 'COLLOQUI', date: '2026-12-15', startTime: '', endTime: '', rawSnippet: '15/12/2026 | SSIG MAT-TEC- MUS-SM | COLLOQUI | 15:00/18:15' },
    { title: 'COLLOQUI STRUMENTO MUSICALE', date: '2026-12-15', startTime: '', endTime: '', rawSnippet: '15/12/2026 | STRUMENTO MUSICALE | COLLOQUI | 09.45/13.00' },
  ], supportProfile);
  assert.deepEqual([gruppoUno.startTime, gruppoUno.endTime], ['15:00', '18:15']);
  assert.deepEqual([gruppoDue.startTime, gruppoDue.endTime], ['09:45', '13:00']);
  assert.equal(gruppoUno.relevance, 'ROSSO');
  assert.match(gruppoUno.relevanceReason, /MAT \(matematica\)/);
  // Abbinamento NON deducibile: un solo impegno col primo intervallo, gli altri
  // riportati in notes (regola del prompt): l'intervallo dichiarato dal modello
  // resta verificato contro il primo intervallo della riga.
  const [unico] = normalizeExtractedItems([{
    title: 'COLLOQUI', date: '2026-12-15', startTime: '15:00', endTime: '18:15',
    notes: 'Altro intervallo: 09.45/13.00.', rawSnippet: ROW_15_12,
  }], supportProfile);
  assert.deepEqual([unico.startTime, unico.endTime], ['15:00', '18:15']);
  assert.match(unico.notes, /09\.45\/13\.00/);
  // Uno snippet ambiguo su più righe (intera tabella) non può invece avallare
  // alcun intervallo: il comportamento conservativo precedente resta.
  const table = ['PRIMARIA | PROGRAMMAZIONE ANNUALE | 09:00-11:00', 'SSIG | COLLOQUI | 15:00/18:15'].join('\n');
  const [ambiguous] = normalizeExtractedItems([{
    title: 'COLLOQUI', date: '2026-12-15', startTime: '15:00', endTime: '18:15', rawSnippet: table,
  }], supportProfile);
  assert.equal(ambiguous.startTime, undefined);
  assert.equal(ambiguous.endTime, undefined);
});

test('le tre righe del caso reale passano da normalizeExtractedItems con orari e pertinenza', () => {
  const [r14, r15, r02] = normalizeExtractedItems([
    { title: 'COLLOQUI', category: 'ricevimento_genitori', date: '2026-12-14', startTime: '', endTime: '', rawSnippet: ROW_14_12 },
    { title: 'COLLOQUI', category: 'ricevimento_genitori', date: '2026-12-15', startTime: '15:00', endTime: '18:15', notes: 'Altro intervallo: 09.45/13.00.', rawSnippet: ROW_15_12 },
    { title: 'COLLOQUI 1A-2A-3A-4A-5A', category: 'ricevimento_genitori', date: '2026-12-02', startTime: '', endTime: '', rawSnippet: ROW_02_12 },
  ], supportProfile);
  assert.equal(r14.date, '2026-12-14');
  assert.deepEqual([r14.startTime, r14.endTime], ['15:00', '18:15']);
  assert.equal(r14.relevance, 'VERDE');
  assert.equal(r14.selectedForImport, true);
  assert.match(r14.relevanceReason, /SOS \(sostegno\)/);
  assert.deepEqual([r15.startTime, r15.endTime], ['15:00', '18:15']);
  assert.equal(r15.relevance, 'ROSSO');
  assert.match(r15.relevanceReason, /MAT \(matematica\)/);
  assert.deepEqual([r02.startTime, r02.endTime], ['17:00', '20:15']);
  assert.equal(r02.relevance, 'ROSSO');
  assert.equal(r02.relevanceReason, 'Destinato a un altro ordine scolastico.');
});

// ---------------------------------------------------------------------------
// Endpoint /api/analyze-circular con provider simulato (Gemini mockato)
// ---------------------------------------------------------------------------

test('endpoint: prompt con formati orari/colonna DOCENTI, recupero orari e pertinenza end-to-end', async () => {
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT: process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT,
  };
  process.env.GEMINI_API_KEY = 'AIzaSy_FAKE_TEST_KEY';
  delete process.env.GEMINI_CIRCULAR_DIAGNOSTIC_VARIANT;

  // Il modello simulato riproduce il difetto di produzione: orari con la barra
  // non letti (startTime vuota) e DOCENTI riportata nel rawSnippet. Per il
  // 15/12 l'abbinamento gruppo↔orario è dedotto dall'ordine: due impegni.
  const modelItems = [
    { title: 'COLLOQUI', category: 'ricevimento_genitori', date: '2026-12-14', startTime: '', endTime: '', className: '', subject: '', location: '', notes: '', rawSnippet: ROW_14_12, recipientGrades: [], recipientClasses: [] },
    { title: 'COLLOQUI', category: 'ricevimento_genitori', date: '2026-12-15', startTime: '', endTime: '', className: '', subject: '', location: '', notes: '', rawSnippet: '15/12/2026 | SSIG MAT-TEC- MUS-SM | COLLOQUI | 15:00/18:15', recipientGrades: [], recipientClasses: [] },
    { title: 'COLLOQUI STRUMENTO MUSICALE', category: 'ricevimento_genitori', date: '2026-12-15', startTime: '', endTime: '', className: '', subject: '', location: '', notes: '', rawSnippet: '15/12/2026 | STRUMENTO MUSICALE | COLLOQUI | 09.45/13.00', recipientGrades: [], recipientClasses: [] },
    { title: 'COLLOQUI 1A-2A-3A-4A-5A', category: 'ricevimento_genitori', date: '2026-12-02', startTime: '', endTime: '', className: '', subject: '', location: '', notes: '', rawSnippet: ROW_02_12, recipientGrades: [], recipientClasses: [] },
  ];
  let capturedBody: string | null = null;
  const originalFetch = globalThis.fetch;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/analyze-circular`;
  globalThis.fetch = (async (inputUrl: any, opts: any) => {
    if (inputUrl.toString().includes('generativelanguage.googleapis.com')) {
      capturedBody = opts?.body ? opts.body.toString() : null;
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(modelItems) }] }, finishReason: 'STOP' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(inputUrl, opts);
  }) as typeof fetch;
  try {
    const res = await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...analysisAuthHeaders() },
      body: JSON.stringify({ text: [ROW_14_12, ROW_15_12, ROW_02_12].join('\n'), profile: supportProfile }),
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.items.length, 4);
    const byDate = (date: string) => json.items.filter((i: any) => i.date === date);
    // 14/12: orario recuperato dalla barra e pertinenza SOS per il sostegno.
    const [r14] = byDate('2026-12-14');
    assert.deepEqual([r14.startTime, r14.endTime], ['15:00', '18:15']);
    assert.equal(r14.relevance, 'VERDE');
    assert.equal(r14.selectedForImport, true);
    assert.match(r14.relevanceReason, /SOS \(sostegno\)/);
    // 15/12: due impegni distinti con i rispettivi intervalli, altra materia per il sostegno.
    const due = byDate('2026-12-15');
    assert.equal(due.length, 2);
    assert.deepEqual(due.map((i: any) => [i.startTime, i.endTime]).sort(), [['09:45', '13:00'], ['15:00', '18:15']]);
    for (const item of due) {
      assert.equal(item.relevance, 'ROSSO');
      assert.match(item.relevanceReason, /altra materia/i);
    }
    assert.match(due.find((i: any) => i.endTime === '18:15').relevanceReason, /MAT \(matematica\)/);
    // 02/12: escluso per ordine di scuola, con l'orario col punto normalizzato.
    const [r02] = byDate('2026-12-02');
    assert.deepEqual([r02.startTime, r02.endTime], ['17:00', '20:15']);
    assert.equal(r02.relevance, 'ROSSO');
    assert.equal(r02.relevanceReason, 'Destinato a un altro ordine scolastico.');
    // Il prompt inviato al modello contiene le nuove regole.
    assert.ok(capturedBody);
    assert.match(capturedBody!, /HH\.MM\/HH\.MM/);
    assert.match(capturedBody!, /colonna DOCENTI/);
    assert.match(capturedBody!, /due impegni distinti/);
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
