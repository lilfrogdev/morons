#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    target_os = "windows"
)))]
compile_error!("Morons desktop currently targets macOS Apple Silicon and Windows");

mod input;
mod drafts;
use gpui::{prelude::*, *};
use morons_desktop::{
    model::{Role, TaskStatus},
    transport::{Command, Config, State, Worker},
};

const ICON_PLUS: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#24262b" stroke-width="1.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>"##;
const ICON_SEND: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m-7 7 7-7 7 7"/></svg>"##;
const ICON_MIC: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#24262b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>"##;
const ICON_HOME: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#24262b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>"##;
const ICON_FOLDER: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#626772" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"/></svg>"##;
const ICON_AGENT: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#626772" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M9 13h.01M15 13h.01M9 17h6"/></svg>"##;

actions!(morons, [SendMessage, Quit, FocusNext, FocusPrevious]);
struct Chat {
    input: Entity<input::TextInput>,
    login_name: Entity<input::TextInput>,
    login_password: Entity<input::TextInput>,
    bootstrap_token: Entity<input::TextInput>,
    provider_callback: Entity<input::TextInput>,
    worker: Worker,
    state: State,
    // Keep the foreground listener alive for exactly the view lifetime.
    _updates: Task<()>,
    local_error: Option<&'static str>,
    last_ack: Option<String>,
    scroll: ScrollHandle,
    show_model: bool,
    drafts: drafts::Drafts,
    _input_subscription: Subscription,
}
impl Chat {
    fn new(config: Config, cx: &mut Context<Self>) -> Self {
        let input = cx.new(input::TextInput::new);
        let input_subscription = cx.observe(&input, |_, _, cx| cx.notify());
        let login_name = cx.new(|cx| { let mut field = input::TextInput::new(cx); field.set_id("account-name"); field.set_placeholder("Account name"); field });
        let login_password = cx.new(|cx| { let mut field = input::TextInput::new_secret(cx); field.set_id("account-password"); field });
        let bootstrap_token = cx.new(|cx| { let mut field = input::TextInput::new_secret(cx); field.set_id("bootstrap-token"); field.set_placeholder("First-account setup code"); field });
        let provider_callback = cx.new(|cx| { let mut field = input::TextInput::new_secret(cx); field.set_id("provider-callback"); field.set_placeholder("Paste final callback URL if needed"); field });
        let (worker, updates) = Worker::start(config);
        let task = cx.spawn(async move |view, cx| {
            while let Ok(state) = updates.recv().await {
                if view
                    .update(cx, |view, cx| {
                        if let Some((id, text)) = &state.accepted
                            && view.state.selected_moron == state.selected_moron
                            && view.last_ack.as_ref() != Some(id)
                        {
                            view.last_ack = Some(id.clone());
                            view.input.update(cx, |input, cx| {
                                if input.text() == text {
                                    input.reset();
                                    cx.notify();
                                }
                            });
                        }
                        let follow = view.scroll.max_offset().y + view.scroll.offset().y < px(60.);
                        if view.state.account_login && !state.account_login {
                            view.login_password.update(cx, |field, cx| { field.reset(); cx.notify(); });
                            view.bootstrap_token.update(cx, |field, cx| { field.reset(); cx.notify(); });
                        }
                        if !view.state.account_login && state.account_login {
                            for field in [&view.input, &view.login_name, &view.login_password,
                                &view.bootstrap_token, &view.provider_callback] {
                                field.update(cx, |field, cx| { field.reset(); cx.notify(); });
                            }
                            view.last_ack = None;
                            view.local_error = None;
                            view.drafts.clear();
                        } else if view.state.selected_moron != state.selected_moron {
                            let current = view.input.read(cx).text().to_owned();
                            let restored = view.drafts.switch(state.selected_moron.as_deref(), &current);
                            view.input.update(cx, |input, cx| { input.set_text(restored); cx.notify(); });
                            view.last_ack = None;
                            view.show_model = false;
                        }
                        view.state = state;
                        if follow {
                            view.scroll.scroll_to_bottom();
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            input,
            login_name,
            login_password,
            bootstrap_token,
            provider_callback,
            worker,
            state: State::default(),
            _updates: task,
            local_error: None,
            last_ack: None,
            scroll: ScrollHandle::new(),
            show_model: false,
            drafts: drafts::Drafts::default(),
            _input_subscription: input_subscription,
        }
    }
    fn send(&mut self, _: &SendMessage, _: &mut Window, cx: &mut Context<Self>) {
        if self.state.account_login {
            self.account_action(false, cx);
            return;
        }
        if !self.state.ready {
            self.local_error = Some("Backend not ready");
            cx.notify();
            return;
        }
        if self.input.read(cx).composing()
            || self.state.pending
            || self.state.snapshot.active_task_id.is_some()
        {
            return;
        }
        let text = self.input.read(cx).text().to_owned();
        if text.trim().is_empty() {
            return;
        }
        if text.len() > 8192 {
            self.local_error = Some("Messages are limited to 8192 UTF-8 bytes");
            cx.notify();
            return;
        }
        match self.worker.send(Command::Submit(text)) {
            Ok(()) => {
                self.state.pending = true;
                self.local_error = None;
            }
            Err(error) => self.local_error = Some(error),
        }
        cx.notify();
    }
    fn command(&mut self, command: Command, cx: &mut Context<Self>) {
        self.local_error = self.worker.send(command).err();
        cx.notify();
    }
    fn account_action(&mut self, create: bool, cx: &mut Context<Self>) {
        let name = self.login_name.read(cx).text().trim().to_owned();
        let password = self.login_password.read(cx).text().to_owned();
        let command = if create {
            Command::AccountCreate { name, password, bootstrap: self.bootstrap_token.read(cx).text().to_owned() }
        } else { Command::AccountLogin { name, password } };
        self.command(command, cx);
        self.login_password.update(cx, |field, cx| { field.reset(); cx.notify(); });
        self.bootstrap_token.update(cx, |field, cx| { field.reset(); cx.notify(); });
    }
    fn submit_provider_callback(&mut self, cx: &mut Context<Self>) {
        let url = self.provider_callback.read(cx).text().to_owned();
        self.command(Command::ProviderCallback(url), cx);
        self.provider_callback.update(cx, |field, cx| { field.reset(); cx.notify(); });
    }
    fn sidebar(&self, narrow: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.state.selected_moron.as_deref();
        div()
            .id("moron-sidebar")
            .role(gpui::Role::Navigation)
            .aria_label("Morons sidebar")
            .h_full()
            .w(px(if narrow { 176. } else { 272. }))
            .flex_shrink_0()
            .flex()
            .bg(rgb(0xF7F7F8))
            .border_r_1()
            .border_color(rgb(0xE3E5E8))
            .when(!narrow, |d| d.child(
                div().w(px(52.)).h_full().flex_shrink_0()
                    .border_r_1().border_color(rgb(0xE3E5E8))
                    .flex().flex_col().items_center().pt_4()
                    .child(div().w(px(38.)).h(px(38.)).rounded(px(6.))
                        .bg(rgb(0xECEEF1)).flex().items_center().justify_center()
                        .child(svg().data(ICON_HOME).w(px(20.)).h(px(20.)).text_color(rgb(0x24262B))))
            ))
            .child(
                div().flex_1().min_w_0().h_full().flex().flex_col()
                    .px_3().pt_5().pb_3()
                    .child(div().px_2().mb_7().text_size(px(17.))
                        .font_weight(FontWeight::BOLD).child("Morons"))
                    .child(div().px_2().mb_2().text_size(px(12.))
                        .font_weight(FontWeight::BOLD).text_color(rgb(0x626772))
                        .child("Your Morons"))
                    .child(div().id("moron-list").role(gpui::Role::List)
                        .aria_label("Named Morons")
                        .flex_1().min_h_0().overflow_y_scroll()
                        .flex().flex_col().gap_1()
                        .when(self.state.named_morons.is_empty(), |d| d.child(
                            div().px_2().py_2().text_size(px(12.))
                                .text_color(rgb(0x626772))
                                .child(if self.state.account_login {
                                    "Sign in to see your Morons"
                                } else { "No named Morons yet" })
                        ))
                        .children(self.state.named_morons.iter().map(|(id, name)| {
                            let selected = active == Some(id.as_str());
                            let chosen = id.clone();
                            let key_choice = id.clone();
                            div().id(SharedString::from(format!("sidebar-moron-{id}")))
                                .role(gpui::Role::Button)
                                .aria_label(SharedString::from(format!("Open {name}")))
                                .aria_selected(selected)
                                .focusable().tab_stop(true)
                                .w_full().min_w_0().h(px(36.)).px_2()
                                .rounded(px(6.)).flex().items_center().gap_2()
                                .bg(if selected { rgb(0xECEEF1) } else { rgb(0xF7F7F8) })
                                .hover(|d| d.bg(rgb(0xECEEF1)))
                                .cursor_pointer().text_size(px(14.))
                                .child(div().w(px(20.)).flex_shrink_0()
                                    .child(svg().data(if id == "repo" { ICON_FOLDER } else { ICON_AGENT })
                                        .w(px(18.)).h(px(18.)).text_color(rgb(0x626772))))
                                .child(div().flex_1().min_w_0().truncate().child(name.clone()))
                                .on_click(cx.listener(move |view, _, _, cx| {
                                    view.command(Command::SelectMoron(chosen.clone()), cx)
                                }))
                                .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                                    if !event.keystroke.modifiers.modified() &&
                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                        view.command(Command::SelectMoron(key_choice.clone()), cx);
                                        cx.stop_propagation();
                                    }
                                }))
                        })))
                    .child(div().px_2().pt_3().text_size(px(11.))
                        .text_color(rgb(0x626772))
                        .child(self.state.status))
            )
    }
}
fn button(id: &'static str, label: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .role(gpui::Role::Button)
        .aria_label(label)
        .focusable()
        .tab_stop(true)
        .px_3()
        .py_2()
        .rounded_sm()
        .bg(rgb(0xE8ECEF))
        .text_color(rgb(0x233342))
        .text_sm()
        .cursor_pointer()
        .hover(|s| s.bg(rgb(0xD9E2E8)))
        .child(label)
}
impl Render for Chat {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let narrow = window.bounds().size.width < px(760.);
        let active = self.state.snapshot.active_task_id.clone();
        let error = self
            .local_error
            .or(self.state.request_error)
            .or(self.state.error);
        let status = if active.is_some() {
            "Working…"
        } else {
            self.state.status
        };
        let model = self.state.model.as_deref().unwrap_or("No model connected");
        let model_display = if narrow && model == "Offline fixture" { "Offline" } else { model };
        let model_options = self.state.models.clone();
        let selected_model = self.state.selected_model.clone();
        let draft_ready = !self.input.read(cx).text().trim().is_empty();
        let review = self.state.review.clone();
        let provider_url = self.state.provider_url.clone();
        let provider_state = self.state.provider_state.clone();
        let visualizations = if self.state.visualization_expires_at.is_some_and(|until| std::time::Instant::now() < until) {
            self.state.visualizations.clone()
        } else { Vec::new() };
        let messages = self
            .state
            .snapshot
            .messages
            .iter()
            .map(|message| {
                let text = message.text.clone();
                let role = match message.role {
                    Role::User => "You",
                    Role::Assistant => "Moron",
                };
                let task_status = self
                    .state
                    .snapshot
                    .tasks
                    .iter()
                    .find(|task| task.id == message.task_id)
                    .map(|task| task.status);
                div()
                    .id(SharedString::from(message.id.clone()))
                    .role(gpui::Role::ListItem)
                    .aria_label(SharedString::from(format!("{role}: {}", message.text)))
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_4()
                    .rounded_sm()
                    .bg(if message.role == Role::User {
                        rgb(0xECF1F5)
                    } else {
                        rgb(0xFFFFFF)
                    })
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .items_center()
                            .child(div().font_weight(FontWeight::BOLD).text_sm().child(role))
                            .child(
                                div()
                                    .id("copy")
                                    .role(gpui::Role::Button)
                                    .aria_label("Copy message")
                                    .text_xs()
                                    .text_color(rgb(0x557080))
                                    .cursor_pointer()
                                    .child("Copy")
                                    .on_click(move |_, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            text.clone(),
                                        ))
                                    }),
                            ),
                    )
                    .child(div().text_size(px(16.)).line_height(px(25.)).child(
                        if message.text.is_empty() {
                            "…".to_owned()
                        } else {
                            message.text.clone()
                        },
                    ))
                    .when(
                        message.role == Role::User
                            && matches!(
                                task_status,
                                Some(TaskStatus::Failed | TaskStatus::Stopped)
                            ),
                        |d| {
                            d.child(div().text_xs().text_color(rgb(0x886044)).child(
                                if task_status == Some(TaskStatus::Stopped) {
                                    "Stopped"
                                } else {
                                    "Task failed"
                                },
                            ))
                        },
                    )
            })
            .collect::<Vec<_>>();
        div()
            .id("morons")
            .role(gpui::Role::Application)
            .aria_label("Morons chat")
            .size_full()
            .flex()
            .bg(rgb(0xFFFFFF))
            .text_color(rgb(0x24262B))
            .font_family(if cfg!(target_os = "windows") {
                "Segoe UI"
            } else {
                ".AppleSystemUIFont"
            })
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(|_, _: &FocusNext, window, cx| window.focus_next(cx)))
            .on_action(cx.listener(|_, _: &FocusPrevious, window, cx| window.focus_prev(cx)))
            .on_click(cx.listener(|view, _, _, cx| {
                if view.show_model { view.show_model = false; cx.notify(); }
            }))
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                if view.show_model && event.keystroke.key == "escape" {
                    view.show_model = false;
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .child(self.sidebar(narrow, cx))
            .child(div().id("main-pane").flex_1().min_w_0().h_full()
                .flex().flex_col().bg(rgb(0xFFFFFF))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .px_6()
                    .py_4()
                    .border_b_1()
                    .border_color(rgb(0xE0E6EC))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_xl()
                                    .font_weight(FontWeight::BOLD)
                                    .child("Morons"),
                            )
                            .child(div().text_sm().text_color(rgb(0x667786)).child(status)),
                    )
                    .child(div().flex().gap_2()
                        .when(!self.state.account_login, |d| d.child(button("reconnect", "Reconnect").on_click(
                            cx.listener(|view, _, _, cx| view.command(Command::Reconnect, cx)),
                        )))
                        .when(self.state.selected_moron.is_some(), |d| d.child(button("account-sign-out", "Sign out").on_click(
                            cx.listener(|view, _, _, cx| view.command(Command::AccountLogout, cx)),
                        )))),
            )
            .when(self.state.account_login, |d| d.child(
                div().id("account-form").role(gpui::Role::Region)
                    .aria_label("Morons account setup and sign in")
                    .w_full().max_w(px(580.)).mx_auto().mt_8().p_6()
                    .rounded_sm().border_1().border_color(rgb(0xBAC8D3))
                    .bg(rgb(0xFFFFFF)).flex().flex_col().gap_3()
                    .child(div().text_xl().font_weight(FontWeight::BOLD).child("Sign in"))
                    .child(div().text_sm().child("Your account keeps named Morons and sessions in sync."))
                    .child(self.login_name.clone())
                    .child(self.login_password.clone())
                    .child(button("account-sign-in", "Sign in").on_click(cx.listener(|view, _, _, cx| view.account_action(false, cx))))
                    .child(div().mt_3().text_sm().child("Setting up the first account? Enter the private setup code supplied by your server."))
                    .child(self.bootstrap_token.clone())
                    .child(button("account-create", "Create first account").on_click(cx.listener(|view, _, _, cx| view.account_action(true, cx))))
            ))
            .when(self.state.selected_moron.is_some(), |d| d.child(
                div().id("provider-panel").role(gpui::Role::Region)
                    .aria_label("ChatGPT provider connection")
                    .px_6().py_2().border_b_1().border_color(rgb(0xE0E6EC))
                    .flex().flex_col().gap_2().text_sm()
                    .child(if self.state.provider_available {
                        format!("ChatGPT connection: {}", provider_state.as_deref().unwrap_or("disconnected"))
                    } else { "ChatGPT login needs an unlocked private provider store. Offline chat remains available.".to_owned() })
                    .when(self.state.provider_available && provider_state.as_deref() != Some("connected"), |d| d.child(
                        button("provider-start", "Connect ChatGPT").on_click(cx.listener(|view, _, _, cx| view.command(Command::ProviderStart, cx)))
                    ))
                    .when_some(provider_url, |d, url| d.child(
                        button("provider-browser", "Open ChatGPT sign-in in browser").on_click(move |_, _, cx| cx.open_url(&url))
                    ))
                    .when(self.state.provider_available && matches!(provider_state.as_deref(), Some("awaiting_callback" | "open_browser")), |d| d
                        .child(div().text_xs().child("Complete sign-in in the browser. If it cannot return to this Mac, paste its final redirect URL below."))
                        .child(self.provider_callback.clone())
                        .child(button("provider-callback-submit", "Submit callback URL").on_click(cx.listener(|view, _, _, cx| view.submit_provider_callback(cx))))
                        .child(button("provider-cancel", "Cancel sign-in").on_click(cx.listener(|view, _, _, cx| view.command(Command::ProviderCancel, cx))))
                    )
                    .when(provider_state.as_deref() == Some("connected"), |d| d.child(
                        button("provider-logout", "Disconnect ChatGPT").on_click(cx.listener(|view, _, _, cx| view.command(Command::ProviderLogout, cx)))
                    ))
            ))
            .when(!self.state.account_login, |d| d.child(
                div()
                    .id("history")
                    .role(gpui::Role::List)
                    .aria_label("Conversation")
                    .track_scroll(&self.scroll)
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_6()
                    .child(
                        div()
                            .w_full()
                            .max_w(px(780.))
                            .mx_auto()
                            .flex()
                            .flex_col()
                            .gap_4()
                            .when(messages.is_empty(), |d| {
                                d.child(
                                    div()
                                        .py_8()
                                        .text_color(rgb(0x667786))
                                        .child("One Moron. A conversation that stays with you."),
                                )
                            })
                            .children(messages)
            .when_some(review, |d, review| {
                let approve_id = review.id.clone();
                let reject_id = review.id.clone();
                let check = if review.checks.iter().all(|item| item.ok) {
                    "Checks passed"
                } else { "Checks failed" };
                d.child(
                    div().id("review-panel").role(gpui::Role::Region)
                        .aria_label("Repository change for human review")
                        .mx_6().mb_3().p_3().rounded_sm().border_1()
                        .border_color(rgb(0xBAC8D3)).bg(rgb(0xFFFFFF))
                        .flex().flex_col().gap_2()
                        .child(div().font_weight(FontWeight::BOLD).child("Review proposed change"))
                        .child(div().text_xs().child(format!("{} · {} · base {}", review.branch, check, &review.base_revision[..8])))
                        .child(div().text_xs().child(format!("Decision: {}", review.decision)))
                        .child(div().id("review-diff").role(gpui::Role::Document)
                            .aria_label("Proposed diff")
                            .max_h(px(180.)).overflow_y_scroll().p_2()
                            .bg(rgb(0xF3F6F8)).font_family("Menlo")
                            .text_sm().child(review.diff))
                        .when(review.decision == "pending", |d| d.child(
                            div().flex().gap_2()
                                .child(button("review-approve", "Approve review").on_click(cx.listener(move |view, _, _, cx| {
                                    view.command(Command::ReviewDecision { id: approve_id.clone(), decision: morons_desktop::transport::ReviewDecision::Approve }, cx)
                                })))
                                .child(button("review-reject", "Reject review").on_click(cx.listener(move |view, _, _, cx| {
                                    view.command(Command::ReviewDecision { id: reject_id.clone(), decision: morons_desktop::transport::ReviewDecision::Reject }, cx)
                                })))
                        )),
                )
            })
            .when(!visualizations.is_empty(), |d| d.child(
                div().id("visualizations").role(gpui::Role::Region)
                    .aria_label("Structured visualizations")
                    .mx_6().mb_3().max_h(px(260.)).overflow_y_scroll()
                    .flex().flex_col().gap_2()
                    .children(visualizations.iter().map(morons_desktop::visualization::render_native))
            ))
                    ),
            ))
            .when_some(error, |d, error| {
                d.child(
                    div()
                        .mx_6()
                        .mb_2()
                        .text_sm()
                        .text_color(rgb(0xA04438))
                        .child(error),
                )
            })
            .when(!self.state.account_login, |d| d.child(
                div().px(px(16.)).pb(px(16.)).pt(px(6.)).child(
                    div()
                        .w_full()
                        .min_h(px(123.))
                        .relative()
                        .flex()
                        .flex_col()
                        .pt(px(14.)).px(px(14.)).pb(px(10.))
                        .rounded(px(8.))
                        .border_1().border_color(rgb(0xE3E5E8))
                        .bg(rgb(0xFFFFFF))
                        .shadow(vec![
                            BoxShadow::new(px(0.), px(3.), hsla(0., 0., 0., 0.07)).blur_radius(px(14.)),
                            BoxShadow::new(px(0.), px(1.), hsla(0., 0., 0., 0.03)).blur_radius(px(3.)),
                        ])
                        .child(self.input.clone())
                        .child(div().flex_1().min_h(px(10.)))
                        .child(div().flex().items_center().gap(px(8.))
                            .child(div().w(px(100.)).h(px(32.)).px(px(2.)).rounded(px(8.))
                                .border_1().border_color(rgb(0xE3E5E8))
                                .flex().items_center()
                                .child(div().w_full().px_2().py_1().rounded(px(5.))
                                    .bg(rgb(0xFFFFFF)).shadow_xs().text_size(px(12.))
                                    .child("Moron")))
                            .child(div().id("attach-unavailable")
                                .aria_label("Attachments unavailable for this connection")
                                .w(px(32.)).h(px(32.)).flex().items_center().justify_center()
                                .child(svg().data(ICON_PLUS).w(px(20.)).h(px(20.)).text_color(rgb(0x24262B))))
                            .child(div().id("model").role(gpui::Role::Button)
                                .aria_label("Current backend model details; selection unavailable")
                                .aria_expanded(self.show_model)
                                .focusable().tab_stop(true)
                                .min_w_0().max_w(px(190.)).flex_1().h(px(28.)).px_2()
                                .rounded(px(6.)).flex().items_center().gap_1()
                                .hover(|d| d.bg(rgb(0xECEEF1))).cursor_pointer()
                                .text_size(px(12.))
                                .child(svg().data(ICON_AGENT).w(px(16.)).h(px(16.)).text_color(rgb(0x626772)))
                                .child(div().min_w_0().truncate().child(model_display.to_owned()))
                                .child("⌄")
                                .on_click(cx.listener(|view, _, _, cx| {
                                    view.show_model = !view.show_model;
                                    cx.stop_propagation(); cx.notify();
                                }))
                                .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                    if !event.keystroke.modifiers.modified() &&
                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                        view.show_model = !view.show_model;
                                        cx.stop_propagation(); cx.notify();
                                    }
                                })))
                            .child(div().flex_1())
                            .when(self.state.pending, |d| d.child(button("retry", "Retry")
                                .on_click(cx.listener(|view, _, _, cx| view.command(Command::Retry, cx)))))
                            .when_some(active.clone(), |d, id| d.child(button("stop", "Stop")
                                .on_click(cx.listener(move |view, _, _, cx| view.command(Command::Stop(id.clone()), cx)))))
                            .child(div().id("mic-unavailable")
                                .aria_label("Dictation unavailable")
                                .w(px(32.)).h(px(32.)).flex().items_center().justify_center()
                                .child(svg().data(ICON_MIC).w(px(20.)).h(px(20.)).text_color(rgb(0x24262B))))
                            .when(self.state.ready && !self.state.pending && active.is_none(), |d| d.child(
                                div().id("send").aria_label(if draft_ready { "Send message" } else { "Write a message to enable send" })
                                    .w(px(28.)).h(px(28.)).rounded(px(6.))
                                    .bg(if draft_ready { rgb(0x24262B) } else { rgb(0x9DA1A7) })
                                    .flex().items_center().justify_center()
                                    .child(svg().data(ICON_SEND).w(px(16.)).h(px(16.)).text_color(rgb(0xFFFFFF)))
                                    .when(draft_ready, |d| d.role(gpui::Role::Button)
                                        .focusable().tab_stop(true).cursor_pointer()
                                        .on_click(cx.listener(|view, _, window, cx| view.send(&SendMessage, window, cx)))
                                        .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                                            if !event.keystroke.modifiers.modified() &&
                                                matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                view.send(&SendMessage, window, cx);
                                                cx.stop_propagation();
                                            }
                                        })))
                            )))
                        .when(self.show_model, |d| {
                            d.child(
                                div()
                                    .id("model-menu")
                                    .role(gpui::Role::Region)
                                    .aria_label("Backend model details; selection managed by server")
                                    .absolute().bottom(px(56.)).left(px(if narrow { 0. } else { 161. }))
                                    .w(px(362.)).max_w_full().h(px(348.))
                                    .rounded(px(8.))
                                    .border_1()
                                    .border_color(rgb(0xE3E5E8))
                                    .bg(rgb(0xFFFFFF))
                                    .shadow(vec![BoxShadow::new(px(0.), px(10.), hsla(0., 0., 0., 0.12)).blur_radius(px(28.))])
                                    .text_size(px(12.))
                                    .on_click(cx.listener(|_, _, _, cx| cx.stop_propagation()))
                                    .flex()
                                    .child(div().w(px(44.)).h_full().flex_shrink_0()
                                        .border_r_1().border_color(rgb(0xE3E5E8))
                                        .flex().flex_col().items_center().pt_3().gap_3()
                                        .child(div().w(px(24.)).h(px(24.))
                                            .flex().items_center().justify_center()
                                            .child(svg().data(ICON_AGENT).w(px(18.)).h(px(18.)).text_color(rgb(0x626772))))
                                        .child(div().w(px(32.)).h(px(32.)).rounded(px(6.))
                                            .bg(rgb(0xECEEF1)).flex().items_center().justify_center()
                                            .child(svg().data(ICON_AGENT).w(px(20.)).h(px(20.)).text_color(rgb(0x626772)))))
                                    .child(div().flex_1().min_w_0().p(px(12.)).flex().flex_col()
                                        .child(div().h(px(36.)).px_2().border_b_1()
                                            .border_color(rgb(0xE3E5E8)).flex().items_center().gap_2()
                                            .text_color(rgb(0x626772))
                                            .child("Models on this server"))
                                        .child(div().id("model-catalog").role(gpui::Role::List)
                                            .aria_label("Server model catalog")
                                            .flex_1().min_h_0().overflow_y_scroll().pt_2()
                                            .when(model_options.is_empty(), |d| d.child(
                                                div().px_2().py_2().text_color(rgb(0x626772))
                                                    .child("No model catalog available")))
                                            .children(model_options.iter().map(|option| {
                                                let selected = selected_model.as_ref().is_some_and(|(provider, id)|
                                                    provider == &option.provider && id == &option.id);
                                                div().px_2().py_2().rounded(px(6.))
                                                    .bg(if selected { rgb(0xECEEF1) } else { rgb(0xFFFFFF) })
                                                    .flex().items_center().gap_2()
                                                    .child(div().min_w_0().flex_1().flex().flex_col()
                                                        .child(div().truncate().child(option.label.clone()))
                                                        .child(div().text_size(px(11.)).text_color(rgb(0x626772))
                                                            .child(option.provider.clone())))
                                                    .when(selected, |d| d.child("✓"))
                                            })))
                                        .child(div().pt_2().border_t_1().border_color(rgb(0xE3E5E8))
                                            .text_color(rgb(0x626772)).child("Model selection is set by your server."))),
                            )
                        })
                ),
            )))
    }
}
fn main() {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Morons: {error}");
            return;
        }
    };
    let login_initial = matches!(config, Config::NamedLogin { .. });
    let preview = std::env::var_os("MORONS_UI_PREVIEW").is_some();
    gpui_platform::application().run(move |cx: &mut App| {
        input::bind_keys(cx);
        cx.bind_keys([
            KeyBinding::new("enter", SendMessage, Some("TextInput")),
            KeyBinding::new("tab", FocusNext, None),
            KeyBinding::new("shift-tab", FocusPrevious, None),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        #[cfg(target_os = "windows")]
        cx.bind_keys([KeyBinding::new("ctrl-q", Quit, None)]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        let bounds = Bounds::centered(None, size(px(900.), px(720.)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(640.), px(480.))),
                    titlebar: Some(TitlebarOptions {
                        title: Some(if preview { "Morons UI Preview".into() } else { "Morons".into() }),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |_, cx| cx.new(|cx| Chat::new(config, cx)),
            )
            .expect("open Morons window");
        window
            .update(cx, |view, window, cx| {
                window.focus(&if login_initial { view.login_name.focus_handle(cx) } else { view.input.focus_handle(cx) }, cx);
                cx.activate(true);
            })
            .expect("focus composer");
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
    });
}
