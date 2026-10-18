use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubState {
    pub repository_id: String,
    pub available: bool,
    pub preparing: bool,
    pub message: String,
    pub connection: Option<GitHubConnection>,
    pub publication: Option<GitHubPublication>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubConnection {
    pub id: String,
    pub account_id: String,
    pub host: String,
    pub login: String,
    pub user_id: u64,
    pub repository_id: u64,
    pub repository: String,
    pub base_ref: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPublication {
    pub account_id: String,
    pub id: String,
    pub review_id: String,
    pub status: String,
    pub repository: String,
    pub login: String,
    pub branch: String,
    pub base_ref: String,
    pub base_revision: String,
    pub commit: String,
    pub tree: String,
    pub patch_hash: String,
    pub main_review_hash: String,
    pub pr_title: String,
    pub pr_body: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub error: Option<String>,
    pub pull_url: Option<String>,
    pub check_summary: Option<String>,
    pub checks: Vec<GitHubCheck>,
}
#[derive(Clone, Deserialize)]
pub struct GitHubCheck {
    pub name: String,
    pub status: String,
    pub conclusion: String,
    pub url: Option<String>,
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
impl GitHubState {
    pub fn valid_for(&self, repository: &str, account: &str, review: Option<&str>) -> bool {
        self.repository_id == repository && self.message.len() <= 1024 &&
            self.connection.as_ref().is_none_or(|connection| connection.account_id == account &&
                connection.id.len() <= 160 && connection.host == "github.com" && connection.user_id > 0 &&
                connection.repository_id > 0 && connection.repository.len() <= 200 && connection.login.len() <= 40 &&
                connection.base_ref.len() <= 240) &&
            self.publication.as_ref().is_none_or(|publication| publication.account_id == account &&
                Some(publication.review_id.as_str()) == review && publication.repository.len() <= 200 &&
                publication.login.len() <= 40 && publication.base_ref.len() <= 240 &&
                publication.id.len() <= 160 && publication.branch.starts_with("morons/") && publication.branch.len() <= 200 &&
                hex(&publication.base_revision, 40) && hex(&publication.commit, 40) && hex(&publication.tree, 40) &&
                hex(&publication.patch_hash, 64) && hex(&publication.main_review_hash, 64) &&
                publication.pr_title.len() <= 256 && publication.pr_body.len() <= 65536 && publication.message.len() <= 65536 &&
                publication.author_name.len() <= 256 && publication.author_email.len() <= 256 &&
                matches!(publication.status.as_str(), "preparing" | "prepared" | "waiting" | "running" | "completed" | "failed" | "interrupted") &&
                publication.error.as_ref().is_none_or(|value| value.len() <= 1024) &&
                publication.pull_url.as_ref().is_none_or(|value| valid_pull_url(value, &publication.repository)) &&
                publication.check_summary.as_ref().is_none_or(|value| value.len() <= 80) &&
                publication.checks.len() <= 100 && publication.checks.iter().all(|check| check.name.len() <= 256 &&
                    check.status.len() <= 80 && check.conclusion.len() <= 80 &&
                    check.url.as_ref().is_none_or(|value| valid_github_url(value))))
    }
}
pub fn valid_github_url(value: &str) -> bool {
    value.len() <= 4096 && reqwest::Url::parse(value).is_ok_and(|url| url.scheme() == "https" &&
        url.host_str() == Some("github.com") && url.username().is_empty() && url.password().is_none() &&
        url.port().is_none() && url.fragment().is_none())
}
pub fn valid_pull_url(value: &str, repository: &str) -> bool {
    valid_github_url(value) && reqwest::Url::parse(value).is_ok_and(|url| {
        let prefix = format!("/{repository}/pull/");
        url.query().is_none() && url.path().strip_prefix(&prefix).is_some_and(|number|
            number.parse::<u64>().is_ok_and(|value| value > 0))
    })
}
