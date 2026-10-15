use crate::{
    model::{Message, Role, Snapshot, Status, Task, TaskStatus},
    named::NamedHistory,
    sse::Decoder,
    visualization::{VisualizationDocument, VisualizationLease},
};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct State {
    pub snapshot: Snapshot,
    pub status: &'static str,
    // Display only. The backend owns model selection and provider credentials.
    pub model: Option<String>,
    pub named_morons: Vec<(String, String)>,
    pub selected_moron: Option<String>,
    pub review: Option<NamedReview>,
    pub error: Option<&'static str>,
    pub ready: bool,
    pub pending: bool,
    pub accepted: Option<(String, String)>,
    pub request_error: Option<&'static str>,
    pub account_login: bool,
    pub provider_available: bool,
    pub provider_state: Option<String>,
    pub provider_url: Option<String>,
    pub visualizations: Vec<VisualizationDocument>,
    pub visualization_expires_at: Option<Instant>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            snapshot: Snapshot::empty(),
            status: "Connecting…",
            model: None,
            named_morons: vec![],
            selected_moron: None,
            review: None,
            error: None,
            ready: false,
            pending: false,
            accepted: None,
            request_error: None,
            account_login: false,
            provider_available: false,
            provider_state: None,
            provider_url: None,
            visualizations: Vec::new(),
            visualization_expires_at: None,
        }
    }
}

pub enum Command {
    Submit(String),
    Stop(String),
    Reconnect,
    Retry,
    SelectMoron(String),
    ReviewDecision {
        id: String,
        decision: ReviewDecision,
    },
    AccountLogin { name: String, password: String },
    AccountCreate { name: String, password: String, bootstrap: String },
    AccountLogout,
    ProviderStart,
    ProviderCallback(String),
    ProviderCancel,
    ProviderLogout,
}

#[derive(Clone, Copy)]
pub enum ReviewDecision {
    Approve,
    Reject,
}
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedReview {
    pub id: String,
    pub branch: String,
    pub base_revision: String,
    #[serde(default)]
    pub diff: String,
    pub checks: Vec<NamedCheck>,
    pub decision: String,
}
#[derive(Clone, serde::Deserialize)]
pub struct NamedCheck {
    pub ok: bool,
}
#[derive(serde::Deserialize)]
struct NamedReviews {
    reviews: Vec<NamedReview>,
}
#[derive(serde::Deserialize)]
struct NamedReviewDetail {
    review: NamedReview,
}

// The only token accepted here is the backend application bearer, never a provider key.
// Configuration deliberately has no Debug implementation or persistent storage.
pub enum Config {
    Mock,
    Http { url: Url, bearer: Option<String> },
    Named { url: Url, bearer: String },
    NamedLogin { url: Url },
}
impl Config {
    pub fn from_env() -> Result<Self, &'static str> {
        let Ok(value) = std::env::var("MORONS_BACKEND_URL") else {
            return Ok(Self::Mock);
        };
        let url = Url::parse(&value).map_err(|_| "Invalid backend URL")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("Use a backend origin without path or credentials");
        }
        if url.scheme() != "https" && !(url.scheme() == "http" && local) {
            return Err("Backend requires HTTPS");
        }
        let bearer = std::env::var("MORONS_BACKEND_TOKEN")
            .ok()
            .filter(|s| !s.is_empty());
        if std::env::var("MORONS_BACKEND_MODE").ok().as_deref() == Some("named") {
            return Ok(match bearer { Some(bearer) => Self::Named { url, bearer }, None => Self::NamedLogin { url } });
        }
        if bearer.is_none() { return Err("Backend application bearer is required"); }
        Ok(Self::Http { url, bearer })
    }
}

