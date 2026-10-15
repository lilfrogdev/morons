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
                        std::thread::spawn(move || serve(stream, requests, snapshot));
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
    let route = headers
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    if route != "/v1/session/login" && route != "/v1/accounts/bootstrap" {
        assert!(headers.to_lowercase().contains("authorization: bearer fixture-only") ||
            headers.to_lowercase().contains("authorization: bearer fixture-only-account-token-00000000"));
    }
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    let mut records = requests.lock().unwrap();
    records.push((route.clone(), body.clone()));
    let submits = records
        .iter()
        .filter(|(r, _)| r == "/v1/root/tasks")
        .count();
    let named_submit = records
        .iter()
        .rev()
        .find(|(r, _)| r == "/v1/sessions/main/chat")
        .map(|(_, body)| body.clone());
    drop(records);
    if route.starts_with("/v1/") && !route.starts_with("/v1/root/") {
        let reply = match route.as_str() {
            "/v1/session/login" => serde_json::json!({"token":"fixture-only-account-token-00000000","expiresAt":9999999999999_u64}),
            "/v1/accounts/bootstrap" => serde_json::json!({"account":{"id":"fixture-account","name":"owner"}}),
            "/v1/session/logout" => serde_json::json!({"signedOut":true}),
            "/v1/session/me" => serde_json::json!({"account":{"id":"fixture-account","name":"owner"}}),
            "/v1/provider/openai/status" => serde_json::json!({"available":true,"provider":{"state":"awaiting_callback","authorizationUrl":"https://auth.openai.com/api/accounts/authorize?state=mock"}}),
            "/v1/models" => {
                serde_json::json!({"models":[{"provider":"morons-fixture","id":"fixture","label":"Offline fixture","available":true}]})
            }
            "/v1/morons" => serde_json::json!({"morons":[{"id":"repo","name":"Repository"}]}),
            "/v1/morons/repo/sessions" => serde_json::json!({"sessions":[{"id":"main"}]}),
            "/v1/sessions/main/history" => {
                let messages = named_submit.as_ref().map(|body| vec![
                    serde_json::json!({"id":"user-1","role":"user","text":body["text"]}),
                    serde_json::json!({"id":"assistant-1","role":"assistant","text":"Fixture answer"}),
                ]).unwrap_or_default();
                serde_json::json!({"sessionId":"main","moronId":"repo","messages":messages})
            }
            "/v1/sessions/main/reviews" => {
                if named_submit.as_ref().is_some_and(|body| body["text"].as_str().is_some_and(|text| text.starts_with("/review"))) {
                    serde_json::json!({"reviews":[{"id":"aaaaaaaaaaaaaaaa","branch":"morons-review/aaaaaaaaaaaaaaaa","baseRevision":"1111111111111111111111111111111111111111","checks":[{"ok":true}],"decision":"pending"}]})
                } else { serde_json::json!({"reviews":[]}) }
            }
            "/v1/sessions/main/visualizations" => {
                if named_submit.as_ref().is_some_and(|body| body["text"] == "/viz") {
                    serde_json::json!({"accountId":"fixture-account","threadId":"main","accessEpoch":"test-epoch","leaseMs":5000,"documents":[{"version":1,"id":"viz-1","accountId":"fixture-account","threadId":"main","sourceMessageId":"assistant-1","sourceRevision":"r","createdAt":1,"content":{"kind":"bar","title":"Checks","xLabel":"Run","yLabel":"Passed","points":[{"label":"one","value":3}]}}]})
                } else { serde_json::json!({"accountId":"fixture-account","threadId":"main","accessEpoch":"test-epoch","leaseMs":5000,"documents":[]}) }
            }
            "/v1/reviews/aaaaaaaaaaaaaaaa" => serde_json::json!({"review":{"id":"aaaaaaaaaaaaaaaa","branch":"morons-review/aaaaaaaaaaaaaaaa","baseRevision":"1111111111111111111111111111111111111111","diff":"+after","checks":[{"ok":true}],"decision":"pending"}}),
            "/v1/sessions/main/chat" => {
                serde_json::json!({"requestId":body["requestId"],"answer":"Fixture answer"})
            }
            _ => serde_json::json!({"error":"not_found"}),
        };
        let bytes = serde_json::to_vec(&reply).unwrap();
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        );
        let _ = stream.write_all(&bytes);
        return;
    }
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
        let bytes =
            br#"{"version":1,"ready":true,"model":"mock","authMode":"bearer","futureField":true}"#;
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        );
        let _ = stream.write_all(bytes);
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
        bearer: Some("fixture-only".into()),
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
fn named_session_chat_reconnects_with_server_history() {
    let fixture = Fixture::start();
    let (worker, updates) = Worker::start(Config::Named {
        url: fixture.url.clone(),
        bearer: "fixture-only".into(),
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
        let initial = until(&updates, |s| s.status == "Connected").await;
        assert_eq!(initial.model.as_deref(), Some("Offline fixture"));
        assert_eq!(initial.selected_moron.as_deref(), Some("repo"));
        worker
            .send(Command::Submit("Inspect this repo".into()))
            .unwrap();
        until(&updates, |s| s.accepted.is_some()).await;
        let resumed = until(&updates, |s| s.snapshot.messages.len() == 2).await;
        assert_eq!(resumed.snapshot.messages[0].text, "Inspect this repo");
        assert_eq!(resumed.snapshot.messages[1].text, "Fixture answer");
    });
    drop(worker);
    drop(updates);
    let requests = fixture.requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .any(|(route, _)| route == "/v1/morons/repo/sessions")
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(route, _)| route == "/v1/sessions/main/chat")
            .count(),
        1
    );
}

