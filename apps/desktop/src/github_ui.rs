use gpui::{prelude::*, *};
use morons_desktop::transport::Command;
use super::{Chat, activation_key, button};

fn action(
    id: &'static str,
    label: &'static str,
    command: impl Fn() -> Command + Clone + 'static,
    cx: &mut Context<Chat>,
) -> Stateful<Div> {
    let key_command = command.clone();
    button(id, label)
        .on_click(cx.listener(move |view, _, _, cx| view.command(command(), cx)))
        .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
            if activation_key(event) {
                view.command(key_command(), cx);
                cx.stop_propagation();
            }
        }))
}

fn detail(label: &'static str, value: impl Into<SharedString>) -> Div {
    let value: SharedString = value.into();
    div().min_w_0().flex().flex_col().gap_1()
        .child(div().text_size(px(11.)).text_color(rgb(0x626772)).child(label))
        .child(div().min_w_0().text_sm().child(value))
}

fn github_url(value: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(value).ok()?;
    (url.scheme() == "https" && url.host_str() == Some("github.com") &&
        url.username().is_empty() && url.password().is_none() &&
        url.port().is_none() && url.fragment().is_none() && url.query().is_none())
        .then_some(url)
}

fn pull_url(value: &str, repository: &str) -> Option<String> {
    let url = github_url(value)?;
    let parts: Vec<_> = url.path_segments()?.collect();
    let repository_parts: Vec<_> = repository.split('/').collect();
    (repository_parts.len() == 2 && parts.len() == 4 &&
        parts[0].eq_ignore_ascii_case(repository_parts[0]) &&
        parts[1].eq_ignore_ascii_case(repository_parts[1]) && parts[2] == "pull" &&
        parts[3].parse::<u64>().is_ok_and(|number| number > 0))
        .then(|| url.to_string())
}

fn open_link(id: SharedString, label: &'static str, url: String, cx: &mut Context<Chat>) -> Stateful<Div> {
    let key_url = url.clone();
    div().id(id).role(gpui::Role::Button).aria_label(label)
        .focusable().tab_stop(true).px_3().py_2().rounded_sm()
        .bg(rgb(0xE8ECEF)).text_color(rgb(0x233342)).text_sm()
        .cursor_pointer().hover(|s| s.bg(rgb(0xD9E2E8))).child(label)
        .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url)))
        .on_key_down(cx.listener(move |_, event: &KeyDownEvent, _, cx| {
            if activation_key(event) { cx.open_url(&key_url); cx.stop_propagation(); }
        }))
}

fn connect(chat: &mut Chat, cx: &mut Context<Chat>) {
    let Some(repository) = chat.state.repositories.iter().find(|repository|
        !repository.archived && chat.state.selected_moron.as_deref() == Some(repository.moron_id.as_str())) else { return; };
    chat.command(Command::ConnectGitHub {
        repository_id: repository.id.clone(),
        repository: chat.github_repository.read(cx).text().trim().to_owned(),
        base_ref: chat.github_base.read(cx).text().trim().to_owned(),
    }, cx);
}

pub(super) fn settings(chat: &Chat, cx: &mut Context<Chat>) -> Div {
    let Some(repository) = chat.state.repositories.iter().find(|repository|
        !repository.archived && chat.state.selected_moron.as_deref() == Some(repository.moron_id.as_str())) else { return div(); };
    let github = chat.state.github.as_ref().filter(|github| github.repository_id == repository.id);
    let connection = github.and_then(|github| github.connection.as_ref());
    div().w_full().min_w_0().child(
        div().id("github-settings").role(gpui::Role::Region).aria_label("Repository GitHub connection")
            .w_full().min_w_0().flex().flex_col().gap_3().p_4().rounded(px(10.))
            .border_1().border_color(rgb(0xE3E5E8)).bg(rgb(0xFFFFFF))
            .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child("GitHub"))
            .child(div().text_sm().child("Uses the GitHub sign-in on the computer hosting Morons. Publishing requires approval and creates a task branch and draft pull request. GitHub may run CI."))
            .when_some(github, |d, github| d.child(div().text_sm().child(github.message.clone())))
            .when(github.is_none(), |d| d.child(div().text_sm().child("Loading this repository’s GitHub connection…")))
            .when_some(connection, |d, connection| {
                let repository_id = repository.id.clone();
                d.child(div().id("github-connection-details").min_w_0().max_h(px(180.)).overflow_x_scroll().overflow_y_scroll()
                    .flex().flex_col().gap_2()
                    .child(detail("Repository", connection.repository.clone()))
                    .child(detail("GitHub account", connection.login.clone()))
                    .child(detail("Base branch", connection.base_ref.clone()))
                    .child(detail("Host", connection.host.clone()))
                    .child(detail("Account ID", connection.user_id.to_string()))
                    .child(detail("Repository ID", connection.repository_id.to_string())))
                    .child(action("github-disconnect", "Disconnect GitHub", move || Command::DisconnectGitHub {
                        repository_id: repository_id.clone(),
                    }, cx))
            })
            .when(github.is_some_and(|github| github.available) && connection.is_none(), |d| d
                .child(div().text_sm().child("Repository"))
                .child(div().w_full().min_w_0().px_2().py_1().rounded(px(6.)).border_1()
                    .border_color(rgb(0xBAC8D3)).child(chat.github_repository.clone()))
                .child(div().text_sm().child("Base branch"))
                .child(div().w_full().min_w_0().px_2().py_1().rounded(px(6.)).border_1()
                    .border_color(rgb(0xBAC8D3)).child(chat.github_base.clone()))
                .child(button("github-connect", "Connect GitHub")
                    .on_click(cx.listener(|view, _, _, cx| connect(view, cx)))
                    .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                        if activation_key(event) { connect(view, cx); cx.stop_propagation(); }
                    }))))
    )
}

