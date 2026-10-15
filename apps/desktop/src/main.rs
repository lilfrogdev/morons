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
const ICON_CPU: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#626772" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4"/></svg>"##;
const ICON_OPENAI: &[u8] = include_bytes!("assets/model-openai.svg");
const ICON_SEARCH: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#626772" stroke-width="1.5" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg>"##;
const ICON_STAR: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#b77900" stroke-width="1.5" stroke-linejoin="round"><path d="m12 2 3.1 6.3 7 1-5 4.9 1.2 6.9L12 17.8l-6.3 3.3 1.2-6.9-5-4.9 7-1z"/></svg>"##;
const ICON_CHEVRON: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#626772" stroke-width="1.5" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>"##;
fn provider_icon(provider: &str) -> &'static [u8] { if provider == "openai" { ICON_OPENAI } else { ICON_CPU } }
fn model_icon(model_id: &str) -> &'static [u8] {
    let id = model_id.to_ascii_lowercase();
    if id.starts_with("gpt-") || id.starts_with("chatgpt-") ||
        id.starts_with("o1") || id.starts_with("o3") || id.starts_with("o4") {
        ICON_OPENAI
    } else { ICON_CPU }
}
fn provider_name(provider: &str) -> &str { if provider == "morons-fixture" { "Offline" } else if provider == "openai" { "OpenAI" } else { provider } }
fn model_label(provider: &str, label: &str) -> String {
    if provider == "morons-fixture" { label.replace("Offline fixture", "Offline") } else { label.to_owned() }
}

actions!(morons, [SendMessage, Quit, FocusNext, FocusPrevious]);
struct Chat {
    input: Entity<input::TextInput>,
    model_search: Entity<input::TextInput>,
    login_name: Entity<input::TextInput>,
    login_password: Entity<input::TextInput>,
    bootstrap_token: Entity<input::TextInput>,
    provider_callback: Entity<input::TextInput>,
    worker: Worker,
    state: State,

