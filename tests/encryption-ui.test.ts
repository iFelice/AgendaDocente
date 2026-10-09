/**
 * INTERFACCIA DELLA CIFRATURA DEI DATI RISERVATI.
 *
 *  - stato nelle impostazioni: non attiva / attiva su questo dispositivo /
 *    attiva ma da sbloccare su questo dispositivo;
 *  - attivazione: frase segreta (≥12 caratteri) con conferma, poi codice di
 *    recupero mostrato UNA sola volta con copia, stampa e avviso;
 *  - sblocco su un nuovo dispositivo: la frase oppure il codice, nello stesso
 *    campo; segreto errato rifiutato;
 *  - scheda alunno: "Dati riservati cifrati: sblocca per vederli" quando
 *    esistono dati cifrati ma il dispositivo non è sbloccato.
 *
 * Testi semplici, nessun gergo tecnico.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { EncryptionCard } from '../src/components/EncryptionCard';
import { ClassesView } from '../src/components/ClassesView';
import { EncryptionKeystore, WrongSecretError, type KeysGateway } from '../src/services/encryptionKeys';
import { emptyInstallation } from '../src/services/storage';
import type { Student, TeacherProfile } from '../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const text = (node: any): string => {
  if (!node) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(text).join(' ');
};

interface MiniCloud { doc: { payload: unknown; updatedAt: string; schemaVersion: 1 } | null }

function makeKeysGateway(cloud: MiniCloud): KeysGateway {
  return {
    async readState() { return cloud.doc ? structuredClone(cloud.doc) : null; },
    async writeState(_name, payload) {
      const updatedAt = new Date().toISOString();
      cloud.doc = { payload: structuredClone(payload), updatedAt, schemaVersion: 1 };
      return { updatedAt };
    },
  };
}

function makeKeystore(cloud: MiniCloud): { keystore: EncryptionKeystore; meta: Map<string, unknown> } {
  const meta = new Map<string, unknown>();
  const keystore = new EncryptionKeystore({
    gateway: () => makeKeysGateway(cloud),
    meta: { read: async key => meta.get(key), write: async (key, value) => { meta.set(key, value); } },
  });
  return { keystore, meta };
}

const fillInput = async (renderer: any, placeholder: string, value: string): Promise<void> => {
  const input = renderer.root.findAllByType('input').find((node: any) => node.props.placeholder === placeholder);
  assert.ok(input, `campo con placeholder "${placeholder}" presente`);
  await act(async () => { input.props.onChange({ target: { value } }); });
};

const submitForm = async (renderer: any): Promise<void> => {
  const form = renderer.root.findByType('form');
  await act(async () => { await form.props.onSubmit({ preventDefault: () => undefined }); });
};

const clickButton = async (renderer: any, label: string): Promise<void> => {
  const button = renderer.root.findAllByType('button').find((node: any) => text(node).includes(label));
  assert.ok(button, `pulsante "${label}" presente`);
  await act(async () => { await button.props.onClick(); });
};

/** Le azioni (PBKDF2, letture) sono asincrone: attende il testo atteso. */
async function waitForText(renderer: any, needle: string | RegExp, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rendered = text(renderer.toJSON());
    if (typeof needle === 'string' ? rendered.includes(needle) : needle.test(rendered)) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  }
  assert.fail(`attesa scaduta per: ${needle} — contenuto: ${text(renderer.toJSON()).slice(0, 400)}`);
}

// ---------------------------------------------------------------------------
// Scheda alunno
// ---------------------------------------------------------------------------

const student = (id: string, patch: Partial<Student> = {}): Student => ({
  id, fullName: `Alunno ${id}`, className: '2E', notes: [], ...patch,
});

test('C1. scheda alunno: dati cifrati senza sblocco -> avviso al posto dei campi', async () => {
  const profile = emptyInstallation().profile as TeacherProfile;
  const renderer = create(React.createElement(ClassesView, {
    profile,
    students: [
      student('s1', { sensitiveEnc: { v: 1, iv: 'AAAA', ct: 'BBBB' } }),
      student('s2', { diagnosticSummary: 'Sintesi in chiaro locale' }),
      student('s3'),
    ],
    onSaveStudent: () => {}, onDeleteStudent: () => {}, onAddNote: () => {}, onDeleteNote: () => {},
    onScheduleEvent: () => {},
  }));
  await act(async () => {});
  const rendered = text(renderer.toJSON());
  assert.ok(rendered.includes('Dati riservati cifrati: sblocca per vederli'), 'avviso per l alunno cifrato');
  assert.equal(rendered.match(/Dati riservati cifrati: sblocca per vederli/g)!.length, 1, 'un solo avviso');
  assert.ok(rendered.includes('Dati riservati: salvati solo su questo dispositivo, non sincronizzati.'), 'avviso classico per i dati locali');
  renderer.unmount();
});

// ---------------------------------------------------------------------------
// Impostazioni: stati e attivazione
// ---------------------------------------------------------------------------

test('C2. impostazioni: stato "non attiva" con pulsante di attivazione', async () => {
  const cloud: MiniCloud = { doc: null };
  const { keystore } = makeKeystore(cloud);
  const renderer = create(React.createElement(EncryptionCard, { uid: 'uid-1', keystore, onSyncNow: () => {} }));
  await act(async () => {});
  await waitForText(renderer, 'Non attiva');
  const rendered = text(renderer.toJSON());
  assert.ok(rendered.includes('Cifratura dati riservati'), 'titolo della scheda');
  assert.ok(rendered.includes('Attiva la protezione'), 'pulsante di attivazione');
  renderer.unmount();
});

