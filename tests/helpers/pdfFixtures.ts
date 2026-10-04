/**
 * Fixture PDF sintetiche e minimali generate a runtime (NESSUN file scolastico
 * reale committato). Costruiscono PDF validi "a mano" con un text layer reale,
 * così i test di estrazione testo usano file realistici senza dipendere da
 * librerie di generazione PDF aggiuntive.
 */

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Costruisce un PDF minimale e valido con una pagina per ogni array di righe
 * ricevuto. Scrive manualmente la tabella xref con offset corretti.
 */
export function buildMinimalPdf(pagesLines: string[][]): Buffer {
  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];
  let nextNum = 3;
  pagesLines.forEach(() => {
    pageObjNums.push(nextNum++);
    contentObjNums.push(nextNum++);
  });
  const fontObjNum = nextNum;

  const objStrings: string[] = [];
  objStrings[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  objStrings[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageObjNums.length} >>\nendobj\n`;

  pagesLines.forEach((lines, idx) => {
    const pageNum = pageObjNums[idx];
    const contentNum = contentObjNums[idx];
    objStrings[pageNum] =
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> ` +
      `/MediaBox [0 0 612 792] /Contents ${contentNum} 0 R >>\nendobj\n`;
    let y = 740;
    const parts = ["BT", "/F1 12 Tf"];
    for (const line of lines) {
      parts.push(`1 0 0 1 72 ${y} Tm (${escapePdfText(line)}) Tj`);
      y -= 18;
    }
    parts.push("ET");
    const stream = parts.join("\n");
    objStrings[contentNum] =
      `${contentNum} 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`;
  });

  objStrings[fontObjNum] = `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  const totalObjs = fontObjNum;
  let body = "%PDF-1.4\n";
  const offsets = new Array(totalObjs + 1).fill(0);
  for (let i = 1; i <= totalObjs; i++) {
    offsets[i] = Buffer.byteLength(body, "utf8");
    body += objStrings[i];
  }
  const xrefOffset = Buffer.byteLength(body, "utf8");
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjs; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, "utf8");
}

/** PDF a una pagina senza alcun testo (text layer vuoto ma documento valido). */
export function buildEmptyPdf(): Buffer {
  return buildMinimalPdf([[]]);
}

/**
 * PDF multipagina sintetico con un piano annuale minimale, per i test di
 * routing. Il testo supera volutamente la soglia di "testo sufficiente"
 * (`PDF_TEXT_SUFFICIENT_MIN_CHARS`), come un vero piano annuale pluripagina.
 */
export function buildMultiPagePlanPdf(): Buffer {
  return buildMinimalPdf([
    [
      "PIANO DELLE ATTIVITA 2026/2027",
      "Istituto Comprensivo di Prova",
      "",
      "SETTEMBRE",
    ],
    [
      "4 settembre 2026",
      "Collegio docenti ore 09:00-11:00",
      "Ordine del giorno: avvio anno scolastico, assegnazione classi",
    ],
    [
      "OTTOBRE",
      "12 ottobre 2026",
      "Consiglio di classe 3E ore 15:00-16:00",
      "Presenti i docenti del consiglio e un rappresentante dei genitori",
    ],
    [
      "NOVEMBRE",
      "5 novembre 2026",
      "GLO classe 2D ore 14:30-15:30",
      "Partecipano famiglia, referente inclusione e specialisti ASL",
    ],
  ]);
}

/**
 * Bytes che superano il controllo di firma `%PDF-` (così arrivano fino alla
 * nostra estrazione, non bloccati prima dalla validazione generica
 * dell'upload) ma non sono un PDF interpretabile: la struttura dopo l'header
 * è volutamente corrotta, per simulare un PDF non valido/non interpretabile.
 */
export function buildInvalidPdf(): Buffer {
  return Buffer.from("%PDF-1.4\nquesto non e' un documento PDF interpretabile, struttura corrotta a caso", "utf8");
}

/** Bytes che non hanno nemmeno la firma `%PDF-` (rifiutati dalla validazione generica dell'upload). */
export function buildNonPdfBytes(): Buffer {
  return Buffer.from("questo non e' un documento PDF valido, solo bytes qualsiasi", "utf8");
}
