use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const SERVICE: &str = "morons://local/chatgpt-session/v1";
pub const MAX_BYTES: usize = 65_536;

// Dedicated inherited pipe protocol, not a public socket or agent tool. The
// controlling signed service must consume exact user authorization BEFORE spawn.
// No Debug implementation: payloads and responses may contain credentials.
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Read {
        version: u8,
        slot: String,
    },
    Write {
        version: u8,
        slot: String,
        payload: String,
    },
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Found { payload: String },
    Missing,
    Stored,
    Failed,
}
pub trait ProtectedBackend {
    fn read(&mut self, slot: &str) -> Result<Option<Zeroizing<Vec<u8>>>, ()>;
    fn write(&mut self, slot: &str, value: &[u8]) -> Result<(), ()>;
}
fn valid_slot(slot: &str) -> bool {
    slot.len() == 64
        && slot
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub fn execute<B: ProtectedBackend>(backend: &mut B, encoded: &[u8]) -> Response {
    if encoded.len() > MAX_BYTES + 1024 {
        return Response::Failed;
    }
    let Ok(request) = serde_json::from_slice::<Request>(encoded) else {
        return Response::Failed;
    };
    match request {
        Request::Read { version, slot } => {
            if version != 1 || !valid_slot(&slot) {
                return Response::Failed;
            }
            match backend.read(&slot) {
                Ok(Some(payload)) if payload.len() <= MAX_BYTES => {
                    match String::from_utf8(payload.to_vec()) {
                        Ok(payload) => Response::Found { payload },
                        Err(_) => Response::Failed,
                    }
                }
                Ok(None) => Response::Missing,
                _ => Response::Failed,
            }
        }
        Request::Write {
            version,
            slot,
            payload,
        } => {
            let payload = Zeroizing::new(payload);
            if version != 1 || !valid_slot(&slot) || payload.is_empty() || payload.len() > MAX_BYTES
            {
                return Response::Failed;
            }
            if backend.write(&slot, payload.as_bytes()).is_ok() {
                Response::Stored
            } else {
                Response::Failed
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub struct MacKeychain;
#[cfg(target_os = "macos")]
impl ProtectedBackend for MacKeychain {
    fn read(&mut self, slot: &str) -> Result<Option<Zeroizing<Vec<u8>>>, ()> {
        match security_framework::passwords::get_generic_password(SERVICE, slot) {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(_) => Err(()),
        }
    }
    fn write(&mut self, slot: &str, value: &[u8]) -> Result<(), ()> {
        // One SecItem update holds the ENTIRE record; never independently rotate
        // access/refresh/ID token fields or delete the old item before replacing.
        security_framework::passwords::set_generic_password(SERVICE, slot, value).map_err(|_| ())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        calls: usize,
        value: Option<Vec<u8>>,
        fail: bool,
    }
    impl ProtectedBackend for Fixture {
        fn read(&mut self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, ()> {
            self.calls += 1;
            if self.fail {
                Err(())
            } else {
                Ok(self.value.clone().map(Zeroizing::new))
            }
        }
        fn write(&mut self, _: &str, value: &[u8]) -> Result<(), ()> {
            self.calls += 1;
            if self.fail {
                Err(())
            } else {
                self.value = Some(value.to_vec());
                Ok(())
            }
        }
    }
    fn fixture() -> Fixture {
        Fixture {
            calls: 0,
            value: None,
            fail: false,
        }
    }
    #[test]
    fn malformed_requests_never_access_keychain() {
        let mut backend = fixture();
        for body in [
            r#"{}"#,
            r#"{"action":"read","version":1,"slot":"other-service"}"#,
            r#"{"action":"read","version":2,"slot":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            r#"{"action":"read","version":1,"slot":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","extra":"secret"}"#,
        ] {
            assert!(matches!(
                execute(&mut backend, body.as_bytes()),
                Response::Failed
            ));
        }
        assert_eq!(backend.calls, 0);
    }
    #[test]
    fn stores_whole_bundle_and_reads_only_explicit_slot() {
        let mut backend = fixture();
        let write = serde_json::json!({"action":"write","version":1,"slot":"a".repeat(64),"payload":"synthetic-whole-bundle"}).to_string();
        assert!(matches!(
            execute(&mut backend, write.as_bytes()),
            Response::Stored
        ));
        let read =
            serde_json::json!({"action":"read","version":1,"slot":"a".repeat(64)}).to_string();
        match execute(&mut backend, read.as_bytes()) {
            Response::Found { payload } => assert_eq!(payload, "synthetic-whole-bundle"),
            _ => panic!("fixture read failed"),
        }
        assert_eq!(backend.calls, 2);
    }
    #[test]
    fn storage_failure_retains_old_fixture_and_returns_fixed_error() {
        let mut backend = fixture();
        backend.value = Some(b"synthetic-old".to_vec());
        backend.fail = true;
        let body = serde_json::json!({"action":"write","version":1,"slot":"a".repeat(64),"payload":"synthetic-new"}).to_string();
        assert!(matches!(
            execute(&mut backend, body.as_bytes()),
            Response::Failed
        ));
        assert_eq!(backend.value.unwrap(), b"synthetic-old");
        assert_eq!(
            serde_json::to_string(&Response::Failed).unwrap(),
            r#"{"status":"failed"}"#
        );
    }
}
