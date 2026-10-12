import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { create, act } from 'react-test-renderer';
import {
  buildCommitmentSearchIndex,
  hasSearchableTerms,
  normalizeSearchText,
  searchCommitments,
} from '../src/utils/commitmentSearch';
import { deriveArchiveCommitments, deriveFutureCommitments } from '../src/utils/futureCommitments';
import { FutureCommitmentsView } from '../src/components/FutureCommitmentsView';
import type { CalendarEvent, EventCategory, Student, StudentScheduledAssessment } from '../src/types';
import { addDaysISO } from '../src/utils/dates';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const viewSource = readFileSync(resolve(here, '../src/components/FutureCommitmentsView.tsx'), 'utf8');
const searchUtilSource = readFileSync(resolve(here, '../src/utils/commitmentSearch.ts'), 'utf8');

// Mercoledì 2026-04-15 come "oggi" di riferimento (l'anno corrente è 2026).
const TODAY = '2026-04-15';

function event(partial: Partial<CalendarEvent> & { id: string; date: string }): CalendarEvent {
  return {
    title: 'Impegno',
    category: 'riunione',
    isAllDay: false,
    sourceType: 'manuale',
    ...partial,
  } as CalendarEvent;
}

function assessment(partial: Partial<StudentScheduledAssessment> & { id: string; date: string }): StudentScheduledAssessment {
  return {
    studentId: 'stu-1',
    assessmentType: 'written',
    status: 'scheduled',
    ...partial,
  } as StudentScheduledAssessment;
}

const students: Student[] = [
  { id: 'stu-1', fullName: 'Mario Rossi', className: '3E', notes: [] } as unknown as Student,
];

/**
 * Stub STRETTO dell'etichetta tipologia (nella vista è costruita su EVENT_CATEGORIES):
 * una categoria senza etichetta nota non contribuisce al testo ricercabile, così i
 * test sulla tipologia sono davvero significativi.
 */
const CATEGORY_LABELS: Partial<Record<EventCategory, string>> = {
  collegio_docenti: 'Collegio Docenti',
  consiglio_classe: 'Consiglio di Classe',
  glo: 'G.L.O. (Gruppo Lavoro Operativo)',
  uscita_didattica: 'Uscita didattica',
};
const categoryLabel = (category: EventCategory): string => CATEGORY_LABELS[category] ?? '';

/** Gli stessi derivati usati dalla vista: impegni (tutti) + Archivio. Nessun'altra fonte. */
function commitmentsOf(events: CalendarEvent[], assessments: StudentScheduledAssessment[] = []) {
  return [
    ...deriveFutureCommitments({ events, scheduledAssessments: assessments, students, todayIso: TODAY }),
    ...deriveArchiveCommitments({ events, scheduledAssessments: assessments, students, todayIso: TODAY }),
  ];
}

function search(events: CalendarEvent[], query: string, assessments: StudentScheduledAssessment[] = []) {
  return searchCommitments(commitmentsOf(events, assessments), query, { todayIso: TODAY, categoryLabel });
}

function ids(result: { upcoming: { id: string }[]; past: { id: string }[] }) {
  return {
    upcoming: result.upcoming.map(item => item.id),
    past: result.past.map(item => item.id),
  };
}

function renderedText(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join('');
  return renderedText(node?.children ?? []);
}

async function renderView(events: CalendarEvent[], extras: Record<string, unknown> = {}) {
  let renderer: any;
  await act(async () => {
    renderer = create(
      React.createElement(FutureCommitmentsView, {
        events,
        scheduledAssessments: [],
        students,
        todayIso: TODAY,
        ...extras,
      }),
    );
  });
  return renderer;
}

function openSearch(renderer: any) {
  return act(async () => renderer.root.findByProps({ 'data-commitments-search-toggle': true }).props.onClick());
}

function typeQuery(renderer: any, value: string) {
  const input = renderer.root.findByProps({ 'data-commitments-search-input': true });
  return act(async () => input.props.onChange({ target: { value } }));
}

const COLLEGIO = [event({ id: 'c', date: addDaysISO(TODAY, 3), title: 'Collegio dei docenti' })];

