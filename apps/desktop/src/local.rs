use reqwest::Url;
use std::{fs::{self, OpenOptions}, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::mpsc, time::{Duration, Instant}};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

pub struct LocalBackend {
    child: Child,
    data_dir: PathBuf,
    bootstrap_file: PathBuf,
    provider_file: PathBuf,
    script: PathBuf,
    url: Url,
}

impl LocalBackend {
    pub fn launch(create_account: bool) -> Result<(Self, Url, String), &'static str> {
        let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("Home directory unavailable")?;
        let config_dir = std::env::var_os("MORONS_LOCAL_CONFIG_DIR").map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config/morons"));
        let data_dir = std::env::var_os("MORONS_LOCAL_DATA_DIR").map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share/morons"));
        if create_account { private_dir(&config_dir)?; private_dir(&data_dir)?; }
        else if !data_dir.join("accounts.sqlite").is_file() { return Err("Create your first account to get started"); }
        let bootstrap_file = config_dir.join("bootstrap");
        let provider_file = config_dir.join("provider-key");
        let bootstrap = if create_account { private_secret(&bootstrap_file, 64)? }
            else { read_secret(&bootstrap_file, 64)? };
        let script = std::env::var_os("MORONS_LOCAL_SERVER_SCRIPT").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/selfhost/src/account-server.mjs"));
        if !script.is_file() { return Err("Local account server is missing"); }
        let mut child = spawn(&script, &data_dir, &bootstrap_file, &provider_file)?;
        let url = match read_url(&mut child) { Ok(url) => url, Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); } };
        Ok((Self { child, data_dir, bootstrap_file, provider_file, script, url: url.clone() }, url, bootstrap))
    }

    pub fn url(&self) -> Url { self.url.clone() }

    pub fn enable_provider(&mut self) -> Result<Url, &'static str> {
        if !self.provider_file.exists() {
            let mut key = [0u8; 32];
            getrandom::fill(&mut key).map_err(|_| "Cannot generate provider storage key")?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)] options.mode(0o600);
            let mut file = options.open(&self.provider_file).map_err(|_| "Cannot create provider storage key")?;
            file.write_all(&key).map_err(|_| "Cannot write provider storage key")?;
            file.sync_all().map_err(|_| "Cannot save provider storage key")?;
        }
        stop(&mut self.child);
        self.child = spawn(&self.script, &self.data_dir, &self.bootstrap_file, &self.provider_file)?;
        self.url = read_url(&mut self.child)?;
        Ok(self.url.clone())
    }
}

impl Drop for LocalBackend {
    fn drop(&mut self) { stop(&mut self.child); }
}

fn stop(child: &mut Child) {
    #[cfg(unix)] {
        let _ = Command::new("/bin/kill").arg("-TERM").arg(child.id().to_string()).status();
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until {
            if child.try_wait().ok().flatten().is_some() { return; }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn private_dir(path: &Path) -> Result<(), &'static str> {
    if !path.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)] builder.mode(0o700);
        builder.create(path).map_err(|_| "Cannot create private local directory")?;
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "Cannot inspect private local directory")?;
    if !meta.is_dir() || meta.file_type().is_symlink() { return Err("Local directory must not be a symlink"); }
    #[cfg(unix)] fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| "Cannot protect local directory")?;
    Ok(())
}

fn private_secret(path: &Path, size: usize) -> Result<String, &'static str> {
    if !path.exists() {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] options.mode(0o600);
        let mut file = options.open(path).map_err(|_| "Cannot create local credential")?;
        let value = (0..((size + 15) / 16)).map(|_| uuid::Uuid::new_v4().simple().to_string()).collect::<String>();
        file.write_all(value[..size].as_bytes()).map_err(|_| "Cannot write local credential")?;
        file.sync_all().map_err(|_| "Cannot save local credential")?;
    }
    read_secret(path, size)
}

fn read_secret(path: &Path, size: usize) -> Result<String, &'static str> {
    let meta = fs::symlink_metadata(path).map_err(|_| "Local credential is missing")?;
    if !meta.is_file() || meta.file_type().is_symlink() { return Err("Local credential must be a regular file"); }
    #[cfg(unix)] if meta.permissions().mode() & 0o077 != 0 { return Err("Local credential must be private"); }
    let data = fs::read(path).map_err(|_| "Cannot read local credential")?;
    if data.len() != size { return Err("Local credential has invalid length"); }
    String::from_utf8(data).map_err(|_| "Local credential has invalid contents")
}

fn spawn(script: &Path, data_dir: &Path, bootstrap_file: &Path, provider_file: &Path) -> Result<Child, &'static str> {
    let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        .iter().find(|path| Path::new(path).is_file()).copied().unwrap_or("node");
    let mut command = Command::new(node);
    command.arg("--experimental-strip-types").arg(script)
        .env("MORONS_DATA_DIR", data_dir)
        .env("MORONS_BOOTSTRAP_TOKEN_FILE", bootstrap_file)
        .env("PORT", "0")
        .stdout(Stdio::piped()).stderr(Stdio::null());
    if provider_file.exists() { command.env("MORONS_PROVIDER_KEY_FILE", provider_file); }
    command.spawn().map_err(|_| "Cannot start local account server; install Node.js")
}

fn read_url(child: &mut Child) -> Result<Url, &'static str> {
    let stdout = child.stdout.take().ok_or("Local account server has no output")?;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
    });
    let line = rx.recv_timeout(Duration::from_secs(15)).map_err(|_| "Local account server timed out")?
        .map_err(|_| "Local account server failed to start")?;
    let value = line.trim().strip_prefix("Morons local account server listening at ")
        .ok_or("Local account server failed to start")?;
    let url = Url::parse(value).map_err(|_| "Local account server returned an invalid address")?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") { return Err("Local account server returned an unsafe address"); }
    Ok(url)
}
