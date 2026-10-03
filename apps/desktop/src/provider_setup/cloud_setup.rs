use super::secret_input::SecretInput;
use crate::provisioning_bridge::{self as pb, Bridge, Preview};
use gpui::{prelude::*, *};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

pub struct CloudSetup {
    generation: u64,
    token: Entity<SecretInput>,
    account: Entity<SecretInput>,
    worker: Entity<SecretInput>,
    auth: Entity<SecretInput>,
    model_key: Entity<SecretInput>,
    bridge: Option<Arc<Mutex<Bridge>>>,
    pending_connect: Option<(String, String, Zeroizing<String>)>,
    preview: Option<Preview>,
    busy: bool,
    error: Option<&'static str>,
    deployed: Option<String>,
}
impl EventEmitter<super::ConnectionReady> for CloudSetup {}
impl CloudSetup {
    pub fn new(model_key: Entity<SecretInput>, cx: &mut Context<Self>) -> Self {
        Self {
            generation: 0,
            token: cx.new(|cx| SecretInput::new_secret(cx, "Scoped Cloudflare API token")),
            account: cx
                .new(|cx| SecretInput::new_public(cx, "Cloudflare account ID (32 hex characters)")),
            worker: cx.new(|cx| SecretInput::new_public(cx, "New worker name")),
            auth: cx.new(|cx| {
                SecretInput::new_secret(cx, "Backend bearer (43–128 URL-safe characters)")
            }),
            model_key,
            bridge: None,
            pending_connect: None,
            preview: None,
            busy: false,
            error: None,
            deployed: None,
        }
    }
    pub fn clear_ephemeral(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.pending_connect = None;
        self.preview = None;
        self.bridge = None;
        for field in [&self.token, &self.auth] {
            field.update(cx, |field, cx| {
                field.reset();
                cx.notify();
            });
        }
        cx.notify();
    }
    fn review(&mut self, cx: &mut Context<Self>) {
        let account = self.account.read(cx).secret();
        let worker = self.worker.read(cx).secret();
        let token = self.token.read(cx).secret();
        if !pb::account_id(&account)
            || !pb::worker_name(&worker)
            || token.len() < 20
            || token.len() > 256
        {
            self.error = Some(
                "Enter the selected account ID, a new worker name, and a scoped Cloudflare token",
            );
        } else {
            self.preview = None;
            self.error = None;
            self.pending_connect = Some((account.to_string(), worker.to_string(), token));
        }
        cx.notify();
    }
    fn prepare(&mut self, cx: &mut Context<Self>) {
        let Some((account, worker, token)) = self.pending_connect.take() else {
            return;
        };
        if *self.account.read(cx).secret() != account
            || *self.worker.read(cx).secret() != worker
            || *self.token.read(cx).secret() != *token
        {
            self.error = Some("Setup fields changed; review account access again");
            cx.notify();
            return;
        }
        let generation = self.generation;
        self.busy = true;
        self.error = None;
        let (sender, receiver) = async_channel::bounded(1);
        std::thread::spawn(move || {
            let result = (|| {
                let bundle: serde_json::Value = if pb::fixture_mode() {
                    serde_json::json!({"mainModule":"worker.js","modules":[{"name":"worker.js","content":"offline fixture"}]})
                } else {
                    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../packages/provisioning/dist/backend-bundle.json");
                    let metadata = std::fs::metadata(&path)
                        .map_err(|_| "Build the provisioning backend bundle before cloud setup")?;
                    if metadata.len() > 5 * 1024 * 1024 {
                        return Err("Backend bundle exceeds limit");
                    }
                    let bytes = std::fs::read(path).map_err(|_| "Backend bundle unavailable")?;
                    let parsed: serde_json::Value =
                        serde_json::from_slice(&bytes).map_err(|_| "Invalid backend bundle")?;
                    parsed
                };
                let mut bridge = Bridge::spawn()?;
                let _: serde_json::Value = bridge.request(&pb::Connect {
                    op: "connect",
                    token: &token,
                    account_ids: vec![&account],
                    credential_entry_approved: true,
                    scope_confirmed: true,
                })?;
                let accounts: Vec<pb::Account> =
                    bridge.request(&serde_json::json!({"op":"listAccounts"}))?;
                if !accounts.iter().any(|a| a.id == account) {
                    return Err("Selected Cloudflare account unavailable");
                }
                let preview: Preview = bridge.request(&serde_json::json!({"op":"prepare","accountId":account,"workerName":worker,"bundle":bundle}))?;
                preview.validate()?;
                if preview.account.id != account || preview.worker_name != worker {
                    return Err("Deployment preview identity mismatch");
                }
                Ok((Arc::new(Mutex::new(bridge)), preview))
            })();
            drop(token);
            let _ = sender.send_blocking(result);
        });
        cx.spawn(async move |view, cx| {
            if let Ok(result) = receiver.recv().await {
                let _ = view.update(cx, |view, cx| {
                    view.busy = false;
                    if generation != view.generation {
                        cx.notify();
                        return;
                    }
                    view.token.update(cx, |field, cx| {
                        field.reset();
                        cx.notify();
                    });
                    match result {
                        Ok((bridge, preview)) => {
                            view.bridge = Some(bridge);
                            view.preview = Some(preview);
                        }
                        Err(error) => view.error = Some(error),
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }
    fn deploy(&mut self, cx: &mut Context<Self>) {
        let Some(preview) = self.preview.take() else {
            return;
        };
        let auth = self.auth.read(cx).secret();
        let key = self.model_key.read(cx).secret();
        if !(43..=128).contains(&auth.len())
            || !auth
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !super::valid_api_key(&key)
        {
            self.error = Some(
                "Enter a valid backend bearer and OpenAI API key before confirming secret upload",
            );
            self.preview = Some(preview);
            cx.notify();
            return;
        }
        let Some(bridge) = self.bridge.take() else {
            return;
        };
        self.busy = true;
        self.error = None;
        let (sender, receiver) = async_channel::bounded(1);
        std::thread::spawn(move || {
            let result = bridge
                .lock()
                .map_err(|_| "Provisioning connection unavailable")
                .and_then(|mut bridge| {
                    let result: pb::Deployed = bridge.request(&pb::Deploy {
                        op: "deploy",
                        confirmation: pb::Confirmation {
                            preview_id: &preview.id,
                            account_id: &preview.account.id,
                            worker_name: &preview.worker_name,
                            accept_resource_creation: true,
                            acknowledge_usage_billing: true,
                            approve_secret_upload: true,
                        },
                        bootstrap: pb::Bootstrap {
                            auth_token: &auth,
                            openai_api_key: &key,
                        },
                    })?;
                    if result.state != "deployed"
                        || result.account_id != preview.account.id
                        || result.worker_name != preview.worker_name
                        || result.endpoint != preview.endpoint
                        || result.bundle_sha256 != preview.bundle_sha256
                    {
                        return Err("Deployment result mismatch; check cloud status before retry");
                    }
                    Ok((result.endpoint, auth))
                });
            drop(key);
            let _ = sender.send_blocking(result);
        });
        cx.spawn(async move |view, cx| {
            if let Ok(result) = receiver.recv().await {
                let _ = view.update(cx, |view, cx| {
                    view.busy = false;
                    view.auth.update(cx, |field, cx| {
                        field.reset();
                        cx.notify();
                    });
                    view.model_key.update(cx, |field, cx| {
                        field.reset();
                        cx.notify();
                    });
                    match result {
                        Ok((endpoint, bearer)) => {
                            view.deployed = Some(endpoint.clone());
                            cx.emit(super::ConnectionReady {
                                endpoint,
                                bearer,
                                fixture: pb::fixture_mode(),
                            });
                        }
                        Err(error) => view.error = Some(error),
                    }
                    cx.notify();
                });
            }
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
        .p_2()
        .bg(rgb(0xE8ECEF))
        .cursor_pointer()
        .child(text)
}
impl Render for CloudSetup {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let preview_text = self.preview.as_ref().map(|p| format!("Account: {} ({})\nNew worker: {}\nEndpoint: {}\nBundle SHA-256: {}\nResources: {}\nSecrets uploaded directly to Cloudflare: {}\nModel: {}\nLimits: {}\nBilling: {}\nToken scope verified: {}\nPreview expires: {}", p.account.name,p.account.id,p.worker_name,p.endpoint,p.bundle_sha256,p.resources.join(", "),p.secret_bindings.join(", "),p.model_id,p.limits,p.billing,p.token_scope_verified,p.expires_at));
        div().flex().flex_col().gap_2().child(div().text_lg().child(if pb::fixture_mode() { "Cloud setup · offline fixture" } else { "Cloud setup" }))
            .child("Requires the built provisioning sidecar and Node 22.19+. Account reads happen only after confirmation below.")
            .child(self.account.clone()).child(self.worker.clone()).child(self.token.clone())
            .when(!self.busy, |d| d.child(button("review-cloud", "Review account access").on_click(cx.listener(|view, _, _, cx| view.review(cx)))))
            .when_some(self.pending_connect.as_ref(), |d, (account, worker, _)| d.child(format!("Allow this scoped token to list selected account {account} and check availability of new worker {worker}? No resources or secrets uploaded at this step."))
                .child(button("confirm-read-cloud", "Confirm account reads and prepare preview").on_click(cx.listener(|view, _, _, cx| view.prepare(cx))))
                .child(button("cancel-read-cloud", "Cancel account access").on_click(cx.listener(|view, _, _, cx| { view.pending_connect = None; cx.notify(); }))))
            .when_some(preview_text, |d, text| d.child(div().text_sm().child(text))
                .child(self.auth.clone())
                .child("Confirmation creates the listed resources, uploads the backend bearer and OpenAI API key, and accepts usage billing with no spend cap. The desktop connects with this bearer kept in memory. No model call is made. The account must already have a workers.dev subdomain.")
                .child(button("confirm-deploy", "Confirm resource creation, secret upload, and usage billing").on_click(cx.listener(|view, _, _, cx| view.deploy(cx))))
                .child(button("cancel-deploy", "Cancel deployment").on_click(cx.listener(|view, _, _, cx| { view.preview = None; view.bridge = None; cx.notify(); }))))
            .when(self.busy, |d| d.child("Cloud setup in progress…"))
            .when_some(self.error, |d, error| d.child(div().text_color(rgb(0xA04438)).child(error)))
            .when_some(self.deployed.clone(), |d, endpoint| d.child(if pb::fixture_mode() { "Fixture deployment complete · no cloud resources, network or paid model call".to_owned() } else { format!("Worker deployed at {endpoint}. Model call not verified. Desktop connected using the in-memory backend bearer.") }))
    }
}