pub struct Worker {
    commands: mpsc::Sender<Command>,
}
impl Worker {
    pub fn start(config: Config) -> (Self, async_channel::Receiver<State>) {
        let (commands, mut receiver) = mpsc::channel(16);
        let (updates, view) = async_channel::bounded(1);
        let stale = view.clone();
        // Networking and timers live on a dedicated runtime thread. Closing the
        // window closes this channel; dropping the stream never sends task stop.
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("network runtime");
            runtime.block_on(async move {
                let publisher = Publisher { updates, stale };
                match config {
                    Config::Mock => mock(receiver, publisher).await,
                    Config::Http { url, bearer } => http(url, bearer, receiver, publisher).await,
                    Config::Named { url, bearer } => {
                        if named_http(url.clone(), bearer, &mut receiver, &publisher).await {
                            named_account(url, &mut receiver, &publisher).await;
                        }
                    }
                    Config::NamedLogin { url } => named_account(url, &mut receiver, &publisher).await,
                }
            });
        });
        (Self { commands }, view)
    }
    pub fn send(&self, command: Command) -> Result<(), &'static str> {
        self.commands
            .try_send(command)
            .map_err(|_| "Client is busy; try again")
    }
}
struct Publisher {
    updates: async_channel::Sender<State>,
    stale: async_channel::Receiver<State>,
}
impl Publisher {
    fn publish(&self, state: &State) {
        // Coalesce fast full snapshots instead of building an unbounded UI queue.
        if let Err(async_channel::TrySendError::Full(value)) = self.updates.try_send(state.clone())
        {
            let _ = self.stale.try_recv();
            let _ = self.updates.try_send(value);
        }
    }
}

