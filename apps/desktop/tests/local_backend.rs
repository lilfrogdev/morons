use morons_desktop::{
    model::{Snapshot, TaskStatus},
    transport::{Command, Config, State, Worker},
};
use reqwest::{Client, Url};
use std::time::Duration;

async fn until(
    updates: &async_channel::Receiver<State>,
    predicate: impl Fn(&State) -> bool,
) -> State {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let state = updates.recv().await.expect("transport closed");
            if predicate(&state) {
                return state;
            }
        }
    })
    .await
    .expect("transport state deadline exceeded")
}

// Run against a disposable local Worker with the mock entry point. This test
// writes history and must never target a shared demo or production backend.
#[tokio::test]
#[ignore = "requires a disposable mock Worker and MORONS_TEST_BACKEND_URL/TOKEN"]
async fn public_transport_against_local_worker() {
    let url = Url::parse(&std::env::var("MORONS_TEST_BACKEND_URL").unwrap()).unwrap();
    assert_eq!(url.scheme(), "http");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.path(), "/");
    let token = std::env::var("MORONS_TEST_BACKEND_TOKEN").unwrap();
    let api = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let route = |path: &str| url.join(&format!("v1/root/{path}")).unwrap();
    let status: serde_json::Value = api
        .get(route("status"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["model"], "mock", "refuse provider-backed tests");
    assert_eq!(status["ready"], true);
    assert_eq!(status["version"], 1);
    assert_eq!(status["authMode"], "bearer");
    assert_eq!(status["limits"]["maxInputBytes"], 8192);
    assert_eq!(status["limits"]["maxTasks"], 200);
    assert_eq!(status["limits"]["maxHistoryBytes"], 524288);
    assert_eq!(status["limits"]["maxOutputTokens"], 4096);
    let initial: Snapshot = api
        .get(route("snapshot"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        initial.tasks.is_empty(),
        "requires disposable empty history"
    );
    assert_eq!(
        api.get(route("snapshot")).send().await.unwrap().status(),
        401
    );
    let config = || Config::Http {
        url: url.clone(),
        bearer: Some(token.clone()),
    };
    let (worker, updates) = Worker::start(config());
    until(&updates, |s| s.status == "Connected").await;
    let text = "slow: integration 🐸";
    worker.send(Command::Submit(text.into())).unwrap();
    let accepted = until(&updates, |s| s.accepted.is_some()).await;
    let id = accepted.accepted.unwrap().0;
    assert_eq!(
        accepted.snapshot.active_task_id.as_deref(),
        Some(id.as_str())
    );
    let body = serde_json::json!({"requestId": id, "text": text});
    assert_eq!(
        api.post(route("tasks"))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        api.post(route("tasks"))
            .bearer_auth(&token)
            .json(&serde_json::json!({"requestId":id, "text":"different"}))
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    drop(worker);
    drop(updates);
    // No transport is alive while the server finishes accepted work.
    let completed = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let snapshot: Snapshot = api
                .get(route("snapshot"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if snapshot.tasks[0].status == TaskStatus::Completed {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    completed.validate().unwrap();
    assert_eq!(completed.tasks.len(), 1);
    assert_eq!(completed.messages[1].text, format!("Mock: {text}"));
    let (worker, updates) = Worker::start(config());
    until(&updates, |s| {
        s.status == "Connected" && s.snapshot == completed
    })
    .await;
    worker
        .send(Command::Submit("slow: stop exact task".into()))
        .unwrap();
    let active = until(&updates, |s| s.snapshot.active_task_id.is_some()).await;
    let active_id = active.snapshot.active_task_id.unwrap();
    assert_ne!(active_id, id);
    assert_eq!(
        api.post(route(&format!("tasks/{id}/stop")))
            .bearer_auth(&token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let after_old_stop: Snapshot = api
        .get(route("snapshot"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after_old_stop.active_task_id.as_ref(), Some(&active_id));
    worker.send(Command::Stop(active_id.clone())).unwrap();
    until(&updates, |s| {
        s.snapshot
            .tasks
            .iter()
            .any(|t| t.id == active_id && t.status == TaskStatus::Stopped)
    })
    .await;
    worker.send(Command::Submit("fail".into())).unwrap();
    let failed = until(&updates, |s| {
        s.snapshot
            .tasks
            .iter()
            .any(|t| t.status == TaskStatus::Failed)
    })
    .await;
    assert!(failed.snapshot.active_task_id.is_none());
    assert_eq!(failed.snapshot.tasks.len(), 3);
    assert_eq!(
        failed.snapshot.tasks.last().unwrap().error.as_deref(),
        Some("Model execution failed or exceeded its limits.")
    );
}
