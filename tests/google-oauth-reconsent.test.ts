import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCOPES, createGoogleProvider } from "../src/services/googleAuth";
import { isInsufficientScopeError } from "../src/services/googleCalendarService";

const root = resolve(import.meta.dirname, "..");
const readSource = (relative: string) => readFileSync(resolve(root, relative), "utf8");

// 1 + 6 — il login normale usa solo select_account, mai consent
test("createGoogleProvider() di default usa prompt=select_account", () => {
  const provider = createGoogleProvider();
  assert.deepEqual(provider.getCustomParameters(), { prompt: "select_account" });
});

// 2 — il re-consent esplicito forza la schermata di consenso
test("createGoogleProvider(true) usa prompt=consent select_account", () => {
  const provider = createGoogleProvider(true);
  assert.deepEqual(provider.getCustomParameters(), { prompt: "consent select_account" });
});

// 3 — forceConsent non è sticky: un provider nuovo per ogni login
test("forceConsent non altera i login successivi (nessun provider globale mutabile)", () => {
  const forced = createGoogleProvider(true);
  assert.equal(forced.getCustomParameters().prompt, "consent select_account");
  const normalAfter = createGoogleProvider();
  assert.equal(normalAfter.getCustomParameters().prompt, "select_account");
  assert.equal(createGoogleProvider(false).getCustomParameters().prompt, "select_account");

  const auth = readSource("src/services/googleAuth.ts");
  // Niente provider condiviso a livello di modulo: il provider nasce dentro signInWithGoogle.
  assert.doesNotMatch(auth, /^const provider = new GoogleAuthProvider\(\);/m);
  assert.match(auth, /signInWithPopup\(auth, createGoogleProvider\(options\?\.forceConsent === true\)\)/);
  assert.match(auth, /prompt: forceConsent \? "consent select_account" : "select_account"/);
});

// 4 — SCOPES G1.3: calendar.events (minimo per scrivere eventi anche su calendari
// condivisi "writer"; copre anche le letture inbound), mai calendar full access.
// Il nuovo consenso viene raccolto SOLO dal gesto esplicito "Ricollega Google".
test("SCOPES minimi G1.3 e tutti registrati sul provider", () => {
  assert.deepEqual(SCOPES, [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  ]);
  assert.ok(!SCOPES.includes("https://www.googleapis.com/auth/calendar"));
  assert.ok(!SCOPES.includes("https://www.googleapis.com/auth/calendar.events.owned"));
  const scopes = createGoogleProvider(true).getScopes();
  SCOPES.forEach(scope => assert.ok(scopes.includes(scope), `scope mancante sul provider: ${scope}`));
});

// 5 — le CTA "Ricollega Google" usano il flusso forceConsent, non il login normale
test("CTA Ricollega Google della card calendari usa onGoogleReconnect", () => {
  const profileModal = readSource("src/components/ProfileModal.tsx");
  assert.match(profileModal, /onGoogleReconnect\?: \(\) => Promise<void>;/);
  // Entrambe le CTA di riconnessione preferiscono il reconnect esplicito.
  const reconnectCtas = profileModal.match(/\(onGoogleReconnect \?\? onGoogleLogin\)/g) ?? [];
  assert.ok(reconnectCtas.length >= 1, "CTA needs-auth deve usare onGoogleReconnect");
  assert.match(profileModal, /const reconnect = onGoogleReconnect \?\? onGoogleLogin;/);
  assert.match(profileModal, /Ricollega Google/);

  const app = readSource("src/App.tsx");
  assert.match(app, /onGoogleReconnect=\{handleGoogleReconnect\}/);
  assert.match(app, /runGoogleSignIn\(\{ forceConsent: true \}\)/);
});

// 6 — login normale invariato: nessun forceConsent
test("handleGoogleLogin resta login normale senza consent", () => {
  const app = readSource("src/App.tsx");
  assert.match(app, /const handleGoogleLogin = async \(\) => runGoogleSignIn\(\);/);
  // Il forceConsent compare solo nel reconnect esplicito.
  const forced = app.match(/forceConsent: true/g) ?? [];
  assert.equal(forced.length, 1);
});

