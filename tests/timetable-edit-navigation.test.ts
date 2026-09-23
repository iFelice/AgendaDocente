import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import {
  backFromSlotEdit,
  clearSlotEdit,
  initialSlotEditNavigation,
  isSlotEditOpen,
  openSlotForEdit,
  type SlotEditOriginView,
} from "../src/utils/timetableEditNavigation";
import type { TimetableSlot } from "../src/types";

/*
 * Navigazione della MODIFICA LEZIONE aperta dal Planning (stesso pattern
 * concettuale di registerNavigation.ts, speculare al registro):
 *
 *  - Oggi/Settimana -> tap su una lezione -> sessione con slot, tipo orario,
 *    origine e data da ripristinare;
 *  - "Indietro" riporta al Planning di ORIGINE sulla stessa data/settimana;
 *  - la navigazione principale chiude la sessione senza lasciare tracce;
 *  - Mese non è un'origine possibile (non mostra TimetableSlot): la garanzia è
 *    a compile-time, non un runtime fallback;
 *  - le transizioni sono pure: né lo slot originale né lo stato precedente
 *    vengono mai mutati.
 *
 * La utility è indipendente dalla UI: nessun React state, nessun storage,
 * nessun DOM, nessun browser history (test n. 10).
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Slot "base" completo dei campi opzionali: la sessione non ne perde nessuno. */
function richSlot(overrides: Partial<TimetableSlot> = {}): TimetableSlot {
  return {
    id: "tt-101",
    dayOfWeek: 2,
    periodNumber: 3,
    startTime: "09:40",
    endTime: "10:35",
    subject: "Matematica",
    className: "1A",
    classroom: "Aula 12",
    campus: "Sede Centrale",
    color: "#34d399",
    isProvisional: false,
    coTeachingSubjects: ["Matematica", "Scienze"],
    coSupportTeachers: ["Anna Bianchi"],
    supportTeachers: ["Anna Bianchi", "Luca Verdi"],
    schoolId: "school-00000001",
    ...overrides,
  };
}

test("1. apertura da Oggi (definitivo): slot, tipo, origine e data sono conservati", () => {
  const slot = richSlot();
  const nav = openSlotForEdit(slot, "definitivo", "oggi", "2026-09-21");

  assert.ok(isSlotEditOpen(nav), "la sessione è aperta");
  assert.equal(nav.slot?.id, "tt-101", "lo slot è conservato");
  assert.equal(nav.type, "definitivo", "il tipo orario è quello attivo al tap");
  assert.equal(nav.originView, "oggi", "l'origine è la vista Oggi");
  assert.equal(nav.originDateIso, "2026-09-21", "la data selezionata in Oggi è preservata");
});

test("2. apertura da Oggi (provvisorio): il tipo provvisorio è preservato", () => {
  const nav = openSlotForEdit(richSlot({ isProvisional: true }), "provvisorio", "oggi", "2026-09-18");
  assert.equal(nav.type, "provvisorio");
  assert.equal(nav.slot?.isProvisional, true, "anche il flag dello slot resta intatto");
  assert.equal(nav.originView, "oggi");
});

test("3. apertura da Settimana: origine settimana e data della settimana visualizzata", () => {
  // La data è quella reale del giorno visualizzato (es. martedì della settimana -1).
  const nav = openSlotForEdit(richSlot(), "definitivo", "settimana", "2026-09-15");
  assert.equal(nav.originView, "settimana");
  assert.equal(nav.originDateIso, "2026-09-15", "al ritorno WeekView ripristina la settimana di questa data");
});

test("4. slot ricco: schoolId, compresenze e campi opzionali senza perdita", () => {
  const slot = richSlot();
  const nav = openSlotForEdit(slot, "definitivo", "settimana", "2026-09-22");

  assert.deepEqual(nav.slot, slot, "tutti i campi sono conservati senza perdita");
  assert.equal(nav.slot?.schoolId, "school-00000001");
  assert.deepEqual(nav.slot?.coTeachingSubjects, ["Matematica", "Scienze"]);
  assert.deepEqual(nav.slot?.coSupportTeachers, ["Anna Bianchi"]);
  assert.deepEqual(nav.slot?.supportTeachers, ["Anna Bianchi", "Luca Verdi"]);
  assert.equal(nav.slot?.classroom, "Aula 12");
  assert.equal(nav.slot?.campus, "Sede Centrale");
});

test("5. open non muta lo slot originale (copia nella sessione, array inclusi)", () => {
  const slot = richSlot();
  const nav = openSlotForEdit(slot, "definitivo", "oggi", "2026-09-21");

  assert.notEqual(nav.slot, slot, "la sessione conserva una copia, non il riferimento");
  nav.slot!.subject = "Storia";
  nav.slot!.coTeachingSubjects?.push("Fisica");

  assert.equal(slot.subject, "Matematica", "la materia originale non è cambiata");
  assert.deepEqual(slot.coTeachingSubjects, ["Matematica", "Scienze"], "gli array originali non sono mutati");
});