struct Api {
    client: Client,
    url: Url,
    bearer: Option<String>,
}
impl Api {
    fn request(&self, method: reqwest::Method, route: &str) -> reqwest::RequestBuilder {
        let request = self.client.request(
            method,
            self.url
                .join(&format!("v1/root/{route}"))
                .expect("static API route"),
        );
        match &self.bearer {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }
    async fn ready(&self) -> Result<(bool, String), &'static str> {
        let response = self
            .request(reqwest::Method::GET, "status")
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "Cannot reach backend")?;
        if !response.status().is_success() {
            return Err("Backend authentication or status request failed");
        }
        let status: Status = serde_json::from_slice(&bounded_body(response).await?)
            .map_err(|_| "Invalid backend status")?;
        if status.version != 1 || status.auth_mode != "bearer" || status.model.len() > 256 {
            return Err("Unsupported backend status");
        }
        Ok((status.ready, status.model))
    }
    async fn snapshot(&self) -> Result<Snapshot, &'static str> {
        let response = self
            .request(reqwest::Method::GET, "snapshot")
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "Cannot reach backend")?;
        if !response.status().is_success() {
            return Err("Backend rejected snapshot request");
        }
        let bytes = bounded_body(response).await?;
        let snapshot: Snapshot =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid server snapshot")?;
        snapshot.validate()?;
        Ok(snapshot)
    }
    async fn mutate(&self, route: &str, body: serde_json::Value) -> Result<(), &'static str> {
        let response = self
            .request(reqwest::Method::POST, route)
            .json(&body)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "Request outcome uncertain; reconnect or retry same request")?;
        if response.status().is_success() {
            Ok(())
        } else {
            let status = response.status().as_u16();
            let bytes = bounded_body_with_limit(response, 16 * 1024)
                .await
                .unwrap_or_default();
            Err(rejection_message(status, &bytes))
        }
    }
}
async fn bounded_body(response: reqwest::Response) -> Result<Vec<u8>, &'static str> {
    bounded_body_with_limit(response, 8 * 1024 * 1024).await
}
async fn bounded_body_with_limit(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Backend connection interrupted")?;
        if bytes.len() + chunk.len() > limit {
            return Err("Server snapshot exceeds client limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

// Only versioned, known codes select static UI text. Never display an arbitrary
// backend error message, which could contain provider or application secrets.
#[derive(serde::Deserialize)]
struct Rejection {
    version: u32,
    error: RejectionCode,
}
#[derive(serde::Deserialize)]
struct RejectionCode {
    code: String,
}
fn rejection_message(status: u16, bytes: &[u8]) -> &'static str {
    let code = serde_json::from_slice::<Rejection>(bytes)
        .ok()
        .filter(|value| value.version == 1);
    match (status, code.as_ref().map(|value| value.error.code.as_str())) {
        (401, _) => "Backend authentication failed",
        (429, Some("task_limit")) => {
            "Backend task limit reached. Use a new backend instance; existing history is retained."
        }
        (429, Some("history_limit")) => {
            "Backend history limit reached. Use a new backend instance; existing history is retained."
        }
        (409, Some("busy")) => "Another task is active. Wait for it to finish or stop it.",
        (409, Some("request_conflict")) => {
            "Request ID conflicts with existing input. Reconnect before sending a new message."
        }
        (413, Some("input_limit")) => {
            "Message exceeds the backend input limit. Shorten it and try again."
        }
        (503, Some("not_configured")) => {
            "Backend model is not configured. Check the backend configuration."
        }
        (409, _) => "Backend has an active task or conflicting request",
        _ => "Backend rejected request",
    }
}

async fn http(
    url: Url,
    bearer: Option<String>,
    mut commands: mpsc::Receiver<Command>,
    publisher: Publisher,
) {
    let client = match Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    let api = Api {
        client,
        url,
        bearer,
    };
    let mut state = State::default();
    let mut pending: Option<(String, String)> = None;
    loop {
        state.status = "Connecting…";
        publisher.publish(&state);
        let result = match api.ready().await {
            Ok((ready, model)) => {
                state.ready = ready;
                state.model = Some(model);
                api.snapshot().await
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(snapshot) => {
                // If submit response was lost, the stable request ID in the fresh
                // snapshot is sufficient to acknowledge acceptance, across clients.
                if pending
                    .as_ref()
                    .is_some_and(|(id, _)| snapshot.tasks.iter().any(|task| &task.id == id))
                {
                    state.accepted = pending.take();
                    state.request_error = None;
                }
                state.snapshot = snapshot;
                state.pending = pending.is_some();
                state.error = None;
            }
            Err(error) => {
                state.error = Some(error);
                state.status = "Disconnected";
                publisher.publish(&state);
                tokio::select! { command = commands.recv() => { match command { None => return, Some(command) => handle(command, &api, &mut pending, &mut state).await } }, _ = tokio::time::sleep(Duration::from_secs(3)) => {} }
                continue;
            }
        }
        let response = tokio::time::timeout(
            Duration::from_secs(15),
            api.request(reqwest::Method::GET, "events")
                .header("Accept", "text/event-stream")
                .send(),
        )
        .await;
        let response = match response {
            Ok(Ok(response))
                if response.status().is_success()
                    && response
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|v| v.starts_with("text/event-stream")) =>
            {
                response
            }
            _ => {
                state.status = "Disconnected";
                state.error = Some("Cannot open backend stream");
                publisher.publish(&state);
                tokio::select! { command = commands.recv() => { if let Some(command) = command { handle(command, &api, &mut pending, &mut state).await; } else { return; } }, _ = tokio::time::sleep(Duration::from_secs(3)) => {} }
                continue;
            }
        };
        let mut stream = response.bytes_stream();
        let mut decoder = Decoder::default();
        state.status = if state.ready {
            "Connected"
        } else {
            "Backend not ready"
        };
        publisher.publish(&state);
        'stream: loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { return; };
                    state.status = "Sending…"; publisher.publish(&state);
                    handle(command, &api, &mut pending, &mut state).await;
                    publisher.publish(&state);
                    // Discard this connection, fetch a fresh snapshot, then subscribe.
                    break;
                }
                chunk = tokio::time::timeout(Duration::from_secs(45), stream.next()) => {
                    let Ok(Some(Ok(chunk))) = chunk else { state.error = Some("Connection interrupted; reconnecting…"); break; };
                    let Ok(events) = decoder.push(&chunk) else { state.error = Some("Invalid backend stream"); break; };
                    for bytes in events {
                        let snapshot = serde_json::from_slice::<Snapshot>(&bytes).ok().filter(|s| s.validate().is_ok());
                        let Some(snapshot) = snapshot else { state.error = Some("Invalid server snapshot"); break 'stream; };
                        if pending.as_ref().is_some_and(|(id, _)| snapshot.tasks.iter().any(|task| &task.id == id)) { state.accepted = pending.take(); state.pending = false; state.request_error = None; }
                        state.snapshot = snapshot; publisher.publish(&state);
                    }
                }
            }
        }
        if state.error.is_some() {
            state.status = "Disconnected";
            publisher.publish(&state);
            tokio::select! { command = commands.recv() => { if let Some(command) = command { handle(command, &api, &mut pending, &mut state).await; } else { return; } }, _ = tokio::time::sleep(Duration::from_secs(3)) => {} }
        }
    }
}