#[test]
fn named_review_arrives_with_diff_and_records_human_decision() {
    let fixture = Fixture::start();
    let (worker, updates) = Worker::start(Config::Named {
        url: fixture.url.clone(),
        bearer: "fixture-only".into(),
    });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        async fn until(updates: &async_channel::Receiver<State>, predicate: impl Fn(&State) -> bool) -> State {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop { let state = updates.recv().await.unwrap(); if predicate(&state) { return state; } }
            }).await.unwrap()
        }
        until(&updates, |state| state.ready).await;
        worker.send(Command::Submit("/review\ndiff --git a/README.md b/README.md".into())).unwrap();
        let review = until(&updates, |state| state.review.is_some()).await.review.unwrap();
        assert_eq!(review.diff, "+after");
        assert!(review.checks[0].ok);
        worker.send(Command::ReviewDecision { id: review.id, decision: ReviewDecision::Approve }).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if fixture.requests.lock().unwrap().iter().any(|(route, body)|
                    route == "/v1/reviews/aaaaaaaaaaaaaaaa/decision" && body["decision"] == "approve") { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
    });
}

#[test]
fn named_account_setup_signin_and_logout_use_in_app_credentials() {
    let fixture = Fixture::start();
    let (worker, updates) = Worker::start(Config::NamedLogin { url: fixture.url.clone() });
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let signed_out = tokio::time::timeout(Duration::from_secs(10), async {
            loop { let state = updates.recv().await.unwrap(); if state.account_login { break state; } }
        }).await.unwrap();
        assert!(!signed_out.ready);
        worker.send(Command::AccountCreate { name: "owner".into(), password: "offline-password-123".into(),
            bootstrap: "offline-bootstrap-token-for-test-123".into() }).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let state = updates.recv().await.unwrap();
                if state.status == "Account created. Sign in." { break; }
            }
        }).await.unwrap();
        worker.send(Command::AccountLogin { name: "owner".into(), password: "offline-password-123".into() }).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop { let state = updates.recv().await.unwrap(); if state.ready { assert!(!state.account_login); break; } }
        }).await.unwrap();
        worker.send(Command::AccountLogout).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop { let state = updates.recv().await.unwrap(); if state.account_login { break; } }
        }).await.unwrap();
        let requests = fixture.requests.lock().unwrap();
        assert!(requests.iter().any(|(route, _)| route == "/v1/accounts/bootstrap"));
        assert!(requests.iter().any(|(route, _)| route == "/v1/session/login"));
        assert!(requests.iter().any(|(route, _)| route == "/v1/session/logout"));
    });
}

#[test]
fn named_bearer_launch_can_sign_in_again_after_logout() {
    let fixture = Fixture::start();
    let (worker, updates) = Worker::start(Config::Named {
        url: fixture.url.clone(), bearer: "fixture-only".into(),
    });
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        async fn until(updates: &async_channel::Receiver<State>, predicate: impl Fn(&State) -> bool) {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop { let state = updates.recv().await.unwrap(); if predicate(&state) { break; } }
            }).await.unwrap();
        }
        until(&updates, |state| state.ready).await;
        worker.send(Command::AccountLogout).unwrap();
        until(&updates, |state| state.account_login).await;
        worker.send(Command::AccountLogin { name: "owner".into(), password: "offline-password-123".into() }).unwrap();
        until(&updates, |state| state.ready && !state.account_login).await;
    });
}

#[test]
fn named_provider_handoff_sends_only_user_selected_actions() {
    let fixture = Fixture::start();
    let (worker, updates) = Worker::start(Config::Named { url: fixture.url.clone(), bearer: "fixture-only".into() });
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let state = updates.recv().await.unwrap();
                if state.ready {
                    assert!(state.provider_available);
                    assert_eq!(state.provider_url.as_deref(), Some("https://auth.openai.com/api/accounts/authorize?state=mock"));
                    break;
                }
            }
        }).await.unwrap();
        worker.send(Command::ProviderStart).unwrap();
        let callback = "http://127.0.0.1:1455/auth/callback?code=mock&state=mock";
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if fixture.requests.lock().unwrap().iter().any(|(route, _)| route == "/v1/provider/openai/start") { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        worker.send(Command::ProviderCallback(callback.into())).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if fixture.requests.lock().unwrap().iter().any(|(route, body)|
                    route == "/v1/provider/openai/callback" && body["url"] == callback) { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
    });
}

#[test]
fn named_visualization_is_parsed_for_the_authenticated_session() {
    let fixture = Fixture::start();
    let (worker, updates) = Worker::start(Config::Named { url: fixture.url.clone(), bearer: "fixture-only".into() });
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop { if updates.recv().await.unwrap().ready { break; } }
        }).await.unwrap();
        worker.send(Command::Submit("/viz".into())).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let state = updates.recv().await.unwrap();
                if !state.visualizations.is_empty() {
                    assert_eq!(state.visualizations[0].account_id, "fixture-account");
                    assert_eq!(state.visualizations[0].thread_id, "main");
                    assert!(state.visualization_expires_at.unwrap() > Instant::now());
                    break;
                }
            }
        }).await.unwrap();
    });
}
