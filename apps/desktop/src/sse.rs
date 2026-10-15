


const MAX_EVENT: usize = 8 * 1024 * 1024;
#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
    data: Vec<u8>,
    event: String,
    cr: bool,
}

impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, &'static str> {
        let mut snapshots = Vec::new();
        for &byte in bytes {
            if self.cr {
                self.cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if byte == b'\r' || byte == b'\n' {
                self.cr = byte == b'\r';
                if self.pending.is_empty() {
                    if self.event == "snapshot" && !self.data.is_empty() {
                        self.data.pop();
                        snapshots.push(std::mem::take(&mut self.data));
                    }
                    self.event.clear();
                    self.data.clear();
                } else {
                    let line = std::mem::take(&mut self.pending);
                    let text = std::str::from_utf8(&line).map_err(|_| "Invalid stream encoding")?;
                    if let Some(value) = text.strip_prefix("event:") {
                        self.event = value.strip_prefix(' ').unwrap_or(value).into();
                    }
                    if let Some(value) = text.strip_prefix("data:") {
                        self.data
                            .extend_from_slice(value.strip_prefix(' ').unwrap_or(value).as_bytes());
                        self.data.push(b'\n');
                    }
                }
            } else {
                self.pending.push(byte);
            }
            if self.pending.len() + self.data.len() > MAX_EVENT {
                return Err("Server stream exceeds client limit");
            }
        }
        Ok(snapshots)
    }
}
