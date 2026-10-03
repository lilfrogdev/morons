// Parse bytes only after a complete line arrives, preserving split UTF-8 codepoints.
// Full snapshots are bounded to 8 MiB. IDs are deliberately ignored: reconnect
// fetches fresh authoritative state rather than replaying an event cursor.
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_byte_boundary_preserves_unicode_and_crlf() {
        let wire =
            ": heartbeat\r\nevent: snapshot\r\ndata: {\"text\":\"🐸 café\"}\r\n\r\n".as_bytes();
        for split in 0..=wire.len() {
            let mut parser = Decoder::default();
            let mut got = parser.push(&wire[..split]).unwrap();
            got.extend(parser.push(&wire[split..]).unwrap());
            assert_eq!(got, vec!["{\"text\":\"🐸 café\"}".as_bytes()]);
        }
    }
    #[test]
    fn multiple_events_and_multiline_data() {
        let mut parser = Decoder::default();
        assert_eq!(parser.push(b"event: snapshot\ndata: {\ndata: }\n\nevent: ignored\ndata: secret\n\nevent: snapshot\ndata: {}\n\n").unwrap(), vec![b"{\n}".to_vec(), b"{}".to_vec()]);
    }
    #[test]
    fn incomplete_and_oversized_events_are_not_published() {
        let mut parser = Decoder::default();
        assert!(
            parser
                .push(b"event: snapshot\ndata: {}")
                .unwrap()
                .is_empty()
        );
        assert!(parser.push(&vec![b'x'; MAX_EVENT]).is_err());
    }
}
