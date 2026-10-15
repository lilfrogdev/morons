//! Bounded adapter for the self-hosted named-session HTTP contract.
//! The server remains authoritative; this only supplies the existing chat view.

use crate::model::{Message, Role, Snapshot, Task, TaskStatus};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedHistory {
    pub session_id: String,
    pub moron_id: String,
    pub messages: Vec<NamedMessage>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamedMessage {
    pub id: String,
    pub role: Role,
    pub text: String,
}

impl NamedHistory {
    pub fn into_snapshot(self) -> Result<Snapshot, &'static str> {
        if self.session_id.len() > 80
            || self.moron_id.len() > 80
            || self.messages.len() > 400
            || self
                .messages
                .iter()
                .any(|m| m.id.len() > 128 || m.text.len() > 1_048_576)
        {
            return Err("Invalid named history");
        }
        let mut snapshot = Snapshot::empty();
        let mut task_id: Option<String> = None;
        for item in self.messages {
            match item.role {
                Role::User => {
                    if snapshot.tasks.len() == 200 || item.text.len() > 8192 {
                        return Err("Named history exceeds client limit");
                    }
                    let id = uuid::Uuid::from_u128(snapshot.tasks.len() as u128 + 1).to_string();
                    snapshot.tasks.push(Task {
                        id: id.clone(),
                        status: TaskStatus::Completed,
                        input: item.text.clone(),
                        created_at: 0,
                        updated_at: 0,
                        error: None,
                    });
                    task_id = Some(id);
                }
                Role::Assistant if task_id.is_none() => return Err("Invalid named history order"),
                Role::Assistant => {}
            }
            snapshot.messages.push(Message {
                id: item.id,
                task_id: task_id.clone().expect("user was observed"),
                role: item.role,
                text: item.text,
                partial: false,
            });
        }
        snapshot.validate()?;
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapts_two_named_turns_for_the_gpui_chat_view() {
        let history: NamedHistory = serde_json::from_value(serde_json::json!({
            "sessionId":"s1", "moronId":"repo", "messages":[
                {"id":"m1","role":"user","text":"Inspect source"},
                {"id":"m2","role":"assistant","text":"I found Rust and TypeScript."},
                {"id":"m3","role":"user","text":"Remember that decision"}
            ]
        }))
        .unwrap();
        let snapshot = history.into_snapshot().unwrap();
        assert_eq!(snapshot.tasks.len(), 2);
        assert_eq!(snapshot.messages[0].task_id, snapshot.messages[1].task_id);
        assert_ne!(snapshot.messages[1].task_id, snapshot.messages[2].task_id);
    }

    #[test]
    fn rejects_unowned_assistant_entry() {
        let history: NamedHistory = serde_json::from_value(serde_json::json!({
            "sessionId":"s1", "moronId":"repo", "messages":[
                {"id":"m1","role":"assistant","text":"unexpected"}
            ]
        }))
        .unwrap();
        assert!(history.into_snapshot().is_err());
    }
}
