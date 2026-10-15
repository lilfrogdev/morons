/** Human-operated bridge to Pi's OAuth interaction. Never returns credentials. */
export function createProviderFlow(auth) {
  let current = { state: 'disconnected' };
  let pendingPrompt = null;
  let controller = null;
  let running = null;
  const publicStatus = () => ({ ...current });
  return {
    async status() {
      if (auth?.status && !running) {
        const metadata = await auth.status();
        current = { state: metadata.providers.some(({ provider, method }) =>
          provider === 'openai' && method === 'oauth') ? 'connected' : 'disconnected' };
      }
      return publicStatus();
    },
    start() {
      if (!auth) throw new Error('provider_store_unavailable');
      if (running) throw new Error('login_in_progress');
      controller = new AbortController();
      current = { state: 'starting' };
      const interaction = {
        signal: controller.signal,
        notify(event) {
          if (event?.type === 'auth_url' && typeof event.url === 'string') {
            const url = new URL(event.url);
            if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || event.url.length > 4096)
              throw new Error('invalid_auth_url');
            current = { state: 'open_browser', authorizationUrl: event.url };
          } else if (event?.type === 'progress') {
            current = { ...current, state: 'working' };
          }
        },
        prompt(prompt) {
          if (prompt?.type !== 'manual_code' || pendingPrompt) throw new Error('unsupported_login_prompt');
          current = { ...current, state: 'awaiting_callback' };
          return new Promise((resolve, reject) => {
            pendingPrompt = { resolve, reject };
            prompt.signal?.addEventListener('abort', () => {
              if (pendingPrompt) { pendingPrompt = null; reject(new Error('prompt_cancelled')); }
            }, { once: true });
          });
        },
      };
      running = auth.loginOpenAI(interaction).then(() => {
        current = { state: 'connected' };
      }, () => {
        current = { state: controller.signal.aborted ? 'cancelled' : 'failed' };
      }).finally(() => { running = null; pendingPrompt = null; controller = null; });
      return publicStatus();
    },
    submitCallback(value) {
      if (!pendingPrompt || typeof value !== 'string' || value.length > 4096 ||
          !value.startsWith('http://127.0.0.1:1455/auth/callback?'))
        throw new Error('invalid_callback');
      const prompt = pendingPrompt;
      pendingPrompt = null;
      current = { state: 'working' };
      prompt.resolve(value);
      return publicStatus();
    },
    cancel() {
      if (controller) controller.abort();
      if (pendingPrompt) { pendingPrompt.reject(new Error('prompt_cancelled')); pendingPrompt = null; }
      current = { state: 'cancelled' };
      return publicStatus();
    },
    async logout() {
      if (!auth) throw new Error('provider_store_unavailable');
      this.cancel();
      await auth.logoutOpenAI();
      current = { state: 'disconnected' };
      return publicStatus();
    },
    async close() { this.cancel(); await running; },
  };
}
