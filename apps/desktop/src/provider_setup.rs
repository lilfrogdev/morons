use serde::{Deserialize, Serialize};

#[cfg(feature = "native")]
pub struct ConnectionReady {
    pub endpoint: String,
    pub bearer: zeroize::Zeroizing<String>,
    pub fixture: bool,
}

pub const MODEL_ID: &str = "gpt-5-mini";
pub const KEYCHAIN_SERVICE: &str = "morons://provider/openai/api-key";
pub fn valid_api_key(key: &str) -> bool {
    key.starts_with("sk-")
        && key.len() > 3
        && key.len() <= 4096
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    MissingCredential,
    InvalidCredential,
    UnsupportedModel,
    Ready,
    Fixture,
}
impl Readiness {
    pub fn label(self) -> &'static str {
        match self {
            Self::MissingCredential => "Server API key missing",
            Self::InvalidCredential => "Server API key invalid",
            Self::UnsupportedModel => "Server model unsupported",
            Self::Ready => "Server configured · live call not verified",
            Self::Fixture => "Fixture chat · no live provider",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProviderConfiguration {
    version: u8,
    provider: String,
    model_id: String,
    auth_mode: String,
    pub readiness: Readiness,
    subscription: Subscriptions,
    verification: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Subscriptions {
    openai: String,
    opencode: String,
}
impl ProviderConfiguration {
    pub fn decode(bytes: &[u8]) -> Result<Readiness, &'static str> {
        if bytes.len() > 8192 {
            return Err("Provider configuration exceeds limit");
        }
        // Wire keys are camelCase; never surface remote parse errors or values.
        let config: Self =
            serde_json::from_slice(bytes).map_err(|_| "Invalid provider configuration")?;
        if config.version != 1
            || config.provider != "openai"
            || config.model_id != MODEL_ID
            || config.auth_mode != "api_key"
            || config.verification != "not_verified"
            || config.subscription.openai != "unsupported"
            || config.subscription.opencode != "unsupported"
        {
            return Err("Unsupported provider configuration");
        }
        Ok(config.readiness)
    }
}
// Only the current setup session may change staged fields or connect chat.
// A completed approved cloud write still leaves a secret-free recovery notice.
#[derive(Default)]
pub struct SetupLifecycle {
    generation: u64,
    pending_deployment: Option<u64>,
    pub recovered_deployment: Option<Result<String, &'static str>>,
}
impl SetupLifecycle {
    pub fn capture(&self) -> u64 {
        self.generation
    }
    pub fn is_current(&self, ticket: u64) -> bool {
        ticket == self.generation
    }
    pub fn reset(&mut self) {
        self.generation += 1;
    }
    pub fn deployment_pending(&self) -> bool {
        self.pending_deployment.is_some()
    }
    pub fn begin_deployment(&mut self) -> u64 {
        self.pending_deployment = Some(self.generation);
        self.generation
    }
    pub fn finish_deployment(
        &mut self,
        ticket: u64,
        result: Result<(String, zeroize::Zeroizing<String>), &'static str>,
    ) -> Option<Result<(String, zeroize::Zeroizing<String>), &'static str>> {
        if self.pending_deployment == Some(ticket) {
            self.pending_deployment = None;
        }
        if !self.is_current(ticket) {
            self.recovered_deployment = Some(match &result {
                Ok((endpoint, _)) => Ok(endpoint.clone()),
                Err(error) => Err(*error),
            });
            return None;
        }
        Some(result)
    }
}

// Ordinary settings contain only the curated model/auth mode; keys have their
// own explicit Keychain operation and cannot be serialized into these settings.
#[derive(Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub model_id: String,
    pub auth_mode: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            model_id: MODEL_ID.into(),
            auth_mode: "api_key".into(),
        }
    }
}
impl Settings {
    pub fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        let settings: Self =
            serde_json::from_slice(bytes).map_err(|_| "Invalid saved provider settings")?;
        if settings != Self::default() {
            return Err("Unsupported saved provider settings");
        }
        Ok(settings)
    }
}

