/**
 * Fallback Groq Vision per `/api/analyze-timetable`.
 *
 * perché esiste: su Render l'analisi dell'orario curricolare falliva PRIMA di
 * essere elaborata con `[AI Orari] analisi cloud non riuscita
 * categoria=sovraccarico tentativi=[gemini-3.8-flash:sovraccarico,
 * gemini-3.8-flash:sovraccarico]`. Un 503 "sovraccarico" è transitorio per
 * definizione: la richiesta è corretta, il fornitore in quel momento non
 * risponde. Riprovare lo stesso fornitore dopo due tentativi ravvicinati spesso
 * riproduce lo stesso esito, mentre un secondo fornitore con la stessa richiesta
 * ha buone probabilità di riuscire.
 *
 * perché è un FALLBACK e non un secondo provider in cascata: Groq entra in gioco
 * SOLO dopo che Gemini ha esaurito i propri tentativi E il fallimento è
 * classificato transitorio (`isTransientGeminiCategory`). Non entra mai su un
 * errore deterministico — request non valida, `coordinateScope` non valido,
 * profilo non valido, MIME non supportato, schema rifiutato — perché in quei casi
 * la richiesta è sbagliata e un altro modello risponderebbe sbagliato allo stesso
 * modo, bruciando quota.
 *
 * perché il contratto non cambia: Groq riceve ESATTAMENTE il prompt già
 * costruito per Gemini (`buildPersonalTimetablePrompt` /
 * `buildCurricularTimetablePrompt`), la stessa immagine e lo stesso obiettivo
 * JSON, espresso come Structured Output (`response_format: json_schema`) derivato
 * dallo schema Gemini già usato dall'endpoint. Il testo che torna passa poi negli
 * STESSI `parseGeminiJson` e `parseTimetableAiResponse`: il provider non può
 * bypassare `validatePersonalSequencePayload` / `validateCurricularTargetsPayload`.
 * Un JSON di Groq non conforme è un 422 esattamente come uno di Gemini.
 *
 * perché nessuna dipendenza nuova: l'API Groq è OpenAI-compatible, quindi basta
 * una POST con `fetch` nativo. Aggiungere `groq-sdk` per una chiamata sola
 * sarebbe più superficie di quanta ne serva.
 *
 * Privacy: la chiave vive solo in `process.env.GROQ_API_KEY` (mai nel client,
 * mai in una `VITE_*`, mai nei log) e i log riportano SOLO modello, categoria,
 * status e durata. Mai immagine/base64, OCR, prompt, JSON del modello, classi,
 * materie o nomi.
 */

/** Endpoint OpenAI-compatible di Groq (chat completions). */
export const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Modello di fallback. Vision + structured output; `qwen/qwen3.8-27b` accetta
 * `reasoning_effort: "none"` e `reasoning_format: "hidden"`, cioè estrazione
 * deterministica senza catena di pensiero nell'output.
 * `GROQ_VISION_MODEL` (solo server) permette di cambiarlo senza rifare il build.
 */
export const GROQ_VISION_MODEL_DEFAULT = "qwen/qwen3.8-27b";
const GROQ_MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,63}$/;

/**
 * Estrazione visiva deterministica: temperatura 0 e reasoning minimo. La
 * tabella è trascrizione, non ragionamento — lo stesso motivo per cui Gemini
 * riceve `thinkingLevel: "low"`. `reasoning_format: "hidden"` garantisce che
 * nessuna catena di pensiero finisca nella risposta (e quindi nei log).
 */
export const GROQ_TEMPERATURE = 0;
export const GROQ_REASONING_EFFORT = "none";
export const GROQ_REASONING_FORMAT = "hidden";

/** Margine riservato alla scrittura della risposta dopo il tentativo Groq. */
export const GROQ_RESPONSE_RESERVE_MS = 2_000;
/** Sotto questa soglia un tentativo Groq non può concludersi: si salta il fallback. */
export const GROQ_MIN_ATTEMPT_MS = 5_000;

