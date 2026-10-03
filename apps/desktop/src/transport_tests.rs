use super::*;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

struct Fixture {
    url: Url,
    requests: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    done: Arc<AtomicBool>,
}
impl Fixture {
    fn start() -> Self {
        Self::with_identity(None)
    }
    fn with_identity(identity: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let done = Arc::new(AtomicBool::new(false));
        let snapshot = Arc::new(Mutex::new(Snapshot::empty()));
        let captured = requests.clone();
        let finished = done.clone();
        std::thread::spawn(move || {
            while !finished.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let requests = captured.clone();
                        let snapshot = snapshot.clone();
                        let identity = identity.clone();
                        std::thread::spawn(move || serve(stream, requests, snapshot, identity));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Self {
            url,
            requests,
            done,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.done.store(true, Ordering::Relaxed);
    }
}

fn serve(
    mut stream: TcpStream,
    requests: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    snapshot: Arc<Mutex<Snapshot>>,
    identity: Option<String>,
) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut data = Vec::new();
    let mut buffer = [0; 4096];
    let (headers, body) = loop {
        let Ok(count) = stream.read(&mut buffer) else {
            return;
        };
        if count == 0 {
            return;
        }
        data.extend_from_slice(&buffer[..count]);
        let Some(end) = data.windows(4).position(|s| s == b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8(data[..end].to_vec()).unwrap();
        let length = headers
            .lines()
            .find_map(|line| {
                line.to_lowercase()
                    .strip_prefix("content-length: ")
                    .and_then(|n| n.parse::<usize>().ok())
            })
            .unwrap_or(0);
        if data.len() >= end + 4 + length {
            break (headers, data[end + 4..end + 4 + length].to_vec());
        }
    };
    let expected = identity
        .as_ref()
        .map(|id| format!("fixture-{id}"))
        .unwrap_or_else(|| "fixture-only-capability".into());
    assert!(
        headers
            .to_lowercase()
            .contains(&format!("authorization: bearer {expected}"))
    );
    let route = headers
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    let mut records = requests.lock().unwrap();
    records.push((route.clone(), body.clone()));
    let submits = records
        .iter()
        .filter(|(r, _)| r == "/v1/root/tasks")
        .count();
    drop(records);
    if route == "/v1/root/tasks" {
        // First request loses its response without acceptance. Retry must reuse ID.
        if submits == 1 {
            return;
        }
        let mut state = snapshot.lock().unwrap();
        let id = body["requestId"].as_str().unwrap().to_owned();
        state.tasks = vec![Task {
            id: id.clone(),
            status: TaskStatus::Running,
            input: body["text"].as_str().unwrap().into(),
            created_at: 1,
            updated_at: 1,
            error: None,
        }];
        state.active_task_id = Some(id);
        let bytes = b"{}";
        let _ = write!(
            stream,
            "HTTP/1.1 202 Accepted\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        );
        let _ = stream.write_all(bytes);
        return;
    }
    if route == "/v1/root/status" {
        let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"ready":true,"model":"mock","authMode":"bearer","executionHost":"local","provider":"fixture","paid":false,"configurationRevision":"fixture-v1","instanceId":identity})).unwrap();
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        );
        let _ = stream.write_all(&bytes);
        return;
    }
    let bytes = serde_json::to_vec(&*snapshot.lock().unwrap()).unwrap();
    if route == "/v1/root/events" {
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: snapshot\ndata: ");
        // Split the frame to exercise network chunk boundaries, not just parser calls.
        for chunk in bytes.chunks(3) {
            let _ = stream.write_all(chunk);
        }
        let _ = stream.write_all(b"\n\n");
        let _ = stream.flush();
        let _ = stream.read(&mut buffer); // EOF once the client reconnects or quits.
    } else {
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        );
        let _ = stream.write_all(&bytes);
    }
}

#[test]
fn uncertain_retry_reuses_identity_and_quit_never_stops_task() {
    let fixture = Fixture::start();
    let (worker, updates) = Worker::start(Config::Http {
        url: fixture.url.clone(),
        bearer: Some("fixture-only-capability".into()),
    });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        async fn until(
            updates: &async_channel::Receiver<State>,
            predicate: impl Fn(&State) -> bool,
        ) -> State {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let state = updates.recv().await.unwrap();
                    if predicate(&state) {
                        return state;
                    }
                }
            })
            .await
            .unwrap()
        }
        until(&updates, |s| s.status == "Connected").await;
        worker
            .send(Command::Submit("hello 🐸\nsecond line".into()))
            .unwrap();
        until(&updates, |s| s.pending && s.request_error.is_some()).await;
        worker.send(Command::Retry).unwrap();
        let accepted = until(&updates, |s| s.accepted.is_some() && !s.pending).await;
        assert_eq!(accepted.snapshot.tasks[0].input, "hello 🐸\nsecond line");
        worker.send(Command::Reconnect).unwrap();
        let resumed = until(&updates, |s| {
            s.status == "Connected" && s.snapshot.active_task_id.is_some()
        })
        .await;
        assert_eq!(resumed.snapshot, accepted.snapshot);
    });
    drop(worker);
    drop(updates);
    std::thread::sleep(Duration::from_millis(50));
    let requests = fixture.requests.lock().unwrap();
    let submits = requests
        .iter()
        .filter(|(route, _)| route == "/v1/root/tasks")
        .map(|(_, body)| body)
        .collect::<Vec<_>>();
    assert_eq!(submits.len(), 2);
    assert_eq!(submits[0], submits[1]);
    assert!(requests.iter().all(|(route, _)| !route.ends_with("/stop")));
    assert!(requests.iter().all(|(route, _)| !route.contains("cursor")));
}