#[cfg(feature = "native")]
mod cloud_setup;
// Review binds the exact staged key; consuming the approval prevents replay.
#[cfg(any(feature = "native", test))]
struct SaveApproval(zeroize::Zeroizing<String>);
#[cfg(any(feature = "native", test))]
impl SaveApproval {
    fn prepare(key: &str) -> Result<Self, &'static str> {
        if !valid_api_key(key) {
            return Err("Enter an OpenAI API key; subscription tokens are unsupported");
        }
        Ok(Self(zeroize::Zeroizing::new(key.to_owned())))
    }
    fn execute<R>(self, current: &str, write: impl FnOnce(&[u8]) -> R) -> Result<R, &'static str> {
        if self.0.as_str() != current {
            return Err("Key changed; review the save again");
        }
        Ok(write(self.0.as_bytes()))
    }
}

#[cfg(feature = "native")]
mod secret_input;
#[cfg(feature = "native")]
pub mod native {
    use super::*;
    use crate::transport::Config;
    use futures_util::StreamExt;
    use gpui::{prelude::*, *};

    pub struct ProviderSetup {
        generation: u64,
        key: Entity<super::secret_input::SecretInput>,
        cloud: Entity<super::cloud_setup::CloudSetup>,
        readiness: Option<Readiness>,
        error: Option<&'static str>,
        pending_save: Option<SaveApproval>,
        saving: bool,
        pending_read: bool,
        saved: bool,
        _readiness: Task<()>,
        _cloud_connection: Subscription,
    }
    impl EventEmitter<super::ConnectionReady> for ProviderSetup {}
    impl ProviderSetup {
        pub fn new(config: &Config, cx: &mut Context<Self>) -> Self {
            let key = cx.new(super::secret_input::SecretInput::new);
            let cloud = cx.new(|cx| super::cloud_setup::CloudSetup::new(key.clone(), cx));
            let connection = cx.subscribe(&cloud, |view, _, event: &super::ConnectionReady, cx| {
                view.readiness = Some(if event.fixture {
                    Readiness::Fixture
                } else {
                    Readiness::Ready
                });
                cx.emit(super::ConnectionReady {
                    endpoint: event.endpoint.clone(),
                    bearer: zeroize::Zeroizing::new(event.bearer.to_string()),
                    fixture: event.fixture,
                });
                cx.notify();
            });
            let (sender, receiver) = async_channel::bounded(1);
            match config {
                Config::Mock => {
                    let _ = sender.try_send(Ok(Readiness::Fixture));
                }
                Config::Http { url, bearer } => {
                    let url = url.join("/v1/provider/configuration").expect("fixed route");
                    let bearer = bearer.clone();
                    std::thread::spawn(move || {
                        let result = tokio::runtime::Builder::new_current_thread().enable_all().build()
                            .map_err(|_| "Provider status unavailable")
                            .and_then(|rt| rt.block_on(async {
                                let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
                                    .timeout(std::time::Duration::from_secs(10)).build().map_err(|_| "Provider status unavailable")?;
                                let response = client.get(url).bearer_auth(bearer.as_deref().unwrap_or(""))
                                    .send().await.map_err(|_| "Provider status unavailable")?;
                                if !response.status().is_success() { return Err("Provider status unavailable; check backend authentication"); }
                                let mut stream = response.bytes_stream(); let mut body = Vec::new();
                                while let Some(chunk) = stream.next().await {
                                    let chunk = chunk.map_err(|_| "Provider status unavailable")?;
                                    if body.len() + chunk.len() > 8192 { return Err("Provider configuration exceeds limit"); }
                                    body.extend_from_slice(&chunk);
                                }
                                ProviderConfiguration::decode(&body)
                            }));
                        let _ = sender.send_blocking(result);
                    });
                }
            }
            let task = cx.spawn(async move |view, cx| {
                if let Ok(result) = receiver.recv().await {
                    let _ = view.update(cx, |view, cx| {
                        match result {
                            Ok(state) => view.readiness = Some(state),
                            Err(error) => view.error = Some(error),
                        }
                        cx.notify();
                    });
                }
            });
            Self {
                generation: 0,
                key,
                cloud,
                readiness: None,
                error: None,
                pending_save: None,
                saving: false,
                pending_read: false,
                saved: false,
                _readiness: task,
                _cloud_connection: connection,
            }
        }
        pub fn clear_ephemeral(&mut self, cx: &mut Context<Self>) {
            self.generation += 1;
            self.pending_save = None;
            self.pending_read = false;
            self.key.update(cx, |key, cx| {
                key.reset();
                cx.notify();
            });
            self.cloud.update(cx, |cloud, cx| cloud.clear_ephemeral(cx));
            cx.notify();
        }
        fn confirm_read(&mut self, cx: &mut Context<Self>) {
            if !self.pending_read {
                return;
            }
            self.pending_read = false;
            let generation = self.generation;
            let task = cx.read_credentials(KEYCHAIN_SERVICE);
            cx.spawn(async move |view, cx| {
                let result = task
                    .await
                    .map(|value| value.map(|(user, bytes)| (user, zeroize::Zeroizing::new(bytes))));
                let _ = view.update(cx, |view, cx| {
                    if generation != view.generation {
                        return;
                    }
                    match result {
                        Ok(Some((_, bytes))) => match std::str::from_utf8(&bytes) {
                            Ok(secret) if valid_api_key(secret) => {
                                view.key.update(cx, |key, cx| key.load_secret(secret, cx));
                                view.error = None;
                            }
                            _ => view.error = Some("Saved Keychain credential is invalid"),
                        },
                        Ok(None) => view.error = Some("No OpenAI API key saved for Morons"),
                        Err(_) => view.error = Some("Keychain read failed"),
                    }
                    cx.notify();
                });
            })
            .detach();
        }
        fn prepare_save(&mut self, cx: &mut Context<Self>) {
            if !self.key.read(cx).valid() {
                self.error = Some("Enter an OpenAI API key; subscription tokens are unsupported");
            } else {
                self.pending_save = SaveApproval::prepare(&self.key.read(cx).secret()).ok();
                self.error = None;
            }
            cx.notify();
        }
        fn confirm_save(&mut self, cx: &mut Context<Self>) {
            let Some(secret) = self.pending_save.take() else {
                return;
            };
            let current = self.key.read(cx).secret();
            let task = match secret.execute(&current, |secret| {
                cx.write_credentials(KEYCHAIN_SERVICE, "openai-api-key", secret)
            }) {
                Ok(task) => task,
                Err(error) => {
                    self.error = Some(error);
                    cx.notify();
                    return;
                }
            };
            self.saving = true;
            let generation = self.generation;
            cx.spawn(async move |view, cx| {
                let result = task.await;
                let _ = view.update(cx, |view, cx| {
                    view.saving = false;
                    if generation != view.generation {
                        cx.notify();
                        return;
                    }
                    if result.is_ok() {
                        view.saved = true;
                        if *view.key.read(cx).secret() == *current {
                            view.key.update(cx, |key, cx| {
                                key.reset();
                                cx.notify();
                            });
                        }
                    } else {
                        view.error = Some("Keychain save failed; no provider call was made");
                    }
                    cx.notify();
                });
            })
            .detach();
        }
    }
    fn button(id: &'static str, text: &'static str) -> Stateful<Div> {
        div()
            .id(id)
            .role(Role::Button)
            .aria_label(text)
            .focusable()
            .tab_stop(true)
            .px_3()
            .py_2()
            .rounded_md()
            .bg(rgb(0xE8ECEF))
            .cursor_pointer()
            .child(text)
    }
    impl Render for ProviderSetup {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            div().id("provider-setup-scroll").size_full().overflow_y_scroll().p_6().flex().flex_col().gap_3().bg(rgb(0xF6F8FA)).text_color(rgb(0x243440))
                .child(div().text_xl().child("Model connection"))
                .child("OpenAI API key · gpt-5-mini")
                .child(self.readiness.map(Readiness::label).unwrap_or("Checking server configuration…"))
                .child("OpenAI and OpenCode subscriptions: unsupported on this backend")
                .child(self.key.clone())
                .child("The key stays in this form until you explicitly save it. Saving on this Mac does not configure the cloud worker.")
                .when(!self.saving, |d| d.child(button("review-keychain", "Review Keychain save").on_click(cx.listener(|view, _, _, cx| view.prepare_save(cx)))))
                .when(self.pending_save.is_some(), |d| d.child(div().p_3().flex().flex_col().gap_2()
                    .child("Save this OpenAI API key in this Mac’s Keychain under Morons? This persists the key locally. No upload or paid model call.")
                    .child(button("confirm-keychain", "Confirm save to Keychain").on_click(cx.listener(|view, _, _, cx| view.confirm_save(cx))))
                    .child(button("cancel-keychain", "Cancel save").on_click(cx.listener(|view, _, _, cx| { view.pending_save = None; cx.notify(); })))))
                .when(self.saving, |d| d.child("Saving to Keychain…"))
                .when(self.saved, |d| d.child("Saved on this Mac · cloud worker still needs an approved credential upload"))
                .child(button("review-keychain-read", "Review loading saved key").on_click(cx.listener(|view, _, _, cx| { view.pending_read = true; cx.notify(); })))
                .when(self.pending_read, |d| d.child("Load the OpenAI API key from this Mac’s Morons Keychain item into this masked form? This does not upload it or make a model call.")
                    .child(button("confirm-keychain-read", "Confirm Keychain read").on_click(cx.listener(|view, _, _, cx| view.confirm_read(cx))))
                    .child(button("cancel-keychain-read", "Cancel Keychain read").on_click(cx.listener(|view, _, _, cx| { view.pending_read = false; cx.notify(); }))))
                .child(self.cloud.clone())
                .when_some(self.error, |d, error| d.child(div().text_color(rgb(0xA04438)).child(error)))
        }
    }
    pub fn bind_keys(cx: &mut App) {
        super::secret_input::bind_keys(cx);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_save_is_bound_to_exact_key_and_store_errors_remain_private() {
        let mut writes = Vec::new();
        let approval = SaveApproval::prepare("sk-fixture-one").unwrap();
        assert!(
            approval
                .execute("sk-fixture-two", |key| writes.push(key.to_vec()))
                .is_err()
        );
        assert!(writes.is_empty());
        let approval = SaveApproval::prepare("sk-fixture-one").unwrap();
        approval
            .execute("sk-fixture-one", |key| writes.push(key.to_vec()))
            .unwrap();
        assert_eq!(writes, [b"sk-fixture-one".to_vec()]);
        let approval = SaveApproval::prepare("sk-fixture-one").unwrap();
        let result = approval.execute("sk-fixture-one", |_| Err::<(), _>("fixture store failure"));
        assert!(result.unwrap().is_err());
    }
    #[test]
    fn late_deployment_after_close_preserves_new_fields_and_records_recovery_without_reconnect() {
        let mut lifecycle = SetupLifecycle::default();
        let ticket = lifecycle.begin_deployment();
        lifecycle.reset();
        let mut new_fields = vec!["sk-fixture-new-key", "new-fixture-bearer"];
        let mut connected = false;
        if lifecycle
            .finish_deployment(
                ticket,
                Ok((
                    "https://fixture.workers.dev".into(),
                    zeroize::Zeroizing::new("old-fixture-bearer".into()),
                )),
            )
            .is_some()
        {
            new_fields.clear();
            connected = true;
        }
        assert_eq!(new_fields, ["sk-fixture-new-key", "new-fixture-bearer"]);
        assert!(!connected);
        assert!(!lifecycle.deployment_pending());
        assert_eq!(
            lifecycle.recovered_deployment,
            Some(Ok("https://fixture.workers.dev".into()))
        );
        let fresh = lifecycle.begin_deployment();
        assert!(
            lifecycle
                .finish_deployment(fresh, Err("Fixture publish failed; state unknown"))
                .is_some()
        );
    }
    #[test]
    fn api_key_validation_rejects_subscription_and_secret_injection() {
        for key in [
            "sk-",
            "oauth-token",
            "{\"access\":\"secret\"}",
            "sk-key\n",
            "sk-é",
            "sk-key.secret",
        ] {
            assert!(!valid_api_key(key));
        }
        assert!(valid_api_key("sk-proj-fixture_123"));
        assert!(!valid_api_key(&format!("sk-{}", "a".repeat(4094))));
    }
    #[test]
    fn settings_roundtrip_excludes_credentials_and_rejects_untrusted_fields() {
        let bytes = serde_json::to_vec(&Settings::default()).unwrap();
        assert_eq!(Settings::decode(&bytes).unwrap(), Settings::default());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            2
        );
        assert!(
            Settings::decode(
                br#"{"model_id":"gpt-5-mini","auth_mode":"api_key","key":"sk-secret"}"#
            )
            .is_err()
        );
    }
    #[test]
    fn readiness_never_renders_remote_values_or_errors() {
        let fixture = br#"{"version":1,"provider":"openai","modelId":"gpt-5-mini","authMode":"api_key","readiness":"fixture","subscription":{"openai":"unsupported","opencode":"unsupported"},"verification":"not_verified"}"#;
        assert!(matches!(
            ProviderConfiguration::decode(fixture),
            Ok(Readiness::Fixture)
        ));
        assert_eq!(
            ProviderConfiguration::decode(b"secret raw response").err(),
            Some("Invalid provider configuration")
        );
        assert_eq!(
            Readiness::Ready.label(),
            "Server configured · live call not verified"
        );
    }
}