/**
 * H5 — Budget RISERVATO al percorso Groq a due passaggi dell'orario personale.
 *
 * Problema reale osservato su Render: `gemini-3.7-flash` ha consumato ~41 s e
 * Groq è stato saltato per `budget-esaurito`, pur rispondendo nei test reali in
 * 0.4–0.9 s. Quando il documento è un'immagine e `GROQ_API_KEY` è configurata,
 * Gemini NON deve poter consumare tutto `TIMETABLE_ANALYSIS_TIMEOUT_MS`: si
 * riserva a Groq questa finestra complessiva. Il deadline TOTALE dell'endpoint
 * NON cambia — cambia solo il budget concesso a Gemini.
 */
export const GROQ_TIMETABLE_RESERVED_MS = 10_000;

/**
 * Quota del budget Groq residuo destinata al Passo A (identificazione riga). Il
 * resto (60%) va al Passo B (trascrizione). Divisione deterministica: nessun
 * timeout indipendente che possa superare il deadline.
 */
export const GROQ_TWO_PASS_A_SHARE = 0.4;

/**
 * Un passaggio del percorso a due fasi è leggero (0.4–0.9 s nei tentativi reali):
 * la soglia minima è molto più bassa di quella della lettura monolitica
 * (`GROQ_MIN_ATTEMPT_MS`), altrimenti la finestra riservata di 10 s non basterebbe
 * mai a due chiamate. Sotto questa soglia un passaggio non può partire.
 */
export const GROQ_TWO_PASS_MIN_ATTEMPT_MS = 1_500;

/**
 * H6 — AL PIÙ un retry per FASE (Passo A e Passo B) sui soli errori transitori
 * HTTP 429 (`quota`), HTTP 5xx (`sovraccarico`) ed errore di RETE: il primo
 * tentativo più un eventuale secondo = massimo due chiamate per fase, mai di
 * più e sempre dentro il budget della fase (il tempo già consumato dal primo
 * tentativo viene sottratto). La stessa richiesta riproposta una volta può
 * valere su un fallimento transitorio; un terzo tentativo aggiungerebbe solo
 * latenza (Gemini ha già fatto i suoi retry). Nessun retry su 400/
 * richiesta-non-valida, autenticazione, modello-non-trovato, errori di forma
 * (schema/output) o rifiuti H3/H4: lì la richiesta è sbagliata o la risposta è
 * definitiva, e riprovare brucerebbe quota senza cambiare l'esito.
 */
export const GROQ_MAX_CALLS_PER_PHASE = 2;

/** Budget residuo minimo DI FASE sotto il quale il retry non parte. */
export const GROQ_RETRY_MIN_ATTEMPT_MS = GROQ_TWO_PASS_MIN_ATTEMPT_MS;

/**
 * L'unico elenco delle categorie Groq su cui HA SENSO riprovare UNA volta:
 * `quota` (429) e `sovraccarico` (5xx) sono stati transitori del fornitore,
 * `rete` è un fallimento di trasporto prima di qualunque risposta. Tutto il
 * resto — `richiesta-non-valida` (400/422), `chiave-o-permessi` (401/403),
 * `modello-non-trovato` (404), `deadline`, `output-vuoto`, `output-troncato`,
 * `budget-esaurito`, `annullata`, `sconosciuta` — non migliora ripetendo la
 * stessa chiamata e non viene MAI ritentato.
 */
export function groqRetryableCategory(category: GroqFailureCategory | "ok"): boolean {
  return category === "quota" || category === "sovraccarico" || category === "rete";
}

/**
 * Decisione PURA del retry: restituisce il timeout con cui riprovare dentro il
 * budget RESIDUO della fase, oppure 0 (nessun retry). Nessun retry quando la
 * categoria non è transitoria o quando il residuo è sotto soglia.
 */
export function groqRetryAttemptTimeoutMs(category: GroqFailureCategory | "ok", remainingPhaseMs: number): number {
  if (!groqRetryableCategory(category)) return 0;
  const usable = Math.floor(remainingPhaseMs);
  return usable >= GROQ_RETRY_MIN_ATTEMPT_MS ? usable : 0;
}

