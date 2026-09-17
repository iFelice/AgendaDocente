/**
 * Geometria della griglia orario e specifiche di crop: SOLO matematica.
 *
 * Questo modulo non tocca il DOM, non decodifica immagini e non conosce il
 * canvas: riceve numeri normalizzati (0..1 rispetto all'immagine) e restituisce
 * numeri. Tutto ciò che è `<canvas>`/`drawImage` vive in `imageCropper.ts`, così
 * la parte verificabile resta testabile in Node senza jsdom.
 *
 * ── ASSUNZIONE DICHIARATA: COLONNE ORARIE DI LARGHEZZA UNIFORME ──────────────
 * La posizione x di una colonna è derivata aritmeticamente dividendo la griglia
 * in `PERSONAL_SCHOOL_DAYS * periodsPerDay` colonne UGUALI. È la stessa
 * assunzione di CONTEGGIO che l'app già fa sull'orario personale (P10 del prompt:
 * "Ogni blocco giornaliero contiene ESATTAMENTE N COLONNE FISICHE"), estesa alla
 * larghezza in pixel.
 *
 * Il conteggio è verificato dal contratto esistente (5 blocchi x N celle), la
 * LARGHEZZA UNIFORME NO: nessuna informazione nel codice può garantirla, perché
 * dipende dal documento fotografato. Una tabella con ore da due unite in una
 * cella sola, con una colonna MATERIA di larghezza variabile o con blocchi
 * giorno di ampiezza diversa rompe l'assunzione. Per questo:
 *  - la geometria che entra qui è sempre validata e, se non torna, si FALLISCE
 *    in modo esplicito (mai coordinate inventate);
 *  - la preview diagnostica del modale esiste proprio per confermare o smentire
 *    l'assunzione sulla foto reale PRIMA di collegare il crop all'analisi.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { MAX_GRID_PERIODS, PERSONAL_SCHOOL_DAYS } from "./timetableAnalysis";

/** Rettangolo in coordinate NORMALIZZATE: 0 = bordo sinistro/superiore, 1 = destro/inferiore. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fascia verticale in coordinate normalizzate: l'estensione verticale è quella della tabella. */
export interface NormalizedSpan {
  x: number;
  width: number;
}

/**
 * Geometria minima della tabella orario, tutta normalizzata 0..1.
 *
 * È esattamente ciò che la chiamata di geometria deve restituire: nessun testo,
 * nessuna classe, nessuna materia, nessun docente. Solo numeri.
 */
export interface TimetableGridGeometry {
  /** Area della tabella, intestazione dei giorni/ora inclusa. */
  table: NormalizedRect;
  /** Colonna MATERIA/DISCIPLINA. */
  subjectColumn: NormalizedSpan;
  /** Area della griglia giorno x periodo (esclude MATERIA, DOCENTI e CLASSI). */
  scheduleGrid: NormalizedSpan;
  /** Ore per giorno dichiarate dall'UTENTE e verificate qui. */
  periodsPerDay: number;
}

/** Rettangolo in PIXEL, pronto per `drawImage`. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Una colonna oraria della griglia, derivata deterministicamente. */
export interface PeriodColumn {
  /** Numero di colonna FISICO, 1-based: lunedì 1ª = 1, martedì 1ª = periodsPerDay + 1. */
  columnNumber: number;
  /** Indice 0-based, usato per l'aritmetica. */
  columnIndex: number;
  dayOfWeek: number;
  periodIndex: number;
  /** Fascia orizzontale normalizzata della colonna. */
  span: NormalizedSpan;
}

/**
 * Specifica di composizione: MATERIA a sinistra, colonna oraria a destra, con lo
 * STESSO `sourceY`/`sourceHeight`. Le righe restano allineate per costruzione:
 * non è il modello a doverle allineare, è la geometria.
 */
export interface SubjectColumnCropSpec {
  dayOfWeek: number;
  periodIndex: number;
  columnNumber: number;
  /** Fascia normalizzata della colonna MATERIA. */
  subject: NormalizedSpan;
  /** Fascia normalizzata della colonna oraria target. */
  column: NormalizedSpan;
  /** Estensione verticale condivisa (l'intera tabella, intestazione inclusa). */
  sourceY: number;
  sourceHeight: number;
}

