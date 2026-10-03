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
    assert!(
        headers
            .to_lowercase()
            .contains("authorization: bearer fixture-only")
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