/**
 * Divide il budget Groq RESIDUO fra Passo A e Passo B, restituendo i due timeout
 * di rete effettivi. È deterministica e pura:
 *  - si sottrae UNA volta il margine di scrittura della risposta finale;
 *  - il tempo utile è diviso `GROQ_TWO_PASS_A_SHARE` (Passo A) / resto (Passo B);
 *  - se anche uno solo dei due passaggi non raggiunge `GROQ_TWO_PASS_MIN_ATTEMPT_MS`,
 *    il percorso non è fattibile e si torna `{ passA: 0, passB: 0 }` (errore
 *    controllato a monte, mai due timeout che sommati sforino il deadline).
 */
export function groqTwoPassBudgets(remainingMs: number): { passA: number; passB: number } {
  const usable = Math.floor(remainingMs) - GROQ_RESPONSE_RESERVE_MS;
  if (usable < GROQ_TWO_PASS_MIN_ATTEMPT_MS * 2) return { passA: 0, passB: 0 };
  const passA = Math.floor(usable * GROQ_TWO_PASS_A_SHARE);
  const passB = usable - passA;
  if (passA < GROQ_TWO_PASS_MIN_ATTEMPT_MS || passB < GROQ_TWO_PASS_MIN_ATTEMPT_MS) {
    return { passA: 0, passB: 0 };
  }
  return { passA, passB };
}

/**
 * Budget effettivo del Passo B calcolato DOPO il Passo A, sul tempo davvero
 * rimasto: mai più della quota pianificata (`plannedPassB`) e mai più del tempo
 * residuo meno il margine di risposta. Se scende sotto la soglia minima torna 0,
 * e il chiamante ferma il percorso con un errore controllato invece di avviare
 * un Passo B che sforerebbe il deadline.
 */
export function groqPassBBudget(remainingAfterPassAMs: number, plannedPassB: number): number {
  const available = Math.floor(remainingAfterPassAMs) - GROQ_RESPONSE_RESERVE_MS;
  const budget = Math.min(Math.floor(plannedPassB), available);
  return budget >= GROQ_TWO_PASS_MIN_ATTEMPT_MS ? budget : 0;
}

/**
 * MIME che Groq Vision accetta come immagine. È `supportedFiles` dei guard meno
 * `application/pdf`: Groq non prende un PDF in `image_url`, e convertire un PDF
 * in pagine raster è una pipeline nuova che questo task non introduce. Per il
 * PDF l'analisi resta Gemini-only.
 */
export const GROQ_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Esito di un tentativo Groq: stessa tassonomia usata per Gemini, nessun contenuto. */
export type GroqFailureCategory =
  | "non-configurato"
  | "mime-non-supportato"
  | "quota"
  | "sovraccarico"
  | "deadline"
  | "rete"
  | "modello-non-trovato"
  | "chiave-o-permessi"
  | "richiesta-non-valida"
  | "output-vuoto"
  | "output-troncato"
  | "budget-esaurito"
  | "annullata"
  | "sconosciuta";

/** Modello di fallback effettivamente usato (env opzionale, solo server). */
export function groqVisionModel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.GROQ_VISION_MODEL ?? "").trim();
  if (!raw) return GROQ_VISION_MODEL_DEFAULT;
  if (!GROQ_MODEL_NAME_RE.test(raw)) {
    console.warn("[AI Orari] GROQ_VISION_MODEL non valida: uso il modello predefinito.");
    return GROQ_VISION_MODEL_DEFAULT;
  }
  return raw;
}

/** Fallback disponibile solo se la chiave è presente e non vuota. */
export function groqConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GROQ_API_KEY ?? "").trim().length > 0;
}

/** Il documento è un'immagine che Groq Vision può ricevere? */
export function groqSupportsMimeType(mimeType: string): boolean {
  return GROQ_IMAGE_MIME_TYPES.includes(String(mimeType ?? "").trim().toLowerCase());
}