// 7 + 9 — il reconnect aggiorna il token e avvia subito l'import (bypass cooldown)
test("reconnect aggiorna access token e avvia import immediato", () => {
  const app = readSource("src/App.tsx");
  // Pipeline condivisa: il reconnect passa da applyGoogleLoginResult.
  assert.match(app, /const applyGoogleLoginResult = async [\s\S]*?setGoogleAccessToken\(result\.accessToken\);/);
  assert.match(app, /void runAutomaticGoogleImport\(true, result\.accessToken, result\.user\)/);
  assert.match(app, /const result = await runGoogleSignIn\(\{ forceConsent: true \}\);/);
});

// 8 — il reconnect invalida la cache CalendarList e la ricarica senza riaprire la modale
test("reconnect azzera googleCalendars e ricarica la CalendarList", () => {
  const app = readSource("src/App.tsx");
  const reconnect = app.slice(app.indexOf("const handleGoogleReconnect"));
  assert.match(reconnect, /setGoogleCalendars\(null\);/);
  assert.match(reconnect, /setGoogleCalendars\(await listGoogleCalendars\(result\.accessToken\)\)/);
});

// Errore scope: riconoscimento esplicito e messaggio utile
test("isInsufficientScopeError riconosce 403 e insufficient scopes", () => {
  assert.equal(isInsufficientScopeError(new Error("Request had insufficient authentication scopes.")), true);
  assert.equal(isInsufficientScopeError(new Error("The caller does not have insufficient permissions")), true);
  assert.equal(isInsufficientScopeError(new Error("Errore elenco calendari Google (403)")), true);
  assert.equal(isInsufficientScopeError(Object.assign(new Error("Forbidden"), { status: 403 })), true);
  assert.equal(isInsufficientScopeError(new Error("Failed to fetch")), false);
  assert.equal(isInsufficientScopeError(null), false);

  const profileModal = readSource("src/components/ProfileModal.tsx");
  assert.match(profileModal, /Google richiede una nuova autorizzazione per leggere i calendari condivisi\./);
  assert.match(profileModal, /Autorizza calendari/);
  assert.match(profileModal, /calendarListErrorMessage/);
});

// 10 — nessun popup automatico senza gesto utente
test("nessun popup OAuth automatico: token assente ⇒ needs-auth", () => {
  const app = readSource("src/App.tsx");
  assert.match(app, /if \(!token\) \{\s*setGoogleAutoImportStatus\("needs-auth"\);/);
  // I trigger automatici (focus/online/sessione) chiamano solo l'import, mai il login.
  assert.doesNotMatch(app, /useEffect\([\s\S]{0,400}?signInWithGoogle/);

  const auth = readSource("src/services/googleAuth.ts");
  const popupCalls = auth.match(/signInWithPopup\(/g) ?? [];
  assert.equal(popupCalls.length, 1, "signInWithPopup deve esistere solo dentro signInWithGoogle");
});

// 11 + 12 — nessuna regressione G1/G1.1/G1.2; outbound G1.3 per singolo impegno
test("import multi-calendar e cooldown invariati; outbound esplicito G1.3", () => {
  const app = readSource("src/App.tsx");
  assert.match(app, /if \(autoImportInFlight\.current\) return autoImportInFlight\.current;/);
  assert.match(app, /importSelectedGoogleCalendars\(token, calendarIds\)/);
  assert.match(app, /GOOGLE_CALENDAR_AUTO_IMPORT_COOLDOWN_MS = 5 \* 60 \* 1000/);
  assert.match(app, /await runAutomaticGoogleImport\(true, undefined, undefined, unique\)/);
  // G1.3: l'invio remoto passa SOLO dall'azione esplicita per singolo impegno.
  assert.match(app, /handleSendEventToGoogle/);

  const profileModal = readSource("src/components/ProfileModal.tsx");
  // G1.3: nessun batch outbound nel Profilo.
  assert.doesNotMatch(profileModal, /onSyncAllToGoogle/);

  const service = readSource("src/services/googleCalendarService.ts");
  assert.match(service, /PRIMARY_CALENDAR_ID/);
});
