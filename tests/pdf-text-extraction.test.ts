import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPdfText,
  runPdfTextExtraction,
  isPdfTextSufficient,
  PDF_TEXT_SUFFICIENT_MIN_CHARS,
} from '../server/pdfTextExtraction';
import { buildEmptyPdf, buildInvalidPdf, buildMultiPagePlanPdf } from './helpers/pdfFixtures';

// ---------------------------------------------------------------------------
// 1. PDF con text layer -> testo estratto correttamente (multipagina)
// ---------------------------------------------------------------------------

test('extractPdfText: PDF digitale multipagina estrae il testo di tutte le pagine', async () => {
  const pdf = buildMultiPagePlanPdf();
  const base64 = pdf.toString('base64');
  const result = await extractPdfText(base64);

  assert.equal(result.pageCount, 4);
  assert.ok(result.textChars > 0);
  assert.ok(result.text.includes('PIANO DELLE ATTIVITA'));
  assert.ok(result.text.includes('SETTEMBRE'));
  assert.ok(result.text.includes('Collegio docenti'));
  assert.ok(result.text.includes('OTTOBRE'));
  assert.ok(result.text.includes('Consiglio di classe 3E'));
  assert.ok(result.text.includes('NOVEMBRE'));
  assert.ok(result.text.includes('GLO classe 2D'));
  // Separazione strutturale fra pagine, senza contenuto semantico inventato.
  assert.ok(result.text.includes('--- PAGINA 1 ---'));
  assert.ok(result.text.includes('--- PAGINA 4 ---'));

  const outcome = await runPdfTextExtraction(base64);
  assert.equal(outcome.status, 'success');
  assert.equal(isPdfTextSufficient(outcome.text), true);
});

// ---------------------------------------------------------------------------
// 2. PDF vuoto / senza testo utile -> isPdfTextSufficient === false
// ---------------------------------------------------------------------------

test('extractPdfText: PDF valido ma senza testo utile risulta insufficiente', async () => {
  const pdf = buildEmptyPdf();
  const base64 = pdf.toString('base64');
  const result = await extractPdfText(base64);

  assert.equal(result.pageCount, 1);
  assert.equal(isPdfTextSufficient(result.text), false);

  const outcome = await runPdfTextExtraction(base64);
  assert.equal(outcome.status, 'empty');
});

test('isPdfTextSufficient: soglia deterministica su caratteri non whitespace, nessuna euristica AI', () => {
  assert.equal(isPdfTextSufficient(''), false);
  assert.equal(isPdfTextSufficient('   \n\n\t  '), false);
  assert.equal(isPdfTextSufficient('Circolare n. 3'), false);
  assert.equal(isPdfTextSufficient('A'.repeat(PDF_TEXT_SUFFICIENT_MIN_CHARS - 1)), false);
  assert.equal(isPdfTextSufficient('A'.repeat(PDF_TEXT_SUFFICIENT_MIN_CHARS)), true);
  // Tanti spazi ma poco testo reale: non deve ingannare la soglia.
  const paddedButSparse = 'Titolo circolare' + ' '.repeat(2000);
  assert.equal(isPdfTextSufficient(paddedButSparse), false);
});

// ---------------------------------------------------------------------------
// 3. PDF non valido -> errore controllato, non crash del processo
// ---------------------------------------------------------------------------

test('extractPdfText: PDF non valido rifiuta la Promise senza crashare il processo', async () => {
  const base64 = buildInvalidPdf().toString('base64');
  await assert.rejects(() => extractPdfText(base64));
});

test('runPdfTextExtraction: PDF non valido restituisce esito controllato "failed", non un\'eccezione', async () => {
  const base64 = buildInvalidPdf().toString('base64');
  const outcome = await runPdfTextExtraction(base64);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.text, '');
  assert.equal(outcome.textChars, 0);
});

test('runPdfTextExtraction: base64 totalmente malformato resta un esito controllato', async () => {
  const outcome = await runPdfTextExtraction('%%% non base64 %%%');
  assert.equal(outcome.status, 'failed');
});
