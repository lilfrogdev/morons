use serde::{Deserialize, Serialize};

// Protocol-only types: the backend owns persistence, task execution and identity.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub root_id: String,
    pub tasks: Vec<Task>,
    pub messages: Vec<Message>,
    pub active_task_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub status: TaskStatus,
    pub input: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Accepted,
    Running,
    Completed,
    Failed,
    Stopped,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub task_id: String,
    pub role: Role,
    pub text: String,
    pub partial: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

impl Snapshot {
    pub fn empty() -> Self {
        Self {
            version: 1,
            root_id: "root".into(),
            tasks: vec![],
            messages: vec![],
            active_task_id: None,
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 || self.root_id != "root" {
            return Err("Unsupported server protocol");
        }
        if self.messages.len() > 400 || self.tasks.len() > 200 {
            return Err("Server history exceeds client limit");
        }
        if self.messages.iter().any(|m| m.text.len() > 1_048_576) {
            return Err("Server message exceeds client limit");
        }
        if self
            .tasks
            .iter()
            .any(|t| uuid::Uuid::parse_str(&t.id).is_err() || t.input.len() > 8192)
        {
            return Err("Invalid server task");
        }
        if self.active_task_id.as_ref().is_some_and(|id| {
            !self.tasks.iter().any(|t| {
                &t.id == id && matches!(t.status, TaskStatus::Accepted | TaskStatus::Running)
            })
        }) {
            return Err("Invalid active task");
        }
        if self
            .messages
            .iter()
            .any(|m| !self.tasks.iter().any(|t| t.id == m.task_id))
        {
            return Err("Invalid message task");
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub version: u32,
    pub ready: bool,
    pub model: String,
    pub auth_mode: String,
}
