use crate::{
    model::{ApprovalDecision, Message, Role, Snapshot, Status, Task, TaskStatus},
    sse::Decoder,
};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct State {
    pub snapshot: Snapshot,
    pub status: &'static str,
    pub error: Option<&'static str>,
    pub ready: bool,
    pub action: Option<Status>,
    pub endpoint: Option<String>,
    pub pending: bool,
    pub accepted: Option<(String, String)>,
    pub request_error: Option<&'static str>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            snapshot: Snapshot::empty(),
            status: "Connecting…",
            error: None,
            ready: false,
            action: None,
            endpoint: None,
            pending: false,
            accepted: None,
            request_error: None,
        }
    }
}

pub enum Command {
    Submit(String),
    SubmitReviewed { text: String, action: Status },
    Stop(String),
    DecideApproval(ApprovalDecision),
    Reconnect,
    Retry,
}

// The only token accepted here is the backend application bearer, never a provider key.
// Configuration deliberately has no Debug implementation or persistent storage.
#[derive(Clone)]
pub enum Config {
    Mock,
    Http { url: Url, bearer: Option<String> },
    Local { discovery: std::path::PathBuf },
}
impl Config {
    pub fn from_env() -> Result<Self, &'static str> {
        if let Some(path) = std::env::var_os("MORONS_LOCAL_CONNECTION") {
            let discovery = std::path::PathBuf::from(path);
            if !discovery.is_absolute() {
                return Err("Local service connection path must be absolute");
            }
            return Ok(Self::Local { discovery });
        }
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
        if bearer.is_none() {
            return Err("Backend application bearer is required");
        }
        Ok(Self::Http { url, bearer })
    }
}

pub struct Worker {
    commands: mpsc::Sender<Command>,
}
impl Worker {
    pub fn start(config: Config) -> (Self, async_channel::Receiver<State>) {
        let (commands, receiver) = mpsc::channel(16);
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
                    Config::Local { discovery } => {
                        http(None, Some(discovery), receiver, publisher).await
                    }
                    Config::Http { url, bearer } => {
                        http(Some((url, bearer)), None, receiver, publisher).await
                    }
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
    revision: Option<String>,
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
    async fn ready(&self) -> Result<Status, &'static str> {
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
        Ok(status)
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
    fixed: Option<(Url, Option<String>)>,
    discovery: Option<std::path::PathBuf>,
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
    let mut state = State::default();
    let mut pending: Option<(String, String, Option<String>)> = None;
    let mut previous_instance = None;
    loop {
        state.ready = false;
        state.action = None;
        state.status = if discovery.is_some() {
            "Connecting to local service…"
        } else {
            "Connecting…"
        };
        publisher.publish(&state);
        let connection = if let Some(path) = &discovery {
            crate::local_service::discover(path).map(|c| {
                (
                    c.url,
                    Some(c.bearer),
                    Some(c.instance_id),
                    Some(c.configuration_revision),
                )
            })
        } else {
            let (url, bearer) = fixed.as_ref().expect("HTTP configuration");
            Ok((url.clone(), bearer.clone(), None, None))
        };
        let (url, bearer, instance, revision) = match connection {
            Ok(connection) => connection,
            Err(error) => {
                state.status = "Local service unavailable";
                state.error = Some(error);
                publisher.publish(&state);
                tokio::select! {
                    command = commands.recv() => { match command {
                        None => return,
                        Some(Command::Reconnect) => {},
                        Some(_) => { state.request_error = Some("Reconnect to the local service before taking an action"); publisher.publish(&state); }
                    } },
                    _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                }
                continue;
            }
        };
        if previous_instance.is_some() && previous_instance != instance {
            state.status = "Local service restarted · recovering snapshot…";
            publisher.publish(&state);
        }
        previous_instance = instance.clone();
        let mut api = Api {
            client: client.clone(),
            url,
            bearer,
            revision,
        };
        state.endpoint = Some(api.url.to_string());
        let result = match api.ready().await {
            Ok(status) => {
                if instance.is_some()
                    && (status.instance_id != instance
                        || status.configuration_revision != api.revision
                        || status.execution_host.as_deref() != Some("local"))
                {
                    Err("Local service identity changed; reconnect")
                } else {
                    state.ready = status.ready;
                    api.revision = status.configuration_revision.clone();
                    state.action = Some(status);
                    api.snapshot().await
                }
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(snapshot) => {
                // If submit response was lost, the stable request ID in the fresh
                // snapshot is sufficient to acknowledge acceptance, across clients.
                if pending
                    .as_ref()
                    .is_some_and(|(id, _, _)| snapshot.tasks.iter().any(|task| &task.id == id))
                {
                    state.accepted = pending.take().map(|(id, text, _)| (id, text));
                    state.request_error = None;
                }
                state.snapshot = snapshot;
                state.pending = pending.is_some();
                state.error = None;
            }
            Err(error) => {
                state.error = Some(error);
                state.ready = false;
                state.status = if discovery.is_some() {
                    "Local service disconnected · reconnecting…"
                } else {
                    "Disconnected"
                };
                publisher.publish(&state);
                tokio::select! { command = commands.recv() => { match command { None => return, Some(command) => if discovery.is_none() { handle(command, &api, &mut pending, &mut state).await } } }, _ = tokio::time::sleep(Duration::from_secs(3)) => {} }
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
                state.ready = false;
                state.status = if discovery.is_some() {
                    "Local service disconnected · reconnecting…"
                } else {
                    "Disconnected"
                };
                state.error = Some("Cannot open backend stream");
                publisher.publish(&state);
                tokio::select! { command = commands.recv() => { if let Some(command) = command { if discovery.is_none() { handle(command, &api, &mut pending, &mut state).await }; } else { return; } }, _ = tokio::time::sleep(Duration::from_secs(3)) => {} }
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
                    state.status = "Sending…"; state.request_error = None; publisher.publish(&state);
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
                        if pending.as_ref().is_some_and(|(id, _, _)| snapshot.tasks.iter().any(|task| &task.id == id)) { state.accepted = pending.take().map(|(id, text, _)| (id, text)); state.pending = false; state.request_error = None; }
                        state.snapshot = snapshot; publisher.publish(&state);
                    }
                }
            }
        }
        if state.error.is_some() {
            state.ready = false;
            state.status = if discovery.is_some() {
                "Local service disconnected · reconnecting…"
            } else {
                "Disconnected"
            };
            publisher.publish(&state);
            tokio::select! { command = commands.recv() => { if let Some(command) = command { if discovery.is_none() { handle(command, &api, &mut pending, &mut state).await }; } else { return; } }, _ = tokio::time::sleep(Duration::from_secs(3)) => {} }
        }
    }
}