/**
 * Decide SE chiamare Groq. Pura e deterministica: nessun contenuto, nessuna
 * chiamata di rete, quindi ogni condizione è verificabile in test.
 *
 * `geminiTransient` è calcolato dal chiamante con `isTransientGeminiCategory`:
 * la classificazione degli errori Gemini resta un solo punto del codice.
 */
/**
 * Esito della decisione. `reason` è sempre presente (vuoto quando il fallback
 * parte): senza `strictNullChecks` il narrowing su una union discriminata non è
 * disponibile, e un campo opzionale costringerebbe il chiamante a un cast.
 */
export interface GroqFallbackDecision {
  proceed: boolean;
  /** Vuoto se il fallback parte; altrimenti il motivo del salto, buono per i log. */
  reason: string;
}

export function groqFallbackDecision(input: {
  geminiOk: boolean;
  geminiTransient: boolean;
  groqConfigured: boolean;
  mimeType: string;
  remainingBudgetMs: number;
}): GroqFallbackDecision {
  if (input.geminiOk) return { proceed: false, reason: "gemini-ok" };
  // Errore deterministico (request/schema/chiave/modello): un altro provider
  // sbaglierebbe allo stesso modo. Si risponde con l'errore già previsto.
  if (!input.geminiTransient) return { proceed: false, reason: "errore-non-transitorio" };
  if (!input.groqConfigured) return { proceed: false, reason: "non-configurato" };
  if (!groqSupportsMimeType(input.mimeType)) return { proceed: false, reason: "mime-non-supportato" };
  if (groqAttemptTimeoutMs(input.remainingBudgetMs) === 0) return { proceed: false, reason: "budget-esaurito" };
  return { proceed: true, reason: "" };
}

/**
 * Decide SE chiamare Groq una seconda volta per un motivo SEMANTICO, e non
 * tecnico: Gemini ha risposto e il JSON è decodificabile, ma fallisce H3
 * (`TEACHER_ROW_NOT_RECOGNIZED`) oppure H4
 * (`TIMETABLE_CLASS_TOTALS_MISMATCH`). Sono errori di lettura indipendenti dalla
 * geometria sui quali un vero secondo provider può riuscire. La risposta non
 * viene "accettata di più": viene riletta e passata allo STESSO validatore.
 *
 * È distinto da `groqFallbackDecision`, che copre i fallimenti TECNICI di
 * Gemini e non parte mai con `geminiOk`. Ogni altro shape error — numero di
 * blocchi, lunghezza giornaliera, schema, coordinate fuori elenco o payload
 * troncato — resta escluso e conserva il 422/503 già previsto.
 */
export function groqSemanticFallbackDecision(input: {
  /** Gemini ha prodotto il payload appena rifiutato? */
  geminiOk: boolean;
  /** Solo l'orario personale ha una riga docente da riconoscere. */
  personalDocument: boolean;
  /** Il rifiuto è ESATTAMENTE `TEACHER_ROW_NOT_RECOGNIZED`? */
  rowNotRecognized: boolean;
  /** Il rifiuto è ESATTAMENTE `TIMETABLE_CLASS_TOTALS_MISMATCH`? */
  classTotalsMismatch?: boolean;
  groqConfigured: boolean;
  mimeType: string;
  remainingBudgetMs: number;
}): GroqFallbackDecision {
  // Se il payload rifiutato è già di Groq (fallback tecnico appena avvenuto),
  // richiamarlo significa ripetere la stessa lettura con la stessa immagine e
  // lo stesso prompt: nessun secondo parere, solo latenza e quota bruciate.
  if (!input.geminiOk) return { proceed: false, reason: "gemini-non-ok" };
  if (!input.personalDocument) return { proceed: false, reason: "documento-non-personale" };
  // Soli due codici di LETTURA ammessi: identità della riga (H3) o coerenza del
  // riepilogo separato (H4). Geometria e ogni altro shape error restano esclusi.
  if (!input.rowNotRecognized && !input.classTotalsMismatch) {
    return { proceed: false, reason: "errore-non-semantico" };
  }
  if (!input.groqConfigured) return { proceed: false, reason: "non-configurato" };
  // PDF: Groq Vision prende immagini, non PDF. Nessuna conversione, resta il 422.
  if (!groqSupportsMimeType(input.mimeType)) return { proceed: false, reason: "mime-non-supportato" };
  if (groqAttemptTimeoutMs(input.remainingBudgetMs) === 0) return { proceed: false, reason: "budget-esaurito" };
  return { proceed: true, reason: "" };
}