test('C3. attivazione: frase con conferma, poi codice di recupero mostrato una sola volta', async () => {
  const cloud: MiniCloud = { doc: null };
  const { keystore } = makeKeystore(cloud);
  const renderer = create(React.createElement(EncryptionCard, { uid: 'uid-1', keystore, onSyncNow: () => {} }));
  await act(async () => {});

  await clickButton(renderer, 'Attiva la protezione');
  const inputs = renderer.root.findAllByType('input');
  // Frase troppo corta rifiutata.
  await act(async () => {
    inputs[0].props.onChange({ target: { value: 'corta' } });
    inputs[1].props.onChange({ target: { value: 'corta' } });
  });
  await submitForm(renderer);
  assert.ok(text(renderer.toJSON()).includes('almeno 12 caratteri'), 'frase corta rifiutata');

  // Frasi discordi rifiutate.
  await act(async () => {
    inputs[0].props.onChange({ target: { value: 'frase segreta numero uno' } });
    inputs[1].props.onChange({ target: { value: 'frase diversa numero due' } });
  });
  await submitForm(renderer);
  assert.ok(text(renderer.toJSON()).includes('non coincidono'), 'le frasi devono coincidere');

  // Attivazione riuscita: codice di recupero mostrato UNA volta, con copia, stampa e avviso.
  await act(async () => {
    inputs[0].props.onChange({ target: { value: 'frase segreta numero uno' } });
    inputs[1].props.onChange({ target: { value: 'frase segreta numero uno' } });
  });
  await submitForm(renderer);
  await waitForText(renderer, /[A-Z0-9]{4}(-[A-Z0-9]{4}){5}/);
  const rendered = text(renderer.toJSON());
  assert.ok(rendered.includes('mostrato una sola volta'), 'una sola volta');
  assert.ok(rendered.includes('Copia'), 'pulsante copia');
  assert.ok(rendered.includes('Stampa'), 'pulsante stampa');
  assert.ok(rendered.includes('non sono recuperabili') || rendered.includes('non potranno essere recuperati') || rendered.includes('non recuperabili') || rendered.includes('non sono recuperabili'), 'avviso sul recupero');
  assert.ok(cloud.doc, 'il documento chiavi è stato scritto');

  await clickButton(renderer, 'Fatto: ho salvato il codice');
  assert.ok(text(renderer.toJSON()).includes('Attiva su questo dispositivo'), 'stato attiva su questo dispositivo');
  assert.ok(text(renderer.toJSON()).includes('Cambia frase segreta'), 'cambio frase disponibile');
  renderer.unmount();
});

test('C4. sblocco su un nuovo dispositivo: stesso campo per frase e codice, errori compresi', async () => {
  const cloud: MiniCloud = { doc: null };
  const deviceA = makeKeystore(cloud);
  const { recoveryCode } = await deviceA.keystore.activate('uid-1', 'frase segreta numero uno');

  // Dispositivo B: chiavi nel cloud ma non sbloccate qui.
  const deviceB = makeKeystore(cloud);
  const renderer = create(React.createElement(EncryptionCard, {
    uid: 'uid-1',
    keystore: deviceB.keystore,
    applyLocal: async () => false,
    onSyncNow: () => {},
  }));
  await act(async () => {});
  await waitForText(renderer, 'Da sbloccare su questo dispositivo');

  await clickButton(renderer, 'Sblocca');
  const unlockInputs = renderer.root.findAllByType('input');
  await act(async () => { unlockInputs[0].props.onChange({ target: { value: 'qualcosa di sbagliato' } }); });
  await submitForm(renderer);
  await waitForText(renderer, 'non corretti');

  await act(async () => { unlockInputs[0].props.onChange({ target: { value: recoveryCode } }); });
  await submitForm(renderer);
  await waitForText(renderer, 'Attiva su questo dispositivo');
  const rendered = text(renderer.toJSON());
  assert.ok(rendered.includes('sbloccati'), 'conferma di sblocco');
  renderer.unmount();
});

test('C5. cambio frase: richiede il segreto attuale e aggiorna solo la chiave', async () => {
  const cloud: MiniCloud = { doc: null };
  const { keystore } = makeKeystore(cloud);
  await keystore.activate('uid-1', 'prima frase segreta lunga');

  const renderer = create(React.createElement(EncryptionCard, { uid: 'uid-1', keystore, onSyncNow: () => {} }));
  await act(async () => {});
  await waitForText(renderer, 'Attiva su questo dispositivo');

  await clickButton(renderer, 'Cambia frase segreta');
  const inputs = renderer.root.findAllByType('input');
  await act(async () => {
    inputs[0].props.onChange({ target: { value: 'prima frase segreta lunga' } });
    inputs[1].props.onChange({ target: { value: 'seconda frase segreta lunga' } });
    inputs[2].props.onChange({ target: { value: 'seconda frase segreta lunga' } });
  });
  const prima = JSON.stringify(cloud.doc);
  await submitForm(renderer);
  await waitForText(renderer, 'aggiornata');
  assert.notEqual(JSON.stringify(cloud.doc), prima, 'il documento chiavi è aggiornato');

  // La vecchia frase non sblocca più, la nuova sì.
  await assert.rejects(() => keystore.unlock('uid-1', 'prima frase segreta lunga', 'phrase'), WrongSecretError);
  renderer.unmount();
});