async fn handle(
    command: Command,
    api: &Api,
    pending: &mut Option<(String, String)>,
    state: &mut State,
) {
    let admission = matches!(&command, Command::Submit(_) | Command::Retry);
    let result = match command {
        Command::Submit(text) => {
            if text.trim().is_empty() || text.len() > 8192 {
                state.request_error = Some("Message must contain 1–8192 UTF-8 bytes");
                return;
            }
            if pending.is_some() {
                return;
            }
            *pending = Some((uuid::Uuid::new_v4().to_string(), text));
            submit_pending(api, pending.as_ref()).await
        }
        Command::Retry => submit_pending(api, pending.as_ref()).await,
        Command::Stop(id) => {
            // Only exact task IDs from authoritative snapshots can reach this path.
            if uuid::Uuid::parse_str(&id).is_err() {
                Err("Invalid server task identity")
            } else {
                api.mutate(&format!("tasks/{id}/stop"), serde_json::json!({}))
                    .await
            }
        }
        Command::Reconnect => Ok(()),
        Command::SelectMoron(_) => Err("Named morons require the self-hosted backend"),
        Command::ReviewDecision { .. } => Err("Reviews require the self-hosted backend"),
        Command::AccountLogin { .. } | Command::AccountCreate { .. } | Command::AccountLogout |
        Command::ProviderStart | Command::ProviderCallback(_) | Command::ProviderCancel |
        Command::ProviderLogout => Err("Account and provider login require the named backend"),
    };
    state.request_error = result.err();
    // Only uncertain failures retain the idempotency key. Definite rejection
    // leaves the user's draft available to edit and resubmit as a new request.
    if admission
        && state
            .request_error
            .is_some_and(|error| !error.starts_with("Request outcome uncertain"))
    {
        *pending = None;
    }
    state.pending = pending.is_some();
}
async fn submit_pending(api: &Api, pending: Option<&(String, String)>) -> Result<(), &'static str> {
    if let Some((id, text)) = pending {
        api.mutate("tasks", serde_json::json!({"requestId":id,"text":text}))
            .await
    } else {
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct NamedMoron {
    id: String,
    name: String,
}
#[derive(serde::Deserialize)]
struct NamedMorons {
    morons: Vec<NamedMoron>,
}
#[derive(serde::Deserialize)]
struct NamedSession {
    id: String,
}
#[derive(serde::Deserialize)]
struct NamedSessions {
    sessions: Vec<NamedSession>,
}
fn valid_named_id(value: &str) -> bool {
    (2..=40).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.as_bytes()[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}
#[derive(serde::Deserialize)]
struct NamedModel {
    provider: String,
    id: String,
    label: String,
    available: bool,
}
#[derive(serde::Deserialize)]
struct NamedModels {
    models: Vec<NamedModel>,
}

struct NamedApi {
    client: Client,
    url: Url,
    bearer: String,
}
impl NamedApi {
    fn request(&self, method: reqwest::Method, route: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, self.url.join(route).expect("validated named route"))
            .bearer_auth(&self.bearer)
            .timeout(Duration::from_secs(120))
    }
    async fn get<T: serde::de::DeserializeOwned>(&self, route: &str) -> Result<T, &'static str> {
        let response = self
            .request(reqwest::Method::GET, route)
            .send()
            .await
            .map_err(|_| "Cannot reach named backend")?;
        if !response.status().is_success() {
            return Err("Named backend rejected request");
        }
        serde_json::from_slice(&bounded_body(response).await?)
            .map_err(|_| "Invalid named backend response")
    }
    async fn post(&self, route: &str, body: serde_json::Value) -> Result<(), &'static str> {
        let response = self
            .request(reqwest::Method::POST, route)
            .json(&body)
            .send()
            .await
            .map_err(|_| "Request outcome uncertain; retry same request")?;
        if response.status().is_success() {
            Ok(())
        } else if response.status().as_u16() == 409 {
            Err("Named request conflicts with existing state")
        } else {
            Err("Named backend rejected request")
        }
    }
    async fn selected_session(&self, moron_id: &str) -> Result<String, &'static str> {
        if !valid_named_id(moron_id) {
            return Err("Invalid named moron");
        }
        let morons: NamedMorons = self.get("v1/morons").await?;
        if morons.morons.len() > 32 {
            return Err("Named moron catalog exceeds client limit");
        }
        if !morons.morons.iter().any(|m| m.id == moron_id) {
            return Err("Named moron not found");
        }
        let route = format!("v1/morons/{moron_id}/sessions");
        let sessions: NamedSessions = self.get(&route).await?;
        if sessions.sessions.len() > 200 {
            return Err("Named sessions exceed client limit");
        }
        if let Some(first) = sessions.sessions.first() {
            if !valid_named_id(&first.id) {
                return Err("Invalid named session");
            }
            return Ok(first.id.clone());
        }
        // Moron IDs are globally unique and already fit the session ID limit.
        // Reusing the full ID avoids truncated-ID collisions across devices.
        let first_id = moron_id.to_owned();
        let _ = self.post(&route, serde_json::json!({"id":first_id})).await;
        let sessions: NamedSessions = self.get(&route).await?;
        sessions
            .sessions
            .first()
            .filter(|s| valid_named_id(&s.id))
            .map(|s| s.id.clone())
            .ok_or("Cannot select named session")
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountSession {
    token: String,
    expires_at: u64,
}
#[derive(serde::Deserialize)]
struct ProviderResponse {
    available: bool,
    provider: ProviderStatus,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStatus {
    state: String,
    authorization_url: Option<String>,
}
#[derive(serde::Deserialize)]
struct AccountMe { account: AccountIdentity }
#[derive(serde::Deserialize)]
struct AccountIdentity { id: String }

async fn named_account(url: Url, commands: &mut mpsc::Receiver<Command>, publisher: &Publisher) {
    let client = match Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10)).build() {
        Ok(client) => client,
        Err(_) => return,
    };
    let mut state = State { account_login: true, status: "Sign in to Morons", ..State::default() };
    publisher.publish(&state);
    while let Some(command) = commands.recv().await {
        match command {
            Command::AccountLogin { name, password } if valid_named_id(&name) && password.len() >= 12 && password.len() <= 256 => {
                state.status = "Signing in…";
                state.error = None;
                publisher.publish(&state);
                let result = async {
                    let response = client.post(url.join("v1/session/login").expect("static route"))
                        .json(&serde_json::json!({"name":name,"password":password}))
                        .timeout(Duration::from_secs(15)).send().await.map_err(|_| "Cannot reach account server")?;
                    if !response.status().is_success() { return Err("Account name or password was not accepted"); }
                    let session: AccountSession = serde_json::from_slice(&bounded_body_with_limit(response, 4096).await?)
                        .map_err(|_| "Invalid account login response")?;
                    if session.token.len() < 32 || session.token.len() > 256 || session.expires_at == 0 {
                        return Err("Invalid account login response");
                    }
                    Ok(session.token)
                }.await;
                match result {
                    Ok(token) => {
                        if !named_http(url.clone(), token, commands, publisher).await { return; }
                        state = State { account_login: true, status: "Signed out", ..State::default() };
                    }
                    Err(error) => { state.status = "Sign in to Morons"; state.error = Some(error); }
                }
            }
            Command::AccountCreate { name, password, bootstrap } if valid_named_id(&name) && password.len() >= 12 && password.len() <= 256 && bootstrap.len() >= 32 && bootstrap.len() <= 256 => {
                state.status = "Creating account…";
                state.error = None;
                publisher.publish(&state);
                let result = client.post(url.join("v1/accounts/bootstrap").expect("static route"))
                    .header("X-Morons-Bootstrap", bootstrap)
                    .json(&serde_json::json!({"name":name,"password":password}))
                    .timeout(Duration::from_secs(15)).send().await;
                match result {
                    Ok(response) if response.status().is_success() => state.status = "Account created. Sign in.",
                    Ok(_) => { state.status = "Sign in to Morons"; state.error = Some("Account setup unavailable or rejected"); }
                    Err(_) => { state.status = "Sign in to Morons"; state.error = Some("Cannot reach account server"); }
                }
            }
            Command::AccountLogin { .. } | Command::AccountCreate { .. } => state.error = Some("Enter a valid account name and password (12+ characters)"),
            _ => {},
        }
        publisher.publish(&state);
    }
}

