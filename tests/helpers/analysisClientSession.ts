import { setAnalysisTokenProviderForTests } from '../../src/services/analysisSession';

/** I test che si aspettano l'invio della richiesta simulano un utente collegato. */
export function installSignedInAnalysisClient(token = 'test-id-token'): void {
  setAnalysisTokenProviderForTests(async () => token);
}
