# Pi provider authentication adapter

This module pins `@earendil-works/pi-ai` 1.2.0 and registers its normal `openai` provider. `createPiProviderAuth({ credentials, getDeviceId })` requires an app-owned Pi `CredentialStore` and a stable installation UUID. Supply its `models` object to `Harness.open`; the `auth` wrapper delegates human-initiated `loginOpenAI(interaction)` to `models.login("openai", "oauth", interaction, { agentName: "Morons", getDeviceId })`.

This package has no login HTTP route and never starts login by itself. The caller must present Pi's prompt and notification events to the human, handle the loopback callback on the same machine as the browser, and store credentials only in the trusted server process. For remote or VM deployments, design a secure callback handoff first. Do not copy browser cookies, tokens, or the credential store into GPUI clients or repository runners.

`auth.status()` returns only provider and method metadata from the store. `auth.logoutOpenAI()` removes the local Pi credential; it does not confirm server-side session revocation. OpenAI model access is provider authorization, not Morons account identity. The fixture server remains offline until account authorization, private credential storage, and a deliberate login UI are connected.