// --- normalizeSearchText -----------------------------------------------------

test('normalizeSearchText: doppie, accenti, maiuscole e classi', () => {
  assert.equal(normalizeSearchText('Collegio'), 'colegio');
  assert.equal(normalizeSearchText('colleggio'), 'colegio');
  assert.equal(normalizeSearchText('COLLEGGIO'), 'colegio');
  assert.equal(normalizeSearchText('Perché Città'), 'perche cita'); // accenti (NFD), maiuscole e doppie ("tt" → "t")
  assert.equal(normalizeSearchText('Città'), 'cita');
  assert.equal(normalizeSearchText('Annullare'), 'anulare'); // doppie consecutive → una
  assert.equal(normalizeSearchText('2 C'), '2c');
  assert.equal(normalizeSearchText('2^C'), '2c');
  assert.equal(normalizeSearchText('2ªC'), '2c');
  assert.equal(normalizeSearchText('classe 2c'), 'clase 2c');
  assert.equal(normalizeSearchText('  Consiglio   di  Classe '), 'consiglio di clase'); // spazi multipli
  assert.equal(normalizeSearchText('uscita; GLO, pranzo.'), 'uscita glo pranzo'); // punteggiatura → spazio
  // Non salda il numero a una parola vera: solo la lettera singola è una classe.
  assert.equal(normalizeSearchText('il 2 novembre'), 'il 2 novembre');
  // Le cifre doppie restano: solo le LETTERE doppie si riducono.
  assert.equal(normalizeSearchText('aula 22'), 'aula 22');
});

// --- corrispondenze di base: "collegio" in ogni forma ------------------------

test('"colleggio", "Collegio", "COLLEGIO" e "coll" trovano "Collegio dei docenti"', () => {
  for (const query of ['colleggio', 'Collegio', 'COLLEGIO', 'coll']) {
    assert.deepEqual(ids(search(COLLEGIO, query)), { upcoming: ['event:c'], past: [] }, `query: ${query}`);
  }
});

test('inizio di parola ("coll") e contenuto ("olleg", almeno 4 caratteri)', () => {
  assert.deepEqual(ids(search(COLLEGIO, 'olleg')), { upcoming: ['event:c'], past: [] });
});

test('tipologia: categoria collegio_docenti con titolo "CD straordinario" trovata con "collegio"', () => {
  const events = [event({ id: 'cd', date: addDaysISO(TODAY, 2), category: 'collegio_docenti', title: 'CD straordinario' })];
  // Con lo stub stretto il titolo non contiene "collegio": lo trova solo l'etichetta
  // "Collegio Docenti" passata tramite categoryLabel.
  assert.deepEqual(ids(search(events, 'collegio')), { upcoming: ['event:cd'], past: [] });
  // Senza etichette la stessa ricerca non troverebbe nulla.
  const senzaEtichetta = searchCommitments(commitmentsOf(events), 'collegio', { todayIso: TODAY, categoryLabel: () => '' });
  assert.deepEqual(ids(senzaEtichetta), { upcoming: [], past: [] });
});

// --- AND tra parole ----------------------------------------------------------

test('AND: "consiglio 2c" trova "Consiglio di Classe 2C" e non "Consiglio di Classe 3A"', () => {
  const events = [
    event({ id: 'ok', date: addDaysISO(TODAY, 5), category: 'consiglio_classe', title: 'Consiglio di Classe 2C' }),
    event({ id: 'no', date: addDaysISO(TODAY, 6), category: 'consiglio_classe', title: 'Consiglio di Classe 3A' }),
  ];
  assert.deepEqual(ids(search(events, 'consiglio 2c')), { upcoming: ['event:ok'], past: [] });
  // Le forme della classe sono equivalenti nella query.
  assert.deepEqual(ids(search(events, 'consiglio 2 C')), { upcoming: ['event:ok'], past: [] });
  assert.deepEqual(ids(search(events, 'consiglio 2^C')), { upcoming: ['event:ok'], past: [] });
});