/** Timeout del tentativo Groq: budget rimasto meno il margine di risposta. */
export function groqAttemptTimeoutMs(remainingMs: number): number {
  const usable = Math.floor(remainingMs) - GROQ_RESPONSE_RESERVE_MS;
  return usable >= GROQ_MIN_ATTEMPT_MS ? usable : 0;
}

/** Status HTTP di Groq -> categoria. Nessuna lettura del corpo: solo il codice. */
export function classifyGroqHttpStatus(status: number): GroqFailureCategory {
  if (status === 429) return "quota";
  if (status === 401 || status === 403) return "chiave-o-permessi";
  if (status === 404) return "modello-non-trovato";
  if (status === 408 || status === 504) return "deadline";
  if (status === 400 || status === 422) return "richiesta-non-valida";
  if (status >= 500) return "sovraccarico";
  return "sconosciuta";
}

/** Nodo di uno schema Gemini (`@google/genai`): solo i campi che usiamo. */
interface GeminiSchemaNode {
  type?: unknown;
  description?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  minimum?: unknown;
  maximum?: unknown;
}

function isSchemaNode(value: unknown): value is GeminiSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Schema Gemini (`Type.OBJECT`/`Type.ARRAY`/…) -> JSON Schema per lo Structured
 * Output di Groq, senza toccare lo schema di partenza.
 *
 * Lo Structured Output in modalità `strict` esige, per ogni oggetto, tutte le
 * proprietà in `required` e `additionalProperties: false`: qui lo imponiamo noi,
 * unendo i `required` già dichiarati alle chiavi presenti. Non cambia la
 * semantica — negli schemi dell'app ogni campo è comunque obbligatorio — e il
 * controllo di merito resta quello del validatore applicativo.
 *
 * Un tipo non riconosciuto è un errore: meglio rinunciare al fallback (503
 * controllato) che inviare uno schema ambiguo e accettare output fuori contratto.
 */
export function groqJsonSchemaFrom(geminiSchema: unknown): Record<string, unknown> {
  if (!isSchemaNode(geminiSchema)) throw new Error("schema non convertibile");
  const type = typeof geminiSchema.type === "string" ? geminiSchema.type.toUpperCase() : "";
  const description = typeof geminiSchema.description === "string" ? geminiSchema.description : undefined;
  const withDescription = (node: Record<string, unknown>): Record<string, unknown> =>
    description ? { ...node, description } : node;

  if (type === "OBJECT") {
    const source = isSchemaNode(geminiSchema.properties) ? geminiSchema.properties : {};
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) properties[key] = groqJsonSchemaFrom(value);
    const declared = Array.isArray(geminiSchema.required)
      ? geminiSchema.required.filter((item): item is string => typeof item === "string")
      : [];
    const required = Array.from(new Set([...declared, ...Object.keys(properties)]));
    return withDescription({ type: "object", properties, required, additionalProperties: false });
  }
  if (type === "ARRAY") {
    return withDescription({ type: "array", items: groqJsonSchemaFrom(geminiSchema.items) });
  }
  if (type === "STRING" || type === "INTEGER" || type === "NUMBER" || type === "BOOLEAN") {
    const scalar: Record<string, unknown> = { type: type.toLowerCase() };
    // I vincoli numerici fanno parte del contratto, non sono documentazione:
    // senza `minimum`/`maximum` lo Structured Output accetta qualunque numero e
    // una coordinata normalizzata potrebbe arrivare come percentuale (25) o come
    // pixel. Vengono riportati solo se sono numeri finiti, così uno schema senza
    // vincoli resta identico a prima.
    if (type === "NUMBER" || type === "INTEGER") {
      if (typeof geminiSchema.minimum === "number" && Number.isFinite(geminiSchema.minimum)) {
        scalar.minimum = geminiSchema.minimum;
      }
      if (typeof geminiSchema.maximum === "number" && Number.isFinite(geminiSchema.maximum)) {
        scalar.maximum = geminiSchema.maximum;
      }
    }
    return withDescription(scalar);
  }
  throw new Error("schema non convertibile");
}

