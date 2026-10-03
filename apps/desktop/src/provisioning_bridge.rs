use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use zeroize::Zeroizing;
const MAX_FRAME: usize = 6 * 1024 * 1024;

// No Debug implementation: the child receives credentials only in bounded
// stdin frames. stderr is discarded and environment credentials are not inherited.
pub struct Bridge {
    child: Child,
    stdin: Option<ChildStdin>,
    replies: mpsc::Receiver<Result<Vec<u8>, &'static str>>,
    id: u64,
}
pub fn fixture_mode() -> bool {
    cfg!(debug_assertions) && std::env::var("MORONS_SETUP_FIXTURE").as_deref() == Ok("1")
}
impl Bridge {
    pub fn spawn() -> Result<Self, &'static str> {
        if fixture_mode() {
            return Self::spawn_fixed(
                "/opt/homebrew/bin/node",
                &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("test/fixtures/provisioning-fixture.cjs"),
                "--fixture",
            );
        }
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/provisioning/dist/src/bridge.js");
        if !script.is_file() {
            return Err("Build the provisioning sidecar before cloud setup");
        }
        let node = "/opt/homebrew/bin/node";
        Self::spawn_fixed(node, &script, "--stdio")
    }
    fn spawn_fixed(node: &str, script: &std::path::Path, mode: &str) -> Result<Self, &'static str> {
        let mut child = Command::new(node)
            .arg(script)
            .arg(mode)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Provisioning sidecar unavailable; Node 22.19 or newer is required")?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Provisioning sidecar unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Provisioning sidecar unavailable")?;
        let (send, replies) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut frame = Vec::new();
                let result = loop {
                    let buffer = match reader.fill_buf() {
                        Ok(b) => b,
                        Err(_) => break Err("Provisioning connection failed"),
                    };
                    if buffer.is_empty() {
                        break Err("Provisioning connection closed");
                    }
                    let count = buffer
                        .iter()
                        .position(|b| *b == b'\n')
                        .map(|n| n + 1)
                        .unwrap_or(buffer.len());
                    if frame.len() + count > MAX_FRAME {
                        break Err("Provisioning response exceeds limit");
                    }
                    frame.extend_from_slice(&buffer[..count]);
                    reader.consume(count);
                    if frame.last() == Some(&b'\n') {
                        break Ok(frame);
                    }
                };
                let stop = result.is_err();
                if send.send(result).is_err() || stop {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin: Some(stdin),
            replies,
            id: 0,
        })
    }
    pub fn request<P: Serialize, R: DeserializeOwned>(
        &mut self,
        payload: &P,
    ) -> Result<R, &'static str> {
        self.id += 1;
        #[derive(Serialize)]
        struct Request<'a, P> {
            id: u64,
            #[serde(flatten)]
            payload: &'a P,
        }
        let mut frame = Zeroizing::new(
            serde_json::to_vec(&Request {
                id: self.id,
                payload,
            })
            .map_err(|_| "Invalid provisioning request")?,
        );
        if frame.len() + 1 > MAX_FRAME {
            return Err("Provisioning request exceeds limit");
        }
        frame.push(b'\n');
        let mut stdin = self
            .stdin
            .take()
            .ok_or("Provisioning connection unavailable")?;
        let (sent, receipt) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = stdin.write_all(&frame).and_then(|_| stdin.flush());
            drop(frame);
            let _ = sent.send((stdin, result));
        });
        let (stdin, write) = match receipt.recv_timeout(Duration::from_secs(60)) {
            Ok(result) => result,
            Err(_) => {
                let _ = self.child.kill();
                return Err("Provisioning write timed out; deployment state may be unknown");
            }
        };
        if write.is_err() {
            let _ = self.child.kill();
            return Err("Provisioning connection failed");
        }
        self.stdin = Some(stdin);
        let result = match self.replies.recv_timeout(Duration::from_secs(60)) {
            Ok(result) => result,
            Err(_) => {
                self.stdin.take();
                let _ = self.child.kill();
                return Err("Provisioning timed out; deployment state may be unknown");
            }
        };
        let frame = Zeroizing::new(result?);
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Reply {
            id: u64,
            ok: bool,
            result: Option<serde_json::Value>,
            error: Option<serde_json::Value>,
        }
        let reply: Reply =
            serde_json::from_slice(&frame).map_err(|_| "Invalid provisioning response")?;
        if reply.id != self.id {
            let _ = self.child.kill();
            return Err("Mismatched provisioning response");
        }
        if !reply.ok {
            return Err("Provisioning failed; review cloud status before retrying any write");
        }
        if reply.error.is_some() {
            return Err("Invalid provisioning response");
        }
        serde_json::from_value(reply.result.ok_or("Invalid provisioning response")?)
            .map_err(|_| "Invalid provisioning response")
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Account {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    pub id: String,
    pub expires_at: u64,
    pub account: Account,
    pub worker_name: String,
    pub endpoint: String,
    pub bundle_sha256: String,
    pub resources: Vec<String>,
    pub secret_bindings: Vec<String>,
    pub model_id: String,
    pub selection: crate::provider_setup::Selection,
    pub provider_endpoint: String,
    pub provider_secret_binding: String,
    pub configuration_sha256: String,
    pub limits: serde_json::Value,
    pub billing: serde_json::Value,
    pub token_scope_verified: bool,
}
impl Preview {
    pub fn validate(&self) -> Result<(), &'static str> {
        if uuid::Uuid::parse_str(&self.id).is_err()
            || !account_id(&self.account.id)
            || !worker_name(&self.worker_name)
            || !self.selection.valid()
            || self.model_id != self.selection.model_id
            || self.provider_endpoint != self.selection.endpoint()
            || self.provider_secret_binding != self.selection.secret_slot()
            || self.secret_bindings != ["AUTH_TOKEN", self.selection.secret_slot()]
            || self.configuration_sha256.len() != 64
            || !self
                .configuration_sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            || self.bundle_sha256.len() != 64
            || !self.bundle_sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || self.resources.len() > 20
            || self.resources.iter().any(|s| s.len() > 512)
            || self.account.name.len() > 256
        {
            return Err("Unsupported deployment preview");
        }
        let url = reqwest::Url::parse(&self.endpoint).map_err(|_| "Invalid deployment endpoint")?;
        if url.scheme() != "https"
            || !url.host_str().is_some_and(|h| h.ends_with(".workers.dev"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("Invalid deployment endpoint");
        }
        Ok(())
    }
}
pub fn account_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn generated_worker_name(stem: &str, name: &str) -> bool {
    if let Some(suffix) = name.strip_prefix(&format!("{stem}-")) {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && worker_name(name)
    } else {
        false
    }
}
pub fn worker_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connect<'a> {
    pub op: &'static str,
    pub token: &'a str,
    pub account_ids: Vec<&'a str>,
    pub credential_entry_approved: bool,
    pub scope_confirmed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation<'a> {
    pub preview_id: &'a str,
    pub configuration_sha256: &'a str,
    pub account_id: &'a str,
    pub worker_name: &'a str,
    pub accept_resource_creation: bool,
    pub acknowledge_usage_billing: bool,
    pub approve_secret_upload: bool,
}
#[derive(Serialize)]
pub struct Bootstrap<'a> {
    #[serde(rename = "AUTH_TOKEN")]
    pub auth_token: &'a str,
    #[serde(rename = "providerKey")]
    pub provider_key: &'a str,
}
#[derive(Serialize)]
pub struct Deploy<'a> {
    pub op: &'static str,
    pub confirmation: Confirmation<'a>,
    pub bootstrap: Bootstrap<'a>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Deployed {
    pub state: String,
    pub account_id: String,
    pub worker_name: String,
    pub endpoint: String,
    pub bundle_sha256: String,
    pub configuration_sha256: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_failure_redacts_sidecar_errors() {
        let code = "process.stdin.on('data',()=>process.stdout.write(JSON.stringify({id:1,ok:false,error:{message:'sk-fixture-secret'}})+'\\n'));";
        let file = std::env::temp_dir().join(format!("morons-bridge-{}.js", uuid::Uuid::new_v4()));
        std::fs::write(&file, code).unwrap();
        let mut bridge = Bridge::spawn_fixed("/opt/homebrew/bin/node", &file, "--fixture").unwrap();
        let result: Result<serde_json::Value, _> =
            bridge.request(&serde_json::json!({"op":"connect","token":"fixture-secret"}));
        assert_eq!(
            result.err(),
            Some("Provisioning failed; review cloud status before retrying any write")
        );
        drop(bridge);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn input_preview_confirmation_result_are_bound_end_to_end_with_fake_sidecar() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test/fixtures/provisioning-fixture.cjs");
        let mut bridge =
            Bridge::spawn_fixed("/opt/homebrew/bin/node", &fixture, "--fixture").unwrap();
        let account = "a".repeat(32);
        let _: serde_json::Value = bridge
            .request(&Connect {
                op: "connect",
                token: "fixture_cloud_token_123",
                account_ids: vec![&account],
                credential_entry_approved: true,
                scope_confirmed: true,
            })
            .unwrap();
        let accounts: Vec<Account> = bridge
            .request(&serde_json::json!({"op":"listAccounts"}))
            .unwrap();
        assert_eq!(accounts[0].id, account);
        let preview: Preview = bridge.request(&serde_json::json!({"op":"prepare","accountId":account,"workerName":"morons-fixture","selection":crate::provider_setup::Selection::legacy_openai(),"bundle":{"mainModule":"worker.js","modules":[]}})).unwrap();
        preview.validate().unwrap();
        let bootstrap = Bootstrap {
            auth_token: "fixture_bearer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            provider_key: "sk-fixture-never-live",
        };
        let result: Deployed = bridge
            .request(&Deploy {
                op: "deploy",
                confirmation: Confirmation {
                    preview_id: &preview.id,
                    configuration_sha256: &preview.configuration_sha256,
                    account_id: &account,
                    worker_name: &preview.worker_name,
                    accept_resource_creation: true,
                    acknowledge_usage_billing: true,
                    approve_secret_upload: true,
                },
                bootstrap,
            })
            .unwrap();
        assert_eq!(result.endpoint, preview.endpoint);
        assert_eq!(result.bundle_sha256, preview.bundle_sha256);
        let replay: Result<Deployed, _> = bridge.request(&Deploy {
            op: "deploy",
            confirmation: Confirmation {
                preview_id: &preview.id,
                configuration_sha256: &preview.configuration_sha256,
                account_id: &account,
                worker_name: &preview.worker_name,
                accept_resource_creation: true,
                acknowledge_usage_billing: true,
                approve_secret_upload: true,
            },
            bootstrap: Bootstrap {
                auth_token: "fixture_bearer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                provider_key: "sk-fixture-never-live",
            },
        });
        assert!(replay.is_err());
    }
    #[test]
    fn account_and_worker_identity_are_bounded() {
        assert!(account_id(&"a".repeat(32)));
        assert!(!account_id("../../secret"));
        assert!(worker_name("morons-private"));
        assert!(generated_worker_name(
            "morons",
            &format!("morons-{}", "a".repeat(32))
        ));
        assert!(!generated_worker_name("morons", "morons-user-chosen"));
        assert!(!generated_worker_name(
            "morons",
            &format!("morons-{}", "G".repeat(32))
        ));
        assert!(!worker_name("hello;printenv"));
    }
}