async fn named_http(
    url: Url,
    bearer: String,
    commands: &mut mpsc::Receiver<Command>,
    publisher: &Publisher,
) -> bool {
    let client = match Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let api = NamedApi {
        client,
        url,
        bearer,
    };
    let mut state = State::default();
    let mut pending: Option<(String, String)> = None;
    let mut selected = "repo".to_owned();
    loop {
        let refreshed = async {
            let models: NamedModels = api.get("v1/models").await?;
            if models.models.len() > 128 {
                return Err("Model catalog exceeds client limit");
            }
            let model = models
                .models
                .iter()
                .find(|m| m.available)
                .ok_or("No model available")?;
            if model.provider.len() > 80 || model.id.len() > 128 || model.label.len() > 128 {
                return Err("Invalid model catalog");
            }
            let mut catalog: NamedMorons = api.get("v1/morons").await?;
            if catalog.morons.is_empty() {
                let _ = api.post("v1/morons", serde_json::json!({
                    "id":"repo", "name":"Repository",
                    "rules":"Read repository source, explain evidence, and propose isolated review changes. Never merge or update the running application automatically.",
                    "preferences":"Use concise answers and cite source paths."
                })).await;
                catalog = api.get("v1/morons").await?;
            }
            if catalog.morons.len() > 32 || catalog.morons.iter().any(|m| !valid_named_id(&m.id) || m.name.len() > 80) {
                return Err("Invalid named moron catalog");
            }
            if !catalog.morons.iter().any(|m| m.id == selected) {
                selected = catalog.morons.first().ok_or("No named moron available")?.id.clone();
            }
            let session = api.selected_session(&selected).await?;
            let history: NamedHistory = api.get(&format!("v1/sessions/{session}/history")).await?;
            if history.session_id != session || history.moron_id != selected {
                return Err("Named session identity mismatch");
            }
            let reviews: NamedReviews = api.get(&format!("v1/sessions/{session}/reviews")).await?;
            if reviews.reviews.len() > 64 || reviews.reviews.iter().any(|r| r.id.len() != 16 ||
                !r.id.bytes().all(|b| b.is_ascii_hexdigit()) || r.diff.len() > 256 * 1024 ||
                r.branch.len() > 100 || r.base_revision.len() != 40 || r.checks.len() > 8 ||
                !matches!(r.decision.as_str(), "pending" | "approve" | "reject")) {
                return Err("Invalid named reviews");
            }
            let selected_review = reviews.reviews.iter().find(|r| r.decision == "pending")
                .or_else(|| reviews.reviews.first());
            let review = if let Some(summary) = selected_review {
                let detail: NamedReviewDetail = api.get(&format!("v1/reviews/{}", summary.id)).await?;
                if detail.review.id != summary.id || detail.review.diff.len() > 256 * 1024 {
                    return Err("Invalid named review detail");
                }
                Some(detail.review)
            } else { None };
            let me: AccountMe = api.get("v1/session/me").await?;
            let visual: serde_json::Value = api.get(&format!("v1/sessions/{session}/visualizations")).await?;
            let now = Instant::now();
            let epoch = visual.get("accessEpoch").and_then(|v| v.as_str()).unwrap_or("");
            let lease = VisualizationLease::parse(&serde_json::to_vec(&visual).unwrap_or_default(),
                &me.account.id, &session, now);
            let documents = lease.as_ref().and_then(|lease| lease.documents(&me.account.id, &session, epoch, now))
                .map(|docs| docs.to_vec()).unwrap_or_default();
            let provider: Option<ProviderResponse> = api.get("v1/provider/openai/status").await.ok();
            Ok::<_, &'static str>((model.label.clone(), history.into_snapshot()?, session, catalog, review, provider, documents, lease.map(|lease| lease.expires_at())))
        }
        .await;
        let session = match refreshed {
            Ok((model, snapshot, session, catalog, review, provider, documents, expires_at)) => {
                state.model = Some(model);
                state.snapshot = snapshot;
                state.named_morons = catalog.morons.into_iter().map(|m| (m.id, m.name)).collect();
                state.selected_moron = Some(selected.clone());
                state.review = review;
                state.visualizations = documents;
                state.visualization_expires_at = expires_at;
                state.provider_available = provider.as_ref().is_some_and(|p| p.available);
                state.provider_state = provider.as_ref().map(|p| p.provider.state.clone());
                state.provider_url = provider.and_then(|p| p.provider.authorization_url)
                    .filter(|value| Url::parse(value).ok().is_some_and(|url|
                        url.scheme() == "https" && url.host_str() == Some("auth.openai.com") && value.len() <= 4096));
                state.status = "Connected";
                state.ready = true;
                state.error = None;
                state.pending = pending.is_some();
                publisher.publish(&state);
                session
            }
            Err(error) => {
                state.ready = false;
                state.status = "Disconnected";
                state.error = Some(error);
                state.visualizations.clear();
                state.visualization_expires_at = None;
                publisher.publish(&state);
                tokio::select! {
                    command = commands.recv() => {
                        match command {
                            None => return false,
                            Some(Command::AccountLogout) => { let _ = api.post("v1/session/logout", serde_json::json!({})).await; return true; },
                            _ => {},
                        }
                    },
                    _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                }
                continue;
            }
        };
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { return false; };
                let should_submit = matches!(command, Command::Submit(_) | Command::Retry);
                match command {
                    Command::Submit(text) => {
                        if text.trim().is_empty() || text.len() > 8192 {
                            state.request_error = Some("Message must contain 1–8192 UTF-8 bytes");
                        } else if pending.is_none() {
                            pending = Some((uuid::Uuid::new_v4().to_string(), text));
                        }
                    }
                    Command::Retry | Command::Reconnect => {},
                    Command::SelectMoron(id) => {
                        if pending.is_none() && state.named_morons.iter().any(|(known, _)| known == &id) {
                            selected = id;
                            state.request_error = None;
                        }
                    }
                    Command::ReviewDecision { id, decision } => {
                        if state.review.as_ref().is_some_and(|r| r.id == id && r.decision == "pending") {
                            let verb = match decision { ReviewDecision::Approve => "approve", ReviewDecision::Reject => "reject" };
                            state.request_error = api.post(&format!("v1/reviews/{id}/decision"),
                                serde_json::json!({"decision":verb})).await.err();
                        } else { state.request_error = Some("Review is no longer pending"); }
                    }
                    Command::Stop(_) => { state.request_error = Some("Named task stop is not available yet"); }
                    Command::AccountLogout => {
                        let _ = api.post("v1/session/logout", serde_json::json!({})).await;
                        state.snapshot = Snapshot::empty();
                        state.review = None;
                        state.named_morons.clear();
                        state.ready = false;
                        state.account_login = true;
                        state.provider_url = None;
                        state.provider_state = None;
                        state.visualizations.clear();
                        state.visualization_expires_at = None;
                        publisher.publish(&state);
                        return true;
                    }
                    Command::AccountLogin { .. } | Command::AccountCreate { .. } => {},
                    Command::ProviderStart if state.provider_available => {
                        state.request_error = api.post("v1/provider/openai/start", serde_json::json!({})).await.err();
                    }
                    Command::ProviderCallback(url) if state.provider_available => {
                        if url.len() > 4096 { state.request_error = Some("Callback URL is too long"); }
                        else { state.request_error = api.post("v1/provider/openai/callback", serde_json::json!({"url":url})).await.err(); }
                    }
                    Command::ProviderCancel if state.provider_available => {
                        state.request_error = api.post("v1/provider/openai/cancel", serde_json::json!({})).await.err();
                    }
                    Command::ProviderLogout if state.provider_available => {
                        state.request_error = api.post("v1/provider/openai/logout", serde_json::json!({})).await.err();
                    }
                    Command::ProviderStart | Command::ProviderCallback(_) | Command::ProviderCancel | Command::ProviderLogout => {
                        state.request_error = Some("ChatGPT login requires an unlocked private provider store");
                    }
                }
                if should_submit {
                  if let Some((id, text)) = &pending {
                    state.status = "Sending…";
                    state.pending = true;
                    publisher.publish(&state);
                    let result = api.post(&format!("v1/sessions/{session}/chat"),
                        serde_json::json!({"requestId":id,"text":text})).await;
                    state.request_error = result.err();
                    if state.request_error.is_none() {
                        state.accepted = pending.take();
                        state.pending = false;
                    } else if !state.request_error.is_some_and(|e| e.starts_with("Request outcome uncertain")) {
                        pending = None;
                        state.pending = false;
                    }
                    publisher.publish(&state);
                  }
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }
    }
}

