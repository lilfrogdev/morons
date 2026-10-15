// Provider login is deliberately separate from Morons account and session authorization.
export function createProviderAuth({ models, credentials, getDeviceId }) {
  if (!models || !credentials || typeof getDeviceId !== "function") throw new Error("models, credentials and getDeviceId required");
  let loginPending = false;
  return {
    async loginOpenAI(interaction) {
      if (loginPending) throw new Error("login_in_progress");
      if (typeof interaction?.prompt !== "function" || typeof interaction?.notify !== "function")
        throw new Error("interactive_login_required");
      loginPending = true;
      try {
        // Pi owns PKCE, state, nonce, callback, and credential storage semantics.
        await models.login("openai", "oauth", interaction, { agentName: "Morons", getDeviceId });
        return { provider: "openai", connected: true };
      } finally { loginPending = false; }
    },
    async status() {
      // Never return access/refresh tokens or infer a Morons account identity.
      const info = await credentials.list();
      return { providers: info.map(({ providerId, type }) => ({ provider: providerId, method: type })) };
    },
    async logoutOpenAI() {
      await models.logout("openai");
      // Pi removes the local credential. Server-side session revocation is separate work.
      return { provider: "openai", connected: false, remoteRevocation: "not_confirmed" };
    },
  };
}