    _updates: Task<()>,
    local_error: Option<&'static str>,
    last_ack: Option<String>,
    scroll: ScrollHandle,
    show_model: bool,
    model_section: String,
    model_cursor: usize,
    drafts: drafts::Drafts,
    _input_subscription: Subscription,
}
impl Chat {
    fn new(config: Config, cx: &mut Context<Self>) -> Self {
        let input = cx.new(input::TextInput::new);
        let model_search = cx.new(|cx| { let mut field = input::TextInput::new(cx); field.set_id("model-search"); field.set_placeholder("Search models…"); field });
        let input_subscription = cx.observe(&input, |_, _, cx| cx.notify());
        cx.observe(&model_search, |_, _, cx| cx.notify()).detach();
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
                            view.show_model = false;
                            view.model_section.clear();
                            view.model_cursor = 0;
                            view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                        } else if view.state.selected_moron != state.selected_moron {
                            let current = view.input.read(cx).text().to_owned();
                            let restored = view.drafts.switch(state.selected_moron.as_deref(), &current);
                            view.input.update(cx, |input, cx| { input.set_text(restored); cx.notify(); });
                            view.last_ack = None;
                            view.show_model = false;
                            view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
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
            model_search,
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
            model_section: String::new(),
            model_cursor: 0,
            drafts: drafts::Drafts::default(),
            _input_subscription: input_subscription,
        }
    }
    fn visible_models(&self, cx: &Context<Self>) -> Vec<morons_desktop::transport::ModelOption> {
        let query = self.model_search.read(cx).text().to_lowercase();
        let tokens: Vec<_> = query.split_whitespace().collect();
        self.state.models.iter().filter(|option| {
            if !option.available && !self.state.selected_model.as_ref().is_some_and(|(provider, id)|
                provider == &option.provider && id == &option.id) { return false; }
            if !tokens.is_empty() {
                let haystack = format!("{} {} {}", option.label, option.id, provider_name(&option.provider)).to_lowercase();
                tokens.iter().all(|token| haystack.contains(token))
            } else if self.model_section == "favorites" {
                self.state.model_favorites.contains(&(option.provider.clone(), option.id.clone()))
            } else { option.provider == self.model_section }
        }).cloned().collect()
    }
    fn open_model_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_model = !self.show_model;
        if self.show_model {
            self.model_section = self.state.selected_model.as_ref().map(|item| item.0.clone())
                .or_else(|| self.state.models.first().map(|item| item.provider.clone())).unwrap_or_default();
            self.model_cursor = 0;
            self.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
            window.focus(&self.model_search.focus_handle(cx), cx);
        }
        cx.notify();
    }
    fn choose_model(&mut self, provider: String, id: String, cx: &mut Context<Self>) {
        if self.state.models.iter().any(|option| option.provider == provider && option.id == id && option.available) {
            self.show_model = false;
            self.command(Command::SelectModel { provider, id }, cx);
        }
    }
    fn send(&mut self, _: &SendMessage, window: &mut Window, cx: &mut Context<Self>) {
        if self.show_model && self.model_search.focus_handle(cx).is_focused(window) {
            let choices: Vec<_> = self.visible_models(cx).into_iter().filter(|option| option.available).collect();
            if let Some(option) = choices.get(self.model_cursor).or_else(|| choices.first()) {
                self.choose_model(option.provider.clone(), option.id.clone(), cx);
                window.focus(&self.input.focus_handle(cx), cx);
            }
            return;
        }
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
        let needs_provider = self.state.selected_model.as_ref().is_some_and(|(provider, _)|
            provider == "morons-fixture") && self.state.provider_state.as_deref() != Some("connected");
        let model_display = if needs_provider { "Set up provider".to_owned() } else {
            model_label(self.state.selected_model.as_ref().map(|item| item.0.as_str()).unwrap_or(""), model)
        };
        let model_options = self.state.models.clone();
        let visible_models = self.visible_models(cx);
        let mut providers = Vec::<String>::new();
        for option in &model_options {
            if !providers.contains(&option.provider) { providers.push(option.provider.clone()); }
        }
        let selected_model = self.state.selected_model.clone();
        let model_favorites = self.state.model_favorites.clone();
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
                let handoff = message.handoff.clone();
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
                    .when_some(handoff, |d, handoff| {
                        d.child(div()
                            .mt_2()
                            .p_3()
                            .rounded_sm()
                            .border_1()
                            .border_color(rgb(0xCAD9E4))
                            .bg(rgb(0xF7FAFC))
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(div().text_xs().font_weight(FontWeight::BOLD)
                                .child(format!("↗ @{}", handoff.target_moron_id)))
                            .child(div().text_sm().child(handoff.answer)))
                    })
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
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                if view.show_model && event.keystroke.key == "escape" {
                    view.show_model = false;
                    window.focus(&view.input.focus_handle(cx), cx);
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
            .when(self.state.selected_moron.is_some() && self.state.provider_available &&
                matches!(provider_state.as_deref(), Some("awaiting_callback" | "open_browser")), |d| d.child(
                div().id("provider-panel").role(gpui::Role::Region)
                    .aria_label("ChatGPT provider connection")
                    .px_6().py_2().border_b_1().border_color(rgb(0xE0E6EC))
                    .flex().flex_col().gap_2().text_sm()
                    .child("Complete ChatGPT sign-in")
                    .when_some(provider_url, |d, url| d.child(
                        button("provider-browser", "Open ChatGPT sign-in in browser").on_click(move |_, _, cx| cx.open_url(&url))
                    ))
                    .when(self.state.provider_available && matches!(provider_state.as_deref(), Some("awaiting_callback" | "open_browser")), |d| d
                        .child(div().text_xs().child("Complete sign-in in the browser. If it cannot return to this Mac, paste its final redirect URL below."))
                        .child(self.provider_callback.clone())
                        .child(button("provider-callback-submit", "Submit callback URL").on_click(cx.listener(|view, _, _, cx| view.submit_provider_callback(cx))))
                        .child(button("provider-cancel", "Cancel sign-in").on_click(cx.listener(|view, _, _, cx| view.command(Command::ProviderCancel, cx))))
                    )
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
                div().px(px(if narrow { 12. } else { 16. }))
                    .pb(px(16.)).child(
                    div()
                        .w_full()
                        .min_h(px(123.))
                        .relative()
                        .flex()
                        .flex_col()
                        .pt(px(14.)).px(px(14.)).pb(px(10.))
                        .rounded(px(20.))
                        .border_1().border_color(rgb(0xE3E5E8))
                        .bg(rgb(0xFFFFFF))
                        .shadow(vec![
                            BoxShadow::new(px(0.), px(3.), hsla(0., 0., 0., 0.07)).blur_radius(px(14.)),
                            BoxShadow::new(px(0.), px(1.), hsla(0., 0., 0., 0.03)).blur_radius(px(3.)),
                        ])
                        .child(self.input.clone())
                        .child(div().flex_1().min_h(px(10.)))
                        .child(div().flex().items_center().gap(px(8.))
                            .child(div().id("attach-unavailable")
                                .aria_label("Attachments unavailable for this connection")
                                .w(px(32.)).h(px(32.)).flex().items_center().justify_center()
                                .child(svg().data(ICON_PLUS).w(px(20.)).h(px(20.)).text_color(rgb(0x24262B))))
                            .child(div().id("model").role(gpui::Role::Button)
                                .aria_label("Choose a model")
                                .aria_expanded(self.show_model)
                                .focusable().tab_stop(true)
                                .min_w_0().max_w(px(230.)).h(px(28.)).px(px(7.))
                                .rounded(px(6.)).flex().items_center().gap_1()
                                .hover(|d| d.bg(rgb(0xECEEF1))).cursor_pointer()
                                .text_size(px(12.))
                                .child(svg().data(model_icon(selected_model.as_ref().map(|item| item.1.as_str()).unwrap_or("")))
                                    .w(px(16.)).h(px(16.)).text_color(rgb(0x626772)))
                                .child(div().min_w_0().truncate().child(model_display.clone()))
                                .child(svg().data(ICON_CHEVRON).w(px(13.)).h(px(13.)).text_color(rgb(0x626772)))
                                .on_click(cx.listener(|view, _, window, cx| {
                                    view.open_model_menu(window, cx);
                                    cx.stop_propagation();
                                }))
                                .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                                    if !event.keystroke.modifiers.modified() &&
                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                        view.open_model_menu(window, cx);
                                        cx.stop_propagation();
                                    }
                                })))
                            .child(div().flex_1())
                            .when(self.state.pending, |d| d.child(button("retry", "Retry")
                                .on_click(cx.listener(|view, _, _, cx| view.command(Command::Retry, cx)))))
                            .when_some(active.clone(), |d, id| d.child(button("stop", "Stop")
                                .on_click(cx.listener(move |view, _, _, cx| view.command(Command::Stop(id.clone()), cx)))))
                            .child(div().id("mic-unavailable")
                                .aria_label("Dictation unavailable")
                                .w(px(32.)).h(px(32.)).rounded(px(16.))
                                .flex().items_center().justify_center()
                                .child(svg().data(ICON_MIC).w(px(20.)).h(px(20.)).text_color(rgb(0x24262B))))
                            .when(self.state.ready && !self.state.pending && active.is_none(), |d| d.child(
                                div().id("send").aria_label(if draft_ready { "Send message" } else { "Write a message to enable send" })
                                    .w(px(28.)).h(px(28.)).rounded(px(14.))
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
                                    .role(gpui::Role::Dialog)
                                    .aria_label("Choose a model")
                                    .absolute().bottom(px(56.)).left(px(14.))
                                    .w(px(362.)).max_w_full().h(px(348.))
                                    .rounded(px(10.))
                                    .border_1()
                                    .border_color(rgb(0xE3E5E8))
                                    .bg(rgb(0xFFFFFF))
                                    .shadow(vec![
                                        BoxShadow::new(px(0.), px(10.), hsla(0., 0., 0., 0.12)).blur_radius(px(28.)),
                                        BoxShadow::new(px(0.), px(2.), hsla(0., 0., 0., 0.03)).blur_radius(px(5.)),
                                    ])
                                    .text_size(px(12.))
                                    .on_click(cx.listener(|_, _, _, cx| cx.stop_propagation()))
                                    .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                        if !event.keystroke.modifiers.modified() {
                                            let choices = view.visible_models(cx).into_iter().filter(|option| option.available).count();
                                            if choices > 0 && matches!(event.keystroke.key.as_str(), "down" | "up") {
                                                if event.keystroke.key == "down" { view.model_cursor = (view.model_cursor + 1) % choices; }
                                                else { view.model_cursor = (view.model_cursor + choices - 1) % choices; }
                                                cx.stop_propagation(); cx.notify();
                                            }
                                        }
                                    }))
                                    .flex()
                                    .child(div().w(px(44.)).h_full().flex_shrink_0()
                                        .border_r_1().border_color(rgb(0xE3E5E8))
                                        .flex().flex_col().items_center().pt(px(5.)).gap(px(4.))
                                        .child(div().id("model-favorites").role(gpui::Role::Button)
                                            .aria_label("Favorites").aria_selected(self.model_section == "favorites")
                                            .focusable().tab_stop(true).cursor_pointer()
                                            .w(px(35.)).h(px(36.)).rounded(px(6.))
                                            .bg(if self.model_section == "favorites" { rgb(0xECEEF1) } else { rgb(0xFFFFFF) })
                                            .flex().items_center().justify_center()
                                            .child(svg().data(ICON_STAR).w(px(20.)).h(px(20.)).text_color(rgb(0xB77900)))
                                            .on_click(cx.listener(|view, _, window, cx| {
                                                view.model_section = "favorites".into(); view.model_cursor = 0;
                                                view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                                                window.focus(&view.model_search.focus_handle(cx), cx);
                                                cx.stop_propagation(); cx.notify();
                                            }))
                                            .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                                                if !event.keystroke.modifiers.modified() &&
                                                    matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                    view.model_section = "favorites".into(); view.model_cursor = 0;
                                                    view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                                                    window.focus(&view.model_search.focus_handle(cx), cx);
                                                    cx.stop_propagation(); cx.notify();
                                                }
                                            })))
                                        .child(div().w(px(32.)).border_t_1().border_color(rgb(0xE3E5E8)))
                                        .children(providers.iter().map(|provider| {
                                            let chosen = provider.clone();
                                            let keyboard_choice = provider.clone();
                                            div().id(SharedString::from(format!("model-provider-{provider}")))
                                                .role(gpui::Role::Button)
                                                .aria_label(SharedString::from(provider_name(provider).to_owned()))
                                                .aria_selected(self.model_section == *provider)
                                                .focusable().tab_stop(true).cursor_pointer()
                                                .w(px(35.)).h(px(36.)).rounded(px(6.))
                                                .bg(if self.model_section == *provider { rgb(0xECEEF1) } else { rgb(0xFFFFFF) })
                                                .flex().items_center().justify_center()
                                                .child(svg().data(provider_icon(provider)).w(px(20.)).h(px(20.)).text_color(rgb(0x626772)))
                                                .on_click(cx.listener(move |view, _, window, cx| {
                                                    view.model_section = chosen.clone(); view.model_cursor = 0;
                                                    view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                                                    window.focus(&view.model_search.focus_handle(cx), cx);
                                                    cx.stop_propagation(); cx.notify();
                                                }))
                                                .on_key_down(cx.listener(move |view, event: &KeyDownEvent, window, cx| {
                                                    if !event.keystroke.modifiers.modified() &&
                                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                        view.model_section = keyboard_choice.clone(); view.model_cursor = 0;
                                                        view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                                                        window.focus(&view.model_search.focus_handle(cx), cx);
                                                        cx.stop_propagation(); cx.notify();
                                                    }
                                                }))
                                        })))
                                    .child(div().flex_1().min_w_0().pt(px(7.)).px(px(12.)).pb(px(9.)).flex().flex_col()
                                        .when(needs_provider || provider_state.as_deref() == Some("connected"), |d| d.child(
                                            div().id("provider-setup-choice").role(gpui::Role::Button)
                                                .aria_label(if provider_state.as_deref() == Some("connected") { "Disconnect ChatGPT" } else { "Set up provider" })
                                                .h(px(42.)).px_2().mb_1().rounded(px(6.))
                                                .bg(rgb(0xF7F7F8)).flex().items_center()
                                                .child(div().flex_1().child(if provider_state.as_deref() == Some("connected") { "Disconnect ChatGPT" } else { "Set up provider" }))
                                                .child(div().text_size(px(11.)).text_color(rgb(0x626772))
                                                    .child(if self.state.provider_available { "ChatGPT" } else { "Server setup required" }))
                                                .when(self.state.provider_available, |d| d.focusable().tab_stop(true).cursor_pointer())
                                                .on_click(cx.listener(|view, _, _, cx| {
                                                    if view.state.provider_available {
                                                        view.show_model = false;
                                                        view.command(if view.state.provider_state.as_deref() == Some("connected") {
                                                            Command::ProviderLogout
                                                        } else { Command::ProviderStart }, cx);
                                                    }
                                                    cx.stop_propagation();
                                                }))
                                                .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                                    if view.state.provider_available && !event.keystroke.modifiers.modified() &&
                                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                        view.show_model = false;
                                                        view.command(if view.state.provider_state.as_deref() == Some("connected") {
                                                            Command::ProviderLogout
                                                        } else { Command::ProviderStart }, cx);
                                                        cx.stop_propagation();
                                                    }
                                                }))
                                        ))
                                        .child(div().h(px(32.)).border_b_1()
                                            .border_color(rgb(0xE3E5E8)).flex().items_center().gap(px(5.))
                                            .child(svg().data(ICON_SEARCH).w(px(16.)).h(px(16.)).text_color(rgb(0x626772)))
                                            .child(self.model_search.clone()))
                                        .when(self.model_section == "favorites" && self.model_search.read(cx).text().is_empty(), |d|
                                            d.child(div().pt(px(10.)).px_2().text_size(px(11.))
                                                .text_color(rgb(0x626772)).child("Favorites")))
                                        .child(div().id("model-catalog").role(gpui::Role::List)
                                            .aria_label("Models")
                                            .flex_1().min_h_0().overflow_y_scroll().pt(px(7.))
                                            .when(visible_models.is_empty(), |d| d.child(
                                                div().px_2().pt(px(20.)).text_color(rgb(0x626772))
                                                    .child(if !self.model_search.read(cx).text().is_empty() { "No models found" }
                                                        else if self.model_section == "favorites" { "No favorites yet" }
                                                        else if self.model_section == "openai" &&
                                                            self.state.provider_state.as_deref() != Some("connected") {
                                                            "Set up provider to see models"
                                                        } else { "No available models" })))
                                            .children(visible_models.iter().enumerate().map(|(index, option)| {
                                                let selected = selected_model.as_ref().is_some_and(|(provider, id)|
                                                    provider == &option.provider && id == &option.id);
                                                let favorite = model_favorites.contains(&(option.provider.clone(), option.id.clone()));
                                                let provider = option.provider.clone(); let id = option.id.clone();
                                                let star_provider = provider.clone(); let star_id = id.clone();
                                                let key_provider = provider.clone(); let key_id = id.clone();
                                                let star_key_provider = provider.clone(); let star_key_id = id.clone();
                                                let active_index = visible_models[..index].iter().filter(|item| item.available).count();
                                                div().id(SharedString::from(format!("model-option-{provider}-{id}")))
                                                    .role(gpui::Role::ListItem).aria_selected(selected)
                                                    .when(option.available, |d| d.focusable().tab_stop(true))
                                                    .h(px(46.)).px(px(8.)).rounded(px(6.))
                                                    .bg(if selected || (option.available && self.model_cursor == active_index) { rgb(0xECEEF1) } else { rgb(0xFFFFFF) })
                                                    .flex().items_center().gap(px(5.))
                                                    .on_key_down(cx.listener(move |view, event: &KeyDownEvent, window, cx| {
                                                        if !event.keystroke.modifiers.modified() &&
                                                            matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                            view.choose_model(key_provider.clone(), key_id.clone(), cx);
                                                            window.focus(&view.input.focus_handle(cx), cx);
                                                            cx.stop_propagation();
                                                        }
                                                    }))
                                                    .child(div().id(SharedString::from(format!("model-choice-{provider}-{id}")))
                                                        .role(gpui::Role::Button)
                                                        .aria_label(SharedString::from(format!("Select {}", model_label(&option.provider, &option.label))))
                                                        .flex_1().min_w_0().flex().flex_col().justify_center()
                                                        .when(option.available, |d| d.cursor_pointer())
                                                        .when(!option.available, |d| d.opacity(0.45))
                                                        .child(div().truncate().line_height(px(16.)).child(model_label(&option.provider, &option.label)))
                                                        .child(div().flex().items_center().gap(px(5.)).mt(px(3.))
                                                            .text_size(px(11.)).text_color(rgb(0x626772))
                                                            .child(svg().data(provider_icon(&option.provider)).w(px(12.)).h(px(12.)).text_color(rgb(0x626772)))
                                                            .child(provider_name(&option.provider).to_owned()))
                                                        .on_click(cx.listener(move |view, _, window, cx| {
                                                            view.choose_model(provider.clone(), id.clone(), cx);
                                                            window.focus(&view.input.focus_handle(cx), cx);
                                                            cx.stop_propagation();
                                                        })))
                                                    .when(selected, |d| d.child(div().text_color(rgb(0x626772)).child("✓")))
                                                    .child(div().id(SharedString::from(format!("model-star-{}-{}", option.provider, option.id)))
                                                        .role(gpui::Role::Button)
                                                        .aria_label(if favorite { "Remove from favorites" } else { "Add to favorites" })
                                                        .aria_selected(favorite).focusable().tab_stop(true)
                                                        .w(px(24.)).h(px(26.)).rounded(px(4.))
                                                        .flex().items_center().justify_center().cursor_pointer()
                                                        .child(svg().data(ICON_STAR).w(px(14.)).h(px(14.))
                                                            .text_color(if favorite { rgb(0xEAB308) } else { rgb(0xB77900) }))
                                                        .on_click(cx.listener(move |view, _, _, cx| {
                                                            view.command(Command::ToggleModelFavorite {
                                                                provider: star_provider.clone(), id: star_id.clone(), favorite: !favorite,
                                                            }, cx);
                                                            cx.stop_propagation();
                                                        }))
                                                        .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                                                            if !event.keystroke.modifiers.modified() &&
                                                                matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                                view.command(Command::ToggleModelFavorite {
                                                                    provider: star_key_provider.clone(), id: star_key_id.clone(), favorite: !favorite,
                                                                }, cx);
                                                                cx.stop_propagation();
                                                            }
                                                        })))
                                            }))),
                                    ),
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
        let bounds = Bounds::centered(None, size(px(1200.), px(760.)), cx);
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
