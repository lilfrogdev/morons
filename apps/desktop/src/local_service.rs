//! Private, explicitly selected local-service discovery. No installation or autostart.
use reqwest::Url;
use serde::Deserialize;
use std::os::unix::fs::MetadataExt;
use std::{fs, io::Read, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    version: u32,
    pid: u32,
    instance_id: String,
    base_url: String,
    auth_token: String,
    configuration_revision: String,
}
// No Debug: the capability must never appear in diagnostics.
pub struct Connection {
    pub url: Url,
    pub bearer: String,
    pub instance_id: String,
    pub configuration_revision: String,
}
pub fn discover(path: &Path) -> Result<Connection, &'static str> {
    if !path.is_absolute() || path.file_name().and_then(|n| n.to_str()) != Some("connection.json") {
        return Err("Select an absolute local service connection.json path");
    }
    let parent = path.parent().ok_or("Invalid local service directory")?;
    let directory = fs::symlink_metadata(parent).map_err(|_| "Local service is not started")?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "Local service is not started; start it and reconnect")?;
    if !directory.is_dir()
        || directory.mode() & 0o077 != 0
        || !metadata.is_file()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != directory.uid()
        || metadata.len() > 16 * 1024
    {
        return Err(
            "Local service discovery must be a private regular file in a private directory",
        );
    }
    let file = fs::File::open(path).map_err(|_| "Cannot read local service discovery")?;
    let opened = file
        .metadata()
        .map_err(|_| "Cannot read local service discovery")?;
    if opened.ino() != metadata.ino() || opened.dev() != metadata.dev() {
        return Err("Local service discovery changed; reconnect");
    }
    let mut bytes = Vec::new();
    file.take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read local service discovery")?;
    if bytes.len() > 16 * 1024 {
        return Err("Invalid local service discovery");
    }
    let value: Discovery =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid local service discovery")?;
    let url = Url::parse(&value.base_url).map_err(|_| "Invalid local service origin")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Local service must use a literal loopback HTTP origin");
    }
    if value.version != 1
        || value.pid == 0
        || uuid::Uuid::parse_str(&value.instance_id).is_err()
        || value.auth_token.len() < 16
        || value.auth_token.len() > 4096
        || !value.auth_token.bytes().all(|b| b.is_ascii_graphic())
        || value.configuration_revision.is_empty()
        || value.configuration_revision.len() > 256
    {
        return Err("Unsupported local service discovery");
    }
    Ok(Connection {
        url,
        bearer: value.auth_token,
        instance_id: value.instance_id,
        configuration_revision: value.configuration_revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[test]
    fn discovery_requires_private_literal_loopback_and_reloads_rotated_capability() {
        let dir = std::env::temp_dir().join(format!("morons-discovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.join("connection.json");
        let write = |origin: &str, token: &str| {
            fs::write(&path, serde_json::to_vec(&serde_json::json!({"version":1,"pid":1,"instanceId":uuid::Uuid::new_v4().to_string(),"baseUrl":origin,"authToken":token,"configurationRevision":"fixture-v1"})).unwrap()).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        };
        write("http://127.0.0.1:1234/", "synthetic-capability-one");
        let first = discover(&path).unwrap();
        write("http://127.0.0.1:4321/", "synthetic-capability-two");
        let second = discover(&path).unwrap();
        assert_ne!(first.bearer, second.bearer);
        assert_ne!(first.instance_id, second.instance_id);
        for origin in [
            "http://localhost:1234/",
            "https://127.0.0.1:1234/",
            "http://example.com:1234/",
            "http://127.0.0.1:1234/?token=secret",
        ] {
            write(origin, "synthetic-capability-two");
            assert!(discover(&path).is_err());
        }
        write("http://127.0.0.1:1234/", "synthetic-capability-one");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(discover(&path).is_err());
        fs::rename(&path, dir.join("other.json")).unwrap();
        symlink(dir.join("other.json"), &path).unwrap();
        assert!(discover(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
