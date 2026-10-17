use serde::Deserialize;

pub const MODES: [(&str, &str, &str); 4] = [
    ("approval-required", "Supervised", "Ask before commands and file changes."),
    ("auto-accept-edits", "Auto-accept edits", "Auto-approve edits, ask before other actions."),
    ("auto", "Auto", "Supported providers approve routine actions; others still ask."),
    ("full-access", "Full access", "Allow commands and edits without prompts."),
];
pub fn mode_label(mode: &str) -> &'static str {
    MODES.iter().find(|option| option.0 == mode).map(|option| option.1).unwrap_or("Permissions unavailable")
}
pub fn valid_mode(mode: &str) -> bool { MODES.iter().any(|option| option.0 == mode) }
fn hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionState {
    pub session_id: String,
    pub workspace_id: String,
    pub repository_id: Option<String>,
    pub mode: String,
    pub revision: u64,
    pub auto_review_supported: bool,
    pub pending: Vec<PermissionRequest>,
}
impl PermissionState {
    pub fn valid_for(&self, session: &str, workspace: &str) -> bool {
        self.session_id == session && self.workspace_id == workspace && valid_mode(&self.mode) &&
            self.revision > 0 && self.pending.len() <= 64 && self.pending.iter().all(|request|
                request.session_id == session && request.workspace_id == workspace &&
                request.repository_id == self.repository_id && request.valid())
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub repository_id: Option<String>,
    pub kind: String,
    pub action: serde_json::Value,
    pub proposal_id: Option<String>,
    pub base_revision: Option<String>,
    pub fingerprint: String,
    pub status: String,
}
impl PermissionRequest {
    fn valid(&self) -> bool {
        uuid::Uuid::parse_str(&self.id).is_ok() && hex(&self.fingerprint, 64) && self.status == "pending" &&
            matches!(self.kind.as_str(), "read" | "edit" | "command" | "source-apply" | "external-request") &&
            self.action.is_object() && serde_json::to_vec(&self.action).is_ok_and(|bytes| bytes.len() <= 524288) &&
            self.proposal_id.as_ref().is_none_or(|value| value.len() <= 160) &&
            self.base_revision.as_ref().is_none_or(|value| value.len() <= 160)
    }
    pub fn preview(&self) -> String {
        let mut preview = format!("Session: {}\nWorkspace: {}\nRepository: {}\nAction: {}\n",
            self.session_id, self.workspace_id, self.repository_id.as_deref().unwrap_or("None"), self.kind);
        if let Some(value) = &self.proposal_id { preview.push_str(&format!("Proposal: {value}\n")); }
        if let Some(value) = &self.base_revision { preview.push_str(&format!("Base: {value}\n")); }
        preview.push_str(&serde_json::to_string_pretty(&self.action).unwrap_or_default());
        preview
    }
}