test("6. back restituisce la vista di ritorno e la data da ripristinare", () => {
  const nav = openSlotForEdit(richSlot(), "provvisorio", "settimana", "2026-09-15");
  const back = backFromSlotEdit(nav);

  assert.equal(back.targetView, "settimana", "il ritorno va alla vista di origine");
  assert.equal(back.targetDateIso, "2026-09-15", "la settimana di origine è ripristinabile");
  assert.equal(isSlotEditOpen(back.next), false, "dopo il ritorno la sessione è chiusa");
  assert.equal(back.next.slot, null);
  assert.equal(back.next.type, null);
  assert.equal(back.next.originView, null);
  assert.equal(back.next.originDateIso, null);

  // Lo stesso per Oggi.
  const backOggi = backFromSlotEdit(openSlotForEdit(richSlot(), "definitivo", "oggi", "2026-09-28"));
  assert.equal(backOggi.targetView, "oggi");
  assert.equal(backOggi.targetDateIso, "2026-09-28");

  // Senza sessione aperta nessun target: nessun fallback silenzioso su "oggi".
  const emptyBack = backFromSlotEdit(initialSlotEditNavigation);
  assert.equal(emptyBack.targetView, null);
  assert.equal(emptyBack.targetDateIso, null);
  assert.equal(isSlotEditOpen(emptyBack.next), false);
});

test("7. clear chiude la sessione (abbandono via navigazione principale)", () => {
  const nav = openSlotForEdit(richSlot(), "definitivo", "oggi", "2026-09-21");
  const cleared = clearSlotEdit(nav);

  assert.equal(isSlotEditOpen(cleared), false);
  assert.deepEqual(cleared, initialSlotEditNavigation, "lo stato chiuso coincide con lo stato iniziale");
});

test("8. back e clear non mutano lo stato precedente", () => {
  const nav = openSlotForEdit(richSlot(), "definitivo", "settimana", "2026-09-15");

  const back = backFromSlotEdit(nav);
  back.next.slot = richSlot({ id: "intruso" });
  back.next.originView = "oggi";
  assert.equal(nav.slot?.id, "tt-101", "back: lo stato precedente non è toccato");
  assert.equal(nav.originView, "settimana");
  assert.notEqual(back.next, nav, "back restituisce uno stato nuovo");

  const cleared = clearSlotEdit(nav);
  cleared.slot = richSlot({ id: "intruso2" });
  cleared.type = "provvisorio";
  assert.equal(nav.slot?.id, "tt-101", "clear: lo stato precedente non è toccato");
  assert.equal(nav.type, "definitivo");
  assert.notEqual(cleared, nav, "clear restituisce uno stato nuovo");
});

test("9. l'origine può essere SOLO oggi|settimana (garanzia a compile-time)", () => {
  // L'unione ristretta rende gli stati sbagliati IMPOSSIBILI a compilazione:
  // ogni riga sotto è un errore di tipo che tsc deve segnalare. Se una di
  // queste righe diventasse valida, @ts-expect-error fallirebbe il lint.
  const slot = richSlot();
  // @ts-expect-error "mese" non è un'origine: MonthView non mostra TimetableSlot
  openSlotForEdit(slot, "definitivo", "mese", "2026-09-21");
  // @ts-expect-error "registro" non è un'origine del planning delle lezioni
  openSlotForEdit(slot, "definitivo", "registro", "2026-09-21");
  // @ts-expect-error "orario" non è un'origine (è la destinazione della modifica)
  openSlotForEdit(slot, "definitivo", "orario", "2026-09-21");
  // @ts-expect-error "classi" non è un'origine
  openSlotForEdit(slot, "definitivo", "classi", "2026-09-21");

  // A runtime l'unione è verificabile solo per i due valori legittimi:
  const validOrigins: SlotEditOriginView[] = ["oggi", "settimana"];
  for (const origin of validOrigins) {
    const nav = openSlotForEdit(slot, "definitivo", origin, "2026-09-21");
    assert.equal(nav.originView, origin);
  }
});

test("10. la utility non dipende da DOM, browser o storage", () => {
  const source = readFileSync(resolve(here, "../src/utils/timetableEditNavigation.ts"), "utf8");
  for (const forbidden of ["window.", "document.", "localStorage", "sessionStorage", "indexedDB", "history.pushState", "history.back", "fetch(", "react"]) {
    assert.ok(!source.includes(forbidden), `nessun riferimento a "${forbidden}"`);
  }
  assert.ok(!/^import .*from\s+["']react["']$/m.test(source), "nessun import React");
});