#[test]
fn approval_command_sends_exact_owner_decision_and_rejects_changed_intent() {
    let fixture = Fixture::start();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let record: crate::model::Approval = serde_json::from_value(serde_json::json!({"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","taskId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","toolCallId":"pi:fixture","toolName":"request_user_confirmation","args":{"message":"Confirm this message"},"digest":"a".repeat(64),"state":"pending","createdAt":1,"expiresAt":300001})).unwrap();
        let api = Api { revision: None, client: Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap(), url: fixture.url.clone(), bearer: Some("fixture-only-capability".into()) };
        let mut state = State::default(); state.snapshot.approvals.push(record.clone());
        let mut pending = None;
        let mut tampered = record.decision(true); tampered.digest = "b".repeat(64);
        handle(Command::DecideApproval(tampered), &api, &mut pending, &mut state).await;
        assert!(state.request_error.is_some()); assert!(fixture.requests.lock().unwrap().is_empty());
        handle(Command::DecideApproval(record.decision(false)), &api, &mut pending, &mut state).await;
        assert!(state.request_error.is_none());
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, format!("/v1/root/approvals/{}/decision", record.id));
        assert_eq!(requests[0].1, serde_json::json!({"taskId":record.task_id,"digest":record.digest,"decision":"deny"}));
    });
}

#[test]
fn local_reconnect_discovers_new_instance_without_submitting_or_stopping() {
    use std::os::unix::fs::PermissionsExt;
    let first_id = uuid::Uuid::new_v4().to_string();
    let second_id = uuid::Uuid::new_v4().to_string();
    let first = Fixture::with_identity(Some(first_id.clone()));
    let second = Fixture::with_identity(Some(second_id.clone()));
    let dir = std::env::temp_dir().join(format!("morons-reconnect-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.join("connection.json");
    let publish = |fixture: &Fixture, instance: &str| {
        let temp = dir.join("next.json");
        std::fs::write(&temp, serde_json::to_vec(&serde_json::json!({"version":1,"pid":1,"instanceId":instance,"baseUrl":fixture.url.as_str(),"authToken":format!("fixture-{instance}"),"configurationRevision":"fixture-v1"})).unwrap()).unwrap();
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::rename(temp, &path).unwrap();
    };
    publish(&first, &first_id);
    let (worker, updates) = Worker::start(Config::Local {
        discovery: path.clone(),
    });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        async fn connected(updates: &async_channel::Receiver<State>, id: &str) {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let state = updates.recv().await.unwrap();
                    if state.ready
                        && state.status == "Connected"
                        && state.action.as_ref().and_then(|a| a.instance_id.as_deref()) == Some(id)
                    {
                        break;
                    }
                }
            })
            .await
            .unwrap();
        }
        connected(&updates, &first_id).await;
        publish(&second, &second_id);
        worker.send(Command::Reconnect).unwrap();
        connected(&updates, &second_id).await;
    });
    drop(worker);
    for fixture in [&first, &second] {
        assert!(
            fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .all(|(route, _)| !route.ends_with("/stop") && route != "/v1/root/tasks")
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn provider_review_is_invalidated_by_configuration_change() {
    let fixture = Fixture::start();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let action: Status = serde_json::from_value(serde_json::json!({"version":1,"ready":true,"model":"selected-model","authMode":"bearer","provider":"openai","paid":true,"configurationRevision":"revision-one"})).unwrap();
        assert!(!action.fixture_only());
        let api = Api { revision: Some("revision-two".into()), client: Client::new(), url: fixture.url.clone(), bearer: Some("fixture-only-capability".into()) };
        let mut state = State { ready: true, action: Some(action.clone()), ..State::default() };
        handle(Command::SubmitReviewed { text: "fixture input".into(), action }, &api, &mut None, &mut state).await;
        assert_eq!(state.request_error, Some("Provider action changed; review the send again"));
        assert!(fixture.requests.lock().unwrap().is_empty());
    });
}