test('le parole di 1 carattere sono ignorate; senza parole utili la ricerca non restituisce nulla', () => {
  const events = [event({ id: 'glo', date: addDaysISO(TODAY, 1), category: 'glo', title: 'GLO 2C' })];
  // "g" da sola è rumore: non è una parola utile, non trova l'intero elenco.
  const soloRumore = search(events, 'g');
  assert.equal(soloRumore.tooShort, true);
  assert.deepEqual(ids(soloRumore), { upcoming: [], past: [] });
  // "2c" invece è una classe normalizzata e filtra davvero.
  assert.deepEqual(ids(search(events, '2c')), { upcoming: ['event:glo'], past: [] });
  assert.deepEqual(ids(search(events, '3c')), { upcoming: [], past: [] });
  // Query fatta solo di parole da 1 carattere: nessuna parola utile ⇒ NESSUN
  // risultato (mai l'intero elenco: l'AND su lista vuota non viene eseguito).
  const soloRumore2 = search(events, 'g 3');
  assert.equal(soloRumore2.tooShort, true);
  assert.deepEqual(ids(soloRumore2), { upcoming: [], past: [] });
});

test('le verifiche programmate sono ricercabili per argomento e materia', () => {
  const result = search([], 'frazioni', [assessment({ id: 'as-1', date: addDaysISO(TODAY, 1), subject: 'Matematica', topic: 'Frazioni' })]);
  assert.deepEqual(ids(result), { upcoming: ['assessment:as-1'], past: [] });
  assert.deepEqual(ids(search([], 'matematica', [assessment({ id: 'as-1', date: addDaysISO(TODAY, 1), subject: 'Matematica' })])), { upcoming: ['assessment:as-1'], past: [] });
});

// --- errori di battitura -----------------------------------------------------

test('errore di battitura: "collegko" trovato (1 modifica su parola lunga), "colegoi" no (2 modifiche)', () => {
  assert.deepEqual(ids(search(COLLEGIO, 'collegko')), { upcoming: ['event:c'], past: [] });
  // "colegoi" scambia due lettere: distanza di modifica 2, oltre la tolleranza di 1.
  assert.deepEqual(ids(search(COLLEGIO, 'colegoi')), { upcoming: [], past: [] });
});

test('"glo": nessuna correzione automatica sotto i 6 caratteri — solo inizio di parola (comportamento atteso)', () => {
  // Come da specifica: "glo" (3 caratteri) non ha diritto all'errore di battitura.
  // Trova "globale" SOLO perché "globale" inizia per "glo", non come errore tollerato.
  const events = [
    event({ id: 'sigla', date: addDaysISO(TODAY, 1), title: 'GLO 2C' }),
    event({ id: 'globale', date: addDaysISO(TODAY, 2), title: 'Riunione globale' }),
    event({ id: 'conglobato', date: addDaysISO(TODAY, 3), title: 'Orario conglobato' }),
  ];
  assert.deepEqual(ids(search(events, 'glo')), {
    upcoming: ['event:sigla', 'event:globale'], // "globale" incluso solo come inizio parola
    past: [],
  });
  // "conglobato" contiene "glo" in mezzo alla parola: la regola di contenuto parte da
  // 4 caratteri e quella dell'errore da 6, quindi "glo" non deve trovarlo.
  const soloConglobato = [event({ id: 'conglobato', date: addDaysISO(TODAY, 3), title: 'Orario conglobato' })];
  assert.deepEqual(ids(search(soloConglobato, 'glo')), { upcoming: [], past: [] });
});

// --- testo di pertinenza nascosto --------------------------------------------

test('il motivo di pertinenza nascosto delle circolari non genera risultati', () => {
  const reason = 'Destinato a tutti i docenti.';
  const circular = [event({ id: 'circ', date: addDaysISO(TODAY, 1), sourceType: 'circolare', notes: reason })];
  // Nella riga il motivo non viene mostrato: non deve nemmeno emergere dalla ricerca.
  assert.deepEqual(ids(search(circular, 'destinato')), { upcoming: [], past: [] });
  assert.deepEqual(ids(search(circular, reason)), { upcoming: [], past: [] });
  // La stessa nota su un impegno manuale È visibile nella riga, quindi è ricercabile.
  const manual = [event({ id: 'man', date: addDaysISO(TODAY, 1), sourceType: 'manuale', notes: reason })];
  assert.deepEqual(ids(search(manual, 'destinato')), { upcoming: ['event:man'], past: [] });
});

