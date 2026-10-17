use gpui::{prelude::*, *};
use morons_desktop::transport::{Command, RunnerStatus};
use super::{Chat, NavSection, activation_key, button};

const INSTALL_GUIDE: &str = if cfg!(target_os = "windows") {
    "https://docs.docker.com/desktop/setup/install/windows-install/"
} else { "https://docs.docker.com/desktop/setup/install/mac-install/" };
const DOCKER_TERMS: &str = "https://docs.docker.com/subscription-billing/desktop-license/";

fn link(id: &'static str, label: &'static str, url: &'static str, cx: &mut Context<Chat>) -> Stateful<Div> {
    button(id, label)
        .on_click(cx.listener(move |_, _, _, cx| cx.open_url(url)))
        .on_key_down(cx.listener(move |_, event: &KeyDownEvent, _, cx| {
            if activation_key(event) { cx.open_url(url); cx.stop_propagation(); }
        }))
}
fn open_docker(chat: &mut Chat, cx: &mut Context<Chat>) {
    #[cfg(target_os = "macos")]
    if !std::process::Command::new("/usr/bin/open").args(["-a", "Docker"])
        .status().is_ok_and(|status| status.success()) {
        chat.local_error = Some("Could not open Docker Desktop. Open it from Applications, then recheck readiness.");
    }
    cx.notify();
}
pub(super) fn entry(cx: &mut Context<Chat>) -> Div {
    div().px_6().py_2().child(button("repository-setup-entry", "Set up repository coding")
        .on_click(cx.listener(|view, _, _, cx| { view.select_section(NavSection::Settings, cx); }))
        .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
            if activation_key(event) { view.select_section(NavSection::Settings, cx); cx.stop_propagation(); }
        })))
}
pub(super) fn card(chat: &Chat, runner: RunnerStatus, cx: &mut Context<Chat>) -> Stateful<Div> {
    let busy = runner.activity.is_some();
    let restricted = matches!(runner.state.as_str(), "disabled" | "restricted");
    let step = match runner.state.as_str() {
        "docker-stopped" => 1, "image-missing" => 2, "ready" => 3, _ => 0,
    };
    let image = runner.image.clone();
    let confirming = !busy && runner.state == "image-missing" && image.is_some() &&
        chat.runner_download_confirmation == image;
    div().id("repository-setup").role(gpui::Role::Region).aria_label("Repository coding setup")
        .w_full().min_w_0().flex().flex_col().gap_3().p_4().rounded(px(10.))
        .border_1().border_color(rgb(0xE3E5E8)).bg(rgb(0xFFFFFF))
        .child(div().text_lg().font_weight(FontWeight::SEMIBOLD)
            .child(if runner.available { "Repository coding" } else { "Set up repository coding" }))
        .child(div().text_sm().child(runner.message.clone()))
        .when(!restricted, |d| d.child(div().flex().flex_col().gap_2()
            .children(["Install Docker Desktop", "Start Docker Desktop", "Add the coding runner"]
                .into_iter().enumerate().map(|(index, label)| {
                    div().flex().items_center().gap_2().text_size(px(12.))
                        .child(div().w(px(18.)).text_color(rgb(0x80858D)).child(format!("{}", index + 1)))
                        .child(div().flex_1().child(label))
                        .child(div().text_color(if index < step { rgb(0x347052) } else { rgb(0x626772) })
                            .child(if index < step { "Ready" } else if index == step { "Next" } else { "Waiting" }))
                }))))
        .when(!runner.available && !restricted, |d| d.child(div().text_size(px(12.)).text_color(rgb(0x626772))
            .child("Docker runs repository tools in an isolated workspace. Regular chat works without it.")))
        .when(!busy && !restricted && matches!(runner.state.as_str(), "docker-missing" | "unavailable"), |d|
            d.child(div().flex().flex_col().gap_2()
                .child(link("docker-install-guide", "Open Docker installation guide", INSTALL_GUIDE, cx))
                .child(div().text_size(px(11.)).text_color(rgb(0x626772))
                    .child(if cfg!(target_os = "macos") {
                        "Opens docs.docker.com. Choose your Mac’s installer and install Docker in Applications. Docker shows the current download size."
                    } else { "Opens docs.docker.com for the official installer, download size, and installation destination." }))
                .child(div().text_size(px(11.)).text_color(rgb(0x626772))
                    .child("Docker’s terms apply. Some business and government use requires a paid subscription."))
                .child(link("docker-license", "Read Docker terms", DOCKER_TERMS, cx))))
        .when(!busy && runner.state == "docker-stopped", |d| d.child(div().flex().flex_col().gap_2()
            .child(div().text_size(px(12.)).text_color(rgb(0x626772))
                .child(if chat.state.local_mode { "Open Docker Desktop and finish its setup, then recheck readiness." }
                    else { "Open Docker Desktop on the computer hosting this Morons server, finish its setup, then recheck readiness." }))
            .when(chat.state.local_mode && cfg!(target_os = "macos"), |d| d.child(
                button("docker-open", "Open Docker Desktop")
                    .on_click(cx.listener(|view, _, _, cx| open_docker(view, cx)))
                    .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                        if activation_key(event) { open_docker(view, cx); cx.stop_propagation(); }
                    }))))
            .child(link("docker-start-guide", "Docker setup instructions", INSTALL_GUIDE, cx))))
        .when(!busy && runner.state == "image-missing" && !confirming, |d| {
            let selected_image = image.clone().unwrap_or_default();
            d.child(button("runner-download-options", "Set up coding runner…")
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.runner_download_confirmation = Some(selected_image.clone()); cx.notify();
                }))
                .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                    if activation_key(event) { view.runner_download_confirmation = image.clone(); cx.stop_propagation(); cx.notify(); }
                })))
        })
        .when(confirming, |d| {
            let selected_image = runner.image.clone().unwrap_or_default();
            let download_image = selected_image.clone();
            let key_image = selected_image.clone();
            let reference_lines: Vec<String> = selected_image.chars().collect::<Vec<_>>().chunks(42)
                .map(|chunk| chunk.iter().collect()).collect();
            d.child(div().flex().flex_col().gap_2().p_3().rounded(px(6.)).bg(rgb(0xF3F4F6))
                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Download this coding runner?"))
                .child(div().text_size(px(11.)).child("Destination: the Morons server’s Docker Desktop image store (desktop-linux)."))
                .child(div().font_family("Menlo").text_size(px(10.)).children(reference_lines.into_iter().map(|line| div().child(line))))
                .child(div().text_size(px(11.)).child(runner.download_bytes.map(|bytes|
                    format!("About {} MB from Docker Hub. Existing image layers may reduce the download.", (bytes as f64 / 1_000_000.).ceil() as u64))
                    .unwrap_or_else(|| "Downloads from the configured container registry. Its transfer size is not available.".into())))
                .child(div().text_size(px(11.)).text_color(rgb(0x626772)).child("The image is verified before repository coding is enabled."))
                .child(div().flex().flex_wrap().gap_2()
                    .child(button("runner-download-confirm", "Download runner")
                        .on_click(cx.listener(move |view, _, _, cx| {
                            view.runner_download_confirmation = None;
                            view.command(Command::DownloadRunner(download_image.clone()), cx);
                        }))
                        .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                            if activation_key(event) {
                                view.runner_download_confirmation = None;
                                view.command(Command::DownloadRunner(key_image.clone()), cx); cx.stop_propagation();
                            }
                        })))
                    .child(button("runner-download-cancel", "Cancel")
                        .on_click(cx.listener(|view, _, _, cx| { view.runner_download_confirmation = None; cx.notify(); }))
                        .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                            if activation_key(event) { view.runner_download_confirmation = None; cx.stop_propagation(); cx.notify(); }
                        })))))
        })
        .when(runner.activity.as_deref() == Some("downloading"), |d| d.child(
            button("runner-download-stop", "Cancel download")
                .on_click(cx.listener(|view, _, _, cx| view.command(Command::CancelRunnerDownload, cx)))
                .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                    if activation_key(event) { view.command(Command::CancelRunnerDownload, cx); cx.stop_propagation(); }
                }))))
        .when(!busy && runner.configured && !restricted, |d| d.child(
            button("runner-recheck", "Recheck readiness")
                .on_click(cx.listener(|view, _, _, cx| view.command(Command::RecheckRunner, cx)))
                .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                    if activation_key(event) { view.command(Command::RecheckRunner, cx); cx.stop_propagation(); }
                }))))
}