async fn mock(mut commands: mpsc::Receiver<Command>, publisher: Publisher) {
    let mut state = State {
        ready: true,
        status: "Demo · mock transport",
        model: Some("Local demo".into()),
        ..State::default()
    };
    let mut words: Vec<String> = vec![];
    let mut timer = tokio::time::interval(Duration::from_millis(70));
    publisher.publish(&state);
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { return; };
                match command {
                    Command::Submit(text) if state.snapshot.active_task_id.is_none() => {
                        if text.trim().is_empty() || text.len() > 8192 || state.snapshot.tasks.len() >= 200 { state.request_error = Some("Demo input or history limit reached"); publisher.publish(&state); continue; }
                        state.request_error = None;
                        let id = uuid::Uuid::new_v4().to_string();
                        state.accepted = Some((id.clone(), text.clone()));
                        state.snapshot.tasks.push(Task { id:id.clone(), status:TaskStatus::Running, input:text.clone(), created_at:0, updated_at:0, error:None });
                        state.snapshot.messages.push(Message { id:uuid::Uuid::new_v4().to_string(), task_id:id.clone(), role:Role::User, text, partial:false });
                        state.snapshot.messages.push(Message { id:uuid::Uuid::new_v4().to_string(), task_id:id.clone(), role:Role::Assistant, text:String::new(), partial:true });
                        state.snapshot.active_task_id = Some(id);
                        words = "Hello! I’m Moron. This is a local demo of streaming chat. Connect a backend to keep your tasks and history across devices. You can close this window without stopping accepted backend work.".split_inclusive(' ').map(str::to_owned).collect(); words.reverse();
                    }
                    Command::Stop(id) if state.snapshot.active_task_id.as_ref() == Some(&id) => {
                        words.clear(); state.snapshot.active_task_id = None;
                        if let Some(task) = state.snapshot.tasks.last_mut() { task.status = TaskStatus::Stopped; }
                    }
                    _ => {}
                }
                publisher.publish(&state);
            }
            _ = timer.tick(), if !words.is_empty() => {
                if let Some(message) = state.snapshot.messages.last_mut() { message.text.push_str(&words.pop().unwrap()); }
                if words.is_empty() { state.snapshot.messages.last_mut().unwrap().partial = false; state.snapshot.active_task_id = None; state.snapshot.tasks.last_mut().unwrap().status = TaskStatus::Completed; }
                publisher.publish(&state);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn named_session_path_accepts_only_bounded_ids() {
        assert!(valid_named_id("main"));
        assert!(!valid_named_id("../other"));
        assert!(!valid_named_id("a/b"));
        assert!(!valid_named_id("a%2fb"));
    }
    #[test]
    fn known_rejections_are_actionable_without_echoing_server_text() {
        for (status, code, expected) in [
            (429, "task_limit", "Backend task limit reached."),
            (429, "history_limit", "Backend history limit reached."),
            (409, "busy", "Another task is active."),
            (
                409,
                "request_conflict",
                "Request ID conflicts with existing input.",
            ),
            (
                413,
                "input_limit",
                "Message exceeds the backend input limit.",
            ),
            (503, "not_configured", "Backend model is not configured."),
        ] {
            let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"error":{"code":code,"message":"secret-provider-token","extra":"secret"}})).unwrap();
            let message = rejection_message(status, &bytes);
            assert!(message.starts_with(expected));
            assert!(!message.contains("secret"));
        }
    }
    #[test]
    fn unknown_invalid_or_mismatched_errors_never_echo_server_text() {
        for bytes in [
            br#"{"version":1,"error":{"code":"secret-provider-token","message":"secret"}}"#
                .as_slice(),
            br#"{"version":2,"error":{"code":"history_limit","message":"secret"}}"#.as_slice(),
            b"secret invalid JSON".as_slice(),
        ] {
            assert_eq!(rejection_message(429, bytes), "Backend rejected request");
        }
        let bytes = br#"{"version":1,"error":{"code":"history_limit","message":"secret"}}"#;
        assert_eq!(rejection_message(500, bytes), "Backend rejected request");
        assert_eq!(
            rejection_message(401, b"secret"),
            "Backend authentication failed"
        );
    }

    #[test]
    fn mock_stream_and_stop_are_authoritative() {
        let (worker, updates) = Worker::start(Config::Mock);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            updates.recv().await.unwrap();
            worker.send(Command::Submit("hello 🐸".into())).unwrap();
            let state = updates.recv().await.unwrap();
            let id = state.snapshot.active_task_id.clone().unwrap();
            assert_eq!(state.snapshot.messages[0].text, "hello 🐸");
            worker.send(Command::Stop(id)).unwrap();
            loop {
                let state = updates.recv().await.unwrap();
                if state.snapshot.active_task_id.is_none() {
                    assert_eq!(state.snapshot.tasks[0].status, TaskStatus::Stopped);
                    break;
                }
            }
        });
    }
    #[test]
    fn updates_coalesce_to_latest_snapshot() {
        let (updates, stale) = async_channel::bounded(1);
        let publisher = Publisher {
            updates,
            stale: stale.clone(),
        };
        let mut state = State::default();
        publisher.publish(&state);
        state.status = "Connected";
        publisher.publish(&state);
        assert_eq!(stale.try_recv().unwrap().status, "Connected");
        assert!(stale.try_recv().is_err());
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod http_tests;