/** Motivo stabile del rifiuto di una geometria: mai testo del documento. */
export const GEOMETRY_ERRORS = {
  periodsPerDay: "geometry-periods-per-day",
  shape: "geometry-forma-non-valida",
  bounds: "geometry-valori-fuori-intervallo",
  overlap: "geometry-colonna-materia-sovrapposta-alla-griglia",
  columns: "geometry-colonne-fuori-dalla-griglia",
  pixels: "geometry-crop-fuori-immagine",
} as const;

export type GeometryErrorCode = (typeof GEOMETRY_ERRORS)[keyof typeof GEOMETRY_ERRORS];

/**
 * Errore di geometria: il messaggio è una stringa fissa nostra (mai contenuto
 * del documento), quindi è sicuro nei log del server.
 */
export class TimetableGeometryError extends Error {
  readonly code: GeometryErrorCode;
  constructor(code: GeometryErrorCode, message: string) {
    super(message);
    this.name = "TimetableGeometryError";
    this.code = code;
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Tolleranza per i bordi: 0.999999 del modello non deve diventare un rifiuto. */
const EPSILON = 1e-6;

/** Ore per giorno utilizzabili: intero dentro il tetto di geometria dell'app. */
export function isValidPeriodsPerDay(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 1 && value <= MAX_GRID_PERIODS;
}

/**
 * Numero di colonna FISICO (1-based) per una coordinata giorno + ora.
 *
 * Formula esatta: `(dayOfWeek - 1) * periodsPerDay + periodIndex`.
 * Con 5 ore: lunedì 2ª = 2, martedì 1ª = 6, venerdì 5ª = 25.
 */
export function physicalColumnNumber(dayOfWeek: number, periodIndex: number, periodsPerDay: number): number {
  return (dayOfWeek - 1) * periodsPerDay + periodIndex;
}

/** Indice 0-based della colonna: è il numero fisico meno uno. */
export function physicalColumnIndex(dayOfWeek: number, periodIndex: number, periodsPerDay: number): number {
  return physicalColumnNumber(dayOfWeek, periodIndex, periodsPerDay) - 1;
}

/** Numero totale di colonne orarie della griglia. */
export function totalPeriodColumns(periodsPerDay: number): number {
  return PERSONAL_SCHOOL_DAYS * periodsPerDay;
}

function readNormalizedRect(value: unknown, what: string): NormalizedRect {
  if (!isRecord(value)) throw new TimetableGeometryError(GEOMETRY_ERRORS.shape, `Geometria non valida: ${what}.`);
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(isFiniteNumber)) {
    throw new TimetableGeometryError(GEOMETRY_ERRORS.shape, `Geometria non valida: ${what}.`);
  }
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function readNormalizedSpan(value: unknown, what: string): NormalizedSpan {
  if (!isRecord(value)) throw new TimetableGeometryError(GEOMETRY_ERRORS.shape, `Geometria non valida: ${what}.`);
  const { x, width } = value;
  if (![x, width].every(isFiniteNumber)) {
    throw new TimetableGeometryError(GEOMETRY_ERRORS.shape, `Geometria non valida: ${what}.`);
  }
  return { x: x as number, width: width as number };
}

const outOfBounds = (what: string) =>
  new TimetableGeometryError(GEOMETRY_ERRORS.bounds, `Geometria fuori dall'immagine: ${what}.`);

/** Verifica che una fascia orizzontale stia dentro i limiti normalizzati 0..1. */
function assertSpanInImage(span: NormalizedSpan, what: string): void {
  if (span.x < -EPSILON) throw outOfBounds(what);
  if (span.width <= 0) throw outOfBounds(what);
  if (span.x + span.width > 1 + EPSILON) throw outOfBounds(what);
}

/**
 * Valida e normalizza la geometria restituita dalla chiamata di geometria.
 *
 * Controlli (tutti obbligatori, nessuno aggirabile):
 *  - `periodsPerDay` intero da 1 a `MAX_GRID_PERIODS` (dichiarato dall'utente);
 *  - tutti i valori finiti e dentro 0..1;
 *  - larghezze e altezze strettamente positive;
 *  - `subjectColumn` e `scheduleGrid` interamente dentro `table`;
 *  - `subjectColumn` non sovrapposta alla griglia: se le due fasce si
 *    intersecano, una delle due è sbagliata e nessun crop sarebbe affidabile;
 *  - le `PERSONAL_SCHOOL_DAYS * periodsPerDay` colonne derivate restano dentro
 *    `scheduleGrid` (verifica esplicita sulla prima e sull'ultima).
 *
 * Ogni fallimento è un `TimetableGeometryError`: nessuna coordinata di ripiego.
 */
export function normalizeTimetableGeometry(raw: unknown, periodsPerDay: unknown): TimetableGridGeometry {
  if (!isValidPeriodsPerDay(periodsPerDay)) {
    throw new TimetableGeometryError(GEOMETRY_ERRORS.periodsPerDay, "Ore per giorno non valide per la geometria.");
  }
  if (!isRecord(raw)) throw new TimetableGeometryError(GEOMETRY_ERRORS.shape, "Geometria non valida.");

  const table = readNormalizedRect(raw.table, "table");
  const subjectColumn = readNormalizedSpan(raw.subjectColumn, "subjectColumn");
  const scheduleGrid = readNormalizedSpan(raw.scheduleGrid, "scheduleGrid");

  // Table: dentro l'immagine e di area positiva.
  if (table.x < -EPSILON || table.y < -EPSILON) throw outOfBounds("table");
  if (table.width <= 0 || table.height <= 0) throw outOfBounds("table");
  if (table.x + table.width > 1 + EPSILON || table.y + table.height > 1 + EPSILON) throw outOfBounds("table");

  // Le due fasce devono stare interamente nella tabella.
  assertSpanInImage(subjectColumn, "subjectColumn");
  assertSpanInImage(scheduleGrid, "scheduleGrid");
  const tableEnd = table.x + table.width;
  if (subjectColumn.x < table.x - EPSILON || subjectColumn.x + subjectColumn.width > tableEnd + EPSILON) {
    throw outOfBounds("subjectColumn fuori da table");
  }
  if (scheduleGrid.x < table.x - EPSILON || scheduleGrid.x + scheduleGrid.width > tableEnd + EPSILON) {
    throw outOfBounds("scheduleGrid fuori da table");
  }

  // MATERIA e griglia non devono sovrapporsi: la composizione le affianca, e una
  // sovrapposizione significa che una delle due misure è sbagliata.
  const overlap = Math.min(subjectColumn.x + subjectColumn.width, scheduleGrid.x + scheduleGrid.width)
    - Math.max(subjectColumn.x, scheduleGrid.x);
  if (overlap > EPSILON) {
    throw new TimetableGeometryError(
      GEOMETRY_ERRORS.overlap,
      "Colonna MATERIA e griglia si sovrappongono: geometria non utilizzabile.",
    );
  }

  const geometry: TimetableGridGeometry = { table, subjectColumn, scheduleGrid, periodsPerDay };
  // Verifica esplicita che ogni colonna derivata resti dentro la griglia.
  const columns = derivePeriodColumns(geometry);
  if (columns.length !== totalPeriodColumns(periodsPerDay)) {
    throw new TimetableGeometryError(GEOMETRY_ERRORS.columns, "Numero di colonne della griglia non coerente.");
  }
  const first = columns[0].span;
  const last = columns[columns.length - 1].span;
  const gridEnd = scheduleGrid.x + scheduleGrid.width;
  if (first.x < scheduleGrid.x - EPSILON || last.x + last.width > gridEnd + EPSILON) {
    throw new TimetableGeometryError(GEOMETRY_ERRORS.columns, "Colonne derivate fuori dalla griglia.");
  }
  return geometry;
}

/**
 * Deriva le colonne orarie dividendo la griglia in parti UGUALI.
 *
 * `columnWidth = scheduleGrid.width / (PERSONAL_SCHOOL_DAYS * periodsPerDay)`
 * `columnX(i)  = scheduleGrid.x + i * columnWidth`
 */
export function derivePeriodColumns(geometry: TimetableGridGeometry): PeriodColumn[] {
  const total = totalPeriodColumns(geometry.periodsPerDay);
  const columnWidth = geometry.scheduleGrid.width / total;
  const columns: PeriodColumn[] = [];
  for (let dayOfWeek = 1; dayOfWeek <= PERSONAL_SCHOOL_DAYS; dayOfWeek += 1) {
    for (let periodIndex = 1; periodIndex <= geometry.periodsPerDay; periodIndex += 1) {
      const columnIndex = physicalColumnIndex(dayOfWeek, periodIndex, geometry.periodsPerDay);
      columns.push({
        columnNumber: columnIndex + 1,
        columnIndex,
        dayOfWeek,
        periodIndex,
        span: { x: geometry.scheduleGrid.x + columnIndex * columnWidth, width: columnWidth },
      });
    }
  }
  return columns;
}

/**
 * Specifica di composizione per UNA coordinata: MATERIA + la colonna oraria di
 * quel giorno/ora, con la stessa estensione verticale (l'intera tabella).
 *
 * La coordinata è verificata: giorno 1..`PERSONAL_SCHOOL_DAYS`, ora
 * 1..`periodsPerDay`. Una coordinata fuori dalla griglia dichiarata è un errore,
 * non un crop vuoto.
 */
export function subjectColumnCropSpec(
  geometry: TimetableGridGeometry,
  dayOfWeek: number,
  periodIndex: number,
): SubjectColumnCropSpec {
  if (!isFiniteNumber(dayOfWeek) || !Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > PERSONAL_SCHOOL_DAYS) {
    throw new TimetableGeometryError(GEOMETRY_ERRORS.columns, "Giorno della coordinata fuori dalla griglia.");
  }
  if (!isFiniteNumber(periodIndex) || !Number.isInteger(periodIndex) || periodIndex < 1 || periodIndex > geometry.periodsPerDay) {
    throw new TimetableGeometryError(GEOMETRY_ERRORS.columns, "Ora della coordinata fuori dalla griglia dichiarata.");
  }
  const columns = derivePeriodColumns(geometry);
  const column = columns[physicalColumnIndex(dayOfWeek, periodIndex, geometry.periodsPerDay)];
  return {
    dayOfWeek,
    periodIndex,
    columnNumber: column.columnNumber,
    subject: { x: geometry.subjectColumn.x, width: geometry.subjectColumn.width },
    column: { x: column.span.x, width: column.span.width },
    // Stessa origine e stessa altezza per le due fasce: è ciò che tiene le righe
    // allineate senza chiedere alcun allineamento al modello.
    sourceY: geometry.table.y,
    sourceHeight: geometry.table.height,
  };
}

/**
 * Coordinate normalizzate -> pixel interi.
 *
 * `pixel = round(normalized * dimensione)`, poi ogni rettangolo è verificato
 * contro i bordi reali dell'immagine: un crop che uscirebbe dal foto è un
 * errore, non un ritaglio silenzioso.
 */
export function toPixelRect(
  span: NormalizedSpan,
  sourceY: number,
  sourceHeight: number,
  imageWidth: number,
  imageHeight: number,
): PixelRect {
  if (!isFiniteNumber(imageWidth) || !isFiniteNumber(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    throw new TimetableGeometryError(GEOMETRY_ERRORS.pixels, "Dimensioni immagine non valide.");
  }
  const x = Math.round(span.x * imageWidth);
  const width = Math.round(span.width * imageWidth);
  const y = Math.round(sourceY * imageHeight);
  const height = Math.round(sourceHeight * imageHeight);
  if (width <= 0 || height <= 0) throw new TimetableGeometryError(GEOMETRY_ERRORS.pixels, "Crop di dimensione nulla.");
  if (x < 0 || y < 0 || x + width > imageWidth || y + height > imageHeight) {
    throw new TimetableGeometryError(GEOMETRY_ERRORS.pixels, "Crop fuori dai bordi dell'immagine.");
  }
  return { x, y, width, height };
}

/** I due rettangoli sorgente di una composizione, in pixel. */
export function subjectColumnCropPixels(
  spec: SubjectColumnCropSpec,
  imageWidth: number,
  imageHeight: number,
): { subject: PixelRect; column: PixelRect } {
  return {
    subject: toPixelRect(spec.subject, spec.sourceY, spec.sourceHeight, imageWidth, imageHeight),
    column: toPixelRect(spec.column, spec.sourceY, spec.sourceHeight, imageWidth, imageHeight),
  };
}
