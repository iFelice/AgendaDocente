import { getCachedUser } from "./googleAuth";

export const ANALYSIS_SIGN_IN_REQUIRED_MESSAGE = "Accedi con Google per analizzare i documenti.";
export const ANALYSIS_SESSION_EXPIRED_MESSAGE = "Sessione scaduta: accedi di nuovo con Google.";
export const ANALYSIS_NOT_AUTHORIZED_MESSAGE = "Questo account non è autorizzato all'analisi dei documenti.";
export const ANALYSIS_NOT_CONFIGURED_CLIENT_MESSAGE = "Analisi non configurata sul server.";
export const ANALYSIS_NOT_CONFIGURED_SERVER_MESSAGE = "Analisi non configurata";

export interface AnalysisAuthorizationHeaders {
  Authorization: string;
}

let tokenProvider: (() => Promise<string | null>) | null = null;

/** Solo test: sostituisce getIdToken. `null` ripristina il percorso Firebase. */
export function setAnalysisTokenProviderForTests(provider: (() => Promise<string | null>) | null): void {
  tokenProvider = provider;
}

async function firebaseIdToken(): Promise<{ token: string } | { message: string }> {
  const user = getCachedUser();
  if (!user) return { message: ANALYSIS_SIGN_IN_REQUIRED_MESSAGE };
  try {
    const token = await user.getIdToken();
    if (typeof token !== "string" || token.length === 0) {
      return { message: ANALYSIS_SESSION_EXPIRED_MESSAGE };
    }
    return { token };
  } catch {
    return { message: ANALYSIS_SESSION_EXPIRED_MESSAGE };
  }
}

export async function resolveAnalysisAuthorization(): Promise<
  | { ok: true; headers: AnalysisAuthorizationHeaders }
  | { ok: false; message: string }
> {
  if (tokenProvider) {
    const token = await tokenProvider();
    if (!token) return { ok: false, message: ANALYSIS_SIGN_IN_REQUIRED_MESSAGE };
    return { ok: true, headers: { Authorization: `Bearer ${token}` } };
  }
  const resolved = await firebaseIdToken();
  if ("message" in resolved) return { ok: false, message: resolved.message };
  return { ok: true, headers: { Authorization: `Bearer ${resolved.token}` } };
}

export function isAnalysisNotConfiguredResponse(data: Record<string, unknown>): boolean {
  return data.errorCode === "ANALYSIS_NOT_CONFIGURED" || data.error === ANALYSIS_NOT_CONFIGURED_SERVER_MESSAGE;
}

/** Messaggi fissi per 401, 403 e 503 di configurazione. Gli altri stati restano ai mapper esistenti. */
export function analysisHttpAuthMessage(status: number, data: Record<string, unknown>): string | null {
  if (status === 401) return ANALYSIS_SESSION_EXPIRED_MESSAGE;
  if (status === 403) return ANALYSIS_NOT_AUTHORIZED_MESSAGE;
  if (status === 503 && isAnalysisNotConfiguredResponse(data)) return ANALYSIS_NOT_CONFIGURED_CLIENT_MESSAGE;
  return null;
}
