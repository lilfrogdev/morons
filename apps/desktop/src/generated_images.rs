use serde::Deserialize;
use std::sync::Arc;

pub const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProviderStatus {
    pub configured: bool,
    pub model: String,
    pub authentication: String,
    pub subscription_supported: bool,
    pub message: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    pub id: String,
    pub account_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub moron_id: String,
    pub title: String,
    pub status: String,
    pub model: String,
    pub created_at: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub byte_length: usize,
    pub mime_type: String,
    pub error: Option<String>,
    pub usage: Option<serde_json::Value>,
    pub cost_known: bool,
    #[serde(skip)]
    pub bytes: Option<Arc<Vec<u8>>>,
}

#[derive(Deserialize)]
pub struct GeneratedImages { pub images: Vec<GeneratedImage> }

impl GeneratedImage {
    pub fn valid_for(&self, account: &str, workspace: &str, session: &str, moron: &str) -> bool {
        self.id.len() == 36 && self.id.starts_with("img-") &&
            self.id[4..].bytes().all(|c| c.is_ascii_hexdigit()) &&
            self.account_id == account && self.workspace_id == workspace &&
            self.session_id == session && self.moron_id == moron &&
            !self.title.is_empty() && self.title.len() <= 480 && self.model.len() <= 128 &&
            self.mime_type == "image/png" && self.byte_length <= MAX_IMAGE_BYTES &&
            self.error.as_ref().is_none_or(|error| error.len() <= 512) &&
            matches!(self.status.as_str(), "generating" | "completed" | "failed" | "uncertain") &&
            (self.status != "completed" || self.width.zip(self.height).is_some_and(|(w, h)|
                w > 0 && h > 0 && w <= 4096 && h <= 4096 && u64::from(w) * u64::from(h) <= 8_388_608))
    }
    pub fn accepts_bytes(&self, bytes: &[u8]) -> bool {
        bytes.len() == self.byte_length && bytes.len() >= 33 && bytes.len() <= MAX_IMAGE_BYTES &&
            bytes[..8] == [137, 80, 78, 71, 13, 10, 26, 10] && &bytes[12..16] == b"IHDR" &&
            Some(u32::from_be_bytes(bytes[16..20].try_into().unwrap())) == self.width &&
            Some(u32::from_be_bytes(bytes[20..24].try_into().unwrap())) == self.height
    }
}
