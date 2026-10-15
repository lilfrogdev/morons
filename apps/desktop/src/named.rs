


use crate::model::{Handoff, Message, Role, Snapshot, Task, TaskStatus};
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
    pub handoff: Option<Handoff>,
}

impl NamedHistory {
    pub fn into_snapshot(self) -> Result<Snapshot, &'static str> {
        if self.session_id.len() > 80
            || self.moron_id.len() > 80
            || self.messages.len() > 400
            || self
                .messages
                .iter()
                .any(|m| m.id.len() > 128 || m.text.len() > 1_048_576 || m.handoff.as_ref().is_some_and(|h|
                    h.target_moron_id.len() > 40 || h.answer.len() > 4096))
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
                handoff: item.handoff,
            });
        }
        snapshot.validate()?;
        Ok(snapshot)
    }
}
