import { LocalAuth, type Transport } from "./index";

// Official OpenAI OIDC metadata. Native settings and saved account records cannot
// replace these trust anchors. Generic metadata injection remains a test boundary.
const OPENAI = Object.freeze({
  issuer: "https://auth.openai.com",
  authorizationEndpoint: "https://auth.openai.com/api/accounts/authorize",
  tokenEndpoint: "https://auth.openai.com/api/accounts/oauth/token",
  jwksUri: "https://auth.openai.com/.well-known/jwks.json",
});
const officialSessions = new WeakSet<LocalAuth>();
export function isOpenAILocalAuth(session: LocalAuth) {
  return officialSessions.has(session);
}
export function createOpenAILocalAuth(hostId: string, transport: Transport) {
  const session = new LocalAuth(OPENAI, hostId, transport);
  officialSessions.add(session);
  return session;
}
