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
    #[serde(default)]
    pub approvals: Vec<Approval>,
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
            approvals: vec![],
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 || self.root_id != "root" {
            return Err("Unsupported server protocol");
        }
        if self.approvals.len() > 400
            || self.approvals.iter().any(|approval| {
                !approval.valid() || !self.tasks.iter().any(|task| task.id == approval.task_id)
            })
        {
            return Err("Invalid server approval");
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub task_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: serde_json::Value,
    pub digest: String,
    pub state: ApprovalState,
    pub created_at: u64,
    pub expires_at: u64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalState {
    Pending,
    Approved,
    Denied,
    Expired,
    Cancelled,
    Consumed,
}
impl Approval {
    pub fn valid(&self) -> bool {
        uuid::Uuid::parse_str(&self.id).is_ok()
            && uuid::Uuid::parse_str(&self.task_id).is_ok()
            && !self.tool_call_id.is_empty()
            && self.tool_call_id.len() <= 256
            && !self.tool_name.is_empty()
            && self.tool_name.len() <= 64
            && self
                .tool_name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
            && self.args.is_object()
            && self.args.to_string().len() <= 2048
            && self.digest.len() == 64
            && self
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
    pub fn decision(&self, approve: bool) -> ApprovalDecision {
        ApprovalDecision {
            id: self.id.clone(),
            task_id: self.task_id.clone(),
            digest: self.digest.clone(),
            decision: if approve { "approve" } else { "deny" }.into(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalDecision {
    pub id: String,
    pub task_id: String,
    pub digest: String,
    pub decision: String,
}
impl ApprovalDecision {
    pub fn matches(&self, record: &Approval) -> bool {
        record.valid()
            && record.state == ApprovalState::Pending
            && record.id == self.id
            && record.task_id == self.task_id
            && record.digest == self.digest
            && matches!(self.decision.as_str(), "approve" | "deny")
    }
}

#[cfg(test)]
mod approval_tests {
    use super::*;
    fn record() -> Approval {
        serde_json::from_value(serde_json::json!({"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","taskId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","toolCallId":"pi:fixture","toolName":"request_user_confirmation","args":{"message":"Confirm only this message"},"digest":"a".repeat(64),"state":"pending","createdAt":1000,"expiresAt":301000})).unwrap()
    }
    #[test]
    fn old_snapshots_default_to_no_approvals() {
        let snapshot: Snapshot = serde_json::from_value(serde_json::json!({"version":1,"rootId":"root","tasks":[],"messages":[],"activeTaskId":null})).unwrap();
        assert!(snapshot.approvals.is_empty());
        assert!(snapshot.validate().is_ok());
    }
    #[test]
    fn decisions_bind_task_digest_and_pending_state() {
        let mut record = record();
        let decision = record.decision(true);
        assert!(decision.matches(&record));
        record.digest = "b".repeat(64);
        assert!(!decision.matches(&record));
        record = self::record();
        record.task_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into();
        assert!(!decision.matches(&record));
        record = self::record();
        record.state = ApprovalState::Consumed;
        assert!(!decision.matches(&record));
        record = self::record();
        assert!(
            !ApprovalDecision {
                decision: "automatic".into(),
                ..decision
            }
            .matches(&record)
        );
    }
    #[test]
    fn metadata_is_bounded_and_digest_is_exact() {
        let mut record = record();
        assert!(record.valid());
        record.digest = "G".repeat(64);
        assert!(!record.valid());
        record = self::record();
        record.args = serde_json::json!({"message":"x".repeat(2049)});
        assert!(!record.valid());
    }
}
