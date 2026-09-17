/**
 * Composizione del crop diagnostico: MATERIA | COLONNA ORARIA.
 *
 * È l'UNICO punto del progetto che tocca `<canvas>`/`drawImage`. Tutta la
 * matematica (geometria, colonne, conversione in pixel) sta in
 * `timetableCrops.ts` ed è testabile senza DOM; qui si esegue soltanto il
 * disegno di due rettangoli già calcolati.
 *
 * Le due fasce sono disegnate con lo STESSO `sourceY` e la stessa
 * `sourceHeight`, quindi le righe della tabella restano allineate per
 * costruzione: l'allineamento non è delegato al modello.
 *
 * PRIVACY / EPHEMERALITÀ
 * L'immagine prodotta è un `Blob` in memoria destinato a un object URL della
 * preview diagnostica. Non viene scritta su disco, non viene salvata in
 * IndexedDB/Firestore, non entra nei backup e non viene loggata: chi la usa DEVE
 * revocare l'object URL (`revokePreviewUrl`) quando la preview scompare.
 */

import type { PixelRect, SubjectColumnCropSpec } from "./timetableCrops";
import { subjectColumnCropPixels } from "./timetableCrops";

/** Sorgente disegnabile: `HTMLImageElement` o `ImageBitmap`. */
export type CroppableImageSource = CanvasImageSource;

/** Separatore visivo fra le due fasce: aiuta l'occhio nel test reale. */
const GAP_PX = 8;
/** Larghezza minima di una fascia in pixel: sotto questa soglia il crop è inutile. */
export const MIN_STRIP_WIDTH_PX = 24;

/** Risultato della composizione: solo dati in memoria. */
export interface ComposedCropResult {
  blob: Blob;
  width: number;
  height: number;
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * Compone `[MATERIA] | [COLONNA TARGET]` a partire dai rettangoli in pixel.
 *
 * Nessuna lettura dei pixel (`getImageData`), nessuna persistenza: due
 * `drawImage` e un `toBlob`.
 */
export async function composeSubjectAndColumn(
  image: CroppableImageSource,
  rects: { subject: PixelRect; column: PixelRect },
  gapPx: number = GAP_PX,
): Promise<ComposedCropResult> {
  const { subject, column } = rects;
  const width = subject.width + gapPx + column.width;
  const height = Math.max(subject.height, column.height);
  const canvas = canvasOf(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Composizione del crop non disponibile in questo ambiente.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  // Stessa origine verticale per entrambe le fasce: righe allineate per costruzione.
  context.drawImage(image, subject.x, subject.y, subject.width, subject.height, 0, 0, subject.width, subject.height);
  context.drawImage(
    image,
    column.x,
    column.y,
    column.width,
    column.height,
    subject.width + gapPx,
    0,
    column.width,
    column.height,
  );
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), "image/png"));
  if (!blob) throw new Error("Composizione del crop non riuscita.");
  return { blob, width, height };
}

/**
 * Scorciatoia per la preview diagnostica: specifica normalizzata + dimensioni
 * reali dell'immagine -> crop composto. Le dimensioni servono alla conversione
 * normalizzato -> pixel, che resta in `timetableCrops.ts`.
 */
export async function composeCropForCoordinate(
  image: CroppableImageSource,
  spec: SubjectColumnCropSpec,
  imageWidth: number,
  imageHeight: number,
): Promise<ComposedCropResult> {
  const rects = subjectColumnCropPixels(spec, imageWidth, imageHeight);
  if (rects.subject.width < MIN_STRIP_WIDTH_PX || rects.column.width < MIN_STRIP_WIDTH_PX) {
    // Non è un errore di geometria ma un crop inutilizzabile: meglio dirlo che
    // mostrare una striscia illeggibile e farla passare per un buon risultato.
    throw new Error("Crop troppo stretto per essere leggibile: avvicina o raddrizza la foto.");
  }
  return composeSubjectAndColumn(image, rects);
}

/**
 * Carica un'immagine da un object URL (o data URL) già creato in memoria.
 *
 * Restituisce l'elemento (sorgente per `drawImage`) insieme alle dimensioni
 * reali, che servono alla conversione normalizzato -> pixel.
 */
export function loadImage(url: string): Promise<{ image: HTMLImageElement; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ image, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Immagine non leggibile per la preview del crop."));
    image.src = url;
  });
}

/** Solo le immagini raster sono ritagliabili: un PDF non ha pixel da comporre. */
export function isCroppableMimeType(mimeType: string): boolean {
  return /^image\/(png|jpeg|webp)$/i.test(String(mimeType ?? ""));
}