export interface RunGroqJsonOptions {
  /** Prompt IDENTICO a quello inviato a Gemini (systemInstruction). */
  systemInstruction: string;
  /** Testo utente IDENTICO a quello inviato a Gemini. */
  userText: string;
  imageBase64: string;
  mimeType: string;
  /** Schema Gemini dell'endpoint: convertito qui in Structured Output. */
  responseSchema: unknown;
  signal: AbortSignal;
  label: string;
  /** Tempo ancora disponibile dentro il deadline dell'endpoint. */
  budgetMs: number;
  /**
   * Timeout di rete GIÀ CALCOLATO (percorso a due passaggi): quando presente ha
   * la precedenza su `budgetMs` e non viene ridotto di nuovo del margine di
   * risposta (il chiamante l'ha già scalato). `<= 0` significa budget esaurito.
   */
  attemptTimeoutMs?: number;
  /** Nome dello Structured Output (default `timetable_analysis`; il Passo A usa `teacher_rows`). */
  schemaName?: string;
  /** Fase del percorso a due passaggi, solo per i log privacy-safe (es. `identificazione-riga`). */
  phase?: string;
  /** Iniezioni per i test. */
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface GroqJsonRunResult {
  ok: boolean;
  text: string;
  source: string;
  category: GroqFailureCategory | "ok";
  durationMs: number;
}

/**
 * Un solo tentativo Groq (il retry H6 vive in `runGroqJsonWithTransientRetry`,
 * così chi vuole il comportamento monolitico/curricolare resta invariato).
 * Ritorna sempre un esito classificato; `ok=false` lascia all'endpoint la
 * risposta di errore controllata già prevista.
 */
export async function runGroqJson(opts: RunGroqJsonOptions): Promise<GroqJsonRunResult> {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const apiKey = (opts.apiKey ?? process.env.GROQ_API_KEY ?? "").trim();
  const model = opts.model ?? groqVisionModel();
  const phaseTag = opts.phase ? ` fase=${opts.phase}` : "";
  const failed = (category: GroqFailureCategory, durationMs = 0, note?: string): GroqJsonRunResult => {
    log(`[${opts.label}] provider=groq${phaseTag} modello=${model} esito=fallito categoria=${category} durataMs=${durationMs}${note ? ` nota=${note}` : ""} (nessun contenuto nel log)`);
    return { ok: false, text: "", source: "", category, durationMs };
  };

  if (!apiKey) return failed("non-configurato", 0, "GROQ_API_KEY assente o vuota");
  if (!groqSupportsMimeType(opts.mimeType)) return failed("mime-non-supportato");
  // Percorso a due passaggi: timeout già calcolato dal chiamante; altrimenti il
  // budget rimasto meno il margine di risposta (percorso monolitico storico).
  const timeoutMs = opts.attemptTimeoutMs !== undefined
    ? (Math.floor(opts.attemptTimeoutMs) > 0 ? Math.floor(opts.attemptTimeoutMs) : 0)
    : groqAttemptTimeoutMs(opts.budgetMs);
  if (timeoutMs === 0) return failed("budget-esaurito", 0, "tempo insufficiente per il fallback");

  let responseSchema: Record<string, unknown>;
  try {
    responseSchema = groqJsonSchemaFrom(opts.responseSchema);
  } catch {
    return failed("richiesta-non-valida", 0, "schema-non-convertibile");
  }

  const startedAt = now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts.signal.aborted) return failed("annullata");
  opts.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(GROQ_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      // Stesso prompt, stessa immagine, stesso obiettivo JSON di Gemini: cambia
      // solo il formato del trasporto (chat completions OpenAI-compatible).
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: opts.systemInstruction },
          {
            role: "user",
            content: [
              { type: "text", text: opts.userText },
              { type: "image_url", image_url: { url: `data:${opts.mimeType};base64,${opts.imageBase64}` } },
            ],
          },
        ],
        temperature: GROQ_TEMPERATURE,
        response_format: {
          type: "json_schema",
          json_schema: { name: opts.schemaName ?? "timetable_analysis", strict: true, schema: responseSchema },
        },
        reasoning_effort: GROQ_REASONING_EFFORT,
        reasoning_format: GROQ_REASONING_FORMAT,
      }),
      signal: controller.signal,
    });
    const durationMs = now() - startedAt;
    if (!response.ok) return failed(classifyGroqHttpStatus(response.status), durationMs, `status=${response.status}`);

    const payload = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    } | null;
    const text = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    const finishReason = String(payload?.choices?.[0]?.finish_reason ?? "").toLowerCase();
    if (!text) return failed("output-vuoto", durationMs);
    if (finishReason === "length") return failed("output-troncato", durationMs);

    log(`[${opts.label}] provider=groq${phaseTag} modello=${model} esito=ok durataMs=${durationMs} (nessun contenuto nel log)`);
    return { ok: true, text, source: model, category: "ok", durationMs };
  } catch (error: unknown) {
    const durationMs = now() - startedAt;
    // Abort esterno (client scollegato o deadline dell'endpoint) vs timeout del
    // tentativo: il primo non è un errore del fornitore.
    if (opts.signal.aborted) return failed("annullata", durationMs);
    const name = String((error as { name?: unknown })?.name ?? "");
    if (name === "AbortError" || name === "TimeoutError") return failed("deadline", durationMs);
    return failed("rete", durationMs);
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * H6 — Un tentativo + AL PIÙ UN retry transitorio, dentro il budget della fase.
 *
 * Pensato per le due fasi del percorso personale (Passo A e Passo B): il primo
 * tentativo usa l'intero timeout della fase; se fallisce con `quota` (429),
 * `sovraccarico` (503/5xx) o `rete` E il residuo della fase supera la soglia
 * minima, la STESSA richiesta viene ripetuta UNA sola volta con il timeout
 * residuo. In totale mai più di `GROQ_MAX_CALLS_PER_PHASE` chiamate per fase e
 * mai oltre il timeout che il chiamante aveva assegnato alla fase.
 *
 * Il percorso curricolare (one-shot) non cambia: continua a usare
 * `runGroqJson` direttamente.
 */
export async function runGroqJsonWithTransientRetry(opts: RunGroqJsonOptions): Promise<GroqJsonRunResult> {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const now = opts.now ?? Date.now;
  // Timeout effettivo del primo tentativo (stessa regola del singolo tentativo).
  const phaseTimeoutMs = opts.attemptTimeoutMs !== undefined
    ? (Math.floor(opts.attemptTimeoutMs) > 0 ? Math.floor(opts.attemptTimeoutMs) : 0)
    : groqAttemptTimeoutMs(opts.budgetMs);
  if (phaseTimeoutMs === 0) return runGroqJson({ ...opts, attemptTimeoutMs: phaseTimeoutMs });

  const startedAt = now();
  const first = await runGroqJson({ ...opts, attemptTimeoutMs: phaseTimeoutMs });
  if (first.ok) return first;

  const retryTimeoutMs = groqRetryAttemptTimeoutMs(first.category, phaseTimeoutMs - (now() - startedAt));
  if (retryTimeoutMs === 0) return first;

  // Log del retry privacy-safe come gli altri: solo categoria e numero di tentativo.
  const phaseTag = opts.phase ? ` fase=${opts.phase}` : "";
  log(`[${opts.label}] provider=groq${phaseTag} esito=retry categoria=${first.category} tentativo=2/${GROQ_MAX_CALLS_PER_PHASE} (nessun contenuto nel log)`);
  return runGroqJson({ ...opts, attemptTimeoutMs: retryTimeoutMs });
}