pub(super) fn publication(chat: &Chat, cx: &mut Context<Chat>) -> Div {
    let Some(repository) = chat.state.repositories.iter().find(|repository|
        !repository.archived && chat.state.selected_moron.as_deref() == Some(repository.moron_id.as_str())) else { return div(); };
    let Some(review) = chat.state.review.as_ref() else { return div(); };
    let github = chat.state.github.as_ref().filter(|github| github.repository_id == repository.id);
    let publication = github.and_then(|github| github.publication.as_ref())
        .filter(|publication| publication.review_id == review.id);
    let approved = review.decision == "approve" && review.checks.iter().all(|check| check.ok) &&
        review.main_review.as_ref().is_some_and(|assessment| !assessment.trim().is_empty()) &&
        review.proposal_revision.as_ref().is_some_and(|revision|
            revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())) &&
        review.diff_hash.as_ref().is_some_and(|hash|
            hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if publication.is_none() && !approved { return div(); }
    let connected = github.is_some_and(|github| github.available && github.connection.is_some());
    let preparing = github.is_some_and(|github| github.preparing);
    div().w_full().min_w_0().child(
        div().id("github-publication").role(gpui::Role::Region).aria_label("Publish reviewed change to GitHub")
            .mx_6().mb_3().min_w_0().p_3().rounded_sm().border_1().border_color(rgb(0xBAC8D3))
            .bg(rgb(0xFFFFFF)).flex().flex_col().gap_2()
            .child(div().font_weight(FontWeight::BOLD).child("Draft pull request"))
            .when(publication.is_none(), |d| {
                let review_id = review.id.clone();
                d.child(div().text_sm().child("Prepare the approved change to review its exact commit and pull request before publishing."))
                    .when(!connected, |d| d.child(div().text_sm().text_color(rgb(0x626772))
                        .child("Connect this repository to GitHub in Settings to prepare a draft pull request.")))
                    .when(connected && !preparing, |d| d.child(action("github-prepare", "Prepare draft PR",
                        move || Command::PrepareGitHubPublication { review_id: review_id.clone() }, cx)))
                    .when(preparing, |d| d.child(div().text_sm().child("Preparing the commit and draft pull request…")))
                    .when_some(github, |d, github| d.child(div().text_size(px(11.)).text_color(rgb(0x626772)).child(github.message.clone())))
            })
            .when_some(publication, |d, publication| {
                let completed = matches!(publication.status.as_str(), "completed" | "published");
                let resumable = matches!(publication.status.as_str(), "prepared" | "failed" | "interrupted");
                let same_connection = github.and_then(|github| github.connection.as_ref()).is_some_and(|connection|
                    connection.repository == publication.repository && connection.login == publication.login &&
                    connection.base_ref == publication.base_ref);
                let can_publish = approved && connected && same_connection && resumable;
                let review_id = review.id.clone();
                let publication_id = publication.id.clone();
                let refresh_review_id = review.id.clone();
                let refresh_publication_id = publication.id.clone();
                let url = publication.pull_url.as_deref().and_then(|url| pull_url(url, &publication.repository));
                d.child(div().text_sm().child(match publication.status.as_str() {
                    "preparing" => "Preparing the commit and draft pull request…".to_owned(),
                    "prepared" => "Prepared for your review".to_owned(),
                    "waiting" => "Waiting for publish approval".to_owned(),
                    "running" => "Publishing the approved artifact…".to_owned(),
                    "completed" | "published" => "Draft pull request published".to_owned(),
                    "failed" => "Publishing failed. Some objects or the task branch may already be on GitHub.".to_owned(),
                    "interrupted" => "Publishing was interrupted. Some objects or the task branch may already be on GitHub.".to_owned(),
                    status => format!("Publication status: {status}"),
                }))
                .child(div().id("github-publication-artifact").role(gpui::Role::Document)
                    .aria_label("Exact commit and draft pull request for approval")
                    .min_w_0().max_h(px(290.)).overflow_x_scroll().overflow_y_scroll().p_3()
                    .rounded(px(6.)).bg(rgb(0xF3F6F8)).flex().flex_col().gap_3()
                    .child(detail("Destination repository", publication.repository.clone()))
                    .child(detail("GitHub account", publication.login.clone()))
                    .child(detail("Task branch", publication.branch.clone()))
                    .child(detail("Base branch", publication.base_ref.clone()))
                    .child(detail("Base commit", publication.base_revision.clone()))
                    .child(detail("Head commit", publication.commit.clone()))
                    .child(detail("Author", format!("{} <{}>", publication.author_name, publication.author_email)))
                    .child(detail("Commit message", publication.message.clone()))
                    .child(detail("Pull request title", publication.pr_title.clone()))
                    .child(detail("Pull request body", publication.pr_body.clone()))
                    .child(detail("Patch SHA-256", publication.patch_hash.clone()))
                    .child(detail("Main review SHA-256", publication.main_review_hash.clone())))
                .when_some(publication.error.clone(), |d, error| d.child(div().text_sm().text_color(rgb(0xA04438)).child(error)))
                .when(resumable, |d| d.child(div().text_size(px(11.)).text_color(rgb(0x626772))
                    .child(if publication.status == "prepared" {
                        "Approval uploads this exact commit, creates the task branch and opens a draft pull request. CI may run."
                    } else {
                        "Resume uses this exact saved commit and pull request. Approval may finish an earlier partial upload."
                    })))
                .when(resumable && !same_connection, |d| d.child(div().text_sm().text_color(rgb(0xA04438))
                    .child("Reconnect the displayed GitHub account, repository and base branch in Settings to continue.")))
                .when(resumable && !approved, |d| d.child(div().text_sm().text_color(rgb(0xA04438))
                    .child("This change needs an approved review before publishing can continue.")))
                .when(can_publish, |d| d.child(action("github-request-publish", if publication.status == "prepared" {
                    "Request publish approval"
                } else { "Request approval to resume" }, move || Command::PublishGitHubPublication {
                    review_id: review_id.clone(), publication_id: publication_id.clone(),
                }, cx)))
                .when(completed, |d| d
                    .child(div().id("github-ci-commit").min_w_0().overflow_x_scroll()
                        .child(div().text_size(px(11.)).child(format!("CI for exact commit {}", publication.commit))))
                    .when_some(url, |d, url| d.child(open_link("github-open-pr".into(), "Open draft pull request", url, cx)))
                    .when(publication.pull_url.is_some() && publication.pull_url.as_deref().and_then(|url|
                        pull_url(url, &publication.repository)).is_none(), |d| d.child(div().text_sm().text_color(rgb(0xA04438))
                        .child("The pull request URL could not be verified.")))
                    .child(action("github-refresh-ci", "Refresh CI", move || Command::RefreshGitHubPublication {
                        review_id: refresh_review_id.clone(), publication_id: refresh_publication_id.clone(),
                    }, cx))
                    .when_some(publication.check_summary.clone(), |d, summary| d.child(div().text_sm().child(summary)))
                    .when(publication.checks.is_empty(), |d| d.child(div().text_sm().text_color(rgb(0x626772))
                        .child(if publication.check_summary.is_none() { "Refresh CI to load checks for this commit." }
                            else { "No checks reported for this commit." })))
                    .child(div().id("github-checks").min_w_0().max_h(px(180.)).overflow_y_scroll()
                        .flex().flex_col().gap_2().children(publication.checks.iter().enumerate().map(|(index, check)| {
                            let url = check.url.as_deref().and_then(github_url).map(|url| url.to_string());
                            div().min_w_0().flex().flex_col().gap_1().p_2().rounded_sm().bg(rgb(0xF3F6F8))
                                .child(div().text_sm().child(check.name.clone()))
                                .child(div().text_size(px(11.)).text_color(rgb(0x626772)).child(
                                    if check.conclusion.is_empty() { check.status.clone() }
                                    else { format!("{} · {}", check.status, check.conclusion) }))
                                .when_some(url, |d, url| d.child(open_link(
                                    format!("github-check-{index}").into(), "Open check", url, cx)))
                        }))))
            })
    )
}