// --- separazione e ordinamento futuri/passati --------------------------------

test('separazione e ordinamento: oggi nei futuri, passati dal più recente, oltre il 31 agosto incluso', () => {
  const events = [
    event({ id: 'past-old', date: '2026-04-10', title: 'Riunione passata remota' }),
    event({ id: 'past-recent', date: '2026-04-13', title: 'Riunione passata recente' }),
    event({ id: 'today', date: TODAY, title: 'Riunione di oggi' }),
    event({ id: 'future', date: '2026-04-20', title: 'Riunione futura' }),
    event({ id: 'beyond', date: '2027-09-10', title: 'Riunione oltre agosto' }),
  ];
  const result = search(events, 'riunione');
  assert.deepEqual(ids(result), {
    upcoming: ['event:today', 'event:future', 'event:beyond'], // data crescente, oggi incluso
    past: ['event:past-recent', 'event:past-old'], // dal più recente al più vecchio
  });
  // L'impegno oltre il 31 agosto è elencato tra i futuri, non solo contato.
  assert.ok(result.upcoming.some(item => item.id === 'event:beyond'));
});

test('l\'indice precalcolato produce gli stessi risultati dell\'elenco grezzo', () => {
  const items = commitmentsOf(COLLEGIO);
  const diretto = searchCommitments(items, 'colleggio', { todayIso: TODAY, categoryLabel });
  const indicizzato = searchCommitments(buildCommitmentSearchIndex(items, categoryLabel), 'colleggio', { todayIso: TODAY, categoryLabel });
  assert.deepEqual(ids(diretto), ids(indicizzato));
});