async fn handle(
    command: Command,
    api: &Api,
    pending: &mut Option<(String, String, Option<String>)>,
    state: &mut State,
) {
    let command = match command {
        Command::SubmitReviewed { text, action } => {
            if state.action.as_ref() != Some(&action)
                || !state.ready
                || api.revision != action.configuration_revision
            {
                state.request_error = Some("Provider action changed; review the send again");
                return;
            }
            Command::Submit(text)
        }
        command => command,
    };
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
            *pending = Some((uuid::Uuid::new_v4().to_string(), text, api.revision.clone()));
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
        Command::DecideApproval(decision) => {
            if !state
                .snapshot
                .approvals
                .iter()
                .any(|record| decision.matches(record))
            {
                Err("Approval is no longer pending or its intent changed")
            } else {
                api.mutate(&format!("approvals/{}/decision", decision.id), serde_json::json!({"taskId":decision.task_id,"digest":decision.digest,"decision":decision.decision})).await
            }
        }
        Command::Reconnect => Ok(()),
        Command::SubmitReviewed { .. } => unreachable!("normalized reviewed submit"),
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
async fn submit_pending(
    api: &Api,
    pending: Option<&(String, String, Option<String>)>,
) -> Result<(), &'static str> {
    if let Some((id, text, revision)) = pending {
        let mut body = serde_json::json!({"requestId":id,"text":text});
        if let Some(revision) = revision {
            body["configurationRevision"] = revision.clone().into();
        }
        api.mutate("tasks", body).await
    } else {
        Ok(())
    }
}

async fn mock(mut commands: mpsc::Receiver<Command>, publisher: Publisher) {
    let mut state = State {
        ready: true,
        status: "Demo · mock transport",
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
