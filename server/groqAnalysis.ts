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
    return withDescription({ type: type.toLowerCase() });
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
 * Un solo tentativo Groq (nessun retry: i retry sono già stati fatti da Gemini e
 * un fallback che riprova allunga il tempo di risposta dell'utente). Ritorna
 * sempre un esito classificato; `ok=false` lascia all'endpoint la risposta di
 * errore controllata già prevista.
 */
export async function runGroqJson(opts: RunGroqJsonOptions): Promise<GroqJsonRunResult> {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const apiKey = (opts.apiKey ?? process.env.GROQ_API_KEY ?? "").trim();
  const model = opts.model ?? groqVisionModel();
  const failed = (category: GroqFailureCategory, durationMs = 0, note?: string): GroqJsonRunResult => {
    log(`[${opts.label}] provider=groq modello=${model} esito=fallito categoria=${category} durataMs=${durationMs}${note ? ` nota=${note}` : ""} (nessun contenuto nel log)`);
    return { ok: false, text: "", source: "", category, durationMs };
  };

  if (!apiKey) return failed("non-configurato", 0, "GROQ_API_KEY assente o vuota");
  if (!groqSupportsMimeType(opts.mimeType)) return failed("mime-non-supportato");
  const timeoutMs = groqAttemptTimeoutMs(opts.budgetMs);
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
          json_schema: { name: "timetable_analysis", strict: true, schema: responseSchema },
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

    log(`[${opts.label}] provider=groq modello=${model} esito=ok durataMs=${durationMs} (nessun contenuto nel log)`);
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