test('la ricerca resta locale: la utility non importa componenti React né servizi, la vista memoizza l\'indice', () => {
  assert.ok(!/from "\.\.\/(components|services)/.test(searchUtilSource), 'nessun import di componenti o servizi');
  assert.match(searchUtilSource, /isRelevanceReasonText/);
  // La vista costruisce l'etichetta da EVENT_CATEGORIES, memoizza l'indice (useMemo)
  // e non fa partire la ricerca senza parole utili.
  assert.match(viewSource, /SEARCH_CATEGORY_LABEL = \(category: EventCategory\): string =>/);
  assert.match(viewSource, /EVENT_CATEGORIES\.find/);
  assert.match(viewSource, /buildCommitmentSearchIndex\(searchItems, SEARCH_CATEGORY_LABEL\)/);
  assert.match(viewSource, /useMemo\(/);
  assert.match(viewSource, /hasSearchableTerms/);
  assert.match(searchUtilSource, /hasSearchableTerms/);
});

// --- UI ----------------------------------------------------------------------

test('UI: il pulsante lente (≥44px, aria-label) apre il campo di ricerca sotto l\'header', async () => {
  const renderer = await renderView(COLLEGIO);
  const toggle = renderer.root.findByProps({ 'data-commitments-search-toggle': true });
  assert.equal(toggle.props['aria-label'], 'Cerca negli impegni');
  assert.match(toggle.props.className, /h-11/); // 44px
  assert.match(toggle.props.className, /w-11/); // 44px
  assert.equal(renderer.root.findAllByProps({ 'data-commitments-search-input': true }).length, 0);

  await openSearch(renderer);
  const input = renderer.root.findByProps({ 'data-commitments-search-input': true });
  assert.equal(input.props.type, 'search');
  assert.equal(input.props.autoFocus, true);
  assert.equal(input.props.placeholder, 'Cerca: collegio, GLO, 2C, uscita…');
  assert.equal(renderer.root.findAllByProps({ 'data-search-results': true }).length, 0, 'senza query nessun risultato');
  await act(async () => renderer.unmount());
});

test('UI: con 1 carattere la vista resta identica a oggi', async () => {
  const renderer = await renderView([
    event({ id: 'today-note', date: TODAY, title: 'Nota di oggi' }),
    ...COLLEGIO,
    event({ id: 'past', date: addDaysISO(TODAY, -2), title: 'Vecchio collegio' }),
  ]);
  await openSearch(renderer);
  await typeQuery(renderer, 'c');
  assert.equal(renderer.root.findAllByProps({ 'data-search-results': true }).length, 0);
  assert.equal(renderer.root.findAllByProps({ 'data-search-empty': true }).length, 0);
  // Vista normale intatta: gruppi e Archivio al loro posto.
  assert.ok(renderer.root.findAllByProps({ 'data-commitment-group': 'oggi' }).length > 0);
  assert.ok(renderer.root.findAllByProps({ 'data-archive-commitments-toggle': true }).length > 0);
  await act(async () => renderer.unmount());
});

test('UI: "collegio" mostra riepilogo, "In programma" e "Passati" con conteggi, niente gruppi né Archivio', async () => {
  const renderer = await renderView([
    event({ id: 'future-collegio', date: addDaysISO(TODAY, 1), title: 'Collegio dei docenti' }),
    event({ id: 'other', date: addDaysISO(TODAY, 2), title: 'Consegna PEI' }),
    event({ id: 'past-collegio', date: addDaysISO(TODAY, -2), title: 'Collegio docenti' }),
    event({ id: 'past-other', date: addDaysISO(TODAY, -5), title: 'Riunione vecchia' }),
  ]);
  await openSearch(renderer);
  await typeQuery(renderer, 'collegio');

  const summary = renderer.root.findByProps({ 'data-search-results-summary': true });
  assert.equal(renderedText(summary), '2 risultati per «collegio»');

  const upcomingSection = renderer.root.findByProps({ 'data-search-section': 'in-programma' });
  assert.match(renderedText(upcomingSection), /In programma \(1\)/);
  assert.ok(upcomingSection.findByProps({ 'data-commitment-id': 'event:future-collegio' }));
  assert.equal(upcomingSection.findAllByProps({ 'data-commitment-id': 'event:past-collegio' }).length, 0);

  const pastSection = renderer.root.findByProps({ 'data-search-section': 'passati' });
  assert.match(renderedText(pastSection), /Passati \(1\)/);
  assert.ok(pastSection.findByProps({ 'data-commitment-id': 'event:past-collegio' }));
  assert.equal(pastSection.findAllByProps({ 'data-commitment-id': 'event:future-collegio' }).length, 0);

  // Al posto dei gruppi normali e dell'Archivio: nessun gruppo, nessun pannello storico.
  assert.equal(renderer.root.findAll(el => el.props?.['data-commitment-group'] !== undefined).length, 0);
  assert.equal(renderer.root.findAllByProps({ 'data-archive-commitments': true }).length, 0);
  await act(async () => renderer.unmount());
});

test('UI: tap su un risultato apre l\'impegno e la spunta delle note resta attiva', async () => {
  const nota = event({ id: 'nota', date: addDaysISO(TODAY, -1), category: 'promemoria', title: 'Nota sul collegio', completed: true });
  const opened: CalendarEvent[] = [];
  const toggled: string[] = [];
  const renderer = await renderView([nota], {
    onEditNote: (e: CalendarEvent) => opened.push(e),
    onToggleComplete: (id: string) => {
      toggled.push(id);
      return false;
    },
  });
  await openSearch(renderer);
  await typeQuery(renderer, 'collegio');
  const row = renderer.root.findByProps({ 'data-search-section': 'passati' }).findByProps({ 'data-commitment-id': 'event:nota' });
  await act(async () => row.props.onClick());
  assert.deepEqual(opened, [nota]);
  await act(async () => renderer.root.findByProps({ 'data-commitment-toggle': 'event:nota' }).props.onClick());
  assert.deepEqual(toggled, ['nota']);
  await act(async () => renderer.unmount());
});

test('UI: X svuota e chiude; l\'Archivio torna aperto/chiuso com\'era', async () => {
  const renderer = await renderView([
    event({ id: 'future', date: addDaysISO(TODAY, 1), title: 'Collegio dei docenti' }),
    event({ id: 'past', date: addDaysISO(TODAY, -2), title: 'Vecchio collegio' }),
  ]);
  // L'Archivio viene aperto PRIMA della ricerca: dopo la chiusura deve restare aperto.
  await act(async () => renderer.root.findByProps({ 'data-archive-commitments-toggle': true }).props.onClick());
  assert.ok(renderer.root.findAllByProps({ 'data-archive-commitments-list': true }).length > 0);

  await openSearch(renderer);
  await typeQuery(renderer, 'collegio');
  assert.equal(renderer.root.findAllByProps({ 'data-archive-commitments': true }).length, 0);

  await act(async () => renderer.root.findByProps({ 'data-commitments-search-clear': true }).props.onClick());
  assert.equal(renderer.root.findAllByProps({ 'data-commitments-search-input': true }).length, 0, 'il campo si chiude');
  assert.ok(renderer.root.findAllByProps({ 'data-commitment-group': 'domani' }).length > 0, 'tornano i gruppi');
  assert.ok(renderer.root.findAllByProps({ 'data-archive-commitments-list': true }).length > 0, 'Archivio ancora aperto');

  // Riaprendo la ricerca la query è stata svuotata.
  await openSearch(renderer);
  assert.equal(renderer.root.findByProps({ 'data-commitments-search-input': true }).props.value, '');
  await act(async () => renderer.unmount());
});

test('UI: Esc svuota e chiude come X', async () => {
  const renderer = await renderView([
    event({ id: 'future', date: addDaysISO(TODAY, 1), title: 'Collegio dei docenti' }),
  ]);
  await openSearch(renderer);
  await typeQuery(renderer, 'collegio');
  assert.ok(renderer.root.findAllByProps({ 'data-search-results': true }).length > 0);
  await act(async () => renderer.root.findByProps({ 'data-commitments-search-input': true }).props.onKeyDown({ key: 'Escape' }));
  assert.equal(renderer.root.findAllByProps({ 'data-commitments-search-input': true }).length, 0);
  assert.ok(renderer.root.findAllByProps({ 'data-commitment-group': 'domani' }).length > 0);
  await act(async () => renderer.unmount());
});

test('UI: nessun risultato → messaggio dedicato, senza sezioni vuote', async () => {
  const renderer = await renderView(COLLEGIO);
  await openSearch(renderer);
  await typeQuery(renderer, 'qwzxvk');
  const empty = renderer.root.findByProps({ 'data-search-empty': true });
  assert.match(renderedText(empty), /Nessun impegno trovato per «qwzxvk»/);
  assert.equal(renderer.root.findAllByProps({ 'data-search-results': true }).length, 0);
  assert.equal(renderer.root.findAllByProps({ 'data-search-section': 'in-programma' }).length, 0);
  assert.equal(renderer.root.findAllByProps({ 'data-search-section': 'passati' }).length, 0);
  await act(async () => renderer.unmount());
});

test('query senza parole utili ("aa", "zz", "..", "c d", "   "): risultati vuoti e tooShort coerente', () => {
  // Il difetto: queste query mostravano l'intero elenco con "N risultati".
  for (const query of ['aa', 'zz', '..', 'c d', '   ']) {
    const result = search(COLLEGIO, query);
    assert.deepEqual(ids(result), { upcoming: [], past: [] }, `query: ${query}`);
    assert.equal(result.tooShort, true, `query: ${query}`);
    assert.equal(hasSearchableTerms(query), false, `query: ${query}`);
    assert.equal(result.upcoming.length + result.past.length, 0, `query: ${query}`);
  }
});

test('hasSearchableTerms: "2c" (classe) e "glo" (sigla) restano parole utili e funzionano come prima', () => {
  assert.equal(hasSearchableTerms('2c'), true);
  assert.equal(hasSearchableTerms('glo'), true);
  assert.equal(hasSearchableTerms('collegio'), true);
  const events = [event({ id: 'glo', date: addDaysISO(TODAY, 1), category: 'glo', title: 'GLO 2C' })];
  const byClass = search(events, '2c');
  assert.equal(byClass.tooShort, false);
  assert.deepEqual(ids(byClass), { upcoming: ['event:glo'], past: [] });
  const bySigla = search(events, 'glo');
  assert.equal(bySigla.tooShort, false);
  assert.deepEqual(ids(bySigla), { upcoming: ['event:glo'], past: [] });
  // Parola utile mescolata al rumore: filtra per la parola utile, senza tooShort.
  const mista = search(events, 'aa 2c');
  assert.equal(mista.tooShort, false);
  assert.deepEqual(ids(mista), { upcoming: ['event:glo'], past: [] });
});

test('UI: query fatta di sole doppie ("zzzzzz") → suggerimento, non "Nessun impegno trovato"', async () => {
  const renderer = await renderView(COLLEGIO);
  await openSearch(renderer);
  // Le doppie collassano ("zzzzzz" → "z"): nessuna parola utile.
  await typeQuery(renderer, 'zzzzzz');
  assert.equal(renderer.root.findAllByProps({ 'data-search-empty': true }).length, 0);
  assert.equal(renderer.root.findAllByProps({ 'data-search-results-summary': true }).length, 0);
  assert.ok(renderer.root.findAllByProps({ 'data-search-hint': true }).length > 0);
  await act(async () => renderer.unmount());
});

test('UI: "aa" mostra il suggerimento, non la vista normale né "N risultati"', async () => {
  const renderer = await renderView([
    event({ id: 'future', date: addDaysISO(TODAY, 1), title: 'Collegio dei docenti' }),
    event({ id: 'past', date: addDaysISO(TODAY, -2), title: 'Vecchio collegio' }),
  ]);
  await openSearch(renderer);
  await typeQuery(renderer, 'aa');
  const hint = renderer.root.findByProps({ 'data-search-hint': true });
  assert.equal(renderedText(hint), 'Scrivi almeno una parola di 2 lettere.');
  // Né risultati, né conteggio, né messaggio "nessun risultato".
  assert.equal(renderer.root.findAllByProps({ 'data-search-results': true }).length, 0);
  assert.equal(renderer.root.findAllByProps({ 'data-search-results-summary': true }).length, 0);
  assert.equal(renderer.root.findAllByProps({ 'data-search-empty': true }).length, 0);
  // Nemmeno la vista normale (gruppi, conteggio oltre anno, Archivio) sotto il suggerimento.
  assert.equal(renderer.root.findAll(el => el.props?.['data-commitment-group'] !== undefined).length, 0);
  assert.equal(renderer.root.findAllByProps({ 'data-archive-commitments': true }).length, 0);
  // Appena arriva una parola utile i risultati tornano, come prima.
  await typeQuery(renderer, 'collegio');
  assert.equal(renderer.root.findAllByProps({ 'data-search-hint': true }).length, 0);
  assert.ok(renderer.root.findAllByProps({ 'data-search-results': true }).length > 0);
  await typeQuery(renderer, 'c d');
  assert.ok(renderer.root.findAllByProps({ 'data-search-hint': true }).length > 0, 'solo lettere singole ⇒ suggerimento');
  await act(async () => renderer.unmount());
});

test('UI: la ricerca elenca anche gli impegni oltre il 31 agosto, con data completa e anno', async () => {
  const beyond = event({ id: 'beyond', date: '2027-09-15', title: 'Collegio di inizio anno' });
  const renderer = await renderView([...COLLEGIO, beyond], { schoolYear: '2026/2027' });
  // Nella vista normale gli impegni oltre il 31 agosto restano riassunti nel conteggio.
  assert.ok(renderer.root.findAllByProps({ 'data-commitments-beyond-count': 1 }).length > 0);

  await openSearch(renderer);
  await typeQuery(renderer, 'collegio');
  const upcomingSection = renderer.root.findByProps({ 'data-search-section': 'in-programma' });
  assert.match(renderedText(upcomingSection), /In programma \(2\)/);
  // Data completa con l'anno: non è l'anno corrente.
  const beyondRow = upcomingSection.findByProps({ 'data-commitment-id': 'event:beyond' });
  assert.match(renderedText(beyondRow.findByProps({ 'data-commitment-date': true })), /15\/09\/2027/);
  await act(async () => renderer.unmount());
});
